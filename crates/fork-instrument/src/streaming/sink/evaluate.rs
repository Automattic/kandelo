use std::collections::BTreeMap;

use anyhow::{Context, Result, ensure};
use wasmparser::{BlockType, Operator, ValType};

use super::*;
use crate::streaming::{FunctionIr, HandlerKind, RegionId, RegionKind, Scan};

/// Evaluate one exact original function. Resource failures are errors; an
/// unsupported operator is explicit in the result and proves no sink boundary.
pub fn evaluate(
    scan: &Scan<'_>,
    body: &FunctionIr<'_>,
    environment: &mut impl Environment,
    options: Options<'_>,
    limits: Limits,
) -> Result<Evaluation> {
    let summary = scan
        .functions
        .get(body.function as usize)
        .context("unknown sink function")?;
    ensure!(
        summary.ty == body.type_index
            && summary
                .body
                .as_ref()
                .is_some_and(|s| s.range == body.source.range()
                    && std::ptr::eq(
                        scan.input()[s.range.clone()].as_ptr(),
                        body.source.as_bytes().as_ptr()
                    )),
        "sink interpretation requires the original source function"
    );
    ensure!(
        body.instructions.len() <= limits.work,
        "sink interpretation exceeds work budget"
    );
    let (params, results) = signature(scan, BlockType::FuncType(body.type_index));
    // WHY: unused trailing declarations are not abstract state. Retain source
    // local coordinates for every referenced local without cloning a possibly
    // enormous unused suffix at each structured-control join.
    let local_count = body
        .instructions
        .iter()
        .filter_map(|i| match i.operation {
            Operator::LocalGet { local_index }
            | Operator::LocalSet { local_index }
            | Operator::LocalTee { local_index } => Some(local_index as usize + 1),
            _ => None,
        })
        .max()
        .unwrap_or(0)
        .max(params);
    ensure!(
        local_count <= body.locals.len(),
        "sink local outside original body"
    );
    let mut depth = vec![0usize; body.regions.len()];
    let mut handler_kinds = vec![0u8; body.regions.len()];
    let mut unsupported_handlers = false;
    let mut max_depth = 0;
    let mut width = local_count;
    for (i, region) in body.regions.iter().enumerate() {
        depth[i] = region.parent.map_or(0, |p| depth[p.0] + 1);
        let own = match region.kind {
            RegionKind::LegacyTry => 1,
            RegionKind::TryTable => 2,
            _ => 0,
        };
        handler_kinds[i] = region.parent.map_or(0, |p| handler_kinds[p.0]) | own;
        unsupported_handlers |= handler_kinds[i] == 3 || region.delegate.is_some();
        max_depth = max_depth.max(depth[i]);
        let (p, r) = signature(scan, region.signature);
        width = width.max(local_count.saturating_add(p).saturating_add(r));
    }
    ensure!(
        max_depth <= limits.control_depth,
        "sink interpretation exceeds control-depth budget"
    );
    // The conservative legacy approximation uses a separate handler search.
    // Delegation or nested mixed EH requires semantic normalization first;
    // never turn an incomplete handler model into a sink/argument proof.
    if unsupported_handlers {
        return Ok(Evaluation {
            unsupported: true,
            work_steps: body.instructions.len(),
            ..Default::default()
        });
    }
    for instruction in &body.instructions {
        let (p, r) = instruction.arity.unwrap_or_default();
        width = width.max(
            local_count
                .saturating_add(instruction.operand_height as usize)
                .saturating_add(p as usize)
                .saturating_add(r as usize),
        );
    }
    let frame = environment.stack_pointer_global().is_some() && !options.disable_frame_tracking;
    let stores = body
        .instructions
        .iter()
        .any(|i| is_store(&i.operation).is_some());
    let incoming_slots = options.normal_states.map_or(0, |states| {
        states.values().map(|s| s.memory.len()).max().unwrap_or(0)
    });
    let slots = if frame && stores {
        limits.frame_slots
    } else {
        incoming_slots
    };
    width = width
        .saturating_add(slots.saturating_mul(3))
        .saturating_add(8);
    // WHY: a structured evaluator retains label, loop, arm and scratch states
    // only along the active nesting path. Reserve an upper bound before any
    // state clone, instead of building a locals × every-instruction matrix.
    let retained = options
        .record_states
        .map_or(0, BTreeSet::len)
        .saturating_add(
            body.regions
                .iter()
                .filter(|r| r.kind == RegionKind::LegacyTry)
                .map(|r| r.handlers.len())
                .sum::<usize>(),
        );
    let active = max_depth
        .saturating_mul(12)
        .saturating_add(16)
        .saturating_add(retained.saturating_mul(2));
    ensure!(
        width <= limits.state_values / active,
        "sink interpretation exceeds state-value budget for function {} \
         (estimated {} values, limit {})",
        body.function,
        width.saturating_mul(active),
        limits.state_values,
    );
    if let Some(states) = options.normal_states {
        let mut values = 0usize;
        for state in states.values() {
            ensure!(
                (!state.live || state.locals.len() == local_count)
                    && state.stack.len() <= width
                    && state.memory.len() <= limits.frame_slots,
                "invalid sink injection state"
            );
            values = values
                .saturating_add(state.locals.len())
                .saturating_add(state.stack.len())
                .saturating_add(state.memory.len().saturating_mul(3));
        }
        ensure!(
            values <= limits.state_values.saturating_sub(width * active),
            "sink injection states exceed state-value budget"
        );
    }
    if let Some(injections) = options.injections {
        for (&i, injection) in injections {
            ensure!(
                i < body.instructions.len(),
                "sink injection outside original body"
            );
            ensure!(
                injection.payload.as_ref().map_or(0, Vec::len) <= width,
                "sink injection payload exceeds state-value budget"
            );
        }
    }
    ensure!(
        options.entry_arguments.map_or(0, <[Value]>::len) <= params,
        "too many sink entry arguments"
    );
    let locals = body
        .locals
        .iter()
        .take(local_count)
        .enumerate()
        .map(|(i, ty)| {
            if i < params {
                options
                    .entry_arguments
                    .and_then(|a| a.get(i))
                    .copied()
                    .unwrap_or(Value::Parameter(i as u32))
            } else if is_exn(*ty) {
                Value::Exception(0)
            } else {
                Value::Constant(0)
            }
        })
        .collect();
    let child = options.child;
    let mut walk = Walk {
        scan,
        body,
        environment,
        options,
        limits,
        work: limits
            .work
            .checked_sub(body.instructions.len())
            .context("sink interpretation exceeds work budget")?,
        labels: BTreeMap::new(),
        legacy_entries: BTreeMap::new(),
        handlers: Vec::new(),
        legacy: Vec::new(),
        output: Evaluation::default(),
        results,
        frame,
        target_count: 0,
    };
    let initial = State {
        live: !child,
        locals,
        stack: vec![],
        memory: vec![],
        stack_pointer: (!child).then_some(0),
    };
    let out = walk.region(RegionId(0), initial, 0, body.regions[0].end)?;
    walk.returned(&out);
    walk.output.work_steps = limits.work - walk.work;
    Ok(walk.output)
}

