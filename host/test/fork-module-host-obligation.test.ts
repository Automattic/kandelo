import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createForkModuleHostCapabilities,
  type ForkExternrefResolver,
} from "../src/fork-module-host-capabilities";

/**
 * The fork-module's HOST OBLIGATION, asserted end to end.
 *
 * `fork-module-host-capabilities.test.ts` is the M2 unit test of
 * `resolve_externref` against the real token cache. This file is the
 * complementary check: that the obligation as a WHOLE is complete and cannot
 * grow silently. It uses a structural stub resolver so it does not depend on
 * the broker, and it proves completeness the only way that cannot pass
 * vacuously -- by instantiating the real fork-module with these capabilities
 * plus placement and nothing else. A missing import is a `LinkError` naming it.
 *
 * It loads the artifact `crates/fork-module/build-wasm.sh` stages, by explicit
 * path. That is deliberate (master-plan H-9): the resolver prefers
 * `local-binaries/source-only-v1/`, which a local-build projection writes
 * later, so resolving here would test whichever module a projection last wrote.
 *
 * Placement uses the same fixed constants as the V8 harnesses rather than the
 * module's `dylink.0` sizing, because this module's `dylink.0` is the LAST
 * section and `parseDylinkSection` requires it first, so it reads null. An
 * earlier draft depended on it and the withheld-capability assertion passed for
 * the WRONG reason -- it threw on the missing section before reaching
 * instantiation. Placement is not this file's subject; completeness is.
 */
const repoRoot = join(__dirname, "..", "..");
const wasmPath = join(repoRoot, "local-binaries", "fork_module32.wasm");

const PAGE = 65536;
const MODULE_BASE = 32 * 1024 * 1024;
const STACK_TOP = MODULE_BASE + 16 * 1024 * 1024 + 1024 * 1024;
const INITIAL_PAGES = Math.ceil((STACK_TOP + PAGE) / PAGE);

/** A resolver that honours a fixed map and THROWS for anything else. */
function stubResolver(known: Map<number, object> = new Map()): ForkExternrefResolver {
  return {
    materialize(handle: number): object {
      const value = known.get(handle);
      if (value === undefined) {
        throw new RangeError(`no reference for handle ${handle}`);
      }
      return value;
    },
    encode(value: unknown): number | undefined {
      for (const [handle, known_value] of known) {
        if (known_value === value) return handle;
      }
      return undefined;
    },
  };
}

/** The three reference-typed tables `fork-module-instance` owns. */
/**
 * The indirect-function-table size the artifact's `dylink.0` declares.
 *
 * The same subsection `host/src/fork-module-instance.ts` reads to place the
 * module; read here rather than imported because this file loads the artifact
 * by explicit path and must not depend on the placement path it is checking.
 */
function indirectTableSize(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8; // magic + version
  while (at < bytes.length) {
    const id = bytes[at++]!;
    let size = 0;
    let shift = 0;
    for (;;) {
      const byte = bytes[at++]!;
      size |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    const end = at + size;
    if (id === 0) {
      let nameLen = 0;
      shift = 0;
      for (;;) {
        const byte = bytes[at++]!;
        nameLen |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      const name = new TextDecoder().decode(bytes.subarray(at, at + nameLen));
      at += nameLen;
      if (name === "dylink.0") {
        // subsection 1 = memory info: memorySize, memoryAlign, tableSize, ...
        while (at < end) {
          const kind = bytes[at++]!;
          let subSize = 0;
          shift = 0;
          for (;;) {
            const byte = bytes[at++]!;
            subSize |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) break;
            shift += 7;
          }
          const subEnd = at + subSize;
          if (kind === 1) {
            const leb = (): number => {
              let value = 0;
              let s = 0;
              for (;;) {
                const byte = bytes[at++]!;
                value |= (byte & 0x7f) << s;
                if ((byte & 0x80) === 0) break;
                s += 7;
              }
              return value >>> 0;
            };
            leb();
            leb();
            return leb();
          }
          at = subEnd;
        }
      }
    }
    at = end;
  }
  throw new Error("the fork-module artifact declares no dylink.0 memory info");
}

function moduleTables() {
  return {
    __wpk_fork_function_catalog: new WebAssembly.Table({
      element: "anyfunc",
      initial: 0,
    }),
    __wpk_fork_drive_table: new WebAssembly.Table({
      element: "anyfunc",
      initial: 0,
    }),
    // `anyref`, NOT `externref`: the static-root binder holds GC-hierarchy
    // values, and `any` and `extern` are disjoint roots, so the wrong one is
    // rejected at instantiation.
    __wpk_fork_static_root_catalog: new WebAssembly.Table({
      element: "anyref",
      initial: 0,
    }),
  };
}

function instantiate(env: Record<string, unknown>) {
  const bytes = readFileSync(wasmPath);
  const memory = new WebAssembly.Memory({
    initial: INITIAL_PAGES,
    maximum: 16384,
    shared: true,
  });
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    env: {
      memory,
      // SIZED FROM THE ARTIFACT, not from a constant. A PIC side module
      // declares how many indirect-call slots its own elements need, and the
      // injector's shims put functions there -- so a fixed 0 was a test that
      // failed the day the module gained its first `call_indirect` target
      // (`table import 1 is smaller than initial 2`), which says nothing about
      // the host obligation this file is about. Production reads the same
      // number out of `dylink.0`.
      __indirect_function_table: new WebAssembly.Table({
        element: "anyfunc",
        initial: indirectTableSize(bytes),
      }),
      __stack_pointer: new WebAssembly.Global(
        { value: "i32", mutable: true },
        STACK_TOP,
      ),
      __memory_base: new WebAssembly.Global(
        { value: "i32", mutable: false },
        MODULE_BASE,
      ),
      __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
      ...env,
    },
  });
}

