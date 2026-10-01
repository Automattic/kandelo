import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { applyHostPathGuard, findHostPaths, hostPathGuardMode } from '../src/lib/host-path-guard.ts';
import {
  buildClangArgs,
  decodeLlvmResponseFile,
  linkerArgsFromClangTrace,
  workingDirectoryFromClangTrace,
} from '../src/bin/cc.ts';

describe('buildClangArgs', () => {
  const toolchain = {
    llvmDir: '/opt/llvm/bin',
    lldMajor: 21,
    cc: '/opt/llvm/bin/clang',
    cxx: '/opt/llvm/bin/clang++',
    ar: '/opt/llvm/bin/llvm-ar',
    ranlib: '/opt/llvm/bin/llvm-ranlib',
    nm: '/opt/llvm/bin/llvm-nm',
    sysroot: '/tmp/sysroot',
    glueDir: '/tmp/glue',
  };
  const build = (
    userArgs: string[],
    selectedToolchain = toolchain,
    mainThreadStackSizeBytes = 8 * 1024 * 1024,
  ): string[] => buildClangArgs(userArgs, selectedToolchain, 'wasm32', {
    kind: 'executable-link',
    mainThreadStackSizeBytes,
  });

  it('compile-only: adds compile flags, no link flags', () => {
    const args = build(['-c', 'foo.c', '-o', 'foo.o']);
    expect(args).toContain('--target=wasm32-unknown-unknown');
    expect(args).toContain('-D__unix__=1');
    expect(args).toContain('-D__unix=1');
    expect(args).toContain('--sysroot=/tmp/sysroot');
    expect(args).toContain('-c');
    expect(args).toContain('foo.c');
    expect(args).not.toContain('-Wl,--entry=_start');
    expect(args.join(' ')).not.toContain('syscall_glue.c');
  });

  it('compile+link: adds both compile and link flags plus glue', () => {
    const args = build(['foo.c', '-o', 'foo.wasm']);
    expect(args).toContain('--target=wasm32-unknown-unknown');
    expect(args).toContain('-Wl,--no-entry');
    expect(args).toContain('-Wl,--import-memory');
    expect(args.join(' ')).toContain('channel_syscall.c');
    expect(args.join(' ')).toContain('compiler_rt.c');
    expect(args.join(' ')).toContain('crt1.o');
    expect(args.join(' ')).toContain('libc.a');
    expect(args).toContain('-Wl,-z,stack-size=8388608');
  });

  it('-ldl selects the functional dynamic-loading glue', () => {
    const args = build(['foo.c', '-ldl', '-o', 'foo.wasm']);
    expect(args).not.toContain('-ldl');
    expect(args).toContain('/tmp/glue/dlopen.c');
  });

  it('uses the 8 MiB stack floor for default and smaller requests', () => {
    const defaultArgs = build(['foo.c', '-o', 'foo.wasm']);
    const smallerArgs = build([
      'foo.c', '-Wl,-z,stack-size=1048576', '-o', 'foo.wasm',
    ], toolchain);

    expect(defaultArgs.filter((arg) => arg.includes('stack-size=')).at(-1))
      .toBe('-Wl,-z,stack-size=8388608');
    expect(smallerArgs.filter((arg) => arg.includes('stack-size=')).at(-1))
      .toBe('-Wl,-z,stack-size=8388608');
  });

  it('emits the prepared larger stack after preserving the original arguments', () => {
    const userArgs = [
      'foo.c', '-Wl,-z', '-iquote', '/tmp/include',
      '-Wl,stack-size=16777216', '-o', 'foo.wasm',
    ];
    const args = build(userArgs, toolchain, 16 * 1024 * 1024);
    const forwarded = userArgs.slice(0, -2);

    expect(args.slice(args.indexOf(forwarded[0]), args.indexOf(forwarded.at(-1)!) + 1))
      .toEqual(forwarded);
    expect(args.filter((arg) => arg.includes('stack-size=')).at(-1))
      .toBe('-Wl,-z,stack-size=16777216');
  });

  it('rejects malformed UTF-16 response text like LLVM', () => {
    expect(() => decodeLlvmResponseFile(Buffer.from([
      0xff, 0xfe, 0x00, 0xd8,
    ]))).toThrow();
    expect(() => decodeLlvmResponseFile(Buffer.from([
      0xfe, 0xff, 0xd8, 0x00,
    ]))).toThrow();
    expect(() => decodeLlvmResponseFile(Buffer.from([
      0xff, 0xfe, 0x41,
    ]))).toThrow(/odd-length UTF-16LE/);
  });

  it('decodes both LLVM UTF-16 response-file encodings', () => {
    const contents = '-z\nstack-size=16777216\n';
    const littleEndian = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(contents, 'utf16le'),
    ]);
    const bigEndianContents = Buffer.from(contents, 'utf16le');
    bigEndianContents.swap16();
    const bigEndian = Buffer.concat([
      Buffer.from([0xfe, 0xff]),
      bigEndianContents,
    ]);

    for (const encoded of [littleEndian, bigEndian]) {
      expect(decodeLlvmResponseFile(encoded)).toBe(contents);
    }
  });

  it('link-only: object files without -c get link flags plus compile flags for glue', () => {
    const args = build(['foo.o', 'bar.o', '-o', 'out.wasm']);
    expect(args).toContain('-Wl,--no-entry');
    expect(args.join(' ')).toContain('libc.a');
    expect(args).toContain('--target=wasm32-unknown-unknown');
    // Compile flags are present because glue .c files are compiled during linking
    expect(args).toContain('-fno-trapping-math');
    expect(args.join(' ')).toContain('channel_syscall.c');
  });

  it('preserves user linker input order across argument categories', () => {
    const userLinkArgs = [
      'main.o',
      '-Wl,--start-group',
      '-lfoo',
      'libbar.a',
      '-Wl,--end-group',
    ];
    const args = build([...userLinkArgs, '-o', 'out.wasm']);
    const forwarded = args.slice(args.indexOf('main.o'), args.indexOf('-Wl,--end-group') + 1);
    expect(forwarded).toEqual(userLinkArgs);
  });

  it('orders explicit libc and user libraries after syscall glue', () => {
    const args = build([
      'main.o',
      '-L', '/deps/lib',
      '-lxml2',
      'support.a',
      '-lc',
      '-o', 'out.wasm',
    ]);
    const channelGlue = args.indexOf('/tmp/glue/channel_syscall.c');
    const crt = args.indexOf('/tmp/sysroot/lib/crt1.o');
    const main = args.indexOf('main.o');
    const libraryPath = args.indexOf('-L');
    const xml = args.indexOf('-lxml2');
    const support = args.indexOf('support.a');
    const explicitLibc = args.indexOf('-lc');
    const finalLibc = args.indexOf('/tmp/sysroot/lib/libc.a');

    expect(channelGlue).toBeLessThan(crt);
    expect(crt).toBeLessThan(main);
    expect(main).toBeLessThan(libraryPath);
    expect(libraryPath).toBeLessThan(xml);
    expect(xml).toBeLessThan(support);
    expect(support).toBeLessThan(explicitLibc);
    expect(explicitLibc).toBeLessThan(finalLibc);
  });

  it('maps SDK-owned glue and sysroot paths to stable debug identities', () => {
    const args = build(['-ffile-prefix-map=/tmp=/caller-source', 'foo.c', '-o', 'foo.wasm']);

    for (const kind of ['file', 'debug', 'macro']) {
      expect(args).toContain(`-f${kind}-prefix-map=/tmp/glue=/usr/src/kandelo-sdk/libc/glue`);
      expect(args).toContain(`-f${kind}-prefix-map=/tmp/sysroot=/usr/src/kandelo-sdk/sysroot`);
    }
    expect(args.indexOf('-ffile-prefix-map=/tmp/glue=/usr/src/kandelo-sdk/libc/glue'))
      .toBeGreaterThan(args.indexOf('-ffile-prefix-map=/tmp=/caller-source'));
  });

  it('uses an architecture-specific stable identity for the wasm64 sysroot', () => {
    const args = buildClangArgs(['-c', 'foo.c', '-o', 'foo.o'], toolchain, 'wasm64');

    expect(args).toContain('-ffile-prefix-map=/tmp/sysroot=/usr/src/kandelo-sdk/sysroot64');
  });

  it('preprocess-only: no link flags', () => {
    const args = build(['-E', 'foo.c']);
    expect(args).not.toContain('-Wl,--entry=_start');
  });

  it('preserves -pthread compiler semantics while filtering -lpthread', () => {
    const args = buildClangArgs(['-c', '-pthread', '-lpthread', '-fPIC', 'foo.c'], toolchain);
    expect(args).toContain('-pthread');
    expect(args).not.toContain('-lpthread');
    expect(args).toContain('-fPIC');
  });

  it('honors an authoritative no-link trace for direct and response-file inputs', () => {
    for (const userArgs of [
      ['-fsyntax-only', 'foo.c'],
      ['@/tmp/syntax-only.rsp'],
    ]) {
      const args = buildClangArgs(userArgs, toolchain, 'wasm32', { kind: 'no-link' });
      expect(args).toContain('-fno-trapping-math');
      expect(args).not.toContain('-fuse-ld=/opt/llvm/bin/wasm-ld');
      expect(args).not.toContain('-Wl,--entry=_start');
      expect(args.join(' ')).not.toContain('channel_syscall.c');
    }
  });

  it('normalizes equivalent configure-supplied wasm target aliases', () => {
    const args = build(['--target=wasm32-linux-musl', '-c', 'foo.c']);
    expect(args.filter((arg) => arg.startsWith('--target='))).toEqual(['--target=wasm32-unknown-unknown']);
  });

  it('treats linker response lists as link commands', () => {
    const args = build(['-fuse-ld=lld', '-o', 'out.wasm', '-Wl,@/tmp/objects.list']);
    expect(args).toContain('-Wl,--no-entry');
    expect(args.join(' ')).toContain('channel_syscall.c');
    expect(args.join(' ')).toContain('libc.a');
  });

  it('preserves the relative order of link inputs and -l flags', () => {
    const args = build(['foo.o', '-L/deps/lib', '-lz', 'bar.o', '-o', 'out.wasm']);
    expect(args.indexOf('foo.o')).toBeLessThan(args.indexOf('-lz'));
    expect(args.indexOf('-lz')).toBeLessThan(args.indexOf('bar.o'));
  });

  it('emits explicit process thread slot declarations into the glue compile', () => {
    const args = build(['--kandelo-thread-slots=2', 'foo.c', '-o', 'foo.wasm']);
    expect(args).toContain('-DWASM_POSIX_THREAD_SLOT_DECL=2');
    expect(args).not.toContain('--kandelo-thread-slots=2');
  });

  it('pins lld to the same resolved LLVM tree as clang', () => {
    const args = build(['foo.c', '-o', 'foo.wasm']);

    expect(args).toContain('-fuse-ld=/opt/llvm/bin/wasm-ld');
  });

  it('rejects executable link arguments before wasm-ld is versioned', () => {
    expect(() =>
      buildClangArgs(
        ['foo.c', '-o', 'foo.wasm'],
        { ...toolchain, lldMajor: null },
      ),
    ).toThrow(/wasm-ld version is unresolved/);
  });

  it('rejects executable links without the matching Clang trace preparation', () => {
    expect(() => buildClangArgs(['foo.c', '-o', 'foo.wasm'], toolchain))
      .toThrow(/executable linker arguments are unprepared/);
    expect(() => build(['foo.c', '-o', 'foo.wasm'], toolchain, 1024))
      .toThrow(/prepared main-thread stack size must be an integer/);
  });

  it('extracts the exact pinned wasm-ld argv from a Clang trace', () => {
    const trace = [
      'clang version 21.1.7',
      ' "/opt/llvm/bin/clang-21" "-cc1" "-iquote" "/tmp/include"',
      ' "/opt/llvm/bin/wasm-ld" "-m" "wasm32" "main.o" "-z" "stack-size=16777216"',
    ].join('\n');

    expect(linkerArgsFromClangTrace(trace, '/opt/llvm/bin/wasm-ld')).toEqual([
      '-m', 'wasm32', 'main.o', '-z', 'stack-size=16777216',
    ]);
    expect(() => linkerArgsFromClangTrace(trace, '/other/wasm-ld'))
      .toThrow(/emitted 0 commands/);

    const noLinkTrace =
      ' "/opt/llvm/bin/clang-21" "-cc1" "-triple" "wasm32-unknown-unknown"';
    expect(linkerArgsFromClangTrace(noLinkTrace, '/opt/llvm/bin/wasm-ld')).toBeNull();
    expect(() => linkerArgsFromClangTrace(
      ' "/opt/llvm/bin/clang-21" "-cc1"\n "/opt/llvm/bin/wasm-ld" "one.o"\n' +
        ' "/opt/llvm/bin/wasm-ld" "two.o"',
      '/opt/llvm/bin/wasm-ld',
    )).toThrow(/emitted 2 commands/);
    expect(() => linkerArgsFromClangTrace(
      ' "/opt/llvm/bin/clang-21" "-cc1"\n "/other/wasm-ld" "main.o"',
      '/opt/llvm/bin/wasm-ld',
    )).toThrow(/emitted 0 commands/);
    expect(() => linkerArgsFromClangTrace(
      ' "/opt/llvm/bin/clang-21" "-cc1"\n' +
        ' "/opt/llvm/bin/wasm-ld" "main.o"\n "/other/wasm-ld" "other.o"',
      '/opt/llvm/bin/wasm-ld',
    )).toThrow(/emitted 1 commands/);
    expect(linkerArgsFromClangTrace(
      ' "/opt/llvm/bin/clang-21" "-cc1"\n' +
        ' "/opt/llvm/bin/wasm-ld" "main.o"\n "/opt/bin/wasm-opt" "a.wasm"',
      '/opt/llvm/bin/wasm-ld',
    )).toEqual(['main.o']);
    expect(() => linkerArgsFromClangTrace(
      ' "/opt/bin/wasm-opt" "a.wasm"',
      '/opt/llvm/bin/wasm-ld',
    )).toThrow(/no compiler or pinned linker jobs/);
    expect(() => linkerArgsFromClangTrace(
      'clang version 21.1.7',
      '/opt/llvm/bin/wasm-ld',
    )).toThrow(/no recognizable jobs/);

    const newlinePathTrace =
      ' "/opt/llvm/bin/wasm-ld" "main\nobject.o" "-z" "stack-size=16777216"\n';
    expect(linkerArgsFromClangTrace(newlinePathTrace, '/opt/llvm/bin/wasm-ld')).toEqual([
      'main\nobject.o', '-z', 'stack-size=16777216',
    ]);
    expect(linkerArgsFromClangTrace(
      `"unrelated unterminated diagnostic\n${trace}`,
      '/opt/llvm/bin/wasm-ld',
    )).toEqual(['-m', 'wasm32', 'main.o', '-z', 'stack-size=16777216']);
    expect(() => linkerArgsFromClangTrace(
      ' "/opt/llvm/bin/wasm-ld" "unterminated\n',
      '/opt/llvm/bin/wasm-ld',
    )).toThrow(/unterminated quoted command/);

    const workingDirectoryTrace = [
      ' "/opt/llvm/bin/clang-21" "-cc1" "-ffile-compilation-dir=/spoofed" ' +
        '"-resource-dir" "/opt/llvm/lib/clang/21" "-working-directory" "/tmp/build" ' +
        '"-internal-isystem" "/opt/include" "-working-directory" "/xclang-only"',
      ' "/opt/llvm/bin/wasm-ld" "main.o"',
    ].join('\n');
    expect(workingDirectoryFromClangTrace(
      workingDirectoryTrace,
      '/tmp/project',
    )).toBe('/tmp/build');

    const initialDirectoryTrace =
      ' "/opt/llvm/bin/clang-21" "-cc1" "-resource-dir" "/opt/llvm/lib/clang/21" ' +
      '"-internal-isystem" "/opt/include" "-working-directory" "/xclang-only"';
    expect(workingDirectoryFromClangTrace(
      initialDirectoryTrace,
      '/tmp/project',
    )).toBe('/tmp/project');
    expect(() => workingDirectoryFromClangTrace(
      ' "/opt/llvm/bin/wasm-ld" "main.o"\n',
      '/tmp/project',
    )).toThrow(/did not emit one consistent driver working directory/);
    expect(() => workingDirectoryFromClangTrace([
      workingDirectoryTrace,
      ' "/opt/llvm/bin/clang-21" "-cc1" "-resource-dir" "/opt/llvm/lib/clang/21" ' +
        '"-working-directory" "/other"',
    ].join('\n'), '/tmp/project')).toThrow(/did not emit one consistent driver working directory/);
  });

  it('pins the packaged SDK driver to clang\'s adjacent wasm-ld', () => {
    const script = readFileSync(
      join(import.meta.dirname, '../kandelo/bin/wasm32posix-cc'),
      'utf8',
    );

    expect(script).toContain('WASM_LD="${TOOL_DIR}/wasm-ld"');
    expect(script).not.toContain('WASM_LD="$(find_tool wasm-ld');
  });

  it('preserves -pthread in the packaged SDK compiler path', () => {
    const script = readFileSync(
      join(import.meta.dirname, '../kandelo/bin/wasm32posix-cc'),
      'utf8',
    );

    expect(script).toContain(`-pthread)
      raw_threads_or_dynamic=1
      filtered+=("$arg")`);
  });

  it('preserves stack-after-data layout with LLD 22 and newer', () => {
    const args = build(
      ['foo.c', '-o', 'foo.wasm'],
      { ...toolchain, lldMajor: 22 },
    );

    expect(args).toContain('-Wl,--no-stack-first');
  });

  it('uses LLD 21 defaults without passing its unsupported negative option', () => {
    const args = build(
      ['foo.c', '-o', 'foo.wasm'],
      { ...toolchain, lldMajor: 21 },
    );

    expect(args).not.toContain('-Wl,--no-stack-first');
  });
});

