import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  binariesDir,
  localBinariesDir,
  resolveBinary,
} from "../src/binary-resolver";
import { ABI_VERSION } from "../src/generated/abi";
import {
  MemoryFileSystem,
  type VfsImageMetadata,
} from "../src/vfs/memory-fs";

const cleanupDirs = new Set<string>();
const cleanupEmptyDirs = new Set<string>();

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of cleanupEmptyDirs) {
    try {
      rmdirSync(dir);
    } catch {
      // Keep any non-empty resolver cache directories owned by the user.
    }
  }
  cleanupDirs.clear();
  cleanupEmptyDirs.clear();
});

function uleb128(n: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return bytes;
}

function sleb128I32(n: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    let byte = n & 0x7f;
    n >>= 7;
    const signBit = (byte & 0x40) !== 0;
    if ((n === 0 && !signBit) || (n === -1 && signBit)) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 0x80);
  }
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb128(payload.length), ...payload];
}

function nameBytes(name: string): number[] {
  const encoded = new TextEncoder().encode(name);
  return [...uleb128(encoded.length), ...encoded];
}

function functionBody(instructions: number[]): number[] {
  const body = [0x00, ...instructions, 0x0b];
  return [...uleb128(body.length), ...body];
}

function executableWasmWithAbi(abi: number): Uint8Array {
  const bytes: number[] = [
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
  ];

  bytes.push(...section(1, [0x01, 0x60, 0x00, 0x01, 0x7f]));
  bytes.push(...section(3, [0x02, 0x00, 0x00]));
  bytes.push(...section(7, [
    0x02,
    ...nameBytes("__abi_version"), 0x00, 0x00,
    ...nameBytes("_start"), 0x00, 0x01,
  ]));
  bytes.push(...section(10, [
    0x02,
    ...functionBody([0x41, ...sleb128I32(abi)]),
    ...functionBody([0x41, 0x00]),
  ]));

  return new Uint8Array(bytes);
}

async function vfsImage(
  metadata: VfsImageMetadata | null | undefined,
  compressed: boolean,
): Promise<Uint8Array> {
  const mfs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  const image = await mfs.saveImage(
    metadata === undefined ? undefined : { metadata },
  );
  return compressed ? new Uint8Array(zstdCompressSync(image)) : image;
}

function fixtureRelPath(extension: ".wasm" | ".vfs" | ".vfs.zst" | ".dat"): string {
  const testRoot = "programs/wasm32/__binary_resolver_test__";
  const dir = `${testRoot}/${randomUUID()}`;
  cleanupDirs.add(join(localBinariesDir(), dir));
  cleanupDirs.add(join(binariesDir(), dir));
  for (const root of [localBinariesDir(), binariesDir()]) {
    cleanupEmptyDirs.add(join(root, testRoot));
    cleanupEmptyDirs.add(join(root, "programs/wasm32"));
    cleanupEmptyDirs.add(join(root, "programs"));
    cleanupEmptyDirs.add(root);
  }
  return `${dir}/artifact${extension}`;
}

function candidatePath(root: string, relPath: string): string {
  return join(root, relPath);
}

function writeCandidate(root: string, relPath: string, bytes: Uint8Array): string {
  const path = candidatePath(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

describe("binary resolver artifact policy", () => {
  it("skips a stale local .vfs.zst when a fetched ABI-matching candidate exists", async () => {
    const relPath = fixtureRelPath(".vfs.zst");
    const staleLocal = await vfsImage(
      { version: 1, kernelAbi: ABI_VERSION - 1 },
      true,
    );
    const fetched = await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, true);

    writeCandidate(localBinariesDir(), relPath, staleLocal);
    const fetchedPath = writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(fetchedPath);
  });

  it("skips a stale local .vfs when a fetched ABI-matching candidate exists", async () => {
    const relPath = fixtureRelPath(".vfs");
    const staleLocal = await vfsImage(
      { version: 1, kernelAbi: ABI_VERSION - 1 },
      false,
    );
    const fetched = await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, false);

    writeCandidate(localBinariesDir(), relPath, staleLocal);
    const fetchedPath = writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(fetchedPath);
  });

  it("selects a matching local .vfs.zst before the fetched candidate", async () => {
    const relPath = fixtureRelPath(".vfs.zst");
    const local = await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, true);
    const fetched = await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, true);

    const localPath = writeCandidate(localBinariesDir(), relPath, local);
    writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(localPath);
  });

  it("accepts a VFS image with metadata but no kernelAbi declaration", async () => {
    const relPath = fixtureRelPath(".vfs.zst");
    const local = await vfsImage({ version: 1 }, true);
    const fetched = await vfsImage({ version: 1, kernelAbi: ABI_VERSION }, true);

    const localPath = writeCandidate(localBinariesDir(), relPath, local);
    writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(localPath);
  });

  it("keeps skipping a stale local .wasm when a fetched ABI-matching candidate exists", () => {
    const relPath = fixtureRelPath(".wasm");
    const staleLocal = executableWasmWithAbi(ABI_VERSION - 1);
    const fetched = executableWasmWithAbi(ABI_VERSION);

    writeCandidate(localBinariesDir(), relPath, staleLocal);
    const fetchedPath = writeCandidate(binariesDir(), relPath, fetched);

    expect(resolveBinary(relPath)).toBe(fetchedPath);
  });

  it("prefers a local declared runtime data file over the fetched candidate", () => {
    const relPath = fixtureRelPath(".dat");
    const localPath = writeCandidate(
      localBinariesDir(),
      relPath,
      new TextEncoder().encode("local-runtime"),
    );
    writeCandidate(
      binariesDir(),
      relPath,
      new TextEncoder().encode("fetched-runtime"),
    );

    expect(resolveBinary(relPath)).toBe(localPath);
  });
});