fn is_exn(ty: ValType) -> bool {
    matches!(ty, ValType::Ref(r) if matches!(r.heap_type(), wasmparser::HeapType::Abstract {
        ty: wasmparser::AbstractHeapType::Exn, .. }))
}

fn signature(scan: &Scan<'_>, ty: BlockType) -> (usize, usize) {
    match ty {
        BlockType::Empty => (0, 0),
        BlockType::Type(_) => (0, 1),
        BlockType::FuncType(index) => {
            let ty = scan
                .types
                .as_ref()
                .get(scan.types.as_ref().core_type_at_in_module(index))
                .unwrap()
                .composite_type
                .unwrap_func();
            (ty.params().len(), ty.results().len())
        }
    }
}

struct Walk<'a, 'b, E> {
    scan: &'b Scan<'a>,
    body: &'b FunctionIr<'a>,
    environment: &'b mut E,
    options: Options<'b>,
    limits: Limits,
    work: usize,
    labels: BTreeMap<RegionId, Option<State>>,
    legacy_entries: BTreeMap<usize, Option<State>>,
    handlers: Vec<RegionId>,
    legacy: Vec<RegionId>,
    output: Evaluation,
    results: usize,
    frame: bool,
    target_count: usize,
}

impl<E: Environment> Walk<'_, '_, E> {
    fn charge(&mut self, n: usize) -> Result<()> {
        self.work = self
            .work
            .checked_sub(n)
            .context("sink interpretation exceeds work budget")?;
        Ok(())
    }

    fn pop(&mut self, state: &mut State, n: usize) -> Vec<Value> {
        if state.stack.len() < n {
            if state.live {
                self.output.unsupported = true;
            }
            state.stack.clear();
            vec![Value::Unknown; n]
        } else {
            state.stack.split_off(state.stack.len() - n)
        }
    }

    fn escape(&mut self, values: &[Value]) {
        self.output.frame_escaped |=
            self.frame && values.iter().any(|v| matches!(v, Value::StackAddress(_)));
    }

