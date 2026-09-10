/**
 * The Rust planner, driving a REAL compiled side module on a JavaScript host.
 *
 * Everything about `crates/dylink` up to now has been provable only from Rust:
 * `cargo test -p dylink` exercises the planner against synthetic module shapes,
 * and `cargo test -p dylink-module` exercises the session machine. Neither
 * touches a `WebAssembly.Module`, because neither can — the planner emits acts
 * and something else has to perform them.
 *
 * This is that something else, and this test is the first evidence that the two
 * halves fit: a `.so` built by the real SDK toolchain, parsed by the Rust
 * `dylink.0` reader, placed by the Rust placement arithmetic, relocated by the
 * Rust GOT planner, and instantiated by `host/src/dylink-planner.ts` into a
 * live `WebAssembly.Instance` whose exported function returns the right answer.
 *
 * It runs the STANDALONE linker path — no allocator, no fork activation owner,
 * no syscall channel — so it isolates the planner and its executor from the
 * process host. That is deliberate: a failure here is the linker, not the
 * process.
 *
 * ## The gate, and why it is written this way
 *
 * The dlopen suites in this tree skip silently when their artifacts are absent,
 * which is how a 6,340-line deletion came to be guarded by a gate armed to pass
 * by default (`docs/plans/2026-09-10-rust-first-campaign-status.md`, "the fifth
 * silent-success defect"). So this file reports what it skipped and why, and
 * the skip condition names an artifact a developer can build, rather than
 * disappearing into a green run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import {
  DylinkActExecutor,
  PlannerSession,
  drivePlan,
  type DylinkEngineEnvironment,
  type DylinkProcessHost,
} from "../src/dylink-planner";
import {
  Reader,
  Writer,
  decodeActResult,
  encodeActResult,
  type ActResult,
} from "../src/dylink-planner-wire";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");

const PLANNER_WASM = [
  join(REPO_ROOT, "local-binaries", "dylink_module32.wasm"),
  join(REPO_ROOT, "host", "wasm", "dylink_module32.wasm"),
  join(REPO_ROOT, "binaries", "dylink_module32.wasm"),
].find(existsSync);

function hasCompiler(): boolean {
  try {
    execFileSync("wasm32posix-cc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const CAN_BUILD = hasCompiler();
const PAGE = 65536;

describe("the Rust planner drives a real side module", () => {
  let plannerModule: WebAssembly.Module | undefined;

  beforeAll(() => {
    if (PLANNER_WASM) {
      plannerModule = new WebAssembly.Module(readFileSync(PLANNER_WASM));
    }
  });

  it("has its artifacts, or says exactly which one is missing", () => {
    // Not an assertion that they exist -- a fresh worktree legitimately has
    // neither. It is an assertion that the run REPORTS which, so a green suite
    // cannot be mistaken for a proven one.
    const missing: string[] = [];
    if (!PLANNER_WASM) missing.push("local-binaries/dylink_module32.wasm");
    if (!CAN_BUILD) missing.push("wasm32posix-cc (run inside scripts/dev-shell.sh)");
    if (missing.length > 0) {
      console.warn(
        `dylink planner drive: NOT PROVEN, missing ${missing.join(" and ")}`,
      );
    }
    expect(Array.isArray(missing)).toBe(true);
  });

  it("compiles, places, relocates and instantiates a .so, and calls into it", () => {
    if (!plannerModule || !CAN_BUILD) {
      console.warn("dylink planner drive: SKIPPED (artifacts missing, see above)");
      return;
    }

    const build = mkdtempSync(join(tmpdir(), "dylink-planner-"));
    const source = join(build, "adder.c");
    const object = join(build, "adder.so");
    writeFileSync(
      source,
      [
        // Mutated, so the object genuinely needs a data segment and a real
        // `__memory_base` rather than a constant the optimizer folded away.
        "static int bias = 7;",
        "int adder_bias(void) { return bias; }",
        "int adder_bump(void) { return ++bias; }",
        "int adder_add(int a, int b) { return a + b + bias; }",
      ].join("\n"),
    );
    execFileSync("wasm32posix-cc", ["-shared", "-fPIC", "-O2", source, "-o", object], {
      stdio: "pipe",
    });
    const image = new Uint8Array(readFileSync(object));

    // A standalone address space: no kernel, no allocator, so the planner
    // places the object by growing this memory itself.
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 64, shared: true });
    const table = new WebAssembly.Table({ initial: 8, element: "anyfunc" });
    const stackPointer = new WebAssembly.Global({ value: "i32", mutable: true }, 4 * PAGE);

    const environment: DylinkEngineEnvironment = {
      memory,
      table,
      stackPointer,
      mainInstance: () => undefined,
      activationEnv: (name) => {
        throw new Error(`unexpected activation import ${name}`);
      },
    };
    const refused = (operation: string) => (): never => {
      throw new Error(`the standalone linker path must not ${operation}`);
    };
    const host: DylinkProcessHost = {
      allocateMemory: refused("allocate through the kernel"),
      adoptMapping: refused("adopt a mapping"),
      releaseMapping: refused("release a mapping"),
      prepareActivation: refused("prepare a fork activation"),
      registerActivation: refused("register a fork activation"),
      unregisterActivation: refused("unregister a fork activation"),
      journalTableMutation: () => {
        /* no fork archive on this path */
      },
    };

    const session = PlannerSession.instantiate(plannerModule);
    session.configure({
      pointerWidth: 4,
      hasAllocator: false,
      forkActivationAvailable: false,
      forkActivationUnavailableReason: "the standalone linker path has no activation owner",
      unresolvedPolicy: "elfStrict",
      memoryBytes: BigInt(memory.buffer.byteLength),
      sharedMemory: true,
      heapPointer: BigInt(memory.buffer.byteLength),
    });
    // No main image: the global scope is empty, so this object must be
    // self-contained. That is the strictest form of the test -- anything it
    // fails to resolve is a real undefined symbol, not a missing fixture.
    session.publishMainImage({ tableLength: BigInt(table.length), exports: [], elementSlots: [] });

    const executor = new DylinkActExecutor(environment, host);
    executor.setCurrentImage(image);

    const stages: string[] = [];
    session.openBegin({
      name: "adder.so",
      moduleBytes: image,
      globalVisibility: true,
      borrowedMemory: false,
    });
    const layout = { instance: -1 };
    drivePlan(session, executor, (call) => {
      stages.push(call.stage);
      layout.instance = call.instance;
      const target = executor.instance(call.instance)?.exports[call.exportName];
      if (typeof target === "function") (target as () => void)();
    });
    const plan = session.planLayout();
    const handle = session.openFinish();

    expect(handle).toBeGreaterThan(1);
    // `__wasm_apply_data_relocs` and `__wasm_call_ctors` are the two stages an
    // uninstrumented object has; `wpk_fork_module_bootstrap` needs a fork
    // activation and must NOT appear here.
    expect(stages).not.toContain("bootstrap");
    expect(plan.memoryBase).toBeGreaterThan(0n);

    const instance = executor.instance(plan.instance);
    expect(instance).toBeDefined();
    const add = instance!.exports.adder_add as (a: number, b: number) => number;
    const bias = instance!.exports.adder_bias as () => number;
    expect(bias()).toBe(7);
    expect(add(20, 15)).toBe(42);
    const bump = instance!.exports.adder_bump as () => number;
    expect(bump()).toBe(8);
    // The data segment was placed at the relocated base and is writable there.
    expect(add(20, 15)).toBe(43);

    // dlsym goes through the planner's scope, not through `instance.exports`.
    const resolved = session.sym(handle, "adder_add");
    expect(resolved).not.toBeNull();
    expect(resolved!.value.kind).toBe("func");
    expect(session.sym(handle, "no_such_symbol")).toBeNull();

    // The object is the only thing holding itself, so dlclose releases it.
    const outcome = session.close(handle);
    expect(outcome.outcome).toBe("released");
    expect(session.isUnloadable("adder.so")).toBe(true);
  });

  it("refuses a strong undefined symbol instead of zeroing it", () => {
    if (!plannerModule || !CAN_BUILD) return;

    const build = mkdtempSync(join(tmpdir(), "dylink-planner-undef-"));
    const source = join(build, "needs.c");
    const object = join(build, "needs.so");
    writeFileSync(
      source,
      ["extern int missing_helper(int);", "int call_it(int v) { return missing_helper(v); }"].join(
        "\n",
      ),
    );
    execFileSync("wasm32posix-cc", ["-shared", "-fPIC", "-O2", source, "-o", object], {
      stdio: "pipe",
    });
    const image = new Uint8Array(readFileSync(object));

    const memory = new WebAssembly.Memory({ initial: 4, maximum: 64, shared: true });
    const table = new WebAssembly.Table({ initial: 8, element: "anyfunc" });
    const session = PlannerSession.instantiate(plannerModule);
    session.configure({
      pointerWidth: 4,
      hasAllocator: false,
      forkActivationAvailable: false,
      forkActivationUnavailableReason: "standalone",
      unresolvedPolicy: "elfStrict",
      memoryBytes: BigInt(memory.buffer.byteLength),
      sharedMemory: true,
      heapPointer: BigInt(memory.buffer.byteLength),
    });
    session.publishMainImage({ tableLength: BigInt(table.length), exports: [], elementSlots: [] });

    const executor = new DylinkActExecutor(
      {
        memory,
        table,
        stackPointer: new WebAssembly.Global({ value: "i32", mutable: true }, 4 * PAGE),
        mainInstance: () => undefined,
        activationEnv: (name) => {
          throw new Error(`unexpected activation import ${name}`);
        },
      },
      {
        allocateMemory: () => {
          throw new Error("no allocator");
        },
        adoptMapping: () => {},
        releaseMapping: () => {},
        prepareActivation: () => 0,
        registerActivation: () => {},
        unregisterActivation: () => {},
        journalTableMutation: () => {},
      },
    );
    executor.setCurrentImage(image);

    // ELF: a STRONG undefined symbol fails the load. K5 adjudicated this on ELF
    // and RTLD_LAZY semantics, not on which symbols any package happens to
    // leave unresolved, so it must hold for a module no artifact in this tree
    // ships.
    expect(() => {
      session.openBegin({
        name: "needs.so",
        moduleBytes: image,
        globalVisibility: true,
        borrowedMemory: false,
      });
      drivePlan(session, executor, (call) => {
        const target = executor.instance(call.instance)?.exports[call.exportName];
        if (typeof target === "function") (target as () => void)();
      });
      session.openFinish();
    }).toThrow(/missing_helper|undefined/i);
  });
});

