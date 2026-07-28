/**
 * Build a pre-built VFS image containing the Shell VFS base, npm 10.9.2,
 * and a writable workspace for the browser Node demos.
 *
 * Layout produced:
 *   Shell VFS base         — dash + shell utility symlinks/config/lazy archives
 *   /usr/bin/node          — exact resolved Node executable bytes
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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  walkAndWrite,
  writeVfsBinary,
  type VfsWasmArtifactPolicy,
} from "./vfs-image-helpers";
import { symlinkWithParentDirectories } from "./derived-vfs-symlink";
import {
  loadShellBaseFileSystem,
  resolvePolicyBoundVfsWasmArtifact,
  saveShellDerivedVfsImage,
} from "./shell-vfs-build";
import {
  NODE_BINARY_SPEC,
} from "../lib/init/shell-binaries";
import {
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
} from "../../../web-libs/kandelo-session/src/vfs-capacity";
import { stageSpiderMonkeyNpmRuntime } from "../lib/init/spidermonkey-npm-runtime";
import {
  terminalPresentation,
  writeKandeloDemoConfig,
} from "./kandelo-demo-config";
import { nodeGuide } from "./kandelo-demo-guides";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const NPM_DIST = join(REPO_ROOT, "packages", "registry", "npm", "dist");
const OUT_FILE = join(REPO_ROOT, "apps", "browser-demos", "public", "node-vfs.vfs.zst");

const NPM_MOUNT = "/usr/local/lib/npm";
// The Node image contains the complete canonical shell plus npm. It cannot
// truthfully advertise a smaller ceiling than its 512 MiB shell base.
const NODE_IMAGE_MAX_BYTES = SHELL_DERIVED_VFS_PROFILE_MAX_BYTES;
const DEMO_UID = 1000;
const DEMO_GID = 1000;
const NODE_WASM_ARTIFACT_POLICY = {
  path: NODE_BINARY_SPEC.vfsPath,
  forkInstrumentation: "disabled",
} as const satisfies VfsWasmArtifactPolicy;

async function main() {
  if (!existsSync(join(NPM_DIST, "bin", "npm-cli.js"))) {
    console.error(`npm dist not found at ${NPM_DIST}/bin/npm-cli.js`);
    console.error("Run: bash packages/registry/npm/build-npm.sh (or whatever populates packages/registry/npm/dist)");
    process.exit(1);
  }

  console.log("Loading shell base image...");
  const fs = await loadShellBaseFileSystem(NODE_IMAGE_MAX_BYTES);
  populateNodeBinary(fs);

  // Node/npm workspace additions.
  ensureDirRecursive(fs, "/usr/local/lib");
  ensureDirRecursive(fs, "/work");
  // /etc/ssl needs to exist before the browser kernel worker auto-writes
  // the MITM CA cert to /etc/ssl/certs/ca-certificates.crt on init.
  ensureDirRecursive(fs, "/etc/ssl");
  fs.chmod("/work", 0o777);

  // npm dist — skip man/ and docs/ (not used at install time)
  console.log(`Mounting npm dist at ${NPM_MOUNT}...`);
  const written = walkAndWrite(fs, NPM_DIST, NPM_MOUNT, {
    exclude: (rel) => rel === "man" || rel.startsWith("man/")
                   || rel === "docs" || rel.startsWith("docs/"),
  });
  console.log(`  ${written} files written`);
  stageSpiderMonkeyNpmRuntime(fs);

  // Starter package.json so `npm install --prefix /work` has somewhere to write.
  fs.createFileWithOwner(
    "/work/package.json",
    0o644,
    DEMO_UID,
    DEMO_GID,
    new TextEncoder().encode(
      JSON.stringify({ name: "demo", version: "0.0.1" }, null, 2) + "\n",
    ),
  );
  writeKandeloDemoConfig(fs, {
    version: 1,
    profiles: {
      node: {
        presentation: terminalPresentation(),
        guide: nodeGuide(),
      },
    },
  });

  await saveShellDerivedVfsImage(fs, OUT_FILE, {
    wasmArtifactPolicies: [NODE_WASM_ARTIFACT_POLICY],
  });
}

function populateNodeBinary(fs: MemoryFileSystem): void {
  const resolved = resolvePolicyBoundVfsWasmArtifact(
    NODE_BINARY_SPEC.resolverPath,
    NODE_BINARY_SPEC.id,
    NODE_WASM_ARTIFACT_POLICY.forkInstrumentation,
  );
  // WHY: the dedicated Node demo always executes Node. Embedding its package-
  // resolved bytes avoids a second browser transport whose authority was not
  // part of the image's closed lazy-bottle plan.
  writeVfsBinary(
    fs,
    NODE_BINARY_SPEC.vfsPath,
    new Uint8Array(readFileSync(resolved)),
    0o755,
  );
  for (const link of NODE_BINARY_SPEC.symlinks) {
    // WHY: the minimal bottle-composed shell deliberately omits optional
    // directory skeletons such as /usr/local/bin. This derived image owns the
    // Node aliases, so it must also own their parent directories.
    symlinkWithParentDirectories(fs, NODE_BINARY_SPEC.vfsPath, link);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
