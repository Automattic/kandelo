//! Scratch-frame spill coverage: a caller whose per-call argument and
//! carryover spills exceed `SCRATCH_SPILL_THRESHOLD_BYTES` routes them
//! through a shadow-stack scratch region instead of declared locals.
//! This test proves, on real executed wasm:
//!
//! 1. the instrumented caller does not redeclare one local per spill
//!    (the Liftoff frame-size lever this transform exists for);
//! 2. NORMAL execution round-trips values through scratch correctly and
//!    releases the shadow-stack reservation on every return;
//! 3. UNWIND publishes the same node payload bytes the local-based shape
//!    produced (spill values land at their assigned frame offsets);
//! 4. a fresh child instance replays the continuation from those nodes
//!    (preamble node→scratch copy + scratch-based arg/carryover reloads)
//!    and resumes at the fork call site with the correct state.
//!
//! The callee keeps a below-threshold shape on purpose so the mixed
//! Locals/Scratch mode interaction is exercised in one continuation.

use std::{
    fmt::Write as _,
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::{Options, instrument};

/// One i64 argument is 8 payload bytes; 33 arguments plus one i64
/// carryover put the caller's spill region at 272 bytes — above the
/// 256-byte scratch threshold. Values are loaded from linear memory so
/// the pure-tail materializer cannot replay them without spill storage.
const N_ARGS: usize = 33;
/// Where the Node driver seeds the input values.
const INPUT_BASE: usize = 0x1000;
/// Where the fixture publishes its final result (clear of the inputs).
const RESULT_ADDR: usize = 512;

fn scratch_fixture() -> String {
    let mut params = String::new();
    let mut gets = String::new();
    let mut adds = String::new();
    let mut args = String::new();
    for i in 0..N_ARGS {
        write!(params, " (param $p{i} i64)").unwrap();
        writeln!(gets, "    local.get $p{i}").unwrap();
        if i > 0 {
            writeln!(adds, "    i64.add").unwrap();
        }
        writeln!(
            args,
            "    (i64.load (i32.const {}))",
            INPUT_BASE + 8 * i
        )
        .unwrap();
    }
    format!(
        r#"
(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (memory (export "memory") 8)
  (global (export "__stack_pointer") (mut i32) (i32.const 32768))

  ;; Below-threshold fork-path callee: stays in the local-based shape.
  (func $work{params} (result i64)
{gets}{adds}
    call $fork
    i64.extend_i32_s
    i64.add)

  (func (export "run") (result i64)
    ;; i64 carryover pushed before the call and consumed after it.
    (i64.load (i32.const {carry_addr}))
{args}    call $work
    i64.add
    local.set $total
    (i64.store (i32.const {result_addr}) (local.get $total))
    local.get $total))
"#,
        carry_addr = INPUT_BASE + 8 * N_ARGS,
        result_addr = RESULT_ADDR,
    )
    .replace(
        "(func (export \"run\") (result i64)",
        "(func (export \"run\") (result i64) (local $total i64)",
    )
}

/// Count the declared (non-parameter) locals of the function exported as
/// `run` in the emitted binary.
fn declared_locals_of_run(bytes: &[u8]) -> u32 {
    use wasmparser::{Parser, Payload};
    let mut imported_funcs = 0u32;
    let mut run_index: Option<u32> = None;
    let mut code_index = 0u32;
    let mut result: Option<u32> = None;
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.expect("parse instrumented module") {
            Payload::ImportSection(reader) => {
                for imports in reader {
                    for import in imports.expect("imports entry") {
                        let (_offset, import) = import.expect("import entry");
                        if matches!(import.ty, wasmparser::TypeRef::Func(_)) {
                            imported_funcs += 1;
                        }
                    }
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export = export.expect("export entry");
                    if export.name == "run"
                        && export.kind == wasmparser::ExternalKind::Func
                    {
                        run_index = Some(export.index);
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                let func_index = imported_funcs + code_index;
                code_index += 1;
                if Some(func_index) == run_index {
                    let mut locals = 0u32;
                    for decl in body.get_locals_reader().expect("locals reader") {
                        let (count, _ty) = decl.expect("local decl");
                        locals += count;
                    }
                    result = Some(locals);
                }
            }
            _ => {}
        }
    }
    result.expect("exported run function has a code entry")
}

#[test]
fn scratch_spill_caller_roundtrips_capture_and_replay() {
    let input = wat::parse_str(scratch_fixture()).expect("parse scratch fixture");
    let output = instrument(&input, &Options::default()).expect("instrument scratch fixture");

    // The lever itself: without scratch storage the caller redeclares one
    // local per argument/carryover spill (≥ 34 on top of its own local).
    // With scratch storage the count stays a small constant (base + one
    // tmp per width + user local + instrumenter incidentals).
    let run_locals = declared_locals_of_run(&output);
    assert!(
        run_locals < N_ARGS as u32,
        "scratch mode must not declare one local per spill; \
         run declares {run_locals} locals for {N_ARGS} spilled arguments"
    );

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-fork-scratch-spill-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create scratch fixture directory");
    fs::write(directory.join("fixture.wasm"), output).expect("write scratch fixture");
    fs::write(
        directory.join("test.mjs"),
        format!(
            r#"
import {{ readFileSync }} from "node:fs";

const N_ARGS = {N_ARGS};
const INPUT_BASE = {INPUT_BASE};
const RESULT_ADDR = {RESULT_ADDR};
const ROOT = 0x10000;
const SP_INIT = 32768n;

const module = new WebAssembly.Module(
  readFileSync(new URL("./fixture.wasm", import.meta.url)),
);

function importsFor(role) {{
  const imports = {{}};
  for (const descriptor of WebAssembly.Module.imports(module)) {{
    const namespace = imports[descriptor.module] ??= {{}};
    switch (descriptor.kind) {{
      case "table":
        namespace[descriptor.name] = new WebAssembly.Table({{
          element: descriptor.name === "__wpk_fork_ref_gc_transit"
            ? "anyref"
            : "anyfunc",
          initial: 1024,
        }});
        break;
      case "global":
        namespace[descriptor.name] = new WebAssembly.Global(
          descriptor.name === "__wpk_fork_module_state_table_generation_addr"
            ? {{ value: "i64", mutable: false }}
            : {{ value: "i32", mutable: false }},
          descriptor.name === "__wpk_fork_module_state_table_generation_addr"
            ? 0n
            : 0,
        );
        break;
      case "tag":
        namespace[descriptor.name] = new WebAssembly.Tag({{ parameters: [] }});
        break;
      case "function":
        namespace[descriptor.name] = (...args) => role.call(descriptor, args);
        break;
      default:
        throw new Error(`unexpected import kind ${{descriptor.kind}}`);
    }}
  }}
  return imports;
}}

function seedInputs(memory) {{
  const view = new DataView(memory.buffer);
  let expected = 0n;
  for (let i = 0; i <= N_ARGS; i++) {{
    // Distinct, sign-bit-exercising values; index N_ARGS is the carryover.
    const value = (BigInt(i + 1) * 0x0101010101n) ^ 0x8000000000000000n;
    view.setBigUint64(INPUT_BASE + 8 * i, value, true);
    expected = BigInt.asIntN(64, expected + BigInt.asIntN(64, value));
  }}
  return expected; // sum of args + carryover (fork result added separately)
}}

function spValue(instance) {{
  return BigInt(instance.exports.__stack_pointer.value);
}}

// ---------------------------------------------------------------
// Phase 1: NORMAL execution — values round-trip through scratch,
// and the shadow-stack reservation is released on return (twice,
// to catch cursor drift).
// ---------------------------------------------------------------
{{
  let instance;
  const role = {{
    call(descriptor) {{
      if (descriptor.module === "kernel" && descriptor.name === "kernel_fork") {{
        if (spValue(instance) >= SP_INIT) {{
          throw new Error("caller scratch reservation missing at fork time");
        }}
        return 42;
      }}
      if (descriptor.name.startsWith("__wpk_fork_frame_")) {{
        throw new Error(`normal execution must not touch frames: ${{descriptor.name}}`);
      }}
      return 0;
    }},
  }};
  instance = new WebAssembly.Instance(module, importsFor(role));
  const expectedSum = seedInputs(instance.exports.memory);
  for (let round = 0; round < 2; round++) {{
    const result = instance.exports.run();
    const expected = BigInt.asIntN(64, expectedSum + 42n);
    if (result !== expected) {{
      throw new Error(`normal round ${{round}}: got ${{result}}, expected ${{expected}}`);
    }}
    if (spValue(instance) !== SP_INIT) {{
      throw new Error(
        `shadow stack drifted after round ${{round}}: SP=${{spValue(instance)}}`,
      );
    }}
  }}
}}

// ---------------------------------------------------------------
// Phase 2: capture — unwind publishes the spill values into the
// committed node payloads at their assigned frame offsets.
// ---------------------------------------------------------------
const frames = [];
let nextPayload = 0x30000;
let parent;
const parentRole = {{
  call(descriptor, args) {{
    if (descriptor.name === "__wpk_fork_frame_reserve") {{
      const payload = nextPayload;
      nextPayload += (Number(args[0]) + 15) & ~15;
      frames.push({{ payload, size: Number(args[0]) }});
      return payload;
    }}
    if (descriptor.name === "__wpk_fork_frame_commit") return 0;
    if (descriptor.name === "__wpk_fork_frame_next") {{
      throw new Error("parent capture must not enter replay");
    }}
    if (descriptor.module === "kernel" && descriptor.name === "kernel_fork") {{
      parent.exports.wpk_fork_unwind_begin(ROOT);
      return 0;
    }}
    return 0;
  }},
}};
parent = new WebAssembly.Instance(module, importsFor(parentRole));
const expectedSum = seedInputs(parent.exports.memory);
try {{
  parent.exports.run();
}} catch (error) {{
  if (!(error instanceof WebAssembly.Exception)) throw error;
}}
if (parent.exports.wpk_fork_state() !== 1) {{
  throw new Error("fixture did not unwind from fork");
}}
if (frames.length !== 2) {{
  throw new Error(`expected callee+caller frames, got ${{frames.length}}`);
}}
// frames[0] is the callee (leaf commits first); frames[1] is the caller.
const callerFrame = frames[1];
const view = new DataView(parent.exports.memory.buffer);
// Caller payload: 16-byte header, one 8-byte user scalar ($total), then
// the arg spills in call order, then the carryover — the same offsets
// assign_local_offsets gives the local-based shape.
for (let i = 0; i <= N_ARGS; i++) {{
  const got = view.getBigUint64(callerFrame.payload + 24 + 8 * i, true);
  const want = view.getBigUint64(INPUT_BASE + 8 * i, true);
  if (got !== want) {{
    throw new Error(
      `caller frame slot ${{i}}: node payload holds ${{got}}, expected ${{want}}`,
    );
  }}
}}
parent.exports.wpk_fork_unwind_end();

// ---------------------------------------------------------------
// Phase 3: fresh-child replay — node→scratch preamble copy feeds the
// scratch-based arg/carryover reloads and resumes at the fork site.
// ---------------------------------------------------------------
let child;
let served = 0;
const childRole = {{
  call(descriptor) {{
    if (descriptor.name === "__wpk_fork_frame_next") {{
      // The committed chain replays outermost-first: caller, then callee.
      const frame = frames[frames.length - 1 - served++];
      if (!frame) throw new Error("child requested an unexpected frame");
      return frame.payload;
    }}
    if (descriptor.name === "__wpk_fork_frame_reserve") {{
      throw new Error("child replay must not reserve a continuation frame");
    }}
    if (descriptor.name === "__wpk_fork_frame_commit") {{
      throw new Error("child replay must not commit a continuation frame");
    }}
    if (descriptor.module === "kernel" && descriptor.name === "kernel_fork") {{
      if (child.exports.wpk_fork_state() !== 2) {{
        throw new Error("child did not reach fork while replaying");
      }}
      child.exports.wpk_fork_rewind_end();
      return 7;
    }}
    return 0;
  }},
}};
child = new WebAssembly.Instance(module, importsFor(childRole));
new Uint8Array(child.exports.memory.buffer)
  .set(new Uint8Array(parent.exports.memory.buffer));
child.exports.wpk_fork_rewind_begin(ROOT);
const replayResult = child.exports.run();
if (served !== frames.length) {{
  throw new Error(`child consumed ${{served}}/${{frames.length}} frames`);
}}
const expectedReplay = BigInt.asIntN(64, expectedSum + 7n);
if (replayResult !== expectedReplay) {{
  throw new Error(`replay returned ${{replayResult}}, expected ${{expectedReplay}}`);
}}
const stored = new DataView(child.exports.memory.buffer)
  .getBigUint64(RESULT_ADDR, true);
if (stored !== BigInt.asUintN(64, expectedReplay)) {{
  throw new Error(`replay stored ${{stored}} at RESULT_ADDR, expected ${{expectedReplay}}`);
}}
console.log("scratch spill roundtrip ok");
"#,
        ),
    )
    .expect("write Node test");

    let result = Command::new("node")
        .arg(directory.join("test.mjs"))
        .output()
        .expect("run node");
    let stdout = String::from_utf8_lossy(&result.stdout);
    let stderr = String::from_utf8_lossy(&result.stderr);
    assert!(
        result.status.success() && stdout.contains("scratch spill roundtrip ok"),
        "scratch roundtrip failed\nstdout: {stdout}\nstderr: {stderr}",
    );
    fs::remove_dir_all(&directory).ok();
}
