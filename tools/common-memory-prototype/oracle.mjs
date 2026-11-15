import { PAGE, LIMIT } from './runtime.mjs';

// Byte/object model independent of the encoded page table and Wasm resolver.
export function oracle(group, contextFactory = () => group.context()) {
  const ctx = contextFactory(), model = new Map(), objects = [];
  let seed = 0x17ab75;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  for (const [page, rights] of [[48, 3], [49, 3], [50, 1], [52, 2], [53, 0]]) {
    const physical = group.alloc(), expected = new Uint8Array(PAGE);
    for (let i = 0; i < PAGE; i++) expected[i] = random() & 255;
    new Uint8Array(group.memory.buffer, physical, PAGE).set(expected);
    const object = { physical, expected };
    objects.push(object);
    model.set(page, { object, rights });
    group.map(ctx, page * PAGE, physical, 1, rights);
  }
  model.set(54, model.get(49));
  group.map(ctx, 54 * PAGE, model.get(49).object.physical);
  let operations = 0, denied = 0;
  for (const mode of ['inline', 'helper']) {
    for (let i = 0; i < 3000; i++) {
      const page = 48 + random() % 7;
      const offset = i % 4 === 0 ? PAGE - 1 - random() % 4 : random() % PAGE;
      const va = i % 101 === 0 ? LIMIT - random() % 4 : page * PAGE + offset;
      const writing = (random() & 1) === 1, value = random();
      const locations = [];
      for (let j = 0; j < 4; j++) {
        const address = va + j, mapping = model.get(Math.floor(address / PAGE));
        if (address >= LIMIT || !mapping || !(mapping.rights & (writing ? 2 : 1))) break;
        locations.push({ bytes: mapping.object.expected, index: address % PAGE });
      }
      let error, actual;
      try { actual = writing ? ctx[mode].store(va, value) : ctx[mode].load(va); } catch (e) { error = e; }
      if (locations.length !== 4) {
        if (!(error instanceof WebAssembly.RuntimeError)) throw Error(`oracle expected trap: ${mode} ${va}`);
        denied++;
      } else {
        if (error) throw error;
        if (writing) locations.forEach(({ bytes, index }, j) => { bytes[index] = value >>> (8 * j) & 255; });
        else {
          const expected = locations.reduce((v, { bytes, index }, j) => v | bytes[index] << (8 * j), 0);
          if (actual !== expected) throw Error(`oracle read mismatch: ${mode} ${va}`);
        }
      }
      operations++;
    }
    for (const { physical, expected } of objects) {
      if (!new Uint8Array(group.memory.buffer, physical, PAGE).every((x, i) => x === expected[i])) {
        throw Error(`oracle physical byte mismatch: ${mode}`);
      }
    }
  }
  return { operations, denied, seed: '0x17ab75', independentByteModel: true };
}
