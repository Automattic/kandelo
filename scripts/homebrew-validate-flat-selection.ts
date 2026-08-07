#!/usr/bin/env -S npx tsx

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  homebrewBottleSelectionSha256,
  parseCanonicalHomebrewBottleSelection,
} from "../host/src/homebrew-bottle-selection";

const MAX_SELECTION_BYTES = 16 * 1024 * 1024;

export interface HomebrewFlatSelectionValidationReport {
  selectionSha256: string;
  compressedBytes: number;
  descriptorCount: number;
}

/** Read and report one canonical flat selection without fetching or rewriting it. */
export function runHomebrewFlatSelectionValidator(
  args: readonly string[],
  writeLine: (line: string) => void = console.log,
): HomebrewFlatSelectionValidationReport {
  const options = parseArgs(args);
  const bytes = readBoundedRegularFile(options.selection);
  const selection = parseCanonicalHomebrewBottleSelection(bytes, {
    expectedAbi: options.expectedAbi,
  });
  const compressedBytes = selection.bottles.reduce((total, bottle) => {
    const next = total + bottle.bytes;
    if (!Number.isSafeInteger(next)) throw new Error("selection compressed-byte sum is unsafe");
    return next;
  }, 0);
  const report = {
    selectionSha256: homebrewBottleSelectionSha256(bytes),
    compressedBytes,
    descriptorCount: selection.bottles.length,
  };
  writeLine(JSON.stringify(report));
  return report;
}

interface CliOptions {
  selection: string;
  expectedAbi?: number;
}

function parseArgs(args: readonly string[]): CliOptions {
  let selection: string | undefined;
  let expectedAbi: number | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) usage();
    if (flag === "--selection" && selection === undefined) {
      selection = value;
    } else if (flag === "--expected-abi" && expectedAbi === undefined) {
      if (!/^[1-9][0-9]*$/.test(value)) usage();
      expectedAbi = Number(value);
      if (!Number.isSafeInteger(expectedAbi)) usage();
    } else {
      usage();
    }
  }
  if (!selection) usage();
  return expectedAbi === undefined ? { selection } : { selection, expectedAbi };
}

function readBoundedRegularFile(path: string): Uint8Array {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(`selection must be one bounded nonempty regular file: ${path}`);
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SELECTION_BYTES) {
      throw new Error(`selection must be one bounded nonempty regular file: ${path}`);
    }
    const bytes = new Uint8Array(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (count === 0) {
        throw new Error(`selection changed during bounded read: ${path}`);
      }
      offset += count;
    }
    const extra = new Uint8Array(1);
    if (readSync(descriptor, extra, 0, 1, null) !== 0 || fstatSync(descriptor).size !== stat.size) {
      throw new Error(`selection changed during bounded read: ${path}`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function usage(): never {
  throw new Error(
    "usage: scripts/homebrew-validate-flat-selection.ts " +
      "--selection <selection.json> [--expected-abi <positive-integer>]",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runHomebrewFlatSelectionValidator(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
