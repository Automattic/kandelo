import { Group, PAGE } from './runtime.mjs';

function assert(ok, why) { if (!ok) throw Error(why); }
function median(xs) { return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]; }
function seedRandom(seed) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
}

export async function benchmark(modules, progress = () => {}) {
  const results = [];
  // All three variants use the same common backing and loop shape. Native gets
  // physical addresses; translated variants get unchanged virtual addresses.
  for (const size of [PAGE, 8 * 1024 * 1024]) {
    const group = new Group(modules), ctx = group.context();
    const physical = group.alloc(size / PAGE), destPhysical = group.alloc(1);
    const va = 4 * PAGE, destVA = 200 * PAGE;
    group.map(ctx, va, physical, size / PAGE);
    group.map(ctx, destVA, destPhysical);
    const words = new Uint32Array(group.memory.buffer, physical, size / 4);
    const dst = new Uint32Array(group.memory.buffer, destPhysical, PAGE / 4);
    const order = Uint32Array.from({ length: words.length }, (_, i) => i);
    const rand = seedRandom(0x735976);
    for (let i = order.length - 1; i > 0; i--) {
      const j = rand() % (i + 1), x = order[i]; order[i] = order[j]; order[j] = x;
    }
    const next = new Uint32Array(order.length);
    for (let i = 0; i < order.length; i++) next[order[i]] = order[(i + 1) % order.length];
    for (const workload of ['read', 'chase', 'write', 'atomic', 'copy64k']) {
      if (size !== PAGE && ['atomic', 'copy64k'].includes(workload)) continue;
      const setup = mode => {
        if (workload === 'chase') {
          const base = mode === 'native' ? physical : va;
          for (let i = 0; i < words.length; i++) words[i] = base + 4 * next[i];
        } else if (workload === 'atomic') words[0] = 0;
        else for (let i = 0; i < words.length; i++) words[i] = i + 1;
        if (workload === 'copy64k') dst.fill(0);
      };
      const invoke = (mode, n) => {
        const base = mode === 'native' ? physical : va;
        return workload === 'copy64k'
          ? ctx[mode][workload](n, mode === 'native' ? destPhysical : destVA, base)
          : ctx[mode][workload](n, base, size - 4);
      };
      let expectedChase;
      const verify = (n, value) => {
        if (workload === 'atomic') {
          assert(words[0] === n, 'atomic final count');
          assert(value === Number(BigInt.asIntN(32, BigInt(n) * BigInt(n - 1) / 2n)), 'atomic return checksum');
        } else if (workload === 'write') {
          for (const i of [0, 1, 17, words.length - 1]) {
            const last = n - 1 - ((n - 1 - i) & (words.length - 1));
            assert(words[i] === (last >= 0 ? last : i + 1), 'write final contents');
          }
        } else if (workload === 'copy64k') {
          assert(dst.every((x, i) => x === i + 1), 'copy final contents');
        } else if (workload === 'read') {
          const count = BigInt(words.length), q = BigInt(Math.floor(n / words.length)), r = BigInt(n % words.length);
          const total = q * count * (count + 1n) / 2n + r * (r + 1n) / 2n;
          assert(value === Number(BigInt.asIntN(32, total)), 'read checksum');
        } else if (workload === 'chase') {
          assert(value === expectedChase, 'independent pointer-chase checksum');
        }
      };
      let n = workload === 'copy64k' ? 256 : 65536;
      // Tier-up is outside the samples. The fastest control chooses a common
      // iteration count; no variant gets a more favorable per-sample workload.
      for (;;) {
        setup('native');
        const t = performance.now(); invoke('native', n); const ms = performance.now() - t;
        if (ms >= 50 || n >= 134217728) break;
        n *= 2;
      }
      if (workload === 'chase') {
        // Traverse the whole large graph repeatedly even if calibration caught
        // a transient slow sample. Avoid a whole-cycle zero XOR: skipping all
        // the loads must not accidentally satisfy the checksum check.
        n = Math.max(n, 4 * words.length) + 137;
        let index = 0;
        expectedChase = 0;
        // A full power-of-two cycle visits every offset exactly once, whose
        // XOR is zero. Independently model the nonzero remainder in JS.
        for (let i = 0; i < n % words.length; i++) {
          index = next[index]; expectedChase ^= index * 4;
        }
        assert(expectedChase !== 0, 'pointer-chase fixture must have nonzero checksum');
      }
      for (const mode of ['native', 'inline', 'helper']) {
        for (let i = 0; i < 3; i++) { setup(mode); verify(n, invoke(mode, n)); }
      }
      const samples = { native: [], inline: [], helper: [] }, checksums = {};
      const orderLog = [];
      for (let round = 0; round < 9; round++) {
        const modes = ['native', 'inline', 'helper'];
        const rotate = round % 3;
        const sequence = [...modes.slice(rotate), ...modes.slice(0, rotate)];
        if (round % 2) sequence.reverse();
        orderLog.push(sequence);
        for (const mode of sequence) {
          setup(mode);
          const t = performance.now();
          const value = invoke(mode, n);
          const ms = performance.now() - t;
          verify(n, value);
          checksums[mode] = value;
          samples[mode].push(ms);
        }
      }
      assert(checksums.native === checksums.inline && checksums.inline === checksums.helper, 'matched variant checksum');
      const stats = Object.fromEntries(Object.entries(samples).map(([mode, times]) => [mode, {
        medianMs: median(times), minMs: Math.min(...times), maxMs: Math.max(...times),
        medianNsPerOp: median(times) * 1e6 / n,
      }]));
      const result = { workload, workingSetBytes: size, iterations: n, samples, order: orderLog, stats,
        inlineOverNative: stats.inline.medianMs / stats.native.medianMs,
        helperOverNative: stats.helper.medianMs / stats.native.medianMs,
        bytesPerOp: workload === 'copy64k' ? PAGE : 4, checksums };
      results.push(result);
      progress({ workload, size, inlineOverNative: result.inlineOverNative, helperOverNative: result.helperOverNative });
      // Yield only between cases, never inside the timed guest computation.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return { results, measured: 'trusted standalone Wasm mechanisms; no application or Kandelo speedup claim',
    protocol: '9 rotated/reversed rounds; common native-calibrated >=50ms target; 3 warmups per variant; setup excluded',
    pageSize: PAGE, virtualAddressLimit: 64 * 1024 * 1024,
    checks: 'bounds, R/W permissions, cross-page scalar fallback; page table stable during calls',
    excludes: ['concurrent mapping revocation', 'untrusted module validation', 'general C rewrite', 'kernel/syscall host translation', 'fork continuation', 'dynamic linking', 'memory64', 'SIMD'] };
}
