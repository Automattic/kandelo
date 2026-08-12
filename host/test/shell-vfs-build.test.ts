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
import {
  addSealedLazyAtomicTestTree,
  forgeLazyAtomicSeal,
} from "./lazy-atomic-seal-fixture";

const MiB = 1024 * 1024;
const O_RDONLY = 0x0000;
const O_WRONLY = 0x0001;
const O_CREAT = 0x0040;
const O_TRUNC = 0x0200;
const DEMO_CONFIG_PATH = "/etc/kandelo/demo.json";
const SHELL_CONFIG_PATH = "/etc/kandelo/shell.json";
const SOURCE_DEMO_CONFIG = '{"version":1,"profiles":{"shell":{}}}\n';
const DERIVED_DEMO_CONFIG = '{"version":1,"profiles":{"node":{}}}\n';
const FLAT_SHELL_CONFIG =
  '{"version":1,"path":"/opt/kandelo/homebrew/bin/bash",' +
  '"argv":["bash","--login"]}\n';

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
    packageDeferredTrees: [
      {
        id: "homebrew-bootstrap/source-tree",
        state: "deferred",
        package: {
          name: "homebrew-bootstrap",
          output: "homebrew-bootstrap.zip",
        },
      },
    ],
    homebrewBootstrap: {
      entrypoint: "/usr/bin/brew",
      prefix: "/opt/kandelo/homebrew",
    },
    homebrew: {
      tapRepository: "Kandelo-dev/homebrew-tap-core",
      tapName: "Kandelo-dev/tap-core",
      tapCommit: "a".repeat(40),
      demoConfig: {
        path: DEMO_CONFIG_PATH,
        sha256: sha256Hex(SOURCE_DEMO_CONFIG),
        bytes: new TextEncoder().encode(SOURCE_DEMO_CONFIG).byteLength,
      },
    },
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

function flatShellImageMetadata(maxByteLength: number): VfsImageMetadata {
  return {
    version: 1,
    kernelAbi: ABI_VERSION,
    createdBy: "build-homebrew-flat-vfs-image",
    capacity: { maxByteLength },
    baseImage: {
      sha256: "d".repeat(64),
      bytes: 345_678,
      kernelAbi: ABI_VERSION,
    },
    homebrewFlat: {
      selectionSha256: "e".repeat(64),
      requestedVfsFilename: "shell.vfs.zst",
      resourcePolicy: "kandelo-homebrew-vfs-main-shell-v1",
    },
    shellConfig: {
      path: "/opt/kandelo/homebrew/bin/bash",
      argv: ["bash", "--login"],
      sha256: sha256Hex(FLAT_SHELL_CONFIG),
      bytes: new TextEncoder().encode(FLAT_SHELL_CONFIG).byteLength,
    },
    demoConfig: {
      path: DEMO_CONFIG_PATH,
      sha256: sha256Hex(SOURCE_DEMO_CONFIG),
      bytes: new TextEncoder().encode(SOURCE_DEMO_CONFIG).byteLength,
    },
    sourceAttestation: { mustNotBeRelabeledAsDerived: true },
  };
}

