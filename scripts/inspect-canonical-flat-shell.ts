#!/usr/bin/env -S npx tsx

import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { parseCanonicalHomebrewBottleSelection } from "../host/src/homebrew-bottle-selection";
import { resolveHomebrewVfsResourcePolicy } from "../host/src/homebrew-vfs-resource-policy";
import { ABI_VERSION } from "../host/src/generated/abi";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import {
  KANDELO_DEMO_CONFIG_PATH,
  MAX_KANDELO_DEMO_CONFIG_BYTES,
  parseKandeloDemoConfig,
  validateKandeloDemoConfig,
} from "../web-libs/kandelo-session/src/demo-config";
import {
  KANDELO_SHELL_CONFIG_PATH,
  MAX_KANDELO_SHELL_CONFIG_BYTES,
  parseKandeloShellConfig,
} from "../web-libs/kandelo-session/src/shell-config";

const KIND = "kandelo-canonical-flat-shell" as const;
const TRANSPORT_KIND = "flat-self-contained" as const;
const MAX_SELECTION_BYTES = 4 * 1024 * 1024;
const EXPECTED_IMAGE_CREATED_BY =
  "images/vfs/scripts/build-homebrew-flat-vfs-image.ts";
const BREW_STABLE_PATH = "/usr/bin/brew";
const BREW_SELECTED_PATH = "/opt/kandelo/homebrew/bin/brew";

export interface CanonicalFlatShellReport {
  schema: 1;
  kind: typeof KIND;
  image: {
    sha256: string;
    bytes: number;
    kernel_abi: number;
    capacity: {
      byte_length: number;
      max_byte_length: number;
    };
  };
  selection: {
    sha256: string;
    bytes: number;
    name: string;
    arch: "wasm32";
    kandelo_abi: number;
    requested_vfs_filename: "shell.vfs.zst";
    resource_policy: "kandelo-homebrew-vfs-main-shell-v1";
  };
  shell_config: {
    sha256: string;
    bytes: number;
    path: string;
    argv: string[];
  };
  demo_config: {
    sha256: string;
    bytes: number;
    path: typeof KANDELO_DEMO_CONFIG_PATH;
  };
  transport: {
    kind: typeof TRANSPORT_KIND;
    mirror_required: false;
  };
}

