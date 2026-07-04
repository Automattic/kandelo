import { describe, it, expect } from 'vitest';
import {
  COMPILE_FLAGS,
  DEFAULT_MAIN_THREAD_STACK_SIZE,
  filterArgs,
  inferThreadSlotDeclaration,
  LINK_FLAGS,
  mainThreadStackSize,
  needsLinking,
  parseArgs,
  THREAD_SLOT_NONE,
  THREAD_SLOT_USE_HOST_DEFAULT,
} from '../src/lib/flags.ts';

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

  it('removes -Wl,-rpath-link,/some/path', () => {
    const result = filterArgs(['-Wl,-rpath-link,/usr/lib', 'main.c']);
    expect(result.filtered).toEqual(['main.c']);
  });

  it('removes -Wl,-soname,libfoo.so', () => {
    const result = filterArgs(['-Wl,-soname,libfoo.so', 'main.c']);
    expect(result.filtered).toEqual(['main.c']);
  });

  it('removes ELF-only -z linker flags without dropping wasm stack sizing', () => {
    const result = filterArgs([
      '-Wl,-z,noexecstack',
      '-Wl,-z,relro',
      '-Wl,-z,stack-size=16777216',
      'main.c',
    ]);
    expect(result.filtered).toEqual(['-Wl,-z,stack-size=16777216', 'main.c']);
  });

  it('normalizes zero-padded decimal stack sizes for linker parity', () => {
    const result = filterArgs(['-Wl,-z,stack-size=016777216', 'main.c']);
    expect(result.filtered).toEqual(['-Wl,-z,stack-size=16777216', 'main.c']);
  });

  it('removes equivalent wasm target aliases supplied by configure scripts', () => {
    const result = filterArgs([
      '--target=wasm32-linux-musl',
      '-target',
      'wasm32-unknown-linux-musl',
      '--target=wasm32-unknown-unknown',
      'main.c',
    ]);
    expect(result.filtered).toEqual(['main.c']);
  });

  it('preserves non-equivalent target flags', () => {
    const result = filterArgs(['--target=x86_64-linux-gnu', 'main.c']);
    expect(result.filtered).toEqual(['--target=x86_64-linux-gnu', 'main.c']);
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

  it('treats LLVM .obj files as link inputs', () => {
    const parsed = parseArgs(['foo.obj', 'bar.o', '-o', 'out.wasm']);
    expect(parsed.compileOnly).toBe(false);
    expect(parsed.objectFiles).toEqual(['foo.obj', 'bar.o']);
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

  it('parses explicit thread slot declarations', () => {
    expect(parseArgs(['--kandelo-thread-slots=3', 'foo.c']).threadSlots).toBe(3);
    expect(parseArgs(['--wasm-posix-thread-slots', '0', 'foo.c']).threadSlots).toBe(0);
    expect(parseArgs(['--kandelo-thread-slots=-1', 'foo.c']).threadSlots).toBe(-1);
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

  it('returns true for linker response-list files', () => {
    const parsed = parseArgs(['-fuse-ld=lld', '-o', 'out.wasm', '-Wl,@/tmp/objects.list']);
    expect(needsLinking(parsed)).toBe(true);
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

  it('reserves an 8 MiB main-thread shadow stack (wasm-ld default ~64 KiB is too small)', () => {
    expect(LINK_FLAGS).toContain('-Wl,-z,stack-size=8388608');
  });
});

describe('mainThreadStackSize', () => {
  it('uses 8 MiB when no explicit stack size is requested', () => {
    expect(mainThreadStackSize(['main.c'])).toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
  });

  it('raises smaller requests to the SDK floor', () => {
    expect(mainThreadStackSize(['-Wl,-z,stack-size=1048576', 'main.c']))
      .toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
  });

  it('retains the largest explicit request', () => {
    expect(mainThreadStackSize([
      '-Wl,-z,stack-size=1048576',
      '-Wl,-z,stack-size=16777216',
      'main.c',
    ])).toBe(16 * 1024 * 1024);
  });

  it('retains larger requests in directly referenced linker response files', () => {
    expect(mainThreadStackSize(
      ['-Wl,@/tmp/objects.list'],
      () => 'first.o\n-z\nstack-size=16777216\n',
    )).toBe(16 * 1024 * 1024);
  });
});

describe('inferThreadSlotDeclaration', () => {
  it('emits zero only for source-only builds with no thread or dynamic use', () => {
    const parsed = parseArgs(['main.c', '-o', 'main.wasm']);
    expect(inferThreadSlotDeclaration(parsed, ['main.c', '-o', 'main.wasm'], {
      readFile: () => 'int main(void) { return 0; }\n',
    })).toBe(THREAD_SLOT_NONE);
  });

  it('uses the host default for uncertain thread or dynamic use', () => {
    const threaded = parseArgs(['main.c', '-o', 'main.wasm']);
    expect(inferThreadSlotDeclaration(threaded, ['-pthread', 'main.c'], {
      readFile: () => 'int main(void) { return 0; }\n',
    })).toBe(THREAD_SLOT_USE_HOST_DEFAULT);

    expect(inferThreadSlotDeclaration(threaded, ['main.c'], {
      readFile: () => 'void f(void) { pthread_create(0, 0, 0, 0); }\n',
    })).toBe(THREAD_SLOT_USE_HOST_DEFAULT);

    expect(inferThreadSlotDeclaration(threaded, ['main.c'], {
      readFile: () => '#include<thread>\nvoid f(void) { clone (0); }\n',
    })).toBe(THREAD_SLOT_USE_HOST_DEFAULT);

    const objectOnly = parseArgs(['main.o', '-o', 'main.wasm']);
    expect(inferThreadSlotDeclaration(objectOnly, ['main.o', '-o', 'main.wasm']))
      .toBe(THREAD_SLOT_USE_HOST_DEFAULT);
  });
});
