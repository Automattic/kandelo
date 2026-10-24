# Guarded native Codex transform attempts

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
