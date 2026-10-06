//! Fork boundaries (sinks): which functions the bounded unwind stops at and
//! which callers it leaves uninstrumented. See
//! `docs/plans/2026-10-02-fork-sinks.md` and `src/sink.rs`.

use fork_instrument::{Options, instrument};
use walrus::{FunctionKind, Module, ir::Instr};

fn instrument_wat(wat: &str, sinks: bool) -> Vec<u8> {
    let input = wat::parse_str(wat).expect("wat parse");
    let output = instrument(&input, &Options { sinks, ..Options::default() }).expect("instrument");
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::all())
        .validate_all(&output)
        .expect("instrumented module validates");
    output
}

/// Function ordinals listed in `kandelo.wpk_fork.boundaries`.
fn boundary_ordinals(bytes: &[u8]) -> Vec<u32> {
    let module = Module::from_buffer(bytes).expect("parse");
    let Some((_, section)) = module
        .customs
        .iter()
        .find(|(_, section)| section.name() == "kandelo.wpk_fork.boundaries")
    else {
        return vec![];
    };
    let data = section.data(&Default::default()).to_vec();
    assert_eq!(&data[0..4], b"KFSB");
    assert_eq!(u16::from_le_bytes([data[4], data[5]]), 1);
    let count = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
    assert_eq!(data.len(), 12 + count * 8);
    (0..count)
        .map(|i| u32::from_le_bytes(data[12 + i * 8..16 + i * 8].try_into().unwrap()))
        .collect()
}

/// Whether `name`'s body reads the fork state global (it was instrumented).
fn is_instrumented(bytes: &[u8], name: &str) -> bool {
    let module = Module::from_buffer(bytes).expect("parse");
    let state = module
        .globals
        .iter()
        .find(|g| g.name.as_deref() == Some("_wpk_fork_state"))
        .map(|g| g.id())
        .expect("fork state global");
    let function = module
        .funcs
        .iter()
        .find(|f| f.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("function {name}"));
    let FunctionKind::Local(local) = &function.kind else { return false };
    let mut found = false;
    let mut stack = vec![local.entry_block()];
    while let Some(seq) = stack.pop() {
        for (instr, _) in &local.block(seq).instrs {
            match instr {
                Instr::GlobalGet(g) if g.global == state => found = true,
                Instr::Block(b) => stack.push(b.seq),
                Instr::Loop(b) => stack.push(b.seq),
                Instr::TryTable(t) => stack.push(t.seq),
                Instr::IfElse(i) => {
                    stack.push(i.consequent);
                    stack.push(i.alternative);
                }
                _ => {}
            }
        }
    }
    found
}

fn has_boundary_import(bytes: &[u8]) -> bool {
    let module = Module::from_buffer(bytes).expect("parse");
    module.imports.iter().any(|i| i.module == "env" && i.name == "__wpk_fork_boundary")
}

fn has_sink_entry(bytes: &[u8]) -> bool {
    let module = Module::from_buffer(bytes).expect("parse");
    module.exports.iter().any(|e| e.name == "wpk_fork_resume_sink")
}

const SINK_EXIT: &str = r#"
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (memory 1)
  (func $_exit (param i32) (loop $l (br $l)))
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $spawn (result i32) (local $pid i32)
    (local.set $pid (call $fork))
    (if (i32.eqz (local.get $pid)) (then (call $_exit (i32.const 127))))
    (local.get $pid))
  (func $main (export "_start") (drop (call $spawn))))
"#;

#[test]
fn child_that_never_returns_makes_its_function_a_boundary() {
    let out = instrument_wat(SINK_EXIT, true);
    assert_eq!(boundary_ordinals(&out).len(), 1, "spawn is the only boundary");
    assert!(has_boundary_import(&out));
    assert!(has_sink_entry(&out));
    assert!(is_instrumented(&out, "spawn"));
    assert!(is_instrumented(&out, "fork"));
    assert!(
        !is_instrumented(&out, "main"),
        "the caller above the sink must stay uninstrumented"
    );
}

#[test]
fn no_sinks_option_restores_the_full_closure() {
    let out = instrument_wat(SINK_EXIT, false);
    assert!(boundary_ordinals(&out).is_empty());
    assert!(!has_boundary_import(&out));
    assert!(!has_sink_entry(&out));
    assert!(is_instrumented(&out, "main"));
}

#[test]
fn child_that_returns_keeps_every_caller() {
    let out = instrument_wat(
        r#"
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (memory 1)
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $daemonize (result i32) (call $fork))
  (func $main (export "_start") (drop (call $daemonize))))
