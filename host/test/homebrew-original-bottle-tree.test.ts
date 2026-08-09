import { describe, expect, it } from "vitest";

import {
  parseHomebrewOriginalBottleTreeDescriptor,
  registerHomebrewDeferredTreeCollection,
} from "../src/homebrew-runtime-layer-consumer";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const SHA256 = "a".repeat(64);
const REFERENCE =
  `https://artifacts.example.test/homebrew-tap-core-abi-8-candidates/bash?sha256=${SHA256}`;

describe("Homebrew original-bottle tree descriptors", () => {
  it("restores a verified tree without opening bottle bytes", () => {
    const parsed = parseHomebrewOriginalBottleTreeDescriptor(descriptor(), {
      architecture: "wasm32",
      tap: "kandelo-dev/homebrew-tap-core",
      formula: "bash",
      package: "kandelo-dev/tap-core/bash",
      bottle: { sha256: SHA256, bytes: 123 },
      allowedRoots: new Set(["bash"]),
    });
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024));
    fs.mkdir("/opt", 0o755);
    fs.mkdir("/opt/kandelo", 0o755);

    const registered = registerHomebrewDeferredTreeCollection({
      fs,
      id: "browser-main-shell",
      schema: 5,
      trees: [parsed.tree],
    });

    expect(registered).toEqual([
      expect.objectContaining({
        id: "bash",
        package: "kandelo-dev/tap-core/bash",
        content: { sha256: SHA256, bytes: 123 },
      }),
    ]);
    expect(fs.isPathDeferred(
      "/opt/kandelo/homebrew/Cellar/bash/1.0/bin/bash",
    )).toBe(true);
    expect(fs.exportLazyArchiveEntries()[0]?.content?.transports).toEqual([
      REFERENCE,
    ]);
  });

  it("rejects wrong bottle identity, non-HTTPS transport, and path escape", () => {
    expect(() => parseHomebrewOriginalBottleTreeDescriptor(descriptor(), {
      architecture: "wasm32",
      tap: "kandelo-dev/homebrew-tap-core",
      formula: "bash",
      bottle: { sha256: "b".repeat(64), bytes: 123 },
      allowedRoots: new Set(["bash"]),
    })).toThrow(/exact bottle input/);

    const transport = descriptor();
    transport.tree.transports[0] = {
      kind: "external-https",
      url: `http://artifacts.example.test/bash?sha256=${SHA256}`,
    };
    expect(() => parseHomebrewOriginalBottleTreeDescriptor(transport, expected()))
      .toThrow(/URL|HTTPS/);

    const escaped = descriptor();
    escaped.tree.inventory.entries[5]!.path = "usr/bin/bash";
    expect(() => parseHomebrewOriginalBottleTreeDescriptor(escaped, expected()))
      .toThrow(/prefix|directory|keg/);

    const foreignPackage = descriptor();
    foreignPackage.tree.package = "untrusted/tap/bash";
    expect(() =>
      parseHomebrewOriginalBottleTreeDescriptor(foreignPackage, expected())
    ).toThrow(/exact bottle input/);
  });
});

function expected() {
  return {
    architecture: "wasm32" as const,
    tap: "kandelo-dev/homebrew-tap-core",
    formula: "bash",
    package: "kandelo-dev/tap-core/bash",
    bottle: { sha256: SHA256, bytes: 123 },
    allowedRoots: new Set(["bash"]),
  };
}

function descriptor(): any {
  const keg = "opt/kandelo/homebrew/Cellar/bash/1.0";
  const entries = [
    directory("opt/kandelo/homebrew", "descriptor-prefix", "mergeable-directory"),
    directory("opt/kandelo/homebrew/Cellar", "descriptor-cellar", "mergeable-directory"),
    directory("opt/kandelo/homebrew/Cellar/bash", "descriptor-formula", "mergeable-directory"),
    directory(keg, "descriptor-keg", "layer"),
    directory(`${keg}/bin`, "descriptor-bin", "layer"),
    {
      path: `${keg}/bin/bash`,
      source_path: "bash/1.0/bin/bash",
      materialization: "archive",
      type: "file",
      ownership: "layer",
      mode: 0o755,
      size: 8,
      inode_group: "bash-bin",
    },
    directory("opt/kandelo/homebrew/opt", "descriptor-opt", "mergeable-directory"),
    {
      path: "opt/kandelo/homebrew/opt/bash",
      source_path: "descriptor-opt-link",
      materialization: "descriptor",
      type: "symlink",
      ownership: "layer",
      mode: 0o777,
      size: new TextEncoder().encode("../Cellar/bash/1.0").byteLength,
      target: "../Cellar/bash/1.0",
    },
  ];
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema: 1,
    kind: "kandelo-homebrew-original-bottle-tree",
    architecture: "wasm32",
    tap: "kandelo-dev/homebrew-tap-core",
    formula: "bash",
    required_by: ["bash"],
    tree: {
      id: "bash",
      package: "kandelo-dev/tap-core/bash",
      activation: {
        mode: "first-use",
        capabilities: ["homebrew-bottle:bash"],
        roots: ["/opt/kandelo/homebrew/Cellar/bash/1.0"],
      },
      content: {
        media_type: "application/vnd.oci.image.layer.v1.tar+gzip",
        decoder: "homebrew-bottle-tar-gzip-v1",
        sha256: SHA256,
        bytes: 123,
      },
      transports: [{ kind: "external-https", url: REFERENCE }],
      inventory: {
        entry_count: entries.length,
        source_entry_count: 1,
        regular_inode_count: 1,
        layer_entry_count: 4,
        mergeable_directory_count: 4,
        expanded_bytes: 8,
        payload_bytes: 8,
        source: {
          schema: 1,
          kind: "homebrew-bottle-tar-gzip-v1",
          entries: [{
            path: "bash/1.0/bin/bash",
            type: "file",
            mode: 0o755,
            size: 8,
          }],
        },
        entries,
      },
    },
  };
}

function directory(
  path: string,
  sourcePath: string,
  ownership: "layer" | "mergeable-directory",
) {
  return {
    path,
    source_path: sourcePath,
    materialization: "descriptor",
    type: "directory",
    ownership,
    mode: 0o755,
    size: 0,
  };
}
