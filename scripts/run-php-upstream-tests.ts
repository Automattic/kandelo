/**
 * Run php-src PHPT runtime tests on Kandelo, through either the Node.js host
 * or the browser host.
 *
 * This is intentionally a small PHPT harness instead of a native `make test`
 * wrapper: upstream run-tests.php assumes it can spawn a native PHP binary.
 * Here each --SKIPIF-- / --FILE-- / --CLEAN-- section is executed as a PHP
 * process inside Kandelo and the harness performs the expectation match.
 */
import { chromium, type Browser, type Page } from "playwright";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { setFlagsFromString } from "node:v8";
import {
  existsSync,
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { tryResolveBinary } from "../host/src/binary-resolver";
import { ABI_SYSCALL_NAMES } from "../host/src/generated/abi";
import { ensureSourceExtract } from "../images/vfs/scripts/source-extract-helper";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const LOCAL_PHP_SRC = join(REPO_ROOT, "packages/registry/php/php-src");
const PHP_TEST_VFS = join(
  REPO_ROOT,
  "apps/browser-demos/public/php-test.vfs.zst",
);
const BROWSER_DIR = join(REPO_ROOT, "apps/browser-demos");
const VITE_HOST = "127.0.0.1";
const VITE_PORT = Number(process.env.PHP_TEST_VITE_PORT ?? 5201);
const BROWSER_EXTENSION_DIR = "/usr/lib/php/extensions";
const RUN_TESTS_BASE_INI = [
  "output_handler=",
  "open_basedir=",
  "disable_functions=",
  "output_buffering=Off",
  "error_reporting=32767",
  "display_errors=1",
  "display_startup_errors=1",
  "log_errors=0",
  "html_errors=0",
  "track_errors=0",
  "report_memleaks=1",
  "report_zend_debug=0",
  "docref_root=",
  "docref_ext=.html",
  "error_prepend_string=",
  "error_append_string=",
  "auto_prepend_file=",
  "auto_append_file=",
  "ignore_repeated_errors=0",
  "precision=14",
  "serialize_precision=-1",
  "memory_limit=128M",
  "opcache.fast_shutdown=0",
  "opcache.file_update_protection=0",
  "opcache.revalidate_freq=0",
  "opcache.jit_hot_loop=1",
  "opcache.jit_hot_func=1",
  "opcache.jit_hot_return=1",
  "opcache.jit_hot_side_exit=1",
  "zend.assertions=1",
  "zend.exception_ignore_args=0",
];

const FAILURE_SNIPPET_BYTES = Math.max(
  2000,
  parseInt(process.env.PHP_TEST_FAILURE_SNIPPET_BYTES ?? "2000", 10) || 2000,
);
const BROWSER_WASM_STACK_JS_FLAGS = [
  // Chromium dedicated Web Workers expose only the default V8 native stack,
  // which is too small for legitimate stack-heavy Wasm workloads. Keep
  // browser-host PHPT runs on V8's secondary Wasm stack and raise that stack
  // so deep guest recursion behaves like the Node host's larger worker stack.
  "--stack-size=32768",
  "--stress-wasm-stack-switching",
  "--wasm-stack-switching-stack-size=32768",
  "--experimental-wasm-growable-stacks",
].join(" ");

type HostKind = "node" | "browser";
type TestStatus =
  | "pass"
  | "fail"
  | "skip"
  | "xfail"
  | "xpass"
  | "unsupported"
  | "time";

interface PhptTest {
  path: string;
  rel: string;
  sections: Record<string, string>;
}

interface PhpRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output?: string;
  error?: string;
  durationMs: number;
}

interface TestResult {
  test: string;
  status: TestStatus;
  time_ms: number;
  reason?: string;
  detail?: string;
}

interface PhpRunner {
  loadExtensionIniArgs(requiredExtensions: string[]): string[];
  runScript(opts: {
    test: PhptTest;
    kind: "skipif" | "file" | "clean";
    script: string;
    argv: string[];
    scriptArgs?: string[];
    env: string[];
    stdin?: string;
    stdinIsPipe?: boolean;
    pipeStdio?: number[];
    waitForChildOutput?: boolean;
    timeoutMs: number;
  }): Promise<PhpRunResult>;
  endTest?(): Promise<void>;
  close(): Promise<void>;
}

let tempCounter = 0;
let nodeToolDir: string | null = null;

function ensureNodeToolDir(): string {
  if (nodeToolDir) return nodeToolDir;
  nodeToolDir = mkdtempSync(join(tmpdir(), "kandelo-php-tools-"));
  writeFileSync(
    join(nodeToolDir, "pgrep"),
    `#!/bin/sh
if [ "$1" != "-P" ] || [ -z "$2" ]; then
  exit 1
fi
want_ppid=$2
for stat in /proc/[0-9]*/stat; do
  [ -r "$stat" ] || continue
  line=$(cat "$stat" 2>/dev/null) || continue
  pid=\${line%% *}
  after=\${line#*) }
  set -- $after
  ppid=$2
  if [ "$ppid" = "$want_ppid" ]; then
    printf '%s\\n' "$pid"
  fi
done
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(nodeToolDir, "ps"),
    `#!/bin/sh
pids=
format=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p)
      shift
      pids=$1
      ;;
    -o)
      shift
      format=$1
      ;;
    *)
      ;;
  esac
  shift
done

if [ -z "$pids" ]; then
  exit 1
fi

[ -n "$format" ] || format=pid,command
header=1
case "$format" in
  *=*)
    header=0
    ;;
esac

fields=$(printf '%s' "$format" | tr ',' ' ')
pid_list=$(printf '%s' "$pids" | tr ',' ' ')

if [ "$header" = 1 ]; then
  out=
  for field in $fields; do
    field=\${field%=}
    case "$field" in
      pid) label=PID ;;
      nice|ni) label=NICE ;;
      command|comm|args) label=COMMAND ;;
      *) label=$(printf '%s' "$field" | tr '[:lower:]' '[:upper:]') ;;
    esac
    out="$out\${out:+ }$label"
  done
  printf '%s\\n' "$out"
fi

found=0
for pid in $pid_list; do
  stat=/proc/$pid/stat
  [ -r "$stat" ] || continue
  line=$(cat "$stat" 2>/dev/null) || continue
  comm=\${line#*(}
  comm=\${comm%)*}
  after=\${line#*) }
  set -- $after
  nice=\${17:-0}
  row=
  for field in $fields; do
    field=\${field%=}
    case "$field" in
      pid) value=$pid ;;
      nice|ni) value=$nice ;;
      command|comm|args) value=$comm ;;
      *) value= ;;
    esac
    row="$row\${row:+ }$value"
  done
  printf '%s\\n' "$row"
  found=1
done

