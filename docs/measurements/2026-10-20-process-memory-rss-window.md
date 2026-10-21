# Node process-memory reclamation: observation window

## Finding

The sequential-spawn resident set size (RSS) test was too short to
distinguish startup and collection timing from continued memory retention.
Two uninterrupted runs exceeded its limits at 48 children, then leveled
off when continued to 256 children in the same host. The production
allocator and teardown code were unchanged throughout those runs.

RSS includes the entire Node process: all its worker threads, compiled
code, engine heaps, and resident allocator pages. It does not count only
live guest address spaces. Node documents that distinction in
[process.memoryUsage](https://nodejs.org/docs/latest-v24.x/api/process.html#processmemoryusage).

The test now runs 32 waves of eight children instead of six. It retains
the existing 2 MiB-per-child late-slope limit and 64 MiB late-growth limit.
It uses one host throughout, reaps every observed process, and refuses
forced garbage collection. Its 4 MiB ordinary allocation pressure is
explicit so an inherited measurement setting cannot disable it.
No production memory policy, ownership rule, or browser behavior changed.

Main's separate #1526 fix already extends its check to 96 children, as
recorded in the October 13 addendum to the earlier measurement report.
This follow-up extends that window to 256 and checks every wave's child
count. The uninterrupted comparisons and eight-run series below support
that longer window; the earlier addendum remains a historical record.

This addresses a measurement-window defect. It does not establish which
engine allocations explain each RSS fluctuation, prove that all possible
memory leaks are absent, or promise collection within a portable deadline.

## Environment and method

- Source: PR #1518 at `47a9629f6e9e`, based on main `3756c11c15f4`.
- Apple M5 Max, 48 GiB RAM, macOS 27.0.1 (26A434), arm64.
- Declared development shell: Node 24.15.0, V8 13.6.233.17-node.48.
- Four warm-up children, then waves of eight sequential children. Each
  child touches 8 MiB through the ordinary guest allocation path.
- One parent process per wave; the child axis excludes those parents.
- The late window drops the first third of samples. The slope is an
  ordinary least-squares fit; late growth is the last RSS minus the first
  RSS in that window. Neither calculation nor limit changed.
- All measurements completed with no guest stderr or host diagnostics.
  Runs were sequential. No host was restarted between its waves, and no
  run used forced garbage collection.

The original full-suite failure was 2.207 MiB per child and 51.59 MiB late
growth. Its slope exceeded 2 MiB; its late growth remained under 64 MiB.
Of eight new independent, unmodified 48-child runs, two exceeded both
limits: slopes 2.148 and 2.435, with late growth 74.50 and 88.39 MiB.
The other six passed. All results were retained.

## Continue the same process

These runs used the unmodified harness with only
`KANDELO_RECLAIM_WAVES=32`. The 48-child columns are recomputed from each
run's first seven samples, using the old test's exact calculation. The
256-child columns use the full uninterrupted run.

| Run | Slope at 48, MiB/child | Growth at 48, MiB | Slope at 256, MiB/child | Growth at 256, MiB |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2.518 | 80.34 | -0.061 | -41.34 |
| 2 | 2.597 | 67.98 | 0.236 | -13.92 |
| 3 | 1.342 | 45.44 | 0.112 | 4.64 |

All three long runs passed the original limits. The first two show why
a fresh-process rerun is insufficient: the failed short window and the
later plateau occurred inside the same process and host.

Eight further independent 256-child measurements of the final harness
all passed both original limits. Their late slopes ranged from -0.666
to +0.225 MiB per child, and late growth ranged from -112.47 to
+29.28 MiB. Each run retained all 33 samples. This was a fixed series
of eight runs, not a retry-until-pass policy.

A separate 256-child run with the ordinary-pressure hook disabled had a
-0.080 MiB-per-child late slope and -94.02 MiB late growth. That control
also collected, but with larger sawtooth excursions. It does not justify
removing the production pressure hook or supersede the earlier
[cross-engine pressure measurements](2026-07-28-process-memory-retirement-rss.md).

## Ownership diagnostics and retained-memory control

Separate diagnostic runs temporarily sampled the existing allocator's
numeric retirement statistics and live process/teardown counts from the
kernel worker. This instrumentation was removed afterward. These results
are diagnostic evidence, separate from the unmodified RSS runs above.

At the end of a 256-child run:

- No live memories, aliases, process records, or teardown operations
  remained.
- 293 allocations had retired: five in warm-up plus 32 waves of nine.
- Weak finalization records observed complete wrapper collection for
  291 of those generations. Two generations still awaited collection;
  this is optional telemetry, not admission or correctness authority.
- Late slope was -0.244 MiB per child and late growth was -50.95 MiB.

For a negative control, the diagnostic kernel worker deliberately held
a strong reference to every distinct guest memory observed by the normal
registration callback. The guests still exited and reaped normally, so
this isolated memory retention from process-table cleanup.

At 128 children that control had zero live process records but 149 held
memories, zero completely finalized generations, an 8.534 MiB-per-child
late slope, and 750.28 MiB late growth. Both original limits failed by a
wide margin. The longer observation window therefore remains sensitive
to complete history-proportional guest-memory retention.

The actual updated Vitest test was also run with the retained-memory
control at its full 256 children. It failed at the RSS slope assertion:
8.416 MiB per child, with 1,414.09 MiB late growth. All children completed
with no stderr or host diagnostics. The control runner required exactly
that assertion failure, so a setup error could not count as successful
detection. The temporary strong references and diagnostic sampling were
then removed before normal validation.

## Final validation

After removing all temporary diagnostic and retained-memory code, the
ordinary Vitest configuration passed 121 tests in 15 files, with no skips
or file-load failures. This included the updated RSS test, memory
allocation and retirement, exact-generation detachment, worker adapters,
worker quiescence, host destruction, and ordinary process exit. The RSS
test completed in 28.8 seconds within its existing timeout.

No production source changed. The full host suite, browser integration,
POSIX conformance, and performance suites were not repeated for this
measurement and documentation change. The original full-suite failure
remains preserved, and the unrelated browser network-join failures are
not resolved by this work.

## Reproduce

Run the regression through its ordinary setup and configuration:

```bash
scripts/dev-shell.sh env CI=1 bash -c \
  'cd host && npx vitest run test/process-memory-reclamation-rss.test.ts'
```

For a raw measurement after fixture preparation:

```bash
scripts/dev-shell.sh env KANDELO_RECLAIM_WAVES=32 \
  node --import ./host/node_modules/tsx/dist/loader.mjs \
  host/test/fixtures/process-memory-reclamation-rss.ts
```

The workspace evidence directory is
`.context/pr1518-rss-investigation/`. It contains all original and final
sample arrays, the temporary diagnostic patch and harness, the retained
control, and the exact runner scripts. These local files are not part of
the tracked implementation. The earlier full-suite failure remains in
`.context/pr1518-validation-20261020/rss-full-suite-failure.json`.
