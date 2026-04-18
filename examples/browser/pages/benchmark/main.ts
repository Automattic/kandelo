/**
 * Browser benchmark page.
 *
 * Exposes window.__runBenchmark(suiteName, options?) which the Playwright
 * harness calls to execute benchmarks inside the browser.
 *
 * Supported suites:
 *   - "syscall-io": pipe/file throughput and syscall latency
 *   - "process-lifecycle": hello start, fork, clone
 *   - "erlang-ring": BEAM VM ring benchmark (1000 processes, 100 rounds)
 *   - "wordpress": nginx + PHP-FPM boot with WordPress page load
 *   - "mariadb": MariaDB bootstrap, server start, and SQL queries
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { loadErlangBundle } from "../../lib/erlang-bundle";
import { loadWordPressBundle } from "../../lib/wp-bundle";
import { populateNginxConfig } from "../../lib/init/nginx-config";
import { populatePhpFpmConfig } from "../../lib/init/php-fpm-config";
import { populateMariadbDirs } from "../../lib/init/mariadb-config";
import {
  writeVfsBinary,
  writeVfsFile,
  writeInitDescriptor,
  ensureDir,
  ensureDirRecursive,
} from "../../lib/init/vfs-utils";
import { MySqlBrowserClient } from "../../lib/mysql-client";

// Import benchmark wasm URLs via Vite
import pipeWasmUrl from "../../../../benchmarks/wasm/pipe-throughput.wasm?url";
import fileWasmUrl from "../../../../benchmarks/wasm/file-throughput.wasm?url";
import syscallWasmUrl from "../../../../benchmarks/wasm/syscall-latency.wasm?url";
import forkWasmUrl from "../../../../benchmarks/wasm/fork-bench.wasm?url";
import cloneWasmUrl from "../../../../benchmarks/wasm/clone-bench.wasm?url";
import helloWasmUrl from "../../../../benchmarks/wasm/hello.wasm?url";

// Erlang
import beamWasmUrl from "../../../../examples/libs/erlang/bin/beam.wasm?url";

// WordPress / nginx / PHP-FPM
import nginxWasmUrl from "../../../../examples/nginx/nginx.wasm?url";
import phpFpmWasmUrl from "../../../../examples/nginx/php-fpm.wasm?url";

// MariaDB
import mariadbWasmUrl from "../../../../examples/libs/mariadb/mariadb-install/bin/mariadbd.wasm?url";
import systemTablesUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables.sql?url";
import systemDataUrl from "../../../../examples/libs/mariadb/mariadb-install/share/mysql/mysql_system_tables_data.sql?url";

const logEl = document.getElementById("log")!;
function log(msg: string) {
  logEl.textContent += msg + "\n";
}

async function fetchWasm(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.arrayBuffer();
}

function parseMetrics(stdout: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\w+)=([\d.eE+-]+)$/);
    if (match) metrics[match[1]] = parseFloat(match[2]);
  }
  return metrics;
}

async function runProgram(
  programBytes: ArrayBuffer,
  argv: string[],
): Promise<{ exitCode: number; stdout: string }> {
  let stdout = "";
  const kernel = new BrowserKernel({
    maxWorkers: 4,
    fsSize: 4 * 1024 * 1024,
    onStdout: (data) => { stdout += new TextDecoder().decode(data); },
    onStderr: () => {},
  });
  await kernel.init();

  // Create /tmp for file benchmarks (may already exist after init)
  try { kernel.fs.mkdir("/tmp", 0o777); } catch {};

  const exitCode = await kernel.spawn(programBytes, argv);
  return { exitCode, stdout };
}

// ─── syscall-io ─────────────────────────────────────────────────────────────

async function runSyscallIo(): Promise<Record<string, number>> {
  const results: Record<string, number> = {};

  log("  Running pipe-throughput...");
  const pipeBytes = await fetchWasm(pipeWasmUrl);
  const pipe = await runProgram(pipeBytes, ["pipe-throughput"]);
  if (pipe.exitCode !== 0) throw new Error("pipe-throughput failed");
  Object.assign(results, parseMetrics(pipe.stdout));

  log("  Running file-throughput...");
  const fileBytes = await fetchWasm(fileWasmUrl);
  const file = await runProgram(fileBytes, ["file-throughput"]);
  if (file.exitCode !== 0) throw new Error("file-throughput failed");
  Object.assign(results, parseMetrics(file.stdout));

  log("  Running syscall-latency...");
  const syscallBytes = await fetchWasm(syscallWasmUrl);
  const syscall = await runProgram(syscallBytes, ["syscall-latency"]);
  if (syscall.exitCode !== 0) throw new Error("syscall-latency failed");
  Object.assign(results, parseMetrics(syscall.stdout));

  return results;
}

// ─── process-lifecycle ──────────────────────────────────────────────────────

async function runProcessLifecycle(): Promise<Record<string, number>> {
  const results: Record<string, number> = {};

  log("  Running hello (cold start)...");
  const helloBytes = await fetchWasm(helloWasmUrl);
  const t0 = performance.now();
  const hello = await runProgram(helloBytes, ["hello"]);
  results.hello_start_ms = performance.now() - t0;
  if (hello.exitCode !== 0) throw new Error("hello failed");

  log("  Running fork-bench...");
  const forkBytes = await fetchWasm(forkWasmUrl);
  const fork = await runProgram(forkBytes, ["fork-bench"]);
  if (fork.exitCode !== 0) throw new Error("fork-bench failed");
  Object.assign(results, parseMetrics(fork.stdout));

  log("  Running clone-bench...");
  const cloneBytes = await fetchWasm(cloneWasmUrl);
  const clone = await runProgram(cloneBytes, ["clone-bench"]);
  if (clone.exitCode !== 0) throw new Error("clone-bench failed");
  Object.assign(results, parseMetrics(clone.stdout));

  return results;
}

// ─── erlang-ring ────────────────────────────────────────────────────────────

const OTP_ROOT = "/usr/local/lib/erlang";
const OTP_DIRS = [
  "/usr", "/usr/local", "/usr/local/lib", "/usr/local/lib/erlang",
  "/usr/local/lib/erlang/lib", "/usr/local/lib/erlang/releases",
  "/usr/local/lib/erlang/releases/28",
  "/usr/local/lib/erlang/erts-16.1.2",
  "/usr/local/lib/erlang/erts-16.1.2/bin",
  "/tmp", "/home",
];

const BEAM_ENV = [
  "HOME=/tmp", "TMPDIR=/tmp", "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  `ROOTDIR=${OTP_ROOT}`,
  `BINDIR=${OTP_ROOT}/erts-16.1.2/bin`,
  "EMU=beam", "PROGNAME=erl",
];

const RING_CODE = `Ring = fun Ring(0, _N) -> ok;
           Ring(Rounds, N) ->
    Pids = lists:foldl(
        fun(_, [Prev|_] = Acc) ->
            Pid = spawn(fun Loop() ->
                receive {token, From, Val} ->
                    Prev ! {token, self(), Val + 1},
                    Loop()
                end
            end),
            [Pid | Acc]
        end,
        [self()],
        lists:seq(1, N - 1)
    ),
    Last = hd(Pids),
    Last ! {token, self(), 0},
    receive {token, _, Val} -> ok end,
    Ring(Rounds - 1, N)
end,
T1 = erlang:monotonic_time(microsecond),
Ring(100, 1000),
T2 = erlang:monotonic_time(microsecond),
Elapsed = T2 - T1,
TotalMessages = 100 * 1000,
io:format("elapsed_us=~p~n", [Elapsed]),
io:format("total_messages=~p~n", [TotalMessages]),
halt(0, [{flush, false}]).`;

async function runErlangRing(): Promise<Record<string, number>> {
  log("  Loading BEAM + OTP runtime...");
  const beamBytes = await fetchWasm(beamWasmUrl);

  let stdout = "";
  let lastOutputTime = 0;
  let outputSeen = false;

  const kernel = new BrowserKernel({
    maxWorkers: 4,
    fsSize: 16 * 1024 * 1024,
    onStdout: (data) => {
      stdout += new TextDecoder().decode(data);
      lastOutputTime = Date.now();
      outputSeen = true;
    },
    onStderr: () => {},
  });
  await kernel.init();

  // Create OTP directory tree
  for (const d of OTP_DIRS) {
    try { kernel.fs.mkdir(d, 0o755); } catch { /* exists */ }
  }

  // Load OTP runtime bundle
  log("  Loading OTP bundle...");
  await loadErlangBundle(
    kernel.fs,
    import.meta.env.BASE_URL + "erlang-bundle.json",
  );

  // Spawn BEAM with ring benchmark
  log("  Running ring benchmark (100 rounds x 1000 processes)...");
  const args = [
    "beam.smp", "-S", "1:1", "-A", "0", "-SDio", "1", "-SDcpu", "1:1",
    "-P", "262144", "--",
    "-root", OTP_ROOT,
    "-bindir", `${OTP_ROOT}/erts-16.1.2/bin`,
    "-progname", "erl", "-home", "/tmp",
    "-start_epmd", "false",
    "-boot", `${OTP_ROOT}/releases/28/start_clean`,
    "-noshell", "-pa", ".",
    `${OTP_ROOT}/lib/kernel-10.4.2/ebin`,
    `${OTP_ROOT}/lib/stdlib-7.1/ebin`,
    "-eval", RING_CODE,
  ];

  const exitPromise = kernel.spawn(beamBytes, args, { env: BEAM_ENV });

  // Halt detection: BEAM's halt() hangs on pthread_join, so detect
  // completion via output timing heuristic (3s idle = done)
  const exitCode = await new Promise<number>((resolve) => {
    const interval = setInterval(() => {
      if (outputSeen && Date.now() - lastOutputTime > 3000) {
        clearInterval(interval);
        resolve(0);
      }
    }, 500);
    exitPromise.then((code) => {
      clearInterval(interval);
      resolve(code);
    });
  });

  try { await kernel.destroy(); } catch { /* already destroyed */ }

  // Parse metrics from stdout
  const metrics = parseMetrics(stdout);
  const results: Record<string, number> = {};

  if (metrics.elapsed_us != null && metrics.total_messages != null) {
    results.total_ms = metrics.elapsed_us / 1000;
    results.messages_per_sec = Math.round(
      (metrics.total_messages / metrics.elapsed_us) * 1_000_000,
    );
  }

  return results;
}

