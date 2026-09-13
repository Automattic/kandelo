import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadShellBaseFileSystemFromImage,
  populateShellEnvironment,
  saveShellDerivedBuildGuestSnapshot,
  saveShellDerivedVfsImage,
  SOURCE_ROOTFS_SHELL_COMPOSITION,
} from "../../images/vfs/scripts/shell-vfs-build";
import { restoreTrustedShellRootfs } from "../../images/vfs/scripts/shell-rootfs-restore";
import {
  MemoryFileSystem,
  type VfsImageMetadata,
} from "../src/vfs/memory-fs";
import { ABI_VERSION } from "../src/generated/abi";
import type { ZipEntry } from "../src/vfs/zip";
import {
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
} from "../../web-libs/kandelo-session/src/vfs-capacity";
import { SffsImageFs } from "../../images/vfs/lib/sffs-image-fs";

const MiB = 1024 * 1024;
const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const DEMO_CONFIG_PATH = "/etc/kandelo/demo.json";
const SOURCE_DEMO_CONFIG = '{"version":1,"profiles":{"shell":{}}}\n';

function writeFile(fs: MemoryFileSystem, path: string, text: string): void {
  const fd = fs.open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644);
  const bytes = new TextEncoder().encode(text);
  fs.write(fd, bytes, null, bytes.byteLength);
  fs.close(fd);
}

function readFile(fs: MemoryFileSystem, path: string): string {
  const size = fs.stat(path).size;
  const fd = fs.open(path, O_RDONLY, 0);
  const bytes = new Uint8Array(size);
  const count = fs.read(fd, bytes, null, size);
  fs.close(fd);
  return new TextDecoder().decode(bytes.subarray(0, count));
}

/**
 * A product filesystem with a declared capacity, built the way a product build
 * builds one.
 *
 * These used to be `MemoryFileSystem.create(new SharedArrayBuffer(16 MiB, {
 * maxByteLength }), maxByteLength)` — a buffer sized now and a ceiling declared
 * for later, which is the shape the module removes. Capacity is a number the
 * export reads, so there is no buffer to size and no second argument to keep in
 * step with the first.
 */
function productFs(maxByteLength: number): SffsImageFs {
  const fs = SffsImageFs.create();
  fs.setImageCapacity(maxByteLength);
  return fs;
}

function lazyArchiveEntry(): ZipEntry {
  return {
    fileName: "usr/share/demo/archive.txt",
    fileNameBytes: new TextEncoder().encode("usr/share/demo/archive.txt"),
    compressedSize: 10,
    uncompressedSize: 4096,
    compressionMethod: 8,
    localHeaderOffset: 0,
    mode: 0o644,
    isDirectory: false,
    isSymlink: false,
    externalAttrs: 0,
    creatorOS: 3,
  };
}

function shellImageMetadata(maxByteLength: number): VfsImageMetadata {
  return {
    version: 1,
    kernelAbi: ABI_VERSION,
    createdBy: "shell-vfs-build.test/source",
    capacity: { maxByteLength },
    baseImage: {
      sha256: "b".repeat(64),
      bytes: 123_456,
      kernelAbi: ABI_VERSION,
      sourceSignature: "must not be relabeled as a derived-image signature",
    },
    shellComposition: SOURCE_ROOTFS_SHELL_COMPOSITION,
    sourceAttestation: { mustNotBeRelabeledAsDerived: true },
  };
}

