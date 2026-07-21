import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
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

function archiveFor(
  spec: ShellLazyArchiveSpec,
  files: Record<string, Uint8Array> = {},
): Uint8Array {
  return zipSync({
    [spec.requiredExecutable]: new TextEncoder().encode(`${spec.id} executable`),
    [`share/${spec.id}/runtime.dat`]: new TextEncoder().encode(`${spec.id} runtime`),
    ...files,
  });
}

function writeArchive(name: string, bytes: Uint8Array): string {
  const path = join(tempDir(), name);
  writeFileSync(path, bytes);
  return path;
}

describe("declared shell lazy-archive inputs", () => {
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
      const fs = MemoryFileSystem.create(new SharedArrayBuffer(4 * 1024 * 1024));

      const archive = registerDeclaredShellLazyArchive(fs, spec, resolve);

      expect(calls).toEqual([[spec.resolverPath, spec.dependency]]);
      expect(Array.from(archive.bytes)).toEqual(Array.from(expected));
      expect(archive.integrity).toEqual({
        compressedBytes: expected.byteLength,
        sha256: createHash("sha256").update(expected).digest("hex"),
      });
      expect(archive.entries.map((entry) => entry.fileName)).toContain(
        spec.requiredExecutable,
      );
      expect(fs.stat(`${spec.mountPrefix}${spec.requiredExecutable}`).size).toBe(
        `${spec.id} executable`.length,
      );
      expect(fs.exportLazyArchiveEntries()).toEqual([
        expect.objectContaining({
          url: spec.archiveUrl,
          mountPrefix: spec.mountPrefix,
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
      /vim-browser-bundle output .* must contain exactly one regular executable bin\/vim; found 0/,
    );
    expect(() => fs.stat("/usr/bin/vim")).toThrow();
    expect(fs.exportLazyArchiveEntries()).toEqual([]);
  });

  it("reports a corrupt declared output as an invalid lazy ZIP", () => {
    const spec = SHELL_LAZY_ARCHIVE_SPECS[0];
    const corruptPath = writeArchive(spec.archiveUrl, new Uint8Array([1, 2, 3]));

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
        resolveVfsArtifact(
          "programs/wasm32/vim.zip",
          "vim-browser-bundle",
        ),
      ).toThrow(
        `direct dependency vim-browser-bundle is available at ${dependencyDir}, ` +
        "but vim.zip was not found",
      );
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("locks the shell package and build recipe to declared bundle dependencies", () => {
    const packageToml = readFileSync(
      join(repoRoot, "packages/registry/shell/package.toml"),
      "utf8",
    );
    const buildToml = readFileSync(
      join(repoRoot, "packages/registry/shell/build.toml"),
      "utf8",
    );
    const buildScript = readFileSync(
      join(repoRoot, "packages/registry/shell/build-shell.sh"),
      "utf8",
    );

    expect(packageToml).toContain('"vim-browser-bundle@9.1.0900"');
    expect(packageToml).toContain('"nethack-browser-bundle@3.6.7"');
    expect(packageToml).not.toMatch(/^\s*"vim@/m);
    expect(packageToml).not.toMatch(/^\s*"nethack@/m);
    expect(buildToml).toContain('"images/vfs/scripts/shell-lazy-archives.ts"');
    expect(buildToml).toMatch(/^revision\s*=\s*14$/m);
    expect(buildToml).not.toContain("build-vim-zip.sh");
    expect(buildToml).not.toContain("build-nethack-zip.sh");
    expect(buildScript).not.toContain(
      "bash \"$REPO_ROOT/images/vfs/scripts/build-vim-zip.sh\"",
    );
    expect(buildScript).not.toContain(
      "bash \"$REPO_ROOT/images/vfs/scripts/build-nethack-zip.sh\"",
    );
  });
});
