//! Typed constructor wrappers preserve original allocation/trap order, then
//! register the inputs needed to reconstruct mutable non-null fields later.
use super::*;
use crate::streaming::{
    FrozenDeclarations, FrozenImports, FunctionIr, RuntimeInputs, SourceInstruction,
};
use wasm_encoder::{Function, Instruction, RefType};
use wasmparser::Operator;

mod emit;
pub(super) mod imports;
pub(super) mod signatures;
use imports::{ProvenanceHost, ProvenanceImports};

#[derive(Clone, Copy, Debug)]
pub struct GcConstructorLimits {
    pub metadata_bytes: usize,
    pub work: usize,
    pub parameters: usize,
}
impl Default for GcConstructorLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: crate::limits::TOTAL_WORK,
            parameters: 1000,
        }
    }
}
struct Recipe {
    layout: u32,
    parameters: u32,
}
pub struct GcConstructorPlan {
    recipes: Vec<Recipe>,
    declarations: FrozenDeclarations,
    imports: Option<ProvenanceImports>,
    first_helper: u32,
    identity: [u8; 32],
    source: [u8; 32],
}
pub struct FrozenGcConstructors {
    recipes: Vec<Recipe>,
    declarations: FrozenDeclarations,
    host: Option<ProvenanceHost>,
    by_layout: BTreeMap<u32, u32>,
    identity: [u8; 32],
}
impl GcConstructorPlan {
    /// Prototype types join RuntimeInputs before runtime import freezing.
    /// Helper ordinals are relative to the frozen generated-function base.
    pub fn reserve(
        scan: &Scan<'_>,
        plan: &NativeGcPlan,
        inputs: &mut RuntimeInputs,
        first_helper: u32,
        limits: GcConstructorLimits,
    ) -> Result<Self> {
        plan.validate_source(scan)?;
        let mut budget = Budget {
            metadata: limits.metadata_bytes,
            work: limits.work,
        };
        budget.step(plan.layouts.len())?;
        let mut recipes = Vec::new();
        let mut function_types = Vec::new();
        let mut signatures = signatures::Signatures::new(scan, inputs, &mut budget)?;
        for layout in &plan.layouts {
            let needed = match layout.constructor {
                NativeGcConstructor::Struct => layout.provenance_reference_count != 0,
                NativeGcConstructor::ArrayGeneric => false,
                _ => true,
            };
            if !needed {
                continue;
            }
            let count = signatures::parameter_count(layout)?;
            ensure!(
                count <= limits.parameters,
                "GC constructor exceeds helper parameter limit"
            );
            budget.step(count.saturating_add(1))?;
            budget.charge(
                count
                    .checked_mul(64)
                    .and_then(|n| n.checked_add(512))
                    .context("GC constructor signature size overflow")?,
            )?;
            let parameters = signatures::parameters(layout, count);
            let result = ValType::Ref(RefType {
                nullable: false,
                heap_type: wasm_encoder::HeapType::Concrete(layout.type_index),
            });
            function_types.push(signatures.intern(inputs, parameters, vec![result])?);
            recipes.push(Recipe {
                layout: layout.id,
                parameters: u32::try_from(count)?,
            });
        }
        first_helper
            .checked_add(u32::try_from(recipes.len())?)
            .context("GC constructor helper ordinal overflow")?;
        let imports = if recipes.is_empty() {
            None
        } else {
            Some(ProvenanceImports::reserve(
                scan,
                inputs,
                &mut signatures,
                limits.metadata_bytes,
            )?)
        };
        FrozenDeclarations::validate_parts(&inputs.types, &[], limits.metadata_bytes)?;
        Ok(Self {
            recipes,
            declarations: FrozenDeclarations::new(vec![], function_types, limits.metadata_bytes)?,
            imports,
            first_helper,
            identity: plan.identity,
            source: plan.source,
        })
    }
    pub fn helper_count(&self) -> u32 {
        self.declarations.function_count()
    }
    pub fn freeze(self, imports: &FrozenImports) -> Result<FrozenGcConstructors> {
        ensure!(
            self.source == imports.source_identity(),
            "GC constructor imports belong to another source module"
        );
        let first = imports
            .helper_function_base()
            .checked_add(self.first_helper)
            .context("GC constructor helper index overflow")?;
        let mut by_layout = BTreeMap::new();
        for (ordinal, recipe) in self.recipes.iter().enumerate() {
            by_layout.insert(
                recipe.layout,
                first
                    .checked_add(u32::try_from(ordinal)?)
                    .context("GC constructor helper index overflow")?,
            );
        }
        Ok(FrozenGcConstructors {
            recipes: self.recipes,
            declarations: self.declarations,
            host: self.imports.map(|host| host.freeze(imports)).transpose()?,
            by_layout,
            identity: self.identity,
        })
    }
}
impl FrozenGcConstructors {
    pub fn declarations(&self) -> &FrozenDeclarations {
        &self.declarations
    }
    pub fn emit_function<T: Reencode>(
        &self,
        plan: &NativeGcPlan,
        source: &FunctionIr<'_>,
        map: &mut T,
        limit: usize,
    ) -> Result<Function>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        self.validate_plan(plan)?;
        let mut output = map.new_function_with_parsed_locals(&source.source)?;
        for instruction in &source.instructions {
            self.emit_source(plan, instruction, map, &mut output, limit)?;
        }
        Ok(output)
    }
    fn validate_plan(&self, plan: &NativeGcPlan) -> Result<()> {
        ensure!(
            self.identity == plan.identity,
            "GC constructor catalog belongs to another mapped plan"
        );
        Ok(())
    }
    pub fn replacement(&self, plan: &NativeGcPlan, source: &Operator<'_>) -> Result<Option<u32>> {
        self.validate_plan(plan)?;
        let (source_type, constructor) = match *source {
            Operator::StructNew { struct_type_index } => {
                (struct_type_index, NativeGcConstructor::Struct)
            }
            Operator::ArrayNew { array_type_index } => {
                (array_type_index, NativeGcConstructor::ArrayNew)
            }
            Operator::ArrayNewDefault { array_type_index } => {
                (array_type_index, NativeGcConstructor::ArrayDefault)
            }
            Operator::ArrayNewFixed {
                array_type_index,
                array_size,
            } => (
                array_type_index,
                NativeGcConstructor::ArrayFixed { len: array_size },
            ),
            Operator::ArrayNewData {
                array_type_index,
                array_data_index,
            } => (
                array_type_index,
                NativeGcConstructor::ArrayData {
                    segment_ordinal: array_data_index,
                },
            ),
            Operator::ArrayNewElem {
                array_type_index,
                array_elem_index,
            } => (
                array_type_index,
                NativeGcConstructor::ArrayElement {
                    segment_ordinal: array_elem_index,
                },
            ),
            _ => return Ok(None),
        };
        let Some(layout) = plan.constructor_layout(source_type, constructor) else {
            return Ok(None);
        };
        self.by_layout
            .get(&layout.id)
            .copied()
            .map(Some)
            .context("GC constructor was not reserved")
    }
    /// May be called from an activation source hook or an ordinary function
    /// transform. Original ProgramPoint coordinates never change.
    pub fn emit_source<T: Reencode>(
        &self,
        plan: &NativeGcPlan,
        source: &SourceInstruction<'_>,
        map: &mut T,
        output: &mut Function,
        limit: usize,
    ) -> Result<()>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let instruction = if let Some(helper) = self.replacement(plan, &source.operation)? {
            Instruction::Call(helper)
        } else {
            map.instruction(source.operation.clone())?
        };
        output.instruction(&instruction);
        ensure!(
            output.byte_len() <= limit,
            "GC constructor rewrite exceeds output budget"
        );
        Ok(())
    }
    pub fn emit_helper(&self, ordinal: u32, plan: &NativeGcPlan, limit: usize) -> Result<Function> {
        self.validate_plan(plan)?;
        let recipe = self
            .recipes
            .get(ordinal as usize)
            .context("unknown GC constructor helper")?;
        let host = self
            .host
            .context("GC constructor host imports were not reserved")?;
        let layout = &plan.layouts[(recipe.layout - 1) as usize];
        emit::constructor(layout, recipe.parameters, host, limit)
    }
}
