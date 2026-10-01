import { appendFileSync } from 'node:fs';
import { isAbsolute, posix } from 'node:path';
import { type ResponseFileReader, type SearchDirectoryArg, searchDirectoryArgs } from './flags.ts';

// The host-path guard keeps the build machine's own headers and libraries out
// of WebAssembly compiles. A host directory reaches a target compile as an
// ordinary `-I`/`-L` flag (usually from host pkg-config, a `*-config` script,
// or CPPFLAGS/LDFLAGS) and clang accepts it, so a package silently compiles
// against host headers whose version differs from the Kandelo package it
// links. See docs/sdk-guide.md#host-path-guard and
// docs/superpowers/specs/2026-10-01-hermetic-target-dependency-flags-design.md.

export const HOST_PATH_GUARD_ENV = 'KANDELO_HOST_PATH_GUARD';
export const HOST_PATH_GUARD_LOG_ENV = 'KANDELO_HOST_PATH_GUARD_LOG';
export const HOST_PATH_GUARD_DOC = 'docs/sdk-guide.md#host-path-guard';

export type HostPathGuardMode = 'report' | 'error';

export function hostPathGuardMode(env: NodeJS.ProcessEnv): HostPathGuardMode {
  const value = env[HOST_PATH_GUARD_ENV];
  if (value === undefined || value === '' || value === 'report') return 'report';
  if (value === 'error') return 'error';
  throw new Error(`${HOST_PATH_GUARD_ENV} must be "report" or "error", got ${JSON.stringify(value)}`);
}

// Locations that hold only host-built headers and libraries. Nothing under
// them is a WebAssembly artifact, so a deny-list here has no false positives
// in target builds, while an allow-list would have to enumerate every recipe
// source tree, generated-header directory, and vendored include path.
export const HOST_PATH_ROOTS: readonly string[] = [
  '/nix/store',
  '/usr/include',
  '/usr/lib',
  '/usr/local/include',
  '/usr/local/lib',
  '/opt/homebrew',
  // macOS SDKs and toolchains. These are where `xcrun --show-sdk-path`
  // points outside Nix; inside the dev shell it points into /nix/store.
  // Listing them avoids spawning xcrun on every compile.
  '/Library/Developer/CommandLineTools',
  '/Applications/Xcode.app',
];

export function hostPathRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = [...HOST_PATH_ROOTS];
  // A non-Nix macOS shell can select another Xcode with SDKROOT.
  const sdkRoot = env.SDKROOT;
  if (sdkRoot && isAbsolute(sdkRoot)) {
    const normalized = posix.resolve(sdkRoot);
    if (normalized !== '/') roots.push(normalized);
  }
  return roots;
}

function underRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export interface HostPathFinding extends SearchDirectoryArg {
  /** The deny-listed root the directory falls under. */
  root: string;
  /** Flag-carrying environment variables whose value contains this directory. */
  envSources: string[];
}

// Compiler environment variables that add search directories without any
// flag on the command line.
const SEARCH_PATH_ENV = [
  'CPATH',
  'C_INCLUDE_PATH',
  'CPLUS_INCLUDE_PATH',
  'OBJC_INCLUDE_PATH',
  'LIBRARY_PATH',
];

// Build-system variables a host directory most often arrives through. Used
// only to tell the reader where to look, never to decide anything.
const FLAG_ENV_SOURCES = ['CPPFLAGS', 'CFLAGS', 'CXXFLAGS', 'LDFLAGS'];

export interface HostPathScan {
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  readResponseFile?: ResponseFileReader;
}

