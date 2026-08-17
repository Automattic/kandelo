#!/usr/bin/env -S node --experimental-strip-types
import { readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { resolveLldMajor, resolveToolchain, type Toolchain } from '../lib/toolchain.ts';
import {
  compileFlags,
  DEFAULT_MAIN_THREAD_STACK_SIZE,
  filterArgs,
  inferThreadSlotDeclaration,
  linkFlags,
  mainThreadStackSize,
  MAX_EXECUTABLE_MEMORY_SIZE,
  needsLinking,
  parseArgs,
  SHARED_LINK_FLAGS,
  THREAD_SLOT_USE_HOST_DEFAULT,
  threadSlotDeclarationDefine,
  tokenizeGnuResponseFile,
  type ResponseFileContents,
} from '../lib/flags.ts';
import { run, runPassthrough } from '../lib/exec.ts';
import { isMain } from '../lib/is-main.ts';
import { type WasmArch, detectArch, targetTriple } from '../lib/arch.ts';

const STABLE_SDK_SOURCE_ROOT = '/usr/src/kandelo-sdk';

function sourcePrefixMapFlags(source: string, destination: string): string[] {
  return [
    `-ffile-prefix-map=${source}=${destination}`,
    `-fdebug-prefix-map=${source}=${destination}`,
    `-fmacro-prefix-map=${source}=${destination}`,
  ];
}

function sdkSourcePrefixMapFlags(toolchain: Toolchain, arch: WasmArch): string[] {
  const sysrootName = arch === 'wasm64' ? 'sysroot64' : 'sysroot';
  return [
    ...sourcePrefixMapFlags(toolchain.glueDir, `${STABLE_SDK_SOURCE_ROOT}/libc/glue`),
    ...sourcePrefixMapFlags(toolchain.sysroot, `${STABLE_SDK_SOURCE_ROOT}/${sysrootName}`),
  ];
}

export function decodeLlvmResponseFile(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    if ((buffer.length - 2) % 2 !== 0) throw new Error('odd-length UTF-16LE response file');
    return new TextDecoder('utf-16le', { fatal: true }).decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    if ((buffer.length - 2) % 2 !== 0) throw new Error('odd-length UTF-16BE response file');
    return new TextDecoder('utf-16be', { fatal: true }).decode(buffer.subarray(2));
  }
  return buffer.toString('utf8');
}

function readLlvmResponseFile(
  path: string,
  workingDirectory = process.cwd(),
): ResponseFileContents | null {
  try {
    const resolvedPath = resolve(workingDirectory, path);
    return {
      contents: decodeLlvmResponseFile(readFileSync(resolvedPath)),
      identity: realpathSync(resolvedPath),
    };
  } catch {
    return null;
  }
}

export type LinkerPreparation =
  | { kind: 'no-link' }
  | { kind: 'executable-link'; mainThreadStackSizeBytes: number };

function isPinnedLinker(actualPath: string | undefined, linkerPath: string): boolean {
  if (actualPath === linkerPath) return true;
  if (!actualPath) return false;
  try {
    return realpathSync(actualPath) === realpathSync(linkerPath);
  } catch {
    return false;
  }
}

function isExpectedNonLinkerJob(args: string[]): boolean {
  if (args[1] === '-cc1') return true;
  // Wrapped LLVM installations may schedule Binaryen after wasm-ld. It is a
  // post-link transform, not a second or replacement linker job.
  const executable = basename(args[0] ?? '').replace(/\.exe$/i, '');
  return /^wasm-opt(?:-[0-9]+)?$/.test(executable);
}