"#,
        true,
    );
    assert!(boundary_ordinals(&out).is_empty());
    assert!(!has_boundary_import(&out));
    assert!(is_instrumented(&out, "main"));
    assert!(is_instrumented(&out, "daemonize"));
}

#[test]
fn exception_caught_above_keeps_the_child_path_open() {
    // The child throws; `main` above the would-be sink catches the tag and
    // continues. Stopping the unwind at `spawn` would change behaviour.
    let out = instrument_wat(
        r#"
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (memory 1)
  (tag $t (param i32))
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $spawn (result i32) (local $pid i32)
    (local.set $pid (call $fork))
    (if (i32.eqz (local.get $pid)) (then (throw $t (i32.const 1))))
    (local.get $pid))
  (func $main (export "_start")
    (block $h (result i32)
      (try_table (catch $t $h) (drop (call $spawn)))
      (i32.const 0))
    (drop)))
"#,
        true,
    );
    assert!(boundary_ordinals(&out).is_empty());
    assert!(is_instrumented(&out, "main"));
}

#[test]
fn uncaught_child_exception_still_allows_a_boundary() {
    // Nothing can catch the escape, so it reaches the stack root either way.
    let out = instrument_wat(
        r#"
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (memory 1)
  (tag $t (param i32))
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $spawn (result i32) (local $pid i32)
    (local.set $pid (call $fork))
    (if (i32.eqz (local.get $pid)) (then (throw $t (i32.const 1))))
    (local.get $pid))
  (func $main (export "_start") (drop (call $spawn))))
"#,
        true,
    );
    assert_eq!(boundary_ordinals(&out).len(), 1);
    assert!(!is_instrumented(&out, "main"));
}

#[test]
fn o0_frame_slots_are_tracked_only_while_the_frame_does_not_escape() {
    let slot = r#"
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (global $__stack_pointer (mut i32) (i32.const 65536))
  (memory 2)
  (func $_exit (param i32) (loop $l (br $l)))
  (func $noise)
  (func $clobber (param i32) (i32.store offset=8 (local.get 0) (i32.const 1)))
  (func $fork (result i32) (call $kernel_fork (i32.const 0)))
  (func $spawn (result i32) (local $fp i32)
    (local.set $fp (i32.sub (global.get $__stack_pointer) (i32.const 16)))
    (global.set $__stack_pointer (local.get $fp))
    (i32.store offset=8 (local.get $fp) (call $fork))
    MIDDLE
    (if (i32.eqz (i32.load offset=8 (local.get $fp))) (then (call $_exit (i32.const 1))))
    (global.set $__stack_pointer (i32.add (local.get $fp) (i32.const 16)))
    (i32.load offset=8 (local.get $fp)))
  (func $main (export "_start") (drop (call $spawn))))
"#;
    let kept = instrument_wat(&slot.replace("MIDDLE", "(call $noise)"), true);
    assert_eq!(boundary_ordinals(&kept).len(), 1, "slot survives an unrelated call");
    let escaped = instrument_wat(&slot.replace("MIDDLE", "(call $clobber (local.get $fp))"), true);
    assert!(
        boundary_ordinals(&escaped).is_empty(),
        "a callee holding the frame address may rewrite the slot"
    );
}

#[test]
fn fork_reaching_tail_call_is_transparent_to_the_child() {
    let out = instrument_wat(
        r#"
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (memory 1)
  (func $deep (result i32) (call $kernel_fork (i32.const 0)))
  (func $tail (result i32) (return_call $deep))
  (func $root (export "_start") (drop (call $tail))))
"#,
        true,
    );
    assert!(boundary_ordinals(&out).is_empty());
    assert!(is_instrumented(&out, "root"));
}

#[test]
fn vfork_caller_is_a_boundary_by_contract() {
    // POSIX: the vfork child may not return from the function that called
    // vfork. Even though `spawn` may return here, its vfork site is a
    // boundary; returning in the child traps at the sink entry.
    let out = instrument_wat(
        r#"
(module
  (import "kernel" "kernel_fork" (func $kernel_fork (param i32) (result i32)))
  (memory 1)
  (func $vfork (result i32) (call $kernel_fork (i32.const 1)))
  (func $spawn (result i32) (call $vfork))
  (func $main (export "_start") (drop (call $spawn))))
"#,
        true,
    );
    assert_eq!(boundary_ordinals(&out).len(), 1, "spawn is a boundary by contract");
    assert!(is_instrumented(&out, "spawn"));
    assert!(!is_instrumented(&out, "main"));
}
