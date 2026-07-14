import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, unlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
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
    await prepareExecutableLinker(userArgs, toolchain);
    const args = buildClangArgs(userArgs, toolchain);
    const result = await run(toolchain.cc, args);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(join(toolchain.llvmDir, 'wasm-ld'));
    try { unlinkSync(srcFile); } catch {}
    try { unlinkSync(outFile); } catch {}
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
    await prepareExecutableLinker(userArgs, toolchain);
    const args = buildClangArgs(userArgs, toolchain);
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
      await prepareExecutableLinker(userArgs, toolchain);
      const args = buildClangArgs(userArgs, toolchain);
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
      await prepareExecutableLinker(linkArgs, toolchain);
      const link = await run(toolchain.cc, buildClangArgs(linkArgs, toolchain));
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
});
