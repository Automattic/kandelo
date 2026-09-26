import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORK_BINDING_EXPORT_CATALOG,
  FORK_IMPORT_SPACE_GLOBAL,
  FORK_IMPORT_SPACE_TABLE,
  ForkImportIdentity,
  type ForkImportSeedSink,
  type ForkWasmImports,
} from "../src/fork-import-identity";
import {
  WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER,
  WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE,
  WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE,
} from "../src/generated/abi";

/**
 * The host half of the imported-global/table port: identity and observed
 * values, published to the module, and nothing else.
 *
 * Everything here is about what only JavaScript can see. The provider election,
 * the type codes and the record encoding live in `fork-codec` and are tested
 * there; if a test in this file starts asserting which activation provides
 * something, the split has moved back.
 */

interface Seed {
  readonly call: "identity" | "provenance";
  readonly args: readonly (number | bigint)[];
  readonly bytes?: Uint8Array;
}

function recordingSink(): { seeds: Seed[]; calls: number[]; sink: ForkImportSeedSink } {
  const seeds: Seed[] = [];
  const calls: number[] = [];
  return {
    seeds,
    calls,
    sink: {
      // One `fm_publish_bindings` per activation; flattened here into the
      // per-row facts the assertions below read.
      publishBindings: (activation, rows) => {
        calls.push(activation);
        for (const r of rows) {
          seeds.push(
            r.role === FORK_BINDING_EXPORT_CATALOG
              ? { call: "identity", args: [r.space, activation, r.ordinalOrOwner, r.group] }
              : { call: "provenance", args: [r.space, activation, r.ordinalOrOwner, r.kind, r.group, r.bits] },
          );
        }
      },
    },
  };
}

/**
 * The fixture module. Its shape is the point:
 *
 * - `env.dup` is imported TWICE, so the Nth read has to map to the Nth ordinal;
 * - a function import sits between the globals and the table, so ordinals are
 *   positions in the whole import section rather than a per-kind counter;
 * - the imported table is re-exported as `__wpk_fork_table_1`, which is the
 *   case that makes a catalog entry an IMPORTER rather than a provider.
 */
const WAT = `(module
  (import "env" "dup" (global (mut i32)))
  (import "env" "dup" (global (mut i32)))
  (import "env" "num" (global f64))
  (import "env" "big" (global i64))
  (import "env" "ref" (global externref))
  (import "env" "fn" (func))
  (import "env" "tbl" (table 1 funcref))
  (global $own (mut i32) (i32.const 7))
  (export "__wpk_fork_global_1" (global $own))
  (export "__wpk_fork_table_1" (table 0))
)`;

const ORDINAL_DUP_FIRST = 0;
const ORDINAL_DUP_SECOND = 1;
const ORDINAL_NUM = 2;
const ORDINAL_BIG = 3;
const ORDINAL_REF = 4;
const ORDINAL_TABLE = 6;

