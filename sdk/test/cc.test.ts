import { describe, it, expect } from 'vitest';
import { buildClangArgs } from '../src/bin/cc.ts';

describe('buildClangArgs', () => {
  const toolchain = {
    llvmDir: '/opt/llvm/bin',
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

  it('uses the 8 MiB stack floor for default and smaller requests', () => {
    const defaultArgs = buildClangArgs(['foo.c', '-o', 'foo.wasm'], toolchain);
    const smallerArgs = buildClangArgs([
      'foo.c', '-Wl,-z,stack-size=1048576', '-o', 'foo.wasm',
    ], toolchain);

    expect(defaultArgs.filter((arg) => arg.includes('stack-size=')).at(-1))
      .toBe('-Wl,-z,stack-size=8388608');
    expect(smallerArgs.filter((arg) => arg.includes('stack-size=')).at(-1))
      .toBe('-Wl,-z,stack-size=8388608');
  });

  it('retains explicit stack requests larger than the SDK floor', () => {
    const args = buildClangArgs([
      'foo.c', '-Wl,-z,stack-size=16777216', '-o', 'foo.wasm',
    ], toolchain);

    expect(args.filter((arg) => arg.includes('stack-size=')).at(-1))
      .toBe('-Wl,-z,stack-size=16777216');
  });

  it('-ldl selects the functional dynamic-loading glue', () => {
    const args = buildClangArgs(['foo.c', '-ldl', '-o', 'foo.wasm'], toolchain);
    expect(args).not.toContain('-ldl');
    expect(args).toContain('/tmp/glue/dlopen.c');
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
});
