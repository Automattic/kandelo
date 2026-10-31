import { readFileSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { StringDecoder as NativeStringDecoder } from 'node:string_decoder';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../../packages/registry/node-compat/bootstrap.js', import.meta.url), 'utf8');
function section(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw Error(`Decoder source boundaries missing: ${start}, ${end}`);
  return source.slice(a, b);
}
function implementation(nativeHook: boolean) {
  return runInNewContext(
    section("if (typeof globalThis.TextEncoder === 'undefined') {", '// Some JavaScript engine parsers') +
    section('function _bufferInputBytes(', 'const _builtinModules =') +
    section('const Buffer = (() => {', '// process module') +
    section('const string_decoder = (() => {', '// timers module') +
    ';({TextEncoder, TextDecoder, Buffer, StringDecoder:string_decoder.StringDecoder})', {
      Uint8Array, ArrayBuffer, SharedArrayBuffer, DataView, TypeError, RangeError, Buffer, btoa, atob,
      _nodeNative: nativeHook ? { decodeUtf8(bytes: Uint8Array) {
        if (bytes.buffer instanceof SharedArrayBuffer) throw Error('one-shot native converter received a live shared span');
        if (!isUtf8(bytes)) throw Error('one-shot native converter received malformed or partial UTF-8');
        return Buffer.from(bytes).toString('utf8');
      } } : {},
    });
}
function outcome(fn: () => unknown) {
  try { return { value: fn() }; }
  catch (error: any) { return { name: error.name, code: error.code }; }
}
function streamed(Type: any, encoding: string, bytes: Uint8Array, width: number, options = {}) {
  const decoder = new Type(encoding, options);
  let output = '';
  for (let i = 0; i < bytes.length; i += width) output += decoder.decode(bytes.subarray(i, i + width), { stream: true });
  return output + decoder.decode();
}
const vectors = [[], [0xef,0xbb,0xbf,97], [0xc2,0x80], [0xe2,0x82,0xac], [0xf4,0x8f,0xbf,0xbf],
  [0xe2], [0xe2,0x82], [0xe2,97], [0xe2,0x82,97], [0xc0,0x80], [0xed,0xa0,0x80],
  [0xf0,0x80,0x80,0x80], [0xf4,0x90,0x80,0x80], [0xff,0xfe,0xfd,0xfc],
  [0,0xd8], [0,0xd8,0], [0,0xd8,0,0xdc], [0,0xdc], [0xfe,0xff,0,97], [0xff,0xfe,97,0]];

describe.each([false, true])('Node text codecs (native hook=%s)', nativeHook => {
  const subject = implementation(nativeHook);
  it('encodes all UTF-16 units and fills only complete UTF-8 code points', () => {
    const encoder = new subject.TextEncoder(), native = new TextEncoder();
    for (let unit = 0; unit <= 0xffff; unit++) {
      const input = String.fromCharCode(unit);
      const actual = encoder.encode(input), expected = native.encode(input);
      if (actual.length !== expected.length || actual.some((byte: number, index: number) => byte !== expected[index])) {
        throw Error('UTF-16 encode mismatch: ' + unit);
      }
    }
    for (const input of ['', 'hello', '€', '😀', '\ud800', '\udc00', 'a\ud800b', '\ud800\ud800', '\udc00\ud800', 'a€😀z']) {
      for (let size = 0; size < 18; size++) {
        const backing = new Uint8Array(size + 4).fill(0xff), reference = new Uint8Array(size + 4).fill(0xff);
        const destination = backing.subarray(2, 2 + size), expected = reference.subarray(2, 2 + size);
        expect(encoder.encodeInto(input, destination)).toEqual(native.encodeInto(input, expected));
        expect([...backing]).toEqual([...reference]);
      }
    }
    for (const value of [undefined, null, 1, true, new String('a'), Symbol('x'), { toString: () => '€', valueOf: () => 7 }]) {
      expect(outcome(() => [...encoder.encode(value)])).toEqual(outcome(() => [...native.encode(value as any)]));
      expect(outcome(() => encoder.encodeInto(value, new Uint8Array(8)))).toEqual(outcome(() => native.encodeInto(value as any, new Uint8Array(8))));
    }
    const buffer = new ArrayBuffer(4), detached = new Uint8Array(buffer);
    structuredClone(buffer, { transfer: [buffer] });
    for (const destination of [detached, new Uint8ClampedArray(8), new Uint16Array(8), new DataView(new ArrayBuffer(8)), new SharedArrayBuffer(8)]) {
      expect(outcome(() => encoder.encodeInto('a', destination))).toEqual(outcome(() => native.encodeInto('a', destination as any)));
    }
    expect(subject.TextEncoder.length).toBe(TextEncoder.length);
    expect(encoder.encode.length).toBe(native.encode.length);
    expect(encoder.encodeInto.length).toBe(native.encodeInto.length);
    expect(Object.keys(subject.TextEncoder.prototype)).toEqual(Object.keys(TextEncoder.prototype));
    expect(Object.prototype.toString.call(encoder)).toBe('[object TextEncoder]');
    // Node 26 uses private-field receiver errors; the Node 24 build toolchain
    // still reports ERR_INVALID_THIS. Pin the verified target behavior.
    expect(outcome(() => subject.TextEncoder.prototype.encode.call({}))).toEqual({ name: 'TypeError', code: undefined });
    expect(subject.Buffer.from('\ud800').toString('utf8')).toBe('\ufffd');
  });

  it('matches native UTF-8 and UTF-16 for every single- and two-byte input', () => {
    for (const encoding of ['utf-8', 'utf-16le', 'utf-16be']) {
      const actual = new subject.TextDecoder(encoding), expected = new TextDecoder(encoding);
      for (let first = 0; first < 256; first++) {
        const single = Uint8Array.of(first);
        expect(actual.decode(single)).toBe(expected.decode(single));
        for (let second = 0; second < 256; second++) {
          const bytes = Uint8Array.of(first, second);
          const got = actual.decode(bytes), wanted = expected.decode(bytes);
          if (got !== wanted) throw Error(JSON.stringify({ encoding, bytes: [...bytes], got, wanted }));
        }
      }
    }
  }, 30_000);

  it('retains state across splits, malformed continuations, BOMs and fatal errors', () => {
    let seed = 20261031;
    const inputs = vectors.map(bytes => Uint8Array.from(bytes));
    inputs.push(new TextEncoder().encode('a'.repeat(4095) + '€'));
    for (let i = 0; i < 200; i++) {
      const input = new Uint8Array(i % 17);
      for (let n = 0; n < input.length; n++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; input[n] = seed >>> 24; }
      inputs.push(input);
    }
    for (const encoding of ['utf-8', 'utf-16le', 'utf-16be', 'windows-1252']) {
      for (const bytes of inputs) for (const width of [1, 2, 3, 4, 7, 4096]) {
        for (const options of [{}, { ignoreBOM: true }, { fatal: true }]) {
          expect(outcome(() => streamed(subject.TextDecoder, encoding, bytes, width, options)))
            .toEqual(outcome(() => streamed(TextDecoder, encoding, bytes, width, options)));
        }
      }
    }
    const decoder = new subject.TextDecoder('utf-8', { fatal: true });
    expect(() => decoder.decode(Uint8Array.of(0xe2), { stream: true })).not.toThrow();
    expect(() => decoder.decode()).toThrow(TypeError);
    expect(decoder.decode(Uint8Array.of(97))).toBe('a');
  }, 30_000);

  it('normalizes supported labels and honors options, input brands and intrinsic bounds', () => {
    for (const label of [{ toString: () => 'utf8', valueOf: () => 'wrong' }, { [Symbol.toPrimitive]: (hint: string) => hint === 'string' ? 'utf8' : 'wrong' }, undefined, 'utf8', ' UTF-8\t', 'unicode-1-1-utf-8', 'utf-16', 'unicodefffe', 'latin1', 'ascii', 'x-cp1252', 'no-encoding', '\u00a0utf-8']) {
      expect(outcome(() => new subject.TextDecoder(label).encoding)).toEqual(outcome(() => new TextDecoder(label as any).encoding));
    }
    for (const options of [undefined, null, 0, '', true, {}, [], { fatal: true, ignoreBOM: true }]) {
      expect(outcome(() => { const d = new subject.TextDecoder('utf8', options); return [d.fatal, d.ignoreBOM]; }))
        .toEqual(outcome(() => { const d = new TextDecoder('utf8', options as any); return [d.fatal, d.ignoreBOM]; }));
      expect(outcome(() => new subject.TextDecoder().decode(undefined, options)))
        .toEqual(outcome(() => new TextDecoder().decode(undefined, options as any)));
    }
    const array = Uint8Array.of(0xff,97,0xff), dataView = new DataView(array.buffer, 1, 1);
    const shadow = array.subarray(1,2);
    for (const value of [shadow, dataView]) for (const property of ['buffer', 'byteOffset', 'byteLength']) {
      Object.defineProperty(value, property, { get() { throw Error('shadow accessor'); } });
    }
    const detached = new ArrayBuffer(4), detachedView = new Uint8Array(detached), detachedData = new DataView(detached);
    structuredClone(detached, { transfer: [detached] });
    for (const value of [undefined, null, '', 7, {}, [], new ArrayBuffer(0), new SharedArrayBuffer(2),
      shadow, dataView, detached, detachedView, detachedData, runInNewContext('new Uint8Array([97])')]) {
      expect(outcome(() => new subject.TextDecoder().decode(value)))
        .toEqual(outcome(() => new TextDecoder().decode(value as any)));
    }
    // A shared span can change after validation. The test hook refuses such
    // spans, so the state machine must decode them without that assumption.
    const sharedSubject = implementation(nativeHook);
    const shared = new SharedArrayBuffer(1);
    new Uint8Array(shared)[0] = 97;
    expect(new sharedSubject.TextDecoder().decode(shared)).toBe('a');
    for (const options of [{}, { fatal: true }]) {
      expect(new subject.TextDecoder('windows-1252', options).decode(Uint8Array.from({ length: 256 }, (_, i) => i)))
        .toBe(new TextDecoder('windows-1252', options).decode(Uint8Array.from({ length: 256 }, (_, i) => i)));
    }
    expect(subject.TextDecoder.length).toBe(TextDecoder.length);
    expect(subject.TextDecoder.prototype.decode.length).toBe(TextDecoder.prototype.decode.length);
    expect(Object.prototype.toString.call(new subject.TextDecoder())).toBe('[object TextDecoder]');
    expect(Object.keys(subject.TextDecoder.prototype)).toEqual(Object.keys(TextDecoder.prototype));
    expect(outcome(() => subject.TextDecoder.prototype.decode.call({})))
      .toEqual(outcome(() => TextDecoder.prototype.decode.call({})));
  });

  it('matches StringDecoder byte output and end/reset behavior across encodings', () => {
    for (const encoding of ['utf8', 'utf16le', 'latin1', 'ascii', 'hex', 'base64', 'base64url']) {
      for (const input of vectors) for (const width of [1, 2, 3, 4, 7]) {
        const actual = new subject.StringDecoder(encoding), expected = new NativeStringDecoder(encoding as any) as NativeStringDecoder & {lastNeed:number;lastTotal:number;lastChar:Buffer};
        const bytes = Uint8Array.from(input);
        for (let i = 0; i < bytes.length; i += width) {
          expect(actual.write(bytes.subarray(i, i + width)), JSON.stringify({ encoding, input, width, i }))
            .toBe(expected.write(bytes.subarray(i, i + width)));
        }
        expect([actual.lastNeed, actual.lastTotal, [...actual.lastChar]]).toEqual([expected.lastNeed, expected.lastTotal, [...expected.lastChar]]);
        expect(actual.end()).toBe(expected.end());
        expect(actual.end(Uint8Array.of(97))).toBe(expected.end(Uint8Array.of(97)));
      }
    }
    for (const label of [undefined, null, '', 'UTF8', 'utf-16le', 'binary', 'ucs-2', 'wrong', 1, true, [], {}, new String('utf8')]) {
      expect(outcome(() => new subject.StringDecoder(label).encoding)).toEqual(outcome(() => (new NativeStringDecoder(label as any) as any).encoding));
    }
    expect(subject.Buffer.from([0xef,0xbb,0xbf,97]).toString('utf8')).toBe('\ufeffa');
    for (const value of ['a', new Uint16Array([97]), new DataView(new Uint8Array([97]).buffer), undefined, null, new ArrayBuffer(2)]) {
      expect(outcome(() => new subject.StringDecoder().write(value)))
        .toEqual(outcome(() => new NativeStringDecoder().write(value as any)));
    }
    const called: any = {}; subject.StringDecoder.call(called); expect(called.encoding).toBe('utf8');
    const actual = new subject.StringDecoder(), expected = new NativeStringDecoder();
    actual.write(Uint8Array.of(0xe2)); expected.write(Uint8Array.of(0xe2));
    expect(actual.end('a')).toBe(expected.end('a' as any));
  });
});

describe('SpiderMonkey text output adapter', () => {
  it('matches UTF-8 encoding before a native TextEncoder is available', () => {
    const adapter = readFileSync(new URL('../../packages/registry/spidermonkey/node-compat/adapter.js', import.meta.url), 'utf8');
    const a = adapter.indexOf('    function encodeUtf8(value) {'), b = adapter.indexOf('    function decodeUtf8(value)', a);
    if (a < 0 || b < 0) throw Error('Adapter encoding source missing');
    const encode = runInNewContext('const encoder=null;\n' + adapter.slice(a,b) + ';encodeUtf8', { Uint8Array });
    const native = new TextEncoder();
    for (let value = 0; value <= 0xffff; value++) {
      const input = String.fromCharCode(value), actual: Uint8Array = encode(input), expected = native.encode(input);
      if (actual.length !== expected.length || actual.some((byte, index) => byte !== expected[index])) throw Error('Adapter UTF-16 mismatch: ' + value);
    }
    for (const input of ['😀', '\ud800\ud800\udc00', '\udc00\ud800', '\ud800a']) expect([...encode(input)]).toEqual([...native.encode(input)]);
  });
});
