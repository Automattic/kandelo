/**
 * serve-nginx.ts — WordPress behind nginx + PHP-FPM on wasm-posix-kernel.
 *
 * Starts multiple Wasm processes in the same kernel:
 *   - php-fpm master (pid 1) → forks 1 worker (pid 2)
 *   - nginx master   (pid 3) → forks 2 workers (pid 4, 5)
 *
 * nginx handles HTTP connections (multi-worker) and proxies all requests
 * to PHP-FPM via FastCGI over the kernel's loopback TCP. A PHP router
 * script serves static files and routes WordPress requests.
 *
 * Usage:
 *   npx tsx examples/wordpress/serve-nginx.ts [port]
 *
 * Requires:
 *   1. nginx binary:   examples/nginx/nginx.wasm
 *      (build with: bash examples/nginx/build.sh)
 *   2. PHP-FPM binary: examples/nginx/php-fpm.wasm
 *      (build with: bash examples/libs/php/build-php.sh)
 *   3. WordPress files: examples/wordpress/wordpress/
 *      (download with: bash examples/wordpress/setup.sh)
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { NodeKernelHost } from "../../host/src/node-kernel-host";
import { resolveBinary } from "../../host/src/binary-resolver";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../..");

const nginxWasmPath = resolveBinary("programs/nginx.wasm");
const phpFpmWasmPath = resolveBinary("programs/php/php-fpm.wasm");
const wpDir = resolve(scriptDir, "wordpress");
const confTemplate = resolve(scriptDir, "nginx.conf");
const phpFpmConf = resolve(scriptDir, "php-fpm.conf");
const routerScript = resolve(scriptDir, "fpm-router.php");

const port = parseInt(process.argv[2] || "8080", 10);

// Validate prerequisites
for (const [name, path, hint] of [
  ["nginx.wasm", nginxWasmPath, "bash examples/nginx/build.sh"],
  ["php-fpm.wasm", phpFpmWasmPath, "bash examples/libs/php/build-php.sh"],
] as const) {
  if (!existsSync(path)) {
    console.error(`Error: ${name} not found. Run: ${hint}`);
    process.exit(1);
  }
}
if (!existsSync(join(wpDir, "wp-settings.php"))) {
  console.error("Error: WordPress not found. Run: bash examples/wordpress/setup.sh");
  process.exit(1);
}

// Create temp directories nginx needs
for (const dir of ["client_body_temp", "fastcgi_temp"]) {
  mkdirSync(join("/tmp/nginx-wasm", dir), { recursive: true });
}
mkdirSync("/tmp/nginx-wasm/logs", { recursive: true });

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function generateNginxConf(): string {
  let conf = readFileSync(confTemplate, "utf-8");
  conf = conf.replace(/WORDPRESS_ROOT/g, wpDir);
  conf = conf.replace(/ROUTER_SCRIPT/g, routerScript);
  conf = conf.replace("listen 8080", `listen ${port}`);
  const outPath = "/tmp/nginx-wasm/wordpress-nginx.conf";
  writeFileSync(outPath, conf);
  return outPath;
}

async function main() {
  const phpFpmBytes = loadBytes(phpFpmWasmPath);
  const nginxBytes = loadBytes(nginxWasmPath);

  const host = new NodeKernelHost({
    maxWorkers: 8,
    onStdout: (_pid, data) => process.stdout.write(data),
    onStderr: (_pid, data) => process.stderr.write(data),
  });

  await host.init();

  // --- Process 1: php-fpm master ---
  console.log("Starting php-fpm master (pid 1) on 127.0.0.1:9000...");
  const fpmExit = host.spawn(phpFpmBytes, [
    "php-fpm",
    "-y", phpFpmConf,
    "-c", "/dev/null",
    "--nodaemonize",
  ], {
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin"],
    cwd: wpDir,
  });

  // Wait for php-fpm to start listening before starting nginx
  console.log("Waiting for php-fpm to initialize...");
  await new Promise((r) => setTimeout(r, 2000));

  // --- nginx master ---
  const confPath = generateNginxConf();
  console.log(`Starting nginx master (pid 3) on http://localhost:${port}/...`);
  console.log("  nginx will fork 2 worker processes");
  host.spawn(nginxBytes, [
    "nginx",
    "-p", scriptDir + "/",
    "-c", confPath,
  ], {
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin"],
    cwd: scriptDir,
  });

  console.log("\nWordPress running behind nginx + php-fpm!");
  console.log(`  Homepage:  curl http://localhost:${port}/`);
  console.log(`  Admin:     http://localhost:${port}/wp-admin/`);
  console.log("\nPress Ctrl+C to stop.");

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await host.destroy().catch(() => {});
    process.exit(0);
  });

  await fpmExit;
  await host.destroy().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
