//! Differential checks only. The production Walrus interpreter is unchanged.
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use super::*;
use crate::streaming::{self, sink as native};

fn value(v: V) -> native::Value {
    match v {
        V::Top => native::Value::Unknown,
        V::C(c) => native::Value::Constant(c),
        V::P(p) => native::Value::Parameter(p),
        V::Exn(t) => native::Value::Exception(t),
        V::Sp(k) => native::Value::StackAddress(k),
    }
}

struct Env<'a> {
    p: &'a Prog<'a>,
    summaries: &'a [Summ],
    types: &'a [TypeId],
    globals: &'a [GlobalId],
}

impl native::Environment for Env<'_> {
    fn call(
        &mut self,
        _: streaming::ProgramPoint,
        invocation: native::Invocation,
        selector: native::Value,
        _: &[native::Value],
        _: bool,
    ) -> anyhow::Result<native::CallEffect> {
        let (targets, external): (Vec<u32>, bool) = match invocation {
            native::Invocation::Direct(f) => (vec![f], false),
            native::Invocation::Indirect { table, ty } => {
                let key = self.p.tkey[&self.types[ty as usize]];
                if let (0, native::Value::Constant(k), Some(slots)) =
                    (table, selector, &self.p.slots)
                {
                    (
                        slots
                            .get(&k)
                            .copied()
                            .filter(|f| self.p.skey[*f as usize] == key)
                            .into_iter()
                            .collect(),
                        false,
                    )
                } else {
                    (
                        self.p
                            .members
                            .get(&(table as usize, key))
                            .cloned()
                            .unwrap_or_default(),
                        self.p.dyn_link,
                    )
                }
            }
            native::Invocation::Reference { ty } => {
                let key = self.p.tkey[&self.types[ty as usize]];
                (
                    (0..self.p.n as u32)
                        .filter(|f| self.p.escapes[*f as usize] && self.p.skey[*f as usize] == key)
                        .collect(),
                    self.p.dyn_link,
                )
            }
        };
        let mut ret = external;
        let mut thr = if external { TAGS_ALL } else { 0 };
        for &target in &targets {
            if self.p.import[target as usize] {
                ret = true;
            } else {
                ret |= self.summaries[target as usize].ret;
                thr |= self.summaries[target as usize].thr;
            }
        }
        Ok(native::CallEffect {
            returned: ret.then_some(native::Value::Unknown),
            thrown: thr,
            targets,
            external,
        })
    }
    fn global_constant(&self, global: u32) -> Option<i64> {
        self.p.gconst.get(&self.globals[global as usize]).copied()
    }
    fn stack_pointer_global(&self) -> Option<u32> {
        self.p
            .sp_global
            .and_then(|g| self.globals.iter().position(|v| *v == g).map(|i| i as u32))
    }
}

