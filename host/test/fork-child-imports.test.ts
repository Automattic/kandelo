// A fork child's import objects, planned by the REAL fork module.
//
// Nothing here stands in for the module. A parent capture runs through the
// production entries -- admission with KFIG sections, the identity groups and
// import provenance a parent publishes, the guest's module-state save -- and
// seals binding records into an arena. `fm_child_plan` then plans the child
// from that arena, and `ForkChildImports` turns the plan into import objects
// for real WebAssembly modules whose import sections the KFIG describes.
//
// What the host no longer decides, and so what this file checks the MODULE
// decided: which activation provides what, the saved scalar behind a base
// import, the instantiation order, and the refusal of a provider cycle.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ForkChildImports } from "../src/fork-child-imports";
import type { ForkWasmImports } from "../src/fork-import-identity";
import {
  FORK_ACTIVATION_DRIVE_BINDINGS,
  ForkModuleContinuationBackend,
} from "../src/fork-module-backend";
import {
  CHANNEL_BASE,
  DRIVE_SLOT_MODULE_STATE_SAVE,
  DRIVE_SLOT_UNWIND_BEGIN,
  admitActivation,
  bindActivation,
  driveBase,
  fixture,
  publishInto,
  saveSlotThunk,
  sideTemplate,
  type Fixture,
} from "./fork-module-capture-fixture";
import { exportRow, importRow } from "./support/fork-admission";

const SPACE_GLOBAL = 0;
const KIND_RAW_NUMBER = 1;
const KIND_ACTIVATION_GLOBAL = 4;
const TYPE_I32 = 1;
const FLAG_MUTABLE = 1;
const RECORD_KIND_MUTABLE_GLOBAL = 3;
const EDEADLK = 35;
/** The value every snapshot here saves, so a base import's saved scalar is known. */
const SAVED = 42;