describe("the wire format agrees with crates/dylink/src/wire.rs", () => {
  it("round-trips every ActResult shape", () => {
    const cases: ActResult[] = [
      { result: "done" },
      { result: "value", value: { kind: "i32", value: 0xdead_beef } },
      { result: "value", value: { kind: "i64", value: 0xfedc_ba98_7654_3210n } },
      { result: "index", index: 0x1_0000_0001n },
      {
        result: "exports",
        exports: [
          { name: "f", kind: "func" },
          { name: "g", kind: "global", value: { kind: "i32", value: 12 }, mutable: false },
          { name: "h", kind: "global", value: { kind: "i64", value: 12n }, mutable: true },
        ],
      },
    ];
    for (const value of cases) {
      expect(decodeActResult(encodeActResult(value))).toEqual(value);
    }
  });

  it("refuses a record with trailing bytes", () => {
    const bytes = encodeActResult({ result: "done" });
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(() => decodeActResult(padded)).toThrow(/trailing bytes/);
  });

  it("refuses a vector length the record cannot possibly back", () => {
    const w = new Writer();
    w.u8(3); // Exports
    w.u32(0xffff_ffff);
    const r = new Reader(w.bytes());
    r.u8();
    expect(() => r.vecLen(4)).toThrow(/exceeds record/);
  });
});

