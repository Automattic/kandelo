/**
 * Shared MariaDB benchmark logic.
 *
 * Extracted so mariadb-aria and mariadb-innodb suites can reuse it
 * with different engine configurations.
 */
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { createServer } from "net";
import { NodeKernelHost } from "../../host/src/node-kernel-host.js";
import { tryResolveBinary } from "../../host/src/binary-resolver.js";
import { ensureSourceExtract } from "../../images/vfs/scripts/source-extract-helper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const mariadbLibDir = resolve(repoRoot, "packages/registry/mariadb");
const MARIADB_PROCESS_TIMEOUT_MS = 120_000;
const MARIADB_CLEANUP_TIMEOUT_MS = 10_000;

export type WasmArch = "wasm32" | "wasm64";

function installDirFor(arch: WasmArch): string {
  return resolve(mariadbLibDir, arch === "wasm64" ? "mariadb-install-64" : "mariadb-install");
}

function resolverPathFor(arch: WasmArch, file: "mariadbd.wasm" | "mysqltest.wasm"): string {
  return arch === "wasm64"
    ? `programs/wasm64/mariadb/${file}`
    : `programs/mariadb/${file}`;
}

function resolveMariaDBProgram(
  arch: WasmArch,
  file: "mariadbd.wasm" | "mysqltest.wasm",
): string | null {
  const resolved = tryResolveBinary(resolverPathFor(arch, file));
  if (resolved) return resolved;

  const legacy = resolve(installDirFor(arch), "bin", file);
  if (existsSync(legacy)) return legacy;

  if (file === "mariadbd.wasm") {
    const legacyNoExtension = resolve(installDirFor(arch), "bin/mariadbd");
    if (existsSync(legacyNoExtension)) return legacyNoExtension;
  }

  return null;
}

function resolveMariaDBBootstrapSql(arch: WasmArch): { systemTables: string; systemData: string } {
  const installDir = installDirFor(arch);
  const legacyTables = resolve(installDir, "share/mysql/mysql_system_tables.sql");
  const legacyData = resolve(installDir, "share/mysql/mysql_system_tables_data.sql");
  if (existsSync(legacyTables) && existsSync(legacyData)) {
    return { systemTables: legacyTables, systemData: legacyData };
  }

  const sourceDir = ensureSourceExtract("mariadb", repoRoot);
  return {
    systemTables: join(sourceDir, "scripts/mysql_system_tables.sql"),
    systemData: join(sourceDir, "scripts/mysql_system_tables_data.sql"),
  };
}

