import type { WasmArch } from './arch.ts';
import { targetTriple, toolPrefix } from './arch.ts';

export function compileFlags(arch: WasmArch): string[] {
  return [
    `--target=${targetTriple(arch)}`,
    // LLVM's generic wasm target has no operating-system identity, but
    // Kandelo is a Unix/POSIX userspace.  Publish that source-environment
    // contract through the reserved macros that Unix compilers conventionally
    // predefine.  This keeps upstream feature selection (including SDL's Unix
    // platform headers) truthful without claiming Linux or another host OS.
    '-D__unix__=1',
    '-D__unix=1',
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

export function linkFlags(arch: WasmArch): string[] {
  return [
    '-nostdlib',
    '-Wl,--entry=_start',
    '-Wl,--export=_start',
    '-Wl,--export=__heap_base',
    '-Wl,--import-memory',
    '-Wl,--shared-memory',
    '-Wl,--max-memory=1073741824',
    '-Wl,--allow-undefined',
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
    filtered.push(arg);
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
  /** Arguments forwarded to clang, in the exact order supplied by the caller. */
  forwardedArgs: string[];
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
    forwardedArgs: [],
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
      result.forwardedArgs.push(arg);
      i++;
      if (i < args.length) {
        result.otherArgs.push(args[i]);
        result.forwardedArgs.push(args[i]);
      }
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
      result.forwardedArgs.push(arg);
    } else {
      result.otherArgs.push(arg);
      result.forwardedArgs.push(arg);
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
