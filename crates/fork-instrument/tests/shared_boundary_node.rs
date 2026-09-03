use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::{Options, instrument};

/// Nine direct fork-path landings put `run` above
/// `SHARED_UNWIND_BOUNDARY_MIN_CALLS`, so every landing catches the private
/// unwind tag to the one shared handler. `$mid` keeps its single landing on
/// the per-site path, so one capture crosses both boundary shapes.
const SHARED_BOUNDARY_FIXTURE: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (memory (export "memory") 4)

      (func $mid (param i32) (result i32)
        local.get 0
        i32.const 5
        i32.eq
        if (result i32)
          call $fork
        else
          local.get 0
        end)

      (func (export "run") (result i32)
        i32.const 1
        call $mid
        i32.const 2
        call $mid
        i32.add
        i32.const 3
        call $mid
        i32.add
        i32.const 4
        call $mid
        i32.add
        i32.const 5
        call $mid
        i32.add
        i32.const 6
        call $mid
        i32.add
        i32.const 7
        call $mid
        i32.add
        i32.const 8
        call $mid
        i32.add
        i32.const 9
        call $mid
        i32.add))
"#;

fn run_node_fixture(test_js: &str, label: &str) {
    let input = wat::parse_str(SHARED_BOUNDARY_FIXTURE).expect("parse shared-boundary fixture");
    let output = instrument(&input, &Options::default()).expect("instrument shared-boundary");

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-fork-shared-boundary-{label}-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create shared-boundary fixture directory");
    fs::write(directory.join("fixture.wasm"), output).expect("write shared-boundary fixture");
    fs::write(directory.join("test.mjs"), test_js).expect("write Node shared-boundary test");

    let result = Command::new("node")
        .arg("--experimental-wasm-exnref")
        .arg(directory.join("test.mjs"))
        .output()
        .expect("run Node shared-boundary test");
    let _ = fs::remove_dir_all(&directory);
    assert!(
        result.status.success(),
        "Node shared-boundary {label} test failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr),
    );
}

const HARNESS_PRELUDE: &str = r#"
import { readFileSync } from "node:fs";

const module = new WebAssembly.Module(
  readFileSync(new URL("./fixture.wasm", import.meta.url)),
);
const imports = {};
let instance;
const root = 0x10000;
let payloadCursor = 0x20000;
const committed = [];
const sizes = new Map();
let reserveCalls = 0;
let frameNextCalls = 0;
let frameCommitCalls = 0;
let forkCalls = 0;
let failReserveAt = 0;
"#;

const HARNESS_IMPORTS: &str = r#"
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
"#;

const HARNESS_HOSTCALL: &str = r#"
function hostCall(descriptor, args) {
  if (descriptor.name === "__wpk_fork_frame_reserve") {
    reserveCalls += 1;
    if (reserveCalls === failReserveAt) {
      instance.exports.wpk_fork_abort_begin(root);
      return 0;
    }
    const size = Number(args[0]);
    const payload = payloadCursor;
    payloadCursor += (size + 7) & ~7;
    sizes.set(payload, size);
    return payload;
  }
  if (descriptor.name === "__wpk_fork_frame_commit") {
    frameCommitCalls += 1;
    committed.push(args[0]);
    return;
  }
  if (descriptor.name === "__wpk_fork_frame_next") {
    frameNextCalls += 1;
    const payload = committed.pop();
    if (payload === undefined) {
      throw new Error("frame_next with no committed frame");
    }
    if (sizes.get(payload) !== Number(args[0])) {
      throw new Error(
        `frame_next size mismatch: recorded ${sizes.get(payload)}, asked ${args[0]}`,
      );
    }
    return payload;
  }
  if (descriptor.name === "__wpk_fork_resume_peek") {
    return 0;
  }
  if (descriptor.module === "kernel" && descriptor.name === "kernel_fork") {
    forkCalls += 1;
    const state = instance.exports.wpk_fork_state();
    if (state === 0) {
      instance.exports.wpk_fork_unwind_begin(root);
      return 0;
    }
    if (state === 2) {
      instance.exports.wpk_fork_rewind_end();
      return 7;
    }
    if (state === 3) {
      instance.exports.wpk_fork_abort_end();
      return 7;
    }
    throw new Error(`kernel_fork observed unexpected state ${state}`);
  }
  return 0;
}
"#;

#[test]
fn shared_boundary_unwinds_and_rewinds_through_the_selected_landing() {
    let test_js = format!(
        r#"{HARNESS_PRELUDE}
{HARNESS_HOSTCALL}
{HARNESS_IMPORTS}

let threw = false;
try {{
  instance.exports.run();
}} catch (error) {{
  threw = true;
}}
if (!threw) {{
  throw new Error("capture must escape run() through the private unwind tag");
}}
if (instance.exports.wpk_fork_state() !== 1) {{
  throw new Error("capture must leave the module UNWINDING");
}}
if (frameCommitCalls !== 2) {{
  throw new Error(`expected mid + run frames committed, got ${{frameCommitCalls}}`);
}}
const runPayload = committed[1];
const callIndex = new DataView(instance.exports.memory.buffer)
  .getUint32(runPayload + 4, true);
if (callIndex !== 4) {{
  throw new Error(`run frame selected call index ${{callIndex}}, expected 4`);
}}

instance.exports.wpk_fork_unwind_end();
instance.exports.wpk_fork_rewind_begin(root);
const result = instance.exports.run();
if (result !== 47) {{
  throw new Error(`replayed run() returned ${{result}}, expected 47`);
}}
if (instance.exports.wpk_fork_state() !== 0) {{
  throw new Error("replay did not return the module to NORMAL");
}}
if (forkCalls !== 2 || frameNextCalls !== 2) {{
  throw new Error(
    `expected two fork entries and two consumed frames; got ${{forkCalls}}/${{frameNextCalls}}`,
  );
}}
"#
    );
    run_node_fixture(&test_js, "rewind");
}

#[test]
fn shared_boundary_abort_restarts_the_live_activation() {
    let test_js = format!(
        r#"{HARNESS_PRELUDE}
{HARNESS_HOSTCALL}
failReserveAt = 2;

{HARNESS_IMPORTS}

const result = instance.exports.run();
if (result !== 47) {{
  throw new Error(`abort restart returned ${{result}}, expected 47`);
}}
if (instance.exports.wpk_fork_state() !== 0) {{
  throw new Error("abort restart did not return the module to NORMAL");
}}
if (reserveCalls !== 2 || frameCommitCalls !== 1) {{
  throw new Error(
    `expected one committed mid frame and one failed run reserve; got ${{reserveCalls}}/${{frameCommitCalls}}`,
  );
}}
if (frameNextCalls !== 1 || forkCalls !== 2) {{
  throw new Error(
    `abort replay must consume the committed mid frame exactly once; got ${{frameNextCalls}}/${{forkCalls}}`,
  );
}}
"#
    );
    run_node_fixture(&test_js, "abort");
}
