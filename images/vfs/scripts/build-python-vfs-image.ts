/**
 * Build the deterministic CPython 3.13 VFS layer from resolver-owned package
 * outputs. The image contains the exact validated interpreter, its standard
 * library, license, executable aliases, and image-owned demo metadata.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import type { MemoryFileSystem as MemoryFileSystemType } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  exactVfsImageMetadata,
  saveImage,
  symlink,
  type ExactVfsImageAbi,
  writeVfsBinary,
} from "./vfs-image-helpers";
import {
  terminalPresentation,
  writeKandeloDemoConfig,
} from "./kandelo-demo-config";

const SCRIPT_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(SCRIPT_DIR, "..", "..", "..");
const LEGACY_RUNTIME_ROOT = join(
  REPO_ROOT,
  "packages",
  "registry",
  "cpython",
  "python-runtime-stage",
);
const LEGACY_PYTHON_WASM = join(
  REPO_ROOT,
  "packages",
  "registry",
  "cpython",
  "bin",
  "python.wasm",
);
const PYTHON_STDLIB = "python3.13";
// Keep enough allocator headroom for downstream images to layer additional
// Homebrew executables onto the complete interpreter and standard library.
const VFS_BYTES = 256 * 1024 * 1024;
const REPRODUCIBLE_TIMESTAMP_MS = 1_700_000_000_000;

function copyTreeSorted(
  fs: MemoryFileSystemType,
  hostRoot: string,
  guestRoot: string,
): number {
  let files = 0;
  ensureDirRecursive(fs, guestRoot);

  const walk = (hostDirectory: string): void => {
    for (const name of readdirSync(hostDirectory).sort()) {
      const hostPath = join(hostDirectory, name);
      const relativePath = relative(hostRoot, hostPath);
      const guestPath = `${guestRoot}/${relativePath}`.replace(/\/+/g, "/");
      const stat = lstatSync(hostPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`CPython runtime output contains an unsupported symlink: ${hostPath}`);
      }
      if (stat.isDirectory()) {
        ensureDirRecursive(fs, guestPath);
        walk(hostPath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`CPython runtime output contains an unsupported entry: ${hostPath}`);
      }
      writeVfsBinary(fs, guestPath, new Uint8Array(readFileSync(hostPath)), 0o644);
      files++;
    }
  };

  walk(hostRoot);
  return files;
}

export interface PythonVfsImageBuildInputs {
  python: Uint8Array;
  runtimeRoot: string;
  outputPath: string;
  targetAbi?: ExactVfsImageAbi;
}

export async function buildPythonVfsImage(
  inputs: PythonVfsImageBuildInputs,
): Promise<void> {
  const stdlibRoot = join(inputs.runtimeRoot, "lib", PYTHON_STDLIB);
  const license = join(
    inputs.runtimeRoot,
    "share",
    "licenses",
    "cpython",
    "LICENSE",
  );
  for (const required of [join(stdlibRoot, "os.py"), license]) {
    if (!existsSync(required)) throw new Error(`required CPython VFS input missing: ${required}`);
  }

  const fs = MemoryFileSystem.create(new SharedArrayBuffer(VFS_BYTES));
  ensureDir(fs, "/tmp");
  fs.chmod("/tmp", 0o1777);
  ensureDirRecursive(fs, "/home");
  ensureDirRecursive(fs, "/usr/bin");
  ensureDirRecursive(fs, `/usr/lib/${PYTHON_STDLIB}`);
  ensureDirRecursive(fs, "/usr/share/licenses/cpython");

  writeVfsBinary(fs, "/usr/bin/python3", inputs.python, 0o755);
  symlink(fs, "/usr/bin/python3", "/usr/bin/python");
  symlink(fs, "/usr/bin/python3", "/usr/bin/cpython");
  const runtimeFiles = copyTreeSorted(fs, stdlibRoot, `/usr/lib/${PYTHON_STDLIB}`);
  writeVfsBinary(fs, "/usr/share/licenses/cpython/LICENSE", new Uint8Array(readFileSync(license)), 0o644);

  writeKandeloDemoConfig(fs, {
    version: 1,
    profiles: {
      python: {
        presentation: {
          ...terminalPresentation(),
          autoCommand: "PYTHONHOME=/usr PYTHONDONTWRITEBYTECODE=1 python3 -c \"import json, sys; print('Python', sys.version.split()[0]); print(json.dumps({'kandelo': 'software'}))\"",
        },
      },
    },
  });

  await saveImage(fs, inputs.outputPath, {
    normalizeTimestampsMs: REPRODUCIBLE_TIMESTAMP_MS,
    ...(inputs.targetAbi === undefined
      ? {}
      : {
          kernelAbi: inputs.targetAbi.version,
          metadata: exactVfsImageMetadata(
            inputs.targetAbi,
            "images/vfs/scripts/build-python-vfs-image.ts",
          ),
        }),
  });
  console.log(`CPython VFS contents: interpreter + ${runtimeFiles} standard-library files`);
}

async function main(): Promise<void> {
  const runtimeRoot = process.env.KANDELO_PYTHON_RUNTIME_ROOT ??
    LEGACY_RUNTIME_ROOT;
  const pythonPath = process.env.KANDELO_PYTHON_WASM ?? LEGACY_PYTHON_WASM;
  const outputPath = process.env.KANDELO_PYTHON_VFS_OUT ??
    join(REPO_ROOT, "apps", "browser-demos", "public", "python.vfs.zst");
  if (!existsSync(pythonPath)) {
    throw new Error(`required CPython VFS input missing: ${pythonPath}`);
  }
  await buildPythonVfsImage({
    python: new Uint8Array(readFileSync(pythonPath)),
    runtimeRoot,
    outputPath,
  });
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