function clangTraceCommands(
  trace: string,
  acceptsFirstLine: (args: string[], firstLine: string) => boolean,
): string[] {
  const commands: string[] = [];
  let offset = 0;

  while (offset < trace.length) {
    const physicalLineEnd = trace.indexOf('\n', offset);
    const firstLineEnd = physicalLineEnd === -1 ? trace.length : physicalLineEnd;
    const firstLine = trace.slice(offset, firstLineEnd);
    const firstLineArgs = tokenizeGnuResponseFile(firstLine);
    if (!acceptsFirstLine(firstLineArgs, firstLine)) {
      offset = physicalLineEnd === -1 ? trace.length : physicalLineEnd + 1;
      continue;
    }

    let quote: string | null = null;
    let end = offset;
    for (; end < trace.length; end++) {
      const char = trace[end];
      if (char === '\\' && end + 1 < trace.length) {
        end++;
        continue;
      }
      if (quote !== null) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '\n') break;
    }
    if (quote !== null) {
      throw new Error('clang -### emitted an unterminated quoted command');
    }

    commands.push(trace.slice(offset, end));
    offset = end < trace.length ? end + 1 : end;
  }

  return commands;
}

export function linkerArgsFromClangTrace(trace: string, linkerPath: string): string[] | null {
  const jobs = clangTraceCommands(
    trace,
    (args, firstLine) =>
      /^[\t ]+["']/.test(firstLine) && args[0] !== undefined && isAbsolute(args[0]),
  ).map((line) => tokenizeGnuResponseFile(line));
  if (jobs.length === 0) {
    throw new Error('clang -### emitted no recognizable jobs');
  }

  const matches = jobs.filter((args) => isPinnedLinker(args[0], linkerPath));
  const unexpectedJobs = jobs.filter((args) =>
    !isPinnedLinker(args[0], linkerPath) && !isExpectedNonLinkerJob(args));
  if (matches.length > 1 || unexpectedJobs.length > 0) {
    throw new Error(
      `clang -### emitted ${matches.length} commands for the pinned linker ${linkerPath}; expected exactly one`,
    );
  }
  if (matches.length === 0) {
    if (!jobs.some((args) => args[1] === '-cc1')) {
      throw new Error('clang -### emitted no compiler or pinned linker jobs');
    }
    return null;
  }
  return matches[0].slice(1);
}

export function workingDirectoryFromClangTrace(
  trace: string,
  initialWorkingDirectory = process.cwd(),
): string {
  const tracedDirectories = new Set<string>();

  // The provisional argv always adds absolute glue C sources, so an executable
  // link, including an object-only user link, emits cc1 jobs. Pinned LLVM 21
  // constructs this exact slot by pushing -resource-dir, its value, and then
  // Args.AddLastArg(OPT_working_directory), before preprocessing and -Xclang
  // arguments. This is the effective driver cwd even when a config file or
  // CCC_OVERRIDE_OPTIONS supplied it; debug and coverage metadata are not.
  for (const command of clangTraceCommands(trace, (args) => args.includes('-cc1'))) {
    const args = tokenizeGnuResponseFile(command);
    const resourceDirectoryIndex = args.indexOf('-resource-dir');
    if (resourceDirectoryIndex === -1 || args[resourceDirectoryIndex + 1] === undefined) {
      throw new Error('clang -### cc1 command omitted its driver resource-directory slot');
    }
    const followingIndex = resourceDirectoryIndex + 2;
    if (args[followingIndex] === '-working-directory') {
      const value = args[followingIndex + 1];
      if (value === undefined || value.length === 0) {
        throw new Error('clang -### emitted a malformed driver working-directory slot');
      }
      tracedDirectories.add(resolve(initialWorkingDirectory, value));
    } else if (args[followingIndex]?.startsWith('-working-directory')) {
      throw new Error('clang -### emitted an ambiguous driver working-directory slot');
    } else {
      tracedDirectories.add(resolve(initialWorkingDirectory));
    }
  }
  if (tracedDirectories.size !== 1) {
    throw new Error('clang -### did not emit one consistent driver working directory');
  }
  return tracedDirectories.values().next().value as string;
}

function buildClangArgsInternal(
  userArgs: string[],
  toolchain: Toolchain,
  arch: WasmArch = 'wasm32',
  executableLinker?: LinkerPreparation,
  reportWarnings = true,
  classifyLink = false,
): string[] {
  const { filtered, warnings } = filterArgs(userArgs, arch);
  if (reportWarnings) {
    for (const w of warnings) console.error(w);
  }

  const parsed = parseArgs(filtered);
  const linking = needsLinking(parsed) && executableLinker?.kind !== 'no-link';
  const hasSourceFiles = parsed.sourceFiles.length > 0;

  const args: string[] = [];
  const target = `--target=${targetTriple(arch)}`;

  // Inject compile flags for visible sources and compile-only modes, links
  // that compile glue, and response-hidden compile jobs found by the trace.
  if (
    hasSourceFiles || parsed.compileOnly || parsed.preprocessOnly || parsed.assemblyOnly || linking ||
    executableLinker?.kind === 'no-link'
  ) {
    args.push(...compileFlags(arch));
  }
  // Target is always needed (even for link-only, clang needs to know the target)
  if (!args.includes(target)) {
    args.push(target);
  }
  args.push(`--sysroot=${toolchain.sysroot}`);

  if (parsed.compileOnly) args.push('-c');
  if (parsed.preprocessOnly) args.push('-E');
  if (parsed.assemblyOnly) args.push('-S');
  if (parsed.outputFile) args.push('-o', parsed.outputFile);
  // Static link semantics depend on the caller's exact ordering of objects,
  // archives, -l flags, and linker group controls. Parsed classifications are
  // for SDK decisions only; forwarding must never rebuild the command in
  // type-based buckets.
  args.push(...parsed.forwardedArgs);

  // The SDK compiles its glue sources during each executable link. Keep those
  // files and sysroot headers independent of the checkout used for the build.
  // Append these after caller flags so a broader caller-owned mapping cannot
  // retain a less-specific host path in DWARF.
  if (
    hasSourceFiles || parsed.compileOnly || parsed.preprocessOnly || parsed.assemblyOnly || linking ||
    executableLinker?.kind === 'no-link'
  ) {
    args.push(...sdkSourcePrefixMapFlags(toolchain, arch));
  }

  // -fPIC is consumed by parseArgs (so the linker can see `parsed.pic`),
  // but it must also reach clang at compile time so the resulting object
  // uses PIC relocations. Without this a TU later linked into a shared
  // library produces non-PIC objects and `wasm-ld --shared` rejects them
  // with "R_WASM_MEMORY_ADDR_LEB cannot be used; recompile with -fPIC".
  if (parsed.pic) args.push('-fPIC');

  if (linking) {
    // Keep clang and lld in the same resolved LLVM tree. Without an explicit
    // linker path, clang can pick an unrelated ambient wasm-ld whose defaults
    // differ from the repository-pinned toolchain.
    args.push(`-fuse-ld=${join(toolchain.llvmDir, 'wasm-ld')}`);
    if (classifyLink) return args;
    if (parsed.shared) {
      // Shared library build: no CRT, no libc, no syscall glue
      args.push(...SHARED_LINK_FLAGS);
    } else {
      if (toolchain.lldMajor === null) {
        throw new Error(
          'wasm-ld version is unresolved; call prepareExecutableLinker() before building executable link arguments',
        );
      }
      if (!executableLinker || executableLinker.kind !== 'executable-link') {
        throw new Error(
          'executable linker arguments are unprepared; call prepareExecutableLinker() and pass its result to buildClangArgs()',
        );
      }
      const preparedStackSize = executableLinker.mainThreadStackSizeBytes;
      if (
        !Number.isSafeInteger(preparedStackSize) ||
        preparedStackSize < DEFAULT_MAIN_THREAD_STACK_SIZE ||
        preparedStackSize > MAX_EXECUTABLE_MEMORY_SIZE
      ) {
        throw new Error(
          `prepared main-thread stack size must be an integer from ${DEFAULT_MAIN_THREAD_STACK_SIZE} ` +
          `through ${MAX_EXECUTABLE_MEMORY_SIZE} bytes`,
        );
      }
      // Executable build: link CRT, libc, and syscall glue
      const threadSlots = inferThreadSlotDeclaration(parsed, userArgs, {
        readFile: (path) => {
          try {
            return readFileSync(path, 'utf8');
          } catch {
            return null;
          }
        },
      });
      if (threadSlots !== THREAD_SLOT_USE_HOST_DEFAULT) {
        args.push(threadSlotDeclarationDefine(threadSlots));
      }
      args.push(
        join(toolchain.glueDir, 'channel_syscall.c'),
        join(toolchain.glueDir, 'compiler_rt.c'),
        join(toolchain.glueDir, 'cxxrt.c'),
      );
      if (parsed.linkDl) {
        args.push(join(toolchain.glueDir, 'dlopen.c'));
      }
      args.push(
        join(toolchain.sysroot, 'lib', 'crt1.o'),
        join(toolchain.sysroot, 'lib', 'libc.a'),
        // LLD 22 made --stack-first the default; LLD 21 neither defaults to
        // it nor accepts --no-stack-first. Preserve Kandelo's established
        // stack-after-data layout explicitly only where the option exists.
        ...(toolchain.lldMajor >= 22 ? ['-Wl,--no-stack-first'] : []),
        ...linkFlags(arch, preparedStackSize),
      );
    }
  }

  return args;
}

export function buildClangArgs(
  userArgs: string[],
  toolchain: Toolchain,
  arch: WasmArch = 'wasm32',
  executableLinker?: LinkerPreparation,
): string[] {
  return buildClangArgsInternal(userArgs, toolchain, arch, executableLinker, true);
}

export async function prepareExecutableLinker(
  userArgs: string[],
  toolchain: Toolchain,
  arch: WasmArch = 'wasm32',
  compiler = toolchain.cc,
): Promise<LinkerPreparation | null> {
  const { filtered } = filterArgs(userArgs, arch);
  const parsed = parseArgs(filtered);
  if (!needsLinking(parsed) || parsed.shared) return null;

  const classificationArgs = buildClangArgsInternal(
    userArgs,
    toolchain,
    arch,
    undefined,
    false,
    true,
  );
  const classificationTrace = await run(compiler, ['-###', ...classificationArgs]);
  if (classificationTrace.exitCode !== 0) {
    throw new Error(
      `clang -### failed while classifying the requested jobs:\n${classificationTrace.stderr.trim()}`,
    );
  }
  const linkerPath = join(toolchain.llvmDir, 'wasm-ld');
  const classifiedLinkerArgs = linkerArgsFromClangTrace(classificationTrace.stderr, linkerPath);
  if (classifiedLinkerArgs === null) return { kind: 'no-link' };

  toolchain.lldMajor = await resolveLldMajor(toolchain.llvmDir);
  const provisional = buildClangArgsInternal(userArgs, toolchain, arch, {
    kind: 'executable-link',
    mainThreadStackSizeBytes: DEFAULT_MAIN_THREAD_STACK_SIZE,
  }, false);
  const trace = await run(compiler, ['-###', ...provisional]);
  if (trace.exitCode !== 0) {
    throw new Error(`clang -### failed while preparing the executable link:\n${trace.stderr.trim()}`);
  }

  const linkerArgs = linkerArgsFromClangTrace(trace.stderr, linkerPath);
  if (linkerArgs === null) {
    throw new Error('clang -### omitted the pinned linker from a confirmed executable link');
  }
  let tracedWorkingDirectory: string | undefined;
  return {
    kind: 'executable-link',
    mainThreadStackSizeBytes: mainThreadStackSize(
      linkerArgs,
      (path) => {
        if (!isAbsolute(path)) {
          tracedWorkingDirectory ??= workingDirectoryFromClangTrace(trace.stderr);
        }
        return readLlvmResponseFile(path, tracedWorkingDirectory);
      },
    ),
  };
}

async function main(): Promise<void> {
  const arch = detectArch();
  const toolchain = await resolveToolchain(arch);
  const userArgs = process.argv.slice(2);
  const executableLinker = await prepareExecutableLinker(userArgs, toolchain, arch);
  const args = buildClangArgs(userArgs, toolchain, arch, executableLinker ?? undefined);
  const exitCode = await runPassthrough(toolchain.cc, args);
  process.exit(exitCode);
}

if (isMain(import.meta.url)) main();