function compile(wat: string, sections: readonly [string, Uint8Array][] = []): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "fork-import-identity-"));
  try {
    const watPath = join(directory, "fixture.wat");
    const wasmPath = join(directory, "fixture.wasm");
    writeFileSync(watPath, wat);
    // Reference types are on by default in this wat2wasm; the externref import
    // in the fixture needs them.
    execFileSync("wat2wasm", [watPath, "-o", wasmPath]);
    let bytes = new Uint8Array(readFileSync(wasmPath));
    for (const [name, payload] of sections) {
      bytes = appendCustomSection(bytes, name, payload);
    }
    return bytes;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Append a custom section, LEB-encoded exactly as the binary format wants. */
function appendCustomSection(
  wasm: Uint8Array,
  name: string,
  payload: Uint8Array,
): Uint8Array {
  const encodedName = new TextEncoder().encode(name);
  const body = [...leb(encodedName.length), ...encodedName, ...payload];
  return new Uint8Array([...wasm, 0, ...leb(body.length), ...body]);
}

function leb(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

/** The two Globals `env.dup`'s getter answers with, in read order. */
function importsFor(
  first: WebAssembly.Global,
  second: WebAssembly.Global,
  overrides: Partial<Record<string, unknown>> = {},
): ForkWasmImports {
  let reads = 0;
  const env: Record<string, unknown> = {
    num: 12.5,
    big: 9n,
    ref: { referent: true },
    fn: () => {},
    tbl: new WebAssembly.Table({ initial: 1, element: "anyfunc" }),
    ...overrides,
  };
  Object.defineProperty(env, "dup", {
    enumerable: true,
    get: () => (reads++ === 0 ? first : second),
  });
  return { env } as ForkWasmImports;
}

function mutableI32(value: number): WebAssembly.Global {
  return new WebAssembly.Global({ value: "i32", mutable: true }, value);
}

function prepared(
  identity: ForkImportIdentity,
  activationId: number,
  bytes: Uint8Array,
  imports: ForkWasmImports,
) {
  const module = new WebAssembly.Module(bytes);
  const preparation = identity.prepareActivation(activationId, module, imports);
  const instance = new WebAssembly.Instance(
    module,
    preparation.imports as unknown as WebAssembly.Imports,
  );
  return { preparation, instance };
}

describe("what only JavaScript can see about an activation's imports", () => {
  it("maps the Nth read of a repeated name to the Nth import ordinal", () => {
    // `env.dup` is declared twice and answered by a getter. Resolving the name
    // once and reusing the value would publish one Global for two distinct
    // bindings, and the child would then share a cell the parent did not.
    const { seeds, sink } = recordingSink();
    const identity = new ForkImportIdentity(sink, "test");
    const first = mutableI32(1);
    const second = mutableI32(2);
    const { preparation, instance } = prepared(
      identity,
      0,
      compile(WAT),
      importsFor(first, second),
    );
    preparation.complete(instance);

    const provenance = seeds.filter((s) => s.call === "provenance");
    const groupOf = (ordinal: number) =>
      provenance.find((s) => s.args[2] === ordinal)?.args[4];
    expect(groupOf(ORDINAL_DUP_FIRST)).not.toBe(groupOf(ORDINAL_DUP_SECOND));
  });

  it("gives one object one group id across activations", () => {
    // The whole reason the host is involved. Two activations handed the same
    // Global must publish the same id, or the module elects a provider for each
    // separately and the child ends up with two cells where there was one.
    const { seeds, sink } = recordingSink();
    const identity = new ForkImportIdentity(sink, "test");
    const shared = mutableI32(1);
    const other = mutableI32(2);
    const bytes = compile(WAT);
    const a = prepared(identity, 0, bytes, importsFor(shared, other));
    a.preparation.complete(a.instance);
    const b = prepared(identity, 1, bytes, importsFor(shared, other));
    b.preparation.complete(b.instance);

    const provenance = seeds.filter((s) => s.call === "provenance");
    const groupFor = (activation: number) =>
      provenance.find(
        (s) => s.args[1] === activation && s.args[2] === ORDINAL_DUP_FIRST,
      )?.args[4];
    expect(groupFor(0)).toBe(groupFor(1));

    // And each activation's own catalog global is its own object, so the two
    // do NOT share a group -- a WeakMap keyed by identity, not a counter.
    const catalog = seeds.filter(
      (s) => s.call === "identity" && s.args[0] === FORK_IMPORT_SPACE_GLOBAL,
    );
    expect(catalog).toHaveLength(2);
    expect(catalog[0].args[3]).not.toBe(catalog[1].args[3]);
  });

  it("publishes the imported table's catalog entry in the table space", () => {
    // The fixture re-exports the table it imports, which is the shape that
    // makes an election necessary: the entry is a member of the group and an
    // importer at once, and only the module's KFIT can tell.
    const { seeds, sink } = recordingSink();
    const identity = new ForkImportIdentity(sink, "test");
    const { preparation, instance } = prepared(
      identity,
      0,
      compile(WAT),
      importsFor(mutableI32(1), mutableI32(2)),
    );
    preparation.complete(instance);

    const table = seeds.find(
      (s) => s.call === "identity" && s.args[0] === FORK_IMPORT_SPACE_TABLE,
    );
    expect(table?.args.slice(0, 3)).toEqual([FORK_IMPORT_SPACE_TABLE, 0, 1]);
    const provenance = seeds.find(
      (s) => s.call === "provenance" && s.args[2] === ORDINAL_TABLE,
    );
    expect(provenance?.args[0]).toBe(FORK_IMPORT_SPACE_TABLE);
    expect(provenance?.args[3]).toBe(WPK_FORK_IMPORTED_TABLE_BINDING_ACTIVATION_TABLE);
    // The catalog entry and the import are the same object, so one group id.
    expect(provenance?.args[4]).toBe(table?.args[3]);
  });

  it("says what each imported value IS, and never what provides it", () => {
    // Four kinds the host can know. BASE_IMPORT is not among them: it asserts
    // that no activation provides the object, which is the module's election.
    const { seeds, sink } = recordingSink();
    const identity = new ForkImportIdentity(sink, "test");
    const { preparation, instance } = prepared(
      identity,
      0,
      compile(WAT),
      importsFor(mutableI32(1), mutableI32(2)),
    );
    preparation.complete(instance);

    const kind = (ordinal: number) =>
      seeds.find((s) => s.call === "provenance" && s.args[2] === ordinal)?.args[3];
    expect(kind(ORDINAL_DUP_FIRST)).toBe(
      WPK_FORK_IMPORTED_GLOBAL_BINDING_ACTIVATION_GLOBAL,
    );
    expect(kind(ORDINAL_NUM)).toBe(WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_NUMBER);
    expect(kind(ORDINAL_BIG)).toBe(WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_BIGINT);
    expect(kind(ORDINAL_REF)).toBe(
      WPK_FORK_IMPORTED_GLOBAL_BINDING_RAW_REFERENCE,
    );

    // A scalar's bits travel, because the value lives only in the import object.
    const bitsFor = (ordinal: number) =>
      seeds.find((s) => s.call === "provenance" && s.args[2] === ordinal)?.args[5];
    const f64 = new DataView(new ArrayBuffer(8));
    f64.setFloat64(0, 12.5, true);
    expect(bitsFor(ORDINAL_NUM)).toBe(f64.getBigUint64(0, true));
    expect(bitsFor(ORDINAL_BIG)).toBe(9n);
  });

  it("publishes an activation in one call and tells the table journal each table's group", () => {
    // One module call per activation, whatever its size. And the table group
    // the catalog row carries is the one `ForkTables` marks a host mutation
    // by, so the two can never name different objects.
    const { seeds, calls, sink } = recordingSink();
    const tracked: [WebAssembly.Table, number][] = [];
    const identity = new ForkImportIdentity(sink, "test", {
      track: (table, group) => void tracked.push([table, group]),
    });
    const imports = importsFor(mutableI32(1), mutableI32(2));
    const { preparation, instance } = prepared(identity, 0, compile(WAT), imports);
    preparation.complete(instance);
    expect(calls).toEqual([0]);
    const row = seeds.find((s) => s.call === "identity" && s.args[0] === FORK_IMPORT_SPACE_TABLE);
    expect(tracked).toEqual([[(imports.env as Record<string, unknown>).tbl, row?.args[3]]]);
  });

  it("publishes nothing for the channel base the instrumenter excludes", () => {
    // `env.__channel_base` is the process's syscall channel, rebound per worker
    // rather than reconstructed from a parent's value, and the instrumenter
    // leaves it OUT of KFIG (`imported_global_is_child_binding`). The module
    // matches provenance against KFIG, so publishing this one made it refuse
    // the whole capture with EINVAL -- which is what every dlopen guest hit.
    const { seeds, sink } = recordingSink();
    const identity = new ForkImportIdentity(sink, "test");
    const wat = WAT.replace(
      '(import "env" "dup" (global (mut i32)))',
      '(import "env" "__channel_base" (global i32))\n'
      + '  (import "env" "dup" (global (mut i32)))',
    );
    const channelBase = new WebAssembly.Global({ value: "i32", mutable: false }, 64);
    const { preparation, instance } = prepared(
      identity,
      0,
      compile(wat),
      importsFor(mutableI32(1), mutableI32(2), { __channel_base: channelBase }),
    );
    preparation.complete(instance);

    // Ordinal 0 is now `__channel_base`; nothing may be published for it.
    expect(
      seeds.filter((s) => s.call === "provenance" && s.args[2] === 0),
      "no provenance for the channel base",
    ).toEqual([]);
    // And the imports AFTER it still get theirs, at their shifted ordinals --
    // a blanket skip would have taken them too.
    expect(
      seeds.some((s) => s.call === "provenance" && s.args[2] === ORDINAL_NUM + 1),
      "the imports after it are still published",
    ).toBe(true);
  });
});

describe("what it refuses rather than publishing a half-truth", () => {
  it("refuses a second preparation of one activation", () => {
    const identity = new ForkImportIdentity(recordingSink().sink, "test");
    const module = new WebAssembly.Module(compile(WAT));
    identity.prepareActivation(0, module, importsFor(mutableI32(1), mutableI32(2)));
    expect(() =>
      identity.prepareActivation(0, module, importsFor(mutableI32(1), mutableI32(2))),
    ).toThrow(/already prepared/);
  });

  it("refuses to complete a preparation twice", () => {
    // Completing twice would publish one activation's catalog into the groups
    // again, which is harmless, and its provenance again, which is not: the
    // module takes a re-publication as a correction.
    const identity = new ForkImportIdentity(recordingSink().sink, "test");
    const { preparation, instance } = prepared(
      identity,
      0,
      compile(WAT),
      importsFor(mutableI32(1), mutableI32(2)),
    );
    preparation.complete(instance);
    expect(() => preparation.complete(instance)).toThrow(/finished/);
  });

  it("refuses an import WebAssembly never read", () => {
    // If instantiation did not read a declared global, the host has no value to
    // publish for it and the module would bind a child's import from provenance
    // that was never observed. The fixture is instantiated WITHOUT the wrapper,
    // so nothing is recorded.
    const identity = new ForkImportIdentity(recordingSink().sink, "test");
    const module = new WebAssembly.Module(compile(WAT));
    const imports = importsFor(mutableI32(1), mutableI32(2));
    const preparation = identity.prepareActivation(0, module, imports);
    const instance = new WebAssembly.Instance(
      module,
      imports as unknown as WebAssembly.Imports,
    );
    expect(() => preparation.complete(instance)).toThrow(/did not read import ordinal/);
  });

  it("refuses a malformed catalog export rather than guessing an owner", () => {
    // A catalog name the host cannot parse means the instrumentation and this
    // reader disagree, and an owner id invented here would key every later seed
    // to the wrong global.
    const identity = new ForkImportIdentity(recordingSink().sink, "test");
    const wat = WAT.replace(
      '(export "__wpk_fork_global_1" (global $own))',
      '(export "__wpk_fork_global_0x1" (global $own))',
    );
    const { preparation, instance } = prepared(
      identity,
      0,
      compile(wat),
      importsFor(mutableI32(1), mutableI32(2)),
    );
    expect(() => preparation.complete(instance)).toThrow(/malformed catalog export/);
  });
});
