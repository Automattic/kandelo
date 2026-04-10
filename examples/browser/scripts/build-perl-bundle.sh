#!/usr/bin/env bash
#
# Build a Perl stdlib filesystem bundle (JSON) for the browser demo.
# Gathers .pm/.pl files from Perl's source tree (lib/, cpan/*/lib/,
# dist/*/lib/, ext/*/lib/) and packages them as base64 JSON.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BROWSER_DIR/../.." && pwd)"

PERL_SRC="$REPO_ROOT/examples/libs/perl/perl-src"
BUNDLE_DIR="$BROWSER_DIR/public"
BUNDLE_FILE="$BUNDLE_DIR/perl-bundle.json"

if [ ! -f "$PERL_SRC/lib/strict.pm" ]; then
    echo "Perl source not found. Run: bash examples/libs/perl/build-perl.sh"
    exit 1
fi

mkdir -p "$BUNDLE_DIR"

echo "==> Building Perl stdlib bundle..."

node --experimental-strip-types - "$PERL_SRC" "$BUNDLE_FILE" << 'BUNDLER'
import { readFileSync, readdirSync, statSync, lstatSync, writeFileSync, existsSync } from "fs";
import { join, relative } from "path";

const perlSrc = process.argv[2];
const outFile = process.argv[3];

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

interface BundleEntry {
  path: string;
  data: string; // base64
}

const files: BundleEntry[] = [];
let totalSize = 0;

function shouldInclude(name: string): boolean {
  if (EXCLUDE_PATTERNS.some(p => p.test(name))) return false;
  // Include .pm, .pl, .ph files and Config_* files
  return /\.(pm|pl|ph)$/.test(name) || /^Config_/.test(name);
}

function scanDir(dir: string, prefix: string) {
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
      let data = readFileSync(fullPath);

      // Patch: warnings.pm line 620 does `delete @warnings::{qw(NORMAL FATAL MESSAGE LEVEL)}`
      // which triggers a "panic: del_backref, svp=0" crash in the wasm32 Perl build.
      // The delete is a space optimization that removes internal constants after use —
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

      totalSize += data.length;
      files.push({
        path: `${PRIVLIB}/${prefix ? prefix + "/" : ""}${entry}`,
        data: data.toString("base64"),
      });
    }
  }
}

// 1. Core lib/ directory — strict.pm, warnings.pm, Config.pm, etc.
console.log("  Scanning lib/...");
scanDir(join(perlSrc, "lib"), "");

// 2. cpan/*/lib/ — bundled CPAN modules (Carp, Scalar::Util, List::Util, etc.)
console.log("  Scanning cpan/*/lib/...");
for (const mod of readdirSync(join(perlSrc, "cpan"))) {
  const libDir = join(perlSrc, "cpan", mod, "lib");
  if (existsSync(libDir)) {
    scanDir(libDir, "");
  }
}

// 3. dist/*/lib/ — core distributions (Cwd, Storable, Data::Dumper, etc.)
console.log("  Scanning dist/*/lib/...");
for (const mod of readdirSync(join(perlSrc, "dist"))) {
  const libDir = join(perlSrc, "dist", mod, "lib");
  if (existsSync(libDir)) {
    scanDir(libDir, "");
  }
}

// 4. ext/*/lib/ — core extensions (POSIX, File::Find, Fcntl, etc.)
console.log("  Scanning ext/*/lib/...");
for (const mod of readdirSync(join(perlSrc, "ext"))) {
  const libDir = join(perlSrc, "ext", mod, "lib");
  if (existsSync(libDir)) {
    scanDir(libDir, "");
  }
}

// Deduplicate by path (lib/ may overlap with cpan/dist/ext)
const seen = new Map<string, BundleEntry>();
for (const entry of files) {
  // Keep the last one (cpan/dist/ext override lib/)
  seen.set(entry.path, entry);
}
const dedupedFiles = Array.from(seen.values());

// Sort for deterministic output
dedupedFiles.sort((a, b) => a.path.localeCompare(b.path));

writeFileSync(outFile, JSON.stringify({ files: dedupedFiles }, null, 0));

const bundleSize = statSync(outFile).size;
console.log(`Files: ${dedupedFiles.length}`);
console.log(`Source size: ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
console.log(`Bundle size: ${(bundleSize / 1024 / 1024).toFixed(1)}MB`);
BUNDLER

echo "==> Perl bundle: $BUNDLE_FILE"
ls -lh "$BUNDLE_FILE"
