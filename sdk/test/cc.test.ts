import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildClangArgs } from '../src/bin/cc.ts';

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

  it('compile-only: adds compile flags, no link flags', () => {
    const args = buildClangArgs(['-c', 'foo.c', '-o', 'foo.o'], toolchain);
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
    const args = buildClangArgs(['foo.c', '-o', 'foo.wasm'], toolchain);
    expect(args).toContain('--target=wasm32-unknown-unknown');
    expect(args).toContain('-Wl,--entry=_start');
    expect(args).toContain('-Wl,--import-memory');
    expect(args.join(' ')).toContain('channel_syscall.c');
    expect(args.join(' ')).toContain('compiler_rt.c');
    expect(args.join(' ')).toContain('crt1.o');
    expect(args.join(' ')).toContain('libc.a');
  });

  it('link-only: object files without -c get link flags plus compile flags for glue', () => {
    const args = buildClangArgs(['foo.o', 'bar.o', '-o', 'out.wasm'], toolchain);
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
    const args = buildClangArgs([...userLinkArgs, '-o', 'out.wasm'], toolchain);
    const forwarded = args.slice(args.indexOf('main.o'), args.indexOf('-Wl,--end-group') + 1);
    expect(forwarded).toEqual(userLinkArgs);
  });

  it('preprocess-only: no link flags', () => {
    const args = buildClangArgs(['-E', 'foo.c'], toolchain);
    expect(args).not.toContain('-Wl,--entry=_start');
  });

  it('filters ignored flags', () => {
    const args = buildClangArgs(['-c', '-pthread', '-fPIC', 'foo.c'], toolchain);
    expect(args).not.toContain('-pthread');
    expect(args).toContain('-fPIC');
  });

  it('normalizes equivalent configure-supplied wasm target aliases', () => {
    const args = buildClangArgs(['--target=wasm32-linux-musl', '-c', 'foo.c'], toolchain);
    expect(args.filter((arg) => arg.startsWith('--target='))).toEqual(['--target=wasm32-unknown-unknown']);
  });

  it('treats linker response lists as link commands', () => {
    const args = buildClangArgs(['-fuse-ld=lld', '-o', 'out.wasm', '-Wl,@/tmp/objects.list'], toolchain);
    expect(args).toContain('-Wl,--entry=_start');
    expect(args.join(' ')).toContain('channel_syscall.c');
    expect(args.join(' ')).toContain('libc.a');
  });

  it('emits explicit process thread slot declarations into the glue compile', () => {
    const args = buildClangArgs(['--kandelo-thread-slots=2', 'foo.c', '-o', 'foo.wasm'], toolchain);
    expect(args).toContain('-DWASM_POSIX_THREAD_SLOT_DECL=2');
    expect(args).not.toContain('--kandelo-thread-slots=2');
  });

  it('pins lld to the same resolved LLVM tree as clang', () => {
    const args = buildClangArgs(['foo.c', '-o', 'foo.wasm'], toolchain);

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

  it('pins the packaged SDK driver to clang\'s adjacent wasm-ld', () => {
    const script = readFileSync(
      join(import.meta.dirname, '../kandelo/bin/wasm32posix-cc'),
      'utf8',
    );

    expect(script).toContain('WASM_LD="${TOOL_DIR}/wasm-ld"');
    expect(script).not.toContain('WASM_LD="$(find_tool wasm-ld');
  });

  it('preserves stack-after-data layout with LLD 22 and newer', () => {
    const args = buildClangArgs(
      ['foo.c', '-o', 'foo.wasm'],
      { ...toolchain, lldMajor: 22 },
    );

    expect(args).toContain('-Wl,--no-stack-first');
  });

  it('uses LLD 21 defaults without passing its unsupported negative option', () => {
    const args = buildClangArgs(
      ['foo.c', '-o', 'foo.wasm'],
      { ...toolchain, lldMajor: 21 },
    );

    expect(args).not.toContain('-Wl,--no-stack-first');
  });
});
