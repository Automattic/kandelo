#!/usr/bin/env -S npx tsx

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadHomebrewFlatVfsProofInputs,
  type HomebrewFlatVfsProofInputPaths,
  type LoadedHomebrewFlatVfsProofRuntimeInput,
} from "../homebrew/test/homebrew_flat_vfs_proof_inputs_node";
import {
  type HomebrewFlatVfsStartupProofResult,
} from "../homebrew/test/homebrew_flat_vfs_shipping_proof";
import {
  runHomebrewFlatVfsStartupProofInNode,
} from "../homebrew/test/homebrew_guest_lifecycle_node";

const STARTUP_TIMEOUT_MS = 5 * 60_000;

export interface HomebrewFlatVfsNodeStartupOptions {
  image: string;
  selection: string;
  report: string;
  kernel: string;
  tapRoot: string;
  tapRevision: string;
}

type LoadRuntimeInputs = (
  paths: HomebrewFlatVfsProofInputPaths,
  options: { includeRuntimeBytes: true },
) => LoadedHomebrewFlatVfsProofRuntimeInput;

const FLAGS = new Map<string, keyof HomebrewFlatVfsNodeStartupOptions>([
  ["--image", "image"],
  ["--selection", "selection"],
  ["--report", "report"],
  ["--kernel", "kernel"],
  ["--tap-root", "tapRoot"],
  ["--tap-revision", "tapRevision"],
]);

export function parseHomebrewFlatVfsNodeStartupArgs(
  args: readonly string[],
): HomebrewFlatVfsNodeStartupOptions {
  const parsed: Partial<HomebrewFlatVfsNodeStartupOptions> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const key = flag === undefined ? undefined : FLAGS.get(flag);
    if (
      key === undefined ||
      value === undefined ||
      value.length === 0 ||
      value.startsWith("--") ||
      parsed[key] !== undefined
    ) {
      return usage();
    }
    parsed[key] = value;
  }
  for (const key of FLAGS.values()) {
    if (parsed[key] === undefined) return usage();
  }
  const options = parsed as HomebrewFlatVfsNodeStartupOptions;
  return {
    image: resolve(options.image),
    selection: resolve(options.selection),
    report: resolve(options.report),
    kernel: resolve(options.kernel),
    tapRoot: resolve(options.tapRoot),
    tapRevision: options.tapRevision,
  };
}

export async function runHomebrewFlatVfsNodeStartup(
  args: readonly string[],
  dependencies: {
    loadInputs?: LoadRuntimeInputs;
    runProof?: typeof runHomebrewFlatVfsStartupProofInNode;
  } = {},
): Promise<HomebrewFlatVfsStartupProofResult> {
  const options = parseHomebrewFlatVfsNodeStartupArgs(args);
  const loadInputs: LoadRuntimeInputs = dependencies.loadInputs ??
    loadHomebrewFlatVfsProofInputs;
  const inputs = loadInputs({
    imagePath: options.image,
    selectionPath: options.selection,
    reportPath: options.report,
    kernelPath: options.kernel,
    tapRoot: options.tapRoot,
    tapRevision: options.tapRevision,
  }, { includeRuntimeBytes: true });
  const runProof = dependencies.runProof ??
    runHomebrewFlatVfsStartupProofInNode;
  return runProof({
    runtime: inputs.runtime,
    tapRevision: inputs.tapRevision,
    deadlineMs: Date.now() + STARTUP_TIMEOUT_MS,
    kernelWasmBytes: inputs.kernelWasmBytes,
  });
}

function usage(): never {
  throw new Error(
    "usage: scripts/homebrew-flat-vfs-node-startup.ts " +
      "--image <image.vfs.zst> --selection <selection.json> " +
      "--report <report.json> --kernel <kernel.wasm> " +
      "--tap-root <checkout> --tap-revision <40-character-sha>",
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void runHomebrewFlatVfsNodeStartup(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(
        `homebrew-flat-vfs-node-startup: started ${result.selectionSha256}\n`,
      );
    },
    (error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
