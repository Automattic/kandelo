// Observer counters and last-geometry gauges have different semantics.
export function affineDelta(start, end, report) {
  const config = report.affineDiagnostics;
  if (config?.version !== 2 || start.version !== 1 || end.version !== 1) throw Error('affine counter version');
  const previous = new Map(start.records.map(r => [`${r.pid}:${r.root}`, new Map(r.values)]));
  if (previous.size !== end.records.length) throw Error('affine root inventory changed');
  const derived = ['privatePrefixFits', 'largestPrivateFits', 'largestSharedFits', 'prefixOrSharedFits', 'largestPrivateOrSharedFits', 'outsideLargestWindows', 'validMappedAttempts', 'privatePlaneAddressMatches', 'privatePlaneOrSharedMatches'];
  const totals = Object.fromEntries([...Object.values(config.countSlots), ...derived].map(name => [name, 0n]));
  const records = end.records.map(record => {
    const before = previous.get(`${record.pid}:${record.root}`), current = new Map(record.values);
    if (!before) throw Error('affine root identity changed');
    const counts = {};
    for (const [slot, name] of Object.entries(config.countSlots)) {
      const value = BigInt(current.get(Number(slot)) ?? 0) - BigInt(before.get(Number(slot)) ?? 0);
      if (value < 0n) throw Error('affine counter regression');
      counts[name] = value;
    }
    const histogram = Array.from({ length: 16 }, (_, mask) => {
      const slot = config.maskHistogram.base + mask;
      const value = BigInt(current.get(slot) ?? 0) - BigInt(before.get(slot) ?? 0);
      if (value < 0n || ((mask & 4) && (mask & 11) && value)) throw Error('affine histogram mismatch');
      return value;
    });
    const sum = predicate => histogram.reduce((n, value, mask) => n + (predicate(mask) ? value : 0n), 0n);
    Object.assign(counts, { privatePrefixFits: sum(m => m & 1), largestPrivateFits: sum(m => m & 2), largestSharedFits: sum(m => m & 4), prefixOrSharedFits: sum(m => m & 5), largestPrivateOrSharedFits: sum(m => m & 6), outsideLargestWindows: sum(m => !(m & 6)), validMappedAttempts: sum(() => true), privatePlaneAddressMatches: sum(m => m & 8), privatePlaneOrSharedMatches: sum(m => m & 12) });
    for (const [name, value] of Object.entries(counts)) totals[name] += value;
    const c = counts;
    if (c.wrappedAttempts !== c.largestPrivateOrSharedFits + c.outsideLargestWindows + c.invalidVirtualRange + c.epochDisabled + c.livePteMismatch + c.invalidPteOrPermission) throw Error('affine partition mismatch');
    if (c.prefixOrSharedFits !== c.privatePrefixFits + c.largestSharedFits || c.largestPrivateOrSharedFits !== c.largestPrivateFits + c.largestSharedFits || c.privatePlaneOrSharedMatches !== c.privatePlaneAddressMatches + c.largestSharedFits) throw Error('affine union mismatch');
    for (const name of ['prefixOrSharedFits', 'largestPrivateOrSharedFits', 'privatePlaneOrSharedMatches', 'splitPageAttempts']) if (c[name] > c.wrappedAttempts) throw Error('affine count exceeds attempts');
    const gauges = Object.fromEntries(Object.entries(config.gaugeSlots).map(([slot, name]) => [name, current.get(Number(slot)) ?? '0']));
    return { pid: record.pid, root: record.root, counts, gauges, histogram };
  });
  const ratios = Object.fromEntries(['privatePrefixFits', 'largestPrivateFits', 'largestSharedFits', 'prefixOrSharedFits', 'largestPrivateOrSharedFits', 'privatePlaneAddressMatches', 'privatePlaneOrSharedMatches'].map(name => [name, totals.wrappedAttempts ? Number(totals[name]) / Number(totals.wrappedAttempts) : null]));
  return JSON.parse(JSON.stringify({ records, totals, ratios, scope: config.scope + ' Counts are attempted wrapped operations, not CPU time, bytes, completed accesses or speedups. Gauges are ending observations, not deltas or atomic whole-table snapshots.' }, (_, value) => typeof value === 'bigint' ? value.toString() : value));
}
