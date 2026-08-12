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
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { findRepoRoot, tryResolveBinary } from "../../../host/src/binary-resolver";
import { preparePhpTestFixtures } from "./php-test-fixtures";
import { ensureSourceExtract } from "./source-extract-helper";
import {
  exactVfsImageMetadata,
  saveImage,
  type ExactVfsImageAbi,
  walkAndWrite,
} from "./vfs-image-helpers";
import { resolvePackageRuntimeFile } from "../../../scripts/package-runtime-file";

const DEFAULT_FS_MAX_BYTES = 2 * 1024 * 1024 * 1024;

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

interface PhpTestFingerprintInputs {
  sourceRoot: string;
  fixtureRoot: string;
  rootfsPath: string;
  phpPath: string;
  phpFpmPath?: string;
  extensionDirectories: readonly string[];
  opcachePath?: string;
  intlPath?: string;
  icuPath?: string;
  runtimeContract?: {
    artifact: string;
    guestPath: string;
    mode: number;
  };
  maximumBytes: number;
}

function phpTestVfsFingerprint(inputs: PhpTestFingerprintInputs): string {
  const hash = createHash("sha256");
  hash.update(`php-test-vfs-v2\0max=${inputs.maximumBytes}\0`);
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
  hashInputPath(hash, "source", inputs.sourceRoot);
  hashInputPath(hash, "fixtures", inputs.fixtureRoot);
  hashInputPath(hash, "rootfs", inputs.rootfsPath);
  hashInputPath(hash, "php", inputs.phpPath);
  hashInputPath(hash, "php-fpm", inputs.phpFpmPath);
  for (const [index, extensionDir] of inputs.extensionDirectories.entries()) {
    hashInputPath(hash, `extensions-${index}`, extensionDir);
  }
  hashInputPath(hash, "opcache", inputs.opcachePath);
  hashInputPath(hash, "intl", inputs.intlPath);
  hashInputPath(hash, "intl-icu-data", inputs.icuPath);
  if (inputs.runtimeContract !== undefined) {
    const runtime = inputs.runtimeContract;
    hash.update(
      `runtime-contract\0${runtime.artifact}\0${runtime.guestPath}\0${runtime.mode}\0`,
    );
  }
  return hash.digest("hex");
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

export interface PhpTestVfsInputs {
  baseImage: Uint8Array;
  php: Uint8Array;
  phpFpm?: Uint8Array;
  extensions: Readonly<Record<string, Uint8Array>>;
  icuData?: Uint8Array;
  sourceDirectory: string;
  fixtureDirectory: string;
  outputPath: string;
  targetAbi?: ExactVfsImageAbi;
  maximumBytes?: number;
}

export async function buildPhpTestVfsImage(
  inputs: PhpTestVfsInputs,
): Promise<void> {
  if (!existsSync(inputs.sourceDirectory)) {
    throw new Error(`PHP test source input is missing: ${inputs.sourceDirectory}`);
  }
  if (!existsSync(inputs.fixtureDirectory)) {
    throw new Error(`PHP fixture input is missing: ${inputs.fixtureDirectory}`);
  }
  if (inputs.php.byteLength === 0) throw new Error("PHP executable input is empty");
  for (const [name, bytes] of Object.entries(inputs.extensions)) {
    if (!/^[A-Za-z0-9_+-]+\.so$/.test(name) || bytes.byteLength === 0) {
      throw new Error(`PHP extension input is invalid: ${name}`);
    }
  }
  if ((inputs.extensions["intl.so"] !== undefined) !== (inputs.icuData !== undefined)) {
    throw new Error("PHP intl.so and icu.dat must be supplied together");
  }
  const maximumBytes = inputs.maximumBytes ?? DEFAULT_FS_MAX_BYTES;
  const stagingRoot = mkdtempSync(join(tmpdir(), "kandelo-php-vfs-source-"));
  const phpSrc = join(stagingRoot, "php-src");
  try {
    cpSync(inputs.sourceDirectory, phpSrc, {
      recursive: true,
      dereference: false,
      filter: (path) => {
        const base = path.split(/[\\/]/).pop();
        return base !== ".git" && base !== ".deps" && base !== ".libs";
      },
    });
    preparePhpTestFixtures(phpSrc, inputs.fixtureDirectory);

    console.log("==> Building PHP PHPT test VFS image");
    let fs = MemoryFileSystem.fromImage(
      inputs.baseImage,
      { maxByteLength: maximumBytes },
    );
    await fs.verifyImportedLazyAtomicGroupSeals();
    if (inputs.targetAbi !== undefined) {
      const metadata = fs.getImageMetadata();
      if (
        metadata?.kernelAbi !== inputs.targetAbi.version ||
        metadata.abiSnapshotSha256 !== inputs.targetAbi.snapshotSha256
      ) {
        throw new Error("PHP test base product ABI differs from its target");
      }
    }
    const baseStats = fs.statfs("/");
    const baseMaxBytes = baseStats.blocks * baseStats.bsize;
    if (baseMaxBytes < maximumBytes) {
      fs = fs.rebaseToNewFileSystem(maximumBytes);
    }
    ensureDirRecursive(fs, "/usr/local/bin");
    ensureDirRecursive(fs, "/usr/local/sbin");
    ensureDirRecursive(fs, "/usr/lib/php/extensions");
    ensureDirRecursive(fs, "/php-src");

    writeVfsBinary(fs, "/usr/local/bin/php", inputs.php);
    if (inputs.phpFpm !== undefined) {
      writeVfsBinary(fs, "/usr/local/sbin/php-fpm", inputs.phpFpm);
    }
    for (const [name, bytes] of Object.entries(inputs.extensions).sort()) {
      writeVfsBinary(
        fs,
        `/usr/lib/php/extensions/${name}`,
        bytes,
        0o755,
      );
    }
    if (inputs.icuData !== undefined) {
      ensureDirRecursive(fs, "/usr/lib/php");
      writeVfsBinary(
        fs,
        "/usr/lib/php/icu.dat",
        inputs.icuData,
        0o644,
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
      });
    }
    if (supportDirs.length > 0) {
      console.log(`  Writing ${supportDirs.length} PHPT support directories...`);
      for (const dir of supportDirs) {
        fileCount += copySupportFiles(fs, phpSrc, dir);
      }
    }
    console.log(`    ${fileCount} files`);

    await saveImage(fs, inputs.outputPath, inputs.targetAbi === undefined
      ? {}
      : {
          kernelAbi: inputs.targetAbi.version,
          metadata: exactVfsImageMetadata(
            inputs.targetAbi,
            "images/vfs/scripts/build-php-test-vfs-image.ts",
          ),
        });
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const repositoryRoot = findRepoRoot();
  const fixtureRoot = join(repositoryRoot, "tests/php-fixtures");
  const localSource = join(repositoryRoot, "packages/registry/php/php-src");
  const runtime = resolvePackageRuntimeFile(repositoryRoot, "php", "icu.dat");
  const phpPath = process.env.PHP_WASM ?? runtime?.closureHostPaths.get("php/php.wasm")
    ?? join(localSource, "sapi/cli/php");
  const extensionDirectories = [
    dirname(phpPath),
    ...((process.env.PHP_EXTENSION_DIR ?? "").split(delimiter)
      .map((path) => path.trim()).filter(Boolean)),
  ];
  const phpFpmPath = process.env.PHP_FPM_WASM ??
    runtime?.closureHostPaths.get("php/php-fpm.wasm");
  const opcachePath = process.env.PHP_OPCACHE_SO ??
    runtime?.closureHostPaths.get("php/opcache.so");
  const intlPath = runtime?.closureHostPaths.get("php/intl.so") ??
    [...extensionDirectories].reverse().map((dir) => join(dir, "intl.so"))
      .find((path) => existsSync(path));
  const rootfsPath = process.env.ROOTFS_VFS ?? tryResolveBinary("rootfs.vfs") ??
    tryResolveBinary("programs/rootfs.vfs") ?? join(repositoryRoot, "host/wasm/rootfs.vfs");
  const sourceRoot = process.env.PHP_SOURCE_DIR ?? ensureSourceExtract(
    "php",
    repositoryRoot,
    existsSync(localSource) ? localSource : undefined,
  );
  const outputPath = process.env.PHP_TEST_VFS_OUT ??
    join(repositoryRoot, "apps/browser-demos/public/php-test.vfs.zst");
  const maximumBytes = Number(process.env.PHP_TEST_VFS_MAX_BYTES ?? DEFAULT_FS_MAX_BYTES);
  const fingerprint = phpTestVfsFingerprint({
    sourceRoot,
    fixtureRoot,
    rootfsPath,
    phpPath,
    ...(phpFpmPath === undefined ? {} : { phpFpmPath }),
    extensionDirectories,
    ...(opcachePath === undefined ? {} : { opcachePath }),
    ...(intlPath === undefined ? {} : { intlPath }),
    ...(runtime === undefined ? {} : { icuPath: runtime.hostPath }),
    ...(runtime === undefined
      ? {}
      : {
          runtimeContract: {
            artifact: runtime.artifact,
            guestPath: runtime.guestPath,
            mode: runtime.mode,
          },
        }),
    maximumBytes,
  });
  if (process.argv.includes("--print-fingerprint")) {
    process.stdout.write(`${fingerprint}\n`);
    return;
  }
  const extensions: Record<string, Uint8Array> = {};
  for (const directory of extensionDirectories) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory).sort()) {
      if (entry.endsWith(".so")) {
        extensions[entry] = new Uint8Array(readFileSync(join(directory, entry)));
      }
    }
  }
  if (opcachePath !== undefined) {
    extensions["opcache.so"] = new Uint8Array(readFileSync(opcachePath));
  }
  if (intlPath !== undefined) {
    if (runtime === undefined) {
      throw new Error("PHP intl.so is present without its declared icu.dat runtime file");
    }
    extensions["intl.so"] = new Uint8Array(readFileSync(intlPath));
  }
  await buildPhpTestVfsImage({
    baseImage: new Uint8Array(readFileSync(rootfsPath)),
    php: new Uint8Array(readFileSync(phpPath)),
    ...(phpFpmPath === undefined ? {} : { phpFpm: new Uint8Array(readFileSync(phpFpmPath)) }),
    extensions,
    ...(runtime === undefined ? {} : { icuData: new Uint8Array(readFileSync(runtime.hostPath)) }),
    sourceDirectory: sourceRoot,
    fixtureDirectory: fixtureRoot,
    outputPath,
    maximumBytes,
  });
  writeFileSync(`${outputPath}.meta.json`, `${JSON.stringify({
    version: 1,
    fingerprint,
    generatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
