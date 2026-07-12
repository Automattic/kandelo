/**
 * Build a VFS image for running php-src PHPT runtime tests in the browser.
 *
 * The image contains:
 *   - /bin/sh plus standard shell utilities for PHP's shell-backed exec APIs
 *   - /usr/local/bin/php
 *   - /php-src/<test directories containing .phpt files>
 *
 * The Playwright-side runner parses each .phpt file and writes transient
 * PHP scripts into the restored image before spawning /usr/local/bin/php.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { findRepoRoot, tryResolveBinary } from "../../../host/src/binary-resolver";
import { preparePhpTestFixtures } from "./php-test-fixtures";
import { ensureSourceExtract } from "./source-extract-helper";
import { saveImage, walkAndWrite } from "./vfs-image-helpers";

const REPO_ROOT = findRepoRoot();
const PHP_FIXTURE_ROOT = join(REPO_ROOT, "tests/php-fixtures");
const LOCAL_PHP_SRC = join(REPO_ROOT, "packages/registry/php/php-src");
const PHP_WASM = process.env.PHP_WASM
  ?? tryResolveBinary("programs/php/php.wasm")
  ?? join(LOCAL_PHP_SRC, "sapi/cli/php");
const OPCACHE_SO = process.env.PHP_OPCACHE_SO
  ?? tryResolveBinary("programs/php/opcache.so");
const PHP_EXTENSION_DIRS = [
  dirname(PHP_WASM),
  ...((process.env.PHP_EXTENSION_DIR ?? "")
    .split(delimiter)
    .map((path) => path.trim())
    .filter(Boolean)),
];
const PHP_FPM_WASM = process.env.PHP_FPM_WASM
  ?? tryResolveBinary("programs/php/php-fpm.wasm");
const ROOTFS_VFS = process.env.ROOTFS_VFS
  ?? tryResolveBinary("programs/rootfs/rootfs.vfs")
  ?? join(REPO_ROOT, "host/wasm/rootfs.vfs");
const OUT_FILE = process.env.PHP_TEST_VFS_OUT
  ?? join(REPO_ROOT, "apps/browser-demos/public/php-test.vfs.zst");
const FS_MAX_BYTES = Number(process.env.PHP_TEST_VFS_MAX_BYTES ?? 2 * 1024 * 1024 * 1024);
const META_FILE = `${OUT_FILE}.meta.json`;

function hashInputPath(
  hash: Hash,
  label: string,
  path: string | null | undefined,
): void {
  hash.update(`input\0${label}\0`);
  if (!path || !existsSync(path)) {
    hash.update("missing\0");
    return;
  }
  const root = path;
  const visit = (current: string) => {
    const st = lstatSync(current);
    const rel = relative(root, current) || ".";
    hash.update(`${rel}\0${st.mode & 0o7777}\0`);
    if (st.isSymbolicLink()) {
      hash.update(`link\0${readlinkSync(current)}\0`);
    } else if (st.isDirectory()) {
      hash.update("dir\0");
      for (const entry of readdirSync(current).sort()) {
        if (entry === ".git" || entry === ".deps" || entry === ".libs") continue;
        visit(join(current, entry));
      }
    } else if (st.isFile()) {
      hash.update("file\0");
      hash.update(readFileSync(current));
    } else {
      hash.update("unsupported\0");
    }
  };
  visit(path);
}

function phpTestVfsFingerprint(sourceRoot: string): string {
  const hash = createHash("sha256");
  hash.update(`php-test-vfs-v2\0max=${FS_MAX_BYTES}\0`);
  hashInputPath(hash, "builder", fileURLToPath(import.meta.url));
  hashInputPath(
    hash,
    "fixture-preparation",
    join(dirname(fileURLToPath(import.meta.url)), "php-test-fixtures.ts"),
  );
  hashInputPath(
    hash,
    "helpers",
    join(dirname(fileURLToPath(import.meta.url)), "vfs-image-helpers.ts"),
  );
  hashInputPath(hash, "source", sourceRoot);
  hashInputPath(hash, "fixtures", PHP_FIXTURE_ROOT);
  hashInputPath(hash, "rootfs", ROOTFS_VFS);
  hashInputPath(hash, "php", PHP_WASM);
  hashInputPath(hash, "php-fpm", PHP_FPM_WASM);
  for (const [index, extensionDir] of PHP_EXTENSION_DIRS.entries()) {
    hashInputPath(hash, `extensions-${index}`, extensionDir);
  }
  hashInputPath(hash, "opcache", OPCACHE_SO);
  return hash.digest("hex");
}

function resolvePhpSource(): string {
  return process.env.PHP_SOURCE_DIR
    ?? ensureSourceExtract("php", REPO_ROOT, existsSync(LOCAL_PHP_SRC) ? LOCAL_PHP_SRC : undefined);
}

function collectPhptDirs(root: string): string[] {
  const dirs = new Set<string>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".deps" || entry.name === ".libs") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".phpt")) {
        dirs.add(dir);
      }
    }
  }
  walk(root);
  // Some PHPTs include helper fixtures from extension directories that do not
  // themselves contain .phpt files. Keep those directories in the browser VFS
  // so SKIPIF sections behave like they do against a complete php-src tree.
  for (const rel of ["ext/dl_test/tests"]) {
    const full = join(root, rel);
    if (existsSync(full)) dirs.add(full);
  }
  return [...dirs].sort();
}

const SUPPORT_FILE_PATTERN =
  /\.(?:inc|php|phtml|pem|crt|csr|key|cnf|ini|txt|dat|data|json|xml|xsd|dtd|rng|csv|sql|stub)$/i;

function isTestPath(relPath: string): boolean {
  return relPath.split(/[\\/]+/).includes("tests");
}

function isSupportFileName(name: string): boolean {
  return SUPPORT_FILE_PATTERN.test(name);
}

function directoryHasSupportFiles(sourceRoot: string, dir: string): boolean {
  const relDir = relative(sourceRoot, dir);
  if (!relDir || !isTestPath(relDir)) return false;
  for (const entry of readdirSync(dir)) {
    if (!isSupportFileName(entry)) continue;
    try {
      if (statSync(join(dir, entry)).isFile()) return true;
    } catch {
      // Ignore unreadable or disappearing entries.
    }
  }
  return false;
}

function collectPhptSupportDirs(sourceRoot: string, phptDirs: string[]): string[] {
  const dirs = new Set<string>();
  const phptDirSet = new Set(phptDirs);
  for (const phptDir of phptDirs) {
    let current = dirname(phptDir);
    while (current !== sourceRoot && current.startsWith(sourceRoot)) {
      if (!phptDirSet.has(current) && directoryHasSupportFiles(sourceRoot, current)) {
        dirs.add(current);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return [...dirs].sort();
}

function copySupportFiles(
  fs: MemoryFileSystem,
  sourceRoot: string,
  dir: string,
): number {
  const relDir = relative(sourceRoot, dir);
  const destDir = relDir ? `/php-src/${relDir}` : "/php-src";
  ensureDirRecursive(fs, destDir);
  let count = 0;
  for (const entry of readdirSync(dir)) {
    if (!isSupportFileName(entry)) continue;
    const relPath = relDir ? `${relDir}/${entry}` : entry;
    if (shouldExclude(sourceRoot, relPath)) continue;
    const full = join(dir, entry);
    const st = lstatSync(full);
    const dest = `${destDir}/${entry}`;
    if (st.isSymbolicLink()) {
      fs.symlink(readlinkSync(full), dest);
      count++;
    } else if (st.isFile()) {
      writeVfsBinary(
        fs,
        dest,
        new Uint8Array(readFileSync(full)),
        st.mode & 0o7777,
      );
      count++;
    }
  }
  return count;
}

function shouldExclude(sourceRoot: string, relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  if (relPath.includes("/.git/") || relPath.includes("/.deps/") || relPath.includes("/.libs/")) return true;
  if (base.startsWith(".nfs")) return true;
  if (isGeneratedPhptArtifact(sourceRoot, relPath)) return true;
  if (base.endsWith(".o") || base.endsWith(".lo") || base.endsWith(".la") || base.endsWith(".a")) return true;
  if (base === "php" || base === "phpdbg" || base === "php-cgi" || base === "php-fpm") {
    try {
      const st = statSync(join(sourceRoot, relPath));
      return st.size > 1024 * 1024;
    } catch {
      return true;
    }
  }
  return false;
}

function isGeneratedPhptArtifact(sourceRoot: string, relPath: string): boolean {
  const slash = relPath.lastIndexOf("/");
  const dir = slash >= 0 ? relPath.slice(0, slash) : "";
  const base = slash >= 0 ? relPath.slice(slash + 1) : relPath;

  // Some PHPTs create a same-stem directory next to the test and then remove
  // it from --CLEAN--. If a long browser run is interrupted during the test,
  // the source checkout/cache can retain a huge generated directory; baking it
  // into the immutable browser VFS changes the next run's initial state. Keep
  // small same-stem directories because upstream also uses that convention for
  // legitimate helper fixtures (for example ext/phar/tests/bug53872/).
  if (base && existsSync(join(sourceRoot, dir, `${base}.phpt`))) {
    try {
      const full = join(sourceRoot, relPath);
      const st = statSync(full);
      if (st.isDirectory() && readdirSync(full).length >= 100) {
        return true;
      }
    } catch {
      // Fall through to the file-artifact checks below.
    }
  }

  for (const suffix of [".skip.php", ".clean.php", ".php"]) {
    if (!base.endsWith(suffix)) continue;
    const stem = base.slice(0, -suffix.length);
    if (stem && existsSync(join(sourceRoot, dir, `${stem}.phpt`))) return true;
  }

  // Same-stem archives and databases are often committed PHPT fixtures. The
  // staging-copy lifecycle prevents this builder from contaminating its source
  // tree, so filename heuristics must not discard those legitimate inputs.
  return false;
}

async function main() {
  if (!existsSync(PHP_WASM)) {
    throw new Error(`PHP wasm not found at ${PHP_WASM}. Run: bash packages/registry/php/build-php.sh`);
  }
  if (!ROOTFS_VFS || !existsSync(ROOTFS_VFS)) {
    throw new Error(
      `rootfs.vfs not found at ${ROOTFS_VFS}. Build the rootfs package or set ROOTFS_VFS`,
    );
  }
  const phpSourceInput = resolvePhpSource();
  if (!existsSync(phpSourceInput)) {
    throw new Error(`php-src not found at ${phpSourceInput}`);
  }
  const fingerprint = phpTestVfsFingerprint(phpSourceInput);
  if (process.argv.includes("--print-fingerprint")) {
    process.stdout.write(`${fingerprint}\n`);
    return;
  }
  const stagingRoot = mkdtempSync(join(tmpdir(), "kandelo-php-vfs-source-"));
  const phpSrc = join(stagingRoot, "php-src");
  try {
    cpSync(phpSourceInput, phpSrc, {
      recursive: true,
      dereference: false,
      filter: (path) => {
        const base = path.split(/[\\/]/).pop();
        return base !== ".git" && base !== ".deps" && base !== ".libs";
      },
    });
    preparePhpTestFixtures(phpSrc, PHP_FIXTURE_ROOT);

    console.log("==> Building PHP PHPT test VFS image");
    console.log(`  php-src input: ${phpSourceInput}`);

    let fs = MemoryFileSystem.fromImage(
      new Uint8Array(readFileSync(ROOTFS_VFS)),
      { maxByteLength: FS_MAX_BYTES },
    );
    const baseStats = fs.statfs("/");
    const baseMaxBytes = baseStats.blocks * baseStats.bsize;
    if (baseMaxBytes < FS_MAX_BYTES) {
      console.log(
        `  Rebasing rootfs capacity from ${Math.round(baseMaxBytes / 1024 / 1024)} MiB ` +
          `to ${Math.round(FS_MAX_BYTES / 1024 / 1024)} MiB...`,
      );
      fs = fs.rebaseToNewFileSystem(FS_MAX_BYTES);
    }
    ensureDirRecursive(fs, "/usr/local/bin");
    ensureDirRecursive(fs, "/usr/local/sbin");
    ensureDirRecursive(fs, "/usr/lib/php/extensions");
    ensureDirRecursive(fs, "/php-src");

    writeVfsBinary(fs, "/usr/local/bin/php", new Uint8Array(readFileSync(PHP_WASM)));
    if (PHP_FPM_WASM && existsSync(PHP_FPM_WASM)) {
      writeVfsBinary(
        fs,
        "/usr/local/sbin/php-fpm",
        new Uint8Array(readFileSync(PHP_FPM_WASM)),
      );
    }
    for (const extensionDir of PHP_EXTENSION_DIRS) {
      if (!existsSync(extensionDir)) continue;
      for (const entry of readdirSync(extensionDir)) {
        if (!entry.endsWith(".so")) continue;
        const src = join(extensionDir, entry);
        writeVfsBinary(
          fs,
          `/usr/lib/php/extensions/${entry}`,
          new Uint8Array(readFileSync(src)),
        );
      }
    }
    if (OPCACHE_SO && existsSync(OPCACHE_SO)) {
      // PHP_OPCACHE_SO is the explicit harness override for the OPcache side
      // module. Honor it even when PHP_EXTENSION_DIR also contains an
      // opcache.so; otherwise browser PHPT runs can silently package a stale
      // or non-side-module opcache under the canonical extension path while the
      // runner advertises OPcache as available.
      writeVfsBinary(
        fs,
        "/usr/lib/php/extensions/opcache.so",
        new Uint8Array(readFileSync(OPCACHE_SO)),
      );
    }

    const phptDirs = collectPhptDirs(phpSrc);
    const supportDirs = collectPhptSupportDirs(phpSrc, phptDirs);
    console.log(`  Writing ${phptDirs.length} PHPT directories...`);
    let fileCount = 0;
    for (const dir of phptDirs) {
      const rel = relative(phpSrc, dir);
      const dest = rel ? `/php-src/${rel}` : "/php-src";
      ensureDirRecursive(fs, dirname(dest));
      fileCount += walkAndWrite(fs, dir, dest, {
        exclude: (childRel) => shouldExclude(phpSrc, rel ? `${rel}/${childRel}` : childRel),
        preserveMode: true,
        preserveSymlinks: true,
        failOnError: true,
      });
    }
    if (supportDirs.length > 0) {
      console.log(`  Writing ${supportDirs.length} PHPT support directories...`);
      for (const dir of supportDirs) {
        fileCount += copySupportFiles(fs, phpSrc, dir);
      }
    }
    console.log(`    ${fileCount} files`);

    await saveImage(fs, OUT_FILE);
    writeFileSync(
      META_FILE,
      `${JSON.stringify(
        {
          version: 1,
          fingerprint,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