[ "$found" = 1 ]
`,
    { mode: 0o755 },
  );
  return nodeToolDir;
}

const PASSTHROUGH_ENV_NAMES = [
  "NO_INTERACTION",
  "RES_OPTIONS",
  "SKIP_IO_CAPTURE_TESTS",
  "SKIP_ONLINE_TESTS",
  "SKIP_PERF_SENSITIVE",
  "SKIP_SLOW_TESTS",
  "TEST_FPM_DEBUG",
  "TEST_FPM_RUN_AS_ROOT",
  "FPM_RUN_RESOURCE_HEAVY_TESTS",
  "TEST_NON_ROOT_USER",
];

function forceNodeGc(): void {
  try {
    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    gc();
  } catch {
    // Best-effort: Node may disable exposing gc in some embeddings.
  }
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function resolvePhpBinary(): string {
  const candidate =
    process.env.PHP_WASM ??
    tryResolveBinary("programs/php/php.wasm") ??
    join(LOCAL_PHP_SRC, "sapi/cli/php");
  if (!candidate || !existsSync(candidate)) {
    throw new Error(
      "PHP wasm not found. Run: bash packages/registry/php/build-php.sh",
    );
  }
  return candidate;
}

function resolvePhpFpmBinary(phpPath: string): string | null {
  const explicit = process.env.PHP_FPM_WASM;
  if (explicit) return resolve(explicit);
  const resolved = tryResolveBinary("programs/php/php-fpm.wasm");
  if (resolved) return resolved;
  const sibling = join(dirname(phpPath), "php-fpm.wasm");
  return existsSync(sibling) ? sibling : null;
}

function resolvePhpSource(): string {
  const explicit = process.env.PHP_SOURCE_DIR;
  if (explicit) return resolve(explicit);
  return ensureSourceExtract(
    "php",
    REPO_ROOT,
    existsSync(LOCAL_PHP_SRC) ? LOCAL_PHP_SRC : undefined,
  );
}

function parsePhpt(path: string, sourceRoot: string): PhptTest {
  // PHPT files are byte-oriented. A few upstream tests intentionally contain
  // non-UTF-8 PHP source/EXPECT bytes, so keep a one-code-point-per-byte
  // representation and write/capture generated scripts the same way.
  const text = readFileSync(path, "latin1");
  const marker = /^--([A-Z_]+)--[ \t]*\r?$/gm;
  const matches = [...text.matchAll(marker)];
  const sections: Record<string, string> = {};
  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1];
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    sections[name] = text.slice(start, end).replace(/^\r?\n/, "");
  }
  return { path, rel: relative(sourceRoot, path), sections };
}

function walkPhpt(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === ".git" ||
      entry.name === ".deps" ||
      entry.name === ".libs"
    )
      continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkPhpt(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".phpt")) {
      out.push(full);
    }
  }
  return out;
}

function discoverTests(sourceRoot: string, selectors: string[]): PhptTest[] {
  const files: string[] = [];
  if (selectors.length === 0) {
    walkPhpt(sourceRoot, files);
  } else {
    for (const selector of selectors) {
      const resolved = isAbsolute(selector)
        ? selector
        : resolve(sourceRoot, selector);
      if (!existsSync(resolved))
        throw new Error(`PHPT selector not found: ${selector}`);
      const st = statSync(resolved);
      if (st.isDirectory()) walkPhpt(resolved, files);
      else files.push(resolved);
    }
  }
  return [...new Set(files)].sort().map((path) => parsePhpt(path, sourceRoot));
}

function splitArgs(input: string | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (const ch of input.trim()) {
    if (escape) {
      current += ch;
      escape = false;
    } else if (ch === "\\") {
      escape = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

function extraChromiumArgsFromEnv(): string[] {
  const args = [
    ...splitArgs(process.env.PHP_TEST_CHROMIUM_ARGS),
    ...splitArgs(process.env.KANDELO_CHROMIUM_ARGS),
  ];
  if (process.env.PHP_TEST_DISABLE_BROWSER_WASM_STACK_FLAGS !== "1") {
    args.unshift(`--js-flags=${BROWSER_WASM_STACK_JS_FLAGS}`);
  }
  return args;
}

function guestTestDir(test: PhptTest): string {
  const relDir = dirname(test.rel).split("\\").join("/");
  return relDir === "." ? "/php-src" : `/php-src/${relDir}`;
}

function expandSectionPlaceholders(value: string, test: PhptTest): string {
  return value
    .replaceAll("{PWD}", guestTestDir(test))
    .replaceAll("{TMP}", "/tmp")
    .replace(/\{MAIL:([^}]+)\}/g, (_match, path) => `tee ${path} >/dev/null`)
    .replace(/\{ENV:([^}]+)\}/g, (_match, name) => process.env[name] ?? "");
}

function iniArgs(ini: string | undefined, test: PhptTest): string[] {
  if (!ini) return [];
  const args: string[] = [];
  for (const raw of expandSectionPlaceholders(ini, test).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (eq >= 0) {
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      line = `${key}=${value}`;
    }
    args.push("-d", line);
  }
  return args;
}

function envArgs(env: string | undefined, test: PhptTest): string[] {
  if (!env) return [];
  const args: string[] = [];
  for (const raw of expandSectionPlaceholders(env, test).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    // Upstream run-tests.php feeds --ENV-- through PHP's proc_open()
    // environment array. proc_open's POSIX envp builder intentionally skips
    // entries whose value is an empty string, so mirror that rather than
    // passing NAME= directly to Kandelo.
    if (eq >= 0 && line.slice(eq + 1).length === 0) continue;
    args.push(line);
  }
  return args;
}

function captureStdioFds(test: PhptTest): number[] {
  const capture = test.sections.CAPTURE_STDIO;
  if (capture === undefined) return [];
  const fds: number[] = [];
  if (/\bSTDIN\b/i.test(capture)) fds.push(0);
  if (/\bSTDOUT\b/i.test(capture)) fds.push(1);
  if (/\bSTDERR\b/i.test(capture)) fds.push(2);
  return fds;
}

function passthroughEnvArgs(): string[] {
  return PASSTHROUGH_ENV_NAMES.flatMap((name) =>
    process.env[name] === undefined ? [] : [`${name}=${process.env[name]}`],
  );
}

function defaultPhpTestEnvArgs(): string[] {
  // Mirror upstream php-src run-tests.php's baseline CGI-ish environment for
  // ordinary FILE tests. Several CLI PHPT fixtures intentionally inspect
  // $_SERVER['REQUEST_METHOD'] / REQUEST_URI without using a CGI section.
  return [
    "REDIRECT_STATUS=",
    "QUERY_STRING=",
    "PATH_TRANSLATED=",
    "SCRIPT_FILENAME=",
    "REQUEST_METHOD=GET",
    "CONTENT_TYPE=",
    "CONTENT_LENGTH=",
    // Kandelo runs FPM and its helper clients under emulation, so PHP-FPM
    // startup notices can legitimately take longer than php-src's native
    // three-second tester default (especially with OPcache preloading).
    // The fixture patch below teaches the FPM tester helper to honor this.
    `TEST_FPM_LOG_TIMEOUT_SECONDS=${process.env.TEST_FPM_LOG_TIMEOUT_SECONDS ?? "20"}`,
    `TEST_FPM_CHECK_CONNECTION_ATTEMPTS=${process.env.TEST_FPM_CHECK_CONNECTION_ATTEMPTS ?? "200"}`,
    `TEST_FPM_READ_WRITE_TIMEOUT_MS=${process.env.TEST_FPM_READ_WRITE_TIMEOUT_MS ?? "20000"}`,
    "TEST_FPM_EXTENSION_DIR=/usr/lib/php/extensions",
    `TEST_NON_ROOT_USER=${process.env.TEST_NON_ROOT_USER ?? "nobody"}`,
    "TZ=",
  ];
}

function parseOptionalNonNegativeInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${value}`);
  }
  return parsed;
}

function mergeEnvArgs(...groups: string[][]): string[] {
  const merged = new Map<string, string>();
  for (const group of groups) {
    for (const entry of group) {
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      merged.set(entry.slice(0, eq), entry);
    }
  }
  return [...merged.values()];
}

function isFlakyTest(test: PhptTest): boolean {
  if (test.sections.FLAKY !== undefined) return true;
  const file = test.sections.FILE ?? "";
  return /\b(?:disk_free_space|hrtime|microtime|sleep|usleep)\s*\(/i.test(file);
}

function phptConflictTokens(test: PhptTest): string[] {
  const tokens = new Set<string>();
  const conflicts = test.sections.CONFLICTS ?? "";
  for (const token of conflicts.split(/[\s,]+/)) {
    const normalized = token.trim();
    if (normalized) tokens.add(normalized);
  }

  const source = [
    test.sections.SKIPIF,
    test.sections.FILE,
    test.sections.FILEEOF,
    test.sections.CLEAN,
  ]
    .filter((section): section is string => section !== undefined)
    .join("\n");

  // Upstream run-tests.php uses --CONFLICTS-- to keep server-style PHPTs from
  // running concurrently. Some php-src tests do not declare it even though
  // they start helper servers or bind fixed loopback ports. Mirror the
  // important resource constraints here so `--jobs` remains usable without
  // producing false failures from EADDRINUSE or competing php_cli_server
  // instances.
  if (
    /\b(?:php_cli_server_start|php_cli_server_connect|PHP_CLI_SERVER_)/.test(
      source,
    ) ||
    /\bServerClientTestCase\.inc\b/.test(source)
  ) {
    tokens.add("server");
  }

  const loopbackPort =
    /\b(?:127\.0\.0\.1|localhost|\[::1\]|::1):([0-9]{2,5})\b/g;
  for (const match of source.matchAll(loopbackPort)) {
    tokens.add(`tcp-port:${match[1]}`);
  }

  return [...tokens];
}

function requiresExclusiveScheduling(conflicts: string[]): boolean {
  // Server-style PHPTs commonly start a helper PHP process, sleep briefly, and
  // then connect to a fixed loopback listener. The declared `server` conflict
  // prevents port/helper overlap, but under Kandelo's Wasm host even unrelated
  // concurrent PHPTs can consume enough CPU during PHP startup to turn those
  // upstream timing assumptions into false connection-refused failures. Run
  // server tests exclusively rather than skipping or patching them.
  return conflicts.includes("server");
}

function isFlakyOutput(output: string): boolean {
  return /\b(?:404: page not found|address already in use|connection refused|deadlock|mailbox already exists|timed out)\b/i.test(output);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellArgs(args: string[]): string {
  return args.map(shellEscape).join(" ");
}

function baseIniArgs(): string[] {
  return RUN_TESTS_BASE_INI.flatMap((setting) => ["-d", setting]);
}

function extensionArgs(extensions: string | undefined): string[] {
  if (!extensions) return [];
  return extensions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function normalizeExtensionName(extension: string): string {
  const name = extension.trim().toLowerCase();
  if (name === "zend opcache") return "opcache";
  return name.replace(/^(?:php_)?(.+?)(?:\.so)?$/, "$1");
}

function sharedExtensionPathsForPhp(phpPath: string): Map<string, string> {
  const out = new Map<string, string>();
  const extensionDirs = [
    dirname(phpPath),
    ...((process.env.PHP_EXTENSION_DIR ?? "")
      .split(delimiter)
      .map((dir) => dir.trim())
      .filter(Boolean)),
  ];
  for (const dir of extensionDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".so")) {
        out.set(normalizeExtensionName(entry), join(dir, entry));
      }
    }
  }
  const phpDir = dirname(phpPath);
  const opcachePath =
    process.env.PHP_OPCACHE_SO ??
    tryResolveBinary("programs/php/opcache.so") ??
    join(phpDir, "opcache.so");
  if (opcachePath && existsSync(opcachePath)) out.set("opcache", opcachePath);
  return out;
}

function staticExtensionsForPhpSource(sourceRoot: string): Set<string> {
  const out = new Set<string>();
  for (const file of ["internal_functions.c", "internal_functions_cli.c"]) {
    const internalFunctions = join(sourceRoot, "main", file);
    if (!existsSync(internalFunctions)) continue;
    const text = readFileSync(internalFunctions, "utf8");
    for (const match of text.matchAll(/\bphpext_([A-Za-z0-9_]+)_ptr\b/g)) {
      out.add(normalizeExtensionName(match[1]));
    }
  }
  return out;
}