/** Filesystem inputs selected by one Node MariaDB architecture. */
export function describeMariaDBBenchmarkInputs(arch: WasmArch): {
  serverPath: string | null;
  serverResolverRequest: string;
  serverResolverSelectedPath: string | null;
  clientPath: string | null;
  clientResolverRequest: string;
  clientResolverSelectedPath: string | null;
  bootstrapSql: { systemTables: string; systemData: string } | null;
  bootstrapSqlError?: string;
} {
  const serverResolverRequest = resolverPathFor(arch, "mariadbd.wasm");
  const clientResolverRequest = resolverPathFor(arch, "mysqltest.wasm");
  const serverPath = resolveMariaDBProgram(arch, "mariadbd.wasm");
  const clientPath = resolveMariaDBProgram(arch, "mysqltest.wasm");
  let bootstrapSql: { systemTables: string; systemData: string } | null = null;
  let bootstrapSqlError: string | undefined;
  if (serverPath && clientPath) {
    try {
      bootstrapSql = resolveMariaDBBootstrapSql(arch);
    } catch (error) {
      bootstrapSqlError = error instanceof Error ? error.message : String(error);
    }
  } else {
    bootstrapSqlError = "not resolved because MariaDB program prerequisites are missing";
  }

  return {
    serverPath,
    serverResolverRequest,
    serverResolverSelectedPath: tryResolveBinary(serverResolverRequest),
    clientPath,
    clientResolverRequest,
    clientResolverSelectedPath: tryResolveBinary(clientResolverRequest),
    bootstrapSql,
    bootstrapSqlError,
  };
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

async function withRejectingTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function outputSuffix(output: string): string {
  const trimmed = output.trim();
  return trimmed ? `:\n${trimmed}` : "";
}

interface MariaDBInstance {
  host: NodeKernelHost;
  port: number;
  getOutput: () => string;
  getProcessOutput: (pid: number) => { stdout: string; stderr: string };
  dataDir: string;
  assertLiveServer: (activity: string) => void;
  raceLiveServer: <T>(operation: Promise<T>, activity: string) => Promise<T>;
  cleanup: () => Promise<void>;
}

async function startMariaDB(arch: WasmArch, dataDir: string, bootstrap: boolean, engineArgs: string[]): Promise<MariaDBInstance> {
  const port = await getFreePort();
  const mysqldPath = resolveMariaDBProgram(arch, "mariadbd.wasm");
  if (!mysqldPath) {
    throw new Error(`MariaDB ${arch} server binary not found`);
  }
  const mysqldBytes = loadBytes(mysqldPath);

  const verbose = process.env.MARIADB_BENCH_VERBOSE === "1";
  let output = "";
  const processOutput = new Map<number, { stdout: string; stderr: string }>();
  const appendOutput = (data: Uint8Array) => {
    const text = new TextDecoder().decode(data);
    output += text;
    if (output.length > 16_384) output = output.slice(-16_384);
    return text;
  };
  const appendProcessOutput = (pid: number, kind: "stdout" | "stderr", text: string) => {
    const entry = processOutput.get(pid) ?? { stdout: "", stderr: "" };
    entry[kind] += text;
    processOutput.set(pid, entry);
  };
  const host = new NodeKernelHost({
    maxWorkers: 8,
    enableTcpNetwork: true,
    // InnoDB writes log files in 1MB+ chunks; increase from 64KB default
    dataBufferSize: engineArgs.some(a => a.includes("InnoDB")) ? 2 * 1024 * 1024 : undefined,
    onStdout: (pid, data) => {
      const text = appendOutput(data);
      appendProcessOutput(pid, "stdout", text);
      if (verbose) process.stdout.write(text);
    },
    onStderr: (pid, data) => {
      const text = appendOutput(data);
      appendProcessOutput(pid, "stderr", text);
      if (verbose) process.stderr.write(text);
    },
  });

  await host.init();

  const commonArgs = [
    "mariadbd", "--no-defaults",
    "--user=root",
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
    const sqlPaths = resolveMariaDBBootstrapSql(arch);
    const systemTables = readFileSync(sqlPaths.systemTables, "utf-8");
    const systemData = readFileSync(sqlPaths.systemData, "utf-8");
    const bootstrapSql = `use mysql;\n${systemTables}\n${systemData}\n`;
    stdinData = new TextEncoder().encode(bootstrapSql);
  }

  let livePid: number | undefined;
  let resolveStarted: ((pid: number) => void) | undefined;
  const startedPromise = bootstrap
    ? undefined
    : new Promise<number>((resolveStartedPromise) => {
      resolveStarted = resolveStartedPromise;
    });
  const exitPromise = host.spawn(mysqldBytes, serverArgs, {
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
    cwd: dataDir,
    // Supplying onStarted keeps stdin open by default. The live benchmark
    // server instead needs the same immediate EOF it had before pid tracking.
    stdin: bootstrap ? stdinData : new Uint8Array(0),
    onStarted: bootstrap ? undefined : (pid) => resolveStarted?.(pid),
  });

  if (bootstrap) {
    try {
      const exitCode = await withRejectingTimeout(
        exitPromise,
        MARIADB_PROCESS_TIMEOUT_MS,
        `MariaDB ${arch} bootstrap timed out after ${MARIADB_PROCESS_TIMEOUT_MS}ms`,
      );
      if (exitCode !== 0) {
        throw new Error(
          `MariaDB ${arch} bootstrap exited with status ${exitCode}` +
          outputSuffix(output),
        );
      }
    } catch (error) {
      await host.destroy().catch(() => {});
      throw error;
    }
  } else {
    try {
      livePid = await withRejectingTimeout(
        Promise.race([
          startedPromise!,
          exitPromise.then((exitCode) => {
            throw new Error(
              `MariaDB ${arch} server exited with status ${exitCode} before startup completed` +
              outputSuffix(output),
            );
          }),
        ]),
        MARIADB_PROCESS_TIMEOUT_MS,
        `MariaDB ${arch} server startup timed out after ${MARIADB_PROCESS_TIMEOUT_MS}ms`,
      );
    } catch (error) {
      await host.destroy().catch(() => {});
      throw error;
    }
  }

  let liveExitStatus: number | undefined;
  let prematureExitObserved = false;
  if (!bootstrap) {
    void exitPromise.then(
      (status) => { liveExitStatus = status; },
      () => {},
    );
  }

  const liveServerError = (activity: string, status: number) => new Error(
    `MariaDB ${arch} server exited with status ${status} ${activity}` +
    outputSuffix(output),
  );

  const assertLiveServer = (activity: string) => {
    if (liveExitStatus === undefined) return;
    prematureExitObserved = true;
    throw liveServerError(activity, liveExitStatus);
  };

  const raceLiveServer = async <T>(operation: Promise<T>, activity: string): Promise<T> => {
    if (bootstrap) return operation;
    assertLiveServer(activity);
    return Promise.race([
      operation,
      exitPromise.then((status) => {
        prematureExitObserved = true;
        throw liveServerError(activity, status);
      }),
    ]);
  };

  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;

    let cleanupError: unknown;
    if (!bootstrap && livePid !== undefined) {
      if (liveExitStatus === undefined) {
        try {
          await host.terminateProcess(livePid, 137);
        } catch (error) {
          cleanupError = error;
        }

        try {
          const exitCode = await withRejectingTimeout(
            exitPromise,
            MARIADB_CLEANUP_TIMEOUT_MS,
            `MariaDB ${arch} server did not exit after deliberate termination`,
          );
          if (exitCode !== 137) {
            cleanupError = liveServerError("before deliberate cleanup completed", exitCode);
          }
        } catch (error) {
          cleanupError ??= error;
        }
      } else if (!prematureExitObserved) {
        cleanupError = liveServerError("before deliberate cleanup began", liveExitStatus);
      }
    }

    try {
      await host.destroy();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError !== undefined) throw cleanupError;
  };

  return {
    host,
    port,
    dataDir,
    getOutput: () => output,
    getProcessOutput: (pid) => processOutput.get(pid) ?? { stdout: "", stderr: "" },
    assertLiveServer,
    raceLiveServer,
    cleanup,
  };
}