function flatLazyShellImageMetadata(maxByteLength: number): VfsImageMetadata {
  return {
    version: 1,
    kernelAbi: ABI_VERSION,
    createdBy: "homebrew-flat-lazy-vfs-composer.test/source",
    capacity: { maxByteLength },
    baseImage: {
      sha256: "f".repeat(64),
      bytes: 456_789,
      kernelAbi: ABI_VERSION,
    },
    packageDeferredTrees: [{
      schema: 1,
      kind: "kandelo-package-deferred-zip-tree",
      id: "homebrew-bootstrap/source-tree",
      state: "deferred",
      package: {
        name: "homebrew-bootstrap",
        output: "homebrew-bootstrap.zip",
      },
    }],
    homebrewBootstrap: {
      environment: {
        path: "/etc/homebrew/brew.env",
        sha256: "1".repeat(64),
        bytes: 210,
      },
      entrypoint: {
        path: "/usr/bin/brew",
        target: "/opt/kandelo/homebrew/bin/brew",
      },
      ownership: {
        prefix: "/opt/kandelo/homebrew",
        uid: 1000,
        gid: 1000,
        mutable_paths: ["/opt/kandelo/homebrew/Cellar"],
      },
    },
    homebrewFlatLazy: {
      schema: 1,
      kind: "kandelo-homebrew-flat-selection-lazy-v1",
      selection: {
        sha256: "2".repeat(64),
        name: "main-shell-abi42-wasm32",
        arch: "wasm32",
        kandeloAbi: ABI_VERSION,
        requestedVfsFilename: "shell.vfs.zst",
        resourcePolicy: "kandelo-homebrew-vfs-main-shell-v1",
        linkPolicy: "kandelo-homebrew-link-ownership-v1",
        runtimeSupport: "kandelo-homebrew-bootstrap-v1",
      },
      materializationPolicySha256: "3".repeat(64),
      runtimeSupportPolicySha256: "4".repeat(64),
      mirror: {
        repository: "kandelo-dev/homebrew-tap-core",
        tag: `homebrew-shell-bottles-sha256-${"5".repeat(64)}`,
        collectionSha256: "5".repeat(64),
        planSha256: "6".repeat(64),
        planBytes: 19_901,
        assetCount: 37,
      },
      partition: {
        embeddedPackageOrder: ["libcxx", "ncurses", "bash"],
        deferredPackageOrder: [
          "libyaml",
          "ruby",
          ...Array.from({ length: 35 }, (_, index) => `ordinary-${index}`),
        ],
        bootstrapPackage: "kandelo-dev/tap-core/homebrew-bootstrap",
        runtimeCohortPackageOrder: ["libyaml", "ruby"],
      },
    },
    shellConfig: {
      path: "/opt/kandelo/homebrew/bin/bash",
      argv: ["bash", "--login"],
      sha256: sha256Hex(FLAT_SHELL_CONFIG),
      bytes: new TextEncoder().encode(FLAT_SHELL_CONFIG).byteLength,
    },
    demoConfig: {
      path: DEMO_CONFIG_PATH,
      sha256: sha256Hex(SOURCE_DEMO_CONFIG),
      bytes: new TextEncoder().encode(SOURCE_DEMO_CONFIG).byteLength,
    },
  };
}

async function flatLazySourceImage(maxByteLength: number): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(16 * MiB, { maxByteLength }),
    maxByteLength,
  );
  fs.mkdir("/etc", 0o755);
  fs.mkdir("/etc/kandelo", 0o755);
  writeFile(fs, SHELL_CONFIG_PATH, FLAT_SHELL_CONFIG);
  writeFile(fs, DEMO_CONFIG_PATH, SOURCE_DEMO_CONFIG);
  await addSealedLazyAtomicTestTree(fs, {
    groupId: "homebrew-runtime-support",
    member: "bootstrap",
    root: "/opt/kandelo/homebrew/bootstrap",
  });
  fs.registerLazyTree(
    {
      decoder: "zip-v1",
      mediaType: "application/zip",
      sha256: "7".repeat(64),
      bytes: 7,
      expandedBytes: 11,
      sourceEntryCount: 1,
      transports: ["https://example.invalid/ordinary.zip"],
    },
    [{
      vfsPath: "/opt/kandelo/homebrew/ordinary/tool",
      sourcePath: "tool",
      type: "file",
      mode: 0o755,
      size: 11,
      inodeGroup: "ordinary:tool",
    }],
    "/opt/kandelo/homebrew/ordinary",
    {
      mode: "first-use",
      capabilities: ["homebrew-bottle:ordinary-0"],
      roots: ["/opt/kandelo/homebrew/ordinary/tool"],
    },
    { uid: 0, gid: 0 },
  );
  return fs.saveImage({ metadata: flatLazyShellImageMetadata(maxByteLength) });
}

