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
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { NodeKernelHost } from "../host/src/node-kernel-host";
import { tryResolveBinary } from "../host/src/binary-resolver";
import { ABI_SYSCALL_NAMES } from "../host/src/generated/abi";
import { ensureSourceExtract } from "../images/vfs/scripts/source-extract-helper";
import { preparePhpTestFixtures } from "../images/vfs/scripts/php-test-fixtures";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const LOCAL_PHP_SRC = join(REPO_ROOT, "packages/registry/php/php-src");
const BROWSER_PUBLIC_DIR = join(REPO_ROOT, "apps/browser-demos/public");
const PHP_TEST_VFS = resolve(
  process.env.PHP_TEST_VFS_OUT ??
    join(REPO_ROOT, "apps/browser-demos/public/php-test.vfs.zst"),
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
  "zend.exception_string_param_max_len=15",
  "short_open_tag=0",
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
export type TestStatus =
  | "pass"
  | "fail"
  | "bork"
  | "warn"
  | "skip"
  | "xfail"
  | "xpass"
  | "unsupported"
  | "time";

export interface PhptTest {
  path: string;
  rel: string;
  sourceRoot: string;
  sections: Record<string, string>;
}

export interface PhpRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  output?: string;
  error?: string;
  durationMs: number;
}

export interface TestResult {
  test: string;
  status: TestStatus;
  time_ms: number;
  reason?: string;
  detail?: string;
}

export interface PhpRunner {
  loadExtensionIniArgs(requiredExtensions: string[]): string[];
  runScript(opts: {
    test: PhptTest;
    kind: "skipif" | "file" | "clean";
    script: string;
    argv: string[];
    scriptArgs?: string[];
    env: string[];
    stdin?: string;
    waitForChildOutput?: boolean;
    timeoutMs: number;
  }): Promise<PhpRunResult>;
  endTest?(): Promise<void>;
  close(): Promise<void>;
}

let tempCounter = 0;

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

export function resolvePhpSource(): string {
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
  return { path, rel: relative(sourceRoot, path), sourceRoot, sections };
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
  const realSourceRoot = realpathSync(sourceRoot);
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
      const realResolved = realpathSync(resolved);
      const rel = relative(realSourceRoot, realResolved);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new Error(`PHPT selector escapes php-src: ${selector}`);
      }
      const st = statSync(realResolved);
      if (st.isDirectory()) walkPhpt(realResolved, files);
      else if (realResolved.endsWith(".phpt")) files.push(realResolved);
      else throw new Error(`PHPT selector is not a .phpt file: ${selector}`);
    }
  }
  return [...new Set(files)].sort().map((path) => parsePhpt(path, sourceRoot));
}

export function splitArgs(input: string | undefined): string[] {
  if (!input) return [];
  const out: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (const ch of input.trim()) {
    if (escape) {
      current += ch;
      tokenStarted = true;
      escape = false;
    } else if (ch === "\\") {
      tokenStarted = true;
      escape = true;
    } else if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      tokenStarted = true;
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (tokenStarted) {
        out.push(current);
        current = "";
        tokenStarted = false;
      }
    } else {
      current += ch;
      tokenStarted = true;
    }
  }
  if (escape) current += "\\";
  if (tokenStarted) out.push(current);
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
    .replace(/\{ENV:([^}]+)\}/g, (_match, name) => {
      if (name !== "TEST_NON_ROOT_USER") {
        throw new Error(
          `${test.rel}: unsupported host environment placeholder {ENV:${name}}`,
        );
      }
      return process.env[name] ?? "";
    });
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

function passthroughEnvArgs(): string[] {
  return PASSTHROUGH_ENV_NAMES.flatMap((name) =>
    process.env[name] === undefined ? [] : [`${name}=${process.env[name]}`],
  );
}

