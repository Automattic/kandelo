import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, unlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveToolchain } from '../src/lib/toolchain.ts';
import { buildClangArgs, prepareExecutableLinker } from '../src/bin/cc.ts';
import { run } from '../src/lib/exec.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(SDK_ROOT, '..');
const TMP_DIR = join(SDK_ROOT, '.test-tmp');

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
  // If sysroot isn't in the worktree, use the main repo's
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

  it('pins clang to the resolved wasm-ld', async () => {
    const toolchain = await resolveToolchain();
    mkdirSync(TMP_DIR, { recursive: true });
    const srcFile = join(TMP_DIR, 'linker-probe.c');
    const outFile = join(TMP_DIR, 'linker-probe.wasm');
    writeFileSync(srcFile, 'int main(void) { return 0; }\n');

    const userArgs = ['-###', srcFile, '-o', outFile];
    const executableLinker = await prepareExecutableLinker(userArgs, toolchain);
    const args = buildClangArgs(userArgs, toolchain, 'wasm32', executableLinker ?? undefined);
    const result = await run(toolchain.cc, args);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(join(toolchain.llvmDir, 'wasm-ld'));
    try { unlinkSync(srcFile); } catch {}
    try { unlinkSync(outFile); } catch {}
  }, 30_000);

  it('preserves Clang non-linking modes directly and through response files', async () => {
    const toolchain = await resolveToolchain();
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
          const preparation = await prepareExecutableLinker(userArgs, toolchain);
          expect(preparation).toEqual({ kind: 'no-link' });
          const args = buildClangArgs(userArgs, toolchain, 'wasm32', preparation ?? undefined);
          expect(args).not.toContain(`-fuse-ld=${join(toolchain.llvmDir, 'wasm-ld')}`);
          expect(args.join(' ')).not.toContain('channel_syscall.c');
          execFileSync(process.execPath, [
            '--experimental-strip-types',
            join(SDK_ROOT, 'src/bin/cc.ts'),
            ...userArgs,
          ], {
            cwd: TMP_DIR,
            env: process.env,
            stdio: 'pipe',
          });
        }
      }
      expect(existsSync(sourceTreeAnalyzerOutput)).toBe(false);
    } finally {
      try { unlinkSync(source); } catch {}
      for (const path of [...responses, ...outputs]) {
        try { unlinkSync(path); } catch {}
      }
    }
  }, 30_000);

  it('retains larger stacks across non-intervening options and UTF-16 responses', async () => {
    const toolchain = await resolveToolchain();
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
    const environmentWorkingDirectoryOutput = join(TMP_DIR, 'stack-floor-environment-cwd.wasm');
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
      environmentWorkingDirectoryOutput, deepResponseOutput, ...deepResponses,
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

    const link = async (userArgs: string[]): Promise<void> => {
      const executableLinker = await prepareExecutableLinker(userArgs, toolchain);
      const result = await run(toolchain.cc, buildClangArgs(
        userArgs,
        toolchain,
        'wasm32',
        executableLinker ?? undefined,
      ));
      expect(result.exitCode, result.stderr).toBe(0);
    };
    const stackPointer = (path: string): number => {
      const dump = execFileSync('wasm-objdump', ['-x', path], { encoding: 'utf8' });
      const match = dump.match(/<__stack_pointer> - init i32=(\d+)/);
      expect(match, dump).not.toBeNull();
      return Number(match?.[1]);
    };

    try {
      const pchResult = await run(toolchain.cc, buildClangArgs([
        '-c', '-x', 'c-header', pchSource, '-o', pch,
      ], toolchain));
      expect(pchResult.exitCode, pchResult.stderr).toBe(0);
      const objectResult = await run(toolchain.cc, buildClangArgs([
        '-c', source, '-o', object,
      ], toolchain));
      expect(objectResult.exitCode, objectResult.stderr).toBe(0);

      await link([source, '-o', floorOutput]);
      for (let index = 0; index < variants.length; index++) {
        const [, ...options] = variants[index];
        await link([
          source, '-Wl,-z', ...options,
          '-Wl,stack-size=16777216', '-o', variantOutputs[index],
        ]);
      }
      await link([
        source, '-working-directory', TMP_DIR,
        `-Wl,@${basename(response)}`, '-o', responseOutput,
      ]);
      await link([object, `@${driverResponse}`, '-o', objectOutput]);
      await link([
        source, '-working-directory', TMP_DIR,
        '-fdebug-compilation-dir=/unrelated',
        `-Wl,@${basename(response)}`, '-o', debugDirectoryOutput,
      ]);
      await link([
        source, '-working-directory', TMP_DIR,
        '-ffile-compilation-dir=/unrelated',
        `-Wl,@${basename(response)}`, '-o', fileDirectoryOutput,
      ]);
      await link([
        source, '-working-directory', TMP_DIR,
        `--config=${compilationDirectoryConfig}`,
        `-Wl,@${basename(response)}`, '-o', configuredDirectoryOutput,
      ]);
      await link([
        source, '-working-directory', TMP_DIR,
        '-Xclang', '-working-directory', '-Xclang', SDK_ROOT,
        `-Wl,@${basename(response)}`, '-o', xclangOutput,
      ]);
      await link([
        source, `--config=${workingDirectoryConfig}`,
        `-Wl,@${basename(response)}`, '-o', configuredWorkingDirectoryOutput,
      ]);
      const previousOverride = process.env.CCC_OVERRIDE_OPTIONS;
      try {
        process.env.CCC_OVERRIDE_OPTIONS = `+-working-directory=${TMP_DIR}`;
        await link([
          source, `-Wl,@${basename(response)}`,
          '-o', environmentWorkingDirectoryOutput,
        ]);
      } finally {
        if (previousOverride === undefined) delete process.env.CCC_OVERRIDE_OPTIONS;
        else process.env.CCC_OVERRIDE_OPTIONS = previousOverride;
      }
      await link([
        source, '-working-directory', TMP_DIR,
        `-Wl,@${basename(deepResponses[0])}`, '-o', deepResponseOutput,
      ]);
      if (process.platform !== 'win32') {
        await link([
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
      expect(stackPointer(environmentWorkingDirectoryOutput)).toBe(largeStackPointer);
      expect(stackPointer(deepResponseOutput)).toBe(largeStackPointer);
      if (process.platform !== 'win32') {
        expect(stackPointer(newlineOutput)).toBe(largeStackPointer);
      }
    } finally {
      for (const path of paths) {
        try { unlinkSync(path); } catch {}
      }
    }
  }, 30_000);

  it('compiles a hello world program to .wasm', async () => {
    const toolchain = await resolveToolchain();
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

    const userArgs = [srcFile, '-o', outFile];
    const executableLinker = await prepareExecutableLinker(userArgs, toolchain);
    const args = buildClangArgs(userArgs, toolchain, 'wasm32', executableLinker ?? undefined);
    const result = await run(toolchain.cc, args);

    if (result.exitCode !== 0) {
      console.error('clang stderr:', result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(existsSync(outFile)).toBe(true);

    // Clean up
    try { unlinkSync(srcFile); } catch {}
    try { unlinkSync(outFile); } catch {}
  }, 30_000);

  it('links timer_create without fictional raw setjmp imports', async () => {
    const toolchain = await resolveToolchain();
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
      const userArgs = [srcFile, '-o', outFile];
      const executableLinker = await prepareExecutableLinker(userArgs, toolchain);
      const args = buildClangArgs(userArgs, toolchain, 'wasm32', executableLinker ?? undefined);
      const result = await run(toolchain.cc, args);
      if (result.exitCode !== 0) {
        console.error('clang stderr:', result.stderr);
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
  }, 30_000);

  it('compiles in compile-only mode', async () => {
    const toolchain = await resolveToolchain();
    mkdirSync(TMP_DIR, { recursive: true });

    const srcFile = join(TMP_DIR, 'componly.c');
    const objFile = join(TMP_DIR, 'componly.o');

    writeFileSync(srcFile, `
      int add(int a, int b) { return a + b; }
    `);

    const args = buildClangArgs(['-c', srcFile, '-o', objFile], toolchain);
    const result = await run(toolchain.cc, args);

    if (result.exitCode !== 0) {
      console.error('clang stderr:', result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(existsSync(objFile)).toBe(true);

    // Clean up
    try { unlinkSync(srcFile); } catch {}
    try { unlinkSync(objFile); } catch {}
  }, 30_000);

  it('keeps direct helper objects ahead of dependent static libraries', async () => {
    const toolchain = await resolveToolchain();
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
        const compile = await run(toolchain.cc, buildClangArgs(['-c', source, '-o', object], toolchain));
        expect(compile.exitCode, compile.stderr).toBe(0);
      }
      const archive = await run(toolchain.ar, ['rcs', providerArchive, apiObject, archiveHelperObject]);
      expect(archive.exitCode, archive.stderr).toBe(0);

      const linkArgs = [
        mainObject,
        directHelperObject,
        '-L',
        TMP_DIR,
        '-llink-order-provider',
        '-o',
        output,
      ];
      const executableLinker = await prepareExecutableLinker(linkArgs, toolchain);
      const link = await run(toolchain.cc, buildClangArgs(
        linkArgs,
        toolchain,
        'wasm32',
        executableLinker ?? undefined,
      ));
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
  }, 30_000);

  it('preserves Autoconf pthread compiler semantics', async () => {
    const toolchain = await resolveToolchain();
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
      const executableLinker = await prepareExecutableLinker(userArgs, toolchain);
      const args = buildClangArgs(
        userArgs,
        toolchain,
        'wasm32',
        executableLinker ?? undefined,
      );
      const result = await run(toolchain.cc, args);
      if (result.exitCode !== 0) {
        console.error('clang stderr:', result.stderr);
      }
      expect(args).toContain('-pthread');
      expect(args).not.toContain('-lpthread');
      expect(result.exitCode).toBe(0);
      expect(existsSync(outFile)).toBe(true);
    } finally {
      try { unlinkSync(srcFile); } catch {}
      try { unlinkSync(outFile); } catch {}
    }
  }, 30_000);
});
