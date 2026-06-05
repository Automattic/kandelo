/**
 * Browser benchmark page.
 *
 * Exposes window.__runBenchmark(suiteName, options?) which the Playwright
 * harness calls to execute benchmarks inside the browser.
 *
 * Supported suites:
 *   - "syscall-io": pipe/file throughput and syscall latency
 *   - "process-lifecycle": hello start, fork, clone
 *   - "wordpress": nginx + PHP-FPM boot with WordPress page load
 *   - "mariadb-aria": MariaDB with Aria engine
 *   - "mariadb-innodb": MariaDB with InnoDB engine
 */
import { BrowserKernel } from "@host/browser-kernel-host";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { writeVfsFile } from "../../lib/init/vfs-utils";
import { MySqlBrowserClient } from "../../lib/mysql-client";

// Micro-benchmark wasm URLs (always built by scripts/build-programs.sh)
import pipeWasmUrl from "../../../../benchmarks/wasm/pipe-throughput.wasm?url";
import fileWasmUrl from "../../../../benchmarks/wasm/file-throughput.wasm?url";
import syscallWasmUrl from "../../../../benchmarks/wasm/syscall-latency.wasm?url";
import forkWasmUrl from "../../../../benchmarks/wasm/fork-bench.wasm?url";
import cloneWasmUrl from "../../../../benchmarks/wasm/clone-bench.wasm?url";
import spawnBenchWasmUrl from "../../../../benchmarks/wasm/spawn-bench.wasm?url";
import helloWasmUrl from "../../../../benchmarks/wasm/hello.wasm?url";

// Kernel
import kernelWasmUrl from "@kernel-wasm?url";

/**
 * Optional application-binary URL imports are resolved via `import.meta.glob`.
 * Static top-level `?url` imports fail the whole page load if any file is
 * missing, which hangs every suite on the Playwright harness — even
 * micro-benchmarks that don't need the missing binary. `import.meta.glob`
 * returns an empty map for missing files, so missing binaries surface as a
 * per-suite failure with a helpful build hint instead of blocking page load.
 */