fn compare(wat: &str, children: bool) {
    let bytes = wat::parse_str(wat).unwrap();
    let scan = streaming::scan(&bytes).unwrap();
    let local_counts: Vec<_> = streaming::FunctionBodies::new(&bytes, Default::default())
        .map(|body| {
            let body = body.unwrap();
            (body.function, body.locals.len())
        })
        .collect();
    let mapping = Arc::new(Mutex::new((Vec::new(), Vec::new(), HashMap::new())));
    let capture = mapping.clone();
    let (ntypes, nglobals) = (
        scan.types.as_ref().core_type_count_in_module(),
        scan.types.as_ref().global_count(),
    );
    let mut config = ModuleConfig::new();
    config.on_instr_loc(|offset| InstrLocId::new(*offset as u32));
    config.on_parse(move |_, indices| {
        let mut mapping = capture.lock().unwrap();
        mapping.0 = (0..ntypes)
            .map(|i| indices.get_type(i))
            .collect::<walrus::Result<Vec<_>>>()?;
        mapping.1 = (0..nglobals)
            .map(|i| indices.get_global(i))
            .collect::<walrus::Result<Vec<_>>>()?;
        for &(f, count) in &local_counts {
            let fid = indices.get_func(f)?;
            for i in 0..count as u32 {
                mapping.2.insert((fid, indices.get_local(fid, i)?), i);
            }
        }
        Ok(())
    });
    let module = config.parse(&bytes).unwrap();
    let p = Prog::new(&module);
    let mapping = mapping.lock().unwrap();
    let mut storage = crate::facts::storage::FactsStore::empty(Default::default()).unwrap();
    let metadata = native::Program::build(&scan, &mut storage, Default::default()).unwrap();
    assert_eq!(
        metadata.constant_slots,
        p.slots.is_some(),
        "constant slots in {wat}"
    );
    assert_eq!(metadata.dynamic_linking, p.dyn_link);
    for (f, info) in metadata.functions.iter().enumerate() {
        assert_eq!(
            (
                info.imported,
                info.escaping,
                info.small,
                info.noreturn,
                info.nothrow
            ),
            (
                p.import[f],
                p.escapes[f],
                p.small[f],
                p.noreturn[f],
                p.nothrow[f]
            ),
            "metadata function {f} in {wat}"
        );
        assert_eq!(metadata.direct_callers(f as u32).unwrap(), p.callers[f]);
        if let Some(slots) = &p.slots {
            for (&slot, &target) in slots {
                assert_eq!(metadata.constant_slot(slot).unwrap(), Some(target));
            }
        }
    }
    for (t, &old_type) in mapping.0.iter().enumerate() {
        if !module.types.get(old_type).is_function() {
            continue;
        }
        let key = metadata.signature(t as u32).unwrap();
        let old_key = p.tkey[&old_type];
        for table in 0..scan.table_initializers.len() {
            assert_eq!(
                metadata.table_targets(table as u32, key).unwrap(),
                p.members
                    .get(&(table, old_key))
                    .cloned()
                    .unwrap_or_default(),
                "table {table} type {t} in {wat}"
            );
        }
        let expected: Vec<_> = (0..p.n as u32)
            .filter(|f| p.escapes[*f as usize] && p.skey[*f as usize] == old_key)
            .collect();
        assert_eq!(metadata.reference_targets(key).unwrap(), expected);
        let actual = metadata.indirect_callers(key).unwrap();
        assert!(
            p.icallers
                .get(&old_key)
                .into_iter()
                .flatten()
                .all(|f| actual.contains(f))
        );
    }
    for (source, &global) in mapping.1.iter().enumerate() {
        assert_eq!(
            metadata.global_constants[source],
            p.gconst.get(&global).copied()
        );
    }
    assert_eq!(
        metadata.stack_pointer_global.map(|i| mapping.1[i as usize]),
        p.sp_global
    );
    let summaries: Vec<_> = p
        .names
        .iter()
        .enumerate()
        .map(|(i, name)| Summ {
            ret: !name.starts_with("never_"),
            thr: if name.starts_with("throws_") && !p.import[i] {
                1
            } else {
                0
            },
        })
        .collect();
    let mut ptarg = HashMap::new();
    let mut seen = HashMap::new();
    let mut escaped = HashSet::new();
    let mut spec = HashMap::new();
    let mut provider = scan.body_provider(Default::default());
    for function in scan.imported_functions..scan.functions.len() as u32 {
        let body = provider.load(function).unwrap();
        let lf = module.funcs.get(p.fid(function)).kind.unwrap_local();
        let info = fninfo(&module, lf);
        let mut cx = Ctx {
            p: &p,
            summ: &summaries,
            ptarg: &mut ptarg,
            exn_seen: &mut seen,
            frame_esc: &mut escaped,
            allow_spec: false,
            spec: &mut spec,
            depth: 0,
        };
        let old = interpret2(
            &mut cx,
            function,
            &info,
            Mode::Normal,
            &HashMap::new(),
            None,
            true,
        );
        let all_calls: BTreeSet<_> = body.calls.iter().map(|call| call.instruction).collect();
        let mut env = Env {
            p: &p,
            summaries: &summaries,
            types: &mapping.0,
            globals: &mapping.1,
        };
        let mut new = native::evaluate(
            &scan,
            &body,
            &mut env,
            native::Options {
                record_states: Some(&all_calls),
                record_targets: true,
                ..Default::default()
            },
            Default::default(),
        )
        .unwrap();
        if new.frame_escaped {
            new = native::evaluate(
                &scan,
                &body,
                &mut env,
                native::Options {
                    record_states: Some(&all_calls),
                    record_targets: true,
                    disable_frame_tracking: true,
                    ..Default::default()
                },
                Default::default(),
            )
            .unwrap();
        }
        assert_eq!(
            (new.returned, new.thrown, new.unsupported),
            (old.ret.map(value), old.thr, old.unsupported),
            "function {function} in {wat}"
        );
        let expected: BTreeMap<_, BTreeSet<_>> = old
            .sites
            .iter()
            .map(|(&(seq, i), targets)| {
                (
                    lf.block(seq).instrs[i].1.data() as usize,
                    targets.iter().copied().collect(),
                )
            })
            .collect();
        let actual: BTreeMap<_, BTreeSet<_>> = new
            .targets
            .iter()
            .map(|(&i, ts)| {
                (
                    body.instructions[i].point.offset,
                    ts.iter().copied().collect(),
                )
            })
            .collect();
        assert_eq!(actual, expected, "targets in function {function} in {wat}");
        // Compare original local coordinates, not Walrus's compact local order.
        let old_keys: HashMap<_, _> = all_seqs(lf)
            .iter()
            .flat_map(|(seq, block)| {
                block
                    .instrs
                    .iter()
                    .enumerate()
                    .filter_map(move |(i, (op, loc))| {
                        matches!(
                            op,
                            Instr::Call(_) | Instr::CallIndirect(_) | Instr::CallRef(_)
                        )
                        .then_some((loc.data() as usize, (*seq, i)))
                    })
            })
            .collect();
        let state_keys = old_keys.values().map(|k| (*k, None)).collect();
        let frame = !cx.frame_esc.contains(&function) && p.sp_global.is_some();
        let (_, states, _) = walk_body(
            &mut cx,
            function,
            &info,
            Mode::Normal,
            &HashMap::new(),
            None,
            false,
            Some(state_keys),
            HashMap::new(),
            frame,
            None,
        );
        for (&i, state) in &new.states {
            let offset = body.instructions[i].point.offset;
            let Some(key) = old_keys.get(&offset) else {
                continue;
            }; // Tail sites have no normal post-call state.
            let old_state = states.as_ref().unwrap()[key].as_ref().unwrap();
            assert_eq!(
                state.stack,
                old_state.stk.iter().copied().map(value).collect::<Vec<_>>(),
                "stack at {offset} in {wat}"
            );
            for (local, &slot) in &info.lidx {
                let original = mapping.2[&(p.fid(function), *local)] as usize;
                assert_eq!(
                    state.locals[original],
                    value(old_state.loc[slot]),
                    "local {original} at {offset} in {wat}"
                );
            }
        }
        if children {
            for call in &body.calls {
                let index = call.instruction;
                let offset = body.instructions[index].point.offset;
                let Some((seq, ix)) = all_seqs(lf).iter().find_map(|(seq, block)| {
                    block
                        .instrs
                        .iter()
                        .enumerate()
                        .find(|(_, (_, loc))| loc.data() as usize == offset)
                        .map(|(ix, _)| (*seq, ix))
                }) else {
                    continue;
                };
                for (ret, thr) in [
                    (Some(V::C(0)), 0),
                    (Some(V::C(1)), 0),
                    (Some(V::Top), 0),
                    (None, 1),
                    (None, TAGS_ALL),
                ] {
                    let inject = HashMap::from([(
                        (seq, ix),
                        Inject {
                            ret,
                            thr,
                            top: None,
                        },
                    )]);
                    let old = interpret(&mut cx, function, &info, Mode::Child, &inject, None);
                    let injections = BTreeMap::from([(
                        index,
                        native::Injection {
                            returned: ret.map(value),
                            thrown: thr,
                            payload: None,
                        },
                    )]);
                    let new_child = native::evaluate(
                        &scan,
                        &body,
                        &mut env,
                        native::Options {
                            child: true,
                            injections: Some(&injections),
                            normal_states: Some(&new.states),
                            disable_frame_tracking: cx.frame_esc.contains(&function),
                            ..Default::default()
                        },
                        Default::default(),
                    )
                    .unwrap();
                    assert_eq!(
                        (new_child.returned, new_child.thrown, new_child.unsupported),
                        (old.ret.map(value), old.thr, old.unsupported),
                        "child at {offset} returning {ret:?} throwing {thr:#x} in {wat}"
                    );
                }
            }
        }
    }
    let planned = native::solve_summaries(
        &metadata,
        Default::default(),
        Default::default(),
        |body, context| {
            let summaries: Vec<_> = context
                .summaries
                .iter()
                .map(|s| Summ {
                    ret: s.may_return,
                    thr: s.thrown,
                })
                .collect();
            let mut environment = Env {
                p: &p,
                summaries: &summaries,
                types: &mapping.0,
                globals: &mapping.1,
            };
            native::evaluate(
                &scan,
                body,
                &mut environment,
                native::Options {
                    disable_frame_tracking: context.disable_frame_tracking,
                    ..Default::default()
                },
                native::Limits {
                    work: native::Limits::default().work.min(context.work_remaining),
                    ..Default::default()
                },
            )
        },
    )
    .unwrap();
    // The oracle interpreter computes the same least fixed point. A complete
    // round-robin test driver also checks call_ref dependencies independently
    // of the production oracle's historical workqueue bookkeeping.
    let mut expected: Vec<_> = p
        .import
        .iter()
        .map(|imported| Summ {
            ret: *imported,
            thr: 0,
        })
        .collect();
    let mut ptarg = HashMap::new();
    let mut seen = HashMap::new();
    let mut escaped = HashSet::new();
    let mut spec = HashMap::new();
    for round in 0..50 * p.n.max(1) {
        let before = expected.clone();
        for f in scan.imported_functions..p.n as u32 {
            let info = fninfo(&module, module.funcs.get(p.fid(f)).kind.unwrap_local());
            let mut cx = Ctx {
                p: &p,
                summ: &expected,
                ptarg: &mut ptarg,
                exn_seen: &mut seen,
                frame_esc: &mut escaped,
                allow_spec: false,
                spec: &mut spec,
                depth: 0,
            };
            let result = interpret(&mut cx, f, &info, Mode::Normal, &HashMap::new(), None);
            let mut next = if result.unsupported {
                Summ {
                    ret: true,
                    thr: TAGS_ALL,
                }
            } else {
                Summ {
                    ret: result.ret.is_some(),
                    thr: result.thr,
                }
            };
            if p.noreturn[f as usize] {
                next.ret = false;
            }
            if p.nothrow[f as usize] {
                next.thr = 0;
            }
            expected[f as usize].ret |= next.ret;
            expected[f as usize].thr |= next.thr;
        }
        if before == expected {
            break;
        }
        assert!(
            round + 1 < 50 * p.n.max(1),
            "oracle fixed point did not converge"
        );
    }
    assert_eq!(
        planned
            .functions
            .iter()
            .map(|s| (s.may_return, s.thrown))
            .collect::<Vec<_>>(),
        expected.iter().map(|s| (s.ret, s.thr)).collect::<Vec<_>>(),
        "normal summary fixed point in {wat}"
    );
}