    fn returned(&mut self, state: &State) {
        if state.live {
            let result = if self.results == 1 {
                state.stack.last().copied().unwrap_or(Value::Unknown)
            } else {
                Value::Unknown
            };
            self.escape(&state.stack[state.stack.len().saturating_sub(self.results)..]);
            self.output.returned = Some(
                self.output
                    .returned
                    .map_or(result, |old| join_value(old, result)),
            );
        }
    }

    fn label_arity(&self, label: RegionId) -> usize {
        let r = &self.body.regions[label.0];
        let (p, results) = signature(self.scan, r.signature);
        if r.kind == RegionKind::Loop {
            p
        } else {
            results
        }
    }

    fn deliver(&mut self, label: RegionId, state: &State, values: Vec<Value>) -> Result<()> {
        if state.live {
            self.charge(state.locals.len() + state.memory.len() * 3 + values.len() + 1)?;
            let branch = State {
                live: true,
                locals: state.locals.clone(),
                stack: values,
                memory: state.memory.clone(),
                stack_pointer: state.stack_pointer,
            };
            join_state(self.labels.entry(label).or_default(), &branch);
        }
        Ok(())
    }

    fn branch(&mut self, label: RegionId, state: &State) -> Result<()> {
        let arity = self.label_arity(label);
        if state.live && state.stack.len() < arity {
            self.output.unsupported = true;
        }
        let values = state.stack[state.stack.len().saturating_sub(arity)..].to_vec();
        self.deliver(label, state, values)
    }

    fn thrown(&mut self, state: &State, mut tags: Tags) -> Result<()> {
        if !state.live || tags == 0 {
            return Ok(());
        }
        // Preserve the oracle's ordered modern-handler search and conservative
        // legacy approximation. Legacy tagged catches do not remove tag bits.
        for h in (0..self.handlers.len()).rev() {
            let region = self.handlers[h];
            for arm in 0..self.body.regions[region.0].handlers.len() {
                self.charge(1)?;
                let handler = &self.body.regions[region.0].handlers[arm];
                let kind = handler.kind;
                let label = handler.target.unwrap();
                let bits = handler.tag.map_or(tags, |tag| {
                    self.environment.catch_bits(self.body.function, tag)
                }) & tags;
                if tags & bits == 0 {
                    continue;
                }
                let mut values = vec![Value::Unknown; self.label_arity(label)];
                if matches!(kind, HandlerKind::CatchRef | HandlerKind::CatchAllRef) {
                    if let Some(last) = values.last_mut() {
                        *last = Value::Exception(if handler.tag.is_some() { bits } else { tags });
                    }
                }
                self.deliver(label, state, values)?;
                if handler.tag.is_none() {
                    tags = 0;
                } else if bits != 1 << 63 {
                    tags &= !bits;
                }
                if tags == 0 {
                    return Ok(());
                }
            }
        }
        for h in (0..self.legacy.len()).rev() {
            let region = self.legacy[h];
            for arm in 0..self.body.regions[region.0].handlers.len() {
                self.charge(1 + state.locals.len() + state.memory.len() * 3)?;
                let handler = &self.body.regions[region.0].handlers[arm];
                let bits = handler.tag.map_or(tags, |tag| {
                    self.environment.catch_bits(self.body.function, tag)
                }) & tags;
                if tags & bits == 0 {
                    continue;
                }
                let target = handler.instruction;
                let n = handler.tag.map_or(0, |tag| {
                    let types = self.scan.types.as_ref();
                    types
                        .get(types.tag_at(tag))
                        .unwrap()
                        .composite_type
                        .unwrap_func()
                        .params()
                        .len()
                });
                let entry = State {
                    live: true,
                    locals: state.locals.clone(),
                    stack: vec![Value::Unknown; n],
                    memory: state.memory.clone(),
                    stack_pointer: state.stack_pointer,
                };
                join_state(self.legacy_entries.entry(target).or_default(), &entry);
                if handler.tag.is_none() {
                    tags = 0;
                }
            }
            if tags == 0 {
                return Ok(());
            }
        }
        self.output.thrown |= tags;
        Ok(())
    }

