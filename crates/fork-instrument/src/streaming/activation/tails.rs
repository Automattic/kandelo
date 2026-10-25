//! Tail transfers do not own replay frames. Freeze their transport targets
//! separately so both activation bodies and transparent tail-only bodies can
//! preserve the original `return_call` operation.
use super::{ActivationCallTarget, ActivationSupportCatalog, FrozenActivationSupport};
use crate::streaming::{FunctionIr, ProgramPoint, Scan, SourceTypes};
use anyhow::{Context, Result, ensure};
use std::collections::{BTreeMap, BTreeSet};
use wasm_encoder::{Function, Instruction, ValType, reencode::Reencode};
use wasmparser::Operator;

#[derive(Clone, Copy, Debug)]
pub struct TailLimits {
    pub metadata_bytes: usize,
    pub work: usize,
}
impl Default for TailLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            work: crate::limits::LOCAL_WORK,
        }
    }
}

pub struct TailTransferPlan {
    function: u32,
    transports: BTreeMap<ProgramPoint, u32>,
}

impl TailTransferPlan {
    /// `selected` contains exact original points from the control closure.
    /// Local direct tails stay lexical; imported and dynamic tails reuse the
    /// same frozen transports as ordinary call boundaries.
    #[allow(clippy::too_many_arguments)]
    pub fn plan<T: Reencode>(
        scan: &Scan<'_>,
        body: &FunctionIr<'_>,
        source_types: &SourceTypes,
        map: &mut T,
        selected: &BTreeSet<ProgramPoint>,
        support: &mut ActivationSupportCatalog,
        limits: TailLimits,
    ) -> Result<Self>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        Self::build(
            scan,
            body,
            source_types,
            map,
            selected,
            limits,
            |target, parameters, results| support.transport(target, parameters, results),
        )
    }

    /// Rebuild and discard one body's routes during the emission pass. Only
    /// frozen helper identities survive between the declaration and emission
    /// passes; retaining every function's tail plan is unnecessary.
    #[allow(clippy::too_many_arguments)]
    pub fn from_frozen<T: Reencode>(
        scan: &Scan<'_>,
        body: &FunctionIr<'_>,
        source_types: &SourceTypes,
        map: &mut T,
        selected: &BTreeSet<ProgramPoint>,
        support: &FrozenActivationSupport,
        limits: TailLimits,
    ) -> Result<Self>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        Self::build(
            scan,
            body,
            source_types,
            map,
            selected,
            limits,
            |target, parameters, results| support.lookup_transport(target, parameters, results),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn build<T: Reencode>(
        scan: &Scan<'_>,
        body: &FunctionIr<'_>,
        source_types: &SourceTypes,
        map: &mut T,
        selected: &BTreeSet<ProgramPoint>,
        limits: TailLimits,
        mut resolve_transport: impl FnMut(ActivationCallTarget, &[ValType], &[ValType]) -> Result<u32>,
    ) -> Result<Self>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        let summary = scan
            .functions
            .get(body.function as usize)
            .and_then(|function| function.body.as_ref())
            .context("tail plan requires an original local function")?;
        ensure!(
            summary.range == body.source.range()
                && std::ptr::eq(
                    scan.input()[summary.range.clone()].as_ptr(),
                    body.source.as_bytes().as_ptr()
                ),
            "tail plan requires the original source body"
        );
        let first = ProgramPoint {
            function: body.function,
            offset: 0,
        };
        let last = ProgramPoint {
            function: body.function,
            offset: usize::MAX,
        };
        let sites = selected.range(first..=last);
        ensure!(
            sites.clone().count() <= limits.metadata_bytes / 128,
            "tail plan exceeds metadata budget"
        );

        let types = scan.types.as_ref();
        let mut remaining_work = limits.work;
        let mut transports = BTreeMap::new();
        for &point in sites {
            remaining_work = remaining_work
                .checked_sub(1 + body.instructions.len().ilog2() as usize)
                .context("tail planning exceeds work budget")?;
            let index = body
                .instructions
                .binary_search_by_key(&point.offset, |source| source.point.offset)
                .map_err(|_| anyhow::anyhow!("tail point is not an original instruction"))?;
            let source = &body.instructions[index];
            ensure!(
                source.retained,
                "tail point belongs to a detached source region"
            );
            let (target, signature) = match source.operation {
                Operator::ReturnCall { function_index } => {
                    let callee = scan
                        .functions
                        .get(function_index as usize)
                        .context("unknown tail callee")?;
                    if callee.import.is_none() {
                        continue;
                    }
                    (
                        ActivationCallTarget::Direct(map.function_index(function_index)?),
                        callee.ty,
                    )
                }
                Operator::ReturnCallIndirect {
                    type_index,
                    table_index,
                } => (
                    ActivationCallTarget::Indirect {
                        table: map.table_index(table_index)?,
                        signature: map.type_index(type_index)?,
                        table64: types.table_at(table_index).table64,
                    },
                    type_index,
                ),
                Operator::ReturnCallRef { type_index } => (
                    ActivationCallTarget::Reference {
                        signature: map.type_index(type_index)?,
                    },
                    type_index,
                ),
                _ => anyhow::bail!("selected tail point is not a tail transfer"),
            };
            let signature = types
                .get(types.core_type_at_in_module(signature))
                .unwrap()
                .composite_type
                .unwrap_func();
            let values = signature
                .params()
                .len()
                .checked_add(signature.results().len())
                .context("tail signature size overflow")?;
            ensure!(
                values <= limits.metadata_bytes / 128,
                "tail signature exceeds metadata budget"
            );
            remaining_work = remaining_work
                .checked_sub(values)
                .context("tail planning exceeds work budget")?;
            let parameters = signature
                .params()
                .iter()
                .map(|&ty| source_types.value_type(map, ty))
                .collect::<Result<Vec<_>>>()?;
            let results = signature
                .results()
                .iter()
                .map(|&ty| source_types.value_type(map, ty))
                .collect::<Result<Vec<_>>>()?;
            transports.insert(point, resolve_transport(target, &parameters, &results)?);
        }
        Ok(Self {
            function: body.function,
            transports,
        })
    }

    pub fn function(&self) -> u32 {
        self.function
    }

    /// Called after index remapping. A replacement keeps the operand order
    /// and tail return, including the extra selector or function reference.
    pub fn rewrite<'a>(
        &self,
        point: ProgramPoint,
        instruction: Instruction<'a>,
    ) -> Result<Instruction<'a>> {
        ensure!(
            point.function == self.function,
            "tail plan names another function"
        );
        let Some(&helper) = self.transports.get(&point) else {
            return Ok(instruction);
        };
        ensure!(
            matches!(
                instruction,
                Instruction::ReturnCall(_)
                    | Instruction::ReturnCallIndirect { .. }
                    | Instruction::ReturnCallRef(_)
            ),
            "frozen tail route no longer names a tail transfer"
        );
        Ok(Instruction::ReturnCall(helper))
    }

    /// Transparent functions keep their original locals and structured body.
    /// They need transport routing even though they never save a replay frame.
    pub fn emit_function<T: Reencode>(
        &self,
        body: &FunctionIr<'_>,
        map: &mut T,
        output_limit: usize,
    ) -> Result<Function>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        ensure!(
            body.function == self.function,
            "tail plan names another function"
        );
        let mut output = map.new_function_with_parsed_locals(&body.source)?;
        for source in &body.instructions {
            output.instruction(
                &self.rewrite(source.point, map.instruction(source.operation.clone())?)?,
            );
            ensure!(
                output.byte_len() <= output_limit,
                "tail rewrite exceeds output budget"
            );
        }
        Ok(output)
    }
}

pub(super) fn is_tail_transfer(operation: &Operator<'_>) -> bool {
    matches!(
        operation,
        Operator::ReturnCall { .. }
            | Operator::ReturnCallIndirect { .. }
            | Operator::ReturnCallRef { .. }
    )
}
