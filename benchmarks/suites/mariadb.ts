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
import { tryResolveBinary } from "../../host/src/binary-resolver.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const mariadbLibDir = resolve(repoRoot, "examples/libs/mariadb");

export type WasmArch = "wasm32" | "wasm64";

function localInstallDir(arch: WasmArch): string {
  return resolve(mariadbLibDir, arch === "wasm64" ? "mariadb-install-64" : "mariadb-install");
}

// Resolve the mariadbd / mysqltest wasm binary. Priority:
//   1. Packaged binary under binaries/programs/<arch>/mariadb/<name>
//      (populated by scripts/fetch-binaries.sh).
//   2. Local source build under examples/libs/mariadb/mariadb-install[-64]/bin/.
function resolveMariaDBBinary(arch: WasmArch, name: "mariadbd" | "mysqltest.wasm"): string | null {
  const packaged = tryResolveBinary(`programs/${arch}/mariadb/${name === "mariadbd" ? "mariadbd.wasm" : name}`);
  if (packaged) return packaged;
  const local = resolve(localInstallDir(arch), "bin", name);
  if (existsSync(local)) return local;
  return null;
}

// Locate the mysql_system_tables*.sql bootstrap files. The mariadb
// package archive ships only the wasm binaries (see package.toml
// outputs), so these SQL files come from one of:
//   1. $MARIADB_BENCH_SQL_DIR (CI / explicit override)
//   2. examples/libs/mariadb/share/mysql/ (vendored / staged fixture)
//   3. examples/libs/mariadb/mariadb-install[-64]/share/mysql/ (local source build)
function resolveSystemTablesSql(arch: WasmArch, basename: string): string | null {
  const candidates: string[] = [];
  if (process.env.MARIADB_BENCH_SQL_DIR) {
    candidates.push(resolve(process.env.MARIADB_BENCH_SQL_DIR, basename));
  }
  candidates.push(resolve(mariadbLibDir, "share/mysql", basename));
  candidates.push(resolve(localInstallDir(arch), "share/mysql", basename));
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

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

async function startMariaDB(arch: WasmArch, dataDir: string, bootstrap: boolean, engineArgs: string[]): Promise<MariaDBInstance> {
  const port = await getFreePort();
  const mariadbdPath = resolveMariaDBBinary(arch, "mariadbd");
  if (!mariadbdPath) {
    throw new Error(
      `mariadbd ${arch} binary not found. Expected via fetch-binaries (binaries/programs/${arch}/mariadb/mariadbd.wasm) or local build (mariadb-install/bin/mariadbd).`,
    );
  }
  const mysqldBytes = loadBytes(mariadbdPath);

  const verbose = process.env.MARIADB_BENCH_VERBOSE === "1";
  const host = new NodeKernelHost({
    maxWorkers: 8,
    // InnoDB writes log files in 1MB+ chunks; increase from 64KB default
    dataBufferSize: engineArgs.some(a => a.includes("InnoDB")) ? 2 * 1024 * 1024 : undefined,
    onStdout: verbose ? (_pid, data) => process.stdout.write(new TextDecoder().decode(data)) : () => {},
    onStderr: verbose ? (_pid, data) => process.stderr.write(new TextDecoder().decode(data)) : () => {},
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
    const tablesPath = resolveSystemTablesSql(arch, "mysql_system_tables.sql");
    const dataPath = resolveSystemTablesSql(arch, "mysql_system_tables_data.sql");
    if (!tablesPath || !dataPath) {
      throw new Error(
        "MariaDB bootstrap SQL not found (mysql_system_tables.sql + mysql_system_tables_data.sql). " +
          "Set $MARIADB_BENCH_SQL_DIR, vendor under examples/libs/mariadb/share/mysql/, or run build-mariadb.sh.",
      );
    }
    const systemTables = readFileSync(tablesPath, "utf-8");
    const systemData = readFileSync(dataPath, "utf-8");
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
  arch: WasmArch,
  instance: MariaDBInstance,
  sql: string,
): Promise<{ stdout: string; exitCode: number }> {
  const mysqltestPath = resolveMariaDBBinary(arch, "mysqltest.wasm");
  if (!mysqltestPath) {
    throw new Error(`mysqltest ${arch} binary not found.`);
  }
  const { runCentralizedProgram } = await import("../../host/test/centralized-test-helper.js");
  // wasm64 mariadbd cold-start under V8 wasm-c-api takes substantially
  // longer than wasm32 — observed >120s on the very first query.
  // Use a more generous budget for wasm64 so the cold-start path can
  // complete; wasm32 keeps the tighter cap to fail fast on real hangs.
  const timeoutMs = arch === "wasm64" ? 600_000 : 180_000;
  const result = await runCentralizedProgram({
    programPath: mysqltestPath,
    argv: [
      "mysqltest",
      "--host=127.0.0.1",
      `--port=${instance.port}`,
      "--user=root",
      "--silent",
    ],
    stdin: sql,
    timeout: timeoutMs,
  });
  return { stdout: result.stdout, exitCode: result.exitCode };
}

export function isMariaDBAvailable(arch: WasmArch = "wasm32"): boolean {
  return resolveMariaDBBinary(arch, "mariadbd") !== null
    && resolveSystemTablesSql(arch, "mysql_system_tables.sql") !== null;
}

export async function runMariaDBBenchmark(engine: string, arch: WasmArch = "wasm32"): Promise<Record<string, number>> {
  if (!isMariaDBAvailable(arch)) {
    const flag = arch === "wasm64" ? " --wasm64" : "";
    console.warn(
      `  MariaDB ${arch} not runnable (missing binary or bootstrap SQL); skipping.\n` +
      `    Hint: scripts/fetch-binaries.sh + scripts/stage-bench-fixtures.sh, or build locally: bash examples/libs/mariadb/build-mariadb.sh${flag}`,
    );
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

  // Use a fresh data directory for each run (separate per arch so concurrent suites don't collide)
  const dataDir = resolve(repoRoot, `benchmarks/results/.mariadb-bench-data-${engine.toLowerCase()}-${arch}`);
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(resolve(dataDir, "mysql"), { recursive: true });
  mkdirSync(resolve(dataDir, "tmp"), { recursive: true });

  // 1. Bootstrap
  const t0 = performance.now();
  const bootstrapInstance = await startMariaDB(arch, dataDir, true, engineArgs);
  await bootstrapInstance.cleanup();
  results.bootstrap_ms = performance.now() - t0;

  // 2. Start server
  const instance = await startMariaDB(arch, dataDir, false, engineArgs);

  // Wait for TCP readiness
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await tryConnect(instance.port)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  try {
    // 3. Run all DDL + DML + queries in a SINGLE mysqltest invocation.
    //
    // Previously this was 4 separate runMysqlTest() calls (CREATE,
    // INSERT, SELECT, JOIN) and the per-call numbers all clocked
    // ~50,800ms — almost entirely mysqltest spawn + TCP handshake
    // overhead, with the actual SQL work in the noise. Batching pays
    // that startup once and gives a single end-to-end measurement
    // that's still dominated by startup but at ~25% of the wall clock.
    //
    // Side benefit: this also means wasm64 mariadb only pays its
    // (much heavier) cold-start once per round instead of four times,
    // which is what makes wasm64 mariadb tractable in CI again.
    const batchedSql =
      `CREATE DATABASE IF NOT EXISTS bench;\n` +
      `USE bench;\n` +
      `CREATE TABLE t1 (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(100), value INT) ENGINE=${engine};\n` +
      `CREATE TABLE t2 (id INT PRIMARY KEY AUTO_INCREMENT, t1_id INT, data VARCHAR(200)) ENGINE=${engine};\n` +
      Array.from({ length: 100 }, (_, i) =>
        `INSERT INTO t1 (name, value) VALUES ('item_${i}', ${i * 10});`).join("\n") + "\n" +
      Array.from({ length: 100 }, (_, i) =>
        `INSERT INTO t2 (t1_id, data) VALUES (${i + 1}, 'data_for_item_${i}');`).join("\n") + "\n" +
      `SELECT * FROM t1 WHERE value > 500 AND value < 800;\n` +
      `SELECT t1.name, t2.data FROM t1 JOIN t2 ON t1.id = t2.t1_id WHERE t1.value > 500;\n`;

    const t1 = performance.now();
    await runMysqlTest(arch, instance, batchedSql);
    results.all_queries_ms = performance.now() - t1;
  } finally {
    await instance.cleanup();
  }

  // Cleanup data directory
  rmSync(dataDir, { recursive: true, force: true });

  return results;
}
