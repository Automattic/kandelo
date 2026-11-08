import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureWasmStackText, createStackCaptureImport, parseWasmStack } from "../src/wasm-stack-capture";
import { describeProgramExtensionFailures } from "../src/program-extensions";
import { describeWasmArtifactPolicyFailures, readWasmFunctionImports, readWasmImportDescriptors } from "../src/constants";
import * as wire from "../src/generated/program-extensions";
const repo = resolve(import.meta.dirname, "../..");
let directory: string, bytes: ArrayBuffer;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "kandelo-stack-capture-"));
  const source = join(directory, "stack.wat"), output = join(directory, "stack.wasm");
  writeFileSync(source, `(module
    (import "env" "memory" (memory 1))
    (import "${wire.STACK_MODULE}" "${wire.STACK_IMPORT}" (func $capture (param i32 i32 i32) (result i32)))
    (func $inner (param i32) (result i32) local.get 0 i32.const 4096 i32.const 8 call $capture)
    (func $outer (export "run") (param i32) (result i32) local.get 0 call $inner))`);
  execFileSync("wat2wasm", ["--debug-names", source, "-o", output]);
  bytes = Uint8Array.from(readFileSync(output)).buffer;
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true }); });

describe("versioned stack capture", () => {
  it("captures actual Wasm frames and restores V8's stack limit", async () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const descriptor = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
    const formatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    let stack = "";
    const capture = createStackCaptureImport(memory, 4, bytes, () => true, () => { stack = captureWasmStackText(); return stack; });
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory }, [wire.STACK_MODULE]: { [wire.STACK_IMPORT]: capture } });
    const length = (instance.exports.run as (pointer: number) => number)(1024);
    expect(length, stack).toBeGreaterThan(wire.STACK_HEADER_BYTES);
    const packet = new DataView(memory.buffer, 1024, length);
    expect(packet.getUint32(0, true)).toBe(wire.STACK_MAGIC);
    expect(packet.getUint32(wire.STACK_COUNT_OFFSET, true)).toBe(2);
    let offset = wire.STACK_HEADER_BYTES as number;
    for (const name of ["inner", "outer"]) {
      expect(packet.getUint32(offset + wire.STACK_FRAME_FLAGS_OFFSET, true) & wire.STACK_FRAME_HAS_PC).not.toBe(0);
      const length = packet.getUint32(offset + wire.STACK_FRAME_NAME_LENGTH_OFFSET, true);
      expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 1024 + offset + wire.STACK_FRAME_HEADER_BYTES, length))).toBe(name);
      offset += wire.STACK_FRAME_HEADER_BYTES + length;
    }
    expect(Object.getOwnPropertyDescriptor(Error, "stackTraceLimit")).toEqual(descriptor);
    expect(Object.getOwnPropertyDescriptor(Error, "prepareStackTrace")).toEqual(formatter);
  });
  it("refuses invalid buffer authority before capture and leaves memory alone", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    new Uint8Array(memory.buffer).fill(0xa5);
    let calls = 0;
    const capture = createStackCaptureImport(memory, 4, bytes, () => true, () => { calls++; return ""; });
    expect(capture(-1, 128, 8)).toBe(wire.STACK_INVALID_ADDRESS);
    expect(capture(65530, 128, 8)).toBe(wire.STACK_INVALID_ADDRESS);
    expect(capture(0, wire.STACK_MAX_PACKET_BYTES + 1, 8)).toBe(wire.STACK_INVALID_ARGUMENT);
    expect(capture(0, 128, wire.STACK_MAX_FRAMES + 1)).toBe(wire.STACK_INVALID_ARGUMENT);
    expect(calls).toBe(0);
    expect(new Uint8Array(memory.buffer).every(byte => byte === 0xa5)).toBe(true);
  });
  it("keeps ambiguous module ownership unresolved", () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const capture = createStackCaptureImport(memory, 4, bytes, () => false, () => "at inner (wasm://wasm/test:wasm-function[1]:0x80)");
    const length = capture(0, 4096, 8);
    const packet = new DataView(memory.buffer, 0, length);
    expect(packet.getUint16(wire.STACK_FLAGS_OFFSET, true) & wire.STACK_FLAG_MODULE_UNRESOLVED).not.toBe(0);
    expect(new Uint8Array(memory.buffer, wire.STACK_MODULE_HASH_OFFSET, 32).every(byte => byte === 0)).toBe(true);
    expect(packet.getUint32(wire.STACK_HEADER_BYTES + wire.STACK_FRAME_FLAGS_OFFSET, true) & wire.STACK_FRAME_HAS_SOURCE).toBe(0);
  });
  it("recognizes observed engine formats without inventing missing PCs", () => {
    const frames = parseWasmStack("at inner (wasm://wasm/a:wasm-function[1]:0x32)\nouter@file:wasm-function[2]:0x37\nthird@wasm-function[3]", 8).frames;
    expect(frames.map(frame => [frame.index, frame.pc])).toEqual([[1,50],[2,55],[3,undefined]]);
  });
  it("requires supported versions and exact pointer-sensitive signatures", () => {
    const imports = readWasmImportDescriptors(bytes), functions = readWasmFunctionImports(bytes);
    expect(describeProgramExtensionFailures(imports, functions, [4])).toEqual([]);
    expect(describeWasmArtifactPolicyFailures(bytes)).toEqual([]);
    expect(describeProgramExtensionFailures(imports, functions, [4], new Set())).not.toEqual([]);
    expect(describeProgramExtensionFailures(imports, functions, [8])).not.toEqual([]);
    expect(describeProgramExtensionFailures(imports.map(entry => entry.module === wire.STACK_MODULE ? { ...entry, module: "kandelo.stack.v2" } : entry), functions, [4])).not.toEqual([]);
    expect(describeProgramExtensionFailures([], [], [4], new Set())).toEqual([]);
  });
  it("resolves source locations from the actual prepared module", () => {
    const llvm = process.env.LLVM_BIN;
    if (!llvm) throw new Error("run this test using scripts/dev-shell.sh");
    const original = join(directory, "linked.wasm"), prepared = join(directory, "prepared.wasm");
    for (const file of ["inner.c", "outer.c"]) writeFileSync(join(directory, file), readFileSync(join(repo, "crates/fork-instrument/tests/fixtures/debug-lines", file)));
    const sourceRoot = execFileSync("pwd", ["-P"], { cwd: directory, encoding: "utf8" }).trim();
    execFileSync(join(llvm, "clang"), ["--target=wasm32-unknown-unknown", "-g", "-O0", "-nostdlib", `-fuse-ld=${join(llvm,"wasm-ld")}`, `-fdebug-prefix-map=${sourceRoot}=/kandelo-debug-fixture`, "-Wl,--no-entry", "-Wl,--export=outer", "-Wl,--allow-undefined", "-Wl,--import-memory", "inner.c", "outer.c", "-o", original], { cwd: sourceRoot });
    const host = /^host: (.+)$/m.exec(execFileSync("rustc", ["-vV"], { encoding: "utf8" }))![1];
    execFileSync("cargo", ["run", "--quiet", "-p", "fork-instrument", "--target", host, "--bin", "wasm-fork-instrument", "--", original, "-o", prepared, "--entry", "env.capture", "--no-sinks", "--keep-names", "--debug-map"], { cwd: repo, timeout: 300000 });
    const program = Uint8Array.from(readFileSync(prepared)).buffer;
    const memory = new WebAssembly.Memory({ initial: 4 });
    let capturedStack = "";
    const capture = createStackCaptureImport(memory, 4, program, () => true, () => { capturedStack = captureWasmStackText(); return capturedStack; });
    let length = 0;
    const imports: WebAssembly.Imports = { env: { memory, capture: () => { length = capture(1024, 16384, 32); } } };
    const module = new WebAssembly.Module(program);
    for (const entry of WebAssembly.Module.imports(module)) {
      const namespace = imports[entry.module] ??= {};
      if (entry.name in namespace) continue;
      if (entry.kind === "function") namespace[entry.name] = () => { throw new Error(`unexpected ${entry.name}`); };
      else if (entry.kind === "global") namespace[entry.name] = entry.name.includes("generation") ? 0n : 7;
      else if (entry.kind === "table") namespace[entry.name] = new WebAssembly.Table({ element: entry.name === "__wpk_fork_ref_gc_transit" ? "anyref" : "anyfunc", initial: 128 });
      else if (entry.kind === "tag") namespace[entry.name] = new WebAssembly.Tag({ parameters: [] });
      else throw new Error(`unexpected import ${entry.kind}`);
    }
    const instance = new WebAssembly.Instance(module, imports);
    (instance.exports.wpk_fork_module_bootstrap as () => void)();
    (instance.exports.outer as () => void)();
    expect(length).toBeGreaterThan(wire.STACK_HEADER_BYTES);
    const view = new DataView(memory.buffer, 1024, length);
    const sourced: unknown[] = [];
    const observed: unknown[] = [];
    let offset = wire.STACK_HEADER_BYTES as number;
    for (let index = 0; index < view.getUint32(wire.STACK_COUNT_OFFSET, true); index++) {
      const nameLength = view.getUint32(offset + wire.STACK_FRAME_NAME_LENGTH_OFFSET, true);
      const fileLength = view.getUint32(offset + wire.STACK_FRAME_FILE_LENGTH_OFFSET, true);
      observed.push({ index: view.getUint32(offset, true), pc: String(view.getBigUint64(offset + wire.STACK_FRAME_PC_OFFSET, true)), flags: view.getUint32(offset + wire.STACK_FRAME_FLAGS_OFFSET, true), name: new TextDecoder().decode(new Uint8Array(memory.buffer, 1024 + offset + wire.STACK_FRAME_HEADER_BYTES, nameLength)) });
      if (view.getUint32(offset + wire.STACK_FRAME_FLAGS_OFFSET, true) & wire.STACK_FRAME_HAS_SOURCE) {
        const file = new TextDecoder().decode(new Uint8Array(memory.buffer, 1024 + offset + wire.STACK_FRAME_HEADER_BYTES + nameLength, fileLength));
        sourced.push([file, view.getUint32(offset + wire.STACK_FRAME_LINE_OFFSET, true), view.getUint32(offset + wire.STACK_FRAME_COLUMN_OFFSET, true)]);
      }
      offset += wire.STACK_FRAME_HEADER_BYTES + nameLength + fileLength;
    }
    expect(sourced, JSON.stringify({ capturedStack, observed })).toEqual([["/kandelo-debug-fixture/inner.c",4,5],["/kandelo-debug-fixture/outer.c",3,3]]);
  }, 300000);
});
