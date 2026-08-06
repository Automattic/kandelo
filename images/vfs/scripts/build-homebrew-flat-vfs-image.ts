import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";

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
      constants.O_RDONLY | constants.O_NOFOLLOW,
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

export interface FlatHomebrewVfsStagedOutput {
  stagedPath: string;
  finalPath: string;
}

/** Hard-link staged files into place, rolling back links from this attempt. */
export function publishFlatHomebrewVfsOutputs(
  outputs: readonly FlatHomebrewVfsStagedOutput[],
): void {
  if (outputs.length === 0) {
    throw new Error("flat Homebrew VFS publication has no outputs");
  }
  const prepared = outputs.map((output) => {
    const staged = lstatOrNull(output.stagedPath);
    if (staged === null || !staged.isFile()) {
      throw new Error(
        `flat Homebrew staged output must be a regular file: ${output.stagedPath}`,
      );
    }
    if (lstatOrNull(output.finalPath) !== null) {
      throw new Error(
        `flat Homebrew final output already exists: ${output.finalPath}`,
      );
    }
    return { ...output, staged };
  });

  const published: typeof prepared = [];
  try {
    for (const output of prepared) {
      linkSync(output.stagedPath, output.finalPath);
      published.push(output);
    }
  } catch (error) {
    for (const output of published.reverse()) {
      const final = lstatOrNull(output.finalPath);
      if (
        final !== null &&
        final.dev === output.staged.dev &&
        final.ino === output.staged.ino
      ) {
        unlinkSync(output.finalPath);
      }
    }
    throw new Error(
      `flat Homebrew VFS output publication failed: ${errorMessage(error)}`,
    );
  }
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
