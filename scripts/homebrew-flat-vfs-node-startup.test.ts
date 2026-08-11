import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import type {
  HomebrewFlatVfsProofInputPaths,
  LoadedHomebrewFlatVfsProofRuntimeInput,
} from "../homebrew/test/homebrew_flat_vfs_proof_inputs_node";
import type {
  HomebrewFlatVfsStartupProofResult,
} from "../homebrew/test/homebrew_flat_vfs_shipping_proof";
import {
  parseHomebrewFlatVfsNodeStartupArgs,
  runHomebrewFlatVfsNodeStartup,
} from "./homebrew-flat-vfs-node-startup";

const TAP_REVISION = "1".repeat(40);
const ARGS = [
  "--image", "image.vfs.zst",
  "--selection", "selection.json",
  "--report", "report.json",
  "--kernel", "kernel.wasm",
  "--tap-root", "tap",
  "--tap-revision", TAP_REVISION,
] as const;

test("parses exactly the six startup inputs", () => {
  const parsed = parseHomebrewFlatVfsNodeStartupArgs(ARGS);
  assert.deepEqual(parsed, {
    image: resolve("image.vfs.zst"),
    selection: resolve("selection.json"),
    report: resolve("report.json"),
    kernel: resolve("kernel.wasm"),
    tapRoot: resolve("tap"),
    tapRevision: TAP_REVISION,
  });
  assert.throws(
    () => parseHomebrewFlatVfsNodeStartupArgs([
      ...ARGS,
      "--evidence", "evidence.json",
    ]),
    /usage:/,
  );
  assert.throws(
    () => parseHomebrewFlatVfsNodeStartupArgs([
      "--image", "image.vfs.zst",
      "--selection", "selection.json",
    ]),
    /usage:/,
  );
  assert.throws(
    () => parseHomebrewFlatVfsNodeStartupArgs([
      ...ARGS,
      "--image", "other.vfs.zst",
    ]),
    /usage:/,
  );
});

test("loads and forwards the exact runtime inputs without evidence output", async () => {
  const imageBytes = new Uint8Array([1, 2, 3]);
  const kernelWasmBytes = Uint8Array.from([4, 5, 6]).buffer;
  const loaded = createLoadedInputs(imageBytes, kernelWasmBytes);
  let observedPaths: HomebrewFlatVfsProofInputPaths | undefined;
  let observedRuntimeFlag = false;
  let observedDeadline = 0;
  const expected: HomebrewFlatVfsStartupProofResult = {
    tapRevision: TAP_REVISION,
    kandeloAbi: 42,
    selectionSha256: "a".repeat(64),
    lazyDownloads: [],
  };

  const result = await runHomebrewFlatVfsNodeStartup(ARGS, {
    loadInputs: (paths, options) => {
      observedPaths = paths;
      observedRuntimeFlag = options.includeRuntimeBytes;
      return loaded;
    },
    runProof: async (options) => {
      assert.equal(options.runtime, loaded.runtime);
      assert.equal(options.tapRevision, TAP_REVISION);
      assert.equal(options.kernelWasmBytes, kernelWasmBytes);
      observedDeadline = options.deadlineMs;
      return expected;
    },
  });

  assert.deepEqual(observedPaths, {
    imagePath: resolve("image.vfs.zst"),
    selectionPath: resolve("selection.json"),
    reportPath: resolve("report.json"),
    kernelPath: resolve("kernel.wasm"),
    tapRoot: resolve("tap"),
    tapRevision: TAP_REVISION,
  });
  assert.equal(observedRuntimeFlag, true);
  assert.ok(observedDeadline > Date.now());
  assert.ok(observedDeadline <= Date.now() + 5 * 60_000);
  assert.equal(result, expected);
});

function createLoadedInputs(
  imageBytes: Uint8Array,
  kernelWasmBytes: ArrayBuffer,
): LoadedHomebrewFlatVfsProofRuntimeInput {
  return {
    tapRevision: TAP_REVISION,
    selectionSha256: "a".repeat(64),
    image: { sha256: "b".repeat(64), bytes: imageBytes.byteLength },
    report: { sha256: "c".repeat(64), bytes: 100 },
    kernel: { sha256: "d".repeat(64), bytes: kernelWasmBytes.byteLength },
    imagePath: resolve("image.vfs.zst"),
    selectionPath: resolve("selection.json"),
    reportPath: resolve("report.json"),
    kernelPath: resolve("kernel.wasm"),
    requestedVfsFilename:
      "kandelo-homebrew-experimental-abi42-wasm32.vfs.zst",
    shellPath: "/bin/bash",
    shellArgv0: "bash",
    runtime: {
      imageBytes,
      shellPath: "/bin/bash",
      shellArgv0: "bash",
    },
    kernelWasmBytes,
  };
}