export function findHostPaths(scan: HostPathScan): HostPathFinding[] {
  const roots = hostPathRoots(scan.env);
  const candidates = searchDirectoryArgs(scan.args, scan.readResponseFile);
  for (const name of SEARCH_PATH_ENV) {
    for (const value of (scan.env[name] ?? '').split(':')) {
      if (value) candidates.push({ flag: name, value });
    }
  }

  const findings: HostPathFinding[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // `-I=dir` and `--sysroot`-relative spellings name a directory inside the
    // target sysroot, never a host location.
    if (candidate.value.startsWith('=')) continue;
    const resolved = posix.resolve(scan.cwd, candidate.value);
    const root = roots.find((r) => underRoot(resolved, r));
    if (!root) continue;
    const key = `${candidate.flag}\0${candidate.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      ...candidate,
      root,
      envSources: FLAG_ENV_SOURCES.filter((name) => scan.env[name]?.includes(candidate.value)),
    });
  }
  return findings;
}

function spell(finding: SearchDirectoryArg): string {
  if (SEARCH_PATH_ENV.includes(finding.flag)) return `${finding.flag}=${finding.value}`;
  if (finding.flag.startsWith('--')) return `${finding.flag}=${finding.value}`;
  return `${finding.flag}${finding.value}`;
}

function likelySource(finding: HostPathFinding): string {
  if (SEARCH_PATH_ENV.includes(finding.flag)) return `the ${finding.flag} environment variable`;
  if (finding.envSources.length > 0) return `${finding.envSources.join('/')} in the environment`;
  return 'pkg-config, a *-config script, or flags the build system assembled';
}

export interface HostPathGuardContext extends HostPathScan {
  /** Tool name for messages, e.g. `wasm32posix-cc`. */
  tool: string;
  arch: string;
  writeStderr?: (text: string) => void;
  appendLog?: (path: string, text: string) => void;
}

/**
 * Inspect a compiler invocation for host directories. Returns `true` when the
 * compile may proceed. Report mode always proceeds; error mode refuses any
 * invocation that names a host directory.
 */
export function applyHostPathGuard(context: HostPathGuardContext): boolean {
  const writeStderr = context.writeStderr ?? ((text) => process.stderr.write(text));
  const mode = hostPathGuardMode(context.env);
  const findings = findHostPaths(context);
  if (findings.length === 0) return true;

  if (mode === 'error') {
    const lines = [`${context.tool}: error: host directory in a ${context.arch} compile`];
    for (const finding of findings) {
      lines.push(
        `  ${spell(finding)}`,
        `    ${finding.root} holds host-built files, never ${context.arch} ones; ` +
          `likely from ${likelySource(finding)}.`,
      );
    }
    lines.push(
      '  Resolve the dependency from its declared Kandelo package (or declare it) instead.',
      `  See ${HOST_PATH_GUARD_DOC} and ` +
        'docs/superpowers/specs/2026-10-01-hermetic-target-dependency-flags-design.md.',
    );
    writeStderr(`${lines.join('\n')}\n`);
    return false;
  }

  // WHY a log file: compiler stderr is an input to some configure probes
  // (Autoconf's AC_LANG_WERROR, libtool's flag checks compare stderr to a
  // baseline), so a report on stderr can change what a leaking package
  // configures. Census runs set the log to observe without perturbing.
  const logPath = context.env[HOST_PATH_GUARD_LOG_ENV];
  if (logPath && isAbsolute(logPath)) {
    const appendLog = context.appendLog ?? ((path, text) => appendFileSync(path, text));
    const records = findings.map((finding) => JSON.stringify({
      tool: context.tool,
      arch: context.arch,
      package: context.env.WASM_POSIX_DEP_NAME ?? null,
      flag: finding.flag,
      value: finding.value,
      root: finding.root,
      envSources: finding.envSources,
      cwd: context.cwd,
    }));
    appendLog(logPath, `${records.join('\n')}\n`);
    return true;
  }
  for (const finding of findings) {
    writeStderr(
      `${context.tool}: host-path guard (report): ${spell(finding)} is under ${finding.root}; ` +
        `likely from ${likelySource(finding)}; see ${HOST_PATH_GUARD_DOC}\n`,
    );
  }
  return true;
}
