import { zipSync, type Zippable } from "fflate";
import { describe, expect, it, vi } from "vitest";

import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
  materializePackageDeferredZipTree,
  parsePackageDeferredZipTreeDescriptor,
  parsePackageDeferredZipTreeSpec,
  registerPackageDeferredZipTree,
  type PackageDeferredZipTreeSpec,
} from "../src/vfs/package-deferred-tree";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { EIO, SFSError } from "../src/vfs/sharedfs-vendor";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const SPEC = {
  schema: 1,
  kind: "kandelo-package-deferred-zip-tree",
  id: "shell/pkg-bootstrap",
  content_role: "source-tree",
  package: {
    name: "shell",
    output: "pkg-bootstrap.zip",
  },
  archive: {
    url: "pkg-bootstrap.zip",
    mode_policy: "portable-posix-v1",
  },
  mount_prefix: "/opt/kandelo/pkg",
  owner: {
    uid: 1000,
    gid: 1000,
  },
  activation: {
    mode: "first-use",
    capabilities: ["pkg:bootstrap"],
    roots: ["/opt/kandelo/pkg/bin/brew"],
  },
} as const satisfies PackageDeferredZipTreeSpec;

describe("package deferred ZIP trees", () => {
  it("derives one canonical descriptor from the exact package output", () => {
    const archive = packageArchive();
    const first = derivePackageDeferredZipTree(SPEC, archive);
    const second = derivePackageDeferredZipTree(
      structuredClone(SPEC),
      new Uint8Array(archive),
    );

    expect(second.descriptor).toEqual(first.descriptor);
    expect(second.descriptorBytes).toEqual(first.descriptorBytes);
    expect(second.descriptorSha256).toBe(first.descriptorSha256);
    expect(first.descriptor.archive).toMatchObject({
      decoder: "zip-v1",
      media_type: "application/zip",
      bytes: archive.byteLength,
      source_entry_count: 6,
    });
    expect(first.content.modePolicy).toBe("portable-posix-v1");
    expect(first.descriptor.inventory).toEqual([
      expect.objectContaining({
        vfs_path: "/opt/kandelo/pkg/bin",
        type: "directory",
        mode: 0o755,
      }),
      expect.objectContaining({
        vfs_path: "/opt/kandelo/pkg/bin/brew",
        type: "file",
        mode: 0o755,
        size: 12,
      }),
      expect.objectContaining({
        vfs_path: "/opt/kandelo/pkg/bin/brew-link",
        type: "symlink",
        mode: 0o777,
        target: "brew",
      }),
      expect.objectContaining({
        vfs_path: "/opt/kandelo/pkg/Library",
        type: "directory",
      }),
      expect.objectContaining({
        vfs_path: "/opt/kandelo/pkg/Library/PkgLib",
        type: "directory",
      }),
      expect.objectContaining({
        vfs_path: "/opt/kandelo/pkg/Library/PkgLib/global.rb",
        type: "file",
        mode: 0o644,
      }),
    ]);
    expect(decoder.decode(first.descriptorBytes).endsWith("\n")).toBe(true);
  });

  it("restores a lazy tree from authenticated descriptor bytes without archive bytes", () => {
    const archive = packageArchive();
    const produced = derivePackageDeferredZipTree(SPEC, archive);
    const immutableReference =
      `https://artifacts.example.test/pkg-bootstrap.zip?sha256=${produced.content.sha256}`;
    const restored = parsePackageDeferredZipTreeDescriptor(
      structuredClone(produced.descriptor),
      {
        archive: {
          bytes: archive.byteLength,
          reference: immutableReference,
          sha256: produced.content.sha256,
        },
        id: SPEC.id,
        package: SPEC.package,
      },
    );

    expect(restored.descriptor).toEqual(produced.descriptor);
    expect(restored.descriptorSha256).toBe(produced.descriptorSha256);
    expect(restored.content).toEqual({
      ...produced.content,
      transports: [immutableReference],
    });
    expect(restored.entries).toEqual(produced.entries);

    const fs = packageFs();
    registerPackageDeferredZipTree(fs, restored);
    expect(fs.isPathDeferred(`${SPEC.mount_prefix}/bin/brew`)).toBe(true);
  });

  it("rejects package descriptors that drift from their exact archive input", () => {
    const archive = packageArchive();
    const produced = derivePackageDeferredZipTree(SPEC, archive);
    const expected = {
      archive: {
        bytes: archive.byteLength,
        reference:
          `https://artifacts.example.test/pkg-bootstrap.zip?sha256=${produced.content.sha256}`,
        sha256: produced.content.sha256,
      },
      id: SPEC.id,
      package: SPEC.package,
    };
    const tampered = structuredClone(produced.descriptor);
    tampered.inventory[1]!.vfs_path = "/outside/brew";

    expect(() => parsePackageDeferredZipTreeDescriptor(tampered, expected)).toThrow(
      /inventory|mount|descriptor/i,
    );
    expect(() => parsePackageDeferredZipTreeDescriptor(
      produced.descriptor,
      {
        ...expected,
        archive: { ...expected.archive, sha256: "f".repeat(64) },
      },
    )).toThrow(/archive identity/i);
  });

  it("preserves producer-assigned atomic membership through registration", async () => {
    const archive = packageArchive();
    const spec = structuredClone(SPEC) as unknown as Record<string, any>;
    spec.activation.atomic_group = "pkg-runtime-support";
    const derived = derivePackageDeferredZipTree(spec, archive);
    expect(derived.descriptor.activation.atomicGroup).toEqual({
      id: "pkg-runtime-support",
      member: SPEC.id,
    });
    const fs = packageFs();
    registerPackageDeferredZipTree(fs, derived);
    await fs.sealLazyAtomicGroup("pkg-runtime-support", [SPEC.id]);

    expect(fs.exportLazyArchiveEntries()[0]).toMatchObject({
      kind: "kandelo-deferred-tree-v3",
      activation: {
        atomicGroup: {
          id: "pkg-runtime-support",
          member: SPEC.id,
          expectedCount: 1,
        },
      },
    });
    assertPackageDeferredZipTreeState(fs, derived, "deferred");
  });

  it("fetches one whole group on first use and never refetches it", async () => {
    const archive = packageArchive();
    const derived = derivePackageDeferredZipTree(SPEC, archive);
    const fs = packageFs();
    registerPackageDeferredZipTree(fs, derived);
    assertPackageDeferredZipTreeState(fs, derived, "deferred");
    for (const entry of derived.entries) {
      expect(fs.lstat(entry.vfsPath)).toMatchObject({ uid: 1000, gid: 1000 });
    }
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toBe("pkg-bootstrap.zip");
      return new Response(archive, {
        headers: { "content-length": String(archive.byteLength) },
      });
    });
    fs.setLazyFetcher(fetcher);

    expect(fs.lstat(`${SPEC.mount_prefix}/bin/brew`)).toMatchObject({
      mode: expect.any(Number),
      uid: 1000,
      gid: 1000,
      size: 12,
    });
    expect(fs.stat(`${SPEC.mount_prefix}/bin/brew`).size).toBe(12);
    expect(fs.isPathDeferred(`${SPEC.mount_prefix}/bin/brew`)).toBe(true);
    const directory = fs.opendir(`${SPEC.mount_prefix}/Library/PkgLib`);
    try {
      expect(fs.readdir(directory)).toBeTruthy();
    } finally {
      fs.closedir(directory);
    }
    expect(fetcher).not.toHaveBeenCalled();

    await expect(fs.preparePath(`${SPEC.mount_prefix}/bin/brew`)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readFile(fs, `${SPEC.mount_prefix}/bin/brew`)).toBe("#!/bin/brew\n");
    expect(readFile(fs, `${SPEC.mount_prefix}/Library/PkgLib/global.rb`)).toBe(
      "GLOBAL = true\n",
    );
    expect(fs.readlink(`${SPEC.mount_prefix}/bin/brew-link`)).toBe("brew");
    expect(fs.isPathDeferred(`${SPEC.mount_prefix}/bin/brew`)).toBe(false);
    assertPackageDeferredZipTreeState(fs, derived, "materialized");

    await expect(
      fs.preparePath(`${SPEC.mount_prefix}/Library/PkgLib/global.rb`),
    ).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("preserves guest-external symlink text without following it", () => {
    const archive = packageArchive("../../../../usr/bin/env");
    const derived = derivePackageDeferredZipTree(SPEC, archive);
    const fs = packageFs();
    fs.mkdir("/usr", 0o755);
    fs.mkdir("/usr/bin", 0o755);
    fs.createFileWithOwner(
      "/usr/bin/env",
      0o755,
      0,
      0,
      encoder.encode("base image\n"),
    );

    registerPackageDeferredZipTree(fs, derived);

    expect(fs.readlink(`${SPEC.mount_prefix}/bin/brew-link`)).toBe(
      "../../../../usr/bin/env",
    );
    expect(readFile(fs, `${SPEC.mount_prefix}/bin/brew-link`)).toBe(
      "base image\n",
    );
    expect(readFile(fs, "/usr/bin/env")).toBe("base image\n");
    expect(fs.lstat("/usr/bin/env")).toMatchObject({ uid: 0, gid: 0 });
  });

  it("keeps every member deferred after a failed fetch and coalesces the retry", async () => {
    const archive = packageArchive();
    const derived = derivePackageDeferredZipTree(SPEC, archive);
    const fs = packageFs();
    registerPackageDeferredZipTree(fs, derived);
    const wrong = new Uint8Array(archive);
    wrong[0] ^= 1;
    let served = wrong;
    const fetcher = vi.fn(async () => new Response(served, {
      headers: { "content-length": String(served.byteLength) },
    }));
    fs.setLazyFetcher(fetcher);

    await expect(Promise.all([
      fs.preparePath(`${SPEC.mount_prefix}/bin/brew`),
      fs.preparePath(`${SPEC.mount_prefix}/Library/PkgLib/global.rb`),
    ])).rejects.toThrow(/SHA-256/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    assertPackageDeferredZipTreeState(fs, derived, "deferred");
    expect(fs.isPathDeferred(`${SPEC.mount_prefix}/bin/brew`)).toBe(true);
    expect(fs.isPathDeferred(
      `${SPEC.mount_prefix}/Library/PkgLib/global.rb`,
    )).toBe(true);

    served = archive;
    await expect(Promise.all([
      fs.preparePath(`${SPEC.mount_prefix}/bin/brew`),
      fs.preparePath(`${SPEC.mount_prefix}/Library/PkgLib/global.rb`),
    ])).resolves.toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    assertPackageDeferredZipTreeState(fs, derived, "materialized");
  });

  it("pre-materializes the identical descriptor without using transport", async () => {
    const archive = packageArchive();
    const lazy = derivePackageDeferredZipTree(SPEC, archive);
    const eager = derivePackageDeferredZipTree(SPEC, archive);
    const fs = packageFs();
    const registered = registerPackageDeferredZipTree(fs, eager);
    await materializePackageDeferredZipTree(fs, registered, archive);
    const fetcher = vi.fn(async () => {
      throw new Error("eager package tree must not fetch");
    });
    fs.setLazyFetcher(fetcher);

    expect(eager.descriptorSha256).toBe(lazy.descriptorSha256);
    expect(eager.descriptorBytes).toEqual(lazy.descriptorBytes);
    expect(fs.exportLazyArchiveEntries()).toEqual([]);
    expect(fs.isPathDeferred(`${SPEC.mount_prefix}/bin/brew`)).toBe(false);
    expect(readFile(fs, `${SPEC.mount_prefix}/bin/brew`)).toBe("#!/bin/brew\n");
    assertPackageDeferredZipTreeState(fs, eager, "materialized");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed on invalid recipes, incomplete archives, and collisions", () => {
    expect(() => parsePackageDeferredZipTreeSpec({
      ...SPEC,
      unexpected: true,
    })).toThrow(/unsupported fields/);
    expect(() => parsePackageDeferredZipTreeSpec({
      ...SPEC,
      activation: { ...SPEC.activation, roots: ["/outside"] },
    })).toThrow(/escapes its mount/);
    expect(() => parsePackageDeferredZipTreeSpec({
      ...SPEC,
      owner: { uid: 0xffff_ffff, gid: 1000 },
    })).toThrow(/spec is invalid/);

    const incomplete = zipSync({
      "missing/parent/file": encoder.encode("bad"),
    });
    expect(() => derivePackageDeferredZipTree(SPEC, incomplete)).toThrow(
      /omits directory entry/,
    );

    const archive = packageArchive();
    const derived = derivePackageDeferredZipTree(SPEC, archive);
    expect(() => packageFs().registerLazyTree(
      { ...derived.content, modePolicy: "host-mode" } as unknown as typeof derived.content,
      derived.entries,
      SPEC.mount_prefix,
      SPEC.activation,
    )).toThrow(/mode policy is invalid/);
    const fs = packageFs();
    fs.mkdir(`${SPEC.mount_prefix}/bin`, 0o700);
    fs.chown(`${SPEC.mount_prefix}/bin`, 1000, 1000);
    expect(() => registerPackageDeferredZipTree(fs, derived)).toThrow(
      /collides with the base/,
    );

    const blockedFs = MemoryFileSystem.create(
      new SharedArrayBuffer(32 * 1024 * 1024),
    );
    blockedFs.symlink("elsewhere", "/blocked");
    const blockedSpec = {
      ...SPEC,
      mount_prefix: "/blocked/tree",
      activation: {
        ...SPEC.activation,
        roots: ["/blocked/tree/bin/brew"],
      },
    } satisfies PackageDeferredZipTreeSpec;
    expect(() => registerPackageDeferredZipTree(
      blockedFs,
      derivePackageDeferredZipTree(blockedSpec, archive),
    )).toThrow(/ancestor collides/);
  });

  it("publishes no deferred metadata before package ownership succeeds", () => {
    const archive = packageArchive();
    const derived = derivePackageDeferredZipTree(SPEC, archive);
    const fs = packageFs();
    const lchown = vi.spyOn(fs, "lchown").mockImplementationOnce(() => {
      throw new SFSError(EIO);
    });

    expect(() => registerPackageDeferredZipTree(fs, derived)).toThrow(SFSError);

    lchown.mockRestore();
    expect(fs.exportLazyArchiveEntries()).toEqual([]);
    expect(fs.isPathDeferred(`${SPEC.mount_prefix}/bin/brew`)).toBe(false);
  });

  it("rejects changed bytes before direct materialization", async () => {
    const archive = packageArchive();
    const derived = derivePackageDeferredZipTree(SPEC, archive);
    const fs = packageFs();
    const registered = registerPackageDeferredZipTree(fs, derived);
    const changed = new Uint8Array(archive);
    changed[0] ^= 1;
    await expect(
      materializePackageDeferredZipTree(fs, registered, changed),
    ).rejects.toThrow(/changed identity/);
    expect(fs.isPathDeferred(`${SPEC.mount_prefix}/bin/brew`)).toBe(true);
  });

  it("propagates namespace lookup errors instead of treating them as absence", () => {
    const archive = packageArchive();
    const derived = derivePackageDeferredZipTree(SPEC, archive);
    const fs = packageFs();
    const originalLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, "lstat").mockImplementation((path) => {
      if (path === `${SPEC.mount_prefix}/bin`) throw new SFSError(EIO);
      return originalLstat(path);
    });
    let caught: unknown;
    try {
      registerPackageDeferredZipTree(fs, derived);
    } catch (error) {
      caught = error;
    } finally {
      lstat.mockRestore();
    }
    expect(caught).toBeInstanceOf(SFSError);
    expect((caught as SFSError).code).toBe(EIO);
    expect(fs.exportLazyArchiveEntries()).toEqual([]);
    expect(fs.isPathDeferred(`${SPEC.mount_prefix}/bin/brew`)).toBe(false);
  });
});

function packageArchive(symlinkTarget = "brew"): Uint8Array {
  const zippable: Zippable = {
    "bin/": zipEntry(new Uint8Array(), 0o040700),
    "bin/brew": zipEntry(encoder.encode("#!/bin/brew\n"), 0o100711),
    "bin/brew-link": zipEntry(encoder.encode(symlinkTarget), 0o120700),
    "Library/": zipEntry(new Uint8Array(), 0o040750),
    "Library/PkgLib/": zipEntry(new Uint8Array(), 0o040777),
    "Library/PkgLib/global.rb": zipEntry(encoder.encode("GLOBAL = true\n"), 0o100600),
  };
  return zipSync(zippable, { level: 9 });
}

function zipEntry(bytes: Uint8Array, mode: number): Zippable[string] {
  return [bytes, { os: 3, attrs: ((mode << 16) >>> 0) }];
}

function packageFs(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
  for (const path of ["/opt", "/opt/kandelo", SPEC.mount_prefix]) {
    fs.mkdir(path, 0o755);
  }
  fs.chown(SPEC.mount_prefix, 1000, 1000);
  return fs;
}

function readFile(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    expect(fs.read(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
    return decoder.decode(bytes);
  } finally {
    fs.close(fd);
  }
}
