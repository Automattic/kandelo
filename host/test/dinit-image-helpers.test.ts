import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { findRepoRoot } from "../src/binary-resolver";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  addDinitBaseSystemFiles,
  addDinitInit,
} from "../../images/vfs/scripts/dinit-image-helpers";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../src/vfs/image-helpers";
import {
  derivePackageDeferredZipTree,
  registerPackageDeferredZipTree,
  type PackageDeferredZipTreeSpec,
} from "../src/vfs/package-deferred-tree";
import { loadShellBaseFileSystemFromImage } from "../../images/vfs/scripts/shell-vfs-build";
import { ABI_VERSION } from "../src/generated/abi";

const O_RDONLY = 0;
const encoder = new TextEncoder();
const DINIT_DEMO_CONFIG = '{"version":1,"profiles":{"dinit-fixture":{}}}\n';

// WHY: this suite owns the helper's fallback choice, while binary-resolver
// tests own artifact-policy and provenance validation. Substitute only the
// two already-accepted paths so this test does not duplicate that boundary.
const dinitResolverFixture = vi.hoisted(() => ({
  artifacts: new Map<string, string>(),
}));

vi.mock("../src/binary-resolver", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/binary-resolver")>();
  return {
    ...actual,
    tryResolveBinary: (path: string) =>
      dinitResolverFixture.artifacts.get(path) ?? null,
  };
});

function readGuestBytes(fs: MemoryFileSystem, path: string): Uint8Array {
  const size = fs.stat(path).size;
  const fd = fs.open(path, O_RDONLY, 0);
  try {
    const bytes = new Uint8Array(size);
    const count = fs.read(fd, bytes, null, bytes.byteLength);
    return bytes.subarray(0, count);
  } finally {
    fs.close(fd);
  }
}

function readGuestFile(fs: MemoryFileSystem, path: string): string {
  return new TextDecoder().decode(readGuestBytes(fs, path));
}

function createFs(): MemoryFileSystem {
  return MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
}

function deferredDinitTree(
  mountPrefix: string,
  id: string,
): ReturnType<typeof derivePackageDeferredZipTree> {
  const archive = zipSync({
    dinitctl: [
      encoder.encode("deferred dinitctl"),
      { os: 3, attrs: (0o100755 << 16) >>> 0 },
    ],
  } satisfies Zippable);
  const spec = {
    schema: 1,
    kind: "kandelo-package-deferred-zip-tree",
    id,
    content_role: "runtime-tree",
    package: {
      name: "dinit-fixture",
      output: "dinit-fixture.zip",
    },
    archive: {
      url: "dinit-fixture.zip",
      mode_policy: "portable-posix-v1",
    },
    mount_prefix: mountPrefix,
    owner: {
      uid: 0,
      gid: 0,
    },
    activation: {
      mode: "first-use",
      capabilities: ["service-supervisor:dinit"],
      roots: [`${mountPrefix}/dinitctl`],
    },
  } as const satisfies PackageDeferredZipTreeSpec;
  return derivePackageDeferredZipTree(spec, archive);
}

describe("dinit-derived image system databases", () => {
  it("copies the authoritative rootfs services database without reducing aliases", () => {
    const fs = createFs();
    addDinitBaseSystemFiles(fs);

    const source = readFileSync(
      join(findRepoRoot(), "images", "rootfs", "etc", "services"),
      "utf8",
    );
    const derived = readGuestFile(fs, "/etc/services");

    expect(derived).toBe(source);
    expect(derived).toContain("www www-http");
    expect(derived).toContain("postgresql\t5432/tcp");
  });
});

