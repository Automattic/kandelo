/**
 * Build a pre-built VFS image containing Perl 5.40.3 stdlib for the
 * browser demo.
 *
 * Produces: examples/browser/public/perl.vfs
 *
 * Usage: npx tsx examples/browser/scripts/build-perl-vfs-image.ts
 */
import { readFileSync, readdirSync, lstatSync, statSync, existsSync } from "fs";
import { join } from "path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  writeVfsFile,
  writeVfsBinary,
  ensureDir,
  ensureDirRecursive,
  saveImage,
} from "./vfs-image-helpers";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const PERL_SRC = join(REPO_ROOT, "examples", "libs", "perl", "perl-src");
const OUT_FILE = join(REPO_ROOT, "examples", "browser", "public", "perl.vfs");

// Target prefix in the VFS (matches Perl's compiled-in privlib)
const PRIVLIB = "/usr/lib/perl5/5.40.3";

// Directories to exclude entirely
const EXCLUDE_DIRS = new Set([
  "t", "test", "tests", ".git", "blib", "hints", "eg", "demo",
  "benchmark", "benchmarks", "corpus", "xt",
]);

// File patterns to exclude
const EXCLUDE_PATTERNS = [
  /\.t$/,       // test files
  /\.pod$/,     // documentation
  /\.bs$/,      // bootstrap files
  /\.o$/,       // object files
  /\.c$/,       // C source
  /\.h$/,       // C headers
  /\.xs$/,      // XS source
  /Makefile$/,
  /Makefile\.PL$/,
  /MANIFEST$/,
  /META\.json$/,
  /META\.yml$/,
  /Changes$/,
  /ChangeLog$/,
  /README/,
  /LICENSE/,
  /COPYING$/,
  /\.gitignore$/,
];

function shouldInclude(name: string): boolean {
  if (EXCLUDE_PATTERNS.some(p => p.test(name))) return false;
  // Include .pm, .pl, .ph files and Config_* files
  return /\.(pm|pl|ph)$/.test(name) || /^Config_/.test(name);
}

// Deduplication map: VFS path -> file data. Later sources override earlier.
const fileMap = new Map<string, Uint8Array>();

function scanDir(dir: string, prefix: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch { return; }

  for (const entry of entries) {
    const fullPath = join(dir, entry);

    // Skip symlinks
    try {
      if (lstatSync(fullPath).isSymbolicLink()) continue;
    } catch { continue; }

    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      scanDir(fullPath, prefix ? `${prefix}/${entry}` : entry);
    } else if (stat.isFile() && shouldInclude(entry)) {
      let data: Buffer | Uint8Array = readFileSync(fullPath);

      // Patch: warnings.pm line 620 does `delete @warnings::{qw(NORMAL FATAL MESSAGE LEVEL)}`
      // which triggers a "panic: del_backref, svp=0" crash in the wasm32 Perl build.
      // The delete is a space optimization that removes internal constants after use --
      // commenting it out is harmless (those constants just stay in the stash).
      if (entry === "warnings.pm" && !prefix) {
        const text = data.toString("utf8");
        const patched = text.replace(
          "delete @warnings::{qw(NORMAL FATAL MESSAGE LEVEL)};",
          "# delete @warnings::{qw(NORMAL FATAL MESSAGE LEVEL)}; # patched for wasm32",
        );
        if (patched !== text) {
          data = Buffer.from(patched, "utf8");
          console.log("  Patched warnings.pm (del_backref workaround)");
        }
      }

      const vfsPath = `${PRIVLIB}/${prefix ? prefix + "/" : ""}${entry}`;
      fileMap.set(vfsPath, new Uint8Array(data));
    }
  }
}

async function main() {
  // Validate prerequisites
  if (!existsSync(join(PERL_SRC, "lib", "strict.pm"))) {
    console.error("Perl source not found. Run: bash examples/libs/perl/build-perl.sh");
    process.exit(1);
  }

  // 1. Core lib/ directory -- strict.pm, warnings.pm, Config.pm, etc.
  console.log("  Scanning lib/...");
  scanDir(join(PERL_SRC, "lib"), "");

  // 2. cpan/*/lib/ -- bundled CPAN modules (Carp, Scalar::Util, List::Util, etc.)
  console.log("  Scanning cpan/*/lib/...");
  for (const mod of readdirSync(join(PERL_SRC, "cpan"))) {
    const libDir = join(PERL_SRC, "cpan", mod, "lib");
    if (existsSync(libDir)) {
      scanDir(libDir, "");
    }
  }

  // 3. dist/*/lib/ -- core distributions (Cwd, Storable, Data::Dumper, etc.)
  console.log("  Scanning dist/*/lib/...");
  for (const mod of readdirSync(join(PERL_SRC, "dist"))) {
    const libDir = join(PERL_SRC, "dist", mod, "lib");
    if (existsSync(libDir)) {
      scanDir(libDir, "");
    }
  }

  // 4. ext/*/lib/ -- core extensions (POSIX, File::Find, Fcntl, etc.)
  console.log("  Scanning ext/*/lib/...");
  for (const mod of readdirSync(join(PERL_SRC, "ext"))) {
    const libDir = join(PERL_SRC, "ext", mod, "lib");
    if (existsSync(libDir)) {
      scanDir(libDir, "");
    }
  }

  // Create a 16MB SharedArrayBuffer + MemoryFileSystem
  const sab = new SharedArrayBuffer(16 * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  // Create standard directories
  ensureDir(fs, "/tmp");
  fs.chmod("/tmp", 0o777);
  ensureDir(fs, "/home");
  ensureDir(fs, "/usr");
  ensureDir(fs, "/usr/lib");
  ensureDir(fs, "/usr/lib/perl5");
  ensureDir(fs, "/usr/lib/perl5/5.40.3");

  // Write all deduped files to VFS
  console.log(`Writing ${fileMap.size} files to VFS...`);
  for (const [vfsPath, data] of fileMap) {
    // Ensure parent directories exist
    const parts = vfsPath.split("/").filter(Boolean);
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current += "/" + parts[i];
      ensureDir(fs, current);
    }
    writeVfsBinary(fs, vfsPath, data, 0o644);
  }

  // Save image
  await saveImage(fs, OUT_FILE);
  console.log(`${fileMap.size} Perl stdlib files total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
