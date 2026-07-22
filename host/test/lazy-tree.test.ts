import { createHash } from "node:crypto";
import { gzipSync, zipSync, type Zippable } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryFileSystem,
  type LazyTreeActivation,
  type LazyTreeRegistrationEntry,
} from "../src/vfs/memory-fs";
import {
  VFS_DEFERRED_TREE_COLLECTION_LIMITS,
  VFS_DEFERRED_TREE_LIMITS,
} from "../src/vfs/deferred-tree-limits";

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface TarSpec {
  path: string;
  type?: "file" | "directory" | "symlink" | "hardlink";
  mode: number;
  data?: string;
  target?: string;
}

describe("format-neutral deferred trees", () => {
  it("keeps public deferred-tree bounds reloadable and accounts for pending base usage", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    fs.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    const pending = fs.pendingDeferredTreeUsage();

    expect(pending).toEqual({
      groups: 1,
      archiveBytes: fixture.content.bytes,
      expandedBytes: fixture.content.expandedBytes,
      payloadBytes: 7,
      entries: fixture.inventory.length,
    });
    expect(() => fs.assertCanAppendDeferredTreeUsage({
      groups: VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups - pending.groups,
      archiveBytes:
        VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes -
        pending.archiveBytes,
      expandedBytes:
        VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxExpandedBytes -
        pending.expandedBytes,
      payloadBytes:
        VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxPayloadBytes -
        pending.payloadBytes,
      entries:
        VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxEntries - pending.entries,
    })).not.toThrow();

    const overBoundary = [
      ["groups", /group cap/],
      ["archiveBytes", /archive-byte cap/],
      ["expandedBytes", /expansion cap/],
      ["payloadBytes", /payload-byte cap/],
      ["entries", /entry-count cap/],
    ] as const;
    for (const [field, error] of overBoundary) {
      const additional = {
        groups: 0,
        archiveBytes: 0,
        expandedBytes: 0,
        payloadBytes: 0,
        entries: 0,
      };
      const limitField = field === "groups"
        ? "maxGroups"
        : field === "archiveBytes"
          ? "maxArchiveBytes"
          : field === "expandedBytes"
            ? "maxExpandedBytes"
            : field === "payloadBytes"
              ? "maxPayloadBytes"
              : "maxEntries";
      additional[field] =
        VFS_DEFERRED_TREE_COLLECTION_LIMITS[limitField] - pending[field] + 1;
      expect(() => fs.assertCanAppendDeferredTreeUsage(additional)).toThrow(
        error,
      );
    }

    const boundary = MemoryFileSystem.create(
      new SharedArrayBuffer(8 * 1024 * 1024),
    );
    const third = Math.floor(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes / 3,
    );
    const archiveBytes = [
      third,
      third,
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes - 2 * third,
    ];
    for (const [index, bytes] of archiveBytes.entries()) {
      const tree = tarTreeFixture("first-use", `archive-${index}`);
      boundary.registerLazyTree(
        { ...tree.content, bytes },
        tree.inventory,
        "/",
        tree.activation,
      );
    }
    expect(boundary.pendingDeferredTreeUsage().archiveBytes).toBe(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes,
    );
    const image = await boundary.saveImage();
    expect(MemoryFileSystem.fromImage(image).pendingDeferredTreeUsage().archiveBytes)
      .toBe(VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes);

    const over = structuredClone(boundary.exportLazyArchiveEntries());
    over[2]!.content!.bytes += 1;
    over[2]!.integrity!.bytes += 1;
    expect(() =>
      MemoryFileSystem.fromImage(replaceLazyArchiveMetadata(image, over))
    )
      .toThrow(/archive-byte cap/);
  });

  it("refuses to register a 513th pending group and round-trips the exact boundary", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(64 * 1024 * 1024));
    const registration = (index: number) => {
      const root = `group-${index.toString().padStart(3, "0")}`;
      return {
        content: {
          ...fixture.content,
          transports: [`https://example.invalid/${root}.tar.gz`],
        },
        inventory: fixture.inventory.map((entry) => ({
          ...entry,
          vfsPath: entry.vfsPath.replace("/runtime", `/${root}`),
          sourcePath: entry.sourcePath.replace("runtime", root),
          ...(entry.target === undefined
            ? {}
            : { target: entry.target.replace("/runtime", `/${root}`) }),
          ...(entry.inodeGroup === undefined
            ? {}
            : { inodeGroup: entry.inodeGroup.replace("runtime", root) }),
        })),
        activation: {
          mode: "first-use" as const,
          capabilities: [`test:${root}`],
          roots: [`/${root}`],
        },
      };
    };
    for (
      let index = 0;
      index < VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups;
      index += 1
    ) {
      const tree = registration(index);
      fs.registerLazyTree(tree.content, tree.inventory, "/", tree.activation);
    }
    expect(fs.pendingDeferredTreeUsage().groups).toBe(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups,
    );
    const image = await fs.saveImage();
    expect(MemoryFileSystem.fromImage(image).pendingDeferredTreeUsage().groups).toBe(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups,
    );

    const extra = registration(VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxGroups);
    expect(() => fs.registerLazyTree(
      extra.content,
      extra.inventory,
      "/",
      extra.activation,
    )).toThrow(/Cannot register another lazy archive group/);
    expect(() => fs.lstat(`/${extra.activation.roots[0]!.slice(1)}`)).toThrow();
  });

  it("accepts the filesystem root as the default first-use activation root", () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();

    fs.registerLazyTree(fixture.content, fixture.inventory);

    const serialized = fs.exportLazyArchiveEntries()[0];
    expect(serialized?.kind).toBe("kandelo-deferred-tree-v1");
    expect(serialized?.mountPrefix).toBe("/");
    expect(serialized?.entries.every((entry) => entry.vfsPath.startsWith("/")))
      .toBe(true);
    expect(serialized?.activation).toEqual({
      mode: "first-use",
      capabilities: ["deferred-tree"],
      roots: ["/"],
    });
  });

  it("materializes a TAR+gzip tree once while preserving hardlink identity", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);

    expect(fetcher).not.toHaveBeenCalled();
    const beforeTarget = fs.lstat("/runtime/tool");
    const beforeAlias = fs.lstat("/runtime/tool-hardlink");
    expect(beforeAlias.ino).toBe(beforeTarget.ino);
    expect(beforeTarget.nlink).toBe(2);
    expect(beforeAlias.size).toBe(7);

    await expect(Promise.all([
      fs.preparePath("/runtime/tool"),
      fs.preparePath("/runtime/tool-hardlink"),
    ])).resolves.toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readText(fs, "/runtime/tool")).toBe("payload");
    expect(readText(fs, "/runtime/tool-hardlink")).toBe("payload");
    const afterTarget = fs.lstat("/runtime/tool");
    const afterAlias = fs.lstat("/runtime/tool-hardlink");
    expect(afterAlias.ino).toBe(afterTarget.ino);
    expect(afterTarget.nlink).toBe(2);
  });

  it("binds direct materialization authority to one registered tree and filesystem", async () => {
    const fixture = tarTreeFixture("first-use");
    const owner = createFs();
    const foreign = createFs();
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    owner.setLazyFetcher(fetcher);
    const directContent = { ...fixture.content, transports: [] };
    expect(() => foreign.registerLazyTree(
      directContent,
      fixture.inventory,
      "/",
      fixture.activation,
    )).toThrow(/Lazy tree transports/);
    const handle = owner.registerLazyTreeWithMaterializationHandle(
      directContent,
      fixture.inventory,
      "/",
      fixture.activation,
    );
    await expect(owner.saveImage()).rejects.toThrow(
      /must be materialized before serialization/,
    );

    await expect(
      foreign.materializeRegisteredDeferredTree(handle, fixture.payload),
    ).rejects.toThrow(
      /not issued by this filesystem/,
    );
    expect(fetcher).not.toHaveBeenCalled();
    const wrongBytes = new Uint8Array(fixture.payload);
    wrongBytes[0] ^= 0xff;
    await expect(
      owner.materializeRegisteredDeferredTree(handle, wrongBytes),
    ).rejects.toThrow(/SHA-256/);
    const direct = owner.materializeRegisteredDeferredTree(handle, fixture.payload);
    const concurrentGuest = owner.preparePath("/runtime/tool");
    await expect(Promise.all([direct, concurrentGuest])).resolves.toEqual([true, true]);
    await expect(
      owner.materializeRegisteredDeferredTree(handle, fixture.payload),
    ).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(owner.exportLazyArchiveEntries()).toEqual([]);
    expect(
      MemoryFileSystem.fromImage(await owner.saveImage()).exportLazyArchiveEntries(),
    ).toEqual([]);
    expect(readText(owner, "/runtime/tool")).toBe("payload");
  });

  it("reports every deferred backing through direct and symlink paths without fetching", async () => {
    const fixture = tarTreeFixture("first-use");
    const source = createFs();
    source.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );
    const legacyBytes = encoder.encode("legacy!");
    source.registerLazyFile(
      "/legacy-tool",
      "https://example.invalid/legacy-tool",
      legacyBytes.byteLength,
      0o755,
    );
    source.symlink("/runtime/tool", "/tree-link");
    source.symlink("/legacy-tool", "/legacy-link");
    source.mkdir("/concrete", 0o755);

    const restored = MemoryFileSystem.fromImage(await source.saveImage());
    const fetcher = vi.fn(async (url: string) => new Response(
      url.endsWith("/legacy-tool") ? legacyBytes : fixture.payload,
    ));
    restored.setLazyFetcher(fetcher);
    for (const path of [
      "/runtime/tool",
      "/tree-link",
      "/legacy-tool",
      "/legacy-link",
    ]) {
      expect(restored.isPathDeferred(path), path).toBe(true);
    }
    expect(restored.isPathDeferred("/concrete")).toBe(false);
    expect(restored.isPathDeferred("/missing")).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();

    await expect(restored.preparePath("/tree-link")).resolves.toBe(true);
    expect(restored.isPathDeferred("/runtime/tool")).toBe(false);
    expect(restored.isPathDeferred("/tree-link")).toBe(false);
    await expect(restored.preparePath("/legacy-link")).resolves.toBe(true);
    expect(restored.isPathDeferred("/legacy-tool")).toBe(false);
    expect(restored.isPathDeferred("/legacy-link")).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("tries byte-identical tree transports in declared order", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const primary = "https://primary.example.invalid/runtime.tar.gz";
    const mirror = "https://mirror.example.invalid/runtime.tar.gz";
    const fetcher = vi.fn(async (url: string) =>
      url === primary
        ? new Response(null, { status: 503 })
        : new Response(fixture.payload)
    );
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree({
      ...fixture.content,
      transports: [primary, mirror],
    }, fixture.inventory, "/", fixture.activation);

    await expect(fs.preparePath("/runtime/tool")).resolves.toBe(true);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([primary, mirror]);
    expect(readText(fs, "/runtime/tool")).toBe("payload");
  });

  it("accepts every exact public activation and transport boundary", () => {
    const fixture = tarTreeFixture("first-use");
    const capabilities = Array.from(
      { length: VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilities },
      (_, index) => index === 0
        ? "a".repeat(VFS_DEFERRED_TREE_LIMITS.maxActivationCapabilityBytes)
        : `test:capability-${index.toString().padStart(2, "0")}`,
    );
    const roots = [
      "/runtime",
      ...Array.from(
        { length: VFS_DEFERRED_TREE_LIMITS.maxActivationRoots - 1 },
        (_, index) => `/activation-root-${index.toString().padStart(2, "0")}`,
      ),
    ];
    const inventory = [
      ...fixture.inventory,
      ...roots.slice(1).map((root) => ({
        vfsPath: root,
        sourcePath: root.slice(1),
        type: "directory" as const,
        mode: 0o755,
        size: 0,
      })),
    ];
    const transports = Array.from(
      { length: VFS_DEFERRED_TREE_LIMITS.maxTransportsPerTree },
      (_, index) => `https://example.invalid/runtime-${index}.tar.gz`,
    );
    const fs = createFs();
    expect(() => fs.registerLazyTree({
      ...fixture.content,
      sourceEntryCount: inventory.length,
      transports,
    }, inventory, "/", {
      mode: "first-use",
      capabilities,
      roots,
    })).not.toThrow();
    expect(fs.exportLazyArchiveEntries()[0]?.content?.transports).toHaveLength(
      VFS_DEFERRED_TREE_LIMITS.maxTransportsPerTree,
    );
  });

  it("round-trips decoder, inventory, activation, and inode groups through an image", async () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    fs.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    const restored = MemoryFileSystem.fromImage(await fs.saveImage());
    const serialized = restored.exportLazyArchiveEntries()[0];

    expect(serialized.content).toEqual(fixture.content);
    expect(serialized.activation).toEqual(fixture.activation);
    expect(serialized.inventory).toEqual(fixture.inventory);
    expect(restored.lstat("/runtime/tool-hardlink").ino)
      .toBe(restored.lstat("/runtime/tool").ino);

    restored.setLazyFetcher(async () => new Response(fixture.payload));
    await restored.preparePath("/runtime/tool-hardlink");
    expect(readText(restored, "/runtime/tool")).toBe("payload");
  });

  it("keeps first-use trees inert and makes boot-prefetch failures fatal", async () => {
    const firstUse = tarTreeFixture("first-use", "first-use");
    const boot = tarTreeFixture("boot-prefetch", "boot");
    const fs = createFs();
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("boot")) throw new Error("transport offline");
      return new Response(firstUse.payload);
    });
    fs.setLazyFetcher(fetcher);
    fs.registerLazyTree(
      firstUse.content,
      firstUse.inventory,
      "/",
      firstUse.activation,
    );
    fs.registerLazyTree(boot.content, boot.inventory, "/", boot.activation);

    expect(fs.stat("/first-use/tool").size).toBe(7);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(fs.prepareBootDeferredTrees()).rejects.toThrow("transport offline");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fs.stat("/first-use/tool").size).toBe(7);
  });

  it("bounds concurrent boot-prefetch buffers", async () => {
    const fixtures = Array.from({ length: 5 }, (_, index) =>
      tarTreeFixture("boot-prefetch", `boot-${index}`)
    );
    const payloads = new Map(fixtures.map((fixture) => [
      fixture.content.transports[0],
      fixture.payload,
    ]));
    const fs = createFs();
    let active = 0;
    let maximumActive = 0;
    fs.setLazyFetcher(async (url) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(payloads.get(url)!);
    });
    for (const fixture of fixtures) {
      fs.registerLazyTree(
        fixture.content,
        fixture.inventory,
        "/",
        fixture.activation,
      );
    }

    await expect(fs.prepareBootDeferredTrees()).resolves.toBe(fixtures.length);
    expect(maximumActive).toBe(2);
  });

  it("preserves and verifies a symlink-only boot-prefetch tree", async () => {
    const fixture = symlinkTreeFixture();
    const source = createFs();
    source.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );
    expect(source.exportLazyArchiveEntries()[0]).toMatchObject({
      mountPrefix: "/",
      materialized: false,
      entries: [],
    });
    const restored = MemoryFileSystem.fromImage(await source.saveImage());
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    restored.setLazyFetcher(fetcher);

    expect(restored.readlink("/metadata/runtime-link")).toBe("/runtime/target");
    expect(fetcher).not.toHaveBeenCalled();
    expect(restored.exportLazyArchiveEntries()).toHaveLength(1);
    await expect(restored.prepareBootDeferredTrees()).resolves.toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(restored.exportLazyArchiveEntries()).toEqual([]);
  });

  it("preserves a pending metadata-only tree after its regular names are removed", async () => {
    const fixture = tarTreeFixture("first-use");
    const source = createFs();
    source.registerLazyTree(
      fixture.content,
      fixture.inventory,
      "/",
      fixture.activation,
    );
    source.unlink("/runtime/tool-hardlink");
    source.unlink("/runtime/tool");
    expect(source.exportLazyArchiveEntries()[0]).toMatchObject({
      materialized: false,
      entries: [],
    });

    const restored = MemoryFileSystem.fromImage(await source.saveImage());
    const fetcher = vi.fn(async () => new Response(fixture.payload));
    restored.setLazyFetcher(fetcher);
    await expect(restored.preparePath("/runtime")).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(restored.exportLazyArchiveEntries()).toEqual([]);
  });

  it("rejects inventory/content disagreement before mutating any stub", () => {
    const fixture = tarTreeFixture("first-use");
    const fs = createFs();
    const inventory = fixture.inventory.filter(
      (entry) => entry.vfsPath !== "/runtime/tool-hardlink",
    );

    expect(() =>
      fs.registerLazyTree(fixture.content, inventory, "/", fixture.activation)
    ).toThrow(/source entry count differs/);
    expect(() => fs.lstat("/runtime")).toThrow();
  });

  it("rejects impossible hardlink metadata before namespace registration", () => {
    const fixture = tarTreeFixture("first-use");
    const inventory = structuredClone(fixture.inventory);
    const alias = inventory.find((entry) => entry.type === "hardlink")!;
    alias.mode = 0o644;
    const fs = createFs();

    expect(() =>
      fs.registerLazyTree(
        fixture.content,
        inventory,
        "/",
        fixture.activation,
      )
    ).toThrow(/hardlink .* invalid target/);
    expect(() => fs.lstat("/runtime")).toThrow();
  });

  it("binds original-bottle copy modes unless the link manifest explicitly overrides them", async () => {
    const fixture = originalBottleTreeFixture();
    const mismatched = structuredClone(fixture.inventory);
    mismatched.find((entry) => entry.materialization === "archive-copy")!.mode = 0o644;
    const rejected = createFs();

    expect(() => rejected.registerLazyTree(
      fixture.content,
      mismatched,
      "/",
      fixture.activation,
    )).toThrow(/archive copy .* differs from its source/);
    expect(() => rejected.lstat("/runtime")).toThrow();

    const overridden = structuredClone(fixture.inventory);
    const copy = overridden.find((entry) => entry.materialization === "archive-copy")!;
    copy.materialization = "archive-copy-mode";
    copy.mode = 0o644;
    const accepted = createFs();
    accepted.registerLazyTree(
      fixture.content,
      overridden,
      "/",
      fixture.activation,
    );
    expect(accepted.exportLazyArchiveEntries()[0]?.kind)
      .toBe("kandelo-deferred-tree-v2");
    const restored = MemoryFileSystem.fromImage(await accepted.saveImage());
    expect(restored.exportLazyArchiveEntries()[0]?.kind)
      .toBe("kandelo-deferred-tree-v2");
    const rebased = restored.rebaseToNewFileSystem(8 * 1024 * 1024);
    expect(rebased.exportLazyArchiveEntries()[0]?.kind)
      .toBe("kandelo-deferred-tree-v2");
    rebased.setLazyFetcher(async () => new Response(fixture.payload));

    await expect(rebased.preparePath("/runtime/tool-copy")).resolves.toBe(true);
    expect(readText(rebased, "/runtime/tool-copy")).toBe("payload");
    expect(rebased.stat("/runtime/tool-copy").mode & 0o777).toBe(0o644);
  });

  it("keeps legacy v1 and original-bottle v2 serialized shapes disjoint", () => {
    const legacyFixture = tarTreeFixture("first-use");
    const legacy = createFs();
    legacy.registerLazyTree(
      legacyFixture.content,
      legacyFixture.inventory,
      "/",
      legacyFixture.activation,
    );
    const legacyV1 = structuredClone(legacy.exportLazyArchiveEntries()[0]) as any;
    expect(legacyV1.kind).toBe("kandelo-deferred-tree-v1");
    legacyV1.kind = "kandelo-deferred-tree-v2";
    expect(() => MemoryFileSystem.fromExisting(legacy.sharedBuffer)
      .importLazyArchiveEntries([legacyV1]))
      .toThrow(/v2 requires original-bottle source metadata/);

    const directFixture = originalBottleTreeFixture();
    const direct = createFs();
    direct.registerLazyTree(
      directFixture.content,
      directFixture.inventory,
      "/",
      directFixture.activation,
    );
    const directV2 = structuredClone(direct.exportLazyArchiveEntries()[0]) as any;
    expect(directV2.kind).toBe("kandelo-deferred-tree-v2");
    directV2.kind = "kandelo-deferred-tree-v1";
    expect(() => MemoryFileSystem.fromExisting(direct.sharedBuffer)
      .importLazyArchiveEntries([directV2]))
      .toThrow(/v1 cannot contain original-bottle source metadata/);

    const incompleteV2 = structuredClone(direct.exportLazyArchiveEntries()[0]) as any;
    delete incompleteV2.content.source;
    for (const entry of incompleteV2.inventory) delete entry.materialization;
    incompleteV2.inventory = incompleteV2.inventory.filter(
      (entry: any) => entry.vfsPath !== "/runtime/tool-copy",
    );
    incompleteV2.entries = incompleteV2.entries.filter(
      (entry: any) => entry.vfsPath !== "/runtime/tool-copy",
    );
    expect(() => MemoryFileSystem.fromExisting(direct.sharedBuffer)
      .importLazyArchiveEntries([incompleteV2]))
      .toThrow(/v2 requires original-bottle source metadata/);
  });

  it("preserves ZIP inventories whose hardlinks reuse the canonical member", () => {
    const fixture = tarTreeFixture("first-use");
    const inventory = structuredClone(fixture.inventory);
    const file = inventory.find((entry) => entry.type === "file")!;
    const hardlink = inventory.find((entry) => entry.type === "hardlink")!;
    hardlink.sourcePath = file.sourcePath;
    const fs = createFs();

    fs.registerLazyTree({
      ...fixture.content,
      decoder: "zip-v1",
      mediaType: "application/zip",
      expandedBytes: 7,
      sourceEntryCount: 2,
      transports: ["https://example.invalid/runtime.zip"],
    }, inventory, "/", fixture.activation);

    expect(fs.lstat("/runtime/tool-hardlink").ino)
      .toBe(fs.lstat("/runtime/tool").ino);
  });

  it("bounds ZIP expansion by the declared inventory before mutating a stub", async () => {
    const uncompressed = new TextEncoder().encode("payload".repeat(4_096));
    const input: Zippable = {
      "runtime/tool": [uncompressed, {
        level: 9,
        os: 3,
        attrs: (((0o100000 | 0o755) << 16) >>> 0),
      }],
    };
    const payload = zipSync(input, { level: 9 });
    const centralOffset = findZipCentralDirectory(payload);
    new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      .setUint32(centralOffset + 24, 1, true);
    const fs = createFs();
    fs.registerLazyTree({
      decoder: "zip-v1",
      mediaType: "application/zip",
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
      expandedBytes: 1,
      sourceEntryCount: 1,
      transports: ["https://example.invalid/runtime.zip"],
    }, [{
      vfsPath: "/runtime/tool",
      sourcePath: "runtime/tool",
      type: "file",
      mode: 0o755,
      size: 1,
      inodeGroup: "runtime:tool",
    }], "/", {
      mode: "first-use",
      capabilities: ["test:zip-bound"],
      roots: ["/runtime/tool"],
    });
    fs.setLazyFetcher(async () => new Response(payload));

    await expect(fs.preparePath("/runtime/tool")).rejects.toThrow(
      /expands beyond 1 bytes/,
    );
    const peer = MemoryFileSystem.fromExisting(fs.sharedBuffer);
    expect(peer.stat("/runtime/tool").size).toBe(0);
  });

  it("closes and bounds every live generic-tree schema component", () => {
    const fixture = tarTreeFixture("first-use");
    const cases: Array<{ mutate: (value: Record<string, any>) => void; error: RegExp }> = [
      {
        mutate: (value) => value.content.unexpected = true,
        error: /content has unexpected or missing fields/,
      },
      {
        mutate: (value) => value.activation.unexpected = true,
        error: /activation has unexpected or missing fields/,
      },
      {
        mutate: (value) => value.inventory[0].unexpected = true,
        error: /entry 0 has unexpected or missing fields/,
      },
      {
        mutate: (value) => value.activation.roots = ["/runtime/../escape"],
        error: /unsafe path segment/,
      },
      {
        mutate: (value) => value.activation.roots = ["/outside"],
        error: /is not owned by its inventory/,
      },
      {
        mutate: (value) => value.mountPrefix = "/runtime/../escape",
        error: /mount prefix is not canonical/,
      },
      {
        mutate: (value) => value.inventory[0].sourcePath = "x".repeat(4097),
        error: /canonical relative path/,
      },
      {
        mutate: (value) => value.content.transports = ["x".repeat(8193)],
        error: /exceeds 8192 bytes/,
      },
      {
        mutate: (value) => value.activation.capabilities = new Array(33).fill("test:x"),
        error: /must contain 1 to 32 items/,
      },
    ];

    for (const testCase of cases) {
      const value: Record<string, any> = {
        content: structuredClone(fixture.content),
        inventory: structuredClone(fixture.inventory),
        activation: structuredClone(fixture.activation),
        mountPrefix: "/",
      };
      testCase.mutate(value);
      const fs = createFs();
      expect(() =>
        fs.registerLazyTree(
          value.content,
          value.inventory,
          value.mountPrefix,
          value.activation,
        )
      ).toThrow(testCase.error);
      expect(() => fs.lstat("/runtime")).toThrow();
    }
  });

  it("rejects missing, cyclic, and cross-inode hardlinks before registration", () => {
    const fixture = tarTreeFixture("first-use");
    const missing = structuredClone(fixture.inventory);
    missing.find((entry) => entry.type === "hardlink")!.target = "/runtime/missing";
    expect(() =>
      createFs().registerLazyTree(
        fixture.content,
        missing,
        "/",
        fixture.activation,
      )
    ).toThrow(/target .* is missing/);

    const cyclic = structuredClone(fixture.inventory);
    const alias = cyclic.find((entry) => entry.type === "hardlink")!;
    alias.target = alias.vfsPath;
    expect(() =>
      createFs().registerLazyTree(
        fixture.content,
        cyclic,
        "/",
        fixture.activation,
      )
    ).toThrow(/cycle reaches/);

    const crossInode = structuredClone(fixture.inventory);
    crossInode.push({
      vfsPath: "/runtime/other",
      sourcePath: "runtime/other",
      type: "file",
      mode: 0o755,
      size: 7,
      inodeGroup: "runtime:other",
    });
    const crossAlias = crossInode.find((entry) => entry.type === "hardlink")!;
    crossAlias.target = "/runtime/other";
    const crossContent = {
      ...fixture.content,
      sourceEntryCount: fixture.content.sourceEntryCount + 1,
      expandedBytes: fixture.content.expandedBytes + 7,
    };
    expect(() =>
      createFs().registerLazyTree(
        crossContent,
        crossInode,
        "/",
        fixture.activation,
      )
    ).toThrow(/invalid target/);
  });

  it("validates imported generic metadata before installing any group", () => {
    const fixture = tarTreeFixture("first-use");
    const source = createFs();
    source.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    const serialized = source.exportLazyArchiveEntries();
    const cases: Array<{ mutate: (value: any) => unknown; error: RegExp }> = [
      {
        mutate: (value) => {
          delete value.kind;
          return value;
        },
        error: /missing its kind discriminator/,
      },
      {
        mutate: (value) => ({ ...value, unexpected: true }),
        error: /Serialized lazy tree has unexpected or missing fields/,
      },
      {
        mutate: (value) => {
          value.content.unexpected = true;
          return value;
        },
        error: /content has unexpected or missing fields/,
      },
      {
        mutate: (value) => {
          value.inventory[0].unexpected = true;
          return value;
        },
        error: /entry 0 has unexpected or missing fields/,
      },
      {
        mutate: (value) => {
          value.entries[0].size += 1;
          return value;
        },
        error: /disagrees with its inventory/,
      },
      {
        mutate: (value) => {
          value.entries = new Array(100_001).fill(value.entries[0]);
          return value;
        },
        error: /must contain 0 to 100000 items/,
      },
    ];

    for (const testCase of cases) {
      const candidate = testCase.mutate(structuredClone(serialized[0]));
      const peer = MemoryFileSystem.fromExisting(source.sharedBuffer);
      expect(() => peer.importLazyArchiveEntries([candidate] as any))
        .toThrow(testCase.error);
      expect(peer.exportLazyArchiveEntries()).toEqual([]);
    }
    const peer = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() =>
      peer.importLazyArchiveEntries(
        new Array(513).fill(serialized[0]) as any,
      )
    ).toThrow(/must contain 0 to 512 items/);
  });

  it("does not let ZIP deferred-tree metadata downgrade to the legacy schema", () => {
    const fixture = tarTreeFixture("first-use");
    const inventory = structuredClone(fixture.inventory);
    const file = inventory.find((entry) => entry.type === "file")!;
    const hardlink = inventory.find((entry) => entry.type === "hardlink")!;
    hardlink.sourcePath = file.sourcePath;
    const source = createFs();
    source.registerLazyTree({
      ...fixture.content,
      decoder: "zip-v1",
      mediaType: "application/zip",
      expandedBytes: 7,
      sourceEntryCount: 2,
      transports: ["https://example.invalid/runtime.zip"],
    }, inventory, "/", fixture.activation);
    const downgraded = structuredClone(source.exportLazyArchiveEntries()[0]) as any;
    delete downgraded.kind;
    delete downgraded.content;
    delete downgraded.inventory;
    delete downgraded.activation;

    const peer = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() => peer.importLazyArchiveEntries([downgraded]))
      .toThrow(/missing its kind discriminator/);
    expect(peer.exportLazyArchiveEntries()).toEqual([]);
  });

  it("commits no groups when a later imported inode identity is invalid", () => {
    const source = createFs();
    const first = tarTreeFixture("first-use", "first");
    const second = tarTreeFixture("first-use", "second");
    source.registerLazyTree(first.content, first.inventory, "/", first.activation);
    source.registerLazyTree(second.content, second.inventory, "/", second.activation);
    const serialized = structuredClone(source.exportLazyArchiveEntries());
    serialized[1].entries[0].ino += 1_000;

    const peer = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() => peer.importLazyArchiveEntries(serialized))
      .toThrow(/stub .* has a different inode/);
    expect(peer.exportLazyArchiveEntries()).toEqual([]);
  });

  it("rejects aggregate serialized-tree resource claims before installing groups", () => {
    const source = createFs();
    const first = tarTreeFixture("first-use", "aggregate-first");
    const second = tarTreeFixture("first-use", "aggregate-second");
    const third = tarTreeFixture("first-use", "aggregate-third");
    source.registerLazyTree(first.content, first.inventory, "/", first.activation);
    source.registerLazyTree(second.content, second.inventory, "/", second.activation);
    source.registerLazyTree(third.content, third.inventory, "/", third.activation);
    const serialized = structuredClone(source.exportLazyArchiveEntries()) as any[];

    const archiveShare = Math.floor(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxArchiveBytes / serialized.length,
    ) + 1;
    for (const group of serialized) {
      group.content.bytes = archiveShare;
      group.integrity.bytes = group.content.bytes;
    }
    const archivePeer = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() => archivePeer.importLazyArchiveEntries(serialized as any))
      .toThrow(/collection exceeds the archive-byte cap/);
    expect(archivePeer.exportLazyArchiveEntries()).toEqual([]);

    const expanded = structuredClone(source.exportLazyArchiveEntries()) as any[];
    const expandedShare = Math.floor(
      VFS_DEFERRED_TREE_COLLECTION_LIMITS.maxExpandedBytes / expanded.length,
    ) + 1;
    for (const group of expanded) {
      group.content.expandedBytes = expandedShare;
    }
    const expandedPeer = MemoryFileSystem.fromExisting(source.sharedBuffer);
    expect(() => expandedPeer.importLazyArchiveEntries(expanded as any))
      .toThrow(/collection exceeds the expansion cap/);
    expect(expandedPeer.exportLazyArchiveEntries()).toEqual([]);

    const payloadSource = createFs();
    for (const root of ["payload-a", "payload-b", "payload-c"]) {
      const fixture = originalBottleTreeFixture(root);
      payloadSource.registerLazyTree(
        fixture.content,
        fixture.inventory,
        "/",
        fixture.activation,
      );
    }
    const payload = structuredClone(payloadSource.exportLazyArchiveEntries()) as any[];
    for (const group of payload) {
      const largeSize = 90 * 1024 * 1024;
      for (const sourceEntry of group.content.source.entries) {
        if (sourceEntry.type === "file") sourceEntry.size = largeSize;
      }
      for (const entry of group.inventory) {
        if (entry.type === "file" || entry.type === "hardlink") entry.size = largeSize;
      }
      for (const entry of group.entries) entry.size = largeSize;
    }
    const payloadPeer = MemoryFileSystem.fromExisting(payloadSource.sharedBuffer);
    expect(() => payloadPeer.importLazyArchiveEntries(payload as any))
      .toThrow(/collection exceeds the payload-byte cap/);
    expect(payloadPeer.exportLazyArchiveEntries()).toEqual([]);

    const metadataGroup = (root: string) => ({
      kind: "kandelo-deferred-tree-v1",
      content: {
        ...first.content,
        expandedBytes: 50_001,
        sourceEntryCount: 50_001,
        transports: [`https://example.invalid/${root}.tar.gz`],
      },
      inventory: Array.from({ length: 50_001 }, (_, index) => ({
        vfsPath: `/${root}/link-${index.toString().padStart(5, "0")}`,
        sourcePath: `${root}/link-${index.toString().padStart(5, "0")}`,
        type: "symlink",
        mode: 0o777,
        size: 1,
        target: "x",
      })),
      activation: {
        mode: "first-use",
        capabilities: [`test:${root}`],
        roots: ["/"],
      },
      url: `https://example.invalid/${root}.tar.gz`,
      mountPrefix: "/",
      integrity: {
        sha256: first.content.sha256,
        bytes: first.content.bytes,
      },
      materialized: false,
      entries: [],
    });
    const entryPeer = createFs();
    expect(() => entryPeer.importLazyArchiveEntries([
      metadataGroup("aggregate-a"),
      metadataGroup("aggregate-b"),
    ] as any)).toThrow(/collection exceeds the entry-count cap/);
    expect(entryPeer.exportLazyArchiveEntries()).toEqual([]);
  });

  it("applies the same generic-tree validator during restore and rebase", async () => {
    const fixture = tarTreeFixture("first-use");
    const source = createFs();
    source.registerLazyTree(fixture.content, fixture.inventory, "/", fixture.activation);
    const image = await source.saveImage();
    const serialized = source.exportLazyArchiveEntries();
    const unknown = structuredClone(serialized[0]) as any;
    unknown.activation.unexpected = true;
    expect(() =>
      MemoryFileSystem.fromImage(replaceLazyArchiveMetadata(image, [unknown]))
    ).toThrow(/activation has unexpected or missing fields/);

    const downgraded = structuredClone(serialized[0]) as any;
    delete downgraded.kind;
    delete downgraded.content;
    delete downgraded.inventory;
    delete downgraded.activation;
    expect(() =>
      MemoryFileSystem.fromImage(replaceLazyArchiveMetadata(image, [downgraded]))
    ).toThrow(/missing its kind discriminator/);

    const truncated = image.slice();
    const archiveOffset = lazyArchiveMetadataOffset(truncated);
    const truncatedView = new DataView(
      truncated.buffer,
      truncated.byteOffset,
      truncated.byteLength,
    );
    truncatedView.setUint32(
      archiveOffset,
      truncatedView.getUint32(archiveOffset, true) + 1,
      true,
    );
    expect(() => MemoryFileSystem.fromImage(truncated))
      .toThrow(/truncated \(lazy archive payload\)/);

    const oversized = image.slice();
    new DataView(oversized.buffer, oversized.byteOffset, oversized.byteLength)
      .setUint32(lazyArchiveMetadataOffset(oversized), 16 * 1024 * 1024 + 1, true);
    expect(() => MemoryFileSystem.fromImage(oversized))
      .toThrow(/lazy archive metadata exceeds/);

    const internal = source as unknown as {
      lazyArchiveGroups: Array<{ content: { expandedBytes: number } }>;
    };
    internal.lazyArchiveGroups[0].content.expandedBytes = 0;
    expect(() => source.rebaseToNewFileSystem(8 * 1024 * 1024))
      .toThrow(/expanded byte count differs from its inventory/);
  });
});

function findZipCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset <= bytes.byteLength - 4; offset++) {
    if (view.getUint32(offset, true) === 0x02014b50) return offset;
  }
  throw new Error("central directory entry not found in test ZIP");
}

function lazyArchiveMetadataOffset(image: Uint8Array): number {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const sabLength = view.getUint32(12, true);
  const lazyOffset = 16 + sabLength;
  const lazyLength = view.getUint32(lazyOffset, true);
  return lazyOffset + 4 + lazyLength;
}

function replaceLazyArchiveMetadata(
  image: Uint8Array,
  metadata: unknown,
): Uint8Array {
  const archiveOffset = lazyArchiveMetadataOffset(image);
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const oldLength = view.getUint32(archiveOffset, true);
  const suffixOffset = archiveOffset + 4 + oldLength;
  const json = encoder.encode(JSON.stringify(metadata));
  const replaced = new Uint8Array(
    archiveOffset + 4 + json.byteLength + image.byteLength - suffixOffset,
  );
  replaced.set(image.subarray(0, archiveOffset), 0);
  new DataView(replaced.buffer).setUint32(archiveOffset, json.byteLength, true);
  replaced.set(json, archiveOffset + 4);
  replaced.set(image.subarray(suffixOffset), archiveOffset + 4 + json.byteLength);
  return replaced;
}

