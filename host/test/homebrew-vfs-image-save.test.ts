import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  saveVerifiedHomebrewVfsImage,
} from "../../images/vfs/scripts/build-homebrew-vfs-image";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const MiB = 1024 * 1024;

describe("Homebrew VFS image publication boundary", () => {
  it("writes an image whose encoded ceiling matches its consumer contract", async () => {
    const maxByteLength = 8 * MiB;
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(1 * MiB, { maxByteLength }),
      maxByteLength,
    );
    const dir = mkdtempSync(join(tmpdir(), "homebrew-vfs-capacity-"));
    const outFile = join(dir, "homebrew.vfs.zst");
    try {
      const image = await saveVerifiedHomebrewVfsImage(
        fs,
        outFile,
        { skipWasmArtifactCheck: true },
        maxByteLength,
      );

      expect(
        MemoryFileSystem.readImageCapacity(image).maxByteLength,
      ).toBe(maxByteLength);
      expect(existsSync(outFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a masked encoded ceiling before creating an output artifact", async () => {
    const encodedMaxByteLength = 8 * MiB;
    const consumerMaxByteLength = 4 * MiB;
    const source = MemoryFileSystem.create(
      new SharedArrayBuffer(1 * MiB, {
        maxByteLength: encodedMaxByteLength,
      }),
      encodedMaxByteLength,
    );
    const restored = MemoryFileSystem.fromImage(await source.saveImage(), {
      maxByteLength: consumerMaxByteLength,
    });
    expect(restored.statfs("/").blocks * restored.statfs("/").bsize).toBe(
      consumerMaxByteLength,
    );

    const dir = mkdtempSync(join(tmpdir(), "homebrew-vfs-capacity-drift-"));
    const outFile = join(dir, "homebrew.vfs.zst");
    try {
      await expect(
        saveVerifiedHomebrewVfsImage(
          restored,
          outFile,
          { skipWasmArtifactCheck: true },
          consumerMaxByteLength,
        ),
      ).rejects.toThrow(
        /has a 8388608-byte VFS capacity; 4194304 bytes are required/,
      );
      expect(existsSync(outFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
