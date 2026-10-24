use std::collections::BTreeSet;

use fork_instrument::{call_graph, facts::storage::FactsStore, sink, streaming};
use streaming::sink::{NativeSinkPlan, Program, SinkLimits, plan_sinks};

fn compare(text: &str) -> NativeSinkPlan {
    compare_policy(text, Default::default())
}

fn compare_policy(text: &str, policy: sink::SinkPolicy) -> NativeSinkPlan {
    let bytes = wat::parse_str(text).unwrap();
    let scan = streaming::scan(&bytes).unwrap();
    let seed = scan
        .functions
        .iter()
        .position(|f| {
            f.import
                .as_ref()
                .is_some_and(|(m, n)| m == "kernel" && n == "kernel_fork")
        })
        .unwrap() as u32;
    let today = scan.reaching_from_seeds([seed], false).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    let native = plan_sinks(&mut program, seed, &today, policy, Default::default())
        .unwrap()
        .expect("native plan");
    let module = walrus::ModuleConfig::new().parse(&bytes).unwrap();
    let old_seed = call_graph::find_import_func(&module, "kernel.kernel_fork").unwrap();
    let old_today = call_graph::analyze_reaching_closure(&module, old_seed);
    let old = sink::plan(&module, old_seed, &old_today, policy).expect("oracle plan");
    let indices = |set: Vec<walrus::FunctionId>| -> BTreeSet<u32> {
        set.into_iter().map(|f| f.index() as u32).collect()
    };
    assert_eq!(
        native.activations,
        indices(old.activations.into_iter().collect()),
        "activations: {text}"
    );
    assert_eq!(
        native.control_reachable,
        indices(old.control_reachable.into_iter().collect()),
        "control: {text}"
    );
    assert_eq!(
        native.boundaries,
        indices(old.boundaries.into_iter().collect()),
        "boundaries: {text}"
    );
    assert_eq!(
        native.fork_returning,
        indices(old.fork_returning.into_iter().collect()),
        "returning: {text}"
    );
    native
}

#[test]
fn native_sink_plans_match_the_oracle_for_indirect_and_reference_targets() {
    for dispatch in [
        "local.get 0 call_indirect (type $t)",
        "i32.const 0 call_indirect (type $t)",
        "ref.func $fork call_ref $t",
        "local.get 0 return_call_indirect (type $t)",
        "ref.func $fork return_call_ref $t",
    ] {
        compare(&format!(
            r#"(module
          (type $t (func (result i32)))
          (import "kernel" "kernel_fork" (func $seed (param i32) (result i32)))
          (table 2 funcref) (elem (i32.const 0) $fork $other)
          (func $fork (type $t) i32.const 0 call $seed)
          (func $other (type $t) i32.const 17)
          (func $dispatch (param i32) (result i32) {dispatch})
          (func (export "root") (param i32) local.get 0 call $dispatch drop))"#
        ));
    }
}

#[test]
fn native_sink_plans_match_signal_policy_and_record_required_guards() {
    let text = r#"(module
      (type $handler (func (param i32)))
      (import "kernel" "kernel_fork" (func $seed (param i32) (result i32)))
      (table 1 funcref) (elem (i32.const 0) $handler)
      (func $handler (param i32) i32.const 0 call $seed drop)
      (func $__deliver_pending_signal i32.const 1 i32.const 0 call_indirect (type $handler))
      (func $root (export "root") call $__deliver_pending_signal))"#;
    let strict = compare(text);
    let gated = compare_policy(
        text,
        sink::SinkPolicy {
            signal: sink::SignalPolicy::Gate,
        },
    );
    assert!(strict.required_signal_gates.is_empty());
    assert_eq!(gated.required_signal_gates, BTreeSet::from([2]));
    assert!(gated.activations.contains(&2));
}

#[test]
fn native_sink_planner_keeps_unresolved_external_dispatch_open() {
    let bytes = wat::parse_str(
        r#"(module
      (type $t (func (result i32)))
      (import "kernel" "kernel_fork" (func $seed (param i32) (result i32)))
      (import "env" "table" (table 1 funcref))
      (func $spawn (result i32) (local i32)
        i32.const 0 call_indirect (type $t) local.set 0
        local.get 0 i32.eqz if unreachable end local.get 0)
      (func $root (export "root") call $spawn drop))"#,
    )
    .unwrap();
    let scan = streaming::scan(&bytes).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    assert!(program.has_external_dispatch());
    let today = scan.reaching_from_seeds([0], true).unwrap();
    let plan = plan_sinks(
        &mut program,
        0,
        &today,
        Default::default(),
        Default::default(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(plan.activations, BTreeSet::from([0, 1, 2]));
    assert_eq!(plan.fork_returning, BTreeSet::from([1, 2]));
    assert!(plan.boundaries.is_empty());
}

#[test]
fn native_sink_planner_declines_unsupported_normalization_without_a_partial_proof() {
    for extra in [
        r#"(import "env" "__wasm_longjmp" (func))"#.to_owned(),
        r#"(import "env" "__wasm_dlopen" (func))"#.to_owned(),
        "(tag)".repeat(63),
    ] {
        let bytes = wat::parse_str(format!(
            r#"(module
          (import "kernel" "kernel_fork" (func $seed (param i32) (result i32)))
          {extra} (func i32.const 0 call $seed drop))"#
        ))
        .unwrap();
        let scan = streaming::scan(&bytes).unwrap();
        let today = scan.reaching_from_seeds([0], true).unwrap();
        let mut store = FactsStore::empty(Default::default()).unwrap();
        let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
        assert!(
            plan_sinks(
                &mut program,
                0,
                &today,
                Default::default(),
                Default::default()
            )
            .unwrap()
            .is_none()
        );
    }
}

