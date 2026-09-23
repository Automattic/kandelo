/**
 * Build a fully-bootable VFS image for the nginx + Python (wsgiref) Notes
 * API demo. The image starts from shell.vfs.zst, then dinit, the first user
 * process, brings up the Python WSGI app on 127.0.0.1:8000 and nginx on
 * :8080 (depends-on chain ensures the app is up first). nginx serves the
 * static app root and reverse-proxies /api/ to the Python app.
 *
 * Produces: apps/browser-demos/public/nginx-python-vfs.vfs.zst
 *
 * Usage: npx tsx images/vfs/scripts/build-nginx-python-vfs-image.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
  symlink,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import { addDinitInit, type DinitBinaryInputs } from "./dinit-image-helpers";
import {
  loadShellBaseFileSystem,
  loadShellBaseFileSystemFromImage,
  saveShellDerivedVfsImage,
} from "./package-shell-vfs-build";
import { SHELL_DERIVED_VFS_PROFILE_MAX_BYTES } from "../../../web-libs/kandelo-session/src/vfs-capacity";
import { webPresentation, writeKandeloDemoConfig } from "./kandelo-demo-config";
import { nginxPythonGuide } from "./kandelo-demo-guides";
import { prewarmPythonBytecode } from "./python-bytecode-prewarm";

const PYTHON_STDLIB = "python3.13";
const APP_DIR = join(
  findRepoRoot(),
  "packages",
  "registry",
  "nginx-python-vfs",
  "app",
);
const OUT_FILE = join(
  findRepoRoot(),
  "apps",
  "browser-demos",
  "public",
  "nginx-python-vfs.vfs.zst",
);
const DEMO_UID = 1000;
const DEMO_GID = 1000;

// Directories and file suffixes that are legitimate to have on disk next to
// the app sources (e.g. from running `python3 -m unittest` locally) but must
// never be baked into the image: they are untracked, non-reproducible build
// byproducts, not part of the app.
const APP_TREE_SKIP_DIRS = new Set(["__pycache__"]);
const APP_TREE_SKIP_FILE_SUFFIXES = [".pyc", ".pyo"];

// nginx serves the static app root and reverse-proxies /api/ to the Python
// WSGI server on 127.0.0.1:8000.
const NGINX_CONF = `user root;
daemon off;
master_process on;
worker_processes 2;
error_log stderr info;
pid /tmp/nginx.pid;

events {
    worker_connections 64;
    use poll;
}

http {
    access_log /dev/stderr;
    client_body_temp_path /tmp/nginx_client_temp;
    proxy_temp_path /tmp/nginx_proxy_temp;

    types {
        text/html   html htm;
        text/css    css;
        text/javascript js;
        application/json json;
        image/svg+xml svg;
    }
    default_type application/octet-stream;

    server {
        listen 8080;
        server_name localhost;
        root /var/www/notes/static;
        index index.html;

        location / {
        }

        location /api/ {
            proxy_pass http://127.0.0.1:8000;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $remote_addr;
        }
    }
}
`;

// Recursively copy a host directory tree into the VFS, sorted for
// reproducibility, rejecting symlinks. Skips non-reproducible local build
// byproducts (see APP_TREE_SKIP_DIRS/APP_TREE_SKIP_FILE_SUFFIXES) so a
// developer's local `__pycache__` from running the app's tests doesn't leak
// into the shipped image. Returns the file count.
function copyTreeSorted(
  fs: MemoryFileSystem,
  hostDir: string,
  vfsDir: string,
): number {
  ensureDirRecursive(fs, vfsDir);
  let count = 0;
  const entries = readdirSync(hostDir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`unexpected symlink in tree: ${join(hostDir, entry.name)}`);
    }
    if (entry.isDirectory() && APP_TREE_SKIP_DIRS.has(entry.name)) continue;
    if (
      !entry.isDirectory() &&
      APP_TREE_SKIP_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
    ) {
      continue;
    }
    const hostPath = join(hostDir, entry.name);
    const vfsPath = `${vfsDir}/${entry.name}`;
    if (entry.isDirectory()) {
      count += copyTreeSorted(fs, hostPath, vfsPath);
    } else {
      writeVfsBinary(fs, vfsPath, new Uint8Array(readFileSync(hostPath)), 0o644);
      count += 1;
    }
  }
  return count;
}

export interface NginxPythonVfsImageBuildInputs {
  shellImage?: Uint8Array;
  nginx: Uint8Array;
  python: Uint8Array;
  // Host directory holding the extracted CPython runtime closure: expects
  // <runtimeRoot>/lib/python3.13 and <runtimeRoot>/share/licenses/cpython/LICENSE.
  runtimeRoot: string;
  dinit?: DinitBinaryInputs;
  // Exact staged build inputs for the build-time CPython bytecode prewarm
  // (see python-bytecode-prewarm.ts). When omitted, the prewarm is skipped
  // and the image ships source-only stdlib — which the browser cannot import
  // without overflowing the kernel worker's stack. Provided by the resolver
  // build path (kernel-wasm toolchain + staged python.wasm).
  buildPrograms?: {
    python: Uint8Array;
    kernel: Uint8Array;
  };
  outputPath: string;
}

export async function buildNginxPythonVfsImage(
  inputs: NginxPythonVfsImageBuildInputs,
): Promise<void> {
  console.log("Loading shell base image...");
  const fs = inputs.shellImage
    ? await loadShellBaseFileSystemFromImage(
        inputs.shellImage,
        SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
      )
    : await loadShellBaseFileSystem(SHELL_DERIVED_VFS_PROFILE_MAX_BYTES);

  fs.chmod("/tmp", 0o777);
  ensureDirRecursive(fs, "/usr/sbin");
  ensureDirRecursive(fs, "/usr/bin");
  ensureDirRecursive(fs, `/usr/lib/${PYTHON_STDLIB}`);
  ensureDirRecursive(fs, "/usr/share/licenses/cpython");
  ensureDirRecursive(fs, "/etc/nginx");
  ensureDirRecursive(fs, "/var/www/notes");
  ensureDirRecursive(fs, "/var/lib/notes");
  ensureDirRecursive(fs, "/var/log");
  ensureDirRecursive(fs, "/tmp/nginx_client_temp");
  ensureDirRecursive(fs, "/tmp/nginx_proxy_temp");

  // nginx binary.
  writeVfsBinary(fs, "/usr/sbin/nginx", inputs.nginx, 0o755);

  // CPython interpreter + aliases + standard library + license.
  writeVfsBinary(fs, "/usr/bin/python3", inputs.python, 0o755);
  symlink(fs, "/usr/bin/python3", "/usr/bin/python");
  symlink(fs, "/usr/bin/python3", "/usr/bin/cpython");
  const stdlibRoot = join(inputs.runtimeRoot, "lib", PYTHON_STDLIB);
  const stdlibCount = copyTreeSorted(fs, stdlibRoot, `/usr/lib/${PYTHON_STDLIB}`);
  const license = join(
    inputs.runtimeRoot, "share", "licenses", "cpython", "LICENSE",
  );
  writeVfsBinary(
    fs, "/usr/share/licenses/cpython/LICENSE",
    new Uint8Array(readFileSync(license)), 0o644,
  );

  // The Python app (app.py, schema.sql, seed.sql, static/index.html).
  const appCount = copyTreeSorted(fs, APP_DIR, "/var/www/notes");

  // nginx config.
  writeVfsFile(fs, "/etc/nginx/nginx.conf", NGINX_CONF);

  // Make the app tree and its writable data dir owned by the demo user.
  fs.chown("/var/www/notes", DEMO_UID, DEMO_GID);
  fs.chown("/var/lib/notes", DEMO_UID, DEMO_GID);
  fs.chmod("/var/lib/notes", 0o755);

  // dinit: nginx depends on notes-app so the WSGI port is up first.
  addDinitInit(fs, [
    {
      name: "notes-app",
      type: "process",
      command: "/usr/bin/python3 /var/www/notes/app.py",
      logfile: "/var/log/notes-app.log",
      restart: false,
    },
    {
      name: "nginx",
      type: "process",
      command: "/usr/sbin/nginx -c /etc/nginx/nginx.conf",
      dependsOn: ["notes-app"],
      logfile: "/var/log/nginx.log",
      restart: false,
    },
  ], { binaries: inputs.dinit });

  writeKandeloDemoConfig(fs, {
    version: 1,
    profiles: {
      "nginx-python": {
        presentation: webPresentation(),
        guide: nginxPythonGuide(),
      },
    },
  });

  // Prewarm CPython bytecode: precompile the stdlib and the app to .pyc so
  // the browser loads bytecode via marshal instead of compiling from source
  // on first import — the compile pass overflows the browser kernel worker's
  // fixed stack. See python-bytecode-prewarm.ts for the full rationale.
  let prewarmedPyc = 0;
  if (inputs.buildPrograms) {
    prewarmedPyc = await prewarmPythonBytecode(fs, {
      sourceRoots: [`/usr/lib/${PYTHON_STDLIB}`, "/var/www/notes"],
      label: "nginx-python",
      programs: inputs.buildPrograms,
    });
  } else {
    console.warn(
      "[python-prewarm] skipped: no kernel/python build programs supplied " +
        "(the browser demo will compile stdlib from source and may overflow " +
        "the kernel worker stack)",
    );
  }

  await saveShellDerivedVfsImage(fs, inputs.outputPath);
  console.log(
    `nginx-python VFS: interpreter + ${stdlibCount} stdlib files + ${appCount} app files ` +
      `+ ${prewarmedPyc} prewarmed .pyc`,
  );
}

async function main(): Promise<void> {
  const shellRoot = process.env.WASM_POSIX_DEP_SHELL_DIR;
  const nginxRoot = process.env.WASM_POSIX_DEP_NGINX_DIR;
  const dinitRoot = process.env.WASM_POSIX_DEP_DINIT_DIR;
  const runtimeRoot = process.env.KANDELO_PYTHON_RUNTIME_ROOT;
  const pythonWasm = process.env.KANDELO_PYTHON_WASM;
  const kernelRoot = process.env.WASM_POSIX_DEP_KERNEL_DIR;
  if (!runtimeRoot || !pythonWasm) {
    throw new Error(
      "KANDELO_PYTHON_RUNTIME_ROOT and KANDELO_PYTHON_WASM are required",
    );
  }
  const pythonBytes = new Uint8Array(readFileSync(pythonWasm));
  await buildNginxPythonVfsImage({
    shellImage: shellRoot
      ? new Uint8Array(readFileSync(join(shellRoot, "shell.vfs.zst")))
      : undefined,
    nginx: new Uint8Array(
      readFileSync(
        nginxRoot ? join(nginxRoot, "nginx.wasm") : resolveBinary("programs/nginx.wasm"),
      ),
    ),
    python: pythonBytes,
    runtimeRoot,
    dinit: dinitRoot
      ? {
          dinit: new Uint8Array(readFileSync(join(dinitRoot, "dinit.wasm"))),
          dinitctl: new Uint8Array(readFileSync(join(dinitRoot, "dinitctl.wasm"))),
        }
      : undefined,
    buildPrograms: kernelRoot
      ? {
          python: pythonBytes,
          kernel: new Uint8Array(
            readFileSync(join(kernelRoot, "kandelo-kernel.wasm")),
          ),
        }
      : undefined,
    outputPath: process.argv[2] ?? OUT_FILE,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
