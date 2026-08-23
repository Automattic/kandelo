/**
 * Build a pre-built VFS image containing the Shell VFS base, npm 10.9.2,
 * and a writable workspace for the browser Node demos.
 *
 * Layout produced:
 *   Shell VFS base         — fully materialized Homebrew shell and metadata
 *   /usr/bin/node          — exact resolved Node executable bytes
 *   /usr/local/lib/npm/...   — full npm dist (bin/npm-cli.js + lib + node_modules)
 *   /usr/bin/npm          — wrapper that runs npm through the node binary
 *   /etc/profile.d/...       — guest initializer for the mounted maker home
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
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  walkAndWrite,
  writeVfsBinary,
  type VfsWasmArtifactPolicy,
} from "./vfs-image-helpers";
import { symlinkWithParentDirectories } from "./derived-vfs-symlink";
import {
  loadShellBaseFileSystemFromImage,
  resolveVfsArtifact,
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
import { ensureSourceExtract } from "./source-extract-helper";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const OUT_FILE = join(REPO_ROOT, "apps", "browser-demos", "public", "node-vfs.vfs.zst");

const NPM_MOUNT = "/usr/local/lib/npm";
// The Node image contains the complete canonical shell plus npm. It cannot
// truthfully advertise a smaller ceiling than its 512 MiB shell base.
const NODE_IMAGE_MAX_BYTES = SHELL_DERIVED_VFS_PROFILE_MAX_BYTES;
const NODE_WASM_ARTIFACT_POLICY = {
  path: NODE_BINARY_SPEC.vfsPath,
  forkInstrumentation: "auto",
} as const satisfies VfsWasmArtifactPolicy;

export interface NodeVfsImageBuildInputs {
  shellImage: Uint8Array;
  node: Uint8Array;
  npmDirectory: string;
  outputPath: string;
}

type SourceExtract = typeof ensureSourceExtract;

export function resolveNodeNpmSource(
  primarySource: string | undefined,
  repoRoot: string,
  resolveSource: SourceExtract = ensureSourceExtract,
): string {
  return primarySource ?? resolveSource("node-vfs", repoRoot);
}

export async function buildNodeVfsImage(
  inputs: NodeVfsImageBuildInputs,
): Promise<void> {
  if (!existsSync(join(inputs.npmDirectory, "bin", "npm-cli.js"))) {
    throw new Error(
      `npm dist not found at ${inputs.npmDirectory}/bin/npm-cli.js`,
    );
  }

  console.log("Loading shell base image...");
  const fs = await loadShellBaseFileSystemFromImage(
    inputs.shellImage,
    NODE_IMAGE_MAX_BYTES,
  );
  populateNodeBinary(fs, inputs.node);

  // Node/npm workspace additions.
  ensureDirRecursive(fs, "/usr/local/lib");
  // /etc/ssl needs to exist before the browser kernel worker auto-writes
  // the MITM CA cert to /etc/ssl/certs/ca-certificates.crt on init.
  ensureDirRecursive(fs, "/etc/ssl");

  // npm dist — skip man/ and docs/ (not used at install time)
  console.log(`Mounting npm dist at ${NPM_MOUNT}...`);
  const written = walkAndWrite(fs, inputs.npmDirectory, NPM_MOUNT, {
    exclude: (rel) => rel === "man" || rel.startsWith("man/")
                   || rel === "docs" || rel.startsWith("docs/"),
  });
  console.log(`  ${written} files written`);
  stageSpiderMonkeyNpmRuntime(fs);
  writeKandeloDemoConfig(fs, {
    version: 1,
    profiles: {
      node: {
        presentation: terminalPresentation(),
        guide: nodeGuide(),
      },
    },
  });

  await saveShellDerivedVfsImage(fs, inputs.outputPath, {
    wasmArtifactPolicies: [NODE_WASM_ARTIFACT_POLICY],
  });
}

function populateNodeBinary(fs: MemoryFileSystem, node: Uint8Array): void {
  // WHY: the dedicated Node demo always executes Node. Embedding its package-
  // resolved bytes avoids a second browser transport whose authority was not
  // part of the admitted flat shell lineage.
  writeVfsBinary(
    fs,
    NODE_BINARY_SPEC.vfsPath,
    node,
    0o755,
  );
  for (const link of NODE_BINARY_SPEC.symlinks) {
    // WHY: the minimal bottle-composed shell deliberately omits optional
    // directory skeletons such as /usr/local/bin. This derived image owns the
    // Node aliases, so it must also own their parent directories.
    symlinkWithParentDirectories(fs, NODE_BINARY_SPEC.vfsPath, link);
  }
}

async function main(): Promise<void> {
  const npmDirectory = resolveNodeNpmSource(
    process.env.WASM_POSIX_DEP_SOURCE_DIR,
    REPO_ROOT,
  );
  if (!existsSync(join(npmDirectory, "bin", "npm-cli.js"))) {
    throw new Error(`npm dist not found at ${npmDirectory}/bin/npm-cli.js`);
  }
  const nodeRoot = process.env.WASM_POSIX_DEP_NODE_DIR;
  const resolved = nodeRoot
    ? join(nodeRoot, "node.wasm")
    : resolvePolicyBoundVfsWasmArtifact(
      NODE_BINARY_SPEC.resolverPath,
      NODE_BINARY_SPEC.id,
      NODE_WASM_ARTIFACT_POLICY.forkInstrumentation,
    );
  const shellRoot = process.env.WASM_POSIX_DEP_SHELL_DIR;
  const shellImagePath = shellRoot
    ? join(shellRoot, "shell.vfs.zst")
    : resolveVfsArtifact("programs/shell.vfs.zst", "shell");
  await buildNodeVfsImage({
    shellImage: new Uint8Array(readFileSync(shellImagePath)),
    node: new Uint8Array(readFileSync(resolved)),
    npmDirectory,
    outputPath: process.argv[2] ?? OUT_FILE,
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
