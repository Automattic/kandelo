import { basename } from 'node:path';
import { describe, it, expect } from 'vitest';
import { findLlvmDir, findSysroot, findGlueDir } from '../src/lib/toolchain.ts';

describe('findLlvmDir', () => {
  it('finds LLVM from auto-detection', async () => {
    const dir = await findLlvmDir();
    expect(dir).toBeTruthy();
    expect(typeof dir).toBe('string');
  });
});

describe('findSysroot', () => {
  it('resolves sysroot relative to SDK root', () => {
    const sysroot = findSysroot();
    expect(sysroot).toContain('sysroot');
  });

  it('selects the sysroot matching the compiler architecture', () => {
    const original = process.env.WASM_POSIX_SYSROOT;
    delete process.env.WASM_POSIX_SYSROOT;
    try {
      expect(basename(findSysroot('wasm32'))).toBe('sysroot');
      expect(basename(findSysroot('wasm64'))).toBe('sysroot64');
    } finally {
      if (original === undefined) {
        delete process.env.WASM_POSIX_SYSROOT;
      } else {
        process.env.WASM_POSIX_SYSROOT = original;
      }
    }
  });
});

describe('findGlueDir', () => {
  it('resolves glue dir relative to SDK root', () => {
    const glueDir = findGlueDir();
    expect(glueDir).toContain('libc/glue');
  });
});
