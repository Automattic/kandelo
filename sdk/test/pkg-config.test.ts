import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  buildPkgConfigEnv,
  droppedPathNote,
  filterPkgConfigPath,
  targetPkgConfigRoots,
} from '../src/bin/pkg-config.ts';

const SYSROOT = '/tmp/test-sysroot';
const CACHE_ROOT = '/Users/x/.cache/kandelo/source-only/source-only-v1/compiled';
const WORK_DIR = `${CACHE_ROOT}/libs/.cpython-abc.work-1/recipe-work`;
const OUT_DIR = `${CACHE_ROOT}/libs/.cpython-abc.tmp-1`;
const RESOLVER_ENV = {
  WASM_POSIX_BINARY_CACHE_ROOT: CACHE_ROOT,
  WASM_POSIX_DEP_WORK_DIR: WORK_DIR,
  WASM_POSIX_DEP_OUT_DIR: OUT_DIR,
};

describe('buildPkgConfigEnv', () => {
  it('points PKG_CONFIG_LIBDIR at the sysroot lib + share dirs', () => {
    const { env } = buildPkgConfigEnv({}, SYSROOT);
    expect(env.PKG_CONFIG_LIBDIR).toBe(
      `${SYSROOT}/lib/pkgconfig:${SYSROOT}/share/pkgconfig`,
    );
  });

  it('keeps dependency .pc directories inside the resolver cache root', () => {
    const dep = `${CACHE_ROOT}/libs/zlib-1.3.1-rev1-wasm32-9acb9405/lib/pkgconfig`;
    const { env, dropped } = buildPkgConfigEnv(
      { ...RESOLVER_ENV, PKG_CONFIG_PATH: dep },
      SYSROOT,
    );
    expect(env.PKG_CONFIG_PATH).toBe(dep);
    expect(dropped).toEqual([]);
  });

  it('keeps .pc files the recipe staged in its own work and output directories', () => {
    const staged = [`${WORK_DIR}/build/lib/pkgconfig`, `${OUT_DIR}/lib/pkgconfig`].join(':');
    const { env } = buildPkgConfigEnv({ ...RESOLVER_ENV, PKG_CONFIG_PATH: staged }, SYSROOT);
    expect(env.PKG_CONFIG_PATH).toBe(staged);
  });

  it('keeps the target sysroot pkgconfig directories', () => {
    const sysrootPc = `${SYSROOT}/lib/pkgconfig:${SYSROOT}/share/pkgconfig`;
    const { env } = buildPkgConfigEnv({ PKG_CONFIG_PATH: sysrootPc }, SYSROOT);
    expect(env.PKG_CONFIG_PATH).toBe(sysrootPc);
  });

  it('drops a kandelo-named checkout path that is neither cache nor sysroot', () => {
    // The old substring filter kept anything containing "kandelo/" or
    // "/sysroot/", which matched host directories in a developer checkout.
    const checkoutPaths = [
      '/Users/x/src/kandelo/vendor/host-libs/lib/pkgconfig',
      '/Users/x/conductor/workspaces/kandelo/puebla/sysroot/lib/pkgconfig',
      '/home/runner/work/_temp/kandelo/other-cache/libs/icu/lib/pkgconfig',
    ];
    const { env, dropped } = buildPkgConfigEnv(
      { ...RESOLVER_ENV, PKG_CONFIG_PATH: checkoutPaths.join(':') },
      SYSROOT,
    );
    expect(env.PKG_CONFIG_PATH).toBe('');
    expect(dropped).toEqual(checkoutPaths);
  });

  it('keeps only the selected exact-main cache root, wherever it lives', () => {
    const selected = '/home/runner/work/_temp/exact-main-package-cache.abc';
    const dep = `${selected}/libs/icu/lib/pkgconfig`;
    expect(
      buildPkgConfigEnv(
        { WASM_POSIX_BINARY_CACHE_ROOT: selected, PKG_CONFIG_PATH: dep },
        SYSROOT,
      ).env.PKG_CONFIG_PATH,
    ).toBe(dep);
    expect(
      buildPkgConfigEnv(
        { WASM_POSIX_BINARY_CACHE_ROOT: `${selected}-other`, PKG_CONFIG_PATH: dep },
        SYSROOT,
      ).env.PKG_CONFIG_PATH,
    ).toBe('');
  });

  it('keeps only the sysroot when no resolver roots are present', () => {
    const dep = `${CACHE_ROOT}/libs/zlib/lib/pkgconfig`;
    const { env, dropped } = buildPkgConfigEnv({ PKG_CONFIG_PATH: dep }, SYSROOT);
    expect(env.PKG_CONFIG_PATH).toBe('');
    expect(dropped).toEqual([dep]);
  });

  it('defaults PKG_CONFIG_PATH to empty string when caller does not set it', () => {
    const { env, dropped } = buildPkgConfigEnv({}, SYSROOT);
    expect(env.PKG_CONFIG_PATH).toBe('');
    expect(dropped).toEqual([]);
  });

  it('drops host Nix-store .pc paths, keeping interleaved cache paths in order', () => {
    const dep = `${CACHE_ROOT}/libs/openssl-3.3.2-rev1-wasm32-abc/lib/pkgconfig`;
    const hostA = '/nix/store/x56h6pvq8gs6qc3ab1f3kjncn6vlspjp-openssl-3.6.1-dev/lib/pkgconfig';
    const hostB = '/nix/store/24yccf3vq5wzwzvfsijz42f1iv3vqrvw-nghttp2-1.67.1-dev/lib/pkgconfig';
    const { env, dropped } = buildPkgConfigEnv(
      { ...RESOLVER_ENV, PKG_CONFIG_PATH: `${hostA}:${dep}:${hostB}` },
      SYSROOT,
    );
    expect(env.PKG_CONFIG_PATH).toBe(dep);
    expect(dropped).toEqual([hostA, hostB]);
  });

  it('rejects lexical escapes and relative entries', () => {
    const { env, dropped } = buildPkgConfigEnv(
      {
        ...RESOLVER_ENV,
        PKG_CONFIG_PATH: `${CACHE_ROOT}/../../host/lib/pkgconfig:lib/pkgconfig:${CACHE_ROOT}-sibling/x`,
      },
      SYSROOT,
    );
    expect(env.PKG_CONFIG_PATH).toBe('');
    expect(dropped).toHaveLength(3);
  });

  it('does not set PKG_CONFIG_SYSROOT_DIR (sysroot-prefix would corrupt absolute-path .pc files)', () => {
    const { env } = buildPkgConfigEnv({}, SYSROOT);
    expect(env.PKG_CONFIG_SYSROOT_DIR).toBeUndefined();
  });

  it('passes a caller-provided PKG_CONFIG_SYSROOT_DIR through unchanged', () => {
    // Documented current behaviour: the caller must not set it. If we ever
    // want to actively scrub it, swap this to .toBeUndefined().
    const { env } = buildPkgConfigEnv(
      { PKG_CONFIG_SYSROOT_DIR: '/some/other/sysroot' },
      SYSROOT,
    );
    expect(env.PKG_CONFIG_SYSROOT_DIR).toBe('/some/other/sysroot');
  });

  it('preserves unrelated caller env vars', () => {
    const { env } = buildPkgConfigEnv(
      { PATH: '/usr/bin', HOME: '/home/x' },
      SYSROOT,
    );
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
  });
});

