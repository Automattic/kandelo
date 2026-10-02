import { describe, it, expect } from 'vitest';
import {
  COMPILE_FLAGS,
  DEFAULT_MAIN_THREAD_STACK_SIZE,
  filterArgs,
  inferThreadSlotDeclaration,
  LINK_FLAGS,
  MAX_EXECUTABLE_MEMORY_SIZE,
  MAX_RESPONSE_FILE_EXPANSIONS,
  mainThreadStackSize,
  needsLinking,
  parseArgs,
  searchDirectoryArgs,
  THREAD_SLOT_NONE,
  THREAD_SLOT_USE_HOST_DEFAULT,
} from '../src/lib/flags.ts';

function responseFile(contents: string, identity = '/tmp/objects.list') {
  return { contents, identity };
}

describe('filterArgs', () => {
  it('passes through normal flags', () => {
    const result = filterArgs(['-O2', '-DFOO', '-Iinclude', 'main.c']);
    expect(result.filtered).toEqual(['-O2', '-DFOO', '-Iinclude', 'main.c']);
    expect(result.warnings).toEqual([]);
  });

  it('preserves -pthread while silently removing target no-ops', () => {
    const result = filterArgs(['-O2', '-pthread', '-fPIE', '-pie', 'main.c']);
    expect(result.filtered).toEqual(['-O2', '-pthread', 'main.c']);
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

  it('preserves valid and invalid stack-size spellings for wasm-ld', () => {
    for (const value of [
      '0100000000',
      '0o100000000',
      '0x1000000',
      '0X1000000',
      '0b1000000000000000000000000',
      '0B1000000000000000000000000',
      '16777216z',
      '08',
      '0o8',
      '0xg',
      '0b2',
    ]) {
      const flag = `-Wl,-z,stack-size=${value}`;
      expect(filterArgs([flag, 'main.c']).filtered).toEqual([flag, 'main.c']);
    }
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

  it('retains the original order of forwarded linker inputs and controls', () => {
    const parsed = parseArgs([
      'main.o',
      '-Wl,--start-group',
      '-lfoo',
      'libbar.a',
      '-Wl,--end-group',
      '-o',
      'out.wasm',
    ]);
    expect(parsed.forwardedArgs).toEqual([
      'main.o',
      '-Wl,--start-group',
      '-lfoo',
      'libbar.a',
      '-Wl,--end-group',
    ]);
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
    expect(COMPILE_FLAGS).toContain('-D__unix__=1');
    expect(COMPILE_FLAGS).toContain('-D__unix=1');
    expect(COMPILE_FLAGS).toContain('-matomics');
    expect(COMPILE_FLAGS).toContain('-mbulk-memory');
  });
});

describe('LINK_FLAGS', () => {
  it('leaves constructors to musl while exporting the process entry', () => {
    expect(LINK_FLAGS).toContain('-Wl,--no-entry');
    expect(LINK_FLAGS).toContain('-Wl,--export=_start');
    expect(LINK_FLAGS).not.toContain('-Wl,--entry=_start');
    expect(LINK_FLAGS).toContain('-Wl,--import-memory');
    expect(LINK_FLAGS).toContain('-Wl,--shared-memory');
  });

  it('reserves an 8 MiB main-thread shadow stack (wasm-ld default ~64 KiB is too small)', () => {
    expect(LINK_FLAGS).toContain('-Wl,-z,stack-size=8388608');
  });
});

describe('mainThreadStackSize', () => {
  it('uses 8 MiB when no explicit stack size is requested', () => {
    expect(mainThreadStackSize(['main.o'])).toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
  });

  it('raises smaller requests to the SDK floor', () => {
    expect(mainThreadStackSize(['-z', 'stack-size=1048576', 'main.o']))
      .toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
  });

  it('retains the largest request in the exact lld argv', () => {
    expect(mainThreadStackSize([
      '-z', 'stack-size=1048576',
      'main.o',
      '-z', 'stack-size=16777216',
    ])).toBe(16 * 1024 * 1024);
  });

  it('recognizes both accepted lld -z spellings', () => {
    for (const args of [
      ['-zstack-size=0x1000000', 'main.o'],
      ['-z', 'stack-size=0o100000000', 'main.o'],
    ]) {
      expect(mainThreadStackSize(args)).toBe(16 * 1024 * 1024);
    }
  });

  it('requires the stack-size operand to immediately follow -z', () => {
    for (const args of [
      ['-z', 'main.o', 'stack-size=33554432'],
      ['-z', '-lfoo', 'stack-size=33554432'],
      ['-z', '-e', 'stack-size=33554432'],
      ['-z', '-r', 'stack-size=33554432'],
    ]) {
      expect(mainThreadStackSize(args)).toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
    }
  });

  it('retains larger requests in every integer radix accepted by LLVM 21', () => {
    for (const value of [
      '16777216',
      '0100000000',
      '0o100000000',
      '0x1000000',
      '0X1000000',
      '0b1000000000000000000000000',
      '0B1000000000000000000000000',
    ]) {
      expect(mainThreadStackSize(['-z', `stack-size=${value}`, 'main.o']))
        .toBe(16 * 1024 * 1024);
    }
  });

  it('treats leading-zero values as octal rather than padded decimal', () => {
    expect(mainThreadStackSize(['-z', 'stack-size=020000000', 'main.o']))
      .toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
    expect(mainThreadStackSize(
      ['@/tmp/objects.list'],
      () => responseFile('-z\nstack-size=020000000\n'),
    )).toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
  });

  it('retains larger radix-prefixed requests in directly referenced response files', () => {
    for (const value of [
      '16777216',
      '0100000000',
      '0o100000000',
      '0x1000000',
      '0X1000000',
      '0b1000000000000000000000000',
      '0B1000000000000000000000000',
    ]) {
      expect(mainThreadStackSize(
        ['@/tmp/objects.list'],
        () => responseFile(`first.o\n-z\nstack-size=${value}\n`),
      )).toBe(16 * 1024 * 1024);
    }
  });

  it('expands nested lld response files with LLVM GNU tokenization', () => {
    const files: Record<string, string> = {
      '/tmp/outer.rsp': '"/tmp/not-stack-size=33554432.o" @/tmp/inner\\ file.rsp',
      '/tmp/inner file.rsp': "-z 'stack-size=0x1000000'",
    };
    const readResponseFile = (path: string) =>
      files[path] === undefined ? null : responseFile(files[path], path);

    expect(mainThreadStackSize(['@/tmp/outer.rsp', 'main.o'], readResponseFile))
      .toBe(16 * 1024 * 1024);
  });

  it('only treats exact lld -z operands as stack requests', () => {
    for (const args of [
      ['stack-size=33554432', 'main.o'],
      ['-z=stack-size=33554432', 'main.o'],
      ['/tmp/not-stack-size=33554432.o'],
      ['-z', '-zstack-size=33554432'],
      ['--', '-zstack-size=33554432'],
    ]) {
      expect(mainThreadStackSize(args)).toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
    }

    expect(mainThreadStackSize(
      ['@/tmp/objects.rsp'],
      () => responseFile('not-stack-size=33554432.o\nstack-size=33554432\n'),
    )).toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
  });

  it('does not let invalid integer digits influence the floor', () => {
    for (const value of ['16777216z', '08', '0o8', '0xg', '0b2']) {
      expect(mainThreadStackSize(['-z', `stack-size=${value}`, 'main.o']))
        .toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
      expect(mainThreadStackSize(
        ['@/tmp/objects.list'],
        () => responseFile(`-z\nstack-size=${value}\n`),
      )).toBe(DEFAULT_MAIN_THREAD_STACK_SIZE);
    }
  });

  it('rejects requests larger than the executable memory maximum', () => {
    for (const value of [
      `${MAX_EXECUTABLE_MEMORY_SIZE + 1}`,
      '010000000001',
      '0o10000000001',
      '0x40000001',
      '0b1000000000000000000000000000001',
    ]) {
      expect(() => mainThreadStackSize(['-z', `stack-size=${value}`, 'main.o']))
        .toThrow(/exceeds the SDK's 1073741824-byte executable memory limit/);
      expect(() => mainThreadStackSize(
        ['@/tmp/objects.list'],
        () => responseFile(`-z\nstack-size=${value}\n`),
      )).toThrow(/exceeds the SDK's 1073741824-byte executable memory limit/);
    }
  });

  it('inspects response chains deeper than the former recursive cutoff', () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 100; index++) {
      files[`/tmp/deep-${index}.rsp`] = index === 99
        ? '-z stack-size=16777216'
        : `@/tmp/deep-${index + 1}.rsp`;
    }
    const readResponseFile = (path: string) =>
      files[path] === undefined ? null : responseFile(files[path], path);

    expect(mainThreadStackSize(['@/tmp/deep-0.rsp'], readResponseFile))
      .toBe(16 * 1024 * 1024);
  });

  it('expands repeated files each time so cross-file option boundaries stay exact', () => {
    const files: Record<string, string> = {
      '/tmp/z.rsp': '-z',
    };
    const readResponseFile = (path: string) =>
      files[path] === undefined ? null : responseFile(files[path], path);

    expect(mainThreadStackSize([
      '@/tmp/z.rsp', 'stack-size=16777216',
      '@/tmp/z.rsp', 'stack-size=33554432',
    ], readResponseFile)).toBe(32 * 1024 * 1024);
  });

  it('rejects missing, recursive, and alias-recursive response files', () => {
    expect(() => mainThreadStackSize(['@/tmp/missing.rsp'], () => null))
      .toThrow(/cannot inspect response file/);

    const recursiveFiles: Record<string, string> = {
      '/tmp/a.rsp': '@/tmp/b.rsp',
      '/tmp/b.rsp': '@/tmp/a.rsp',
    };
    expect(() => mainThreadStackSize(
      ['@/tmp/a.rsp'],
      (path) => responseFile(recursiveFiles[path], path),
    )).toThrow(/recursive response file/);

    expect(() => mainThreadStackSize(
      ['@/tmp/a.rsp'],
      (path) => responseFile('@/tmp/alias.rsp', 'same-file'),
    )).toThrow(/recursive response file/);
  });

  it('fails closed when response expansion exceeds the explicit file bound', () => {
    expect(() => mainThreadStackSize(
      ['@0'],
      (path) => {
        const index = Number(path);
        return responseFile(`@${index + 1}`, path);
      },
    )).toThrow(
      `response-file expansion exceeds the ${MAX_RESPONSE_FILE_EXPANSIONS}-file safety limit`,
    );
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

describe('searchDirectoryArgs', () => {
  const NIX = '/nix/store/abc-libpng-apng-1.6.55-dev/include/libpng16';

  it('finds attached and separated compiler directory flags', () => {
    expect(searchDirectoryArgs([
      `-I${NIX}`, '-I', '/a',
      '-isystem/b', '-isystem', '/c',
      '-iquote/d', '-iquote', '/e',
      '-idirafter/f', '-idirafter', '/g',
      '-L/h', '-L', '/i',
      '--sysroot=/j', '--sysroot', '/k',
      '-isysroot/l',
      '--include-directory=/m', '--library-directory', '/n',
      'main.c',
    ])).toEqual([
      { flag: '-I', value: NIX },
      { flag: '-I', value: '/a' },
      { flag: '-isystem', value: '/b' },
      { flag: '-isystem', value: '/c' },
      { flag: '-iquote', value: '/d' },
      { flag: '-iquote', value: '/e' },
      { flag: '-idirafter', value: '/f' },
      { flag: '-idirafter', value: '/g' },
      { flag: '-L', value: '/h' },
      { flag: '-L', value: '/i' },
      { flag: '--sysroot', value: '/j' },
      { flag: '--sysroot', value: '/k' },
      { flag: '-isysroot', value: '/l' },
      { flag: '--include-directory', value: '/m' },
      { flag: '--library-directory', value: '/n' },
    ]);
  });

  it('does not read a longer flag as a shorter one', () => {
    expect(searchDirectoryArgs(['-isystem-after', '/x'])).toEqual([
      { flag: '-isystem-after', value: '/x' },
    ]);
  });

  it('finds linker directories passed through -Wl, and -Xlinker', () => {
    expect(searchDirectoryArgs([
      '-Wl,-L/nix/store/a/lib',
      '-Wl,-L,/nix/store/b/lib',
      '-Wl,--library-path=/c',
      '-Xlinker', '-L', '-Xlinker', '/d',
      '-Wl,-rpath,/nix/store/not-a-search-dir',
    ])).toEqual([
      { flag: '-Wl,-L', value: '/nix/store/a/lib' },
      { flag: '-Wl,-L', value: '/nix/store/b/lib' },
      { flag: '-Wl,--library-path', value: '/c' },
      { flag: '-Xlinker -L', value: '/d' },
    ]);
  });

  it('skips values of unrelated flags', () => {
    expect(searchDirectoryArgs([
      '-MF', '-Ideps.d', '-include', '-Iconfig.h', '-D', '-L', '-o', 'a.o', '-c', 'a.c',
    ])).toEqual([]);
  });

  it('expands compiler and linker response files', () => {
    const files: Record<string, string> = {
      'flags.rsp': `-I ${NIX} @nested.rsp`,
      'nested.rsp': '"-L/usr/lib/host lib"',
      'link.rsp': '-L /opt/homebrew/lib',
    };
    const read = (path: string) =>
      files[path] === undefined ? null : responseFile(files[path], `/rsp/${path}`);
    expect(searchDirectoryArgs(['@flags.rsp', '-Wl,@link.rsp', 'main.c'], read)).toEqual([
      { flag: '-I', value: NIX },
      { flag: '-L', value: '/usr/lib/host lib' },
      { flag: '-Wl,-L', value: '/opt/homebrew/lib' },
    ]);
  });

  it('inspects visible arguments when a response file cannot be read', () => {
    expect(searchDirectoryArgs(['@missing.rsp', '-I/x'], () => null)).toEqual([
      { flag: '-I', value: '/x' },
    ]);
  });
});
