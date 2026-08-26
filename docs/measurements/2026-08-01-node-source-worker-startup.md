# Node source-worker startup — 2026-08-01

## Conclusion

When Kandelo runs directly from a source checkout without a compiled worker
entry, bundling the TypeScript entry once and reusing it materially reduces
Node process-worker startup time compared with starting a new `tsx` loader for
each worker.

This is a Node source-mode result, not a claim about production packages or
browsers. Published Node packages prefer their compiled JavaScript entry.
Browser workers already pass through the browser build's bundler and do not
use either source fallback measured here.

## Method

The benchmark creates a minimal TypeScript worker that replies once with its
initialization value. Each trial creates a fresh `NodeWorkerAdapter`, launches
and terminates eight workers sequentially, and includes the one-time esbuild
cost in the bundled result. The baseline disables only the new bundle resolver
so the adapter follows its former per-worker `tsx` path with the same worker
source and Worker options. Trial order alternates to reduce ordering bias.

Run from the declared development shell:

```bash
scripts/dev-shell.sh npx tsx \
  benchmarks/node-source-worker-startup.ts --trials=3 --workers=8
```

Environment:

- Apple M5 Max with 48 GiB memory;
- macOS 26.6 (`Darwin 25.6.0`); and
- Node.js `v24.15.0` from Kandelo's development shell.

## Results

| Trial | Eight workers through `tsx` | Eight workers through cached bundle |
|---:|---:|---:|
| 1 | 632.6 ms | 228.2 ms |
| 2 | 654.0 ms | 212.3 ms |
| 3 | 649.2 ms | 211.8 ms |
| Median | 649.2 ms | 212.3 ms |

For this narrow workload, the prior path took 3.06 times as long at the
median. The result demonstrates the source-startup effect only. It does not
measure a complete package-install lifecycle, resident memory, browser
performance, or the compiled distribution path. The batch-level Node and
browser benchmark suites and the exact package-install lifecycle remain
separate completion gates.
