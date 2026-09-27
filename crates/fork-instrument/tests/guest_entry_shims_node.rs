//! The two guest shims lane F step 3c moved out of the hosts:
//!
//! * `wpk_fork_thread_entry` / `wpk_fork_resume_thread` call a pthread start
//!   routine in the convention the guest's own function table uses -- plain C,
//!   or binaryen's `--fpcast-emu` uniform `(i64 x N) -> i64` thunks. The
//!   JavaScript host used to adapt the arguments per call
//!   (`buildThreadEntryArgs`); the fork module's run loop cannot, so the
//!   binary carries the adaptation.
//! * `__wpk_fork_static_root_fill` copies an activation's static roots into
//!   the fork module's merged catalog with one `table.copy`, which the hosts
//!   used to do one `Table.set` at a time.
//!
//! # Why Node
//!
//! Both properties are about what a real engine does with the emitted code:
//! that a call through the fixed signature reaches the start routine with the
//! right argument and hands its result back, and that the merged catalog holds
//! the very object (`===`) the guest's catalog holds. An IR assertion can show
//! an instruction was emitted, not that the value arriving is the right one.

use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::{Options, instrument, instrument::ThreadEntryAbi};

/// A plain C start routine: `(i32) -> i32`, returning `arg + 1`. The second
/// table entry has a different type, which is what a real C program's table
/// looks like and what rules out `--fpcast-emu`.
const PLAIN: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
      (memory (export "memory") 4)
      (table $t (export "__indirect_function_table") 2 funcref)
      (func $start (param $arg i32) (result i32)
        (i32.add (local.get $arg) (i32.const 1)))
      (func $other (param i32) (param i32))
      (elem (table $t) (i32.const 0) func $start $other)
      (func (export "_start") (drop (call $fork (i32.const 0)))))
"#;

/// The same routine after `--fpcast-emu`: every table entry is a thunk of one
/// type, three i64 parameters and an i64 result. It returns `param0 + 1` and
/// traps unless the other two parameters are zero, so a call that got the
/// padding wrong cannot pass.
const FPCAST: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
      (memory (export "memory") 4)
      (table $t (export "__indirect_function_table") 2 funcref)
      (func $start (param i64 i64 i64) (result i64)
        (if (i64.ne (local.get 1) (i64.const 0)) (then unreachable))
        (if (i64.ne (local.get 2) (i64.const 0)) (then unreachable))
        (i64.add (local.get 0) (i64.const 1)))
      (func $other (param i64 i64 i64) (result i64) (i64.const 0))
      (elem (table $t) (i32.const 0) func $start $other)
      (func (export "_start") (drop (call $fork (i32.const 0)))))
"#;

/// One statically initialised GC root (an immutable global), which the
/// static-reference catalog harvests at ordinal 0.
const STATIC_ROOT: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
      (type $s (struct (field i32)))
      (memory (export "memory") 4)
      (global $root (export "root") (ref $s) (struct.new $s (i32.const 7)))
      (func (export "_start") (drop (call $fork (i32.const 0)))))
"#;

fn instrumented(wat_text: &str) -> Vec<u8> {
    let input = wat::parse_str(wat_text).expect("parse fixture");
    instrument(&input, &Options::default()).expect("instrument fixture")
}

#[test]
fn the_thread_entry_convention_is_read_from_the_table() {
    let abi = |text: &str| {
        let module = walrus::Module::from_buffer(&wat::parse_str(text).unwrap()).unwrap();
        fork_instrument::instrument::detect_thread_entry_abi(&module)
    };
    assert_eq!(abi(PLAIN), ThreadEntryAbi::Plain);
    assert_eq!(abi(FPCAST), ThreadEntryAbi::FpcastEmu { params: 3 });
    assert_eq!(abi(STATIC_ROOT), ThreadEntryAbi::Plain, "no function table at all");
}

#[test]
fn a_guest_calls_its_own_start_routines_and_fills_its_own_roots() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-fork-guest-entry-shims-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create fixture directory");
    fs::write(directory.join("plain.wasm"), instrumented(PLAIN)).unwrap();
    fs::write(directory.join("fpcast.wasm"), instrumented(FPCAST)).unwrap();
    fs::write(directory.join("root.wasm"), instrumented(STATIC_ROOT)).unwrap();
    fs::write(directory.join("test.mjs"), TEST_MJS).unwrap();
    let result = Command::new("node")
        .arg("--experimental-wasm-exnref")
        .arg(directory.join("test.mjs"))
        .output()
        .expect("run Node guest-shim test");
    let _ = fs::remove_dir_all(&directory);
    assert!(
        result.status.success(),
        "Node guest-shim test failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr),
    );
}