function defaultPhpTestEnvArgs(): string[] {
  // Stable harness inputs shared by all sections. php-src's CGI-like request
  // variables are section-specific and are added by envForSection().
  return [
    // Kandelo runs FPM and its helper clients under emulation, so PHP-FPM
    // startup notices can legitimately take longer than php-src's native
    // three-second tester default (especially with OPcache preloading).
    // The fixture patch below teaches the FPM tester helper to honor this.
    `TEST_FPM_LOG_TIMEOUT_SECONDS=${process.env.TEST_FPM_LOG_TIMEOUT_SECONDS ?? "20"}`,
    `TEST_FPM_CHECK_CONNECTION_ATTEMPTS=${process.env.TEST_FPM_CHECK_CONNECTION_ATTEMPTS ?? "200"}`,
    `TEST_FPM_READ_WRITE_TIMEOUT_MS=${process.env.TEST_FPM_READ_WRITE_TIMEOUT_MS ?? "20000"}`,
    "TEST_FPM_EXTENSION_DIR=/usr/lib/php/extensions",
    `TEST_NON_ROOT_USER=${process.env.TEST_NON_ROOT_USER ?? "nobody"}`,
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
      // Kandelo has no cross-process MAP_SHARED yet, so the packaged extension
      // rejects the normal SHM mode. Exercise its supported file-cache-only
      // boundary explicitly; individual PHPT --INI-- sections can still expose
      // unsupported SHM assumptions as real failures.
      args.push(
        "-d",
        "opcache.enable=1",
        "-d",
        "opcache.enable_cli=1",
        "-d",
        "opcache.file_cache=/tmp",
        "-d",
        "opcache.file_cache_only=1",
      );
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
    .replace(/^[\x00\t\n\v\r ]+|[\x00\t\n\v\r ]+$/g, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceExpectfPlaceholders(text: string): string {
  return text.replace(/%[easSAwidxfc0]/g, (token) => {
    switch (token) {
      case "%e":
        return "/";
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
        return "[+-]?(?:\\d+|(?=\\.\\d))(?:\\.\\d+)?(?:[Ee][+-]?\\d+)?";
      case "%c":
        return ".";
      case "%0":
        return "\\x00";
      default:
        return escapeRegExp(token);
    }
  });
}

function pcrePatternToJs(pattern: string): string {
  // PHP's PCRE \R token has no JavaScript equivalent. Preserve its generic
  // newline semantics rather than letting JS interpret it as a literal "R".
  return pattern.replace(
    /\\R/g,
    "(?:\\r\\n|[\\n\\r\\v\\f\\x85\\u2028\\u2029])",
  );
}

function expectfToRegExp(expectf: string): RegExp {
  let out = "";
  for (let i = 0; i < expectf.length; i++) {
    if (expectf.startsWith("%r", i)) {
      const end = expectf.indexOf("%r", i + 2);
      if (end !== -1) {
        out += `(${pcrePatternToJs(expectf.slice(i + 2, end))})`;
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

export function compareExpectation(
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
    const matched = re.test(actual);
    return {
      ok: matched,
      detail: matched ? undefined : "EXPECTF pattern did not match",
    };
  }
  if (test.sections.EXPECTREGEX !== undefined) {
    const expected = normalizeOutput(test.sections.EXPECTREGEX);
    // php-src's run-tests.php wraps EXPECTREGEX in ^...$ before matching.
    // Leaving it unanchored would let otherwise unexpected prefix/suffix
    // output turn a failing PHPT into a false pass.
    const re = new RegExp(`^${pcrePatternToJs(expected)}$`, "s");
    const matched = re.test(actual);
    return {
      ok: matched,
      detail: matched ? undefined : "EXPECTREGEX pattern did not match",
    };
  }
  return { ok: false, detail: "no supported EXPECT section" };
}

function failureSnippet(actualOutput: string): string {
  return normalizeOutput(actualOutput)
    .slice(0, FAILURE_SNIPPET_BYTES)
    .replace(/\n/g, "\\n");
}

function fileExternalPath(test: PhptTest): string | null {
  const raw = test.sections.FILE_EXTERNAL?.trim();
  if (!raw) return null;
  if (isAbsolute(raw)) {
    throw new Error(`${test.rel}: FILE_EXTERNAL must be relative to the PHPT`);
  }
  const candidate = resolve(dirname(test.path), raw);
  const lexicalRel = relative(test.sourceRoot, candidate);
  if (
    lexicalRel === ".." ||
    lexicalRel.startsWith(`..${sep}`) ||
    isAbsolute(lexicalRel)
  ) {
    throw new Error(`${test.rel}: FILE_EXTERNAL escapes php-src: ${raw}`);
  }
  if (!existsSync(candidate)) return candidate;
  const realCandidate = realpathSync(candidate);
  const realRoot = realpathSync(test.sourceRoot);
  const realRel = relative(realRoot, realCandidate);
  if (realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
    throw new Error(
      `${test.rel}: FILE_EXTERNAL resolves outside php-src: ${raw}`,
    );
  }
  return realCandidate;
}

function unsupportedReason(test: PhptTest): string | null {
  if (test.sections.CAPTURE_STDIO !== undefined) {
    const capture = test.sections.CAPTURE_STDIO.toUpperCase();
    if (
      !capture.includes("STDIN") ||
      !capture.includes("STDOUT") ||
      !capture.includes("STDERR")
    ) {
      return "partial CAPTURE_STDIO requires per-descriptor inheritance in the host spawn contract";
    }
  }
  const requiredExtensions = extensionArgs(test.sections.EXTENSIONS).map(
    normalizeExtensionName,
  );
  const source = `${test.sections.SKIPIF ?? ""}\n${test.sections.FILE ?? ""}\n${test.sections.FILEEOF ?? ""}`;
  const explicitlyLoadsOpcache =
    /(?:^|[^\w])(?:-d)?zend_extension\s*=\s*["']?opcache(?:\.so)?\b/im.test(
      source,
    );
  const ini = test.sections.INI ?? "";
  const opcacheConfiguration = `${ini}\n${source}`;
  const explicitlyActivatesOpcacheCli =
    /(?:^|[^\w])(?:-d)?opcache\.enable_cli\s*=\s*(?:1|on|yes|true)\b/im.test(
      opcacheConfiguration,
    ) ||
    /(?:^|[^\w])(?:-d)?opcache\.preload\s*=\s*[^\s'";]+/im.test(
      opcacheConfiguration,
    );
  if (
    requiredExtensions.includes("opcache") ||
    (explicitlyLoadsOpcache && explicitlyActivatesOpcacheCli)
  ) {
    const fileCacheOnly =
      /(?:^|[^\w])(?:-d)?opcache\.file_cache_only\s*=\s*(?:1|on|yes|true)\b/im.test(
        opcacheConfiguration,
      );
    const fileCachePath =
      /(?:^|[^\w])(?:-d)?opcache\.file_cache(?!_only)\s*=\s*[^\s'";]+/im.test(
        opcacheConfiguration,
      );
    if (!fileCacheOnly || !fileCachePath) {
      return "opcache SHM mode requires unsupported cross-process MAP_SHARED; only explicit file-cache-only PHPTs are supported";
    }
  }
  if (test.sections.REDIRECTTEST !== undefined)
    return "REDIRECTTEST is not supported by the Kandelo PHPT harness yet";
  if (test.sections.PHPDBG !== undefined) {
    return "PHPDBG requires the phpdbg SAPI and command-stream handling, which the Kandelo PHPT harness does not provide yet";
  }
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
    !existsSync(fileExternalPath(test) ?? "")
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

export function testScript(test: PhptTest): string {
  if (test.sections.FILE !== undefined) return test.sections.FILE;
  if (test.sections.FILEEOF !== undefined) {
    return test.sections.FILEEOF.replace(/[\r\n]+$/, "");
  }
  if (test.sections.FILE_EXTERNAL !== undefined) {
    const externalPath = fileExternalPath(test);
    if (!externalPath) return "";
    return readFileSync(externalPath, "latin1");
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

const UNSET_FOR_AUXILIARY_SECTIONS = new Set([
  "QUERY_STRING",
  "PATH_TRANSLATED",
  "SCRIPT_FILENAME",
  "REQUEST_METHOD",
]);

function withoutEnvNames(env: string[], names: Set<string>): string[] {
  return env.filter((entry) => {
    const eq = entry.indexOf("=");
    return eq < 0 || !names.has(entry.slice(0, eq));
  });
}

function hasEnvName(env: string[], name: string): boolean {
  return env.some((entry) => entry.startsWith(`${name}=`));
}

function envForSection(
  test: PhptTest,
  kind: "skipif" | "file" | "clean",
  env: string[],
): string[] {
  // Match php-src 8.3's run_test() mutations. Empty values are absent because
  // PHP's POSIX envp builder drops them. SKIPIF explicitly unsets only the
  // request/path quartet after applying --ENV--.
  if (kind === "skipif") {
    return withoutEnvNames(env, UNSET_FOR_AUXILIARY_SECTIONS);
  }

  // FILE clears content metadata, forces an ordinary CLI request method and
  // redirect status, and preserves --ENV-- query/script paths when supplied.
  if (kind === "file") {
    const fileEnv = withoutEnvNames(
      env,
      new Set([
        "REDIRECT_STATUS",
        "REQUEST_METHOD",
        "CONTENT_TYPE",
        "CONTENT_LENGTH",
        "HTTP_COOKIE",
      ]),
    );
    const scriptName = phptGeneratedScriptName(test, kind);
    const scriptPath = guestScriptPath(test, test.sourceRoot, scriptName);
    return mergeEnvArgs(fileEnv, [
      "REDIRECT_STATUS=1",
      ...(hasEnvName(fileEnv, "PATH_TRANSLATED")
        ? []
        : [`PATH_TRANSLATED=${scriptPath}`]),
      ...(hasEnvName(fileEnv, "SCRIPT_FILENAME")
        ? []
        : [`SCRIPT_FILENAME=${scriptPath}`]),
      "REQUEST_METHOD=GET",
    ]);
  }

  // CLEAN inherits FILE's redirect status and cleared content metadata, then
  // explicitly unsets the same request/path quartet as SKIPIF.
  return mergeEnvArgs(
    withoutEnvNames(
      env,
      new Set([
        ...UNSET_FOR_AUXILIARY_SECTIONS,
        "REDIRECT_STATUS",
        "CONTENT_TYPE",
        "CONTENT_LENGTH",
        "HTTP_COOKIE",
      ]),
    ),
    ["REDIRECT_STATUS=1"],
  );
}

class NodePhpRunner implements PhpRunner {
  private virtualPhpPath: string;
  private host: NodeKernelHost | null = null;
  private phpBytes: ArrayBuffer | null = null;
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
      // Binary resolver outputs are commonly symlinks into the content cache.
      // A copied symlink would point outside this host-backed mount and be
      // rejected by HostFileSystem's sandbox, so materialize the file bytes.
      copyFileSync(srcPath, destPath);
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
    copyFileSync(this.phpPath, phpDest);
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
      copyFileSync(this.phpFpmPath, fpmDest);
      chmodSync(fpmDest, 0o755);
    }
    this.binaryMountRoot = root;
    return root;
  }

  private async ensureHost(): Promise<NodeKernelHost> {
    if (this.host) return this.host;
    this.phpBytes = loadBytes(this.phpPath);
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
    // PHPT execution is non-interactive: finite stdin and captured stdout and
    // stderr are all created as pipes by the host before the process starts.
    // Tests without an explicit --STDIN-- section receive immediate EOF.
    const stdin = Buffer.from(opts.stdin ?? "", "latin1");
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
            "PATH=/bin:/usr/bin:/usr/local/bin",
            `TEST_PHP_SRCDIR=/php-src`,
            `TEST_PHP_EXECUTABLE=${this.virtualPhpPath}`,
            `TEST_PHP_EXECUTABLE_ESCAPED=${shellEscape(this.virtualPhpPath)}`,
            ...opts.env,
          ],
          stdin,
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
  try {
    cpSync(sourceRoot, copyRoot, {
      recursive: true,
      dereference: false,
      filter: (path) => {
        const base = basename(path);
        return base !== ".git" && base !== ".deps" && base !== ".libs";
      },
    });
    // On macOS, tmpdir() returns /tmp while the filesystem canonicalizes it
    // to /private/tmp. Keep the PHPT root and discovered test paths in the
    // same namespace so relative guest paths never acquire ../ components.
    return realpathSync(copyRoot);
  } catch (err) {
    rmSync(copyRoot, { recursive: true, force: true });
    throw err;
  }
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

function phpTestVfsPublicUrl(): string {
  const rel = relative(BROWSER_PUBLIC_DIR, PHP_TEST_VFS);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `PHP_TEST_VFS_OUT must be inside ${BROWSER_PUBLIC_DIR} for browser runs: ${PHP_TEST_VFS}`,
    );
  }
  return rel.split(sep).join("/");
}

async function startViteServer(): Promise<ChildProcess> {
  const vfsPublicUrl = phpTestVfsPublicUrl();
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
        env: {
          ...process.env,
          KANDELO_BROWSER_DEMO_INPUTS: "php-test",
          VITE_PHP_TEST_VFS_URL: vfsPublicUrl,
        },
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
  private activeTestId: string | null = null;
  private activeTestSections = 0;

  constructor(
    private sourceRoot: string,
    private rebuildVfs: boolean,
    private availableSharedExtensions: Set<string>,
    private ownsSourceRoot = false,
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
    const builder = join(
      REPO_ROOT,
      "images/vfs/scripts/build-php-test-vfs-image.sh",
    );
    const builderEnv = { ...process.env, PHP_SOURCE_DIR: this.sourceRoot };
    const expectedFingerprint = execFileSync(
      "bash",
      [builder, "--print-fingerprint"],
      {
        cwd: REPO_ROOT,
        env: builderEnv,
        encoding: "utf8",
      },
    ).trim();
    let recordedFingerprint: string | undefined;
    try {
      const metadata = JSON.parse(
        readFileSync(`${PHP_TEST_VFS}.meta.json`, "utf8"),
      );
      if (metadata?.version === 1 && typeof metadata.fingerprint === "string") {
        recordedFingerprint = metadata.fingerprint;
      }
    } catch {
      recordedFingerprint = undefined;
    }
    if (
      this.rebuildVfs ||
      !existsSync(PHP_TEST_VFS) ||
      recordedFingerprint !== expectedFingerprint
    ) {
      execFileSync(
        "bash",
        [builder],
        {
          cwd: REPO_ROOT,
          stdio: "inherit",
          env: builderEnv,
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
    waitForChildOutput?: boolean;
    timeoutMs: number;
  }): Promise<PhpRunResult> {
    if (!this.page) throw new Error("browser page not ready");
    if (this.activeTestId !== opts.test.rel) {
      this.activeTestId = opts.test.rel;
      this.activeTestSections = 0;
    }
    const retryCanStartFromFreshImage = this.activeTestSections === 0;

    const scriptName = phptGeneratedScriptName(opts.test, opts.kind);
    const scriptPath = guestScriptPath(opts.test, this.sourceRoot, scriptName);
    const request = {
      testId: opts.test.rel,
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
      waitForChildOutput: opts.waitForChildOutput,
      timeoutMs: opts.timeoutMs,
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const start = performance.now();
      try {
        const page = this.page;
        if (!page) throw new Error("browser page not ready");
        const evaluatePromise = page.evaluate(
          async ({ request }) => (window as any).__runPhpScript(request),
          { request },
        );
        void evaluatePromise.catch(() => {});
        const result = await withTimeout(
          evaluatePromise,
          opts.timeoutMs + 10_000,
          "browser PHPT run",
        );
        this.activeTestSections++;
        return result;
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
        if (recoverable) {
          await this.page
            ?.context()
            .close()
            .catch(() => {});
          this.page = null;
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
          if (attempt === 0 && retryCanStartFromFreshImage) {
            continue;
          }
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

  async endTest(): Promise<void> {
    this.activeTestId = null;
    this.activeTestSections = 0;
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
    if (this.ownsSourceRoot) {
      rmSync(this.sourceRoot, { recursive: true, force: true });
    }
  }
}

export async function probeLoadedExtensions(
  runner: PhpRunner,
  sourceRoot: string,
  sharedExtensions: Set<string>,
  timeoutMs: number,
): Promise<Set<string>> {
  const marker = "__KANDELO_PHP_EXTENSIONS__";
  const endMarker = "__KANDELO_PHP_EXTENSIONS_END__";
  const probe: PhptTest = {
    path: join(sourceRoot, ".kandelo-extension-probe.phpt"),
    rel: ".kandelo-extension-probe.phpt",
    sourceRoot,
    sections: {},
  };
  const result = await runner.runScript({
    test: probe,
    kind: "file",
    script: `<?php echo "${marker}", json_encode(array_values(get_loaded_extensions())), "${endMarker}"; ?>`,
    argv: [
      ...baseIniArgs(),
      ...runner.loadExtensionIniArgs([...sharedExtensions]),
    ],
    env: defaultPhpTestEnvArgs(),
    timeoutMs: Math.max(30_000, timeoutMs),
  });
  const output = result.output ?? `${result.stdout}${result.stderr}`;
  if (result.error || result.exitCode !== 0) {
    throw new Error(
      `PHP extension probe failed${result.error ? `: ${result.error}` : ` with exit ${result.exitCode}`}${
        output ? `; output: ${failureSnippet(output)}` : ""
      }`,
    );
  }
  const start = output.lastIndexOf(marker);
  const end = start < 0 ? -1 : output.indexOf(endMarker, start + marker.length);
  if (start < 0 || end < 0) {
    throw new Error(
      `PHP extension probe returned malformed output: ${failureSnippet(output)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start + marker.length, end));
  } catch (err: any) {
    throw new Error(
      `PHP extension probe returned invalid JSON: ${err?.message || String(err)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) {
    throw new Error("PHP extension probe did not return a string array");
  }
  const loaded = new Set(parsed.map((name) => normalizeExtensionName(name)));
  const missingShared = [...sharedExtensions].filter((name) => !loaded.has(name));
  if (missingShared.length > 0) {
    throw new Error(
      `packaged PHP extension(s) failed to load: ${missingShared.join(", ")}; ` +
        `output: ${failureSnippet(output)}`,
    );
  }
  return loaded;
}

export async function runPhpt(
  test: PhptTest,
  runner: PhpRunner,
  availableExtensions: Set<string>,
  timeoutMs: number,
): Promise<TestResult> {
  return runPhptAttempt(test, runner, availableExtensions, timeoutMs, false);
}

function phptMayRetry(test: PhptTest, output: string): boolean {
  if (test.sections.FLAKY !== undefined) return true;
  const source = test.sections.FILE ?? "";
  if (/\b(?:disk_free_space|hrtime|microtime|sleep|usleep)\(/i.test(source)) {
    return true;
  }
  return /\b(?:404: page not found|address already in use|connection refused|deadlock|mailbox already exists|timed out)\b/i
    .test(normalizeOutput(output));
}

async function runPhptAttempt(
  test: PhptTest,
  runner: PhpRunner,
  availableExtensions: Set<string>,
  timeoutMs: number,
  retried: boolean,
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
  let skipXfailReason: string | undefined;
  let skipWarning: string | undefined;
  let skipInfo: string | undefined;
  let skipFlakyReason: string | undefined;
  let skipXleakReason: string | undefined;
  if (test.sections.SKIPIF !== undefined) {
    const skip = await runner.runScript({
      test,
      kind: "skipif",
      script: test.sections.SKIPIF,
      // Upstream run-tests.php executes SKIPIF before applying the test's
      // --INI-- block. Keep that ordering so resource-probing SKIPIF sections
      // are not distorted by settings meant only for the main FILE body.
      argv: preTestArgv,
      env: envForSection(test, "skipif", envWithExtraArgs),
      timeoutMs,
    });
    // php-src's system_with_timeout() reads stdout when evaluating SKIPIF and
    // leaves the separately captured stderr pipe out of the verdict string.
    // Preserve interleaved output for diagnostics, but do not let a shell
    // diagnostic emitted on stderr turn a valid stdout `skip` into BORK.
    let skipOutput = normalizeOutput(skip.stdout);
    const skipDiagnostics = normalizeOutput(
      skip.output ?? `${skip.stdout}${skip.stderr}`,
    );
    // SkipCache in php-src treats a leading lowercase `nocache` directive as
    // empty output after using it to disable cache reuse for that SKIPIF.
    if (skipOutput.startsWith("nocache")) skipOutput = "";
    if (skip.error) {
      return {
        test: test.rel,
        status: skip.error === "TIMEOUT" ? "time" : "fail",
        time_ms: skip.durationMs,
        reason:
          skip.error === "TIMEOUT"
            ? "SKIPIF timed out"
            : `SKIPIF host error: ${skip.error}`,
        detail: skipDiagnostics
          ? `partial output: ${failureSnippet(skipDiagnostics)}`
          : undefined,
      };
    }
    if (/^(?:skip|skipped)\b/i.test(skipOutput)) {
      return {
        test: test.rel,
        status: "skip",
        time_ms: Math.round(performance.now() - start),
        reason: skipOutput,
      };
    }
    const infoMatch = skipOutput.match(/^info\s*(.+)/i);
    const warnMatch = skipOutput.match(/^warn\s+(.+)/i);
    if (infoMatch) {
      skipInfo = infoMatch[1];
    } else if (warnMatch) {
      skipWarning = warnMatch[1];
    } else if (/^xfail/i.test(skipOutput)) {
      // Match run-tests.php: SKIPIF may synthesize an XFAIL section, but FILE
      // still runs and determines whether the result is XFAIL or XPASS.
      skipXfailReason = skipOutput.slice(5).trim();
    } else if (/^xleak/i.test(skipOutput)) {
      skipXleakReason = skipOutput.slice(5).trim();
    } else if (/^flaky/i.test(skipOutput)) {
      skipFlakyReason = skipOutput.slice(5).trim();
    } else if (skipOutput !== "") {
      return {
        test: test.rel,
        status: "bork",
        time_ms: Math.round(performance.now() - start),
        reason: "invalid output from SKIPIF",
        detail: failureSnippet(skipOutput),
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
      env: envForSection(test, "file", envWithExtraArgs),
      stdin: test.sections.STDIN,
      waitForChildOutput: /\b(?:pcntl_fork|pcntl_rfork|forkx|proc_open|popen)\s*\(/.test(
        test.sections.FILE ?? "",
      ),
      timeoutMs,
    });

  const main = await runMain();

  let ok = false;
  let detail = main.error;
  let actualOutput = main.output ?? `${main.stdout}${main.stderr}`;
  if (main.error) {
    detail = main.error;
    if (actualOutput) {
      detail += `; partial actual: ${failureSnippet(actualOutput)}`;
    }
  } else {
    const compared = compareExpectation(test, actualOutput);
    // PHPTs often intentionally trigger fatal errors; upstream run-tests.php
    // treats matching output as the authority rather than requiring exit 0.
    ok = compared.ok;
    detail = compared.detail;
    if (!ok && detail) {
      const snippet = failureSnippet(actualOutput);
      detail = `${detail}; exit=${main.exitCode}; actual: ${snippet}`;
    }
  }
  const mainMatched = ok;

  let cleanFailure: string | undefined;
  let cleanTimedOut = false;
  let cleanBorked = false;
  if (test.sections.CLEAN !== undefined) {
    try {
      const clean = await runner.runScript({
        test,
        kind: "clean",
        script: test.sections.CLEAN,
        // CLEAN runs with the same pre-test INI baseline as SKIPIF upstream.
        argv: preTestArgv,
        env: envForSection(test, "clean", envWithExtraArgs),
        timeoutMs: Math.min(timeoutMs, 30_000),
      });
      const cleanOutput = normalizeOutput(
        clean.output ?? `${clean.stdout}${clean.stderr}`,
      );
      if (clean.error || clean.exitCode !== 0) {
        cleanTimedOut = clean.error === "TIMEOUT";
        cleanFailure = clean.error
          ? `CLEAN host error: ${clean.error}`
          : `CLEAN exited ${clean.exitCode}`;
        if (cleanOutput) {
          cleanFailure += `; output: ${failureSnippet(cleanOutput)}`;
        }
      } else if (cleanOutput && mainMatched) {
        // run-tests.php treats output from an otherwise-successful CLEAN
        // section as a malformed test, not a passing cleanup.
        cleanBorked = true;
        cleanFailure = `invalid output from CLEAN: ${failureSnippet(cleanOutput)}`;
      }
    } catch (err: any) {
      cleanFailure = `CLEAN harness error: ${err?.message || String(err)}`;
    }
  }
  if (
    !retried &&
    !main.error &&
    !cleanFailure &&
    !mainMatched &&
    (skipFlakyReason !== undefined || phptMayRetry(test, actualOutput))
  ) {
    // php-src reruns the complete PHPT once, including SKIPIF and CLEAN. Do
    // not let a retry hide host, timeout, or cleanup infrastructure failures.
    return runPhptAttempt(test, runner, availableExtensions, timeoutMs, true);
  }
  if (cleanFailure) {
    ok = false;
    detail = detail ? `${detail}; ${cleanFailure}` : cleanFailure;
  }

  const isXfail =
    test.sections.XFAIL !== undefined || skipXfailReason !== undefined;
  const xfailReason =
    test.sections.XFAIL !== undefined
      ? normalizeOutput(test.sections.XFAIL)
      : skipXfailReason;
  const skipContext =
    skipInfo !== undefined
      ? `SKIPIF info: ${skipInfo}`
      : skipFlakyReason !== undefined
        ? `SKIPIF flaky: ${skipFlakyReason || "no reason given"}`
        : skipXleakReason !== undefined
          ? `SKIPIF xleak: ${skipXleakReason || "no reason given"}`
          : undefined;
  let status: TestStatus;
  if (cleanBorked) status = "bork";
  else if (cleanFailure) status = cleanTimedOut ? "time" : "fail";
  else if (main.error === "TIMEOUT") status = "time";
  else if (main.error) status = "fail";
  // PHP 8.3's run-tests.php reports WARN for a matching test after a warned
  // SKIPIF. A mismatch is a combined WARN&FAIL upstream; this single-status
  // harness must retain FAIL so the aggregate command cannot exit success.
  else if (skipWarning !== undefined && ok) status = "warn";
  else if (ok) status = isXfail ? "xpass" : retried ? "warn" : "pass";
  else status = isXfail ? "xfail" : "fail";

  const warningContext = skipWarning
    ? `SKIPIF warning: ${skipWarning}`
    : undefined;

  return {
    test: test.rel,
    status,
    time_ms: Math.round(performance.now() - start),
    reason:
      status === "xfail"
        ? [xfailReason || "expected failure", warningContext]
            .filter((value): value is string => value !== undefined)
            .join("; ")
        : status === "warn"
          ? retried && ok
            ? "test passed on retry attempt"
            : [warningContext, !ok && isXfail ? xfailReason : undefined]
                .filter((value): value is string => value !== undefined)
                .join("; ")
          : warningContext ?? skipContext,
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
  --allow-unsupported   Keep an inventory run successful when its only
                        non-passing results are unsupported harness features
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
  --print-source-dir    Resolve php-src from package metadata/cache and exit

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
  let allowUnsupported = false;
  let printSourceDir = false;
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
    } else if (arg === "--allow-unsupported") {
      allowUnsupported = true;
    } else if (arg === "--print-source-dir") {
      printSourceDir = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      selectors.push(arg);
    }
  }

  if (printSourceDir) {
    console.log(resolvePhpSource());
    return;
  }

  const sourceInputRoot = resolvePhpSource();
  // Fixture maintenance and generated PHPT section files must never modify a
  // caller-supplied or content-addressed php-src checkout. Prepare one
  // harness-owned source tree, then give parallel Node runners their own
  // copies of that already-prepared tree.
  const sourceRoot = copySourceRootForNodeRunner(sourceInputRoot, 0);
  const runners: PhpRunner[] = [];
  try {
    preparePhpTestFixtures(
      sourceRoot,
      join(REPO_ROOT, "tests/php-fixtures"),
    );
    const phpPath = resolvePhpBinary();
    const phpFpmPath = resolvePhpFpmBinary(phpPath);
    const sharedExtensionPaths = sharedExtensionPathsForPhp(phpPath);
    const availableSharedExtensions = new Set(sharedExtensionPaths.keys());
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
      console.error(`php-src input: ${sourceInputRoot}`);
      console.error(`php-src harness copy: ${sourceRoot}`);
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

    if (host === "browser") {
      const runner = new BrowserPhpRunner(
        sourceRoot,
        rebuildVfs,
        availableSharedExtensions,
        true,
        runUid,
        runGid,
      );
      runners.push(runner);
      await runner.init();
    } else {
      for (let i = 0; i < jobs; i++) {
        const runnerSourceRoot =
          i === 0 ? sourceRoot : copySourceRootForNodeRunner(sourceRoot, i + 1);
        const runner = new NodePhpRunner(
          runnerSourceRoot,
          phpPath,
          phpFpmPath,
          sharedExtensionPaths,
          true,
          hostResetInterval,
          enableTcpNetwork,
          runUid,
          runGid,
        );
        runners.push(runner);
        if (runUid !== undefined || runGid !== undefined) {
          makeSourceTreeWritableByGuest(runnerSourceRoot);
        }
      }
    }
    const availableExtensions = await probeLoadedExtensions(
      runners[0],
      sourceRoot,
      availableSharedExtensions,
      timeoutMs,
    );
    if (!json) {
      console.error(
        `Loaded extensions: ${[...availableExtensions].sort().join(", ")}`,
      );
      console.error("");
    }

    const counts: Record<TestStatus, number> = {
      pass: 0,
      fail: 0,
      bork: 0,
      warn: 0,
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
        "bork",
        "warn",
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

    if (
      counts.fail > 0 ||
      counts.bork > 0 ||
      counts.xpass > 0 ||
      (!allowUnsupported && counts.unsupported > 0) ||
      counts.time > 0
    ) {
      process.exitCode = 1;
    }
  } finally {
    await Promise.all(
      runners.map((runner) =>
        runner.close().catch(() => {
          // Keep shutdown best-effort so one wedged worker does not hide
          // already-recorded PHPT results or other cleanup.
        }),
      ),
    );
    rmSync(sourceRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
