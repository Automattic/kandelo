//! Checked libc callback/cancellation and signal-dispatch policies.

use std::collections::BTreeSet;

use anyhow::{Result, ensure};
use rusqlite::params;
use wasmparser::Operator;

use super::{
    Invocation, Limits, ParameterLimits, Program, ResolvedTargets, Tags, Value, jmp::JmpPlan,
};
use crate::{
    sink::{SignalPolicy, SinkPolicy},
    streaming::{IrLimits, ProgramPoint},
};

#[derive(Clone, Copy, Debug, Default)]
pub struct PolicyLimits {
    pub ir: IrLimits,
    pub evaluation: Limits,
    pub parameters: ParameterLimits,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyTargets {
    pub functions: Vec<u32>,
    pub external: bool,
    pub cut: bool,
}

/// An exclusive program borrow freezes policy tables for the returned plan.
/// Gate mode requires the corresponding runtime instrumentation; this type
/// emits no module itself. Source normalization and full sink planning remain
/// separate from these target/effect policies.
pub struct PolicyPlan<'p, 's, 'a> {
    program: &'p Program<'s, 'a>,
    signal: SignalPolicy,
    signal_callers: Vec<bool>,
    handler_keys: BTreeSet<u32>,
    cancel_callers: Vec<bool>,
    exits: Vec<bool>,
    jmp: Option<JmpPlan>,
    buffer_facts: bool,
}

impl<'p, 's, 'a> PolicyPlan<'p, 's, 'a> {
    pub fn build(
        program: &'p mut Program<'s, 'a>,
        policy: SinkPolicy,
        limits: PolicyLimits,
    ) -> Result<Self> {
        let n = program.functions.len();
        ensure!(
            n <= program.limits.metadata_bytes / 4,
            "sink policy headers exceed resident budget"
        );
        if !program.parameters_ready.get() {
            program.record_parameter_values(limits.ir, limits.evaluation, limits.parameters)?;
        }
        program.store.db.execute_batch(include_str!("policy.sql"))?;
        let mut output = Self {
            program,
            signal: policy.signal,
            signal_callers: vec![false; n],
            handler_keys: BTreeSet::new(),
            cancel_callers: vec![false; n],
            exits: vec![false; n],
            jmp: None,
            buffer_facts: false,
        };
        for name in ["__deliver_pending_signal", "__do_syscall_impl"] {
            for function in named(program, name, true) {
                if !program.functions[function as usize].imported {
                    output.signal_callers[function as usize] = true;
                }
            }
        }
        for signature in ["i32->", "i32,i32,i32->"] {
            if let Some(key) = output.signature(signature)? {
                output.handler_keys.insert(key);
            }
        }
        let writers = [
            "pthread_cancel",
            "__pthread_cancel",
            "timer_create",
            "__timer_create",
        ];
        // These source-shape rules require original linked LLVM facts. An
        // optimizer can inline writers without removing their effects.
        if program.store.calls_ready.get()
            && !writers.iter().any(|name| {
                named(program, name, true)
                    .iter()
                    .any(|f| !program.functions[*f as usize].imported)
            })
        {
            for name in [
                "__syscall_cp_check",
                "__syscall_cp_cancel_preflight",
                "__testcancel",
                "__cancel",
                "__pthread_testcancel",
                "pthread_testcancel",
            ] {
                for f in named(program, name, true) {
                    output.cancel_callers[f as usize] = true;
                }
            }
            for name in ["pthread_exit", "__pthread_exit"] {
                for f in named(program, name, true) {
                    output.exits[f as usize] = true;
                }
            }
        }
        if program.store.calls_ready.get() {
            output.registries(limits.ir)?;
        }
        output.cleanup()?;
        if program.store.calls_ready.get() {
            program.store.charge_work(1)?;
            output.buffer_facts =
                program
                    .store
                    .db
                    .query_row("SELECT EXISTS(SELECT 1 FROM jmp)", [], |r| r.get(0))?;
        }
        output.jmp = JmpPlan::build(program, limits.ir)?;
        Ok(output)
    }

    pub fn original_program(&self) -> &Program<'s, 'a> {
        self.program
    }

