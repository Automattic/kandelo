import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zipSync, type Zippable } from "fflate";
import {
  assertHomebrewBootstrapConsumerState,
  installHomebrewBootstrapConsumerState,
  prepareHomebrewBootstrapConsumerNamespace,
} from "../src/homebrew-bootstrap-consumer";
import {
  readHomebrewBootstrapEnvironment,
  restoreVerifiedHomebrewBaseImage,
  saveVerifiedHomebrewVfsImage,
  serializeVerifiedHomebrewVfsImage,
} from "../../images/vfs/scripts/build-homebrew-vfs-image";
import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
  materializePackageDeferredZipTree,
  registerPackageDeferredZipTree,
  type PackageDeferredZipTreeSpec,
} from "../src/vfs/package-deferred-tree";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { writeVfsBinary } from "../src/vfs/image-helpers";
import {
  addSealedLazyAtomicTestTree,
  forgeLazyAtomicSeal,
} from "./lazy-atomic-seal-fixture";

const MiB = 1024 * 1024;
const encoder = new TextEncoder();
const bootstrapEnvironment = encoder.encode(
  "HOMEBREW_NO_ANALYTICS=1\n" +
    "HOMEBREW_NO_AUTO_UPDATE=1\n" +
    "HOMEBREW_NO_INSTALL_FROM_API=1\n" +
    "HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1\n" +
    "HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1\n" +
    "HOMEBREW_KANDELO_BOTTLE_TAG=wasm32_kandelo\n",
);
const bootstrapSpec = {
  schema: 1,
  kind: "kandelo-package-deferred-zip-tree",
  id: "homebrew-bootstrap/source-tree",
  content_role: "source-tree",
  package: { name: "homebrew-bootstrap", output: "homebrew-bootstrap.zip" },
  archive: {
    url: "homebrew-bootstrap.zip",
    mode_policy: "portable-posix-v1",
  },
  mount_prefix: "/opt/kandelo/homebrew",
  owner: { uid: 1000, gid: 1000 },
  activation: {
    mode: "first-use",
    capabilities: ["homebrew:bootstrap"],
    roots: ["/opt/kandelo/homebrew/bin/brew"],
  },
} as const satisfies PackageDeferredZipTreeSpec;