describe("fork-module host obligation", () => {
  it("names exactly the host FUNCTIONS, so the set cannot drift silently", () => {
    const caps = createForkModuleHostCapabilities({ tokens: stubResolver() });
    // FOUR, and each is argued where it is declared: two identity imports
    // (`any` and `func` are disjoint hierarchies, and wasm cannot compare
    // references in either), and the externref pair -- `resolve_externref`
    // brings a handle back to life in a child, `__wpk_fork_host_externref_handle`
    // says which handle names a live value so a parent's capture can record it.
    expect(Object.keys(caps.imports).sort()).toEqual([
      "__wpk_fork_host_externref_handle",
      "__wpk_fork_host_func_identity",
      "__wpk_fork_host_ref_identity",
      "resolve_externref",
    ]);
  });

  describe("reference identity", () => {
    const identity = () =>
      createForkModuleHostCapabilities({ tokens: stubResolver() }).imports
        .__wpk_fork_host_ref_identity;

    it("is stable per reference and distinct across references", () => {
      const id = identity();
      const a = {};
      const b = {};
      expect(id(a)).toBe(id(a));
      expect(id(a)).not.toBe(id(b));
    });

    it("treats equal i31 payloads as the same reference", () => {
      // An i31ref arrives here as a number. Equal payloads ARE the same
      // reference, so they must share an identity: a WeakMap alone would throw
      // on them, and a fresh id each time would split one value into two
      // recipes in the child.
      const id = identity();
      expect(id(7)).toBe(id(7));
      expect(id(7)).not.toBe(id(8));
    });

    it("never issues 0, which the module reads as 'no recipe bound'", () => {
      const id = identity();
      expect(id({})).toBeGreaterThan(0);
    });

    it("rejects a null reference instead of sharing one identity", () => {
      const id = identity();
      expect(() => id(null)).toThrow(RangeError);
      expect(() => id(undefined)).toThrow(RangeError);
    });

    it("counts distinct references for capture diagnostics", () => {
      const caps = createForkModuleHostCapabilities({ tokens: stubResolver() });
      const id = caps.imports.__wpk_fork_host_ref_identity;
      const a = {};
      id(a);
      id(a);
      id({});
      expect(caps.distinctReferenceCount).toBe(2);
    });
  });

  describe("resolve_externref", () => {
    it("returns the identical object the registry materializes", () => {
      const value = { live: true };
      const caps = createForkModuleHostCapabilities({
        tokens: stubResolver(new Map([[42, value]])),
      });
      expect(caps.imports.resolve_externref(42)).toBe(value);
    });

    it("propagates a truthful RangeError rather than a null sentinel", () => {
      // A sentinel would let a replay continue with a reference it never
      // actually restored.
      const caps = createForkModuleHostCapabilities({ tokens: stubResolver() });
      expect(() => caps.imports.resolve_externref(9)).toThrow(RangeError);
    });

    it("advances resolvedCount once per resolve (proof-of-use)", () => {
      const caps = createForkModuleHostCapabilities({
        tokens: stubResolver(new Map([[1, {}], [2, {}]])),
      });
      expect(caps.resolvedCount).toBe(0);
      caps.imports.resolve_externref(1);
      caps.imports.resolve_externref(2);
      expect(caps.resolvedCount).toBe(2);
    });
  });

  describe("against the real fork-module", () => {
    if (!existsSync(wasmPath)) {
      // Provisioning, not a defect: build with
      // `crates/fork-module/build-wasm.sh`.
      it.skip("fork module not built", () => {});
      return;
    }

    it("these capabilities plus placement satisfy every import", () => {
      const caps = createForkModuleHostCapabilities({ tokens: stubResolver() });
      const instance = instantiate({ ...caps.imports, ...moduleTables() });
      // A module that instantiated but exported nothing would satisfy the
      // import check vacuously.
      expect(Object.keys(instance.exports).length).toBeGreaterThan(50);
    });

    it("fails loudly when any one host import is withheld", () => {
      const caps = createForkModuleHostCapabilities({ tokens: stubResolver() });
      const full = { ...caps.imports, ...moduleTables() } as Record<string, unknown>;
      for (const name of Object.keys(full)) {
        const withheld = { ...full };
        delete withheld[name];
        expect(
          () => instantiate(withheld),
          `withholding ${name} must fail instantiation`,
        ).toThrow();
      }
    });
  });
});