    fn region(
        &mut self,
        region: RegionId,
        entry: State,
        start: usize,
        end: usize,
    ) -> Result<State> {
        let is_loop = self.body.regions[region.0].kind == RegionKind::Loop;
        let results = signature(self.scan, self.body.regions[region.0].signature).1;
        let mut ent = Some(entry);
        let mut iterations = 0;
        let mut out;
        loop {
            let source = ent.as_ref().unwrap();
            self.charge(12usize.saturating_mul(
                source.locals.len() + source.stack.len() + 3 * source.memory.len() + 1,
            ))?;
            self.labels.insert(region, None);
            out = self.run(start, end, ent.as_ref().unwrap().clone())?;
            let branch = self.labels.remove(&region).unwrap();
            if !is_loop {
                let mut joined = Some(out);
                if let Some(branch) = branch {
                    join_state(&mut joined, &branch);
                }
                out = joined.unwrap();
                break;
            }
            let mut next = ent.clone();
            if !branch
                .as_ref()
                .is_some_and(|branch| join_state(&mut next, branch))
            {
                break;
            }
            iterations += 1;
            if iterations > 6 {
                if let (Some(a), Some(b)) = (&ent, &mut next) {
                    if a.live && b.live {
                        for (x, y) in a.locals.iter().zip(&mut b.locals) {
                            if x != y {
                                *y = Value::Unknown;
                            }
                        }
                    }
                }
            }
            if iterations > 40 {
                self.output.unsupported = true;
                break;
            }
            ent = next;
        }
        if out.stack.len() > results {
            out.stack.drain(..out.stack.len() - results);
        }
        if !is_loop && out.stack.len() < results {
            out.stack.splice(
                0..0,
                std::iter::repeat_n(Value::Unknown, results - out.stack.len()),
            );
        }
        Ok(out)
    }

    fn run(&mut self, start: usize, end: usize, mut state: State) -> Result<State> {
        let mut i = start;
        while i < end {
            self.charge(1)?;
            let mut next = i + 1;
            if let Some(region) = self.body.instructions[i].opens {
                let r = &self.body.regions[region.0];
                let stop = r.end;
                let kind = r.kind;
                let alternative = r.alternative;
                let handlers = if kind == RegionKind::LegacyTry {
                    r.handlers.iter().map(|h| h.instruction).collect::<Vec<_>>()
                } else {
                    Vec::new()
                };
                let (params, _) = signature(self.scan, r.signature);
                let condition = if kind == RegionKind::If {
                    Some(self.pop(&mut state, 1)[0])
                } else {
                    None
                };
                if let Some(condition) = condition {
                    self.escape(&[condition]);
                }
                let args = self.pop(&mut state, params);
                let inner = State {
                    live: state.live,
                    locals: std::mem::take(&mut state.locals),
                    stack: args,
                    memory: std::mem::take(&mut state.memory),
                    stack_pointer: state.stack_pointer,
                };
                let out = if kind == RegionKind::If {
                    let mut a = inner.clone();
                    let mut b = inner;
                    a.live &= condition != Some(Value::Constant(0));
                    b.live &= !matches!(condition, Some(Value::Constant(c)) if c != 0);
                    let a = self.region(region, a, i + 1, alternative.unwrap_or(stop))?;
                    let b = self.region(region, b, alternative.map_or(stop, |v| v + 1), stop)?;
                    let mut joined = Some(a);
                    join_state(&mut joined, &b);
                    joined.unwrap()
                } else {
                    if kind == RegionKind::TryTable {
                        self.handlers.push(region);
                    }
                    if kind == RegionKind::LegacyTry {
                        self.legacy.push(region);
                    }
                    let out = self.region(
                        region,
                        inner,
                        i + 1,
                        handlers.first().copied().unwrap_or(stop),
                    )?;
                    if kind == RegionKind::TryTable {
                        self.handlers.pop();
                    }
                    if kind == RegionKind::LegacyTry {
                        self.legacy.pop();
                        let mut joined = Some(out);
                        for (h, &handler) in handlers.iter().enumerate() {
                            if let Some(Some(entry)) = self.legacy_entries.remove(&handler) {
                                let result = self.region(
                                    region,
                                    entry,
                                    handler + 1,
                                    handlers.get(h + 1).copied().unwrap_or(stop),
                                )?;
                                join_state(&mut joined, &result);
                            }
                        }
                        joined.unwrap()
                    } else {
                        out
                    }
                };
                state.live = out.live;
                state.locals = out.locals;
                state.memory = out.memory;
                state.stack_pointer = out.stack_pointer;
                state.stack.extend(out.stack);
                next = stop + 1;
            } else {
                self.step(i, &mut state)?;
            }
            if self
                .options
                .record_states
                .is_some_and(|set| set.contains(&i))
                && state.live
            {
                self.charge(state.locals.len() + state.stack.len() + state.memory.len() * 3 + 1)?;
                let mut old = self.output.states.remove(&i);
                join_state(&mut old, &state);
                self.output.states.insert(i, old.unwrap());
            }
            if let Some(injection) = self.options.injections.and_then(|map| map.get(&i)) {
                if matches!(
                    self.body.instructions[i].operation,
                    Operator::ReturnCall { .. }
                        | Operator::ReturnCallIndirect { .. }
                        | Operator::ReturnCallRef { .. }
                ) {
                    if self.options.child {
                        if let Some(value) = injection.returned {
                            self.output.returned = Some(
                                self.output
                                    .returned
                                    .map_or(value, |old| join_value(old, value)),
                            );
                        }
                        self.output.thrown |= injection.thrown;
                    }
                } else if let Some(base) = self
                    .options
                    .normal_states
                    .and_then(|map| map.get(&i))
                    .filter(|s| s.live)
                {
                    self.charge(
                        3 * (base.locals.len() + base.stack.len() + base.memory.len() * 3 + 1),
                    )?;
                    self.thrown(base, injection.thrown)?;
                    if let Some(values) = &injection.payload {
                        ensure!(
                            values.len() <= base.stack.len(),
                            "sink injection payload exceeds original stack"
                        );
                        let mut injected = base.clone();
                        let offset = injected.stack.len() - values.len();
                        injected.stack[offset..].copy_from_slice(values);
                        let mut old = Some(state);
                        join_state(&mut old, &injected);
                        state = old.unwrap();
                    }
                    if let Some(value) = injection.returned {
                        let mut injected = base.clone();
                        if let Some(last) = injected.stack.last_mut() {
                            *last = value;
                        }
                        let mut old = Some(state);
                        join_state(&mut old, &injected);
                        state = old.unwrap();
                    }
                }
            }
            i = next;
        }
        Ok(state)
    }

