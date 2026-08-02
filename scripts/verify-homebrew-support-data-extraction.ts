#!/usr/bin/env -S npx tsx

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyHomebrewSupportDataExtraction } from "../host/src/homebrew-support-data-bottle";
import type { HomebrewBottleArch } from "../host/src/homebrew-vfs-planner";
import {
  loadTapFile,
  parseJson,
  requireAbsent,
  requireTapInput,
} from "./extract-homebrew-support-data-bottle";

const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const OUTPUT_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MAX_REPORT_BYTES = 1024 * 1024;

interface CliOptions {
  tapRoot: string;
  expectedTapSha: string;
  tapRepository: string;
  tapName: string;
  packageName: string;
  arch: HomebrewBottleArch;
  expectedAbi: number;
  report: string;
  outputs: Map<string, string>;
  verifiedReportOut: string;
  selectionVerificationReport?: string;
}

export async function runHomebrewSupportDataExtractionVerifier(
  args: string[],
): Promise<void> {
  const options = parseArgs(args);
  const tapRoot = requireTapInput(
    options.tapRoot,
    {
      expectedTapSha: options.expectedTapSha,
      expectedTapRepository: options.tapRepository,
      expectedTapName: options.tapName,
      expectedPackageName: options.packageName,
      expectedArch: options.arch,
      expectedAbi: options.expectedAbi,
    },
    options.selectionVerificationReport,
  );
  const report = parseJson(
    readRegularFile(options.report, "extraction report", MAX_REPORT_BYTES),
    "extraction report",
  );
  const metadata = parseJson(
    loadTapFile(tapRoot, "Kandelo/metadata.json"),
    "tap metadata",
  );
  const loadedOutputNames = new Set<string>();
  const loadedOutputPaths = new Set<string>();
  const extraction = await verifyHomebrewSupportDataExtraction({
    metadata,
    packageName: options.packageName,
    arch: options.arch,
    expectedAbi: options.expectedAbi,
    expectedTapRepository: options.tapRepository,
    expectedTapName: options.tapName,
    expectedCheckoutCommit: options.expectedTapSha,
    loadTapFile: (path) => loadTapFile(tapRoot, path),
    report,
    loadOutput: ({ name, expectedBytes }) => {
      const path = options.outputs.get(name);
      if (path === undefined) {
        throw new Error(`no detached output path was provided for ${name}`);
      }
      const bytes = readRegularFile(
        path,
        `support-data output ${name}`,
        expectedBytes,
        expectedBytes,
      );
      loadedOutputNames.add(name);
      const absolute = realpathSync(path);
      if (loadedOutputPaths.has(absolute)) {
        throw new Error(
          `multiple support-data outputs resolve to the same file: ${absolute}`,
        );
      }
      loadedOutputPaths.add(absolute);
      return bytes;
    },
  });
  if (loadedOutputNames.size !== options.outputs.size) {
    const unused = [...options.outputs.keys()]
      .filter((name) => !loadedOutputNames.has(name))
      .sort();
    throw new Error(
      `detached output mapping contains undeclared names: ${unused.join(", ")}`,
    );
  }

  const verifiedReportOut = resolve(options.verifiedReportOut);
  requireAbsent(verifiedReportOut, "verified report output");
  mkdirSync(dirname(verifiedReportOut), { recursive: true });
  writeFileSync(
    verifiedReportOut,
    `${JSON.stringify(extraction.report, null, 2)}\n`,
    { flag: "wx", mode: 0o644 },
  );
  console.log(`Verified Homebrew support-data report: ${verifiedReportOut}`);
}

function readRegularFile(
  path: string,
  label: string,
  maxBytes: number,
  exactBytes?: number,
): Uint8Array {
  const absolute = resolve(path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    throw new Error(
      `${label} is unavailable: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > maxBytes ||
    (exactBytes !== undefined && stat.size !== exactBytes)
  ) {
    const expected =
      exactBytes === undefined
        ? `1..${maxBytes} bytes`
        : `exactly ${exactBytes} bytes`;
    throw new Error(
      `${label} must be a regular non-symlink file with ${expected}`,
    );
  }
  return new Uint8Array(readFileSync(absolute));
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const outputs = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !name?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      usage(`invalid argument near ${name ?? "<end>"}`);
    }
    if (name === "--output") {
      const separator = value.indexOf("=");
      const outputName = separator < 0 ? "" : value.slice(0, separator);
      const outputPath = separator < 0 ? "" : value.slice(separator + 1);
      if (
        !OUTPUT_NAME_RE.test(outputName) ||
        outputPath.length === 0 ||
        outputs.has(outputName)
      ) {
        usage(`invalid or duplicate --output mapping ${value}`);
      }
      outputs.set(outputName, outputPath);
      continue;
    }
    if (values.has(name)) usage(`duplicate option ${name}`);
    values.set(name, value);
  }
  const allowed = new Set([
    "--tap-root",
    "--expected-tap-sha",
    "--tap-repository",
    "--tap-name",
    "--package",
    "--arch",
    "--expected-abi",
    "--report",
    "--verified-report-out",
    "--selection-verification-report",
  ]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) usage(`unknown option ${name}`);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value.length === 0) {
      usage(`${name} is required`);
    }
    return value;
  };
  const expectedTapSha = required("--expected-tap-sha");
  if (!GIT_SHA_RE.test(expectedTapSha)) {
    usage("--expected-tap-sha must be a lowercase 40-character Git SHA");
  }
  const arch = required("--arch");
  if (arch !== "wasm32" && arch !== "wasm64") {
    usage("--arch must be wasm32 or wasm64");
  }
  const abiText = required("--expected-abi");
  if (!/^[1-9][0-9]*$/.test(abiText)) {
    usage("--expected-abi must be a positive integer");
  }
  const expectedAbi = Number(abiText);
  if (!Number.isSafeInteger(expectedAbi)) {
    usage("--expected-abi exceeds the safe integer range");
  }
  if (outputs.size === 0) {
    usage("at least one --output <name>=<path> mapping is required");
  }
  return {
    tapRoot: required("--tap-root"),
    expectedTapSha,
    tapRepository: required("--tap-repository"),
    tapName: required("--tap-name"),
    packageName: required("--package"),
    arch,
    expectedAbi,
    report: required("--report"),
    outputs,
    verifiedReportOut: required("--verified-report-out"),
    selectionVerificationReport: values.get("--selection-verification-report"),
  };
}

function usage(message: string): never {
  console.error(`verify-homebrew-support-data-extraction: ${message}`);
  console.error(
    "usage: npx tsx scripts/verify-homebrew-support-data-extraction.ts " +
      "--tap-root <exact-checkout> --expected-tap-sha <sha> " +
      "--tap-repository <owner/repository> --tap-name <owner/tap> " +
      "--package <name> --arch <wasm32|wasm64> --expected-abi <n> " +
      "--report <report.json> --output <name>=<path> [...] " +
      "--verified-report-out <new-report.json> " +
      "[--selection-verification-report <verified-report.json>]",
  );
  process.exit(2);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  runHomebrewSupportDataExtractionVerifier(process.argv.slice(2)).catch(
    (error) => {
      console.error(
        `verify-homebrew-support-data-extraction: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    },
  );
}