    pub fn required_signal_gates(&self) -> impl Iterator<Item = u32> + '_ {
        self.signal_callers
            .iter()
            .enumerate()
            .filter_map(|(f, &signal)| {
                (signal && self.signal == SignalPolicy::Gate).then_some(f as u32)
            })
    }

    pub fn cancel_cut(&self, caller: u32, callee: u32) -> bool {
        self.cancel_callers.get(caller as usize) == Some(&true)
            && self.exits.get(callee as usize) == Some(&true)
    }

    pub fn supports_tag_masks(&self) -> bool {
        let count = self.program.original_scan().types.as_ref().tag_count();
        count <= 62 && (count <= 40 || !self.buffer_facts)
    }

    pub(super) fn longjmp_buffer_bits(&self) -> Tags {
        self.jmp.as_ref().map_or(0, JmpPlan::buffer_bits)
    }
    pub(super) fn handler_signature(&self, key: u32) -> bool {
        self.handler_keys.contains(&key)
    }

    pub fn catch_bits(&self, function: u32, tag: u32) -> Tags {
        self.jmp
            .as_ref()
            .map_or(1u64 << tag.min(63), |jmp| jmp.catch_bits(function, tag))
    }

    pub fn remap_longjmp(
        &self,
        function: u32,
        targets: &[u32],
        external: bool,
        thrown: Tags,
    ) -> Tags {
        self.jmp.as_ref().map_or(thrown, |jmp| {
            jmp.remap(self.program, function, targets, external, thrown)
        })
    }

    fn signature(&self, text: &str) -> Result<Option<u32>> {
        let Some(atom) = self.program.store.find_atom(text)? else {
            return Ok(None);
        };
        self.program.store.charge_work(1)?;
        Ok(self.program.store.db.query_row(
            "SELECT MIN(signature) FROM sink_signature WHERE fact_name=?",
            [atom],
            |r| r.get(0),
        )?)
    }

    fn extend(&self, set: &mut BTreeSet<u32>, values: impl IntoIterator<Item = u32>) -> Result<()> {
        for value in values {
            if !set.contains(&value) {
                ensure!(
                    set.len() < self.program.limits.metadata_bytes / 64,
                    "registry target union exceeds resident budget"
                );
                set.insert(value);
            }
        }
        Ok(())
    }

    fn registered(&self, api: &str, parameter: u32) -> Result<Option<BTreeSet<u32>>> {
        let mut functions = named(self.program, api, false);
        if let Some(alias) = api
            .strip_prefix("__")
            .filter(|alias| alias.starts_with("pthread_"))
        {
            functions.extend(named(self.program, alias, false));
            functions.sort_unstable();
            functions.dedup();
        }
        if functions.is_empty() {
            return Ok([
                "pthread_atfork",
                "__pthread_once",
                "__pthread_key_create",
                "_pthread_cleanup_push",
            ]
            .contains(&api)
            .then(BTreeSet::new));
        }
        let mut targets = BTreeSet::new();
        for f in functions {
            let types = self.program.original_scan().types.as_ref();
            let ty = self.program.original_scan().functions[f as usize].ty;
            let arity = types
                .get(types.core_type_at_in_module(ty))
                .unwrap()
                .composite_type
                .unwrap_func()
                .params()
                .len();
            if (parameter as usize) >= arity {
                return Ok(None);
            }
            let Some(values) = self.program.parameter_targets(f, parameter)? else {
                return Ok(None);
            };
            self.extend(&mut targets, values)?;
        }
        Ok(Some(targets))
    }

    fn set_override(&self, caller: u32, signature: u32, targets: &BTreeSet<u32>) -> Result<()> {
        self.program.store.execute(
            "INSERT OR IGNORE INTO sink_override_group VALUES(?,?)",
            params![caller, signature],
        )?;
        self.program.store.execute(
            "DELETE FROM sink_override_target WHERE caller=? AND signature=?",
            params![caller, signature],
        )?;
        for &target in targets {
            if self.program.accepts(target, signature) {
                self.program.store.execute(
                    "INSERT INTO sink_override_target VALUES(?,?,?)",
                    params![caller, signature, target],
                )?;
            }
        }
        Ok(())
    }

    fn registries(&self, ir_limits: IrLimits) -> Result<()> {
        let hubs: &[(&str, &str, &[(&str, u32)])] = &[
            (
                "__fork_handler",
                "->",
                &[
                    ("pthread_atfork", 0),
                    ("pthread_atfork", 1),
                    ("pthread_atfork", 2),
                ],
            ),
            ("__funcs_on_exit", "i32->", &[("__cxa_atexit", 0)]),
            ("__pthread_once_full", "->", &[("__pthread_once", 1)]),
            (
                "__pthread_tsd_run_dtors",
                "i32->",
                &[("__pthread_key_create", 1)],
            ),
            (
                "_pthread_cleanup_pop",
                "i32->",
                &[("_pthread_cleanup_push", 1)],
            ),
            (
                "__pthread_exit",
                "i32->",
                &[("__pthread_key_create", 1), ("_pthread_cleanup_push", 1)],
            ),
        ];
        for &(hub, signature, apis) in hubs {
            let Some(key) = self.signature(signature)? else {
                continue;
            };
            let mut targets = BTreeSet::new();
            let mut known = true;
            for &(api, parameter) in apis {
                if let Some(values) = self.registered(api, parameter)? {
                    self.extend(&mut targets, values)?;
                } else {
                    known = false;
                    break;
                }
            }
            if known {
                for caller in named(self.program, hub, false) {
                    self.set_override(caller, key, &targets)?;
                }
            }
        }
        // Only literal immutable slots justify this inlined-atexit rule.
        // Unknown slots must not turn missing evidence into an empty registry.
        if self.program.constant_slots && named(self.program, "__cxa_atexit", false).is_empty() {
            let exits = named(self.program, "atexit", false);
            if let ([atexit], Some(key)) = (exits.as_slice(), self.signature("i32->")?) {
                if !self.program.functions[*atexit as usize].imported {
                    let body = self
                        .program
                        .original_scan()
                        .body_provider(ir_limits)
                        .load(*atexit)?;
                    let mut targets = BTreeSet::new();
                    for instruction in &body.instructions {
                        let value = match instruction.operation {
                            Operator::I32Const { value } => Some(i64::from(value)),
                            Operator::GlobalGet { global_index } => {
                                self.program.global_constants[global_index as usize]
                            }
                            _ => None,
                        };
                        if let Some(slot) = value
                            && let Some(target) = self.program.constant_slot(slot)?
                        {
                            self.extend(&mut targets, [target])?;
                        }
                    }
                    for caller in named(self.program, "__funcs_on_exit", false) {
                        self.set_override(caller, key, &targets)?;
                    }
                }
            }
        }
        if let Some(key) = self.signature("->")? {
            let mut wrappers = self.registered("__cxa_atexit", 0)?.unwrap_or_default();
            if let Some(&hub) = named(self.program, "__funcs_on_exit", false).first() {
                if let Some(signature) = self.signature("i32->")? {
                    if let Some(values) = self.override_targets(hub, signature)? {
                        self.extend(&mut wrappers, values)?;
                    }
                }
            }
            if let Some(targets) = self.registered("atexit", 0)? {
                for caller in named(self.program, "call", false) {
                    if wrappers.contains(&caller) {
                        self.set_override(caller, key, &targets)?;
                    }
                }
            }
        }
        Ok(())
    }

    pub fn override_targets(&self, caller: u32, signature: u32) -> Result<Option<Vec<u32>>> {
        self.program.store.charge_work(2)?;
        let exists: bool = self.program.store.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sink_override_group WHERE caller=? AND signature=?)",
            params![caller, signature],
            |r| r.get(0),
        )?;
        if !exists {
            return Ok(None);
        }
        let mut query = self.program.store.db.prepare_cached("SELECT target FROM sink_override_target WHERE caller=? AND signature=? ORDER BY target")?;
        let mut rows = query.query(params![caller, signature])?;
        let mut targets = Vec::new();
        while let Some(row) = rows.next()? {
            ensure!(
                targets.len() < self.program.limits.metadata_bytes / 8,
                "registry target group exceeds resident budget"
            );
            targets.push(row.get(0)?);
        }
        Ok(Some(targets))
    }

    fn cleanup(&self) -> Result<()> {
        if !self.program.store.calls_ready.get() {
            return Ok(());
        }
        // Keep original caller identity. The compatibility projection uses
        // names; copying that projection would apply a bound caller's proof
        // to an unrelated unbound function with the same local symbol name.
        self.program.store.db.execute_batch(
            "INSERT INTO sink_cleanup_group
          SELECT caller FROM cleanup_caller;
          INSERT OR IGNORE INTO sink_cleanup_target
          SELECT c.caller,t.id FROM cleanup_caller c
            JOIN cleanup_handler h ON h.caller=c.caller JOIN wasm_function t ON t.name=h.handler;",
        )?;
        Ok(())
    }

    fn finish(&self, point: ProgramPoint, mut selected: PolicyTargets) -> Result<PolicyTargets> {
        if !selected.external
            && selected.functions.len() == 1
            && self
                .program
                .original_scan()
                .functions
                .get(selected.functions[0] as usize)
                .is_some_and(|f| f.name.as_deref() == Some("_pthread_cleanup_pop"))
        {
            self.program.store.charge_work(2)?;
            let exists: bool = self.program.store.db.query_row(
                "SELECT EXISTS(SELECT 1 FROM sink_cleanup_group WHERE caller=?)",
                [point.function],
                |r| r.get(0),
            )?;
            if exists {
                let mut query = self.program.store.db.prepare_cached(
                    "SELECT handler FROM sink_cleanup_target WHERE caller=? ORDER BY handler",
                )?;
                let mut rows = query.query([point.function])?;
                let mut targets = Vec::new();
                while let Some(row) = rows.next()? {
                    ensure!(
                        targets.len() < self.program.limits.metadata_bytes / 8,
                        "cleanup target group exceeds resident budget"
                    );
                    targets.push(row.get(0)?);
                }
                // run==0 skips the handler, so the pop can return normally.
                targets.push(u32::MAX);
                selected.functions = targets;
            }
        }
        Ok(selected)
    }

    /// Normal call selection before longjmp effects and specialization.
    pub fn resolve(
        &self,
        point: ProgramPoint,
        invocation: Invocation,
        selector: Value,
        tail: bool,
    ) -> Result<PolicyTargets> {
        ensure!(
            (point.function as usize) < self.program.functions.len(),
            "unknown policy caller"
        );
        if let Invocation::Direct(callee) = invocation
            && self.cancel_cut(point.function, callee)
        {
            return Ok(PolicyTargets {
                functions: Vec::new(),
                external: false,
                cut: true,
            });
        }
        if let Invocation::Indirect { table, ty } = invocation {
            self.program.table_has_external_targets(table)?;
            let key = self.program.signature(ty)?;
            if !tail
                && self.signal == SignalPolicy::Gate
                && self.signal_callers[point.function as usize]
                && self.handler_keys.contains(&key)
            {
                return Ok(PolicyTargets {
                    functions: vec![u32::MAX],
                    external: false,
                    cut: false,
                });
            }
            if !(table == 0
                && self.program.constant_slots
                && matches!(selector, Value::Constant(_)))
            {
                if let Value::Parameter(parameter) = selector {
                    if let Some(mut functions) =
                        self.program.parameter_targets(point.function, parameter)?
                    {
                        functions.retain(|f| self.program.accepts(*f, key));
                        return self.finish(
                            point,
                            PolicyTargets {
                                functions,
                                external: false,
                                cut: false,
                            },
                        );
                    }
                }
                if let Some(functions) = self.override_targets(point.function, key)? {
                    let external = self.program.table_has_external_targets(table)?;
                    return self.finish(
                        point,
                        PolicyTargets {
                            functions,
                            external,
                            cut: false,
                        },
                    );
                }
            }
        }
        let ResolvedTargets {
            functions,
            external,
        } = self
            .program
            .base_targets(point.function, invocation, selector)?;
        self.finish(
            point,
            PolicyTargets {
                functions,
                external,
                cut: false,
            },
        )
    }
}

fn named(program: &Program<'_, '_>, name: &str, demangled: bool) -> Vec<u32> {
    program
        .original_scan()
        .functions
        .iter()
        .enumerate()
        .filter_map(|(i, f)| {
            let text = f.name.as_deref()?;
            (text == name
                || (demangled && text.strip_prefix(name).is_some_and(|s| s.starts_with('('))))
            .then_some(i as u32)
        })
        .collect()
}
