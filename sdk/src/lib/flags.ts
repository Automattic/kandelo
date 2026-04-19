import type { WasmArch } from './arch.ts';
import { targetTriple, toolPrefix } from './arch.ts';

export function compileFlags(arch: WasmArch): string[] {
  return [
    `--target=${targetTriple(arch)}`,
    '-matomics',
    '-mbulk-memory',
    '-mexception-handling',
    '-mllvm', '-wasm-enable-sjlj',
    '-mllvm', '-wasm-use-legacy-eh=true',
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
]);

const IGNORED_PREFIXES = [
  '-Wl,-rpath,',
  '-Wl,-soname,',
  '-Wl,--version-script',
];

const WARN_FLAGS = new Set([
  '-dynamiclib',
]);

export interface FilterResult {
  filtered: string[];
  warnings: string[];
}

export function filterArgs(args: string[], arch: WasmArch = 'wasm32'): FilterResult {
  const filtered: string[] = [];
  const warnings: string[] = [];
  const prefix = toolPrefix(arch);

  for (const arg of args) {
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
  outputFile: string | null;
  sourceFiles: string[];
  objectFiles: string[];
  archiveFiles: string[];
  otherArgs: string[];
}

const SOURCE_EXTS = new Set(['.c', '.cc', '.cpp', '.cxx', '.m', '.mm', '.i', '.ii']);
const OBJECT_EXTS = new Set(['.o']);
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
  return parsed.sourceFiles.length > 0 || parsed.objectFiles.length > 0;
}
