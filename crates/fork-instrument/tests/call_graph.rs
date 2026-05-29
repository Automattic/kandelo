//! Tests for Phase 2: direct-call graph discovery.
//!
//! Each fixture is a small WAT module whose structure lets us assert
//! exactly which functions should be reported as reaching the
//! `kernel.kernel_fork` import through direct calls.

use fork_instrument::{analyze, Options};
use std::collections::HashSet;

fn discover(wat_src: &str) -> HashSet<String> {
    discover_with_options(wat_src, &Options::default())
}

fn discover_with_options(wat_src: &str, opts: &Options) -> HashSet<String> {
    let bytes = wat::parse_str(wat_src).expect("wat parse");
    let analysis = analyze(&bytes, opts).expect("analyze");
    analysis
        .fork_path
        .iter()
        .map(|e| e.name.clone())
        .collect()
}

#[test]
fn seed_alone_when_nothing_calls_fork() {
    // No function in the module calls $fork. The result should just be
    // the seed import itself.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $a (result i32)
            i32.const 0)
          (func $b (result i32)
            call $a))
    "#;
    let found = discover(wat);
    // Only the seed should be reported: nothing else reaches it.
    assert_eq!(found.len(), 1, "expected seed alone; got {found:?}");
}

#[test]
fn direct_caller_included() {
    // $a calls $fork directly; nothing calls $a. Result: {$fork, $a}.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $a (export "a") (result i32)
            call $fork))
    "#;
    let found = discover(wat);
    assert_eq!(
        found.len(),
        2,
        "expected seed + one direct caller, got {found:?}"
    );
    assert!(found.iter().any(|n| n == "a"));
}

#[test]
fn transitive_chain() {
    // main -> middle -> leaf -> fork. All four should be reported.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $leaf (export "leaf") (result i32)
            call $fork)
          (func $middle (export "middle") (result i32)
            call $leaf)
          (func $main (export "main") (result i32)
            call $middle))
    "#;
    let found = discover(wat);
    assert_eq!(found.len(), 4, "got {found:?}");
    for name in ["leaf", "middle", "main"] {
        assert!(found.iter().any(|n| n == name), "missing {name}");
    }
}

#[test]
fn unrelated_function_excluded() {
    // $a reaches fork; $unrelated does not. Only $a and fork reported.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $a (export "a") (result i32)
            call $fork)
          (func $unrelated (export "unrelated") (result i32)
            i32.const 42))
    "#;
    let found = discover(wat);
    assert_eq!(found.len(), 2, "got {found:?}");
    assert!(found.iter().any(|n| n == "a"));
    assert!(!found.iter().any(|n| n == "unrelated"));
}

#[test]
fn diamond_shape() {
    // main calls both $left and $right, both of which reach fork.
    // main should appear exactly once in the result, plus left, right,
    // fork. (Verifies BFS doesn't double-count.)
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $left (export "left") (result i32)
            call $fork)
          (func $right (export "right") (result i32)
            call $fork)
          (func $main (export "main") (result i32)
            call $left
            drop
            call $right))
    "#;
    let found = discover(wat);
    assert_eq!(found.len(), 4, "got {found:?}");
    for name in ["left", "right", "main"] {
        assert!(found.iter().any(|n| n == name));
    }
}

#[test]
fn missing_entry_import_is_an_error() {
    // Module has no fork import at all. Must fail loudly rather than
    // silently produce an empty set.
    let wat = r#"
        (module
          (func $a (export "a") (result i32) i32.const 0))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    let err = analyze(&bytes, &Options::default()).unwrap_err();
    let msg = format!("{err:#}");
    assert!(
        msg.contains("kernel.kernel_fork") && msg.contains("not found"),
        "expected a helpful missing-import error, got: {msg}"
    );
}

#[test]
fn custom_entry_import_name() {
    // The entry import is configurable; verify.
    let wat = r#"
        (module
          (import "host" "do_async" (func $async (result i32)))
          (func $a (export "a") (result i32)
            call $async))
    "#;
    let bytes = wat::parse_str(wat).expect("wat parse");
    let opts = Options {
        entry_import: "host.do_async".into(),
        ..Options::default()
    };
    let analysis = analyze(&bytes, &opts).expect("analyze");
    assert_eq!(analysis.fork_path.len(), 2);
    assert!(analysis.fork_path.iter().any(|e| e.name == "a"));
}

#[test]
fn cycle_terminates() {
    // $a calls $b, $b calls $a, $b calls $fork. Cycle must not loop.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (func $a (export "a") (result i32)
            call $b)
          (func $b (export "b") (result i32)
            call $a
            drop
            call $fork))
    "#;
    let found = discover(wat);
    assert_eq!(found.len(), 3, "got {found:?}");
    assert!(found.iter().any(|n| n == "a"));
    assert!(found.iter().any(|n| n == "b"));
}

