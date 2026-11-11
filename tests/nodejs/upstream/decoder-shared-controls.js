const observations = [], matrix = [];
let failures = 0;
function assert(condition, message) { if (!condition) throw new Error(message); }
function check(name, run) {
  try { const detail = run(); observations.push({ name, status: 'pass', detail }); }
  catch (error) { failures++; observations.push({ name, status: 'fail', error: { name: error.name, message: error.message, stack: error.stack } }); }
}
function state(encoding) {
  const storage = new Uint8Array(binding.kSize);
  storage[binding.kEncodingField] = binding.encodings.indexOf(encoding);
  assert(storage[binding.kEncodingField] !== 255, 'unknown reference encoding');
  return storage;
}
check('native-export-descriptors-and-encoding-layout', () => Object.fromEntries(
  Reflect.ownKeys(binding).map(name => {
    const d = Object.getOwnPropertyDescriptor(binding, name), v = d.value;
    return [name, { writable: d.writable, enumerable: d.enumerable, configurable: d.configurable,
      value: typeof v === 'function' ? { type: 'function', name: v.name, length: v.length } : v }];
  })));
for (const [encoding, input, expected] of [
  ['utf8', [0x41, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80], 'Aé😀'],
  ['utf16le', [0x41, 0, 0x3d, 0xd8, 0, 0xde], 'A😀'],
  ['ascii', [0x41, 0xc1, 0xff], 'AA\x7f'],
  ['latin1', [0x41, 0xc1, 0xff], 'AÁÿ'],
  ['hex', [0x41, 0x42, 0xff], '4142ff'],
  ['base64', [1, 2, 3, 4], 'AQIDBA=='],
  ['base64url', [0xfb, 0xff, 0xff, 0xfe], '-____g'],
]) check('incremental-known-output-' + encoding, () => {
  const s = state(encoding); let actual = '';
  for (const byte of input) { collect(); actual += binding.decode(s, Uint8Array.of(byte)); }
  actual += binding.flush(s);
  assert(actual === expected, JSON.stringify({ actual, expected }));
  assert(s[binding.kMissingBytes] === 0 && s[binding.kBufferedBytes] === 0, 'state not cleared');
  return { actual, state: Array.from(s) };
});
check('input-view-offset-and-byte-length-use-actual-backing-memory', () => {
  const bytes = Uint8Array.of(0xff, 0x41, 0x42, 0xff), s = state('utf8');
  const output = binding.decode(s, new DataView(bytes.buffer, 1, 2));
  assert(output === 'AB', output); return output;
});
check('state-view-offset-writes-only-the-decoder-bytes', () => {
  const bytes = new Uint8Array(binding.kSize + 4).fill(0xa5), s = bytes.subarray(2, 2 + binding.kSize);
  s.fill(0); s[binding.kEncodingField] = binding.encodings.indexOf('utf8');
  assert(binding.decode(s, Uint8Array.of(0xe2)) === '', 'unexpected incomplete output'); collect();
  assert(binding.decode(s, Uint8Array.of(0x82, 0xac)) === '€', 'lost decoder state');
  assert(bytes[0] === 0xa5 && bytes[1] === 0xa5 && bytes.at(-1) === 0xa5 && bytes.at(-2) === 0xa5, 'state escaped its view');
  return Array.from(bytes);
});
check('shared-input-and-state-are-real-backing-storage', () => {
  const s = new Uint8Array(new SharedArrayBuffer(binding.kSize));
  s[binding.kEncodingField] = binding.encodings.indexOf('utf8');
  const bytes = new Uint8Array(new SharedArrayBuffer(3)); bytes.set([0xe2, 0x82, 0xac]);
  assert(binding.decode(s, bytes.subarray(0, 1)) === '', 'unexpected partial shared output');
  assert(s[binding.kMissingBytes] === 2, 'shared state was not written'); collect();
  assert(binding.decode(s, bytes.subarray(1)) === '€', 'shared decoding failed');
  return Array.from(s);
});
check('detached-input-is-observed-as-an-empty-view', () => {
  const bytes = Uint8Array.of(0x41), s = state('utf8');
  detachBuffer(bytes.buffer);
  const output = binding.decode(s, bytes); assert(output === '', 'detached input was read'); return output;
});
check('record-original-native-chunk-boundaries-and-state', () => {
  const inputs = [[], [0x41], [0xc3], [0xc3, 0xa9], [0xf0, 0x9f, 0x98, 0x80],
    [0xe2, 0x82, 0x41, 0xac], [0xc0, 0x80, 0xff, 0x41], [0xed, 0xa0, 0x80],
    [0x3d, 0xd8, 0, 0xde, 0x41], [0xff, 0xfe, 1, 2, 3, 4, 5]];
  for (const encoding of ['ascii', 'utf8', 'base64', 'utf16le', 'latin1', 'hex', 'base64url']) {
    for (const input of inputs) for (const width of [1, 2, 3, 8]) {
      const s = state(encoding), chunks = [];
      for (let offset = 0; offset < input.length; offset += width) {
        const bytes = Uint8Array.from(input.slice(offset, offset + width));
        const output = binding.decode(s, bytes);
        chunks.push({ input: Array.from(bytes), output, state: Array.from(s) });
      }
      const flushed = binding.flush(s);
      matrix.push({ encoding, input, width, chunks, flushed, state: Array.from(s) });
    }
  }
  return { entries: matrix.length };
});
check('resizable-view-lengths-and-pins-restore-after-return', () => {
  const memory = new ArrayBuffer(binding.kSize, {maxByteLength:64}), s = new Uint8Array(memory);
  s[binding.kEncodingField] = binding.encodings.indexOf('utf8');
  const input = new ArrayBuffer(1,{maxByteLength:8}), view = new Uint8Array(input); view[0]=0xe2;
  assert(binding.decode(s,view)==='', 'partial RAB output');memory.resize(14);input.resize(2);view.set([0x82,0xac]);
  assert(binding.decode(s,view)==='€','RAB storage/length lost');
  memory.resize(64);input.resize(8);
  assert(s.slice(14).every(byte=>byte===0) && view.slice(2).every(byte=>byte===0),'RAB growth was not zero-filled');
  s.fill(0xa5,14);view.fill(0xa5,2);memory.resize(14);input.resize(2);memory.resize(64);input.resize(8);
  assert(s.slice(14).every(byte=>byte===0) && view.slice(2).every(byte=>byte===0),'RAB shrink/regrow retained old bytes');
  return {state:Array.from(s),inputLength:view.length};
});
check('state-and-input-alias-the-same-original-allocation', () => {
  const s=state('utf8');s[0]=0xe2;s[binding.kBufferedBytes]=1;s[binding.kMissingBytes]=2;
  const output=binding.decode(s,s.subarray(0,1));assert(output==='�','aliased malformed prefix');
  assert(s[binding.kBufferedBytes]===1 && s[binding.kMissingBytes]===2,'aliased state lost');return {output,state:Array.from(s)};
});
check('bulk-codec-paths-preserve-multibyte-and-NUL-characters',()=>{
  const latin=Uint8Array.from({length:1200},(_,i)=>i%2?0xa9:0xc3);
  assert(binding.decode(state('utf8'),latin)==='é'.repeat(600),'Latin1-fitting UTF8 fast path');
  const pattern=[65,0xc3,0xa9,0xf0,0x9f,0x98,0x80],valid=Uint8Array.from({length:700},(_,i)=>pattern[i%pattern.length]);
  assert(binding.decode(state('utf8'),valid)==='Aé😀'.repeat(100),'UTF16 UTF8 fast path');
  const invalid=[0xed,0xa0,0x80,0,65],bytes=Uint8Array.from({length:500},(_,i)=>invalid[i%5]);
  assert(binding.decode(state('utf8'),bytes)===('���\0A').repeat(100),'malformed UTF8 or embedded NUL changed');
});
