//! WAT-fixture coverage for fork-instrument patterns that don't have a
//! direct C/C++ source surface:
//!
//! - **S-04..S-06**: mutable table operations are captured by the
//!   module-state owner and remain valid across fresh-instance replay.
//! - **S-07**: a dead reference-typed call result needs no continuation
//!   recipe and remains accepted.
//! - **F-03/F-04**: abstract and concrete wasm-GC references are encoded as
//!   activation-owned recipe IDs and reconstructed through the generated
//!   anyref codec.
//! - **C-08/C-09**: ref-typed catch operands are captured as complete
//!   exception recipes and reconstructed with `throw_ref`.
//!
//! These complement `host/test/fork-instrument-coverage.test.ts`
//! by covering patterns whose validation can be done at the
//! fork-instrument tool level without requiring a runnable program.

use fork_instrument::{Options, instrument};

fn instrument_and_validate(wat: &str, label: &str) -> Vec<u8> {
    let input = wat::parse_str(wat).unwrap_or_else(|e| panic!("{label}: wat parse: {e}"));
    let output = instrument(&input, &Options::default())
        .unwrap_or_else(|e| panic!("{label}: fork-instrument rejected supported wasm: {e:#}"));
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&output)
        .unwrap_or_else(|e| panic!("{label}: instrumented wasm did not validate: {e}"));
    output
}

// ---------------------------------------------------------------------
// S-04..S-07: state before fork
// ---------------------------------------------------------------------
//
// The child starts with a freshly instantiated table. The module-state
// transaction must therefore capture each mutation rather than relying on the
// child instance's static element initialization.

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
    instrument_and_validate(wat, "S-04 table.fill");
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
    instrument_and_validate(wat, "S-05 table.copy");
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
    instrument_and_validate(wat, "S-06 table.grow");
}

#[test]
fn s_07_non_nullable_funcref_call_result_before_fork() {
    // The original-IR liveness pass proves the result is dropped before fork,
    // so this shape must not pay for or be rejected by reference replay.
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
    let input = wat::parse_str(wat).unwrap();
    let output = instrument(&input, &Options::default())
        .expect("dead funcref result should remain instrumentable");
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&output)
        .expect("instrumented dead-funcref fixture should validate");
}

// ---------------------------------------------------------------------
// F-03 / F-04: wasm-GC activation state uses generated codecs
// ---------------------------------------------------------------------
//
// JavaScript cannot directly implement anyref-typed imports. The artifact
// therefore calls the generated Wasm codec, which converts each live reference
// to an activation-owned scalar recipe ID and narrows the decoded anyref back
// to the statically expected type in the fresh child.

#[test]
fn f_03_anyref_on_fork_path_uses_generated_codec() {
    // A non-null i31 value widened to anyref is live across fork, so this
    // exercises the codec rather than the definitely-null fast path.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (func $main (export "_start") (result i32)
            (local $r anyref)
            i32.const 17
            ref.i31
            local.set $r
            (drop (call $fork))
            local.get $r
            drop
            (i32.const 0)))
    "#;
    instrument_and_validate(wat, "F-03 anyref");
}

#[test]
fn f_04_struct_ref_on_fork_path_uses_generated_codec() {
    // Concrete GC references encode through the broad anyref codec and are
    // ref.cast back to `$pair` on replay. Keep an inline allocation live across
    // fork so the original-IR stack analysis must preserve the producer's
    // precise concrete type rather than relying on a typed helper call.
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (type $pair (struct (field i32) (field i32)))
          (func $main (export "_start") (result i32)
            (local $r (ref null $pair))
            i32.const 23
            i32.const 42
            struct.new $pair
            local.set $r
            (drop (call $fork))
            local.get $r
            drop
            (i32.const 0)))
    "#;
    instrument_and_validate(wat, "F-04 struct ref");
}

// ---------------------------------------------------------------------
// C-08 / C-09: ref-typed catch operands
// ---------------------------------------------------------------------
//
// A reference-bearing tag payload cannot be serialized independently without
// losing exception identity. The transformed catch therefore captures the
// complete exception as an exnref recipe and replay reconstructs that exception
// before `throw_ref` re-enters the original clause.

#[test]
fn c_08_funcref_catch_operand_uses_exception_recipe() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (tag $func_tag (param funcref))
          (func $target)
          (elem declare func $target)
          (func $main (export "_start") (result i32)
            (local $caught funcref)
            (block $h (result funcref)
              (try_table (result funcref) (catch $func_tag $h)
                ref.func $target
                throw $func_tag
                unreachable))
            local.set $caught
            (drop (call $fork))
            local.get $caught
            drop
            (i32.const 0)))
    "#;
    instrument_and_validate(wat, "C-08 funcref catch payload");
}

#[test]
fn c_09_externref_catch_operand_uses_exception_recipe() {
    let wat = r#"
        (module
          (import "kernel" "kernel_fork" (func $fork (result i32)))
          (memory 1)
          (tag $ext_tag (param externref))
          (func $main (export "_start") (result i32)
            (local $caught externref)
            (block $h (result externref)
              (try_table (result externref) (catch $ext_tag $h)
                ref.null extern
                throw $ext_tag
                unreachable))
            local.set $caught
            (drop (call $fork))
            local.get $caught
            drop
            (i32.const 0)))
    "#;
    instrument_and_validate(wat, "C-09 externref catch payload");
}
