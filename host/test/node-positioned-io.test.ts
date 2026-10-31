import * as native from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';

const source = native.readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
function section(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error('Missing filesystem source boundary');
  return source.slice(a, b);
}
// Exercise the actual shared functions against real host descriptors. The
// bridge implements only the native engine boundary; it never models a cursor.
const linuxErrno: Record<string, number> = { EBADF: 9, EINVAL: 22, EFBIG: 27, ESPIPE: 29, EOVERFLOW: 75 };
const transfer = (writing: boolean, fd: number, data: ArrayBuffer, offset: number, length: number, position: number | bigint | null) => {
  try {
    const view = new Uint8Array(data, offset, length);
    return writing ? native.writeSync(fd, view, 0, length, position as any)
      : native.readSync(fd, view, 0, length, position);
  } catch (error: any) { if (linuxErrno[error.code]) return -linuxErrno[error.code]; throw error; }
};
const subject = Function('os', 'Buffer',
  section('function _errnoToCode(', 'function _checkErrno(') +
  section('    function _ioArgumentError(', '    // fs-minipass guards') +
  section('    class FileHandle {', '    function mkdtempSync(') +
  ';return {readSync,writeSync,read,FileHandle};')({
  read: (...args: any[]) => (transfer as any)(false, ...args, null),
  pread: (...args: any[]) => (transfer as any)(false, ...args),
  write: (...args: any[]) => (transfer as any)(true, ...args, null),
  pwrite: (...args: any[]) => (transfer as any)(true, ...args),
}, Buffer);
const directory = native.mkdtempSync(join(tmpdir(), 'kandelo-positioned-'));
afterAll(() => native.rmSync(directory, { recursive: true }));
let serial = 0;
function file(fn: (fd: number, path: string) => unknown) {
  const path = join(directory, String(serial++));
  native.writeFileSync(path, 'abcdefgh');
  const fd = native.openSync(path, 'r+');
  try { return fn(fd, path); } finally { native.closeSync(fd); }
}
function outcome(fn: () => unknown) {
  try { return { value: fn() }; } catch (error: any) { return { name: error.name, code: error.code }; }
}
function next(fd: number) { const b = Buffer.alloc(1); native.readSync(fd, b, 0, 1, null); return b.toString(); }

