/**
 * Shared MariaDB benchmark logic.
 *
 * Extracted so mariadb-aria and mariadb-innodb suites can reuse it
 * with different engine configurations.
 */
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createConnection, createServer, type Socket } from "net";
import { NodeKernelHost } from "../../host/src/node-kernel-host.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const mariadbLibDir = resolve(repoRoot, "examples/libs/mariadb");
const installDir = resolve(mariadbLibDir, "mariadb-install");
const mysqldPath = resolve(installDir, "bin/mariadbd");
const mysqlTestPath = resolve(installDir, "bin/mysqltest.wasm");

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function tryConnect(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    const sock: Socket = createConnection({ host: "127.0.0.1", port }, () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

interface MariaDBInstance {
  host: NodeKernelHost;
  port: number;
  cleanup: () => Promise<void>;
}

async function startMariaDB(dataDir: string, bootstrap: boolean, engineArgs: string[]): Promise<MariaDBInstance> {
  const port = await getFreePort();
  const mysqldBytes = loadBytes(mysqldPath);

  const host = new NodeKernelHost({
    maxWorkers: 8,
    // InnoDB writes log files in 1MB+ chunks; increase from 64KB default
    dataBufferSize: engineArgs.some(a => a.includes("InnoDB")) ? 2 * 1024 * 1024 : undefined,
    onStdout: () => {},
    onStderr: () => {},
  });

  await host.init();

  const commonArgs = [
    "mariadbd", "--no-defaults",
    `--datadir=${dataDir}`,
    `--tmpdir=${resolve(dataDir, "tmp")}`,
    "--skip-grant-tables",
    "--key-buffer-size=1048576",
    "--table-open-cache=10",
    "--sort-buffer-size=262144",
    ...engineArgs,
  ];

  const serverArgs = bootstrap
    ? [...commonArgs, "--bootstrap", "--log-warnings=0"]
    : [...commonArgs, "--skip-networking=0", `--port=${port}`, "--bind-address=0.0.0.0", "--socket=", "--max-connections=10"];

  let stdinData: Uint8Array | undefined;
  if (bootstrap) {
    const shareDir = resolve(installDir, "share/mysql");
    const systemTables = readFileSync(resolve(shareDir, "mysql_system_tables.sql"), "utf-8");
    const systemData = readFileSync(resolve(shareDir, "mysql_system_tables_data.sql"), "utf-8");
    const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\n`;
    stdinData = new TextEncoder().encode(bootstrapSql);
  }

  const exitPromise = host.spawn(mysqldBytes, serverArgs, {
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
    cwd: dataDir,
    stdin: stdinData,
  });

  if (bootstrap) {
    const timeout = new Promise<number>((r) => setTimeout(() => r(0), 120_000));
    await Promise.race([exitPromise, timeout]);
  }

  const cleanup = async () => {
    await host.destroy().catch(() => {});
  };

  return { host, port, cleanup };
}

async function runMysqlTest(
  instance: MariaDBInstance,
  sql: string,
): Promise<{ stdout: string; exitCode: number }> {
  const { runCentralizedProgram } = await import("../../host/test/centralized-test-helper.js");
  const result = await runCentralizedProgram({
    programPath: mysqlTestPath,
    argv: [
      "mysqltest",
      "--host=127.0.0.1",
      `--port=${instance.port}`,
      "--user=root",
      "--silent",
    ],
    stdin: sql,
    timeout: 120_000,
  });
  return { stdout: result.stdout, exitCode: result.exitCode };
}

export function isMariaDBAvailable(): boolean {
  return existsSync(mysqldPath);
}

export async function runMariaDBBenchmark(engine: string): Promise<Record<string, number>> {
  if (!isMariaDBAvailable()) {
    console.warn("  MariaDB not found, skipping. Run: bash examples/libs/mariadb/build-mariadb.sh");
    return {};
  }

  const engineArgs = [`--default-storage-engine=${engine}`];
  if (engine === "InnoDB") {
    engineArgs.push(
      "--innodb-buffer-pool-size=8M",
      "--innodb-log-file-size=2M",
      "--innodb-log-buffer-size=1M",
      "--innodb-flush-log-at-trx-commit=2",
      "--innodb-buffer-pool-load-at-startup=OFF",
      "--innodb-buffer-pool-dump-at-shutdown=OFF",
    );
  }

  const results: Record<string, number> = {};

  // Use a fresh data directory for each run
  const dataDir = resolve(repoRoot, `benchmarks/results/.mariadb-bench-data-${engine.toLowerCase()}`);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(resolve(dataDir, "mysql"), { recursive: true });
  mkdirSync(resolve(dataDir, "tmp"), { recursive: true });

  // 1. Bootstrap
  const t0 = performance.now();
  const bootstrapInstance = await startMariaDB(dataDir, true, engineArgs);
  await bootstrapInstance.cleanup();
  results.bootstrap_ms = performance.now() - t0;

  // 2. Start server
  const instance = await startMariaDB(dataDir, false, engineArgs);

  // Wait for TCP readiness
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await tryConnect(instance.port)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    // 3. CREATE TABLE
    const t1 = performance.now();
    await runMysqlTest(instance, `
      CREATE DATABASE IF NOT EXISTS bench;
      USE bench;
      CREATE TABLE t1 (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(100), value INT) ENGINE=${engine};
      CREATE TABLE t2 (id INT PRIMARY KEY AUTO_INCREMENT, t1_id INT, data VARCHAR(200)) ENGINE=${engine};
    `);
    results.query_create_ms = performance.now() - t1;

    // 4. INSERT 100 rows
    let insertSql = "USE bench;\n";
    for (let i = 0; i < 100; i++) {
      insertSql += `INSERT INTO t1 (name, value) VALUES ('item_${i}', ${i * 10});\n`;
    }
    for (let i = 0; i < 100; i++) {
      insertSql += `INSERT INTO t2 (t1_id, data) VALUES (${i + 1}, 'data_for_item_${i}');\n`;
    }
    const t2 = performance.now();
    await runMysqlTest(instance, insertSql);
    results.query_insert_ms = performance.now() - t2;

    // 5. SELECT with WHERE
    const t3 = performance.now();
    await runMysqlTest(instance, `
      USE bench;
      SELECT * FROM t1 WHERE value > 500 AND value < 800;
    `);
    results.query_select_ms = performance.now() - t3;

    // 6. JOIN
    const t4 = performance.now();
    await runMysqlTest(instance, `
      USE bench;
      SELECT t1.name, t2.data FROM t1 JOIN t2 ON t1.id = t2.t1_id WHERE t1.value > 500;
    `);
    results.query_join_ms = performance.now() - t4;
  } finally {
    await instance.cleanup();
  }

  // Cleanup data directory
  rmSync(dataDir, { recursive: true, force: true });

  return results;
}
