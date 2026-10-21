import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, unlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(SDK_ROOT, '..');
const TMP_DIR = join(SDK_ROOT, '.test-tmp');

// The SDK's tools as users and package builds run them: the wrapper
// executables, which run this worktree's driver (crates/kandelo-cc).
const CC = join(SDK_ROOT, 'bin', 'wasm32posix-cc');
const CXX = join(SDK_ROOT, 'bin', 'wasm32posix-c++');
const AR = join(SDK_ROOT, 'bin', 'wasm32posix-ar');

/**
 * Find the main repo root. In a worktree, REPO_ROOT is the worktree dir,
 * but sysroot/libc/glue live in the main checkout. Use git to find it.
 */
function findMainRepoRoot(): string {
  try {
    const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
    // gitCommonDir is the .git dir of the main repo (absolute or relative)
    const absGitDir = resolve(REPO_ROOT, gitCommonDir);
    // Main repo root is the parent of .git
    return resolve(absGitDir, '..');
  } catch {
    return REPO_ROOT;
  }
}

beforeAll(() => {
  // If sysroot isn't in the worktree, use the main repo's. The driver
  // honours the same WASM_POSIX_* overrides, and every SDK tool below
  // inherits this environment.
  if (!existsSync(join(REPO_ROOT, 'sysroot', 'lib', 'libc.a'))) {
    const mainRepo = findMainRepoRoot();
    if (existsSync(join(mainRepo, 'sysroot', 'lib', 'libc.a'))) {
      process.env.WASM_POSIX_SYSROOT = join(mainRepo, 'sysroot');
      const mainGlue = join(mainRepo, 'libc', 'glue');
      if (existsSync(join(mainGlue, 'abi_constants.h'))) {
        process.env.WASM_POSIX_GLUE_DIR = mainGlue;
      }
    }
  }
});

/**
 * The LLVM bin directory the driver resolves: WASM_POSIX_LLVM_DIR, else the
 * dev shell's LLVM_BIN (find_llvm_dir in crates/kandelo-cc/src/toolchain.rs).
 */
function llvmDir(): string {
  const dir = process.env.WASM_POSIX_LLVM_DIR || process.env.LLVM_BIN;
  if (!dir) {
    throw new Error('neither WASM_POSIX_LLVM_DIR nor LLVM_BIN is set; run these tests inside scripts/dev-shell.sh');
  }
  return dir;
}

/**
 * The sysroot and glue the driver resolves when it runs inside this
 * checkout: the WASM_POSIX_* overrides, else the repository layout
 * (find_sysroot and find_glue_dir in crates/kandelo-cc/src/toolchain.rs).
 */
function sysroot(): string {
  return process.env.WASM_POSIX_SYSROOT || join(REPO_ROOT, 'sysroot');
}

function glueDir(): string {
  return process.env.WASM_POSIX_GLUE_DIR || join(REPO_ROOT, 'libc', 'glue');
}

interface ToolResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run an SDK tool. The default working directory is the SDK directory,
 * inside this checkout, so the driver discovers this checkout's sysroot
 * and glue.
 */
