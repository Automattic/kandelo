/**
 * Build a fully-bootable VFS image for the nginx demo. The image
 * contains dinit (PID 1), nginx, the nginx config + static content,
 * and a single dinit service file. The browser demo just fetches the
 * image and boots — no JS-side orchestration.
 *
 * Produces: examples/browser/public/nginx.vfs
 *
 * Usage: npx tsx examples/browser/scripts/build-nginx-vfs-image.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { resolveBinary, findRepoRoot } from "../../../host/src/binary-resolver";
import { saveImage } from "./vfs-image-helpers";
import { addDinitInit } from "./dinit-image-helpers";

const REPO_ROOT = findRepoRoot();
const NGINX_CONF_HOST = join(REPO_ROOT, "examples", "nginx", "nginx.conf");
const OUT_FILE = join(REPO_ROOT, "examples", "browser", "public", "nginx.vfs");

const INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>nginx on wasm-posix-kernel</title>
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
    <code>/sbin/dinit</code> as PID 1, which read
    <code>/etc/dinit.d/nginx</code> and brought the service up.</p>
    <p>Request flow: browser fetch → service worker → main thread →
    TCP connection injected into the kernel → nginx (Wasm) → response
    flows back through the same pipe.</p>
  </div>
</body>
</html>
`;

// nginx.conf shipped in the image — uses the project's existing conf.
// nginx's master process calls getpwnam("nobody") at startup; the
// kernel's synthetic /etc/passwd has the entry, so no override needed.
function loadNginxConf(): string {
  try {
    return readFileSync(NGINX_CONF_HOST, "utf8");
  } catch {
    throw new Error(`nginx.conf not found at ${NGINX_CONF_HOST}`);
  }
}

async function main() {
  const NGINX_WASM = resolveBinary("programs/nginx.wasm");

  // 32MB SAB; nginx wasm itself is ~3MB, dinit+dinitctl ~1.6MB,
  // plus configs and html — fits comfortably with room to grow at boot.
  const sab = new SharedArrayBuffer(32 * 1024 * 1024, { maxByteLength: 128 * 1024 * 1024 });
  const fs = MemoryFileSystem.create(sab, 128 * 1024 * 1024);

  // Standard system tree
  for (const dir of ["/tmp", "/home", "/dev", "/etc", "/run", "/var"]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);
  ensureDirRecursive(fs, "/usr/sbin");
  ensureDirRecursive(fs, "/var/www/html");
  ensureDirRecursive(fs, "/etc/nginx");

  // nginx binary + config + content
  writeVfsBinary(fs, "/usr/sbin/nginx", new Uint8Array(readFileSync(NGINX_WASM)));
  writeVfsFile(fs, "/etc/nginx/nginx.conf", loadNginxConf());
  writeVfsFile(fs, "/var/www/html/index.html", INDEX_HTML);
  // The packaged conf uses `root html;` (relative to the prefix passed
  // via -p), so symlink /etc/nginx/html -> /var/www/html so the conf
  // resolves to a real path.
  try { fs.symlink("/var/www/html", "/etc/nginx/html"); } catch { /* exists */ }

  // dinit + service tree
  addDinitInit(fs, [
    {
      name: "nginx",
      type: "process",
      command: "/usr/sbin/nginx -p /etc/nginx -c nginx.conf",
      restart: true,
      restartDelay: 2,
    },
  ]);

  await saveImage(fs, OUT_FILE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
