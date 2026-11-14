// Shared accounting for diagnostic runs, never for latency comparisons.
export function regionDelta(start, end, report) {
  const config = report.regional.metadata, plans = report.regional.plans;
  const previous = new Map(start.records.map(r => [`${r.pid}:${r.root}`, new Map(r.values)]));
  if (start.version !== 1 || end.version !== 1 || previous.size !== end.records.length) throw Error('counter root inventory changed');
  const totals = { accesses: 0n, fastAccesses: 0n, guards: 0n, hits: 0n, misses: 0n, weightedHitSites: 0n };
  const regions = plans.map((plan, id) => ({ id, ...plan, hits: 0n, misses: 0n }));
  const records = end.records.map(record => {
    const before = previous.get(`${record.pid}:${record.root}`);
    if (!before) throw Error('counter root identity changed');
    const current = new Map(record.values);
    const values = new Map([...new Set([...before.keys(), ...current.keys()])].map(slot => {
      const value = current.get(slot) ?? 0;
      const delta = BigInt(value) - BigInt(before.get(slot) ?? 0);
      if (delta < 0n) throw Error('counter regression');
      return [slot, delta];
    }));
    const read = slot => values.get(slot) ?? 0n;
    const accesses = [...values].filter(([slot]) => slot < 133).reduce((n, [, value]) => n + value, 0n);
    const functions = [...values].filter(([slot]) => slot >= report.functionBase && slot < config.functionEnd).reduce((n, [, value]) => n + value, 0n);
    if (accesses !== functions) throw Error('access/category accounting mismatch');
    const fastAccesses = read(config.fastAccessesSlot), guards = read(config.guardAttemptsSlot);
    const hits = read(config.guardHitsSlot), misses = read(config.guardMissesSlot);
    if (guards !== hits + misses) throw Error('guard accounting mismatch');
    let regionHits = 0n, regionMisses = 0n, weightedHitSites = 0n;
    for (const region of regions) {
      const h = read(config.regionBase + 2 * region.id), m = read(config.regionBase + 2 * region.id + 1);
      region.hits += h; region.misses += m;
      regionHits += h; regionMisses += m; weightedHitSites += h * BigInt(region.sites);
    }
    if (hits !== regionHits || misses !== regionMisses || fastAccesses > weightedHitSites || fastAccesses > accesses) throw Error('region coverage accounting mismatch');
    for (const [name, value] of Object.entries({ accesses, fastAccesses, guards, hits, misses, weightedHitSites })) totals[name] += value;
    return { pid: record.pid, root: record.root, accesses, fastAccesses, guards, hits, misses, weightedHitSites, values: [...values].filter(([, value]) => value !== 0n) };
  });
  const sorted = regions.filter(r => r.hits || r.misses).sort((a, b) => {
    const left = a.hits * BigInt(a.sites), right = b.hits * BigInt(b.sites);
    return left > right ? -1 : left < right ? 1 : a.id - b.id;
  });
  return JSON.parse(JSON.stringify({ records, totals, activeRegions: sorted.length,
    fastAccessShare: totals.accesses ? Number(totals.fastAccesses) / Number(totals.accesses) : null,
    guardHitShare: totals.guards ? Number(totals.hits) / Number(totals.guards) : null,
    topRegions: sorted.slice(0, 25), regions: sorted,
    scope: 'Attempted original access dispatches, not completed accesses, bytes, page checks, CPU share or speedup. Fast counts include only raw scalar operations in successful regional branches. Weighted sites can overcount if arithmetic traps later in a region. Individually atomic snapshots are not one global transaction.',
  }, (_, value) => typeof value === 'bigint' ? value.toString() : value));
}
