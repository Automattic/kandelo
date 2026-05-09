/**
 * Build a pre-built VFS image containing the CPython 3.13 stdlib.
 *
 * Produces: examples/browser/public/python.vfs
 *
 * Usage: npx tsx examples/browser/scripts/build-python-vfs-image.ts
 */
import { join } from "path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  walkAndWrite,
  saveImage,
} from "./vfs-image-helpers";
import { ensureSourceExtract } from "./source-extract-helper";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
// Prefer the local CPython source-build tree if present (faster, matches
// `bash examples/libs/cpython/build-cpython.sh` output). Otherwise download
// + extract the upstream tarball into the resolver's source cache.
const LEGACY_SRC = join(REPO_ROOT, "examples", "libs", "cpython", "cpython-src");
const STDLIB_DIR = join(ensureSourceExtract("cpython", REPO_ROOT, LEGACY_SRC), "Lib");
const OUT_FILE = join(REPO_ROOT, "examples", "browser", "public", "python.vfs.zst");

// Directories to exclude from the stdlib (test suites, GUI, unnecessary modules)
const EXCLUDED_DIRS = new Set([
  "test",
  "tests",
  "__pycache__",
  "idlelib",
  "tkinter",
  "turtledemo",
  "ensurepip",
  "lib2to3",
  "pydoc_data",
  "unittest",
  "doctest",
  "xmlrpc",
  "multiprocessing",
  "concurrent",
  "asyncio",
  "ctypes",
  "distutils",
  "venv",
  "curses",
]);

function shouldExclude(relPath: string): boolean {
  // Check if any path segment matches an excluded directory
  const segments = relPath.split("/");
  for (const seg of segments) {
    if (EXCLUDED_DIRS.has(seg)) return true;
  }
  // Exclude compiled bytecode files
  if (relPath.endsWith(".pyc") || relPath.endsWith(".pyo")) return true;
  return false;
}

async function main() {
  // Create a MemoryFileSystem sized for the Python stdlib (~32MB).
  const sab = new SharedArrayBuffer(32 * 1024 * 1024);
  const fs = MemoryFileSystem.create(sab);

  console.log("Creating directories...");
  ensureDir(fs, "/tmp");
  fs.chmod("/tmp", 0o777);
  ensureDir(fs, "/home");
  ensureDirRecursive(fs, "/usr/lib/python3.13");

  console.log("Writing Python stdlib files...");
  const fileCount = walkAndWrite(fs, STDLIB_DIR, "/usr/lib/python3.13", {
    exclude: shouldExclude,
  });
  console.log(`  Python stdlib: ${fileCount} files`);

  // Save image
  await saveImage(fs, OUT_FILE);
  console.log(`${fileCount} stdlib files total`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
