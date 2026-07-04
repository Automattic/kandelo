import type { WasmArch } from './arch.ts';
import { targetTriple, toolPrefix } from './arch.ts';

export function compileFlags(arch: WasmArch): string[] {
  return [
    `--target=${targetTriple(arch)}`,
    '-matomics',
    '-mbulk-memory',
    '-mexception-handling',
    '-mllvm', '-wasm-enable-sjlj',
    // Modern wasm-EH lowering. Empirical finding 2026-05-14: LLVM 21's
    // default for `-wasm-use-legacy-eh` is `true` — just dropping the
    // earlier `=true` override (commit 9 of the fork-instrument
    // mega-PR) leaves the toolchain on legacy `try`/`catch` lowering.
    // To actually get modern `try_table`/`catch_ref` we must pass
    // `=false` explicitly. Verified by inspecting the disassembly of
    // a C-02 build with this flag flipped.
    '-mllvm', '-wasm-use-legacy-eh=false',
    '-fno-trapping-math',
  ];
}

export const DEFAULT_MAIN_THREAD_STACK_SIZE = 8 * 1024 * 1024;

function parseDecimalStackSize(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;

  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function normalizeStackSizeLinkerArg(arg: string): string {
  if (!arg.startsWith('-Wl,')) return arg;

  const parts = arg.slice('-Wl,'.length).split(',');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith('stack-size=')) continue;

    const requested = parseDecimalStackSize(parts[i].slice('stack-size='.length));
    if (requested !== null) parts[i] = `stack-size=${requested}`;
  }
  return `-Wl,${parts.join(',')}`;
}

/**
 * Apply the SDK's stack-size floor while retaining explicit larger requests.
 * clang passes each comma-delimited -Wl component to wasm-ld in order, so the
 * effective value is the last stack-size flag emitted by buildClangArgs().
 */
export function mainThreadStackSize(
  args: string[],
  readResponseFile?: (path: string) => string | null,
): number {
  let result = DEFAULT_MAIN_THREAD_STACK_SIZE;

  const consider = (value: string): void => {
    const requested = parseDecimalStackSize(value);
    if (requested !== null && requested > result) result = requested;
  };

  for (const arg of args) {
    if (!arg.startsWith('-Wl,')) continue;

    for (const part of arg.slice('-Wl,'.length).split(',')) {
      if (part.startsWith('stack-size=')) {
        consider(part.slice('stack-size='.length));
      } else if (part.startsWith('@') && readResponseFile) {
        const response = readResponseFile(part.slice(1));
        if (response === null) continue;

        for (const match of response.matchAll(/\bstack-size=(\d+)\b/g)) {
          consider(match[1]);
        }
      }
    }
  }

  return result;
}

export function linkFlags(
  arch: WasmArch,
  mainThreadStackSizeBytes = DEFAULT_MAIN_THREAD_STACK_SIZE,
): string[] {
  return [
    '-nostdlib',
    '-Wl,--entry=_start',
    '-Wl,--export=_start',
    '-Wl,--export=__heap_base',
    '-Wl,--import-memory',
    '-Wl,--shared-memory',
    '-Wl,--max-memory=1073741824',
    '-Wl,--allow-undefined',
    // Reserve an 8 MiB main-thread shadow stack. wasm-ld's default is only
    // ~64 KiB, and WebAssembly has no stack guard page, so a deep call chain
    // silently overflows past __data_end into .bss and corrupts the pthread/TLS
    // globals that live there (__wasm_tp_storage, __pthread_tsd_main), which
    // then surfaces as a spurious "memory access out of bounds" far from the
    // real fault. POSIX leaves the default stack size implementation-defined,
    // but 8 MiB is the de-facto Linux/glibc RLIMIT_STACK default that mainstream
    // C software (GTK, etc.) is written and tested against, so matching it
    // maximizes portability. Treat it as a floor: callers retain explicit larger
    // requests. This sizes only the main thread; pthreads get their own stacks
    // from musl's __default_stacksize. Cost: at least ~8 MiB of initial linear
    // memory per process (it raises __heap_base 1:1). Keep in sync with the bash
    // wasm32posix-cc. See docs/sdk-guide.md.
    `-Wl,-z,stack-size=${mainThreadStackSizeBytes}`,
    '-Wl,--global-base=1114112',
    '-Wl,--table-base=3',
    '-Wl,--export-table',
    '-Wl,--growable-table',
    '-Wl,--export=__wasm_init_tls',
    '-Wl,--export=__tls_base',
    '-Wl,--export=__tls_size',
    '-Wl,--export=__tls_align',
    '-Wl,--export=__stack_pointer',
    '-Wl,--export=__wasm_thread_init',
    // Pinned so later build stages do not drop the runtime ABI marker the host
    // verifies against. See docs/abi-versioning.md.
    '-Wl,--export=__abi_version',
  ];
}

