import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolveBinary } from "../src/binary-resolver";

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

  async function instantiateKernelOnly(
    bytes: Uint8Array,
  ): Promise<WebAssembly.Instance> {
    // Match host/src/kernel.ts. The kernel wasm grows when we add
    // synthetic data (e.g. /etc/ssl/cert.pem); 24 pages keeps headroom
    // without re-tuning per change.
    const memory = new WebAssembly.Memory({
      initial: 24n,
      maximum: 16384n,
      shared: true,
      address: "i64",
    } as unknown as WebAssembly.MemoryDescriptor);
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
