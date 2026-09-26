//! Frame slots survive capture and replay through the shared frame helpers.
//!
//! # Why this test runs in Node rather than asserting on the IR
//!
//! Instrumented bodies move their frame slots through shared
//! `__wpk_fork_frame_io_*` helpers, one call per run of consecutive
//! same-typed slots. What matters is that every slot comes back holding
//! exactly the value it held at the fork: runs split at the helper length
//! limit, change type mid-frame, include parameters, and cover every scalar
//! value type. A wrong run base, element offset, or restore order would
//! silently swap or shift values, which only a real capture and replay can
//! observe. So this captures a parent activation in Node, copies its memory
//! into a fresh child instance, replays, and checks every value the child
//! observes after the fork.

use std::{
    fmt::Write as _,
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::{Options, instrument};

/// One frame-backed local of the fixture and the value it holds at the fork.
struct Slot {
    ty: &'static str,
    value: String,
}

/// Locals chosen to exercise run planning: a run longer than the helper
/// limit (so it splits), type changes in the middle of the frame, runs of
/// every scalar type, and single-slot runs.
fn slots() -> Vec<Slot> {
    let mut slots = Vec::new();
    for index in 0..20 {
        slots.push(Slot {
            ty: "i32",
            value: format!("{}", 1000 + index * 7),
        });
    }
    for (ty, value) in [
        ("i64", "81985529216486895"),
        ("f32", "1.5"),
        ("f64", "-2.25"),
        ("i32", "-17"),
        ("i64", "-9"),
        ("i64", "4294967297"),
        ("f64", "3.125"),
        ("f64", "6.5"),
        ("f32", "-0.75"),
        ("i32", "42"),
    ] {
        slots.push(Slot {
            ty,
            value: value.to_string(),
        });
    }
    slots
}

/// A fork-path function whose parameters and locals are all live across the
/// fork; after the fork it writes each one to its own 8-byte cell at 4096.
fn fixture(memory64: bool) -> String {
    let slots = slots();
    let (memory, address) = if memory64 {
        ("(memory (export \"memory\") i64 8)", "i64.const")
    } else {
        ("(memory (export \"memory\") 8)", "i32.const")
    };
    // The first two slots are parameters so parameter frame slots are covered.
    let params = &slots[..2];
    let locals = &slots[2..];
    let mut wat = String::new();
    writeln!(
        wat,
        "(module\n  (import \"kernel\" \"kernel_fork\" (func $fork (result i32)))\n  {memory}"
    )
    .unwrap();
    write!(wat, "  (func $work").unwrap();
    for (index, slot) in params.iter().enumerate() {
        write!(wat, " (param $s{index} {})", slot.ty).unwrap();
    }
    for (index, slot) in locals.iter().enumerate() {
        write!(wat, " (local $s{} {})", index + params.len(), slot.ty).unwrap();
    }
    writeln!(wat).unwrap();
    for (index, slot) in locals.iter().enumerate() {
        writeln!(
            wat,
            "    {}.const {}\n    local.set $s{}",
            slot.ty,
            slot.value,
            index + params.len()
        )
        .unwrap();
    }
    writeln!(wat, "    call $fork\n    drop").unwrap();
    for (index, slot) in slots.iter().enumerate() {
        writeln!(
            wat,
            "    {address} {}\n    local.get $s{index}\n    {}.store",
            4096 + index * 8,
            slot.ty
        )
        .unwrap();
    }
    writeln!(wat, "  )").unwrap();
    write!(wat, "  (func (export \"run\")").unwrap();
    for slot in params {
        write!(wat, " {}.const {}", slot.ty, slot.value).unwrap();
    }
    writeln!(wat, " call $work))").unwrap();
    wat
}

fn expectations() -> String {
    slots()
        .iter()
        .map(|slot| format!("{} {}", slot.ty, slot.value))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn every_frame_slot_survives_capture_and_replay() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("kandelo-frame-io-{}-{nonce}", std::process::id(),));
    fs::create_dir(&directory).expect("create fixture directory");
    for (name, memory64) in [("wasm32", false), ("wasm64", true)] {
        let input = wat::parse_str(fixture(memory64))
            .unwrap_or_else(|error| panic!("parse {name} fixture: {error}"));
        let output = instrument(&input, &Options::default())
            .unwrap_or_else(|error| panic!("instrument {name} fixture: {error:#}"));
        fs::write(directory.join(format!("{name}.wasm")), output)
            .unwrap_or_else(|error| panic!("write {name} fixture: {error}"));
    }
    fs::write(directory.join("expect.txt"), expectations()).expect("write expectations");
    fs::write(directory.join("test.mjs"), FRAME_IO_TEST_MJS).expect("write Node test");

    let output = Command::new("node")
        .arg(directory.join("test.mjs"))
        .output()
        .expect("run Node");
    let _ = fs::remove_dir_all(&directory);
    assert!(
        output.status.success(),
        "Node frame I/O capture/replay failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

const FRAME_IO_TEST_MJS: &str = r#"
import { readFileSync } from "node:fs";

const expected = readFileSync(new URL("./expect.txt", import.meta.url), "utf8")
  .trim().split("\n").map((line) => line.split(" "));

function importsFor(module, call) {
  const imports = {};
  for (const descriptor of WebAssembly.Module.imports(module)) {
    const namespace = imports[descriptor.module] ??= {};
    switch (descriptor.kind) {
      case "table":
        namespace[descriptor.name] = new WebAssembly.Table({
          element: descriptor.name === "__wpk_fork_ref_gc_transit" ? "anyref" : "anyfunc",
          initial: 16,
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
      case "function":
        namespace[descriptor.name] = (...args) => call(descriptor, args);
        break;
      default:
        throw new Error(`unexpected import ${descriptor.module}.${descriptor.name}`);
    }
  }
  return imports;
}

function captureAndReplay(name) {
  const module = new WebAssembly.Module(
    readFileSync(new URL(`./${name}.wasm`, import.meta.url)),
  );
  const wide = name === "wasm64";
  const ptr = (value) => (wide ? BigInt(value) : value);
  const root = 0x10000;
  let nextPayload = 0x30000;
  const frames = [];

  let parent;
  parent = new WebAssembly.Instance(module, importsFor(module, (descriptor, args) => {
    switch (descriptor.name) {
      case "__wpk_fork_frame_reserve": {
        const size = Number(args[0]);
        const payload = nextPayload;
        nextPayload += (size + 15) & ~15;
        frames.push({ payload, size });
        return ptr(payload);
      }
      case "__wpk_fork_frame_commit":
        return;
      case "kernel_fork":
        parent.exports.wpk_fork_unwind_begin(ptr(root));
        return 0;
      default:
        throw new Error(`parent capture called ${descriptor.name}`);
    }
  }));
  try {
    parent.exports.run();
    throw new Error("parent returned instead of unwinding");
  } catch (error) {
    if (!(error instanceof WebAssembly.Exception)) throw error;
  }
  if (parent.exports.wpk_fork_state() !== 1) throw new Error("parent did not unwind");
  if (frames.length !== 2) throw new Error(`expected two frames, got ${frames.length}`);
  parent.exports.wpk_fork_unwind_end();

  let child;
  let nextFrame = 0;
  child = new WebAssembly.Instance(module, importsFor(module, (descriptor, args) => {
    switch (descriptor.name) {
      case "__wpk_fork_frame_next": {
        // Capture commits innermost first; replay enters outermost first.
        const frame = frames[frames.length - 1 - nextFrame++];
        if (!frame) throw new Error("child requested an unexpected frame");
        if (frame.size !== Number(args[0])) {
          throw new Error(`frame size ${Number(args[0])} != captured ${frame.size}`);
        }
        return ptr(frame.payload);
      }
      case "__wpk_fork_resume_peek":
        return 0;
      case "kernel_fork":
        if (child.exports.wpk_fork_state() !== 2) throw new Error("child not replaying");
        child.exports.wpk_fork_rewind_end();
        return 0;
      default:
        throw new Error(`child replay called ${descriptor.name}`);
    }
  }));
  new Uint8Array(child.exports.memory.buffer).set(
    new Uint8Array(parent.exports.memory.buffer),
  );
  // Poison the result cells so a value the child never wrote cannot pass.
  new Uint8Array(child.exports.memory.buffer, 4096, expected.length * 8).fill(0xa5);
  child.exports.wpk_fork_rewind_begin(ptr(root));
  child.exports.run();
  if (nextFrame !== frames.length) {
    throw new Error(`child consumed ${nextFrame}/${frames.length} frames`);
  }

  const view = new DataView(child.exports.memory.buffer);
  expected.forEach(([ty, text], index) => {
    const at = 4096 + index * 8;
    let actual, want;
    switch (ty) {
      case "i32": actual = view.getInt32(at, true); want = Number(text); break;
      case "i64": actual = view.getBigInt64(at, true); want = BigInt(text); break;
      case "f32": actual = view.getFloat32(at, true); want = Math.fround(Number(text)); break;
      case "f64": actual = view.getFloat64(at, true); want = Number(text); break;
    }
    if (actual !== want) {
      throw new Error(`${name}: slot ${index} (${ty}) replayed ${actual}, expected ${want}`);
    }
  });
}

captureAndReplay("wasm32");
captureAndReplay("wasm64");
"#;
