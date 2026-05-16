/**
 * Build a pre-built VFS image containing npm 10.9.2 + a writable workspace
 * for the browser node demo.
 *
 * Layout produced:
 *   /usr/local/lib/npm/...   — full npm dist (bin/npm-cli.js + lib + node_modules)
 *   /work/package.json       — empty starter package, used as --prefix and HOME
 *   /tmp/                    — writable, mode 0o777
 *   /root/                   — fallback HOME
 *   /usr/bin, /bin           — placeholder PATH dirs
 *
 * Excludes npm's man/ and docs/ (man pages + markdown docs add ~3 MB and
 * are never read during `npm install`).
 *
 * Output: examples/browser/public/node-vfs.vfs.zst
 *
 * Usage: npx tsx examples/browser/scripts/build-node-vfs-image.ts
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  walkAndWrite,
  writeVfsFile,
  saveImage,
} from "./vfs-image-helpers";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const NPM_DIST = join(REPO_ROOT, "examples", "libs", "npm", "dist");
const OUT_FILE = join(REPO_ROOT, "examples", "browser", "public", "node-vfs.vfs.zst");

const NPM_MOUNT = "/usr/local/lib/npm";

async function main() {
  if (!existsSync(join(NPM_DIST, "bin", "npm-cli.js"))) {
    console.error(`npm dist not found at ${NPM_DIST}/bin/npm-cli.js`);
    console.error("Run: bash examples/libs/npm/build-npm.sh (or whatever populates examples/libs/npm/dist)");
    process.exit(1);
  }

  // 32 MiB SAB. npm dist is ~17 MiB on disk; rest is overhead + scratch headroom.
  // The .vfs file size equals the SAB size verbatim (saveImage writes the full buffer).
  const sab = new SharedArrayBuffer(32 * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  // Filesystem skeleton
  ensureDirRecursive(fs, "/usr/local/lib");
  ensureDir(fs, "/usr/bin");
  ensureDir(fs, "/bin");
  ensureDir(fs, "/work");
  ensureDir(fs, "/root");
  ensureDir(fs, "/tmp");
  // /etc/ssl needs to exist before kernel-worker auto-writes the bundled
  // CA cert to /etc/ssl/cert.pem on init. Without this, npm install over
  // HTTPS fails — see kernel-worker-entry.ts handleInit.
  ensureDirRecursive(fs, "/etc/ssl");
  fs.chmod("/tmp", 0o777);
  fs.chmod("/work", 0o777);

  // npm dist — skip man/ and docs/ (not used at install time)
  console.log(`Mounting npm dist at ${NPM_MOUNT}...`);
  const written = walkAndWrite(fs, NPM_DIST, NPM_MOUNT, {
    exclude: (rel) => rel === "man" || rel.startsWith("man/")
                   || rel === "docs" || rel.startsWith("docs/"),
  });
  console.log(`  ${written} files written`);

  // Starter package.json so `npm install --prefix /work` has somewhere to write.
  writeVfsFile(
    fs,
    "/work/package.json",
    JSON.stringify({ name: "demo", version: "0.0.1" }, null, 2) + "\n",
    0o644,
  );

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
