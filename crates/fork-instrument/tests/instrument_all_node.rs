//! `--instrument-all` must complete a fork, exactly as the default closure does.
//!
//! The closure is discovered by walking a seed's callers, so an import enters
//! it only by being a seed itself. Seeding every local function without the
//! ordinary boundary seeds left `kernel.kernel_fork` outside the closure, its
//! call site carried no unwind transport, and the import returned its
//! ignored-during-unwind result straight to the guest, which read it as the
//! child. This test drives one capture and one replay per mode and requires
//! both modes to produce the same frames and the same replayed result.

use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::{Options, instrument};

/// Fork at the bottom of a nested chain so replay restores more than one
/// activation, then report through memory rather than an exported result.
const NESTED_FORK: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (memory (export "memory") 4)

      (func $level3 (result i32)
        call $fork)

      (func $level2 (result i32)
        call $level3
        i32.const 1
        i32.add)

      (func $level1 (result i32)
        call $level2
        i32.const 10
        i32.add)

      (func (export "run")
        i32.const 4096
        call $level1
        i32.store))
"#;

const DRIVER: &str = r#"
import { readFileSync } from "node:fs";

const ROOT = 0x10000;
const RESULT_ADDRESS = 4096;
const CHILD_FORK_RESULT = 7;

function importsFor(module, role) {
  const imports = {};
  for (const descriptor of WebAssembly.Module.imports(module)) {
    const namespace = imports[descriptor.module] ??= {};
    switch (descriptor.kind) {
      case "function":
        namespace[descriptor.name] = (...args) => role(descriptor, args);
        break;
      case "table":
        namespace[descriptor.name] = new WebAssembly.Table({
          element: descriptor.name === "__wpk_fork_ref_gc_transit"
            ? "anyref"
            : "anyfunc",
          initial: 64,
        });
        break;
      case "global":
        namespace[descriptor.name] =
          descriptor.name === "__wpk_fork_module_state_table_generation_addr"
            ? new WebAssembly.Global({ value: "i64", mutable: false }, 0n)
            : new WebAssembly.Global({ value: "i32", mutable: false }, 0);
        break;
      case "tag":
        namespace[descriptor.name] = new WebAssembly.Tag({ parameters: [] });
        break;
      default:
        throw new Error(
          `unexpected import ${descriptor.module}.${descriptor.name}`,
        );
    }
  }
  return imports;
}

function captureAndReplay(path) {
  const module = new WebAssembly.Module(readFileSync(path));
  const frames = [];
  let nextPayload = 0x30000;

  let parent;
  parent = new WebAssembly.Instance(module, importsFor(module, (descriptor, args) => {
    if (descriptor.name === "__wpk_fork_frame_reserve") {
      const payload = nextPayload;
      nextPayload += (Number(args[0]) + 15) & ~15;
      frames.push({ payload, size: Number(args[0]) });
      return payload;
    }
    if (descriptor.name === "__wpk_fork_frame_commit") return;
    if (descriptor.name === "__wpk_fork_frame_next") {
      throw new Error("capture must not consume a replay frame");
    }
    if (descriptor.module === "kernel" && descriptor.name === "kernel_fork") {
      if (parent.exports.wpk_fork_state() !== 0) {
        throw new Error("fork import reached outside NORMAL during capture");
      }
      parent.exports.wpk_fork_unwind_begin(ROOT);
      return 0;
    }
    return 0;
  }));

  let transported = false;
  try {
    parent.exports.run();
  } catch (error) {
    if (!(error instanceof WebAssembly.Exception)) throw error;
    transported = true;
  }
  if (!transported) {
    throw new Error("the fork call site did not transport a private unwind");
  }
  if (parent.exports.wpk_fork_state() !== 1) {
    throw new Error(`capture ended in state ${parent.exports.wpk_fork_state()}`);
  }
  parent.exports.wpk_fork_unwind_end();

  let child;
  let consumed = 0;
  child = new WebAssembly.Instance(module, importsFor(module, (descriptor, args) => {
    if (descriptor.name === "__wpk_fork_frame_next") {
      if (consumed >= frames.length) {
        throw new Error("replay consumed more frames than capture recorded");
      }
      // Capture commits leaf to root; replay rebuilds root to leaf.
      const frame = frames[frames.length - 1 - consumed++];
      if (frame.size !== Number(args[0])) {
        throw new Error(
          `replay expected a ${Number(args[0])}-byte frame, got ${frame.size}`,
        );
      }
      return frame.payload;
    }
    if (descriptor.name === "__wpk_fork_frame_reserve") {
      throw new Error("replay must not reserve a continuation frame");
    }
    if (descriptor.name === "__wpk_fork_frame_commit") {
      throw new Error("replay must not commit a continuation frame");
    }
    if (descriptor.module === "kernel" && descriptor.name === "kernel_fork") {
      if (child.exports.wpk_fork_state() !== 2) {
        throw new Error("replay reached fork outside REWINDING");
      }
      child.exports.wpk_fork_rewind_end();
      return CHILD_FORK_RESULT;
    }
    return 0;
  }));
  new Uint8Array(child.exports.memory.buffer)
    .set(new Uint8Array(parent.exports.memory.buffer));
  child.exports.wpk_fork_rewind_begin(ROOT);
  child.exports.run();
  if (consumed !== frames.length) {
    throw new Error(`replay consumed ${consumed}/${frames.length} frames`);
  }
  return {
    frames: frames.length,
    result: new DataView(child.exports.memory.buffer)
      .getInt32(RESULT_ADDRESS, true),
  };
}

const modes = ["default", "instrument-all"].map((mode) => ({
  mode,
  ...captureAndReplay(new URL(`./${mode}.wasm`, import.meta.url)),
}));
for (const { mode, frames, result } of modes) {
  if (result !== CHILD_FORK_RESULT + 1 + 10) {
    throw new Error(`${mode}: replay produced ${result}`);
  }
  if (frames !== 4) {
    throw new Error(`${mode}: capture recorded ${frames} activation frames`);
  }
}
"#;

#[test]
fn instrument_all_captures_and_replays_the_same_fork_as_the_default_closure() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-instrument-all-fork-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create fixture directory");

    let input = wat::parse_str(NESTED_FORK).expect("parse nested fork fixture");
    for (name, instrument_all) in [("default", false), ("instrument-all", true)] {
        let opts = Options {
            instrument_all,
            ..Options::default()
        };
        fs::write(
            directory.join(format!("{name}.wasm")),
            instrument(&input, &opts).unwrap_or_else(|error| panic!("instrument {name}: {error}")),
        )
        .unwrap_or_else(|error| panic!("write {name} fixture: {error}"));
    }
    fs::write(directory.join("test.mjs"), DRIVER).expect("write Node driver");

    let output = Command::new("node")
        .arg(directory.join("test.mjs"))
        .output()
        .expect("run Node");
    let _ = fs::remove_dir_all(&directory);
    assert!(
        output.status.success(),
        "Node instrument-all fork test failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}