function tarTreeFixture(
  mode: LazyTreeActivation["mode"],
  root = "runtime",
) {
  const specs: TarSpec[] = [
    { path: root, type: "directory", mode: 0o755 },
    { path: `${root}/tool`, mode: 0o755, data: "payload" },
    {
      path: `${root}/tool-hardlink`,
      type: "hardlink",
      mode: 0o755,
      target: `${root}/tool`,
    },
  ];
  const tar = tarBytes(specs);
  const payload = gzipSync(tar);
  const inventory: LazyTreeRegistrationEntry[] = [
    {
      vfsPath: `/${root}`,
      sourcePath: root,
      type: "directory",
      mode: 0o755,
      size: 0,
    },
    {
      vfsPath: `/${root}/tool`,
      sourcePath: `${root}/tool`,
      type: "file",
      mode: 0o755,
      size: 7,
      inodeGroup: `${root}:tool`,
    },
    {
      vfsPath: `/${root}/tool-hardlink`,
      sourcePath: `${root}/tool-hardlink`,
      type: "hardlink",
      mode: 0o755,
      size: 7,
      target: `/${root}/tool`,
      inodeGroup: `${root}:tool`,
    },
  ];
  return {
    payload,
    inventory,
    content: {
      decoder: "homebrew-bottle-tar-gzip-v1" as const,
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" as const,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
      expandedBytes: tar.byteLength,
      sourceEntryCount: specs.length,
      transports: [`https://example.invalid/${root}.tar.gz`],
    },
    activation: {
      mode,
      capabilities: [`test:${root}`],
      roots: [`/${root}`],
    } satisfies LazyTreeActivation,
  };
}

