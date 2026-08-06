import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const SHA256_RE = /^[0-9a-f]{64}$/;

export interface FlatHomebrewVfsCliOptions {
  selection: string;
  baseImage: string;
  bottleCache: string;
  shellConfig: string;
  out: string;
  report: string;
}

const CLI_FLAGS = new Map<string, keyof FlatHomebrewVfsCliOptions>([
  ["--selection", "selection"],
  ["--base-image", "baseImage"],
  ["--bottle-cache", "bottleCache"],
  ["--shell-config", "shellConfig"],
  ["--out", "out"],
  ["--report", "report"],
]);

export function parseFlatHomebrewVfsArgs(
  args: readonly string[],
): FlatHomebrewVfsCliOptions {
  const parsed: Partial<FlatHomebrewVfsCliOptions> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || !CLI_FLAGS.has(flag)) {
      throw new Error(`unknown flat Homebrew VFS option: ${flag ?? "<missing>"}`);
    }
    if (value === undefined || value.length === 0 || value.startsWith("--")) {
      throw new Error(`flat Homebrew VFS option ${flag} requires one value`);
    }
    const key = CLI_FLAGS.get(flag)!;
    if (parsed[key] !== undefined) {
      throw new Error(`flat Homebrew VFS option ${flag} was provided more than once`);
    }
    parsed[key] = value;
  }
  for (const [flag, key] of CLI_FLAGS) {
    if (parsed[key] === undefined) {
      throw new Error(`required flat Homebrew VFS option is missing: ${flag}`);
    }
  }
  const options = parsed as FlatHomebrewVfsCliOptions;
  if (resolve(options.out) === resolve(options.report)) {
    throw new Error("flat Homebrew VFS image and report paths must be different");
  }
  return options;
}

export interface FlatHomebrewBottleCacheIdentity {
  fullName: string;
  sha256: string;
  bytes: number;
}

/** Read one exact digest-addressed bottle. This path has no URL fallback. */
export function readFlatHomebrewBottleCacheEntry(
  cacheRoot: string,
  bottle: FlatHomebrewBottleCacheIdentity,
): Uint8Array {
  if (!SHA256_RE.test(bottle.sha256)) {
    throw new Error(`invalid flat Homebrew bottle digest for ${bottle.fullName}`);
  }
  if (!Number.isSafeInteger(bottle.bytes) || bottle.bytes <= 0) {
    throw new Error(`invalid flat Homebrew bottle byte count for ${bottle.fullName}`);
  }
  const path = join(cacheRoot, `${bottle.sha256}.tar.gz`);
  const label = `flat bottle cache entry for ${bottle.fullName} at ${path}`;
  const bytes = readBoundedRegularFileNoFollow(
    path,
    label,
    bottle.bytes,
    bottle.bytes,
  );
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== bottle.sha256) {
    throw new Error(
      `${label} expected ${bottle.sha256}, got ${actualSha256}`,
    );
  }
  return bytes;
}

export function readBoundedRegularFileNoFollow(
  path: string,
  label: string,
  maxBytes: number,
  expectedBytes?: number,
): Uint8Array {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error(`${label} has an invalid byte limit`);
  }
  if (
    expectedBytes !== undefined &&
    (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)
  ) {
    throw new Error(`${label} has an invalid expected byte count`);
  }
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw new Error(
      `${label} must be an accessible regular non-symlink file: ${errorMessage(error)}`,
    );
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(`${label} must be a regular file`);
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
      throw new Error(`${label} exceeds its ${maxBytes}-byte limit`);
    }
    if (expectedBytes !== undefined && stat.size !== expectedBytes) {
      throw new Error(
        `${label} expected ${expectedBytes} bytes, found ${stat.size}`,
      );
    }
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(
        descriptor,
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (count === 0) {
        throw new Error(`${label} changed while it was being read`);
      }
      offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    if (readSync(descriptor, extra, 0, 1, null) !== 0) {
      throw new Error(`${label} changed while it was being read`);
    }
    return Uint8Array.from(buffer);
  } finally {
    closeSync(descriptor);
  }
}