#[test]
fn indirect_call_to_fork_path_target_is_followed() {
    // $forks_via_indirect is in a table and reaches fork directly.
    // $calls_indirect does call_indirect of the same signature.
    // Phase 3: $calls_indirect must be added because the table
    // target it might dispatch to is on the fork path.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $forks_via_indirect)
          (func $forks_via_indirect (export "forks_via_indirect") (result i32)
            call $fork)
          (func $calls_indirect (export "calls_indirect") (result i32)
            i32.const 0
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "forks_via_indirect"));
    assert!(
        found.iter().any(|n| n == "calls_indirect"),
        "Phase 3: call_indirect caller must be added when its possible \
         target is on the fork path; got {found:?}"
    );
}

#[test]
fn direct_only_ignores_indirect_callers() {
    // Same shape as indirect_call_to_fork_path_target_is_followed, but
    // with indirect discovery disabled. The table target still reaches
    // fork directly; the call_indirect caller is intentionally excluded.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $forks_via_indirect)
          (func $forks_via_indirect (export "forks_via_indirect") (result i32)
            call $fork)
          (func $calls_indirect (export "calls_indirect") (result i32)
            i32.const 0
            call_indirect (type $ft)))
    "#;
    let opts = Options {
        include_indirect_calls: false,
        ..Options::default()
    };
    let found = discover_with_options(wat, &opts);
    assert!(found.iter().any(|n| n == "forks_via_indirect"));
    assert!(
        !found.iter().any(|n| n == "calls_indirect"),
        "--direct-only must not include call_indirect callers; got {found:?}"
    );
}

#[test]
fn indirect_call_with_mismatched_signature_not_followed() {
    // $forks_via_indirect reaches fork and is in the table with type
    // (result i32). $calls_indirect_wrong_sig does call_indirect with
    // a different signature (param i32). Different signature, so its
    // call_indirect cannot actually target $forks_via_indirect;
    // instrumenting it would be overly conservative.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft_a (func (result i32)))
          (type $ft_b (func (param i32)))
          (table 1 funcref)
          (elem (i32.const 0) $forks_via_indirect)
          (func $forks_via_indirect (export "forks_via_indirect") (result i32)
            call $fork)
          (func $calls_indirect_wrong_sig (export "calls_indirect_wrong_sig")
            i32.const 0
            i32.const 0
            call_indirect (type $ft_b)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "forks_via_indirect"));
    assert!(
        !found.iter().any(|n| n == "calls_indirect_wrong_sig"),
        "signature mismatch must not force instrumentation; got {found:?}"
    );
}

#[test]
fn indirect_to_direct_to_fork_chain() {
    //   main → calls_indirect ⇝(type $ft)⇝ target → fork
    //
    // The chain requires: main (direct), calls_indirect (direct to
    // main's pov), target (via table + matching signature), fork.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $target)
          (func $target (export "target") (result i32)
            call $fork)
          (func $calls_indirect (export "calls_indirect") (result i32)
            i32.const 0
            call_indirect (type $ft))
          (func $main (export "main") (result i32)
            call $calls_indirect))
    "#;
    let found = discover(wat);
    for name in ["target", "calls_indirect", "main"] {
        assert!(found.iter().any(|n| n == name), "missing {name}: {found:?}");
    }
}

#[test]
fn function_not_in_any_table_is_not_an_indirect_target() {
    // $fn_with_matching_sig has the same signature as $calls_indirect's
    // call_indirect, BUT it's not in any table. So it's not a possible
    // target and should not be dragged in via indirect closure.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem (i32.const 0) $some_other_target)
          (func $some_other_target (export "some_other_target") (result i32)
            i32.const 0)
          (func $fn_with_matching_sig (export "fn_with_matching_sig") (result i32)
            call $fork)
          (func $calls_indirect (export "calls_indirect") (result i32)
            i32.const 0
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    // $fn_with_matching_sig reaches fork directly (calls it).
    assert!(found.iter().any(|n| n == "fn_with_matching_sig"));
    // $some_other_target is in the table and has matching signature,
    // but it doesn't reach fork — so the indirect closure has nothing
    // to pull in through $calls_indirect.
    assert!(
        !found.iter().any(|n| n == "calls_indirect"),
        "call_indirect target is in the table but doesn't reach fork; \
         caller should not be pulled in: {found:?}"
    );
    assert!(
        !found.iter().any(|n| n == "some_other_target"),
        "irrelevant table function should not appear: {found:?}"
    );
}

#[test]
fn indirect_call_on_different_table_not_followed() {
    // $forks_via_indirect is table-addressable, but only through
    // $fork_table. A call_indirect against $safe_table cannot dispatch
    // to it even though the signature matches.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table $safe_table 1 funcref)
          (table $fork_table 1 funcref)
          (elem (table $safe_table) (i32.const 0) func $safe_target)
          (elem (table $fork_table) (i32.const 0) func $forks_via_indirect)
          (func $safe_target (result i32)
            i32.const 0)
          (func $forks_via_indirect (export "forks_via_indirect") (result i32)
            call $fork)
          (func $calls_safe_table (export "calls_safe_table") (result i32)
            i32.const 0
            call_indirect $safe_table (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "forks_via_indirect"));
    assert!(
        !found.iter().any(|n| n == "calls_safe_table"),
        "call_indirect must be scoped to its table; got {found:?}"
    );
}

#[test]
fn declared_element_is_not_an_indirect_table_target() {
    // A declared element segment makes ref.func valid but does not
    // initialize a table. Treating it as table-addressable makes every
    // same-signature call_indirect a false positive.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem declare func $declared_fork_target)
          (func $declared_fork_target (export "declared_fork_target") (result i32)
            call $fork)
          (func $calls_table (export "calls_table") (result i32)
            i32.const 0
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "declared_fork_target"));
    assert!(
        !found.iter().any(|n| n == "calls_table"),
        "declared elements do not populate an indirect-call table; got {found:?}"
    );
}

