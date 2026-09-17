import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { createHash } from "node:crypto";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { parseZipCentralDirectory } from "../src/vfs/zip";
import { findRepoRoot } from "../src/binary-resolver";
import {
  addDinitBaseSystemFiles,
  addDinitInit,
} from "../../images/vfs/scripts/dinit-image-helpers";
import {
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../src/vfs/image-helpers";
import { loadShellBaseFileSystemFromImage } from "../../images/vfs/scripts/package-shell-vfs-build";
import { ABI_VERSION } from "../src/generated/abi";
import { EXPERIMENTAL_TERMINAL_SESSION_PATH } from "../../web-libs/kandelo-session/src/experimental-terminal-session";

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

function readGuestBytes(fs: KandeloImageFs, path: string): Uint8Array {
  return fs.readFile(path);
}

function readGuestFile(fs: KandeloImageFs, path: string): string {
  return new TextDecoder().decode(readGuestBytes(fs, path));
}

// The fixture is the producer that ships: `loadShellBaseFileSystemFromImage`
// already RETURNS a `KandeloImageFs`, so the shell image this suite composes
// from was the only thing still built by the filesystem being deleted — and a
// derived composition that worked only over the legacy writer's output would
// have passed here and failed in every builder.
function createFs(): KandeloImageFs {
  return KandeloImageFs.create();
}

/**
 * Make `<mountPrefix>/dinitctl` DEFERRED, which is the whole of what this
 * fixture owes.
 *
 * It used to go through `derivePackageDeferredZipTree` +
 * `registerPackageDeferredZipTree`, carrying a spec with an activation mode,
 * capabilities and roots. None of that reached the assertion: `addDinitInit`
 * asks `getLazyEntry(path) !== null || isPathDeferred(path)` and refuses, and
 * a deferred archive member answers that question by itself. The spec was
 * scaffolding around a one-bit fact.
 */
function registerDeferredDinit(fs: KandeloImageFs, mountPrefix: string): void {
  const archive = zipSync({
    dinitctl: [
      encoder.encode("deferred dinitctl"),
      { os: 3, attrs: (0o100755 << 16) >>> 0 },
    ],
  } satisfies Zippable);
  fs.registerLazyArchive({
    url: "dinit-fixture.zip",
    entries: parseZipCentralDirectory(archive),
    mountPrefix,
    integrity: {
      sha256: createHash("sha256").update(archive).digest("hex"),
      bytes: archive.byteLength,
    },
  });
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
  it("installs the exact declared services database for a standalone image", () => {
    const fs = createFs();
    addDinitInit(fs, [], {
      binaries: {
        dinit: encoder.encode("exact dinit"),
        dinitctl: encoder.encode("exact dinitctl"),
      },
      services: encoder.encode("exact standalone services\n"),
    });

    expect(readGuestFile(fs, "/etc/services")).toBe(
      "exact standalone services\n",
    );
  });

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
    // The parent first: `registerLazyFile` on the module does NOT create one,
    // where the filesystem it replaces did. That leniency difference is the
    // documented seam between the two producers, and it is the fixture's to
    // pay rather than the module's to adopt — a producer that invents
    // directories is a producer that can put a file somewhere nobody asked
    // for.
    ensureDirRecursive(fs, "/sbin");
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
    // Built by `KandeloImageFs` rather than `createFs()`: this is the one case
    // in the file that needs a DEFERRED path, and the deferred registration
    // that survives `memory-fs.ts` is the bridge's. What is under test --
    // `addDinitInit` refusing a deferred dinitctl -- is unchanged, and it takes
    // `VfsImageFilesystem`, which both producers satisfy.
    const fs = KandeloImageFs.create();
    registerDeferredDinit(fs, "/sbin");
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
    ensureDirRecursive(shell, "/usr/bin");
    writeVfsBinary(shell, "/sbin/dinit", encoder.encode("package dinit"));
    writeVfsBinary(shell, "/sbin/dinitctl", encoder.encode("package dinitctl"));
    writeVfsBinary(shell, "/usr/bin/login", encoder.encode("package login"), 0o4755);
    writeVfsFile(
      shell,
      EXPERIMENTAL_TERMINAL_SESSION_PATH,
      JSON.stringify({
        kind: "kandelo-experimental-terminal-session",
        version: 1,
        initial: {
          path: "/usr/bin/login",
          argv: ["login", "-p", "-f", "maker"],
          uid: 0,
          gid: 0,
        },
      }),
    );
    writeVfsFile(shell, "/etc/kandelo/demo.json", DINIT_DEMO_CONFIG);
    shell.setImageMetadata({
      version: 1,
      kernelAbi: ABI_VERSION,
      createdBy: "dinit-image-helpers.test/shell-fixture",
      capacity: {
        // ASKED OF THE PRODUCER, not computed from block arithmetic. This
        // multiplied `statfs` blocks by a block size, which is how capacity
        // was derived while it was an ALLOCATION over a `SharedArrayBuffer`.
        // It is a declared ceiling now, and the module is the thing that
        // declares it into the image this fixture is about to export.
        maxByteLength: shell.exportCapacityBytes(),
      },
      baseImage: {
        sha256: "a".repeat(64),
        bytes: 1,
        kernelAbi: ABI_VERSION,
      },
      shellComposition: {
        schema: 1,
        kind: "package-rootfs-shell",
      },
    });
    const shellImage = await shell.saveImage();
    const shellCapacity =
      KandeloImageFs.readImageCapacity(shellImage).maxByteLength;
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

    expect(readGuestFile(derived, "/sbin/dinit")).toBe("package dinit");
    expect(readGuestFile(derived, "/sbin/dinitctl")).toBe("package dinitctl");
    expect(readGuestFile(derived, "/etc/dinit.d/service")).toContain(
      "type = internal",
    );
  });

  it("rejects an unversioned shell fixture before derived composition", async () => {
    const shell = createFs();
    ensureDirRecursive(shell, "/sbin");
    writeVfsBinary(shell, "/sbin/dinit", encoder.encode("package dinit"));
    writeVfsBinary(shell, "/sbin/dinitctl", encoder.encode("package dinitctl"));
    const shellImage = await shell.saveImage();

    await expect(
      loadShellBaseFileSystemFromImage(
        shellImage,
        KandeloImageFs.readImageCapacity(shellImage).maxByteLength,
      ),
    ).rejects.toThrow("package shell base image has invalid metadata");
  });
});
