import { describe, it, expect } from 'vitest';
import { filterArgs, parseArgs, needsLinking, COMPILE_FLAGS, LINK_FLAGS } from '../src/lib/flags.ts';

describe('filterArgs', () => {
  it('passes through normal flags', () => {
    const result = filterArgs(['-O2', '-DFOO', '-Iinclude', 'main.c']);
    expect(result.filtered).toEqual(['-O2', '-DFOO', '-Iinclude', 'main.c']);
    expect(result.warnings).toEqual([]);
  });

  it('silently removes ignored flags', () => {
    const result = filterArgs(['-O2', '-pthread', '-fPIE', '-pie', 'main.c']);
    expect(result.filtered).toEqual(['-O2', 'main.c']);
    expect(result.warnings).toEqual([]);
  });

  it('warns on -dynamiclib but removes it', () => {
    const result = filterArgs(['-dynamiclib', 'foo.o']);
    expect(result.filtered).toEqual(['foo.o']);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('-dynamiclib');
  });

  it('removes -Wl,-rpath,/some/path', () => {
    const result = filterArgs(['-Wl,-rpath,/usr/lib', 'main.c']);
    expect(result.filtered).toEqual(['main.c']);
  });

  it('removes -Wl,-soname,libfoo.so', () => {
    const result = filterArgs(['-Wl,-soname,libfoo.so', 'main.c']);
    expect(result.filtered).toEqual(['main.c']);
  });
});

describe('parseArgs', () => {
  it('detects compile-only mode', () => {
    const parsed = parseArgs(['-c', 'foo.c', '-o', 'foo.o']);
    expect(parsed.compileOnly).toBe(true);
    expect(parsed.sourceFiles).toEqual(['foo.c']);
    expect(parsed.outputFile).toBe('foo.o');
  });

  it('detects link-only mode with object files', () => {
    const parsed = parseArgs(['foo.o', 'bar.o', '-o', 'out.wasm']);
    expect(parsed.compileOnly).toBe(false);
    expect(parsed.objectFiles).toEqual(['foo.o', 'bar.o']);
    expect(parsed.outputFile).toBe('out.wasm');
  });

  it('detects source files for compile+link', () => {
    const parsed = parseArgs(['foo.c', '-o', 'foo.wasm']);
    expect(parsed.sourceFiles).toEqual(['foo.c']);
    expect(parsed.compileOnly).toBe(false);
  });

  it('categorizes archive files', () => {
    const parsed = parseArgs(['foo.o', 'libbar.a', '-o', 'out.wasm']);
    expect(parsed.objectFiles).toEqual(['foo.o']);
    expect(parsed.archiveFiles).toEqual(['libbar.a']);
  });

  it('handles -ofilename (no space) syntax', () => {
    const parsed = parseArgs(['-c', 'foo.c', '-ofoo.o']);
    expect(parsed.outputFile).toBe('foo.o');
    expect(parsed.compileOnly).toBe(true);
  });
});

describe('needsLinking', () => {
  it('returns false when -c is present', () => {
    const parsed = parseArgs(['-c', 'foo.c']);
    expect(needsLinking(parsed)).toBe(false);
  });

  it('returns true for compile+link', () => {
    const parsed = parseArgs(['foo.c', '-o', 'foo.wasm']);
    expect(needsLinking(parsed)).toBe(true);
  });

  it('returns true for link-only', () => {
    const parsed = parseArgs(['foo.o', '-o', 'out.wasm']);
    expect(needsLinking(parsed)).toBe(true);
  });

  it('returns false for -E', () => {
    const parsed = parseArgs(['-E', 'foo.c']);
    expect(needsLinking(parsed)).toBe(false);
  });
});

describe('COMPILE_FLAGS', () => {
  it('includes target and wasm features', () => {
    expect(COMPILE_FLAGS).toContain('--target=wasm32-unknown-unknown');
    expect(COMPILE_FLAGS).toContain('-matomics');
    expect(COMPILE_FLAGS).toContain('-mbulk-memory');
  });
});

describe('LINK_FLAGS', () => {
  it('includes entry and memory flags', () => {
    expect(LINK_FLAGS).toContain('-Wl,--entry=_start');
    expect(LINK_FLAGS).toContain('-Wl,--import-memory');
    expect(LINK_FLAGS).toContain('-Wl,--shared-memory');
  });
});