// ─── wordpress ──────────────────────────────────────────────────────────────

const FASTCGI_LOCATION = `        location / {
            fastcgi_pass 127.0.0.1:9000;
            fastcgi_param SCRIPT_FILENAME /var/www/fpm-router.php;
            fastcgi_param DOCUMENT_ROOT $document_root;
            fastcgi_param DOCUMENT_URI $document_uri;
            fastcgi_param QUERY_STRING $query_string;
            fastcgi_param REQUEST_METHOD $request_method;
            fastcgi_param CONTENT_TYPE $content_type;
            fastcgi_param CONTENT_LENGTH $content_length;
            fastcgi_param REQUEST_URI $request_uri;
            fastcgi_param SERVER_PROTOCOL $server_protocol;
            fastcgi_param SERVER_PORT $server_port;
            fastcgi_param SERVER_NAME $server_name;
            fastcgi_param HTTP_HOST $http_host;
            fastcgi_param REDIRECT_STATUS 200;
        }`;

const WP_CONFIG_PHP = `<?php
define('DB_NAME', 'wordpress');
define('DB_USER', '');
define('DB_PASSWORD', '');
define('DB_HOST', '');
define('DB_CHARSET', 'utf8');
define('DB_COLLATE', '');
define('DB_DIR', __DIR__ . '/wp-content/database/');
define('DB_FILE', 'wordpress.db');
define('AUTH_KEY', 'bench'); define('SECURE_AUTH_KEY', 'bench');
define('LOGGED_IN_KEY', 'bench'); define('NONCE_KEY', 'bench');
define('AUTH_SALT', 'bench'); define('SECURE_AUTH_SALT', 'bench');
define('LOGGED_IN_SALT', 'bench'); define('NONCE_SALT', 'bench');
$table_prefix = 'wp_';
define('WP_DEBUG', false);
define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);
if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
require_once ABSPATH . 'wp-settings.php';
`;

