use std::collections::{BTreeMap, BTreeSet};

use fork_instrument::facts::storage::{FactsStore, StorageLimits};
use fork_instrument::streaming::{self, sink::*, *};

struct Env;

#[test]
fn cached_call_selection_tracks_selectors_but_reads_current_effect_summaries() {
    let input = wat::parse_str(
        r#"(module (type $t (func (result i32)))
          (table 2 funcref) (elem (i32.const 0) $one $two)
          (func $one (type $t) i32.const 1)
          (func $two (type $t) i32.const 2)
          (func $caller (param i32) (result i32)
            local.get 0 call_indirect (type $t)))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let plan = PolicyPlan::build(&mut program, Default::default(), Default::default()).unwrap();
    let body = scan.body_provider(Default::default()).load(2).unwrap();
    // Disabled, too small, one entry (forcing eviction), and normal allowance.
    for allowance in [0, 1, 196, 2 * 1024 * 1024] {
        let mut interpreter = SinkInterpreter::new(
            &plan,
            InterpreterLimits {
                resolved_target_cache_bytes: allowance,
                ..Default::default()
            },
        )
        .unwrap();
        for (selector, may_return, thrown) in
            [(0, false, 1), (0, true, 2), (1, true, 4), (0, false, 8)]
        {
            let mut summaries = vec![Summary::default(); 3];
            summaries[selector] = Summary { may_return, thrown };
            let arguments = [Value::Constant(selector as i64)];
            let result = interpreter
                .evaluate(
                    &body,
                    &summaries,
                    Options {
                        entry_arguments: Some(&arguments),
                        ..Default::default()
                    },
                    false,
                    usize::MAX,
                )
                .unwrap();
            assert!(!result.unsupported);
            assert_eq!(result.returned.is_some(), may_return);
            assert_eq!(result.thrown, thrown);
        }
    }
}

impl Environment for Env {
    fn call(
        &mut self,
        _: ProgramPoint,
        _: Invocation,
        _: Value,
        _: &[Value],
        _: bool,
    ) -> anyhow::Result<CallEffect> {
        Ok(CallEffect {
            returned: Some(Value::Unknown),
            thrown: 0,
            targets: vec![0, 1],
            external: false,
        })
    }
    fn stack_pointer_global(&self) -> Option<u32> {
        Some(0)
    }
}

