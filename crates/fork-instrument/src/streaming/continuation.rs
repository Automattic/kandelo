//! Function-local landing partition and activation-owned operand planning.
//! Instruction spans borrow the original IR by index: no instruction clones,
//! recursive region walks, or module-wide continuation arena are needed.

mod dispatch;
mod materialize;
pub use dispatch::*;
pub use materialize::OperandMaterialization;

use super::{
    FrameBuilder, FrameEnvironment, FrameLayout, FrameLimits, FrameReferencePlan, FunctionIr,
    LocalKey, ProgramPoint, ReferenceCallKind, ReferenceLimits, RegionId, RegionKind, Scan,
    SourceTypes, analyze_references,
};
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeSet, ops::Range};
use wasm_encoder::{ValType, reencode::Reencode};
use wasmparser::{BlockType, Operator};

#[derive(Clone, Copy, Debug)]
pub struct ContinuationLimits {
    pub metadata_bytes: usize,
    pub values: usize,
    pub work: usize,
    pub frame: FrameLimits,
    pub references: ReferenceLimits,
}
impl Default for ContinuationLimits {
    fn default() -> Self {
        Self {
            metadata_bytes: 64 * 1024 * 1024,
            values: 1_000_000,
            work: crate::limits::LOCAL_WORK,
            frame: FrameLimits::default(),
            references: ReferenceLimits::default(),
        }
    }
}

