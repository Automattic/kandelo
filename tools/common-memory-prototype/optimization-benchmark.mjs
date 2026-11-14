import { Group, PAGE } from './runtime.mjs';
import { cInstance, PROFILES } from './optimization-runtime.mjs';

function assert(ok, why) { if (!ok) throw Error(why); }
function median(xs) { return [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]; }
function randomGenerator(seed) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
}
function shuffle(xs, random) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = random() % (i + 1), value = xs[i]; xs[i] = xs[j]; xs[j] = value;
  }
  return xs;
}

function candidates(op) {
  if (op === 'copy') return [
    { id: 'O2/scalarized', profile: 'O2', mode: 'scalarized', operation: op },
    { id: 'O2/bulk-preserved', profile: 'O2', mode: 'generic', operation: op },
    { id: 'O3/bulk-preserved', profile: 'O3', mode: 'generic', operation: op },
    { id: 'O3-lto/bulk-preserved', profile: 'O3-lto', mode: 'generic', operation: op },
    { id: 'O3-lto-auto/bulk-preserved', profile: 'O3-lto-auto', mode: 'generic', operation: op },
    { id: 'all', profile: 'O3-lto-post', mode: 'combined', operation: op },
  ];
  const result = ['generic', 'span', 'cache', 'aligned', 'combined'].map(mode =>
    ({ id: `O2/${mode}`, profile: 'O2', mode, operation: op }));
  if (['read', 'write'].includes(op)) result.push(
    { id: 'O2/vector', profile: 'O2', mode: 'vector', operation: `simd_${op}` },
    { id: 'O2/combined-vector', profile: 'O2', mode: 'combined', operation: `simd_${op}` });
  if (['read', 'chase', 'fields'].includes(op)) {
    for (const profile of ['O2', 'O3', 'O3-lto']) result.push({ id: `${profile}/opaque`, profile, mode: 'opaque', operation: op });
  }
  for (const profile of ['O3', 'O3-lto', 'O3-lto-auto']) result.push({ id: `${profile}/generic`, profile, mode: 'generic', operation: op });
  result.push({ id: 'all', profile: 'O3-lto-post', mode: 'combined',
    operation: ['read', 'write'].includes(op) ? `simd_${op}` : op });
  return result;
}

