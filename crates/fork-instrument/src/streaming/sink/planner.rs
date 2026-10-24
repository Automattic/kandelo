//! Disk-backed fork closure and child-continuation sink fixed points.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use anyhow::{Context, Result, ensure};
use rusqlite::params;
use wasmparser::Operator;

use super::{
    ALL_TAGS, CallEffect, Environment, Evaluation, Injection, InterpreterLimits, Invocation,
    Options, PolicyLimits, PolicyPlan, Program, SinkInterpreter, Summaries, SummaryLimits, Tags,
    Value, evaluate, join_value,
};
use crate::{
    sink::SinkPolicy,
    streaming::{FunctionIr, HandlerKind, ProgramPoint, ReachingPlan, RegionId, RegionKind},
};

const EXT: u32 = u32::MAX - 1;
const PROBE: Tags = 1 << 62;

#[derive(Clone, Copy, Debug)]
pub struct SinkLimits {
    pub policy: PolicyLimits,
    pub interpreter: InterpreterLimits,
    pub summaries: SummaryLimits,
    pub metadata_bytes: usize,
    pub work: usize,
    pub evaluations_per_function: usize,
}

impl Default for SinkLimits {
    fn default() -> Self {
        Self {
            policy: PolicyLimits::default(),
            interpreter: InterpreterLimits::default(),
            summaries: SummaryLimits::default(),
            metadata_bytes: 128 * 1024 * 1024,
            work: super::DEFAULT_TOTAL_WORK_LIMIT,
            evaluations_per_function: 50,
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct NativeSinkPlan {
    pub activations: BTreeSet<u32>,
    pub control_reachable: BTreeSet<u32>,
    pub boundaries: BTreeSet<u32>,
    pub fork_returning: BTreeSet<u32>,
    pub required_signal_gates: BTreeSet<u32>,
}

/// A main-module kernel_fork sink plan over exact original bytes. None means
/// that sink refinement is unavailable; the caller must keep its conservative
/// closure. This never invokes the Walrus implementation. Legacy import
/// normalization and production runtime/continuation emission are separate.
pub fn plan_sinks(
    program: &mut Program<'_, '_>,
    seed: u32,
    today: &ReachingPlan,
    policy: SinkPolicy,
    limits: SinkLimits,
) -> Result<Option<NativeSinkPlan>> {
    let scan = program.original_scan();
    let source = scan
        .functions
        .get(seed as usize)
        .context("unknown native sink seed")?;
    if !source
        .import
        .as_ref()
        .is_some_and(|(module, name)| module == "kernel" && name == "kernel_fork")
    {
        return Ok(None);
    }
    if scan
        .functions
        .iter()
        .filter_map(|f| f.import.as_ref())
        .any(|(_, name)| matches!(name.as_str(), "__wasm_dlopen" | "__wasm_longjmp"))
    {
        return Ok(None);
    }
    if program.dynamic_linking && !program.store.calls_ready.get() {
        return Ok(None);
    }
    let n = scan.functions.len();
    ensure!(
        n <= limits.metadata_bytes / 192,
        "native sink plan exceeds resident metadata budget"
    );
    let progress = crate::progress::Progress::new("sinks");
    progress.note(format_args!("policy"));
    let plan = PolicyPlan::build(program, policy, limits.policy)?;
    if !plan.supports_tag_masks() {
        return Ok(None);
    }
    let mut engine = SinkInterpreter::new(&plan, limits.interpreter)?;
    progress.note(format_args!("normal summaries"));
    let summaries = engine.normal_summaries(SummaryLimits {
        work: limits.summaries.work.min(limits.work),
        ..limits.summaries
    })?;
    if !summaries.unsupported.is_empty() {
        return Ok(None);
    }
    let work = summaries.work_steps;
    let evaluations = summaries.evaluations;
    let mut planner = Planner {
        plan: &plan,
        engine,
        normal: summaries,
        limits,
        work,
        evaluations,
        max_evaluations: n
            .max(1)
            .checked_mul(limits.evaluations_per_function)
            .context("sink evaluation budget overflow")?,
        seed,
        n,
        reaching: vec![false; n + 1],
        below: vec![0; n + 1],
        above: vec![0; n + 1],
        via_side: vec![false; n + 1],
        vfork: vec![false; n],
        longjmp: plan.longjmp_buffer_bits(),
    };
    progress.note(format_args!("targets"));
    if !planner.targets()? {
        return Ok(None);
    }
    progress.note(format_args!("closure"));
    planner.closure()?;
    progress.note(format_args!("vforks"));
    planner.vforks()?;
    progress.note(format_args!("catchers"));
    planner.catchers()?;
    progress.note(format_args!("children"));
    let result = planner.children(today)?;
    progress.note(format_args!("complete"));
    Ok(Some(result))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
struct Child {
    returned: Option<Value>,
    thrown: Tags,
}

struct Planner<'p, 's, 'a> {
    plan: &'p PolicyPlan<'p, 's, 'a>,
    engine: SinkInterpreter<'p, 's, 'a>,
    normal: Summaries,
    limits: SinkLimits,
    work: usize,
    evaluations: usize,
    max_evaluations: usize,
    seed: u32,
    n: usize,
    reaching: Vec<bool>,
    below: Vec<Tags>,
    above: Vec<Tags>,
    via_side: Vec<bool>,
    vfork: Vec<bool>,
    longjmp: Tags,
}

impl<'a> Planner<'_, '_, 'a> {
    fn ix(&self, function: u32) -> usize {
        if function == EXT {
            self.n
        } else {
            function as usize
        }
    }
    fn remaining(&mut self) -> Result<usize> {
        ensure!(
            self.evaluations < self.max_evaluations,
            "native sink plan exceeds evaluation budget"
        );
        self.evaluations += 1;
        self.limits
            .work
            .checked_sub(self.work)
            .context("native sink plan exceeds work budget")
    }
    fn charged(&mut self, result: &Evaluation) -> Result<()> {
        self.work = self
            .work
            .checked_add(result.work_steps)
            .context("native sink work overflow")?;
        ensure!(
            self.work <= self.limits.work,
            "native sink plan exceeds work budget"
        );
        Ok(())
    }
    fn normal(
        &mut self,
        body: &FunctionIr<'a>,
        states: Option<&BTreeSet<usize>>,
        disabled: bool,
    ) -> Result<Evaluation> {
        let work = self.remaining()?;
        let result = self.engine.evaluate_stable(
            body,
            &self.normal.functions,
            Options {
                record_states: states,
                disable_frame_tracking: disabled,
                ..Default::default()
            },
            true,
            work,
        )?;
        self.charged(&result)?;
        Ok(result)
    }
    fn child(
        &mut self,
        body: &FunctionIr<'a>,
        injections: &BTreeMap<usize, Injection>,
    ) -> Result<Evaluation> {
        let states: BTreeSet<_> = injections.keys().copied().collect();
        loop {
            let disabled = self.engine.frame_escaped()[body.function as usize];
            let normal = self.normal(body, Some(&states), disabled)?;
            if normal.unsupported {
                return Ok(normal);
            }
            let disabled = self.engine.frame_escaped()[body.function as usize];
            let work = self.remaining()?;
            let result = self.engine.evaluate(
                body,
                &self.normal.functions,
                Options {
                    child: true,
                    injections: Some(injections),
                    normal_states: Some(&normal.states),
                    disable_frame_tracking: disabled,
                    ..Default::default()
                },
                true,
                work,
            )?;
            self.charged(&result)?;
            if result.frame_escaped && !disabled {
                continue;
            }
            return Ok(result);
        }
    }
    fn indices(&self, sql: &str, parameters: impl rusqlite::Params) -> Result<Vec<u32>> {
        let store = self.plan.original_program().store;
        store.charge_work(1)?;
        let mut query = store.db.prepare_cached(sql)?;
        let mut rows = query.query(parameters)?;
        let mut output = Vec::new();
        while let Some(row) = rows.next()? {
            ensure!(
                output.len() < self.limits.metadata_bytes / 8,
                "sink dependency group exceeds resident budget"
            );
            output.push(row.get(0)?);
        }
        Ok(output)
    }
    fn callers(&self, function: u32) -> Result<Vec<u32>> {
        self.indices(
            "SELECT caller FROM sink_rdep WHERE callee=? ORDER BY caller",
            [function],
        )
    }
    fn callees(&self, function: u32) -> Result<Vec<u32>> {
        self.indices(
            "SELECT callee FROM sink_rdep WHERE caller=? ORDER BY callee",
            [function],
        )
    }

    fn targets(&mut self) -> Result<bool> {
        let plan = self.plan;
        let program = plan.original_program();
        let store = program.store;
        store.db.execute_batch(include_str!("planner.sql"))?;
        let mut provider = program
            .original_scan()
            .body_provider(self.limits.interpreter.ir);
        for function in 0..self.n as u32 {
            if program.functions[function as usize].imported {
                continue;
            }
            let body = provider.load(function)?;
            if program.original_scan().functions[function as usize]
                .name
                .as_deref()
                == Some("__wasm_longjmp")
            {
                for instruction in &body.instructions {
                    if let Operator::Throw { tag_index } = instruction.operation {
                        self.longjmp |= 1u64 << tag_index.min(63);
                    }
                }
            }
            let work = self.remaining()?;
            let result = self.engine.evaluate_stable(
                &body,
                &self.normal.functions,
                Options {
                    record_targets: true,
                    ..Default::default()
                },
                true,
                work,
            )?;
            self.charged(&result)?;
            if result.unsupported {
                return Ok(false);
            }
            let transaction = store.db.unchecked_transaction()?;
            for (instruction, targets) in result.targets {
                let source = &body.instructions[instruction];
                let tail = matches!(
                    source.operation,
                    Operator::ReturnCall { .. }
                        | Operator::ReturnCallIndirect { .. }
                        | Operator::ReturnCallRef { .. }
                );
                let point = i64::try_from(source.point.offset)?;
                store.execute(
                    "INSERT INTO sink_site VALUES(?,?,?,?)",
                    params![function, point, instruction as u32, tail],
                )?;
                for target in targets {
                    store.execute(
                        "INSERT INTO sink_target VALUES(?,?,?)",
                        params![function, point, target],
                    )?;
                }
            }
            transaction.commit()?;
        }
        Ok(true)
    }
    fn closure(&mut self) -> Result<()> {
        let store = self.plan.original_program().store;
        store.execute("INSERT INTO sink_reaching WITH RECURSIVE r(function) AS (
          VALUES(?1) UNION SELECT ?2 WHERE ?3 UNION SELECT t.caller FROM sink_target t JOIN r ON r.function=t.target)
          SELECT function FROM r",params![self.seed,EXT,self.plan.original_program().has_external_dispatch()])?;
        store.db.execute_batch(
            "INSERT INTO sink_rdep SELECT DISTINCT t.target,t.caller FROM sink_target t
          JOIN sink_reaching a ON a.function=t.target JOIN sink_reaching b ON b.function=t.caller;",
        )?;
        for f in self.indices("SELECT function FROM sink_reaching ORDER BY function", [])? {
            let i = self.ix(f);
            self.reaching[i] = true;
        }
        let mut queue = VecDeque::from([EXT]);
        while let Some(g) = queue.pop_front() {
            for f in self.callers(g)? {
                let i = self.ix(f);
                if !self.via_side[i] {
                    self.via_side[i] = true;
                    queue.push_back(f);
                }
            }
        }
        Ok(())
    }
    fn vforks(&mut self) -> Result<()> {
        let plan = self.plan;
        let program = plan.original_program();
        let mut provider = program
            .original_scan()
            .body_provider(self.limits.interpreter.ir);
        for function in program.direct_callers(self.seed)? {
            let body = provider.load(function)?;
            let mut disabled = false;
            let modes = loop {
                let work = self.remaining()?;
                let mut env = Modes {
                    plan,
                    seed: self.seed,
                    values: BTreeSet::new(),
                    limit: self.limits.interpreter.evaluation.call_targets,
                };
                let result = evaluate(
                    program.original_scan(),
                    &body,
                    &mut env,
                    Options {
                        disable_frame_tracking: disabled,
                        ..Default::default()
                    },
                    super::Limits {
                        work: self.limits.interpreter.evaluation.work.min(work),
                        ..self.limits.interpreter.evaluation
                    },
                )?;
                self.charged(&result)?;
                if result.frame_escaped && !disabled {
                    disabled = true;
                    continue;
                }
                if result.unsupported {
                    break BTreeSet::new();
                }
                break env.values;
            };
            self.vfork[function as usize] =
                !modes.is_empty() && modes.iter().all(|v| *v == Value::Constant(1));
        }
        Ok(())
    }
    fn catchers(&mut self) -> Result<()> {
        let plan = self.plan;
        let program = plan.original_program();
        let mut provider = program
            .original_scan()
            .body_provider(self.limits.interpreter.ir);
        let mut catches = vec![0u64; self.n + 1];
        for function in 0..self.n as u32 {
            if program.functions[function as usize].imported {
                continue;
            }
            let body = provider.load(function)?;
            let mut bits = 0;
            for region in &body.regions {
                if region.kind == RegionKind::LegacyTry {
                    bits = ALL_TAGS;
                }
                if region.kind != RegionKind::TryTable {
                    continue;
                }
                for handler in &region.handlers {
                    let payload_len = handler.tag.map_or(0, |tag| {
                        let types = program.original_scan().types.as_ref();
                        types
                            .get(types.tag_at(tag))
                            .unwrap()
                            .composite_type
                            .unwrap_func()
                            .params()
                            .len()
                    });
                    let reference = matches!(
                        handler.kind,
                        HandlerKind::CatchRef | HandlerKind::CatchAllRef
                    );
                    let caught = handler
                        .tag
                        .map_or(ALL_TAGS & !PROBE & !self.longjmp, |tag| {
                            plan.catch_bits(function, tag)
                        });
                    let target = &body.regions[handler.target.unwrap().0];
                    if target.kind != RegionKind::Block || payload_len + usize::from(reference) > 4
                    {
                        bits |= caught;
                        continue;
                    }
                    if next_terminates(program, &body, handler.target.unwrap()) {
                        continue;
                    }
                    let mut payload = vec![Value::Unknown; payload_len];
                    if reference {
                        payload.push(Value::Exception(PROBE));
                    }
                    let key = target.opener.unwrap();
                    let injections = BTreeMap::from([(
                        key,
                        Injection {
                            returned: None,
                            thrown: 0,
                            payload: Some(payload),
                        },
                    )]);
                    let result = self.child(&body, &injections)?;
                    if result.unsupported || result.returned.is_some() || result.thrown & PROBE == 0
                    {
                        bits |= caught;
                    }
                }
            }
            catches[function as usize] = bits & !PROBE;
        }
        let mut queue = VecDeque::new();
        let mut queued = vec![false; self.n + 1];
        for f in 0..self.n {
            if self.reaching[f] && catches[f] != 0 {
                self.below[f] = catches[f];
                queue.push_back(f as u32);
                queued[f] = true;
            }
        }
        while let Some(g) = queue.pop_front() {
            let i = self.ix(g);
            queued[i] = false;
            for h in self.callees(g)? {
                let j = self.ix(h);
                let next = self.below[j] | self.below[i];
                if next != self.below[j] {
                    self.below[j] = next;
                    if !queued[j] {
                        queued[j] = true;
                        queue.push_back(h);
                    }
                }
            }
        }
        for g in 0..=self.n {
            let function = if g == self.n { EXT } else { g as u32 };
            for caller in self.callers(function)? {
                self.above[g] |= self.below[caller as usize];
            }
        }
        Ok(())
    }
    fn closed(&self, child: &Child, function: u32) -> bool {
        child.returned.is_none()
            && (child.thrown == 0 || self.above[self.ix(function)] & child.thrown == 0)
    }

    fn children(&mut self, today: &ReachingPlan) -> Result<NativeSinkPlan> {
        let plan = self.plan;
        let program = plan.original_program();
        let store = program.store;
        let mut child = vec![None; self.n + 1];
        child[self.seed as usize] = Some(Child {
            returned: Some(Value::Constant(0)),
            thrown: 0,
        });
        if self.reaching[self.n] {
            child[self.n] = Some(Child {
                returned: Some(Value::Unknown),
                thrown: ALL_TAGS,
            });
        }
        let mut queue = VecDeque::new();
        let mut queued = vec![false; self.n];
        for root in [self.seed, EXT] {
            for f in self.callers(root)? {
                if !queued[f as usize] {
                    queued[f as usize] = true;
                    queue.push_back(f);
                }
            }
        }
        let mut provider = program
            .original_scan()
            .body_provider(self.limits.interpreter.ir);
        while let Some(function) = queue.pop_front() {
            queued[function as usize] = false;
            let mut injections = BTreeMap::new();
            let mut needed = false;
            store.charge_work(1)?;
            let mut query=store.db.prepare_cached("SELECT s.instruction,t.target FROM sink_site s JOIN sink_target t ON t.caller=s.caller AND t.point=s.point
              JOIN sink_reaching r ON r.function=t.target WHERE s.caller=? ORDER BY s.instruction,t.target")?;
            let mut rows = query.query([function])?;
            let mut site = None;
            let mut targets = Vec::new();
            while let Some(row) = rows.next()? {
                let instruction: usize = row.get(0)?;
                let target: u32 = row.get(1)?;
                if site != Some(instruction) {
                    if let Some(instruction) = site {
                        self.injection(
                            function,
                            instruction,
                            &targets,
                            &child,
                            &mut injections,
                            &mut needed,
                        )?;
                    }
                    targets.clear();
                    site = Some(instruction);
                }
                ensure!(
                    targets.len() < self.limits.interpreter.evaluation.call_targets,
                    "child target group exceeds budget"
                );
                targets.push(target);
            }
            if let Some(instruction) = site {
                self.injection(
                    function,
                    instruction,
                    &targets,
                    &child,
                    &mut injections,
                    &mut needed,
                )?;
            }
            drop(rows);
            drop(query);
            let mut result = if injections.is_empty() {
                if !needed {
                    continue;
                }
                Child::default()
            } else {
                let body = provider.load(function)?;
                let output = self.child(&body, &injections)?;
                if output.unsupported {
                    Child {
                        returned: Some(Value::Unknown),
                        thrown: ALL_TAGS,
                    }
                } else {
                    Child {
                        returned: output.returned,
                        thrown: output.thrown,
                    }
                }
            };
            if self.via_side[function as usize] {
                result.returned = Some(Value::Unknown);
            }
            let old = child[function as usize];
            let previous = old.unwrap_or_default();
            let next = Child {
                returned: match (previous.returned, result.returned) {
                    (None, x) | (x, None) => x,
                    (Some(a), Some(b)) => Some(join_value(a, b)),
                },
                thrown: previous.thrown | result.thrown,
            };
            if old != Some(next) {
                child[function as usize] = Some(next);
                for caller in self.callers(function)? {
                    if !queued[caller as usize] {
                        queued[caller as usize] = true;
                        queue.push_back(caller);
                    }
                }
            }
        }
        let mut keep: BTreeSet<_> = child
            .iter()
            .enumerate()
            .filter_map(|(f, c)| (f < self.n && c.is_some()).then_some(f as u32))
            .collect();
        keep.insert(self.seed);
        let handler = program.functions.iter().enumerate().any(|(f, info)| {
            info.escaping && plan.handler_signature(info.signature) && child[f].is_some()
        });
        let gates: BTreeSet<_> = if handler {
            plan.required_signal_gates().collect()
        } else {
            BTreeSet::new()
        };
        keep.extend(gates.iter().copied());
        let mut output = NativeSinkPlan {
            activations: today.activations.intersection(&keep).copied().collect(),
            control_reachable: today
                .control_reachable
                .intersection(&keep)
                .copied()
                .collect(),
            required_signal_gates: gates,
            ..Default::default()
        };
        for (f, c) in child[..self.n].iter().enumerate() {
            if f == self.seed as usize {
                continue;
            }
            if let Some(c) = c {
                if self.closed(c, f as u32) {
                    if output.activations.contains(&(f as u32)) {
                        output.boundaries.insert(f as u32);
                    }
                } else {
                    output.fork_returning.insert(f as u32);
                }
            }
        }
        Ok(output)
    }
    fn injection(
        &self,
        function: u32,
        instruction: usize,
        targets: &[u32],
        child: &[Option<Child>],
        injections: &mut BTreeMap<usize, Injection>,
        needed: &mut bool,
    ) -> Result<()> {
        let mut returned = None;
        let mut thrown = 0;
        for &target in targets {
            if target != EXT && self.vfork[target as usize] {
                *needed = true;
                continue;
            }
            if let Some(c) = child[self.ix(target)] {
                if !self.closed(&c, target) {
                    if let Some(value) = c.returned {
                        // Parameters and frame-relative addresses belong to
                        // the callee. Never reinterpret them as caller locals.
                        let value = if matches!(value, Value::Parameter(_) | Value::StackAddress(_))
                        {
                            Value::Unknown
                        } else {
                            value
                        };
                        returned = Some(returned.map_or(value, |old| join_value(old, value)));
                    }
                    thrown |= c.thrown;
                }
            }
        }
        thrown = self
            .plan
            .remap_longjmp(function, targets, targets.contains(&EXT), thrown);
        if returned.is_some() || thrown != 0 {
            ensure!(
                injections.len() < self.limits.interpreter.evaluation.call_targets,
                "child injection count exceeds budget"
            );
            injections.insert(
                instruction,
                Injection {
                    returned,
                    thrown,
                    payload: None,
                },
            );
        }
        Ok(())
    }
}

struct Modes<'p, 's, 'a> {
    plan: &'p PolicyPlan<'p, 's, 'a>,
    seed: u32,
    values: BTreeSet<Value>,
    limit: usize,
}
impl Environment for Modes<'_, '_, '_> {
    fn call(
        &mut self,
        point: ProgramPoint,
        invocation: Invocation,
        selector: Value,
        arguments: &[Value],
        tail: bool,
    ) -> Result<CallEffect> {
        let selected = self.plan.resolve(point, invocation, selector, tail)?;
        if selected.external || selected.functions.contains(&self.seed) {
            let value = if selected.external {
                Value::Unknown
            } else {
                arguments.first().copied().unwrap_or(Value::Unknown)
            };
            if !self.values.contains(&value) {
                ensure!(
                    self.values.len() < self.limit,
                    "vfork argument values exceed budget"
                );
                self.values.insert(value);
            }
        }
        Ok(CallEffect {
            returned: (!selected.cut).then_some(Value::Unknown),
            thrown: if selected.cut { 0 } else { ALL_TAGS },
            targets: Vec::new(),
            external: false,
        })
    }
    fn global_constant(&self, index: u32) -> Option<i64> {
        self.plan.original_program().global_constants[index as usize]
    }
    fn stack_pointer_global(&self) -> Option<u32> {
        self.plan.original_program().stack_pointer_global
    }
}

fn next_terminates(program: &Program<'_, '_>, body: &FunctionIr<'_>, label: RegionId) -> bool {
    let region = &body.regions[label.0];
    let end = region
        .parent
        .map_or(body.instructions.len(), |p| body.regions[p.0].end);
    for i in region.end + 1..end {
        match body.instructions[i].operation {
            Operator::Nop => {}
            Operator::LocalGet { .. }
            | Operator::LocalSet { .. }
            | Operator::LocalTee { .. }
            | Operator::GlobalGet { .. }
            | Operator::GlobalSet { .. }
            | Operator::I32Const { .. }
            | Operator::I64Const { .. }
            | Operator::F32Const { .. }
            | Operator::F64Const { .. }
            | Operator::V128Const { .. }
            | Operator::Drop => {}
            Operator::Call { function_index } => {
                return program.original_scan().functions[function_index as usize]
                    .name
                    .as_deref()
                    .is_some_and(|name| {
                        name.contains("terminate") || name == "abort" || name.starts_with("abort(")
                    });
            }
            _ => return false,
        }
    }
    false
}
