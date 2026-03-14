import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, unlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveToolchain } from '../src/lib/toolchain.ts';
import { buildClangArgs } from '../src/bin/cc.ts';
import { run } from '../src/lib/exec.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(SDK_ROOT, '..');
const TMP_DIR = join(SDK_ROOT, '.test-tmp');

/**
 * Find the main repo root. In a worktree, REPO_ROOT is the worktree dir,
 * but sysroot/glue live in the main checkout. Use git to find it.
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
      process.env.WASM_POSIX_GLUE_DIR = join(mainRepo, 'glue');
    }
  }
});

describe('integration: compile C program', () => {
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

    const args = buildClangArgs([srcFile, '-o', outFile], toolchain);
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
});