// Paths are relative to this file (apps/browser-demos/pages/benchmark/main.ts).
// Vite normalizes glob result keys, so callers must use the same relative
// strings declared here.
const OPTIONAL_URLS = {
  ...import.meta.glob("../../../../packages/registry/erlang/bin/beam.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/erlang/beam.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/nginx/nginx.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/nginx.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/nginx.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/php/php-fpm.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/php/php-fpm.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/coreutils/bin/coreutils.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/coreutils.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/coreutils.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/grep/bin/grep.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/grep.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/grep.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/sed/bin/sed.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/sed.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/sed.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install/bin/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/mariadb/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/mariadb/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install/share/mysql/mysql_system_tables.sql", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install/share/mysql/mysql_system_tables_data.sql", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install-64/bin/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm64/mariadb/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm64/mariadb/mariadbd.wasm", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install-64/share/mysql/mysql_system_tables.sql", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../packages/registry/mariadb/mariadb-install-64/share/mysql/mysql_system_tables_data.sql", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/erlang-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/erlang-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../public/erlang.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/wordpress.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/wordpress.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../public/wordpress.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../public/mariadb.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../public/mariadb-64.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm32/mariadb-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm32/mariadb-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../local-binaries/programs/wasm64/mariadb-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
  ...import.meta.glob("../../../../binaries/programs/wasm64/mariadb-vfs.vfs.zst", {
    query: "?url", import: "default",
  }),
} as Record<string, () => Promise<string>>;

async function loadOptionalUrl(
  relPath: string,
  label: string,
  buildHint: string,
): Promise<string> {
  const loader = OPTIONAL_URLS[relPath];
  if (!loader) {
    throw new Error(`${label} is not built. Run: ${buildHint}`);
  }
  return loader();
}

async function loadOptionalUrlFrom(
  relPaths: string[],
  label: string,
  buildHint: string,
): Promise<string> {
  for (const relPath of relPaths) {
    const loader = OPTIONAL_URLS[relPath];
    if (loader) return loadOptionalUrl(relPath, label, buildHint);
  }
  throw new Error(`${label} is not built. Run: ${buildHint}`);
}

const logEl = document.getElementById("log")!;
function log(msg: string) {
  logEl.textContent += msg + "\n";
  // Also forward to console so the Playwright harness can surface progress
  // and prerequisite failures (e.g. "missing binary, run ...").
  console.log(msg);
}

const PROFILE_BENCHMARKS = new URLSearchParams(location.search).has("profile");

async function dumpSysprof(kernel: BrowserKernel): Promise<void> {
  if (!PROFILE_BENCHMARKS) return;
  kernel.sysprofDump();
  await new Promise((r) => setTimeout(r, 250));
}

async function waitForListener(
  kernel: BrowserKernel,
  port: number,
  timeoutMs = 30_000,
  intervalMs = 50,
): Promise<{ pid: number; fd: number }> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const target = await kernel.pickListenerTarget(port);
    if (target) return target;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for listener on port ${port}`);
}

async function fetchWasm(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return resp.arrayBuffer();
}

async function readVfsBytes(fs: MemoryFileSystem, path: string): Promise<ArrayBuffer> {
  await fs.ensureMaterialized(path);
  const fd = fs.open(path, 0, 0);
  try {
    const stat = fs.fstat(fd);
    const buf = new Uint8Array(stat.size);
    fs.read(fd, buf, 0, buf.length);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } finally {
    fs.close(fd);
  }
}

async function readVfsText(fs: MemoryFileSystem, path: string): Promise<string> {
  return new TextDecoder().decode(await readVfsBytes(fs, path));
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
  try {
    await kernel.init();

    // Create /tmp for file benchmarks (may already exist after init)
    try { kernel.fs.mkdir("/tmp", 0o777); } catch {};

    const exitCode = await kernel.spawn(programBytes, argv);
    return { exitCode, stdout };
  } finally {
    try { await kernel.destroy(); } catch {}
  }
}

/**
 * Like runProgram but pre-stages additional VFS entries via
 * `registerLazyFiles` so child programs can resolve them via
 * posix_spawn / execve. Used by `spawn-bench` (needs /bin/hello).
 */
async function runProgramWithExecMap(
  programBytes: ArrayBuffer,
  argv: string[],
  execMap: Array<{ path: string; url: string; size: number }>,
): Promise<{ exitCode: number; stdout: string }> {
  let stdout = "";
  const kernel = new BrowserKernel({
    maxWorkers: 4,
    fsSize: 4 * 1024 * 1024,
    onStdout: (data) => { stdout += new TextDecoder().decode(data); },
    onStderr: () => {},
  });
  try {
    await kernel.init();
    try { kernel.fs.mkdir("/tmp", 0o777); } catch {};

    if (execMap.length > 0) {
      kernel.registerLazyFiles(execMap.map(e => ({
        path: e.path, url: e.url, size: e.size, mode: 0o755,
      })));
    }

    const exitCode = await kernel.spawn(programBytes, argv);
    return { exitCode, stdout };
  } finally {
    try { await kernel.destroy(); } catch {}
  }
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

  log("  Running spawn-bench...");
  // posix_spawn — non-forking SYS_SPAWN fast path. The child is the
  // existing hello.wasm; pre-stage it at /bin/hello via registerLazyFiles
  // so libc-side path resolution finds it. Distinct from exec_ms (no
  // exec exists on the browser bench page anyway) and fork_ms.
  const helloHead = await fetch(helloWasmUrl, { method: "HEAD" });
  const helloSize = parseInt(helloHead.headers.get("content-length") ?? "0", 10) || 1 << 20;
  const spawnBenchBytes = await fetchWasm(spawnBenchWasmUrl);
  const spawn = await runProgramWithExecMap(spawnBenchBytes, ["spawn-bench"], [
    { path: "/bin/hello", url: helloWasmUrl, size: helloSize },
  ]);
  if (spawn.exitCode !== 0) throw new Error(`spawn-bench failed: ${spawn.stdout}`);
  Object.assign(results, parseMetrics(spawn.stdout));

  return results;
}

// ─── erlang-ring ────────────────────────────────────────────────────────────

const OTP_ROOT = "/usr/local/lib/erlang";
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
  let beamWasmUrl: string;
  try {
    beamWasmUrl = await loadOptionalUrl(
      "../../../../packages/registry/erlang/beam.wasm",
      "BEAM binary",
      "bash packages/registry/erlang/build-erlang.sh",
    );
  } catch (err) {
    log(`  Skipping erlang-ring: ${(err as Error).message}`);
    return {};
  }

  log("  Loading BEAM + OTP runtime...");
  let erlangVfsUrl: string;
  try {
    erlangVfsUrl = await loadOptionalUrlFrom([
      "../../public/erlang.vfs.zst",
      "../../../../local-binaries/programs/wasm32/erlang-vfs.vfs.zst",
      "../../../../binaries/programs/wasm32/erlang-vfs.vfs.zst",
    ], "Erlang VFS image", "bash images/vfs/scripts/build-erlang-vfs-image.sh");
  } catch (err) {
    log(`  Skipping erlang-ring: ${(err as Error).message}`);
    return {};
  }

  const vfsResp = await fetch(erlangVfsUrl);
  if (!vfsResp.ok) {
    log(`  Skipping erlang-ring: ${erlangVfsUrl} not found (HTTP ${vfsResp.status}). Build: bash images/vfs/scripts/build-erlang-vfs-image.sh`);
    return {};
  }
  const [kernelBytes, beamBytes, vfsImageBuf] = await Promise.all([
    fetchWasm(kernelWasmUrl),
    fetchWasm(beamWasmUrl),
    vfsResp.arrayBuffer(),
  ]);

  let stdout = "";
  let lastOutputTime = 0;
  let outputSeen = false;

  const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsImageBuf), {
    maxByteLength: 256 * 1024 * 1024,
  });

  const kernel = new BrowserKernel({
    memfs,
    onStdout: (data) => {
      stdout += new TextDecoder().decode(data);
      lastOutputTime = Date.now();
      outputSeen = true;
    },
    onStderr: () => {},
  });
  await kernel.init(kernelBytes);

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

const PHP_FPM_WORKERS = 6;
const PATCHED_PHP_FPM_CONF = `[global]
daemonize = no
error_log = /dev/stderr
log_level = notice

[www]
user = nobody
group = nobody
listen = 127.0.0.1:9000
pm = static
pm.max_children = ${PHP_FPM_WORKERS}
clear_env = no
slowlog = /dev/null
request_slowlog_trace_depth = 0
`;

async function runWordPress(): Promise<Record<string, number>> {
  const results: Record<string, number> = {};

  log("  Fetching WordPress VFS image...");
  const wpVfsUrl = await loadOptionalUrlFrom([
    "../../public/wordpress.vfs.zst",
    "../../../../local-binaries/programs/wasm32/wordpress.vfs.zst",
    "../../../../binaries/programs/wasm32/wordpress.vfs.zst",
  ], "WordPress VFS image", "bash images/vfs/scripts/build-wp-vfs-image.sh");

  const vfsResp = await fetch(wpVfsUrl);
  if (!vfsResp.ok) {
    throw new Error(
      `WordPress VFS image could not be fetched: ${wpVfsUrl} ` +
      `(HTTP ${vfsResp.status}). Build: bash images/vfs/scripts/build-wp-vfs-image.sh`,
    );
  }
  const [kernelBytes, vfsImageBuf] = await Promise.all([
    fetchWasm(kernelWasmUrl),
    vfsResp.arrayBuffer(),
  ]);

  // Restore MemoryFileSystem from the pre-built VFS image
  const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsImageBuf), {
    maxByteLength: 1024 * 1024 * 1024,
  });
  writeVfsFile(memfs, "/etc/php-fpm.conf", PATCHED_PHP_FPM_CONF);

  const kernel = new BrowserKernel({
    memfs,
    maxWorkers: 12,
    maxMemoryPages: 4096,
    onStdout: (data) => { if (PROFILE_BENCHMARKS) log(new TextDecoder().decode(data).trimEnd()); },
    onStderr: () => {},
  });

  const tBoot = performance.now();
  await kernel.init(kernelBytes);
  try {
    if (PROFILE_BENCHMARKS) kernel.sysprofStart();

    // Write dynamic wp-config.php
    writeVfsFile(kernel.fs, "/var/www/html/wp-config.php", WP_CONFIG_PHP);
    writeVfsFile(kernel.fs, "/var/www/html/wp-content/mu-plugins/wasm-optimizations.php", MU_PLUGIN_PHP);

    // Remove any pre-existing database so WordPress starts fresh
    try { kernel.fs.unlink("/var/www/html/wp-content/database/wordpress.db"); } catch { /* not present */ }

    // Spawn PHP-FPM
    log("  Starting PHP-FPM...");
    await kernel.spawnFromVfs("/usr/sbin/php-fpm", [
      "/usr/sbin/php-fpm", "-y", "/etc/php-fpm.conf", "-c", "/dev/null", "--nodaemonize",
    ]);
    await waitForListener(kernel, 9000);

    // Spawn nginx
    log("  Starting nginx...");
    await kernel.spawnFromVfs("/usr/sbin/nginx", [
      "/usr/sbin/nginx", "-p", "/etc/nginx", "-c", "nginx.conf",
    ]);
    const target = await waitForListener(kernel, 8080);

    results.boot_ms = performance.now() - tBoot;
    await dumpSysprof(kernel);
    log(`  Boot complete: ${results.boot_ms.toFixed(0)}ms`);

    // Measure HTTP first response via injected TCP connection to nginx
    log("  Sending HTTP request to nginx...");
    if (PROFILE_BENCHMARKS) kernel.sysprofStart();
    const tHttp = performance.now();

    const recvPipeIdx = await kernel.injectConnection(
      target.pid, target.fd, [127, 0, 0, 1],
      Math.floor(Math.random() * 60000) + 1024,
    );
    if (recvPipeIdx < 0) {
      throw new Error("failed to inject HTTP connection");
    }

    const sendPipeIdx = recvPipeIdx + 1;
    try {
      const httpReq = new TextEncoder().encode(
        "GET / HTTP/1.0\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      );
      await kernel.pipeWrite(0, recvPipeIdx, httpReq);
      kernel.wakeBlockedReaders(recvPipeIdx);

      // Wait for first bytes of HTTP response (time to first byte)
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const data = await kernel.pipeRead(0, sendPipeIdx);
        if (data && data.length > 0) {
          results.http_first_response_ms = performance.now() - tHttp;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      kernel.pipeCloseWrite(0, recvPipeIdx);
      kernel.pipeCloseRead(0, sendPipeIdx);
    }

    if (results.http_first_response_ms == null) {
      throw new Error("timed out waiting for WordPress HTTP response");
    }

    await dumpSysprof(kernel);

    return results;
  } finally {
    try { await kernel.destroy(); } catch {}
  }
}

// ─── mariadb ────────────────────────────────────────────────────────────────

type MariaDbArch = "wasm32" | "wasm64";
const MYSQL_UID = 101;
const MYSQL_GID = 101;

function ensureMariaDbWritableDataDirs(fs: MemoryFileSystem): void {
  for (const dir of ["/data", "/data/mysql", "/data/tmp", "/data/test"]) {
    try { fs.mkdir(dir, 0o775); } catch { /* already exists */ }
    fs.chown(dir, MYSQL_UID, MYSQL_GID);
    fs.chmod(dir, 0o775);
  }
  try { fs.mkdir("/tmp", 0o1777); } catch { /* already exists */ }
  fs.chmod("/tmp", 0o1777);
}

async function runMariaDbWithEngine(engine: string, arch: MariaDbArch = "wasm32"): Promise<Record<string, number>> {
  const results: Record<string, number> = {};
  const buildHint = arch === "wasm64"
    ? "bash images/vfs/scripts/build-mariadb-vfs-image.sh --wasm64"
    : "bash images/vfs/scripts/build-mariadb-vfs-image.sh";

  const engineArgs = [`--default-storage-engine=${engine}`];
  if (engine === "InnoDB") {
    engineArgs.push(
      "--innodb-buffer-pool-size=8M",
      "--innodb-log-file-size=4M",
      "--innodb-log-buffer-size=1M",
      "--innodb-flush-log-at-trx-commit=2",
      "--innodb-buffer-pool-load-at-startup=OFF",
      "--innodb-buffer-pool-dump-at-shutdown=OFF",
    );
  }

  const mariadbVfsUrl = await loadOptionalUrlFrom(
    arch === "wasm64" ? [
      "../../public/mariadb-64.vfs.zst",
      "../../../../local-binaries/programs/wasm64/mariadb-vfs.vfs.zst",
      "../../../../binaries/programs/wasm64/mariadb-vfs.vfs.zst",
    ] : [
      "../../public/mariadb.vfs.zst",
      "../../../../local-binaries/programs/wasm32/mariadb-vfs.vfs.zst",
      "../../../../binaries/programs/wasm32/mariadb-vfs.vfs.zst",
    ],
    `MariaDB VFS image (${arch})`,
    buildHint,
  );

  const vfsResp = await fetch(mariadbVfsUrl);
  if (!vfsResp.ok) {
    throw new Error(
      `MariaDB VFS image could not be fetched: ${mariadbVfsUrl} ` +
      `(HTTP ${vfsResp.status}). Build: ${buildHint}`,
    );
  }

  log(`  Fetching MariaDB VFS image (${engine}, ${arch})...`);
  const [kernelBytes, vfsImageBuf] = await Promise.all([
    fetchWasm(kernelWasmUrl),
    vfsResp.arrayBuffer(),
  ]);
  const memfs = MemoryFileSystem.fromImage(new Uint8Array(vfsImageBuf), {
    maxByteLength: 1024 * 1024 * 1024,
  });
  ensureMariaDbWritableDataDirs(memfs);
  const mariadbBytes = await readVfsBytes(memfs, "/usr/sbin/mariadbd");
  const bootstrapSql = await readVfsText(memfs, "/etc/mariadb/bootstrap.sql");

  // ── Bootstrap ──
  log("  Running bootstrap...");
  const tBootstrap = performance.now();

  const bootstrapKernel = new BrowserKernel({
    memfs,
    maxWorkers: 12,
    onStdout: (data) => { if (PROFILE_BENCHMARKS) log(new TextDecoder().decode(data).trimEnd()); },
    onStderr: (data) => { if (PROFILE_BENCHMARKS) log(new TextDecoder().decode(data).trimEnd()); },
  });
  await bootstrapKernel.init(kernelBytes);
  let client: MySqlBrowserClient | null = null;
  try {
    if (PROFILE_BENCHMARKS) bootstrapKernel.sysprofStart();

    const bootstrapStdin = new TextEncoder().encode(bootstrapSql);
    bootstrapKernel.spawn(mariadbBytes, [
      "mariadbd", "--no-defaults", "--bootstrap",
      "--user=mysql",
      "--datadir=/data", "--tmpdir=/data/tmp",
      ...engineArgs,
      "--skip-grant-tables",
      "--key-buffer-size=1048576", "--table-open-cache=10",
      "--sort-buffer-size=262144", "--skip-networking", "--log-warnings=0",
    ], { stdin: bootstrapStdin });

    // Wait for bootstrap stdin to be consumed
    const bootstrapPid = (bootstrapKernel as any).nextPid - 1;
    const bootstrapPolls = PROFILE_BENCHMARKS ? 120 : 1200;
    for (let i = 0; i < bootstrapPolls; i++) {
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
    await dumpSysprof(bootstrapKernel);
    log(`  Bootstrap: ${results.bootstrap_ms.toFixed(0)}ms`);

    // ── Server ──
    log("  Starting server...");
    const serverExit = bootstrapKernel.spawn(mariadbBytes, [
      "mariadbd", "--no-defaults",
      "--user=mysql",
      "--datadir=/data", "--tmpdir=/data/tmp",
      ...engineArgs,
      "--skip-grant-tables",
      "--key-buffer-size=1048576", "--table-open-cache=10",
      "--sort-buffer-size=262144", "--skip-networking=0",
      "--port=3306", "--bind-address=0.0.0.0", "--socket=",
      "--max-connections=10",
    ]);
    void serverExit;

    // Wait for port 3306
    log("  Waiting for server to accept connections...");
    const tServer = performance.now();
    await waitForListener(bootstrapKernel, 3306, 120_000);
    results.server_ready_ms = performance.now() - tServer;
    log(`  Server ready: ${results.server_ready_ms.toFixed(0)}ms`);

    // Connect MySQL client with retries
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
    await client.query("CREATE DATABASE IF NOT EXISTS bench");
    await client.query(`CREATE TABLE bench.t1 (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(100), value INT) ENGINE=${engine}`);
    await client.query(`CREATE TABLE bench.t2 (id INT PRIMARY KEY AUTO_INCREMENT, t1_id INT, data VARCHAR(200)) ENGINE=${engine}`);
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

    return results;
  } finally {
    try { client?.close(); } catch {}
    try { await bootstrapKernel.destroy(); } catch {}
  }
}

// ─── Suite registry ─────────────────────────────────────────────────────────

const SUITES: Record<string, () => Promise<Record<string, number>>> = {
  "syscall-io": runSyscallIo,
  "process-lifecycle": runProcessLifecycle,
  "wordpress": runWordPress,
  "mariadb-aria": () => runMariaDbWithEngine("Aria", "wasm32"),
  "mariadb-aria-64": () => runMariaDbWithEngine("Aria", "wasm64"),
  "mariadb-innodb": () => runMariaDbWithEngine("InnoDB", "wasm32"),
  "mariadb-innodb-64": () => runMariaDbWithEngine("InnoDB", "wasm64"),
};

const DISABLED_SUITES: Record<string, string> = {
  "erlang-ring": "disabled while the Erlang benchmark is unstable",
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
  const disabledReason = DISABLED_SUITES[suiteName];
  if (disabledReason) {
    log(`Skipping ${suiteName}: ${disabledReason}`);
    return {};
  }

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