#[test]
fn native_control_values_and_child_resumption_match_the_walrus_interpreter() {
    for body in [
        "call $fork if (result i32) i32.const 31 else i32.const 47 end",
        "call $fork i32.eqz if call $exit unreachable end i32.const 7",
        "block $out (result i32) i32.const 12 call $fork br_if $out drop i32.const 19 end",
        "block $out (result i32) i32.const 12 call $fork br_table $out $out end",
        "(local $x i32) i32.const 5 local.set $x loop $again local.get $x i32.const 1 i32.sub local.tee $x call $fork i32.add br_if $again end local.get $x",
        "call $fork local.get 0 i32.const 2 i32.add i32.mul i32.const 7 i32.xor",
        "block $out (result i32) i32.const 1 if i32.const 17 br $out else call $fork drop end i32.const 19 end",
        "call $fork return i32.const 9",
        "return_call $fork",
        "call $fork i32.const 7 i32.const 9 select",
    ] {
        compare(
            &format!(
                r#"(module (import "kernel" "kernel_fork" (func $fork (result i32))) (import "host" "exit" (func $exit)) (func (param i32) (result i32) {body}))"#
            ),
            true,
        );
    }
}

#[test]
fn native_handlers_and_exception_values_match_the_walrus_interpreter() {
    for body in [
        "block $caught (result i32) try_table (result i32) (catch $e $caught) call $fork end end drop",
        "block $caught (result exnref) try_table (result exnref) (catch_all_ref $caught) call $fork drop call $throws_a ref.null exn end end throw_ref",
        "block $done block $caught try_table (catch_all $caught) call $fork drop br $done end end call $fork drop end",
        "try call $fork drop catch_all call $fork drop end",
        "try call $fork drop catch $e drop rethrow 0 catch_all nop end",
        "try try call $throws_a catch_all call $fork drop rethrow 0 end catch_all nop end",
    ] {
        compare(
            &format!(
                r#"(module (import "kernel" "kernel_fork" (func $fork (result i32))) (tag $e (param i32)) (func $throws_a i32.const 5 throw $e) (func {body}))"#
            ),
            true,
        );
    }
}

