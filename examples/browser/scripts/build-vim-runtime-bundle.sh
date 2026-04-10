#!/usr/bin/env bash
#
# Build a Vim runtime filesystem bundle (JSON) for the browser shell demo.
# Packages the minimal runtime files from examples/libs/vim/runtime/ as
# base64 JSON entries under /usr/share/vim/vim91/.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$BROWSER_DIR/../.." && pwd)"

RUNTIME_DIR="$REPO_ROOT/examples/libs/vim/runtime"
BUNDLE_DIR="$BROWSER_DIR/public"
BUNDLE_FILE="$BUNDLE_DIR/vim-runtime-bundle.json"

if [ ! -d "$RUNTIME_DIR" ]; then
    echo "Vim runtime not found. Run: bash examples/libs/vim/bundle-runtime.sh"
    exit 1
fi

mkdir -p "$BUNDLE_DIR"

echo "==> Building Vim runtime bundle..."

node --experimental-strip-types - "$RUNTIME_DIR" "$BUNDLE_FILE" << 'BUNDLER'
import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const runtimeDir = process.argv[2];
const outFile = process.argv[3];

const VIM_RUNTIME = "/usr/share/vim/vim91";

interface BundleEntry {
  path: string;
  data: string; // base64
}

const files: BundleEntry[] = [];
let totalSize = 0;

function scanDir(dir: string, prefix: string) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      scanDir(fullPath, prefix ? `${prefix}/${entry}` : entry);
    } else if (stat.isFile()) {
      const data = readFileSync(fullPath);
      totalSize += data.length;
      files.push({
        path: `${VIM_RUNTIME}/${prefix ? prefix + "/" : ""}${entry}`,
        data: data.toString("base64"),
      });
    }
  }
}

scanDir(runtimeDir, "");
files.sort((a, b) => a.path.localeCompare(b.path));
writeFileSync(outFile, JSON.stringify({ files }, null, 0));

const bundleSize = statSync(outFile).size;
console.log(`Files: ${files.length}`);
console.log(`Source size: ${(totalSize / 1024).toFixed(0)}KB`);
console.log(`Bundle size: ${(bundleSize / 1024).toFixed(0)}KB`);
BUNDLER

echo "==> Vim runtime bundle: $BUNDLE_FILE"
ls -lh "$BUNDLE_FILE"