    fn step(&mut self, index: usize, state: &mut State) -> Result<()> {
        if !state.live {
            return Ok(());
        }
        let instruction = &self.body.instructions[index];
        let op = &instruction.operation;
        match *op {
            Operator::Nop => {}
            Operator::Unreachable => state.live = false,
            Operator::Br { .. }
            | Operator::BrIf { .. }
            | Operator::BrTable { .. }
            | Operator::BrOnNull { .. }
            | Operator::BrOnNonNull { .. } => {
                let transfer = &self.body.transfers[self
                    .body
                    .transfers
                    .binary_search_by_key(&index, |t| t.instruction)
                    .unwrap()];
                match *op {
                    Operator::Br { .. } => {
                        self.branch(transfer.targets[0], state)?;
                        state.live = false;
                    }
                    Operator::BrIf { .. } => {
                        let c = self.pop(state, 1)[0];
                        self.escape(&[c]);
                        if c != Value::Constant(0) {
                            self.branch(transfer.targets[0], state)?;
                        }
                        if matches!(c, Value::Constant(c) if c != 0) {
                            state.live = false;
                        }
                    }
                    Operator::BrTable { .. } => {
                        let c = self.pop(state, 1)[0];
                        if let Value::Constant(c) = c {
                            let n = transfer.targets.len() - 1;
                            let target = if c >= 0 && (c as usize) < n {
                                c as usize
                            } else {
                                n
                            };
                            self.branch(transfer.targets[target], state)?;
                        } else {
                            for &target in &transfer.targets {
                                self.branch(target, state)?;
                            }
                        }
                        state.live = false;
                    }
                    Operator::BrOnNull { .. } => {
                        let value = self.pop(state, 1)[0];
                        self.branch(transfer.targets[0], state)?;
                        state.stack.push(value);
                    }
                    Operator::BrOnNonNull { .. } => {
                        self.branch(transfer.targets[0], state)?;
                        self.pop(state, 1);
                    }
                    _ => unreachable!(),
                }
            }
            Operator::Return => {
                self.returned(state);
                state.live = false;
            }
            Operator::Throw { tag_index } => {
                let n = instruction.arity.context("missing original throw arity")?.0;
                let args = self.pop(state, n as usize);
                self.escape(&args);
                self.thrown(
                    state,
                    self.environment.tag_bits(self.body.function, tag_index),
                )?;
                state.live = false;
            }
            Operator::ThrowRef => {
                let v = self.pop(state, 1)[0];
                self.thrown(
                    state,
                    if let Value::Exception(bits) = v {
                        bits
                    } else {
                        ALL_TAGS
                    },
                )?;
                state.live = false;
            }
            Operator::Rethrow { .. } => {
                self.thrown(state, ALL_TAGS)?;
                state.live = false;
            }
            Operator::Call { function_index } | Operator::ReturnCall { function_index } => {
                self.call(
                    index,
                    state,
                    Invocation::Direct(function_index),
                    Value::Unknown,
                    matches!(op, Operator::ReturnCall { .. }),
                )?;
            }
            Operator::CallIndirect {
                type_index,
                table_index,
            }
            | Operator::ReturnCallIndirect {
                type_index,
                table_index,
            } => {
                let selector = self.pop(state, 1)[0];
                self.call(
                    index,
                    state,
                    Invocation::Indirect {
                        table: table_index,
                        ty: type_index,
                    },
                    selector,
                    matches!(op, Operator::ReturnCallIndirect { .. }),
                )?;
            }
            Operator::CallRef { type_index } | Operator::ReturnCallRef { type_index } => {
                let selector = self.pop(state, 1)[0];
                self.call(
                    index,
                    state,
                    Invocation::Reference { ty: type_index },
                    selector,
                    matches!(op, Operator::ReturnCallRef { .. }),
                )?;
            }
            Operator::LocalGet { local_index } => {
                state.stack.push(state.locals[local_index as usize])
            }
            Operator::LocalSet { local_index } | Operator::LocalTee { local_index } => {
                let value = if matches!(op, Operator::LocalTee { .. }) {
                    *state.stack.last().unwrap_or(&Value::Unknown)
                } else {
                    self.pop(state, 1)[0]
                };
                state.locals[local_index as usize] = value;
                if is_exn(self.body.locals[local_index as usize]) {
                    self.output.exception_locals |= if let Value::Exception(tags) = value {
                        tags
                    } else {
                        ALL_TAGS
                    };
                }
            }
            Operator::GlobalGet { global_index } => {
                let value = if self.frame
                    && self.environment.stack_pointer_global() == Some(global_index)
                {
                    state
                        .stack_pointer
                        .map_or(Value::Unknown, Value::StackAddress)
                } else {
                    self.environment
                        .global_constant(global_index)
                        .map_or(Value::Unknown, Value::Constant)
                };
                state.stack.push(value);
            }
            Operator::GlobalSet { global_index } => {
                let value = self.pop(state, 1)[0];
                if self.environment.stack_pointer_global() == Some(global_index) {
                    state.stack_pointer = if let Value::StackAddress(k) = value {
                        Some(k)
                    } else {
                        None
                    };
                } else {
                    self.escape(&[value]);
                }
            }
            Operator::I32Const { value } => state.stack.push(Value::Constant(value as i64)),
            Operator::I64Const { value } => state.stack.push(Value::Constant(value)),
            Operator::Select | Operator::TypedSelect { .. } => {
                let args = self.pop(state, 3);
                state.stack.push(match args[2] {
                    Value::Constant(0) => args[1],
                    Value::Constant(_) => args[0],
                    _ => join_value(args[0], args[1]),
                });
            }
            Operator::Drop => {
                self.pop(state, 1);
            }
            _ => {
                if let Some((offset, width, full)) = is_store(op) {
                    let args = self.pop(state, 2);
                    self.escape(&args[1..]);
                    if let Value::StackAddress(k) = args[0] {
                        if self.frame {
                            self.charge(
                                state.memory.len().saturating_mul(
                                    state
                                        .memory
                                        .len()
                                        .checked_ilog2()
                                        .unwrap_or(0)
                                        .saturating_add(2)
                                        as usize,
                                ),
                            )?;
                            if let Some(key) = k.checked_add(offset as i64) {
                                // Saturating endpoints conservatively overlap on address overflow.
                                state.memory.retain(|e| {
                                    e.0.saturating_add(e.1 as i64) <= key
                                        || key.saturating_add(width as i64) <= e.0
                                });
                                if full && !matches!(args[1], Value::StackAddress(_)) {
                                    ensure!(
                                        state.memory.len() < self.limits.frame_slots,
                                        "sink interpretation exceeds frame-slot budget"
                                    );
                                    state.memory.push((key, width, args[1]));
                                    state.memory.sort_by_key(|s| (s.0, s.1));
                                }
                            } else {
                                self.output.frame_escaped = true;
                            }
                        }
                    }
                } else if let Some((offset, width)) = is_load(op) {
                    self.charge(state.memory.len())?;
                    let address = self.pop(state, 1)[0];
                    let value = if let Value::StackAddress(k) = address {
                        if self.frame && width > 0 {
                            k.checked_add(offset as i64)
                                .and_then(|key| {
                                    state.memory.iter().find(|s| s.0 == key && s.1 == width)
                                })
                                .map_or(Value::Unknown, |s| s.2)
                        } else {
                            Value::Unknown
                        }
                    } else {
                        Value::Unknown
                    };
                    state.stack.push(value);
                } else if supported_scalar(op) {
                    if let Some((p, r)) = instruction.arity {
                        let args = self.pop(state, p as usize);
                        let value = arithmetic(op, &args);
                        let stack_arithmetic = matches!(value, Value::StackAddress(_));
                        if !stack_arithmetic && !ignores_frame_address(op) {
                            self.escape(&args);
                        }
                        for result in 0..r {
                            state.stack.push(if result + 1 == r {
                                value
                            } else {
                                Value::Unknown
                            });
                        }
                    } else {
                        self.output.unsupported = true;
                        state.live = false;
                    }
                } else {
                    self.output.unsupported = true;
                    state.live = false;
                }
            }
        }
        Ok(())
    }

