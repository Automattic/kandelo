#!/usr/bin/env npx tsx
/**
 * Direct PHP -> MariaDB transport benchmark.
 *
 * Starts MariaDB inside the wasm kernel with both TCP loopback and an AF_UNIX
 * socket enabled, then runs PHP CLI mysqli timings against both transports.
 */
import { createServer } from "node:net";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { tryResolveBinary } from "../host/src/binary-resolver";
import { ensureSourceExtract } from "../images/vfs/scripts/source-extract-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const phpBenchmarkSource = String.raw`<?php
declare(strict_types=1);

mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);

function bench_now_ms(): float {
    return hrtime(true) / 1000000;
}

function bench_stats(array $values): array {
    $n = count($values);
    if ($n === 0) {
        return array('n' => 0);
    }
    sort($values, SORT_NUMERIC);
    $sum = array_sum($values);
    return array(
        'n' => $n,
        'min_ms' => $values[0],
        'avg_ms' => $sum / $n,
        'p50_ms' => $values[(int) floor(($n - 1) * 0.50)],
        'p95_ms' => $values[(int) floor(($n - 1) * 0.95)],
        'max_ms' => $values[$n - 1],
    );
}

function bench_connect(array $cfg): mysqli {
    $db = mysqli_init();
    $db->options(MYSQLI_OPT_CONNECT_TIMEOUT, 5);
    $db->real_connect(
        $cfg['host'],
        'root',
        '',
        '',
        $cfg['port'],
        $cfg['socket']
    );
    return $db;
}

function bench_variant(array $cfg, int $connectIters, int $queryIters): array {
    $connectTimes = array();
    $connectQueryTimes = array();
    $reuseQueryTimes = array();

    for ($i = 0; $i < $connectIters; $i++) {
        $t = bench_now_ms();
        $db = bench_connect($cfg);
        $connectTimes[] = bench_now_ms() - $t;

        $t = bench_now_ms();
        $db->query('SELECT 1')->free();
        $connectQueryTimes[] = bench_now_ms() - $t;
        $db->close();
    }

    $db = bench_connect($cfg);
    $db->query('SELECT 1')->free();
    for ($i = 0; $i < $queryIters; $i++) {
        $t = bench_now_ms();
        $db->query('SELECT 1')->free();
        $reuseQueryTimes[] = bench_now_ms() - $t;
    }
    $db->close();

    return array(
        'host' => $cfg['host'],
        'port' => $cfg['port'],
        'socket' => $cfg['socket'],
        'connect' => bench_stats($connectTimes),
        'select_after_connect' => bench_stats($connectQueryTimes),
        'select_reused_connection' => bench_stats($reuseQueryTimes),
    );
}

$connectIters = max(1, min(100, (int) ($argv[1] ?? 8)));
$queryIters = max(1, min(1000, (int) ($argv[2] ?? 30)));
$port = (int) ($argv[3] ?? 3306);
$socket = (string) ($argv[4] ?? ini_get('mysqli.default_socket'));

$variants = array(
    'tcp' => array('host' => '127.0.0.1', 'port' => $port, 'socket' => null),
    'unix' => array('host' => 'localhost', 'port' => null, 'socket' => $socket),
    'tcp_persistent' => array('host' => 'p:127.0.0.1', 'port' => $port, 'socket' => null),
    'unix_persistent' => array('host' => 'p:localhost', 'port' => null, 'socket' => $socket),
);

$started = bench_now_ms();
$results = array();
foreach ($variants as $name => $cfg) {
    try {
        $results[$name] = bench_variant($cfg, $connectIters, $queryIters);
    } catch (Throwable $e) {
        $results[$name] = array(
            'host' => $cfg['host'],
            'port' => $cfg['port'],
            'socket' => $cfg['socket'],
            'error' => $e->getMessage(),
        );
    }
}

echo json_encode(array(
    'connect_iters' => $connectIters,
    'query_iters' => $queryIters,
    'default_socket' => ini_get('mysqli.default_socket'),
    'socket' => $socket,
    'elapsed_ms' => bench_now_ms() - $started,
    'variants' => $results,
), JSON_PRETTY_PRINT), "\n";
`;

interface Args {
  label: string;
  rounds: number;
  connectIters: number;
  queryIters: number;
  engine: "Aria" | "InnoDB";
}

interface MariaDBInstance {
  host: NodeKernelHost;
  port: number;
  socketPath: string;
  dataDir: string;
  getOutput: () => string;
  getProcessOutput: (pid: number) => { stdout: string; stderr: string };
  cleanup: () => Promise<void>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    label: "run",
    rounds: 5,
    connectIters: 8,
    queryIters: 30,
    engine: "Aria",
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const readValue = (prefix: string): string => {
      if (arg.startsWith(`${prefix}=`)) return arg.slice(prefix.length + 1);
      return argv[++i];
    };
    if (arg === "--label" || arg.startsWith("--label=")) {
      args.label = readValue("--label");
    } else if (arg === "--rounds" || arg.startsWith("--rounds=")) {
      args.rounds = positiveInt(readValue("--rounds"), "--rounds");
    } else if (arg === "--connect-iters" || arg.startsWith("--connect-iters=")) {
      args.connectIters = positiveInt(readValue("--connect-iters"), "--connect-iters");
    } else if (arg === "--query-iters" || arg.startsWith("--query-iters=")) {
      args.queryIters = positiveInt(readValue("--query-iters"), "--query-iters");
    } else if (arg === "--engine" || arg.startsWith("--engine=")) {
      const engine = readValue("--engine");
      if (engine !== "Aria" && engine !== "InnoDB") {
        throw new Error("--engine must be Aria or InnoDB");
      }
      args.engine = engine;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: npx tsx benchmarks/php-mariadb-transport.ts [options]

Options:
  --label <name>          Result label (default: run)
  --rounds <n>            PHP benchmark rounds (default: 5)
  --connect-iters <n>     Connections per variant per round (default: 8)
  --query-iters <n>       Reused-connection SELECTs per round (default: 30)
  --engine Aria|InnoDB    MariaDB storage engine (default: Aria)
`);
      process.exit(0);
    }
  }

  return args;
}