async function runMysqlTest(
  arch: WasmArch,
  instance: MariaDBInstance,
  sql: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const mysqltestPath = resolveMariaDBProgram(arch, "mysqltest.wasm");
  if (!mysqltestPath) {
    throw new Error(`MariaDB ${arch} mysqltest binary not found`);
  }
  const mysqltestBytes = loadBytes(mysqltestPath);
  let pid = 0;
  const exitPromise = instance.host.spawn(
    mysqltestBytes,
    [
      "mysqltest",
      "--host=127.0.0.1",
      `--port=${instance.port}`,
      "--user=root",
      "--silent",
    ],
    {
      env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
      cwd: instance.dataDir,
      stdin: new TextEncoder().encode(sql),
      onStarted: (startedPid) => { pid = startedPid; },
    },
  );
  const exitCode = await withRejectingTimeout(
    instance.raceLiveServer(
      exitPromise,
      "during a mysqltest operation",
    ),
    MARIADB_PROCESS_TIMEOUT_MS,
    `mysqltest timed out after ${MARIADB_PROCESS_TIMEOUT_MS}ms`,
  );
  return { ...instance.getProcessOutput(pid), exitCode };
}

async function runMysqlTestChecked(
  arch: WasmArch,
  instance: MariaDBInstance,
  sql: string,
): Promise<void> {
  const result = await runMysqlTest(arch, instance, sql);
  if (result.exitCode !== 0) {
    throw new Error(
      `mysqltest failed with exit ${result.exitCode}:\n${result.stdout}\n${result.stderr}`,
    );
  }
}

export function isMariaDBAvailable(arch: WasmArch = "wasm32"): boolean {
  return resolveMariaDBProgram(arch, "mariadbd.wasm") !== null
    && resolveMariaDBProgram(arch, "mysqltest.wasm") !== null;
}

export async function runMariaDBBenchmark(engine: string, arch: WasmArch = "wasm32"): Promise<Record<string, number>> {
  if (!isMariaDBAvailable(arch)) {
    const flag = arch === "wasm64" ? " --wasm64" : "";
    throw new Error(
      `MariaDB ${arch} benchmark prerequisites are missing. ` +
      `Run: bash packages/registry/mariadb/build-mariadb.sh${flag}`,
    );
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
  try {
    // Wait for server readiness. Avoid a socket-level probe here: the Node TCP
    // bridge treats the probe as a real MariaDB client connection, and aborting
    // that connection can destabilize the benchmark before mysqltest starts.
    const deadline = Date.now() + MARIADB_PROCESS_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
      instance.assertLiveServer("while waiting for readiness");
      if (instance.getOutput().includes("ready for connections")) {
        ready = true;
        break;
      }
      await instance.raceLiveServer(
        new Promise((resolveSleep) => setTimeout(resolveSleep, 500)),
        "while waiting for readiness",
      );
    }
    if (!ready) {
      const output = instance.getOutput().trim();
      throw new Error(
        `MariaDB ${arch} server did not listen on port ${instance.port}` +
        (output ? `:\n${output}` : ""),
      );
    }

    // 3. CREATE TABLE
    const t1 = performance.now();
    await runMysqlTestChecked(arch, instance,`
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
    await runMysqlTestChecked(arch, instance,insertSql);
    results.query_insert_ms = performance.now() - t2;

    // 5. SELECT with WHERE
    const t3 = performance.now();
    await runMysqlTestChecked(arch, instance,`
      USE bench;
      SELECT * FROM t1 WHERE value > 500 AND value < 800;
    `);
    results.query_select_ms = performance.now() - t3;

    // 6. JOIN
    const t4 = performance.now();
    await runMysqlTestChecked(arch, instance,`
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