#[test]
fn repeated_call_sites_share_exact_targets_under_a_small_resident_allowance() {
    let calls = "call $f drop ".repeat(100);
    let input = wat::parse_str(format!(
        "(module (import \"h\" \"f\" (func $f (result i32))) (func {calls}))"
    ))
    .unwrap();
    let scan = scan(&input).unwrap();
    let body = scan.body_provider(Default::default()).load(1).unwrap();
    let result = evaluate(
        &scan,
        &body,
        &mut Env,
        Options {
            record_targets: true,
            ..Default::default()
        },
        Limits {
            call_targets: 2,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(result.targets.len(), 100);
    let first = result.targets.values().next().unwrap();
    for targets in result.targets.values() {
        assert_eq!(targets.as_ref(), &[0, 1]);
        assert!(std::sync::Arc::ptr_eq(first, targets));
    }
}

#[test]
fn native_sink_budgets_reject_before_publishing_partial_results() {
    let input = wat::parse_str(
        r#"(module (import "h" "f" (func $f (result i32)))
      (memory 1) (global $sp (mut i32) (i32.const 100))
      (func (result i32) block (result i32) call $f end))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let body = scan.body_provider(Default::default()).load(1).unwrap();
    for (limits, message) in [
        (
            Limits {
                work: 0,
                ..Default::default()
            },
            "work budget",
        ),
        (
            Limits {
                // Admit the body, then exhaust work during interpretation.
                work: body.instructions.len(),
                ..Default::default()
            },
            "requested",
        ),
        (
            Limits {
                state_values: 1,
                ..Default::default()
            },
            "state-value budget",
        ),
        (
            Limits {
                control_depth: 0,
                ..Default::default()
            },
            "control-depth budget",
        ),
        (
            Limits {
                call_targets: 1,
                ..Default::default()
            },
            "call-target budget",
        ),
    ] {
        let error = evaluate(
            &scan,
            &body,
            &mut Env,
            Options {
                record_targets: true,
                ..Default::default()
            },
            limits,
        )
        .unwrap_err();
        assert!(error.to_string().contains(message), "{error:#}");
        if matches!(message, "work budget" | "requested") {
            assert!(error.to_string().contains("function 1"), "{error:#}");
            assert!(error.to_string().contains("limit"), "{error:#}");
        }
    }
    let valid = evaluate(
        &scan,
        &body,
        &mut Env,
        Options::default(),
        Limits::default(),
    )
    .unwrap();
    assert!(!valid.unsupported);
    assert_eq!(valid.returned, Some(Value::Unknown));
}

#[test]
fn native_sink_frame_slot_budget_is_explicit_and_tracking_can_be_disabled() {
    let input = wat::parse_str(
        r#"(module (memory 1) (global $sp (mut i32) (i32.const 100))
      (func (result i32) global.get $sp i32.const 9 i32.store
        global.get $sp i32.const 10 i32.store offset=4 global.get $sp i32.load))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    let limits = Limits {
        frame_slots: 1,
        ..Default::default()
    };
    assert!(
        evaluate(&scan, &body, &mut Env, Default::default(), limits)
            .unwrap_err()
            .to_string()
            .contains("frame-slot budget")
    );
    let disabled = evaluate(
        &scan,
        &body,
        &mut Env,
        Options {
            disable_frame_tracking: true,
            ..Default::default()
        },
        limits,
    )
    .unwrap();
    assert_eq!(disabled.returned, Some(Value::Unknown));
    let tracked = evaluate(
        &scan,
        &body,
        &mut Env,
        Default::default(),
        Default::default(),
    )
    .unwrap();
    assert_eq!(tracked.returned, Some(Value::Constant(9)));
}

#[test]
fn native_sink_probes_restore_original_post_call_states_and_reject_invalid_states() {
    let input = wat::parse_str(
        r#"(module (import "h" "f" (func $f (result i32)))
      (func (param i32) (result i32) call $f local.get 0 i32.add))"#,
    )
    .unwrap();
    let scanned = scan(&input).unwrap();
    let body = scanned.body_provider(Default::default()).load(1).unwrap();
    let call = body.calls[0].instruction;
    let record = BTreeSet::from([call]);
    let normal = evaluate(
        &scanned,
        &body,
        &mut Env,
        Options {
            record_states: Some(&record),
            entry_arguments: Some(&[Value::Constant(7)]),
            ..Default::default()
        },
        Default::default(),
    )
    .unwrap();
    let injections = BTreeMap::from([(
        call,
        Injection {
            returned: None,
            thrown: 0,
            payload: Some(vec![Value::Constant(42)]),
        },
    )]);
    let options = Options {
        child: true,
        injections: Some(&injections),
        normal_states: Some(&normal.states),
        ..Default::default()
    };
    let child = evaluate(&scanned, &body, &mut Env, options, Default::default()).unwrap();
    assert_eq!(child.returned, Some(Value::Constant(49)));
    let invalid = BTreeMap::from([(
        call,
        State {
            live: true,
            locals: vec![],
            stack: vec![],
            memory: vec![],
            stack_pointer: None,
        },
    )]);
    assert!(
        evaluate(
            &scanned,
            &body,
            &mut Env,
            Options {
                child: true,
                injections: Some(&injections),
                normal_states: Some(&invalid),
                ..Default::default()
            },
            Default::default()
        )
        .unwrap_err()
        .to_string()
        .contains("invalid sink injection state")
    );
    let other_input = input.clone();
    let other = streaming::scan(&other_input).unwrap();
    assert!(
        evaluate(
            &other,
            &body,
            &mut Env,
            Default::default(),
            Default::default()
        )
        .unwrap_err()
        .to_string()
        .contains("original source function")
    );
}

#[test]
fn unsupported_gc_is_explicit_and_never_proves_a_sink() {
    let input = wat::parse_str(
        "(module (type $s (struct (field i32))) (func i32.const 4 struct.new $s drop))",
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    let result = evaluate(
        &scan,
        &body,
        &mut Env,
        Default::default(),
        Default::default(),
    )
    .unwrap();
    assert!(result.unsupported);
}

fn table_matrix(functions: usize, tables: usize) -> Vec<u8> {
    let mut text = String::from("(module ");
    for f in 0..functions {
        text.push_str(&format!("(func $f{f})"));
    }
    for _ in 0..tables {
        text.push_str("(table 1 funcref)");
    }
    text.push_str("(elem declare func ");
    for f in 0..functions {
        text.push_str(&format!("$f{f} "));
    }
    text.push_str(")(func ");
    for f in 0..functions {
        text.push_str(&format!("i32.const 0 ref.func $f{f} table.set 0 "));
    }
    text.push_str("))");
    wat::parse_str(text).unwrap()
}

#[test]
fn native_sink_table_matrix_uses_disk_relations_and_bounded_group_queries() {
    let input = table_matrix(48, 64);
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(StorageLimits {
        metadata_bytes: 4096,
        page_cache_bytes: 64 * 1024,
        ..Default::default()
    })
    .unwrap();
    let before = store.report().unwrap().database_bytes;
    let program = Program::build(
        &scan,
        &mut store,
        ProgramLimits {
            metadata_bytes: 4096,
            ..Default::default()
        },
    )
    .unwrap();
    let signature = program.signature(scan.functions[0].ty).unwrap();
    let expected: Vec<_> = (0..48).collect();
    for table in 0..64 {
        assert_eq!(program.table_targets(table, signature).unwrap(), expected);
    }
    assert_eq!(program.reference_targets(signature).unwrap(), expected);
    assert!(!program.constant_slots);
    assert_eq!(program.facts_signature(scan.functions[0].ty).unwrap(), "->");
    drop(program);
    assert!(store.report().unwrap().database_bytes > before);
    assert!(store.targets_for(0, "->").is_err()); // Empty planning storage is not a facts solution.
}

#[test]
fn native_sink_metadata_limits_and_disk_limits_fail_explicitly() {
    let input = table_matrix(256, 100);
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let base = store.report().unwrap().database_bytes;
    let error = Program::build(
        &scan,
        &mut store,
        ProgramLimits {
            metadata_bytes: 8,
            ..Default::default()
        },
    )
    .err()
    .unwrap();
    assert!(error.to_string().contains("resident budget"));
    let error = Program::build(
        &scan,
        &mut store,
        ProgramLimits {
            operators: 1,
            ..Default::default()
        },
    )
    .err()
    .unwrap();
    assert!(error.to_string().contains("operator budget"));
    drop(store);
    let mut store = FactsStore::empty(StorageLimits {
        disk_bytes: base + 128 * 1024,
        ..Default::default()
    })
    .unwrap();
    assert!(Program::build(&scan, &mut store, Default::default()).is_err());
}

#[test]
fn native_sink_null_slots_do_not_shift_function_positions_and_reference_calls_have_dependencies() {
    let input = wat::parse_str(
        r#"(module
      (type $v (func)) (func $a) (func $b)
      (table 3 funcref)
      (elem (i32.const 0) funcref (ref.func $a) (ref.null func) (ref.func $b))
      (func ref.func $b call_ref $v))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let signature = program.signature(scan.functions[0].ty).unwrap();
    assert_eq!(program.table_targets(0, signature).unwrap(), vec![0, 1]);
    assert!(!program.constant_slots);
    assert!(program.constant_slot(2).is_err());
    assert_eq!(program.indirect_callers(signature).unwrap(), vec![2]);
}

#[test]
fn native_sink_queries_compiler_targets_without_collecting_the_target_matrix() {
    use fork_instrument::facts;
    use wasm_encoder::Encode;
    let mut input = wat::parse_str(
        r#"(module (type $v (func)) (table 2 funcref)
      (func $allowed) (func $excluded) (elem (i32.const 0) func $allowed $excluded)
      (func $caller (param i32) local.get 0 call_indirect (type $v))
      (func $empty (param i32) local.get 0 call_indirect (type $v)))"#,
    )
    .unwrap();
    let hash = facts::code_sha256(&input).unwrap();
    let text = "#kandelo-calltypes\t5\nF\tallowed\t0\nT\tallowed\tA\nD\tallowed\t0\t0\nF\texcluded\t0\nT\texcluded\tB\nD\texcluded\t0\t0\nF\tcaller\t1\nS\tcaller\t0\t->\ticall\tA\nD\tcaller\t1\t1\nF\tempty\t1\nS\tempty\t0\t->\ticall\tC\nD\tempty\t1\t1\n";
    for (name, data) in [
        (facts::SECTION, text.as_bytes()),
        (facts::CODE_HASH_SECTION, hash.as_slice()),
    ] {
        input.push(0);
        wasm_encoder::CustomSection {
            name: name.into(),
            data: data.into(),
        }
        .encode(&mut input);
    }
    let scan = scan(&input).unwrap();
    let ty = scan.functions[0].ty;
    let indirect = Invocation::Indirect { table: 0, ty };
    let mut store = FactsStore::from_scan(&scan, Default::default()).unwrap();
    store.resolve_calls(&scan, Default::default()).unwrap();
    let program = Program::build(&scan, &mut store, Default::default()).unwrap();
    assert_eq!(
        program.base_targets(2, indirect, Value::Unknown).unwrap(),
        ResolvedTargets {
            functions: vec![0],
            external: false
        }
    );
    assert_eq!(
        program
            .base_targets(3, indirect, Value::Unknown)
            .unwrap()
            .functions,
        Vec::<u32>::new()
    );
    assert_eq!(
        program
            .base_targets(2, indirect, Value::Constant(1))
            .unwrap()
            .functions,
        vec![1]
    );
    assert_eq!(
        program
            .base_targets(2, Invocation::Reference { ty }, Value::Unknown)
            .unwrap()
            .functions,
        vec![0, 1]
    );
    drop(program);
    let mut empty = FactsStore::empty(Default::default()).unwrap();
    let program = Program::build(&scan, &mut empty, Default::default()).unwrap();
    assert_eq!(
        program
            .base_targets(2, indirect, Value::Unknown)
            .unwrap()
            .functions,
        vec![0, 1]
    );
    assert!(program.base_targets(99, indirect, Value::Unknown).is_err());
    assert!(
        program
            .base_targets(2, Invocation::Indirect { table: 99, ty }, Value::Unknown)
            .is_err()
    );
}

struct SummaryEnvironment<'p, 's, 'a> {
    program: &'p Program<'s, 'a>,
    summaries: &'p [Summary],
}