function positiveInt(value: string, name: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function resolveProgram(file: "mariadbd.wasm" | "php.wasm"): string {
  const rel = file === "php.wasm"
    ? "programs/php/php.wasm"
    : "programs/mariadb/mariadbd.wasm";
  const resolved = tryResolveBinary(rel);
  if (resolved) return resolved;

  const fallback = file === "php.wasm"
    ? resolve(repoRoot, "packages/registry/php/php-src/sapi/cli/php")
    : resolve(repoRoot, "packages/registry/mariadb/mariadb-install/bin/mariadbd.wasm");
  if (existsSync(fallback)) return fallback;

  throw new Error(`${file} not found; fetch or build the PHP and MariaDB packages first`);
}

function resolveMariaDBBootstrapSql(): { systemTables: string; systemData: string } {
  const installDir = resolve(repoRoot, "packages/registry/mariadb/mariadb-install");
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

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
    server.on("error", reject);
  });
}

async function startMariaDB(
  dataDir: string,
  socketPath: string,
  bootstrap: boolean,
  engine: Args["engine"],
): Promise<MariaDBInstance> {
  const port = await getFreePort();
  const mariadbdBytes = loadBytes(resolveProgram("mariadbd.wasm"));
  let output = "";
  const processOutput = new Map<number, { stdout: string; stderr: string }>();
  const appendOutput = (pid: number, kind: "stdout" | "stderr", data: Uint8Array) => {
    const text = new TextDecoder().decode(data);
    output += text;
    if (output.length > 32_768) output = output.slice(-32_768);
    const entry = processOutput.get(pid) ?? { stdout: "", stderr: "" };
    entry[kind] += text;
    processOutput.set(pid, entry);
  };
  const host = new NodeKernelHost({
    maxWorkers: 8,
    enableTcpNetwork: true,
    dataBufferSize: engine === "InnoDB" ? 2 * 1024 * 1024 : undefined,
    onStdout: (pid, data) => appendOutput(pid, "stdout", data),
    onStderr: (pid, data) => appendOutput(pid, "stderr", data),
  });
  await host.init();

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
  const commonArgs = [
    "mariadbd",
    "--no-defaults",
    "--user=root",
    `--datadir=${dataDir}`,
    `--tmpdir=${resolve(dataDir, "tmp")}`,
    "--skip-grant-tables",
    "--key-buffer-size=1048576",
    "--table-open-cache=10",
    "--sort-buffer-size=262144",
    ...engineArgs,
  ];

  let stdin: Uint8Array | undefined;
  const args = bootstrap
    ? [...commonArgs, "--bootstrap", "--skip-networking", "--log-warnings=0"]
    : [
      ...commonArgs,
      "--skip-networking=0",
      `--port=${port}`,
      "--bind-address=127.0.0.1",
      `--socket=${socketPath}`,
      "--max-connections=32",
    ];
  if (bootstrap) {
    const sqlPaths = resolveMariaDBBootstrapSql();
    stdin = new TextEncoder().encode(
      `use mysql;\n${readFileSync(sqlPaths.systemTables, "utf8")}\n${readFileSync(sqlPaths.systemData, "utf8")}\n`,
    );
  }

  const exitPromise = host.spawn(mariadbdBytes, args, {
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
    cwd: dataDir,
    stdin,
  });

  if (bootstrap) {
    await Promise.race([exitPromise, timeout(120_000, "mariadbd bootstrap timed out")]);
  }

  return {
    host,
    port,
    socketPath,
    dataDir,
    getOutput: () => output,
    getProcessOutput: (pid) => processOutput.get(pid) ?? { stdout: "", stderr: "" },
    cleanup: async () => {
      await host.destroy().catch(() => {});
    },
  };
}

async function waitForReady(instance: MariaDBInstance): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (instance.getOutput().includes("ready for connections")) return;
    await sleep(250);
  }
  throw new Error(`MariaDB did not become ready:\n${instance.getOutput()}`);
}

