#[path = "support/snapshot.rs"]
mod snapshot;
use std::collections::BTreeSet;

use fork_instrument::streaming::*;

fn compare(wat: &str) -> Vec<ReferenceAnalysis> {
    let bytes = wat::parse_str(wat).unwrap();
    let scan = scan(&bytes).unwrap();
    let bodies: Vec<_> = FunctionBodies::new(&bytes, IrLimits::default())
        .map(Result::unwrap)
        .collect();
    let targets: BTreeSet<_> = (0..scan.functions.len() as u32).collect();
    let analyses: Vec<_> = bodies
        .iter()
        .map(|body| analyze_references(&scan, body, &targets, ReferenceLimits::default()).unwrap())
        .collect();
    snapshot::check(&bytes, "references", &analyses);
    analyses
}

#[test]
fn reference_values_loops_and_null_tests_preserve_liveness() {
    compare(
        r#"(module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (func (param $value externref) (param $condition i32) (local $merged externref)
        local.get $condition if local.get $value local.set $merged end
        local.get $merged ref.is_null if call $fork drop end
        loop $again call $fork drop local.get $value ref.is_null br_if $again end)
      (func (local $x externref) ref.null extern nop local.set $x call $fork drop local.get $x drop)
      (func (param $value externref)
        block $null local.get $value br_on_null $null drop call $fork drop end)
      (func (param $value externref)
        block $nonnull (result externref) local.get $value br_on_non_null $nonnull
          call $fork drop ref.null extern end drop))"#,
    );
}

#[test]
fn modern_and_legacy_exception_liveness_preserve_handler_rethrow_liveness() {
    let analyses = compare(
        r#"(module
      (func $candidate)
      (tag $a) (tag $b)
      (func (param $value externref)
        block $done block $handler
          try_table (catch_all $handler) call $candidate br $done end
        end local.get $value drop end)
      (func (param $outer externref) (param $inner externref)
        try
          try call $candidate catch $a call $candidate rethrow 0
          catch_all local.get $inner drop end
        catch_all local.get $outer drop end)
      (func (local $scratch exnref)
        block $caught (result exnref)
          try_table (result exnref) (catch_all_ref $caught)
            call $candidate ref.null exn end
        end local.set $scratch local.get $scratch throw_ref))"#,
    );
    let call = &analyses[1].landings[0];
    assert!(call.live_on_normal_return.is_empty());
    assert_eq!(call.live_on_any_successor, BTreeSet::from([0]));
    let handler_call = &analyses[2].landings[1];
    assert_eq!(handler_call.live_on_any_successor, BTreeSet::from([0]));
}

#[test]
fn typed_reference_arguments_results_and_carryovers_match() {
    compare(
        r#"(module
      (type $pair (struct (field i32)))
      (type $holder (struct (field (ref null $pair))))
      (type $takes (func (param externref) (result externref)))
      (func $takes (type $takes) local.get 0)
      (elem declare func $takes)
      (table 1 funcref)
      (func $fork (result i32) i32.const 0)
      (func (param $holder (ref $holder))
        local.get $holder struct.get $holder 0 call $fork drop drop
        i32.const 4 struct.new $pair call $fork drop drop
        ref.null extern i32.const 0 call_indirect (type $takes) drop
        ref.null extern ref.func $takes call_ref $takes drop))"#,
    );
}

#[test]
fn unreachable_nested_code_and_tail_calls_do_not_create_landings() {
    let analyses = compare(
        r#"(module
      (func $candidate)
      (func return_call $candidate block call $candidate end call $candidate)
      (func return block call $candidate end))"#,
    );
    assert!(analyses.iter().all(|a| a.landings.is_empty()));
}

#[test]
fn liveness_uses_multiple_bitset_words_and_ignores_unused_locals() {
    let params = "(param externref)".repeat(130);
    let wat = format!(
        "(module (func $fork) (func {params} (local externref) call $fork local.get 129 drop local.get 64 drop local.get 0 drop))"
    );
    let analyses = compare(&wat);
    assert_eq!(analyses[1].locals.len(), 130);
    assert_eq!(
        analyses[1].landings[0].live_on_normal_return,
        BTreeSet::from([0, 64, 129])
    );
}

#[test]
fn reference_analysis_rejects_bounded_resources_without_unbounded_fallback() {
    let bytes = wat::parse_str(
        "(module (func $fork) (func (param externref) call $fork local.get 0 drop))",
    )
    .unwrap();
    let scan = scan(&bytes).unwrap();
    let body = FunctionBodies::new(&bytes, IrLimits::default())
        .nth(1)
        .unwrap()
        .unwrap();
    for limits in [
        ReferenceLimits {
            state_words: 0,
            ..Default::default()
        },
        ReferenceLimits {
            edges: 0,
            ..Default::default()
        },
        ReferenceLimits {
            work: 0,
            ..Default::default()
        },
        ReferenceLimits {
            landing_values: 0,
            ..Default::default()
        },
    ] {
        let error = analyze_references(&scan, &body, &BTreeSet::from([0]), limits).unwrap_err();
        assert!(error.to_string().contains("budget"), "{error:#}");
    }
}
