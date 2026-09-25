import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ForkChildImports } from "../src/fork-child-imports";
import type { ForkWasmImports } from "../src/fork-import-identity";

/** Compile a `.wat` source into a module, the way the capture-drive tests do. */
function compile(wat: string): WebAssembly.Module {
  const directory = mkdtempSync(join(tmpdir(), "fork-child-imports-"));
  try {
    const watPath = join(directory, "m.wat");
    const wasmPath = join(directory, "m.wasm");
    writeFileSync(watPath, wat);
    execFileSync("wat2wasm", [watPath, "-o", wasmPath, "--enable-all"]);
    return new WebAssembly.Module(readFileSync(wasmPath));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const SPACE_GLOBAL = 0;
const SPACE_TABLE = 1;
const RAW_NUMBER = 1;
const RAW_BIGINT = 2;
const RAW_REFERENCE = 3;
const ACTIVATION_GLOBAL = 4;
const BASE_IMPORT = 5;
const ACTIVATION_TABLE = 1;
const FLAG_SAVED = 1;
const TYPE_I32 = 1;
const TYPE_I64 = 2;
const TYPE_EXTERNREF = 7;

interface Row {
  ordinal: number;
  space?: number;
  kind: number;
  typeCode?: number;
  flags?: number;
  bits?: bigint;
  sourceActivation?: number;
  sourceOwner?: number;
}

/** Stand in for the two module entries, serving rows from a map. */
function planSource(plans: ReadonlyMap<number, readonly Row[]>) {
  let resident: readonly Row[] = [];
  const builds: number[] = [];
  return {
    builds,
    source: {
      childImportPlan(activation: number, root: number): number {
        builds.push(root);
        resident = plans.get(activation) ?? [];
        return resident.length;
      },
      childImportPlanField(index: number, field: number): bigint {
        const row = resident[index];
        if (!row) throw new Error(`no plan entry ${index}`);
        switch (field) {
          case 0: return BigInt(row.ordinal);
          case 1: return BigInt(row.space ?? SPACE_GLOBAL);
          case 2: return BigInt(row.kind);
          case 3: return BigInt(row.typeCode ?? TYPE_I32);
          case 4: return BigInt(row.flags ?? 0);
          case 5: return row.bits ?? 0n;
          case 6: return BigInt(row.sourceActivation ?? 0);
          case 7: return BigInt(row.sourceOwner ?? 0);
          default: throw new Error(`no field ${field}`);
        }
      },
    },
  };
}

const noReferences = {
  ownerActivation: () => null,
  materialize: () => {
    throw new Error("materialize was not expected");
  },
};

/** One consumer importing `env.g` twice and `env.t` once, in that order. */
const CONSUMER = compile(
  '(module (import "env" "g" (global i32)) (import "env" "t" (table 1 funcref))'
  + ' (import "env" "g" (global i32)))',
);

/** A provider exporting the catalog entries a binding names. */
const PROVIDER = compile(
  '(module (global (export "__wpk_fork_global_5") i32 (i32.const 7))'
  + ' (table (export "__wpk_fork_table_5") 1 funcref))',
);

function build(
  plans: ReadonlyMap<number, readonly Row[]>,
  modules: ReadonlyMap<number, WebAssembly.Module> = new Map([[0, CONSUMER]]),
  references: Parameters<typeof makeImports>[0] = noReferences,
) {
  const { source, builds } = planSource(plans);
  const imports = new ForkChildImports(
    source,
    modules,
    4096,
    references,
    "test child imports",
  );
  return { imports, builds };
}

// Only used for its parameter type above.
function makeImports(references: {
  ownerActivation(recipeId: number, typeCode: number): number | null;
  activationDependencies?(recipeId: number, typeCode: number): number[] | undefined;
  materialize(recipeId: number, typeCode: number): unknown;
}) {
  return references;
}

const BASE: ForkWasmImports = {
  env: {
    g: 111,
    t: new WebAssembly.Table({ element: "anyfunc", initial: 1 }),
    other: "untouched",
  },
};

describe("fork child imports", () => {
  it("asks for every activation's plan from the inherited root", () => {
    // The sections a plan needs (KFIG/KFIT) arrive with each activation's
    // admission, which the child makes before building this. Census 175.
    const { builds } = build(
      new Map([[0, []], [1, []]]),
      new Map([[0, CONSUMER], [1, PROVIDER]]),
    );
    expect(builds, "and both plans built from the inherited root").toEqual([
      4096, 4096,
    ]);
  });

  it("overrides the planned ordinal and leaves every other import alone", () => {
    const { imports } = build(
      new Map([[0, [{ ordinal: 0, kind: RAW_NUMBER, bits: 0x4059_0000_0000_0000n }]]]),
    );
    const resolved = imports.importsForActivation(0, BASE) as Record<
      string,
      Record<string, unknown>
    >;
    expect(resolved.env!.g, "the planned value").toBe(100);
    expect(resolved.env!.other, "an import nothing planned").toBe("untouched");
  });

  it("answers a repeated name by POSITION, not by name", () => {
    // `env.g` is imported twice. The plan overrides only the second one, so the
    // first read must fall through to the base import. Resolving by name would
    // give both reads the same value and bind the wrong global.
    const { imports } = build(
      new Map([[0, [{ ordinal: 2, kind: RAW_NUMBER, bits: 0x4059_0000_0000_0000n }]]]),
    );
    const env = (imports.importsForActivation(0, BASE) as Record<
      string,
      Record<string, unknown>
    >).env!;
    expect(env.g, "first read: the base import").toBe(111);
    expect(env.g, "second read: the planned override").toBe(100);
  });

  it("refuses more reads of a name than the module declares", () => {
    const { imports } = build(
      new Map([[0, [{ ordinal: 0, kind: RAW_NUMBER, bits: 0n }]]]),
    );
    const env = (imports.importsForActivation(0, BASE) as Record<
      string,
      Record<string, unknown>
    >).env!;
    void env.g;
    void env.g;
    expect(() => env.g).toThrow(/more than 2 time\(s\)/);
  });

  it("does not narrow a 64-bit raw value", () => {
    const { imports } = build(
      new Map([[
        0,
        [{ ordinal: 0, kind: RAW_BIGINT, typeCode: TYPE_I64, bits: 0xdead_beef_0000_0001n }],
      ]]),
    );
    const env = (imports.importsForActivation(0, BASE) as Record<
      string,
      Record<string, unknown>
    >).env!;
    expect(env.g, "every bit survives the field read").toBe(
      BigInt.asIntN(64, 0xdead_beef_0000_0001n),
    );
  });

  it("reads a provider's catalog export off its instance", () => {
    const { imports } = build(
      new Map([
        [0, [{ ordinal: 0, kind: ACTIVATION_GLOBAL, sourceActivation: 1, sourceOwner: 5 }]],
        [1, []],
      ]),
      new Map([[0, CONSUMER], [1, PROVIDER]]),
    );
    const provider = new WebAssembly.Instance(PROVIDER);
    const env = () =>
      (imports.importsForActivation(0, BASE) as Record<
        string,
        Record<string, unknown>
      >).env!;
    expect(() => env().g, "before the provider exists").toThrow(
      /provider activation 1 is not instantiated/,
    );
    imports.registerInstance(1, provider);
    expect(env().g, "the provider's own Global object").toBe(
      provider.exports.__wpk_fork_global_5,
    );
  });

  it("refuses a provider whose catalog export is missing or the wrong shape", () => {
    const { imports } = build(
      new Map([
        [0, [{ ordinal: 0, kind: ACTIVATION_GLOBAL, sourceActivation: 1, sourceOwner: 9 }]],
        [1, []],
      ]),
      new Map([[0, CONSUMER], [1, PROVIDER]]),
    );
    imports.registerInstance(1, new WebAssembly.Instance(PROVIDER));
    const env = (imports.importsForActivation(0, BASE) as Record<
      string,
      Record<string, unknown>
    >).env!;
    expect(() => env.g).toThrow(/provider global 1:9 is missing/);
  });

  it("resolves a table import to the provider's table", () => {
    const { imports } = build(
      new Map([
        [
          0,
          [{
            ordinal: 1,
            space: SPACE_TABLE,
            kind: ACTIVATION_TABLE,
            sourceActivation: 1,
            sourceOwner: 5,
          }],
        ],
        [1, []],
      ]),
      new Map([[0, CONSUMER], [1, PROVIDER]]),
    );
    const provider = new WebAssembly.Instance(PROVIDER);
    imports.registerInstance(1, provider);
    const env = (imports.importsForActivation(0, BASE) as Record<
      string,
      Record<string, unknown>
    >).env!;
    expect(env.t).toBe(provider.exports.__wpk_fork_table_5);
  });

  it("materializes a reference recipe through the engine floor", () => {
    const token = { the: "externref" };
    const asked: [number, number][] = [];
    const { imports } = build(
      new Map([[
        0,
        [{ ordinal: 0, kind: RAW_REFERENCE, typeCode: TYPE_EXTERNREF, bits: 12n }],
      ]]),
      new Map([[0, CONSUMER]]),
      makeImports({
        ownerActivation: () => null,
        materialize: (recipeId, typeCode) => {
          asked.push([recipeId, typeCode]);
          return token;
        },
      }),
    );
    const env = (imports.importsForActivation(0, BASE) as Record<
      string,
      Record<string, unknown>
    >).env!;
    expect(env.g).toBe(token);
    expect(asked, "asked for exactly the planned recipe").toEqual([[12, TYPE_EXTERNREF]]);
  });

  it("orders providers before consumers and refuses a cycle", () => {
    const { imports } = build(
      new Map([
        [0, [{ ordinal: 0, kind: ACTIVATION_GLOBAL, sourceActivation: 2, sourceOwner: 5 }]],
        [1, []],
        [2, []],
      ]),
      new Map([[0, CONSUMER], [1, PROVIDER], [2, PROVIDER]]),
    );
    expect(imports.instantiationOrder()).toEqual([1, 2, 0]);

    const cyclic = build(
      new Map([
        [0, [{ ordinal: 0, kind: ACTIVATION_GLOBAL, sourceActivation: 1, sourceOwner: 5 }]],
        [1, [{ ordinal: 0, kind: ACTIVATION_GLOBAL, sourceActivation: 0, sourceOwner: 5 }]],
      ]),
      new Map([[0, CONSUMER], [1, CONSUMER]]),
    );
    expect(() => cyclic.imports.instantiationOrder()).toThrow(
      /provider cycle among activations 0, 1/,
    );
  });

  it("adds the reference closure to the instantiation edges", () => {
    // A typed aggregate may need codecs from several earlier activations, so
    // the owner alone is not the whole edge set.
    const { imports } = build(
      new Map([
        [0, [{ ordinal: 0, kind: RAW_REFERENCE, typeCode: TYPE_EXTERNREF, bits: 3n }]],
        [1, []],
        [2, []],
      ]),
      new Map([[0, CONSUMER], [1, PROVIDER], [2, PROVIDER]]),
      makeImports({
        ownerActivation: () => 1,
        activationDependencies: () => [1, 2],
        materialize: () => ({}),
      }),
    );
    expect(imports.dependenciesFor(0)).toEqual([1, 2]);
    expect(imports.instantiationOrder()).toEqual([1, 2, 0]);
  });

  it("falls back to the recipe's owner when there is no closure", () => {
    const { imports } = build(
      new Map([
        [0, [{ ordinal: 0, kind: RAW_REFERENCE, typeCode: TYPE_EXTERNREF, bits: 3n }]],
        [1, []],
      ]),
      new Map([[0, CONSUMER], [1, PROVIDER]]),
      makeImports({
        ownerActivation: () => 1,
        materialize: () => ({}),
      }),
    );
    expect(imports.dependenciesFor(0)).toEqual([1]);
  });

  it("never makes an activation depend on itself", () => {
    // An activation provides globals to ITSELF whenever the election picks its
    // own catalog entry -- which is the ordinary case for a program with one
    // module. A self-edge would make the topological sort find nothing ready
    // and loop forever, so the skip is load-bearing rather than tidy.
    const { imports } = build(
      new Map([[
        0,
        [{ ordinal: 0, kind: ACTIVATION_GLOBAL, sourceActivation: 0, sourceOwner: 5 }],
      ]]),
    );
    expect(imports.dependenciesFor(0), "no self-edge").toEqual([]);
    expect(imports.instantiationOrder()).toEqual([0]);
  });

  it("refuses a dependency on an activation the child does not have", () => {
    const { imports } = build(
      new Map([[0, [{ ordinal: 0, kind: ACTIVATION_GLOBAL, sourceActivation: 4 }]]]),
    );
    expect(() => imports.dependenciesFor(0)).toThrow(
      /depends on missing provider activation 4/,
    );
  });

  it("hands the loader the saved scalar behind a base import", () => {
    const { imports } = build(
      new Map([[
        0,
        [
          { ordinal: 0, kind: BASE_IMPORT, flags: FLAG_SAVED, bits: 42n },
          { ordinal: 2, kind: BASE_IMPORT, flags: FLAG_SAVED, bits: 42n },
        ],
      ]]),
    );
    expect(imports.savedMutableGlobalImport(0, "env", "g")).toBe(42);
    expect(
      imports.savedMutableGlobalImport(0, "env", "absent"),
      "a name this activation does not import",
    ).toBeUndefined();
  });

  it("refuses duplicate base imports whose saved values disagree", () => {
    // Both ordinals alias ONE loader cell, so two different snapshots mean the
    // child cannot restore either honestly.
    const { imports } = build(
      new Map([[
        0,
        [
          { ordinal: 0, kind: BASE_IMPORT, flags: FLAG_SAVED, bits: 42n },
          { ordinal: 2, kind: BASE_IMPORT, flags: FLAG_SAVED, bits: 43n },
        ],
      ]]),
    );
    expect(() => imports.savedMutableGlobalImport(0, "env", "g")).toThrow(
      /conflicting saved values/,
    );
  });

  it("refuses a base import the module did not snapshot", () => {
    const { imports } = build(
      new Map([[0, [{ ordinal: 0, kind: BASE_IMPORT }]]]),
    );
    expect(() => imports.savedMutableGlobalImport(0, "env", "g")).toThrow(
      /has no saved value/,
    );
  });

  it("leaves a base import to the base import object", () => {
    // BASE_IMPORT is a decision NOT to override. Resolving it would be a
    // category error -- there is nothing to resolve it to -- and overriding it
    // would take the cell away from the dylink loader that owns it.
    const { imports } = build(
      new Map([[
        0,
        [
          { ordinal: 0, kind: BASE_IMPORT, flags: FLAG_SAVED, bits: 7n },
          { ordinal: 1, space: SPACE_TABLE, kind: 2 },
        ],
      ]]),
    );
    const env = (imports.importsForActivation(0, BASE) as Record<
      string,
      Record<string, unknown>
    >).env!;
    expect(env.g, "the base value, not the saved snapshot").toBe(111);
    expect(env.t, "the base table").toBe(BASE.env!.t);
  });

  it("does not wrap a namespace it plans nothing in", () => {
    // The Proxy counts reads and refuses extras. A namespace with no planned
    // override must not acquire that behaviour for free.
    const other: ForkWasmImports = { wasi: { fd_write: () => 0 }, env: BASE.env! };
    const { imports } = build(new Map([[0, []]]));
    const resolved = imports.importsForActivation(0, other) as Record<
      string,
      unknown
    >;
    expect(resolved.wasi, "passed through unwrapped").toBe(other.wasi);
    expect(resolved.env, "and so is a namespace with no planned rows").toBe(
      other.env,
    );
  });

  it("refuses a planned kind it cannot resolve, in either space", () => {
    // Both spaces, because their kind numberings OVERLAP: a table row read as
    // a global row would resolve to something rather than refuse.
    const { imports } = build(new Map([[0, [{ ordinal: 0, kind: 99 }]]]));
    const env = (imports.importsForActivation(0, BASE) as Record<
      string,
      Record<string, unknown>
    >).env!;
    expect(() => env.g).toThrow(/global import 0:0 has nothing to resolve to \(kind 99\)/);

    const tables = build(
      new Map([[0, [{ ordinal: 1, space: SPACE_TABLE, kind: 99 }]]]),
    );
    const tableEnv = (tables.imports.importsForActivation(0, BASE) as Record<
      string,
      Record<string, unknown>
    >).env!;
    expect(() => tableEnv.t).toThrow(
      /table import 0:1 has nothing to resolve to \(kind 99\)/,
    );
  });

  it("refuses to register one activation's instance twice", () => {
    const { imports } = build(new Map([[0, []]]));
    imports.registerInstance(0, new WebAssembly.Instance(PROVIDER));
    expect(() =>
      imports.registerInstance(0, new WebAssembly.Instance(PROVIDER)),
    ).toThrow(/was instantiated twice/);
  });

  it("refuses to register an instance for an activation it never planned", () => {
    // A different refusal from the one below: this one is `require`, reached
    // before any module lookup, and it is what stops a caller from binding a
    // provider the plan never mentioned.
    const { imports } = build(new Map([[0, []]]));
    expect(() =>
      imports.registerInstance(3, new WebAssembly.Instance(PROVIDER)),
    ).toThrow(/activation 3 is not declared/);
  });

  it("refuses to plan for an activation it was never given", () => {
    const { imports } = build(new Map([[0, []]]));
    expect(() => imports.importsForActivation(5, BASE)).toThrow(
      /activation 5 is not declared/,
    );
  });
});
