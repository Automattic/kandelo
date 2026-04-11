#!/usr/bin/env bash
#
# Build an Erlang/OTP runtime filesystem bundle (JSON) for the browser demo.
# Includes kernel, stdlib, erts, compiler ebin dirs + boot scripts.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BROWSER_DIR/../.." && pwd)"

INSTALL_DIR="$REPO_ROOT/examples/libs/erlang/erlang-install"
BUNDLE_DIR="$BROWSER_DIR/public"
BUNDLE_FILE="$BUNDLE_DIR/erlang-bundle.json"

if [ ! -d "$INSTALL_DIR/lib/kernel-10.4.2/ebin" ]; then
    echo "Erlang install not found. Run: bash examples/libs/erlang/build-erlang.sh"
    exit 1
fi

mkdir -p "$BUNDLE_DIR"

echo "==> Building Erlang/OTP runtime bundle..."

node --experimental-strip-types - "$INSTALL_DIR" "$BUNDLE_FILE" << 'BUNDLER'
import { readFileSync, readdirSync, statSync, lstatSync, writeFileSync } from "fs";
import { join, relative } from "path";

const installDir = process.argv[2];
const outFile = process.argv[3];

// Directories to include (relative to installDir)
const INCLUDE_DIRS = [
  "lib/kernel-10.4.2/ebin",
  "lib/stdlib-7.1/ebin",
  "lib/erts-16.1.2/ebin",
  "lib/compiler-9.0.3/ebin",
  "releases/28",
];

interface BundleEntry {
  path: string;
  data: string; // base64
}

const files: BundleEntry[] = [];
let totalSize = 0;

function scanDir(dir: string, vfsPrefix: string) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);

    // Skip symlinks
    try {
      if (lstatSync(fullPath).isSymbolicLink()) continue;
    } catch { continue; }

    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath, `${vfsPrefix}/${entry}`);
    } else if (stat.isFile()) {
      const data = readFileSync(fullPath);
      totalSize += data.length;
      files.push({
        path: `${vfsPrefix}/${entry}`,
        data: data.toString("base64"),
      });
    }
  }
}

for (const relDir of INCLUDE_DIRS) {
  const srcDir = join(installDir, relDir);
  const vfsPath = `/usr/local/lib/erlang/${relDir}`;
  scanDir(srcDir, vfsPath);
}

// Sort for deterministic output
files.sort((a, b) => a.path.localeCompare(b.path));

writeFileSync(outFile, JSON.stringify({ files }, null, 0));

const bundleSize = statSync(outFile).size;
console.log(`Files: ${files.length}`);
console.log(`Source size: ${(totalSize / 1024 / 1024).toFixed(1)}MB`);
console.log(`Bundle size: ${(bundleSize / 1024 / 1024).toFixed(1)}MB`);
BUNDLER

echo "==> Erlang bundle: $BUNDLE_FILE"
ls -lh "$BUNDLE_FILE"