/** @deprecated Use compileFlags('wasm32') */
export const COMPILE_FLAGS: string[] = compileFlags('wasm32');
/** @deprecated Use linkFlags('wasm32') */
export const LINK_FLAGS: string[] = linkFlags('wasm32');

/** Link flags for building shared Wasm libraries (.so side modules). */
export const SHARED_LINK_FLAGS: string[] = [
  '-nostdlib',
  '-Wl,--experimental-pic',
  '-Wl,--shared',
  '-Wl,--shared-memory',
  '-Wl,--export-all',
  '-Wl,--allow-undefined',
];

const IGNORED_EXACT = new Set([
  '-pthread', '-lpthread',
  '-fPIE', '-pie',
  '-lrt', '-lresolv', '-lm', '-lcrypt', '-lutil',
  '-rdynamic', '-Wl,-Bsymbolic',
  '-Wl,-z,noexecstack', '-Wl,-z,text', '-Wl,-z,relro',
  '-Wl,-z,now', '-Wl,-z,nocopyreloc',
]);

const IGNORED_PREFIXES = [
  '-Wl,-rpath,',
  '-Wl,-rpath-link,',
  '-Wl,-soname,',
  '-Wl,--version-script',
];

const WARN_FLAGS = new Set([
  '-dynamiclib',
]);

function isEquivalentWasmTarget(value: string, arch: WasmArch): boolean {
  return value === targetTriple(arch) ||
    value === `${arch}-unknown-linux-musl` ||
    value === `${arch}-linux-musl`;
}

export interface FilterResult {
  filtered: string[];
  warnings: string[];
}

export function filterArgs(args: string[], arch: WasmArch = 'wasm32'): FilterResult {
  const filtered: string[] = [];
  const warnings: string[] = [];
  const prefix = toolPrefix(arch);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--target=') && isEquivalentWasmTarget(arg.slice('--target='.length), arch)) {
      continue;
    }
    if ((arg === '--target' || arg === '-target') && i + 1 < args.length && isEquivalentWasmTarget(args[i + 1], arch)) {
      i++;
      continue;
    }
    if (IGNORED_EXACT.has(arg)) continue;
    if (IGNORED_PREFIXES.some(p => arg.startsWith(p))) continue;
    if (WARN_FLAGS.has(arg)) {
      warnings.push(`${prefix}-cc: warning: ${arg} is not supported for Wasm targets (ignored)`);
      continue;
    }
    filtered.push(normalizeStackSizeLinkerArg(arg));
  }

  return { filtered, warnings };
}

export interface ParsedArgs {
  compileOnly: boolean;
  preprocessOnly: boolean;
  assemblyOnly: boolean;
  shared: boolean;
  pic: boolean;
  linkDl: boolean;
  threadSlots: number | null;
  outputFile: string | null;
  sourceFiles: string[];
  objectFiles: string[];
  archiveFiles: string[];
  otherArgs: string[];
}

const SOURCE_EXTS = new Set(['.c', '.cc', '.cpp', '.cxx', '.m', '.mm', '.i', '.ii']);
const OBJECT_EXTS = new Set(['.o', '.obj']);
const ARCHIVE_EXTS = new Set(['.a']);

// Flags that consume the next argument as a value (not a file path).
const FLAGS_WITH_VALUE = new Set([
  '-MT', '-MF', '-MQ', '-MJ',
  '-isystem', '-include', '-imacros',
  '-idirafter', '-iprefix', '-iwithprefix', '-iwithprefixbefore',
  '-isysroot',
  '-target', '-arch',
  '-x',
  '-D', '-U', '-I', '-L', '-F',
]);