#[test]
fn native_table_reference_and_tail_call_effects_match_the_walrus_interpreter() {
    compare(
        r#"(module
      (type $ty (func (param i32) (result i32)))
      (import "host" "input" (func $input (result i32)))
      (func $a (type $ty) local.get 0)
      (func $b (type $ty) i32.const 4)
      (table 2 funcref) (elem (i32.const 0) func $a $b)
      (func (result i32) i32.const 4 i32.const 1 call_indirect (type $ty))
      (func (result i32) i32.const 4 call $input call_indirect (type $ty))
      (func (result i32) i32.const 4 ref.func $b call_ref $ty)
      (func (result i32) i32.const 4 i32.const 0 return_call_indirect (type $ty))
      (func (result i32) i32.const 4 ref.func $a return_call_ref $ty))"#,
        true,
    );
}

#[test]
fn native_frame_slots_and_escaping_addresses_match_the_walrus_interpreter() {
    for body in [
        "global.get $sp i32.const 13 i32.store global.get $sp i32.load call $fork i32.add",
        "global.get $sp i32.const 13 i32.store global.get $sp i32.const 3 i32.store8 global.get $sp i32.load",
        "global.get $sp local.tee $base i32.const 13 i32.store call $fork drop local.get $base i32.load",
        "global.get $sp call $take global.get $sp i32.const 13 i32.store global.get $sp i32.load",
        "global.get $sp i32.const 16 i32.sub global.set $sp global.get $sp i32.const 11 i32.store global.get $sp i32.load",
        "global.get $sp i32.const 13 i32.store global.get $sp i32.atomic.load",
        "global.get $sp i32.const 13 i32.store global.get $sp i32.const 3 i32.atomic.store global.get $sp i32.load",
        "global.get $sp i32.const 13 i32.store global.get $sp v128.load drop global.get $sp i32.load",
        "global.get $sp i32.const 13 i32.store global.get $sp v128.const i32x4 0 0 0 0 v128.store offset=32 global.get $sp i32.load",
        "global.get $sp i32.const 13 i32.store global.get $sp v128.const i32x4 0 0 0 0 v128.load32_lane 0 drop global.get $sp i32.load",
    ] {
        let fixture = format!(
            r#"(module (import "kernel" "kernel_fork" (func $fork (result i32))) (import "host" "take" (func $take (param i32))) (memory 1) (global $sp (mut i32) (i32.const 1024)) (func (result i32) (local $base i32) {body}))"#
        );
        compare(&fixture.replace("$sp", "$__stack_pointer"), true);
    }
}

