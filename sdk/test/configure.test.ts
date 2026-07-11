import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { buildConfigureEnv, buildConfigureArgs } from '../src/bin/configure.ts';

const CONFIG_SITE = fileURLToPath(new URL('../config.site', import.meta.url));

function dynamicLoadingSiteFacts(overrides: Record<string, string> = {}): string[] {
  const printFacts = [
    '. "$1";',
    'printf "%s\\n"',
    '"$ac_cv_func_dlopen"',
    '"$ac_cv_lib_dl_dlopen"',
    '"$ac_cv_search_dlclose"',
    '"$ac_cv_search_dlerror"',
    '"$ac_cv_search_dlopen"',
    '"$ac_cv_search_dlsym"',
  ].join(' ');
  const output = execFileSync(
    'bash',
    ['-c', printFacts, 'bash', CONFIG_SITE],
    { encoding: 'utf8', env: { ...process.env, ...overrides } },
  );
  return output.trimEnd().split('\n');
}

describe('buildConfigureArgs', () => {
  it('includes --host and --prefix', () => {
    const args = buildConfigureArgs([]);
    expect(args).toContain('--host=wasm32-unknown-none');
    expect(args).toContain('--prefix=/usr');
  });

  it('forwards extra user args', () => {
    const args = buildConfigureArgs(['--disable-shared', '--without-pear']);
    expect(args).toContain('--disable-shared');
    expect(args).toContain('--without-pear');
  });
});

describe('buildConfigureEnv', () => {
  it('sets CC to wasm32posix-cc', () => {
    const env = buildConfigureEnv();
    expect(env.CC).toBe('wasm32posix-cc');
    expect(env.AR).toBe('wasm32posix-ar');
    expect(env.STRIP).toBe('wasm32posix-strip');
  });
});

describe('config.site dynamic loading facts', () => {
  it('routes dlfcn library searches through the SDK -ldl glue', () => {
    expect(dynamicLoadingSiteFacts()).toEqual([
      'no',
      'yes',
      '-ldl',
      '-ldl',
      '-ldl',
      '-ldl',
    ]);
  });

  it('preserves caller overrides', () => {
    expect(dynamicLoadingSiteFacts({
      ac_cv_func_dlopen: 'yes',
      ac_cv_search_dlopen: 'custom-dlopen-provider',
    })).toEqual([
      'yes',
      'yes',
      '-ldl',
      '-ldl',
      'custom-dlopen-provider',
      '-ldl',
    ]);
  });
});
