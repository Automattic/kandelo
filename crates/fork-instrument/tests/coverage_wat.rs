//! WAT-fixture coverage for fork-instrument patterns that don't have a
//! direct C/C++ source surface:
//!
//! - **S-04..S-07**: side-effect operations (table.fill, table.copy,
//!   table.grow, non-nullable funcref Call result) before fork.
//!   Switch-dispatch's body-skip-on-REWIND construction means these
//!   ops run exactly once on NORMAL; the test verifies fork-instrument
//!   produces validating wasm for these shapes.
//! - **F-03/F-04**: wasm-GC accepted limits. fork-instrument must
//!   panic with a clear error rather than silently miscompile.
//! - **C-08/C-09**: ref-typed catch operands. Currently A4
//!   territory — fork-instrument either supports via aux-table
//!   spilling (future) or panics with a clear error today.
//!
//! These complement `host/test/fork-instrument-coverage.test.ts`
//! by covering patterns whose validation can be done at the
//! fork-instrument tool level without requiring a runnable program.

use fork_instrument::{Options, instrument};

fn assert_instruments_and_validates(wat: &str, label: &str) {
    let input = wat::parse_str(wat).unwrap_or_else(|e| panic!("{label}: wat parse: {e}"));
    let output = instrument(&input, &Options::default())
        .unwrap_or_else(|e| panic!("{label}: instrument: {e}"));
    let mut validator =
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
    validator
        .validate_all(&output)
        .unwrap_or_else(|e| panic!("{label}: wasmparser validation: {e}"));
}

fn assert_instrument_rejects(wat: &str, label: &str, expected: &[&str]) {
    let input = wat::parse_str(wat).unwrap_or_else(|e| panic!("{label}: wat parse: {e}"));
    let result = std::panic::catch_unwind(|| instrument(&input, &Options::default()));
    let msg = match result {
        Ok(Ok(_)) => panic!("{label}: fork-instrument unexpectedly accepted accepted-limit wasm"),
        Ok(Err(e)) => e.to_string(),
        Err(p) => p
            .downcast::<String>()
            .map(|s| *s)
            .or_else(|p| p.downcast::<&'static str>().map(|s| (*s).to_string()))
            .unwrap_or_else(|_| "<unknown panic>".into()),
    };
    for needle in expected {
        assert!(
            msg.contains(needle),
            "{label}: rejection diagnostic did not contain `{needle}`; got: {msg}",
        );
    }
}

// ---------------------------------------------------------------------
// S-04..S-07: side effects before fork
// ---------------------------------------------------------------------
//
// Switch-dispatch's body-skip-on-REWIND construction (sub-commits
// 2.4c/2.5c/2.6c) means the body chunks BEFORE the chosen POST_K
// never re-execute on REWIND — non-fork-path calls and side-effect
// ops in those chunks run exactly once on NORMAL. These tests
// verify fork-instrument produces validating wasm for each
// side-effect op pattern.

#[test]
fn s_04_table_fill_before_fork() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (table $t 4 funcref)
          (func $main (export "_start") (result i32)
            ;; table.fill: idx=0, ref=null, count=4
            i32.const 0
            ref.null func
            i32.const 4
            table.fill $t
            ;; Now fork.
            (drop (call $fork))
            (i32.const 0)))
    "#;
    assert_instruments_and_validates(wat, "S-04 table.fill");
}

#[test]
fn s_05_table_copy_before_fork() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (table $t 8 funcref)
          (func $main (export "_start") (result i32)
            ;; table.copy: dst=0, src=4, count=4 (within same table)
            i32.const 0
            i32.const 4
            i32.const 4
            table.copy $t $t
            ;; Now fork.
            (drop (call $fork))
            (i32.const 0)))
    "#;
    assert_instruments_and_validates(wat, "S-05 table.copy");
}

#[test]
fn s_06_table_grow_before_fork() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (table $t 4 funcref)
          (func $main (export "_start") (result i32)
            ;; table.grow: init=ref.null, delta=2. Result is prev size.
            ref.null func
            i32.const 2
            table.grow $t
            drop
            ;; Now fork.
            (drop (call $fork))
            (i32.const 0)))
    "#;
    assert_instruments_and_validates(wat, "S-06 table.grow");
}

