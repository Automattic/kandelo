//! Tests for Phase 2: direct-call graph discovery.
//!
//! Each fixture is a small WAT module whose structure lets us assert
//! exactly which functions should be reported as reaching the
//! `kernel.kernel_fork` import through direct calls.

use fork_instrument::{Options, analyze};
use std::collections::HashSet;

fn discover(wat_src: &str) -> HashSet<String> {
    let bytes = wat::parse_str(wat_src).expect("wat parse");
    let analysis = analyze(&bytes, &Options::default()).expect("analyze");
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
    assert_eq!(found.len(), 2, "expected seed + one direct caller, got {found:?}");
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