export interface FlatHomebrewVfsOutput {
  finalPath: string;
  bytes: Uint8Array;
  expectedSha256: string;
  expectedBytes: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface PreparedFlatHomebrewVfsOutput {
  finalPath: string;
  bytes: Uint8Array;
  expectedBytes: number;
}

/**
 * Publish the generated image and report through private same-parent staging.
 * The helper owns and removes only its fresh staging directory. Final paths
 * are never replaced, and a later failure rolls back only links made here.
 */
export function publishFlatHomebrewVfsOutputs(
  outputs: readonly FlatHomebrewVfsOutput[],
): void {
  if (outputs.length !== 2) {
    throw new Error(
      "flat Homebrew VFS publication requires exactly an image and report",
    );
  }

  const prepared = prepareFlatHomebrewVfsOutputs(outputs);
  const stagingDirectory = mkdtempSync(
    join(prepared.parentPath, ".kandelo-homebrew-vfs-"),
  );
  chmodSync(stagingDirectory, 0o700);
  const published: Array<{ path: string; identity: FileIdentity }> = [];
  try {
    const staged = prepared.outputs.map((output, index) => {
      const path = join(stagingDirectory, `output-${index}`);
      writeFileSync(path, output.bytes, { flag: "wx", mode: 0o600 });
      const stat = lstatSync(path) as Stats;
      if (!stat.isFile() || stat.size !== output.expectedBytes) {
        throw new Error(`flat Homebrew staged output is incomplete: ${path}`);
      }
      return { path, stat, output };
    });
    if (sameIdentity(identityOf(staged[0]!.stat), identityOf(staged[1]!.stat))) {
      throw new Error("flat Homebrew image and report share one staged inode");
    }

    for (const candidate of staged) {
      if (lstatOrNull(candidate.output.finalPath) !== null) {
        throw new Error(
          `flat Homebrew final output already exists: ` +
            candidate.output.finalPath,
        );
      }
      linkSync(candidate.path, candidate.output.finalPath);
      const stagedIdentity = identityOf(candidate.stat);
      published.push({
        path: candidate.output.finalPath,
        identity: stagedIdentity,
      });
      const linked = lstatSync(candidate.output.finalPath) as Stats;
      const linkedIdentity = identityOf(linked);
      if (
        !linked.isFile() ||
        linked.size !== candidate.output.expectedBytes ||
        !sameIdentity(linkedIdentity, stagedIdentity)
      ) {
        throw new Error(
          `flat Homebrew final output did not link its staged inode: ` +
            candidate.output.finalPath,
        );
      }
    }
  } catch (error) {
    rollbackFlatHomebrewVfsOutputs(published);
    throw new Error(
      `flat Homebrew VFS output publication failed: ${errorMessage(error)}`,
    );
  } finally {
    rmSync(stagingDirectory, { recursive: true, force: true });
  }
}

function prepareFlatHomebrewVfsOutputs(
  outputs: readonly FlatHomebrewVfsOutput[],
): { parentPath: string; outputs: PreparedFlatHomebrewVfsOutput[] } {
  const parentPaths = outputs.map((output) =>
    realpathSync(dirname(resolve(output.finalPath)))
  );
  if (parentPaths[0] !== parentPaths[1]) {
    throw new Error(
      "flat Homebrew image and report must share one final directory",
    );
  }
  const finalPaths = outputs.map((output) =>
    join(parentPaths[0]!, basename(resolve(output.finalPath)))
  );
  if (finalPaths[0] === finalPaths[1]) {
    throw new Error("flat Homebrew image and report paths must be different");
  }

  return {
    parentPath: parentPaths[0]!,
    outputs: outputs.map((output, index) => {
      if (!SHA256_RE.test(output.expectedSha256)) {
        throw new Error("flat Homebrew output has an invalid SHA-256");
      }
      if (
        !Number.isSafeInteger(output.expectedBytes) ||
        output.expectedBytes < 0
      ) {
        throw new Error("flat Homebrew output has an invalid byte count");
      }
      if (output.bytes.byteLength !== output.expectedBytes) {
        throw new Error(
          `flat Homebrew output expected ${output.expectedBytes} bytes, ` +
            `found ${output.bytes.byteLength}`,
        );
      }
      const actualSha256 = createHash("sha256")
        .update(output.bytes)
        .digest("hex");
      if (actualSha256 !== output.expectedSha256) {
        throw new Error(
          `flat Homebrew output expected ${output.expectedSha256}, ` +
            `got ${actualSha256}`,
        );
      }
      return {
        finalPath: finalPaths[index]!,
        bytes: output.bytes,
        expectedBytes: output.expectedBytes,
      };
    }),
  };
}

function rollbackFlatHomebrewVfsOutputs(
  outputs: readonly { path: string; identity: FileIdentity }[],
): void {
  for (const output of [...outputs].reverse()) {
    const current = lstatOrNull(output.path);
    if (
      current !== null &&
      sameIdentity(identityOf(current), output.identity)
    ) {
      unlinkSync(output.path);
    }
  }
}

function identityOf(stat: Pick<Stats, "dev" | "ino">): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path) as Stats;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