    fn call(
        &mut self,
        index: usize,
        state: &mut State,
        invocation: Invocation,
        selector: Value,
        tail: bool,
    ) -> Result<()> {
        let ty = match invocation {
            Invocation::Direct(f) => self.scan.functions[f as usize].ty,
            Invocation::Indirect { ty, .. } | Invocation::Reference { ty } => ty,
        };
        let (params, results) = signature(self.scan, BlockType::FuncType(ty));
        let args = self.pop(state, params);
        self.escape(&args);
        let effect = self.environment.call(
            self.body.instructions[index].point,
            invocation,
            selector,
            &args,
            tail,
        )?;
        self.charge(effect.targets.len() + 1)?;
        if self.options.record_targets {
            let targets = self.output.targets.entry(index).or_default();
            for target in effect
                .targets
                .into_iter()
                .filter(|t| *t != u32::MAX)
                .chain(effect.external.then_some(u32::MAX - 1))
            {
                if !targets.contains(&target) {
                    ensure!(
                        self.target_count < self.limits.call_targets,
                        "sink interpretation exceeds call-target budget"
                    );
                    self.target_count += 1;
                    targets.insert(target);
                }
            }
        }
        self.thrown(state, effect.thrown)?;
        if tail {
            if effect.returned.is_some() {
                self.output.returned = Some(Value::Unknown);
            }
            state.live = false;
        } else if effect.returned.is_none() {
            state.live = false;
        }
        for i in 0..results {
            state.stack.push(if i + 1 == results {
                effect.returned.unwrap_or(Value::Unknown)
            } else {
                Value::Unknown
            });
        }
        Ok(())
    }
}