describe('shared Node positioned I/O', () => {
  it('preserves the real descriptor cursor across positioned reads and writes', () => {
    file((fd, path) => {
      expect(next(fd)).toBe('a');
      const bytes = Buffer.alloc(2);
      expect(subject.readSync(fd, bytes, 0, 2, 4)).toBe(2);
      expect(bytes.toString()).toBe('ef');
      expect(next(fd)).toBe('b');
      expect(subject.writeSync(fd, Buffer.from('XY'), 0, 2, 5)).toBe(2);
      expect(next(fd)).toBe('c');
      expect(native.readFileSync(path, 'utf8')).toBe('abcdeXYh');
      expect(subject.writeSync(fd, 'Z', 7, 'utf8')).toBe(1);
      expect(next(fd)).toBe('d');
    });
  });

  it('treats null and minus-one reads as sequential, including bigint minus one', () => {
    for (const position of [null, undefined, -1, -1n]) file(fd => {
      const a = Buffer.alloc(2), b = Buffer.alloc(2);
      subject.readSync(fd, a, 0, 2, position);
      subject.readSync(fd, b, 0, 2, position);
      expect(a.toString() + b.toString()).toBe('abcd');
    });
  });

  it('matches Node read position validation and options without mutation', () => {
    const positions = [null, undefined, -1, -1n, 0, 1, 1n, 9, 9n, Number.MAX_SAFE_INTEGER,
      2n ** 63n - 5n, 2n ** 63n, 2n ** 63n - 4n, NaN, -Infinity, Infinity, -0.999,
      -(2n ** 64n), Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE, false, true, '1', Symbol(1), {}, [], () => {}, Promise.resolve(1)];
    for (const position of positions) for (const options of [false, true]) {
      const run = (fs: any) => file(fd => {
        const bytes = Buffer.alloc(4);
        const args = options ? [fd, bytes, Object.freeze({ offset: 0, length: 4, position })]
          : [fd, bytes, 0, 4, position];
        return [fs.readSync(...args), bytes.toString('hex'), next(fd)];
      });
      expect(outcome(() => run(subject)), `${String(position)}, options=${options}`)
        .toEqual(outcome(() => run(native)));
    }
  });

  it('preserves zero-read validation order and transfer bounds', () => {
    for (const offset of [undefined, null, -1, 0, 1, 4, 5, 1.5, '0']) for (const length of [0, 1, 4, -1, 1.5, undefined]) {
      const run = (fs: any) => file(fd => {
        const b = Buffer.alloc(4);
        return [fs.readSync(fd, b, offset, length, 0), b.toString('hex'), next(fd)];
      });
      expect(outcome(() => run(subject)), `${String(offset)},${String(length)}`).toEqual(outcome(() => run(native)));
    }
    expect(subject.readSync(123456, Buffer.alloc(0), 0, 0, 0)).toBe(0);
    expect(outcome(() => subject.readSync(123456, Buffer.alloc(0), 0, 0, 'bad')))
      .toEqual(outcome(() => native.readSync(123456, Buffer.alloc(0), 0, 0, 'bad' as any)));
  });

  it('matches write position fallback, string encodings and options', () => {
    for (const position of [undefined, null, -1, -1n, 0, 0n, 1, 1n, 1.5, -2, NaN, Infinity, '1', true, {}, 2n ** 63n, 2 ** 53]) {
      for (const string of [false, true]) {
        const run = (fs: any) => file((fd, path) => {
          next(fd);
          const n = string ? fs.writeSync(fd, 'e9', position, 'hex') : fs.writeSync(fd, Buffer.from('x'), 0, 1, position);
          return [n, next(fd), native.readFileSync(path).toString('hex')];
        });
        expect(outcome(() => run(subject)), `${String(position)}, string=${string}`).toEqual(outcome(() => run(native)));
      }
    }
    for (const options of [null, undefined, {}, { offset: 1, length: 2, position: 4 }, { offset: 4 }, { length: -1 },
      { length: 1.5 }, { offset: true }, { offset: 5 }, { offset: 3, length: 2 }]) {
      const run = (fs: any) => file((fd, path) => [fs.writeSync(fd, Buffer.from('1234'), options), native.readFileSync(path, 'utf8'), next(fd)]);
      expect(outcome(() => run(subject))).toEqual(outcome(() => run(native)));
    }
  });

  it('supports foreign typed views, DataViews and byte ranges', () => {
    for (const build of [() => new Uint16Array(4), () => new DataView(new ArrayBuffer(8), 2, 4),
      () => runInNewContext('new Uint8Array(new ArrayBuffer(8), 2, 4)')]) {
      const run = (fs: any) => file(fd => {
        const view = build();
        return [fs.readSync(fd, view, 1, 2, 3), Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('hex'), next(fd)];
      });
      expect(run(subject)).toEqual(run(native));
    }
  });

  it('reports real descriptor errors without an offset-changing fallback', () => {
    expect(outcome(() => subject.readSync(123456, Buffer.alloc(1), 0, 1, 0)))
      .toEqual(outcome(() => native.readSync(123456, Buffer.alloc(1), 0, 1, 0)));
    expect(outcome(() => subject.writeSync(123456, Buffer.alloc(1), 0, 1, 0)))
      .toEqual(outcome(() => native.writeSync(123456, Buffer.alloc(1), 0, 1, 0)));
  });

  it('validates callback overloads synchronously and defers I/O results', async () => {
    for (const form of ['positional', 'options', 'buffer-options']) {
      const path = join(directory, String(serial++)); native.writeFileSync(path, 'abcdefgh');
      const fd = native.openSync(path, 'r+');
      try {
        const buffer = Buffer.alloc(2), options = Object.freeze({ buffer, offset: 0, length: 2, position: 4n });
        let sync = true;
        const result = new Promise<void>((resolve, reject) => {
          const cb = (error: Error | null, count: number, value: unknown) => {
            if (error) return reject(error);
            try { expect(sync).toBe(false); expect(count).toBe(2); expect(value).toBe(buffer);
              expect(buffer.toString()).toBe('ef'); expect(next(fd)).toBe('a'); resolve(); } catch (e) { reject(e); }
          };
          if (form === 'positional') subject.read(fd, buffer, 0, 2, 4n, cb);
          else if (form === 'options') subject.read(fd, options, cb);
          else subject.read(fd, buffer, options, cb);
          sync = false;
        });
        await result;
        expect(outcome(() => subject.read(fd, options, () => {}))).toEqual({ value: undefined });
        for (const position of ['bad', NaN, 2n ** 63n]) {
          expect(outcome(() => subject.read(fd, { buffer, position }, () => { throw Error('invalid input reached callback'); })))
            .toEqual(outcome(() => native.read(fd, { buffer, position } as any, () => {})));
        }
      } finally { native.closeSync(fd); }
    }
  });

  it('uses the same positioned operations for FileHandle options and buffers', async () => {
    for (const form of ['positional', 'options', 'buffer-options']) {
      const path = join(directory, String(serial++)); native.writeFileSync(path, 'abcdefgh');
      const fd = native.openSync(path, 'r+');
      try {
        const handle = new subject.FileHandle(fd, path), buffer = Buffer.alloc(2);
        const options = Object.freeze({ buffer, offset: 0, length: 2, position: 4n });
        const result = form === 'positional' ? await handle.read(buffer, 0, 2, 4n)
          : form === 'options' ? await handle.read(options) : await handle.read(buffer, options);
        expect(result.bytesRead).toBe(2); expect(result.buffer).toBe(buffer); expect(buffer.toString()).toBe('ef');
        expect(next(fd)).toBe('a');
        await expect(handle.read({ buffer, position: 'bad' })).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_TYPE' });
      } finally { native.closeSync(fd); }
    }
  });
});