const HEADER: &str = r#"(module
  (import "kernel" "kernel_fork" (func $seed (param i32) (result i32)))
  (memory 2) (global $__stack_pointer (mut i32) (i32.const 65536))
  (tag $t (param i32))
  (func $_exit (param i32) (loop br 0))
"#;

#[test]
fn native_sink_plans_match_the_oracle_for_child_returns_and_vfork() {
    for mode in [0, 1] {
        for body in [
            "call $fork",
            "call $fork local.set 0 local.get 0 i32.eqz if i32.const 127 call $_exit end local.get 0",
            "call $fork local.set 0 local.get 0 i32.eqz if loop br 0 end end local.get 0",
            "call $fork local.set 0 local.get 0 i32.eqz if i32.const 1 throw $t end local.get 0",
        ] {
            let text = format!(
                "{HEADER}
              (func $fork (result i32) i32.const {mode} call $seed)
              (func $spawn (result i32) (local i32) {body})
              (func $root (export \"_start\") call $spawn drop))"
            );
            let plan = compare(&text);
            if mode == 1 {
                assert_eq!(plan.boundaries, BTreeSet::from([3]));
                assert!(!plan.activations.contains(&4));
            }
        }
    }
}

#[test]
fn native_sink_plans_match_the_oracle_for_tail_paths() {
    for call in ["call $fork", "return_call $fork"] {
        for edge in ["call $tail", "return_call $tail"] {
            compare(&format!(
                "{HEADER}
              (func $fork (result i32) i32.const 0 call $seed)
              (func $tail (result i32) {call})
              (func $spawn (result i32) {edge})
              (func $root (export \"_start\") call $spawn drop))"
            ));
        }
    }
}

#[test]
fn native_sink_plans_match_the_oracle_for_frame_escapes() {
    for middle in ["call $noise", "local.get 0 call $clobber"] {
        compare(&format!(
            "{HEADER}
          (func $noise)
          (func $clobber (param i32) local.get 0 i32.const 1 i32.store offset=8)
          (func $fork (result i32) i32.const 0 call $seed)
          (func $spawn (result i32) (local i32)
            global.get $__stack_pointer i32.const 16 i32.sub local.tee 0 global.set $__stack_pointer
            local.get 0 call $fork i32.store offset=8
            {middle}
            local.get 0 i32.load offset=8 i32.eqz if i32.const 1 call $_exit end
            local.get 0 i32.load offset=8)
          (func $root (export \"_start\") call $spawn drop))"
        ));
    }
}

#[test]
fn native_sink_plans_match_the_oracle_for_caught_and_rethrown_exceptions() {
    for handler in [
        "drop i32.const 42",
        "throw $t",
        "drop i32.const 1 call $_exit unreachable",
    ] {
        compare(&format!(
            "{HEADER}
          (func $fork (result i32) i32.const 0 call $seed)
          (func $spawn (result i32) (local i32)
            call $fork local.tee 0 i32.eqz if i32.const 9 throw $t end local.get 0)
          (func $root (export \"_start\") (result i32)
            block $handler (result i32)
              try_table (result i32) (catch $t $handler) call $spawn end
              return
            end {handler}))"
        ));
    }
}

#[test]
fn native_sink_planner_resource_failures_do_not_publish_partial_plans() {
    let bytes = wat::parse_str(format!("{HEADER} (func i32.const 0 call $seed drop))")).unwrap();
    let scan = streaming::scan(&bytes).unwrap();
    let today = scan.reaching_from_seeds([0], false).unwrap();
    let mut store = FactsStore::empty(Default::default()).unwrap();
    let mut program = Program::build(&scan, &mut store, Default::default()).unwrap();
    for limits in [
        SinkLimits {
            work: 0,
            ..Default::default()
        },
        SinkLimits {
            metadata_bytes: 0,
            ..Default::default()
        },
        SinkLimits {
            evaluations_per_function: 0,
            ..Default::default()
        },
    ] {
        assert!(plan_sinks(&mut program, 0, &today, Default::default(), limits).is_err());
    }
    assert!(
        plan_sinks(
            &mut program,
            0,
            &today,
            Default::default(),
            Default::default()
        )
        .unwrap()
        .is_some()
    );
}
