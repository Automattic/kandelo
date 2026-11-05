import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as util from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
const fixture = createRequire(import.meta.url)('./fixtures/node-dotenv-platform.cjs');
const target = createRequire(import.meta.url)('../../packages/registry/node-compat/target.json');
function outcome(fn: () => unknown) {
  try { return { value: fn() }; }
  catch (e: any) { return { name: e.name, code: e.code, message: e.message, syscall: e.syscall, path: e.path }; }
}
describe.skipIf(process.versions.node !== target.version)('dotenv public wrappers over explicit native owners', () => {
  let directory: string | undefined;
  const keys = ['KANDELO_DOTENV_ONE', 'KANDELO_DOTENV_TWO', 'KANDELO_DOTENV_EMPTY'];
  const original = keys.map(key => process.env[key]);
  afterEach(() => {
    if (directory) { rmSync(directory, { recursive: true, force: true }); directory = undefined; }
    keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; });
  });
  it('preserves parser null prototype, duplicate and special keys, quotes and UTF-8 conversion', () => {
    const candidate = fixture.create();
    for (const content of ['', 'FOO=one\nFOO=two\n__proto__=value\nconstructor=ctor',
      'export FOO="a\\nb"\r\nQUOTED=\' a # b \'\n  #comment\nBARE=x # comment',
      ' A = `one\ntwo`\nBROKEN="quote\nNEXT=next',
      '10=ten\n2=two\n😀=😃\nNUL=a\0b\nBAD=\ud800', '=\nexport EMPTY=\n LAST=  ',
      '\uFEFFKEY=one\n\tTAB = x\rbroken\n']) {
      const value = candidate.util.parseEnv(content);
      expect(value).toEqual(util.parseEnv(content)); expect(Object.getPrototypeOf(value)).toBe(null);
      expect(Object.getOwnPropertyDescriptors(value)).toEqual(Object.getOwnPropertyDescriptors(util.parseEnv(content)));
    }
  });
  it('validates content and keeps public function metadata before entering native parser', () => {
    const candidate = fixture.create();
    for (const value of [null, undefined, 1, {}, [], Buffer.from('A=B'), Symbol('input')])
      expect(outcome(() => candidate.util.parseEnv(value))).toEqual(outcome(() => util.parseEnv(value as any)));
    expect(candidate.calls).toEqual([]);
    expect([candidate.util.parseEnv.name, candidate.util.parseEnv.length]).toEqual([util.parseEnv.name, util.parseEnv.length]);
    expect([candidate.loadEnvFile.name, candidate.loadEnvFile.length]).toEqual([process.loadEnvFile.name, process.loadEnvFile.length]);
  });
  it('loads actual files for string/Buffer/URL paths and preserves existing even empty variables', () => {
    const candidate = fixture.create(); directory = mkdtempSync(join(tmpdir(), 'kandelo-dotenv-'));
    const file = join(directory, 'load.env');
    writeFileSync(file, 'KANDELO_DOTENV_ONE=new\nKANDELO_DOTENV_TWO="two\\nlines"\nKANDELO_DOTENV_EMPTY=overwritten\n');
    for (const input of [file, Buffer.from(file), pathToFileURL(file)]) {
      process.env[keys[0]] = 'existing'; delete process.env[keys[1]]; process.env[keys[2]] = '';
      expect(candidate.loadEnvFile(input)).toBeUndefined();
      const actual = keys.map(key => process.env[key]);
      delete process.env[keys[1]]; process.loadEnvFile(input);
      expect(actual).toEqual(keys.map(key => process.env[key]));
      expect(actual).toEqual(['existing', 'two\nlines', '']);
    }
  });
  it('matches invalid paths, missing-file errors and default null/undefined path selection', () => {
    const candidate = fixture.create(); directory = mkdtempSync(join(tmpdir(), 'kandelo-dotenv-'));
    for (const input of [join(directory, 'missing'), directory, '', 1, {}, 'nul\0path', Buffer.from('nul\0path'), new URL('https://example.com/')])
      expect(outcome(() => candidate.loadEnvFile(input))).toEqual(outcome(() => process.loadEnvFile(input as any)));
    const cwd = process.cwd();
    try {
      process.chdir(directory); writeFileSync('.env', 'KANDELO_DOTENV_TWO=default\n');
      for (const input of [undefined, null]) {
        delete process.env[keys[1]]; candidate.loadEnvFile(input);
        expect(process.env[keys[1]]).toBe('default');
      }
    } finally { process.chdir(cwd); }
  });
});
