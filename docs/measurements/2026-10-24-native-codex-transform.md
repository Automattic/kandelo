# Earlier guarded native Codex transform results

This report preserves the earlier shared-target checkpoint. The
[final lexical-source run](2026-10-24-native-codex-lexical-transform.md)
completed separately at 484.97 MiB physical peak in 1,029.34 seconds.
The fingerprints and measurements below remain historical evidence.

The complete native transform succeeded on the original 284.6 MB input in
**1,073.45 seconds (17 minutes 53 seconds)**, including serial Wasm validation
and atomic publication. Its OS lifetime peak physical footprint was
**451.38 MiB**, and its requested Rust allocation peak was **430.94 MiB**.
The 16 GiB guard and 30-minute deadline did not fire. Compiler-fact analysis
completed without falling back to the built-in analysis. See the eighth run
below for exact output provenance and limitations; earlier failures remain
documented as diagnostic history.

The original diagnostic input is 284,605,220 bytes, SHA-256
`17b829246d2396cf73f60d3dee8fea1b64dbbae8b96b0825d7228ce288ef7e42`.
The user coordinated a serial native transform with a 16 GiB physical-memory
guard and a 30-minute deadline. The input is never executed. Binaryen,
Node/browser execution and admission into the normal program tree are excluded.

## First attempt: analysis sanity check rejected the input

On 2026-10-24, the preserved executable from the
[controlled complete-transform comparison](2026-10-24-native-fork-instrumenter-full.md)
ran with normal instrumentation options and no post-optimizer. It stopped
with `sink interpretation exceeds state-value budget` after 514.29 seconds.
It returned failure before publishing an artifact. Neither external guard
fired.

The highest observed OS lifetime physical-footprint high-water mark was
341,623,792 bytes (**325.80 MiB**). The maximum sampled RSS was
628,260,864 bytes (**599.16 MiB**). These are observations from the guard's
approximately 5 ms samples. Because the transform failed, it did not print
its final self-reported peak or Rust allocation counter. These figures do
not represent a successful complete transform.

The old preflight allowed 8,388,608 abstract state-value units. It reserves
maximum frame-slot storage at every active control level, even for a body
that writes only one slot. A regression fixture with 80 nested blocks and
one frame slot reproduces this rejection despite having little live state.

After the first attempt, the default was raised to a generous
268,435,456-unit sanity ceiling. This changes
neither interpretation nor frame tracking. The fixture retains precise slot
values under the new default and still rejects an explicitly supplied old
budget. Rejection diagnostics now identify the original function and the
estimated and allowed values. The architecture's normal memory saving comes
from compact module summaries and function-local state, rather than tight
application-specific thresholds. The external 16 GiB guard is retained.

Evidence is preserved in `.context/native-codex-full-20261024/`: an exact
read-only input copy, metadata, guard source, run script, stdout/stderr,
status, sample trace and `attempt-summary.json`. A one-second external stack
sample was taken during the run; no throughput comparison is claimed.
Executable SHA-256:

```
aed01d7765b0e8ad10214096214631b0eea98102833702b2cb4f87fc0e2c5c40
```

This failed attempt does not establish Codex capacity or replace the pending
complete-transform validation with the revised sanity ceiling. The historical
Walrus run stopped at about 16.02 GiB during sink analysis, also without an
artifact; it measured a different stopping point and is not an end-to-end
before/after pair.

## Second attempt: compiler-generated control depth

The next guarded attempt used the 268,435,456-unit state ceiling and the
same input bytes, external guard, deadline and transform options. It stopped
after 476.21 seconds at `sink interpretation exceeds control-depth budget`.
No artifact was published and neither external guard fired. The highest
observed OS lifetime physical footprint was **329.25 MiB**; maximum sampled
RSS was **677.91 MiB**. Evidence is in
`.context/native-codex-sanity-20261024/`, with its executable and source in
`.context/native-codex-sanity-build/`. Executable SHA-256:

```
b4fd85519ab48381617795bc4c6457f9164be66f3a245ee61a89cd234cb14bb0
```

A separate serial, guarded shape scan took 2.08 seconds without compiler-facts
solving or instruction IR. Its maxima across all 263,515 local functions were:

| Shape | Original function ordinal | Maximum |
|---|---:|---:|
| Operators in one body | 252856 | 197,910 |
| Declared locals | 227299 | 973 |
| Nested control regions | 252856 | 1,896 |
| Ordinary call sites | 44311 | 1,819 |

The 256-level control default was too small for this compiler output.
Defaults now allow 16,384 control levels and use a deliberately loose
4,294,967,295-unit state estimate. The estimate allocates or reserves no
memory. Work and explicit caller-provided budgets remain independent.