function preparePhpTestFixtures(sourceRoot: string): void {
  // PHP 8.3.15's upstream SNI PHPT fixtures expired on 2026-04-02. Do not
  // fake guest time to make them pass: that would compromise Kandelo as a
  // general POSIX platform. Instead, treat this as test-fixture maintenance
  // and copy equivalent long-lived certificates into the local test tree
  // before discovery/VFS packaging.
  const fixtureDir = join(REPO_ROOT, "tests/php-fixtures/openssl-sni-2036");
  const destDir = join(sourceRoot, "ext/openssl/tests");
  if (!existsSync(fixtureDir) || !existsSync(destDir)) return;
  for (const entry of readdirSync(fixtureDir)) {
    if (!entry.startsWith("sni_server_") || !entry.endsWith(".pem")) continue;
    cpSync(join(fixtureDir, entry), join(destDir, entry));
  }

  // PHP 8.3.15's FPM test fixtures need small harness-side maintenance under
  // Kandelo:
  // - ext/opcache/tests/preload_user_004.phpt calls FPM\Tester::getLogLines(),
  //   but the shipped FPM tester helper does not define that method.
  // - logreader.inc has a native three-second default that is too short for
  //   OPcache preload startup under emulation.
  // - fcgi.inc has a native five-second client read/write timeout; under
  //   wasm emulation, OPcache preload requests can legitimately take longer
  //   while still producing the correct FastCGI response.
  //
  // These changes only affect the copied PHPT fixture tree used by the
  // harness. They do not change PHP runtime behavior or Kandelo kernel
  // behavior.
  const fpmTester = join(sourceRoot, "sapi/fpm/tests/tester.inc");
  if (existsSync(fpmTester)) {
    const text = readFileSync(fpmTester, "utf8");
    if (text.includes("class Tester")) {
      const marker = "    /**\n     * Expect no log lines to be logged.\n";
      const method = `    /**\n     * Return currently available FPM log lines.\n     *\n     * @param int $timeoutSeconds Seconds to wait for the first line.\n     * @param int $timeoutMicroseconds Additional microseconds to wait for the first line.\n     *\n     * @return array\n     * @throws \\Exception\n     */\n    public function getLogLines(int $timeoutSeconds = 3, int $timeoutMicroseconds = 0): array\n    {\n        $configuredTimeout = getenv('TEST_FPM_LOG_TIMEOUT_SECONDS');\n        if ($configuredTimeout !== false && is_numeric($configuredTimeout)) {\n            $timeoutSeconds = max($timeoutSeconds, (int) $configuredTimeout);\n        }\n\n        $lines = [];\n        $line = $this->logReader->getLine($timeoutSeconds, $timeoutMicroseconds);\n        while ($line !== null) {\n            if ($line !== '') {\n                $lines[] = $line;\n            }\n            $line = $this->logReader->getLine(timeoutSeconds: 0, timeoutMicroseconds: 1000);\n        }\n\n        return $lines;\n    }\n\n`;
      let next = text;
      if (text.includes("function getLogLines(")) {
        const start = text.indexOf("    /**\n     * Return currently available FPM log lines.");
        const end = text.indexOf(marker, start);
        if (start < 0 || end <= start) {
          throw new Error(
            `Unable to update PHP FPM tester fixture: getLogLines block not found in ${fpmTester}`,
          );
        }
        next = text.slice(0, start) + method + text.slice(end);
      } else {
        if (!text.includes(marker)) {
          throw new Error(
            `Unable to patch PHP FPM tester fixture: marker not found in ${fpmTester}`,
          );
        }
        next = text.replace(marker, method + marker);
      }
      if (!next.includes("TEST_FPM_CHECK_CONNECTION_ATTEMPTS")) {
        const from = `    ) {\n        $i = 0;\n        do {`;
        const to = `    ) {\n        $configuredAttempts = getenv('TEST_FPM_CHECK_CONNECTION_ATTEMPTS');\n        if ($configuredAttempts !== false && is_numeric($configuredAttempts)) {\n            $attempts = max($attempts, (int) $configuredAttempts);\n        }\n\n        $i = 0;\n        do {`;
        if (!next.includes(from)) {
          throw new Error(
            `Unable to patch PHP FPM tester fixture: checkConnection marker not found in ${fpmTester}`,
          );
        }
        next = next.replace(from, to);
      }
      if (!next.includes("$cmd .= ' --allow-to-run-as-root';")) {
        const from = `$cmd           = self::findExecutable() . " -n $configTestArg -y $configFile 2>&1";`;
        const to = `$cmd           = self::findExecutable() . " -n $configTestArg -y $configFile";\n        if (getenv('TEST_FPM_RUN_AS_ROOT')) {\n            $cmd .= ' --allow-to-run-as-root';\n        }\n        $cmd .= " 2>&1";`;
        if (!next.includes(from)) {
          throw new Error(
            `Unable to patch PHP FPM tester fixture: testConfig command marker not found in ${fpmTester}`,
          );
        }
        next = next.replace(from, to);
      }
      if (!next.includes("file_exists($extensionDir . '/' . $extension . '.so')")) {
        const from = `            foreach ($extensions as $extension) {\n                $cmd[] = '-dextension=' . $extension;\n            }`;
        const to = `            foreach ($extensions as $extension) {\n                if (file_exists($extensionDir . '/' . $extension . '.so')) {\n                    $cmd[] = '-dextension=' . $extension;\n                }\n            }`;
        if (!next.includes(from)) {
          throw new Error(
            `Unable to patch PHP FPM tester fixture: extension loading marker not found in ${fpmTester}`,
          );
        }
        next = next.replace(from, to);
      }
      if (next !== text) writeFileSync(fpmTester, next, "utf8");
    }
  }

  const fpmLogReader = join(sourceRoot, "sapi/fpm/tests/logreader.inc");
  if (existsSync(fpmLogReader)) {
    const text = readFileSync(fpmLogReader, "utf8");
    if (!text.includes("TEST_FPM_LOG_TIMEOUT_SECONDS")) {
      const from = `if (is_null($timeoutSeconds) && is_null($timeoutMicroseconds)) {\n            $timeoutSeconds      = 3;\n            $timeoutMicroseconds = 0;\n        }`;
      const to = `if (is_null($timeoutSeconds) && is_null($timeoutMicroseconds)) {\n            $configuredTimeout = getenv('TEST_FPM_LOG_TIMEOUT_SECONDS');\n            $timeoutSeconds = $configuredTimeout !== false && is_numeric($configuredTimeout)\n                ? max(3, (int) $configuredTimeout)\n                : 3;\n            $timeoutMicroseconds = 0;\n        }`;
      if (!text.includes(from)) {
        throw new Error(
          `Unable to patch PHP FPM logreader fixture: marker not found in ${fpmLogReader}`,
        );
      }
      writeFileSync(fpmLogReader, text.replace(from, to), "utf8");
    }
  }

  const fpmFcgi = join(sourceRoot, "sapi/fpm/tests/fcgi.inc");
  if (existsSync(fpmFcgi)) {
    const text = readFileSync(fpmFcgi, "utf8");
    if (!text.includes("TEST_FPM_READ_WRITE_TIMEOUT_MS")) {
      const from = `        $this->transport = $transport;\n    }`;
      const to = `        $this->transport = $transport;\n\n        $configuredTimeout = getenv('TEST_FPM_READ_WRITE_TIMEOUT_MS');\n        if ($configuredTimeout !== false && is_numeric($configuredTimeout)) {\n            $this->_readWriteTimeout = max($this->_readWriteTimeout, (int) $configuredTimeout);\n        }\n    }`;
      if (!text.includes(from)) {
        throw new Error(
          `Unable to patch PHP FPM FastCGI fixture: constructor marker not found in ${fpmFcgi}`,
        );
      }
      writeFileSync(fpmFcgi, text.replace(from, to), "utf8");
    }
  }

  const fpmIpv4Fallback = join(sourceRoot, "sapi/fpm/tests/socket-ipv4-fallback.phpt");
  if (existsSync(fpmIpv4Fallback)) {
    const text = readFileSync(fpmIpv4Fallback, "utf8");
    const from = "Address already in use \\(\\d+\\)";
    const to = "Address (?:already )?in use \\(\\d+\\)";
    if (text.includes(from) && !text.includes(to)) {
      // musl's strerror(EADDRINUSE) is "Address in use" while glibc's is
      // "Address already in use". Both describe the same POSIX errno, so make
      // this fixture regex libc-portable rather than changing Kandelo/libc
      // message strings to match one C library.
      writeFileSync(fpmIpv4Fallback, text.replace(from, to), "utf8");
    }
  }

  const mysqliFakeServer = join(sourceRoot, "ext/mysqli/tests/fake_server.inc");
  if (existsSync(mysqliFakeServer)) {
    const text = readFileSync(mysqliFakeServer, "utf8");
    if (!text.includes("MYSQLI_FAKE_SERVER_DRAIN_IDLE_MS")) {
      const from = `    public function read($bytes_len = 1024)
    {
        // wait 20ms to fill the buffer
        usleep(20000);
        $data = fread($this->conn, $bytes_len);
        if ($data) {
            fprintf(STDERR, "[*] Received: %s\\n", bin2hex($data));
        }
    }`;
      const to = `    public function read($bytes_len = 1024)
    {
        // wait 20ms to fill the buffer
        usleep(20000);
        $data = fread($this->conn, $bytes_len);

        if ($data && $bytes_len > 1024) {
            // Large reads in this fake MySQL server are used to drain the
            // connection tail after the client reacts to a crafted packet.
            // fread() on a POSIX stream may return as soon as any bytes are
            // available; it is not required to wait for later client writes to
            // coalesce into the same TCP segment. Native php-src runs usually
            // see the final COM_STMT_CLOSE and COM_QUIT together after the
            // fixed sleep above, but the browser host can schedule the guest
            // peer more slowly. Keep draining for a short idle window and print
            // one Received line so the fixture remains semantically identical
            // without relying on transport coalescing.
            $idleMs = getenv('MYSQLI_FAKE_SERVER_DRAIN_IDLE_MS');
            $idleMs = $idleMs !== false && is_numeric($idleMs) ? max(0, (int) $idleMs) : 250;
            $deadline = microtime(true) + ($idleMs / 1000);
            $wasBlocking = stream_get_meta_data($this->conn)['blocked'] ?? true;
            stream_set_blocking($this->conn, false);
            try {
                while (strlen($data) < $bytes_len && microtime(true) < $deadline) {
                    usleep(10000);
                    $chunk = fread($this->conn, $bytes_len - strlen($data));
                    if ($chunk !== false && $chunk !== '') {
                        $data .= $chunk;
                        $deadline = microtime(true) + ($idleMs / 1000);
                    }
                }
            } finally {
                stream_set_blocking($this->conn, $wasBlocking);
            }
        }

        if ($data) {
            fprintf(STDERR, "[*] Received: %s\\n", bin2hex($data));
        }
    }`;
      if (!text.includes(from)) {
        throw new Error(
          `Unable to patch PHP mysqli fake_server fixture: read() marker not found in ${mysqliFakeServer}`,
        );
      }
      writeFileSync(mysqliFakeServer, text.replace(from, to), "utf8");
    }
  }
}

