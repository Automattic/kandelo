//! Reference planning over one original function. No module instruction arena
//! or synthetic dispatch locals participate in the data-flow fixed points.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use anyhow::{Context, Result, ensure};
use wasmparser::{Operator, RefType, ValType};

use super::{FunctionIr, ProgramPoint, RegionId, RegionKind, Scan, TransferKind};

/// Logical allocation/work limits, in addition to the source IR limits. These
/// are deterministic rejection limits, not an OS physical-footprint guard.
#[derive(Clone, Copy, Debug)]
pub struct ReferenceLimits {
    /// Total u64 words across the live-in and definitely-null state matrices.
    pub state_words: usize,
    pub edges: usize,
    /// Node visits plus state words merged during both fixed points.
    pub work: usize,
    /// Reference values plus landing records retained in the result.
    pub landing_values: usize,
}

impl Default for ReferenceLimits {
    fn default() -> Self {
        Self {
            state_words: 8 * 1024 * 1024,
            edges: 4 * 1024 * 1024,
            work: crate::limits::LOCAL_WORK,
            landing_values: 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReferenceCallKind {
    Direct(u32),
    Indirect { table: u32, ty: u32 },
    Ref { ty: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TypedReference {
    pub index: usize,
    /// Concrete heap IDs use the validator's canonical type catalog.
    pub ty: RefType,
}

#[derive(Debug)]
pub struct ReferenceLanding {
    pub point: ProgramPoint,
    pub kind: ReferenceCallKind,
    pub arguments: Vec<TypedReference>,
    pub results: Vec<TypedReference>,
    pub carryovers: Vec<TypedReference>,
    /// False if a polymorphic stack slot has no concrete type. An empty
    /// carryover list alone never proves that all carried values are scalar.
    pub carryovers_exact: bool,
    pub has_reference_callee: bool,
    pub live_on_normal_return: BTreeSet<u32>,
    pub live_on_any_successor: BTreeSet<u32>,
    pub definitely_null_before: BTreeSet<u32>,
    pub reachable: bool,
}

#[derive(Debug)]
pub struct ReferenceAnalysis {
    pub function: u32,
    pub locals: BTreeMap<u32, RefType>,
    pub landings: Vec<ReferenceLanding>,
}

/// Select direct fork-path calls, and conservatively select indirect/ref calls,
/// just like the oracle. Tail calls are handled by the separate tail plan.
/// The caller must discard this result before analyzing another function.
pub fn analyze_references(
    scan: &Scan<'_>,
    body: &FunctionIr<'_>,
    targets: &BTreeSet<u32>,
    limits: ReferenceLimits,
) -> Result<ReferenceAnalysis> {
    let summary = scan
        .functions
        .get(body.function as usize)
        .context("unknown function")?;
    ensure!(
        summary
            .body
            .as_ref()
            .is_some_and(|b| b.range == body.source.range()
                && std::ptr::eq(
                    scan.input()[b.range.clone()].as_ptr(),
                    body.source.as_bytes().as_ptr()
                ))
            && summary.ty == body.type_index,
        "reference analysis requires the original source function"
    );
    let types = scan.types.as_ref();
    let signature = types
        .get(types.core_type_at_in_module(body.type_index))
        .unwrap()
        .composite_type
        .unwrap_func();
    let mut used = BTreeSet::from_iter(0..signature.params().len() as u32);
    for instruction in body.instructions.iter().filter(|i| i.reachable) {
        match instruction.operation {
            Operator::LocalGet { local_index }
            | Operator::LocalSet { local_index }
            | Operator::LocalTee { local_index } => {
                used.insert(local_index);
            }
            _ => {}
        }
    }
    let locals: BTreeMap<_, _> = used
        .into_iter()
        .filter_map(|i| match body.locals[i as usize] {
            ValType::Ref(ty) => Some((i, ty)),
            _ => None,
        })
        .collect();
    let slots: BTreeMap<_, _> = locals
        .keys()
        .copied()
        .enumerate()
        .map(|(i, l)| (l, i))
        .collect();
    let words = locals.len().div_ceil(64);
    let nodes = body
        .instructions
        .len()
        .checked_add(1)
        .context("reference node count overflow")?;
    let cells = nodes
        .checked_mul(words)
        .context("reference state size overflow")?;
    ensure!(
        cells <= limits.state_words / 2,
        "reference analysis exceeds state budget"
    );
    let cfg = Cfg::new(body, limits.edges)?;
    let mut work = limits.work;
    let live = liveness(body, &cfg, &slots, words, cells, &mut work)?;
    let (null, reachable) = nullability(
        body,
        &cfg,
        &slots,
        signature.params().len(),
        words,
        cells,
        &mut work,
    )?;
    let local_set = |bits: &[u64]| -> BTreeSet<u32> {
        slots
            .iter()
            .filter_map(|(&l, &slot)| has(bits, slot).then_some(l))
            .collect()
    };
    let mut remaining = limits.landing_values;
    let mut landings = Vec::new();
    for call in &body.calls {
        let i = call.instruction;
        let instruction = &body.instructions[i];
        if !instruction.reachable {
            continue;
        }
        let (kind, ty, extra) = match instruction.operation {
            Operator::Call { function_index } if targets.contains(&function_index) => (
                ReferenceCallKind::Direct(function_index),
                scan.functions[function_index as usize].ty,
                0,
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
                1,
            ),
            Operator::CallRef { type_index } => {
                (ReferenceCallKind::Ref { ty: type_index }, type_index, 1)
            }
            _ => continue,
        };
        let signature = types
            .get(types.core_type_at_in_module(ty))
            .unwrap()
            .composite_type
            .unwrap_func();
        let consumed = signature.params().len() + extra;
        let carryover_count = call
            .operand_stack
            .len()
            .checked_sub(consumed)
            .context("missing call operands")?;
        let mut any = vec![0; words];
        for &successor in &cfg.next[i] {
            for (out, input) in any.iter_mut().zip(row(&live, successor, words)) {
                *out |= input;
            }
        }
        let count_refs = |values: &[ValType]| {
            values
                .iter()
                .filter(|t| matches!(t, ValType::Ref(_)))
                .count()
        };
        let count_bits = |bits: &[u64]| bits.iter().map(|w| w.count_ones() as usize).sum::<usize>();
        let count = 1
            + count_refs(signature.params())
            + count_refs(signature.results())
            + call.operand_stack[..carryover_count]
                .iter()
                .filter(|t| matches!(t, Some(ValType::Ref(_))))
                .count()
            + count_bits(row(&live, i + 1, words))
            + count_bits(&any)
            + count_bits(row(&null, i, words));
        ensure!(
            count <= remaining,
            "reference analysis exceeds landing-value budget"
        );
        remaining -= count;
        let refs = |values: &[ValType]| {
            values
                .iter()
                .enumerate()
                .filter_map(|(index, ty)| match ty {
                    ValType::Ref(ty) => Some(TypedReference { index, ty: *ty }),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        let arguments = refs(signature.params());
        let results = refs(signature.results());
        let carryovers = call.operand_stack[..carryover_count]
            .iter()
            .enumerate()
            .filter_map(|(index, ty)| match ty {
                Some(ValType::Ref(ty)) => Some(TypedReference { index, ty: *ty }),
                _ => None,
            })
            .collect::<Vec<_>>();
        let normal = local_set(row(&live, i + 1, words));
        let any = local_set(&any);
        let null = local_set(row(&null, i, words));
        landings.push(ReferenceLanding {
            point: instruction.point,
            kind,
            arguments,
            results,
            carryovers,
            carryovers_exact: call.operand_stack[..carryover_count]
                .iter()
                .all(Option::is_some),
            has_reference_callee: matches!(kind, ReferenceCallKind::Ref { .. }),
            live_on_normal_return: normal,
            live_on_any_successor: any,
            definitely_null_before: null,
            reachable: reachable[i],
        });
    }
    Ok(ReferenceAnalysis {
        function: body.function,
        locals,
        landings,
    })
}

struct Cfg {
    next: Vec<Vec<usize>>,
    previous: Vec<Vec<usize>>,
    /// The taken target for branches and the true target for `if`.
    taken: Vec<Option<usize>>,
}

impl Cfg {
    fn new(body: &FunctionIr<'_>, limit: usize) -> Result<Self> {
        let n = body.instructions.len();
        let mut cfg = Self {
            next: vec![vec![]; n + 1],
            previous: vec![vec![]; n + 1],
            taken: vec![None; n],
        };
        let mut remaining = limit;
        let mut transfers = body.transfers.iter().peekable();
        for (i, instruction) in body.instructions.iter().enumerate() {
            let transfer = transfers.next_if(|t| t.instruction == i);
            let mut add = |to: usize| -> Result<()> {
                ensure!(to <= n, "invalid reference CFG target");
                if !cfg.next[i].contains(&to) {
                    ensure!(remaining > 0, "reference analysis exceeds edge budget");
                    remaining -= 1;
                    cfg.next[i].push(to);
                    cfg.previous[to].push(i);
                }
                Ok(())
            };
            match instruction.operation {
                Operator::If { .. } => {
                    let region = &body.regions[instruction.opens.unwrap().0];
                    cfg.taken[i] = Some(i + 1);
                    add(i + 1)?;
                    add(region.alternative.map_or(region.end + 1, |pc| pc + 1))?;
                }
                Operator::Else | Operator::Catch { .. } | Operator::CatchAll => {
                    add(body.regions[instruction.region.0].end + 1)?;
                }
                Operator::Br { .. }
                | Operator::BrIf { .. }
                | Operator::BrTable { .. }
                | Operator::BrOnNull { .. }
                | Operator::BrOnNonNull { .. }
                | Operator::BrOnCast { .. }
                | Operator::BrOnCastFail { .. } => {
                    let transfer = transfer.context("missing source branch")?;
                    for &target in &transfer.targets {
                        add(label(body, target))?;
                    }
                    cfg.taken[i] = transfer.targets.first().map(|&r| label(body, r));
                    if transfer.kind == TransferKind::Conditional {
                        add(i + 1)?;
                    }
                }
                Operator::Return
                | Operator::ReturnCall { .. }
                | Operator::ReturnCallIndirect { .. }
                | Operator::ReturnCallRef { .. } => add(n)?,
                Operator::Call { .. }
                | Operator::CallIndirect { .. }
                | Operator::CallRef { .. } => {
                    add(i + 1)?;
                    exception_edges(body, i, None, &mut add)?;
                }
                Operator::Throw { tag_index } => {
                    exception_edges(body, i, Some(tag_index), &mut add)?
                }
                Operator::ThrowRef | Operator::Rethrow { .. } => {
                    exception_edges(body, i, None, &mut add)?
                }
                Operator::Unreachable => {}
                _ => add(i + 1)?,
            }
        }
        Ok(cfg)
    }
}

fn label(body: &FunctionIr<'_>, target: RegionId) -> usize {
    let region = &body.regions[target.0];
    if region.kind == RegionKind::Loop {
        region.opener.unwrap() + 1
    } else {
        region.end + 1
    }
}

fn exception_edges(
    body: &FunctionIr<'_>,
    pc: usize,
    tag: Option<u32>,
    add: &mut impl FnMut(usize) -> Result<()>,
) -> Result<()> {
    let mut region = Some(body.instructions[pc].region);
    while let Some(id) = region {
        let r = &body.regions[id.0];
        region = r.parent;
        // Exceptions inside a legacy handler propagate to its enclosing try,
        // never to a sibling handler. Modern catch clauses branch outwards.
        if r.kind == RegionKind::LegacyTry
            && r.handlers.first().is_some_and(|h| pc >= h.instruction)
        {
            continue;
        }
        for handler in &r.handlers {
            if handler.tag.is_none() || tag.is_none() || handler.tag == tag {
                add(handler
                    .target
                    .map_or(handler.instruction + 1, |r| label(body, r)))?;
                if tag.is_some() || handler.tag.is_none() {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

fn row(bits: &[u64], node: usize, words: usize) -> &[u64] {
    &bits[node * words..(node + 1) * words]
}
fn has(bits: &[u64], slot: usize) -> bool {
    bits[slot / 64] & (1 << (slot % 64)) != 0
}
fn set(bits: &mut [u64], slot: usize, value: bool) {
    if value {
        bits[slot / 64] |= 1 << (slot % 64);
    } else {
        bits[slot / 64] &= !(1 << (slot % 64));
    }
}
fn spend(work: &mut usize, cost: usize) -> Result<()> {
    ensure!(cost <= *work, "reference analysis exceeds work budget");
    *work -= cost;
    Ok(())
}

fn liveness(
    body: &FunctionIr<'_>,
    cfg: &Cfg,
    slots: &BTreeMap<u32, usize>,
    words: usize,
    cells: usize,
    work: &mut usize,
) -> Result<Vec<u64>> {
    let mut live = vec![0; cells];
    let mut queue: VecDeque<_> = (0..body.instructions.len()).rev().collect();
    let mut queued = vec![true; cfg.next.len()];
    let mut next = vec![0; words];
    while let Some(pc) = queue.pop_front() {
        spend(work, 1)?;
        queued[pc] = false;
        next.fill(0);
        for &successor in &cfg.next[pc] {
            spend(work, words)?;
            for (out, input) in next.iter_mut().zip(row(&live, successor, words)) {
                *out |= input;
            }
        }
        match body.instructions[pc].operation {
            Operator::LocalGet { local_index } => {
                if let Some(&slot) = slots.get(&local_index) {
                    set(&mut next, slot, true);
                }
            }
            Operator::LocalSet { local_index } | Operator::LocalTee { local_index } => {
                if let Some(&slot) = slots.get(&local_index) {
                    set(&mut next, slot, false);
                }
            }
            _ => {}
        }
        if row(&live, pc, words) != next {
            live[pc * words..(pc + 1) * words].copy_from_slice(&next);
            for &previous in &cfg.previous[pc] {
                if !queued[previous] {
                    queue.push_back(previous);
                    queued[previous] = true;
                }
            }
        }
    }
    Ok(live)
}

// No-ops remain in the source-preserving instruction
// list. Only skip lexical nops within the same structured region.
fn previous(body: &FunctionIr<'_>, pc: usize) -> Option<usize> {
    let region = body.instructions[pc].region;
    let mut prev = pc.checked_sub(1)?;
    loop {
        if body.instructions[prev].region != region {
            return None;
        }
        if !matches!(body.instructions[prev].operation, Operator::Nop) {
            return Some(prev);
        }
        prev = prev.checked_sub(1)?;
    }
}

fn nullability(
    body: &FunctionIr<'_>,
    cfg: &Cfg,
    slots: &BTreeMap<u32, usize>,
    params: usize,
    words: usize,
    cells: usize,
    work: &mut usize,
) -> Result<(Vec<u64>, Vec<bool>)> {
    let mut null = vec![0; cells];
    let mut reached = vec![false; cfg.next.len()];
    let mut queued = vec![false; cfg.next.len()];
    let mut queue = VecDeque::from([0]);
    reached[0] = true;
    queued[0] = true;
    for (&local, &slot) in slots {
        if local as usize >= params
            && matches!(body.locals[local as usize], ValType::Ref(r) if r.is_nullable())
        {
            set(&mut null[..words], slot, true);
        }
    }
    let mut output = vec![0; words];
    let mut candidate = vec![0; words];
    while let Some(pc) = queue.pop_front() {
        spend(work, 1)?;
        queued[pc] = false;
        if pc == body.instructions.len() {
            continue;
        }
        output.copy_from_slice(row(&null, pc, words));
        let prev = previous(body, pc);
        let lexical = cfg.previous[pc].as_slice() == [pc.wrapping_sub(1)];
        match body.instructions[pc].operation {
            Operator::LocalSet { local_index } | Operator::LocalTee { local_index } => {
                if let Some(&slot) = slots.get(&local_index) {
                    let value = lexical
                        && prev.is_some_and(|p| match body.instructions[p].operation {
                            Operator::RefNull { .. } => true,
                            Operator::LocalGet { local_index } => {
                                slots.get(&local_index).is_some_and(|&s| has(&output, s))
                            }
                            _ => false,
                        });
                    set(&mut output, slot, value);
                }
            }
            _ => {}
        }
        let tested = prev.and_then(|p| {
            let producer = match body.instructions[pc].operation {
                Operator::BrOnNull { .. } | Operator::BrOnNonNull { .. } => Some(p),
                Operator::If { .. } | Operator::BrIf { .. }
                    if matches!(body.instructions[p].operation, Operator::RefIsNull) =>
                {
                    previous(body, p)
                }
                _ => None,
            }?;
            match body.instructions[producer].operation {
                Operator::LocalGet { local_index } => slots.get(&local_index).copied(),
                _ => None,
            }
        });
        for &successor in &cfg.next[pc] {
            spend(work, words)?;
            candidate.copy_from_slice(&output);
            // A branch whose taken and fallthrough destinations coincide
            // does not establish nullness at their common destination.
            let refine = match body.instructions[pc].operation {
                Operator::BrOnNonNull { .. } => {
                    successor == pc + 1 && cfg.taken[pc] != Some(successor)
                }
                Operator::BrOnNull { .. } | Operator::BrIf { .. } => {
                    cfg.taken[pc] == Some(successor) && successor != pc + 1
                }
                Operator::If { .. } => cfg.taken[pc] == Some(successor),
                _ => false,
            };
            if let Some(slot) = tested.filter(|_| refine) {
                set(&mut candidate, slot, true);
            }
            let target = &mut null[successor * words..(successor + 1) * words];
            let mut changed = !reached[successor];
            for (to, &from) in target.iter_mut().zip(&candidate) {
                let joined = if reached[successor] { *to & from } else { from };
                changed |= *to != joined;
                *to = joined;
            }
            if changed {
                reached[successor] = true;
                if !queued[successor] {
                    queue.push_back(successor);
                    queued[successor] = true;
                }
            }
        }
    }
    Ok((null, reached))
}