export async function optimizationBenchmark(modules, progress = () => {}, options = {}) {
  const group = new Group(modules), ctx = group.context();
  const instances = Object.fromEntries(PROFILES.map(profile => [profile, cInstance(group, ctx, profile)]));
  const data = group.alloc(128), nativeData = group.alloc(128);
  const dest = group.alloc(), nativeDest = group.alloc();
  const va = 4 * PAGE, destVA = 200 * PAGE;
  const allBytes = new Uint8Array(group.memory.buffer);
  const cases = [];
  for (const size of [PAGE, 8 * 1024 * 1024]) {
    for (const op of ['read', 'write', 'chase', 'fields']) cases.push({ op, size, layout: 'contiguous' });
  }
  for (const op of ['read', 'write', 'chase', 'fields']) cases.push({ op, size: 8 * 1024 * 1024, layout: 'fragmented' });
  cases.push({ op: 'atomic', size: PAGE, layout: 'contiguous' }, { op: 'copy', size: PAGE, layout: 'contiguous' });
  const results = [], roundCount = options.rounds ?? 7;
  for (const fixture of cases.slice(0, options.caseLimit ?? cases.length)) {
    const { op, size, layout } = fixture;
    ctx.table.fill(0);
    const pages = Array.from({ length: size / PAGE }, (_, i) => data + i * PAGE);
    if (layout === 'fragmented') shuffle(pages, randomGenerator(0x736a173));
    pages.forEach((physical, i) => group.map(ctx, va + i * PAGE, physical));
    group.map(ctx, destVA, dest);
    const nativeWords = new Uint32Array(group.memory.buffer, nativeData, size / 4);
    const virtualWords = new Uint32Array(size / 4);
    let next, nodes = size / 4, stride = 4, fullXor = 0;
    if (op === 'chase' || op === 'fields') {
      stride = op === 'fields' ? 16 : 4;
      nodes = size / stride;
      const order = shuffle(Array.from({ length: nodes }, (_, i) => i), randomGenerator(0x735976));
      next = new Uint32Array(nodes);
      order.forEach((value, i) => { next[value] = order[(i + 1) % nodes]; });
      for (let i = 0; i < nodes; i++) {
        const slot = i * stride / 4;
        nativeWords[slot] = nativeData + stride * next[i];
        virtualWords[slot] = va + stride * next[i];
        let contribution = stride * next[i];
        if (op === 'fields') {
          const values = [(i * 3 + 7) >>> 0, (i ^ 0x12345678) >>> 0, (i * 11 + 13) >>> 0];
          for (let j = 0; j < 3; j++) {
            nativeWords[slot + j + 1] = virtualWords[slot + j + 1] = values[j];
            contribution ^= values[j];
          }
        }
        fullXor ^= contribution;
      }
    } else {
      for (let i = 0; i < virtualWords.length; i++) nativeWords[i] = virtualWords[i] = i + 1;
    }
    pages.forEach((physical, i) => new Uint8Array(group.memory.buffer, physical, PAGE)
      .set(new Uint8Array(virtualWords.buffer, i * PAGE, PAGE)));
    const mask = size - 4;
    const expected = new Map();
    function checksum(n) {
      if (expected.has(n)) return expected.get(n);
      let value = 0;
      if (op === 'read') {
        const count = BigInt(size / 4), q = BigInt(Math.floor(n / (size / 4))), r = BigInt(n % (size / 4));
        value = Number(BigInt.asIntN(32, q * count * (count + 1n) / 2n + r * (r + 1n) / 2n));
      } else if (op === 'atomic') {
        value = Number(BigInt.asIntN(32, BigInt(n) * BigInt(n - 1) / 2n));
      } else if (next) {
        value = Math.floor(n / nodes) % 2 ? fullXor : 0;
        let index = 0;
        for (let j = 0; j < n % nodes; j++) {
          const old = index; index = next[index];
          value ^= stride * index;
          if (op === 'fields') value ^= (old * 3 + 7) ^ (old ^ 0x12345678) ^ (old * 11 + 13);
        }
        assert(value !== 0, 'independent graph checksum must detect a skipped loop');
      }
      expected.set(n, value | 0);
      return value | 0;
    }
    function location(index, native) {
      if (native) return nativeData + index * 4;
      return pages[Math.floor(index * 4 / PAGE)] + index * 4 % PAGE;
    }
    const dataView = new DataView(group.memory.buffer);
    function invoke(profile, mode, operation, n, verify = true) {
      const native = mode === 'native';
      if (op === 'atomic') dataView.setUint32(location(0, native), 0, true);
      const base = op === 'copy' ? (native ? nativeDest : destVA) : native ? nativeData : va;
      const arg = op === 'copy' ? (native ? nativeData : va) : mask;
      const t = performance.now();
      const value = instances[profile].call(mode, operation, n, base, arg);
      const ms = performance.now() - t;
      if (verify) {
        assert(value === checksum(n), `${profile}/${mode}/${operation} checksum ${value} != ${checksum(n)}`);
        if (op === 'write') {
          for (const index of [0, 1, 17, size / 4 - 1, n % (size / 4)]) {
            const last = n - 1 - ((n - 1 - index) & (size / 4 - 1));
            assert(last >= 0 && dataView.getUint32(location(index, native), true) === last, 'benchmark write contents');
          }
        } else if (op === 'atomic') assert(dataView.getUint32(location(0, native), true) === n, 'atomic final counter');
        else if (op === 'copy') {
          const start = native ? nativeDest : dest;
          for (const i of [0, 1, 17, 127, 1023, 8191, 16383])
            assert(dataView.getUint32(start + i * 4, true) === i + 1, 'copy final data');
        }
      }
      return { ms, n, nsPerOp: ms * 1e6 / n, checksum: value };
    }
    function iterations(profile, mode, operation) {
      let n = op === 'copy' ? 1 : 4096;
      const minimum = next ? 4 * nodes : op === 'write' ? size / 4 : 1;
      n = Math.max(n, minimum);
      for (;;) {
        const sample = invoke(profile, mode, operation, next ? n + 137 : n, false);
        if (sample.ms >= 12 || n >= 33554432) break;
        n *= 2;
      }
      if (next) n += 137;
      for (let i = 0; i < 3; i++) invoke(profile, mode, operation, n);
      // Final tiered sample can be much faster than early calibration.
      const warm = invoke(profile, mode, operation, n);
      if (warm.ms < 6 && n < 33554432) n = Math.min(33554432, next ? (n - 137) * 2 + 137 : n * 2);
      return n;
    }
    const variants = candidates(op);
    const nByKey = new Map();
    function count(profile, mode, operation) {
      const key = `${profile}/${mode}/${operation}`;
      if (!nByKey.has(key)) nByKey.set(key, iterations(profile, mode, operation));
      return nByKey.get(key);
    }
    count('O2', 'native', op);
    for (const candidate of variants) {
      count(candidate.profile, 'native', candidate.operation);
      count(candidate.profile, candidate.mode, candidate.operation);
    }
    const records = Object.fromEntries(variants.map(v => [v.id, []]));
    const orderLog = [];
    for (let round = 0; round < roundCount; round++) {
      const order = shuffle([...variants], randomGenerator(0x123894 + round));
      orderLog.push(order.map(v => v.id));
      for (const candidate of order) {
        const { profile, mode, operation } = candidate;
        const nativeN = count(profile, 'native', operation), candidateN = count(profile, mode, operation);
        const scalarN = count('O2', 'native', op);
        const scalarBefore = invoke('O2', 'native', op, scalarN);
        const matchedBefore = profile === 'O2' && operation === op ? scalarBefore : invoke(profile, 'native', operation, nativeN);
        const sample = invoke(profile, mode, operation, candidateN);
        const matchedAfter = invoke(profile, 'native', operation, nativeN);
        const scalarAfter = profile === 'O2' && operation === op ? matchedAfter : invoke('O2', 'native', op, scalarN);
        const matched = (matchedBefore.nsPerOp + matchedAfter.nsPerOp) / 2;
        const scalar = (scalarBefore.nsPerOp + scalarAfter.nsPerOp) / 2;
        const spread = Math.max(matchedBefore.nsPerOp, matchedAfter.nsPerOp) / Math.min(matchedBefore.nsPerOp, matchedAfter.nsPerOp);
        const scalarSpread = Math.max(scalarBefore.nsPerOp, scalarAfter.nsPerOp) / Math.min(scalarBefore.nsPerOp, scalarAfter.nsPerOp);
        records[candidate.id].push({ round, sample, matchedBefore, matchedAfter, scalarBefore, scalarAfter,
          ratioMatched: sample.nsPerOp / matched, ratioScalar: sample.nsPerOp / scalar,
          bracketSpread: spread, stableBracket: spread <= 1.25 && sample.ms >= 2 && matchedBefore.ms >= 2 && matchedAfter.ms >= 2,
          scalarBracketSpread: scalarSpread, stableScalarBracket: scalarSpread <= 1.25 && sample.ms >= 2 && scalarBefore.ms >= 2 && scalarAfter.ms >= 2 });
      }
    }
    const rows = variants.map(candidate => {
      const samples = records[candidate.id];
      return { ...candidate, samples, nativeReference: `${candidate.profile}/native_${candidate.operation}`,
        medianRatioMatched: median(samples.map(x => x.ratioMatched)), medianRatioScalar: median(samples.map(x => x.ratioScalar)),
        medianNsPerOp: median(samples.map(x => x.sample.nsPerOp)),
        stableBrackets: samples.filter(x => x.stableBracket).length,
        ratioRange: [Math.min(...samples.map(x => x.ratioMatched)), Math.max(...samples.map(x => x.ratioMatched))] };
    });
    results.push({ ...fixture, logicalAccessesPerOp: op === 'fields' ? 4 : op === 'copy' ? PAGE / 4 : 1,
      rows, order: orderLog, graphSeed: '0x735976' });
    progress({ ...fixture, completedCases: results.length, totalCases: cases.length,
      generic: rows.find(r => r.id === 'O2/generic')?.medianRatioMatched,
      combined: rows.find(r => r.id === 'all')?.medianRatioMatched });
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { results, rounds: roundCount, options,
    protocol: 'randomized candidate order; each candidate bracketed by matched native; O2 scalar native also bracketed; individually calibrated iteration counts normalized per operation',
    stableBracketRule: 'native before/after within 25%, timed samples >=2ms; all samples retained; report stable count',
    guarantees: 'fixed mappings during calls; invocation-local caches; generic fallback; SIMD excludes volatile/atomic operations',
    limitation: 'hand-expressed transformations of minimal C fixtures, not a general compiler pass or PHP result',
    layouts: 'native graph is physically contiguous; fragmented candidate is a fallback stress control with different physical layout' };
}
