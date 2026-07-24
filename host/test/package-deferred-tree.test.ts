import { zipSync, type Zippable } from "fflate";
import { describe, expect, it, vi } from "vitest";

import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
  materializePackageDeferredZipTree,
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
  id: "shell/homebrew-bootstrap",
  content_role: "source-tree",
  package: {
    name: "shell",
    output: "homebrew-bootstrap.zip",
  },
  archive: {
    url: "homebrew-bootstrap.zip",
    mode_policy: "portable-posix-v1",
  },
  mount_prefix: "/home/linuxbrew/.linuxbrew",
  owner: {
    uid: 1000,
    gid: 1000,
  },
  activation: {
    mode: "first-use",
    capabilities: ["homebrew:bootstrap"],
    roots: ["/home/linuxbrew/.linuxbrew/bin/brew"],
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
        vfs_path: "/home/linuxbrew/.linuxbrew/bin",
        type: "directory",
        mode: 0o755,
      }),
      expect.objectContaining({
        vfs_path: "/home/linuxbrew/.linuxbrew/bin/brew",
        type: "file",
        mode: 0o755,
        size: 12,
      }),
      expect.objectContaining({
        vfs_path: "/home/linuxbrew/.linuxbrew/bin/brew-link",
        type: "symlink",
        mode: 0o777,
        target: "brew",
      }),
      expect.objectContaining({
        vfs_path: "/home/linuxbrew/.linuxbrew/Library",
        type: "directory",
      }),
      expect.objectContaining({
        vfs_path: "/home/linuxbrew/.linuxbrew/Library/Homebrew",
        type: "directory",
      }),
      expect.objectContaining({
        vfs_path: "/home/linuxbrew/.linuxbrew/Library/Homebrew/global.rb",
        type: "file",
        mode: 0o644,
      }),
    ]);
    expect(decoder.decode(first.descriptorBytes).endsWith("\n")).toBe(true);
  });

  it("fetches one whole group on first use and never refetches it", async () => {
    const archive = packageArchive();
    const derived = derivePackageDeferredZipTree(SPEC, archive);
    const fs = packageFs();
    registerPackageDeferredZipTree(fs, derived);
    assertPackageDeferredZipTreeState(fs, derived, "deferred");
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toBe("homebrew-bootstrap.zip");
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
    const directory = fs.opendir(`${SPEC.mount_prefix}/Library/Homebrew`);
    try {
      expect(fs.readdir(directory)).toBeTruthy();
    } finally {
      fs.closedir(directory);
    }
    expect(fetcher).not.toHaveBeenCalled();

    await expect(fs.preparePath(`${SPEC.mount_prefix}/bin/brew`)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readFile(fs, `${SPEC.mount_prefix}/bin/brew`)).toBe("#!/bin/brew\n");
    expect(readFile(fs, `${SPEC.mount_prefix}/Library/Homebrew/global.rb`)).toBe(
      "GLOBAL = true\n",
    );
    expect(fs.readlink(`${SPEC.mount_prefix}/bin/brew-link`)).toBe("brew");
    expect(fs.isPathDeferred(`${SPEC.mount_prefix}/bin/brew`)).toBe(false);
    assertPackageDeferredZipTreeState(fs, derived, "materialized");

    await expect(
      fs.preparePath(`${SPEC.mount_prefix}/Library/Homebrew/global.rb`),
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
      fs.preparePath(`${SPEC.mount_prefix}/Library/Homebrew/global.rb`),
    ])).rejects.toThrow(/SHA-256/);
    expect(fetcher).toHaveBeenCalledTimes(1);
    assertPackageDeferredZipTreeState(fs, derived, "deferred");
    expect(fs.isPathDeferred(`${SPEC.mount_prefix}/bin/brew`)).toBe(true);
    expect(fs.isPathDeferred(
      `${SPEC.mount_prefix}/Library/Homebrew/global.rb`,
    )).toBe(true);

    served = archive;
    await expect(Promise.all([
      fs.preparePath(`${SPEC.mount_prefix}/bin/brew`),
      fs.preparePath(`${SPEC.mount_prefix}/Library/Homebrew/global.rb`),
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
    "Library/Homebrew/": zipEntry(new Uint8Array(), 0o040777),
    "Library/Homebrew/global.rb": zipEntry(encoder.encode("GLOBAL = true\n"), 0o100600),
  };
  return zipSync(zippable, { level: 9 });
}

function zipEntry(bytes: Uint8Array, mode: number): Zippable[string] {
  return [bytes, { os: 3, attrs: ((mode << 16) >>> 0) }];
}

function packageFs(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
  for (const path of ["/home", "/home/linuxbrew", SPEC.mount_prefix]) {
    fs.mkdir(path, 0o755);
    fs.chown(path, 1000, 1000);
  }
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
