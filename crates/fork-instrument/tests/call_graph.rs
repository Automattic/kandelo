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
fn indirect_call_not_in_closure_yet() {
    // Phase 2 does not follow call_indirect. This test documents that
    // behavior — Phase 3 will make it a "reached" result.
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
    // $forks_via_indirect reaches fork directly; included.
    // $calls_indirect goes through call_indirect; Phase 2 does not
    // follow that edge, so it should NOT be in the set.
    assert!(found.iter().any(|n| n == "forks_via_indirect"));
    assert!(
        !found.iter().any(|n| n == "calls_indirect"),
        "Phase 2 must not yet follow call_indirect — that is Phase 3's job"
    );
}
