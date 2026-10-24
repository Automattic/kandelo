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

The default is now a generous 268,435,456-unit sanity ceiling. This changes
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