function originalBottleTreeFixture(root = "runtime") {
  const fixture = tarTreeFixture("first-use", root);
  const inventory: LazyTreeRegistrationEntry[] = fixture.inventory.map((entry) => ({
    ...entry,
    materialization: "archive",
  }));
  inventory.push({
    vfsPath: `/${root}/tool-copy`,
    sourcePath: `${root}/tool`,
    materialization: "archive-copy",
    type: "file",
    mode: 0o755,
    size: 7,
    inodeGroup: `${root}:tool-copy`,
  });
  return {
    ...fixture,
    content: {
      ...fixture.content,
      source: {
        schema: 1 as const,
        kind: "homebrew-bottle-tar-gzip-v1" as const,
        entries: [
          {
            sourcePath: root,
            type: "directory" as const,
            mode: 0o755,
            size: 0,
          },
          {
            sourcePath: `${root}/tool`,
            type: "file" as const,
            mode: 0o755,
            size: 7,
          },
          {
            sourcePath: `${root}/tool-hardlink`,
            type: "hardlink" as const,
            mode: 0o755,
            size: 0,
            target: `${root}/tool`,
          },
        ],
      },
    },
    inventory,
  };
}

function symlinkTreeFixture() {
  const target = "/runtime/target";
  const specs: TarSpec[] = [{
    path: "metadata/runtime-link",
    type: "symlink",
    mode: 0o777,
    target,
  }];
  const tar = tarBytes(specs);
  const payload = gzipSync(tar);
  return {
    payload,
    inventory: [{
      vfsPath: "/metadata/runtime-link",
      sourcePath: "metadata/runtime-link",
      type: "symlink" as const,
      mode: 0o777,
      size: encoder.encode(target).byteLength,
      target,
    }],
    content: {
      decoder: "homebrew-bottle-tar-gzip-v1" as const,
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" as const,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bytes: payload.byteLength,
      expandedBytes: tar.byteLength,
      sourceEntryCount: specs.length,
      transports: ["https://example.invalid/metadata.tar.gz"],
    },
    activation: {
      mode: "boot-prefetch" as const,
      capabilities: ["test:metadata"],
      roots: ["/metadata"],
    },
  };
}

function createFs(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
}

function readText(fs: MemoryFileSystem, path: string): string {
  const stat = fs.stat(path);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    expect(fs.read(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
  } finally {
    fs.close(fd);
  }
  return decoder.decode(bytes);
}

function tarBytes(entries: readonly TarSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 2 * BLOCK;
  for (const entry of entries) {
    const data = encoder.encode(entry.data ?? "");
    const payload = new Uint8Array(Math.ceil(data.byteLength / BLOCK) * BLOCK);
    payload.set(data);
    const header = tarHeader(entry, data.byteLength);
    chunks.push(header, payload);
    total += header.byteLength + payload.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function tarHeader(entry: TarSpec, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, entry.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type === "directory"
    ? "5".charCodeAt(0)
    : entry.type === "hardlink"
      ? "1".charCodeAt(0)
      : entry.type === "symlink"
        ? "2".charCodeAt(0)
        : "0".charCodeAt(0);
  if (entry.target) writeString(header, 157, 100, entry.target);
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function writeString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = encoder.encode(value);
  if (bytes.byteLength > length) throw new Error("test TAR field is too long");
  target.set(bytes, offset);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  writeString(
    target,
    offset,
    length,
    `${value.toString(8).padStart(length - 2, "0")}\0`,
  );
}