fn is_store(op: &Operator<'_>) -> Option<(u64, u32, bool)> {
    use Operator::*;
    let (arg, width, full) = match op {
        I32Store { memarg } => (memarg, 4, true),
        I64Store { memarg } => (memarg, 8, true),
        I32AtomicStore { memarg } => (memarg, 4, false),
        I64AtomicStore { memarg } => (memarg, 8, false),
        F32Store { memarg } => (memarg, 4, false),
        F64Store { memarg } => (memarg, 8, false),
        I32Store8 { memarg }
        | I64Store8 { memarg }
        | I32AtomicStore8 { memarg }
        | I64AtomicStore8 { memarg } => (memarg, 1, false),
        I32Store16 { memarg }
        | I64Store16 { memarg }
        | I32AtomicStore16 { memarg }
        | I64AtomicStore16 { memarg } => (memarg, 2, false),
        I64Store32 { memarg } | I64AtomicStore32 { memarg } => (memarg, 4, false),
        V128Store { memarg } => (memarg, 16, false),
        _ => return None,
    };
    Some((arg.offset, width, full))
}

fn is_load(op: &Operator<'_>) -> Option<(u64, u32)> {
    use Operator::*;
    let (arg, width) = match op {
        I32Load { memarg } | I32AtomicLoad { memarg } => (memarg, 4),
        I64Load { memarg } | I64AtomicLoad { memarg } => (memarg, 8),
        I32Load8S { memarg }
        | I32Load8U { memarg }
        | I32Load16S { memarg }
        | I32Load16U { memarg }
        | I64Load8S { memarg }
        | I64Load8U { memarg }
        | I64Load16S { memarg }
        | I64Load16U { memarg }
        | I64Load32S { memarg }
        | I64Load32U { memarg }
        | F32Load { memarg }
        | F64Load { memarg }
        | I32AtomicLoad8U { memarg }
        | I32AtomicLoad16U { memarg }
        | I64AtomicLoad8U { memarg }
        | I64AtomicLoad16U { memarg }
        | I64AtomicLoad32U { memarg }
        | V128Load { memarg }
        | V128Load8x8S { memarg }
        | V128Load8x8U { memarg }
        | V128Load16x4S { memarg }
        | V128Load16x4U { memarg }
        | V128Load32x2S { memarg }
        | V128Load32x2U { memarg }
        | V128Load8Splat { memarg }
        | V128Load16Splat { memarg }
        | V128Load32Splat { memarg }
        | V128Load64Splat { memarg }
        | V128Load32Zero { memarg }
        | V128Load64Zero { memarg } => (memarg, 0),
        _ => return None,
    };
    Some((arg.offset, width))
}