impl Environment for SummaryEnvironment<'_, '_, '_> {
    fn call(
        &mut self,
        point: ProgramPoint,
        invocation: Invocation,
        selector: Value,
        _: &[Value],
        _: bool,
    ) -> anyhow::Result<CallEffect> {
        let resolved = self
            .program
            .base_targets(point.function, invocation, selector)?;
        let mut returned = resolved.external;
        let mut thrown = if resolved.external { ALL_TAGS } else { 0 };
        for &function in &resolved.functions {
            returned |= self.summaries[function as usize].may_return;
            thrown |= self.summaries[function as usize].thrown;
        }
        Ok(CallEffect {
            returned: returned.then_some(Value::Unknown),
            thrown,
            targets: resolved.functions,
            external: resolved.external,
        })
    }
    fn global_constant(&self, index: u32) -> Option<i64> {
        self.program.global_constants[index as usize]
    }
    fn stack_pointer_global(&self) -> Option<u32> {
        self.program.stack_pointer_global
    }
}

fn summarize(program: &Program<'_, '_>, limits: SummaryLimits) -> anyhow::Result<Summaries> {
    solve_summaries(program, Default::default(), limits, |body, context| {
        let mut environment = SummaryEnvironment {
            program,
            summaries: context.summaries,
        };
        evaluate(
            program.original_scan(),
            body,
            &mut environment,
            Options {
                disable_frame_tracking: context.disable_frame_tracking,
                ..Default::default()
            },
            Limits {
                work: Limits::default().work.min(context.work_remaining),
                ..Default::default()
            },
        )
    })
}

#[test]
fn native_summary_fixed_point_revisits_direct_and_reference_callers() {
    for (text, expected) in [
        (
            "(module (func $caller call $target) (func $target))",
            vec![true, true],
        ),
        (
            "(module (type $v (func)) (func $caller ref.func $target call_ref $v) (func $target) (elem declare func $target))",
            vec![true, true],
        ),
        (
            "(module (func $a call $b) (func $b call $a) (func))",
            vec![false, false, true],
        ),
    ] {
        let input = wat::parse_str(text).unwrap();
        let scan = scan(&input).unwrap();
        let mut store = FactsStore::empty(Default::default()).unwrap();
        let program = Program::build(&scan, &mut store, Default::default()).unwrap();
        let result = summarize(&program, Default::default()).unwrap();
        assert_eq!(
            result
                .functions
                .iter()
                .map(|s| s.may_return)
                .collect::<Vec<_>>(),
            expected
        );
        assert!(result.unsupported.is_empty());
        assert!(result.work_steps > 0);
    }
}

#[test]
fn native_summary_fixed_point_propagates_exceptions_and_applies_named_contracts() {
    let input = wat::parse_str(
        r#"(module (tag $e)
      (func $caller block $caught try_table (catch $e $caught) call $throws end end)
      (func $throws throw $e)
      (func $_exit call $throws))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let result = summarize(&program, Default::default()).unwrap();
    assert_eq!(
        result.functions,
        vec![
            Summary {
                may_return: true,
                thrown: 0
            },
            Summary {
                may_return: false,
                thrown: 1
            },
            Summary {
                may_return: false,
                thrown: 0
            }
        ]
    );
    assert_eq!(
        result.evaluations, 3,
        "direct callees settle before callers"
    );
}

#[test]
fn native_summary_fixed_point_reruns_escaping_frames_and_marks_unsupported_bodies() {
    let input = wat::parse_str(
        r#"(module (type $s (struct (field i32)))
      (import "h" "take" (func $take (param i32)))
      (global $__stack_pointer (mut i32) (i32.const 128))
      (func global.get $__stack_pointer call $take)
      (func i32.const 7 struct.new $s drop))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let result = summarize(&program, Default::default()).unwrap();
    assert_eq!(result.frame_escaped, vec![false, true, false]);
    assert_eq!(result.unsupported, BTreeSet::from([2]));
    assert_eq!(
        result.functions[2],
        Summary {
            may_return: true,
            thrown: ALL_TAGS
        }
    );
    assert_eq!(result.evaluations, 3);
}