describe("Homebrew VFS image publication boundary", () => {
  it.each(["deferred", "materialized"] as const)(
    "adopts a real bottle prefix for a %s package source tree and survives serialization",
    async (state) => {
      const archive = bootstrapArchive(true);
      const derived = derivePackageDeferredZipTree(bootstrapSpec, archive);
      const fs = bootstrapConsumerFs();

      expect(() => registerPackageDeferredZipTree(fs, derived)).toThrow(
        "collides with the base",
      );
      prepareHomebrewBootstrapConsumerNamespace(fs, derived);
      const registered = registerPackageDeferredZipTree(fs, derived);
      if (state === "materialized") {
        await materializePackageDeferredZipTree(fs, registered, archive);
      }
      const consumer = installHomebrewBootstrapConsumerState(
        fs,
        derived,
        bootstrapEnvironment,
      );
      assertPackageDeferredZipTreeState(fs, derived, state);
      assertHomebrewBootstrapConsumerState(fs, consumer);

      const restored = MemoryFileSystem.fromImagePreservingCapacity(
        await fs.saveImage(),
      );
      assertPackageDeferredZipTreeState(restored, derived, state);
      assertHomebrewBootstrapConsumerState(restored, consumer);
      expect(
        restored.lstat("/opt/kandelo/homebrew/Cellar/existing/1/bin/tool"),
      ).toMatchObject({ uid: 1000, gid: 1000 });
      expect(restored.lstat("/etc/homebrew/brew.env")).toMatchObject({
        mode: expect.any(Number),
        uid: 0,
        gid: 0,
      });
      expect(restored.readlink("/usr/bin/brew")).toBe(
        "/opt/kandelo/homebrew/bin/brew",
      );
    },
  );

  it("materializes the source tree through the public /usr/bin/brew alias", async () => {
    const archive = bootstrapArchive(true);
    const derived = derivePackageDeferredZipTree(bootstrapSpec, archive);
    const fs = bootstrapConsumerFs();
    prepareHomebrewBootstrapConsumerNamespace(fs, derived);
    registerPackageDeferredZipTree(fs, derived);
    installHomebrewBootstrapConsumerState(fs, derived, bootstrapEnvironment);
    let fetchCount = 0;
    fs.setLazyFetcher(async (url) => {
      fetchCount += 1;
      expect(url).toBe("homebrew-bootstrap.zip");
      return new Response(archive, {
        headers: { "content-length": String(archive.byteLength) },
      });
    });

    expect(fs.isPathDeferred("/usr/bin/brew")).toBe(true);
    await expect(fs.preparePath("/usr/bin/brew")).resolves.toBe(true);
    expect(fetchCount).toBe(1);
    expect(fs.isPathDeferred("/usr/bin/brew")).toBe(false);
    assertPackageDeferredZipTreeState(fs, derived, "materialized");

    await expect(fs.preparePath("/usr/bin/brew")).resolves.toBe(false);
    expect(fetchCount).toBe(1);
  });

  it("rejects a missing or dangling Homebrew entrypoint and a changed launcher policy", () => {
    const incomplete = derivePackageDeferredZipTree(
      bootstrapSpec,
      bootstrapArchive(false),
    );
    const incompleteFs = bootstrapConsumerFs();
    prepareHomebrewBootstrapConsumerNamespace(incompleteFs, incomplete);
    expect(() =>
      registerPackageDeferredZipTree(incompleteFs, incomplete),
    ).toThrow("activation root");

    const valid = derivePackageDeferredZipTree(
      bootstrapSpec,
      bootstrapArchive(true),
    );
    const danglingFs = bootstrapConsumerFs();
    prepareHomebrewBootstrapConsumerNamespace(danglingFs, valid);
    registerPackageDeferredZipTree(danglingFs, valid);
    danglingFs.unlink("/opt/kandelo/homebrew/bin/brew");
    expect(() =>
      installHomebrewBootstrapConsumerState(
        danglingFs,
        valid,
        bootstrapEnvironment,
      ),
    ).toThrow("canonical deferred source tree");

    const directory = mkdtempSync(join(tmpdir(), "homebrew-bootstrap-env-"));
    try {
      const valid = join(directory, "brew.env");
      const changed = join(directory, "changed.env");
      writeFileSync(valid, bootstrapEnvironment);
      writeFileSync(
        changed,
        new TextEncoder().encode(
          "HOMEBREW_NO_ANALYTICS=1\n" +
            "HOMEBREW_NO_AUTO_UPDATE=1\n" +
            "HOMEBREW_NO_INSTALL_FROM_API=1\n" +
            "HOMEBREW_AUTOMATICALLY_SET_NO_INSTALL_FROM_API=1\n" +
            "HOMEBREW_SYSTEM_ENV_TAKES_PRIORITY=1\n" +
            "HOMEBREW_KANDELO_BOTTLE_TAG=wasm64_kandelo\n",
        ),
      );
      expect(readHomebrewBootstrapEnvironment(valid, "wasm32")).toEqual(
        bootstrapEnvironment,
      );
      expect(() => readHomebrewBootstrapEnvironment(changed, "wasm32")).toThrow(
        "does not select wasm32_kandelo",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["environment", "entrypoint"] as const)(
    "does not replace pre-existing Homebrew %s state",
    (kind) => {
      const tree = derivePackageDeferredZipTree(
        bootstrapSpec,
        bootstrapArchive(true),
      );
      const fs = bootstrapConsumerFs();
      prepareHomebrewBootstrapConsumerNamespace(fs, tree);
      registerPackageDeferredZipTree(fs, tree);
      if (kind === "environment") {
        fs.mkdir("/etc/homebrew", 0o755);
        writeVfsBinary(
          fs,
          "/etc/homebrew/brew.env",
          encoder.encode("existing\n"),
          0o644,
        );
      } else {
        writeVfsBinary(
          fs,
          "/usr/bin/brew",
          encoder.encode("existing\n"),
          0o755,
        );
      }
      expect(() =>
        installHomebrewBootstrapConsumerState(fs, tree, bootstrapEnvironment),
      ).toThrow("refusing to replace Homebrew bootstrap consumer state");
    },
  );

  it.each([
    "environment",
    "entrypoint",
    "target",
    "prefix-owner",
    "cache-owner",
  ] as const)("detects %s drift after installation", (kind) => {
    const tree = derivePackageDeferredZipTree(
      bootstrapSpec,
      bootstrapArchive(true),
    );
    const fs = bootstrapConsumerFs();
    prepareHomebrewBootstrapConsumerNamespace(fs, tree);
    registerPackageDeferredZipTree(fs, tree);
    const consumer = installHomebrewBootstrapConsumerState(
      fs,
      tree,
      bootstrapEnvironment,
    );

    switch (kind) {
      case "environment":
        fs.unlink("/etc/homebrew/brew.env");
        writeVfsBinary(
          fs,
          "/etc/homebrew/brew.env",
          encoder.encode("changed\n"),
          0o644,
        );
        break;
      case "entrypoint":
        fs.unlink("/usr/bin/brew");
        fs.symlink("/wrong/brew", "/usr/bin/brew");
        break;
      case "target":
        fs.unlink("/opt/kandelo/homebrew/bin/brew");
        break;
      case "prefix-owner":
        fs.chown("/opt/kandelo/homebrew", 0, 0);
        break;
      case "cache-owner":
        fs.chown("/home/user/.cache/Homebrew", 0, 0);
        break;
    }

    expect(() => assertHomebrewBootstrapConsumerState(fs, consumer)).toThrow();
  });

  it("restores a platform-only base image with exact ABI and capacity", async () => {
    const fs = bootstrapConsumerFs();
    fs.setImageMetadata({ version: 1, kernelAbi: 42, createdBy: "base fixture" });
    const image = await fs.saveImage();

    const restored = await restoreVerifiedHomebrewBaseImage(image, "base fixture", 42);

    expect(restored.metadata).toEqual({
      version: 1,
      kernelAbi: 42,
      createdBy: "base fixture",
    });
    expect(restored.capacity).toEqual(MemoryFileSystem.readImageCapacity(image));
    expect(restored.bytes).toBe(image.byteLength);
    expect(restored.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(
      restored.fs.stat("/opt/kandelo/homebrew/Cellar/existing/1/bin/tool"),
    ).toMatchObject({ size: encoder.encode("tool\n").byteLength });
  });

  it("snapshots caller-owned base bytes before asynchronous seal verification", async () => {
    const fs = bootstrapConsumerFs();
    fs.setImageMetadata({ version: 1, kernelAbi: 42 });
    const originalPayload = encoder.encode("base-image-snapshot-A\n");
    const replacementPayload = encoder.encode("base-image-snapshot-B\n");
    writeVfsBinary(fs, "/snapshot-proof", originalPayload, 0o644);
    const image = await fs.saveImage();
    const original = Uint8Array.from(image);
    const expectedSha256 = createHash("sha256").update(original).digest("hex");
    const payloadOffset = Buffer.from(image).indexOf(Buffer.from(originalPayload));
    expect(payloadOffset).toBeGreaterThanOrEqual(0);

    const pending = restoreVerifiedHomebrewBaseImage(
      image,
      "mutable base fixture",
      42,
    );
    image.set(replacementPayload, payloadOffset);
    const restored = await pending;

    expect(readVfsText(restored.fs, "/snapshot-proof")).toBe(
      "base-image-snapshot-A\n",
    );
    expect(restored.sha256).toBe(expectedSha256);
    expect(restored.bytes).toBe(original.byteLength);
    expect(restored.capacity).toEqual(
      MemoryFileSystem.readImageCapacity(original),
    );
  });

  it.each(["member", "cohort"] as const)(
    "rejects a forged imported lazy atomic %s seal",
    async (forgery) => {
      const fs = bootstrapConsumerFs();
      fs.setImageMetadata({ version: 1, kernelAbi: 42 });
      await addSealedLazyAtomicTestTree(fs, {
        groupId: `test:homebrew-base-${forgery}`,
        member: "runtime",
        root: `/sealed-homebrew-base-${forgery}`,
      });
      const forged = forgeLazyAtomicSeal(await fs.saveImage(), forgery);

      await expect(
        restoreVerifiedHomebrewBaseImage(
          forged,
          `forged ${forgery} base fixture`,
          42,
        ),
      ).rejects.toThrow(
        forgery === "member"
          ? /activation member .* changed after sealing/
          : /activation group .* differs from its seal/,
      );
    },
  );

  it("rejects missing or wrong base ABI and an existing Homebrew composition", async () => {
    const missingAbi = bootstrapConsumerFs();
    missingAbi.setImageMetadata({ version: 1 });
    await expect(
      restoreVerifiedHomebrewBaseImage(
        await missingAbi.saveImage(),
        "missing ABI fixture",
        42,
      ),
    ).rejects.toThrow(/does not declare its required kernel ABI/);

    const wrongAbi = bootstrapConsumerFs();
    wrongAbi.setImageMetadata({ version: 1, kernelAbi: 41 });
    await expect(
      restoreVerifiedHomebrewBaseImage(
        await wrongAbi.saveImage(),
        "wrong ABI fixture",
        42,
      ),
    ).rejects.toThrow(/declares kernel ABI 41.*requires ABI 42/);

    const composed = bootstrapConsumerFs();
    composed.setImageMetadata({ version: 1, kernelAbi: 42 });
    ensureVfsDirectory(composed, "/etc/kandelo");
    writeVfsBinary(
      composed,
      "/etc/kandelo/homebrew-vfs.json",
      encoder.encode("{}\n"),
      0o644,
    );
    await expect(
      restoreVerifiedHomebrewBaseImage(
        await composed.saveImage(),
        "composed fixture",
        42,
      ),
    ).rejects.toThrow(/already contains a Homebrew composition/);
  });

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

      expect(MemoryFileSystem.readImageCapacity(image).maxByteLength).toBe(
        maxByteLength,
      );
      expect(existsSync(outFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("materializes pending bytes before validating a self-contained serialization", async () => {
    const maxByteLength = 8 * MiB;
    const fs = MemoryFileSystem.create(
      new SharedArrayBuffer(1 * MiB, { maxByteLength }),
      maxByteLength,
    );
    const payload = encoder.encode("eager\n");
    fs.registerLazyFile(
      "/usr/share/materialize-all.txt",
      "https://example.invalid/materialize-all.txt",
      payload.byteLength,
      0o644,
    );
    let fetchCount = 0;
    fs.setLazyFetcher(async () => {
      fetchCount += 1;
      return new Response(payload, {
        headers: { "content-length": String(payload.byteLength) },
      });
    });

    const serialized = await serializeVerifiedHomebrewVfsImage(
      fs,
      "self-contained.vfs.zst",
      {
        materializeAll: true,
        metadata: { version: 1, kernelAbi: 42 },
        normalizeTimestampsMs: 0,
      },
      maxByteLength,
    );
    const restored = MemoryFileSystem.fromImagePreservingCapacity(
      serialized.bytes,
    );

    expect(fetchCount).toBe(1);
    expect(restored.exportLazyEntries()).toEqual([]);
    expect(restored.exportLazyArchiveEntries()).toEqual([]);
    expect(restored.stat("/usr/share/materialize-all.txt").size).toBe(
      payload.byteLength,
    );
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

function bootstrapArchive(includeBrew: boolean): Uint8Array {
  const entries: Zippable = {
    "bin/": zipEntry(new Uint8Array(), 0o040755),
    "Library/": zipEntry(new Uint8Array(), 0o040755),
    "Library/Homebrew/": zipEntry(new Uint8Array(), 0o040755),
    "Library/Homebrew/global.rb": zipEntry(
      encoder.encode("GLOBAL = true\n"),
      0o100644,
    ),
  };
  if (includeBrew) {
    entries["bin/brew"] = zipEntry(encoder.encode("#!/bin/bash\n"), 0o100755);
  }
  return zipSync(entries, { level: 9 });
}

function zipEntry(bytes: Uint8Array, mode: number): Zippable[string] {
  return [bytes, { os: 3, attrs: (mode << 16) >>> 0 }];
}

function bootstrapConsumerFs(): MemoryFileSystem {
  const fs = MemoryFileSystem.create(
    new SharedArrayBuffer(8 * MiB, { maxByteLength: 32 * MiB }),
    32 * MiB,
  );
  for (const path of [
    "/opt",
    "/opt/kandelo",
    "/opt/kandelo/homebrew",
    "/opt/kandelo/homebrew/bin",
    "/opt/kandelo/homebrew/Cellar",
    "/opt/kandelo/homebrew/Cellar/existing",
    "/opt/kandelo/homebrew/Cellar/existing/1",
    "/opt/kandelo/homebrew/Cellar/existing/1/bin",
    "/home",
    "/home/user",
    "/usr",
    "/usr/bin",
    "/etc",
  ]) {
    fs.mkdir(path, 0o755);
  }
  writeVfsBinary(
    fs,
    "/opt/kandelo/homebrew/Cellar/existing/1/bin/tool",
    encoder.encode("tool\n"),
    0o755,
  );
  return fs;
}

function ensureVfsDirectory(fs: MemoryFileSystem, path: string): void {
  const components = path.split("/").filter(Boolean);
  let current = "";
  for (const component of components) {
    current += `/${component}`;
    try {
      fs.mkdir(current, 0o755);
    } catch {
      // Fixture ancestors may already exist.
    }
  }
}

function readVfsText(fs: MemoryFileSystem, path: string): string {
  const size = fs.stat(path).size;
  const bytes = new Uint8Array(size);
  const descriptor = fs.open(path, 0, 0);
  try {
    const count = fs.read(descriptor, bytes, null, bytes.byteLength);
    if (count !== bytes.byteLength) {
      throw new Error(`incomplete VFS fixture read for ${path}`);
    }
    return new TextDecoder().decode(bytes);
  } finally {
    fs.close(descriptor);
  }
}