async function runPhpRound(
  instance: MariaDBInstance,
  scriptPath: string,
  connectIters: number,
  queryIters: number,
): Promise<any> {
  const phpBytes = loadBytes(resolveProgram("php.wasm"));
  let pid = 0;
  const outputStart = instance.getOutput().length;
  const host = instance.host;
  const exitPromise = host.spawn(
    phpBytes,
    [
      "php",
      "-d", `mysqli.default_socket=${instance.socketPath}`,
      "-d", "mysqli.allow_persistent=1",
      "-d", "mysqli.max_persistent=-1",
      scriptPath,
      String(connectIters),
      String(queryIters),
      String(instance.port),
      instance.socketPath,
    ],
    {
      env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp"],
      cwd: instance.dataDir,
      onStarted: (startedPid) => { pid = startedPid; },
    },
  );

  const exitCode = await Promise.race([
    exitPromise,
    timeout(120_000, "PHP mysqli benchmark timed out"),
  ]);
  const processOutput = instance.getProcessOutput(pid);
  let stdout = processOutput.stdout;
  let stderr = processOutput.stderr;
  if (!stdout.trim()) {
    stdout = extractJsonObject(instance.getOutput().slice(outputStart)) ?? "";
  }
  if (exitCode !== 0) {
    throw new Error(`php exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`failed to parse PHP JSON: ${err}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  return text.slice(start, end + 1);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function summarize(rounds: any[]): Record<string, any> {
  const summary: Record<string, any> = {};
  const variants = Object.keys(rounds[0]?.variants ?? {});
  for (const variant of variants) {
    const first = rounds[0].variants[variant];
    if (first?.error) {
      summary[variant] = { error: first.error };
      continue;
    }
    summary[variant] = {};
    for (const metric of ["connect", "select_after_connect", "select_reused_connection"]) {
      summary[variant][metric] = {};
      for (const stat of ["avg_ms", "p50_ms", "p95_ms"]) {
        summary[variant][metric][`${stat}_median`] = median(
          rounds.map((round) => round.variants[variant][metric][stat]),
        );
      }
    }
  }
  return summary;
}

function improvementPercent(beforeMs: number, afterMs: number): number {
  return ((beforeMs - afterMs) / beforeMs) * 100;
}

function runGit(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const started = Date.now();
  const resultRoot = resolve(repoRoot, "benchmarks/results");
  const dataDir = resolve(resultRoot, `.php-mariadb-data-${process.pid}-${started}`);
  const socketPath = `/tmp/php-mariadb-${process.pid}-${started}.sock`;
  const scriptPath = resolve(dataDir, "php-mariadb-bench.php");
  mkdirSync(resolve(dataDir, "mysql"), { recursive: true });
  mkdirSync(resolve(dataDir, "tmp"), { recursive: true });
  writeFileSync(scriptPath, phpBenchmarkSource);

  let instance: MariaDBInstance | null = null;
  try {
    console.log("bootstrapping MariaDB...");
    const bootstrap = await startMariaDB(dataDir, socketPath, true, args.engine);
    await bootstrap.cleanup();

    console.log(`starting MariaDB on tcp:${args.engine} port + unix socket ${socketPath}...`);
    instance = await startMariaDB(dataDir, socketPath, false, args.engine);
    await waitForReady(instance);

    const rounds = [];
    for (let i = 0; i < args.rounds; i++) {
      console.log(`round ${i + 1}/${args.rounds}...`);
      rounds.push(await runPhpRound(instance, scriptPath, args.connectIters, args.queryIters));
    }
    const summary = summarize(rounds);
    const unix = summary.unix?.connect?.avg_ms_median;
    const tcp = summary.tcp?.connect?.avg_ms_median;
    const unixPersistent = summary.unix_persistent?.connect?.avg_ms_median;
    const tcpPersistent = summary.tcp_persistent?.connect?.avg_ms_median;

    const output = {
      label: args.label,
      timestamp: new Date().toISOString(),
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      gitHead: runGit(["rev-parse", "HEAD"]),
      benchmark: {
        rounds: args.rounds,
        connectIters: args.connectIters,
        queryIters: args.queryIters,
        engine: args.engine,
        socketPath,
        port: instance.port,
      },
      summary,
      comparisons: {
        unix_vs_tcp_connect_avg_pct:
          typeof tcp === "number" && typeof unix === "number"
            ? improvementPercent(tcp, unix)
            : null,
        unix_persistent_vs_tcp_persistent_connect_avg_pct:
          typeof tcpPersistent === "number" && typeof unixPersistent === "number"
            ? improvementPercent(tcpPersistent, unixPersistent)
            : null,
      },
      rounds,
    };

    mkdirSync(resultRoot, { recursive: true });
    const outPath = resolve(resultRoot, `php-mariadb-transport-${args.label}-${Date.now()}.json`);
    writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`results saved to ${outPath}`);
    console.log(JSON.stringify({
      summary,
      comparisons: output.comparisons,
    }, null, 2));
  } finally {
    if (instance) await instance.cleanup();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(socketPath, { force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
