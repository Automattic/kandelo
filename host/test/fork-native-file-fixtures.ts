import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeWasmForkArtifactContractFailures } from "../src/constants";
import {
  LinkedForkContinuation,
  readLinkedFrameFormat,
} from "../src/fork-continuation";
import { ForkModuleStateArena } from "../src/fork-module-state";
import { SingleActivationForkRuntime } from "./fork-instrument-runtime-harness";

function compileFixture(
  tool: string,
  directory: string,
  source: string,
  options: string[],
) {
  const wat = join(directory, "input.wat");
  const raw = join(directory, "raw.wasm");
  const output = join(directory, "output.wasm");
  writeFileSync(wat, source);
  execFileSync("wat2wasm", ["--enable-all", wat, "-o", raw]);
  execFileSync(tool, [raw, ...options, "-o", output]);
  return readFileSync(output);
}

/** Run independently of the SDK fixtures as well as through the host suite. */
export function runNativeFileFixtures(toolPath: string) {
  const tool = resolve(toolPath);
  const directory = mkdtempSync(join(tmpdir(), "native-file-host-"));
  let checked = 0;
  try {
    for (const wide of [false, true]) {
      for (const role of ["main", "dynamic", "side"]) {
        for (const optimization of ["none", "Os"]) {
          const forkModule = role === "side" ? "other" : "kernel";
          const forkName = role === "side" ? "callback" : "kernel_fork";
          const linker = role === "dynamic"
            ? '(import "env" "__wasm_dlsym" (func (param i32 i32 i32) (result i32)))'
            : "";
          const source = `(module
            (import "${forkModule}" "${forkName}" (func $fork (param i32) (result i32)))
            ${linker}
            (import "env" "memory" (memory ${wide ? "i64" : ""} 8 16 shared))
            (func (export "_start") i32.const 0 call $fork drop))`;
          const bytes = compileFixture(tool, directory, source, [
            "--entry", role === "side" ? "env.fork" : "kernel.kernel_fork",
            "--post-optimize", optimization,
          ]);
          const buffer = Uint8Array.from(bytes).buffer;
          assert.deepEqual(
            describeWasmForkArtifactContractFailures(buffer),
            [],
            `memory64=${wide}, role=${role}, optimization=${optimization}`,
          );
          new WebAssembly.Module(bytes);
          checked++;
        }
      }
    }
    assertProductionReplay(tool, directory);
    return {
      structuralContracts: checked,
      productionCoordinatorParentReplay: "passed",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertProductionReplay(tool: string, directory: string): void {
  const source = `(module
    (import "kernel" "kernel_fork" (func $fork (param i32) (result i32)))
    (import "env" "memory" (memory 8))
    (global $visits (export "visits") (mut i32) (i32.const 0))
    (func $leaf (result i32) i32.const 0 call $fork)
    (func (export "run") (result i32) (local $saved i32)
      global.get $visits i32.const 1 i32.add global.set $visits
      i32.const 7 local.set $saved call $leaf local.get $saved i32.add))`;
  const bytes = compileFixture(tool, directory, source, ["--post-optimize", "none"]);
  const module = new WebAssembly.Module(bytes);
  const memory = new WebAssembly.Memory({ initial: 8 });
  let nextFrame = 65_536;
  let nextArena = 5 * 65_536;
  const continuation = new LinkedForkContinuation(
    memory,
    readLinkedFrameFormat(module),
    (size) => {
      const address = nextFrame;
      nextFrame += size;
      return address;
    },
    () => {},
    "native file smoke",
  );
  const runtime = new SingleActivationForkRuntime({
    module,
    moduleBytes: bytes,
    memory,
    continuation,
    newArena: () => new ForkModuleStateArena(
      memory,
      4,
      (size) => {
        const address = nextArena;
        nextArena += size;
        if (nextArena > memory.buffer.byteLength) {
          memory.grow(Math.ceil((nextArena - memory.buffer.byteLength) / 65_536));
        }
        return address;
      },
      () => {},
      "native file smoke state",
    ),
    label: "native file smoke",
  });
  const instance = new WebAssembly.Instance(module, {
    env: { memory, ...runtime.envImports },
    kernel: {
      kernel_fork() {
        if (runtime.coordinator.phaseName() === "parent-replay") {
          runtime.coordinator.finishReplay();
          return 77;
        }
        runtime.beginCapture();
        return 0;
      },
    },
  });
  runtime.register(instance);
  const run = instance.exports.run as () => number;
  runtime.expectCaptureTransport(run);
  runtime.coordinator.sealCapture();
  runtime.coordinator.beginParentReplay();
  assert.equal(run(), 84);
  assert.equal((instance.exports.visits as WebAssembly.Global).value, 1);
  assert.equal((instance.exports.wpk_fork_state as () => number)(), 0);
  assert.equal(continuation.hasActiveContinuation(), false);
}
