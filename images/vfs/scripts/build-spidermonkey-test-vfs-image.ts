/**
 * Build a browser VFS image for Mozilla's official SpiderMonkey shell tests.
 *
 * The image contains:
 *   - /usr/bin/js
 *   - js/src/tests and js/src/jit-test mounted at their host absolute paths
 *
 * Keeping the upstream test directories at their host paths lets the Python
 * jstests.py and jit_test.py harnesses invoke the browser shell bridge with
 * unchanged argv values.
 */
import { existsSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  symlink,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { findRepoRoot, tryResolveBinary } from "../../../host/src/binary-resolver";
import { saveImage, walkAndWrite } from "./vfs-image-helpers";

const REPO_ROOT = findRepoRoot();
const PACKAGE_DIR = join(REPO_ROOT, "packages/registry/spidermonkey");
const LOCAL_JS = join(PACKAGE_DIR, "bin/js.wasm");
const JS_WASM = process.env.SPIDERMONKEY_WASM
  ?? tryResolveBinary("programs/js.wasm")
  ?? tryResolveBinary("programs/spidermonkey.wasm")
  ?? LOCAL_JS;
const OUT_FILE = process.env.SPIDERMONKEY_TEST_VFS_OUT
  ?? join(REPO_ROOT, "apps/browser-demos/public/spidermonkey-test.vfs.zst");

function isSpiderMonkeySource(dir: string): boolean {
  return existsSync(join(dir, "mach")) &&
    existsSync(join(dir, "js/src/tests")) &&
    existsSync(join(dir, "js/src/jit-test"));
}

function findSpiderMonkeySource(root: string, maxDepth = 4): string | null {
  if (!existsSync(root)) return null;
  if (isSpiderMonkeySource(root)) return root;
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (stack.length > 0) {
    const { path, depth } = stack.pop()!;
    if (depth >= maxDepth) continue;
    for (const name of readdirSync(path)) {
      const full = join(path, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (isSpiderMonkeySource(full)) return full;
      stack.push({ path: full, depth: depth + 1 });
    }
  }
  return null;
}

function resolveSpiderMonkeySource(): string {
  const explicit = process.env.SPIDERMONKEY_SOURCE_DIR;
  if (explicit) {
    if (!isSpiderMonkeySource(explicit)) {
      throw new Error(`SPIDERMONKEY_SOURCE_DIR is not a SpiderMonkey source root: ${explicit}`);
    }
    return explicit;
  }

  const found = findSpiderMonkeySource(join(PACKAGE_DIR, "source"));
  if (found) return found;

  throw new Error(
    "SpiderMonkey official test source tree is missing. " +
    "Run: scripts/ensure-spidermonkey-source.sh",
  );
}

function normalizeRelPath(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

async function main() {
  if (!existsSync(JS_WASM)) {
    throw new Error(
      `SpiderMonkey js.wasm not found at ${JS_WASM}. ` +
      "Run: bash packages/registry/spidermonkey/build-spidermonkey.sh",
    );
  }

  const spiderMonkeySource = resolveSpiderMonkeySource();

  console.log("==> Building SpiderMonkey official-test VFS image");
  console.log(`  js.wasm: ${JS_WASM}`);
  console.log(`  source:  ${spiderMonkeySource}`);

  const imageMaxBytes = 1536 * 1024 * 1024;
  const sab = new SharedArrayBuffer(1024 * 1024 * 1024, {
    maxByteLength: imageMaxBytes,
  });
  const fs = MemoryFileSystem.create(sab, imageMaxBytes);

  for (const dir of [
    "/tmp",
    "/home",
    "/root",
    "/dev",
    "/etc",
    "/bin",
    "/usr",
    "/usr/bin",
  ]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);

  writeVfsBinary(fs, "/usr/bin/js", new Uint8Array(readFileSync(JS_WASM)));
  symlink(fs, "/usr/bin/js", "/bin/js");

  const officialDirs = [
    join(spiderMonkeySource, "js/src/tests"),
    join(spiderMonkeySource, "js/src/jit-test"),
  ];
  for (const sourceDir of officialDirs) {
    ensureDirRecursive(fs, sourceDir);
    console.log(`  Writing ${sourceDir}...`);
    const count = walkAndWrite(fs, sourceDir, sourceDir, {
      exclude: (rel) => {
        const normalized = normalizeRelPath(sourceDir, join(sourceDir, rel));
        return normalized === "__pycache__" ||
          normalized.startsWith("__pycache__/") ||
          normalized.includes("/__pycache__/") ||
          normalized.endsWith(".pyc");
      },
    });
    console.log(`    ${count} files`);
  }

  await saveImage(fs, OUT_FILE, {
    allowedWasmArtifactPolicyFailures: {
      "/usr/bin/js": [
        "imports kernel.kernel_fork without complete wasm-fork-instrument exports",
      ],
    },
  });
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
