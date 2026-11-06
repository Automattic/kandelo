# Walrus and native instrumentation comparison, 2026-10-25

Native now essentially matches Bash's complete command-line throughput,
trails Gawk by 12%, and trails Coreutils by 46%. It uses about 79–81% less
peak physical memory in complete raw transforms. These are host-tool
measurements; they do not measure guest application runtime performance.
The requested throughput parity target is not met across all three cases.

## Current build and method

Production source is `73cc1c664efaf2ba89d7563e60bf8fb3a5383724`, with an
empty source patch and 208 preserved source-file hashes. Both backends and
all host dependencies use the normal `instrumenter` Cargo profile, with
speed optimization (`opt-level=3`). The repository builder installs this
profile; an experimental environment override is no longer required.
The guest kernel retains its separate size-optimized release profile.

Use the exact immutable original SDK-link inputs and versions from the
[earlier real-package comparison](2026-10-24-native-instrumentation-profile-fixes.md).
Bash is its untouched original link, before the recipe optimizes a separate
copy. Compiler facts retain their original coordinates. Every native raw
run uses compiler facts without a fallback. No Walrus source was modified.

This run has five fresh serial processes per backend and phase, alternating
backend order. No builds or test suites ran alongside the timing matrix.
Ordinary desktop applications and macOS services remained active on the
18-core Apple M5 Max Mac with 48 GiB physical memory. The guard is 16 GiB
with a 30-minute per-process deadline; it is separate from cache allowances.

CLI timings include normal Binaryen `Os` post-optimization. Raw transforms
exclude Binaryen and include common immutable input snapshots, complete
analysis/emission, feature declaration, serial structural validation,
atomic publication and checksums. Raw physical memory is the OS lifetime
peak footprint, not resident set size. CLI memory measurements do not
include optimizer-child footprint and are not used for memory claims.

All 60 transforms and 60 independent Node compilation/production
artifact-policy checks pass. Every output hash matches the preceding
performance stages within its backend, input and phase. Real packages are
not executed in this benchmark. The [JSON evidence](2026-10-25-native-instrumentation-comparison.json)
records input/source/binary hashes, output sizes/hashes, wall ranges,
CPU medians, physical peaks and Rust allocation peaks.

## Complete CLI timing

Five-run wall medians, including Binaryen:

| Package | Walrus | Native | Native / Walrus |
|---|---:|---:|---:|
| Gawk 5.3.0 | 1.552 s | 1.742 s | 1.123 |
| Coreutils 9.6 | 0.817 s | 1.190 s | 1.456 |
| Bash 5.2.37 | 2.428 s | 2.439 s | 1.005 |

Bash's 0.5% difference is within the observed ranges; this supports parity
in this run, not a native speed win. Gawk and Coreutils remain slower.

## Raw transforms and memory

Five-run medians, excluding Binaryen:

| Package | Walrus wall | Native wall | Walrus physical peak | Native physical peak |
|---|---:|---:|---:|---:|
| Gawk | 0.860 s | 0.879 s | 174.41 MiB | 35.88 MiB |
| Coreutils | 0.471 s | 0.803 s | 196.47 MiB | 38.02 MiB |
| Bash | 1.839 s | 1.574 s | 179.49 MiB | 37.41 MiB |

Native is about 2% slower on raw Gawk, 70% slower on raw Coreutils, and
14% faster on raw Bash. The memory savings remain substantial in all
three examples. The full CLI result is the relevant throughput comparison
for normal package builds.

## Progress since the previous speed experiment

The [preceding experiment](2026-10-24-native-instrumentation-additional-rounds.md)
used three-run medians and an explicit speed-profile environment override.
Both sides were already compiled for speed. Its native CLI medians were
2.051 / 1.280 / 3.305 seconds for Gawk / Coreutils / Bash; current medians
are 1.742 / 1.190 / 2.439 seconds, observed reductions of 15% / 7% / 26%.
These are separate timing sessions, not an interleaved source-isolation
experiment. Paired Walrus/native results above define the remaining gap.

The retained changes reduce branch-state allocation, batch target writes
and reuse specialized effects after normal summaries become immutable.
A target-first scheduling experiment was measured and removed because it
barely changed evaluation counts. Details and exact stage fingerprints
are in the [four-round report](2026-10-24-native-instrumentation-frozen-effects.md).

The automatic effect-cache allowance now scales from 16 to 64 MiB with
code size, with explicit overrides and on-demand allocation. All three
real packages already fit within 4 MiB of entries, so larger capacity is
not responsible for their improvement. A separate controlled pressure
case improves 41% at 16 MiB; see the [cache-sizing evidence](2026-10-25-native-cache-sizing.md).

## Current-source correctness checks

The same candidate source passed all 673 instrumenter Rust tests across
76 groups with no failures or skips, 28 focused Node checks, and 57
browser checks across Chromium, Firefox and Playwright WebKit on both
pointer widths. The Node checks include native file/process paths,
exception/reference replay and side-module fork cases. The normal builder
also passed its external-working-directory and stale-source-stamp checks.
The ABI snapshot/generated-contract check passed.

These checks ran after timing, through `scripts/dev-shell.sh`. They do
not establish full workspace, full application benchmark or conformance
coverage. The latest original 284.6 MB Codex capacity rerun and full
workspace/conformance reruns remain pending; earlier revision-specific
results are retained in their historical reports. The PR remains a draft.

Subsequent [native-default rollout validation](2026-10-25-native-default-rollout.md)
completed the current workspace, selected conformance, fresh package execution
and original Codex capacity checks at a later recorded source. The measurements
and candidate-specific evidence above remain unchanged.
