import { describe, expect, it } from "vitest";

import {
  descriptorMaterializationPackage,
  prepareHomebrewKeg,
  type PreparedHomebrewKeg,
} from "../src/homebrew-vfs-materializer";
import {
  finalizeHomebrewRuntimeSupport,
  overlayPreparedHomebrewRuntimeSupport,
  prepareHomebrewRuntimeSupport,
} from "../src/homebrew-runtime-support-materializer";
import { buildHomebrewVfsSelection } from "../src/homebrew-vfs-builder";
import { planHomebrewVfsSelection } from "../src/homebrew-vfs-planner";
import { resolveHomebrewVfsResourcePolicy } from "../src/homebrew-vfs-resource-policy";
import { ensureDirRecursive, writeVfsFile } from "../src/vfs/image-helpers";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import {
  assertPackageDeferredZipTreeState,
  derivePackageDeferredZipTree,
  registerPackageDeferredZipTree,
  type PackageDeferredZipTreeSpec,
} from "../src/vfs/package-deferred-tree";
import {
  HOMEBREW_TEST_PREFIX,
  homebrewTestBottleDescriptor,
  homebrewTestBottleEntry,
  homebrewTestBottleTar,
  homebrewTestBootstrapFixture,
  homebrewTestEnvironment,
  homebrewTestReceipt,
  homebrewTestRuntimeZip,
  homebrewTestSelectionBytes,
  homebrewTestZip,
} from "./fixtures/homebrew-flat-vfs";

const SUPPORT_LIMITS = resolveHomebrewVfsResourcePolicy(
  "kandelo-homebrew-vfs-generous-v1",
).supportZip;

