//! Regression tests for the switch-dispatch redesign.
//!
//! These tests codify the two classes of fork-semantic bug proven in
//! the 2026-04-22 debug session (see
//! `memory/fork-instrument-phase7-debug-evidence.md`):
//!
//! - **waitpid-class**: non-fork-path direct calls must NOT re-fire
//!   during REWINDING.
//! - **posix_spawn-class**: code between call sites must NOT re-execute,
//!   including shadow-stack manipulation.
//!
//! The helpers below are `todo!()` until Task 7 lands the new transform.
//! The tests therefore FAIL on `not implemented`, which is the intended
//! pre-Task-7 state and serves as the executable checklist.

use fork_instrument::{Options, instrument};
use walrus::Module;

#[test]
fn waitpid_class_non_fork_path_call_skipped_on_rewind() {
    let wat = include_str!("fixtures/switch_dispatch/waitpid_class.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    let module = Module::from_buffer(&output).expect("walrus parse");

    // Assert: `main`'s body contains a `br_table` at the top (within
    // the REWINDING guard), and the call to `kernel.setpgid` is NOT
    // inside any `$POST_K` landing-block — it lives in chunk 0,
    // outside the dispatch labels.
    assert!(
        has_top_level_br_table_dispatch(&module, "main"),
        "`main` must contain a top-level br_table dispatch"
    );
    assert!(
        !call_appears_inside_dispatch_body(&module, "main", "kernel.setpgid"),
        "`kernel.setpgid` must live in chunk 0, outside any $POST_K block"
    );
}

#[test]
fn posix_spawn_class_shadow_stack_not_duplicated() {
    let wat = include_str!("fixtures/switch_dispatch/posix_spawn_class.wat");
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options::default()).expect("instrument");
    let module = Module::from_buffer(&output).expect("walrus parse");

    // Assert: the `global.set $__stack_pointer` sequence appears
    // exactly once in `main`'s emitted body (not wrapped inside an
    // if-else, not duplicated by the dispatch shim).
    //
    // The fixture contains TWO global.set $__stack_pointer ops in the
    // source (reserve + restore). After transform, both appear once on
    // the NORMAL path — the critical invariant is that no gating/guard
    // shim introduces extra copies.
    let count = count_global_set(&module, "main", "__stack_pointer");
    assert_eq!(
        count, 2,
        "shadow-stack adjustments must appear exactly twice (reserve + restore), \
         not multiplied by a gating wrapper"
    );
}

// -- Helper predicates ----------------------------------------------
//
// These are filled in after Task 7's transform lands, when the emitted
// shape exists to calibrate against. Until then, each returns `todo!()`
// and the tests fail loudly with "not implemented".

fn has_top_level_br_table_dispatch(_module: &Module, _func_name: &str) -> bool {
    todo!("Task 7: walk the target function's entry seq and look for a top-level \
           block whose body contains an `if state == REWINDING then br_table` shape")
}

fn call_appears_inside_dispatch_body(
    _module: &Module,
    _func_name: &str,
    _import: &str,
) -> bool {
    todo!("Task 7: walk the target function's seqs; find calls to the named import; \
           return true iff any such call sits inside a $POST_K block (i.e. after \
           the dispatch landing label)")
}

fn count_global_set(_module: &Module, _func_name: &str, _global_name: &str) -> usize {
    todo!("Task 7: walk the target function; count `global.set $GLOBAL_NAME` ops")
}