function loadExtensionIniArgs(
  requiredExtensions: string[],
  availableSharedExtensions: Set<string>,
  guestExtensionDir: string,
): string[] {
  const args: string[] = [];
  let emittedExtensionDir = false;
  for (const extension of requiredExtensions) {
    const name = normalizeExtensionName(extension);
    if (!availableSharedExtensions.has(name)) continue;
    if (!emittedExtensionDir) {
      args.push("-d", `extension_dir=${guestExtensionDir}`);
      emittedExtensionDir = true;
    }
    const directive =
      name === "opcache" || name === "xdebug" ? "zend_extension" : "extension";
    args.push("-d", `${directive}=${guestExtensionDir}/${name}.so`);
    if (name === "opcache") {
      // The Kandelo PHP package builds opcache as a shared Zend extension but
      // defaults opcache.enable to 0 for demos that do not opt in. Upstream
      // php-src PHPTs that request --EXTENSIONS-- opcache assume the upstream
      // default active extension unless a test's --INI-- overrides it.
      args.push("-d", "opcache.enable=1");
    }
  }
  return args;
}

function normalizeOutput(text: string): string {
  // Upstream php-src run-tests.php normalizes CRLF and compares PHP
  // trim($out) against trim(EXPECT*). PHP trim's default charlist includes
  // NUL bytes, unlike JavaScript String#trim().
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^[\x00\t\n\v\r ]+|[\x00\t\n\v\r ]+$/g, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceExpectfPlaceholders(text: string): string {
  return text.replace(/%[easSAwidxfc0]/g, (token) => {
    switch (token) {
      case "%e":
        return "[/\\\\]";
      case "%s":
        return "[^\\r\\n]+";
      case "%S":
        return "[^\\r\\n]*";
      case "%a":
        return ".+";
      case "%A":
        return "[\\s\\S]*";
      case "%w":
        return "\\s*";
      case "%i":
        return "[+-]?\\d+";
      case "%d":
        return "\\d+";
      case "%x":
        return "[0-9a-fA-F]+";
      case "%f":
        return "[+-]?(?:(?:\\d+\\.\\d*)|(?:\\d*\\.\\d+)|(?:\\d+))(?:[Ee][+-]?\\d+)?";
      case "%c":
        return ".";
      case "%0":
        return "\\x00";
      default:
        return escapeRegExp(token);
    }
  });
}

function expectfToRegExp(expectf: string): RegExp {
  let out = "";
  for (let i = 0; i < expectf.length; i++) {
    if (expectf.startsWith("%r", i)) {
      const end = expectf.indexOf("%r", i + 2);
      if (end !== -1) {
        out += `(${expectf.slice(i + 2, end)})`;
        i = end + 1;
        continue;
      }
    }
    out += escapeRegExp(expectf[i]);
  }
  // Upstream run-tests.php first preg_quote()s non-%r sections, leaves %r
  // regex spans raw, then applies EXPECTF %-placeholder substitutions to the
  // whole pattern. Do not treat %% specially: literal percent signs remain
  // literal unless followed by a recognized placeholder character.
  return new RegExp(`^${replaceExpectfPlaceholders(out)}$`, "s");
}

function compareExpectation(
  test: PhptTest,
  actualRaw: string,
): { ok: boolean; detail?: string } {
  const actual = normalizeOutput(actualRaw);
  if (test.sections.EXPECT !== undefined) {
    const expected = normalizeOutput(test.sections.EXPECT);
    return {
      ok: actual === expected,
      detail:
        actual === expected
          ? undefined
          : `expected exact output length ${expected.length}, got ${actual.length}`,
    };
  }
  if (test.sections.EXPECTF !== undefined) {
    const expected = normalizeOutput(test.sections.EXPECTF);
    const re = expectfToRegExp(expected);
    return {
      ok: re.test(actual),
      detail: re.test(actual) ? undefined : "EXPECTF pattern did not match",
    };
  }
  if (test.sections.EXPECTREGEX !== undefined) {
    const expected = normalizeOutput(test.sections.EXPECTREGEX);
    const re = new RegExp(expected, "s");
    return {
      ok: re.test(actual),
      detail: re.test(actual) ? undefined : "EXPECTREGEX pattern did not match",
    };
  }
  return { ok: false, detail: "no supported EXPECT section" };
}

function failureSnippet(actualOutput: string): string {
  return normalizeOutput(actualOutput)
    .slice(0, FAILURE_SNIPPET_BYTES)
    .replace(/\n/g, "\\n");
}

function unsupportedReason(test: PhptTest): string | null {
  if (test.sections.REDIRECTTEST !== undefined)
    return "REDIRECTTEST is not supported by the Kandelo PHPT harness yet";
  if (
    test.sections.PHPDBG !== undefined &&
    !process.env.TEST_PHPDBG_EXECUTABLE
  ) {
    return "phpdbg not available";
  }
  const source = `${test.sections.SKIPIF ?? ""}\n${test.sections.FILE ?? ""}\n${test.sections.FILEEOF ?? ""}`;
  if (
    /\b(?:dns_get_record|dns_get_mx|getmxrr|checkdnsrr|dns_check_record)\s*\(/.test(
      source,
    )
  ) {
    return "PHP DNS record-query functions are not enabled in the Kandelo PHP build";
  }
  if (
    test.rel.startsWith("Zend/tests/fibers/") ||
    /\b(?:new\s+\\?Fiber|\\?Fiber::|ReflectionFiber|_?ZendTestFiber)\b/.test(source)
  ) {
    return "PHP Fibers require ucontext/boost context switching, which the Kandelo PHP build does not support yet";
  }
  const sapiOnly = [
    "POST",
    "POST_RAW",
    "PUT",
    "GET",
    "COOKIE",
    "REQUEST",
    "HEADERS",
    "EXPECTHEADERS",
    "GZIP_POST",
    "DEFLATE_POST",
    "CGI",
  ].find((section) => test.sections[section] !== undefined);
  if (sapiOnly) return `${sapiOnly} requires web/CGI PHPT handling`;
  if (
    test.sections.FILE === undefined &&
    test.sections.FILEEOF === undefined &&
    test.sections.FILE_EXTERNAL === undefined
  ) {
    return "no FILE/FILEEOF/FILE_EXTERNAL section";
  }
  if (
    test.sections.FILE_EXTERNAL !== undefined &&
    !existsSync(join(dirname(test.path), test.sections.FILE_EXTERNAL.trim()))
  ) {
    return `FILE_EXTERNAL target not found: ${test.sections.FILE_EXTERNAL.trim()}`;
  }
  if (
    test.sections.EXPECT === undefined &&
    test.sections.EXPECTF === undefined &&
    test.sections.EXPECTREGEX === undefined
  ) {
    return "no supported EXPECT section";
  }
  return null;
}

function testScript(test: PhptTest): string {
  if (test.sections.FILE !== undefined) return test.sections.FILE;
  if (test.sections.FILEEOF !== undefined) return test.sections.FILEEOF;
  if (test.sections.FILE_EXTERNAL !== undefined) {
    return readFileSync(
      join(dirname(test.path), test.sections.FILE_EXTERNAL.trim()),
      "latin1",
    );
  }
  return "";
}

function phptGeneratedScriptName(test: PhptTest, kind: string): string {
  const base = basename(test.path, ".phpt");
  if (kind === "file") {
    return `${base}.php`;
  }
  if (kind === "clean") {
    return `${base}.clean.php`;
  }
  if (kind === "skipif") {
    return `${base}.skip.php`;
  }
  return `.kandelo-phpt-${process.pid}-${tempCounter++}-${kind}.php`;
}

function hostTestDir(test: PhptTest, sourceRoot: string): string {
  const relDir = dirname(test.rel);
  return relDir === "." ? sourceRoot : join(sourceRoot, relDir);
}

function nodeTempPath(test: PhptTest, sourceRoot: string, scriptName: string): string {
  return join(hostTestDir(test, sourceRoot), scriptName);
}

function guestScriptPath(
  test: PhptTest,
  _sourceRoot: string,
  scriptName: string,
): string {
  const relDir = dirname(test.rel).split("\\").join("/");
  return relDir && relDir !== "."
    ? `/php-src/${relDir}/${scriptName}`
    : `/php-src/${scriptName}`;
}

class NodePhpRunner implements PhpRunner {
  private virtualPhpPath: string;
  private host: NodeKernelHost | null = null;
  private phpBytes: ArrayBuffer | null = null;
  private fpmBytes: ArrayBuffer | null = null;
  private binaryMountRoot: string | null = null;
  private extensionMountRoot: string | null = null;
  private testsSinceReset = 0;
  private activeOutput: { stdout: string; stderr: string; output: string } | null =
    null;

  constructor(
    private sourceRoot: string,
    private phpPath: string,
    private phpFpmPath: string | null,
    private sharedExtensionPaths: Map<string, string>,
    private ownsSourceRoot = false,
    private hostResetInterval = 50,
    private enableTcpNetwork = true,
    private runUid?: number,
    private runGid?: number,
  ) {
    this.virtualPhpPath = `/kandelo-bin/${basename(phpPath)}`;
  }

  loadExtensionIniArgs(requiredExtensions: string[]): string[] {
    return loadExtensionIniArgs(
      requiredExtensions,
      new Set(this.sharedExtensionPaths.keys()),
      BROWSER_EXTENSION_DIR,
    );
  }

  private ensureExtensionMountRoot(): string {
    if (this.extensionMountRoot) return this.extensionMountRoot;
    const root = mkdtempSync(join(tmpdir(), "kandelo-php-ext-"));
    chmodSync(root, 0o755);
    const destDir = join(root, "php", "extensions");
    mkdirSync(destDir, { recursive: true });
    chmodSync(join(root, "php"), 0o755);
    chmodSync(destDir, 0o755);
    for (const [name, srcPath] of this.sharedExtensionPaths) {
      const destPath = join(destDir, `${name}.so`);
      cpSync(srcPath, destPath);
      chmodSync(destPath, 0o755);
    }
    this.extensionMountRoot = root;
    return root;
  }

  private ensureBinaryMountRoot(): string {
    if (this.binaryMountRoot) return this.binaryMountRoot;
    const root = mkdtempSync(join(tmpdir(), "kandelo-php-bin-"));
    chmodSync(root, 0o755);
    const phpDest = join(root, basename(this.phpPath));
    cpSync(this.phpPath, phpDest);
    chmodSync(phpDest, 0o755);
    if (this.phpFpmPath && existsSync(this.phpFpmPath)) {
      const sbin = join(root, "sbin");
      mkdirSync(sbin, { recursive: true });
      chmodSync(sbin, 0o755);
      // php-src's FPM PHPT helper searches for TEST_PHP_EXECUTABLE's
      // prefix + /sbin/php-fpm (or /fpm/php-fpm). Provide that normal
      // package layout in the guest rather than teaching individual tests
      // about Kandelo's .wasm artifact name.
      const fpmDest = join(sbin, "php-fpm");
      cpSync(this.phpFpmPath, fpmDest);
      chmodSync(fpmDest, 0o755);
    }
    this.binaryMountRoot = root;
    return root;
  }

  private async ensureHost(): Promise<NodeKernelHost> {
    if (this.host) return this.host;
    this.phpBytes = loadBytes(this.phpPath);
    this.fpmBytes =
      this.phpFpmPath && existsSync(this.phpFpmPath)
        ? loadBytes(this.phpFpmPath)
        : null;
    const binaryMountRoot = this.ensureBinaryMountRoot();
    const extensionMountRoot = this.ensureExtensionMountRoot();
    const host = new NodeKernelHost({
      maxWorkers: 4,
      rootfsImage: "default",
      enableTcpNetwork: this.enableTcpNetwork,
      execPrograms: {
        [this.virtualPhpPath]: this.phpPath,
        "/kandelo-bin/php": this.phpPath,
        ...(this.phpFpmPath
          ? {
              "/kandelo-bin/sbin/php-fpm": this.phpFpmPath,
              "/kandelo-bin/fpm/php-fpm": this.phpFpmPath,
            }
          : {}),
      },
      extraMounts: [
        {
          mountPoint: "/php-src",
          hostPath: this.sourceRoot,
          uid: this.runUid,
          gid: this.runGid ?? this.runUid,
        },
        {
          mountPoint: "/kandelo-bin",
          hostPath: binaryMountRoot,
          readonly: true,
        },
        {
          mountPoint: "/usr/lib",
          hostPath: extensionMountRoot,
          readonly: true,
        },
        {
          mountPoint: "/kandelo-test-bin",
          hostPath: ensureNodeToolDir(),
          readonly: true,
        },
      ],
      onStdout: (_pid, data) => {
        if (this.activeOutput) {
          const text = Buffer.from(data).toString("latin1");
          this.activeOutput.stdout += text;
          this.activeOutput.output += text;
        }
      },
      onStderr: (_pid, data) => {
        if (this.activeOutput) {
          const text = Buffer.from(data).toString("latin1");
          this.activeOutput.stderr += text;
          this.activeOutput.output += text;
        }
      },
      onResolveExec: (path) => {
        const base = path.split("/").pop();
        if (
          base === "php" ||
          base === "php.wasm" ||
          base === basename(this.phpPath)
        )
          return this.phpBytes;
        if (base === "php-fpm" || base === "php-fpm.wasm")
          return this.fpmBytes;
        return null;
      },
    });
    await host.init();
    if (process.env.PHP_TEST_SYSCALL_TRACE) {
      const filters = new Set(
        process.env.PHP_TEST_SYSCALL_TRACE.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      host.subscribeSyscalls((event) => {
        const name = ABI_SYSCALL_NAMES[event.nr] ?? `syscall_${event.nr}`;
        if (filters.size === 0 || filters.has(name) || filters.has(String(event.nr))) {
          console.error(
            `[php-phpt-syscall t=${event.t.toFixed(3)}] pid=${event.pid} ${name}(${event.args.join(",")})`,
          );
        }
      });
    }
    this.host = host;
    return host;
  }

  private async resetHost(host: NodeKernelHost): Promise<void> {
    if (this.host === host) this.host = null;
    await host.destroy().catch(() => {});
    await delay(0);
  }

  private async hasLiveProcesses(host: NodeKernelHost): Promise<boolean> {
    const processes = await withTimeout(host.enumProcs(), 1_000, "enumProcs");
    return processes.length > 0;
  }

  private async terminateLiveProcesses(host: NodeKernelHost): Promise<boolean> {
    let processes: Array<{ pid: number }> = [];
    try {
      processes = await withTimeout(host.enumProcs(), 1_000, "enumProcs");
    } catch {
      await this.resetHost(host);
      return true;
    }
    if (processes.length === 0) return false;
    const results = await Promise.allSettled(
      processes.map((process) =>
        withTimeout(
          host.terminateProcess(process.pid),
          1_000,
          `terminate pid ${process.pid}`,
        ),
      ),
    );
    if (results.some((result) => result.status === "rejected")) {
      await this.resetHost(host);
      return true;
    }
    return true;
  }

  async runScript(opts: {
    test: PhptTest;
    kind: "skipif" | "file" | "clean";
    script: string;
    argv: string[];
    scriptArgs?: string[];
    env: string[];
    stdin?: string;
    stdinIsPipe?: boolean;
    pipeStdio?: number[];
    waitForChildOutput?: boolean;
    timeoutMs: number;
  }): Promise<PhpRunResult> {
    const scriptName = phptGeneratedScriptName(opts.test, opts.kind);
    const hostScriptPath = nodeTempPath(opts.test, this.sourceRoot, scriptName);
    const scriptPath = guestScriptPath(opts.test, this.sourceRoot, scriptName);
    const previousScript = existsSync(hostScriptPath)
      ? readFileSync(hostScriptPath)
      : null;
    writeFileSync(hostScriptPath, opts.script, "latin1");
    const start = performance.now();
    const host = await this.ensureHost();
    if (!this.phpBytes) throw new Error("PHP wasm bytes not loaded");
    const output = { stdout: "", stderr: "", output: "" };
    this.activeOutput = output;
    // PHPT execution provides a finite stdin stream. Tests without an
    // explicit --STDIN-- section get immediate EOF, but keep fd 0 terminal-like
    // unless the PHPT explicitly redirects/captures it. Upstream run-tests.php
    // distinguishes "terminal with no input" from a pipe for isatty/fstat.
    const stdin = Buffer.from(opts.stdin ?? "", "latin1");
    const stdinIsPipe = opts.stdinIsPipe ?? true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let pid: number | null = null;
    try {
      const exitPromise = host.spawn(
        this.phpBytes,
        [
          this.virtualPhpPath,
          ...opts.argv,
          scriptPath,
          ...(opts.scriptArgs ?? []),
        ],
        {
          // php-src run-tests.php executes generated test files from the
          // source root. Several PHPTs intentionally use source-root-relative
          // paths such as ./ext/standard/tests/file.
          cwd: "/php-src",
          env: [
            "HOME=/tmp",
            "USER=kandelo",
            "USERNAME=kandelo",
            "LOGNAME=kandelo",
            "TMPDIR=/tmp",
            "PATH=/kandelo-test-bin:/bin:/usr/bin:/usr/local/bin",
            `TEST_PHP_SRCDIR=/php-src`,
            `TEST_PHP_EXECUTABLE=${this.virtualPhpPath}`,
            `TEST_PHP_EXECUTABLE_ESCAPED=${shellEscape(this.virtualPhpPath)}`,
            ...opts.env,
          ],
          stdin,
          stdinIsPipe,
          pipeStdio: opts.pipeStdio,
          uid: this.runUid,
          gid: this.runGid,
          onStarted: (startedPid) => {
            pid = startedPid;
          },
        },
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("TIMEOUT")),
          opts.timeoutMs,
        );
      });
      const exitCode = await Promise.race([exitPromise, timeoutPromise]);
      // A PHP process may fork short-lived children that inherit the same
      // stdio and produce PHPT-observed output after the original parent exits
      // (matching native run-tests.php process-tree behavior). Only enable
      // this bounded grace period for PHPTs that actually exercise fork-like
      // APIs; doing it unconditionally would add seconds to every test.
      if (opts.waitForChildOutput) {
        await delay(1_000);
      }
      // Process exit and stdio notifications are delivered over separate host
      // messages. Wait for output to quiesce before freezing the capture so
      // data written immediately before _exit() is not lost. A fixed short
      // sleep still flaked on buffered CLI/file PHPTs under full-suite load.
      let lastOutputLength = -1;
      let stablePolls = 0;
      for (let waitedMs = 0; waitedMs < 500 && stablePolls < 3; waitedMs += 25) {
        await delay(25);
        const outputLength = output.output.length;
        if (waitedMs >= 100 && outputLength === lastOutputLength) {
          stablePolls++;
        } else {
          stablePolls = 0;
        }
        lastOutputLength = outputLength;
      }
      return {
        exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
        output: output.output,
        durationMs: Math.round(performance.now() - start),
      };
    } catch (err: any) {
      const message = err?.message || String(err);
      if (message.includes("TIMEOUT") && pid !== null) {
        await this.resetHost(host);
      }
      return {
        exitCode: -1,
        stdout: output.stdout,
        stderr: output.stderr,
        output: output.output,
        error: message.includes("TIMEOUT") ? "TIMEOUT" : message,
        durationMs: Math.round(performance.now() - start),
      };
    } finally {
      if (this.host === host) {
        const hadLiveProcesses = await this.terminateLiveProcesses(host);
        // A PHPT that leaves children behind can also leave pipes, sockets, or
        // stdio delivery state behind. Upstream run-tests.php gets a fresh OS
        // process tree for every PHP invocation; mirror that isolation when
        // Kandelo reports leftover processes after a section completes.
        if (hadLiveProcesses && this.host === host) {
          await this.resetHost(host);
        }
      }
      this.activeOutput = null;
      if (timeoutId) clearTimeout(timeoutId);
      forceNodeGc();
      if (previousScript) {
        writeFileSync(hostScriptPath, previousScript);
      } else {
        rmSync(hostScriptPath, { force: true });
      }
    }
  }

  async endTest(): Promise<void> {
    if (this.hostResetInterval <= 0 || !this.host) return;
    this.testsSinceReset++;
    if (this.testsSinceReset < this.hostResetInterval) return;
    const host = this.host;
    this.testsSinceReset = 0;
    await this.resetHost(host);
  }

  async close(): Promise<void> {
    const host = this.host;
    this.host = null;
    if (host) await host.destroy().catch(() => {});
    if (this.ownsSourceRoot) {
      rmSync(this.sourceRoot, { recursive: true, force: true });
    }
    if (this.extensionMountRoot) {
      rmSync(this.extensionMountRoot, { recursive: true, force: true });
      this.extensionMountRoot = null;
    }
    if (this.binaryMountRoot) {
      rmSync(this.binaryMountRoot, { recursive: true, force: true });
      this.binaryMountRoot = null;
    }
  }
}

