import { createHash } from "node:crypto";
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
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
  dev: bigint;
  ino: bigint;
}

interface PreparedFlatHomebrewVfsOutput {
  finalPath: string;
  bytes: Uint8Array;
  expectedSha256: string;
  expectedBytes: number;
}

export interface FlatHomebrewVfsPublicationResult {
  cleanupWarnings: readonly string[];
}

/**
 * Publish the generated image and report through private same-parent staging.
 * The helper owns and removes only its fresh staging directory. Final paths
 * are never replaced, and a later failure rolls back only links made here.
 * Cleanup failure after both links is a returned warning because publication
 * has already succeeded and the final paths must not be reported as absent.
 */
export function publishFlatHomebrewVfsOutputs(
  outputs: readonly FlatHomebrewVfsOutput[],
): FlatHomebrewVfsPublicationResult {
  if (outputs.length !== 2) {
    throw new Error(
      "flat Homebrew VFS publication requires exactly an image and report",
    );
  }

  const prepared = prepareFlatHomebrewVfsOutputs(outputs);
  const published: Array<{ path: string; identity: FileIdentity }> = [];
  let stagingDirectory: string | null = null;
  let publicationError: unknown = null;
  try {
    stagingDirectory = mkdtempSync(
      join(prepared.parentPath, ".kandelo-homebrew-vfs-"),
    );
    chmodSync(stagingDirectory, 0o700);
    const staged = prepared.outputs.map((output, index) => {
      const path = join(stagingDirectory, `output-${index}`);
      const stat = writeAndVerifyFlatHomebrewVfsStagedOutput(path, output);
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
      const linked = lstatSync(candidate.output.finalPath, { bigint: true });
      const linkedIdentity = identityOf(linked);
      if (
        !linked.isFile() ||
        linked.size !== BigInt(candidate.output.expectedBytes) ||
        (linked.mode & 0o777n) !== 0o600n ||
        !sameIdentity(linkedIdentity, stagedIdentity)
      ) {
        throw new Error(
          `flat Homebrew final output did not link its staged inode: ` +
            candidate.output.finalPath,
        );
      }
    }
  } catch (error) {
    try {
      rollbackFlatHomebrewVfsOutputs(published);
      publicationError = error;
    } catch (rollbackError) {
      publicationError = new Error(
        `${errorMessage(error)}; rollback failed: ${errorMessage(rollbackError)}`,
      );
    }
  }

  const cleanupWarnings: string[] = [];
  if (stagingDirectory !== null) {
    try {
      rmSync(stagingDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupWarnings.push(
        `flat Homebrew staging cleanup failed for ${stagingDirectory}: ` +
          errorMessage(error),
      );
    }
  }
  if (publicationError !== null) {
    const cleanupDetail = cleanupWarnings.length === 0
      ? ""
      : `; ${cleanupWarnings.join("; ")}`;
    throw new Error(
      `flat Homebrew VFS output publication failed: ` +
        `${errorMessage(publicationError)}${cleanupDetail}`,
    );
  }
  return { cleanupWarnings };
}

function writeAndVerifyFlatHomebrewVfsStagedOutput(
  path: string,
  output: PreparedFlatHomebrewVfsOutput,
): BigIntStats {
  const descriptor = openSync(
    path,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    // The create mode is umask-filtered. Set and verify the owned inode's
    // exact private mode before any hard link can expose it.
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, output.bytes);
    const stat = fstatSync(descriptor, { bigint: true });
    if (
      !stat.isFile() ||
      stat.size !== BigInt(output.expectedBytes) ||
      (stat.mode & 0o777n) !== 0o600n
    ) {
      throw new Error(`flat Homebrew staged output is incomplete: ${path}`);
    }

    const actualSha256 = hashExactFileDescriptor(
      descriptor,
      output.expectedBytes,
      path,
    );
    if (actualSha256 !== output.expectedSha256) {
      throw new Error(
        `flat Homebrew staged output ${path} expected SHA-256 ` +
          `${output.expectedSha256}, got ${actualSha256}`,
      );
    }
    const verified = fstatSync(descriptor, { bigint: true });
    if (
      !verified.isFile() ||
      verified.size !== stat.size ||
      (verified.mode & 0o777n) !== 0o600n ||
      !sameIdentity(identityOf(verified), identityOf(stat))
    ) {
      throw new Error(`flat Homebrew staged output changed: ${path}`);
    }
    return verified;
  } finally {
    closeSync(descriptor);
  }
}

function hashExactFileDescriptor(
  descriptor: number,
  expectedBytes: number,
  path: string,
): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(
    Math.max(1, Math.min(expectedBytes, 64 * 1024)),
  );
  let offset = 0;
  while (offset < expectedBytes) {
    const requested = Math.min(buffer.byteLength, expectedBytes - offset);
    const count = readSync(descriptor, buffer, 0, requested, offset);
    if (count === 0) {
      throw new Error(`flat Homebrew staged output changed: ${path}`);
    }
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  const extra = Buffer.allocUnsafe(1);
  if (readSync(descriptor, extra, 0, 1, expectedBytes) !== 0) {
    throw new Error(`flat Homebrew staged output changed: ${path}`);
  }
  return hash.digest("hex");
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
      const bytes = output.bytes;
      const expectedSha256 = output.expectedSha256;
      const expectedBytes = output.expectedBytes;
      if (!SHA256_RE.test(expectedSha256)) {
        throw new Error("flat Homebrew output has an invalid SHA-256");
      }
      if (
        !Number.isSafeInteger(expectedBytes) ||
        expectedBytes < 0
      ) {
        throw new Error("flat Homebrew output has an invalid byte count");
      }
      if (bytes.byteLength !== expectedBytes) {
        throw new Error(
          `flat Homebrew output expected ${expectedBytes} bytes, ` +
            `found ${bytes.byteLength}`,
        );
      }
      const actualSha256 = createHash("sha256")
        .update(bytes)
        .digest("hex");
      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `flat Homebrew output expected ${expectedSha256}, ` +
            `got ${actualSha256}`,
        );
      }
      return {
        finalPath: finalPaths[index]!,
        bytes,
        expectedSha256,
        expectedBytes,
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

function identityOf(stat: Pick<BigIntStats, "dev" | "ino">): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function lstatOrNull(path: string): BigIntStats | null {
  try {
    return lstatSync(path, { bigint: true });
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
