use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::{Options, instrument};

const MULTI_RESULT_REFERENCE_ABORT: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (memory (export "memory") 4)

      ;; The scalar below the fork result is a real operand-stack carryover.
      ;; Returning externref as a second result also exercises a result-typed
      ;; private-tag boundary without requiring a synthetic result local.
      (func $callee (result i32 externref)
        i32.const 100
        call $fork
        i32.add
        ref.null extern)

      (func (export "run") (result i32 externref)
        call $callee))
"#;

#[test]
fn synchronous_frame_reserve_failure_restarts_live_activation_without_selector_local() {
    let input = wat::parse_str(MULTI_RESULT_REFERENCE_ABORT).expect("parse abort fixture");
    let output = instrument(&input, &Options::default()).expect("instrument abort fixture");

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-fork-abort-restart-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create abort fixture directory");
    fs::write(directory.join("fixture.wasm"), output).expect("write abort fixture");
    fs::write(
        directory.join("test.mjs"),
        r#"
import { readFileSync } from "node:fs";

const module = new WebAssembly.Module(
  readFileSync(new URL("./fixture.wasm", import.meta.url)),
);
const imports = {};
let instance;
let reserveCalls = 0;
let frameNextCalls = 0;
let frameCommitCalls = 0;
let forkCalls = 0;
const root = 0x10000;

function hostCall(descriptor, args) {
  if (descriptor.name === "__wpk_fork_frame_reserve") {
    reserveCalls += 1;
    if (instance.exports.wpk_fork_state() !== 1) {
      throw new Error("frame reserve did not run during unwind");
    }
    // This models the host's synchronous allocation-failure contract: replay
    // cursors and ABORT_UNWINDING state are ready before zero is returned.
    instance.exports.wpk_fork_abort_begin(root);
    if (instance.exports.wpk_fork_state() !== 3) {
      throw new Error("abort replay was not established synchronously");
    }
    return 0;
  }
  if (descriptor.name === "__wpk_fork_frame_next") {
    frameNextCalls += 1;
    throw new Error("live abort restart must not consume a replay frame");
  }
  if (descriptor.name === "__wpk_fork_frame_commit") {
    frameCommitCalls += 1;
    throw new Error("failed reservation must not commit a continuation frame");
  }
  if (descriptor.name === "__wpk_fork_resume_peek") {
    return 0;
  }
  if (
    descriptor.module === "kernel"
    && descriptor.name === "kernel_fork"
  ) {
    forkCalls += 1;
    const state = instance.exports.wpk_fork_state();
    if (state === 0) {
      instance.exports.wpk_fork_unwind_begin(root);
      return 0;
    }
    if (state === 3) {
      instance.exports.wpk_fork_abort_end();
      return 7;
    }
    throw new Error(`kernel_fork observed unexpected state ${state}`);
  }
  // No reference/module-state codec import is live in this fixture.
  return 0;
}

for (const descriptor of WebAssembly.Module.imports(module)) {
  const namespace = imports[descriptor.module] ??= {};
  switch (descriptor.kind) {
    case "function":
      namespace[descriptor.name] = (...args) => hostCall(descriptor, args);
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
        `unexpected import ${descriptor.module}.${descriptor.name} (${descriptor.kind})`,
      );
  }
}

instance = new WebAssembly.Instance(module, imports);
const result = instance.exports.run();
if (!Array.isArray(result) || result[0] !== 107 || result[1] !== null) {
  throw new Error(`abort restart returned ${JSON.stringify(result)}`);
}
if (instance.exports.wpk_fork_state() !== 0) {
  throw new Error("abort restart did not return the module to NORMAL");
}
if (reserveCalls !== 1 || forkCalls !== 2) {
  throw new Error(
    `expected one failed reserve and two fork entries; got ${reserveCalls}/${forkCalls}`,
  );
}
if (frameNextCalls !== 0 || frameCommitCalls !== 0) {
  throw new Error(
    `failed reserve touched committed frames: next=${frameNextCalls}, commit=${frameCommitCalls}`,
  );
}

// The helper selected the descriptor's header-sized abort scratch and wrote
// callee call-index zero there before restarting the live activation.
const callIndex = new DataView(instance.exports.memory.buffer)
  .getUint32(root + 8 + 4, true);
if (callIndex !== 0) {
  throw new Error(`abort scratch contains call index ${callIndex}, expected 0`);
}
"#,
    )
    .expect("write Node abort test");

    let result = Command::new("node")
        .arg("--experimental-wasm-exnref")
        .arg(directory.join("test.mjs"))
        .output()
        .expect("run Node abort test");
    let _ = fs::remove_dir_all(&directory);
    assert!(
        result.status.success(),
        "Node synchronous-abort restart failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr),
    );
}