struct Budget {
    bytes: usize,
    values: usize,
    work: usize,
}
impl Budget {
    fn charge(&mut self, bytes: usize) -> Result<()> {
        self.bytes = self
            .bytes
            .checked_sub(bytes)
            .context("continuation metadata exceeds budget")?;
        Ok(())
    }
    fn values(&mut self, count: usize) -> Result<()> {
        self.values = self
            .values
            .checked_sub(count)
            .context("continuation values exceed budget")?;
        self.charge(
            count
                .checked_mul(128)
                .context("continuation value size overflow")?,
        )
    }
    fn step(&mut self, count: usize) -> Result<()> {
        self.work = self
            .work
            .checked_sub(count)
            .context("continuation planning exceeds work budget")?;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct SequenceId(pub usize);

#[derive(Debug)]
pub struct CallContinuation {
    pub point: ProgramPoint,
    pub instruction: usize,
    pub kind: ReferenceCallKind,
    /// Final output type ID; original points/kinds keep original source IDs.
    pub signature: u32,
    pub arguments: OperandMaterialization,
    pub carryovers: Vec<LocalKey>,
}

#[derive(Debug)]
pub enum ContinuationLandingKind {
    Call(u32),
    Region {
        region: RegionId,
        /// If arms have distinct call ranges, used to force the replay arm.
        arms: Vec<SequenceId>,
        inputs: OperandMaterialization,
    },
}
#[derive(Debug)]
pub struct ContinuationLanding {
    /// Original flat instruction span, including the enclosing region end.
    pub source: Range<usize>,
    /// Half-open, function-local call ordinal range.
    pub calls: Range<u32>,
    pub kind: ContinuationLandingKind,
}
#[derive(Debug)]
pub struct ContinuationSequence {
    pub region: RegionId,
    /// Zero is the body/then arm; subsequent arms are else/legacy handlers.
    pub arm: usize,
    pub source: Range<usize>,
    pub calls: Option<Range<u32>>,
    /// Parameters are temporary: set on every normal and replay region entry.
    pub input_parameters: Vec<LocalKey>,
    pub chunks: Vec<Range<usize>>,
    pub landings: Vec<ContinuationLanding>,
}
pub struct ContinuationPlan {
    pub function: u32,
    pub calls: Vec<CallContinuation>,
    pub sequences: Vec<ContinuationSequence>,
    pub frame: FrameLayout,
    pub references: FrameReferencePlan,
    pub condition: Option<LocalKey>,
}

fn extend(target: &mut Option<Range<u32>>, range: &Range<u32>) {
    if let Some(target) = target {
        target.start = target.start.min(range.start);
        target.end = target.end.max(range.end);
    } else {
        *target = Some(range.clone());
    }
}

/// Plans ordinary call landings, including modern/legacy handler bodies.
/// Tail transfers and exception ownership/normalization are separate rewrites;
/// this plan alone does not make an executable fork artifact.
#[allow(clippy::too_many_arguments)]
pub fn plan_continuations<T: Reencode>(
    scan: &Scan<'_>,
    body: &FunctionIr<'_>,
    source_types: &SourceTypes,
    map: &mut T,
    environment: FrameEnvironment,
    targets: &BTreeSet<u32>,
    limits: ContinuationLimits,
) -> Result<ContinuationPlan>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    Ok(plan_continuations_with(
        scan,
        body,
        source_types,
        map,
        environment,
        targets,
        limits,
        |_, _, _, _| Ok(()),
    )?
    .0)
}

/// Reserve wrapper/codec temporaries while the frame layout is still open.
/// Extension state must remain function-local; module helper catalogs retain
/// only compact frozen recipes, never this plan or source instruction IR.
#[allow(clippy::too_many_arguments)]
pub fn plan_continuations_with<T: Reencode, R>(
    scan: &Scan<'_>,
    body: &FunctionIr<'_>,
    source_types: &SourceTypes,
    map: &mut T,
    environment: FrameEnvironment,
    targets: &BTreeSet<u32>,
    limits: ContinuationLimits,
    extension: impl FnOnce(
        &mut FrameBuilder,
        &[CallContinuation],
        &[ContinuationSequence],
        &mut [Vec<LocalKey>],
    ) -> Result<R>,
) -> Result<(ContinuationPlan, R)>
where
    T::Error: std::error::Error + Send + Sync + 'static,
{
    // The builder verifies both source identity and signature before any plan.
    let mut frame = FrameBuilder::new(scan, body, source_types, map, environment, limits.frame)?;
    let mut budget = Budget {
        bytes: limits.metadata_bytes,
        values: limits.values,
        work: limits.work,
    };
    budget.charge(
        body.regions
            .len()
            .checked_mul(256)
            .context("continuation region size overflow")?,
    )?;
    let mut sequences = Vec::new();
    let mut arms = vec![Vec::new(); body.regions.len()];
    for (index, region) in body.regions.iter().enumerate() {
        let start = region.opener.map_or(0, |i| i + 1);
        let boundaries = region
            .alternative
            .into_iter()
            .chain(
                region
                    .handlers
                    .iter()
                    .filter(|h| h.target.is_none())
                    .map(|h| h.instruction),
            )
            .chain(std::iter::once(region.end));
        let mut start = start;
        for (arm, end) in boundaries.enumerate() {
            budget.charge(512)?;
            arms[index].push(SequenceId(sequences.len()));
            sequences.push(ContinuationSequence {
                region: RegionId(index),
                arm,
                source: start..end,
                calls: None,
                input_parameters: Vec::new(),
                chunks: Vec::new(),
                landings: Vec::new(),
            });
            start = end + 1;
        }
    }
    // Region ownership is found iteratively; nested depth cannot exhaust the
    // native stack. The state is one arm cursor per region, not per operator.
    let mut cursors = vec![0usize; body.regions.len()];
    let mut parents = vec![None; body.regions.len()];
    let mut call_by_instruction = std::collections::BTreeMap::new();
    let types = scan.types.as_ref();
    let mut pending = Vec::new();
    let mut typed_calls = body.calls.iter().peekable();
    for (i, instruction) in body.instructions.iter().enumerate() {
        budget.step(1)?;
        let owner = arms[instruction.region.0][cursors[instruction.region.0]];
        if let Some(child) = instruction.opens {
            parents[child.0] = Some(owner);
        }
        if matches!(
            instruction.operation,
            Operator::Else | Operator::Catch { .. } | Operator::CatchAll
        ) {
            cursors[instruction.region.0] += 1;
        }
        let Some(call) = typed_calls.peek().filter(|c| c.instruction == i).copied() else {
            continue;
        };
        typed_calls.next();
        if !instruction.reachable {
            continue;
        }
        let (kind, signature, extra) = match instruction.operation {
            Operator::Call { function_index } if targets.contains(&function_index) => (
                ReferenceCallKind::Direct(function_index),
                scan.functions[function_index as usize].ty,
                None,
            ),
            Operator::CallIndirect {
                type_index,
                table_index,
            } => (
                ReferenceCallKind::Indirect {
                    table: table_index,
                    ty: type_index,
                },
                type_index,
                Some(if types.table_at(table_index).table64 {
                    ValType::I64
                } else {
                    ValType::I32
                }),
            ),
            Operator::CallRef { type_index } => (
                ReferenceCallKind::Ref { ty: type_index },
                type_index,
                Some(ValType::FUNCREF),
            ),
            _ => continue,
        };
        let signature_type = types
            .get(types.core_type_at_in_module(signature))
            .unwrap()
            .composite_type
            .unwrap_func();
        let count = signature_type.params().len() + usize::from(extra.is_some());
        let carry_end = call
            .operand_stack
            .len()
            .checked_sub(count)
            .context("continuation call missing operands")?;
        ensure!(
            carry_end >= call.operand_base,
            "call operands cross control frame"
        );
        budget.charge(512)?;
        budget.values(count + carry_end - call.operand_base)?;
        let mut arguments = signature_type
            .params()
            .iter()
            .map(|&ty| source_types.value_type(map, ty))
            .collect::<Result<Vec<_>>>()?;
        arguments.extend(extra);
        let carryovers = call.operand_stack[call.operand_base..carry_end]
            .iter()
            .map(|ty| {
                source_types.value_type(map, ty.context("polymorphic continuation carryover")?)
            })
            .collect::<Result<Vec<_>>>()?;
        let ordinal = u32::try_from(pending.len())?;
        call_by_instruction.insert(i, ordinal);
        extend(&mut sequences[owner.0].calls, &(ordinal..ordinal + 1));
        pending.push((i, kind, map.type_index(signature)?, arguments, carryovers));
    }
    // Children have larger region IDs. Propagate only endpoints; retaining a
    // list of every descendant call at every ancestor would grow with depth.
    let mut region_calls = vec![None; body.regions.len()];
    for region in (0..body.regions.len()).rev() {
        for &sequence in &arms[region] {
            if let Some(range) = &sequences[sequence.0].calls {
                extend(&mut region_calls[region], range);
            }
        }
        if let (Some(parent), Some(range)) = (parents[region], &region_calls[region]) {
            extend(&mut sequences[parent.0].calls, range);
        }
    }
    // Partition by original spans. Non-fork child regions stay wholly inside a
    // chunk and are skipped here, so each source operator is visited O(1) times.
    let mut argument_chunks = vec![0..0; pending.len()];
    for sequence in &mut sequences {
        if sequence.calls.is_none() {
            continue;
        }
        let mut start = sequence.source.start;
        let mut i = start;
        while i < sequence.source.end {
            budget.step(1)?;
            let instruction = &body.instructions[i];
            let landing = if let Some(&call) = call_by_instruction.get(&i) {
                argument_chunks[call as usize] = start..i;
                Some((i + 1, call..call + 1, ContinuationLandingKind::Call(call)))
            } else if let Some(child) = instruction.opens {
                let end = body.regions[child.0].end + 1;
                if let Some(range) = &region_calls[child.0] {
                    budget.charge(
                        arms[child.0]
                            .len()
                            .checked_mul(32)
                            .context("continuation arm size overflow")?,
                    )?;
                    Some((
                        end,
                        range.clone(),
                        ContinuationLandingKind::Region {
                            region: child,
                            arms: arms[child.0].clone(),
                            inputs: OperandMaterialization::Empty,
                        },
                    ))
                } else {
                    i = end;
                    continue;
                }
            } else {
                i += 1;
                continue;
            };
            if let Some((end, calls, kind)) = landing {
                budget.charge(512)?;
                sequence.chunks.push(start..i);
                sequence.landings.push(ContinuationLanding {
                    source: i..end,
                    calls,
                    kind,
                });
                start = end;
                i = end;
            }
        }
        budget.charge(32)?;
        sequence.chunks.push(start..sequence.source.end);
    }
    // Allocate all call arguments, then all call carryovers. This preserves the
    // scalar spill-tail grouping used by the oracle and scratch bulk copies.
    let mut calls = Vec::with_capacity(pending.len());
    for ((i, kind, signature, arguments, _), chunk) in pending.iter().zip(argument_chunks) {
        let arguments = materialize::plan(body, chunk, arguments, true, &mut frame, &mut budget)?;
        calls.push(CallContinuation {
            point: body.instructions[*i].point,
            instruction: *i,
            kind: *kind,
            signature: *signature,
            arguments,
            carryovers: Vec::new(),
        });
    }
    for (call, (_, _, _, _, carryovers)) in calls.iter_mut().zip(&pending) {
        call.carryovers = carryovers
            .iter()
            .map(|&ty| frame.saved(ty))
            .collect::<Result<_>>()?;
    }
    drop(pending);
    let mut synthetic = vec![Vec::new(); calls.len()];
    for (index, call) in calls.iter().enumerate() {
        materialize::reference_inputs(
            body,
            &frame,
            &call.arguments,
            &mut synthetic[index],
            &mut budget,
        )?;
        for &key in &call.carryovers {
            if matches!(frame.local(key)?.ty, ValType::Ref(_)) {
                add_reference(&mut synthetic[index], key, &mut budget)?;
            }
        }
    }
    for sequence in &mut sequences {
        if sequence.calls.is_none() {
            continue;
        }
        for (landing, chunk) in sequence.landings.iter_mut().zip(&mut sequence.chunks) {
            let ContinuationLandingKind::Region { region, inputs, .. } = &mut landing.kind else {
                if let ContinuationLandingKind::Call(call) = landing.kind {
                    chunk.end = calls[call as usize].arguments.chunk_end(chunk.end);
                }
                continue;
            };
            let child = &body.regions[region.0];
            budget.values(child.input_stack.len())?;
            let values = child
                .input_stack
                .iter()
                .map(|ty| source_types.value_type(map, ty.context("polymorphic region carryover")?))
                .collect::<Result<Vec<_>>>()?;
            let pure_allowed = child.kind != RegionKind::If || values.len() == 1;
            *inputs = materialize::plan(
                body,
                chunk.clone(),
                &values,
                pure_allowed,
                &mut frame,
                &mut budget,
            )?;
            chunk.end = inputs.chunk_end(chunk.end);
            let mut references = Vec::new();
            materialize::reference_inputs(body, &frame, inputs, &mut references, &mut budget)?;
            if !references.is_empty() {
                for call in landing.calls.clone() {
                    for &key in &references {
                        add_reference(&mut synthetic[call as usize], key, &mut budget)?;
                    }
                }
            }
        }
    }
    // Every fork-bearing arm gets distinct temporary entry parameters; handler
    // parameters come from its tag rather than the surrounding try signature.
    for sequence in &mut sequences {
        if sequence.calls.is_none() {
            continue;
        }
        let region = &body.regions[sequence.region.0];
        let parameters = if region.kind == RegionKind::Function {
            &[][..]
        } else if region.kind == RegionKind::LegacyTry && sequence.arm != 0 {
            region.handlers[sequence.arm - 1]
                .tag
                .map(|tag| {
                    types
                        .get(types.tag_at(tag))
                        .unwrap()
                        .composite_type
                        .unwrap_func()
                        .params()
                })
                .unwrap_or(&[])
        } else {
            match region.signature {
                BlockType::FuncType(index) => types
                    .get(types.core_type_at_in_module(index))
                    .unwrap()
                    .composite_type
                    .unwrap_func()
                    .params(),
                _ => &[],
            }
        };
        budget.values(parameters.len())?;
        for &ty in parameters {
            sequence
                .input_parameters
                .push(frame.temporary(source_types.value_type(map, ty)?)?);
        }
    }
    let parameter_count = types
        .get(types.core_type_at_in_module(body.type_index))
        .unwrap()
        .composite_type
        .unwrap_func()
        .params()
        .len();
    let reference_parameters: Vec<_> = (0..parameter_count as u32)
        .filter(|&i| matches!(body.locals[i as usize], wasmparser::ValType::Ref(_)))
        .map(LocalKey)
        .collect();
    let analysis = analyze_references(scan, body, targets, limits.references)?;
    ensure!(
        analysis.landings.len() == calls.len(),
        "reference and continuation landing counts disagree"
    );
    let mut nulls = vec![Vec::new(); calls.len()];
    for (index, (reference, call)) in analysis.landings.iter().zip(&calls).enumerate() {
        ensure!(
            reference.point == call.point && reference.kind == call.kind,
            "reference and continuation original points disagree"
        );
        for &key in &reference_parameters {
            add_reference(&mut synthetic[index], key, &mut budget)?;
        }
        if reference.reachable {
            for &local in &reference.live_on_any_successor {
                let key = frame
                    .source_local(local)
                    .context("missing live reference local")?;
                if reference.definitely_null_before.contains(&local)
                    && analysis.locals[&local].is_nullable()
                {
                    budget.values(1)?;
                    nulls[index].push(key);
                } else {
                    add_reference(&mut synthetic[index], key, &mut budget)?;
                }
            }
        }
    }
    let condition = if sequences.iter().flat_map(|s| &s.landings).any(|l| matches!(l.kind,
        ContinuationLandingKind::Region { region, .. } if body.regions[region.0].kind == RegionKind::If)) {
        Some(frame.temporary(ValType::I32)?)
    } else { None };
    let extra = extension(&mut frame, &calls, &sequences, &mut synthetic)?;
    let frame = frame.finish()?;
    let references = frame.reference_plan(&synthetic, &nulls)?;
    Ok((
        ContinuationPlan {
            function: body.function,
            calls,
            sequences,
            frame,
            references,
            condition,
        },
        extra,
    ))
}

fn add_reference(values: &mut Vec<LocalKey>, key: LocalKey, budget: &mut Budget) -> Result<()> {
    budget.step(1)?;
    budget.values(1)?;
    values.push(key);
    Ok(())
}
