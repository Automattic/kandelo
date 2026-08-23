/**
 * Build a fully-bootable VFS image for the nginx demo. The image starts from
 * shell.vfs.zst, then adds dinit as the first user process, nginx, the nginx
 * config + static content, and a single dinit service file. The browser demo
 * just fetches the image and boots — no JS-side orchestration.
 *
 * Produces: apps/browser-demos/public/nginx.vfs
 *
 * Usage: npx tsx images/vfs/scripts/build-nginx-vfs-image.ts
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import {
  addDinitInit,
  type DinitBinaryInputs,
} from "./dinit-image-helpers";
import {
  loadShellBaseFileSystem,
  loadShellBaseFileSystemFromImage,
  saveShellDerivedVfsImage,
} from "./shell-vfs-build";
import {
  SHELL_DERIVED_VFS_PROFILE_MAX_BYTES,
} from "../../../web-libs/kandelo-session/src/vfs-capacity";
import {
  webPresentation,
  writeKandeloDemoConfig,
} from "./kandelo-demo-config";
import { nginxGuide } from "./kandelo-demo-guides";

const REPO_ROOT = findRepoRoot();
const OUT_FILE = join(REPO_ROOT, "apps", "browser-demos", "public", "nginx.vfs.zst");
const NGINX_IMAGE_MAX_BYTES = SHELL_DERIVED_VFS_PROFILE_MAX_BYTES;
const DEMO_UID = 1000;
const DEMO_GID = 1000;

// Multi-process nginx config — master + 2 workers, mirroring the
// standalone CLI demo's nginx.conf. AF_INET listening sockets share a
// cross-process accept queue (see crates/kernel/src/socket.rs), so
// connections injected from the host are pulled by whichever worker
// happens to be ready, matching POSIX shared-listener semantics.
const NGINX_CONF = `\
user nobody;
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

    types {
        text/html                             html htm;
        text/css                              css;
        text/javascript                       js;
        application/json                      json;
        image/png                             png;
        image/jpeg                            jpg jpeg;
        image/gif                             gif;
        image/svg+xml                         svg;
        application/octet-stream              bin;
    }
    default_type application/octet-stream;

    server {
        listen 8080;
        server_name localhost;
        root /var/www/html;
        index index.html;
        location / {}
    }
}
`;

const INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>nginx on kandelo</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; }
    h1 { color: #333; }
    .info { background: #f0f0f0; padding: 1rem; border-radius: 4px; margin: 1rem 0; }
  </style>
</head>
<body>
  <h1>Hello from nginx on WebAssembly!</h1>
  <div class="info">
    <p>This page is served by <strong>nginx</strong> running inside a
    POSIX kernel compiled to WebAssembly. The kernel was booted with
    <code>/sbin/dinit</code> as the first user process, which read
    <code>/etc/dinit.d/nginx</code> and brought the service up.</p>
    <p>Request flow: browser fetch → service worker → main thread →
    TCP connection injected into the kernel → nginx (Wasm) → response
    flows back through the same pipe.</p>
  </div>
</body>
</html>
`;

export interface NginxVfsImageBuildInputs {
  shellImage?: Uint8Array;
  nginx: Uint8Array;
  dinit?: DinitBinaryInputs;
  outputPath: string;
}

export async function buildNginxVfsImage(
  inputs: NginxVfsImageBuildInputs,
): Promise<void> {
  console.log("Loading shell base image...");
  const fs = inputs.shellImage === undefined
    ? await loadShellBaseFileSystem(NGINX_IMAGE_MAX_BYTES)
    : await loadShellBaseFileSystemFromImage(
        inputs.shellImage,
        NGINX_IMAGE_MAX_BYTES,
      );
  fs.chmod("/tmp", 0o777);
  ensureDirRecursive(fs, "/usr/sbin");
  ensureDirRecursive(fs, "/run");
  ensureDirRecursive(fs, "/var");
  ensureDirRecursive(fs, "/var/www/html");
  ensureDirRecursive(fs, "/etc/nginx");

  // nginx binary + config + content
  writeVfsBinary(fs, "/usr/sbin/nginx", inputs.nginx);
  writeVfsFile(fs, "/etc/nginx/nginx.conf", NGINX_CONF);
  writeVfsFile(fs, "/var/www/html/index.html", INDEX_HTML);
  fs.chown("/var/www", DEMO_UID, DEMO_GID);
  fs.chown("/var/www/html", DEMO_UID, DEMO_GID);
  fs.chown("/var/www/html/index.html", DEMO_UID, DEMO_GID);
  fs.chmod("/var/www", 0o755);
  fs.chmod("/var/www/html", 0o755);
  fs.chmod("/var/www/html/index.html", 0o644);

  // dinit + service tree
  addDinitInit(fs, [
    {
      name: "nginx",
      type: "process",
      command: "/usr/sbin/nginx -p /etc/nginx -c nginx.conf",
      restart: true,
      restartDelay: 2,
    },
  ], { binaries: inputs.dinit });
  writeKandeloDemoConfig(fs, {
    version: 1,
    profiles: {
      nginx: {
        presentation: webPresentation(),
        guide: nginxGuide(),
      },
    },
  });

  await saveShellDerivedVfsImage(fs, inputs.outputPath);
}

async function main(): Promise<void> {
  const shellRoot = process.env.WASM_POSIX_DEP_SHELL_DIR;
  const nginxRoot = process.env.WASM_POSIX_DEP_NGINX_DIR;
  const dinitRoot = process.env.WASM_POSIX_DEP_DINIT_DIR;
  await buildNginxVfsImage({
    shellImage: shellRoot === undefined
      ? undefined
      : new Uint8Array(readFileSync(join(shellRoot, "shell.vfs.zst"))),
    nginx: new Uint8Array(readFileSync(nginxRoot === undefined
      ? resolveBinary("programs/nginx.wasm")
      : join(nginxRoot, "nginx.wasm"))),
    dinit: dinitRoot === undefined
      ? undefined
      : {
          dinit: new Uint8Array(readFileSync(join(dinitRoot, "dinit.wasm"))),
          dinitctl: new Uint8Array(
            readFileSync(join(dinitRoot, "dinitctl.wasm")),
          ),
        },
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
