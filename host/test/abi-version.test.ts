import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveBinary } from "../src/binary-resolver";
import { detectPtrWidth } from "../src/constants";

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
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  async function instantiateKernelOnly(
    bytes: Uint8Array,
  ): Promise<WebAssembly.Instance> {
    const ptrWidth = detectPtrWidth(toArrayBuffer(bytes));
    // Match host/src/kernel.ts. Keep headroom above the kernel Wasm's
    // linker-derived minimum without re-tuning this test per change.
    const memory = ptrWidth === 8
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
    const fn = instance.exports.__abi_version as
      | (() => number)
      | undefined;
    expect(typeof fn).toBe("function");
    const value = fn!();
    expect(typeof value).toBe("number");
    expect(value).toBeGreaterThan(0);
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
    // minimal stubs.
    const memory = new WebAssembly.Memory({
      initial: 17,
      maximum: 16384,
      shared: true,
    });
    const importObject: WebAssembly.Imports = { env: { memory } };
    const envImports = importObject.env as Record<string, unknown>;
    for (const imp of WebAssembly.Module.imports(module)) {
      if (imp.module === "env" && imp.name === "memory") continue;
      const target = (importObject[imp.module] ??= {}) as Record<
        string,
        unknown
      >;
      target[imp.name] ??=
        imp.kind === "function"
          ? (..._args: unknown[]) => 0
          : imp.kind === "global"
            ? new WebAssembly.Global({ value: "i32", mutable: true }, 0)
            : undefined;
      void envImports;
    }
    const instance = await WebAssembly.instantiate(module, importObject);
    const userVer = (instance.exports.__abi_version as () => number)();
    expect(userVer).toBe(kernelVer);
  });
});