export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    compileOnly: false,
    preprocessOnly: false,
    assemblyOnly: false,
    shared: false,
    pic: false,
    linkDl: false,
    threadSlots: null,
    outputFile: null,
    sourceFiles: [],
    objectFiles: [],
    archiveFiles: [],
    otherArgs: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-c') {
      result.compileOnly = true;
    } else if (arg === '-shared') {
      result.shared = true;
    } else if (arg === '-fPIC') {
      result.pic = true;
    } else if (arg === '-ldl') {
      result.linkDl = true;
    } else if (arg === '--kandelo-thread-slots' || arg === '--wasm-posix-thread-slots') {
      i++;
      result.threadSlots = parseThreadSlotDeclaration(args[i], arg);
    } else if (arg.startsWith('--kandelo-thread-slots=')) {
      result.threadSlots = parseThreadSlotDeclaration(
        arg.substring('--kandelo-thread-slots='.length),
        '--kandelo-thread-slots',
      );
    } else if (arg.startsWith('--wasm-posix-thread-slots=')) {
      result.threadSlots = parseThreadSlotDeclaration(
        arg.substring('--wasm-posix-thread-slots='.length),
        '--wasm-posix-thread-slots',
      );
    } else if (arg === '-E') {
      result.preprocessOnly = true;
    } else if (arg === '-S') {
      result.assemblyOnly = true;
    } else if (arg === '-o') {
      i++;
      result.outputFile = args[i] ?? null;
    } else if (arg.startsWith('-o') && arg.length > 2) {
      result.outputFile = arg.substring(2);
    } else if (FLAGS_WITH_VALUE.has(arg)) {
      // Flag that takes the next arg as its value — keep both as otherArgs
      result.otherArgs.push(arg);
      i++;
      if (i < args.length) result.otherArgs.push(args[i]);
    } else if (!arg.startsWith('-')) {
      const ext = arg.substring(arg.lastIndexOf('.'));
      if (SOURCE_EXTS.has(ext)) {
        result.sourceFiles.push(arg);
      } else if (OBJECT_EXTS.has(ext)) {
        result.objectFiles.push(arg);
      } else if (ARCHIVE_EXTS.has(ext)) {
        result.archiveFiles.push(arg);
      } else {
        result.otherArgs.push(arg);
      }
    } else {
      result.otherArgs.push(arg);
    }
  }

  return result;
}

export function needsLinking(parsed: ParsedArgs): boolean {
  if (parsed.compileOnly || parsed.preprocessOnly || parsed.assemblyOnly) return false;
  if (parsed.otherArgs.some(arg => arg.startsWith('-Wl,@') || arg.startsWith('@'))) return true;
  return parsed.sourceFiles.length > 0 || parsed.objectFiles.length > 0;
}

export const THREAD_SLOT_USE_HOST_DEFAULT = -1;
export const THREAD_SLOT_NONE = 0;

export function threadSlotDeclarationDefine(value: number): string {
  return `-DWASM_POSIX_THREAD_SLOT_DECL=${value}`;
}

export function parseThreadSlotDeclaration(value: string | undefined, flag: string): number {
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires -1, 0, or a positive integer`);
  }
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${flag} must be -1, 0, or a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < THREAD_SLOT_USE_HOST_DEFAULT) {
    throw new Error(`${flag} must be -1, 0, or a positive integer`);
  }
  return parsed;
}

export interface ThreadSlotInferenceOptions {
  readFile?: (path: string) => string | null;
}

const THREAD_OR_DYNAMIC_PATTERNS = [
  /pthread_create/,
  /thrd_create/,
  /\bclone\s*\(/,
  /std::thread/,
  /#include\s*<thread>/,
  /\bdlopen\b/,
  /__wasm_dlopen/,
];

function rawArgsSuggestThreadsOrDynamicLinking(args: string[]): boolean {
  return args.some((arg) =>
    arg === '-pthread' ||
    arg === '-lpthread' ||
    arg === '-ldl' ||
    arg === '-shared' ||
    arg === '-dynamiclib' ||
    arg === '-rdynamic' ||
    arg.startsWith('-Wl,-rpath') ||
    arg.startsWith('-Wl,-soname') ||
    arg.startsWith('-Wl,--export-dynamic')
  );
}

function hasUncertainLinkInput(parsed: ParsedArgs): boolean {
  if (parsed.objectFiles.length > 0 || parsed.archiveFiles.length > 0) return true;
  return parsed.otherArgs.some((arg) =>
    arg === '-fuse-ld=lld' ||
    arg.startsWith('-l') ||
    arg.startsWith('-Wl,') ||
    arg.startsWith('@')
  );
}

export function inferThreadSlotDeclaration(
  parsed: ParsedArgs,
  rawArgs: string[],
  options: ThreadSlotInferenceOptions = {},
): number {
  if (parsed.threadSlots !== null) return parsed.threadSlots;
  if (parsed.shared || parsed.linkDl) return THREAD_SLOT_USE_HOST_DEFAULT;
  if (rawArgsSuggestThreadsOrDynamicLinking(rawArgs)) return THREAD_SLOT_USE_HOST_DEFAULT;
  if (hasUncertainLinkInput(parsed)) return THREAD_SLOT_USE_HOST_DEFAULT;
  if (parsed.sourceFiles.length === 0) return THREAD_SLOT_USE_HOST_DEFAULT;

  for (const sourceFile of parsed.sourceFiles) {
    const text = options.readFile?.(sourceFile);
    if (text === null || text === undefined) return THREAD_SLOT_USE_HOST_DEFAULT;
    if (THREAD_OR_DYNAMIC_PATTERNS.some((pattern) => pattern.test(text))) {
      return THREAD_SLOT_USE_HOST_DEFAULT;
    }
  }

  return THREAD_SLOT_NONE;
}
