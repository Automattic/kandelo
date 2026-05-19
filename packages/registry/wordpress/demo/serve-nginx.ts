/**
 * serve-nginx.ts — WordPress behind nginx + PHP-FPM on wasm-posix-kernel.
 *
 * Boots the same fully virtualized dinit/nginx/PHP-FPM/WordPress VFS image
 * used by the browser demo. dinit starts:
 *   - wp-config-init
 *   - php-fpm master → static worker pool
 *   - nginx master   → 2 workers
 *
 * nginx handles HTTP connections (multi-worker) and proxies all requests
 * to PHP-FPM via FastCGI over the kernel's loopback TCP.
 *
 * Usage:
 *   npx tsx packages/registry/wordpress/demo/serve-nginx.ts [port]
 *
 * Requires:
 *   1. WordPress VFS image: programs/wordpress.vfs.zst
 *      (build with: bash images/vfs/scripts/build-wp-vfs-image.sh)
 *   2. dinit binary: programs/dinit/dinit.wasm
 */

import { readFileSync } from "fs";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { writeVfsFile } from "../../../../host/src/vfs/image-helpers";

const wordpressVfsPath = resolveBinary("programs/wordpress.vfs.zst");
const dinitWasmPath = resolveBinary("programs/dinit/dinit.wasm");

const port = parseInt(process.argv[2] || "8080", 10);

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
  const wordpressVfs = await configureWordPressVfs(loadBytes(wordpressVfsPath));
  const dinitBytes = loadBytes(dinitWasmPath);

  const host = new NodeKernelHost({
    maxWorkers: 8,
    rootfsImage: wordpressVfs,
    onStdout: (_pid, data) => process.stdout.write(data),
    onStderr: (_pid, data) => process.stderr.write(data),
  });

  await host.init();

  console.log("Booting WordPress VFS with dinit...");
  const dinitExit = host.spawn(dinitBytes, [
    "/sbin/dinit",
    "--container",
    "-p",
    "/tmp/dinitctl",
  ], {
    env: [
      "HOME=/root",
      "TERM=xterm-256color",
      "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin",
      "WP_APP_PATH=/",
      "WP_PROTO=http",
    ],
    cwd: "/",
  });

  let dinitExited = false;
  dinitExit.then((code) => {
    dinitExited = true;
    console.error(`dinit exited with code ${code}`);
  }).catch(() => {
    dinitExited = true;
  });

  console.log(`Waiting for nginx on http://localhost:${port}/...`);
  await waitForHttp(`http://localhost:${port}/`, 180_000, () => dinitExited);

  console.log("\nWordPress running behind nginx + php-fpm!");
  console.log(`  Homepage:  curl http://localhost:${port}/`);
  console.log(`  Admin:     http://localhost:${port}/wp-admin/`);
  console.log("\nPress Ctrl+C to stop.");

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await host.destroy().catch(() => {});
    process.exit(0);
  });

  await dinitExit;
  await host.destroy().catch(() => {});
}

async function configureWordPressVfs(image: ArrayBuffer): Promise<ArrayBuffer> {
  const fs = MemoryFileSystem.fromImage(new Uint8Array(image), {
    maxByteLength: 1024 * 1024 * 1024,
  });
  const nginxConf = readVfsText(fs, "/etc/nginx/nginx.conf")
    .replace(/listen\s+8080;/, `listen ${port};`);
  writeVfsFile(fs, "/etc/nginx/nginx.conf", nginxConf);
  for (const service of ["wp-config-init", "php-fpm", "nginx"]) {
    const path = `/etc/dinit.d/${service}`;
    const conf = readVfsText(fs, path).replace(/^logfile\s*=.*\n/gm, "");
    writeVfsFile(fs, path, conf);
  }
  try {
    fs.unlink("/var/www/html/wp-content/database/wordpress.db");
  } catch {
    // Fresh release images do not contain an installed database.
  }
  const saved = await fs.saveImage();
  return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength);
}

function readVfsText(fs: MemoryFileSystem, path: string): string {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(st.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const n = fs.read(fd, bytes.subarray(offset), null, bytes.byteLength - offset);
      if (n <= 0) break;
      offset += n;
    }
    return new TextDecoder().decode(bytes.subarray(0, offset));
  } finally {
    fs.close(fd);
  }
}

async function waitForHttp(
  url: string,
  timeoutMs: number,
  didExit: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (didExit()) {
      throw new Error("dinit exited before nginx responded to HTTP");
    }
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      await resp.body?.cancel();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`nginx did not respond to HTTP within ${timeoutMs}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
