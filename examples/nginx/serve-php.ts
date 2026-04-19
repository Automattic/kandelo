/**
 * serve-php.ts — Run nginx (multi-worker) + php-fpm on wasm-posix-kernel.
 *
 * Starts multiple Wasm processes in the same kernel:
 *   - php-fpm master (pid 1) → forks 1 worker (pid 2)
 *   - nginx master   (pid 3) → forks 2 workers (pid 4, 5)
 *
 * The kernel's cross-process loopback routes nginx → php-fpm traffic
 * through in-kernel pipes.
 *
 * Usage:
 *   npx tsx examples/nginx/serve-php.ts
 *
 * Then: curl http://localhost:8080/info.php
 */

import { readFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { NodeKernelHost } from "../../host/src/node-kernel-host";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const prefix = resolve(scriptDir);

// Create temp directories
for (const dir of ["client_body_temp", "fastcgi_temp"]) {
  mkdirSync(join("/tmp/nginx-wasm", dir), { recursive: true });
}
mkdirSync("/tmp/nginx-wasm/logs", { recursive: true });

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function main() {
  const phpFpmWasm = resolve(scriptDir, "php-fpm.wasm");
  const nginxWasm = resolve(scriptDir, "nginx.wasm");
  const confPath = resolve(scriptDir, "nginx.conf");
  const phpFpmConf = resolve(scriptDir, "php-fpm.conf");

  for (const [name, path] of [["php-fpm.wasm", phpFpmWasm], ["nginx.wasm", nginxWasm]] as const) {
    if (!existsSync(path)) {
      console.error(`${name} not found. Run the appropriate build script first.`);
      process.exit(1);
    }
  }

  const phpFpmBytes = loadBytes(phpFpmWasm);
  const nginxBytes = loadBytes(nginxWasm);

  const host = new NodeKernelHost({
    maxWorkers: 8,
    onStdout: (_pid, data) => process.stdout.write(data),
    onStderr: (_pid, data) => process.stderr.write(data),
  });

  await host.init();

  // --- Process 1: php-fpm master ---
  // pid 1, fork child gets pid 2
  console.log("Starting php-fpm master (pid 1) on 127.0.0.1:9000...");
  const fpmExit = host.spawn(phpFpmBytes, [
    "php-fpm",
    "-y", phpFpmConf,
    "-c", "/dev/null",
    "--nodaemonize",
  ], {
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin"],
    cwd: prefix,
  });

  // Wait for php-fpm to start listening before starting nginx
  console.log("Waiting for php-fpm to initialize...");
  await new Promise((r) => setTimeout(r, 2000));

  // --- nginx master ---
  console.log("Starting nginx master (pid 3) on http://localhost:8080/...");
  console.log("  nginx will fork 2 worker processes");
  host.spawn(nginxBytes, [
    "nginx",
    "-p", prefix + "/",
    "-c", confPath,
  ], {
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin"],
    cwd: prefix,
  });

  console.log("\nnginx (multi-worker) + php-fpm running!");
  console.log("  Static files: curl http://localhost:8080/");
  console.log("  PHP:          curl http://localhost:8080/info.php");
  console.log("\nPress Ctrl+C to stop.");

  // Handle Ctrl+C
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await host.destroy().catch(() => {});
    process.exit(0);
  });

  // Wait for php-fpm to exit (it shouldn't normally)
  await fpmExit;
  await host.destroy().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