describe("flat Homebrew runtime support", () => {
  it("replaces the exact deferred base /bin/bash alias with eager Homebrew Bash", async () => {
    const bootstrap = homebrewTestBootstrapFixture({
      zip: homebrewRuntimeZipWithBash(),
    });
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    baseFs.registerLazyFile(
      "/usr/bin/bash",
      "https://invalid.example/binaries/programs/wasm32/bash.wasm",
      1,
      0o755,
    );
    ensureDirRecursive(baseFs, "/bin");
    baseFs.symlink("/usr/bin/bash", "/bin/bash");

    const result = await buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes([bootstrap.descriptor])),
      { baseFs, loadBottleBytes: () => bootstrap.bottle },
    );

    expect(result.fs.readlink("/bin/bash")).toBe(`${HOMEBREW_TEST_PREFIX}/bin/bash`);
    expect(result.fs.lstat("/bin/bash")).toMatchObject({ uid: 0, gid: 0 });
    expect(result.fs.stat("/bin/bash").mode & 0o111).not.toBe(0);
    expect(result.fs.isPathDeferred("/bin/bash")).toBe(false);
    expect(result.fs.isPathDeferred("/usr/bin/bash")).toBe(true);
  });

  it("accepts an already-correct root-owned /bin/bash link", async () => {
    const bootstrap = homebrewTestBootstrapFixture({
      zip: homebrewRuntimeZipWithBash(),
    });
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    ensureDirRecursive(baseFs, "/bin");
    baseFs.symlinkWithOwner(`${HOMEBREW_TEST_PREFIX}/bin/bash`, "/bin/bash", 0, 0);

    const result = await buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes([bootstrap.descriptor])),
      { baseFs, loadBottleBytes: () => bootstrap.bottle },
    );

    expect(result.fs.readlink("/bin/bash")).toBe(`${HOMEBREW_TEST_PREFIX}/bin/bash`);
    expect(result.fs.lstat("/bin/bash")).toMatchObject({ uid: 0, gid: 0 });
    expect(result.fs.isPathDeferred("/bin/bash")).toBe(false);
  });

  it("rejects an already-correct /bin/bash link not owned by root", async () => {
    const bootstrap = homebrewTestBootstrapFixture({
      zip: homebrewRuntimeZipWithBash(),
    });
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    ensureDirRecursive(baseFs, "/bin");
    baseFs.symlinkWithOwner(
      `${HOMEBREW_TEST_PREFIX}/bin/bash`,
      "/bin/bash",
      1000,
      1000,
    );

    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes([bootstrap.descriptor])),
      { baseFs, loadBottleBytes: () => bootstrap.bottle },
    )).rejects.toThrow(/\/bin\/bash.*root-owned/i);
  });

  it("rejects a deferred /bin/bash alias other than the source-rootfs base transition", async () => {
    const bootstrap = homebrewTestBootstrapFixture({
      zip: homebrewRuntimeZipWithBash(),
    });
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    baseFs.registerLazyFile(
      "/usr/bin/other-bash",
      "https://invalid.example/binaries/programs/wasm32/other-bash.wasm",
      1,
      0o755,
    );
    ensureDirRecursive(baseFs, "/bin");
    baseFs.symlink("/usr/bin/other-bash", "/bin/bash");

    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes([bootstrap.descriptor])),
      { baseFs, loadBottleBytes: () => bootstrap.bottle },
    )).rejects.toThrow(/deferred.*\/bin\/bash.*conflicts/i);
  });

  it("rejects an arbitrary eager /bin/bash symlink", async () => {
    const bootstrap = homebrewTestBootstrapFixture();
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    ensureDirRecursive(baseFs, "/custom/bin");
    baseFs.createFileWithOwner(
      "/custom/bin/bash",
      0o755,
      0,
      0,
      new TextEncoder().encode("eager custom bash\n"),
    );
    ensureDirRecursive(baseFs, "/bin");
    baseFs.symlinkWithOwner("/custom/bin/bash", "/bin/bash", 0, 0);

    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes([bootstrap.descriptor])),
      { baseFs, loadBottleBytes: () => bootstrap.bottle },
    )).rejects.toThrow(/\/bin\/bash.*symlink.*conflicts/i);
  });

  it("rejects replacement when selected Homebrew Bash is not executable", async () => {
    const bootstrap = homebrewTestBootstrapFixture({
      zip: homebrewRuntimeZipWithBash(0o100644),
    });
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    baseFs.registerLazyFile(
      "/usr/bin/bash",
      "https://invalid.example/binaries/programs/wasm32/bash.wasm",
      1,
      0o755,
    );
    ensureDirRecursive(baseFs, "/bin");
    baseFs.symlink("/usr/bin/bash", "/bin/bash");

    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes([bootstrap.descriptor])),
      { baseFs, loadBottleBytes: () => bootstrap.bottle },
    )).rejects.toThrow(/selected Homebrew Bash.*executable regular file/i);
  });

  it("preserves an existing eager /bin/bash executable", async () => {
    const bootstrap = homebrewTestBootstrapFixture();
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    ensureDirRecursive(baseFs, "/bin");
    baseFs.createFileWithOwner(
      "/bin/bash",
      0o755,
      0,
      0,
      new TextEncoder().encode("eager base bash\n"),
    );

    const result = await buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes([bootstrap.descriptor])),
      { baseFs, loadBottleBytes: () => bootstrap.bottle },
    );

    expect(readFile(result.fs, "/bin/bash")).toEqual(
      new TextEncoder().encode("eager base bash\n"),
    );
    expect(result.fs.isPathDeferred("/bin/bash")).toBe(false);
  });

  it("eagerly activates the authenticated bootstrap tree and final guest state", async () => {
    const bootstrap = homebrewTestBootstrapFixture();
    const result = await buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes([bootstrap.descriptor])),
      { loadBottleBytes: () => bootstrap.bottle },
    );

    expect(result.fs.readlink("/usr/bin/brew")).toBe(
      "/opt/kandelo/homebrew/bin/brew",
    );
    expect(readFile(result.fs, "/etc/homebrew/brew.env")).toEqual(
      bootstrap.environment,
    );
    expect(readFile(result.fs, `${HOMEBREW_TEST_PREFIX}/bin/brew`)).toEqual(
      new TextEncoder().encode("#!/bin/sh\necho brew\n"),
    );
    expect(result.fs.lstat(`${HOMEBREW_TEST_PREFIX}/bin/brew`)).toMatchObject({
      mode: expect.any(Number),
      uid: 1000,
      gid: 1000,
    });
    expect(result.fs.stat(`${HOMEBREW_TEST_PREFIX}/bin/brew`).mode & 0o777).toBe(0o755);
    expect(result.fs.lstat(`${HOMEBREW_TEST_PREFIX}/Library`).mode & 0o777).toBe(0o755);
    expect(
      result.fs.lstat(`${HOMEBREW_TEST_PREFIX}/Library/Homebrew/global.rb`).mode & 0o777,
    ).toBe(0o644);
    expect(
      result.fs.lstat(`${HOMEBREW_TEST_PREFIX}/bin/homebrew-library`).mode & 0o777,
    ).toBe(0o777);
    expect(result.fs.readlink(`${HOMEBREW_TEST_PREFIX}/bin/homebrew-library`)).toBe(
      "../Library/Homebrew/",
    );
    for (const path of [
      `${HOMEBREW_TEST_PREFIX}/Cellar`,
      `${HOMEBREW_TEST_PREFIX}/Library/Taps`,
      `${HOMEBREW_TEST_PREFIX}/var/homebrew/linked`,
      `${HOMEBREW_TEST_PREFIX}/var/homebrew/locks`,
      "/home/user/.cache/Homebrew",
    ]) {
      const stat = result.fs.lstat(path);
      expect(stat, path).toMatchObject({ uid: 1000, gid: 1000 });
      expect(stat.mode & 0o777, path).toBe(0o755);
    }
    expect(result.fs.lstat("/etc/homebrew/brew.env")).toMatchObject({
      mode: expect.any(Number),
      uid: 0,
      gid: 0,
    });
    expect(result.fs.lstat("/etc/homebrew/brew.env").mode & 0o777).toBe(0o644);
    expect(result.fs.lstat("/usr/bin/brew")).toMatchObject({ uid: 0, gid: 0 });
    expect(result.fs.exportLazyArchiveEntries()).toEqual([]);
    expect(result.report.runtime_support).toBe("kandelo-homebrew-bootstrap-v1");
    expect(Object.keys(result.report)).not.toContain("runtime_support_state");
  });

  it("authenticates both declared outputs before interpreting them", () => {
    const fixture = homebrewTestBootstrapFixture();
    const preparedKeg = preparedBootstrap(fixture);

    const wrongDigest = structuredClone(fixture.descriptor);
    wrongDigest.supportOutputs[0]!.sha256 = "0".repeat(64);
    expect(() => prepareHomebrewRuntimeSupport(
      wrongDigest,
      preparedKeg,
      SUPPORT_LIMITS,
    )).toThrow(/homebrew-bootstrap.*SHA-256.*does not match declared/i);

    const wrongSize = structuredClone(fixture.descriptor);
    wrongSize.supportOutputs[1]!.bytes += 1;
    expect(() => prepareHomebrewRuntimeSupport(
      wrongSize,
      preparedKeg,
      SUPPORT_LIMITS,
    )).toThrow(/homebrew-brew.*byte count.*does not match declared/i);

    const invalidEnvironment = new TextEncoder().encode(
      new TextDecoder().decode(homebrewTestEnvironment()).replace(
        "HOMEBREW_NO_AUTO_UPDATE=1\n",
        "",
      ),
    );
    const invalidFixture = homebrewTestBootstrapFixture({
      environment: invalidEnvironment,
    });
    expect(() => prepareHomebrewRuntimeSupport(
      invalidFixture.descriptor,
      preparedBootstrap(invalidFixture),
      SUPPORT_LIMITS,
    )).toThrow(/does not match the exact.*environment/i);

    const invalidZip = homebrewTestBootstrapFixture({
      zip: new Uint8Array([1, 2, 3, 4]),
    });
    invalidZip.descriptor.supportOutputs[0]!.sha256 = "f".repeat(64);
    expect(() => prepareHomebrewRuntimeSupport(
      invalidZip.descriptor,
      preparedBootstrap(invalidZip),
      SUPPORT_LIMITS,
    )).toThrow(/homebrew-bootstrap.*SHA-256.*does not match declared/i);
  });

  it("requires original regular TAR members and snapshots their bytes", () => {
    const fixture = homebrewTestBootstrapFixture();
    const preparedKeg = preparedBootstrap(fixture);
    const prepared = prepareHomebrewRuntimeSupport(
      fixture.descriptor,
      preparedKeg,
      SUPPORT_LIMITS,
    );
    const zipEntry = preparedKeg.entries.find((entry) =>
      entry.path.endsWith("/libexec/homebrew-bootstrap.zip")
    );
    if (zipEntry?.type !== "file") throw new Error("test bootstrap ZIP entry is not regular");
    zipEntry.data[0] ^= 0xff;
    expect(prepared.zipBytes).toEqual(fixture.zip);

    const nonregular = homebrewTestBootstrapFixture({
      zipEntry: {
        path: "homebrew-bootstrap/6.0.12_1/libexec/homebrew-bootstrap.zip",
        type: "symlink",
        linkName: "elsewhere",
      },
    });
    expect(() => prepareHomebrewRuntimeSupport(
      nonregular.descriptor,
      preparedBootstrap(nonregular),
      SUPPORT_LIMITS,
    )).toThrow(/homebrew-bootstrap.*not a regular TAR member/i);

    const missing = homebrewTestBootstrapFixture({
      zipEntry: {
        path: "homebrew-bootstrap/6.0.12_1/libexec/not-bootstrap.zip",
        data: fixture.zip,
      },
    });
    expect(() => prepareHomebrewRuntimeSupport(
      missing.descriptor,
      preparedBootstrap(missing),
      SUPPORT_LIMITS,
    )).toThrow(/homebrew-bootstrap.*present exactly once/i);
  });

  it("refuses mismatched bootstrap identity and support declarations", () => {
    const fixture = homebrewTestBootstrapFixture();
    const preparedKeg = preparedBootstrap(fixture);
    const wrongIdentity = structuredClone(fixture.descriptor);
    wrongIdentity.name = "not-bootstrap";
    expect(() => prepareHomebrewRuntimeSupport(
      wrongIdentity,
      preparedKeg,
      SUPPORT_LIMITS,
    )).toThrow(/exact selected Homebrew bootstrap descriptor/i);

    const wrongPrepared = structuredClone(preparedKeg);
    wrongPrepared.input.version = "different";
    expect(() => prepareHomebrewRuntimeSupport(
      fixture.descriptor,
      wrongPrepared,
      SUPPORT_LIMITS,
    )).toThrow(/does not match descriptor field version/i);

    const extraOutput = structuredClone(fixture.descriptor);
    extraOutput.supportOutputs.push({
      name: "unexpected",
      kegRelativePath: "libexec/unexpected",
      sha256: "0".repeat(64),
      bytes: 1,
    });
    expect(() => prepareHomebrewRuntimeSupport(
      extraOutput,
      preparedKeg,
      SUPPORT_LIMITS,
    )).toThrow(/exact support outputs/i);
  });

  it("inherits the bounded ZIP path, duplicate, method, and type refusals", () => {
    const invalidZips = [
      {
        label: "traversal",
        zip: homebrewTestZip({
          "../escape": { data: "bad\n", mode: 0o100644 },
        }),
        expected: /not a canonical relative path/i,
      },
      {
        label: "absolute path",
        zip: homebrewTestZip({
          "/escape": { data: "bad\n", mode: 0o100644 },
        }),
        expected: /not a canonical relative path/i,
      },
      {
        label: "path bound",
        zip: homebrewTestZip({
          ["p".repeat(4097)]: { data: "bad\n", mode: 0o100644 },
        }),
        expected: /not a canonical relative path/i,
      },
      {
        label: "duplicate",
        zip: duplicateBrewMemberZip(),
        expected: /duplicate paths/i,
      },
      {
        label: "unsupported method",
        zip: withFirstZipMethod(homebrewTestRuntimeZip(), 99),
        expected: /unsupported compression/i,
      },
      {
        label: "unsupported type",
        zip: homebrewTestZip({
          "bin/": { mode: 0o040755 },
          "bin/brew": { data: "fifo", mode: 0o010755 },
        }),
        expected: /unsupported file type/i,
      },
    ];

    for (const fixture of invalidZips) {
      const bootstrap = homebrewTestBootstrapFixture({ zip: fixture.zip });
      expect(
        () => prepareHomebrewRuntimeSupport(
          bootstrap.descriptor,
          preparedBootstrap(bootstrap),
          SUPPORT_LIMITS,
        ),
        fixture.label,
      ).toThrow(fixture.expected);
    }
  });

  it("enforces the selected support-ZIP archive, expansion, and entry limits", () => {
    const fixture = homebrewTestBootstrapFixture();
    const preparedKeg = preparedBootstrap(fixture);
    expect(() => prepareHomebrewRuntimeSupport(
      fixture.descriptor,
      preparedKeg,
      { ...SUPPORT_LIMITS, maxCompressedBytes: fixture.zip.byteLength - 1 },
    )).toThrow(/ZIP byte count.*exceeds/i);
    expect(() => prepareHomebrewRuntimeSupport(
      fixture.descriptor,
      preparedKeg,
      { ...SUPPORT_LIMITS, maxExpandedBytes: 1 },
    )).toThrow(/ZIP expanded byte count.*exceeds/i);
    expect(() => prepareHomebrewRuntimeSupport(
      fixture.descriptor,
      preparedKeg,
      { ...SUPPORT_LIMITS, maxEntries: 1 },
    )).toThrow(/ZIP entry count.*exceeds/i);
  });

  it("requires one executable regular bin/brew", () => {
    for (const fixture of [
      {
        label: "missing",
        zip: homebrewTestZip({
          "bin/": { mode: 0o040755 },
          "bin/not-brew": { data: "#!/bin/sh\n", mode: 0o100755 },
        }),
      },
      {
        label: "non-executable",
        zip: homebrewTestRuntimeZip({
          "bin/brew": { data: "#!/bin/sh\n", mode: 0o100644 },
        }),
      },
      {
        label: "symlink",
        zip: homebrewTestRuntimeZip({
          "bin/brew": { data: "other", mode: 0o120777 },
        }),
      },
    ]) {
      const bootstrap = homebrewTestBootstrapFixture({ zip: fixture.zip });
      expect(
        () => prepareHomebrewRuntimeSupport(
          bootstrap.descriptor,
          preparedBootstrap(bootstrap),
          SUPPORT_LIMITS,
        ),
        fixture.label,
      ).toThrow(/exactly one executable regular bin\/brew/i);
    }
  });

  it("allows contained parent-relative symlinks but rejects absolute and escaping targets", () => {
    const contained = homebrewTestBootstrapFixture();
    expect(() => prepareHomebrewRuntimeSupport(
      contained.descriptor,
      preparedBootstrap(contained),
      SUPPORT_LIMITS,
    )).not.toThrow();

    for (const [label, target, expected] of [
      ["absolute", "/outside", /target must be relative/i],
      ["escape", "../../../../outside", /escapes.*homebrew/i],
      [
        "escape and re-enter",
        "../../../../opt/kandelo/homebrew/Library/Homebrew/",
        /escapes.*homebrew/i,
      ],
    ] as const) {
      const zip = homebrewTestRuntimeZip({
        "bin/homebrew-library": { data: target, mode: 0o120777 },
      });
      const fixture = homebrewTestBootstrapFixture({ zip });
      expect(
        () => prepareHomebrewRuntimeSupport(
          fixture.descriptor,
          preparedBootstrap(fixture),
          SUPPORT_LIMITS,
        ),
        label,
      ).toThrow(expected);
    }
  });

  it("preflights support destinations and leaves caller-owned base state unchanged", async () => {
    const bootstrap = homebrewTestBootstrapFixture();
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    ensureDirRecursive(baseFs, `${HOMEBREW_TEST_PREFIX}/Library`);
    writeVfsFile(baseFs, `${HOMEBREW_TEST_PREFIX}/Library/Homebrew`, "occupied\n");

    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes([bootstrap.descriptor])),
      { baseFs, loadBottleBytes: () => bootstrap.bottle },
    )).rejects.toThrow(/collides with the base/i);
    expect(readFile(baseFs, `${HOMEBREW_TEST_PREFIX}/Library/Homebrew`)).toEqual(
      new TextEncoder().encode("occupied\n"),
    );
    expect(() => baseFs.lstat(bootstrap.descriptor.keg)).toThrow();
    expect(() => baseFs.lstat("/usr/bin/brew")).toThrow();
  });

  it("rejects invalid support preparation before allocating a private filesystem", async () => {
    const invalidEnvironment = new TextEncoder().encode("HOMEBREW_NO_ANALYTICS=1\n");
    const bootstrap = homebrewTestBootstrapFixture({
      environment: invalidEnvironment,
    });
    const baseFs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    let rebased = false;
    const originalRebase = baseFs.rebaseToNewFileSystem.bind(baseFs);
    baseFs.rebaseToNewFileSystem = (maxByteLength) => {
      rebased = true;
      return originalRebase(maxByteLength);
    };

    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes([bootstrap.descriptor])),
      { baseFs, loadBottleBytes: () => bootstrap.bottle },
    )).rejects.toThrow(/does not match the exact.*environment/i);
    expect(rebased).toBe(false);
    expect(() => baseFs.lstat(HOMEBREW_TEST_PREFIX)).toThrow();
  });

  it("overlays before ordinary-link preflight so bin/brew collisions fail closed", async () => {
    const bootstrap = homebrewTestBootstrapFixture();
    const claimantBottle = homebrewTestBottleTar([
      homebrewTestBottleEntry("claimant", "1.0", ".brew/claimant.rb", "class Claimant\n"),
      homebrewTestBottleEntry("claimant", "1.0", "INSTALL_RECEIPT.json", homebrewTestReceipt([])),
      homebrewTestBottleEntry("claimant", "1.0", "bin/brew", "claimant\n", 0o755),
    ]);
    const claimant = homebrewTestBottleDescriptor({
      name: "claimant",
      version: "1.0",
      bottle: claimantBottle,
      links: [{
        type: "symlink",
        source: "Cellar/claimant/1.0/bin/brew",
        target: "bin/brew",
      }],
    });
    const closure = [bootstrap.descriptor, claimant];

    await expect(buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes(closure)),
      {
        loadBottleBytes(pkg) {
          return pkg.fullName === bootstrap.descriptor.fullName
            ? bootstrap.bottle
            : claimantBottle;
        },
      },
    )).rejects.toThrow(/link target bin\/brew already exists/i);
  });

  it("adopts parent directories and links created after the support overlay", async () => {
    const bootstrap = homebrewTestBootstrapFixture();
    const manualBottle = homebrewTestBottleTar([
      homebrewTestBottleEntry("manual", "1.0", ".brew/manual.rb", "class Manual\n"),
      homebrewTestBottleEntry("manual", "1.0", "INSTALL_RECEIPT.json", homebrewTestReceipt([])),
      homebrewTestBottleEntry("manual", "1.0", "share/man/man1/manual.1", "manual\n"),
    ]);
    const manual = homebrewTestBottleDescriptor({
      name: "manual",
      version: "1.0",
      bottle: manualBottle,
      links: [{
        type: "symlink",
        source: "Cellar/manual/1.0/share/man/man1/manual.1",
        target: "share/man/man1/manual.1",
      }],
    });
    const result = await buildHomebrewVfsSelection(
      planHomebrewVfsSelection(homebrewTestSelectionBytes([
        bootstrap.descriptor,
        manual,
      ])),
      {
        loadBottleBytes(pkg) {
          return pkg.fullName === bootstrap.descriptor.fullName
            ? bootstrap.bottle
            : manualBottle;
        },
      },
    );

    for (const path of [
      `${HOMEBREW_TEST_PREFIX}/share`,
      `${HOMEBREW_TEST_PREFIX}/share/man/man1`,
      `${HOMEBREW_TEST_PREFIX}/share/man/man1/manual.1`,
      `${HOMEBREW_TEST_PREFIX}/opt`,
      `${HOMEBREW_TEST_PREFIX}/opt/manual`,
    ]) {
      expect(result.fs.lstat(path), path).toMatchObject({ uid: 1000, gid: 1000 });
    }
  });

  it("supports the explicit prepare, overlay, and finalize phase boundary", async () => {
    const fixture = homebrewTestBootstrapFixture();
    const prepared = prepareHomebrewRuntimeSupport(
      fixture.descriptor,
      preparedBootstrap(fixture),
      SUPPORT_LIMITS,
    );
    expect(prepared.tree.descriptor.package.output).toBe("homebrew-bootstrap.zip");
    expect(prepared.tree.descriptor.archive.url).toBe("homebrew-bootstrap.zip");
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    await overlayPreparedHomebrewRuntimeSupport(fs, prepared);
    expect(fs.exportLazyArchiveEntries()).toEqual([]);
    expect(() => fs.lstat("/usr/bin/brew")).toThrow();

    finalizeHomebrewRuntimeSupport(fs, prepared);
    expect(fs.readlink("/usr/bin/brew")).toBe(`${HOMEBREW_TEST_PREFIX}/bin/brew`);
  });

  it("asserts only this eager support tree while preserving unrelated deferred state", async () => {
    const fixture = homebrewTestBootstrapFixture();
    const prepared = prepareHomebrewRuntimeSupport(
      fixture.descriptor,
      preparedBootstrap(fixture),
      SUPPORT_LIMITS,
    );
    const unrelatedArchive = homebrewTestZip({
      "bin/": { mode: 0o040755 },
      "bin/tool": { data: "tool\n", mode: 0o100755 },
    });
    const unrelatedSpec = {
      schema: 1,
      kind: "kandelo-package-deferred-zip-tree",
      id: "unrelated/tree",
      content_role: "runtime-tree",
      package: { name: "unrelated", output: "unrelated.zip" },
      archive: { url: "unrelated.zip", mode_policy: "portable-posix-v1" },
      mount_prefix: "/unrelated",
      owner: { uid: 0, gid: 0 },
      activation: {
        mode: "first-use",
        capabilities: ["unrelated:test"],
        roots: ["/unrelated/bin/tool"],
      },
    } as const satisfies PackageDeferredZipTreeSpec;
    const unrelated = derivePackageDeferredZipTree(unrelatedSpec, unrelatedArchive);
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(8 * 1024 * 1024));
    registerPackageDeferredZipTree(fs, unrelated);
    assertPackageDeferredZipTreeState(fs, unrelated, "deferred");

    await overlayPreparedHomebrewRuntimeSupport(fs, prepared);
    finalizeHomebrewRuntimeSupport(fs, prepared);

    assertPackageDeferredZipTreeState(fs, unrelated, "deferred");
    assertPackageDeferredZipTreeState(fs, prepared.tree, "materialized");
  });
});