Deep interpretation uses temporary native stack segments through
[stacker](https://docs.rs/stacker/0.1.25/stacker/fn.maybe_grow.html), on the same
thread as the borrowed analysis environment. This handles deep control even
when the library caller has a small thread stack; it does not enlarge or
change a guest Wasm stack. A 2,000-level regression retains precise slot
tracking on a 256 KiB calling thread stack and still rejects an explicit
256-level analysis limit. Normal working-set reduction comes from the
function-local architecture. These changes still require a successful full
Codex transform before any capacity claim.

## Third attempt: interpretation work ceiling

With the larger state and control sanity ceilings and on-demand analysis
stack, the transform stopped after 810.61 seconds with
`sink interpretation exceeds work budget`. No artifact was published and
neither external guard fired. The highest observed OS lifetime physical
footprint was **342.97 MiB**. This remains a failed-transform observation,
not a complete-transform memory result. Evidence is in
`.context/native-codex-deep-control-20261024/`, with its source and executable
in `.context/native-codex-deep-control-build/`. Executable SHA-256:

```
30078f210f38150b590a83c6999bc98154f425ff641339cf71b622cbc475f001
```

Work counts include abstract-state copies and fixed-point revisits, so they
can be much larger than input operator counts. The previous defaults allowed
104,857,600 units per evaluation and 10 billion across each analysis pass.
The revised defaults allow one trillion units per evaluation and sixteen
trillion per aggregate pass on this 64-bit host. Narrower hosts scale these
allowances down while preserving their ratio.
The aggregate allowance leaves room for nested specialization while a caller's
allowance is reserved. Raising these counters allocates no memory. Explicit
caller limits still reject exhausted work; interpretation,
frame tracking and function-local IR lifetimes are unchanged.

`WPK_FORK_PROGRESS=1` now enables elapsed-time diagnostics for native transform
phases, facts loading/call resolution, sink planning, parameter analysis and
normal summary solving. Function counters appear every 10,000 completed
parameter bodies or summary evaluations. Local work failures identify the
original function, requested work, remaining work and allowed limit. These
diagnostics go to stderr and do not change emitted bytes. The next attempt
retains the same 16 GiB physical guard and 30-minute deadline.

Before that retry, all 654 instrumenter tests passed. Fourteen complete
controlled transforms and fourteen separate Node validators also passed with
the revised defaults and progress enabled. All output hashes match the
historical controlled comparison within each backend. This is a regression
check, not a new three-repeat memory comparison. Its evidence is in
`.context/native-work-controlled-smoke/`; the exact executable and 198 source
files are in `.context/native-codex-progress-build/`. Executable SHA-256:

```
e28dc9b2727199a74db1763d9f5a21e4a84fc1e57a9354cc2aee10453c140fa4
```

## Fourth attempt: disk growth and SQL work accounting

The next attempt ran for 1,070.43 seconds and stopped with SQLite's
`SQLITE_INTERRUPT`, during built-in normal-summary solving. The highest
observed OS lifetime physical footprint was **351.86 MiB**; maximum sampled
RSS was **666.77 MiB**. No artifact was published and neither external guard
fired. Evidence is in `.context/native-codex-progress-20261024/`, using the
`e28dc9b...` executable above.

The phase log exposed an earlier compiler-fact failure: SQLite reported a
full database during call resolution, under the configured 8 GiB main-database
ceiling. The underlying filesystem still had about 116 GiB free. Analysis
then selected the existing conservative built-in path. Its parameter pass
completed all 263,515 local functions in 22.7 seconds. Normal summaries
completed at least 890,000 evaluations before the store's 100-billion-unit
work counter interrupted SQL. These estimated SQL units include a minimum
batch charge for short queries and differ from abstract-interpreter work.

This run does not prove completed Codex capacity or successful compiler-fact
resolution. The next diagnostic isolates compiler-fact solving, without
retrying the entire transform. A smaller explicit database allowance is used
only to locate relation growth quickly, not as a capacity measurement.

A separate guarded, 2.38-second structural scan found 239,569 conservative
fork activations and 239,569 control-reachable functions, with no tail sites.
The activation catalog counts these separately, so its old 64 MiB metadata
preflight could reject this closure before actual allocation. The pipeline
and activation catalog defaults now allow a generous 1 GiB estimate. Native
computational defaults are shared across passes, and the SQL sanity ceiling
is one quadrillion estimated units. Neither change allocates memory or
retains more IR. The 32 MiB SQLite cache target and 8 GiB main-database ceiling
remain unchanged while relation growth is investigated. New opt-in diagnostics
report database bytes and work counts at compiler-fact stage boundaries.

The follow-up passed all 655 instrumenter tests, including SQL work exhaustion
without publishing partial conversions. Fourteen complete controlled
transforms and fourteen separate Node validators passed, with all output
hashes matching the historical comparison within each backend. The source
snapshot and executable are in `.context/native-storage-diagnostics-build/`,
and the checks in `.context/native-storage-controlled-smoke/`. Executable
SHA-256:

```
e6e7d672d3247c79f00ac8a4bc85213f088836e0c67b4bf5970fdb1ae03b3d37
```

## Isolated compiler-fact diagnosis and sharing fix

The facts-only diagnostic loaded 18,495 definitions and 73,959 relations into
15,147,008 database bytes. The initial 512 MiB diagnostic run spent 352.5
seconds in return-flow analysis. Conversion solving then finished at about
148 MB, followed by Wasm inputs, bindings and callback policy at about 272 MB.
The indirect-target stage exhausted the diagnostic database allowance. This
was not a full transform and did not execute the input.

Two causes were identified. Some return-walk queries scanned module-wide
relations for each visited slot or function. Conservative target sets were
also copied for every caller sharing the same signature. A first partial fix
still failed the 512 MiB target stage after 302.93 seconds. It exposed remaining
recursive/parameter scans and duplicated unknown targets at typed sites.

The final fix anchors return-walk queries on the current or visited slots,
using [SQLite's documented CROSS JOIN ordering](https://www.sqlite.org/optoverview.html#manual_control_of_query_plans_using_cross_join).
Target groups share full-signature and unknown-function memberships. Known
typed refinements remain separate. The filtered target API preserves the
original rules, with disjoint branches and no caller-by-fallback-target matrix.

The same facts-only probe then completed in **60.57 seconds**, with a
**277.94 MiB** main database under the unchanged 512 MiB diagnostic allowance.
It bound 13,109 functions. The highest observed OS lifetime physical footprint
was **318.95 MiB**. Return-flow analysis took 0.4 seconds in this single run.
These are diagnostic phase timings, not a repeated application benchmark or
a completed-transform before/after pair. The default 8 GiB database allowance
and 32 MiB cache target were unchanged.

Evidence for the three probes is in `.context/native-facts-growth-probe-20261024/`,
`.context/native-facts-shared-probe-20261024/`, and
`.context/native-facts-shared-complete-probe-20261024/`. The final probe's
source/executable are in `.context/native-shared-facts-complete-build/`.
Executable SHA-256:

```
30bb80963e0733463af0456e25fc46c556ca47cbcf9db30a442ed52f10cb3f05
```

All 658 instrumenter tests passed, including mixed known/unknown target
equivalence with unchanged Walrus, 600 callers sharing 1,200 possible targets
under a 4 MiB database allowance, and indexed recursive return-walk scaling.
A fresh [complete controlled comparison](2026-10-24-native-fork-instrumenter-shared-facts.md)
passed 42 transforms and 42 separate validators with historical output hashes.
The original Codex input still requires a successful full transform before
any complete capacity claim.

## Fifth attempt: stopped for an indexed-lookup correction

The full transform using the shared facts solver reached normal summaries.
The agent stopped it deliberately after **352.70 seconds** to correct a
lookup plan; neither external guard fired. Its highest observed OS lifetime
physical footprint was **399.00 MiB**, and no artifact was published. Raw
evidence and an explicit manual-stop summary are preserved in
`.context/native-codex-shared-facts-20261024/`. This is not a completed capacity
result or a memory-budget failure.

The full-signature fallback view used a truthy `in_table` condition. SQLite
used only the signature prefix of `(sig, in_table, id)`, scanning functions
absent from the table and sorting the results on each lookup. The equivalent
`in_table=1` predicate binds both prefix fields and returns target order from
the index. The column is populated with zero or one.

A regression with one table target and 10,000 non-table functions sharing
its signature exhausts its explicit extra work allowance under the old
predicate and passes with the indexed equality. Mixed known/unknown target
and unchanged-Walrus comparisons also pass. The next complete run retains
the same physical guard and deadline.

The follow-up passed all 659 instrumenter tests and fourteen complete
controlled transforms with fourteen separate Node validators. All controlled
output hashes match the historical comparison within each backend. The
preserved source and executable are in `.context/native-fallback-index-build/`,
with checks in `.context/native-fallback-index-controlled-smoke/`. Executable
SHA-256:

```
094beb5c342908873b674703b9d241c13c8dd057fc0af48afc72f49b762fd5e8
```

## Sixth attempt: CPU deadline during summary solving

The next full attempt reached the **1,800-second wall-time guard** during
normal-summary solving, after at least 1,090,000 evaluations. It published
no artifact. The memory guard did not fire: the highest observed OS lifetime
physical footprint was **403.42 MiB**, with maximum sampled RSS **752.41 MiB**.
Evidence is in `.context/native-codex-indexed-20261024/`, using the
`094beb5...` executable above. This is not a completed-transform memory result.

The follow-up adds a bounded cache of shared, immutable signature target lists.
Full-signature and unknown-only lists can serve multiple eligible callers;
typed groups with explicit known refinements remain caller-specific. Caller
eligibility is checked before a hit, returned vectors are independent copies,
and reanalysis clears the cache. Return/exception summaries are never cached.
The default allowance is 4 MiB; zero disables it. Eviction or an oversized
group falls back to ordinary lookup and does not reject input. This retains
no function instruction IR and leaves the 16 GiB physical guard and 30-minute
deadline unchanged for the next coordinated attempt.

All 661 instrumenter tests passed with this cache, including disabled/tiny
allowances, eviction, caller-mode separation, returned-vector independence and
invalidation. The work regression includes a negative control: the same extra
allowance succeeds with reuse and exhausts work when caching is disabled.
Fourteen complete controlled transforms and fourteen separate validators
passed with historical output hashes. Source and executable are preserved in
`.context/native-target-cache-build/`, with checks in
`.context/native-target-cache-controlled-smoke/`. Executable SHA-256:

```
e200881b339f676b9d7e8e95401e405b804fae9d536e5d923fea98e21e8a314e
```

## Seventh attempt: repeated target memberships trigger an analysis retry

The cached lookup run completed normal summaries in **474.9 seconds**, after
1,213,389 evaluations with no unsupported bodies. Sink planning then failed
with `sink interpretation exceeds call-target budget`. The interpreter
retained target memberships separately at every call site, including repeated
identical lists in the same function. The default allowed 1,048,576 such
memberships per function. The existing conservative built-in retry started
another analysis pass and reached at least 1,140,000 summary evaluations.

The **1,800-second wall-time guard** stopped that retry. No artifact was
published. The memory guard did not fire: the highest observed OS lifetime
physical footprint was **408.39 MiB**, with maximum sampled RSS **750.84 MiB**.
Evidence, including the guard status and explicit failed-attempt summary,
is in `.context/native-codex-target-cache-20261024/`, using the `e200881...`
executable above. These figures remain failed-transform observations. The
completed summary-phase timing is not a completed-transform speed result.

The follow-up shares exact sorted target lists across sites in one function,
releasing superseded unions when their last site changes. The unchanged
1,048,576-membership allowance now counts distinct retained sets. Sites keep
independent unions. The database also stores each exact group once and keeps
site/caller references, rather than retaining the expanded edge matrix.
Digests narrow candidates; full comparison decides equality. Closure visits
separate function and group vertices, and dependency queries project shared
groups without materializing all function pairs.

All 667 instrumenter tests passed, including forced digest collisions,
independent union growth, and recursive/external closure compared with an
expanded graph. A 600-site, 1,200-target regression fits a 4 MiB database;
the negative control that retains all 720,000 edges exhausts the same
allowance. A fresh [controlled comparison](2026-10-24-native-fork-instrumenter-shared-sinks.md)
passed 42 complete transforms and 42 separate validators with historical
output hashes. This does not establish complete Codex capacity.
Source and executable are preserved in `.context/native-target-groups-build/`.
Executable SHA-256:

```
7f9dd77356b566a1a78182b867a7f8ecc2899bf1cec0e0d7003fa13b038ab291
```

## Eighth run: complete native transform succeeds

The shared-target executable above completed with normal options on the exact
original input under the unchanged 16 GiB physical guard and 1,800-second
deadline. No other heavyweight workspace job ran concurrently. Both guard
status and process exit report success. The final stderr reports
`native analysis: facts`, with no analysis retry.

| Observation | Native result |
|---|---:|
| Complete transform wall time | 1,073.45 seconds |
| OS lifetime peak physical footprint | 451.38 MiB |
| Peak requested Rust allocations | 430.94 MiB |
| Maximum sampled RSS | 827.13 MiB |
| Input bytes | 284,605,220 |
| Validated output bytes | 246,465,075 |

The transform includes immutable input/output snapshots, analysis, frozen
planning, serial emission, feature declarations, serial structural validation,
atomic publication and checksums. Binaryen and Node/browser/guest execution
are excluded. A one-second external stack sample was taken during exception
analysis; this is not a throughput benchmark. The unchanged Walrus run failed
at about 16.02 GiB during analysis. It produced no artifact, so this is not a
completed-transform speed comparison or a same-endpoint memory ratio.

Output SHA-256:

```
4f2cf5e87a3a435e214ddee2506d22d25db1bfbb55d3fa1b07c6beda63030de3
```

Evidence is preserved in `.context/native-codex-target-groups-20261024/`,
including exact input, validated output, guard status, sampled traces,
stdout/stderr, run script and source/binary references. The
[machine-readable summary](2026-10-24-native-codex-transform-summary.json)
records exact values and provenance. The output remains a diagnostic artifact:
it was not executed or admitted into the normal program tree. This proves
completed transform capacity for these bytes, not Codex runtime correctness.
