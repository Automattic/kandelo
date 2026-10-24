//! Function-local ownership of the dynamically latest catch. Typed operand
//! scratch is pooled across arms; only its selected scalar payload or one
//! complete exception recipe survives in the linked frame.
use super::{ActivationSupportCatalog, FrozenActivationSupport};
use crate::streaming::{
    FrameBuilder, FunctionIr, HandlerKind, LocalKey, RegionId, RegionKind, Scan, SourceTypes,
};
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeMap, ops::Range};
use wasm_encoder::{BlockType, RefType, ValType, reencode::Reencode};

#[derive(Clone, Copy, Debug)]
pub struct CatchLimits {
    pub metadata_bytes: usize,
    pub work: usize,
}
impl Default for CatchLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: 100 * 1024 * 1024,
        }
    }
}

pub struct NativeCatchArm {
    pub selector: u32,
    pub kind: HandlerKind,
    pub tag: Option<u32>,
    pub target: RegionId,
    pub payload: Vec<ValType>,
    pub operands: Vec<LocalKey>,
    pub uses_exception_recipe: bool,
    pub capture_type: Option<BlockType>,
}

pub struct NativeCatchRegion {
    pub region: RegionId,
    pub selectors: Range<u32>,
    pub parameters: Vec<ValType>,
    pub results: Vec<ValType>,
    pub arms: Vec<NativeCatchArm>,
    pub outer_type: Option<BlockType>,
    pub private_type: Option<BlockType>,
}

pub struct NativeCatchPlan {
    pub regions: BTreeMap<RegionId, NativeCatchRegion>,
    pub selector: Option<LocalKey>,
    pub retained_exception: Option<LocalKey>,
    pub forwarding_exception: Option<LocalKey>,
    metadata_budget: usize,
    work_budget: usize,
    allocated: bool,
}