fn ignores_frame_address(op: &Operator<'_>) -> bool {
    use Operator::*;
    matches!(
        op,
        MemoryGrow { .. }
            | TableGet { .. }
            | TableSet { .. }
            | RefIsNull
            | RefAsNonNull
            | V128Load8Lane { .. }
            | V128Load16Lane { .. }
            | V128Load32Lane { .. }
            | V128Load64Lane { .. }
            | V128Store8Lane { .. }
            | V128Store16Lane { .. }
            | V128Store32Lane { .. }
            | V128Store64Lane { .. }
    )
}

fn supported_scalar(op: &Operator<'_>) -> bool {
    macro_rules! proposals {
        ($(@$proposal:ident $op:ident $({ $($arg:ident: $ty:ty),* })? => $visit:ident ($($ann:tt)*))*) => {
            match op {
                $(Operator::$op $({ $($arg: _),* })? => matches!(stringify!($proposal), "mvp" | "sign_extension" | "saturating_float_to_int" | "bulk_memory" | "reference_types" | "function_references" | "threads" | "simd" | "relaxed_simd"),)*
                _ => false,
            }
        };
    }
    wasmparser::for_each_operator!(proposals)
}

fn arithmetic(op: &Operator<'_>, args: &[Value]) -> Value {
    use Operator::*;
    use Value::*;
    if let [a] = args {
        let Constant(x) = a else {
            return Unknown;
        };
        return Constant(match op {
            I32Eqz => ((*x as i32) == 0) as i64,
            I64Eqz => (*x == 0) as i64,
            I32WrapI64 | I64ExtendI32S => *x as i32 as i64,
            I64ExtendI32U => *x as u32 as i64,
            I32Extend8S => *x as i8 as i64,
            I32Extend16S => *x as i16 as i64,
            _ => return Unknown,
        });
    }
    let [a, b] = args else {
        return Unknown;
    };
    match (op, *a, *b) {
        (I32Add | I64Add, StackAddress(k), Constant(c))
        | (I32Add | I64Add, Constant(c), StackAddress(k)) => {
            return k.checked_add(c).map_or(Unknown, StackAddress);
        }
        (I32Sub | I64Sub, StackAddress(k), Constant(c)) => {
            return k.checked_sub(c).map_or(Unknown, StackAddress);
        }
        _ => {}
    }
    let (Constant(x), Constant(y)) = (*a, *b) else {
        return Unknown;
    };
    let (a, b) = (x as i32, y as i32);
    Constant(match op {
        I32Eq => (a == b) as i64,
        I32Ne => (a != b) as i64,
        I32LtS => (a < b) as i64,
        I32LtU => ((a as u32) < (b as u32)) as i64,
        I32GtS => (a > b) as i64,
        I32GtU => ((a as u32) > (b as u32)) as i64,
        I32LeS => (a <= b) as i64,
        I32LeU => ((a as u32) <= (b as u32)) as i64,
        I32GeS => (a >= b) as i64,
        I32GeU => ((a as u32) >= (b as u32)) as i64,
        I64Eq => (x == y) as i64,
        I64Ne => (x != y) as i64,
        I64LtS => (x < y) as i64,
        I64LtU => ((x as u64) < (y as u64)) as i64,
        I64GtS => (x > y) as i64,
        I64GtU => ((x as u64) > (y as u64)) as i64,
        I64LeS => (x <= y) as i64,
        I64LeU => ((x as u64) <= (y as u64)) as i64,
        I64GeS => (x >= y) as i64,
        I64GeU => ((x as u64) >= (y as u64)) as i64,
        I32Add => a.wrapping_add(b) as i64,
        I32Sub => a.wrapping_sub(b) as i64,
        I32Mul => a.wrapping_mul(b) as i64,
        I32And => (a & b) as i64,
        I32Or => (a | b) as i64,
        I32Xor => (a ^ b) as i64,
        I32Shl => a.wrapping_shl(b as u32) as i64,
        I32ShrS => a.wrapping_shr(b as u32) as i64,
        I32ShrU => (a as u32).wrapping_shr(b as u32) as i32 as i64,
        I64Add => x.wrapping_add(y),
        I64Sub => x.wrapping_sub(y),
        I64Mul => x.wrapping_mul(y),
        I64And => x & y,
        I64Or => x | y,
        I64Xor => x ^ y,
        _ => return Unknown,
    })
}