/**
 * What the module surface does NOT yet let a driver do.
 *
 * These are not aspirational tests. Each one pins a gap standing between this
 * executor and the deletion of `host/src/dylink.ts`, and each is written so
 * that CLOSING the gap makes the test fail — at which point it becomes the
 * positive test for the new behaviour. Recording them as executed assertions
 * rather than as prose in a plan is the difference between a measured boundary
 * and a remembered one.
 *
 * See NDD-K5-1 in `docs/plans/2026-09-10-rust-first-campaign-status.md`.
 */
describe("the gaps between this executor and the dlopen cutover", () => {
  let plannerModule: WebAssembly.Module | undefined;

  beforeAll(() => {
    if (PLANNER_WASM) plannerModule = new WebAssembly.Module(readFileSync(PLANNER_WASM));
  });

  function standaloneSession(): { session: PlannerSession; memory: WebAssembly.Memory } {
    const memory = new WebAssembly.Memory({ initial: 4, maximum: 64, shared: true });
    const session = PlannerSession.instantiate(plannerModule!);
    session.configure({
      pointerWidth: 4,
      hasAllocator: false,
      forkActivationAvailable: false,
      forkActivationUnavailableReason: "standalone",
      unresolvedPolicy: "elfStrict",
      memoryBytes: BigInt(memory.buffer.byteLength),
      sharedMemory: true,
      heapPointer: BigInt(memory.buffer.byteLength),
    });
    session.publishMainImage({ tableLength: 8n, exports: [], elementSlots: [] });
    return { session, memory };
  }

  function bareExecutor(memory: WebAssembly.Memory): DylinkActExecutor {
    return new DylinkActExecutor(
      {
        memory,
        table: new WebAssembly.Table({ initial: 8, element: "anyfunc" }),
        stackPointer: new WebAssembly.Global({ value: "i32", mutable: true }, 4 * PAGE),
        mainInstance: () => undefined,
        activationEnv: (name) => {
          throw new Error(`unexpected activation import ${name}`);
        },
      },
      {
        allocateMemory: () => {
          throw new Error("no allocator on the standalone path");
        },
        adoptMapping: () => {},
        releaseMapping: () => {},
        prepareActivation: () => 0,
        registerActivation: () => {},
        unregisterActivation: () => {},
        journalTableMutation: () => {},
      },
    );
  }

  function buildSo(dir: string, name: string, body: string, extra: string[] = []): Uint8Array {
    const source = join(dir, `${name}.c`);
    const object = join(dir, `${name}.so`);
    writeFileSync(source, body);
    execFileSync(
      "wasm32posix-cc",
      ["-shared", "-fPIC", "-O2", source, ...extra, "-o", object],
      { stdio: "pipe" },
    );
    return new Uint8Array(readFileSync(object));
  }

  it("refuses a second concurrent dlopen instead of nesting it", () => {
    if (!plannerModule || !CAN_BUILD) return;
    const build = mkdtempSync(join(tmpdir(), "dylink-planner-nest-"));
    const image = buildSo(build, "leaf", "static int v = 1;\nint leaf(void) { return ++v; }\n");

    const { session } = standaloneSession();
    const request = {
      name: "leaf.so",
      moduleBytes: image,
      globalVisibility: true,
      borrowedMemory: false,
    };
    session.openBegin(request);
    // A constructor that calls `dlopen` is legal POSIX, and
    // `LoadState::Initializing` exists for exactly that case.
    // `worker-main.ts` keeps a MAP of pending transaction tokens; this module
    // has one slot.
    expect(() => session.openBegin({ ...request, name: "other.so" })).toThrow();
  });

  it("has no way to resolve a DT_NEEDED dependency for the driver", () => {
    if (!plannerModule || !CAN_BUILD) return;
    const build = mkdtempSync(join(tmpdir(), "dylink-planner-needed-"));
    buildSo(build, "libleaf", "int leaf_value(void) { return 5; }\n");
    const top = buildSo(
      build,
      "libtop",
      "extern int leaf_value(void);\nint top(void) { return leaf_value() + 1; }\n",
      [join(build, "libleaf.so")],
    );

    const { session, memory } = standaloneSession();
    const executor = bareExecutor(memory);
    executor.setCurrentImage(top);

    // The planner requires every `DT_NEEDED` object already in scope. No
    // `HostRequest` asks the driver to fetch one, and no entry point reports an
    // image's NEEDED list, so a driver cannot satisfy this without parsing
    // `dylink.0` itself -- which would put linker policy back into TypeScript.
    expect(() => {
      session.openBegin({
        name: "libtop.so",
        moduleBytes: top,
        globalVisibility: true,
        borrowedMemory: false,
      });
      drivePlan(session, executor, () => {});
      session.openFinish();
    }).toThrow();
  });
});
