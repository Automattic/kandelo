#!/usr/bin/env bash
#
# Build a WordPress filesystem bundle (JSON) for the browser demo.
# Strips non-essential files to reduce size.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BROWSER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WP_EXAMPLE_DIR="$(cd "$BROWSER_DIR/../wordpress" && pwd)"
WP_DIR="$WP_EXAMPLE_DIR/wordpress"
SQLITE_DIR="$WP_EXAMPLE_DIR/sqlite-database-integration"

BUNDLE_DIR="$BROWSER_DIR/public"
BUNDLE_FILE="$BUNDLE_DIR/wp-bundle.json"

# Ensure WordPress is downloaded
if [ ! -f "$WP_DIR/wp-settings.php" ]; then
    echo "WordPress not found. Run: bash examples/wordpress/setup.sh"
    exit 1
fi

mkdir -p "$BUNDLE_DIR"

echo "==> Building WordPress bundle..."

# Use Node.js to create the bundle (base64 encode files, skip unnecessary ones)
node --experimental-strip-types - "$WP_DIR" "$SQLITE_DIR" "$BUNDLE_FILE" << 'BUNDLER'
import { readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";

const wpDir = process.argv[2];
const sqliteDir = process.argv[3];
const outFile = process.argv[4];

// File patterns to exclude (reduce bundle size)
const EXCLUDE_PATTERNS = [
  /\.txt$/i,
  /\.md$/i,
  /README/i,
  /LICENSE/i,
  /CHANGELOG/i,
  /\.pot$/,        // translation templates
  /\.po$/,         // translations
  /\.mo$/,         // compiled translations
  /\.min\.map$/,   // source maps
  /\.map$/,        // all source maps
  /wp-content\/themes\/twentytwentyfour/,
  /wp-content\/themes\/twentytwentythree/,
  /wp-content\/plugins\/akismet/,
  /wp-content\/plugins\/hello\.php/,
  /wp-includes\/fonts\//,         // web fonts (not needed for basic demo)
  /wp-includes\/js\/dist\//,      // block editor JS bundles (huge)
  /wp-includes\/blocks\//,        // block assets
  /wp-includes\/css\/dist\//,     // block editor CSS
  /wp-admin\/css\/colors\//,      // admin color schemes (keep default only)
  /wp-admin\/images\//,           // admin images
];

function shouldExclude(relPath: string): boolean {
  return EXCLUDE_PATTERNS.some(p => p.test(relPath));
}

interface BundleEntry {
  path: string;
  data: string;
}

function collectFiles(rootDir: string, mountPrefix: string): BundleEntry[] {
  const entries: BundleEntry[] = [];

  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = relative(rootDir, full);
      const mountPath = mountPrefix + "/" + rel;

      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (stat.isFile()) {
          if (shouldExclude(rel)) continue;
          const data = readFileSync(full);
          entries.push({
            path: mountPath,
            data: data.toString("base64"),
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  walk(rootDir);
  return entries;
}

// Collect WordPress core files
const files: BundleEntry[] = [];
files.push(...collectFiles(wpDir, "/var/www/html"));

// Collect SQLite plugin files (resolve symlink)
files.push(
  ...collectFiles(sqliteDir, "/var/www/html/wp-content/plugins/sqlite-database-integration")
);

const bundle = { files };
const json = JSON.stringify(bundle);
writeFileSync(outFile, json);

const sizeMB = (Buffer.byteLength(json) / (1024 * 1024)).toFixed(1);
console.log(`Bundle: ${files.length} files, ${sizeMB} MB`);
BUNDLER

echo "==> Bundle written to $BUNDLE_FILE"
ls -lh "$BUNDLE_FILE"
