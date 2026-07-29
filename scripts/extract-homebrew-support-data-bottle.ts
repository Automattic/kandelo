#!/usr/bin/env -S npx tsx

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractHomebrewSupportDataBottle,
  type HomebrewSupportDataOutput,
} from "../host/src/homebrew-support-data-bottle";
import type { HomebrewBottleArch } from "../host/src/homebrew-vfs-planner";

const GIT_SHA_RE = /^[0-9a-f]{40}$/;
const MAX_TAP_CONTROL_FILE_BYTES = 16 * 1024 * 1024;

interface CliOptions {
  tapRoot: string;
  expectedTapSha: string;
  tapRepository: string;
  tapName: string;
  packageName: string;
  arch: HomebrewBottleArch;
  expectedAbi: number;
  outputDirectory: string;
}

export async function runHomebrewSupportDataBottleExtractor(
  args: string[],
): Promise<void> {
  const options = parseArgs(args);
  const tapRoot = requireExactTapCheckout(
    options.tapRoot,
    options.expectedTapSha,
  );
  const outputDirectory = resolve(options.outputDirectory);
  requireAbsent(outputDirectory, "output directory");

  const metadata = parseJson(
    loadTapFile(tapRoot, "Kandelo/metadata.json"),
    "tap metadata",
  );
  const extraction = await extractHomebrewSupportDataBottle({
    metadata,
    packageName: options.packageName,
    arch: options.arch,
    expectedAbi: options.expectedAbi,
    expectedTapRepository: options.tapRepository,
    expectedTapName: options.tapName,
    expectedCheckoutCommit: options.expectedTapSha,
    loadTapFile: (path) => loadTapFile(tapRoot, path),
  });

  writeExtractionAtomically(
    outputDirectory,
    extraction.outputs,
    extraction.report,
  );
  console.log(`Homebrew support-data output: ${outputDirectory}`);
  console.log(
    `Homebrew support-data report: ${join(outputDirectory, "report.json")}`,
  );
}

function writeExtractionAtomically(
  outputDirectory: string,
  outputs: readonly HomebrewSupportDataOutput[],
  report: unknown,
): void {
  const parent = dirname(outputDirectory);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, ".kandelo-support-data-"));
  let moved = false;
  try {
    for (const output of outputs) {
      if (output.path === "report.json") {
        throw new Error("support-data output path conflicts with report.json");
      }
      const destination = resolve(staging, output.path);
      if (
        destination === staging ||
        relative(staging, destination).startsWith("..") ||
        isAbsolute(relative(staging, destination))
      ) {
        throw new Error(`unsafe support-data output path: ${output.path}`);
      }
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, output.data, {
        flag: "wx",
        mode: 0o644,
      });
    }
    writeFileSync(
      join(staging, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: "wx", mode: 0o644 },
    );
    renameSync(staging, outputDirectory);
    moved = true;
  } finally {
    if (!moved) rmSync(staging, { recursive: true, force: true });
  }
}

export function loadTapFile(tapRoot: string, path: string): Uint8Array {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new Error(`tap path is unsafe: ${JSON.stringify(path)}`);
  }
  const candidate = resolve(tapRoot, path);
  const within = relative(tapRoot, candidate);
  if (within.startsWith("..") || isAbsolute(within)) {
    throw new Error(`tap path escapes the exact checkout: ${path}`);
  }
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch (error) {
    throw new Error(
      `tap file is unavailable: ${path}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > MAX_TAP_CONTROL_FILE_BYTES
  ) {
    throw new Error(
      `tap file must be a non-empty regular file no larger than ` +
        `${MAX_TAP_CONTROL_FILE_BYTES} bytes: ${path}`,
    );
  }
  const actual = realpathSync(candidate);
  const actualWithin = relative(tapRoot, actual);
  if (actualWithin.startsWith("..") || isAbsolute(actualWithin)) {
    throw new Error(`tap file resolves outside the exact checkout: ${path}`);
  }
  return new Uint8Array(readFileSync(actual));
}

export function requireRealDirectory(path: string, label: string): string {
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
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return realpathSync(absolute);
}

export function requireAbsent(path: string, label: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
}

export function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      `${label} is not valid UTF-8 JSON: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

export function requireExactTapCheckout(
  path: string,
  expectedTapSha: string,
): string {
  const tapRoot = requireRealDirectory(path, "tap root");
  const actualTapSha = git(tapRoot, ["rev-parse", "HEAD"]).trim();
  if (actualTapSha !== expectedTapSha) {
    throw new Error(
      `tap HEAD ${actualTapSha} does not match expected ${expectedTapSha}`,
    );
  }
  const status = git(tapRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") {
    throw new Error(`exact tap checkout is dirty:\n${status}`);
  }
  return tapRoot;
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
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
    "--output-directory",
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
  return {
    tapRoot: required("--tap-root"),
    expectedTapSha,
    tapRepository: required("--tap-repository"),
    tapName: required("--tap-name"),
    packageName: required("--package"),
    arch,
    expectedAbi,
    outputDirectory: required("--output-directory"),
  };
}

function usage(message: string): never {
  console.error(`extract-homebrew-support-data-bottle: ${message}`);
  console.error(
    "usage: npx tsx scripts/extract-homebrew-support-data-bottle.ts " +
      "--tap-root <exact-checkout> --expected-tap-sha <sha> " +
      "--tap-repository <owner/repository> --tap-name <owner/tap> " +
      "--package <name> --arch <wasm32|wasm64> --expected-abi <n> " +
      "--output-directory <new-directory>",
  );
  process.exit(2);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  runHomebrewSupportDataBottleExtractor(process.argv.slice(2)).catch(
    (error) => {
      console.error(
        `extract-homebrew-support-data-bottle: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    },
  );
}