#[test]
fn native_integer_folds_match_the_walrus_value_domain_at_boundaries() {
    let pairs = [
        (-1, 1),
        (0, 0),
        (1, -1),
        (i32::MIN as i64, 31),
        (i32::MAX as i64, 32),
        (i64::MIN, i64::MAX),
        (i64::MAX, 65),
    ];
    let mut text = String::from("(module ");
    for (kind, operations, result) in [
        (
            "i32",
            &[
                "eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u",
            ][..],
            "i32",
        ),
        (
            "i64",
            &[
                "eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u",
            ][..],
            "i32",
        ),
        (
            "i32",
            &[
                "add", "sub", "mul", "and", "or", "xor", "shl", "shr_s", "shr_u", "div_s", "rotl",
            ][..],
            "i32",
        ),
        (
            "i64",
            &[
                "add", "sub", "mul", "and", "or", "xor", "shl", "shr_u", "div_u",
            ][..],
            "i64",
        ),
    ] {
        for op in operations {
            for (x, y) in pairs {
                let (x, y) = if kind == "i32" {
                    (x as i32 as i64, y as i32 as i64)
                } else {
                    (x, y)
                };
                text.push_str(&format!(
                    "(func (result {result}) {kind}.const {x} {kind}.const {y} {kind}.{op})"
                ));
            }
        }
    }
    for (input, result, op) in [
        ("i32", "i32", "i32.eqz"),
        ("i64", "i32", "i64.eqz"),
        ("i64", "i32", "i32.wrap_i64"),
        ("i32", "i64", "i64.extend_i32_s"),
        ("i32", "i64", "i64.extend_i32_u"),
        ("i32", "i32", "i32.extend8_s"),
        ("i32", "i32", "i32.extend16_s"),
    ] {
        for (x, _) in pairs {
            let x = if input == "i32" { x as i32 as i64 } else { x };
            text.push_str(&format!("(func (result {result}) {input}.const {x} {op})"));
        }
    }
    text.push(')');
    compare(&text, false);
}

