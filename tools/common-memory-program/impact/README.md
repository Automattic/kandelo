# PHP-FPM memory and latency comparison

This fixture compares ordinary Wasm with FILE-only OPcache, translated Wasm
with FILE-only OPcache, and the **same translated executable** with shared
OPcache. It uses the current source-built common-memory host profile, not the
survey's older compiler runtime. "Native" in raw arm names means ordinary
Wasm; it does not mean machine-native PHP.

All arms use the same derived WordPress image. Preparation removes existing
FILE-cache contents and FPM; the fixture installs the chosen FPM through the
worker-owned VFS before starting services. Image provenance and executable
hashes are retained. SQLite and MariaDB use two FPM workers with timestamp
validation enabled and a zero revalidation interval. The ordinary and
translated executables have other build differences, including the opt-in
clock path: their comparison does not isolate address translation alone.

Prepare a fresh fixture from a normal `wordpress-common-memory` image and its
original ordinary FPM, then create a plan. Supply an ABI-matched kernel and a
fresh `host/build-common-memory.mjs` source profile as described in the
[prototype guide](../../../docs/experimental-common-memory.md).

```sh
scripts/dev-shell.sh node --import tsx/esm tools/common-memory-program/impact/prepare.ts \
  COMMON_WORDPRESS_IMAGE ORDINARY_FPM .scratch/impact-fixture
scripts/dev-shell.sh node tools/common-memory-program/impact/plan.mjs \
  .scratch/impact-fixture COMMON_PROFILE MATCHING_KERNEL \
  .scratch/impact-results .scratch/impact-plan.json
scripts/agent-job start --name common-memory-impact -- scripts/dev-shell.sh \
  env WASM_POSIX_RESOLUTION_POLICY=source-only-v1 \
  WASM_POSIX_SOURCE_ONLY_BINARY_ROOT=MATCHING_SOURCE_ONLY_PROJECTION \
  node tools/common-memory-program/impact/run-with-xpc.mjs .scratch/impact-plan.json
scripts/dev-shell.sh python3 tools/common-memory-program/impact/analyze.py \
  .scratch/impact-results .scratch/impact-analysis
```

Choose the normal projection matching the image's opaque lazy-asset references.
The server uses the ordinary guarded resolver; integrity failures remain fatal.
Do not modify the frozen plan inputs while a run is active. Stop builds and
other measurement jobs before running, record the remaining machine load, and
retain failed attempts. The runner refuses an existing output directory.

The complete plan starts **96 fresh parents**, serially: three configurations,
two databases, four hosts, two opposite orders, and separate timing/resource
runs. Every timing parent performs four warmup and seven measured rounds of
four pages. The resource parents perform four warmup and three measured rounds,
but their request durations are excluded from latency analysis. Admin login,
both workers and cache configuration are checked. Separate `mode: "check"`
plans exercise live source edits and timestamp invalidation; those are
correctness controls, not timing samples.

Resource probes record guest accounting, kernel linear capacity, and macOS
physical footprint at workload boundaries. Node includes its Worker threads;
browser coverage is the launched process and `ps`-visible descendants. Detached
processes outside that ancestry are not generally established. For WebKit on
macOS, the corrected runner also includes new WebContent/GPU/network XPC
services from its exact Playwright cache build. It refuses a pre-existing user
of that build or ambiguous launcher ownership. The original `run.mjs` is
retained for the first campaign, whose WebKit tree-only footprint is incomplete
and must not be used as the engine's memory total. The OS metric is
physical footprint, not RSS; summing `ps` RSS can double-count shared pages.
The analyzer refuses incomplete OS samples. FILE-cache inventory reports
logical file lengths, not RAM. Ordinary linear buffers and translated mapped
pages also have different accounting coverage.

Two parent launches per case support descriptive comparisons, not statistical
significance or production sizing. Rounds within one parent are correlated.
Guest FILE caches start empty; OS caches are not flushed. Cold first-homepage
time starts at service launch, after image loading and FPM installation. Warm
measurements are serial HTTP latency, not saturated throughput. Preserve both
orders and inspect the page-level results before making a recommendation.

The first campaign used the tree-only probe. Its correction was declared
before any WebKit resource case started: repeat every WebKit resource case
with XPC coverage, then uniformly replace those twelve cases for analysis.
Keep both raw campaigns. `merge.py ORIGINAL CORRECTION FRESH_OUTPUT` checks the
case sets, declaration time, unchanged shared inputs and successful launches;
it records origin paths and the excluded cases. This yields 96 analyzed
parents from 108 collected parents. The latency parents are unchanged.

For offline reanalysis of retained evidence, the analyzer accepts a third
argument naming a directory of input files stored by SHA-256 digest. This lets
it verify the frozen inputs without requiring the original absolute checkout
and cache paths. The original plan still owns the path-to-digest mapping.
