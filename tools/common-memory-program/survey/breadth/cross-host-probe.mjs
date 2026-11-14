// Synthetic cost screen only. Called inside disposable Node/browser Workers.
import { ProgramGroup, PAGE, READ, WRITE } from '../../runtime.mjs';

export function runBreadthProbe(bytes) {
  const started = performance.now();
  const compiled = {};
  const compileMs = {};
  for (const name of ['single', 'dual', 'translated']) {
    const before = performance.now();
    compiled[name] = new WebAssembly.Module(bytes[name]);
    compileMs[name] = performance.now() - before;
  }
  const beforeInstances = performance.now();
  const privateMemory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const sharedMemory = new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
  const ordinary = new WebAssembly.Instance(compiled.dual, {
    env: { private: privateMemory, shared: sharedMemory },
  }).exports;
  // Five table pages, sixteen scratch pages, two data pages and a scatter page
  // fit this bound. The historical Node screen used a larger group ceiling.
  const group = new ProgramGroup({ initialPages: 32, maximumPages: 64 });
  const ctx = group.create(compiled.translated);
  const physical = new WebAssembly.Instance(compiled.single, {
    env: { memory: group.memory },
  }).exports;
  const instantiateMs = performance.now() - beforeInstances;
  const privateWords = Uint32Array.from({ length: 32768 }, (_, i) => (i * 31 ^ 0x12345) & 65535);
  const sharedWords = Uint32Array.from({ length: 32768 }, (_, i) => (i * 17 ^ 0x54321) & 65535);
  new Uint32Array(privateMemory.buffer).set(privateWords);
  new Uint32Array(sharedMemory.buffer).set(sharedWords);
  group.write(ctx, 0, new Uint8Array(privateWords.buffer));
  const cases = {
    'native-private': n => ordinary.private(n, 0),
    'pte-per-access': n => ctx.exports.sum(n, 0),
    // Real validation and both Wasm invocations stay INSIDE the timed call.
    'guarded-contiguous-span': n => {
      const base = ctx.exports.__vm_host_span(0, 131072, READ, ctx.root);
      return base ? physical.sum(n, base) : ctx.exports.sum(n, 0);
    },
    'two-memory-private': n => ordinary.tagged(n, 0),
    'two-memory-shared': n => ordinary.tagged(n, 0x80000000),
    'native-shared': n => ordinary.shared(n, 0),
  };
  const expected = (words, n) => {
    const cycles = Math.floor(n / words.length), tail = n % words.length;
    let whole = 0n, extra = 0n;
    for (let i = 0; i < words.length; i++) {
      whole += BigInt(words[i]);
      if (i < tail) extra += BigInt(words[i]);
    }
    return whole * BigInt(cycles) + extra;
  };
  // Browser clocks quantize the sub-millisecond historical one-million loop.
  // Lengthen the work inside Wasm, without adding per-invocation JS overhead.
  const iterations = 16000000;
  const wants = { private: expected(privateWords, iterations), shared: expected(sharedWords, iterations) };
  const verify = (name, sum) => {
    if (sum !== wants[name.includes('shared') ? 'shared' : 'private']) throw Error('checksum: ' + name);
  };
  const setupMs = performance.now() - started;
  let minimumTimerStepMs = Infinity, previous = performance.now();
  for (let i = 0; i < 10000; i++) {
    const now = performance.now(), delta = now - previous;
    if (delta > 0) minimumTimerStepMs = Math.min(minimumTimerStepMs, delta);
    previous = now;
  }
  // First calls are ordered, not independent cold/tiering measurements.
  const firstInvocations = [];
  for (const [name, fn] of Object.entries(cases)) {
    const before = performance.now(), sum = fn(iterations), elapsedMs = performance.now() - before;
    verify(name, sum);
    firstInvocations.push({ name, elapsedMs, checksum: sum.toString() });
  }
  let guardChecks = 0;
  const secondEntry = group.table(ctx)[1], secondPhysical = (secondEntry & -PAGE) >>> 0;
  const scatter = group.alloc(1);
  new Uint8Array(group.memory.buffer, scatter, PAGE).set(new Uint8Array(group.memory.buffer, secondPhysical, PAGE));
  group.map(ctx, PAGE, scatter);
  if (ctx.exports.__vm_host_span(0, 131072, READ, ctx.root) !== 0) throw Error('scatter guard accepted');
  guardChecks++;
  verify('guarded-contiguous-span', cases['guarded-contiguous-span'](iterations));
  guardChecks++;
  group.map(ctx, PAGE, secondPhysical, { rights: WRITE });
  // The historical vm_span faults on unreadable pages; only scattering returns
  // zero. Check both paths trap. This is not a general speculative-hoist guard.
  for (const name of ['guarded-contiguous-span', 'pte-per-access']) {
    let trapped = false;
    try { cases[name](iterations); }
    catch (error) { if (!(error instanceof WebAssembly.RuntimeError)) throw error; trapped = true; }
    if (!trapped) throw Error('read-denied access did not trap: ' + name);
    guardChecks++;
  }
  group.map(ctx, PAGE, secondPhysical);
  if (!ctx.exports.__vm_host_span(0, 131072, READ, ctx.root)) throw Error('contiguous guard missed');
  guardChecks++;
  for (const fn of Object.values(cases)) for (let i = 0; i < 5; i++) fn(100000);
  const samples = [];
  for (let cohort = 0; cohort < 2; cohort++) for (let round = 0; round < 7; round++) {
    const order = Object.keys(cases);
    if (cohort) order.reverse();
    for (const name of order) {
      const before = performance.now(), sum = cases[name](iterations), elapsedMs = performance.now() - before;
      verify(name, sum);
      samples.push({ cohort, round, name, elapsedMs, checksum: sum.toString() });
    }
  }
  return {
    passed: true, guardChecks, iterations, samples, firstInvocations,
    setup: { compileMs, instantiateMs, setupMs },
    minimumTimerStepMs: Number.isFinite(minimumTimerStepMs) ? minimumTimerStepMs : null,
    groupMemory: { initialPages: 32, maximumPages: 64, backingBytes: group.memory.buffer.byteLength },
    declaredReservationBytes: (64 + 4 + 4) * PAGE,
    scope: 'Pinned read-only 128KiB array, varying addresses, loop-invariant pointer bank, no calls/fork/remap inside loop. Native means ordinary-addressing Wasm on the same engine. Real span validation and extra JS/Wasm invocation are timed. vm_span faults on permission failure and returns zero for scattering; not a general non-faulting speculative-hoist guard. Two-memory uses a high-bit pointer ABI, not PHP/general mmap. One Worker per host, two opposite orders, not independent parent launches or a steady-state/application claim. All memory and instances remain Worker-local; only copied JSON is returned.',
  };
}