function prepareFlatShellFileSystem(
  maxByteLength = SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
): MemoryFileSystem {
  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(16 * MiB, { maxByteLength }),
    maxByteLength,
  );
  fs.setImageMetadata(flatShellImageMetadata(512 * MiB));
  fs.mkdir("/etc", 0o755);
  fs.mkdir("/etc/kandelo", 0o755);
  writeFile(fs, SHELL_CONFIG_PATH, FLAT_SHELL_CONFIG);
  writeFile(fs, DEMO_CONFIG_PATH, SOURCE_DEMO_CONFIG);
  return fs;
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

async function sourceImage(
  byteLength: number,
  maxByteLength: number,
  sealedAtomicTree = false,
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
  fs.registerLazyArchiveFromEntries(
    "https://example.invalid/demo.zip",
    [lazyArchiveEntry()],
    "/",
  );
  if (sealedAtomicTree) {
    await addSealedLazyAtomicTestTree(fs, {
      groupId: "test:shell-base",
      member: "shell-runtime",
      root: "/sealed-shell-base",
    });
  }
  return fs.saveImage({
    metadata: shellImageMetadata(maxByteLength),
  });
}

function expectContentsPreserved(fs: MemoryFileSystem): void {
  expect(readFile(fs, "/ordinary.txt")).toBe("preserved contents");
  expect(fs.stat("/bin/lazy-tool").size).toBe(123_456);
  expect(fs.stat("/bin/lazy-tool").mode & 0o777).toBe(0o755);
  expect(fs.exportLazyEntries()).toMatchObject([
    {
      path: "/bin/lazy-tool",
      url: "https://example.invalid/lazy-tool.wasm",
      size: 123_456,
    },
  ]);
  expect(fs.stat("/usr/share/demo/archive.txt").size).toBe(4096);
  expect(
    fs.exportLazyArchiveEntries().filter(
      (entry) => entry.url === "https://example.invalid/demo.zip",
    ),
  ).toMatchObject([
    {
      url: "https://example.invalid/demo.zip",
      mountPrefix: "/",
      materialized: false,
    },
  ]);
}

