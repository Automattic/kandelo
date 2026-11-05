import { File as NativeFile, Blob as NativeBlob } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createWebDataPlatform } from './fixtures/node-web-data-platform';

const target = JSON.parse(readFileSync(new URL('../../packages/registry/node-compat/target.json', import.meta.url), 'utf8'));
const native = { Blob: NativeBlob, File: NativeFile, FormData };
function failure(fn: () => unknown) {
  try { fn(); return undefined; }
  catch (error: any) { return { name: error.name, code: error.code, message: error.message }; }
}
async function details(file: any) {
  return { name: file.name, modified: file.lastModified, type: file.type, size: file.size,
    text: await file.text(), bytes: Array.from(await file.bytes()) };
}

describe.skipIf(process.versions.node !== target.version)('pinned File and FormData source contracts', () => {
  it('inherits Blob storage and matches File metadata/descriptors', async () => {
    const subject = createWebDataPlatform();
    for (const api of [subject, native]) {
      const file = new api.File(['one', new Uint8Array([50])], 'name', { type: 'TEXT/PLAIN', lastModified: 7 });
      expect(file).toBeInstanceOf(api.File); expect(file).toBeInstanceOf(api.Blob);
      expect(Object.prototype.toString.call(file)).toBe('[object File]');
    }
    expect(await details(new subject.File(['one', new Uint8Array([50])], 'name', { type: 'TEXT/PLAIN', lastModified: 7 })))
      .toEqual(await details(new NativeFile(['one', new Uint8Array([50])], 'name', { type: 'TEXT/PLAIN', lastModified: 7 })));
    for (const key of ['name', 'lastModified', Symbol.toStringTag]) {
      const a = Object.getOwnPropertyDescriptor(subject.File.prototype, key)!, b = Object.getOwnPropertyDescriptor(NativeFile.prototype, key)!;
      expect([a.enumerable, a.configurable, a.writable, typeof a.get]).toEqual([b.enumerable, b.configurable, b.writable, typeof b.get]);
    }
  });

  it('matches filename scalar conversion and timestamp edge values', () => {
    const { File } = createWebDataPlatform();
    for (const name of ['x\ud800', null, undefined, 7, { toString: () => 'coerced' }]) {
      for (const lastModified of [null, 0, -4.5, NaN, Infinity, -Infinity, '8']) {
        const a = new File([], name, { lastModified }), b = new NativeFile([], name as any, { lastModified: lastModified as any });
        expect([a.name, a.lastModified]).toEqual([b.name, b.lastModified]);
      }
    }
    const before = Date.now(), file = new File([], 'now'), after = Date.now();
    expect(file.lastModified).toBeGreaterThanOrEqual(before); expect(file.lastModified).toBeLessThanOrEqual(after);
  });

  it('matches missing arguments, invalid metadata and getter receivers', () => {
    const { File } = createWebDataPlatform();
    const scenarios = [(F: any) => new F(), (F: any) => new F([]),
      (F: any) => new F([], Symbol('name')), (F: any) => new F([], 'name', { lastModified: 1n }),
      (F: any) => new F([], 'name', { lastModified: Symbol('time') })];
    for (const scenario of scenarios) expect(failure(() => scenario(File))).toEqual(failure(() => scenario(NativeFile)));
    for (const key of ['name', 'lastModified']) {
      const a = Object.getOwnPropertyDescriptor(File.prototype, key)!.get!, b = Object.getOwnPropertyDescriptor(NativeFile.prototype, key)!.get!;
      for (const receiver of [{}, null, Object.create(File.prototype)]) {
        expect(failure(() => a.call(receiver))).toEqual(failure(() => b.call(receiver)));
      }
    }
  });

  it('copies raw shared buffers and view byte ranges into File and Blob ownership', async () => {
    const subject = createWebDataPlatform();
    async function run(api: any) {
      const buffer = new SharedArrayBuffer(4), view = new Uint8Array(buffer); view.set([65, 66, 67, 68]);
      const file = new api.File([buffer, new DataView(buffer, 1, 2)], 'bytes', { lastModified: 5 });
      view.fill(0);
      return details(file);
    }
    expect(await run(subject)).toEqual(await run(native));
  });

  it('preserves actual bytes through inherited Blob streaming and slicing', async () => {
    const subject = createWebDataPlatform();
    async function run(api: any) {
      const file = new api.File(['a\r\nb\r\nc'], 'lines', { lastModified: 8 });
      const reader = file.stream().getReader(), chunks: number[] = [];
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(...value); } }
      finally { reader.releaseLock(); }
      return { chunks, slice: await file.slice(1, -1).text(), file: await details(file) };
    }
    expect(await run(subject)).toEqual(await run(native));
  });

  it('matches custom inspection and exercises actual File clone payload ownership', async () => {
    const subject = createWebDataPlatform();
    const file = new subject.File(['owned'], 'original', { lastModified: 11, type: 'text/plain' });
    const expected = new NativeFile(['owned'], 'original', { lastModified: 11, type: 'text/plain' });
    expect(inspect(file)).toEqual(inspect(expected));
    const copy = subject.clonePayload(file);
    expect(copy).toBeInstanceOf(subject.File); expect(copy).not.toBe(file);
    expect(await details(copy)).toEqual(await details(structuredClone(expected)));
    const bytes = await copy.bytes(); bytes.fill(0);
    expect(await copy.text()).toBe('owned'); expect(await file.text()).toBe('owned');
  });

  it('matches ordered duplicate entries, replacement and deletion', () => {
    const subject = createWebDataPlatform();
    function run(api: any) {
      const form = new api.FormData(); form.append('a', 'one'); form.append('b', 'two'); form.append('a', 'three');
      const result: unknown[] = [[...form], form.get('a'), form.getAll('a'), form.get('missing'), form.has('b')];
      form.set('a', 'replace'); result.push([...form]); form.delete('b'); result.push([...form]);
      form.set('new', 'last'); result.push([...form]); return result;
    }
    expect(run(subject)).toEqual(run(native));
  });

  it('matches scalar strings, filenames and File value preservation', async () => {
    const subject = createWebDataPlatform();
    async function run(api: any) {
      const form = new api.FormData(), file = new api.File(['payload'], 'before', { type: 'text/plain', lastModified: 4 });
      form.append('bad\ud800', 'value\udfff'); form.append('number', 42); form.append('file', file);
      expect(form.get('file')).toBe(file);
      form.append('renamed', file, 'after\ud800');
      return [[...form].slice(0, 2), await details(form.get('renamed'))];
    }
    expect(await run(subject)).toEqual(await run(native));
  });

  it('wraps Blob entries in actual File values with independent bytes', async () => {
    const subject = createWebDataPlatform();
    async function run(api: any) {
      const form = new api.FormData(), source = new Uint8Array([65, 66]);
      form.append('data', new api.Blob([source], { type: 'text/x-test' })); source.fill(0);
      const file = form.get('data'); expect(file).toBeInstanceOf(api.File);
      const { modified, ...result } = await details(file);
      expect(Number.isFinite(modified)).toBe(true); return result;
    }
    expect(await run(subject)).toEqual(await run(native));
  });

  it('keeps iterators live while entries mutate and preserves iterator prototypes', () => {
    const subject = createWebDataPlatform();
    function run(api: any) {
      const form = new api.FormData(); form.append('a', 'one'); form.append('b', 'two');
      const iterator = form.entries(), result: unknown[] = [iterator.next()];
      form.delete('b'); form.append('c', 'three'); result.push(iterator.next(), iterator.next());
      form.append('d', 'four'); result.push(iterator.next(), Object.prototype.toString.call(iterator), iterator[Symbol.iterator]() === iterator);
      return result;
    }
    expect(run(subject)).toEqual(run(native));
    expect(subject.FormData.prototype[Symbol.iterator]).toBe(subject.FormData.prototype.entries);
  });

  it('matches forEach callback arguments and observable mutation', () => {
    const subject = createWebDataPlatform();
    function run(api: any) {
      const form = new api.FormData(); form.append('a', 'one'); form.append('b', 'two');
      const receiver = {}, result: unknown[] = [];
      form.forEach(function(this: unknown, value: unknown, key: unknown, owner: unknown) {
        result.push([key, value, owner === form, this === receiver]);
        if (key === 'a') { form.delete('b'); form.append('c', 'three'); }
      }, receiver); return result;
    }
    expect(run(subject)).toEqual(run(native));
  });

  it('matches FormData argument conversion and receiver failures', () => {
    const subject = createWebDataPlatform();
    const scenarios = [(F: any) => new F(null), (F: any) => new F().append('a'),
      (F: any) => new F().append('a', 'text', 'filename'), (F: any) => new F().append(Symbol(), 'value'),
      (F: any) => new F().set('a', Symbol()), (F: any) => new F().get(),
      (F: any) => F.prototype.get.call({}, 'a'), (F: any) => F.prototype.forEach.call({}, () => {}),
      (F: any) => new F().forEach(null), (F: any) => new F().entries().next.call({})];
    for (const scenario of scenarios) expect(failure(() => scenario(subject.FormData))).toEqual(failure(() => scenario(FormData)));
  });

  it('marks FormData as uncloneable at the real native serializer boundary', () => {
    const subject = createWebDataPlatform(), form = new subject.FormData(); form.append('a', 'one');
    expect(subject.modes.get(form)).toBe(0);
    expect(failure(() => structuredClone(form))?.name).toBe(failure(() => structuredClone(new FormData()))?.name);
    expect(failure(() => structuredClone({ nested: form }))?.name).toBe('DataCloneError');
  });
});