function copySourceRootForNodeRunner(sourceRoot: string, index: number): string {
  const copyRoot = mkdtempSync(join(tmpdir(), `kandelo-php-src-${index}-`));
  rmSync(copyRoot, { recursive: true, force: true });
  cpSync(sourceRoot, copyRoot, {
    recursive: true,
    dereference: false,
    filter: (path) => {
      const base = basename(path);
      return base !== ".git" && base !== ".deps" && base !== ".libs";
    },
  });
  return copyRoot;
}

function makeSourceTreeWritableByGuest(sourceRoot: string): void {
  const stack = [sourceRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const st = lstatSync(current);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      chmodSync(current, 0o777);
      for (const entry of readdirSync(current)) {
        stack.push(join(current, entry));
      }
    } else {
      // Non-root PHPT runs still generate per-test .php/.ini/.log fixtures in
      // the mounted php-src checkout. Make the copied fixture tree writable
      // to the guest user instead of weakening kernel credential checks.
      chmodSync(current, (st.mode & 0o111) | 0o666);
    }
  }
}

async function startViteServer(): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    const viteBin = join(BROWSER_DIR, "node_modules", ".bin", "vite");
    const useLocalVite = existsSync(viteBin);
    const proc = spawn(
      useLocalVite ? viteBin : "npx",
      [
        ...(useLocalVite ? [] : ["vite"]),
        "--config",
        join(BROWSER_DIR, "vite.config.ts"),
        "--host",
        VITE_HOST,
        "--port",
        String(VITE_PORT),
        "--strictPort",
      ],
      {
        cwd: BROWSER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, KANDELO_BROWSER_DEMO_INPUTS: "php-test" },
      },
    );
    let started = false;
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(
          new Error(
            `Vite server did not start within 30s${
              stdout || stderr
                ? `:
${stdout}${stderr}`
                : ""
            }`,
          ),
        );
      }
    }, 30_000);
    proc.stderr!.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    proc.stdout!.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (
        !started &&
        (stdout.includes("Local:") || stdout.includes("ready in"))
      ) {
        started = true;
        clearTimeout(timeout);
        setTimeout(() => resolvePromise(proc), 500);
      }
    });
    proc.on("exit", (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(
          new Error(
            `Vite exited with code ${code}${
              stderr
                ? `:
${stderr}`
                : ""
            }`,
          ),
        );
      }
    });
  });
}

