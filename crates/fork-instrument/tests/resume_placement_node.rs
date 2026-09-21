//! `__wpk_fork_place_resume_thunks`: the guest applies a placement decision.
//!
//! # Why this test runs in Node rather than asserting on the IR
//!
//! The property that matters is IDENTITY -- the resume table must end up
//! holding, at each named slot, the very funcref the guest's own catalog holds
//! at that ordinal. An IR assertion can only say that a `table.get`/`table.set`
//! pair was emitted against two table ids; it cannot say that the value which
//! arrives is the same object. A funcref that is merely EQUAL (same type, same
//! body, different instance) would resume into another activation's thunk and
//! trap nothing, which is exactly the failure
//! `host/src/fork-resume-table.ts` documents at census 194.
//!
//! So this instantiates the instrumented module for real, places thunks
//! through the new export, and compares `resumeTable.get(slot)` against
//! `catalog.get(ordinal)` with `===`. The JS API hands back the same function
//! object for the same wasm function, which is what makes the comparison
//! meaningful.
//!
//! # Bounds are wasm's own
//!
//! There is no hand-rolled range check in the shim, for the reason
//! `crates/fork-module-inject/src/main.rs:2107-2108` gives for
//! `__wpk_fork_table_apply`: an out-of-range ordinal or slot must trap rather
//! than write somewhere else. A hand-rolled check would convert that trap into
//! a quiet return, and a quiet return is how a thunk ends up at a slot nobody
//! assigned.

use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

use fork_instrument::{Options, instrument, runtime::names};

/// Three fork-path functions, so the catalog has three distinct thunks and a
/// permuted assignment can be told apart from an identity mapping.
const THREE_TARGET_FORK_PATH: &str = r#"
    (module
      (import "kernel" "kernel_fork" (func $fork (result i32)))
      (memory (export "memory") 4)

      (func $inner (result i32)
        call $fork)

      (func $middle (result i32)
        call $inner)

      (func (export "run") (result i32)
        call $middle))
"#;

fn instrumented() -> Vec<u8> {
    let input = wat::parse_str(THREE_TARGET_FORK_PATH).expect("parse placement fixture");
    instrument(&input, &Options::default()).expect("instrument placement fixture")
}

#[test]
fn instrumented_guest_exports_the_placement_shim() {
    let bytes = instrumented();
    let module = walrus::Module::from_buffer(&bytes).expect("walrus parse");
    let export = module
        .exports
        .iter()
        .find(|export| export.name == names::EXPORT_PLACE_RESUME_THUNKS)
        .unwrap_or_else(|| {
            panic!(
                "instrumented guest does not export {}",
                names::EXPORT_PLACE_RESUME_THUNKS
            )
        });
    assert!(
        matches!(export.item, walrus::ExportItem::Function(_)),
        "{} must be a function export",
        names::EXPORT_PLACE_RESUME_THUNKS
    );

    let mut validator =
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
    validator
        .validate_all(&bytes)
        .expect("instrumented guest with the placement shim must validate");
}

#[test]
fn guest_places_its_own_thunks_and_grows_the_resume_table() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "kandelo-fork-resume-placement-{}-{nonce}",
        std::process::id(),
    ));
    fs::create_dir(&directory).expect("create placement fixture directory");
    fs::write(directory.join("fixture.wasm"), instrumented()).expect("write placement fixture");
    fs::write(
        directory.join("test.mjs"),
        PLACEMENT_TEST_MJS.replace("__PLACE_EXPORT__", names::EXPORT_PLACE_RESUME_THUNKS),
    )
    .expect("write Node placement test");

    let result = Command::new("node")
        .arg("--experimental-wasm-exnref")
        .arg(directory.join("test.mjs"))
        .output()
        .expect("run Node placement test");
    let _ = fs::remove_dir_all(&directory);
    assert!(
        result.status.success(),
        "Node resume-thunk placement failed:\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr),
    );
}

const PLACEMENT_TEST_MJS: &str = r#"
import { readFileSync } from "node:fs";

const PLACE = "__PLACE_EXPORT__";
const RESUME_TABLE = "__wpk_fork_resume_table";
const CATALOG = "__wpk_fork_resume_catalog";
/** Where the (ordinal, slot) pairs are written. Four pages exist. */
const PAIRS = 0x1000;

const module = new WebAssembly.Module(
  readFileSync(new URL("./fixture.wasm", import.meta.url)),
);

/**
 * A fresh instance per case, each with its OWN resume table declared the way
 * the injector declares it: initial 1, no maximum. A shim that only wrote
 * would trap on the first slot past 0, which is the whole reason the shim
 * grows.
 */