#[test]
fn s_07_non_nullable_funcref_call_result_before_fork() {
    // S-07 originally targets the case where a direct call returns
    // a non-nullable Ref and that result is consumed AFTER fork
    // (the result would need to be saved across the fork boundary,
    // but ref-typed values can't be stored in scalar frame slots).
    //
    // For switch-dispatch's body-skip path, the call's result lives
    // in the chunk BEFORE the fork; on REWIND that chunk is skipped
    // and the result is never produced. As long as no instruction
    // between the call and fork consumes the ref, this validates.
    //
    // Today fork-instrument REJECTS fork-path functions with ref-
    // typed argument types via a panic ("ref-typed argument
    // ... needs aux-table spilling, which the MVP switch-dispatch
    // transform does not yet support"). To exercise this case
    // cleanly we use a non-nullable funcref CALLED-RESULT (not
    // arg). The non-nullable funcref result of a direct call is
    // dropped immediately so no spilling is needed.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (table $t 1 funcref)
          (elem (i32.const 0) func $stub)
          (func $stub (result i32) (i32.const 42))
          (func $get_func (result (ref func))
            (ref.func $stub))
          (func $main (export "_start") (result i32)
            ;; Direct call returning non-nullable funcref. Drop the
            ;; result immediately so it doesn't need to survive
            ;; the fork boundary.
            (drop (call $get_func))
            ;; Now fork.
            (drop (call $fork))
            (i32.const 0)))
    "#;
    assert_instruments_and_validates(wat, "S-07 non-nullable funcref call result");
}

// ---------------------------------------------------------------------
// F-03 / F-04: wasm-GC accepted limits — must panic loudly
// ---------------------------------------------------------------------
//
// Per docs/fork-instrumentation.md §Not guaranteed, abstract and
// concrete wasm-GC reference types on the fork path are explicitly
// out of scope. fork-instrument must reject them at the
// `classify_ref` step rather than silently miscompile.

#[test]
fn f_03_anyref_on_fork_path_rejects_with_diagnostic() {
    // Use anyref as a function-local on a fork-path function.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (func $main (export "_start") (result i32)
            (local $r anyref)
            ref.null any
            local.set $r
            (drop (call $fork))
            local.get $r
            drop
            (i32.const 0)))
    "#;
    assert_instrument_rejects(
        wat,
        "F-03 anyref",
        &["fork-instrument 4f", "not yet supported"],
    );
}

#[test]
fn f_04_struct_ref_on_fork_path_rejects_with_diagnostic() {
    // wasm-GC struct.new isn't produced by our LLVM toolchain,
    // but concrete GC references on a fork-path must not silently
    // miscompile. A local of `(ref null $pair)` is enough to exercise
    // the same accepted-limit rejection path that a `struct.new`
    // producer would need before its value could survive fork.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (type $pair (struct (field i32) (field i32)))
          (func $main (export "_start") (result i32)
            (local $r (ref null $pair))
            ref.null $pair
            local.set $r
            (drop (call $fork))
            local.get $r
            drop
            (i32.const 0)))
    "#;
    assert_instrument_rejects(
        wat,
        "F-04 struct ref",
        &["fork-instrument 4f", "not yet supported"],
    );
}

// ---------------------------------------------------------------------
// C-08 / C-09: ref-typed catch operands (A4 territory)
// ---------------------------------------------------------------------
//
// Per the unsupported-cases review doc, fork-path functions whose
// plain-catch arms carry ref-typed operands (funcref / externref)
// are CARVED OUT of the fork-path set at instrument time (via
// `B1ScratchPlan::b2_carveout`). A future A4 implementation would
// extend per-arm aux-table spilling to support these. The current
// behavior: fork-instrument processes the module without panic;
// the function with the ref-typed catch arm doesn't get
// instrumented (which is correct: it's not actually on the
// fork-call path if the carve-out is right, OR it's a
// surprise-fork-path that the carve-out preserves safety for).

#[test]
fn c_08_funcref_catch_operand_does_not_panic() {
    // Try_table with a `catch` clause whose tag has a funcref
    // operand. Since the wat crate may not parse arbitrary tag
    // signatures with ref types, this test gracefully skips on
    // parse failure.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (tag $func_tag (param funcref))
          (func $main (export "_start") (result i32)
            (block $h (result funcref)
              (try_table (result funcref) (catch $func_tag $h)
                ref.null func))
            drop
            (drop (call $fork))
            (i32.const 0)))
    "#;
    match wat::parse_str(wat) {
        Ok(input) => {
            // Should NOT panic. fork-instrument carves out the
            // function or accepts it gracefully.
            let _ = instrument(&input, &Options::default())
                .expect("fork-instrument should not error on funcref catch arm");
        }
        Err(e) => {
            eprintln!("skip: wat crate did not parse funcref tag: {e}");
        }
    }
}

#[test]
fn c_09_externref_catch_operand_does_not_panic() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (tag $ext_tag (param externref))
          (func $main (export "_start") (result i32)
            (block $h (result externref)
              (try_table (result externref) (catch $ext_tag $h)
                ref.null extern))
            drop
            (drop (call $fork))
            (i32.const 0)))
    "#;
    match wat::parse_str(wat) {
        Ok(input) => {
            let _ = instrument(&input, &Options::default())
                .expect("fork-instrument should not error on externref catch arm");
        }
        Err(e) => {
            eprintln!("skip: wat crate did not parse externref tag: {e}");
        }
    }
}
