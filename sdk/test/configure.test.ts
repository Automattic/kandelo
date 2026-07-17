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

function fmtcheckSiteFact(overrides: Record<string, string> = {}): string {
  const output = execFileSync(
    'bash',
    ['-c', '. "$1"; printf "%s\\n" "$ac_cv_func_fmtcheck"', 'bash', CONFIG_SITE],
    { encoding: 'utf8', env: { ...process.env, ...overrides } },
  );
  return output.trimEnd();
}

const absentFunctionFacts = [
  'ac_cv_func___argz_count',
  'ac_cv_func___argz_next',
  'ac_cv_func___argz_stringify',
  'ac_cv_func___setostype',
  'ac_cv_func__doprnt',
  'ac_cv_func_GetSystemTimeAsFileTime',
  'ac_cv_func_argz_count',
  'ac_cv_func_argz_next',
  'ac_cv_func_argz_stringify',
  'ac_cv_func_cap_rights_limit',
  'ac_cv_func_feenableexcept',
  'ac_cv_func_getwd',
  'ac_cv_func_mbscasecmp',
  'ac_cv_func_mbschr',
  'ac_cv_func_mbscmp',
  'ac_cv_func_obstack_printf',
  'ac_cv_func_setdtablesize',
] as const;

function absentSiteFacts(overrides: Record<string, string> = {}): string[] {
  const printFacts = [
    '. "$1";',
    'printf "%s\\n"',
    ...absentFunctionFacts.map((name) => `"$${name}"`),
  ].join(' ');
  const output = execFileSync(
    'bash',
    ['-c', printFacts, 'bash', CONFIG_SITE],
    { encoding: 'utf8', env: { ...process.env, ...overrides } },
  );
  return output.trimEnd().split('\n');
}

const gnulibBehaviorFacts = [
  'gl_cv_func_strcasecmp_works',
  'gl_cv_func_strerror_0_works',
] as const;

function gnulibSiteFacts(overrides: Record<string, string> = {}): string[] {
  const printFacts = [
    '. "$1";',
    'printf "%s\\n"',
    ...gnulibBehaviorFacts.map((name) => `"$${name}"`),
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
    expect(args).toContain('--host=wasm32-unknown-linux-musl');
    expect(args).toContain('--prefix=/usr');
  });

  it('uses the musl userland identity for wasm64 as well', () => {
    expect(buildConfigureArgs([], 'wasm64')).toContain('--host=wasm64-unknown-linux-musl');
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
    expect(env.WASM_POSIX_TARGET_ARCH).toBe('wasm32');
  });

  it('identifies wasm64 so config.site selects LP64 cache values', () => {
    const env = buildConfigureEnv('wasm64');
    expect(env.CC).toBe('wasm64posix-cc');
    expect(env.WASM_POSIX_TARGET_ARCH).toBe('wasm64');
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

describe('config.site absent function facts', () => {
  it('reports the BSD fmtcheck function as absent from musl', () => {
    expect(fmtcheckSiteFact()).toBe('no');
  });

  it('preserves a caller-provided fmtcheck result', () => {
    expect(fmtcheckSiteFact({ ac_cv_func_fmtcheck: 'yes' })).toBe('yes');
  });

  it('reports target functions absent from musl', () => {
    expect(absentSiteFacts()).toEqual(absentFunctionFacts.map(() => 'no'));
  });

  it('preserves caller overrides for absent target functions', () => {
    const facts = absentSiteFacts({ ac_cv_func_mbschr: 'yes' });
    expect(facts[absentFunctionFacts.indexOf('ac_cv_func_mbschr')]).toBe('yes');
  });
});

describe('config.site gnulib behavior facts', () => {
  it('reports working target string behavior', () => {
    expect(gnulibSiteFacts()).toEqual(gnulibBehaviorFacts.map(() => 'yes'));
  });

  it('preserves caller overrides for target string behavior', () => {
    expect(gnulibSiteFacts({
      gl_cv_func_strcasecmp_works: 'no',
      gl_cv_func_strerror_0_works: 'no',
    })).toEqual(['no', 'no']);
  });
});