const MU_PLUGIN_PHP = `<?php
add_filter('pre_wp_mail', '__return_false');
add_filter('pre_http_request', function($pre, $args, $url) {
    return new WP_Error('http_disabled', 'HTTP requests disabled in Wasm');
}, 10, 3);
if (!defined('DISALLOW_FILE_MODS')) define('DISALLOW_FILE_MODS', true);
`;

async function fetchSize(url: string): Promise<number> {
  try {
    const resp = await fetch(url, { method: "HEAD" });
    if (!resp.ok) return 0;
    return parseInt(resp.headers.get("content-length") || "0", 10) || 0;
  } catch {
    return 0;
  }
}

async function runWordPress(): Promise<Record<string, number>> {
  const results: Record<string, number> = {};

  log("  Fetching binaries...");
  const [nginxSize, phpFpmSize] = await Promise.all([
    fetchSize(nginxWasmUrl),
    fetchSize(phpFpmWasmUrl),
  ]);
  if (nginxSize === 0 || phpFpmSize === 0) {
    throw new Error("nginx.wasm or php-fpm.wasm not found");
  }

  const kernel = new BrowserKernel({
    maxWorkers: 8,
    fsSize: 256 * 1024 * 1024,
    maxMemoryPages: 4096,
    onStdout: () => {},
    onStderr: () => {},
  });

  const tBoot = performance.now();
  await kernel.init();

  // Register nginx + PHP-FPM as lazy files
  ensureDir(kernel.fs, "/usr");
  ensureDir(kernel.fs, "/usr/sbin");
  ensureDir(kernel.fs, "/bin");
  ensureDir(kernel.fs, "/etc");
  ensureDir(kernel.fs, "/tmp");
  kernel.registerLazyFiles([
    { path: "/usr/sbin/nginx", url: nginxWasmUrl, size: nginxSize, mode: 0o755 },
    { path: "/usr/sbin/php-fpm", url: phpFpmWasmUrl, size: phpFpmSize, mode: 0o755 },
  ]);

  // nginx and PHP-FPM configs
  populateNginxConfig(kernel.fs, { extraLocations: FASTCGI_LOCATION });
  populatePhpFpmConfig(kernel.fs);

  // WordPress directories
  ensureDirRecursive(kernel.fs, "/var/www/html/wp-content/database");
  ensureDirRecursive(kernel.fs, "/var/www/html/wp-content/mu-plugins");

  // Spawn PHP-FPM
  log("  Starting PHP-FPM...");
  const phpFpmBytes = await kernel.fs.ensureMaterialized("/usr/sbin/php-fpm").then(() => {
    const fd = kernel.fs.open("/usr/sbin/php-fpm", 0, 0);
    const stat = kernel.fs.fstat(fd);
    const buf = new Uint8Array(stat.size);
    kernel.fs.read(fd, buf, 0, buf.length);
    kernel.fs.close(fd);
    return buf.buffer;
  });
  kernel.spawn(phpFpmBytes, [
    "/usr/sbin/php-fpm", "-y", "/etc/php-fpm.conf", "-c", "/dev/null", "--nodaemonize",
  ]);
  // Wait for PHP-FPM to be ready (5s delay like the demo)
  await new Promise((r) => setTimeout(r, 5000));

  // Spawn nginx
  log("  Starting nginx...");
  const nginxBytes = await kernel.fs.ensureMaterialized("/usr/sbin/nginx").then(() => {
    const fd = kernel.fs.open("/usr/sbin/nginx", 0, 0);
    const stat = kernel.fs.fstat(fd);
    const buf = new Uint8Array(stat.size);
    kernel.fs.read(fd, buf, 0, buf.length);
    kernel.fs.close(fd);
    return buf.buffer;
  });
  kernel.spawn(nginxBytes, [
    "/usr/sbin/nginx", "-p", "/etc/nginx", "-c", "nginx.conf",
  ]);
  // Wait for nginx to be ready (3s delay like the demo)
  await new Promise((r) => setTimeout(r, 3000));

  // Load WordPress bundle
  log("  Loading WordPress bundle...");
  await loadWordPressBundle(kernel.fs, import.meta.env.BASE_URL + "wp-bundle.json");

  // Write WordPress config
  writeVfsFile(kernel.fs, "/var/www/html/wp-config.php", WP_CONFIG_PHP);
  writeVfsFile(kernel.fs, "/var/www/html/wp-content/mu-plugins/wasm-optimizations.php", MU_PLUGIN_PHP);

  results.boot_ms = performance.now() - tBoot;
  log(`  Boot complete: ${results.boot_ms.toFixed(0)}ms`);

  // Measure HTTP first response via injected TCP connection to nginx
  log("  Sending HTTP request to nginx...");
  const tHttp = performance.now();
  const target = await kernel.pickListenerTarget(8080);
  if (target) {
    const recvPipeIdx = await kernel.injectConnection(
      target.pid, target.fd, [127, 0, 0, 1],
      Math.floor(Math.random() * 60000) + 1024,
    );
    if (recvPipeIdx >= 0) {
      const sendPipeIdx = recvPipeIdx + 1;
      const httpReq = new TextEncoder().encode(
        "GET / HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      await kernel.pipeWrite(target.pid, recvPipeIdx, httpReq);
      kernel.wakeBlockedReaders(recvPipeIdx);

      // Wait for first bytes of HTTP response (time to first byte)
      const deadline = Date.now() + 180_000;
      let gotResponse = false;
      while (Date.now() < deadline) {
        const data = await kernel.pipeRead(target.pid, sendPipeIdx);
        if (data && data.length > 0) {
          gotResponse = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (gotResponse) {
        results.http_first_response_ms = performance.now() - tHttp;
      }
      kernel.pipeCloseWrite(target.pid, recvPipeIdx);
      kernel.pipeCloseRead(target.pid, sendPipeIdx);
    }
  }

  try { await kernel.destroy(); } catch {}
  return results;
}

// ─── mariadb ────────────────────────────────────────────────────────────────

async function runMariaDb(): Promise<Record<string, number>> {
  const results: Record<string, number> = {};

  log("  Fetching MariaDB + bootstrap SQL...");
  const [mariadbBytes, systemTablesSql, systemDataSql] = await Promise.all([
    fetchWasm(mariadbWasmUrl),
    fetch(systemTablesUrl).then((r) => r.text()),
    fetch(systemDataUrl).then((r) => r.text()),
  ]);

  // ── Bootstrap ──
  log("  Running bootstrap...");
  const tBootstrap = performance.now();

  const bootstrapKernel = new BrowserKernel({
    maxWorkers: 12,
    fsSize: 64 * 1024 * 1024,
    onStdout: () => {},
    onStderr: () => {},
  });
  await bootstrapKernel.init();

  populateMariadbDirs(bootstrapKernel.fs);
  ensureDir(bootstrapKernel.fs, "/usr");
  ensureDir(bootstrapKernel.fs, "/usr/sbin");
  ensureDir(bootstrapKernel.fs, "/tmp");
  writeVfsBinary(bootstrapKernel.fs, "/usr/sbin/mariadbd", new Uint8Array(mariadbBytes));

  const bootstrapSql = `use mysql;\n${systemTablesSql}\n${systemDataSql}\nCREATE DATABASE IF NOT EXISTS bench;\n`;
  ensureDir(bootstrapKernel.fs, "/etc");
  ensureDir(bootstrapKernel.fs, "/etc/mariadb");
  writeVfsFile(bootstrapKernel.fs, "/etc/mariadb/bootstrap.sql", bootstrapSql);

  const bootstrapStdin = new TextEncoder().encode(bootstrapSql);
  const bootstrapExit = bootstrapKernel.spawn(mariadbBytes, [
    "mariadbd", "--no-defaults", "--bootstrap",
    "--datadir=/data", "--tmpdir=/data/tmp",
    "--default-storage-engine=Aria", "--skip-grant-tables",
    "--key-buffer-size=1048576", "--table-open-cache=10",
    "--sort-buffer-size=262144", "--skip-networking", "--log-warnings=0",
  ], { stdin: bootstrapStdin });

  // Wait for bootstrap stdin to be consumed
  const bootstrapPid = (bootstrapKernel as any).nextPid - 1;
  for (let i = 0; i < 1200; i++) {
    try {
      const consumed = await bootstrapKernel.isStdinConsumed(bootstrapPid);
      if (consumed) {
        await new Promise((r) => setTimeout(r, 2000));
        break;
      }
    } catch { break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  try { await bootstrapKernel.terminateProcess(bootstrapPid); } catch {}

  results.bootstrap_ms = performance.now() - tBootstrap;
  log(`  Bootstrap: ${results.bootstrap_ms.toFixed(0)}ms`);

  // ── Server ──
  // We need to reuse the same VFS (with bootstrapped data) for the server.
  // BrowserKernel shares VFS via SharedArrayBuffer, so we create a new
  // kernel with the same underlying FS.
  // Actually, BrowserKernel creates a new FS each time. We need to keep
  // the same kernel instance and spawn a new process.
  // Let's just spawn the server on the bootstrap kernel's VFS.
  log("  Starting server...");
  const serverExit = bootstrapKernel.spawn(mariadbBytes, [
    "mariadbd", "--no-defaults",
    "--datadir=/data", "--tmpdir=/data/tmp",
    "--default-storage-engine=Aria", "--skip-grant-tables",
    "--key-buffer-size=1048576", "--table-open-cache=10",
    "--sort-buffer-size=262144", "--skip-networking=0",
    "--port=3306", "--bind-address=0.0.0.0", "--socket=",
    "--max-connections=10", "--thread-handling=no-threads",
  ]);

  // Wait for port 3306
  log("  Waiting for server to accept connections...");
  for (let i = 0; i < 120; i++) {
    const target = await bootstrapKernel.pickListenerTarget(3306);
    if (target) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // Connect MySQL client with retries
  let client: MySqlBrowserClient | null = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      client = await MySqlBrowserClient.connect(bootstrapKernel, 3306);
      break;
    } catch {
      if (attempt === 10) throw new Error("MySQL handshake failed after 10 attempts");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (!client) throw new Error("Failed to connect MySQL client");

  // ── Queries ──
  log("  Running CREATE TABLE...");
  const t1 = performance.now();
  await client.query("CREATE TABLE bench.t1 (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(100), value INT)");
  await client.query("CREATE TABLE bench.t2 (id INT PRIMARY KEY AUTO_INCREMENT, t1_id INT, data VARCHAR(200))");
  results.query_create_ms = performance.now() - t1;

  log("  Running INSERT (100 rows)...");
  const t2 = performance.now();
  for (let i = 0; i < 100; i++) {
    await client.query(`INSERT INTO bench.t1 (name, value) VALUES ('item_${i}', ${i * 10})`);
  }
  for (let i = 0; i < 100; i++) {
    await client.query(`INSERT INTO bench.t2 (t1_id, data) VALUES (${i + 1}, 'data_for_item_${i}')`);
  }
  results.query_insert_ms = performance.now() - t2;

  log("  Running SELECT...");
  const t3 = performance.now();
  await client.query("SELECT * FROM bench.t1 WHERE value > 500 AND value < 800");
  results.query_select_ms = performance.now() - t3;

  log("  Running JOIN...");
  const t4 = performance.now();
  await client.query("SELECT t1.name, t2.data FROM bench.t1 t1 JOIN bench.t2 t2 ON t1.id = t2.t1_id WHERE t1.value > 500");
  results.query_join_ms = performance.now() - t4;

  client.close();
  try { await bootstrapKernel.destroy(); } catch {}

  return results;
}

// ─── Suite registry ─────────────────────────────────────────────────────────

const SUITES: Record<string, () => Promise<Record<string, number>>> = {
  "syscall-io": runSyscallIo,
  "process-lifecycle": runProcessLifecycle,
  "erlang-ring": runErlangRing,
  "wordpress": runWordPress,
  "mariadb": runMariaDb,
};

declare global {
  interface Window {
    __runBenchmark: (
      suiteName: string,
      options?: { rounds?: number },
    ) => Promise<Record<string, number>>;
    __listSuites: () => string[];
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

window.__runBenchmark = async (suiteName, options) => {
  const suiteFn = SUITES[suiteName];
  if (!suiteFn) throw new Error(`Unknown suite: ${suiteName}. Available: ${Object.keys(SUITES).join(", ")}`);

  const rounds = options?.rounds ?? 1;
  log(`Running ${suiteName} (${rounds} round(s))...`);

  const roundResults: Record<string, number[]> = {};
  for (let r = 0; r < rounds; r++) {
    log(`Round ${r + 1}/${rounds}...`);
    const metrics = await suiteFn();
    for (const [key, value] of Object.entries(metrics)) {
      if (!roundResults[key]) roundResults[key] = [];
      roundResults[key].push(value);
    }
  }

  const result: Record<string, number> = {};
  for (const [key, values] of Object.entries(roundResults)) {
    result[key] = Math.round(median(values) * 100) / 100;
  }

  log(`Done: ${JSON.stringify(result)}`);
  return result;
};

window.__listSuites = () => Object.keys(SUITES);

log("Benchmark page ready.");
