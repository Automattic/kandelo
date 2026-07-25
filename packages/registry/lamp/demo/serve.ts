/**
 * serve.ts — Full LAMP stack on kandelo.
 *
 * Runs MariaDB + PHP-FPM + nginx as separate Wasm processes in one kernel:
 *   - MariaDB   (threads for signal handler + timer)
 *   - PHP-FPM   (master + 6 worker processes)
 *   - nginx     (master + 2 worker processes)
 *
 * All inter-process communication (FastCGI, MySQL protocol) flows through
 * the kernel's cross-process loopback TCP.
 *
 * Usage:
 *   npx tsx packages/registry/lamp/demo/serve.ts [port]
 *
 * Requires:
 *   1. MariaDB:  programs/mariadb/mariadbd.wasm
 *   2. PHP-FPM:  programs/php/php-fpm.wasm
 *   3. nginx:    programs/nginx.wasm
 *   4. WordPress: packages/registry/lamp/demo/wordpress/
 *      (download with: bash packages/registry/lamp/demo/setup.sh)
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { resolveBinary, tryResolveBinary } from "../../../../host/src/binary-resolver";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../../../..");

// Binary paths
const mariadbInstall = resolve(repoRoot, "packages/registry/mariadb/mariadb-install");
const mysqldPath = tryResolveBinary("programs/mariadb/mariadbd.wasm")
  ?? resolve(mariadbInstall, "bin/mariadbd.wasm");
const phpFpmWasmPath = resolveBinary("programs/php/php-fpm.wasm");
const nginxWasmPath = resolveBinary("programs/nginx.wasm");

// WordPress and config paths
const wpDir = resolve(scriptDir, "wordpress");
const confTemplate = resolve(scriptDir, "nginx.conf");
const phpFpmConf = resolve(scriptDir, "php-fpm.conf");
const routerScript = resolve(scriptDir, "fpm-router.php");

// MariaDB data directory
const dataDir = resolve(scriptDir, "data");

const port = parseInt(process.argv[2] || "8080", 10);

// Validate prerequisites
for (const [name, path, hint] of [
  ["mariadbd.wasm", mysqldPath, "scripts/fetch-binaries.sh or bash packages/registry/mariadb/build-mariadb.sh"],
  ["php-fpm.wasm", phpFpmWasmPath, "bash packages/registry/php/build-php.sh"],
  ["nginx.wasm", nginxWasmPath, "bash packages/registry/nginx/build-nginx-local.sh"],
] as const) {
  if (!existsSync(path)) {
    console.error(`Error: ${name} not found. Run: ${hint}`);
    process.exit(1);
  }
}
if (!existsSync(join(wpDir, "wp-settings.php"))) {
  console.error("Error: WordPress not found. Run: bash packages/registry/lamp/demo/setup.sh");
  process.exit(1);
}

// Create directories
mkdirSync(resolve(dataDir, "mysql"), { recursive: true });
mkdirSync(resolve(dataDir, "tmp"), { recursive: true });
for (const dir of ["client_body_temp", "fastcgi_temp", "logs"]) {
  mkdirSync(join("/tmp/nginx-wasm", dir), { recursive: true });
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function generateNginxConf(): string {
  let conf = readFileSync(confTemplate, "utf-8");
  conf = conf.replace(/WORDPRESS_ROOT/g, wpDir);
  conf = conf.replace(/ROUTER_SCRIPT/g, routerScript);
  conf = conf.replace("listen 8080", `listen ${port}`);
  const outPath = "/tmp/nginx-wasm/lamp-nginx.conf";
  writeFileSync(outPath, conf);
  return outPath;
}

async function main() {
  const mysqldBytes = loadBytes(mysqldPath);
  const phpFpmBytes = loadBytes(phpFpmWasmPath);
  const nginxBytes = loadBytes(nginxWasmPath);

  // Check if bootstrap is needed
  const mysqlDir = resolve(dataDir, "mysql");
  const needsBootstrap = readdirSync(mysqlDir).length === 0;

  if (needsBootstrap) {
    // =========================================================================
    // Bootstrap Phase: initialize MariaDB system tables
    // =========================================================================
    console.log("Bootstrapping MariaDB system tables...");
    const shareDir = resolve(mariadbInstall, "share/mysql");
    const systemTables = readFileSync(resolve(shareDir, "mysql_system_tables.sql"), "utf-8");
    const systemData = readFileSync(resolve(shareDir, "mysql_system_tables_data.sql"), "utf-8");
    const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\n`;

    const bootstrapHost = new NodeKernelHost({
      maxWorkers: 12,
      onStdout: (_pid, data) => process.stdout.write(new TextDecoder().decode(data)),
      onStderr: (_pid, data) => process.stderr.write(new TextDecoder().decode(data)),
    });
    await bootstrapHost.init();

    const bootstrapExit = bootstrapHost.spawn(mysqldBytes, [
      "mariadbd", "--no-defaults",
      `--datadir=${dataDir}`, `--tmpdir=${resolve(dataDir, "tmp")}`,
      "--default-storage-engine=Aria", "--skip-grant-tables",
      "--key-buffer-size=1048576", "--table-open-cache=10",
      "--sort-buffer-size=262144", "--bootstrap", "--log-warnings=0",
    ], {
      env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
      cwd: dataDir,
      stdin: new TextEncoder().encode(bootstrapSql),
    });

    const bootstrapTimeout = new Promise<number>((r) => setTimeout(() => {
      console.log("Bootstrap complete (timeout). Proceeding...");
      r(0);
    }, 30000));
    await Promise.race([bootstrapExit, bootstrapTimeout]);
    await bootstrapHost.destroy().catch(() => {});

    // Create WordPress database
    console.log("Creating wordpress database...");
    const createDbHost = new NodeKernelHost({
      maxWorkers: 12,
      onStdout: (_pid, data) => process.stdout.write(new TextDecoder().decode(data)),
      onStderr: (_pid, data) => process.stderr.write(new TextDecoder().decode(data)),
    });
    await createDbHost.init();

    const createDbExit = createDbHost.spawn(mysqldBytes, [
      "mariadbd", "--no-defaults",
      `--datadir=${dataDir}`, `--tmpdir=${resolve(dataDir, "tmp")}`,
      "--default-storage-engine=Aria", "--skip-grant-tables",
      "--key-buffer-size=1048576", "--table-open-cache=10",
      "--sort-buffer-size=262144", "--bootstrap", "--log-warnings=0",
    ], {
      env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
      cwd: dataDir,
      stdin: new TextEncoder().encode("CREATE DATABASE IF NOT EXISTS wordpress;\n"),
    });

    const createDbTimeout = new Promise<number>((r) => setTimeout(() => r(0), 15000));
    await Promise.race([createDbExit, createDbTimeout]);
    await createDbHost.destroy().catch(() => {});
    console.log("Database bootstrap complete.\n");
  }

  // =========================================================================
  // Main Phase: start all services
  // =========================================================================

  const host = new NodeKernelHost({
    maxWorkers: 16,
    onStdout: (_pid, data) => process.stdout.write(new TextDecoder().decode(data)),
    onStderr: (_pid, data) => process.stderr.write(new TextDecoder().decode(data)),
  });
  await host.init();

  // Phase 1: MariaDB
  console.log("Starting MariaDB on 127.0.0.1:3306...");
  host.spawn(mysqldBytes, [
    "mariadbd", "--no-defaults",
    `--datadir=${dataDir}`, `--tmpdir=${resolve(dataDir, "tmp")}`,
    "--default-storage-engine=Aria", "--skip-grant-tables",
    "--key-buffer-size=1048576", "--table-open-cache=10",
    "--sort-buffer-size=262144",
    "--skip-networking=0", "--port=3306",
    "--bind-address=0.0.0.0", "--socket=",
    "--max-connections=10",
  ], {
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
    cwd: dataDir,
  });

  // Wait for MariaDB to be ready
  console.log("Waiting for MariaDB to initialize...");
  await new Promise((r) => setTimeout(r, 5000));

  // Phase 2: PHP-FPM
  console.log("Starting PHP-FPM on 127.0.0.1:9000...");
  host.spawn(phpFpmBytes, [
    "php-fpm", "-R", "-y", phpFpmConf, "-c", "/dev/null", "--nodaemonize",
  ], {
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin"],
    cwd: wpDir,
  });

  // Wait for PHP-FPM to start listening
  console.log("Waiting for PHP-FPM to initialize...");
  await new Promise((r) => setTimeout(r, 2000));

  // Phase 3: nginx
  const confPath = generateNginxConf();
  console.log(`Starting nginx on http://localhost:${port}/...`);
  console.log("  nginx will fork 2 worker processes\n");
  host.spawn(nginxBytes, [
    "nginx", "-p", scriptDir + "/", "-c", confPath,
  ], {
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin"],
    cwd: scriptDir,
  });

  // Ready
  console.log("=== LAMP stack running on kandelo ===");
  console.log(`  MariaDB:   127.0.0.1:3306`);
  console.log(`  PHP-FPM:   127.0.0.1:9000 (master + 6 workers)`);
  console.log(`  nginx:     http://localhost:${port}/ (master + 2 workers)`);
  console.log(`  WordPress: http://localhost:${port}/`);
  console.log("\nPress Ctrl+C to stop.");

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await host.destroy().catch(() => {});
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