#[test]
fn native_parameter_proofs_match_the_oracle_for_direct_constant_forwarding() {
    for root in [
        "(func $root (export \"run\") i32.const 1 call $forward)",
        "(func $root (export \"run\") i32.const 0 call $forward i32.const 1 call $forward)",
        "(func $root (export \"run\") i32.const 99 call $forward)",
        "(func $root (export \"run\") (param i32) local.get 0 call $forward)",
        "(func $root (export \"run\") i32.const 0 i32.load call $forward)",
    ] {
        let bytes = wat::parse_str(format!(
            r#"(module (type $v (func)) (memory 1) (table 2 funcref)
          (func $a) (func $b) (elem (i32.const 0) func $a $b)
          (func $dispatch (param i32) local.get 0 call_indirect (type $v))
          (func $forward (param i32) local.get 0 call $dispatch) {root})"#
        ))
        .unwrap();
        let module = ModuleConfig::new().parse(&bytes).unwrap();
        let p = Prog::new(&module);
        let function = p.by_name("dispatch")[0];
        let mut cache = HashMap::new();
        let mut seen = HashMap::new();
        let mut escaped = HashSet::new();
        let mut spec = HashMap::new();
        let mut cx = Ctx {
            p: &p,
            summ: &[],
            ptarg: &mut cache,
            exn_seen: &mut seen,
            frame_esc: &mut escaped,
            allow_spec: false,
            spec: &mut spec,
            depth: 0,
        };
        let expected = param_targets(&mut cx, function, 0, 0);
        let scan = streaming::scan(&bytes).unwrap();
        let mut store = crate::facts::storage::FactsStore::empty(Default::default()).unwrap();
        let program = native::Program::build(&scan, &mut store, Default::default()).unwrap();
        program
            .record_parameter_values(Default::default(), Default::default(), Default::default())
            .unwrap();
        assert_eq!(
            program.parameter_targets(function, 0).unwrap(),
            expected,
            "{root}"
        );
    }
}

