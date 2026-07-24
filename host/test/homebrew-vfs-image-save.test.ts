import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zipSync, type Zippable } from "fflate";
import {
  assertHomebrewBootstrapConsumerState,
  installHomebrewBootstrapConsumerState,
  prepareHomebrewBootstrapConsumerNamespace,
  readHomebrewBootstrapEnvironment,
  saveVerifiedHomebrewVfsImage,
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

const MiB = 1024 * 1024;
const encoder = new TextEncoder();
const bootstrapEnvironment = encoder.encode(
  "HOMEBREW_NO_ANALYTICS=1\n" +
    "HOMEBREW_NO_AUTO_UPDATE=1\n" +
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
  mount_prefix: "/home/linuxbrew/.linuxbrew",
  owner: { uid: 1000, gid: 1000 },
  activation: {
    mode: "first-use",
    capabilities: ["homebrew:bootstrap"],
    roots: ["/home/linuxbrew/.linuxbrew/bin/brew"],
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
        restored.lstat("/home/linuxbrew/.linuxbrew/Cellar/existing/1/bin/tool"),
      ).toMatchObject({ uid: 1000, gid: 1000 });
      expect(restored.lstat("/etc/homebrew/brew.env")).toMatchObject({
        mode: expect.any(Number),
        uid: 0,
        gid: 0,
      });
      expect(restored.readlink("/usr/bin/brew")).toBe(
        "/home/linuxbrew/.linuxbrew/bin/brew",
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
    danglingFs.unlink("/home/linuxbrew/.linuxbrew/bin/brew");
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
        fs.unlink("/home/linuxbrew/.linuxbrew/bin/brew");
        break;
      case "prefix-owner":
        fs.chown("/home/linuxbrew/.linuxbrew", 0, 0);
        break;
      case "cache-owner":
        fs.chown("/home/user/.cache/Homebrew", 0, 0);
        break;
    }

    expect(() => assertHomebrewBootstrapConsumerState(fs, consumer)).toThrow();
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
    "/home",
    "/home/linuxbrew",
    "/home/linuxbrew/.linuxbrew",
    "/home/linuxbrew/.linuxbrew/bin",
    "/home/linuxbrew/.linuxbrew/Cellar",
    "/home/linuxbrew/.linuxbrew/Cellar/existing",
    "/home/linuxbrew/.linuxbrew/Cellar/existing/1",
    "/home/linuxbrew/.linuxbrew/Cellar/existing/1/bin",
    "/home/user",
    "/usr",
    "/usr/bin",
    "/etc",
  ]) {
    fs.mkdir(path, 0o755);
  }
  writeVfsBinary(
    fs,
    "/home/linuxbrew/.linuxbrew/Cellar/existing/1/bin/tool",
    encoder.encode("tool\n"),
    0o755,
  );
  return fs;
}