#[test]
fn native_summary_fixed_point_limits_do_not_return_partial_plans() {
    let input = wat::parse_str("(module (func))").unwrap();
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let program = Program::build(&scan, &mut store, Default::default()).unwrap();
    for (limits, message) in [
        (
            SummaryLimits {
                metadata_bytes: 0,
                ..Default::default()
            },
            "resident budget",
        ),
        (
            SummaryLimits {
                evaluations_per_function: 0,
                ..Default::default()
            },
            "evaluation budget",
        ),
        (
            SummaryLimits {
                work: 0,
                ..Default::default()
            },
            "work budget",
        ),
    ] {
        let error = summarize(&program, limits).unwrap_err();
        assert!(error.to_string().contains(message), "{error:#}");
    }
    assert!(
        solve_summaries(
            &program,
            Default::default(),
            SummaryLimits {
                work: 1,
                ..Default::default()
            },
            |_, _| Ok(Evaluation {
                work_steps: 2,
                ..Default::default()
            })
        )
        .unwrap_err()
        .to_string()
        .contains("work budget")
    );
}

#[test]
fn native_sink_dispatch_and_summary_dependencies_follow_declared_function_subtypes() {
    let input = wat::parse_str(
        r#"(module
      (type $s (struct))
      (type $base (sub (func (result (ref null $s)))))
      (type $derived (sub $base (func (result (ref $s)))))
      (func $caller (result (ref null $s)) ref.func $target call_ref $base)
      (func $target (type $derived) struct.new $s)
      (table 1 funcref) (elem (i32.const 0) func $target))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let base = program.signature(1).unwrap();
    assert_ne!(program.functions[1].signature, base);
    assert!(program.accepts(1, base));
    assert_eq!(program.table_targets(0, base).unwrap(), vec![1]);
    assert_eq!(program.reference_targets(base).unwrap(), vec![1]);
    assert_eq!(program.indirect_callers_of(1).unwrap(), vec![0]);
    assert_eq!(
        program
            .base_targets(
                0,
                Invocation::Indirect { table: 0, ty: 1 },
                Value::Constant(0)
            )
            .unwrap()
            .functions,
        vec![1]
    );
    let result = summarize(&program, Default::default()).unwrap();
    assert_eq!(
        result.functions[0],
        Summary {
            may_return: true,
            thrown: ALL_TAGS
        }
    );
    assert_eq!(result.unsupported, BTreeSet::from([1]));
}

#[test]
fn native_sink_includes_function_references_in_table_and_global_initializers() {
    for (text, table) in [
        (
            r#"(module (type $v (func)) (func $target) (elem declare func $target)
          (table 2 (ref $v) (ref.func $target))
          (func i32.const 0 call_indirect (type $v)))"#,
            true,
        ),
        (
            r#"(module (type $v (func))
          (func $caller global.get $g call_ref $v) (func $target)
          (global $g (ref $v) (ref.func $target)))"#,
            false,
        ),
    ] {
        let input = wat::parse_str(text).unwrap();
        let scan = scan(&input).unwrap();
        let mut store = FactsStore::empty(Default::default()).unwrap();
        let program = Program::build(&scan, &mut store, Default::default()).unwrap();
        let target = if table { 0 } else { 1 };
        let signature = program.signature(0).unwrap();
        assert!(program.functions[target].escaping);
        assert_eq!(
            program.reference_targets(signature).unwrap(),
            vec![target as u32]
        );
        if table {
            assert!(!program.constant_slots);
            assert_eq!(
                program.table_targets(0, signature).unwrap(),
                vec![target as u32]
            );
        }
        assert!(!program.has_external_dispatch());
        let result = summarize(&program, Default::default()).unwrap();
        assert!(result.functions.iter().all(|s| s.may_return));
    }
}

#[test]
fn native_sink_treats_unknown_reference_imports_and_element_expressions_as_external() {
    for text in [
        r#"(module (type $v (func)) (import "h" "table" (table 1 funcref))
          (func i32.const 0 call_indirect (type $v)))"#,
        r#"(module (type $v (func)) (import "h" "ref" (global $g (ref $v)))
          (func global.get $g call_ref $v))"#,
        r#"(module (type $v (func)) (import "h" "ref" (global $g funcref))
          (table 1 funcref) (elem (i32.const 0) funcref (global.get $g))
          (func i32.const 0 call_indirect (type $v)))"#,
    ] {
        let input = wat::parse_str(text).unwrap();
        let scan = scan(&input).unwrap();
        let mut store = FactsStore::empty(Default::default()).unwrap();
        let program = Program::build(&scan, &mut store, Default::default()).unwrap();
        assert!(program.has_external_dispatch());
        let result = summarize(&program, Default::default()).unwrap();
        assert_eq!(
            result.functions[0],
            Summary {
                may_return: true,
                thrown: ALL_TAGS
            }
        );
    }
}