#[test]
fn native_atfork_registry_targets_match_the_oracle_checked_rules() {
    for (api, registration, mutate) in [
        (
            "(func $pthread_atfork (param i32 i32 i32))",
            "i32.const 0 i32.const 1 i32.const 1 call $pthread_atfork",
            "",
        ),
        (
            "(func $pthread_atfork (param i32 i32 i32))",
            "local.get 0 i32.const 1 i32.const 1 call $pthread_atfork",
            "",
        ),
        ("", "", ""),
        (
            "(func $pthread_atfork (param i32 i32 i32))",
            "i32.const 0 i32.const 1 i32.const 1 call $pthread_atfork",
            "(func ref.null func i32.const 0 table.grow 0 drop)",
        ),
    ] {
        let bytes = wat::parse_str(format!(r#"(module (type $v (func)) (table 3 funcref)
          (func $a) (func $b) (func $other) (elem (i32.const 0) func $a $b $other)
          {api} (func $__fork_handler (param i32) local.get 0 call_indirect (type $v))
          (func $root (export "run") (param i32) {registration} local.get 0 call $__fork_handler) {mutate})"#)).unwrap();
        let module = ModuleConfig::new().parse(&bytes).unwrap();
        let mut p = Prog::new(&module);
        p.use_param = true;
        apply_registries(&mut p);
        let old_key = keys_lookup(&module, &p.tkey, "[]->[]").unwrap();
        let caller = p.by_name("__fork_handler")[0];
        let expected = p.itargets.get(&(caller, old_key)).cloned();
        let scan = streaming::scan(&bytes).unwrap();
        let mut store = crate::facts::storage::FactsStore::empty(Default::default()).unwrap();
        let mut program = native::Program::build(&scan, &mut store, Default::default()).unwrap();
        let key = program.signature(0).unwrap();
        let plan = native::PolicyPlan::build(&mut program, Default::default(), Default::default())
            .unwrap();
        assert_eq!(plan.override_targets(caller, key).unwrap(), expected);
    }
}

#[test]
fn native_jmp_masks_match_the_oracle_for_known_and_unknown_buffers() {
    use wasm_encoder::Encode;
    for unknown in ["A", "*"] {
        let text = format!(
            "#kandelo-calltypes\t5\nJS\tsetA\tA\nJS\tsetB\tB\nJL\tjumpA\tA\nJL\tjumpB\tB\nJL\tunknown\t{unknown}\n"
        );
        let mut bytes = wat::parse_str(
            r#"(module (tag $j (param i32))
          (func $__wasm_longjmp (param i32) local.get 0 throw $j)
          (func $longjmp (param i32) local.get 0 call $__wasm_longjmp)
          (func $setA (param i32) local.get 0 call $__wasm_longjmp)
          (func $setB (param i32) local.get 0 call $__wasm_longjmp)
          (func $jumpA (param i32) local.get 0 call $longjmp)
          (func $jumpB (param i32) local.get 0 call $longjmp)
          (func $unknown (param i32) local.get 0 call $longjmp))"#,
        )
        .unwrap();
        let module = ModuleConfig::new().parse(&bytes).unwrap();
        let mut p = Prog::new(&module);
        apply_call_facts(
            &mut p,
            &CallFacts {
                jmp: text
                    .lines()
                    .filter(|l| l.starts_with("JS\t") || l.starts_with("JL\t"))
                    .map(str::to_owned)
                    .collect(),
                ..Default::default()
            },
        );
        let hash = crate::facts::code_sha256(&bytes).unwrap();
        for (name, data) in [
            (crate::facts::SECTION, text.as_bytes()),
            (crate::facts::CODE_HASH_SECTION, hash.as_slice()),
        ] {
            bytes.push(0);
            wasm_encoder::CustomSection {
                name: name.into(),
                data: data.into(),
            }
            .encode(&mut bytes);
        }
        let scan = streaming::scan(&bytes).unwrap();
        let mut store =
            crate::facts::storage::FactsStore::from_scan(&scan, Default::default()).unwrap();
        store.resolve_calls(&scan, Default::default()).unwrap();
        let mut program = native::Program::build(&scan, &mut store, Default::default()).unwrap();
        let plan = native::PolicyPlan::build(&mut program, Default::default(), Default::default())
            .unwrap();
        for function in 0..p.n as u32 {
            assert_eq!(
                plan.catch_bits(function, 0),
                p.lj_catch_mask(function, p.lj_generic())
            );
            for targets in [
                vec![0],
                vec![1],
                vec![0, 1],
                vec![4],
                vec![u32::MAX],
                vec![],
            ] {
                for thrown in [0, 1, TAGS_ALL, 1u64 << 40] {
                    assert_eq!(
                        plan.remap_longjmp(function, &targets, false, thrown),
                        p.lj_remap(function, &targets, thrown)
                    );
                }
            }
        }
    }
}
