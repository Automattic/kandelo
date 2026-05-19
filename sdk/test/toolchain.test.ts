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
});

describe('findGlueDir', () => {
  it('resolves glue dir relative to SDK root', () => {
    const glueDir = findGlueDir();
    expect(glueDir).toContain('libc/glue');
  });
});