impl NativeCatchPlan {
    pub fn discover<T: Reencode>(
        scan: &Scan<'_>,
        body: &FunctionIr<'_>,
        source_types: &SourceTypes,
        map: &mut T,
        limits: CatchLimits,
    ) -> Result<Self>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let types = scan.types.as_ref();
        let mut remaining = limits.metadata_bytes;
        let mut remaining_work = limits
            .work
            .checked_sub(body.regions.len())
            .context("catch discovery exceeds work budget")?;
        let mut regions = BTreeMap::new();
        let mut next_selector = 1u32;
        for (index, region) in body.regions.iter().enumerate() {
            if region.kind != RegionKind::TryTable
                || region.handlers.is_empty()
                || !body.instructions[region.opener.unwrap()].retained
            {
                continue;
            }
            let single_result = match region.signature {
                wasmparser::BlockType::Type(ty) => Some(ty),
                _ => None,
            };
            let (parameters, results): (&[_], &[_]) = match region.signature {
                wasmparser::BlockType::Empty => (&[], &[]),
                wasmparser::BlockType::Type(_) => (&[], single_result.as_slice()),
                wasmparser::BlockType::FuncType(index) => {
                    let signature = types
                        .get(types.core_type_at_in_module(index))
                        .unwrap()
                        .composite_type
                        .unwrap_func();
                    (signature.params(), signature.results())
                }
            };
            remaining_work = remaining_work
                .checked_sub(parameters.len().saturating_add(results.len()))
                .context("catch discovery exceeds work budget")?;
            charge(
                &mut remaining,
                parameters
                    .len()
                    .checked_add(results.len())
                    .context("catch signature overflow")?,
                512,
            )?;
            let parameters = parameters
                .iter()
                .map(|&ty| source_types.value_type(map, ty))
                .collect::<Result<Vec<_>>>()?;
            let results = results
                .iter()
                .map(|&ty| source_types.value_type(map, ty))
                .collect::<Result<Vec<_>>>()?;
            let first_selector = next_selector;
            let mut arms = Vec::new();
            for handler in &region.handlers {
                let payload = handler
                    .tag
                    .map(|tag| {
                        types
                            .get(types.tag_at(tag))
                            .unwrap()
                            .composite_type
                            .unwrap_func()
                            .params()
                    })
                    .unwrap_or(&[]);
                remaining_work = remaining_work
                    .checked_sub(1 + payload.len())
                    .context("catch discovery exceeds work budget")?;
                charge(&mut remaining, payload.len(), 512)?;
                let payload = payload
                    .iter()
                    .map(|&ty| source_types.value_type(map, ty))
                    .collect::<Result<Vec<_>>>()?;
                let uses_exception_recipe = handler.tag.is_none()
                    || payload
                        .iter()
                        .any(|ty| matches!(ty, ValType::Ref(_) | ValType::V128));
                let selector = next_selector;
                next_selector = next_selector
                    .checked_add(1)
                    .context("catch selector overflow")?;
                arms.push(NativeCatchArm {
                    selector,
                    kind: handler.kind,
                    tag: handler.tag.map(|tag| map.tag_index(tag)).transpose()?,
                    target: handler
                        .target
                        .context("modern catch has no source target")?,
                    payload,
                    operands: Vec::new(),
                    uses_exception_recipe,
                    capture_type: None,
                });
            }
            let region = RegionId(index);
            regions.insert(
                region,
                NativeCatchRegion {
                    region,
                    selectors: first_selector..next_selector,
                    parameters,
                    results,
                    arms,
                    outer_type: None,
                    private_type: None,
                },
            );
        }
        Ok(Self {
            regions,
            selector: None,
            retained_exception: None,
            forwarding_exception: None,
            metadata_budget: limits.metadata_bytes,
            work_budget: limits.work,
            allocated: false,
        })
    }

    /// Called while the continuation frame is open, after ordinary operand
    /// spills have been assigned. Catch scratch never becomes an ordinary
    /// scalar spill or one hidden retained reference per static catch arm.
    pub fn allocate(
        &mut self,
        frame: &mut FrameBuilder,
        references: &mut [Vec<LocalKey>],
    ) -> Result<()> {
        ensure!(!self.allocated, "catch storage was already allocated");
        if self.regions.is_empty() {
            self.allocated = true;
            return Ok(());
        }
        self.selector = Some(frame.temporary(ValType::I32)?);
        if self
            .regions
            .values()
            .flat_map(|region| &region.arms)
            .any(|arm| arm.uses_exception_recipe)
        {
            ensure!(
                references.len() <= self.metadata_budget / 64,
                "catch references exceed metadata budget"
            );
            let exception = frame.temporary(ValType::Ref(RefType::EXNREF))?;
            self.retained_exception = Some(exception);
            for landing in references.iter_mut() {
                landing.push(exception);
            }
        }
        if self
            .regions
            .values()
            .flat_map(|region| &region.arms)
            .any(|arm| arm.is_ref() && !arm.uses_exception_recipe)
        {
            self.forwarding_exception = Some(frame.temporary(ValType::Ref(RefType::EXNREF))?);
        }
        let mut pools = BTreeMap::<ValType, Vec<LocalKey>>::new();
        for arm in self
            .regions
            .values_mut()
            .flat_map(|region| &mut region.arms)
        {
            let mut uses = BTreeMap::<ValType, usize>::new();
            for &ty in &arm.payload {
                let storage = match ty {
                    ValType::Ref(mut reference) => {
                        reference.nullable = true;
                        ValType::Ref(reference)
                    }
                    scalar => scalar,
                };
                let ordinal = uses.entry(storage).or_default();
                let pool = pools.entry(storage).or_default();
                if *ordinal == pool.len() {
                    pool.push(frame.temporary(storage)?);
                }
                arm.operands.push(pool[*ordinal]);
                *ordinal += 1;
            }
            frame.catch_arm(
                arm.selector,
                arm.operands.clone(),
                arm.uses_exception_recipe,
            )?;
        }
        self.allocated = true;
        Ok(())
    }

    pub fn bind_types(&mut self, support: &mut ActivationSupportCatalog) -> Result<()> {
        self.resolve_types(|parameters, results| support.block_type(parameters, results))
    }

    pub fn bind_frozen_types(&mut self, support: &FrozenActivationSupport) -> Result<()> {
        self.resolve_types(|parameters, results| support.lookup_block_type(parameters, results))
    }

    fn resolve_types(
        &mut self,
        mut resolve: impl FnMut(&[ValType], &[ValType]) -> Result<BlockType>,
    ) -> Result<()> {
        ensure!(
            self.allocated,
            "catch storage must be allocated before binding types"
        );
        let mut remaining_work = self.work_budget;
        for region in self.regions.values_mut() {
            remaining_work = remaining_work
                .checked_sub(
                    region
                        .parameters
                        .len()
                        .saturating_mul(2)
                        .saturating_add(region.results.len()),
                )
                .context("catch type planning exceeds work budget")?;
            region.outer_type = Some(resolve(&region.parameters, &region.results)?);
            region.private_type = Some(resolve(&region.parameters, &[])?);
            for arm in &mut region.arms {
                remaining_work = remaining_work
                    .checked_sub(
                        region
                            .parameters
                            .len()
                            .saturating_add(arm.payload.len())
                            .saturating_add(1),
                    )
                    .context("catch type planning exceeds work budget")?;
                let mut results = arm.payload.clone();
                if arm.is_ref() || arm.uses_exception_recipe {
                    let mut exception = RefType::EXNREF;
                    exception.nullable = false;
                    results.push(ValType::Ref(exception));
                }
                arm.capture_type = Some(resolve(&region.parameters, &results)?);
            }
        }
        Ok(())
    }
}

impl NativeCatchArm {
    pub fn is_ref(&self) -> bool {
        matches!(self.kind, HandlerKind::CatchRef | HandlerKind::CatchAllRef)
    }
}

fn charge(remaining: &mut usize, values: usize, record_bytes: usize) -> Result<()> {
    let bytes = values
        .checked_mul(128)
        .and_then(|bytes| bytes.checked_add(record_bytes))
        .context("catch metadata overflow")?;
    *remaining = remaining
        .checked_sub(bytes)
        .context("catch plan exceeds metadata budget")?;
    Ok(())
}