function compile(wat: string): WebAssembly.Module {
  const directory = mkdtempSync(join(tmpdir(), "fork-child-imports-"));
  try {
    writeFileSync(join(directory, "m.wat"), wat);
    execFileSync("wat2wasm", [join(directory, "m.wat"), "-o", join(directory, "m.wasm")]);
    return new WebAssembly.Module(readFileSync(join(directory, "m.wasm")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

interface Declared {
  owner: number;
  ordinal: number;
  name: string;
  mutable: boolean;
}

/** A KFIG section: one `env.<name>` i32 global per declaration. */
function kfig(declared: readonly Declared[]): Uint8Array {
  const encoder = new TextEncoder();
  const records = declared.map(({ owner, ordinal, name, mutable }) => {
    const [moduleName, importName] = [encoder.encode("env"), encoder.encode(name)];
    const record = new Uint8Array(24 + moduleName.length + importName.length);
    const view = new DataView(record.buffer);
    view.setUint32(0, record.length, true);
    view.setUint32(4, owner, true);
    record[8] = TYPE_I32;
    record[9] = mutable ? FLAG_MUTABLE : 0;
    view.setUint32(12, moduleName.length, true);
    view.setUint32(16, importName.length, true);
    view.setUint32(20, ordinal, true);
    record.set(moduleName, 24);
    record.set(importName, 24 + moduleName.length);
    return record;
  });
  const out = new Uint8Array(16 + records.reduce((n, r) => n + r.length, 0));
  const view = new DataView(out.buffer);
  out.set([0x4b, 0x46, 0x49, 0x47], 0); // "KFIG"
  view.setUint16(4, 1, true);
  view.setUint16(6, 16, true);
  view.setUint32(8, records.length, true);
  let at = 16;
  for (const record of records) {
    out.set(record, at);
    at += record.length;
  }
  return out;
}

interface Provenance {
  ordinal: number;
  kind: number;
  group?: number;
  bits?: bigint;
}

interface ActivationFacts {
  declared: readonly Declared[];
  provenance: readonly Provenance[];
  /** `[owner, group]`: a global this activation EXPORTS, in an identity group. */
  exports?: readonly [number, number][];
}

/**
 * Capture a parent with these activations and plan its child. Activation 0
 * is the fixture's; the rest are side activations, admitted and bound the way
 * registration binds them. Every declared import gets a snapshot of `SAVED`,
 * written by the guest save the capture drives -- the module refuses a
 * binding with no snapshot behind it.
 */
function captureAndPlan(activations: ReadonlyMap<number, ActivationFacts>): {
  f: Fixture;
  backend: ForkModuleContinuationBackend;
  root: number;
} {
  const f = fixture();
  const x = f.x as Record<string, (...a: (number | bigint)[]) => number>;
  const reserve = f.x.__wpk_fork_module_state_record_reserve as (...a: number[]) => number;
  const commit = f.x.__wpk_fork_module_state_record_commit as (payload: number) => void;
  for (const [activation, facts] of activations) {
    const template = activation === 0 ? 0 : sideTemplate(activation);
    expect(admitActivation(f, activation, { template, importedGlobals: kfig(facts.declared) })).toBe(0);
    if (activation !== 0) bindActivation(f.x, f.memory, activation);
    const needed = driveBase(activation) + FORK_ACTIVATION_DRIVE_BINDINGS.length;
    if (f.instance.driveTable.length < needed) {
      f.instance.driveTable.grow(needed - f.instance.driveTable.length);
    }
    f.instance.driveTable.set(
      driveBase(activation) + DRIVE_SLOT_MODULE_STATE_SAVE,
      saveSlotThunk((id) => {
        for (const { owner } of activations.get(id)!.declared) {
          const payload = reserve(RECORD_KIND_MUTABLE_GLOBAL, id, owner, 12);
          const view = new DataView(f.memory.buffer);
          view.setUint8(payload, TYPE_I32);
          view.setUint8(payload + 1, 4);
          view.setUint16(payload + 2, 0, true);
          view.setUint32(payload + 4, 0, true);
          view.setUint32(payload + 8, SAVED, true);
          commit(payload);
        }
      }) as never,
    );
    f.instance.driveTable.set(driveBase(activation) + DRIVE_SLOT_UNWIND_BEGIN, saveSlotThunk(() => {}) as never);
    expect(publishInto(f.x, f.memory, activation, [
      ...(facts.exports ?? []).map(([owner, group]) => exportRow(SPACE_GLOBAL, owner, group)),
      ...facts.provenance.map(({ ordinal, kind, group = 0, bits = 0n }) =>
        importRow(SPACE_GLOBAL, ordinal, kind, group, bits)),
    ]), `publishing activation ${activation}`).toBe(0);
  }
  x.fm_capture_begin();
  x.fm_parent_begin_capture(CHANNEL_BASE, 0);
  expect(f.errno(), "the parent captures").toBe(0);
  const backend = new ForkModuleContinuationBackend({
    instance: f.instance,
    memory: f.memory,
    ptrWidth: 4,
    channelBase: CHANNEL_BASE,
    label: "child plan",
  });
  return { f, backend, root: f.root() };
}

/** 100.0 as f64 bits: a raw number a parent captured by value. */
const HUNDRED = 0x4059_0000_0000_0000n;

/**
 * Activation 0 imports `env.p` twice -- first from activation 1's exported
 * global, then as a raw number -- and `env.g`, a base import with a saved
 * value. Activation 1 imports `env.g` too, as a plain base import.
 */
const MAIN = compile(`(module
  (import "env" "p" (global (mut i32)))
  (import "env" "g" (global (mut i32)))
  (import "env" "p" (global i32)))`);
const SIDE = compile(`(module
  (import "env" "g" (global (mut i32)))
  (global (export "__wpk_fork_global_5") (mut i32) (i32.const 7)))`);

function mainAndSide(): ReadonlyMap<number, ActivationFacts> {
  return new Map([
    [0, {
      declared: [
        { owner: 1, ordinal: 0, name: "p", mutable: true },
        { owner: 2, ordinal: 1, name: "g", mutable: true },
        { owner: 3, ordinal: 2, name: "p", mutable: false },
      ],
      provenance: [
        { ordinal: 0, kind: KIND_ACTIVATION_GLOBAL, group: 7 },
        // A group nothing exports: the election falls back to the base import.
        { ordinal: 1, kind: KIND_ACTIVATION_GLOBAL, group: 99 },
        { ordinal: 2, kind: KIND_RAW_NUMBER, bits: HUNDRED },
      ],
    }],
    [1, {
      declared: [{ owner: 1, ordinal: 0, name: "g", mutable: true }],
      provenance: [{ ordinal: 0, kind: KIND_ACTIVATION_GLOBAL, group: 98 }],
      exports: [[5, 7]],
    }],
  ]);
}

const BASE: ForkWasmImports = {
  env: {
    g: new WebAssembly.Global({ value: "i32", mutable: true }, 111),
    p: new WebAssembly.Global({ value: "i32", mutable: true }, 222),
  },
};

describe("fork child imports, planned by the fork module", () => {
  it("orders the provider first and hands the consumer the provider's own Global", () => {
    const { backend, root } = captureAndPlan(mainAndSide());
    const plan = backend.childPlan(root);
    expect(plan.order, "activation 0 reads activation 1's export").toEqual([1, 0]);

    const imports = new ForkChildImports(plan, new Map([[0, MAIN], [1, SIDE]]), "child");
    const side = new WebAssembly.Instance(SIDE, imports.importsForActivation(1, BASE) as WebAssembly.Imports);
    expect(() => imports.importsForActivation(0, BASE).env!.p, "before the provider registers").toThrow(
      /provider activation 1 is not instantiated/,
    );
    imports.registerInstance(1, side);

    const env = imports.importsForActivation(0, BASE).env as Record<string, unknown>;
    expect(env.p, "first read: the provider's own Global").toBe(side.exports.__wpk_fork_global_5);
    expect(env.g, "a base import falls through to the base object").toBe(BASE.env!.g);
    expect(env.p, "second read of the same name: the raw number, by POSITION").toBe(100);
    expect(() => env.p, "and no third read").toThrow(/more than 2 time\(s\)/);
    new WebAssembly.Instance(MAIN, imports.importsForActivation(0, BASE) as WebAssembly.Imports);
  });

  it("hands the dylink loader the saved scalar behind a base import", () => {
    const { backend, root } = captureAndPlan(mainAndSide());
    const imports = new ForkChildImports(backend.childPlan(root), new Map([[0, MAIN], [1, SIDE]]), "child");
    expect(imports.savedMutableGlobalImport(0, "env", "g")).toBe(SAVED);
    expect(imports.savedMutableGlobalImport(1, "env", "g")).toBe(SAVED);
    expect(imports.savedMutableGlobalImport(0, "env", "absent")).toBeUndefined();
  });

  it("refuses a provider cycle in the module, with EDEADLK", () => {
    // Each activation imports the other's exported global. No real parent can
    // instantiate that, so an arena that says so disagrees with itself; the
    // module must refuse it rather than hand the host an order it cannot keep.
    const cyclic = new Map<number, ActivationFacts>([
      [0, {
        declared: [{ owner: 1, ordinal: 0, name: "p", mutable: true }],
        provenance: [{ ordinal: 0, kind: KIND_ACTIVATION_GLOBAL, group: 7 }],
        exports: [[5, 8]],
      }],
      [1, {
        declared: [{ owner: 1, ordinal: 0, name: "p", mutable: true }],
        provenance: [{ ordinal: 0, kind: KIND_ACTIVATION_GLOBAL, group: 8 }],
        exports: [[5, 7]],
      }],
    ]);
    const { f, backend, root } = captureAndPlan(cyclic);
    expect(() => backend.childPlan(root)).toThrow(/fm_child_plan failed with errno 35/);
    expect(f.errno()).toBe(EDEADLK);
  });

  it("refuses to register one activation twice, or one it never planned", () => {
    const { backend, root } = captureAndPlan(mainAndSide());
    const imports = new ForkChildImports(backend.childPlan(root), new Map([[0, MAIN], [1, SIDE]]), "child");
    const instance = new WebAssembly.Instance(SIDE, { env: { g: BASE.env!.g } });
    imports.registerInstance(1, instance);
    expect(() => imports.registerInstance(1, instance)).toThrow(/was instantiated twice/);
    expect(() => imports.registerInstance(3, instance)).toThrow(/activation 3 is not declared/);
  });
});