function sdk(
  tool: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ToolResult {
  const result = spawnSync(tool, args, {
    cwd: options.cwd ?? SDK_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * The jobs of a `-###` trace. `wasm32posix-cc -###` prepares the link as a
 * real build would and then passes the trace through, so clang prints each
 * job it would run as an indented line of double-quoted, backslash-escaped
 * arguments.
 */
function tracedJobs(trace: string): string[][] {
  return trace
    .split('\n')
    .filter((line) => line.startsWith(' "'))
    .map((line) => [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((match) => match[1].replace(/\\(.)/g, '$1')));
}

function isLinkerJob(job: string[]): boolean {
  return basename(job[0]) === 'wasm-ld';
}

/** The one wasm-ld argv of a traced link. */
function tracedLinker(trace: string): string[] {
  const linkers = tracedJobs(trace).filter(isLinkerJob);
  expect(linkers, trace).toHaveLength(1);
  return linkers[0];
}

/**
 * The main-thread stack size a wasm-ld argv requests: the last
 * `-z stack-size=` operand, as wasm-ld resolves repeated ones.
 */
function linkedStackSize(linkerArgs: string[]): number | undefined {
  let size: number | undefined;
  for (let index = 0; index < linkerArgs.length; index++) {
    const arg = linkerArgs[index];
    const value = arg === '-z'
      ? linkerArgs[index + 1]?.match(/^stack-size=(\d+)$/)?.[1]
      : arg.match(/^-zstack-size=(\d+)$/)?.[1];
    if (value !== undefined) size = Number(value);
  }
  return size;
}

describe('integration: compile C program', () => {
  it('pins the complete wasm32 pointer-sized autoconf types', () => {
    const site = readFileSync(join(SDK_ROOT, 'config.site'), 'utf8');

    expect(site).toContain('ac_cv_sizeof_intmax_t=${ac_cv_sizeof_intmax_t=8}');
    expect(site).toContain('ac_cv_sizeof_ssize_t=${ac_cv_sizeof_ssize_t=4}');
    expect(site).toContain('ac_cv_sizeof_ptrdiff_t=${ac_cv_sizeof_ptrdiff_t=4}');
    expect(site).toContain('php_cv_sizeof_intmax_t=${php_cv_sizeof_intmax_t=8}');
    expect(site).toContain('php_cv_sizeof_ssize_t=${php_cv_sizeof_ssize_t=4}');
    expect(site).toContain('php_cv_sizeof_ptrdiff_t=${php_cv_sizeof_ptrdiff_t=4}');
    expect(site).toContain('ac_cv_sizeof_fpos_t=${ac_cv_sizeof_fpos_t=16}');
    expect(site).toContain('ac_cv_alignof_max_align_t=${ac_cv_alignof_max_align_t=16}');
    expect(site).toContain('php_cv_sizeof_ssize_t=${php_cv_sizeof_ssize_t=8}');
    expect(site).toContain('php_cv_sizeof_ptrdiff_t=${php_cv_sizeof_ptrdiff_t=8}');
  });

  it('pins clang to the resolved wasm-ld', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const srcFile = join(TMP_DIR, 'linker-probe.c');
    const outFile = join(TMP_DIR, 'linker-probe.wasm');
    writeFileSync(srcFile, 'int main(void) { return 0; }\n');

    try {
      const result = sdk(CC, ['-###', srcFile, '-o', outFile]);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toContain(join(llvmDir(), 'wasm-ld'));
      expect(tracedLinker(result.stderr)[0]).toBe(join(llvmDir(), 'wasm-ld'));
    } finally {
      try { unlinkSync(srcFile); } catch {}
      try { unlinkSync(outFile); } catch {}
    }
  }, 60_000);

  it('preserves Clang non-linking modes directly and through response files', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const source = join(TMP_DIR, 'non-link-mode.c');
    const modes = [
      ['syntax-only', '-fsyntax-only'],
      ['dependencies', '-M'],
      ['user-dependencies', '-MM'],
      ['analyze', '--analyze'],
    ] as const;
    const responses = modes.map(([name]) => join(TMP_DIR, `non-link-${name}.rsp`));
    const outputs = modes.flatMap(([name]) => [
      join(TMP_DIR, `non-link-${name}-direct.out`),
      join(TMP_DIR, `non-link-${name}-response.out`),
    ]);
    // The SDK tools run in SDK_ROOT, so an analyzer job that lost its -o
    // would leave its report here.
    const sourceTreeAnalyzerOutput = join(SDK_ROOT, 'non-link-mode.plist');
    writeFileSync(source, 'int square(int value) { return value * value; }\n');
    expect(existsSync(sourceTreeAnalyzerOutput)).toBe(false);

    try {
      for (let index = 0; index < modes.length; index++) {
        const [, mode] = modes[index];
        const directOutput = outputs[index * 2];
        const responseOutput = outputs[index * 2 + 1];
        writeFileSync(
          responses[index],
          `${mode} "${source}" -o "${responseOutput}"\n`,
        );
        for (const userArgs of [
          [mode, source, '-o', directOutput],
          [`@${responses[index]}`],
        ]) {
          // A response file hides the mode from the SDK's own parse, so
          // prepare_executable_linker must classify it through clang as a
          // no-link command. The trace shows the jobs the driver would run:
          // no wasm-ld job, no pinned linker (clang names an injected but
          // unused -fuse-ld in a warning), and no link-time glue.
          const traced = sdk(CC, ['-###', ...userArgs]);
          expect(traced.exitCode, traced.stderr).toBe(0);
          expect(tracedJobs(traced.stderr).some(isLinkerJob), traced.stderr).toBe(false);
          expect(traced.stderr).not.toContain(`-fuse-ld=${join(llvmDir(), 'wasm-ld')}`);
          expect(traced.stderr).not.toContain('channel_syscall');

          const result = sdk(CC, userArgs);
          expect(result.exitCode, result.stderr).toBe(0);
        }
      }
      expect(existsSync(sourceTreeAnalyzerOutput)).toBe(false);
    } finally {
      try { unlinkSync(source); } catch {}
      for (const path of [...responses, ...outputs]) {
        try { unlinkSync(path); } catch {}
      }
    }
  }, 120_000);

  it('retains larger stacks across non-intervening options and UTF-16 responses', () => {
    mkdirSync(TMP_DIR, { recursive: true });
    const source = join(TMP_DIR, 'stack-floor-probe.c');
    const newlineSource = join(TMP_DIR, 'stack-floor-\nprobe.c');
    const newlineOutput = join(TMP_DIR, 'stack-floor-newline-path.wasm');
    const pchSource = join(TMP_DIR, 'stack-floor-prefix.c');
    const pch = join(TMP_DIR, 'stack-floor-prefix.pch');
    const object = join(TMP_DIR, 'stack-floor-probe.o');
    const driverResponse = join(TMP_DIR, 'stack-floor-driver.rsp');
    const objectOutput = join(TMP_DIR, 'stack-floor-object-only.wasm');
    const debugDirectoryOutput = join(TMP_DIR, 'stack-floor-debug-directory.wasm');
    const fileDirectoryOutput = join(TMP_DIR, 'stack-floor-file-directory.wasm');
    const configuredDirectoryOutput = join(TMP_DIR, 'stack-floor-configured-directory.wasm');
    const xclangOutput = join(TMP_DIR, 'stack-floor-xclang-working-directory.wasm');
    const compilationDirectoryConfig = join(TMP_DIR, 'stack-floor-compilation-dir.cfg');
    const workingDirectoryConfig = join(TMP_DIR, 'stack-floor-working-dir.cfg');
    const configuredWorkingDirectoryOutput = join(TMP_DIR, 'stack-floor-configured-cwd.wasm');
    const deepResponseOutput = join(TMP_DIR, 'stack-floor-deep-response.wasm');
    const deepResponses = Array.from({ length: 100 }, (_, index) =>
      join(TMP_DIR, `stack-floor-deep-${index}.rsp`));
    const floorOutput = join(TMP_DIR, 'stack-floor-default.wasm');
    const responseOutput = join(TMP_DIR, 'stack-floor-utf16-response.wasm');
    const response = join(TMP_DIR, 'stack-floor-utf16.rsp');
    const variants = [
      ['optimization', '-O2', '-g', '-fvisibility=hidden', '-L', TMP_DIR, '-static'],
      ['iquote', '-iquote', TMP_DIR],
      ['include-pch', '-include-pch', pch],
      ['iframework', '-iframework', TMP_DIR],
      ['working-directory', '-working-directory', TMP_DIR],
    ];
    const variantOutputs = variants.map(([name]) =>
      join(TMP_DIR, `stack-floor-${name}.wasm`));
    const paths = [
      source, newlineSource, newlineOutput, pchSource, pch, object,
      driverResponse, objectOutput, debugDirectoryOutput, fileDirectoryOutput,
      configuredDirectoryOutput, xclangOutput, compilationDirectoryConfig,
      workingDirectoryConfig, configuredWorkingDirectoryOutput,
      deepResponseOutput, ...deepResponses,
      floorOutput, responseOutput, response,
      ...variantOutputs,
    ];
    writeFileSync(source, 'int main(void) { return 0; }\n');
    if (process.platform !== 'win32') {
      writeFileSync(newlineSource, 'int main(void) { return 0; }\n');
    }
    writeFileSync(pchSource, '#define KANDELO_STACK_FLOOR_TEST 1\n');
    writeFileSync(response, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('-z\nstack-size=16777216\n', 'utf16le'),
    ]));
    writeFileSync(
      driverResponse,
      `-working-directory "${TMP_DIR}" -Wl,@${basename(response)}\n`,
    );
    writeFileSync(
      compilationDirectoryConfig,
      '-ffile-compilation-dir=/unrelated\n',
    );
    writeFileSync(
      workingDirectoryConfig,
      `-working-directory=${TMP_DIR}\n`,
    );
    for (let index = 0; index < deepResponses.length; index++) {
      writeFileSync(
        deepResponses[index],
        index === deepResponses.length - 1
          ? '-z stack-size=16777216\n'
          : `@${basename(deepResponses[index + 1])}\n`,
      );
    }

    const link = (userArgs: string[]): void => {
      const result = sdk(CC, userArgs);
      expect(result.exitCode, result.stderr).toBe(0);
    };
    const stackPointer = (path: string): number => {
      const dump = execFileSync('wasm-objdump', ['-x', path], { encoding: 'utf8' });
      const match = dump.match(/<__stack_pointer> - init i32=(\d+)/);
      expect(match, dump).not.toBeNull();
      return Number(match?.[1]);
    };

    try {
      const pchResult = sdk(CC, ['-c', '-x', 'c-header', pchSource, '-o', pch]);
      expect(pchResult.exitCode, pchResult.stderr).toBe(0);
      const objectResult = sdk(CC, ['-c', source, '-o', object]);
      expect(objectResult.exitCode, objectResult.stderr).toBe(0);

      link([source, '-o', floorOutput]);
      for (let index = 0; index < variants.length; index++) {
        const [, ...options] = variants[index];
        link([
          source, '-Wl,-z', ...options,
          '-Wl,stack-size=16777216', '-o', variantOutputs[index],
        ]);
      }
      link([
        source, '-working-directory', TMP_DIR,
        `-Wl,@${basename(response)}`, '-o', responseOutput,
      ]);
      link([object, `@${driverResponse}`, '-o', objectOutput]);
      link([
        source, '-working-directory', TMP_DIR,
        '-fdebug-compilation-dir=/unrelated',
        `-Wl,@${basename(response)}`, '-o', debugDirectoryOutput,
      ]);
      link([
        source, '-working-directory', TMP_DIR,
        '-ffile-compilation-dir=/unrelated',
        `-Wl,@${basename(response)}`, '-o', fileDirectoryOutput,
      ]);
      link([
        source, '-working-directory', TMP_DIR,
        `--config=${compilationDirectoryConfig}`,
        `-Wl,@${basename(response)}`, '-o', configuredDirectoryOutput,
      ]);
      link([
        source, '-working-directory', TMP_DIR,
        '-Xclang', '-working-directory', '-Xclang', SDK_ROOT,
        `-Wl,@${basename(response)}`, '-o', xclangOutput,
      ]);
      link([
        source, `--config=${workingDirectoryConfig}`,
        `-Wl,@${basename(response)}`, '-o', configuredWorkingDirectoryOutput,
      ]);
      link([
        source, '-working-directory', TMP_DIR,
        `-Wl,@${basename(deepResponses[0])}`, '-o', deepResponseOutput,
      ]);
      if (process.platform !== 'win32') {
        link([
          newlineSource, '-Wl,-z', '-Wl,stack-size=16777216',
          '-o', newlineOutput,
        ]);
      }

      const floorStackPointer = stackPointer(floorOutput);
      const largeStackPointer = stackPointer(variantOutputs[0]);
      expect(largeStackPointer - floorStackPointer).toBe(8 * 1024 * 1024);
      for (const output of variantOutputs) {
        expect(stackPointer(output)).toBe(largeStackPointer);
      }
      expect(stackPointer(responseOutput)).toBe(largeStackPointer);
      expect(stackPointer(objectOutput)).toBe(largeStackPointer);
      expect(stackPointer(debugDirectoryOutput)).toBe(largeStackPointer);
      expect(stackPointer(fileDirectoryOutput)).toBe(largeStackPointer);
      expect(stackPointer(configuredDirectoryOutput)).toBe(largeStackPointer);
      expect(stackPointer(xclangOutput)).toBe(largeStackPointer);
      expect(stackPointer(configuredWorkingDirectoryOutput)).toBe(largeStackPointer);
      expect(stackPointer(deepResponseOutput)).toBe(largeStackPointer);
      if (process.platform !== 'win32') {
        expect(stackPointer(newlineOutput)).toBe(largeStackPointer);
      }
    } finally {
      for (const path of paths) {
        try { unlinkSync(path); } catch {}
      }
    }
  }, 300_000);

  it('retains a larger stack when CCC_OVERRIDE_OPTIONS sets the working directory', () => {
    // The driver resolves a relative response file against the working
    // directory clang itself uses, which CCC_OVERRIDE_OPTIONS can set. The
    // variable reaches every clang the driver runs, so this runs on its own:
    // a failure here names the environment case instead of hiding the rest
    // of the stack-floor cases behind it.
    mkdirSync(TMP_DIR, { recursive: true });
    const source = join(TMP_DIR, 'stack-override-probe.c');
    const response = join(TMP_DIR, 'stack-override-utf16.rsp');
    const floorOutput = join(TMP_DIR, 'stack-override-default.wasm');
    const environmentWorkingDirectoryOutput = join(TMP_DIR, 'stack-override-environment-cwd.wasm');
    writeFileSync(source, 'int main(void) { return 0; }\n');
    writeFileSync(response, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('-z\nstack-size=16777216\n', 'utf16le'),
    ]));
    const stackPointer = (path: string): number => {
      const dump = execFileSync('wasm-objdump', ['-x', path], { encoding: 'utf8' });
      const match = dump.match(/<__stack_pointer> - init i32=(\d+)/);
      expect(match, dump).not.toBeNull();
      return Number(match?.[1]);
    };

    try {
      const floor = sdk(CC, [source, '-o', floorOutput]);
      expect(floor.exitCode, floor.stderr).toBe(0);
      const result = sdk(CC, [
        source, `-Wl,@${basename(response)}`,
        '-o', environmentWorkingDirectoryOutput,
      ], { env: { ...process.env, CCC_OVERRIDE_OPTIONS: `+-working-directory=${TMP_DIR}` } });
      expect(result.exitCode, result.stderr).toBe(0);

      expect(stackPointer(environmentWorkingDirectoryOutput) - stackPointer(floorOutput))
        .toBe(8 * 1024 * 1024);
    } finally {
      for (const path of [source, response, floorOutput, environmentWorkingDirectoryOutput]) {
        try { unlinkSync(path); } catch {}
      }
    }
  }, 120_000);

  it('honours an explicit sub-floor stack through the real wasm32posix-cc path, and warns', () => {
    // This is the end-to-end level for the defect that changing
    // main_thread_stack_size()'s resolution surfaced: prepare_executable_linker()
    // (crates/kandelo-cc/src/driver.rs) used to build its own provisional
    // Clang trace with a placeholder `-z stack-size=<default>` appended AFTER
    // the caller's forwarded args, to discover what the caller asked for.
    // Under main_thread_stack_size()'s last-wins resolution
    // (crates/kandelo-cc/src/flags.rs, matching wasm-ld's own behaviour for
    // repeated `-z stack-size=` operands), that placeholder always won,
    // silently overriding every explicit request — larger or smaller — back
    // down to the default. A unit test on main_thread_stack_size() alone
    // cannot see this: the contamination is introduced one layer up, in how
    // the driver assembles the trace it measures. This test drives the real
    // wasm32posix-cc driver: its `-###` trace shows the stack size the
    // prepared link hands wasm-ld, and a real link shows the binary gets it,
    // so it fails the same way a real build would if the contamination came
    // back.
    mkdirSync(TMP_DIR, { recursive: true });
    const source = join(TMP_DIR, 'stack-sub-floor.c');
    const floorOutput = join(TMP_DIR, 'stack-sub-floor-default.wasm');
    const subFloorOutput = join(TMP_DIR, 'stack-sub-floor-explicit.wasm');
    const subFloorArgs = [source, '-Wl,-z,stack-size=65536', '-o', subFloorOutput];
    writeFileSync(source, 'int main(void) { return 0; }\n');

    const stackPointer = (path: string): number => {
      const dump = execFileSync('wasm-objdump', ['-x', path], { encoding: 'utf8' });
      const match = dump.match(/<__stack_pointer> - init i32=(\d+)/);
      expect(match, dump).not.toBeNull();
      return Number(match?.[1]);
    };

    try {
      const floor = sdk(CC, [source, '-o', floorOutput]);
      expect(floor.exitCode, floor.stderr).toBe(0);

      // The prepared link's main-thread stack size is the SDK's own
      // `-z stack-size=`, placed after the caller's and so the one wasm-ld
      // uses.
      const traced = sdk(CC, ['-###', ...subFloorArgs]);
      expect(traced.exitCode, traced.stderr).toBe(0);
      expect(linkedStackSize(tracedLinker(traced.stderr))).toBe(65536);

      // The real link carries no trace, so its stderr is the driver's own
      // diagnostics.
      const result = sdk(CC, subFloorArgs);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toMatch(/stack-size=65536/);
      expect(result.stderr).toMatch(/\.bss|guard page|corrupt/i);

      const floorStackPointer = stackPointer(floorOutput);
      const subFloorStackPointer = stackPointer(subFloorOutput);
      expect(floorStackPointer - subFloorStackPointer).toBe(8 * 1024 * 1024 - 65536);
    } finally {
      for (const path of [source, floorOutput, subFloorOutput]) {
        try { unlinkSync(path); } catch {}
      }
    }
  }, 120_000);

  it('compiles a hello world program to .wasm', () => {
    mkdirSync(TMP_DIR, { recursive: true });

    const srcFile = join(TMP_DIR, 'hello.c');
    const outFile = join(TMP_DIR, 'hello.wasm');

    writeFileSync(srcFile, `
      #include <stdio.h>
      int main(void) {
        printf("hello from wasm\\n");
        return 0;
      }
    `);

    const result = sdk(CC, [srcFile, '-o', outFile]);

    if (result.exitCode !== 0) {
      console.error('wasm32posix-cc stderr:', result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);

    // Clean up
    try { unlinkSync(srcFile); } catch {}
    try { unlinkSync(outFile); } catch {}
  }, 60_000);

  it('keeps SDK checkout paths out of linked debug information', () => {
    mkdirSync(TMP_DIR, { recursive: true });

    const srcFile = join(TMP_DIR, 'debug-paths.c');
    const outFile = join(TMP_DIR, 'debug-paths.wasm');
    // The local's FILE type is declared in a sysroot header, so the
    // program's own DWARF names that header's directory.
    writeFileSync(
      srcFile,
      '#include <stdio.h>\nint main(void) { FILE *stream = stdout; return fputs("debug paths\\n", stream); }\n',
    );

    try {
      const result = sdk(CC, ['-g', srcFile, '-o', outFile]);
      if (result.exitCode !== 0) {
        console.error('wasm32posix-cc stderr:', result.stderr);
      }
      expect(result.exitCode).toBe(0);

      // The glue is compiled apart from the caller's command with fixed
      // flags and no -g (build_glue_compile_args in
      // crates/kandelo-cc/src/driver.rs), so it contributes no DWARF to
      // map; it must still leave no checkout path behind.
      const artifact = readFileSync(outFile);
      expect(artifact.includes(Buffer.from(glueDir()))).toBe(false);
      expect(artifact.includes(Buffer.from(sysroot()))).toBe(false);
      expect(artifact.includes(Buffer.from('/usr/src/kandelo-sdk/sysroot'))).toBe(true);
    } finally {
      try { unlinkSync(srcFile); } catch {}
      try { unlinkSync(outFile); } catch {}
    }
  }, 60_000);

  it('maps sysroot paths in compile-only debug information', () => {
    mkdirSync(TMP_DIR, { recursive: true });

    const srcFile = join(TMP_DIR, 'compile-debug-paths.c');
    const outFile = join(TMP_DIR, 'compile-debug-paths.o');
    const syntheticHeader = join(sysroot(), 'include', 'debug-paths.h');
    writeFileSync(
      srcFile,
      `#line 1 ${JSON.stringify(syntheticHeader)}\nconst char *debug_path = __FILE__;\n`,
    );

    try {
      const result = sdk(CC, ['-g', '-c', srcFile, '-o', outFile]);
      if (result.exitCode !== 0) {
        console.error('wasm32posix-cc stderr:', result.stderr);
      }
      expect(result.exitCode).toBe(0);

      const artifact = readFileSync(outFile);
      expect(artifact.includes(Buffer.from(sysroot()))).toBe(false);
      expect(artifact.includes(Buffer.from('/usr/src/kandelo-sdk/sysroot/include/debug-paths.h'))).toBe(true);
    } finally {
      try { unlinkSync(srcFile); } catch {}
      try { unlinkSync(outFile); } catch {}
    }
  }, 60_000);

  it('links timer_create without fictional raw setjmp imports', () => {
    mkdirSync(TMP_DIR, { recursive: true });

    const srcFile = join(TMP_DIR, 'timer-create.c');
    const outFile = join(TMP_DIR, 'timer-create.wasm');
    writeFileSync(srcFile, `
      #include <signal.h>
      #include <time.h>

      int main(void) {
        struct sigevent event = {0};
        timer_t timer;
        event.sigev_notify = SIGEV_SIGNAL;
        event.sigev_signo = SIGALRM;
        return timer_create(CLOCK_MONOTONIC, &event, &timer);
      }
    `);

    try {
      const result = sdk(CC, [srcFile, '-o', outFile]);
      if (result.exitCode !== 0) {
        console.error('wasm32posix-cc stderr:', result.stderr);
      }
      expect(result.exitCode).toBe(0);

      const module = new WebAssembly.Module(readFileSync(outFile));
      const envImports = WebAssembly.Module.imports(module)
        .filter((entry) => entry.module === 'env')
        .map((entry) => entry.name);
      expect(envImports).not.toContain('setjmp');
      expect(envImports).not.toContain('longjmp');
    } finally {
      try { unlinkSync(srcFile); } catch {}
      try { unlinkSync(outFile); } catch {}
    }
  }, 60_000);

  it('links working dlopen into C++ programs that request -ldl', () => {
    // wasm32posix-c++ hands the SDK's C glue to clang++, which compiles a .c
    // input as C++. dlopen.c once lacked C linkage there, so its dlopen was
    // mangled and a C++ program silently bound to musl's weak stub, which
    // only reports "Dynamic loading not supported". The functional glue is
    // recognizable by its host imports.
    mkdirSync(TMP_DIR, { recursive: true });

    const srcFile = join(TMP_DIR, 'dlopen-cxx.cpp');
    const outFile = join(TMP_DIR, 'dlopen-cxx.wasm');
    writeFileSync(srcFile, `
      #include <dlfcn.h>
      int main(int argc, char **argv) {
        return dlopen(argc > 1 ? argv[1] : nullptr, RTLD_NOW) ? 0 : 1;
      }
    `);

    try {
      const result = sdk(CXX, [srcFile, '-o', outFile, '-ldl']);
      if (result.exitCode !== 0) {
        console.error('wasm32posix-c++ stderr:', result.stderr);
      }
      expect(result.exitCode).toBe(0);

      const module = new WebAssembly.Module(readFileSync(outFile));
      const envImports = WebAssembly.Module.imports(module)
        .filter((entry) => entry.module === 'env')
        .map((entry) => entry.name);
      expect(envImports).toContain('__wasm_dlopen_main');
      expect(envImports).toContain('__wasm_dlopen_prepare');
      expect(envImports.some((name) => name.startsWith('_Z'))).toBe(false);
    } finally {
      try { unlinkSync(srcFile); } catch {}
      try { unlinkSync(outFile); } catch {}
    }
  }, 60_000);

  it('compiles in compile-only mode', () => {
    mkdirSync(TMP_DIR, { recursive: true });

    const srcFile = join(TMP_DIR, 'componly.c');
    const objFile = join(TMP_DIR, 'componly.o');

    writeFileSync(srcFile, `
      int add(int a, int b) { return a + b; }
    `);

    const result = sdk(CC, ['-c', srcFile, '-o', objFile]);

    if (result.exitCode !== 0) {
      console.error('wasm32posix-cc stderr:', result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(existsSync(objFile)).toBe(true);

    // Clean up
    try { unlinkSync(srcFile); } catch {}
    try { unlinkSync(objFile); } catch {}
  }, 60_000);

  it('keeps direct helper objects ahead of dependent static libraries', () => {
    mkdirSync(TMP_DIR, { recursive: true });

    const mainSource = join(TMP_DIR, 'link-order-main.c');
    const mainObject = join(TMP_DIR, 'link-order-main.o');
    const directHelperSource = join(TMP_DIR, 'link-order-direct-helper.c');
    const directHelperObject = join(TMP_DIR, 'link-order-direct-helper.o');
    const apiSource = join(TMP_DIR, 'link-order-api.c');
    const apiObject = join(TMP_DIR, 'link-order-api.o');
    const archiveHelperSource = join(TMP_DIR, 'link-order-archive-helper.c');
    const archiveHelperObject = join(TMP_DIR, 'link-order-archive-helper.o');
    const providerArchive = join(TMP_DIR, 'liblink-order-provider.a');
    const output = join(TMP_DIR, 'link-order.wasm');
    const paths = [
      mainSource,
      mainObject,
      directHelperSource,
      directHelperObject,
      apiSource,
      apiObject,
      archiveHelperSource,
      archiveHelperObject,
      providerArchive,
      output,
    ];

    writeFileSync(mainSource, `
      extern int link_order_api(void);
      int main(void) { return link_order_api(); }
    `);
    writeFileSync(directHelperSource, `
      int link_order_helper(void) { return 42; }
    `);
    writeFileSync(apiSource, `
      extern int link_order_helper(void);
      int link_order_api(void) { return link_order_helper() == 42 ? 0 : 1; }
    `);
    writeFileSync(archiveHelperSource, `
      int link_order_helper(void) { return 7; }
    `);

    try {
      for (const [source, object] of [
        [mainSource, mainObject],
        [directHelperSource, directHelperObject],
        [apiSource, apiObject],
        [archiveHelperSource, archiveHelperObject],
      ]) {
        const compile = sdk(CC, ['-c', source, '-o', object]);
        expect(compile.exitCode, compile.stderr).toBe(0);
      }
      const archive = sdk(AR, ['rcs', providerArchive, apiObject, archiveHelperObject]);
      expect(archive.exitCode, archive.stderr).toBe(0);

      const link = sdk(CC, [
        mainObject,
        directHelperObject,
        '-L',
        TMP_DIR,
        '-llink-order-provider',
        '-o',
        output,
      ]);
      expect(link.exitCode, link.stderr).toBe(0);

      const module = new WebAssembly.Module(readFileSync(output));
      const imports = WebAssembly.Module.imports(module).map((entry) => entry.name);
      expect(imports).not.toContain('link_order_api');
      expect(imports).not.toContain('link_order_helper');
    } finally {
      for (const path of paths) {
        try { unlinkSync(path); } catch {}
      }
    }
  }, 60_000);

  it('preserves Autoconf pthread compiler semantics', () => {
    mkdirSync(TMP_DIR, { recursive: true });

    const srcFile = join(TMP_DIR, 'autoconf-pthread.c');
    const outFile = join(TMP_DIR, 'autoconf-pthread.wasm');
    writeFileSync(srcFile, `
      #include <pthread.h>

      #ifndef _REENTRANT
      #error "-pthread must define _REENTRANT"
      #endif

      static void *start(void *arg) {
        return arg;
      }

      int main(void) {
        pthread_attr_t attr;
        pthread_t thread;
        void *result = 0;

        if (pthread_attr_init(&attr) != 0) return 1;
        if (pthread_create(&thread, &attr, start, 0) != 0) return 2;
        if (pthread_join(thread, &result) != 0) return 3;
        return pthread_attr_destroy(&attr);
      }
    `);

    try {
      const userArgs = ['-pthread', srcFile, '-lpthread', '-o', outFile];

      // -pthread reaches the compile of the caller's source; -lpthread (musl
      // has no separate libpthread) never reaches wasm-ld.
      const traced = sdk(CC, ['-###', ...userArgs]);
      expect(traced.exitCode, traced.stderr).toBe(0);
      const sourceCompile = tracedJobs(traced.stderr)
        .find((job) => job[1] === '-cc1' && job.includes(srcFile));
      expect(sourceCompile, traced.stderr).toBeDefined();
      expect(sourceCompile).toContain('-pthread');
      expect(tracedLinker(traced.stderr)).not.toContain('-lpthread');

      const result = sdk(CC, userArgs);
      if (result.exitCode !== 0) {
        console.error('wasm32posix-cc stderr:', result.stderr);
      }
      expect(result.exitCode).toBe(0);
      expect(existsSync(outFile)).toBe(true);
    } finally {
      try { unlinkSync(srcFile); } catch {}
      try { unlinkSync(outFile); } catch {}
    }
  }, 60_000);
});
