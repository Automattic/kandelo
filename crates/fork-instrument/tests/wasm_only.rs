//! Final-Wasm analysis must not assume the original libc call structure.
use fork_instrument::{Options, PlanSource, SideModules, instrument, sink_report};

fn check(wat: &str, mode: SideModules, required: &[&str]) {
    let input = wat::parse_str(wat).unwrap();
    let opts = Options {
        facts: false,
        side_modules: mode,
        ..Options::default()
    };
    let report = sink_report(&input, &opts).unwrap();
    assert_eq!(
        report.source,
        PlanSource::Builtin,
        "{:?}",
        report.facts_error
    );
    for name in required {
        assert!(
            report.instrumented.iter().any(|f| f == name),
            "missing {name}: {:?}",
            report.instrumented
        );
    }
    let output = instrument(&input, &opts).unwrap();
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&output)
        .unwrap();
}

#[test]
fn dynamic_constant_slot_is_not_proven_empty_by_its_static_initializer() {
    // The loader can populate slot 1. Its call returns, so main's later fork
    // remains reachable even though the input has no element at that slot.
    check(
        r#"(module
      (type $t (func (result i32)))
      (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
      (import "env" "__wasm_dlsym" (func $dlsym (param i32 i32 i32) (result i32)))
      (memory 1) (table (export "__indirect_function_table") 2 funcref)
      (func $main (result i32)
        (drop (call_indirect (type $t) (i32.const 1)))
        (call $fork (i32.const 0)))
      (func (export "_start") (drop (call $main))))"#,
        SideModules::TracedEntries,
        &["main"],
    );
}

#[test]
fn one_local_target_does_not_exclude_a_returning_external_target() {
    for mode in [
        SideModules::TracedEntries,
        SideModules::AssumeAllEntriesForkReturning,
    ] {
        // Specializing only `never` with constant argument 7 would incorrectly
        // classify the entire indirect call as noreturn, losing the next fork.
        check(
            r#"(module
          (type $t (func (param i32) (result i32)))
          (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
          (import "env" "__wasm_dlsym" (func $dlsym (param i32 i32 i32) (result i32)))
          (memory 1) (table 2 funcref) (elem (i32.const 1) $never)
          (func $never (type $t) (loop $forever (br $forever)) (unreachable))
          (func $main (result i32)
            (drop (call_indirect (type $t) (i32.const 7) (i32.load (i32.const 0))))
            (call $fork (i32.const 0)))
          (func (export "_start") (drop (call $main))))"#,
            mode,
            &["main"],
        );
    }
}

#[test]
fn an_inlined_registry_writer_does_not_mean_the_registry_is_empty() {
    check(
        r#"(module
      (type $callback (func))
      (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
      (memory 1) (table 2 funcref) (elem (i32.const 1) $callback)
      (func $callback (drop (call $fork (i32.const 0))))
      (func $__fork_handler
        (call_indirect (type $callback) (i32.load (i32.const 0))))
      (func $main (export "_start")
        ;; A registration writer has been inlined, removing pthread_atfork.
        (i32.store (i32.const 0) (i32.const 1))
        (call $__fork_handler)))"#,
        SideModules::TracedEntries,
        &["__fork_handler", "main"],
    );
}

#[test]
fn an_inlined_cancellation_writer_does_not_remove_the_exit_path() {
    check(
        r#"(module
      (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
      (memory 1)
      (func $__pthread_exit (drop (call $fork (i32.const 0))) (loop $done (br $done)))
      (func $__syscall_cp_check (call $__pthread_exit))
      (func $main (export "_start") (call $__syscall_cp_check)))"#,
        SideModules::TracedEntries,
        &["__pthread_exit"],
    );
}

#[test]
fn imported_tables_use_the_complete_closure() {
    // The importer can supply a returning function even though no local
    // function has this signature. Its call must not hide the later fork.
    let input = wat::parse_str(
        r#"(module
      (type $t (func (result i32)))
      (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
      (import "env" "__indirect_function_table" (table 2 funcref))
      (memory 1)
      (func $main (result i32)
        (drop (call_indirect (type $t) (i32.const 1)))
        (call $fork (i32.const 0)))
      (func (export "_start") (drop (call $main))))"#,
    )
    .unwrap();
    let opts = Options {
        facts: false,
        ..Options::default()
    };
    let report = sink_report(&input, &opts).unwrap();
    assert_eq!(report.source, PlanSource::Closure);
    assert!(report.instrumented.iter().any(|f| f == "main"));
    let output = instrument(&input, &opts).unwrap();
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&output)
        .unwrap();
}