export async function inspectCanonicalFlatShell(input: {
  imageBytes: Uint8Array;
  selectionBytes: Uint8Array;
  shellConfigBytes: Uint8Array;
  demoConfigBytes: Uint8Array;
}): Promise<CanonicalFlatShellReport> {
  const selectionBytes = nonemptyBytes(
    input.selectionBytes,
    "canonical flat-shell selection",
  );
  const selection = parseCanonicalHomebrewBottleSelection(selectionBytes, {
    expectedAbi: ABI_VERSION,
  });
  if (
    selection.name !== "main-shell-abi42-wasm32" ||
    selection.arch !== "wasm32" ||
    selection.requestedVfsFilename !== "shell.vfs.zst" ||
    selection.resourcePolicy !== "kandelo-homebrew-vfs-main-shell-v1"
  ) {
    throw new Error(
      "canonical flat shell selection does not select the main shell product",
    );
  }
  const policy = resolveHomebrewVfsResourcePolicy(selection.resourcePolicy);
  const imageBytes = boundedBytes(
    input.imageBytes,
    "canonical flat-shell image",
    policy.vfs.maxByteLength,
  );
  const shellConfigBytes = boundedBytes(
    input.shellConfigBytes,
    "canonical shell config",
    MAX_KANDELO_SHELL_CONFIG_BYTES,
  );
  const demoConfigBytes = boundedBytes(
    input.demoConfigBytes,
    "canonical demo config",
    MAX_KANDELO_DEMO_CONFIG_BYTES,
  );

  const shellConfig = parseShellConfig(shellConfigBytes);
  const demoConfig = parseDemoConfig(demoConfigBytes);
  validateKandeloDemoConfig(demoConfig);
  const selectionSha256 = sha256(selectionBytes);
  const shellConfigSha256 = sha256(shellConfigBytes);
  const demoConfigSha256 = sha256(demoConfigBytes);
  const metadata = MemoryFileSystem.readImageMetadata(imageBytes);
  if (metadata === null) {
    throw new Error("canonical flat shell image has no metadata");
  }
  expectExactKeys(
    metadata,
    [
      "baseImage",
      "capacity",
      "createdBy",
      "demoConfig",
      "homebrewFlat",
      "kernelAbi",
      "shellConfig",
      "version",
    ],
    "canonical flat shell image metadata",
  );
  if (
    metadata.version !== 1 ||
    metadata.kernelAbi !== ABI_VERSION ||
    metadata.createdBy !== EXPECTED_IMAGE_CREATED_BY
  ) {
    throw new Error(
      "canonical flat shell image metadata has the wrong identity",
    );
  }
  expectExactRecord(
    metadata.capacity,
    {
      maxByteLength: policy.vfs.maxByteLength,
    },
    "canonical flat shell capacity binding",
  );
  expectBaseImage(metadata.baseImage);
  expectExactRecord(
    metadata.homebrewFlat,
    {
      selectionSha256,
      requestedVfsFilename: selection.requestedVfsFilename,
      resourcePolicy: selection.resourcePolicy,
    },
    "canonical flat shell selection binding",
  );
  expectExactRecord(
    metadata.shellConfig,
    {
      path: shellConfig.path,
      argv: [...shellConfig.argv],
      sha256: shellConfigSha256,
      bytes: shellConfigBytes.byteLength,
    },
    "canonical flat shell config binding",
  );
  expectExactRecord(
    metadata.demoConfig,
    {
      path: KANDELO_DEMO_CONFIG_PATH,
      sha256: demoConfigSha256,
      bytes: demoConfigBytes.byteLength,
    },
    "canonical flat shell demo binding",
  );

  const capacity = MemoryFileSystem.readImageCapacity(imageBytes);
  if (
    capacity.byteLength <= 0 ||
    capacity.byteLength > capacity.maxByteLength ||
    capacity.maxByteLength !== policy.vfs.maxByteLength
  ) {
    throw new Error("canonical flat shell image has the wrong VFS capacity");
  }
  const fs = MemoryFileSystem.fromImagePreservingCapacity(imageBytes);
  await fs.verifyImportedLazyAtomicGroupSeals();
  const lazyFiles = fs.exportLazyEntries();
  const lazyTrees = fs.exportLazyArchiveEntries();
  if (lazyFiles.length !== 0 || lazyTrees.length !== 0) {
    throw new Error(
      "canonical flat shell must be self-contained; pending lazy state remains " +
        `(${lazyFiles.length} files, ${lazyTrees.length} trees)`,
    );
  }
  expectGuestBytes(fs, KANDELO_SHELL_CONFIG_PATH, shellConfigBytes);
  expectGuestBytes(fs, KANDELO_DEMO_CONFIG_PATH, demoConfigBytes);
  expectEagerExecutable(fs, shellConfig.path, "selected interactive shell");
  const brewLink = fs.lstat(BREW_STABLE_PATH);
  if (
    (brewLink.mode & 0xf000) !== 0xa000 ||
    fs.readlink(BREW_STABLE_PATH) !== BREW_SELECTED_PATH ||
    fs.isPathDeferred(BREW_STABLE_PATH)
  ) {
    throw new Error(
      `${BREW_STABLE_PATH} is not the eager selected Homebrew entrypoint`,
    );
  }
  expectEagerExecutable(fs, BREW_SELECTED_PATH, "selected Homebrew entrypoint");

  return {
    schema: 1,
    kind: KIND,
    image: {
      sha256: sha256(imageBytes),
      bytes: imageBytes.byteLength,
      kernel_abi: metadata.kernelAbi,
      capacity: {
        byte_length: capacity.byteLength,
        max_byte_length: capacity.maxByteLength,
      },
    },
    selection: {
      sha256: selectionSha256,
      bytes: selectionBytes.byteLength,
      name: selection.name,
      arch: selection.arch,
      kandelo_abi: selection.kandeloAbi,
      requested_vfs_filename: selection.requestedVfsFilename,
      resource_policy: selection.resourcePolicy,
    },
    shell_config: {
      sha256: shellConfigSha256,
      bytes: shellConfigBytes.byteLength,
      path: shellConfig.path,
      argv: [...shellConfig.argv],
    },
    demo_config: {
      sha256: demoConfigSha256,
      bytes: demoConfigBytes.byteLength,
      path: KANDELO_DEMO_CONFIG_PATH,
    },
    transport: {
      kind: TRANSPORT_KIND,
      mirror_required: false,
    },
  };
}

export async function inspectCanonicalFlatShellFiles(options: {
  image: string;
  selection: string;
  shellConfig: string;
  demoConfig: string;
  output: string;
}): Promise<CanonicalFlatShellReport> {
  const selectionBytes = readRegularFileNoFollow(
    options.selection,
    "canonical flat-shell selection",
    MAX_SELECTION_BYTES,
  );
  const selection = parseCanonicalHomebrewBottleSelection(selectionBytes, {
    expectedAbi: ABI_VERSION,
  });
  const policy = resolveHomebrewVfsResourcePolicy(selection.resourcePolicy);
  const report = await inspectCanonicalFlatShell({
    imageBytes: readRegularFileNoFollow(
      options.image,
      "canonical flat-shell image",
      policy.vfs.maxByteLength,
    ),
    selectionBytes,
    shellConfigBytes: readRegularFileNoFollow(
      options.shellConfig,
      "canonical shell config",
      MAX_KANDELO_SHELL_CONFIG_BYTES,
    ),
    demoConfigBytes: readRegularFileNoFollow(
      options.demoConfig,
      "canonical demo config",
      MAX_KANDELO_DEMO_CONFIG_BYTES,
    ),
  });
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return report;
}

