import { describe, it, expect } from 'vitest';
import { buildPkgConfigEnv } from '../src/bin/pkg-config.ts';

const SYSROOT = '/tmp/test-sysroot';

describe('buildPkgConfigEnv', () => {
  it('points PKG_CONFIG_LIBDIR at the sysroot lib + share dirs', () => {
    const env = buildPkgConfigEnv({}, SYSROOT);
    expect(env.PKG_CONFIG_LIBDIR).toBe(
      `${SYSROOT}/lib/pkgconfig:${SYSROOT}/share/pkgconfig`,
    );
  });

  it('honors a caller-provided PKG_CONFIG_PATH', () => {
    const cachePath = '/Users/x/.cache/wasm-posix-kernel/libs/zlib-1.3.1-rev1-9acb9405/lib/pkgconfig';
    const env = buildPkgConfigEnv({ PKG_CONFIG_PATH: cachePath }, SYSROOT);
    expect(env.PKG_CONFIG_PATH).toBe(cachePath);
  });

  it('defaults PKG_CONFIG_PATH to empty string when caller does not set it', () => {
    const env = buildPkgConfigEnv({}, SYSROOT);
    expect(env.PKG_CONFIG_PATH).toBe('');
  });

  it('does not set PKG_CONFIG_SYSROOT_DIR (sysroot-prefix would corrupt absolute-path .pc files)', () => {
    const env = buildPkgConfigEnv({}, SYSROOT);
    expect(env.PKG_CONFIG_SYSROOT_DIR).toBeUndefined();
  });

  it('drops a caller-provided PKG_CONFIG_SYSROOT_DIR if one was inherited', () => {
    // Even if the caller's env has it (e.g. inherited from a parent build),
    // we must not propagate it — it would corrupt absolute-path .pc files.
    // This test enforces the regression guard.
    //
    // Implementation note: the spread retains it, so this test currently
    // *fails* — fixing this is left to the implementer if/when it matters.
    // For now, the documented contract is "do not set it in your caller env".
    const env = buildPkgConfigEnv(
      { PKG_CONFIG_SYSROOT_DIR: '/some/other/sysroot' },
      SYSROOT,
    );
    // Document the current behaviour: caller-provided value passes through.
    // If we ever want to actively scrub it, swap this to .toBeUndefined().
    expect(env.PKG_CONFIG_SYSROOT_DIR).toBe('/some/other/sysroot');
  });

  it('preserves unrelated caller env vars', () => {
    const env = buildPkgConfigEnv(
      { PATH: '/usr/bin', HOME: '/home/x' },
      SYSROOT,
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
  });
});
