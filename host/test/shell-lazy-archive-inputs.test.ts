import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import {
  loadDeclaredShellLazyArchive,
  registerDeclaredShellLazyArchive,
  SHELL_LAZY_ARCHIVE_SPECS,
  type ShellLazyArchiveSpec,
} from "../../images/vfs/scripts/shell-lazy-archives";
import { resolveVfsArtifact } from "../../images/vfs/scripts/shell-vfs-build";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { extractZipEntry, parseZipCentralDirectory } from "../src/vfs/zip";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kandelo-shell-lazy-bundle-"));
  tempDirs.push(dir);
  return dir;
}

interface ResolverBundleFixture {
  bundlePackage: "vim-browser-bundle" | "nethack-browser-bundle";
  dependencyDirectoryVariable:
    | "WASM_POSIX_DEP_VIM_DIR"
    | "WASM_POSIX_DEP_NETHACK_DIR";
  executable: "vim.wasm" | "nethack.wasm";
  helper: "build-vim-zip.sh" | "build-nethack-zip.sh";
  runtimeFiles: Record<string, string>;
  zipExecutable: "bin/vim" | "bin/nethack";
}

function runResolverBundleFixture(fixture: ResolverBundleFixture): void {
  const fixtureRoot = tempDir();
  const copyRepositoryFile = (relativePath: string): void => {
    const destination = join(fixtureRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repoRoot, relativePath), destination);
  };
  const wrapper =
    `packages/registry/${fixture.bundlePackage}/build-${fixture.bundlePackage}.sh`;
  for (const relativePath of [
    wrapper,
    `images/vfs/scripts/${fixture.helper}`,
    "images/vfs/scripts/create-deterministic-zip.sh",
    "scripts/install-local-binary.sh",
    "scripts/wasm-artifact-guards.sh",
  ]) {
    copyRepositoryFile(relativePath);
  }

  const dependencyRoot = join(fixtureRoot, "declared-dependency");
  const workRoot = join(fixtureRoot, "work");
  const outputRoot = join(fixtureRoot, "out");
  const publicRoot = join(fixtureRoot, "apps/browser-demos/public");
  const fakeBin = join(fixtureRoot, "fake-bin");
  mkdirSync(dependencyRoot, { recursive: true });
  mkdirSync(workRoot);
  mkdirSync(outputRoot);
  mkdirSync(publicRoot, { recursive: true });
  mkdirSync(fakeBin);

  const executableBytes = `${fixture.bundlePackage} declared executable\n`;
  writeFileSync(join(dependencyRoot, fixture.executable), executableBytes);
  chmodSync(join(dependencyRoot, fixture.executable), 0o755);
  for (const [relativePath, contents] of Object.entries(fixture.runtimeFiles)) {
    const path = join(dependencyRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  const publicArchive = join(
    publicRoot,
    fixture.bundlePackage === "vim-browser-bundle" ? "vim.zip" : "nethack.zip",
  );
  writeFileSync(publicArchive, "browser public sentinel\n");
  const unexpectedCargo = join(fixtureRoot, "unexpected-cargo");
  writeFileSync(
    join(fakeBin, "cargo"),
    `#!/usr/bin/env bash\n: >${JSON.stringify(unexpectedCargo)}\nexit 97\n`,
  );
  chmodSync(join(fakeBin, "cargo"), 0o755);

  const result = spawnSync("bash", [join(fixtureRoot, wrapper)], {
    cwd: fixtureRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      WASM_POSIX_DEP_OUT_DIR: outputRoot,
      WASM_POSIX_DEP_TARGET_ARCH: "wasm32",
      WASM_POSIX_DEP_WORK_DIR: workRoot,
      [fixture.dependencyDirectoryVariable]: dependencyRoot,
    },
  });
  expect(
    result.status,
    `${fixture.bundlePackage} stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(0);
  expect(existsSync(unexpectedCargo)).toBe(false);
  expect(readFileSync(publicArchive, "utf8")).toBe("browser public sentinel\n");

  const outputArchive = join(
    outputRoot,
    fixture.bundlePackage === "vim-browser-bundle" ? "vim.zip" : "nethack.zip",
  );
  const bytes = new Uint8Array(readFileSync(outputArchive));
  const executableEntry = parseZipCentralDirectory(bytes).find(
    (entry) => entry.fileName === fixture.zipExecutable,
  );
  expect(executableEntry).toBeDefined();
  expect(new TextDecoder().decode(extractZipEntry(bytes, executableEntry!))).toBe(
    executableBytes,
  );
}

function archiveFor(
  spec: ShellLazyArchiveSpec,
  files: Record<string, Uint8Array> = {},
): Uint8Array {
  return zipSync({
    [spec.requiredMember]: new TextEncoder().encode(
      `${spec.id} executable`,
    ),
    [`share/${spec.id}/runtime.dat`]: new TextEncoder().encode(
      `${spec.id} runtime`,
    ),
    ...files,
  });
}

function writeArchive(name: string, bytes: Uint8Array): string {
  const path = join(tempDir(), name);
  writeFileSync(path, bytes);
  return path;
}

function writeDeterministicZipFixture(
  root: string,
  reverseCreationOrder: boolean,
  mtime: Date,
): void {
  const entries = [
    {
      kind: "file" as const,
      path: "bin/vim",
      bytes: new TextEncoder().encode("fixture executable\n"),
      mode: reverseCreationOrder ? 0o700 : 0o775,
    },
    {
      kind: "symlink" as const,
      path: "bin/vi",
      target: "vim",
    },
    {
      kind: "file" as const,
      path: "share/runtime/config.txt",
      bytes: new TextEncoder().encode("fixture runtime\n"),
      mode: reverseCreationOrder ? 0o600 : 0o664,
    },
    {
      kind: "file" as const,
      path: "share/runtime/dictionary.txt",
      bytes: new TextEncoder().encode("deterministic payload\n".repeat(512)),
      mode: reverseCreationOrder ? 0o440 : 0o646,
    },
    {
      kind: "directory" as const,
      path: "share/runtime/empty",
    },
    {
      kind: "file" as const,
      path: "share/runtime/π data.txt",
      bytes: new TextEncoder().encode("unicode path\n"),
      mode: reverseCreationOrder ? 0o400 : 0o666,
    },
  ];
  if (reverseCreationOrder) entries.reverse();

  for (const entry of entries) {
    const path = join(root, entry.path);
    mkdirSync(dirname(path), { recursive: true });
    if (entry.kind === "directory") {
      mkdirSync(path);
    } else if (entry.kind === "symlink") {
      symlinkSync(entry.target, path);
      lutimesSync(path, mtime, mtime);
    } else {
      writeFileSync(path, entry.bytes);
      chmodSync(path, entry.mode);
      utimesSync(path, mtime, mtime);
    }
  }
  for (const dir of [
    root,
    join(root, "bin"),
    join(root, "share"),
    join(root, "share/runtime"),
    join(root, "share/runtime/empty"),
  ]) {
    utimesSync(dir, mtime, mtime);
  }
}

function fixtureSnapshot(root: string): unknown[] {
  return [
    "bin",
    "bin/vi",
    "bin/vim",
    "share",
    "share/runtime",
    "share/runtime/config.txt",
    "share/runtime/dictionary.txt",
    "share/runtime/empty",
    "share/runtime/π data.txt",
  ].map((relative) => {
    const path = join(root, relative);
    const stat = lstatSync(path);
    return {
      relative,
      mode: stat.mode,
      mtimeMs: stat.mtimeMs,
      target: stat.isSymbolicLink() ? readlinkSync(path) : undefined,
      sha256: stat.isFile()
        ? createHash("sha256").update(readFileSync(path)).digest("hex")
        : undefined,
    };
  });
}

function zipEntryMetadata(
  bytes: Uint8Array,
  entries: ReturnType<typeof parseZipCentralDirectory>,
): Array<{
  centralDate: number;
  centralExtraBytes: number;
  centralTime: number;
  localDate: number;
  localExtraBytes: number;
  localTime: number;
}> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error("fixture ZIP has no EOCD record");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const metadata = [];
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error(`fixture ZIP has invalid central entry ${index}`);
    }
    const localOffset = entries[index]?.localHeaderOffset;
    if (
      localOffset === undefined ||
      view.getUint32(localOffset, true) !== 0x04034b50
    ) {
      throw new Error(`fixture ZIP has invalid local entry ${index}`);
    }
    metadata.push({
      centralTime: view.getUint16(offset + 12, true),
      centralDate: view.getUint16(offset + 14, true),
      centralExtraBytes: view.getUint16(offset + 30, true),
      localTime: view.getUint16(localOffset + 10, true),
      localDate: view.getUint16(localOffset + 12, true),
      localExtraBytes: view.getUint16(localOffset + 28, true),
    });
    offset +=
      46 +
      view.getUint16(offset + 28, true) +
      view.getUint16(offset + 30, true) +
      view.getUint16(offset + 32, true);
  }
  return metadata;
}

describe("declared shell lazy-archive inputs", () => {
  it("creates byte-identical lazy ZIPs across source order and mtime changes", () => {
    const firstRoot = tempDir();
    const secondRoot = tempDir();
    const outputRoot = tempDir();
    const firstOutput = join(outputRoot, "first.zip");
    const secondOutput = join(outputRoot, "second.zip");
    writeDeterministicZipFixture(
      firstRoot,
      false,
      new Date("2020-01-02T03:04:05Z"),
    );
    writeDeterministicZipFixture(
      secondRoot,
      true,
      new Date("2025-12-30T21:22:23Z"),
    );
    const firstSource = fixtureSnapshot(firstRoot);
    const secondSource = fixtureSnapshot(secondRoot);

    const helper = join(
      repoRoot,
      "images/vfs/scripts/create-deterministic-zip.sh",
    );
    execFileSync("bash", [helper, firstRoot, firstOutput], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SOURCE_DATE_EPOCH: "123456789",
        TZ: "Pacific/Honolulu",
        ZIPOPT: "-0",
      },
    });
    execFileSync("bash", [helper, secondRoot, secondOutput], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SOURCE_DATE_EPOCH: "987654321",
        TZ: "Asia/Tokyo",
        ZIPOPT: "-9",
      },
    });
    expect(fixtureSnapshot(firstRoot)).toEqual(firstSource);
    expect(fixtureSnapshot(secondRoot)).toEqual(secondSource);

    const first = new Uint8Array(readFileSync(firstOutput));
    const second = new Uint8Array(readFileSync(secondOutput));
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      createHash("sha256").update(second).digest("hex"),
    );
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      "67b198037eb2b47e6d5acadbdfc94f25ec83c469c5374d719342392b08ef0bd0",
    );
    expect(Array.from(first)).toEqual(Array.from(second));

    const entries = parseZipCentralDirectory(first);
    expect(entries.map((entry) => entry.fileName)).toEqual([
      "bin/",
      "bin/vi",
      "bin/vim",
      "share/",
      "share/runtime/",
      "share/runtime/config.txt",
      "share/runtime/dictionary.txt",
      "share/runtime/empty/",
      "share/runtime/π data.txt",
    ]);
    expect(
      entries.map((entry) => [
        entry.fileName,
        entry.creatorOS,
        entry.mode & 0o777,
      ]),
    ).toEqual([
      ["bin/", 3, 0o755],
      ["bin/vi", 3, 0o777],
      ["bin/vim", 3, 0o755],
      ["share/", 3, 0o755],
      ["share/runtime/", 3, 0o755],
      ["share/runtime/config.txt", 3, 0o644],
      ["share/runtime/dictionary.txt", 3, 0o644],
      ["share/runtime/empty/", 3, 0o755],
      ["share/runtime/π data.txt", 3, 0o644],
    ]);
    expect(zipEntryMetadata(first, entries)).toEqual(
      entries.map(() => ({
        centralDate: 0x2821,
        centralExtraBytes: 0,
        centralTime: 0,
        localDate: 0x2821,
        localExtraBytes: 0,
        localTime: 0,
      })),
    );

    const vi = entries.find((entry) => entry.fileName === "bin/vi");
    expect(vi?.isSymlink).toBe(true);
    expect(new TextDecoder().decode(extractZipEntry(first, vi!))).toBe("vim");
    const vimEntry = entries.find((entry) => entry.fileName === "bin/vim");
    expect(new TextDecoder().decode(extractZipEntry(first, vimEntry!))).toBe(
      "fixture executable\n",
    );
    const dictionary = entries.find(
      (entry) => entry.fileName === "share/runtime/dictionary.txt",
    );
    expect(dictionary?.compressionMethod).toBe(8);
    expect(extractZipEntry(first, dictionary!).byteLength).toBe(
      "deterministic payload\n".length * 512,
    );

    const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));
    const vim = SHELL_LAZY_ARCHIVE_SPECS[0];
    const archive = registerDeclaredShellLazyArchive(
      fs,
      vim,
      () => firstOutput,
    );
    expect(archive.symlinkTargets).toEqual(new Map([["bin/vi", "vim"]]));
    expect(fs.readlink("/usr/bin/vi")).toBe("vim");
    expect(fs.stat("/usr/bin/vim").size).toBe("fixture executable\n".length);
  });

  it("fails loudly when neither stat spelling returns an octal mode", () => {
    const sourceRoot = tempDir();
    const outputRoot = tempDir();
    const fakeBin = tempDir();
    writeDeterministicZipFixture(
      sourceRoot,
      false,
      new Date("2020-01-02T03:04:05Z"),
    );
    const fakeStat = join(fakeBin, "stat");
    writeFileSync(fakeStat, "#!/bin/sh\nprintf 'not-an-octal-mode\\n'\n");
    chmodSync(fakeStat, 0o755);

    const helper = join(
      repoRoot,
      "images/vfs/scripts/create-deterministic-zip.sh",
    );
    const result = spawnSync(
      "bash",
      [helper, sourceRoot, join(outputRoot, "invalid.zip")],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "create-deterministic-zip: could not read mode: ./bin/vim",
    );
  });

  it("rejects names that cannot be represented by the ZIP entry list", () => {
    const sourceRoot = tempDir();
    const outputRoot = tempDir();
    mkdirSync(join(sourceRoot, "bin"));
    writeFileSync(join(sourceRoot, "bin", "bad\nname"), "invalid path\n");

    const helper = join(
      repoRoot,
      "images/vfs/scripts/create-deterministic-zip.sh",
    );
    const result = spawnSync(
      "bash",
      [helper, sourceRoot, join(outputRoot, "invalid.zip")],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "create-deterministic-zip: ZIP entry names must not contain newlines",
    );
  });

  it.each(SHELL_LAZY_ARCHIVE_SPECS)(
    "indexes and hashes the exact resolved $id bundle bytes once",
    (spec) => {
      const expected = archiveFor(spec);
      const path = writeArchive(spec.archiveUrl, expected);
      const calls: Array<[string, string]> = [];
      const resolve = (resolverPath: string, dependency: string): string => {
        calls.push([resolverPath, dependency]);
        return path;
      };
      const fs = MemoryFileSystem.create(
        new SharedArrayBuffer(4 * 1024 * 1024),
      );

      const archive = registerDeclaredShellLazyArchive(fs, spec, resolve);

      expect(calls).toEqual([[spec.resolverPath, spec.dependency]]);
      expect(Array.from(archive.bytes)).toEqual(Array.from(expected));
      expect(archive.integrity).toEqual({
        compressedBytes: expected.byteLength,
        sha256: createHash("sha256").update(expected).digest("hex"),
      });
      expect(archive.entries.map((entry) => entry.fileName)).toContain(
        spec.requiredMember,
      );
      expect(archive.symlinkTargets).toEqual(new Map());
      expect(
        fs.stat(`${spec.mountPrefix}${spec.requiredMember}`).size,
      ).toBe(`${spec.id} executable`.length);
      expect(fs.exportLazyArchiveEntries()).toEqual([
        expect.objectContaining({
          url: spec.archiveUrl,
          mountPrefix: spec.mountPrefix.replace(/\/$/, ""),
        }),
      ]);
    },
  );

  it("propagates a missing declared dependency output instead of falling back", () => {
    const spec = SHELL_LAZY_ARCHIVE_SPECS[0];
    expect(() =>
      loadDeclaredShellLazyArchive(spec, () => {
        throw new Error(
          "direct dependency vim-browser-bundle is available, but vim.zip was not found",
        );
      }),
    ).toThrow(
      "direct dependency vim-browser-bundle is available, but vim.zip was not found",
    );
  });

  it("rejects a valid ZIP from the wrong bundle before changing the VFS", () => {
    const vim = SHELL_LAZY_ARCHIVE_SPECS[0];
    const nethack = SHELL_LAZY_ARCHIVE_SPECS[1];
    const wrongPath = writeArchive(nethack.archiveUrl, archiveFor(nethack));
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

    expect(() =>
      registerDeclaredShellLazyArchive(fs, vim, () => wrongPath),
    ).toThrow(
      /vim-browser-bundle output .* must contain exactly one regular member bin\/vim; found 0/,
    );
    expect(() => fs.stat("/usr/bin/vim")).toThrow();
    expect(fs.exportLazyArchiveEntries()).toEqual([]);
  });

  it("reports a corrupt declared output as an invalid lazy ZIP", () => {
    const spec = SHELL_LAZY_ARCHIVE_SPECS[0];
    const corruptPath = writeArchive(
      spec.archiveUrl,
      new Uint8Array([1, 2, 3]),
    );

    expect(() => loadDeclaredShellLazyArchive(spec, () => corruptPath)).toThrow(
      /vim-browser-bundle output .* is not a valid lazy ZIP: Zip EOCD record not found/,
    );
  });

  it("treats an announced direct dependency with no output as a hard failure", () => {
    const dependencyDir = tempDir();
    const key = "WASM_POSIX_DEP_VIM_BROWSER_BUNDLE_DIR";
    const prior = process.env[key];
    process.env[key] = dependencyDir;
    try {
      expect(() =>
        resolveVfsArtifact("programs/wasm32/vim.zip", "vim-browser-bundle"),
      ).toThrow(
        `direct dependency vim-browser-bundle is available at ${dependencyDir}, ` +
          "but vim.zip was not found",
      );
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("builds resolver lazy bundles only from their declared dependency and private roots", () => {
    runResolverBundleFixture({
      bundlePackage: "vim-browser-bundle",
      dependencyDirectoryVariable: "WASM_POSIX_DEP_VIM_DIR",
      executable: "vim.wasm",
      helper: "build-vim-zip.sh",
      runtimeFiles: {
        "runtime/defaults.vim": "declared Vim runtime\n",
      },
      zipExecutable: "bin/vim",
    });
    runResolverBundleFixture({
      bundlePackage: "nethack-browser-bundle",
      dependencyDirectoryVariable: "WASM_POSIX_DEP_NETHACK_DIR",
      executable: "nethack.wasm",
      helper: "build-nethack-zip.sh",
      runtimeFiles: {
        "runtime/share/nethack/license": "declared NetHack license\n",
        "runtime/share/nethack/nhdat": "declared NetHack data\n",
        "runtime/share/nethack/symbols": "declared NetHack symbols\n",
      },
      zipExecutable: "bin/nethack",
    });
  });

  it("keeps the standalone lazy-bundle recipes self-contained", () => {
    const vimBundleBuildToml = readFileSync(
      join(repoRoot, "packages/registry/vim-browser-bundle/build.toml"),
      "utf8",
    );
    const nethackBundleBuildToml = readFileSync(
      join(repoRoot, "packages/registry/nethack-browser-bundle/build.toml"),
      "utf8",
    );
    const vimZipBuildScript = readFileSync(
      join(repoRoot, "images/vfs/scripts/build-vim-zip.sh"),
      "utf8",
    );
    const nethackZipBuildScript = readFileSync(
      join(repoRoot, "images/vfs/scripts/build-nethack-zip.sh"),
      "utf8",
    );

    expect(vimBundleBuildToml).toContain(
      '"packages/registry/vim-browser-bundle/build-vim-browser-bundle.sh"',
    );
    expect(vimBundleBuildToml).toContain(
      '"images/vfs/scripts/build-vim-zip.sh"',
    );
    expect(vimBundleBuildToml).toContain(
      '"images/vfs/scripts/create-deterministic-zip.sh"',
    );
    expect(vimBundleBuildToml).toMatch(/^revision\s*=\s*4$/m);
    expect(nethackBundleBuildToml).toContain(
      '"packages/registry/nethack-browser-bundle/build-nethack-browser-bundle.sh"',
    );
    expect(nethackBundleBuildToml).toContain(
      '"images/vfs/scripts/build-nethack-zip.sh"',
    );
    expect(nethackBundleBuildToml).toContain(
      '"images/vfs/scripts/create-deterministic-zip.sh"',
    );
    expect(nethackBundleBuildToml).toMatch(/^revision\s*=\s*5$/m);
    expect(vimZipBuildScript).toContain(
      'bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"',
    );
    expect(nethackZipBuildScript).toContain(
      'bash "$SCRIPT_DIR/create-deterministic-zip.sh" "$STAGING" "$OUTPUT_FILE"',
    );
    // The generated ZIP belongs to the bundle package. Assigning it to the
    // underlying executable package makes manifest-driven installation reject
    // the ZIP because vim and nethack declare only their .wasm outputs.
    expect(vimZipBuildScript).toContain(
      'install_local_binary vim-browser-bundle "$OUTPUT_FILE" vim.zip',
    );
    expect(vimZipBuildScript).not.toMatch(
      /install_local_binary\s+vim\s+"\$OUTPUT_FILE"/,
    );
    expect(nethackZipBuildScript).toContain(
      'install_local_binary nethack-browser-bundle "$OUTPUT_FILE" nethack.zip',
    );
    expect(nethackZipBuildScript).not.toMatch(
      /install_local_binary\s+nethack\s+"\$OUTPUT_FILE"/,
    );
  });
});