describe('host-path guard', () => {
  const NIX_INCLUDE = '/nix/store/abc-libpng-apng-1.6.55-dev/include/libpng16';
  const NIX_LIB = '/nix/store/abc-libpng-apng-1.6.55/lib';
  const CACHE = '/Users/x/.cache/kandelo/source-only/source-only-v1/compiled';

  // Every detected spelling, each naming a host directory.
  const hostForms: [string, string[]][] = [
    ['attached -I', [`-I${NIX_INCLUDE}`]],
    ['separated -I', ['-I', NIX_INCLUDE]],
    ['attached -isystem', [`-isystem${NIX_INCLUDE}`]],
    ['separated -isystem', ['-isystem', NIX_INCLUDE]],
    ['-iquote', ['-iquote', '/usr/include']],
    ['-idirafter', [`-idirafter${NIX_INCLUDE}`]],
    ['attached -L', [`-L${NIX_LIB}`]],
    ['separated -L', ['-L', '/usr/local/lib']],
    ['--sysroot', ['--sysroot=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk']],
    ['-Wl,-L', [`-Wl,-L${NIX_LIB}`]],
    ['-Wl,-L,dir', [`-Wl,-L,${NIX_LIB}`]],
    ['-Xlinker -L', ['-Xlinker', `-L${NIX_LIB}`]],
    ['response file', ['@flags.rsp']],
  ];
  const readResponseFile = (path: string) =>
    path === 'flags.rsp' ? { contents: `-I"${NIX_INCLUDE}"`, identity: '/rsp/flags.rsp' } : null;
  const guard = (args: string[], env: NodeJS.ProcessEnv) => {
    const stderr: string[] = [];
    const logs: [string, string][] = [];
    const proceed = applyHostPathGuard({
      args: ['-c', 'main.c', ...args],
      env,
      cwd: '/work/recipe',
      readResponseFile,
      tool: 'wasm32posix-cc',
      arch: 'wasm32',
      writeStderr: (text) => stderr.push(text),
      appendLog: (path, text) => logs.push([path, text]),
    });
    return { proceed, stderr: stderr.join(''), logs };
  };

  for (const [name, args] of hostForms) {
    it(`reports ${name} and continues in report mode`, () => {
      const result = guard(args, {});
      expect(result.proceed).toBe(true);
      expect(result.stderr).toMatch(/^wasm32posix-cc: host-path guard \(report\): /);
      expect(result.stderr.trim().split('\n')).toHaveLength(1);
    });

    it(`rejects ${name} in error mode`, () => {
      const result = guard(args, { KANDELO_HOST_PATH_GUARD: 'error' });
      expect(result.proceed).toBe(false);
      expect(result.stderr).toContain('wasm32posix-cc: error: host directory in a wasm32 compile');
      expect(result.stderr).toContain('docs/sdk-guide.md#host-path-guard');
    });
  }

  it('passes repository, cache, sysroot-relative, and relative paths', () => {
    const args = [
      '-I/Users/x/src/kandelo/sysroot/include',
      `-I${CACHE}/libs/libpng-1.6.43-rev2-wasm32-abc/include`,
      `-L${CACHE}/libs/zlib-1.3.1-rev1-wasm32-def/lib`,
      '-I=/usr/include',
      '-Iinclude', '-I../common',
      '--sysroot=/Users/x/src/kandelo/sysroot',
      '-Wl,-L/Users/x/src/kandelo/local-binaries/lib',
    ];
    for (const mode of ['report', 'error']) {
      const result = guard(args, { KANDELO_HOST_PATH_GUARD: mode });
      expect(result).toEqual({ proceed: true, stderr: '', logs: [] });
    }
  });

  it('does not mistake a sibling of a host root for the root', () => {
    expect(findHostPaths({
      args: ['-I/usr/libexec-not-host', '-I/nix/storefront/include', '-I/opt/homebrewer'],
      env: {},
      cwd: '/',
    })).toEqual([]);
  });

  it('resolves relative paths against the working directory', () => {
    expect(findHostPaths({ args: ['-I../include'], env: {}, cwd: '/usr/local' }))
      .toMatchObject([{ flag: '-I', value: '../include', root: '/usr/include' }]);
  });

  it('checks compiler search-path environment variables', () => {
    const result = guard([], { CPATH: `/repo/include:${NIX_INCLUDE}` });
    expect(result.stderr).toContain(`CPATH=${NIX_INCLUDE}`);
  });

  it('honors an absolute SDKROOT as a host root', () => {
    expect(findHostPaths({
      args: ['-I/Volumes/Xcode/SDKs/MacOSX.sdk/usr/include'],
      env: { SDKROOT: '/Volumes/Xcode/SDKs/MacOSX.sdk' },
      cwd: '/',
    })).toHaveLength(1);
    expect(findHostPaths({ args: ['-I/repo/include'], env: { SDKROOT: '/' }, cwd: '/' }))
      .toEqual([]);
  });

  it('names the environment variable a flag likely came from', () => {
    const result = guard([`-I${NIX_INCLUDE}`], { CPPFLAGS: `-I${NIX_INCLUDE} -DX` });
    expect(result.stderr).toContain('likely from CPPFLAGS in the environment');
  });

  it('reports each flag once per invocation', () => {
    const result = guard([`-I${NIX_INCLUDE}`, `-I${NIX_INCLUDE}`, `-L${NIX_LIB}`], {});
    expect(result.stderr.trim().split('\n')).toHaveLength(2);
  });

  it('writes JSON records to the census log instead of stderr when one is set', () => {
    const result = guard([`-I${NIX_INCLUDE}`], {
      KANDELO_HOST_PATH_GUARD_LOG: '/tmp/census.jsonl',
      WASM_POSIX_DEP_NAME: 'scummvm',
      CFLAGS: `-O2 -I${NIX_INCLUDE}`,
    });
    expect(result.proceed).toBe(true);
    expect(result.stderr).toBe('');
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0][0]).toBe('/tmp/census.jsonl');
    expect(JSON.parse(result.logs[0][1])).toEqual({
      tool: 'wasm32posix-cc',
      arch: 'wasm32',
      package: 'scummvm',
      flag: '-I',
      value: NIX_INCLUDE,
      root: '/nix/store',
      envSources: ['CFLAGS'],
      cwd: '/work/recipe',
    });
  });

  it('defaults to report mode and rejects an unknown mode', () => {
    expect(hostPathGuardMode({})).toBe('report');
    expect(hostPathGuardMode({ KANDELO_HOST_PATH_GUARD: '' })).toBe('report');
    expect(hostPathGuardMode({ KANDELO_HOST_PATH_GUARD: 'error' })).toBe('error');
    expect(() => hostPathGuardMode({ KANDELO_HOST_PATH_GUARD: 'off' })).toThrow(/report.*error/);
  });

  for (const driver of ['wasm32posix-cc', 'wasm64posix-c++']) {
    it(`${driver} exits nonzero before compiling in error mode`, () => {
      const wrapper = join(import.meta.dirname, '..', 'bin', driver);
      const result = spawnSync(wrapper, ['-c', '-I', NIX_INCLUDE, 'missing.c', '-o', '/dev/null'], {
        env: { ...process.env, KANDELO_HOST_PATH_GUARD: 'error' },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${driver}: error: host directory in a ${driver.slice(0, 6)} compile`);
      expect(result.stderr).toContain(`-I${NIX_INCLUDE}`);
    });
  }
});
