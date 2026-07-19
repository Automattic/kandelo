#!/usr/bin/env -S npx tsx

import { existsSync, readFileSync } from "node:fs";
import {
  describeWasmArtifactPolicyFailures,
  extractAbiVersion,
} from "../host/src/constants";
import { HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS } from "../host/src/generated/abi";

function usage(): never {
  process.stderr.write(
    "Usage: scripts/validate-wasm-artifacts.ts --abi <version> [--profile program|kernel] [--fork-instrumentation auto|disabled] <artifact.wasm>...\n",
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let expectedAbi: number | undefined;
let profile: "program" | "kernel" = "program";
let forkInstrumentation: "auto" | "disabled" = "auto";
const paths: string[] = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--abi") {
    const value = args[++i];
    if (value === undefined || !/^[0-9]+$/.test(value)) usage();
    expectedAbi = Number(value);
  } else if (arg === "--profile") {
    const value = args[++i];
    if (value !== "program" && value !== "kernel") usage();
    profile = value;
  } else if (arg === "--fork-instrumentation") {
    const value = args[++i];
    if (value !== "auto" && value !== "disabled") usage();
    forkInstrumentation = value;
  } else if (arg.startsWith("-")) {
    usage();
  } else {
    paths.push(arg);
  }
}
if (
  expectedAbi === undefined ||
  !Number.isSafeInteger(expectedAbi) ||
  paths.length === 0
) usage();
if (profile === "kernel" && forkInstrumentation === "disabled") usage();
const requiredExports = profile === "kernel"
  ? HOST_ADAPTER_REQUIRED_KERNEL_EXPORTS
  : ["__abi_version", "_start"];
const forkInstrumentationDisabled = forkInstrumentation === "disabled";
let failed = false;

for (const path of paths) {
  if (!existsSync(path)) {
    process.stderr.write(`validate-wasm-artifacts: missing file: ${path}\n`);
    failed = true;
    continue;
  }

  let failures: string[];
  try {
    const bytes = readFileSync(path);
    const program = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const abi = extractAbiVersion(program);
    failures = describeWasmArtifactPolicyFailures(program, {
      expectedAbi,
      requiredExports,
      requireForkInstrumentation: forkInstrumentationDisabled ? false : undefined,
      forbidForkInstrumentation: forkInstrumentationDisabled,
    });
    if (abi === null) failures.unshift("does not expose a constant __abi_version");
  } catch (error) {
    failures = [error instanceof Error ? error.message : String(error)];
  }

  if (failures.length > 0) {
    process.stderr.write(
      `validate-wasm-artifacts: ${path}: ${failures.join("; ")}\n`,
    );
    failed = true;
  }
}

if (failed) process.exit(1);
process.stdout.write(
  `validated ${paths.length} ${profile} Wasm artifact(s) for Kandelo ABI ${expectedAbi}\n`,
);
