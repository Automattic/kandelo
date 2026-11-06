use super::{Budget, add_reference};
use crate::streaming::{FrameBuilder, FrameLayout, FunctionIr, LocalKey};
use anyhow::{Context, Result, ensure};
use std::ops::Range;
use wasm_encoder::{Function, ValType, reencode::Reencode};
use wasmparser::Operator;

#[derive(Debug)]
pub enum OperandMaterialization {
    Empty,
    /// Bottom-to-top virtual/physical locals. Capture pops in reverse order.
    Spill(Vec<LocalKey>),
    /// Remove this suffix from its normal chunk and reissue at the landing.
    Replay(Range<usize>),
}
impl OperandMaterialization {
    pub fn chunk_end(&self, original_end: usize) -> usize {
        match self {
            Self::Replay(span) => span.start,
            _ => original_end,
        }
    }
    pub fn emit_capture(
        &self,
        layout: &FrameLayout,
        output: &mut Function,
        limit: usize,
    ) -> Result<()> {
        if let Self::Spill(values) = self {
            for &key in values.iter().rev() {
                layout.emit_set(key, output, limit)?;
            }
        }
        ensure!(
            output.byte_len() <= limit,
            "operand capture exceeds output budget"
        );
        Ok(())
    }
    pub fn emit_restore<T: Reencode>(
        &self,
        body: &FunctionIr<'_>,
        layout: &FrameLayout,
        map: &mut T,
        output: &mut Function,
        limit: usize,
    ) -> Result<()>
    where
        T::Error: std::error::Error + Send + Sync + 'static,
    {
        match self {
            Self::Empty => {}
            Self::Spill(values) => {
                for &key in values {
                    layout.emit_get(key, output, limit)?;
                }
            }
            Self::Replay(span) => {
                for instruction in body
                    .instructions
                    .get(span.clone())
                    .context("invalid operand replay span")?
                {
                    if let Operator::LocalGet { local_index } = instruction.operation {
                        layout.emit_get(LocalKey(local_index), output, limit)?;
                    } else {
                        output.instruction(&map.instruction(instruction.operation.clone())?);
                    }
                    ensure!(
                        output.byte_len() <= limit,
                        "operand replay exceeds output budget"
                    );
                }
            }
        }
        ensure!(
            output.byte_len() <= limit,
            "operand restore exceeds output budget"
        );
        Ok(())
    }
}

pub(super) fn plan(
    body: &FunctionIr<'_>,
    chunk: Range<usize>,
    types: &[ValType],
    pure_allowed: bool,
    frame: &mut FrameBuilder,
    budget: &mut Budget,
) -> Result<OperandMaterialization> {
    if types.is_empty() {
        return Ok(OperandMaterialization::Empty);
    }
    if pure_allowed {
        if let Some(span) = pure_suffix(body, frame, chunk, types, budget)? {
            return Ok(OperandMaterialization::Replay(span));
        }
    }
    Ok(OperandMaterialization::Spill(
        types
            .iter()
            .map(|&ty| frame.saved(ty))
            .collect::<Result<_>>()?,
    ))
}

/// Every allowed operator has exactly one output. Walking its expression
/// backwards determines the only closed suffix with the requested outputs.
/// This avoids the oracle's repeated forward simulations of overlapping tails.
fn pure_suffix(
    body: &FunctionIr<'_>,
    frame: &FrameBuilder,
    chunk: Range<usize>,
    outputs: &[ValType],
    budget: &mut Budget,
) -> Result<Option<Range<usize>>> {
    budget.values(outputs.len())?;
    let mut needed = outputs.to_vec();
    for index in chunk.clone().rev() {
        budget.step(1)?;
        let op = &body.instructions[index].operation;
        let Some((inputs, arity, output)) = signature(op, frame)? else {
            return Ok(None);
        };
        if needed.pop() != Some(output) {
            return Ok(None);
        }
        budget.values(arity)?;
        needed.extend_from_slice(&inputs[..arity]);
        if needed.is_empty() {
            return Ok(Some(index..chunk.end));
        }
    }
    Ok(None)
}

fn signature(
    op: &Operator<'_>,
    frame: &FrameBuilder,
) -> Result<Option<([ValType; 2], usize, ValType)>> {
    use Operator::*;
    use ValType::{F32, F64, I32, I64};
    let result = match op {
        I32Const { .. } => ([I32; 2], 0, I32),
        I64Const { .. } => ([I32; 2], 0, I64),
        F32Const { .. } => ([I32; 2], 0, F32),
        F64Const { .. } => ([I32; 2], 0, F64),
        LocalGet { local_index } => ([I32; 2], 0, frame.local(LocalKey(*local_index))?.ty),
        I32Eqz | I32Clz | I32Ctz | I32Popcnt | I32Extend8S | I32Extend16S => ([I32; 2], 1, I32),
        I64Eqz | I32WrapI64 => ([I64; 2], 1, I32),
        I64Clz | I64Ctz | I64Popcnt | I64Extend8S | I64Extend16S | I64Extend32S => {
            ([I64; 2], 1, I64)
        }
        I64ExtendI32S | I64ExtendI32U => ([I32; 2], 1, I64),
        I32Eq | I32Ne | I32LtS | I32LtU | I32GtS | I32GtU | I32LeS | I32LeU | I32GeS | I32GeU
        | I32Add | I32Sub | I32Mul | I32And | I32Or | I32Xor | I32Shl | I32ShrS | I32ShrU
        | I32Rotl | I32Rotr => ([I32; 2], 2, I32),
        I64Eq | I64Ne | I64LtS | I64LtU | I64GtS | I64GtU | I64LeS | I64LeU | I64GeS | I64GeU => {
            ([I64; 2], 2, I32)
        }
        I64Add | I64Sub | I64Mul | I64And | I64Or | I64Xor | I64Shl | I64ShrS | I64ShrU
        | I64Rotl | I64Rotr => ([I64; 2], 2, I64),
        _ => return Ok(None),
    };
    Ok(Some(result))
}

pub(super) fn reference_inputs(
    body: &FunctionIr<'_>,
    frame: &FrameBuilder,
    materialization: &OperandMaterialization,
    output: &mut Vec<LocalKey>,
    budget: &mut Budget,
) -> Result<()> {
    match materialization {
        OperandMaterialization::Empty => {}
        OperandMaterialization::Spill(values) => {
            for &key in values {
                budget.step(1)?;
                if matches!(frame.local(key)?.ty, ValType::Ref(_)) {
                    add_reference(output, key, budget)?;
                }
            }
        }
        OperandMaterialization::Replay(span) => {
            for index in span.clone() {
                budget.step(1)?;
                if let Operator::LocalGet { local_index } = body.instructions[index].operation {
                    let key = LocalKey(local_index);
                    if matches!(frame.local(key)?.ty, ValType::Ref(_)) {
                        add_reference(output, key, budget)?;
                    }
                }
            }
        }
    }
    Ok(())
}
