import { describe, expect, it } from "vitest";

import {
  WPK_FORK_REQUIRED_IMPORTS,
  WPK_FORK_REQUIRED_TABLE_IMPORTS,
} from "../src/generated/abi";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildForkGuestImports,
  FORK_ACTIVATION_TRAMPOLINE_SLOTS,
  forkActivationFrameImports,
  FORK_GUEST_HOST_FLOOR_NAMES,
  forkUnwindTagFrom,
  isForkUnwindException,
  requireForkUnwindTag,
  type ForkGuestHostFloor,
} from "../src/fork-guest-imports";

/** A floor whose members exist but are never meant to be called here. */
function stubFloor(): ForkGuestHostFloor {
  const floor: Record<string, unknown> = {};
  for (const name of FORK_GUEST_HOST_FLOOR_NAMES) {
    floor[name] = () => {
      throw new Error(`${name} was called by a binding test`);
    };
  }
  return floor as unknown as ForkGuestHostFloor;
}

/** Module exports covering everything the floor does not. */
function stubModuleExports(): Record<string, unknown> {
  const exports: Record<string, unknown> = {};
  const floorNames = new Set<string>(FORK_GUEST_HOST_FLOOR_NAMES);
  for (const required of WPK_FORK_REQUIRED_IMPORTS) {
    if (required.module !== "env" || floorNames.has(required.name)) continue;
    exports[required.name] = () => undefined;
  }
  return exports;
}

const envImports = WPK_FORK_REQUIRED_IMPORTS.filter((i) => i.module === "env");

/** The tables the contract requires, which every successful build must carry. */
function requiredTables(): Record<string, unknown> {
  const tables: Record<string, unknown> = {};
  for (const table of WPK_FORK_REQUIRED_TABLE_IMPORTS) {
    // The wire contract spells the funcref element type `funcref`; the JS
    // Table constructor spells the same type `anyfunc`.
    tables[table.name] = new WebAssembly.Table({
      element: (table.element === "funcref" ? "anyfunc" : table.element) as "anyfunc",
      initial: table.minimum,
    });
  }
  return tables;
}