class BrowserPhpRunner implements PhpRunner {
  private vite: ChildProcess | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private runs = 0;

  constructor(
    private sourceRoot: string,
    private rebuildVfs: boolean,
    private availableSharedExtensions: Set<string>,
    private runUid?: number,
    private runGid?: number,
  ) {}

  loadExtensionIniArgs(requiredExtensions: string[]): string[] {
    return loadExtensionIniArgs(
      requiredExtensions,
      this.availableSharedExtensions,
      BROWSER_EXTENSION_DIR,
    );
  }

  async init(): Promise<void> {
    if (this.rebuildVfs || !existsSync(PHP_TEST_VFS)) {
      execFileSync(
        "bash",
        [join(REPO_ROOT, "images/vfs/scripts/build-php-test-vfs-image.sh")],
        {
          cwd: REPO_ROOT,
          stdio: "inherit",
          env: { ...process.env, PHP_SOURCE_DIR: this.sourceRoot },
        },
      );
    }
    this.vite = await startViteServer();
    await this.launchBrowser();
    await this.reloadPage();
  }

  private async launchBrowser(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      args: [
        "--enable-features=SharedArrayBuffer",
        ...extraChromiumArgsFromEnv(),
      ],
    });
  }

  private async reloadPage(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.browser || !this.browser.isConnected()) {
        await this.launchBrowser();
      }
      try {
        const context = await this.browser!.newContext();
        this.page = await context.newPage();
        this.page.on("console", (msg) => {
          if (msg.type() === "error") console.error(`[browser] ${msg.text()}`);
        });
        await this.page.goto(
          `http://${VITE_HOST}:${VITE_PORT}/pages/php-test/`,
        );
        await this.page.waitForFunction(
          () => (window as any).__phpTestReady === true,
          {},
          { timeout: 120_000 },
        );
        return;
      } catch (err) {
        if (attempt === 0) {
          await this.launchBrowser();
          continue;
        }
        throw err;
      }
    }
  }

  async runScript(opts: {
    test: PhptTest;
    kind: "skipif" | "file" | "clean";
    script: string;
    argv: string[];
    scriptArgs?: string[];
    env: string[];
    stdin?: string;
    stdinIsPipe?: boolean;
    pipeStdio?: number[];
    waitForChildOutput?: boolean;
    timeoutMs: number;
  }): Promise<PhpRunResult> {
    if (!this.page) throw new Error("browser page not ready");
    if (this.runs > 0 && this.runs % 20 === 0) {
      await this.page.context().close();
      await this.reloadPage();
    }
    this.runs++;

    const scriptName = phptGeneratedScriptName(opts.test, opts.kind);
    const scriptPath = guestScriptPath(opts.test, this.sourceRoot, scriptName);
    const request = {
      scriptPath,
      script: opts.script,
      argv: [...opts.argv, scriptPath, ...(opts.scriptArgs ?? [])],
      cwd: "/php-src",
      env: [
        "PATH=/bin:/usr/bin:/usr/local/bin",
        "USER=kandelo",
        "USERNAME=kandelo",
        "LOGNAME=kandelo",
        "TEST_PHP_SRCDIR=/php-src",
        "TEST_PHP_EXECUTABLE=/usr/local/bin/php",
        "TEST_PHP_EXECUTABLE_ESCAPED='/usr/local/bin/php'",
        ...opts.env,
      ],
      uid: this.runUid,
      gid: this.runGid,
      stdin: opts.stdin ?? "",
      stdinIsPipe: opts.stdinIsPipe ?? true,
      pipeStdio: opts.pipeStdio,
      waitForChildOutput: opts.waitForChildOutput,
      timeoutMs: opts.timeoutMs,
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const start = performance.now();
      try {
        const evaluatePromise = this.page.evaluate(
          async ({ request }) => (window as any).__runPhpScript(request),
          { request },
        );
        void evaluatePromise.catch(() => {});
        return await withTimeout(
          evaluatePromise,
          opts.timeoutMs + 10_000,
          "browser PHPT run",
        );
      } catch (err: any) {
        const message = err?.message || String(err);
        const timedOut = /browser PHPT run timed out/.test(message);
        if (timedOut) {
          await this.page
            ?.context()
            .close()
            .catch(() => {});
          this.page = null;
          await this.reloadPage().catch(() => {});
          return {
            exitCode: -1,
            stdout: "",
            stderr: "",
            error: "TIMEOUT",
            durationMs: Math.round(performance.now() - start),
          };
        }
        const recoverable =
          /Execution context was destroyed|Target page, context or browser has been closed|Navigation failed/i.test(
            message,
          );
        if (attempt === 0 && recoverable) {
          await this.page
            ?.context()
            .close()
            .catch(() => {});
          try {
            await this.reloadPage();
          } catch (reloadErr: any) {
            return {
              exitCode: -1,
              stdout: "",
              stderr: "",
              error: reloadErr?.message || String(reloadErr),
              durationMs: Math.round(performance.now() - start),
            };
          }
          continue;
        }
        return {
          exitCode: -1,
          stdout: "",
          stderr: "",
          error: message,
          durationMs: Math.round(performance.now() - start),
        };
      }
    }
    throw new Error("unreachable");
  }

  async close(): Promise<void> {
    if (this.page)
      await this.page
        .context()
        .close()
        .catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    if (this.vite) {
      const vite = this.vite;
      if (vite.exitCode === null && vite.signalCode === null) {
        vite.kill("SIGTERM");
      }
      await new Promise<void>((resolveDone) => {
        if (vite.exitCode !== null || vite.signalCode !== null) {
          resolveDone();
          return;
        }
        const killTimer = setTimeout(() => {
          if (vite.exitCode === null && vite.signalCode === null) {
            vite.kill("SIGKILL");
          }
          resolveDone();
        }, 2000);
        vite.once("exit", () => {
          clearTimeout(killTimer);
          resolveDone();
        });
      });
      this.vite = null;
    }
  }
}

