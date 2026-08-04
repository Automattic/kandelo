import { zipSync, type Zippable } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { deriveHomebrewPortableRubyTree } from
  "../src/homebrew-portable-ruby";
import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
  registerPackageDeferredZipTree,
} from "../src/vfs/package-deferred-tree";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const encoder = new TextEncoder();
const COMPAT_PREFIX = "/home/linuxbrew/.linuxbrew";

describe("Homebrew portable Ruby lazy tree", () => {
  it("derives the upstream layout from the source-owned prefix and version", () => {
    const sourceArchive = bootstrapArchive("4.0.5_1");
    const sourceTree = derivePackageDeferredZipTree(
      bootstrapSpec(COMPAT_PREFIX),
      sourceArchive,
    );
    const portableArchive = portableRubyArchive("4.0.5_1");

    const portable = deriveHomebrewPortableRubyTree(
      sourceTree,
      sourceArchive,
      portableArchive,
    );

    expect(portable.descriptor).toMatchObject({
      id: "homebrew-bootstrap/portable-ruby",
      content_role: "runtime-tree",
      package: {
        name: "homebrew-bootstrap",
        output: "homebrew-portable-ruby.zip",
      },
      mount_prefix:
        `${COMPAT_PREFIX}/Library/Homebrew/vendor/portable-ruby`,
      owner: { uid: 1000, gid: 1000 },
      activation: {
        mode: "first-use",
        capabilities: ["homebrew:runtime"],
        roots: [
          `${COMPAT_PREFIX}/Library/Homebrew/vendor/portable-ruby/` +
            "4.0.5_1/bin/ruby",
        ],
        atomicGroup: {
          id: "homebrew-runtime-support",
          member: "homebrew-bootstrap/portable-ruby",
        },
      },
    });
    expect(
      portable.entries.find((entry) => entry.sourcePath === "current"),
    ).toMatchObject({ type: "symlink", target: "4.0.5_1" });
  });

  it("materializes source and portable Ruby atomically on Brew first use", async () => {
    const sourceArchive = bootstrapArchive("4.0.5_1");
    const sourceTree = derivePackageDeferredZipTree(
      bootstrapSpec(COMPAT_PREFIX),
      sourceArchive,
    );
    const portableArchive = portableRubyArchive("4.0.5_1");
    const portableTree = deriveHomebrewPortableRubyTree(
      sourceTree,
      sourceArchive,
      portableArchive,
    );
    const fs = portableRubyFs();
    registerPackageDeferredZipTree(fs, sourceTree);
    registerPackageDeferredZipTree(fs, portableTree);
    expect(fs.lstat(portableTree.descriptor.mount_prefix)).toMatchObject({
      uid: 1000,
      gid: 1000,
    });
    await fs.sealLazyAtomicGroup("homebrew-runtime-support", [
      sourceTree.descriptor.id,
      portableTree.descriptor.id,
    ]);
    const fetcher = vi.fn(async (url: string) => {
      const bytes = url === "homebrew-bootstrap.zip"
        ? sourceArchive
        : url === "homebrew-portable-ruby.zip"
          ? portableArchive
          : undefined;
      if (bytes === undefined) throw new Error(`unexpected URL: ${url}`);
      return new Response(bytes, {
        headers: { "content-length": String(bytes.byteLength) },
      });
    });
    fs.setLazyFetcher(fetcher);

    await expect(fs.preparePath(`${COMPAT_PREFIX}/bin/brew`)).resolves.toBe(
      true,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    assertPackageDeferredZipTreeState(fs, sourceTree, "materialized");
    assertPackageDeferredZipTreeState(fs, portableTree, "materialized");
    expect(readFile(
      fs,
      `${COMPAT_PREFIX}/Library/Homebrew/vendor/portable-ruby/current/bin/ruby`,
    )).toBe("ruby-wasm\n");
  });

  it("rejects a portable archive that disagrees with Homebrew source", () => {
    const sourceArchive = bootstrapArchive("4.0.5_1");
    const sourceTree = derivePackageDeferredZipTree(
      bootstrapSpec(COMPAT_PREFIX),
      sourceArchive,
    );

    expect(() =>
      deriveHomebrewPortableRubyTree(
        sourceTree,
        sourceArchive,
        portableRubyArchive("4.0.4_1"),
      )
    ).toThrow(/source-matched executable/);
  });
});

function bootstrapSpec(prefix: string) {
  return {
    schema: 1,
    kind: "kandelo-package-deferred-zip-tree",
    id: "homebrew-bootstrap/source-tree",
    content_role: "source-tree",
    package: {
      name: "homebrew-bootstrap",
      output: "homebrew-bootstrap.zip",
    },
    archive: {
      url: "homebrew-bootstrap.zip",
      mode_policy: "portable-posix-v1",
    },
    mount_prefix: prefix,
    owner: { uid: 1000, gid: 1000 },
    activation: {
      mode: "first-use",
      capabilities: ["homebrew:bootstrap", "homebrew:runtime"],
      roots: [`${prefix}/bin/brew`],
      atomic_group: "homebrew-runtime-support",
    },
  } as const;
}

function bootstrapArchive(version: string): Uint8Array {
  return zipSync({
    "bin/": zipEntry(new Uint8Array(), 0o040755),
    "bin/brew": zipEntry(encoder.encode("#!/bin/bash\n"), 0o100755),
    "Library/": zipEntry(new Uint8Array(), 0o040755),
    "Library/Homebrew/": zipEntry(new Uint8Array(), 0o040755),
    "Library/Homebrew/vendor/": zipEntry(new Uint8Array(), 0o040755),
    "Library/Homebrew/vendor/portable-ruby-version": zipEntry(
      encoder.encode(`${version}\n`),
      0o100644,
    ),
  }, { level: 9 });
}

function portableRubyArchive(version: string): Uint8Array {
  return zipSync({
    [`${version}/`]: zipEntry(new Uint8Array(), 0o040755),
    [`${version}/bin/`]: zipEntry(new Uint8Array(), 0o040755),
    [`${version}/bin/ruby`]: zipEntry(
      encoder.encode("ruby-wasm\n"),
      0o100755,
    ),
    [`${version}/lib/`]: zipEntry(new Uint8Array(), 0o040755),
    [`${version}/lib/ruby.rb`]: zipEntry(
      encoder.encode("RUBY = true\n"),
      0o100644,
    ),
    current: zipEntry(encoder.encode(version), 0o120777),
  }, { level: 9 });
}

function zipEntry(bytes: Uint8Array, mode: number): Zippable[string] {
  return [bytes, { os: 3, attrs: (mode << 16) >>> 0 }];
}

function portableRubyFs(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024));
  for (const path of ["/home", "/home/linuxbrew", COMPAT_PREFIX]) {
    fs.mkdir(path, 0o755);
  }
  fs.chown(COMPAT_PREFIX, 1000, 1000);
  return fs;
}

function readFile(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    expect(fs.read(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
    return new TextDecoder().decode(bytes);
  } finally {
    fs.close(fd);
  }
}
