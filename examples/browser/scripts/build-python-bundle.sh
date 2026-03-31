#!/usr/bin/env bash
#
# Build a CPython stdlib filesystem bundle (JSON) for the browser demo.
# Includes only the modules needed for a functional REPL + common imports.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BROWSER_DIR/../.." && pwd)"

STDLIB_DIR="$REPO_ROOT/examples/libs/cpython/cpython-src/Lib"
BUNDLE_DIR="$BROWSER_DIR/public"
BUNDLE_FILE="$BUNDLE_DIR/python-bundle.json"

if [ ! -f "$STDLIB_DIR/os.py" ]; then
    echo "CPython stdlib not found. Run: bash examples/libs/cpython/build-cpython.sh"
    exit 1
fi

mkdir -p "$BUNDLE_DIR"

echo "==> Building Python stdlib bundle..."

node --experimental-strip-types - "$STDLIB_DIR" "$BUNDLE_FILE" << 'BUNDLER'
import { readFileSync, readdirSync, statSync, lstatSync, writeFileSync } from "fs";
import { join, relative } from "path";

const stdlibDir = process.argv[2];
const outFile = process.argv[3];

// Directories to exclude entirely (save space)
const EXCLUDE_DIRS = new Set([
  "test", "tests", "__pycache__", "idlelib", "tkinter", "turtledemo",
  "ensurepip", "lib2to3", "pydoc_data", "unittest", "doctest",
  "xmlrpc", "multiprocessing", "concurrent", "asyncio",
  "ctypes", "distutils", "venv", "curses",
]);

// File patterns to exclude
const EXCLUDE_PATTERNS = [
  /\.pyc$/i,
  /\.pyo$/i,
  /\.opt-\d\.pyc$/i,
];

interface BundleEntry {
  path: string;
  data: string; // base64
}

const files: BundleEntry[] = [];
let totalSize = 0;
let skippedSize = 0;

function scanDir(dir: string, prefix: string) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const relPath = prefix ? `${prefix}/${entry}` : entry;

    // Skip symlinks
    try {
      if (lstatSync(fullPath).isSymbolicLink()) continue;
    } catch { continue; }

    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) {
        skippedSize += getDirSize(fullPath);
        continue;
      }
      scanDir(fullPath, relPath);
    } else if (stat.isFile()) {
      if (EXCLUDE_PATTERNS.some(p => p.test(entry))) continue;

      const data = readFileSync(fullPath);
      totalSize += data.length;
      files.push({
        path: `/usr/lib/python3.13/${relPath}`,
        data: data.toString("base64"),
      });
    }
  }
}

function getDirSize(dir: string): number {
  let size = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) size += getDirSize(fullPath);
      else size += stat.size;
    }
  } catch {}
  return size;
}

scanDir(stdlibDir, "");

// Sort for deterministic output
files.sort((a, b) => a.path.localeCompare(b.path));

writeFileSync(outFile, JSON.stringify({ files }, null, 0));

const bundleSize = statSync(outFile).size;
console.log(`Files: ${files.length}`);
console.log(`Source size: ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
console.log(`Skipped: ${(skippedSize / 1024 / 1024).toFixed(1)}MB`);
console.log(`Bundle size: ${(bundleSize / 1024 / 1024).toFixed(1)}MB`);
BUNDLER

echo "==> Python bundle: $BUNDLE_FILE"
ls -lh "$BUNDLE_FILE"
