use super::{FrozenReferenceKinds, NativeReferenceClass};
use crate::streaming::FrameReferencePlan;
use crate::streaming::{
    FrameEnvironment, FrameLayout, FrozenDeclarations, LocalKey, NativeRuntimeIndices,
};
use anyhow::{Context, Result, ensure};
use std::collections::BTreeMap;
use wasm_encoder::{BlockType, FuncType, ValType};

mod emit;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ActivationCallTarget {
    Direct(u32),
    Indirect {
        table: u32,
        signature: u32,
        table64: bool,
    },
    Reference {
        signature: u32,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Transport {
    target: ActivationCallTarget,
    params: Vec<ValType>,
    results: Vec<ValType>,
}
#[derive(Clone, Debug)]
enum Recipe {
    Select,
    Transport {
        operation: Transport,
        resume_signature: u32,
        helper_signature: u32,
    },
    Resume {
        function: u32,
        arguments: Vec<ResumeArgument>,
        frame_size: u32,
        use_zero_arguments: bool,
    },
}
#[derive(Clone, Debug)]
enum ResumeArgument {
    Scalar {
        ty: ValType,
        offset: u32,
    },
    Reference {
        ty: wasm_encoder::RefType,
        class: NativeReferenceClass,
        vector_position: u32,
    },
}

/// Frozen final indices are assigned before any function is emitted. The
/// module catalog owns signatures/recipes, never source bodies or local plans.
pub struct ActivationSupportCatalog {
    environment: FrameEnvironment,
    runtime: NativeRuntimeIndices,
    frames_start: u32,
    first_type: u32,
    first_function: u32,
    types: Vec<FuncType>,
    functions: Vec<u32>,
    recipes: Vec<Recipe>,
    signatures: BTreeMap<(Vec<ValType>, Vec<ValType>), u32>,
    transports: BTreeMap<Transport, u32>,
    estimated: usize,
    budget: usize,
}
impl ActivationSupportCatalog {
    pub fn new(
        environment: FrameEnvironment,
        runtime: NativeRuntimeIndices,
        frames_start: u32,
        first_type: u32,
        first_function: u32,
        budget: usize,
    ) -> Result<Self> {
        ensure!(
            environment.memory.is_some()
                && matches!(environment.pointer, ValType::I32 | ValType::I64),
            "activation support requires the primary linear memory"
        );
        let mut catalog = Self {
            environment,
            runtime,
            frames_start,
            first_type,
            first_function,
            types: Vec::new(),
            functions: Vec::new(),
            recipes: Vec::new(),
            signatures: BTreeMap::new(),
            transports: BTreeMap::new(),
            estimated: 0,
            budget,
        };
        catalog.charge(2048)?;
        let signature =
            catalog.intern_type(&[ValType::I32, environment.pointer], &[ValType::I32])?;
        catalog.functions.push(signature);
        catalog.recipes.push(Recipe::Select);
        first_function
            .checked_add(1)
            .context("activation support function index overflow")?;
        Ok(catalog)
    }
    fn charge(&mut self, bytes: usize) -> Result<()> {
        let total = self
            .estimated
            .checked_add(bytes)
            .context("activation support metadata overflow")?;
        ensure!(
            total <= self.budget,
            "activation support exceeds metadata budget"
        );
        self.estimated = total;
        Ok(())
    }
    fn intern_type(&mut self, params: &[ValType], results: &[ValType]) -> Result<u32> {
        let key = (params.to_vec(), results.to_vec());
        if let Some(&index) = self.signatures.get(&key) {
            return Ok(index);
        }
        let index = self
            .first_type
            .checked_add(u32::try_from(self.types.len())?)
            .context("activation type index overflow")?;
        index
            .checked_add(1)
            .context("activation type index overflow")?;
        self.types.push(FuncType::new(
            params.iter().copied(),
            results.iter().copied(),
        ));
        self.signatures.insert(key, index);
        Ok(index)
    }
    pub fn frame_select(&self) -> u32 {
        self.first_function
    }
    #[allow(clippy::too_many_arguments)]
    pub fn resume_thunk_with_references(
        &mut self,
        function: u32,
        parameters: &[ValType],
        results: &[ValType],
        frame: &FrameLayout,
        references: &FrameReferencePlan,
        kinds: &FrozenReferenceKinds,
    ) -> Result<u32> {
        self.plan_resume_thunk(
            function,
            parameters,
            results,
            frame,
            Some((references, kinds)),
        )
    }
    /// Its callee consumes and validates the selected frame. Reference
    /// parameters use `resume_thunk_with_references` to supply valid recipes.
    pub fn resume_thunk(
        &mut self,
        function: u32,
        parameters: &[ValType],
        results: &[ValType],
        frame: &FrameLayout,
    ) -> Result<u32> {
        self.plan_resume_thunk(function, parameters, results, frame, None)
    }
    fn plan_resume_thunk(
        &mut self,
        function: u32,
        parameters: &[ValType],
        results: &[ValType],
        frame: &FrameLayout,
        reference_context: Option<(&FrameReferencePlan, &FrozenReferenceKinds)>,
    ) -> Result<u32> {
        let parameter_count = u32::try_from(parameters.len())?;
        let cost = parameters
            .len()
            .checked_add(results.len())
            .and_then(|count| count.checked_mul(256))
            .and_then(|bytes| bytes.checked_add(2048))
            .context("resume metadata overflow")?;
        self.preflight(cost)?;
        let index = self
            .first_function
            .checked_add(u32::try_from(self.recipes.len())?)
            .context("resume function index overflow")?;
        index
            .checked_add(1)
            .context("resume function index overflow")?;
        self.first_type
            .checked_add(u32::try_from(
                self.types
                    .len()
                    .checked_add(1)
                    .context("resume type count overflow")?,
            )?)
            .context("resume type index overflow")?;

        // Index only original parameters. Searching the entire spill catalog
        // for each argument would become quadratic for large activations.
        let scalar_fields: BTreeMap<_, _> = frame
            .fields
            .iter()
            .filter(|field| field.local.0 < parameter_count)
            .map(|field| (field.local, (field.ty, field.offset)))
            .collect();
        let reference_slots: BTreeMap<_, _> = reference_context
            .into_iter()
            .flat_map(|(references, _)| &references.slots)
            .filter(|slot| slot.local.0 < parameter_count)
            .map(|slot| (slot.local, slot))
            .collect();
        let mut arguments = Vec::with_capacity(parameters.len());
        for (ordinal, &ty) in parameters.iter().enumerate() {
            let key = LocalKey(u32::try_from(ordinal)?);
            ensure!(
                frame.local(key)?.source == Some(key.0),
                "resume parameter is not a source local"
            );
            arguments.push(match ty {
                ValType::Ref(reference) => {
                    let (_, kinds) = reference_context
                        .context("reference resume parameters require a recipe decoder")?;
                    let slot = reference_slots
                        .get(&key)
                        .context("resume reference parameter has no recipe slot")?;
                    ensure!(
                        slot.ty == reference,
                        "resume reference parameter type differs from recipe slot"
                    );
                    ResumeArgument::Reference {
                        ty: reference,
                        class: kinds.class(reference)?,
                        vector_position: slot.universal_position.context(
                            "resume reference parameter has no universal vector position",
                        )?,
                    }
                }
                scalar => {
                    let &(saved, offset) = scalar_fields
                        .get(&key)
                        .context("resume scalar parameter has no frame field")?;
                    ensure!(
                        saved == scalar,
                        "resume scalar parameter type differs from frame field"
                    );
                    ResumeArgument::Scalar { ty: scalar, offset }
                }
            });
        }
        let use_zero_arguments = prefer_zero_arguments(parameters)?;
        self.charge(cost)?;
        let signature = self.intern_type(&[], results)?;
        self.functions.push(signature);
        self.recipes.push(Recipe::Resume {
            function,
            arguments,
            frame_size: frame.size,
            use_zero_arguments,
        });
        Ok(index)
    }
    fn preflight(&self, bytes: usize) -> Result<()> {
        ensure!(
            bytes <= self.budget.saturating_sub(self.estimated),
            "activation support exceeds metadata budget"
        );
        Ok(())
    }
    pub fn result_block(&mut self, results: &[ValType]) -> Result<BlockType> {
        self.block_type(&[], results)
    }
    /// Typed wrappers forward original block parameters without extra locals.
    pub fn block_type(&mut self, parameters: &[ValType], results: &[ValType]) -> Result<BlockType> {
        let values = parameters
            .len()
            .checked_add(results.len())
            .context("activation block signature overflow")?;
        ensure!(
            values <= self.budget / 128,
            "activation block type exceeds metadata budget"
        );
        match (parameters, results) {
            ([], []) => Ok(BlockType::Empty),
            ([], [ty]) => Ok(BlockType::Result(*ty)),
            _ => {
                if !self
                    .signatures
                    .contains_key(&(parameters.to_vec(), results.to_vec()))
                {
                    self.charge(
                        values
                            .checked_mul(128)
                            .and_then(|bytes| bytes.checked_add(512))
                            .context("activation block type metadata overflow")?,
                    )?;
                }
                Ok(BlockType::FunctionType(
                    self.intern_type(parameters, results)?,
                ))
            }
        }
    }
    /// params excludes an indirect selector/reference callee. The catalog adds
    /// that operand to the transport helper's signature, matching the source.
    pub fn transport(
        &mut self,
        target: ActivationCallTarget,
        params: &[ValType],
        results: &[ValType],
    ) -> Result<u32> {
        let values = params
            .len()
            .checked_add(results.len())
            .and_then(|n| n.checked_add(1))
            .context("transport signature overflow")?;
        ensure!(
            values <= self.budget / 256,
            "transport signature exceeds metadata budget"
        );
        let key = Transport {
            target,
            params: params.to_vec(),
            results: results.to_vec(),
        };
        if let Some(&function) = self.transports.get(&key) {
            return Ok(function);
        }
        // Preflight every index/budget before interning either signature.
        let charge = values
            .checked_mul(256)
            .and_then(|n| n.checked_add(2048))
            .context("transport metadata overflow")?;
        let index = self
            .first_function
            .checked_add(u32::try_from(self.recipes.len())?)
            .context("transport function index overflow")?;
        index
            .checked_add(1)
            .context("transport function index overflow")?;
        self.first_type
            .checked_add(u32::try_from(
                self.types
                    .len()
                    .checked_add(2)
                    .context("transport type count overflow")?,
            )?)
            .context("transport type index overflow")?;
        self.charge(charge)?;
        let mut arguments = params.to_vec();
        match target {
            ActivationCallTarget::Direct(_) => {}
            ActivationCallTarget::Indirect { table64, .. } => {
                arguments.push(if table64 { ValType::I64 } else { ValType::I32 })
            }
            ActivationCallTarget::Reference { .. } => arguments.push(ValType::FUNCREF),
        }
        let helper_signature = self.intern_type(&arguments, results)?;
        let resume_signature = self.intern_type(&[], results)?;
        self.functions.push(helper_signature);
        self.recipes.push(Recipe::Transport {
            operation: key.clone(),
            resume_signature,
            helper_signature,
        });
        self.transports.insert(key, index);
        Ok(index)
    }
    pub fn freeze(self) -> Result<FrozenActivationSupport> {
        Ok(FrozenActivationSupport {
            declarations: FrozenDeclarations::new(self.types, self.functions, self.budget)?,
            environment: self.environment,
            runtime: self.runtime,
            frames_start: self.frames_start,
            recipes: self.recipes,
            transports: self.transports,
            signatures: self.signatures,
            metadata_budget: self.budget,
        })
    }
}

pub struct FrozenActivationSupport {
    declarations: FrozenDeclarations,
    environment: FrameEnvironment,
    runtime: NativeRuntimeIndices,
    frames_start: u32,
    recipes: Vec<Recipe>,
    transports: BTreeMap<Transport, u32>,
    signatures: BTreeMap<(Vec<ValType>, Vec<ValType>), u32>,
    metadata_budget: usize,
}

impl FrozenActivationSupport {
    pub fn lookup_block_type(
        &self,
        parameters: &[ValType],
        results: &[ValType],
    ) -> Result<BlockType> {
        let values = parameters
            .len()
            .checked_add(results.len())
            .context("activation block signature overflow")?;
        ensure!(
            values <= self.metadata_budget / 128,
            "block lookup exceeds metadata budget"
        );
        Ok(match (parameters, results) {
            ([], []) => BlockType::Empty,
            ([], [ty]) => BlockType::Result(*ty),
            _ => BlockType::FunctionType(
                *self
                    .signatures
                    .get(&(parameters.to_vec(), results.to_vec()))
                    .context("block type was not declared before freezing")?,
            ),
        })
    }
    /// Resolve a previously declared transport while rebuilding one local
    /// emission plan. Unknown shapes fail; emission cannot add declarations.
    pub fn lookup_transport(
        &self,
        target: ActivationCallTarget,
        parameters: &[ValType],
        results: &[ValType],
    ) -> Result<u32> {
        let values = parameters
            .len()
            .checked_add(results.len())
            .and_then(|count| count.checked_add(1))
            .context("transport signature overflow")?;
        ensure!(
            values <= self.metadata_budget / 256,
            "transport lookup exceeds metadata budget"
        );
        self.transports
            .get(&Transport {
                target,
                params: parameters.to_vec(),
                results: results.to_vec(),
            })
            .copied()
            .context("transport was not declared before freezing")
    }
}

/// The activation preamble restores scalar parameters before using them, so
/// passing zero avoids redundant loads when its encoding is shorter. References
/// must be decoded first to enter a non-nullable signature; float-heavy scalar
/// signatures also favor loads. Keep this byte-cost policy aligned with Walrus.
fn prefer_zero_arguments(parameters: &[ValType]) -> Result<bool> {
    let mut zero_bytes = 0usize;
    for &ty in parameters {
        let bytes = match ty {
            ValType::I32 | ValType::I64 => 2,
            ValType::F32 => 5,
            ValType::F64 => 9,
            ValType::V128 => 18,
            ValType::Ref(_) => return Ok(false),
        };
        zero_bytes = zero_bytes
            .checked_add(bytes)
            .context("resume byte estimate overflow")?;
    }
    let load_bytes = parameters
        .len()
        .checked_mul(5)
        .and_then(|bytes| bytes.checked_add(7))
        .context("resume byte estimate overflow")?;
    Ok(zero_bytes <= load_bytes)
}