async function runPhpt(
  test: PhptTest,
  runner: PhpRunner,
  availableExtensions: Set<string>,
  timeoutMs: number,
): Promise<TestResult> {
  const start = performance.now();
  const unsupported = unsupportedReason(test);
  if (unsupported) {
    return {
      test: test.rel,
      status: "unsupported",
      time_ms: 0,
      reason: unsupported,
    };
  }

  const commonEnv = mergeEnvArgs(
    passthroughEnvArgs(),
    defaultPhpTestEnvArgs(),
    envArgs(test.sections.ENV, test),
  );
  const defaultIniArgs = baseIniArgs();
  const testIniArgs = iniArgs(test.sections.INI, test);
  const args = splitArgs(test.sections.ARGS);
  const pipeStdio = captureStdioFds(test);
  const stdinIsPipe =
    test.sections.STDIN !== undefined ||
    test.sections.CAPTURE_STDIO === undefined ||
    pipeStdio.includes(0);

  const requiredExtensions = extensionArgs(test.sections.EXTENSIONS);
  const extensionIniArgs = runner.loadExtensionIniArgs(requiredExtensions);
  const missingRequiredExtensions = requiredExtensions.filter(
    (extension) => !availableExtensions.has(normalizeExtensionName(extension)),
  );
  if (missingRequiredExtensions.length > 0) {
    return {
      test: test.rel,
      status: "skip",
      time_ms: Math.round(performance.now() - start),
      reason: `skip required extension(s) not loaded: ${missingRequiredExtensions.join(", ")}`,
    };
  }
  const preTestArgv = [...extensionIniArgs, ...defaultIniArgs];
  const testArgv = [...preTestArgv, ...testIniArgs];
  const envWithExtraArgs = [
    ...commonEnv,
    `TEST_PHP_EXTRA_ARGS=${shellArgs(testArgv)}`,
  ];
  if (test.sections.SKIPIF !== undefined) {
    const skip = await runner.runScript({
      test,
      kind: "skipif",
      script: test.sections.SKIPIF,
      // Upstream run-tests.php executes SKIPIF before applying the test's
      // --INI-- block. Keep that ordering so resource-probing SKIPIF sections
      // are not distorted by settings meant only for the main FILE body.
      argv: preTestArgv,
      env: envWithExtraArgs,
      pipeStdio,
      stdinIsPipe,
      timeoutMs,
    });
    const skipOutput = normalizeOutput(`${skip.stdout}${skip.stderr}`);
    if (/^(?:skip|skipped)\b/i.test(skipOutput)) {
      return {
        test: test.rel,
        status: "skip",
        time_ms: Math.round(performance.now() - start),
        reason: skipOutput,
      };
    }
    if (/^xfail\b/i.test(skipOutput)) {
      return {
        test: test.rel,
        status: "xfail",
        time_ms: Math.round(performance.now() - start),
        reason: skipOutput,
      };
    }
    if (skip.error === "TIMEOUT") {
      return {
        test: test.rel,
        status: "time",
        time_ms: skip.durationMs,
        reason: "SKIPIF timed out",
      };
    }
  }

  const runMain = () =>
    runner.runScript({
      test,
      kind: "file",
      script: testScript(test),
      argv: testArgv,
      scriptArgs: args,
      env: envWithExtraArgs,
      stdin: test.sections.STDIN,
      stdinIsPipe,
      pipeStdio,
      waitForChildOutput: /\b(?:pcntl_fork|pcntl_rfork|forkx|proc_open|popen)\s*\(/.test(
        test.sections.FILE ?? "",
      ),
      timeoutMs,
    });

  let main = await runMain();

  let ok = false;
  let detail = main.error;
  let actualOutput = main.output ?? `${main.stdout}${main.stderr}`;
  if (main.error === "TIMEOUT" && actualOutput) {
    const snippet = failureSnippet(actualOutput);
    detail = `TIMEOUT; partial actual: ${snippet}`;
  }
  if (main.error !== "TIMEOUT") {
    const compared = compareExpectation(test, actualOutput);
    // PHPTs often intentionally trigger fatal errors; upstream run-tests.php
    // treats matching output as the authority rather than requiring exit 0.
    ok = compared.ok;
    detail = compared.detail;
    if (!ok && detail) {
      const snippet = failureSnippet(actualOutput);
      const errorDetail = main.error ? `; error=${main.error}` : "";
      detail = `${detail}; exit=${main.exitCode}${errorDetail}; actual: ${snippet}`;
    }
  }

  if (
    !ok &&
    main.error !== "TIMEOUT" &&
    (isFlakyTest(test) || isFlakyOutput(actualOutput))
  ) {
    main = await runMain();
    actualOutput = main.output ?? `${main.stdout}${main.stderr}`;
    detail = main.error;
    if (main.error !== "TIMEOUT") {
      const compared = compareExpectation(test, actualOutput);
      ok = compared.ok;
      detail = compared.detail;
      if (!ok && detail) {
        const snippet = failureSnippet(actualOutput);
        const errorDetail = main.error ? `; error=${main.error}` : "";
        detail = `${detail}; exit=${main.exitCode}${errorDetail}; actual: ${snippet}`;
      }
    }
  }

  if (test.sections.CLEAN !== undefined) {
    await runner
      .runScript({
        test,
        kind: "clean",
        script: test.sections.CLEAN,
        // CLEAN runs with the same pre-test INI baseline as SKIPIF upstream.
        argv: preTestArgv,
        env: envWithExtraArgs,
        pipeStdio,
        stdinIsPipe,
        timeoutMs: Math.min(timeoutMs, 30_000),
      })
      .catch(() => {});
  }

  const isXfail = test.sections.XFAIL !== undefined;
  let status: TestStatus;
  if (main.error === "TIMEOUT") status = isXfail ? "xfail" : "time";
  else if (ok) status = isXfail ? "xpass" : "pass";
  else status = isXfail ? "xfail" : "fail";

  return {
    test: test.rel,
    status,
    time_ms: Math.round(performance.now() - start),
    reason:
      status === "xfail"
        ? normalizeOutput(test.sections.XFAIL ?? "expected failure")
        : undefined,
    detail,
  };
}

function printUsage(): void {
  console.error(`Usage: npx tsx scripts/run-php-upstream-tests.ts [options] [test-or-dir ...]

Options:
  --host node|browser   Host runtime to use (default: node)
  --all                 Run every .phpt test under php-src (default when no tests are passed)
  --timeout <ms>        Per PHPT section timeout (default: 60000)
  --shard <i>/<n>       Run 1-based shard i of n after discovery sorting
  --offset <n>          Skip the first n selected tests
  --limit <n>           Run only the first n discovered tests
  --jobs <n>            Number of PHPTs to run concurrently (Node host only; default: 1)
  --run-uid <n>         Run guest PHP processes as uid n
                        (default: PHP_TEST_RUN_UID; root when unset)
  --run-gid <n>         Run guest PHP processes as gid n
                        (default: PHP_TEST_RUN_GID; root when unset)
  --host-reset-interval <n>
                        Reboot each Node-host Kandelo kernel after n PHPTs
                        per worker to reclaim host-side Wasm memory
                        (default: PHP_TEST_HOST_RESET_INTERVAL or 50; 0 disables)
  --disable-tcp-network Disable Node-host outbound TCP/DNS bridging
                        (enabled by default; set PHP_TEST_ENABLE_TCP_NETWORK=0
                        for the same effect)
  --json                Emit JSON lines
  --report              Write docs/php-upstream-test-report.md
  --rebuild-vfs         Rebuild php-test.vfs.zst before browser runs

Environment:
  PHP_WASM              Path to php.wasm
  PHP_FPM_WASM          Optional path to php-fpm.wasm for FPM PHPTs
  PHP_EXTENSION_DIR     Additional directory/directories to scan for shared
                        extensions when PHP_WASM is outside the package bin dir
  PHP_SOURCE_DIR        Path to a php-src checkout/extract
  PHP_TEST_RUN_UID      Optional guest uid for PHP processes
  PHP_TEST_RUN_GID      Optional guest gid for PHP processes
`);
}

async function main() {
  // Upstream run-tests.php expects TEST_NON_ROOT_USER to be available for
  // root-run preloading tests that use --INI-- placeholders before the guest
  // process is spawned. Provide the portable account that Kandelo rootfs/VFS
  // images carry by default rather than requiring every harness invocation to
  // remember this environment variable.
  process.env.TEST_NON_ROOT_USER ??= "nobody";

  const args = process.argv.slice(2);
  let host: HostKind = "node";
  let timeoutMs = 60_000;
  let shard: { index: number; total: number } | null = null;
  let offset = 0;
  let limit: number | null = null;
  let jobs = 1;
  let runUid = parseOptionalNonNegativeInt(process.env.PHP_TEST_RUN_UID, "PHP_TEST_RUN_UID");
  let runGid = parseOptionalNonNegativeInt(process.env.PHP_TEST_RUN_GID, "PHP_TEST_RUN_GID");
  let hostResetInterval = parseInt(
    process.env.PHP_TEST_HOST_RESET_INTERVAL ?? "50",
    10,
  );
  let enableTcpNetwork = process.env.PHP_TEST_ENABLE_TCP_NETWORK !== "0";
  let json = false;
  let report = false;
  let rebuildVfs = false;
  const selectors: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return;
    } else if (arg === "--host" && args[i + 1]) {
      const value = args[++i];
      if (value !== "node" && value !== "browser")
        throw new Error(`invalid host: ${value}`);
      host = value;
    } else if (arg === "--all") {
      // Default mode; accepted for clarity.
    } else if (arg === "--timeout" && args[i + 1]) {
      timeoutMs = parseInt(args[++i], 10);
    } else if (arg === "--shard" && args[i + 1]) {
      const value = args[++i];
      const match = /^(\d+)\/(\d+)$/.exec(value);
      if (!match) throw new Error(`invalid shard: ${value}`);
      shard = {
        index: parseInt(match[1], 10),
        total: parseInt(match[2], 10),
      };
      if (shard.total < 1 || shard.index < 1 || shard.index > shard.total) {
        throw new Error(`invalid shard: ${value}`);
      }
    } else if (arg === "--offset" && args[i + 1]) {
      offset = parseInt(args[++i], 10);
      if (!Number.isFinite(offset) || offset < 0) {
        throw new Error(`invalid offset: ${offset}`);
      }
    } else if (arg === "--limit" && args[i + 1]) {
      limit = parseInt(args[++i], 10);
      if (!Number.isFinite(limit) || limit < 0) {
        throw new Error(`invalid limit: ${limit}`);
      }
    } else if (arg === "--jobs" && args[i + 1]) {
      jobs = parseInt(args[++i], 10);
      if (!Number.isFinite(jobs) || jobs < 1) {
        throw new Error(`invalid jobs: ${jobs}`);
      }
    } else if (arg === "--run-uid" && args[i + 1]) {
      runUid = parseOptionalNonNegativeInt(args[++i], "--run-uid");
    } else if (arg === "--run-gid" && args[i + 1]) {
      runGid = parseOptionalNonNegativeInt(args[++i], "--run-gid");
    } else if (arg === "--host-reset-interval" && args[i + 1]) {
      hostResetInterval = parseInt(args[++i], 10);
      if (!Number.isFinite(hostResetInterval) || hostResetInterval < 0) {
        throw new Error(`invalid host reset interval: ${hostResetInterval}`);
      }
    } else if (arg === "--disable-tcp-network") {
      enableTcpNetwork = false;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--report") {
      report = true;
    } else if (arg === "--rebuild-vfs") {
      rebuildVfs = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      selectors.push(arg);
    }
  }

  const sourceRoot = resolvePhpSource();
  preparePhpTestFixtures(sourceRoot);
  const phpPath = resolvePhpBinary();
  const phpFpmPath = resolvePhpFpmBinary(phpPath);
  const sharedExtensionPaths = sharedExtensionPathsForPhp(phpPath);
  const availableSharedExtensions = new Set(sharedExtensionPaths.keys());
  const availableExtensions = new Set([
    ...staticExtensionsForPhpSource(sourceRoot),
    ...availableSharedExtensions,
  ]);
  let tests = discoverTests(sourceRoot, selectors);
  if (shard !== null) {
    tests = tests.filter((_, idx) => idx % shard!.total === shard!.index - 1);
  }
  if (offset > 0) tests = tests.slice(offset);
  if (limit !== null) tests = tests.slice(0, limit);
  if (host === "browser" && jobs !== 1) {
    throw new Error("--jobs is currently supported only by the node host");
  }

  if (!json) {
    console.error("===== PHP PHPT runtime tests =====");
    console.error(`Host: ${host}`);
    console.error(`php-src: ${sourceRoot}`);
    console.error(`PHP wasm: ${phpPath}`);
    if (phpFpmPath) {
      console.error(`PHP-FPM wasm: ${phpFpmPath}`);
    }
    if (availableSharedExtensions.size > 0) {
      console.error(
        `Shared extensions: ${[...availableSharedExtensions].join(", ")}`,
      );
    }
    if (shard !== null) {
      console.error(`Shard: ${shard.index}/${shard.total}`);
    }
    if (offset > 0) console.error(`Offset: ${offset}`);
    if (jobs > 1) console.error(`Jobs: ${jobs}`);
    if (host === "node") {
      console.error(`Node host reset interval: ${hostResetInterval}`);
      console.error(
        `Node TCP/DNS bridge: ${enableTcpNetwork ? "enabled" : "disabled"}`,
      );
    }
    if (runUid !== undefined || runGid !== undefined) {
      console.error(
        `Guest credentials: uid=${runUid ?? 0} gid=${runGid ?? runUid ?? 0}`,
      );
    }
    console.error(`Tests: ${tests.length}`);
    console.error("");
  }

  const runners: PhpRunner[] = [];
  if (host === "browser") {
    const runner = new BrowserPhpRunner(
      sourceRoot,
      rebuildVfs,
      availableSharedExtensions,
      runUid,
      runGid,
    );
    await runner.init();
    runners.push(runner);
  } else {
    for (let i = 0; i < jobs; i++) {
      const runnerSourceRoot =
        jobs === 1 && runUid === undefined && runGid === undefined
          ? sourceRoot
          : copySourceRootForNodeRunner(sourceRoot, i + 1);
      if (runUid !== undefined || runGid !== undefined) {
        makeSourceTreeWritableByGuest(runnerSourceRoot);
      }
      runners.push(
        new NodePhpRunner(
          runnerSourceRoot,
          phpPath,
          phpFpmPath,
          sharedExtensionPaths,
          runnerSourceRoot !== sourceRoot,
          hostResetInterval,
          enableTcpNetwork,
          runUid,
          runGid,
        ),
      );
    }
  }

  const counts: Record<TestStatus, number> = {
    pass: 0,
    fail: 0,
    skip: 0,
    xfail: 0,
    xpass: 0,
    unsupported: 0,
    time: 0,
  };
  const results: TestResult[] = new Array(tests.length);
  let completed = 0;
  const pendingTests = new Set(tests.map((_test, index) => index));
  const activeConflicts = new Set<string>();
  let activeTests = 0;
  let exclusiveActive = false;
  let schedulerWaiters: Array<() => void> = [];

  async function acquireTest(): Promise<{
    index: number;
    conflicts: string[];
  } | null> {
    while (true) {
      if (pendingTests.size === 0) return null;
      for (const index of pendingTests) {
        const conflicts = phptConflictTokens(tests[index]);
        const exclusive = requiresExclusiveScheduling(conflicts);
        if (exclusiveActive || (exclusive && activeTests > 0)) {
          continue;
        }
        if (conflicts.some((conflict) => activeConflicts.has(conflict))) {
          continue;
        }
        pendingTests.delete(index);
        for (const conflict of conflicts) activeConflicts.add(conflict);
        activeTests++;
        if (exclusive) exclusiveActive = true;
        return { index, conflicts };
      }
      await new Promise<void>((resolve) => schedulerWaiters.push(resolve));
    }
  }

  function releaseTest(conflicts: string[]) {
    for (const conflict of conflicts) activeConflicts.delete(conflict);
    if (requiresExclusiveScheduling(conflicts)) exclusiveActive = false;
    activeTests = Math.max(0, activeTests - 1);
    const waiters = schedulerWaiters;
    schedulerWaiters = [];
    for (const wake of waiters) wake();
  }

  try {
    await Promise.all(
      runners.map(async (runner) => {
        while (true) {
          const acquired = await acquireTest();
          if (acquired === null) break;
          const { index, conflicts } = acquired;
          let result: TestResult;
          try {
            result = await runPhpt(
              tests[index],
              runner,
              availableExtensions,
              timeoutMs,
            );
          } finally {
            releaseTest(conflicts);
          }
          counts[result.status]++;
          results[index] = result;
          completed++;
          await runner.endTest?.();
          if (json) {
            console.log(JSON.stringify(result));
          } else {
            const label = result.status.toUpperCase().padEnd(11);
            console.error(
              `[${completed}/${tests.length}] ${label} ${result.test} (${result.time_ms}ms)`,
            );
          }
        }
      }),
    );
  } finally {
    await Promise.all(
      runners.map((runner) =>
        runner.close().catch(() => {
          // Keep shutdown best-effort so one wedged worker does not hide
          // already-recorded PHPT results.
        }),
      ),
    );
  }

  const completedResults = results.filter((result): result is TestResult => {
    return result !== undefined;
  });
  if (completedResults.length !== tests.length) {
    for (let i = 0; i < tests.length; i++) {
      if (results[i] === undefined) {
        const result: TestResult = {
          test: tests[i].rel,
          status: "time",
          time_ms: 0,
          reason: "harness did not record a result",
        };
        results[i] = result;
        counts.time++;
      }
    }
  }

  if (report) {
    const reportPath = join(REPO_ROOT, "docs/php-upstream-test-report.md");
    mkdirSync(dirname(reportPath), { recursive: true });
    const lines = [
      "# PHP PHPT Runtime Test Report",
      "",
      `Host: ${host}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      "| Status | Count |",
      "|--------|-------|",
      ...Object.entries(counts).map(
        ([status, count]) => `| ${status.toUpperCase()} | ${count} |`,
      ),
      `| **TOTAL** | **${results.length}** |`,
      "",
      "## Non-Passing Results",
      "",
      ...results
        .filter((r) => !["pass", "skip", "xfail"].includes(r.status))
        .map(
          (r) =>
            `- ${r.status.toUpperCase()} \`${r.test}\`${r.reason ? `: ${r.reason}` : ""}${r.detail ? ` (${r.detail})` : ""}`,
        ),
      "",
    ];
    writeFileSync(reportPath, `${lines.join("\n")}\n`);
    if (!json) console.error(`Report written to: ${reportPath}`);
  }

  if (!json) {
    console.error("");
    console.error("===== Results =====");
    for (const status of [
      "pass",
      "fail",
      "skip",
      "xfail",
      "xpass",
      "unsupported",
      "time",
    ] as const) {
      console.error(`${status.toUpperCase().padEnd(11)} ${counts[status]}`);
    }
    console.error(`TOTAL       ${results.length}`);
  }

  if (counts.fail > 0 || counts.xpass > 0 || counts.time > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