function preparedBootstrap(
  fixture: ReturnType<typeof homebrewTestBootstrapFixture>,
): PreparedHomebrewKeg {
  return prepareHomebrewKeg(
    descriptorMaterializationPackage(fixture.descriptor),
    fixture.bottle,
    {
      expectedDependencies: fixture.descriptor.dependencies,
      requireExactKegContainment: true,
    },
  );
}

function homebrewRuntimeZipWithBash(bashMode = 0o100755): Uint8Array {
  return homebrewTestRuntimeZip({
    "bin/bash": { data: "#!/bin/bash\necho bash\n", mode: bashMode },
    "bin/brew": { data: "#!/bin/bash\necho brew\n", mode: 0o100755 },
  });
}

function duplicateBrewMemberZip(): Uint8Array {
  const zip = homebrewTestZip({
    "bin/": { mode: 0o040755 },
    "bin/brew": { data: "#!/bin/sh\n", mode: 0o100755 },
    "bin/tool": { data: "duplicate\n", mode: 0o100755 },
  });
  return replaceAscii(zip, "bin/tool", "bin/brew");
}

function replaceAscii(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const source = new TextEncoder().encode(from);
  const replacement = new TextEncoder().encode(to);
  if (source.byteLength !== replacement.byteLength) throw new Error("test replacement differs");
  const output = new Uint8Array(bytes);
  let replacements = 0;
  for (let offset = 0; offset <= output.byteLength - source.byteLength; offset += 1) {
    if (!source.every((byte, index) => output[offset + index] === byte)) continue;
    output.set(replacement, offset);
    replacements += 1;
    offset += source.byteLength - 1;
  }
  if (replacements !== 2) {
    throw new Error(`expected two ZIP filename replacements, got ${replacements}`);
  }
  return output;
}

function withFirstZipMethod(bytes: Uint8Array, method: number): Uint8Array {
  const output = new Uint8Array(bytes);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  let local = false;
  let central = false;
  for (let offset = 0; offset <= output.byteLength - 4; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (!local && signature === 0x04034b50) {
      view.setUint16(offset + 8, method, true);
      local = true;
    } else if (!central && signature === 0x02014b50) {
      view.setUint16(offset + 10, method, true);
      central = true;
    }
  }
  if (!local || !central) throw new Error("test ZIP headers not found");
  return output;
}

function readFile(fs: MemoryFileSystem, path: string): Uint8Array {
  const stat = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(stat.size);
    expect(fs.read(fd, bytes, null, bytes.byteLength)).toBe(bytes.byteLength);
    return bytes;
  } finally {
    fs.close(fd);
  }
}
