import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  saveImage,
  type VfsWasmArtifactPolicy,
} from "../../images/vfs/scripts/vfs-image-helpers";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { ABI_VERSION } from "../src/generated/abi";

const NODE_PATH = "/usr/bin/node";
const DISABLED_NODE_POLICY = {
  path: NODE_PATH,
  forkInstrumentation: "disabled",
} as const satisfies VfsWasmArtifactPolicy;
const cleanupDirectories = new Set<string>();

afterEach(() => {
  for (const path of cleanupDirectories) {
    rmSync(path, { recursive: true, force: true });
  }
  cleanupDirectories.clear();
});

describe("VFS image path-scoped Wasm artifact policy", () => {
  it("accepts one declared non-forking executable without weakening the image walk", async () => {
    const accepted = imageFs();
    writeVfsBinary(accepted, NODE_PATH, wasmImportingKernelFork(), 0o755);
    const acceptedOutput = outputPath("accepted");

    await expect(
      saveImage(accepted, acceptedOutput, {
        wasmArtifactPolicies: [DISABLED_NODE_POLICY],
      }),
    ).resolves.toEqual(expect.any(Uint8Array));
    expect(existsSync(acceptedOutput)).toBe(true);

    const stale = imageFs();
    writeVfsBinary(stale, NODE_PATH, wasmImportingKernelFork(), 0o755);
    writeVfsBinary(
      stale,
      "/usr/bin/undeclared-stale",
      wasmImportingKernelFork(),
      0o755,
    );
    await expect(
      saveImage(stale, outputPath("stale"), {
        wasmArtifactPolicies: [DISABLED_NODE_POLICY],
      }),
    ).rejects.toThrow(
      /\/usr\/bin\/undeclared-stale:[\s\S]*incomplete wasm-fork-instrument exports/,
    );
  });

  it("rejects disabled policy when the artifact carries fork instrumentation state", async () => {
    const fs = imageFs();
    writeVfsBinary(
      fs,
      NODE_PATH,
      wasmImportingKernelFork({ partialForkExport: true }),
      0o755,
    );

    await expect(
      saveImage(fs, outputPath("fork-state"), {
        wasmArtifactPolicies: [DISABLED_NODE_POLICY],
      }),
    ).rejects.toThrow(
      new RegExp(
        String.raw`/usr/bin/node:[\s\S]*contains ABI ${ABI_VERSION} `
          + "wasm-fork-instrument metadata, imports, or exports",
      ),
    );
  });

  it("rejects missing, deferred, and non-Wasm policy targets", async () => {
    await expect(
      saveImage(imageFs(), outputPath("missing"), {
        wasmArtifactPolicies: [DISABLED_NODE_POLICY],
      }),
    ).rejects.toThrow(
      /\/usr\/bin\/node: declared Wasm artifact policy did not match a materialized regular file/,
    );

    const deferred = imageFs();
    deferred.registerLazyFile(
      NODE_PATH,
      "https://example.invalid/node.wasm",
      1024,
      0o755,
    );
    await expect(
      saveImage(deferred, outputPath("deferred"), {
        wasmArtifactPolicies: [DISABLED_NODE_POLICY],
      }),
    ).rejects.toThrow(
      /\/usr\/bin\/node: declared Wasm artifact policy did not match a materialized regular file/,
    );

    const nonWasm = imageFs();
    writeVfsBinary(nonWasm, NODE_PATH, new TextEncoder().encode("node"), 0o755);
    await expect(
      saveImage(nonWasm, outputPath("non-wasm"), {
        wasmArtifactPolicies: [DISABLED_NODE_POLICY],
      }),
    ).rejects.toThrow(
      /\/usr\/bin\/node: declared Wasm artifact policy names a non-Wasm file/,
    );
  });

  it("rejects duplicate, unknown, and disabled-whole-image declarations", async () => {
    const fs = imageFs();
    writeVfsBinary(fs, NODE_PATH, wasmImportingKernelFork(), 0o755);

    await expect(
      saveImage(fs, outputPath("duplicate"), {
        wasmArtifactPolicies: [DISABLED_NODE_POLICY, DISABLED_NODE_POLICY],
      }),
    ).rejects.toThrow("Duplicate VFS Wasm artifact policy path");

    await expect(
      saveImage(fs, outputPath("unknown"), {
        wasmArtifactPolicies: [
          {
            ...DISABLED_NODE_POLICY,
            reason: "typo must not be ignored",
          } as unknown as VfsWasmArtifactPolicy,
        ],
      }),
    ).rejects.toThrow("must contain exactly forkInstrumentation and path");

    await expect(
      saveImage(fs, outputPath("skip"), {
        skipWasmArtifactCheck: true,
        wasmArtifactPolicies: [DISABLED_NODE_POLICY],
      }),
    ).rejects.toThrow(
      "cannot be used when the whole-image Wasm artifact check is disabled",
    );
  });

  it.each([
    "usr/bin/node",
    "/",
    "/usr//bin/node",
    "/usr/./bin/node",
    "/usr/bin/../node",
    "/usr/bin/node/",
    "/usr\\bin\\node",
    "/usr/bin/\0node",
  ])("rejects noncanonical declaration path %j", async (path) => {
    await expect(
      saveImage(imageFs(), outputPath("path"), {
        wasmArtifactPolicies: [
          {
            path,
            forkInstrumentation: "disabled",
          },
        ],
      }),
    ).rejects.toThrow("must be a canonical absolute file path");
  });
});

function imageFs(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
  ensureDirRecursive(fs, "/usr/bin");
  return fs;
}

function outputPath(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `kandelo-vfs-wasm-${name}-`));
  cleanupDirectories.add(directory);
  return join(directory, "image.vfs.zst");
}

function wasmImportingKernelFork(
  options: { partialForkExport?: boolean } = {},
): Uint8Array {
  const bytes: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  bytes.push(...section(1, [0x01, 0x60, 0x00, 0x01, 0x7f]));
  bytes.push(
    ...section(2, [
      0x01,
      ...nameBytes("kernel"),
      ...nameBytes("kernel_fork"),
      0x00,
      0x00,
    ]),
  );
  bytes.push(...section(3, [0x01, 0x00]));
  const exports = [...nameBytes("_start"), 0x00, 0x01];
  if (options.partialForkExport) {
    exports.push(...nameBytes("wpk_fork_state"), 0x00, 0x01);
  }
  bytes.push(
    ...section(7, [options.partialForkExport ? 0x02 : 0x01, ...exports]),
  );
  bytes.push(...section(10, [0x01, ...functionBody([0x41, 0x00])]));
  return new Uint8Array(bytes);
}

function uleb128(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function section(id: number, payload: number[]): number[] {
  return [id, ...uleb128(payload.length), ...payload];
}

function nameBytes(value: string): number[] {
  const encoded = new TextEncoder().encode(value);
  return [...uleb128(encoded.length), ...encoded];
}

function functionBody(instructions: number[]): number[] {
  const body = [0x00, ...instructions, 0x0b];
  return [...uleb128(body.length), ...body];
}
