import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createForkModuleHostCapabilities } from "../src/fork-module-host-capabilities";

/**
 * The fork-module's HOST OBLIGATION, asserted end to end.
 *
 * That the obligation as a WHOLE is complete and cannot grow silently, proven
 * the only way that cannot pass vacuously -- by instantiating the real
 * fork-module with these capabilities plus placement and nothing else. A
 * missing import is a `LinkError` naming it.
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
    const caps = createForkModuleHostCapabilities();
    // TWO, and each is argued where it is declared: `any` and `func` are
    // disjoint hierarchies, and wasm cannot compare references in either. The
    // externref pair (`resolve_externref`, `__wpk_fork_host_externref_handle`)
    // left in externref stage E2: a fork does not carry a raw host externref,
    // so the module never names a host object or rebuilds one.
    expect(Object.keys(caps.imports).sort()).toEqual([
      "__wpk_fork_host_func_identity",
      "__wpk_fork_host_ref_identity",
    ]);
  });

  describe("reference identity", () => {
    const identity = () =>
      createForkModuleHostCapabilities().imports
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
      const caps = createForkModuleHostCapabilities();
      const id = caps.imports.__wpk_fork_host_ref_identity;
      const a = {};
      id(a);
      id(a);
      id({});
      expect(caps.distinctReferenceCount).toBe(2);
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
      const caps = createForkModuleHostCapabilities();
      const instance = instantiate({ ...caps.imports, ...moduleTables() });
      // A module that instantiated but exported nothing would satisfy the
      // import check vacuously.
      expect(Object.keys(instance.exports).length).toBeGreaterThan(50);
    });

    it("fails loudly when any one host import is withheld", () => {
      const caps = createForkModuleHostCapabilities();
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

    it("serves the guest's cross-activation throw, and refuses truthfully", () => {
      // `__wpk_fork_ref_exn_broker_throw_recipe` was the LAST member of the
      // host floor. The host implementation answered one question -- which
      // activation owns this exception recipe -- and then called that
      // activation's exported thrower, because only a guest can raise an
      // exception with its own tag. The module answers the same question from
      // the graph IT decoded and reaches the same thrower through a drive slot.
      // Census section 192.
      //
      // What this can assert without a fork: the export exists, and the
      // refusals are truthful. The SUCCESSFUL cross-activation throw needs a
      // sealed graph and a second activation, which no fixture in this suite
      // builds -- the census records that as owed. Its routing is gated in
      // `fork-module-inject`, which checks the emitted `activation * stride +
      // slot` arithmetic exhaustively.
      const caps = createForkModuleHostCapabilities();
      const instance = instantiate({ ...caps.imports, ...moduleTables() });
      const throwRecipe = instance.exports[
        "__wpk_fork_ref_exn_broker_throw_recipe"
      ] as (recipe: number) => void;
      const lastErrno = instance.exports.fm_last_errno as () => number;
      expect(typeof throwRecipe, "the module must export the guest's import").toBe(
        "function",
      );
      // Node 0 is never a recipe (the encoders return >= 1), a poisoned recipe
      // from a refusing encoder is -1, and 1 is plausible but has no replay
      // behind it. All three are EINVAL (22) HERE for the same reason: with no
      // graph there is nothing to ask who owns them, and a guessed activation
      // would be a throw into the wrong module.
      //
      // The node-kind refusal needs a graph to be interesting, so it is gated
      // in `fork-module-gc-replay.test.ts` against a real decoded one.
      for (const recipe of [0, -1, 1]) {
        expect(() => throwRecipe(recipe), `recipe ${recipe}`).toThrow(
          WebAssembly.RuntimeError,
        );
        expect(lastErrno(), `recipe ${recipe}`).toBe(22);
      }
    });

    it("serves the guest's ingress throw by refusing it, with an errno", () => {
      // `__wpk_fork_ref_exn_ingress_throw` was a `fork-guest-host-floor` member
      // whose body threw an `Error` saying no ingress token exists. That is
      // true -- the only minter is `__wpk_fork_ref_exn_broker_encode`, which
      // the module refuses with EOPNOTSUPP -- and stating a bound is not host
      // work. Census section 191.
      //
      // TRAPPING IS THE CONTRACT, not an implementation detail: the
      // instrumenter emits `unreachable` immediately after this call, so an
      // implementation that RETURNED would trap one instruction later in the
      // guest's own frame with no errno set. Trapping here sets the errno
      // first, which is the whole reason to do it in the module.
      const caps = createForkModuleHostCapabilities();
      const instance = instantiate({ ...caps.imports, ...moduleTables() });
      const ingress = instance.exports[
        "__wpk_fork_ref_exn_ingress_throw"
      ] as (token: number) => void;
      expect(typeof ingress, "the module must export the guest's import").toBe(
        "function",
      );
      expect(() => ingress(1)).toThrow(WebAssembly.RuntimeError);
      const lastErrno = instance.exports.fm_last_errno as () => number;
      // 95 is EOPNOTSUPP. Read AFTER the trap on purpose: a trap unwinds to the
      // host but leaves the instance's memory and globals intact, so the sticky
      // errno is exactly what survives to explain it.
      expect(lastErrno()).toBe(95);
    });

    it("imports no externref, and exports no host-externref surface", () => {
      // Externref stage E2. A fork refuses a raw host externref inside the
      // module (EOPNOTSUPP at capture), so nothing crosses the host boundary
      // as an externref in either direction: no import takes or returns one
      // for the module's own use, and the guest-facing decode and provenance
      // hooks that carried host externrefs are gone.
      const module = new WebAssembly.Module(readFileSync(wasmPath));
      const imported = WebAssembly.Module.imports(module).map((i) => i.name);
      const exported = WebAssembly.Module.exports(module).map((e) => e.name);
      for (const name of [
        "resolve_externref",
        "__wpk_fork_host_externref_handle",
      ]) {
        expect(imported, `${name} must not be imported`).not.toContain(name);
      }
      for (const name of [
        "fm_externref_handle",
        "fm_captured_externref",
        "fm_captured_externref_count",
        "__wpk_fork_ref_decode_externref",
        "__wpk_fork_ref_provenance_externref",
      ]) {
        expect(exported, `${name} must not be exported`).not.toContain(name);
      }
    });
  });
});
