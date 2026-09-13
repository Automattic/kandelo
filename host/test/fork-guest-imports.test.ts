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
    expect(FORK_GUEST_HOST_FLOOR_NAMES.length).toBe(6);
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