#[test]
fn native_sink_does_not_clone_unused_trailing_local_declarations_into_states() {
    let input = wat::parse_str(format!(
        "(module (import \"h\" \"f\" (func $f)) (func (local {}) call $f))",
        "i32 ".repeat(40_000)
    ))
    .unwrap();
    let scan = scan(&input).unwrap();
    let body = scan.body_provider(Default::default()).load(1).unwrap();
    assert_eq!(body.locals.len(), 40_000);
    let sites = BTreeSet::from([body.calls[0].instruction]);
    let result = evaluate(
        &scan,
        &body,
        &mut Env,
        Options {
            record_states: Some(&sites),
            ..Default::default()
        },
        Limits {
            state_values: 256,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(result.states.values().all(|s| s.locals.is_empty()));
    assert!(!result.unsupported);
}

fn parameter_fixture(root: &str) -> Vec<u8> {
    wat::parse_str(format!(
        r#"(module (type $v (func)) (type $s (struct))
      (import "h" "take" (func $take (param i32))) (import "h" "work" (func $work))
      (memory 1) (table 2 funcref) (global $__stack_pointer (mut i32) (i32.const 128))
      (func $a) (func $b) (elem (i32.const 0) func $a $b)
      (func $dispatch (param i32) local.get 0 call_indirect (type $v))
      (func $forward (param i32) local.get 0 call $dispatch)
      {root})"#
    ))
    .unwrap()
}

fn named(scan: &Scan<'_>, name: &str) -> u32 {
    scan.functions
        .iter()
        .position(|f| f.name.as_deref() == Some(name))
        .unwrap() as u32
}

#[test]
fn native_parameter_proofs_follow_forwarders_and_distinguish_empty_from_unknown() {
    for (root, expected) in [
        (
            "(func $root (export \"run\") i32.const 1 call $forward)",
            Some(vec![3]),
        ),
        (
            "(func $root (export \"run\") i32.const 0 call $forward i32.const 1 call $forward)",
            Some(vec![2, 3]),
        ),
        (
            "(func $root (export \"run\") i32.const 99 call $forward)",
            Some(vec![]),
        ),
        (
            "(func $root (export \"run\") (param i32) local.get 0 call $forward)",
            None,
        ),
        (
            "(func $root (export \"run\") i32.const 0 i32.load call $forward)",
            None,
        ),
        (
            "(func $root (export \"run\") struct.new $s drop i32.const 1 call $forward)",
            None,
        ),
    ] {
        let input = parameter_fixture(root);
        let scan = scan(&input).unwrap();
        let dispatch = named(&scan, "dispatch");
        let mut store = FactsStore::empty(Default::default()).unwrap();
        let program = Program::build(&scan, &mut store, Default::default()).unwrap();
        assert!(program.parameter_targets(dispatch, 0).is_err());
        let report = program
            .record_parameter_values(Default::default(), Default::default(), Default::default())
            .unwrap();
        assert!(!report.skipped_mutable_slots);
        assert_eq!(
            program.parameter_targets(dispatch, 0).unwrap(),
            expected,
            "{root}"
        );
        assert_eq!(
            program
                .parameter_targets(named(&scan, "forward"), 0)
                .unwrap(),
            expected
        );
        assert!(program.parameter_targets(dispatch, 1).is_err());
    }
}

#[test]
fn native_parameter_proofs_include_handlers_and_rerun_escaping_frames() {
    for (root, expected, escaped) in [
        (
            "(func $root (export \"run\") try call $work catch_all i32.const 1 call $forward end)",
            Some(vec![3]),
            false,
        ),
        (
            "(func $root (export \"run\") global.get $__stack_pointer i32.const 1 i32.store global.get $__stack_pointer i32.load call $forward)",
            Some(vec![3]),
            false,
        ),
        (
            "(func $root (export \"run\") global.get $__stack_pointer call $take global.get $__stack_pointer i32.const 1 i32.store global.get $__stack_pointer i32.load call $forward)",
            None,
            true,
        ),
        (
            "(func $root (export \"run\") block $out try_table (catch_all $out) try call $work catch_all i32.const 1 call $forward end end end)",
            None,
            false,
        ),
    ] {
        let input = parameter_fixture(root);
        let scan = scan(&input).unwrap();
        let mut store = FactsStore::empty(Default::default()).unwrap();
        let program = Program::build(&scan, &mut store, Default::default()).unwrap();
        let report = program
            .record_parameter_values(Default::default(), Default::default(), Default::default())
            .unwrap();
        assert_eq!(
            program
                .parameter_targets(named(&scan, "dispatch"), 0)
                .unwrap(),
            expected,
            "{root}"
        );
        assert_eq!(report.evaluations > report.functions, escaped);
    }
}

#[test]
fn native_sink_does_not_prove_boundaries_through_unmodeled_delegation_or_nested_mixed_eh() {
    for (body, unsupported) in [
        ("try nop delegate 0", true),
        (
            "block $out try_table (catch_all $out) try nop catch_all nop end end end",
            true,
        ),
        (
            "try nop catch_all nop end block $out try_table (catch_all $out) nop end end",
            false,
        ),
    ] {
        let input = wat::parse_str(format!("(module (func {body}))")).unwrap();
        let scan = scan(&input).unwrap();
        let ir = scan.body_provider(Default::default()).load(0).unwrap();
        let result =
            evaluate(&scan, &ir, &mut Env, Default::default(), Default::default()).unwrap();
        assert_eq!(result.unsupported, unsupported, "{body}");
    }
}

#[test]
fn native_parameter_proofs_solve_closed_forwarding_cycles_without_nested_ir() {
    let input = wat::parse_str(
        r#"(module (func $a) (func $b) (table 2 funcref)
      (elem (i32.const 0) func $a $b)
      (func $f (param i32) local.get 0 call $g)
      (func $g (param i32) local.get 0 call $f)
      (func $root (export "run") i32.const 1 call $f))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let program = Program::build(&scan, &mut store, Default::default()).unwrap();
    program
        .record_parameter_values(Default::default(), Default::default(), Default::default())
        .unwrap();
    assert_eq!(
        program.parameter_targets(named(&scan, "f"), 0).unwrap(),
        Some(vec![1])
    );
    assert_eq!(
        program.parameter_targets(named(&scan, "g"), 0).unwrap(),
        Some(vec![1])
    );
}

#[test]
fn native_parameter_proofs_skip_mutable_slots_and_reject_partial_recording() {
    let input = parameter_fixture(
        "(func $root (export \"run\") ref.null func i32.const 0 table.grow 0 drop i32.const 1 call $forward)",
    );
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let report = program
        .record_parameter_values(
            IrLimits {
                instructions: 0,
                ..Default::default()
            },
            Default::default(),
            Default::default(),
        )
        .unwrap();
    assert!(report.skipped_mutable_slots);
    assert_eq!(report.functions, 0);
    assert_eq!(
        program
            .parameter_targets(named(&scan, "dispatch"), 0)
            .unwrap(),
        None
    );
    drop(program);
    let input = parameter_fixture("(func $root (export \"run\") i32.const 1 call $forward)");
    let scan = streaming::scan(&input).unwrap();
    let program = Program::build(&scan, &mut store, Default::default()).unwrap();
    assert!(
        program
            .record_parameter_values(
                Default::default(),
                Default::default(),
                ParameterLimits { work: 0 }
            )
            .is_err()
    );
    assert!(
        program
            .parameter_targets(named(&scan, "dispatch"), 0)
            .is_err()
    );
    program
        .record_parameter_values(Default::default(), Default::default(), Default::default())
        .unwrap();
    assert_eq!(
        program
            .parameter_targets(named(&scan, "dispatch"), 0)
            .unwrap(),
        Some(vec![3])
    );
}

// These policy fixtures represent original SDK output, before any optimizer
// can inline registry writers. A verified facts section admits source-shape
// rules; final-Wasm fixtures deliberately use an empty store instead.
fn original_policy_input(mut input: Vec<u8>) -> Vec<u8> {
    use fork_instrument::facts;
    use wasm_encoder::Encode;
    let hash = facts::code_sha256(&input).unwrap();
    for (name, data) in [
        (
            facts::SECTION,
            b"#kandelo-calltypes\t5\nM\tpolicy-fixture.c\n".as_slice(),
        ),
        (facts::CODE_HASH_SECTION, hash.as_slice()),
    ] {
        input.push(0);
        wasm_encoder::CustomSection {
            name: name.into(),
            data: data.into(),
        }
        .encode(&mut input);
    }
    input
}

#[test]
fn native_registry_policy_unions_atfork_callbacks_and_preserves_literal_slot_priority() {
    let input = wat::parse_str(r#"(module (type $v (func)) (table 3 funcref)
      (func $a) (func $b) (func $other) (elem (i32.const 0) func $a $b $other)
      (func $pthread_atfork (param i32 i32 i32))
      (func $__fork_handler (param i32) local.get 0 call_indirect (type $v))
      (func $root (export "run") (param i32)
        i32.const 0 i32.const 1 i32.const 1 call $pthread_atfork local.get 0 call $__fork_handler))"#).unwrap();
    let input = original_policy_input(input);
    let scan = scan(&input).unwrap();
    let hub = named(&scan, "__fork_handler");
    let mut store = FactsStore::from_scan(&scan, Default::default()).unwrap();
    store.resolve_calls(&scan, Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let key = program.signature(0).unwrap();
    let plan = PolicyPlan::build(&mut program, Default::default(), Default::default()).unwrap();
    assert_eq!(plan.override_targets(hub, key).unwrap(), Some(vec![0, 1]));
    let point = ProgramPoint {
        function: hub,
        offset: 0,
    };
    let invocation = Invocation::Indirect { table: 0, ty: 0 };
    assert_eq!(
        plan.resolve(point, invocation, Value::Unknown, false)
            .unwrap()
            .functions,
        vec![0, 1]
    );
    assert_eq!(
        plan.resolve(point, invocation, Value::Constant(2), false)
            .unwrap()
            .functions,
        vec![2]
    );
}

#[test]
fn native_registry_policy_keeps_unknown_atexit_slots_conservative() {
    for mutable in [false, true] {
        let mutate = if mutable {
            "(func ref.null func i32.const 0 table.grow 0 drop)"
        } else {
            ""
        };
        let input = wat::parse_str(format!(
            r#"(module (type $v (func)) (type $d (func (param i32))) (table 3 funcref)
          (func $call (param i32) local.get 0 call_indirect (type $v))
          (func $a) (func $b) (elem (i32.const 0) func $call $a $b)
          (func $atexit (param i32) i32.const 0 drop)
          (func $__funcs_on_exit (param i32) local.get 0 i32.const 0 call_indirect (type $d))
          (func $root (export "run") i32.const 1 call $atexit) {mutate})"#
        ))
        .unwrap();
        let input = original_policy_input(input);
        let scan = scan(&input).unwrap();
        let hub = named(&scan, "__funcs_on_exit");
        let mut store = FactsStore::from_scan(&scan, Default::default()).unwrap();
        store.resolve_calls(&scan, Default::default()).unwrap();
        let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
        let (void, dtor) = (program.signature(0).unwrap(), program.signature(1).unwrap());
        let plan = PolicyPlan::build(&mut program, Default::default(), Default::default()).unwrap();
        assert_eq!(
            plan.override_targets(hub, dtor).unwrap(),
            if mutable { None } else { Some(vec![0]) }
        );
        assert_eq!(
            plan.override_targets(0, void).unwrap(),
            if mutable { None } else { Some(vec![1]) }
        );
    }
}

#[test]
fn native_cancellation_policy_requires_absence_of_local_writers() {
    for (writer, cut) in [
        ("", true),
        ("(func $pthread_cancel)", false),
        ("(func $timer_create)", false),
        ("(import \"h\" \"writer\" (func $pthread_cancel))", true),
    ] {
        let input = wat::parse_str(format!(
            "(module {writer} (func $__testcancel call $pthread_exit) (func $pthread_exit))"
        ))
        .unwrap();
        let input = original_policy_input(input);
        let scan = scan(&input).unwrap();
        let (caller, callee) = (named(&scan, "__testcancel"), named(&scan, "pthread_exit"));
        let mut store = FactsStore::from_scan(&scan, Default::default()).unwrap();
        store.resolve_calls(&scan, Default::default()).unwrap();
        let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
        let plan = PolicyPlan::build(&mut program, Default::default(), Default::default()).unwrap();
        assert_eq!(plan.cancel_cut(caller, callee), cut, "{writer}");
        let selected = plan
            .resolve(
                ProgramPoint {
                    function: caller,
                    offset: 0,
                },
                Invocation::Direct(callee),
                Value::Unknown,
                false,
            )
            .unwrap();
        assert_eq!(selected.cut, cut);
        assert_eq!(selected.functions, if cut { vec![] } else { vec![callee] });
    }
}

#[test]
fn native_signal_policy_records_required_gates_and_excludes_tail_dispatch() {
    use fork_instrument::sink::{SignalPolicy, SinkPolicy};
    let input = wat::parse_str(
        r#"(module (type $h (func (param i32))) (table 2 funcref)
      (func $a (param i32)) (func $b (param i32)) (elem (i32.const 0) func $a $b)
      (func $__do_syscall_impl (param i32) i32.const 7 local.get 0 call_indirect (type $h)))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let caller = named(&scan, "__do_syscall_impl");
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    for policy in [SignalPolicy::Gate, SignalPolicy::Strict] {
        let plan = PolicyPlan::build(
            &mut program,
            SinkPolicy { signal: policy },
            Default::default(),
        )
        .unwrap();
        let point = ProgramPoint {
            function: caller,
            offset: 0,
        };
        let invocation = Invocation::Indirect { table: 0, ty: 0 };
        let normal = plan
            .resolve(point, invocation, Value::Unknown, false)
            .unwrap();
        assert_eq!(
            normal.functions,
            if policy == SignalPolicy::Gate {
                vec![u32::MAX]
            } else {
                vec![0, 1]
            }
        );
        assert_eq!(
            plan.resolve(point, invocation, Value::Unknown, true)
                .unwrap()
                .functions,
            vec![0, 1]
        );
        assert_eq!(
            plan.required_signal_gates().collect::<Vec<_>>(),
            if policy == SignalPolicy::Gate {
                vec![caller]
            } else {
                vec![]
            }
        );
    }
}

#[test]
fn native_cleanup_policy_keeps_per_caller_handlers_and_empty_groups_on_disk() {
    use fork_instrument::facts;
    use wasm_encoder::Encode;
    let mut input = wat::parse_str(
        r#"(module (type $v (func)) (table 2 funcref)
      (func $a) (func $b) (elem (i32.const 0) func $a $b)
      (func $_pthread_cleanup_pop i32.const 0 call_indirect (type $v))
      (func $first call $_pthread_cleanup_pop) (func $second call $_pthread_cleanup_pop)
      (func $empty call $_pthread_cleanup_pop))"#,
    )
    .unwrap();
    let hash = facts::code_sha256(&input).unwrap();
    let text = "#kandelo-calltypes\t5\nF\ta\t0\nT\ta\tA\nD\ta\t0\t0\nF\tb\t0\nT\tb\tA\nD\tb\t0\t0\nF\t_pthread_cleanup_pop\t0\nS\t_pthread_cleanup_pop\t0\t->\ticall\tA\nD\t_pthread_cleanup_pop\t1\t1\nF\tfirst\t0\nR\tcleanup\ta\nC\tfirst\t0\t_pthread_cleanup_pop\nD\tfirst\t0\t1\nF\tsecond\t0\nR\tcleanup\tb\nC\tsecond\t0\t_pthread_cleanup_pop\nD\tsecond\t0\t1\nF\tempty\t0\nC\tempty\t0\t_pthread_cleanup_pop\nD\tempty\t0\t1\n";
    for (name, data) in [
        (facts::SECTION, text.as_bytes()),
        (facts::CODE_HASH_SECTION, hash.as_slice()),
    ] {
        input.push(0);
        wasm_encoder::CustomSection {
            name: name.into(),
            data: data.into(),
        }
        .encode(&mut input);
    }
    let scan = scan(&input).unwrap();
    let pop = named(&scan, "_pthread_cleanup_pop");
    let mut store = FactsStore::from_scan(&scan, Default::default()).unwrap();
    store.resolve_calls(&scan, Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let plan = PolicyPlan::build(&mut program, Default::default(), Default::default()).unwrap();
    for (name, expected) in [
        ("first", vec![0, u32::MAX]),
        ("second", vec![1, u32::MAX]),
        ("empty", vec![u32::MAX]),
    ] {
        let targets = plan
            .resolve(
                ProgramPoint {
                    function: named(&scan, name),
                    offset: 0,
                },
                Invocation::Direct(pop),
                Value::Unknown,
                false,
            )
            .unwrap();
        assert_eq!(targets.functions, expected);
        assert!(!targets.external);
        assert!(!targets.cut);
    }
}

fn jmp_fixture(text: &str, tags: usize) -> Vec<u8> {
    use fork_instrument::facts;
    use wasm_encoder::Encode;
    let tags = "(tag (param i32))".repeat(tags);
    let mut input = wat::parse_str(format!(
        r#"(module {tags}
      (func $__wasm_longjmp (param i32) local.get 0 throw 0)
      (func $longjmp (param i32) local.get 0 call $__wasm_longjmp)
      (func $setA (param i32) local.get 0 call $__wasm_longjmp)
      (func $setB (param i32) local.get 0 call $__wasm_longjmp)
      (func $jumpA (param i32) local.get 0 call $longjmp)
      (func $jumpB (param i32) local.get 0 call $longjmp)
      (func $unknown (param i32) local.get 0 call $longjmp))"#
    ))
    .unwrap();
    let hash = facts::code_sha256(&input).unwrap();
    for (name, data) in [
        (facts::SECTION, text.as_bytes()),
        (facts::CODE_HASH_SECTION, hash.as_slice()),
    ] {
        input.push(0);
        wasm_encoder::CustomSection {
            name: name.into(),
            data: data.into(),
        }
        .encode(&mut input);
    }
    input
}