describe("fork guest imports", () => {
  it("binds every import the generated contract requires", () => {
    const env = buildForkGuestImports({
      moduleExports: stubModuleExports(),
      floor: stubFloor(),
      extras: requiredTables(),
    });
    // Driven off the same table the binder reads, so a contract change cannot
    // pass here by being absent from both.
    expect(envImports.length).toBeGreaterThan(0);
    for (const required of envImports) {
      expect(typeof env[required.name], required.name).toBe("function");
    }
  });

  it("names EVERY unbound import, not just the first", () => {
    const exports = stubModuleExports();
    const names = Object.keys(exports).slice(0, 3);
    expect(names.length).toBe(3);
    for (const name of names) delete exports[name];
    let message = "";
    try {
      buildForkGuestImports({
        moduleExports: exports,
        floor: stubFloor(),
        extras: requiredTables(),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    // A binder that threw on the first gap would mention one name and send the
    // caller round the loop twice more to discover the other two.
    for (const name of names) expect(message).toContain(name);
    expect(message).toContain("3 fork import(s)");
  });

  it("prefers the fork module over the host floor", () => {
    // The floor is a fallback, not an override. If a host implementation won,
    // an entry the module had taken over would keep running in TypeScript and
    // the surface budget would never see the reduction.
    const moduleImpl = () => 7;
    const env = buildForkGuestImports({
      moduleExports: {
        ...stubModuleExports(),
        __wpk_fork_ref_encode_funcref: moduleImpl,
      },
      floor: stubFloor(),
      extras: requiredTables(),
    });
    expect(env.__wpk_fork_ref_encode_funcref).toBe(moduleImpl);
  });

  it("passes non-function imports through untouched", () => {
    const table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
    const env = buildForkGuestImports({
      moduleExports: stubModuleExports(),
      floor: stubFloor(),
      extras: { ...requiredTables(), __wpk_fork_resume_table: table },
    });
    expect(env.__wpk_fork_resume_table).toBe(table);
  });

  it("refuses a build that is missing a required table", () => {
    // Without this the omission surfaces at instantiation as a LinkError about
    // a type mismatch, which names neither the import nor who should supply it.
    const tables = requiredTables();
    const dropped = Object.keys(tables)[0]!;
    delete tables[dropped];
    expect(() =>
      buildForkGuestImports({
        moduleExports: stubModuleExports(),
        floor: stubFloor(),
        extras: tables,
      }),
    ).toThrow(dropped);
  });

  it("keeps the floor exactly as large as the module's unserved set", () => {
    // The floor list and the fork module's coverage are two descriptions of one
    // split. If the module starts serving an entry and the floor keeps its
    // implementation, the host keeps running TypeScript nobody needs -- and
    // `forkGuestImportsUnserved` in docs/surface-budget.json would disagree with
    // this file. That is the drift this pins.
    // ONE, and it is not a capability floor: it is the `exn_*` recipe throw
    // the maintainer deferred, and census section 174 records the drive-slot
    // shape that would serve it from the module. Its ingress twin left at two:
    // that half only ever said "no ingress token exists, because the module
    // refuses the encode that would mint one", and stating a refusal is not
    // host work -- the module sets the errno and traps where the guest's own
    // `unreachable` would have trapped one instruction later.
    //
    // It was six until the module took over encode_funcref and
    // table_mutation_commit, and four until table_state_owned moved -- the host
    // still ELECTS which coordinate owns a physical table, but it seeds that
    // answer once instead of answering a callback, so the module serves the
    // import. The last genuine capability entry, provenance_externref, left at
    // three: its host body recorded a `WeakMap` nothing read, so once that was
    // gone the import was `|value| value` -- and an identity function over an
    // externref is something the injector emits and Rust cannot (section 191).
    // This number falling is what the lane's progress looks like.
    expect(FORK_GUEST_HOST_FLOOR_NAMES.length).toBe(1);
    expect([...FORK_GUEST_HOST_FLOOR_NAMES]).toEqual(
      [...FORK_GUEST_HOST_FLOOR_NAMES].sort(),
    );
    for (const name of FORK_GUEST_HOST_FLOOR_NAMES) {
      expect(
        envImports.some((i) => i.name === name),
        `${name} must be a real required import`,
      ).toBe(true);
    }
  });
});

describe("the artifact's own import list", () => {
  /**
   * A module importing `env.<name>` of a kind the generated lists do not
   * enumerate.
   *
   * Hand-assembled rather than built from a fixture because the point is the
   * KIND: `fork-instrument` emits an imported GLOBAL
   * (`__wpk_fork_module_state_table_generation_addr`, the shared generation
   * fence address), and neither `WPK_FORK_REQUIRED_IMPORTS` (functions) nor
   * `WPK_FORK_REQUIRED_TABLE_IMPORTS` (tables) covers a global.
   */
  function moduleImportingGlobal(
    name: string,
    fromModule = "env",
  ): WebAssembly.Module {
    const bytes: number[] = [
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ];
    const moduleBytes = [...fromModule].map((c) => c.charCodeAt(0));
    const nameBytes = [...name].map((c) => c.charCodeAt(0));
    const entry = [
      moduleBytes.length, ...moduleBytes,
      nameBytes.length, ...nameBytes,
      0x03,       // global
      0x7f, 0x00, // i32, immutable
    ];
    bytes.push(0x02, entry.length + 1, 0x01, ...entry);
    return new WebAssembly.Module(new Uint8Array(bytes));
  }

  it("reports an imported global that no generated list covers", () => {
    const name = "__wpk_fork_module_state_table_generation_addr";
    let message = "";
    try {
      buildForkGuestImports({
        moduleExports: stubModuleExports(),
        floor: stubFloor(),
        extras: requiredTables(),
        guestModule: moduleImportingGlobal(name),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    // Without the artifact check this build SUCCEEDS -- every function and
    // table is bound -- and the failure surfaces later inside
    // `WebAssembly.instantiate` as a type complaint naming no import.
    expect(message).toContain(name);
    expect(message).toContain("global");
  });

  it("accepts the same artifact once the global is supplied", () => {
    const name = "__wpk_fork_module_state_table_generation_addr";
    const env = buildForkGuestImports({
      moduleExports: stubModuleExports(),
      floor: stubFloor(),
      extras: {
        ...requiredTables(),
        [name]: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
      },
      guestModule: moduleImportingGlobal(name),
    });
    expect(env[name]).toBeInstanceOf(WebAssembly.Global);
  });

  it("does not report an import twice when both checks see it", () => {
    // A missing TABLE is caught by the generated list and by the artifact. It
    // must appear once: a caller counting names to size the gap would
    // otherwise read one missing import as two.
    const tables = requiredTables();
    const [first] = Object.keys(tables);
    delete tables[first!];
    let message = "";
    try {
      buildForkGuestImports({
        moduleExports: stubModuleExports(),
        floor: stubFloor(),
        extras: tables,
        guestModule: moduleImportingGlobal(first!),
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split(first!).length - 1).toBe(1);
  });

  it("ignores imports from modules this binder does not own", () => {
    // A fork-instrumented guest also imports from `wasi_snapshot_preview1`,
    // `GOT.mem` and others, all bound by different machinery. Reporting those
    // would make this layer fail on every real artifact while claiming they are
    // fork imports nobody supplied.
    const env = buildForkGuestImports({
      moduleExports: stubModuleExports(),
      floor: stubFloor(),
      extras: requiredTables(),
      guestModule: moduleImportingGlobal("clock_time_get", "wasi_snapshot_preview1"),
    });
    expect(env.clock_time_get).toBeUndefined();
  });

  it("is optional, so a caller without the artifact still binds", () => {
    const env = buildForkGuestImports({
      moduleExports: stubModuleExports(),
      floor: stubFloor(),
      extras: requiredTables(),
    });
    expect(Object.keys(env).length).toBeGreaterThan(0);
  });
});

describe("activation frame trampolines", () => {
  /** A stand-in for the module's emitted table. */
  function table(activations: number): WebAssembly.Table {
    const t = new WebAssembly.Table({
      element: "anyfunc",
      initial: activations * FORK_ACTIVATION_TRAMPOLINE_SLOTS.length,
    });
    return t;
  }

  it("matches the slot ORDER the injector emits", () => {
    // The host indexes this table by slot number. If the two orders drift, one
    // frame import binds to another's entry point -- a wrong answer, not a
    // trap, and one that only shows up as corrupted frames under fork.
    const injector = readFileSync(
      join(import.meta.dirname, "..", "..", "crates/fork-module-inject/src/main.rs"),
      "utf8",
    );
    const block = injector.slice(
      injector.indexOf("let targets: [(&str, bool);"),
      injector.indexOf("let mut resolved"),
    );
    const emitted = [...block.matchAll(/\("(fm_[a-z_]+)",/g)].map((m) => m[1]);
    expect(emitted.length).toBe(FORK_ACTIVATION_TRAMPOLINE_SLOTS.length);
    // The guest-facing name is the module export's name with the `fm_` prefix
    // replaced by the frozen `__wpk_fork_` one.
    expect(emitted.map((n) => n.replace(/^fm_/, "__wpk_fork_"))).toEqual([
      ...FORK_ACTIVATION_TRAMPOLINE_SLOTS,
    ]);
  });

  it("reads one activation's slice, not another's", () => {
    const t = table(4);
    const imports = forkActivationFrameImports(
      { __wpk_fork_activation_trampolines: t },
      2,
    );
    expect(Object.keys(imports).sort()).toEqual(
      [...FORK_ACTIVATION_TRAMPOLINE_SLOTS].sort(),
    );
  });

  it("refuses an activation past the module's cap", () => {
    const t = table(4);
    // Without this the read runs off the end inside `table.get`, which throws
    // without naming the activation anyone asked for.
    expect(() =>
      forkActivationFrameImports({ __wpk_fork_activation_trampolines: t }, 4),
    ).toThrow(/activation 4/);
    expect(() =>
      forkActivationFrameImports({ __wpk_fork_activation_trampolines: t }, -1),
    ).toThrow(/activation -1/);
  });

  it("fails loud when the module has no trampoline table", () => {
    expect(() => forkActivationFrameImports({}, 0)).toThrow(/no activation trampoline table/);
  });
});

describe("the fork unwind tag", () => {
  it("comes from the module that defines it", () => {
    const tag = new WebAssembly.Tag({ parameters: [] });
    expect(forkUnwindTagFrom({ __wpk_fork_unwind: tag })).toBe(tag);
  });

  it("refuses a module that exports no tag", () => {
    // The module DEFINES this tag; a build without the injector pass would
    // otherwise hand `undefined` to `WebAssembly.instantiate`, which reports a
    // type mismatch naming neither the import nor who should have supplied it.
    expect(() => forkUnwindTagFrom({})).toThrow(/no __wpk_fork_unwind tag/);
    expect(() => forkUnwindTagFrom({ __wpk_fork_unwind: {} })).toThrow(
      /no __wpk_fork_unwind tag/,
    );
  });

  it("refuses a non-tag where the tag is required", () => {
    const tag = new WebAssembly.Tag({ parameters: [] });
    expect(requireForkUnwindTag(tag, "ctx")).toBe(tag);
    expect(() => requireForkUnwindTag(undefined, "ctx")).toThrow(/ctx/);
    expect(() => requireForkUnwindTag(null, "ctx")).toThrow(
      /missing valid process-owned fork unwind tag/,
    );
  });

  it("tells the unwind transport apart from a program exception", () => {
    const unwind = new WebAssembly.Tag({ parameters: [] });
    const other = new WebAssembly.Tag({ parameters: [] });
    // Distinguishing these is the entire reason the transport has a private
    // tag: instrumented catch-alls rethrow this one and consume the rest.
    expect(isForkUnwindException(new WebAssembly.Exception(unwind, []), unwind)).toBe(
      true,
    );
    expect(isForkUnwindException(new WebAssembly.Exception(other, []), unwind)).toBe(
      false,
    );
    expect(isForkUnwindException(new Error("boom"), unwind)).toBe(false);
  });
});
