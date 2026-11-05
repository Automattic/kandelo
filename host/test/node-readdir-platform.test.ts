import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { create } = require('./fixtures/node-readdir-platform.cjs');
const target = JSON.parse(fs.readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node26-readdir-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'child')); fs.mkdirSync(path.join(root, 'empty'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'a'); fs.writeFileSync(path.join(root, '€😀'), 'b');
  fs.writeFileSync(path.join(root, 'child', 'leaf'), 'c');
  fs.symlinkSync('child', path.join(root, 'alias')); fs.symlinkSync('absent', path.join(root, 'broken'));
  return root;
}
function normalized(value: any): any {
  if (ArrayBuffer.isView(value)) return { bytes: Array.from(value as Uint8Array) };
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object' && typeof value.isFile === 'function')
    return { name: normalized(value.name), parentPath: normalized(value.parentPath),
      kinds: ['isFile', 'isDirectory', 'isSymbolicLink', 'isBlockDevice', 'isCharacterDevice', 'isFIFO', 'isSocket'].map(k => value[k]()) };
  return value;
}
function errorValue(error: any) {
  return { name: error.name, code: error.code, errno: error.errno,
    syscall: error.syscall, path: error.path, message: error.message };
}
function outcome(fn: () => any) { try { return { value: normalized(fn()) }; } catch (e) { return { error: errorValue(e) }; } }
const callback = (api: any, input: any, options: any) => new Promise((resolve, reject) =>
  api.readdir(input, options, (e: any, result: any) => e ? reject(e) : resolve(result)));

describe('pinned directory entry/public scan owners with native dependencies', () => {
  it('uses the exact target native reference', () => { expect(process.versions.node).toBe(target.version); });
  it('preserves entry types, names, parent paths, class identity and descriptors', () => {
    const candidate = create(), root = tree();
    expect(normalized(candidate.api.readdirSync(root, { withFileTypes: true })))
      .toEqual(normalized(fs.readdirSync(root, { withFileTypes: true })));
    for (let type = 0; type <= 7; type++) {
      const a = new candidate.api.Dirent('name', type, root), b = new fs.Dirent('name', type, root);
      expect(normalized(a)).toEqual(normalized(b));
      expect(Object.getPrototypeOf(a)).toBe(candidate.api.Dirent.prototype);
      expect(Object.getOwnPropertyNames(a)).toEqual(Object.getOwnPropertyNames(b));
      expect(Object.getOwnPropertySymbols(a).map(String)).toEqual(Object.getOwnPropertySymbols(b).map(String));
    }
    const descriptors = (proto: any) => Object.fromEntries(Reflect.ownKeys(proto).map(k => {
      const d = Object.getOwnPropertyDescriptor(proto, k)!;
      return [String(k), { enumerable: d.enumerable, configurable: d.configurable, writable: d.writable,
        name: typeof d.value === 'function' ? d.value.name : undefined, length: typeof d.value === 'function' ? d.value.length : undefined }];
    }));
    expect(descriptors(candidate.api.Dirent.prototype)).toEqual(descriptors(fs.Dirent.prototype));
  });
  it('encodes actual byte names and recursive results with the target aliases', () => {
    const candidate = create(), root = tree();
    for (const encoding of ['utf8', 'buffer', 'latin1', 'ascii', 'hex', 'base64', 'ucs2', 'UTF-8'])
      for (const recursive of [false, true]) for (const withFileTypes of [false, true]) {
        const options = { encoding, recursive, withFileTypes };
        expect(outcome(() => candidate.api.readdirSync(root, options)), JSON.stringify(options))
          .toEqual(outcome(() => fs.readdirSync(root, options as any)));
      }
    for (const input of [Buffer.from(root), pathToFileURL(root)])
      expect(normalized(candidate.api.readdirSync(input, { withFileTypes: true })))
        .toEqual(normalized(fs.readdirSync(input, { withFileTypes: true })));
  });
  it('preserves callback and promise validation/errors and recursive symlink traversal', async () => {
    const candidate = create(), root = tree();
    for (const options of [{}, { withFileTypes: true }, { recursive: true },
      { recursive: true, withFileTypes: true, encoding: 'buffer' }]) {
      expect(normalized(await callback(candidate.api, root, options)))
        .toEqual(normalized(await callback(fs, root, options)));
      expect(normalized(await candidate.promises.readdir(root, options)))
        .toEqual(normalized(await fs.promises.readdir(root, options as any)));
    }
    for (const input of [path.join(root, 'absent'), path.join(root, 'a.txt')]) {
      expect(outcome(() => candidate.api.readdirSync(input))).toEqual(outcome(() => fs.readdirSync(input)));
      for (const invoke of [() => callback(candidate.api, input, {}), () => candidate.promises.readdir(input)]) {
        let actual; try { await invoke(); } catch (e) { actual = errorValue(e); }
        let expected; try { await fs.promises.readdir(input); } catch (e) { expected = errorValue(e); }
        expect(actual).toEqual(expected);
      }
    }
    for (const options of [{ recursive: 'yes' }, { encoding: 'invalid' }, 1])
      expect(outcome(() => candidate.api.readdirSync(root, options))).toEqual(outcome(() => fs.readdirSync(root, options as any)));
  });
  it('uses real lstat for unknown types and preserves its errors rather than inventing files', async () => {
    const candidate = create({ forceUnknown: true }), root = tree();
    expect(normalized(candidate.api.readdirSync(root, { withFileTypes: true })))
      .toEqual(normalized(fs.readdirSync(root, { withFileTypes: true })));
    expect(normalized(await callback(candidate.api, root, { withFileTypes: true })))
      .toEqual(normalized(fs.readdirSync(root, { withFileTypes: true })));
    const missing = path.join(root, 'absent');
    expect(outcome(() => candidate.utilities.getDirent(root, 'absent', 0)))
      .toEqual(outcome(() => fs.lstatSync(missing)));
    const result = await new Promise(resolve => candidate.utilities.getDirent(root, 'absent', 0, (e: any) => resolve(errorValue(e))));
    let expected; try { await fs.promises.lstat(missing); } catch (e) { expected = errorValue(e); }
    expect(result).toEqual(expected);
  });
});