#[test]
fn native_jmp_policy_preserves_buffer_identity_and_unknown_external_origins() {
    let text = "#kandelo-calltypes\t5\nJS\tsetA\tA\nJS\tsetB\tB\nJL\tjumpA\tA\nJL\tjumpB\tB\nJL\tunknown\t*\n";
    let input = jmp_fixture(text, 1);
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::from_scan(&scan, Default::default()).unwrap();
    store.resolve_calls(&scan, Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let plan = PolicyPlan::build(&mut program, Default::default(), Default::default()).unwrap();
    let (a, b) = (1u64 << 40, 1u64 << 41);
    let longjmp = [named(&scan, "longjmp")];
    assert!(plan.supports_tag_masks());
    assert_eq!(plan.catch_bits(named(&scan, "setA"), 0), 1 | a);
    assert_eq!(plan.catch_bits(named(&scan, "setB"), 0), 1 | b);
    assert_eq!(
        plan.remap_longjmp(named(&scan, "jumpA"), &longjmp, false, 1),
        a
    );
    assert_eq!(
        plan.remap_longjmp(named(&scan, "jumpB"), &longjmp, false, 1),
        b
    );
    assert_eq!(
        plan.remap_longjmp(named(&scan, "unknown"), &longjmp, false, 1),
        1
    );
    assert_eq!(
        plan.remap_longjmp(named(&scan, "setA"), &longjmp, false, 1),
        1 | a | b
    );
    assert_eq!(
        plan.remap_longjmp(named(&scan, "jumpA"), &longjmp, true, 1),
        1
    );
    assert_eq!(
        plan.remap_longjmp(named(&scan, "jumpA"), &[u32::MAX], false, 1),
        1
    );
}

#[test]
fn native_jmp_policy_limits_named_bits_and_declines_colliding_tag_budgets() {
    let mut text = String::from("#kandelo-calltypes\t5\n");
    for i in 0..22 {
        text.push_str(&format!("JL\tjumpA\tbuffer{i}\n"));
    }
    text.push_str("JS\tsetA\toverflow\nJL\tjumpB\toverflow\n");
    for tags in [1, 41] {
        let input = jmp_fixture(&text, tags);
        let scan = scan(&input).unwrap();
        let mut store = FactsStore::from_scan(&scan, Default::default()).unwrap();
        store.resolve_calls(&scan, Default::default()).unwrap();
        let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
        let plan = PolicyPlan::build(&mut program, Default::default(), Default::default()).unwrap();
        assert_eq!(plan.supports_tag_masks(), tags == 1);
        assert_eq!(plan.catch_bits(named(&scan, "setA"), 0), 1);
        assert_eq!(
            plan.remap_longjmp(named(&scan, "jumpB"), &[named(&scan, "longjmp")], false, 1),
            1
        );
    }
}

#[test]
fn native_policy_interpreter_specializes_constants_with_a_bounded_per_root_cache() {
    let input = wat::parse_str(
        r#"(module
      (func $add (param i32) (result i32) local.get 0 i32.const 1 i32.add)
      (func $one (result i32) i32.const 41 call $add)
      (func $two (result i32) i32.const 40 call $add i32.const 1 call $add i32.add))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let plan = PolicyPlan::build(&mut program, Default::default(), Default::default()).unwrap();
    for cache in [0, 1, 224, 4 * 1024 * 1024] {
        let mut interpreter = SinkInterpreter::new(
            &plan,
            InterpreterLimits {
                specialization_cache_bytes: Some(cache),
                ..Default::default()
            },
        )
        .unwrap();
        let summaries = interpreter.normal_summaries(Default::default()).unwrap();
        let body = scan
            .body_provider(Default::default())
            .load(named(&scan, "one"))
            .unwrap();
        let base = interpreter
            .evaluate(
                &body,
                &summaries.functions,
                Default::default(),
                false,
                SummaryLimits::default().work,
            )
            .unwrap();
        assert_eq!(base.returned, Some(Value::Unknown));
        let specialized = interpreter
            .evaluate(
                &body,
                &summaries.functions,
                Default::default(),
                true,
                SummaryLimits::default().work,
            )
            .unwrap();
        assert_eq!(specialized.returned, Some(Value::Constant(42)));
        assert!(specialized.work_steps > base.work_steps);
        let body = scan
            .body_provider(Default::default())
            .load(named(&scan, "two"))
            .unwrap();
        assert_eq!(
            interpreter
                .evaluate(
                    &body,
                    &summaries.functions,
                    Default::default(),
                    true,
                    SummaryLimits::default().work
                )
                .unwrap()
                .returned,
            Some(Value::Constant(43))
        );
    }
}

#[test]
fn native_policy_interpreter_never_specializes_past_unknown_side_targets() {
    let input = wat::parse_str(
        r#"(module (type $t (func (param i32) (result i32)))
      (import "env" "__wasm_dlsym" (func $unused))
      (func $target (type $t) i32.const 42) (table 1 funcref) (elem (i32.const 0) func $target)
      (func $unknown (param i32) (result i32) i32.const 7 local.get 0 call_indirect (type $t))
      (func $literal (result i32) i32.const 7 i32.const 0 call_indirect (type $t)))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let plan = PolicyPlan::build(&mut program, Default::default(), Default::default()).unwrap();
    let mut interpreter = SinkInterpreter::new(&plan, Default::default()).unwrap();
    let summaries = interpreter.normal_summaries(Default::default()).unwrap();
    let body = scan
        .body_provider(Default::default())
        .load(named(&scan, "unknown"))
        .unwrap();
    let result = interpreter
        .evaluate(
            &body,
            &summaries.functions,
            Default::default(),
            true,
            SummaryLimits::default().work,
        )
        .unwrap();
    assert_eq!(
        (result.returned, result.thrown),
        (Some(Value::Unknown), ALL_TAGS)
    );
    // A dynamic loader can replace even a literal slot; static initialization
    // is not proof that only the local target can return or throw.
    let body = scan
        .body_provider(Default::default())
        .load(named(&scan, "literal"))
        .unwrap();
    let result = interpreter
        .evaluate(
            &body,
            &summaries.functions,
            Default::default(),
            true,
            SummaryLimits::default().work,
        )
        .unwrap();
    assert_eq!(
        (result.returned, result.thrown),
        (Some(Value::Unknown), ALL_TAGS)
    );
}

#[test]
fn native_policy_interpreter_keeps_frame_escape_flags_across_summary_revisions() {
    let input = wat::parse_str(
        r#"(module (import "h" "take" (func $take (param i32)))
      (global $__stack_pointer (mut i32) (i32.const 128))
      (func $f global.get $__stack_pointer call $take))"#,
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let plan = PolicyPlan::build(&mut program, Default::default(), Default::default()).unwrap();
    let mut interpreter = SinkInterpreter::new(&plan, Default::default()).unwrap();
    for _ in 0..2 {
        let summaries = interpreter.normal_summaries(Default::default()).unwrap();
        assert_eq!(summaries.frame_escaped, vec![false, true]);
    }
}

#[test]
fn native_policy_interpreter_enforces_depth_work_and_catalog_limits() {
    let input = wat::parse_str("(module (func $f))").unwrap();
    let scan = scan(&input).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let plan = PolicyPlan::build(&mut program, Default::default(), Default::default()).unwrap();
    assert!(
        SinkInterpreter::new(
            &plan,
            InterpreterLimits {
                specialization_depth: 4,
                ..Default::default()
            }
        )
        .is_err()
    );
    let mut interpreter = SinkInterpreter::new(&plan, Default::default()).unwrap();
    let summaries = interpreter.normal_summaries(Default::default()).unwrap();
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    assert!(
        interpreter
            .evaluate(&body, &[], Default::default(), true, 1)
            .unwrap_err()
            .to_string()
            .contains("catalog mismatch")
    );
    assert!(
        interpreter
            .evaluate(&body, &summaries.functions, Default::default(), true, 0)
            .unwrap_err()
            .to_string()
            .contains("work budget")
    );
}

#[test]
fn native_sink_records_and_probes_control_construct_exit_states() {
    let input = wat::parse_str(
        "(module (func (result i32) block (result i32) i32.const 9 end i32.const 1 i32.add))",
    )
    .unwrap();
    let scan = scan(&input).unwrap();
    let body = scan.body_provider(Default::default()).load(0).unwrap();
    let opener = body.regions[1].opener.unwrap();
    let selected = BTreeSet::from([opener]);
    let normal = evaluate(
        &scan,
        &body,
        &mut Env,
        Options {
            record_states: Some(&selected),
            ..Default::default()
        },
        Default::default(),
    )
    .unwrap();
    assert_eq!(normal.states[&opener].stack, vec![Value::Constant(9)]);
    let injections = BTreeMap::from([(
        opener,
        Injection {
            returned: None,
            thrown: 0,
            payload: Some(vec![Value::Constant(41)]),
        },
    )]);
    let child = evaluate(
        &scan,
        &body,
        &mut Env,
        Options {
            child: true,
            injections: Some(&injections),
            normal_states: Some(&normal.states),
            ..Default::default()
        },
        Default::default(),
    )
    .unwrap();
    assert_eq!(child.returned, Some(Value::Constant(42)));
}
