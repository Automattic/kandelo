#!/usr/bin/env bash
#
# Build a WordPress filesystem bundle (JSON) for the browser demo.
# Bundles all of WordPress — no files are excluded.
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
import { readFileSync, readdirSync, statSync, lstatSync, writeFileSync } from "fs";
import { join, relative } from "path";

const wpDir = process.argv[2];
const sqliteDir = process.argv[3];
const outFile = process.argv[4];

// No exclusions — bundle all of WordPress
function shouldExclude(_relPath: string): boolean {
  return false;
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
        const lstat = lstatSync(full);
        // Skip symlinks to avoid infinite recursion and double-counting
        if (lstat.isSymbolicLink()) continue;
        if (lstat.isDirectory()) {
          walk(full);
        } else if (lstat.isFile()) {
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

// Stream JSON to file to avoid exceeding Node.js max string size
import { createWriteStream } from "fs";
const stream = createWriteStream(outFile);
let totalBytes = 0;

function write(s: string) {
  stream.write(s);
  totalBytes += Buffer.byteLength(s);
}

write('{"files":[');
for (let i = 0; i < files.length; i++) {
  if (i > 0) write(",");
  write(JSON.stringify(files[i]));
}
write("]}");
stream.end();

await new Promise<void>((resolve, reject) => {
  stream.on("finish", resolve);
  stream.on("error", reject);
});

const sizeMB = (totalBytes / (1024 * 1024)).toFixed(1);
console.log(`Bundle: ${files.length} files, ${sizeMB} MB`);
BUNDLER

echo "==> Bundle written to $BUNDLE_FILE"
ls -lh "$BUNDLE_FILE"