#[test]
fn passive_element_without_table_init_is_not_followed() {
    // A passive element segment is not a call_indirect target unless
    // some code can copy it into a table with table.init.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table 1 funcref)
          (elem $passive func $passive_fork_target)
          (func $passive_fork_target (export "passive_fork_target") (result i32)
            call $fork)
          (func $calls_table (export "calls_table") (result i32)
            i32.const 0
            call_indirect (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "passive_fork_target"));
    assert!(
        !found.iter().any(|n| n == "calls_table"),
        "passive segment without table.init should not be treated as table-populating; got {found:?}"
    );
}

#[test]
fn passive_element_with_table_init_is_followed() {
    // Once a passive element can initialize a table, matching call_indirect
    // users of that same table remain fork-path callers.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $ft (func (result i32)))
          (table $t 1 funcref)
          (elem $passive func $passive_fork_target)
          (func $init_table
            i32.const 0
            i32.const 0
            i32.const 1
            table.init $t $passive)
          (func $passive_fork_target (export "passive_fork_target") (result i32)
            call $fork)
          (func $calls_table (export "calls_table") (result i32)
            i32.const 0
            call_indirect $t (type $ft)))
    "#;
    let found = discover(wat);
    assert!(found.iter().any(|n| n == "passive_fork_target"));
    assert!(
        found.iter().any(|n| n == "calls_table"),
        "table.init makes the passive target reachable through that table; got {found:?}"
    );
}

#[test]
fn indirect_closure_allows_two_hops_but_does_not_cascade_forever() {
    // Models trampoline-shaped runtimes without allowing unbounded
    // same-table callback closure:
    //
    //   $hop1 call_indirect -> $fork_target       (depth 1)
    //   $hop2 call_indirect -> $hop1              (depth 2)
    //   $false_positive call_indirect -> $hop2    (depth 3; excluded)
    //
    // The third edge is also a slot-level false positive: the fixture's
    // constant index dispatches to $safe_hop2_target, not $hop2. The
    // call graph is not a full value-flow analyser, so the depth bound is
    // the resource-safety guard that stops this kind of cascade.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (type $fork_ty (func (result i32)))
          (type $hop1_ty (func (result i64)))
          (type $hop2_ty (func (result f32)))
          (table 4 funcref)
          (elem (i32.const 0) $fork_target $hop1 $hop2 $safe_hop2_target)

          (func $fork_target (export "fork_target") (result i32)
            call $fork)

          (func $hop1 (export "hop1") (result i64)
            i32.const 0
            call_indirect (type $fork_ty)
            drop
            i64.const 1)

          (func $hop2 (export "hop2") (result f32)
            i32.const 1
            call_indirect (type $hop1_ty)
            drop
            f32.const 1)

          (func $safe_hop2_target (result f32)
            f32.const 0)

          (func $false_positive (export "false_positive") (result f32)
            i32.const 3
            call_indirect (type $hop2_ty)))
    "#;
    let found = discover(wat);
    for name in ["fork_target", "hop1", "hop2"] {
        assert!(found.iter().any(|n| n == name), "missing {name}: {found:?}");
    }
    assert!(
        !found.iter().any(|n| n == "false_positive"),
        "indirect closure should not cascade beyond two dispatch hops; got {found:?}"
    );
    assert!(
        !found.iter().any(|n| n == "safe_hop2_target"),
        "safe table target should not be pulled into the fork path; got {found:?}"
    );
}
