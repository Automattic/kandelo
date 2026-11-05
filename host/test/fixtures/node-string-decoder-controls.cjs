'use strict';
const assert = require('node:assert/strict'), vm = require('node:vm');
const Native = require('node:string_decoder').StringDecoder;
const { StringDecoder: Candidate, Buffer: CandidateBuffer } = require('./node-string-decoder-platform.cjs').create();
function result(fn) {
  try { return { value: fn() }; }
  catch (e) { return { name: e.name, code: e.code, message: e.message }; }
}
function compare(fn) { assert.deepEqual(result(() => fn(Candidate)), result(() => fn(Native))); }
const scenarios = {
  normalization() {
    for (const encoding of [undefined, null, '', 'UTF8', 'utf-16le', 'binary', 'ucs-2',
      'base64url', 'bad', 1, true, [], {}, new String('utf8'),
      { length: 4, toString() { return 'uTf8'; } },
      { get length() { throw new RangeError('length access'); } },
      { length: 4, [Symbol.toPrimitive]() { return 'UCS2'; } }]) {
      compare(Type => new Type(encoding).encoding);
    }
    compare(Type => {
      const events = [], receiver = { set encoding(value) { events.push(['set', value]); },
        get encoding() { events.push(['get']); return 'hex'; } };
      Type.call(receiver, 'utf8');
      const decoded = Type.prototype.write.call(receiver, Uint8Array.of(0x61));
      return { events, decoded };
    });
    // end deliberately uses the replaceable write property.
    compare(Type => {
      const d = new Type(), seen = [];
      d.write = value => { seen.push(value); return 'replaced'; };
      return [d.end('input'), seen];
    });
  },
  receivers() {
    for (const value of [undefined, null, {}, [], new ArrayBuffer(2), new SharedArrayBuffer(2),
      new Proxy(new Uint8Array(2), {})]) {
      for (const receiver of [{}, null]) compare(Type => Type.prototype.write.call(receiver, value));
    }
    compare(Type => Type.prototype.write.call(null, 'string bypass'));
    compare(Type => {
      const d = new Type('utf8'), proxy = new Proxy(d, {});
      return [proxy.write(Uint8Array.of(0xe2)), proxy.write(Uint8Array.of(0x82, 0xac)), proxy.end()];
    });
    compare(Type => {
      const d = new Type();
      const first = d.lastChar, second = d.lastChar;
      d.write(Uint8Array.of(0xe2));
      first[0] = 0x61;
      return [first === second, [...first], [...second], d.end(Uint8Array.of(0x82, 0xac))];
    });
    const names = Object.getOwnPropertyNames(Native.prototype);
    assert.deepEqual(Object.getOwnPropertyNames(Candidate.prototype), names);
    for (const name of names) {
      function shape(Type) {
        const d = Object.getOwnPropertyDescriptor(Type.prototype, name);
        return { configurable: d.configurable, enumerable: d.enumerable, writable: d.writable,
          get: d.get && [d.get.name, d.get.length], set: typeof d.set,
          value: typeof d.value === 'function' ? [d.value.name, d.value.length] : typeof d.value };
      }
      assert.deepEqual(shape(Candidate), shape(Native));
    }
  },
  incremental() {
    const vectors = [[], [0xef, 0xbb, 0xbf, 97], [0xe2], [0xe2, 0x82], [0xe2, 97],
      [0xe2, 0x82, 97], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80],
      [0xff, 0xfe, 0xfd], [0, 0xd8], [0, 0xd8, 0], [0, 0xd8, 0, 0xdc], [0, 0xdc]];
    let seed = 731;
    for (let i = 0; i < 80; i++) {
      const bytes = [];
      for (let j = 0; j < i % 19; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bytes.push(seed >>> 24); }
      vectors.push(bytes);
    }
    for (const encoding of ['utf8', 'utf16le', 'ascii', 'latin1', 'base64', 'base64url', 'hex']) {
      for (const input of vectors) for (const width of [1, 2, 3, 4, 7]) compare(Type => {
        const d = new Type(encoding), bytes = Uint8Array.from(input), steps = [];
        for (let i = 0; i < bytes.length; i += width) {
          const output = d.write(bytes.subarray(i, i + width));
          steps.push([output, d.lastNeed, d.lastTotal, [...d.lastChar]]);
        }
        steps.push(d.end(), d.end(Uint8Array.of(97)), d.lastNeed, d.lastTotal, [...d.lastChar]);
        return steps;
      });
    }
  },
  storage() {
    const raw = Uint8Array.of(0xff, 0x61, 0x62, 0xff);
    const shadow = raw.subarray(1, 3), data = new DataView(raw.buffer, 1, 2);
    for (const input of [shadow, data]) for (const property of ['buffer', 'byteOffset', 'byteLength']) {
      Object.defineProperty(input, property, { get() { throw Error('shadow accessor'); } });
    }
    const detachedBuffer = new ArrayBuffer(4), detached = new Uint8Array(detachedBuffer), detachedData = new DataView(detachedBuffer);
    structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
    const resizable = new ArrayBuffer(8, { maxByteLength: 16 });
    const fixed = new Uint8Array(resizable, 4, 2), fixedData = new DataView(resizable, 4, 2);
    resizable.resize(1);
    const shared = new Uint8Array(new SharedArrayBuffer(3)); shared.set([0xe2, 0x82, 0xac]);
    for (const input of [shadow, data, detached, detachedData, fixed, fixedData, shared,
      vm.runInNewContext('new Uint16Array([0x6261])')]) {
      compare(Type => new Type().end(input));
    }
    compare(Type => {
      const d = new Type('hex'), events = [];
      d.write(Uint8Array.of(1));
      const input = { slice(offset) { events.push(['slice', offset, d.lastNeed, d.lastTotal]); return Uint8Array.of(2); } };
      d.write = value => { events.push(['write', [...value]]); return 'text'; };
      return [d.text(input, 7), events];
    });
  },
  privateCodecs() {
    function poisoned(Type, BufferType) {
      const saved = Object.getOwnPropertyDescriptors(BufferType);
      const savedProto = Object.getOwnPropertyDescriptors(BufferType.prototype);
      const lower = String.prototype.toLowerCase;
      const fail = () => { throw Error('mutable conversion hook reached'); };
      let output;
      try {
        BufferType.from = fail; BufferType.prototype.toString = fail;
        String.prototype.toLowerCase = fail;
        output = new Type({ length: 4, toString: () => 'UtF8' }).end(Uint8Array.of(0xef, 0xbb, 0xbf, 0xe2, 0x82, 0xac));
      } finally {
        Object.defineProperties(BufferType, saved); Object.defineProperties(BufferType.prototype, savedProto);
        String.prototype.toLowerCase = lower;
      }
      return output;
    }
    assert.deepEqual(result(() => poisoned(Candidate, CandidateBuffer)), result(() => poisoned(Native, Buffer)));
    // A deliberately small injected ceiling verifies the error branch, not
    // either engine's actual maximum allocation or guest memory behavior.
    const { StringDecoder: Small } = require('./node-string-decoder-platform.cjs').create({ kStringMaxLength: 3 });
    assert.equal(result(() => new Small().write(Uint8Array.of(97, 97, 97, 97))).code, 'ERR_STRING_TOO_LONG');
  },
};
const selected = process.argv[2];
if (!Object.hasOwn(scenarios, selected)) throw Error('Select a known scenario');
scenarios[selected]();
console.log(JSON.stringify({ scenario: selected, passed: true }));
