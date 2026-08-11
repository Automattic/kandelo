#!/usr/bin/env -S npx tsx

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadHomebrewFlatVfsProofInputs,
  runHomebrewFlatVfsProofWithEvidence,
} from "../homebrew/test/homebrew_flat_vfs_proof_inputs_node";
import {
  runHomebrewFlatVfsShippingProofInNode,
} from "../homebrew/test/homebrew_guest_lifecycle_node";
import type {
  HomebrewFlatVfsProofEvidence,
} from "../homebrew/test/homebrew_flat_vfs_proof_evidence";

const PROOF_TIMEOUT_MS = 30 * 60_000;

export interface HomebrewFlatVfsNodeSmokeOptions {
  image: string;
  selection: string;
  report: string;
  kernel: string;
  tapRoot: string;
  tapRevision: string;
  evidence: string;
}

const FLAGS = new Map<string, keyof HomebrewFlatVfsNodeSmokeOptions>([
  ["--image", "image"],
  ["--selection", "selection"],
  ["--report", "report"],
  ["--kernel", "kernel"],
  ["--tap-root", "tapRoot"],
  ["--tap-revision", "tapRevision"],
  ["--evidence", "evidence"],
]);

export function parseHomebrewFlatVfsNodeSmokeArgs(
  args: readonly string[],
): HomebrewFlatVfsNodeSmokeOptions {
  const parsed: Partial<HomebrewFlatVfsNodeSmokeOptions> = {};
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
  const options = parsed as HomebrewFlatVfsNodeSmokeOptions;
  return {
    image: resolve(options.image),
    selection: resolve(options.selection),
    report: resolve(options.report),
    kernel: resolve(options.kernel),
    tapRoot: resolve(options.tapRoot),
    tapRevision: options.tapRevision,
    evidence: resolve(options.evidence),
  };
}

export async function runHomebrewFlatVfsNodeSmoke(
  args: readonly string[],
  dependencies: {
    runProof?: typeof runHomebrewFlatVfsShippingProofInNode;
  } = {},
): Promise<HomebrewFlatVfsProofEvidence> {
  const options = parseHomebrewFlatVfsNodeSmokeArgs(args);
  const inputs = loadHomebrewFlatVfsProofInputs({
    imagePath: options.image,
    selectionPath: options.selection,
    reportPath: options.report,
    kernelPath: options.kernel,
    tapRoot: options.tapRoot,
    tapRevision: options.tapRevision,
  }, { includeRuntimeBytes: true });
  const runProof = dependencies.runProof ??
    runHomebrewFlatVfsShippingProofInNode;
  return runHomebrewFlatVfsProofWithEvidence({
    host: "node",
    inputs,
    evidencePath: options.evidence,
    runProof: () => runProof({
      runtime: inputs.runtime,
      tapRevision: inputs.tapRevision,
      deadlineMs: Date.now() + PROOF_TIMEOUT_MS,
      kernelWasmBytes: inputs.kernelWasmBytes,
    }),
  });
}

function usage(): never {
  throw new Error(
    "usage: scripts/homebrew-flat-vfs-node-smoke.ts " +
      "--image <image.vfs.zst> --selection <selection.json> " +
      "--report <report.json> --kernel <kernel.wasm> " +
      "--tap-root <checkout> --tap-revision <40-character-sha> " +
      "--evidence <evidence.json>",
  );
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void runHomebrewFlatVfsNodeSmoke(process.argv.slice(2)).then(
    (evidence) => {
      process.stdout.write(
        `homebrew-flat-vfs-node-smoke: proved ${evidence.image.sha256}\n`,
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
