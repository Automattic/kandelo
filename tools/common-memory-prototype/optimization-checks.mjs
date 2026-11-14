import { Group, PAGE, READ } from './runtime.mjs';
import { cInstance, MODES, PROFILES } from './optimization-runtime.mjs';
import { oracle } from './oracle.mjs';

function equal(a, b, why) { if (a !== b) throw Error(`${why}: ${a} != ${b}`); }
function trap(f, why) {
  let e;
  try { f(); } catch (error) { e = error; }
  if (!(e instanceof WebAssembly.RuntimeError)) throw Error(`expected trap: ${why}`);
}

export async function optimizationChecks(modules, remoteFactory) {
  const group = new Group(modules), results = [];
  let oracleOperations = 0;
  for (const profile of PROFILES) {
    const imports = WebAssembly.Module.imports(modules.profiles[profile]);
    if (imports.some(x => x.kind !== 'memory')) throw Error('unexpected C fixture import');
    for (const mode of MODES) {
      const randomized = oracle(group, () => {
        const ctx = group.context(), c = cInstance(group, ctx, profile);
        return { ...ctx, inline: c.scalar(mode), helper: c.scalar(mode) };
      });
      oracleOperations += randomized.operations;
      const ctx = group.context(), c = cInstance(group, ctx, profile);
      const physical = group.alloc(2), other = group.alloc();
      group.map(ctx, PAGE, physical, 2);
      group.map(ctx, 4 * PAGE, other);
      const array = new Uint32Array(group.memory.buffer, physical, 2 * PAGE / 4);
      for (let i = 0; i < array.length; i++) array[i] = i + 1;
      equal(c.call(mode, 'read', 259, PAGE, PAGE - 4) >>> 0, 259 * 260 / 2, `${profile}/${mode} read`);
      c.call(mode, 'write', 259, PAGE, PAGE - 4);
      for (let i = 0; i < 259; i++) equal(array[i], i, 'write loop');
      // Cache state is local to a call: changes are seen on the next entry.
      c.scalar(mode).store(4 * PAGE, 987);
      equal(c.call(mode, 'read', 1, 4 * PAGE, 0), 987, 'initial remap bytes');
      const replacement = group.alloc();
      group.map(ctx, 4 * PAGE, replacement);
      equal(c.call(mode, 'read', 1, 4 * PAGE, 0), 0, 'remap invalidates per-call cached knowledge');
      // A shared object may hold a virtual pointer into process-private data.
      const shared = group.alloc();
      group.map(ctx, 8 * PAGE, shared, 1, 3, true);
      c.scalar(mode).store(PAGE, 41);
      c.scalar(mode).store(8 * PAGE, PAGE);
      const child = group.fork(ctx), cc = cInstance(group, child, profile);
      cc.scalar(mode).store(PAGE, 42);
      equal(c.scalar(mode).load(c.scalar(mode).load(8 * PAGE)), 41, 'parent pointer graph');
      equal(cc.scalar(mode).load(cc.scalar(mode).load(8 * PAGE)), 42, 'child pointer graph');
      // Nonfaulting span guards must fall back, preserving a store prefix.
      const start = 2 * PAGE - 8;
      array.fill(0xaabbccdd);
      group.map(ctx, 2 * PAGE, physical + PAGE, 1, READ);
      trap(() => c.call(mode, 'write', 8, start, PAGE - 4), `${mode} denied suffix`);
      equal(array[PAGE / 4 - 2], 0, 'first prefix store');
      equal(array[PAGE / 4 - 1], 1, 'second prefix store');
      equal(array[PAGE / 4], 0xaabbccdd, 'denied suffix unchanged');
      equal(c.call(mode, 'read', 0, -1, 0), 0, 'zero iteration read');
      equal(c.call(mode, 'write', 0, -1, 0), 0, 'zero iteration write');
      group.map(ctx, 2 * PAGE, physical + PAGE);
      // A changed page with the same VA and a changed permission is not cached.
      c.call(mode, 'read', 1, 2 * PAGE, 0);
      group.map(ctx, 2 * PAGE, physical + PAGE, 1, 0);
      trap(() => c.call(mode, 'read', 1, 2 * PAGE, 0), 'permission change at next invocation');
      group.map(ctx, 2 * PAGE, physical + PAGE);
      // Unaligned inputs and split physical pages must retain scalar behavior.
      const scatter = group.alloc();
      group.map(ctx, 2 * PAGE, scatter);
      c.scalar(mode).store(start + 5, 0x12345678);
      equal(c.call(mode, 'read', 1, start + 5, 0), 0x12345678, 'unaligned split loop');
      trap(() => c.call(mode, 'atomic', 1, PAGE + 1, 0), 'unaligned atomic');
      c.scalar(mode).store(PAGE, 0);
      equal(c.call(mode, 'atomic', 100, PAGE, 0), 4950, 'atomic old-value checksum');
      equal(c.scalar(mode).load(PAGE), 100, 'atomic count');
      results.push(`${profile}/${mode}: oracle, loops, graph clone, faults, remap, atomics`);
    }
  }
  // A fresh group bounds monotonic fixture allocation and tests SIMD/bulk
  // fallbacks independently from the scalar random oracle.
  const extra = new Group(modules), ctx = extra.context();
  const physical = extra.alloc(2), scattered = extra.alloc(), dest = extra.alloc();
  const deniedDest = extra.alloc(2), scatterDest = extra.alloc();
  extra.map(ctx, PAGE, physical, 2);
  extra.map(ctx, 8 * PAGE, dest);
  for (const profile of PROFILES) {
    const c = cInstance(extra, ctx, profile);
    for (const mode of ['vector', 'combined']) {
      for (const unaligned of [0, 1, 2, 3]) {
        const base = PAGE + unaligned;
        // Byte pattern is defined independently from Wasm's vector reduction.
        const bytes = new Uint8Array(extra.memory.buffer, physical, PAGE + 32);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i * 17 & 255;
        let expected = 0;
        const view = new DataView(extra.memory.buffer);
        for (let i = 0; i < 263; i++) expected = expected + view.getUint32(physical + unaligned + i * 4, true) | 0;
        equal(c.call(mode, 'simd_read', 263, base, PAGE - 4), expected, 'SIMD unaligned/tail sum');
        c.call(mode, 'simd_write', 263, base, PAGE - 4);
        for (let i = 0; i < 263; i++) equal(view.getUint32(physical + unaligned + i * 4, true), i, 'SIMD unaligned/tail write');
      }
      extra.map(ctx, 2 * PAGE, scattered);
      c.scalar('generic').store(2 * PAGE - 4, 5);
      c.scalar('generic').store(2 * PAGE, 7);
      equal(c.call(mode, 'simd_read', 2, 2 * PAGE - 4, 12), 12, 'SIMD rejected span scalar tail');
      const array = new Uint32Array(extra.memory.buffer, physical, PAGE / 4);
      const target = new Uint32Array(extra.memory.buffer, scattered, PAGE / 4);
      array.fill(999); target.fill(999);
      extra.map(ctx, 2 * PAGE, scattered, 1, READ);
      trap(() => c.call(mode, 'simd_write', 8, 2 * PAGE - 8, PAGE - 4), 'SIMD preserves fault prefix');
      equal(array[array.length - 2], 0, 'SIMD first prefix store');
      equal(array[array.length - 1], 1, 'SIMD second prefix store');
      equal(target[0], 999, 'SIMD denied suffix untouched');
      extra.map(ctx, 2 * PAGE, physical + PAGE);
    }
    for (const mode of ['generic', 'scalarized', 'combined']) {
      const bytes = new Uint8Array(extra.memory.buffer, physical, PAGE);
      for (let i = 0; i < PAGE; i++) bytes[i] = i * 29 & 255;
      c.call(mode, 'copy', 1, 8 * PAGE, PAGE);
      if (!new Uint8Array(extra.memory.buffer, dest, PAGE).every((v, i) => v === bytes[i])) throw Error('bulk copy bytes');
      extra.map(ctx, 16 * PAGE, deniedDest);
      extra.map(ctx, 17 * PAGE, deniedDest + PAGE, 1, READ);
      const deniedBytes = new Uint8Array(extra.memory.buffer, deniedDest, 2 * PAGE);
      deniedBytes.fill(0x55);
      trap(() => c.call(mode, 'copy', 1, 16 * PAGE + PAGE / 2, PAGE), 'bulk denied destination suffix');
      if (!deniedBytes.every(v => v === 0x55)) throw Error('bulk denied destination had a partial write');
      extra.map(ctx, 9 * PAGE, scatterDest);
      c.call(mode, 'copy', 1, 8 * PAGE + PAGE / 2, PAGE);
      if (!new Uint8Array(extra.memory.buffer, dest + PAGE / 2, PAGE / 2).every((v, i) => v === bytes[i]) ||
          !new Uint8Array(extra.memory.buffer, scatterDest, PAGE / 2).every((v, i) => v === bytes[i + PAGE / 2]))
        throw Error('bulk fragmented destination');
      // Overlapping aliases require memmove behavior, including scalar fallback.
      const before = new Uint8Array(extra.memory.buffer, physical, PAGE + 16).slice();
      c.call(mode, 'copy', 1, PAGE + 7, PAGE);
      if (!new Uint8Array(extra.memory.buffer, physical + 7, PAGE).every((v, i) => v === before[i])) throw Error('bulk overlap');
      extra.map(ctx, 12 * PAGE, physical, 2);
      const aliasBefore = new Uint8Array(extra.memory.buffer, physical, PAGE + 16).slice();
      c.call(mode, 'copy', 1, 12 * PAGE + 7, PAGE);
      if (!new Uint8Array(extra.memory.buffer, physical + 7, PAGE).every((v, i) => v === aliasBefore[i])) throw Error('bulk alias overlap');
    }
  }
  const peers = await Promise.all([remoteFactory(), remoteFactory()]);
  try {
    const child = extra.context();
    extra.map(child, 12 * PAGE, dest, 1, 3, true);
    for (const [profile, mode] of [['O2', 'span'], ['O2', 'cache'], ['O3-lto-post', 'combined']]) {
      new Uint32Array(extra.memory.buffer, dest, 1)[0] = 0;
      await Promise.all(peers.map((peer, i) => peer.call('init', {
        module: modules.profiles[profile], memory: extra.memory,
        stackTop: extra.alloc() + PAGE,
      })));
      await Promise.all(peers.map((peer, i) => peer.call('run', { name: `${mode}_atomic`,
        args: [100000, (i ? 12 : 8) * PAGE, 0, [ctx, child][i].root, [ctx, child][i].scratch] })));
      equal(new Uint32Array(extra.memory.buffer, dest, 1)[0], 200000, 'optimized concurrent atomic total');
    }
  } finally { await Promise.all(peers.map(p => p.close())); }
  return { scalarGroups: results, oracleOperations, extra: 'SIMD tails/unaligned/fault prefixes, bulk overlap, and real two-Worker optimized atomics passed',
    lifetime: 'mappings stable during each call; caches reset at every call', generalCompilerPass: false };
}
