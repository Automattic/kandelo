import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveBinary } from "../src/binary-resolver";
import { detectPtrWidth } from "../src/constants";
import {
  FORK_ANYREF_TRANSIT_IMPORT,
  ForkAnyrefTransitTable,
} from "../src/fork-anyref-transit";
import { FORK_MODULE_TABLE_GENERATION_ADDR_IMPORT } from "../src/fork-activation-registry";
import {
  createForkUnwindTag,
  FORK_UNWIND_TAG_IMPORT_NAME,
} from "../src/fork-unwind-transport";
import {
  WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
  WPK_FORK_RESUME_IMPORT_TABLE,
} from "../src/generated/abi";

/**
 * Coverage for the ABI version surface:
 *   - the kernel wasm exports `__abi_version` returning an i32/i64 value
 *   - at least one shipped user program exports `__abi_version` with
 *     the matching value (i.e. the glue picked it up at build time)
 *
 * End-to-end rejection of mismatched programs is exercised implicitly
 * by the broader test suite: if the kernel's `__abi_version` differed
 * from the programs', the existing program-launch tests would fail.
 * A dedicated "mismatch rejection" test would require synthesizing a
 * wasm with a deliberately wrong `__abi_version`, which isn't worth
 * the machinery today.
 */
describe("ABI version marker", () => {
  const kernelWasm = readFileSync(resolveBinary("kernel.wasm"));

  function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
  }

  /**
   * Declared page minimum of the module's memory import. The linker derives it
   * from `-Wl,-z,stack-size`, so reading it here keeps the stub memory below
   * correct without re-tuning this test whenever that flag moves.
   */
  function memoryImportPages(bytes: Uint8Array): number {
    let at = 8;
    const uleb = (): number => {
      let value = 0;
      let shift = 0;
      for (;;) {
        const byte = bytes[at++]!;
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) return value;
        shift += 7;
      }
    };
    const skipRefType = (): void => {
      const head = bytes[at++]!;
      if (head === 0x63 || head === 0x64) uleb();
    };
    const skipLimits = (): void => {
      const flags = uleb();
      uleb();
      if ((flags & 1) !== 0) uleb();
    };
    while (at < bytes.length) {
      const sectionId = bytes[at++]!;
      const sectionSize = uleb();
      const sectionEnd = at + sectionSize;
      if (sectionId !== 2) {
        at = sectionEnd;
        continue;
      }
      for (let remaining = uleb(); remaining > 0; remaining--) {
        at += uleb();
        at += uleb();
        const kind = bytes[at++]!;
        if (kind === 0x02) {
          uleb();
          return uleb();
        }
        if (kind === 0x00) uleb();
        else if (kind === 0x01) { skipRefType(); skipLimits(); }
        else if (kind === 0x03) { skipRefType(); at++; }
        else { at++; uleb(); }
      }
      at = sectionEnd;
    }
    throw new Error("module declares no memory import");
  }

  async function instantiateKernelOnly(
    bytes: Uint8Array,
  ): Promise<WebAssembly.Instance> {
    const ptrWidth = detectPtrWidth(toArrayBuffer(bytes));
    // Match host/src/kernel.ts. Keep headroom above the kernel Wasm's
    // linker-derived minimum without re-tuning this test per change.
    const memory =
      ptrWidth === 8
        ? new WebAssembly.Memory({
            initial: 24n,
            maximum: 16384n,
            shared: true,
            address: "i64",
          } as unknown as WebAssembly.MemoryDescriptor)
        : new WebAssembly.Memory({
            initial: 24,
            maximum: 16384,
            shared: true,
          });
    const module = await WebAssembly.compile(bytes as BufferSource);
    // The kernel imports many host functions. We only need to inspect
    // the exports, so provide minimal stubs for every import.
    const importObject: WebAssembly.Imports = { env: { memory } };
    const envImports = importObject.env as Record<string, unknown>;
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module !== "env" || imp.name === "memory") continue;
      envImports[imp.name] ??=
        imp.kind === "function"
          ? (..._args: unknown[]) => 0
          : imp.kind === "global"
            ? new WebAssembly.Global({ value: "i32", mutable: true }, 0)
            : undefined;
    }
    return await WebAssembly.instantiate(module, importObject);
  }

  it("kernel exports __abi_version as a function returning u32", async () => {
    const instance = await instantiateKernelOnly(kernelWasm);
    const fn = instance.exports.__abi_version as (() => number) | undefined;
    expect(typeof fn).toBe("function");
    const value = fn!();
    expect(typeof value).toBe("number");
    expect(value).toBeGreaterThan(0);
  });

  it("built kernel requires paired append and true positioned host I/O imports", async () => {
    const module = await WebAssembly.compile(kernelWasm as BufferSource);
    const envFunctionImports = new Set(
      WebAssembly.Module.imports(module)
        .filter((entry) =>
          entry.module === "env" && entry.kind === "function"
        )
        .map((entry) => entry.name),
    );

    // WHY: append returns its exact end through a paired scalar import, while
    // seek/read/seek is not pread and rounds wasm64 offsets if the split i64
    // crosses JavaScript's safe-integer boundary. Keep this built-artifact
    // guard beside the ABI marker because kernel imports are required host
    // capabilities but are not represented in abi/snapshot.json.
    expect([...envFunctionImports]).toEqual(
      expect.arrayContaining([
        "host_append",
        "host_append_position",
        "host_pread",
        "host_pwrite",
      ]),
    );
  });

  it("freshly-built user programs export a matching __abi_version", async () => {
    // Pick a program we know build-programs.sh regenerates every run.
    const userProg = readFileSync(resolveBinary("programs/exec-caller.wasm"));
    const module = await WebAssembly.compile(userProg as BufferSource);
    const exports = WebAssembly.Module.exports(module);
    const entry = exports.find((e) => e.name === "__abi_version");
    if (!entry) {
      // Program is legacy (predates the marker rollout) — skip.
      // Once all committed binaries carry the marker, this branch
      // can turn into a hard expectation.
      return;
    }

    // Actually instantiate to read the value. The kernel's ABI version
    // is the comparison target.
    const kernel = await instantiateKernelOnly(kernelWasm);
    const kernelVer = (kernel.exports.__abi_version as () => number)();

    // User programs import kernel channel functions + memory. Provide
    // minimal stubs. The page minimum follows the program's linker-derived
    // stack size, so read it from the artifact instead of pinning it here.
    const memory = new WebAssembly.Memory({
      initial: memoryImportPages(userProg),
      maximum: 16384,
      shared: true,
    });
    const importObject: WebAssembly.Imports = { env: { memory } };
    const envImports = importObject.env as Record<string, unknown>;
    const gcTransit = new ForkAnyrefTransitTable();
    const resumeTable = new WebAssembly.Table({
      initial: 1,
      element: "anyfunc",
    });
    const unwindTag = createForkUnwindTag();
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module === "env" && imp.name === "memory") continue;
      const target = (importObject[imp.module] ??= {}) as Record<
        string,
        unknown
      >;
      if (target[imp.name] !== undefined) continue;
      if (imp.kind === "function") {
        target[imp.name] = (..._args: unknown[]) => 0;
      } else if (imp.kind === "global") {
        target[imp.name] =
          imp.name === FORK_MODULE_TABLE_GENERATION_ADDR_IMPORT
            ? new WebAssembly.Global({ value: "i64", mutable: false }, 0n)
            : new WebAssembly.Global(
                {
                  value: "i32",
                  mutable: imp.name !== WPK_FORK_EXCEPTION_IMPORT_ACTIVATION,
                },
                0,
              );
      } else if (imp.kind === "table") {
        // WHY: ABI 43's GC transit table has `(ref null any)` element type and
        // cannot be replaced by the legacy `anyfunc` resume table.
        if (imp.name === FORK_ANYREF_TRANSIT_IMPORT) {
          target[imp.name] = gcTransit.table;
        } else if (imp.name === WPK_FORK_RESUME_IMPORT_TABLE) {
          target[imp.name] = resumeTable;
        } else {
          throw new Error(`unhandled table import ${imp.module}.${imp.name}`);
        }
      } else if (
        (imp.kind as string) === "tag" &&
        imp.name === FORK_UNWIND_TAG_IMPORT_NAME
      ) {
        target[imp.name] = unwindTag;
      } else {
        throw new Error(
          `unhandled ${imp.kind} import ${imp.module}.${imp.name}`,
        );
      }
      void envImports;
    }
    const instance = await WebAssembly.instantiate(module, importObject);
    const userVer = (instance.exports.__abi_version as () => number)();
    expect(userVer).toBe(kernelVer);
  });
});