describe("shell VFS base composition", () => {
  it.each(["member", "cohort"] as const)(
    "rejects a forged imported %s seal before shell build side effects",
    async (forgery) => {
      const source = MemoryFileSystem.create(new SharedArrayBuffer(8 * MiB));
      await addSealedLazyAtomicTestTree(source, {
        groupId: "test:shell-rootfs",
        member: "rootfs",
        root: "/shell-rootfs",
      });
      const resolveArtifact = vi.fn();
      const register = vi.fn();
      const save = vi.fn();

      const image = forgeLazyAtomicSeal(await source.saveImage(), forgery);
      const build = async () => {
        await restoreTrustedShellRootfs(image, 8 * MiB);
        resolveArtifact();
        register();
        save();
      };
      await expect(build()).rejects.toThrow(/seal/);
      expect(resolveArtifact).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

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
      const fs = MemoryFileSystem.create(
        new SharedArrayBuffer(4 * MiB, { maxByteLength: 16 * MiB }),
        16 * MiB,
      );
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
        "images/vfs/scripts/shell-vfs-build.ts",
        "web-libs/kandelo-session/src/demo-config.ts",
        "web-libs/kandelo-session/src/shell-config.ts",
      ]) {
        expect(build, `${name} cache input`).toContain(`"${input}"`);
      }
      return [name, Number(revision![1])] as const;
    }));
    expect(shellDerivedRevisions).toEqual({
      lamp: 13,
      "nginx-php-vfs": 4,
      "nginx-vfs": 4,
      "node-vfs": 17,
      wordpress: 14,
    });
  });

  it("rebases a serialized source larger than the downstream capacity", async () => {
    const image = await sourceImage(16 * MiB, 32 * MiB, true);
    const compressed = new Uint8Array(zstdCompressSync(image));

    expect(() =>
      MemoryFileSystem.fromImage(compressed, { maxByteLength: 8 * MiB }),
    ).toThrow(RangeError);

    const rebased = await loadShellBaseFileSystemFromImage(compressed, 8 * MiB);

    expect(rebased.sharedBuffer.byteLength).toBe(8 * MiB);
    expect(rebased.sharedBuffer.maxByteLength).toBe(8 * MiB);
    const stats = rebased.statfs("/");
    expect(stats.blocks * stats.bsize).toBe(8 * MiB);
    expectContentsPreserved(rebased);
    expect(rebased.getImageMetadata()).toEqual(
      loadedShellImageMetadata(32 * MiB, compressed),
    );
  });

  it("rebases upward to the downstream image's exact capacity", async () => {
    const image = await sourceImage(4 * MiB, 8 * MiB, true);

    const rebased = await loadShellBaseFileSystemFromImage(image, 32 * MiB);

    expect(rebased.sharedBuffer.maxByteLength).toBe(32 * MiB);
    const stats = rebased.statfs("/");
    expect(stats.blocks * stats.bsize).toBe(32 * MiB);
    expectContentsPreserved(rebased);
    expect(rebased.getImageMetadata()).toEqual(
      loadedShellImageMetadata(8 * MiB, image),
    );
  });

  it("preserves the source filesystem when capacities already match", async () => {
    const image = await sourceImage(4 * MiB, 8 * MiB, true);

    const restored = await loadShellBaseFileSystemFromImage(image, 8 * MiB);

    expect(restored.sharedBuffer.byteLength).toBe(4 * MiB);
    expect(restored.sharedBuffer.maxByteLength).toBe(8 * MiB);
    expectContentsPreserved(restored);
    expect(restored.getImageMetadata()).toEqual(
      loadedShellImageMetadata(8 * MiB, image),
    );
  });

  it.each([
    ["member", /activation member .* changed after sealing/],
    ["cohort", /activation group .* differs from its seal/],
  ] as const)(
    "rejects a forged imported %s seal before capacity rebasing",
    async (forgery, expected) => {
      const valid = await sourceImage(4 * MiB, 8 * MiB, true);
      const forged = forgeLazyAtomicSeal(valid, forgery);
      const rebase = vi.spyOn(
        MemoryFileSystem.prototype,
        "rebaseToNewFileSystem",
      );
      try {
        await expect(
          loadShellBaseFileSystemFromImage(forged, 32 * MiB),
        ).rejects.toThrow(expected);
        expect(rebase).not.toHaveBeenCalled();
      } finally {
        rebase.mockRestore();
      }
    },
  );

  it("rejects an image that drifts from the standard product capacity", async () => {
    const largerProfile = 1024 * MiB;
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(16 * MiB, { maxByteLength: largerProfile }),
      largerProfile,
    );
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
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(16 * MiB, { maxByteLength: smallerProfile }),
      smallerProfile,
    );

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
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(16 * MiB, {
        maxByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
      }),
      SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    );

    expect(() =>
      saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst")
    ).toThrow(/omits inherited shell image metadata/);
  });

  it("preserves source composition without inventing Homebrew authority", async () => {
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

  it("preserves flat shell lineage while rebinding the derived demo bytes", async () => {
    const sourceFs = prepareFlatShellFileSystem(512 * MiB);
    const sourceImage = await sourceFs.saveImage({
      metadata: flatShellImageMetadata(512 * MiB),
    });
    const fs = await loadShellBaseFileSystemFromImage(
      sourceImage,
      SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    );
    writeFile(fs, DEMO_CONFIG_PATH, DERIVED_DEMO_CONFIG);
    const directory = mkdtempSync(join(tmpdir(), "shell-derived-flat-"));
    try {
      const image = await saveShellDerivedVfsImage(
        fs,
        join(directory, "node.vfs.zst"),
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
        homebrewFlat: flatShellImageMetadata(512 * MiB).homebrewFlat,
        shellConfig: flatShellImageMetadata(512 * MiB).shellConfig,
        demoConfig: {
          path: DEMO_CONFIG_PATH,
          sha256: sha256Hex(DERIVED_DEMO_CONFIG),
          bytes: new TextEncoder().encode(DERIVED_DEMO_CONFIG).byteLength,
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves flat-lazy metadata, pending transports, and seals without fetching", async () => {
    const sourceImage = await flatLazySourceImage(32 * MiB);
    const fs = await loadShellBaseFileSystemFromImage(
      sourceImage,
      SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    );
    const fetcher = vi.fn(async () => {
      throw new Error("derived image construction must not fetch lazy trees");
    });
    fs.setLazyFetcher(fetcher);
    const pendingBefore = fs.exportLazyArchiveEntries();
    const usageBefore = fs.pendingDeferredTreeUsage();
    const inherited = fs.getImageMetadata()!;
    writeFile(fs, DEMO_CONFIG_PATH, DERIVED_DEMO_CONFIG);
    const directory = mkdtempSync(join(tmpdir(), "shell-derived-flat-lazy-"));
    try {
      const image = await saveShellDerivedVfsImage(
        fs,
        join(directory, "node.vfs.zst"),
      );
      expect(fetcher).not.toHaveBeenCalled();

      const restored = MemoryFileSystem.fromImagePreservingCapacity(image);
      await restored.verifyImportedLazyAtomicGroupSeals();
      expect(restored.exportLazyArchiveEntries()).toEqual(pendingBefore);
      expect(restored.pendingDeferredTreeUsage()).toEqual(usageBefore);
      expect(restored.sharedBuffer.maxByteLength).toBe(
        SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
      );
      expect(MemoryFileSystem.readImageMetadata(image)).toEqual({
        version: 1,
        kernelAbi: ABI_VERSION,
        createdBy: "images/vfs/scripts/saveShellDerivedVfsImage",
        capacity: { maxByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES },
        baseImage: {
          sha256: sha256Hex(sourceImage),
          bytes: sourceImage.byteLength,
          kernelAbi: ABI_VERSION,
        },
        packageDeferredTrees: inherited.packageDeferredTrees,
        homebrewBootstrap: inherited.homebrewBootstrap,
        homebrewFlatLazy: inherited.homebrewFlatLazy,
        shellConfig: inherited.shellConfig,
        demoConfig: {
          path: DEMO_CONFIG_PATH,
          sha256: sha256Hex(DERIVED_DEMO_CONFIG),
          bytes: new TextEncoder().encode(DERIVED_DEMO_CONFIG).byteLength,
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("suppresses flat-lazy boot only in a transient derived-image build guest", async () => {
    const sourceImage = await flatLazySourceImage(32 * MiB);
    const fs = await loadShellBaseFileSystemFromImage(sourceImage, 32 * MiB);
    const metadataBefore = fs.getImageMetadata();
    const pendingBefore = fs.exportLazyArchiveEntries();

    const snapshot = await saveShellDerivedBuildGuestSnapshot(fs);

    expect(fs.getImageMetadata()).toEqual(metadataBefore);
    expect(fs.exportLazyArchiveEntries()).toEqual(pendingBefore);
    expect(MemoryFileSystem.readImageMetadata(snapshot)).toEqual(
      expect.not.objectContaining({ homebrewFlatLazy: expect.anything() }),
    );
    const restored = MemoryFileSystem.fromImagePreservingCapacity(snapshot);
    await restored.verifyImportedLazyAtomicGroupSeals();
    expect(restored.exportLazyArchiveEntries()).toEqual(pendingBefore);
  });

  it.each([
    ["homebrewFlat", /omits valid flat Homebrew selection binding/],
    ["shellConfig", /omits valid flat shell config binding/],
    ["demoConfig", /omits valid flat demo config binding/],
  ] as const)("rejects a flat shell missing its %s binding", (field, error) => {
    const fs = prepareFlatShellFileSystem();
    const metadata = flatShellImageMetadata(512 * MiB);
    delete metadata[field];
    fs.setImageMetadata(metadata);

    expect(() => saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst"))
      .toThrow(error);
  });

  it("rejects flat shell metadata whose shell-config digest no longer matches", () => {
    const fs = prepareFlatShellFileSystem();
    writeFile(
      fs,
      SHELL_CONFIG_PATH,
      FLAT_SHELL_CONFIG.replace("--login", "-l"),
    );

    expect(() => saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst"))
      .toThrow(/flat shell config binding does not match/);
  });

  it("rejects a malformed flat demo binding", () => {
    const fs = prepareFlatShellFileSystem();
    const metadata = flatShellImageMetadata(512 * MiB);
    metadata.demoConfig = {
      ...(metadata.demoConfig as Record<string, unknown>),
      path: "/etc/kandelo/other.json",
    };
    fs.setImageMetadata(metadata);

    expect(() => saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst"))
      .toThrow(/invalid flat demo config binding/);
  });

  it("rejects flat shell lineage mixed with legacy lazy Homebrew claims", () => {
    const fs = prepareFlatShellFileSystem();
    fs.setImageMetadata({
      ...flatShellImageMetadata(512 * MiB),
      packageDeferredTrees: [],
    });

    expect(() => saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst"))
      .toThrow(/mixes flat and legacy Homebrew composition bindings/);
  });

  it("rejects an unclassified or malformed source shell composition", () => {
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(16 * MiB, {
        maxByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
      }),
      SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
    );
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

  it.each([
    ["package tree", { packageDeferredTrees: [] }],
    ["bootstrap", { homebrewBootstrap: {} }],
    ["composition", { homebrew: {} }],
  ] as const)(
    "rejects a source shell that smuggles a Homebrew %s claim",
    (_label, claim) => {
      const fs = MemoryFileSystem.create(
        new SharedArrayBuffer(16 * MiB, {
          maxByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
        }),
        SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
      );
      fs.setImageMetadata({
        ...sourceShellImageMetadata(256 * MiB),
        ...claim,
      });

      expect(() =>
        saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst")
      ).toThrow(/mixes source and Homebrew composition bindings/);
    },
  );

  it.each([
    ["packageDeferredTrees", /omits inherited package tree bindings/],
    ["homebrewBootstrap", /omits valid Homebrew bootstrap ownership/],
    ["homebrew", /omits valid Homebrew composition metadata/],
  ] as const)(
    "rejects a Homebrew shell missing its %s binding",
    (field, error) => {
      const fs = MemoryFileSystem.create(
        new SharedArrayBuffer(16 * MiB, {
          maxByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
        }),
        SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
      );
      const metadata = shellImageMetadata(512 * MiB);
      delete metadata[field];
      fs.setImageMetadata(metadata);
      fs.mkdir("/etc", 0o755);
      fs.mkdir("/etc/kandelo", 0o755);
      writeFile(fs, DEMO_CONFIG_PATH, SOURCE_DEMO_CONFIG);

      expect(() =>
        saveShellDerivedVfsImage(fs, "/tmp/not-written.vfs.zst")
      ).toThrow(error);
    },
  );

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
      const fs = MemoryFileSystem.create(
        new SharedArrayBuffer(16 * MiB, {
          maxByteLength: SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
        }),
        SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
      );
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
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(16 * MiB, { maxByteLength: profileMaxBytes }),
      profileMaxBytes,
    );
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
        packageDeferredTrees: inheritedMetadata.packageDeferredTrees,
        homebrewBootstrap: inheritedMetadata.homebrewBootstrap,
        homebrew: {
          ...(inheritedMetadata.homebrew as Record<string, unknown>),
          demoConfig: {
            path: DEMO_CONFIG_PATH,
            sha256: sha256Hex(derivedDemoConfig),
            bytes: new TextEncoder().encode(derivedDemoConfig).byteLength,
          },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