describe("dinit-derived image binary ownership", () => {
  it("installs exact staged Dinit bytes and preserves the base services database", () => {
    const fs = createFs();
    ensureDirRecursive(fs, "/etc");
    writeVfsFile(fs, "/etc/services", "exact base services\n");

    addDinitInit(fs, [], {
      binaries: {
        dinit: encoder.encode("exact dinit"),
        dinitctl: encoder.encode("exact dinitctl"),
      },
    });

    expect(readGuestFile(fs, "/sbin/dinit")).toBe("exact dinit");
    expect(readGuestFile(fs, "/sbin/dinitctl")).toBe("exact dinitctl");
    expect(readGuestFile(fs, "/etc/services")).toBe("exact base services\n");
  });

  it("rejects an exact staged service image whose base omits /etc/services", () => {
    const fs = createFs();
    expect(() => addDinitInit(fs, [], {
      binaries: {
        dinit: encoder.encode("exact dinit"),
        dinitctl: encoder.encode("exact dinitctl"),
      },
    })).toThrow(
      "exact service-image composition requires /etc/services from its base product",
    );
  });

  it("inherits the complete resident Dinit set from the canonical shell", () => {
    const fs = createFs();
    ensureDirRecursive(fs, "/sbin");
    writeVfsBinary(fs, "/sbin/dinit", new TextEncoder().encode("base dinit"));
    writeVfsBinary(
      fs,
      "/sbin/dinitctl",
      new TextEncoder().encode("base dinitctl"),
    );

    addDinitInit(fs, [
      {
        name: "service",
        type: "internal",
      },
    ]);

    expect(readGuestFile(fs, "/sbin/dinit")).toBe("base dinit");
    expect(readGuestFile(fs, "/sbin/dinitctl")).toBe("base dinitctl");
    expect(readGuestFile(fs, "/etc/dinit.d/service")).toContain(
      "type = internal",
    );
  });

  it("rejects a partially inherited Dinit set instead of mixing provenance", () => {
    const fs = createFs();
    ensureDirRecursive(fs, "/sbin");
    writeVfsBinary(fs, "/sbin/dinit", new TextEncoder().encode("base dinit"));

    expect(() => addDinitInit(fs, [])).toThrow(
      "the shell base contains an incomplete resident Dinit binary set",
    );
  });

  it("rejects lazy Dinit executables because service boot always needs them", () => {
    const fs = createFs();
    fs.registerLazyFile("/sbin/dinit", "https://example.test/dinit", 100);
    fs.registerLazyFile("/sbin/dinitctl", "https://example.test/dinitctl", 100);

    expect(() => addDinitInit(fs, [])).toThrow(
      "/sbin/dinit is lazy, but Dinit must be resident before service boot",
    );
  });

  it("installs the legacy resolver pair only when both shell paths are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-dinit-resolver-"));
    const expectedDinit = encoder.encode("legacy dinit");
    const expectedDinitctl = encoder.encode("legacy dinitctl");
    const dinit = join(root, "dinit.wasm");
    const dinitctl = join(root, "dinitctl.wasm");
    writeFileSync(dinit, expectedDinit);
    writeFileSync(dinitctl, expectedDinitctl);
    dinitResolverFixture.artifacts.set("programs/dinit/dinit.wasm", dinit);
    dinitResolverFixture.artifacts.set(
      "programs/dinit/dinitctl.wasm",
      dinitctl,
    );

    try {
      const fs = createFs();
      addDinitInit(fs, []);

      expect(readGuestBytes(fs, "/sbin/dinit")).toEqual(expectedDinit);
      expect(readGuestBytes(fs, "/sbin/dinitctl")).toEqual(expectedDinitctl);
    } finally {
      dinitResolverFixture.artifacts.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects any non-executable member of a complete pair", () => {
    const fs = createFs();
    ensureDirRecursive(fs, "/sbin");
    writeVfsBinary(fs, "/sbin/dinit", encoder.encode("resident dinit"));
    writeVfsFile(fs, "/sbin/dinitctl", "not executable", 0o644);

    expect(() => addDinitInit(fs, [])).toThrow(
      "/sbin/dinitctl exists in the shell base but is not a regular executable",
    );
  });

  it("rejects a typed deferred Dinit tree", () => {
    const fs = createFs();
    registerPackageDeferredZipTree(
      fs,
      deferredDinitTree("/sbin", "test/deferred-dinit"),
    );
    writeVfsBinary(fs, "/sbin/dinit", encoder.encode("resident dinit"));

    expect(() => addDinitInit(fs, [])).toThrow(
      "/sbin/dinitctl is deferred, but Dinit must be resident in a service image",
    );
  });

  it("follows aliases and rejects a symlink to a lazy Dinit target", () => {
    const fs = createFs();
    ensureDirRecursive(fs, "/opt/dinit/bin");
    ensureDirRecursive(fs, "/sbin");
    writeVfsBinary(fs, "/sbin/dinit", encoder.encode("resident dinit"));
    fs.registerLazyFile(
      "/opt/dinit/bin/dinitctl",
      "https://example.test/dinitctl",
      100,
    );
    fs.symlink("/opt/dinit/bin/dinitctl", "/sbin/dinitctl");

    expect(() => addDinitInit(fs, [])).toThrow(
      "/sbin/dinitctl is lazy, but Dinit must be resident before service boot",
    );
  });

  it("preserves resident Dinit through canonical shell-derived composition", async () => {
    const shell = createFs();
    ensureDirRecursive(shell, "/sbin");
    ensureDirRecursive(shell, "/etc/kandelo");
    writeVfsBinary(shell, "/sbin/dinit", encoder.encode("bottled dinit"));
    writeVfsBinary(shell, "/sbin/dinitctl", encoder.encode("bottled dinitctl"));
    writeVfsFile(shell, "/etc/kandelo/demo.json", DINIT_DEMO_CONFIG);
    shell.setImageMetadata({
      version: 1,
      kernelAbi: ABI_VERSION,
      createdBy: "dinit-image-helpers.test/shell-fixture",
      capacity: {
        maxByteLength: shell.statfs("/").blocks * shell.statfs("/").bsize,
      },
      baseImage: {
        sha256: "a".repeat(64),
        bytes: 1,
        kernelAbi: ABI_VERSION,
      },
      packageDeferredTrees: [],
      homebrewBootstrap: {
        entrypoint: "/usr/bin/brew",
        prefix: "/opt/kandelo/homebrew",
      },
      homebrew: {
        tapRepository: "Kandelo-dev/homebrew-tap-core",
        tapName: "Kandelo-dev/tap-core",
        tapCommit: "b".repeat(40),
        demoConfig: {
          path: "/etc/kandelo/demo.json",
          sha256: createHash("sha256")
            .update(DINIT_DEMO_CONFIG)
            .digest("hex"),
          bytes: encoder.encode(DINIT_DEMO_CONFIG).byteLength,
        },
      },
    });
    const shellImage = await shell.saveImage();
    const shellCapacity =
      MemoryFileSystem.readImageCapacity(shellImage).maxByteLength;
    const derived = await loadShellBaseFileSystemFromImage(
      shellImage,
      shellCapacity,
    );

    addDinitInit(derived, [
      {
        name: "service",
        type: "internal",
      },
    ]);

    expect(readGuestFile(derived, "/sbin/dinit")).toBe("bottled dinit");
    expect(readGuestFile(derived, "/sbin/dinitctl")).toBe("bottled dinitctl");
    expect(readGuestFile(derived, "/etc/dinit.d/service")).toContain(
      "type = internal",
    );
  });

  it("rejects an unversioned shell fixture before derived composition", async () => {
    const shell = createFs();
    ensureDirRecursive(shell, "/sbin");
    writeVfsBinary(shell, "/sbin/dinit", encoder.encode("bottled dinit"));
    writeVfsBinary(shell, "/sbin/dinitctl", encoder.encode("bottled dinitctl"));
    const shellImage = await shell.saveImage();

    await expect(
      loadShellBaseFileSystemFromImage(
        shellImage,
        MemoryFileSystem.readImageCapacity(shellImage).maxByteLength,
      ),
    ).rejects.toThrow("shell base image omits its required kernel ABI");
  });
});