describe('filterPkgConfigPath', () => {
  it('compares real paths, so a symlinked spelling of a root still matches', () => {
    const base = mkdtempSync(join(tmpdir(), 'pkg-config-roots-'));
    const realRoot = join(base, 'real-cache');
    mkdirSync(join(realRoot, 'libs', 'zlib', 'lib', 'pkgconfig'), { recursive: true });
    symlinkSync(realRoot, join(base, 'linked-cache'));
    const viaLink = join(base, 'linked-cache', 'libs', 'zlib', 'lib', 'pkgconfig');
    expect(filterPkgConfigPath(viaLink, [realRoot]).kept).toEqual([viaLink]);
  });

  it('only resolver-provided absolute roots count', () => {
    expect(
      targetPkgConfigRoots(
        { WASM_POSIX_BINARY_CACHE_ROOT: 'relative/cache', WASM_POSIX_DEP_WORK_DIR: '' },
        SYSROOT,
      ),
    ).toEqual([SYSROOT]);
  });
});

describe('droppedPathNote', () => {
  it('names each dropped entry', () => {
    const note = droppedPathNote('wasm32posix-pkg-config', ['/nix/store/a/lib/pkgconfig', '/usr/lib/pkgconfig']);
    expect(note).toContain('ignored 2 PKG_CONFIG_PATH entries');
    expect(note).toContain('/nix/store/a/lib/pkgconfig');
    expect(note).toContain('/usr/lib/pkgconfig');
  });

  it('is silent when nothing was dropped', () => {
    expect(droppedPathNote('wasm32posix-pkg-config', [])).toBeNull();
  });
});
