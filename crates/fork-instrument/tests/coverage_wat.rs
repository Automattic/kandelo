//! WAT-fixture coverage for fork-instrument patterns that don't have a
//! direct C/C++ source surface:
//!
//! - **S-04..S-06**: mutable table operations are rejected because a
//!   fresh child instance cannot inherit the mutated table.
//! - **S-07**: a reference-typed call result in the fork closure is
//!   rejected rather than being carried through module-instance state.
//! - **F-03/F-04**: wasm-GC references are rejected with a precise
//!   diagnostic rather than silently miscompiled.
//! - **C-08/C-09**: ref-typed catch operands are rejected because only
//!   scalar tagged-catch payloads have a reconstruction recipe.
//!
//! These complement `host/test/fork-instrument-coverage.test.ts`
//! by covering patterns whose validation can be done at the
//! fork-instrument tool level without requiring a runnable program.

use fork_instrument::{Options, instrument};

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
// S-04..S-07: non-reconstructible state before fork
// ---------------------------------------------------------------------
//
// Skipping an operation during rewind is not enough: the fork child starts
// with a freshly instantiated table. These shapes must therefore fail during
// instrumentation unless a future owner provides deterministic reconstruction.

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
    assert_instrument_rejects(
        wat,
        "S-04 table.fill",
        &["table.fill", "no fresh-instance reconstruction owner"],
    );
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
    assert_instrument_rejects(
        wat,
        "S-05 table.copy",
        &["table.copy", "no fresh-instance reconstruction owner"],
    );
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
    assert_instrument_rejects(
        wat,
        "S-06 table.grow",
        &["table.grow", "no fresh-instance reconstruction owner"],
    );
}

#[test]
fn s_07_non_nullable_funcref_call_result_before_fork() {
    // Even when immediately dropped, a reference-typed call is not accepted in
    // the fork closure until the analysis can prove it is never a carryover.
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
    assert_instrument_rejects(
        wat,
        "S-07 non-nullable funcref call result",
        &[
            "calls a reference-typed signature",
            "cannot be carried through replay",
        ],
    );
}

// ---------------------------------------------------------------------
// F-03 / F-04: wasm-GC accepted limits — must reject loudly
// ---------------------------------------------------------------------
//
// Per docs/fork-instrumentation.md §Not guaranteed, abstract and
// concrete wasm-GC reference types on the fork path are explicitly
// out of scope. fork-instrument must reject them before rewriting rather than
// silently miscompile.

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
        &[
            "fork-reachable function `main`",
            "reference local/parameter",
            "reference activations are not transferable",
        ],
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
        &[
            "fork-reachable function `main`",
            "reference local/parameter",
            "Concrete",
        ],
    );
}

// ---------------------------------------------------------------------
// C-08 / C-09: ref-typed catch operands
// ---------------------------------------------------------------------
//
// CatchRef reconstruction supports statically tagged scalar payloads. A tag
// payload containing a reference cannot cross the fresh-instance boundary and
// must be rejected before instrumentation.

#[test]
fn c_08_funcref_catch_operand_is_rejected() {
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
            let error = instrument(&input, &Options::default())
                .expect_err("fork-instrument should reject a funcref catch payload");
            let message = error.to_string();
            assert!(
                message.contains("reference-typed catch payload"),
                "{message}"
            );
            assert!(message.contains("Abstract(Func)"), "{message}");
        }
        Err(e) => {
            eprintln!("skip: wat crate did not parse funcref tag: {e}");
        }
    }
}

#[test]
fn c_09_externref_catch_operand_is_rejected() {
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
            let error = instrument(&input, &Options::default())
                .expect_err("fork-instrument should reject an externref catch payload");
            let message = error.to_string();
            assert!(
                message.contains("reference-typed catch payload"),
                "{message}"
            );
            assert!(message.contains("Abstract(Extern)"), "{message}");
        }
        Err(e) => {
            eprintln!("skip: wat crate did not parse externref tag: {e}");
        }
    }
}