function instantiate() {
  const imports = {};
  let instance;
  let resumeTable;
  for (const descriptor of WebAssembly.Module.imports(module)) {
    const namespace = imports[descriptor.module] ??= {};
    switch (descriptor.kind) {
      case "function":
        namespace[descriptor.name] = () => 0;
        break;
      case "table":
        if (descriptor.name === RESUME_TABLE) {
          resumeTable = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
          namespace[descriptor.name] = resumeTable;
        } else {
          namespace[descriptor.name] = new WebAssembly.Table({
            element: descriptor.name === "__wpk_fork_ref_gc_transit"
              ? "anyref"
              : "anyfunc",
            initial: 64,
          });
        }
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
  instance = new WebAssembly.Instance(module, imports);
  if (resumeTable === undefined) {
    throw new Error(`instrumented guest does not import ${RESUME_TABLE}`);
  }
  if (resumeTable.length !== 1) {
    throw new Error("the fixture resume table did not start at size 1");
  }
  const place = instance.exports[PLACE];
  if (typeof place !== "function") {
    throw new Error(`instrumented guest does not export ${PLACE}`);
  }
  const catalog = instance.exports[CATALOG];
  if (!(catalog instanceof WebAssembly.Table)) {
    throw new Error(`instrumented guest does not export ${CATALOG} as a table`);
  }
  return { instance, resumeTable, catalog, place };
}

/** Write `pairs` as packed (ordinal: u32, slot: u32) records at PAIRS. */
function writePairs(instance, pairs) {
  const view = new DataView(instance.exports.memory.buffer);
  pairs.forEach(([ordinal, slot], index) => {
    view.setUint32(PAIRS + index * 8, ordinal >>> 0, true);
    view.setUint32(PAIRS + index * 8 + 4, slot >>> 0, true);
  });
  return pairs.length;
}

function expectTrap(what, run) {
  let trapped = false;
  try {
    run();
  } catch (error) {
    if (!(error instanceof WebAssembly.RuntimeError)) throw error;
    trapped = true;
  }
  if (!trapped) throw new Error(`${what} did not trap`);
}

// --- Identity, permuted, across a grow --------------------------------------
{
  const { instance, resumeTable, catalog, place } = instantiate();
  if (catalog.length !== 3) {
    throw new Error(`catalog holds ${catalog.length} thunks, expected 3`);
  }
  // Deliberately NOT the identity mapping, and deliberately sparse: an
  // ordinal-is-the-slot shim, or one that placed in argument order, would pass
  // a dense ascending assignment and fail this one.
  const assignment = [[2, 1], [0, 7], [1, 4]];
  const count = writePairs(instance, assignment);
  const placed = place(PAIRS, count);
  if (placed !== count) {
    throw new Error(`placement reported ${placed} thunks, expected ${count}`);
  }
  // IDENTITY IS CHECKED FIRST, on purpose. A shim that placed at the wrong
  // slot would also resize the table differently, and a size check ahead of
  // this loop would report the size -- hiding which property actually broke.
  for (const [ordinal, slot] of assignment) {
    const placedThunk = resumeTable.get(slot);
    const expected = catalog.get(ordinal);
    if (expected === null) {
      throw new Error(`catalog ordinal ${ordinal} is null`);
    }
    // IDENTITY. A merely-equal funcref is the failure this asserts against.
    if (placedThunk !== expected) {
      throw new Error(
        `slot ${slot} does not hold the catalog thunk for ordinal ${ordinal}`,
      );
    }
  }
  // Growth is the shim's, not the host's: the table was declared with one
  // entry and the highest assigned slot is 7.
  if (resumeTable.length !== 8) {
    throw new Error(
      `resume table is ${resumeTable.length} entries, expected 8 after growth`,
    );
  }
  const occupied = new Set(assignment.map(([, slot]) => slot));
  for (let slot = 0; slot < resumeTable.length; slot++) {
    if (occupied.has(slot)) continue;
    if (resumeTable.get(slot) !== null) {
      throw new Error(`slot ${slot} holds a thunk nobody assigned`);
    }
  }
}

// --- An empty assignment places nothing and does not trap --------------------
{
  const { resumeTable, place } = instantiate();
  const placed = place(PAIRS, 0);
  if (placed !== 0) throw new Error(`empty assignment placed ${placed}`);
  if (resumeTable.length !== 1) {
    throw new Error("empty assignment grew the resume table");
  }
}

// --- A negative count places nothing rather than reading wildly --------------
{
  const { resumeTable, place } = instantiate();
  const placed = place(PAIRS, -1);
  if (placed !== 0) throw new Error(`negative count placed ${placed}`);
  if (resumeTable.length !== 1) {
    throw new Error("negative count grew the resume table");
  }
}

// --- An out-of-range ORDINAL traps, before anything is written ---------------
{
  const { instance, resumeTable, place } = instantiate();
  // Ordinal 3 is one past the three-entry catalog.
  writePairs(instance, [[3, 1]]);
  expectTrap("out-of-range catalog ordinal", () => place(PAIRS, 1));
  for (let slot = 0; slot < resumeTable.length; slot++) {
    if (resumeTable.get(slot) !== null) {
      throw new Error(`trapping placement still wrote slot ${slot}`);
    }
  }
}

// --- An out-of-range SLOT traps rather than writing elsewhere ----------------
{
  const { instance, resumeTable, catalog, place } = instantiate();
  // A slot no engine can grow to: the grow fails and the write traps on its
  // own bounds. Paired with a valid earlier entry so the trap is observed
  // after real work, not instead of it.
  writePairs(instance, [[0, 2], [1, 0xffffff00]]);
  expectTrap("out-of-range resume slot", () => place(PAIRS, 2));
  // The first pair was applied before the trap; the second wrote nothing.
  if (resumeTable.get(2) !== catalog.get(0)) {
    throw new Error("the entry before the trapping one was not applied");
  }
  for (let slot = 0; slot < resumeTable.length; slot++) {
    if (slot === 2) continue;
    if (resumeTable.get(slot) !== null) {
      throw new Error(`trapping placement wrote slot ${slot}`);
    }
  }
}
"#;