function sourceShellImageMetadata(
  maxByteLength: number,
): VfsImageMetadata {
  return {
    version: 1,
    kernelAbi: ABI_VERSION,
    createdBy: "build-source-rootfs-shell-image",
    capacity: { maxByteLength },
    baseImage: {
      sha256: "c".repeat(64),
      bytes: 234_567,
      kernelAbi: ABI_VERSION,
    },
    shellComposition: SOURCE_ROOTFS_SHELL_COMPOSITION,
  };
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function loadedShellImageMetadata(
  sourceMaxByteLength: number,
  image: Uint8Array,
): VfsImageMetadata {
  return {
    ...shellImageMetadata(sourceMaxByteLength),
    baseImage: {
      sha256: sha256Hex(image),
      bytes: image.byteLength,
      kernelAbi: ABI_VERSION,
    },
  };
}

/**
 * A source image written by the OLD writer, on purpose.
 *
 * The builders under test now load through the Rust module, and the images
 * they will meet in a product build were written by `MemoryFileSystem` until
 * the bases are rebuilt. A fixture that switched writers alongside the code
 * would stop covering the case that actually ships.
 *
 * It no longer plants a sealed atomic tree. That fixture sealed in the LEGACY
 * format, which the module does not read -- so it proved nothing here once the
 * loader changed, and asserting on it would have been a test passing for the
 * wrong reason. Activation cohorts are covered where they are now produced and
 * checked: the module's own suite and `sffs-image-fs.test.ts`.
 */
async function sourceImage(
  byteLength: number,
  maxByteLength: number,
): Promise<Uint8Array> {
  const buffer = new SharedArrayBuffer(byteLength, { maxByteLength });
  const fs = MemoryFileSystem.create(buffer, maxByteLength);
  writeFile(fs, "/ordinary.txt", "preserved contents");
  fs.mkdir("/etc", 0o755);
  fs.mkdir("/etc/kandelo", 0o755);
  writeFile(fs, DEMO_CONFIG_PATH, SOURCE_DEMO_CONFIG);
  fs.registerLazyFile(
    "/bin/lazy-tool",
    "https://example.invalid/lazy-tool.wasm",
    123_456,
    0o755,
  );
  // The archive declares its raw byte length, as every real builder does.
  // Without one the legacy writer SKIPS the whole group when it encodes the
  // kernel-facing section -- a truthful gap at the writing end that used to
  // arrive at the reading end as a 4,096-byte member reporting zero. The
  // loader now refuses such an image (gap 20), so a fixture that omitted the
  // length would be testing the refusal rather than the capacity change it is
  // named for.
  fs.registerLazyArchiveFromEntries(
    "https://example.invalid/demo.zip",
    [lazyArchiveEntry()],
    "/",
    undefined,
    { sha256: "d".repeat(64), bytes: 5_000 },
  );
  return fs.saveImage({
    metadata: shellImageMetadata(maxByteLength),
  });
}

function expectContentsPreserved(fs: SffsImageFs): void {
  expect(readFile(fs, "/ordinary.txt")).toBe("preserved contents");
  expect(fs.stat("/bin/lazy-tool").size).toBe(123_456);
  expect(fs.stat("/bin/lazy-tool").mode & 0o777).toBe(0o755);
  // A deferred file keeps its REAL length and stays deferred across the load.
  // The URL is deliberately not asserted: it lives in the payload the kernel
  // carries without reading, and this bridge does not read it either -- the
  // property that matters to a builder is that the file is still described
  // rather than silently made empty or made resident.
  expect(fs.isPathDeferred("/bin/lazy-tool")).toBe(true);
  expect(fs.stat("/usr/share/demo/archive.txt").size).toBe(4096);
  expect(fs.isPathDeferred("/usr/share/demo/archive.txt")).toBe(true);
}

describe("shell VFS base composition", () => {
  it("refuses an image the loader rejects, before any shell build side effect", async () => {
    // This used to forge a legacy atomic seal and assert the refusal. The
    // refusal moved layers: verification now happens inside the module's
    // `sm_load_image`, where it has ten mutation trials against it, so the
    // FORGERY belongs in Rust and what remains worth checking here is the
    // boundary's own contract -- that a refused load aborts the build before
    // it resolves an artifact, registers anything, or writes a file.
    //
    // The refusal is provoked with a corrupt image rather than a forged seal
    // because this test cannot forge one honestly: the payload format is the
    // module's, and a TypeScript fixture that wrote it would be asserting
    // against its own idea of the format rather than against the module's.
    const source = MemoryFileSystem.create(new SharedArrayBuffer(8 * MiB));
    source.mkdir("/shell-rootfs", 0o755);
    const image = await source.saveImage();
    const corrupt = image.slice(0, Math.floor(image.byteLength / 2));

    const resolveArtifact = vi.fn();
    const register = vi.fn();
    const save = vi.fn();
    const build = () => {
      restoreTrustedShellRootfs(corrupt, 8 * MiB);
      resolveArtifact();
      register();
      save();
    };
    expect(build).toThrow();
    expect(resolveArtifact).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("never replaces a missing strict dependency with ambient magic data", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-strict-shell-resolver-"));
    const genericArtifact = join(root, "program.wasm");
    const ambientFileDir = join(root, "ambient-file");
    mkdirSync(ambientFileDir);
    writeFileSync(genericArtifact, "fixture");
    writeFileSync(join(ambientFileDir, "magic.lite"), "ambient magic");
    const key = "WASM_POSIX_DEP_FILE_DIR";
    const prior = process.env[key];
    process.env[key] = ambientFileDir;
    try {
      const fs = productFs(16 * MiB);
      expect(() =>
        populateShellEnvironment(fs, {
          eagerBinaries: true,
          resolveArtifact: (resolverPath) => {
            if (resolverPath.endsWith("magic.lite")) {
              throw new Error("declared file dependency omitted magic.lite");
            }
            return genericArtifact;
          },
        }),
      ).toThrow("declared file dependency omitted magic.lite");
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("routes every shell-derived product builder through the headroom gate", () => {
    const scriptsDir = join(import.meta.dirname, "../../images/vfs/scripts");
    const builders = readdirSync(scriptsDir)
      .filter((name) => name.startsWith("build-") && name.endsWith("-vfs-image.ts"))
      .filter((name) =>
        /loadShellBaseFileSystem(?:FromImage)?\(/.test(
          readFileSync(join(scriptsDir, name), "utf8"),
        )
      )
      .sort();

    expect(builders).toEqual([
      "build-lamp-vfs-image.ts",
      "build-nginx-php-vfs-image.ts",
      "build-nginx-vfs-image.ts",
      "build-node-vfs-image.ts",
      "build-wp-vfs-image.ts",
    ]);
    for (const builder of builders) {
      const source = readFileSync(join(scriptsDir, builder), "utf8");
      expect(source, builder).toContain("saveShellDerivedVfsImage(");
      expect(source, builder).not.toMatch(/\bsaveImage\(/);
    }

    const packageRegistry = join(import.meta.dirname, "../../packages/registry");
    const packageNames = [
      "lamp",
      "nginx-php-vfs",
      "nginx-vfs",
      "node-vfs",
      "wordpress",
    ] as const;
    const shellDerivedRevisions = Object.fromEntries(packageNames.map((name) => {
      const build = readFileSync(join(packageRegistry, name, "build.toml"), "utf8");
      const revision = /^revision\s*=\s*([1-9][0-9]*)$/m.exec(build);
      expect(revision, `${name} revision`).not.toBeNull();
      expect(build, `${name} authored commit`).toMatch(
        /^commit\s*=\s*"UNPUBLISHED"$/m,
      );
      for (const input of [
        "images/vfs/scripts/package-shell-vfs-build.ts",
        "web-libs/kandelo-session/src/demo-config.ts",
      ]) {
        expect(build, `${name} cache input`).toContain(`"${input}"`);
      }
      return [name, Number(revision![1])] as const;
    }));
    expect(shellDerivedRevisions).toEqual({
      lamp: 18,
      "nginx-php-vfs": 8,
      "nginx-vfs": 8,
      "node-vfs": 24,
      wordpress: 19,
    });
  });

  it("rebases a serialized source larger than the downstream capacity", async () => {
    const image = await sourceImage(16 * MiB, 32 * MiB);
    const compressed = new Uint8Array(zstdCompressSync(image));

    expect(() =>
      MemoryFileSystem.fromImage(compressed, { maxByteLength: 8 * MiB }),
    ).toThrow(RangeError);

    const rebased = await loadShellBaseFileSystemFromImage(compressed, 8 * MiB);

    // The image's DECLARED capacity, not the size of a buffer holding it.
    // The old assertions read `sharedBuffer.byteLength`, which enshrined the
    // very behaviour this campaign is removing: an image of capacity X cost X
    // of memory the moment it was loaded. The module sizes the image when it
    // EXPORTS, so capacity is a number the export reads and a loaded image
    // costs what its CONTENTS cost.
    expect(rebased.exportCapacityBytes()).toBe(8 * MiB);
    expectContentsPreserved(rebased);
    expect(rebased.getImageMetadata()).toEqual(
      loadedShellImageMetadata(32 * MiB, compressed),
    );
  });

  it("rebases upward to the downstream image's exact capacity", async () => {
    const image = await sourceImage(4 * MiB, 8 * MiB);

    const rebased = await loadShellBaseFileSystemFromImage(image, 32 * MiB);

    expect(rebased.exportCapacityBytes()).toBe(32 * MiB);
    expectContentsPreserved(rebased);
    expect(rebased.getImageMetadata()).toEqual(
      loadedShellImageMetadata(8 * MiB, image),
    );
  });

  it("preserves the source filesystem when capacities already match", async () => {
    const image = await sourceImage(4 * MiB, 8 * MiB);

    const restored = await loadShellBaseFileSystemFromImage(image, 8 * MiB);

    expect(restored.exportCapacityBytes()).toBe(8 * MiB);
    expectContentsPreserved(restored);
    expect(restored.getImageMetadata()).toEqual(
      loadedShellImageMetadata(8 * MiB, image),
    );
  });

  it("refuses an image the loader rejects before it asks for a capacity", async () => {
    // The ordering half of the test above: a refused image must not reach the
    // capacity request either. That the refusal itself is correct is the
    // module's business and is tested there.
    const valid = await sourceImage(4 * MiB, 8 * MiB);
    const corrupt = valid.slice(0, Math.floor(valid.byteLength / 2));
    const setCapacity = vi.spyOn(SffsImageFs.prototype, "setImageCapacity");
    try {
      await expect(
        loadShellBaseFileSystemFromImage(corrupt, 32 * MiB),
      ).rejects.toThrow();
      expect(setCapacity).not.toHaveBeenCalled();
    } finally {
      setCapacity.mockRestore();
    }
  });

  it("rejects an image that drifts from the standard product capacity", async () => {
    const largerProfile = 1024 * MiB;
    const fs = productFs(largerProfile);
    fs.setImageMetadata(shellImageMetadata(largerProfile));
    fs.mkdir("/etc", 0o755);
    fs.mkdir("/etc/kandelo", 0o755);
    writeFile(fs, DEMO_CONFIG_PATH, SOURCE_DEMO_CONFIG);

    await expect(
      saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst"),
    ).rejects.toThrow(
      new RegExp(
        `${largerProfile}-byte VFS capacity.*` +
          `${SHELL_DERIVED_VFS_PROFILE_MAX_BYTES} bytes are required`,
      ),
    );
  });

  it("rejects an explicit product profile below the standard capacity", () => {
    const smallerProfile = 512 * MiB;
    const fs = productFs(smallerProfile);

    expect(() =>
      saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst", {
        expectedMaxByteLength: smallerProfile,
      })
    ).toThrow(
      new RegExp(
        `must use the standard ${SHELL_DERIVED_VFS_PROFILE_MAX_BYTES}-byte ` +
          "product profile or an explicitly reviewed, strictly larger profile",
      ),
    );
  });

  it("rejects a derived product that has lost the shell metadata it owns", () => {
    const fs = productFs(SHELL_DERIVED_VFS_PROFILE_MAX_BYTES);

    expect(() =>
      saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst")
    ).toThrow(/omits inherited shell image metadata/);
  });

  it("preserves source composition without inventing package authority", async () => {
    const sourceFs = MemoryFileSystem.create(
      new SharedArrayBuffer(4 * MiB, { maxByteLength: 256 * MiB }),
      256 * MiB,
    );
    sourceFs.setImageMetadata({
      version: 1,
      kernelAbi: ABI_VERSION,
      createdBy: "build-source-rootfs-shell-image",
      capacity: { maxByteLength: 256 * MiB },
      shellComposition: SOURCE_ROOTFS_SHELL_COMPOSITION,
    });
    sourceFs.mkdir("/etc", 0o755);
    sourceFs.mkdir("/etc/kandelo", 0o755);
    writeFile(sourceFs, DEMO_CONFIG_PATH, SOURCE_DEMO_CONFIG);
    const sourceImage = await sourceFs.saveImage();
    const fs = await loadShellBaseFileSystemFromImage(
      sourceImage,
      SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    );
    writeFile(fs, "/product.txt", "source-derived product");
    const dir = mkdtempSync(join(tmpdir(), "shell-derived-source-"));
    try {
      const image = await saveShellDerivedVfsImage(
        fs,
        join(dir, "product.vfs.zst"),
      );

      expect(MemoryFileSystem.readImageMetadata(image)).toEqual({
        version: 1,
        kernelAbi: ABI_VERSION,
        createdBy: "images/vfs/scripts/saveShellDerivedVfsImage",
        capacity: {
          maxByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
        },
        baseImage: {
          sha256: sha256Hex(sourceImage),
          bytes: sourceImage.byteLength,
          kernelAbi: ABI_VERSION,
        },
        shellComposition: SOURCE_ROOTFS_SHELL_COMPOSITION,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // GAP 21, pinned rather than papered over. `it.fails` passes while the body
  // throws and turns RED the moment the defect is fixed, so this cannot be
  // forgotten and cannot quietly bless the wrong behaviour.
  //
  // The defect: a standalone URL-backed lazy file loaded from a LEGACY image
  // survives the load with its real size and its deferred flag, and is then
  // re-exported as a zero-length ORDINARY file. `KLZY` carries no fetch
  // description, so the export has nothing to re-emit -- and instead of
  // saying so it writes a stub, which is the same "wrong tree that looks like
  // a right one" as gap 20, reached through the writer instead of the reader.
  //
  // The live tree is NOT affected, which the assertions before the snapshot
  // check; the loss is in the serialized copy.
  it.fails("serializes a transient derived-image build guest without mutating the live image", async () => {
    const image = await sourceImage(4 * MiB, 8 * MiB);
    const fs = await loadShellBaseFileSystemFromImage(image, 8 * MiB);
    const metadataBefore = fs.getImageMetadata();

    const snapshot = await saveShellDerivedBuildGuestSnapshot(fs);

    // Serializing must not disturb the live tree. Asserted through what the
    // tree still SAYS rather than through a list of pending archives, because
    // a snapshot that quietly materialised a deferred file, dropped its
    // metadata, or changed its capacity would show up in exactly these.
    expect(fs.getImageMetadata()).toEqual(metadataBefore);
    expectContentsPreserved(fs);

    // And the snapshot is a loadable image carrying the same tree.
    const restored = SffsImageFs.create();
    restored.loadImage(snapshot);
    expectContentsPreserved(restored);
  });

  it("rejects an unclassified or malformed source shell composition", () => {
    const fs = productFs(SHELL_DERIVED_VFS_PROFILE_MAX_BYTES);
    const metadata = sourceShellImageMetadata(256 * MiB);
    delete metadata.shellComposition;
    fs.setImageMetadata(metadata);

    expect(() =>
      saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst")
    ).toThrow(/omits a supported shell composition binding/);

    fs.setImageMetadata({
      ...metadata,
      shellComposition: { schema: 2, kind: "source-rootfs" },
    });
    expect(() =>
      saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst")
    ).toThrow(/invalid source shell composition binding/);
  });

  it("serializes equivalent derived products reproducibly across wall clocks", async () => {
    const sourceDateEpochSeconds = 946_684_800;
    const canonicalTimestampMs = sourceDateEpochSeconds * 1000;
    const explicitTimestampMs = canonicalTimestampMs + 123_000;
    const priorSourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
    process.env.SOURCE_DATE_EPOCH = String(sourceDateEpochSeconds);

    const buildAt = async (
      runtimeTimestampMs: number,
      normalizeTimestampsMs?: number,
    ): Promise<Uint8Array> => {
      const now = vi.spyOn(Date, "now").mockReturnValue(runtimeTimestampMs);
      const fs = productFs(SHELL_DERIVED_VFS_PROFILE_MAX_BYTES);
      const dir = mkdtempSync(join(tmpdir(), "shell-derived-reproducible-"));
      try {
        fs.setImageMetadata(shellImageMetadata(512 * MiB));
        fs.mkdir("/etc", 0o755);
        fs.mkdir("/etc/kandelo", 0o755);
        writeFile(fs, DEMO_CONFIG_PATH, SOURCE_DEMO_CONFIG);
        writeFile(fs, "/product.txt", "complete product");

        const image = await saveShellDerivedVfsImage(
          fs,
          join(dir, "product.vfs.zst"),
          normalizeTimestampsMs === undefined
            ? {}
            : { normalizeTimestampsMs },
        );
        const restored = MemoryFileSystem.fromImage(image);
        const expectedTimestamp =
          normalizeTimestampsMs ?? canonicalTimestampMs;
        for (const path of [
          "/",
          "/etc",
          "/etc/kandelo",
          DEMO_CONFIG_PATH,
          "/product.txt",
        ]) {
          const stat = restored.lstat(path);
          expect(stat.atimeMs, `${path} atime`).toBe(expectedTimestamp);
          expect(stat.mtimeMs, `${path} mtime`).toBe(expectedTimestamp);
          expect(stat.ctimeMs, `${path} ctime`).toBe(expectedTimestamp);
        }
        return image;
      } finally {
        now.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    };

    try {
      const first = await buildAt(1_700_000_000_000);
      const second = await buildAt(1_800_000_000_000);
      expect(second.byteLength).toBe(first.byteLength);
      expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);

      await buildAt(1_900_000_000_000, explicitTimestampMs);
    } finally {
      if (priorSourceDateEpoch === undefined) {
        delete process.env.SOURCE_DATE_EPOCH;
      } else {
        process.env.SOURCE_DATE_EPOCH = priorSourceDateEpoch;
      }
    }
  });

  const capacityProfiles: Array<[string, number, number | undefined]> = [
    ["the standard profile", SHELL_DERIVED_VFS_PROFILE_MAX_BYTES, undefined],
    ["an explicit larger product profile", 1024 * MiB, 1024 * MiB],
  ];

  it.each(capacityProfiles)("saves %s only under its exact declared capacity", async (
    _label,
    profileMaxBytes,
    expectedMaxByteLength,
  ) => {
    const fs = productFs(profileMaxBytes);
    const inheritedMetadata = shellImageMetadata(512 * MiB);
    fs.setImageMetadata(inheritedMetadata);
    fs.mkdir("/etc", 0o755);
    fs.mkdir("/etc/kandelo", 0o755);
    const derivedDemoConfig =
      `{"version":1,"profiles":{"${_label}":{}}}\n`;
    writeFile(fs, DEMO_CONFIG_PATH, derivedDemoConfig);
    writeFile(fs, "/product.txt", "complete product");
    const dir = mkdtempSync(join(tmpdir(), "shell-derived-capacity-"));
    try {
      const image = await saveShellDerivedVfsImage(
        fs,
        join(dir, "product.vfs.zst"),
        expectedMaxByteLength === undefined ? {} : { expectedMaxByteLength },
      );

      expect(MemoryFileSystem.readImageCapacity(image).maxByteLength).toBe(
        profileMaxBytes,
      );
      expect(MemoryFileSystem.readImageMetadata(image)).toEqual({
        version: 1,
        kernelAbi: ABI_VERSION,
        createdBy: "images/vfs/scripts/saveShellDerivedVfsImage",
        capacity: { maxByteLength: profileMaxBytes },
        baseImage: {
          sha256: "b".repeat(64),
          bytes: 123_456,
          kernelAbi: ABI_VERSION,
        },
        shellComposition: SOURCE_ROOTFS_SHELL_COMPOSITION,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
