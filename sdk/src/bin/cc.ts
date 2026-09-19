#!/usr/bin/env -S node --experimental-strip-types
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { resolveLldMajor, resolveToolchain, type Toolchain } from '../lib/toolchain.ts';
import {
  calltypesPluginFlags,
  compileFlags,
  filterArgs,
  inferThreadSlotDeclaration,
  linkFlags,
  mainThreadStackSize,
  MAX_EXECUTABLE_MEMORY_SIZE,
  needsLinking,
  parseArgs,
  requestsCfi,
  SHARED_LINK_FLAGS,
  hostImportsAllowance,
  THREAD_SLOT_USE_HOST_DEFAULT,
  threadSlotDeclarationDefine,
  tokenizeGnuResponseFile,
  type ResponseFileContents,
} from '../lib/flags.ts';
import { run, runPassthrough } from '../lib/exec.ts';
import {
  CALLTYPES_SECTION,
  ensureCalltypesPlugin,
  importsFunction,
  withCodeHashSection,
  withoutCustomSection,
} from '../lib/calltypes-plugin.ts';
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

const STABLE_BUILD_SOURCE_ROOT = '/usr/src/kandelo-build';

// During a package build the local-build engine sets WASM_POSIX_DEP_WORK_DIR
// to the recipe's per-build work directory. Its absolute path embeds the
// build scratch location AND a process-PID-suffixed component
// (`…/.<pkg>-<cachekey>.work-<pid>-<seq>/recipe-work`), so it varies both with
// the build location and on every rebuild. That path leaks into DWARF,
// `__FILE__`, assertion strings, and similar, making otherwise-pure builds
// differ across build paths and reruns — the determinism check flags exactly
// these (sqlite3, ruby, nethack, dinit, …). Map the work dir to a stable
// destination so binaries stay path-independent. Doing it here, in the one
// wrapper every C/C++ compile flows through, covers each package (and each
// dependency it links) without per-recipe REPRO_FLAGS. Keyed by package name
// for a stable, collision-free destination when one binary links several deps.
//
// Two maps, from least to most specific (a later -ffile-prefix-map wins for an
// overlapping path, matching the SDK-map ordering comment above):
//   1. the source-only cache root — dependency *install* dirs live under it as
//      `<root>/source-only-v1/compiled/programs/<dep>-<key>/…`, and a `-I` to a
//      dep's headers embeds that absolute path (e.g. sqlite3 embeds ncurses's
//      include dir). The `<dep>-<key>` tail is deterministic; only the root
//      varies, so mapping the root is enough — and it must NOT win over the
//      work-dir map, whose path sits under the same root but carries the PID.
//   2. this package's work dir — see above; keyed by name and mapped last so it
//      takes precedence and strips the PID-suffixed component.
function recipeWorkPrefixMapFlags(): string[] {
  const flags: string[] = [];
  const cacheRoot = process.env.WASM_POSIX_SOURCE_ONLY_CACHE_ROOT;
  if (cacheRoot && isAbsolute(cacheRoot)) {
    flags.push(...sourcePrefixMapFlags(cacheRoot, `${STABLE_BUILD_SOURCE_ROOT}-deps`));
  }
  const workDir = process.env.WASM_POSIX_DEP_WORK_DIR;
  if (workDir && isAbsolute(workDir)) {
    const name = process.env.WASM_POSIX_DEP_NAME;
    const destination = name && /^[A-Za-z0-9._+-]+$/.test(name)
      ? `${STABLE_BUILD_SOURCE_ROOT}/${name}`
      : STABLE_BUILD_SOURCE_ROOT;
    flags.push(...sourcePrefixMapFlags(workDir, destination));
  }
  return flags;
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

// Internal-only third variant, never returned by prepareExecutableLinker()
// and never accepted by the public buildClangArgs(). It drives exactly one
// caller: prepareExecutableLinker()'s own provisional trace, built solely to
// discover what the caller actually asked for. That trace must never itself
// inject a stack-size flag — doing so would plant an SDK-authored `-z
// stack-size=` occurrence that sits after (and, since wasm-ld and
// mainThreadStackSize() both resolve repeated occurrences last-one-wins,
// overrides) any real request forwarded from the caller's own args. See
// linkFlags()'s `null` handling in sdk/src/lib/flags.ts.
type InternalLinkerPreparation = LinkerPreparation | { kind: 'measure-only' };

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

/** Link-time libc glue sources, in link order. */
export function glueSources(toolchain: Toolchain, linkDl: boolean): string[] {
  const sources = ['channel_syscall.c', 'compiler_rt.c', 'cxxrt.c'];
  if (linkDl) sources.push('dlopen.c');
  return sources.map((name) => join(toolchain.glueDir, name));
}

/**
 * Compile command for one link-time glue source.
 *
 * The glue (the syscall channel, compiler-rt builtins, the minimal C++
 * runtime, the dlopen loader) is platform code linked into every executable.
 * It used to be compiled as part of the link command, so it inherited that
 * command's optimization level and language: a meson or configure link with
 * no -O flag shipped the syscall path at -O0, and a clang++ link compiled the
 * .c files as C++. Compiling it separately with fixed flags makes every
 * program carry the same glue code regardless of how its build links.
 */
export function buildGlueCompileArgs(
  sources: string[],
  toolchain: Toolchain,
  arch: WasmArch,
  threadSlotDefine: string | null,
): string[] {
  return [
    ...compileFlags(arch),
    // The glue is code of every executable, so its facts must be in the
    // link like any other object's.
    ...(toolchain.calltypesPlugin ? calltypesPluginFlags(toolchain.calltypesPlugin) : []),
    `--sysroot=${toolchain.sysroot}`,
    ...sdkSourcePrefixMapFlags(toolchain, arch),
    ...recipeWorkPrefixMapFlags(),
    ...(threadSlotDefine ? [threadSlotDefine] : []),
    '-O2',
    '-x', 'c',
    '-c', ...sources,
  ];
}

/** The thread-slot declaration an executable link applies to its glue. */
function executableThreadSlotDefine(userArgs: string[], arch: WasmArch): string | null {
  const { filtered } = filterArgs(userArgs, arch);
  const parsed = parseArgs(filtered);
  const threadSlots = inferThreadSlotDeclaration(parsed, userArgs, {
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
  });
  return threadSlots === THREAD_SLOT_USE_HOST_DEFAULT ? null : threadSlotDeclarationDefine(threadSlots);
}

function buildClangArgsInternal(
  userArgs: string[],
  toolchain: Toolchain,
  arch: WasmArch = 'wasm32',
  executableLinker?: InternalLinkerPreparation,
  reportWarnings = true,
  classifyLink = false,
  glueObjects?: string[],
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
  // The call-type facts plugin, for invocations that can run a compile job.
  // A link of objects only has none, and clang would warn that the -Xclang
  // flags went unused.
  const assemblyOnlyInputs = !hasSourceFiles &&
    parsed.otherArgs.some((arg) => /\.(s|S|sx|asm)$/.test(arg) && !arg.startsWith('-'));
  if (
    toolchain.calltypesPlugin && !requestsCfi(filtered) && !parsed.preprocessOnly && !assemblyOnlyInputs &&
    (hasSourceFiles || parsed.compileOnly || parsed.assemblyOnly || executableLinker?.kind === 'no-link')
  ) {
    args.push(...calltypesPluginFlags(toolchain.calltypesPlugin));
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
  const deferExecutableInputs = linking && !classifyLink && !parsed.shared;
  // Static link semantics depend on the caller's exact ordering of objects,
  // archives, -l flags, and linker group controls. Parsed classifications are
  // for SDK decisions only; forwarding must never rebuild the command in
  // type-based buckets. Executable links defer this sequence until after the
  // platform glue and CRT so an explicit -lc cannot resolve musl's syscall
  // definitions before Kandelo's overrides.
  if (!deferExecutableInputs) args.push(...parsed.forwardedArgs);

  // The SDK compiles its glue sources during each executable link. Keep those
  // files and sysroot headers independent of the checkout used for the build.
  // Append these after caller flags so a broader caller-owned mapping cannot
  // retain a less-specific host path in DWARF.
  const sdkCompileArgs = (
    hasSourceFiles || parsed.compileOnly || parsed.preprocessOnly || parsed.assemblyOnly || linking ||
    executableLinker?.kind === 'no-link'
  ) ? [...sdkSourcePrefixMapFlags(toolchain, arch), ...recipeWorkPrefixMapFlags()] : [];

  // -fPIC is consumed by parseArgs (so the linker can see `parsed.pic`),
  // but it must also reach clang at compile time so the resulting object
  // uses PIC relocations. Without this a TU later linked into a shared
  // library produces non-PIC objects and `wasm-ld --shared` rejects them
  // with "R_WASM_MEMORY_ADDR_LEB cannot be used; recompile with -fPIC".
  if (parsed.pic) sdkCompileArgs.push('-fPIC');
  if (!deferExecutableInputs) args.push(...sdkCompileArgs);

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
      if (
        !executableLinker ||
        (executableLinker.kind !== 'executable-link' && executableLinker.kind !== 'measure-only')
      ) {
        throw new Error(
          'executable linker arguments are unprepared; call prepareExecutableLinker() and pass its result to buildClangArgs()',
        );
      }
      // `measure-only` is prepareExecutableLinker()'s own provisional trace
      // (see InternalLinkerPreparation above): pass `null` through to
      // linkFlags() so it omits the stack-size flag entirely rather than
      // injecting a value that would contaminate that trace.
      const preparedStackSize = executableLinker.kind === 'executable-link'
        ? executableLinker.mainThreadStackSizeBytes
        : null;
      if (preparedStackSize !== null) {
        // The 8 MiB floor is applied by mainThreadStackSize() as a DEFAULT
        // when no request is present, not enforced again here — an explicit
        // caller request below the floor is a choice mainThreadStackSize()
        // already honoured (with its own warning), and re-clamping it here
        // would silently reinstate the exact bug this floor stopped being
        // an invariant of. Only integer-ness and the executable memory
        // ceiling are structural requirements of the linker invocation.
        if (!Number.isSafeInteger(preparedStackSize) || preparedStackSize > MAX_EXECUTABLE_MEMORY_SIZE) {
          throw new Error(
            `prepared main-thread stack size must be an integer no greater than ` +
            `${MAX_EXECUTABLE_MEMORY_SIZE} bytes`,
          );
        }
      }
      // Executable build: place platform definitions before caller inputs and
      // leave the final libc archive available for everything still
      // unresolved. This order is also used by the Kandelo-native SDK driver.
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
      args.push(...(glueObjects ?? glueSources(toolchain, parsed.linkDl)));
      args.push(
        join(toolchain.sysroot, 'lib', 'crt1.o'),
        ...parsed.forwardedArgs,
        ...sdkCompileArgs,
        join(toolchain.sysroot, 'lib', 'libc.a'),
        // LLD 22 made --stack-first the default; LLD 21 neither defaults to
        // it nor accepts --no-stack-first. Preserve Kandelo's established
        // stack-after-data layout explicitly only where the option exists.
        ...(toolchain.lldMajor >= 22 ? ['-Wl,--no-stack-first'] : []),
        ...linkFlags(arch, hostImportsAllowance(toolchain.glueDir), preparedStackSize),
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
  glueObjects?: string[],
): string[] {
  return buildClangArgsInternal(userArgs, toolchain, arch, executableLinker, true, false, glueObjects);
}

/**
 * Compile the link-time glue for an executable link into a temporary
 * directory. Returns the objects (in link order) and the directory to remove
 * after linking, or null when this invocation is not an executable link.
 */
export async function compileExecutableGlue(
  userArgs: string[],
  toolchain: Toolchain,
  arch: WasmArch,
  executableLinker: LinkerPreparation | null,
): Promise<{ objects: string[]; dir: string } | null> {
  if (!executableLinker || executableLinker.kind !== 'executable-link') return null;
  const { filtered } = filterArgs(userArgs, arch);
  const parsed = parseArgs(filtered);
  if (parsed.shared) return null;
  const define = executableThreadSlotDefine(userArgs, arch);
  const dir = mkdtempSync(join(tmpdir(), 'kandelo-glue-'));
  const sources = glueSources(toolchain, parsed.linkDl);
  // One compiler process for every glue source: `-c` with several inputs
  // writes <basename>.o files into the working directory.
  const args = buildGlueCompileArgs(sources, toolchain, arch, define);
  const result = await run(toolchain.cc, args, dir);
  if (result.exitCode !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`compiling SDK glue failed:\n${result.stderr.trim()}`);
  }
  const objects = sources.map((source) => join(dir, basename(source).replace(/\.c$/, '.o')));
  return { objects, dir };
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
  // `measure-only`, not a real `executable-link`: this trace exists only to
  // discover what the caller actually asked for (with the same crt1.o/glue
  // shape as the real build, so a cc1 job — and with it a working directory
  // for response-file resolution — is guaranteed even for an object-only
  // link). It must carry no SDK-injected stack-size flag of its own; see
  // InternalLinkerPreparation and linkFlags()'s `null` handling.
  const provisional = buildClangArgsInternal(userArgs, toolchain, arch, {
    kind: 'measure-only',
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

/** The import whose presence makes a module fork-capable (wasm-fork-instrument's default entry). */
export const FORK_ENTRY_IMPORT = { module: 'kernel', field: 'kernel_fork' } as const;

const KEEP_TARGET_FEATURES = '--keep-section=target_features';

function isWasmOptJob(args: string[]): boolean {
  return /^wasm-opt(?:-[0-9]+)?$/.test(basename(args[0] ?? '').replace(/\.exe$/i, ''));
}

/** The jobs of a `clang -###` trace, tokenized. */
function tracedJobs(trace: string): string[][] {
  return clangTraceCommands(
    trace,
    (args, firstLine) => /^[\t ]+["']/.test(firstLine) && args[0] !== undefined && isAbsolute(args[0]),
  ).map((line) => tokenizeGnuResponseFile(line));
}

function withoutOne(args: string[], value: string): string[] {
  const index = args.indexOf(value);
  return index === -1 ? args : [...args.slice(0, index), ...args.slice(index + 1)];
}

/**
 * The traced wasm-ld argv with the compile jobs' temporary objects (random
 * names, different in every trace) replaced by their job order, so two
 * traces of one command compare equal.
 */
function comparableLinker(jobs: string[][], linker: string[]): string[] {
  const temporaries = new Map<string, string>();
  for (const job of jobs) {
    if (job[1] !== '-cc1') continue;
    const index = job.indexOf('-o');
    if (index !== -1 && job[index + 1] !== undefined) temporaries.set(job[index + 1], `<compile-job-${temporaries.size}>`);
  }
  return withoutOne(linker, KEEP_TARGET_FEATURES).map((arg) => temporaries.get(arg) ?? arg);
}

/**
 * Does the linked module import the fork entry? Such a link skips clang's
 * scheduled post-link wasm-opt and keeps its facts.
 *
 * WHY: a fork-capable module is instrumented next, and the instrumenter
 * analyses it with the per-function facts in its `kandelo.calltypes`
 * section. Binaryen's inlining would move call sites between functions and
 * make those facts describe the wrong functions, so the module must reach
 * the instrumenter as wasm-ld wrote it. The instrumenter runs wasm-opt
 * itself after instrumenting (wasm-fork-instrument --post-optimize). Any
 * other module needs no facts: it loses the section and gets exactly the
 * optimization clang would have run.
 */
export function isForkCapable(module: Uint8Array): boolean {
  return importsFunction(module, FORK_ENTRY_IMPORT.module, FORK_ENTRY_IMPORT.field);
}

/**
 * Run the compiler driver. Compile-only invocations pass straight through.
 * A link is run with clang's post-link wasm-opt (if clang schedules one)
 * held back, then finished per isForkCapable().
 */
export async function runCompilerDriver(compiler: string, args: string[], linking: boolean): Promise<number> {
  if (!linking || args.includes('-###')) return runPassthrough(compiler, args);
  const trace = await run(compiler, ['-###', ...args]);
  // A failing trace is a failing command: let the real run report it.
  if (trace.exitCode !== 0) return runPassthrough(compiler, args);
  const jobs = tracedJobs(trace.stderr);
  const wasmOpt = jobs.filter(isWasmOptJob);
  const linkers = jobs.filter((job) => basename(job[0]).replace(/\.exe$/i, '') === 'wasm-ld');
  // Anything else would leave facts in a module that must not carry them,
  // or optimize one that must reach the instrumenter unoptimized.
  if (linkers.length !== 1 || wasmOpt.length > 1) {
    throw new Error(
      `clang -### emitted ${linkers.length} wasm-ld and ${wasmOpt.length} wasm-opt jobs for a link; expected one and at most one`,
    );
  }
  const linker = linkers[0];
  const outputIndex = linker.indexOf('-o');
  if (outputIndex === -1 || linker[outputIndex + 1] === undefined) {
    throw new Error('clang -### emitted a wasm-ld job without an output');
  }
  let workingDirectory = process.cwd();
  try {
    workingDirectory = workingDirectoryFromClangTrace(trace.stderr);
  } catch {
    // A link with no compile jobs: the driver runs in this directory.
  }
  const output = resolve(workingDirectory, linker[outputIndex + 1]);

  // `--no-wasm-opt` also drops the target_features section clang keeps for
  // wasm-opt to read; keep it explicitly so the link itself is unchanged.
  // Prove that against clang's own trace rather than assume it.
  const linkArgs = wasmOpt.length === 1 ? [...args, '--no-wasm-opt', `-Wl,${KEEP_TARGET_FEATURES}`] : args;
  if (wasmOpt.length === 1) {
    const heldBack = await run(compiler, ['-###', ...linkArgs]);
    const heldBackJobs = heldBack.exitCode === 0 ? tracedJobs(heldBack.stderr) : [];
    const heldBackLinker = heldBackJobs.filter((job) => basename(job[0]).replace(/\.exe$/i, '') === 'wasm-ld');
    if (
      heldBackJobs.some(isWasmOptJob) || heldBackLinker.length !== 1 ||
      JSON.stringify(comparableLinker(heldBackJobs, heldBackLinker[0])) !==
        JSON.stringify(comparableLinker(jobs, linker))
    ) {
      throw new Error('clang changed the wasm-ld command when its post-link wasm-opt was held back');
    }
  }
  const exitCode = await runPassthrough(compiler, linkArgs);
  if (exitCode !== 0) return exitCode;

  let module: Uint8Array | null = null;
  try {
    module = readFileSync(output);
  } catch {
    // No readable output (e.g. -o /dev/null on some hosts): nothing to inspect.
  }
  const isWasm = module !== null && module.length >= 8 && module[0] === 0 && module[1] === 0x61;
  if (isWasm && isForkCapable(module!)) {
    writeFileSync(output, withCodeHashSection(module!));
    return 0;
  }
  if (isWasm) {
    const stripped = withoutCustomSection(module!, CALLTYPES_SECTION);
    if (stripped !== module) writeFileSync(output, stripped);
  }
  if (wasmOpt.length === 1) return runPassthrough(wasmOpt[0][0], wasmOpt[0].slice(1));
  return 0;
}

/** Does this invocation compile anything (and so need the facts plugin)? */
export function mayCompile(userArgs: string[], arch: WasmArch): boolean {
  const parsed = parseArgs(filterArgs(userArgs, arch).filtered);
  return parsed.sourceFiles.length > 0 || parsed.compileOnly || parsed.assemblyOnly || needsLinking(parsed);
}

/** Shared entry of wasm{32,64}posix-cc and -c++. */
export async function compilerMain(selectCompiler: (toolchain: Toolchain) => string): Promise<never> {
  const arch = detectArch();
  const toolchain = await resolveToolchain(arch);
  const compiler = selectCompiler(toolchain);
  const userArgs = process.argv.slice(2);
  if (mayCompile(userArgs, arch)) toolchain.calltypesPlugin = await ensureCalltypesPlugin(toolchain.cc);
  const executableLinker = await prepareExecutableLinker(userArgs, toolchain, arch, compiler);
  const glue = await compileExecutableGlue(userArgs, toolchain, arch, executableLinker);
  const args = buildClangArgs(userArgs, toolchain, arch, executableLinker ?? undefined, glue?.objects);
  const { filtered } = filterArgs(userArgs, arch);
  const linking = needsLinking(parseArgs(filtered)) && executableLinker?.kind !== 'no-link';
  let exitCode: number;
  try {
    exitCode = await runCompilerDriver(compiler, args, linking);
  } finally {
    if (glue) rmSync(glue.dir, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

async function main(): Promise<void> {
  await compilerMain((toolchain) => toolchain.cc);
}

if (isMain(import.meta.url)) main();
