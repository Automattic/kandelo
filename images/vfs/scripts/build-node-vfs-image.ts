/**
 * Build a pre-built VFS image containing the Shell VFS base, npm 10.9.2,
 * and a writable workspace for the browser Node demos.
 *
 * Layout produced:
 *   Shell VFS base         — dash + shell utility symlinks/config/lazy archives
 *   /usr/local/lib/npm/...   — full npm dist (bin/npm-cli.js + lib + node_modules)
 *   /usr/bin/npm          — wrapper that runs npm through the node binary
 *   /work/package.json       — empty starter package, used as --prefix and HOME
 *   /tmp/                    — writable, mode 0o777
 *
 * Excludes npm's man/ and docs/ (man pages + markdown docs add ~3 MB and
 * are never read during `npm install`).
 *
 * Output: apps/browser-demos/public/node-vfs.vfs.zst
 *
 * Usage: npx tsx images/vfs/scripts/build-node-vfs-image.ts
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { resolveBinary } from "../../../host/src/binary-resolver";
import {
  ensureDirRecursive,
  walkAndWrite,
  writeVfsFile,
  saveImage,
  symlink,
} from "./vfs-image-helpers";
import { populateShellEnvironment } from "./shell-vfs-build";
import {
  NODE_LAZY_BINARY_SPEC,
  shellLazyPlaceholderUrl,
} from "../lib/init/shell-binaries";
import {
  terminalPresentation,
  writeKandeloDemoConfig,
} from "./kandelo-demo-config";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const NPM_DIST = join(REPO_ROOT, "packages", "registry", "npm", "dist");
const OUT_FILE = join(REPO_ROOT, "apps", "browser-demos", "public", "node-vfs.vfs.zst");

const NPM_MOUNT = "/usr/local/lib/npm";

async function main() {
  if (!existsSync(join(NPM_DIST, "bin", "npm-cli.js"))) {
    console.error(`npm dist not found at ${NPM_DIST}/bin/npm-cli.js`);
    console.error("Run: bash packages/registry/npm/build-npm.sh (or whatever populates packages/registry/npm/dist)");
    process.exit(1);
  }

  // 32 MiB SAB. npm dist is ~17 MiB on disk; rest is shell base metadata,
  // magic data, npm wrappers, and scratch headroom.
  // The .vfs file size equals the SAB size verbatim (saveImage writes the full buffer).
  const sab = new SharedArrayBuffer(32 * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  console.log("Populating shell base...");
  populateShellEnvironment(fs, { eagerBinaries: false });
  populateNodeLazyBinary(fs);

  // Node/npm workspace additions.
  ensureDirRecursive(fs, "/usr/local/lib");
  ensureDirRecursive(fs, "/work");
  // /etc/ssl needs to exist before kernel-worker auto-writes the bundled
  // CA cert to /etc/ssl/cert.pem on init. Without this, npm install over
  // HTTPS fails — see kernel-worker-entry.ts handleInit.
  ensureDirRecursive(fs, "/etc/ssl");
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
  writeVfsFile(
    fs,
    "/usr/bin/npm",
    "#!/bin/sh\nexec node /usr/local/lib/npm/bin/npm-cli.js \"$@\"\n",
    0o755,
  );
  writeVfsFile(
    fs,
    "/usr/bin/npx",
    "#!/bin/sh\nexec node /usr/local/lib/npm/bin/npx-cli.js \"$@\"\n",
    0o755,
  );
  symlink(fs, "/usr/bin/npm", "/bin/npm");
  symlink(fs, "/usr/bin/npm", "/usr/local/bin/npm");
  symlink(fs, "/usr/bin/npx", "/bin/npx");
  symlink(fs, "/usr/bin/npx", "/usr/local/bin/npx");
  writeKandeloDemoConfig(fs, {
    version: 1,
    profiles: {
      node: { presentation: terminalPresentation() },
    },
  });

  await saveImage(fs, OUT_FILE);
}

function populateNodeLazyBinary(fs: MemoryFileSystem): void {
  const resolved = resolveBinary(NODE_LAZY_BINARY_SPEC.resolverPath);
  const size = statSync(resolved).size;
  fs.registerLazyFile(
    NODE_LAZY_BINARY_SPEC.vfsPath,
    shellLazyPlaceholderUrl(NODE_LAZY_BINARY_SPEC),
    size,
    0o755,
  );
  for (const link of NODE_LAZY_BINARY_SPEC.symlinks) {
    symlink(fs, NODE_LAZY_BINARY_SPEC.vfsPath, link);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