const TEST_MJS: &str = r#"
import { readFileSync } from "node:fs";

function load(name, merged) {
  const module = new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
  const imports = {};
  for (const d of WebAssembly.Module.imports(module)) {
    const ns = imports[d.module] ??= {};
    if (d.kind === "function") ns[d.name] = () => 0;
    else if (d.kind === "table") {
      if (d.name === "__wpk_fork_static_root_catalog") {
        ns[d.name] = merged ?? new WebAssembly.Table({ element: "anyref", initial: 0 });
      }
      else ns[d.name] = new WebAssembly.Table({
        element: d.name === "__wpk_fork_ref_gc_transit" ? "anyref" : "anyfunc",
        initial: 64,
      });
    } else if (d.kind === "global") {
      ns[d.name] = d.name === "__wpk_fork_module_state_table_generation_addr"
        ? new WebAssembly.Global({ value: "i64", mutable: false }, 0n)
        : new WebAssembly.Global({ value: "i32", mutable: false }, 0);
    } else if (d.kind === "tag") ns[d.name] = new WebAssembly.Tag({ parameters: [] });
    else throw new Error(`unexpected import ${d.module}.${d.name}`);
  }
  const instance = new WebAssembly.Instance(module, imports);
  // Instrumentation turns active segments passive; the bootstrap places them,
  // as every host calls it straight after instantiation.
  instance.exports.wpk_fork_module_bootstrap();
  return instance;
}

function expect(what, actual, expected) {
  if (actual !== expected) throw new Error(`${what}: got ${actual}, expected ${expected}`);
}

// --- Thread entry, both conventions, one signature --------------------------
for (const name of ["plain.wasm", "fpcast.wasm"]) {
  const instance = load(name);
  const entry = instance.exports.wpk_fork_thread_entry;
  if (typeof entry !== "function") throw new Error(`${name}: no wpk_fork_thread_entry`);
  // wasm32: `(i32 table_index, i32 arg) -> i32` whatever the table holds.
  expect(`${name} entry(0, 41)`, entry(0, 41), 42);
  // A pointer above 2^31 survives the i64 round trip under fpcast-emu:
  // 0xfffffffe + 1 is 0xffffffff, which is -1 as an i32.
  expect(`${name} entry(0, 0xfffffffe)`, entry(0, 0xfffffffe | 0), -1);
  if (typeof instance.exports.wpk_fork_resume_thread !== "function") {
    throw new Error(`${name}: no wpk_fork_resume_thread`);
  }
}

// --- Every guest imports the merged catalog; only one with roots fills it --
for (const name of ["plain.wasm", "fpcast.wasm"]) {
  const module = new WebAssembly.Module(readFileSync(new URL(name, import.meta.url)));
  const imports = WebAssembly.Module.imports(module).map((d) => `${d.module}.${d.name}`);
  if (!imports.includes("env.__wpk_fork_static_root_catalog")) {
    throw new Error(`${name}: does not import the merged static-root catalog`);
  }
  const exports = WebAssembly.Module.exports(module).map((d) => d.name);
  if (exports.includes("__wpk_fork_static_root_fill")) {
    throw new Error(`${name}: has no roots but exports a fill shim`);
  }
}

// --- Static-root fill: identity, and a refusal instead of a trap ------------
{
  const merged = new WebAssembly.Table({ element: "anyref", initial: 4 });
  const instance = load("root.wasm", merged);
  instance.exports.__wpk_fork_static_root_harvest();
  const own = instance.exports.__wpk_fork_static_root_catalog;
  expect("own catalog length", own.length, 1);
  const fill = instance.exports.__wpk_fork_static_root_fill;
  if (typeof fill !== "function") throw new Error("no __wpk_fork_static_root_fill");
  expect("fill(2)", fill(2), 1);
  // IDENTITY: the very object the guest's global holds, not a copy.
  if (merged.get(2) !== instance.exports.root.value) {
    throw new Error("merged[2] is not the guest's static root");
  }
  expect("merged[1] untouched", merged.get(1), null);
  expect("merged[3] untouched", merged.get(3), null);
  // base 4 on a 4-slot table: the placement and the guest disagree.
  expect("fill(4) on a short table", fill(4), -1);
  expect("fill(-1) never wraps", fill(-1), -1);
}

console.log("ok");
"#;
