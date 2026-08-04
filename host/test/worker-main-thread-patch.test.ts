import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { patchWasmForThread } from "../src/worker-main";

describe("thread Wasm patching", () => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "kandelo-thread-patch-"));
  let programBytes: ArrayBuffer;

  beforeAll(() => {
    const watPath = join(fixtureDirectory, "exported-ctors.wat");
    const wasmPath = join(fixtureDirectory, "exported-ctors.wasm");
    writeFileSync(
      watPath,
      `(module
        (func $__errno_location (result i32)
          i32.const 7)
        (func $__wasm_call_ctors)
        (func $__wasm_init_memory)
        (func $__abi_version (result i32)
          call $__errno_location)
        (func $__get_channel_base_addr (result i32)
          call $__errno_location)
        (func $_start
          call $__errno_location
          drop)
        (start $__wasm_init_memory)
        (export "__errno_location" (func $__errno_location))
        (export "__wasm_call_ctors" (func $__wasm_call_ctors))
        (export "__abi_version" (func $__abi_version))
        (export "__get_channel_base_addr" (func $__get_channel_base_addr))
        (export "_start" (func $_start)))\n`,
    );
    execFileSync("wat2wasm", [watPath, "-o", wasmPath]);
    const bytes = readFileSync(wasmPath);
    programBytes = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  });

  afterAll(() => {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  });

  it("prefers an exported constructor over a frequently called helper", async () => {
    const patched = patchWasmForThread(programBytes);
    const module = await WebAssembly.compile(patched);
    const instance = await WebAssembly.instantiate(module);
    const errnoLocation = instance.exports.__errno_location as () => number;

    expect(errnoLocation()).toBe(7);
  });
});
