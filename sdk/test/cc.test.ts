import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
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
    expect(args).toContain('--sysroot=/tmp/sysroot');
    expect(args).toContain('-c');
    expect(args).toContain('foo.c');
    expect(args).not.toContain('-Wl,--entry=_start');
    expect(args.join(' ')).not.toContain('syscall_glue.c');
  });

  it('compile+link: adds both compile and link flags plus glue', () => {
    const args = build(['foo.c', '-o', 'foo.wasm']);
    expect(args).toContain('--target=wasm32-unknown-unknown');
    expect(args).toContain('-Wl,--entry=_start');
    expect(args).toContain('-Wl,--import-memory');
    expect(args.join(' ')).toContain('channel_syscall.c');
    expect(args.join(' ')).toContain('compiler_rt.c');
    expect(args.join(' ')).toContain('crt1.o');
    expect(args.join(' ')).toContain('libc.a');
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
    expect(args).toContain('-Wl,--entry=_start');
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
    expect(args).toContain('-Wl,--entry=_start');
    expect(args.join(' ')).toContain('channel_syscall.c');
    expect(args.join(' ')).toContain('libc.a');
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
