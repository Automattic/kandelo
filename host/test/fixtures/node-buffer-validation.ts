export const bufferValidationSource = `
const valid = [[], [0], [0x7f], [0xc2,0x80], [0xdf,0xbf],
  [0xe0,0xa0,0x80], [0xed,0x9f,0xbf], [0xef,0xbf,0xbf],
  [0xf0,0x90,0x80,0x80], [0xf4,0x8f,0xbf,0xbf]];
const invalid = [[0x80], [0xc0,0x80], [0xc1,0xbf], [0xc2], [0xc2,0x7f],
  [0xe0,0x9f,0xbf], [0xed,0xa0,0x80], [0xef,0xbf],
  [0xf0,0x8f,0xbf,0xbf], [0xf4,0x90,0x80,0x80], [0xf5,0x80,0x80,0x80],
  [0xf0,0x90,0x80], [0xf0,0x90,0x80,0x7f], [0xff]];
for (const bytes of valid) if (!isUtf8(Uint8Array.from(bytes))) throw Error('valid '+bytes);
for (const bytes of invalid) if (isUtf8(Uint8Array.from(bytes))) throw Error('invalid '+bytes);
const backing = Uint8Array.from([0xff, 0x61, 0x62, 0xff]);
if (!isUtf8(backing.subarray(1,3))) throw Error('view bounds');
if (!isUtf8(new ArrayBuffer(0)) || !isAscii(new ArrayBuffer(0))) throw Error('empty');
if (!isAscii(Uint8Array.from([0,127])) || isAscii(Uint8Array.from([128]))) throw Error('ASCII');
for (const value of [null, undefined, '', 42, [], {}, new DataView(backing.buffer)]) {
  for (const fn of [isUtf8,isAscii]) {
    let threw = false;
    try { fn(value); } catch (e) { threw = e instanceof TypeError && e.code === 'ERR_INVALID_ARG_TYPE'; }
    if (!threw) throw Error('input type');
  }
}
class ByteSubclass extends Uint8Array {}
for (const Type of [Uint8Array, ByteSubclass]) {
  for (const key of ['buffer', 'byteOffset', 'byteLength']) {
    const value = new Type([0xff, 0x61]);
    Object.defineProperty(value, key, { get() { throw Error('shadow getter accessed: ' + key); } });
    if (isAscii(value) || isUtf8(value)) throw Error('shadowed byte validation: ' + key);
  }
  const value = new Type([0xff]);
  Object.defineProperty(value, 'buffer', { value: new ArrayBuffer(1) });
  if (isAscii(value) || isUtf8(value)) throw Error('substitute buffer accepted');
}
console.log('buffer-validation-ok');
`;