function expectBaseImage(value: unknown): void {
  const base = exactRecord(value, "canonical flat shell base-image binding");
  expectExactKeys(
    base,
    ["bytes", "kernelAbi", "sha256"],
    "canonical flat shell base-image binding",
  );
  if (
    typeof base.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(base.sha256) ||
    typeof base.bytes !== "number" ||
    !Number.isSafeInteger(base.bytes) ||
    base.bytes <= 0 ||
    base.kernelAbi !== ABI_VERSION
  ) {
    throw new Error("canonical flat shell base-image binding is invalid");
  }
}

function expectGuestBytes(
  fs: MemoryFileSystem,
  path: string,
  expected: Uint8Array,
): void {
  const actual = readGuestRegularFile(fs, path);
  if (!equalBytes(actual, expected)) {
    throw new Error(
      `canonical flat shell ${path} differs from its source bytes`,
    );
  }
}

function expectEagerExecutable(
  fs: MemoryFileSystem,
  path: string,
  label: string,
): void {
  let stat;
  try {
    stat = fs.stat(path);
  } catch {
    throw new Error(`canonical flat shell ${label} is missing: ${path}`);
  }
  if (
    (stat.mode & 0xf000) !== 0x8000 ||
    (stat.mode & 0o111) === 0 ||
    fs.isPathDeferred(path)
  ) {
    throw new Error(
      `canonical flat shell ${label} is not an eager executable: ${path}`,
    );
  }
}

function readGuestRegularFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.lstat(path);
  if ((stat.mode & 0xf000) !== 0x8000 || stat.size <= 0) {
    throw new Error(
      `canonical flat shell ${path} is not a nonempty regular file`,
    );
  }
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, constants.O_RDONLY, 0);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = fs.read(
        fd,
        bytes.subarray(offset),
        null,
        bytes.byteLength - offset,
      );
      if (count <= 0)
        throw new Error(`short read from canonical flat shell ${path}`);
      offset += count;
    }
  } finally {
    fs.close(fd);
  }
  return bytes;
}

function parseShellConfig(bytes: Uint8Array) {
  try {
    const config = parseKandeloShellConfig(decodeUtf8(bytes, "shell config"));
    if (config === null) throw new Error("unsupported schema");
    return config;
  } catch (error) {
    throw new Error("canonical flat shell config is invalid", { cause: error });
  }
}

function parseDemoConfig(bytes: Uint8Array) {
  try {
    const config = parseKandeloDemoConfig(decodeUtf8(bytes, "demo config"));
    if (config === null) throw new Error("unsupported schema");
    return config;
  } catch (error) {
    throw new Error("canonical flat shell demo config is invalid", {
      cause: error,
    });
  }
}

function decodeUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

function readRegularFileNoFollow(
  path: string,
  label: string,
  maxBytes: number,
): Uint8Array {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error(`${label} must be a regular non-symlink file: ${path}`, {
      cause: error,
    });
  }
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > maxBytes ||
      !Number.isSafeInteger(before.size)
    ) {
      throw new Error(
        `${label} must be a nonempty regular file no larger than ${maxBytes} bytes: ${path}`,
      );
    }
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(
        fd,
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (count <= 0)
        throw new Error(`${label} changed during its bounded read`);
      offset += count;
    }
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`${label} changed during its bounded read`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function boundedBytes(
  value: Uint8Array,
  label: string,
  maxBytes: number,
): Uint8Array {
  const bytes = nonemptyBytes(value, label);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  return bytes;
}

function nonemptyBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) {
    throw new Error(`${label} is empty`);
  }
  return value;
}

function expectExactRecord(
  actual: unknown,
  expected: Record<string, unknown>,
  label: string,
): void {
  exactRecord(actual, label);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} does not match the canonical flat shell input`);
  }
}

function expectExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function exactRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--image",
    "--selection",
    "--shell-config",
    "--demo-config",
    "--out",
  ]);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      key === undefined ||
      value === undefined ||
      !allowed.has(key) ||
      values.has(key)
    ) {
      usage();
    }
    values.set(key, value);
  }
  if (values.size !== allowed.size) usage();
  return {
    image: resolve(values.get("--image")!),
    selection: resolve(values.get("--selection")!),
    shellConfig: resolve(values.get("--shell-config")!),
    demoConfig: resolve(values.get("--demo-config")!),
    output: resolve(values.get("--out")!),
  };
}

function usage(): never {
  throw new Error(
    "usage: npx tsx scripts/inspect-canonical-flat-shell.ts " +
      "--image <shell.vfs.zst> --selection <selection.json> " +
      "--shell-config <shell.json> --demo-config <demo.json> " +
      "--out <new-report.json>",
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await inspectCanonicalFlatShellFiles(parseArgs(process.argv.slice(2)));
}
