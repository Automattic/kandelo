# Shared WebAssembly memory optimization survey

A common `WebAssembly.Memory` is feasible for the trusted, memory32,
single-Worker-per-process PHP-FPM prototype. Real WordPress runs with SQLite
and MariaDB, forked private state stays independent, and workers share actual
OPcache pointer graphs. That is a useful result for prefork applications that
need shared mappings. It does not yet justify making this the general process
memory model: address translation still costs time, and release acceptance
remains incomplete. The subsequent
[source integration screens](../experimental-common-memory.md) add bounded
exact-generation reclamation, normal SDK/package builds, timestamp-preserving
direct clocks and WordPress source-edit checks. Their mechanism counts are
separate from this survey's frozen timings; no new application speedup is
inferred from integration correctness.

Keep timestamp validation enabled as the primary configuration. The completed
timestamp survey below supersedes the earlier scalar recommendations and
pending statuses. Short copies and direct clock renewal are the leading
application candidates. O2 remains the comparison point; no compiler screen
establishes an optimal flag set.

This synthesis covers the original 19 candidate families and the subsequent
timestamp-preserving metadata and scalar-adapter screens in the
[append-only experiment catalog](2026-11-11-common-memory-optimization-catalog.md).
Each has a bounded feasibility, mechanism, coverage or performance screen;
those evidence depths are deliberately distinguished below. Unimplemented
extensions remain research ideas. The catalog, original reports and raw
records preserve unsuccessful and inconclusive attempts as well as wins.


## Subsequent execution-stop measurement — 2026-11-14

The current format-2 integration adds mandatory function/loop stop checks.
A [separate instruction report](2026-11-14-common-memory-stop-overhead.md)
compares that instrumentation against both unchecked translation and
unvirtualized Wasm on all four hosts. It retains labeled numbers, two parent
cohorts per host and all raw samples. WebKit's tight call loop and Firefox's
atomic loop show substantial added costs. This is a different handwritten-Wasm
workload from the survey below; it neither revises those historical ratios nor
measures current PHP request time. Safe poll placement using bounded callees
and call-graph cycles is retained as an unimplemented research candidate.

The subsequent [ordinary-runtime comparison against pinned main](2026-11-14-common-memory-default-regression.md)
completes all nine enabled canonical suites on Node and Chromium in opposing
orders. It retains lower Node stdin throughput and higher Node exec/locking
costs, plus two Chromium database flags. Those whole-candidate comparisons
include differing application artifacts and preserved unrelated changes. They
do not revise this survey's frozen ratios or measure current translated PHP
request latency; the integration is not claimed to be performance-neutral.

## Completed timestamp optimization survey — 2026-11-13

All seven retained timestamp families have individual bounded screens, including both pathname/scalar alternatives, copy thresholds, direct clocks and renewal, conservative/finer backend caching and a distinct guest fast-stat route. This section supersedes earlier pending statuses and scalar recommendations. Every negative result and rejected approach is retained. Follow-up hardening and production acceptance remain separate work.

Primary application measurements retain `opcache.validate_timestamps=1` and `opcache.revalidate_freq=0`. Ratios below are candidate/baseline translated request time, equal-weight geometric means across four SQLite WordPress pages and opposing orders; smaller favors candidate. Separate rows have their own matched baseline and must not be multiplied. Ordinary controls, page/order results, raw samples, load and provenance are in the detailed sections and retained archives. These are bounded observations, without confidence intervals or CPU attribution.

| Individual experiment | Node | Chromium | Firefox | WebKit | Interpretation |
|---|---|---|---|---|---|
| TS-01 synchronous stat reuse | VM candidate / baseline: **1.0125** | VM candidate / baseline: **1.0057** | VM candidate / baseline: **0.9889** | VM candidate / baseline: **0.9832** | Small/mixed; original Chromium timeout retained. |
| TS-02 page pathname scanner (byte) | VM candidate / baseline: **0.9890** | VM candidate / baseline: **1.0016** | VM candidate / baseline: **0.9938** | VM candidate / baseline: **0.9821** | No common preset; opposing-order reversals retained. |
| TS-02 page pathname scanner (word) | VM candidate / baseline: **1.0006** | VM candidate / baseline: **0.9989** | VM candidate / baseline: **1.0145** | VM candidate / baseline: **0.9759** | No common preset; opposing-order reversals retained. |
| TS-03 scalar adapters | Application estimate: **not admitted** | Application estimate: **not admitted** | Application estimate: **not admitted** | Application estimate: **not admitted** | Both independently skip observable Array.at callbacks; historical timings retained with this qualification. |
| TS-04 short copies, threshold64 | VM candidate / baseline: **0.8878** | VM candidate / baseline: **0.8966** | VM candidate / baseline: **0.9233** | VM candidate / baseline: **0.9193** | Promising; both WordPress orders/all pages favor candidate; operation negatives retained. |
| TS-05 direct clocks | VM candidate / baseline: **0.9915** | VM candidate / baseline: **0.9750** | VM candidate / baseline: **0.9872** | VM candidate / baseline: **0.9856** | Small application gain despite large synthetic clock gain. |
| TS-05-R1 VM clock renewal | VM candidate / baseline: **0.9530** | VM candidate / baseline: **0.9521** | VM candidate / baseline: **0.9542** | VM candidate / baseline: **0.9403** | Baseline is original direct-clock runtime; does not compare against pre-clock PHP. |
| TS-06 backend metadata cache (conservative) | VM candidate / baseline: **0.9979** | VM candidate / baseline: **1.0025** | VM candidate / baseline: **0.9998** | VM candidate / baseline: **1.0242** | Baseline is no cache; small/mixed results. |
| TS-06 backend metadata cache (finer) | VM candidate / baseline: **0.9995** | VM candidate / baseline: **0.9991** | VM candidate / baseline: **0.9949** | VM candidate / baseline: **1.0085** | Baseline is no cache; small/mixed results. |
| TS-06 bounded guest fast-stat | VM candidate / baseline: **1.0355** | VM candidate / baseline: **1.0354** | VM candidate / baseline: **1.0419** | VM candidate / baseline: **1.0118** | WordPress regression despite repeated-stat loop gain; retain for other workloads. |
| TS-07 frequency2 policy | VM candidate / baseline: **0.7369** | VM candidate / baseline: **0.7962** | VM candidate / baseline: **0.8188** | VM candidate / baseline: **0.7680** | Minimum observed shared detection: **1.998s**<br>Maximum observed shared detection: **2.965s**<br>Includes queueing/polling; different freshness. Primary frequency0 remains. |

The repeated-stat guest route reduces its translated PHP CLI stat-loop time to0.0531/0.0531/0.0743/0.0707 of baseline (Node/Chromium/Firefox/WebKit), while lstat is3.8–8.4% slower. This does not predict WordPress latency. Initial unused ordinary snapshot overhead, the interrupted app run and repaired VM-only issuance remain recorded separately.

The final combined application run compares **baseline**, **strong** (short64 copies + direct clocks + VM metadata clock renewal), and **broad admitted subset** (strong + synchronous metadata reuse + page-byte scanner + finer backend cache + bounded VM guest stat with shared final eligibility). Baseline is the retained matched prototype without these extra timestamp factors; these are not origin/main merge-performance numbers. Both scalar shortcuts are excluded following concrete semantic counterexamples. The literal all-factor bundle and provisional DataView-only bundle have **no admitted application timing**. This is a comparison of selected bundles, not an attribution of individual marginal effects.

Final broad clock/stat/mixed guests pass24 parents across all four hosts and both models; unchanged strong guest evidence is reused. Freshness gates pass16 new broad and16 unchanged strong parents, both databases/models/all hosts; both FPM workers see edited source before explicit invalidation. Diagnostic-free CLI micro48 and application72 pass every frozen final input. Application cases use two warmup/five measured rounds, opposing variant orders and ordinary-before/after brackets; timing uses SQLite, while freshness also uses MariaDB.

| Host | Strong bundle | Broad admitted subset | Broad / strong translated time |
|---|---|---|---|
| Node | VM / baseline: **0.8567**<br>Ordinary / baseline: **0.9412**<br>VM / own ordinary: **1.7335×**<br>Ratio after ordinary normalization: **0.9102** | VM / baseline: **0.8885**<br>Ordinary / baseline: **1.0309**<br>VM / own ordinary: **1.6412×**<br>Ratio after ordinary normalization: **0.8618** | VM broad / strong: **1.0371** |
| Chromium | VM / baseline: **0.8371**<br>Ordinary / baseline: **0.9959**<br>VM / own ordinary: **1.2991×**<br>Ratio after ordinary normalization: **0.8406** | VM / baseline: **0.8901**<br>Ordinary / baseline: **0.9979**<br>VM / own ordinary: **1.3786×**<br>Ratio after ordinary normalization: **0.8920** | VM broad / strong: **1.0633** |
| Firefox | VM / baseline: **0.8970**<br>Ordinary / baseline: **0.9790**<br>VM / own ordinary: **1.3537×**<br>Ratio after ordinary normalization: **0.9163** | VM / baseline: **0.9448**<br>Ordinary / baseline: **0.9964**<br>VM / own ordinary: **1.4009×**<br>Ratio after ordinary normalization: **0.9483** | VM broad / strong: **1.0533** |
| WebKit | VM / baseline: **0.8799**<br>Ordinary / baseline: **1.0181**<br>VM / own ordinary: **1.1127×**<br>Ratio after ordinary normalization: **0.8643** | VM / baseline: **0.9145**<br>Ordinary / baseline: **1.0154**<br>VM / own ordinary: **1.1595×**<br>Ratio after ordinary normalization: **0.9007** | VM broad / strong: **1.0393** |

| Host / bundle | Opposing application orders | Translated CLI filesystem micro ratios | Ordinary CLI controls |
|---|---|---|---|
| Node / strong | First order VM / baseline: **0.8645**<br>Reverse order VM / baseline: **0.8490** | Stat VM / baseline: **0.5419**<br>Lstat VM / baseline: **0.5855**<br>Missing VM / baseline: **0.5138** | Stat ordinary / baseline: **0.9908**<br>Lstat ordinary / baseline: **1.0325**<br>Missing ordinary / baseline: **0.9770** |
| Node / broad | First order VM / baseline: **0.9017**<br>Reverse order VM / baseline: **0.8755** | Stat VM / baseline: **0.0502**<br>Lstat VM / baseline: **0.6218**<br>Missing VM / baseline: **0.5008** | Stat ordinary / baseline: **1.0434**<br>Lstat ordinary / baseline: **0.9906**<br>Missing ordinary / baseline: **1.0251** |
| Chromium / strong | First order VM / baseline: **0.8398**<br>Reverse order VM / baseline: **0.8344** | Stat VM / baseline: **0.6245**<br>Lstat VM / baseline: **0.6095**<br>Missing VM / baseline: **0.5251** | Stat ordinary / baseline: **0.9846**<br>Lstat ordinary / baseline: **1.0178**<br>Missing ordinary / baseline: **0.9834** |
| Chromium / broad | First order VM / baseline: **0.8874**<br>Reverse order VM / baseline: **0.8928** | Stat VM / baseline: **0.0485**<br>Lstat VM / baseline: **0.6283**<br>Missing VM / baseline: **0.5211** | Stat ordinary / baseline: **0.9720**<br>Lstat ordinary / baseline: **0.9820**<br>Missing ordinary / baseline: **0.9817** |
| Firefox / strong | First order VM / baseline: **0.8887**<br>Reverse order VM / baseline: **0.9054** | Stat VM / baseline: **0.7449**<br>Lstat VM / baseline: **0.7372**<br>Missing VM / baseline: **0.5990** | Stat ordinary / baseline: **0.9275**<br>Lstat ordinary / baseline: **0.9226**<br>Missing ordinary / baseline: **0.9466** |
| Firefox / broad | First order VM / baseline: **0.9490**<br>Reverse order VM / baseline: **0.9406** | Stat VM / baseline: **0.0706**<br>Lstat VM / baseline: **0.9806**<br>Missing VM / baseline: **0.6974** | Stat ordinary / baseline: **0.8934**<br>Lstat ordinary / baseline: **0.9019**<br>Missing ordinary / baseline: **0.9514** |
| WebKit / strong | First order VM / baseline: **0.8548**<br>Reverse order VM / baseline: **0.9058** | Stat VM / baseline: **0.7314**<br>Lstat VM / baseline: **0.7044**<br>Missing VM / baseline: **0.6546** | Stat ordinary / baseline: **0.9642**<br>Lstat ordinary / baseline: **1.0074**<br>Missing ordinary / baseline: **1.0030** |
| WebKit / broad | First order VM / baseline: **0.8955**<br>Reverse order VM / baseline: **0.9340** | Stat VM / baseline: **0.0612**<br>Lstat VM / baseline: **0.8325**<br>Missing VM / baseline: **0.6415** | Stat ordinary / baseline: **0.9528**<br>Lstat ordinary / baseline: **0.9729**<br>Missing ordinary / baseline: **0.9943** |

Ordinary after/before page drift: 0.6693–1.4801; recorded one-minute load: 2.44–5.10. Every page/order regression remains in the reader output (1 cases). Managed-job registries document surrounding work; they do not prove whole-machine idleness. No confidence intervals, real PHP fast-hit census or CPU attribution were collected.

The smaller bundle has lower raw translated time than the broad bundle in every host and both orders. All its individual page/order ratios favor it over baseline; the broad bundle retains one Firefox article regression (first order, candidate/baseline1.0084). Node's ordinary strong/baseline ratio0.9412 and broad/baseline1.0309 materially complicate the marginal comparison: normalizing by those controls reverses the Node bundle ranking. The broad-versus-strong raw gap is not clean causal attribution to its extra factors. The large ordinary bracket drift above is a limitation even though the run began after the reported build ended. Treat these as bounded exploratory measurements and a prioritization signal, not precise general speedup estimates.

**Ordinary means untranslated WebAssembly in the same engine, not machine-native PHP.** VM/ordinary includes anonymous-shared versus FILE-only OPcache configuration, so it is not pure translation overhead. Primary timestamps remain enabled at frequency0. Builds are normal private incremental SDK/PHP relinks from the retained CALL/O2/no-LTO object/dependency closure, not a fresh canonical image. Full conformance, browser-memory, all-platform benchmark and canonical-product acceptance were not run for these experimental bundles. No default or existing interactive preview is changed.

Recommendation: prioritize the short-copy/direct-clock/renewal bundle for the next acceptance stage, subject to the opposing-order and ordinary-control results above. Keep backend caches, scanners and guest-stat for workload-specific work rather than infer general gains from loop results. Scalar hardening needs observable-intrinsic admission before promotion. Frequency2 remains an explicit freshness tradeoff, not a same-freshness optimization.

Final timing matrices were started after the user reported the other workspace build had finished. Its exact identity/start/overlap was not established by the managed registry. The earlier in-flight application matrix was conservatively stopped143 before any partial latency inspection; it and the earlier completed CLI matrix are retained as potentially load-affected exploratory records in `timestamp-combination-reported-load-attempt`, without an admitted application estimate. The post-report run does not prove whole-machine idleness.

Final plan: `.scratch/timestamp-combination-php-plan-2/manifest.json`; strict reader: `.scratch/analyze-timestamp-combination-final-scoped.py`; outputs: `.scratch/timestamp-combination-{php-micro,wordpress}-analysis-3/analysis.json`. Retained evidence: `.context/timestamp-optimization-20261113/timestamp-combination-final-admission` and `timestamp-combination-final-timing`, with independent readback recorded separately.

## What the memory model buys

One group owns the physical backing memory. Each process resolves canonical
guest virtual addresses through its own mapping root. Fork preserves guest
pointer values: the child's private mappings resolve to its copies, while
shared mappings resolve to the same bytes. This avoids scanning and rewriting
all stored pointers. Instrumentation-generated physical temporaries still
need correct binding across fork replay and mapping changes.

The model is attractive when a shared pointer graph matters enough to pay for
translation elsewhere: PHP OPcache is the demonstrated example. A similar
argument might apply to other prefork services, but PostgreSQL has not been
ported or characterized by this experiment. This shared backing also provides
no isolation boundary between mutually untrusted group members.

Skipping translation merely because a function cannot call `fork()` is
unsound. That function can run in an already-forked child and receive a private
pointer created before fork. Useful shortcuts instead need a proof about
pointer origin, mapping lifetime, permissions and effects. Unknown pointers
retain translation. Hoisted physical addresses must be rematerialized after
fork or invalidating mapping effects, without replaying visible writes or
calls. See the catalog's [proof boundaries](2026-11-11-common-memory-optimization-catalog.md#selective-translation-proof-boundaries).

## Timestamp enabled application results

The latest factorial uses the same PHP O2 CALL build and O2 helper, with only
small-offset scalar fusion and guarded byte-copy adaptation varied. All 64
fresh parents pass on Node, Chromium, Firefox and WebKit. Each host has two
opposing VM orders and ordinary FILE-cache brackets under both actual host
profiles. Each parent serves two warmup and five measured four-page rounds:
1,280 measured pages and 512 warmup pages in total. The image starts with an
empty FILE cache; shared cases disable FILE cache and populate shared OPcache.

Ratios below are equal-weight geometric means of four page-median ratios over
the two cohorts. Lower is shorter request latency. They describe this bounded
SQLite workload, rather than CPU cost, traffic-weighted throughput or a
confidence interval.

| Host | Byte copy / baseline | Fusion / baseline | Both / baseline | Both / own ordinary Wasm |
|---|---:|---:|---:|---:|
| Node | 0.9213 | 1.3326 | 0.7938 | 1.6505 |
| Chromium | 0.8252 | 0.8575 | 0.7569 | 1.3285 |
| Firefox | 0.9536 | 0.8890 | 1.2635 | 1.9512 |
| WebKit | 1.2186 | 1.0549 | 1.3052 | 1.7344 |

The cohorts change the interpretation materially:

- Node's combined/baseline ratios are 0.7774/0.8105, but fusion alone reverses
  from 0.9139 to 1.9430. The apparent large increment from adding bytes to that
  adverse fusion parent is not a clean marginal estimate.
- Chromium's combined/baseline ratios are 0.8640/0.6631. Adding fusion after
  byte-copy gives the more consistent 0.9119/0.9226. Both are follow-up signals,
  not a reliable promise of 24% lower latency.
- Firefox's combination reverses from 1.9862 to 0.8038. Byte-copy alone
  (0.9842/0.9240) and fusion alone (0.9078/0.8706) look better in both orders;
  combining them is not justified by this screen.
- WebKit's combined/baseline ratios are 1.0297/1.6545. Fusion alone is adverse
  in both orders (1.0515/1.0582). Keep the compact baseline as the reference.

Ordinary means **untranslated Wasm in the same engine**, not machine-native
PHP. The final column compares shared OPcache with ordinary FILE OPcache and
therefore includes cache-backend effects. It is not a pure translation tax.
Ordinary page-bracket drift reaches 1.54x; observed one-minute load spans
2.81–20.47 across the batch. The results establish neither quiet-machine nor
steady-state performance. All page/cohort, cold-start, memory and load records
remain in [the complete result](../../.context/common-memory-survey-20261111/phase59/runs/common-memory-byte-timestamps-timing-analysis-1/analysis.json)
and the [qualified interpretation](../../.context/common-memory-survey-20261111/phase59/runs/common-memory-byte-timestamps-timing-analysis-1/interpretation.json).

The enabled policy also has an actual edit test: both workers see version 2
after an mtime change, before explicit invalidation. Its original collector
failed by freezing its own empty output log. The guest cases passed; a
[separate recovery audit](../../.context/common-memory-survey-20261111/phase59/runs/common-memory-byte-timestamps-policy-recovery-1/receipt.json)
verified the real inputs and results without rerunning guests or changing the
original failed receipt. Both-database correctness gates are separate from
these SQLite timings.

### Observed cohort ranges with validation retained

These rounded ranges span the **two observed cohort aggregates** (four page
medians each). They are not confidence intervals, per-page extrema, or a
forecast for the next run. Negative changes mean shorter elapsed time; mixed
signs expose reversals. The point ratios and ordinary denominators remain in
the table above.

| Change from outlined baseline | Node | Chromium | Firefox | WebKit |
|---|---:|---:|---:|---:|
| Byte-copy alone | -11% to -5% | -28% to -5% | -8% to -2% | -1% to +51% |
| Scalar fusion alone | -9% to +94% | -19% to -9% | -13% to -9% | +5% to +6% |
| Both | -22% to -19% | -34% to -14% | -20% to +99% | +3% to +65% |

### Timestamp-preserving stat follow-up

APP-03 implements reuse of the metadata already returned by one namespace
walk for kernel-owned rootfs/tmpfs stat calls. It adds no cross-request cache
and keeps validate_timestamps=1/revalidate_freq=0. Both FPM workers observe
edited cached source before explicit invalidation in all sixteen freshness
parents, covering SQLite/MariaDB and both addressing/cache modes on every
host. The separate stat-loop screen completes thirty-two fresh parents.

The SQLite application comparison below uses the unchanged plain host
profile and PHP O2 CALL/outlined/O2-helper build. Each parent serves two
warmup and five measured rounds of four pages. Ratios are equal-weight
geometric means of page medians; lower is shorter latency. The two orders
are independent fresh parents, not confidence intervals.

| Host | Translated shared-cache candidate/baseline | Ordinary FILE-cache candidate/baseline |
|---|---|---|
| Node | First cohort: **1.0008**<br>Second cohort: **1.0242**<br>Combined: **1.0125** | First cohort: **1.0125**<br>Second cohort: **0.9893**<br>Combined: **1.0008** |
| Chromium | First cohort: **1.0095**<br>Second cohort: **1.0019**<br>Combined: **1.0057** | First cohort: **0.9914**<br>Second cohort: **0.9909**<br>Combined: **0.9912** |
| Firefox | First cohort: **0.9977**<br>Second cohort: **0.9803**<br>Combined: **0.9889** | First cohort: **1.0161**<br>Second cohort: **1.0100**<br>Combined: **1.0131** |
| WebKit | First cohort: **0.9803**<br>Second cohort: **0.9862**<br>Combined: **0.9832** | First cohort: **1.0069**<br>Second cohort: **1.0339**<br>Combined: **1.0203** |

This is a small, mixed result, without an established material application
win. Ordinary page-bracket after/before drift spans0.7241–1.0497, and primary
one-minute load spans2.75–8.65. The original timing batch timed out in a
Chromium candidate parent; its phase is unknown because trial progress was
not retained. A separate instrumented candidate/baseline diagnostic passes.
The full browser batch was then repeated with no automatic retries and
completed all thirty-six parents. The primary comparison combines that batch
with the original complete twelve Node parents; the earlier eight completed
browser parents and timeout are preserved separately. The later pass does
not explain or erase the failure.

The [detailed result](2026-11-11-common-memory-optimization-catalog.md#app-03-measurements-and-disposition)
retains the patch, micro ratios, own ordinary denominators, cold/resource/load
results and validation failures. The runtime suite has one failure reproduced
with pre-change source, and the workspace suite has unrelated test compile
errors. Full platform performance/conformance acceptance remains outstanding.
Keep this patch as an experiment; prioritize page-wise pathname/short-record
translation and a direct clock capability that preserves logical clocks,
clock IDs and signal delivery. Those next candidates remain unimplemented.

## Findings across all candidate families

The stable IDs link this synthesis to the original hypotheses and detailed
ledger. A negative screen rejects that implementation on that workload; it
does not discard the technique.

Numbers in this table are observed results, not predicted production gains.
Each value is labeled with its host or metric. Unless a row states otherwise,
latency ratios compare the candidate with its matched
VM reference: **0.90 = 10% less elapsed time; 1.10 = 10% more**. The microbenchmark
ARCH-01 row explicitly uses ordinary Wasm instead. FPM compute and mixed-page
WordPress are different workloads. Older timestamp-off results are labeled;
they do not estimate the same optimization with validation retained. All
cohort variation and control drift in the linked catalog still apply. Rows
with only coverage or resource data have no inferred latency benefit.

| Family | Quantitative evidence | Finding and retained direction |
|---|---|---|
| VM-01 scalar resolver | FPM compute, normalized to each mode’s ordinary brackets.<br>Node: **0.959**<br>Chromium: **0.948**<br>Firefox: **0.986**<br>WebKit: **1.093** | Modest Node compute signal, inconclusive browser ranking. Keep specialized single-page resolution with its general fallback. |
| VM-02 conditional commit | FPM compute, same normalization as VM-01.<br>Node: **1.006**<br>Chromium: **0.996**<br>Firefox: **0.977**<br>WebKit: **0.943** | No consistent shared-cache gain. Retain for store-heavy workloads. |
| VM-03 page caches | One-entry cache, FPM compute.<br>Node: **1.302**<br>Chromium: **1.205**<br>Firefox: **1.356**<br>WebKit: **1.339**<br>Across-host latency increase: about **20–36%** | These placements regress compute. Invocation-local and hoisted placements remain different ideas. |
| VM-04 object spans | Object guard alone, FPM compute.<br>Node: **0.965**<br>Chromium: **0.997**<br>Firefox: **1.016**<br>WebKit: **0.997**<br>Static sites selected: **349** | Correct guarded rewrite, mixed timings and outliers. Improve coverage/proofs before another large matrix. |
| VM-05 loops, bulk and SIMD | Byte-copy alone, WordPress, timestamps **on**.<br>Node: **0.921**<br>Chromium: **0.825**<br>Firefox: **0.954**<br>WebKit: **1.219**<br>Dense span+SIMD / ordinary vector control: about **1.00–1.03x**<br>Strict readonly-loop dispatch reach: about **0.162–0.163%**<br>Broader writer-candidate dispatch reach: **4.344%** | Preserving bulk is essential; byte-copy is an application lead with host dependence. Loop reach is not a safe-hoisting proof or a CPU-saving estimate. |
| VM-06 alignment and bounds | Atomic specialization alone, WordPress, timestamps **off**.<br>Node: **1.016**<br>Chromium: **1.005**<br>Firefox: **0.975**<br>WebKit: **1.045** | Small Firefox signal, no universal gain. Wasm alignment hints alone are not proofs. |
| VM-07 shadow stack | Regional fast-path dispatch coverage: **1.73%**<br>Tracked frame-origin reach: **0.54%**<br>Coverage only; no latency estimate. | All observed regional guards hit. Broader stack lifetime/fork-rebinding proofs remain. |
| VM-08 provenance and call effects | Conservative call-crossing parent dispatch bound: **0.024%**<br>Constant-address dispatch reach: **5.3418%**<br>FPM module size added: **499,846 bytes**<br>No general speedup estimate. | Constant specialization shows no clear Node/Chromium increment and has an unresolved Firefox HTTP504. No sustained admission for that pass. |
| VM-09 affine arenas | Per-access affine cache, WordPress, timestamps **off**.<br>Node: **1.343**<br>Chromium: **1.440**<br>Firefox: **1.514**<br>WebKit: **1.651**<br>Across-host latency increase: about **34–65%**<br>Two-window wrapped-attempt coverage: **40.9%** | This cache placement regresses synthetic reads and the application screen. Once-per-loop/span guards remain promising hypotheses. |
| VM-10 selective inlining | Scalar fusion alone, WordPress, timestamps **on**.<br>Node aggregate: **1.333**<br>Chromium: **0.858**<br>Firefox: **0.889**<br>WebKit: **1.055**<br>Node, first cohort: **0.914**<br>Node, second cohort: **1.943**<br>Wrapper count reduction: over **94%**<br>Wrapper-policy module size added: about **1.1 MB** | Node’s latest aggregate is unstable. Small scalar fusion has repeated Node/Chromium leads and adverse WebKit results. Alignment normalization/generic large offsets provide no clear warm increment over fusion. |
| CC-01 compiler levels | Both PHP/helper O3, WordPress, timestamps **off**.<br>Node: **0.989**<br>Chromium: **1.047**<br>Firefox: **1.008**<br>WebKit: **0.953**<br>Size flags have C-unit size evidence only. | No general O3 gain. Os/Oz shrink some units; Oz enlarges some largest functions. Per-unit cold-code tuning remains unlinked and untimed. |
| CC-02 LTO | WordPress, timestamps **off**.<br>Full LTO, Node: **0.996**<br>Full LTO, Chromium: **1.009**<br>Full LTO, Firefox: **0.997**<br>Full LTO, WebKit: **0.962**<br>ThinLTO, Node: **1.003**<br>ThinLTO, Chromium: **1.006**<br>ThinLTO, Firefox: **1.049**<br>ThinLTO, WebKit: **0.953** | No broad winner; some narrow signals, larger code and adverse combinations. Dependency-wide LTO and LTO+PGO remain distinct ideas. |
| CC-03 PGO | WordPress, timestamps **off**.<br>PGO alone, Node: **0.893**<br>PGO alone, Chromium: **0.802**<br>PGO alone, Firefox: **0.982**<br>PGO alone, WebKit: **0.983**<br>PGO+fusion / fusion, Node: **2.396**<br>PGO+fusion / fusion, Chromium: **0.976**<br>PGO+fusion / fusion, Firefox: **0.945**<br>PGO+fusion / fusion, WebKit: **1.147** | Mixed effects, with a large Node combination regression and a Chromium PGO-alone lead. Source PGO precedes translation and does not train injected helpers. |
| CC-04 later compiler passes | FPM compute, range across post-O2/O3/Os.<br>Node: **0.996–1.072**<br>Chromium: **0.998–1.005**<br>Firefox: **0.919–1.025**<br>WebKit: **1.008–1.051**<br>Flag-aggregate ranges, not uncertainty intervals. | Host/cache-dependent effects, no common winner. Preserve translation metadata and fork-generated accesses; translation-aware pass placement remains useful research. |
| CC-05 PHP dispatch | Browser WordPress, timestamps **off**, GOTO/CALL.<br>Chromium: **2.727**<br>Firefox: **2.204**<br>WebKit: **3.764**<br>Node: compiler admission fails.<br>Portable-loop failures: **8/8**<br>Completed CALL/feature controls: **16/16** | GOTO is adverse in both browser orders and hits default-Node compiler OOM. Handler clustering and transport-aware dispatch remain hypotheses. |
| ARCH-01 two memories | Synthetic shuffled memory tags, relative to ordinary Wasm.<br>Private/shared tag mix: **50/50**<br>Read latency: **2.29–3.35x**<br>RMW latency: **2.82–5.28x**<br>No PHP latency estimate. | Lower than the PTE fixture, but no real SDK/fork/PHP integration or application result. |
| RT-01 allocation reuse | Completed pages with reuse: **512**<br>Sampled high-water with reuse: **140–144 MiB**<br>Pages before control failure: **373–376**<br>Control allocation near failure: **512 MiB**<br>Worker-replacement allocation growth: **31.375 MiB/generation** | Fixed-pool allocation benefit does not establish safe retirement, indefinite service, latency gains or lower RSS. |
| APP-01 capacity/preload | Preload alone, WordPress, timestamps **off**.<br>Node: **0.989**<br>Chromium: **1.003**<br>Firefox: **1.014**<br>WebKit: **1.020**<br>Extra sampled allocation: about **130 MiB** | No capacity pressure on this corpus; little consistent warm benefit. Selective/cold/larger-corpus preload remains. |
| APP-02 timestamp policy | Optional timestamps-off / on, MariaDB WordPress.<br>Chromium: **0.745**<br>Firefox: **0.721**<br>WebKit: **0.728**<br>Node, first cohort: **0.674**<br>Node, second cohort: **1.360** | Disabling checks helps immutable-code cases, with native/file regressions and Node order variation retained. Node is inconclusive. The primary recommendation and latest factorial retain validation. |
| APP-03 synchronous stat reuse | WordPress, timestamps **on**, candidate / matched translated shared-cache baseline.<br>Node: **1.0125**<br>Chromium: **1.0057**<br>Firefox: **0.9889**<br>WebKit: **0.9832**<br>Micro parents completed: **32**<br>SQLite/MariaDB freshness parents completed: **16**<br>Primary timing parents completed: **48**<br>Earlier Chromium outer-test timeouts: **1** | Small, mixed effect; no material application win established. Retain the patch and tests. Later TS rows report pathname/short-record screens; the supported guest direct-clock path remains unimplemented. |
| TS-03 scalar adapters | WordPress, timestamps **on**, independent candidates / translated shared-cache baseline.<br>DataView, Node: **1.4686**<br>DataView, Chromium: **1.0603**<br>DataView, Firefox: **0.9760**<br>DataView, WebKit: **0.9899**<br>Typed, Node: **0.9760**<br>Typed, Chromium: **1.1362**<br>Typed, Firefox: **1.7546**<br>Typed, WebKit: **1.0043**<br>Timing parents completed: **72** | No common preset; retain both candidates. Large adverse parents and ordinary-control drift make several rankings inconclusive. Micro stat-loop reductions did not establish an application win. |
| TS-04 short byte copies | SQLite WordPress translated candidate/baseline.<br>Node: **0.8878**<br>Chromium: **0.8966**<br>Firefox: **0.9233**<br>WebKit: **0.9193**<br>WordPress timing parents completed: **48**<br>PHP stat-loop candidate/baseline.<br>Node: **0.5642**<br>Chromium: **0.6010**<br>Firefox: **0.9151**<br>WebKit: **0.7017**<br>Isolated112-byte JS copy candidate/baseline.<br>Node: **0.0958**<br>Chromium: **0.1042**<br>Firefox: **0.1235**<br>WebKit: **0.1861**<br>Freshness parents completed: **16** | Both WordPress orders favor the selected64–255-byte path on every host/page; timestamps ON/frequency0. Ordinary bracket drift and all parents retained. Candidate for further acceptance, no default promotion. Firefox PHP stat reverses by cohort. Small/non-admitted copies can regress. Operation-screen ordinary control is JS Uint8Array; PHP controls are untranslated Wasm. Neither is machine-native PHP. |
| TS-02 page-wise strings | Isolated Wasm helper,112-byte page-wise word scan / matched ordinary word scan.<br>Node: **1.2897**<br>Chromium: **1.2408**<br>Firefox: **1.2475**<br>WebKit: **1.3512**<br>Matched timing parents completed: **8**<br>Standalone mechanism assertions per host: **1175**<br>SDK guest integration parents completed: **16**<br>Parent checks per integration case: **40**<br>Child checks per integration case: **4**<br>PHP source-edit freshness parents completed: **32** | Private SDK/PHP variants now pass source-edit freshness across both databases, modes and all hosts with validation ON/frequency0. The first PHP timing attempt was interrupted for a confirmed peer build before inspecting elapsed results. PHP loop results appear in the later integration row; WordPress timing remains pending. Separate byte/word controls preserve the algorithm distinction. Ordinary means untranslated Wasm in this engine. |
| TS-06 kernel metadata cache | SQLite WordPress translated candidate/baseline, Node: **0.9746**<br>SQLite WordPress translated candidate/baseline, Chromium: **1.0058**<br>SQLite WordPress translated candidate/baseline, Firefox: **0.9733**<br>SQLite WordPress translated candidate/baseline, WebKit: **1.0001**<br>WordPress timing parents completed: **48**<br>WordPress parents overlapping later peer job: **41**<br>Translated PHP stat-loop candidate/baseline, Node: **1.0010**<br>Translated PHP stat-loop candidate/baseline, Chromium: **0.9839**<br>Translated PHP stat-loop candidate/baseline, Firefox: **1.0241**<br>Translated PHP stat-loop candidate/baseline, WebKit: **1.0269**<br>Micro timing parents completed: **32**<br>Micro parents overlapping later peer job: **6**<br>Focused native tests passed: **6**<br>Rootfs inventory passed: **296**<br>Tmpfs inventory passed: **38**<br>PHP source-edit freshness parents completed: **16**<br>Maximum positive entries per backend: **32**<br>Maximum path-key payload per backend: **64 KiB** | First conservative prototype clears before every non-lstat backend operation; no TTL. Four focused cases overlap the backend inventories. Initial missing-fixture compile failure retained; frozen controls copied unchanged. Both databases/modes/all hosts pass freshness. No material loop win established. All six overlapping micro parents are WebKit; rows and ordinary-control variation retained. The first WordPress attempt was stopped for a peer before elapsed inspection. The complete matrix shows small mixed effects, Node/Firefox order reversals and ordinary drift; five Node and all browser parents overlap a later memory suite. No common preset selected. Guest fast-stat remains unimplemented. Cache records/container overhead is additional to the key-payload bound. |
| TS-02 PHP integration screen | Same-source page-wise byte / generic byte, translated stat loop.<br>Node: **0.9985**<br>Chromium: **1.0020**<br>Firefox: **0.9769**<br>WebKit: **0.9737**<br>Same-source page-wise word / generic word, translated stat loop.<br>Node: **1.0232**<br>Chromium: **0.9915**<br>Firefox: **0.9966**<br>WebKit: **1.0057**<br>Timing parents completed: **80**<br>Parents overlapping a new peer job: **21** | No common preset selected; toy scan gains do not scale directly to short PHP paths. Node word regression and ordinary-control drift retained. One Firefox and all WebKit parents overlap the newly started peer job; no rows dropped. Direct marshaller call sites survive optimization; static coverage is not a dynamic count. WordPress timing remains pending. |
| TS-07 cadence policy tradeoff | Configured nonzero revalidation interval: **2 s**<br>Shared first-new-response range, Node: **2260.2–2960.9 ms**<br>Shared first-new-response range, Chromium: **2758.8–2857.8 ms**<br>Shared first-new-response range, Firefox: **2510.1–2965.0 ms**<br>Shared first-new-response range, WebKit: **1997.6–2860.8 ms**<br>FILE-only first-new-response range, all hosts: **6.5–22.2 ms**<br>Policy source-edit parents completed: **32** | Validation remains ON, but this changes freshness. Shared cases serve old code before detection; FILE controls update in their first poll batch. Values include queueing, polling and background load; not exact invalidation instants or an isolated latency comparison. PHP's whole-second comparison is consistent with nearly three seconds at this setting. Primary frequency stays zero; application latency remains unmeasured. |
| TS-05 direct-clock prototype | Explicit SDK guest parents passed: **8**<br>Advanced explicit guest parents passed: **8**<br>Normal libc diagnostic parents passed: **16**<br>Libc-enabled advanced parents passed: **8**<br>Baseline clock RPCs per loop, each host/mode: **545**<br>Direct clock RPCs, Node ordinary: **3**<br>Direct clock RPCs, Node translated: **3**<br>Direct clock RPCs, Chromium ordinary: **3**<br>Direct clock RPCs, Chromium translated: **3**<br>Direct clock RPCs, Firefox ordinary: **5**<br>Direct clock RPCs, Firefox translated: **5**<br>Direct clock RPCs, WebKit ordinary: **5**<br>Direct clock RPCs, WebKit translated: **3**<br>Custom-provider fallback parents passed: **8**<br>Mapping-boundary parents passed: **8**<br>Node logical-clock parents passed: **2**<br>Clock loop timing parents passed: **32**<br>PHP freshness parents passed: **16**<br>WordPress timing parents passed: **48** | Real normal-SDK guest extension and opt-in libc hook, ordinary and translated Wasm on all hosts. The loop makes512 clock_gettime calls,32 gettimeofday calls and one invalid-ID check. Counts are dispatch evidence, not latency. Advanced probes cover signals/ppoll/fork/exec/protection and sibling fallback. Initial SDK admission, repeating-setitimer and translated-thread startup failures retained. Custom fallback passes on all hosts; Node logical mode passes (browser API unavailable). Copying shared mappings refuse fast clocks; translated anonymous maps already share physical bytes and retain fast clocks, tested for private/mapped output and detach recovery. Synthetic clock-loop timings appear below. Device boundaries/full acceptance remain open. The independent PHP screen is below; no default promotion. |

The PHP filesystem micro screens use CLI `php -n -r` and clear PHP's stat
cache per iteration. They measure filesystem calls and their transport, not
OPcache request-time validation. Enabled timestamps/frequency zero apply to
the separately verified application/freshness runs. The cache reader's
generic scope string also mentions that policy for micro rows; this is a
scope overstatement, not an observed micro configuration.

The [original individual and combined microbenchmark report](2026-11-10-common-memory-optimizations.md)
also preserves the requested all-together experiment. Validated spans plus
explicit SIMD approach their ordinary vector control for dense arrays, while
pointer/object walks retain overhead. Automatic vectorization emits identical
modules in one comparison; timing differences there cannot be credited to
that flag. Application combinations were selected through measured feasibility
and correctness gates; enabling every rejected or failing transform together
would not define a valid PHP configuration.

## What limits the practical design

**Worker churn is the clearest resource gap.** The fixed-pool result does not
extend to retiring processes. Six actual replacements per case preserve
shared-cache values and private request state, but logical allocation rises
from 102.5 to 290.75 MiB with mapped-payload reuse. Live roots stay at three;
retained roots grow from three to nine. These are allocator measurements,
not RSS. Safe reuse needs exact worker-generation quiescence, stale-handle
revocation, pending-snapshot/cancellation ownership, and private/root/scratch
retirement. Exit events, elapsed time and garbage collection are insufficient
proofs. See [the replacement records](../../.context/common-memory-survey-20261111/phase56/runs/common-memory-worker-replacement-1/).

**Method frequency does not identify CPU cost.** The timestamp-enabled adapter
census finds roughly 94% of observed span attempts in typed reads and 3.5% in
DataView methods. It does not classify those typed reads by width/caller, and
it includes kernel-realm background activity. First attribute that traffic
before implementing page-wise C-string scans, short-copy paths or metadata
structure coalescing. Keep actual timestamp and filesystem semantics when
optimizing metadata paths.

**Historical controls need their actual cache provenance.** Older WordPress
images contain 1,500 prebuilt OPcache FILE files totaling 45,251,192 bytes.
Those ordinary controls remain preseeded-image results; fresh parents do not
make them empty-cache controls. Shared cases disable FILE cache, so their
within-shared comparisons remain separate. Later clean-image CALL studies
prove cache generation/reuse; full prebuilt-corpus cross-dispatch compatibility
and clean-image GOTO timing remain unestablished. PGO WordPress evaluation
reuses the training source corpus; only its separate FPM fixture is held out.

## Where to invest next

1. Replicate the timestamp-enabled byte-copy/fusion leads on Node and Chromium
   with better controlled load and more independent parents. Keep Firefox
   factors separate until the reversal is understood; retain the outlined
   WebKit control. No global preset follows from the current aggregates.
2. Establish safe process-generation retirement before treating the prototype
   as a long-running service. Use poisoned stale handles, aliases, cancelled
   snapshots and exact worker-generation fences as adversarial cases.
3. Continue the active timestamp campaign through page-wise strings, short
   records, supported direct clocks and mutation-coherent metadata caches.
   APP-03 stat reuse and TS-03 scalar adapters have separate implementation
   screens. Neither establishes a common application preset; the latter has
   large adverse parents and control drift. Preserve their implementations.
4. Revisit affine and loop/span hoisting only after measuring applicability
   and proving mapping/alias/fork lifetimes. The failed per-access cache does
   not settle a once-per-loop design. Retain hot/page-shared constant wrappers,
   richer provenance and per-unit size optimization for the same reason.
5. Treat two-memory ABI integration and new interpreter dispatch as larger
   architectural experiments, gated by the current mechanism and failure
   evidence. They are not near-term configuration switches.

The systematic survey supports these priorities, rather than a claim that
every future variation has been implemented. The prototype remains private
and opt-in. Its existing interactive preview is unchanged; evidence uses the
partial shell and experimental WordPress images. Canonical products, whole
platform benchmarks, full POSIX/ABI acceptance and the browser-memory gate
remain requirements for production integration, outside this bounded survey.

## Evidence and reproducibility

The experiment catalog records commands, module/source/image/profile hashes,
engine versions, settings, cold and warm results, resource counters and failed
attempts. Sources and raw results are retained under
[the survey archive](../../.context/common-memory-survey-20261111/), alongside
the original prototype/application reports linked from the catalog.

A final retained-record audit reproduces the exact historical reports for
1,152 FPM parents and independently reconstructs application ratios and
admission checks for 592 WordPress parents, including both ordinary host
profiles in the latest timestamp-enabled factorial. It checks 308 distinct
retained input preimages and separates real PGO training from timed controls.
A supplementary audit recomputes diagnostic coverage and verifies the raw
fixed-pool cases, 48 real replacements, portable-dispatch failures and the
unresolved constant-only HTTP504. These are reanalyses, not new independent
timing cohorts. Archive integrity proves retention, not experimental quality.
The final audit and requirement mapping are retained in
[phase 60](../../.context/common-memory-survey-20261111/phase60/).

The subsequent quantitative table amendment is backed by
[extracted values and source hashes](../../.context/common-memory-survey-20261111/phase61/numbers.json).
It adds no timing runs. It preserves cohort reversals and keeps measured
latency, dispatch coverage, code size and allocator usage as separate units;
coverage percentages are not estimates of available CPU savings.

### TS-05 uninstrumented clock-loop timing

This synthetic normal-libc loop uses fresh parents in opposing orders, two warmup rounds and five measured rounds of20000 calls per kind.32 parents pass;350 frozen inputs are unchanged. The same diagnostics-off profile serves baseline and direct-hook programs; only programs declaring the optional clock import allocate certificates and pay its late eligibility query. Diagnostic trace calls and profile getters are absent from the timing bundles. This measures the opt-in prototype against its same-profile baseline, not merged performance against origin/main. No shared mappings or PHP/OPcache requests are in this loop. Ordinary means untranslated Wasm in the same engine. Values are geometric means of the two parent medians, include common loop/check work, and have no confidence interval.

| Host / call | Ordinary Wasm | Translated Wasm | Translated / ordinary |
|---|---|---|---|
| Node / `clock_gettime` | Baseline µs/call: **23.666**<br>Direct µs/call: **0.371**<br>Direct / baseline: **0.01567** | Baseline µs/call: **72.298**<br>Direct µs/call: **0.502**<br>Direct / baseline: **0.00694** | Baseline ratio: **3.055×**<br>Direct ratio: **1.353×** |
| Node / `gettimeofday` | Baseline µs/call: **23.728**<br>Direct µs/call: **0.373**<br>Direct / baseline: **0.01574** | Baseline µs/call: **72.396**<br>Direct µs/call: **0.518**<br>Direct / baseline: **0.00715** | Baseline ratio: **3.051×**<br>Direct ratio: **1.387×** |
| Chromium / `clock_gettime` | Baseline µs/call: **24.551**<br>Direct µs/call: **0.483**<br>Direct / baseline: **0.01968** | Baseline µs/call: **56.891**<br>Direct µs/call: **0.569**<br>Direct / baseline: **0.00999** | Baseline ratio: **2.317×**<br>Direct ratio: **1.177×** |
| Chromium / `gettimeofday` | Baseline µs/call: **24.271**<br>Direct µs/call: **0.499**<br>Direct / baseline: **0.02058** | Baseline µs/call: **57.309**<br>Direct µs/call: **0.588**<br>Direct / baseline: **0.01026** | Baseline ratio: **2.361×**<br>Direct ratio: **1.178×** |
| Firefox / `clock_gettime` | Baseline µs/call: **29.839**<br>Direct µs/call: **0.597**<br>Direct / baseline: **0.02001** | Baseline µs/call: **71.186**<br>Direct µs/call: **0.710**<br>Direct / baseline: **0.00998** | Baseline ratio: **2.386×**<br>Direct ratio: **1.190×** |
| Firefox / `gettimeofday` | Baseline µs/call: **29.928**<br>Direct µs/call: **0.605**<br>Direct / baseline: **0.02021** | Baseline µs/call: **70.821**<br>Direct µs/call: **0.728**<br>Direct / baseline: **0.01029** | Baseline ratio: **2.366×**<br>Direct ratio: **1.204×** |
| WebKit / `clock_gettime` | Baseline µs/call: **31.434**<br>Direct µs/call: **0.483**<br>Direct / baseline: **0.01538** | Baseline µs/call: **65.969**<br>Direct µs/call: **0.585**<br>Direct / baseline: **0.00888** | Baseline ratio: **2.099×**<br>Direct ratio: **1.211×** |
| WebKit / `gettimeofday` | Baseline µs/call: **31.769**<br>Direct µs/call: **0.566**<br>Direct / baseline: **0.01782** | Baseline µs/call: **65.008**<br>Direct µs/call: **0.596**<br>Direct / baseline: **0.00917** | Baseline ratio: **2.046×**<br>Direct ratio: **1.053×** |

Both orders favor the direct hook for both calls on every host. Browser observed `performance.now` positive steps are about5µs on Chromium and20µs on Firefox/WebKit; elapsed loop durations are much larger. Job registries show no other managed build/test overlap during this run; this is not proof of a fully idle host. Recorded one-minute host load ranges from1.86 to6.01. The active preview remains running. Absolute loop gains do not predict application gains: real PHP pointer reuse, intervening syscalls, threads and copying shared mappings can force fallback. The separate PHP freshness/application screen follows below.

### TS-05 PHP-FPM: large clock-loop gain, small WordPress gain

Private SDK/glue relinking retains the completed CALL/O2/no-LTO PHP objects and dependency closure; baseline CLI and FPM reproduce their prior artifact hashes exactly. The candidate adds only the optional clock hook. Normal SDK, preoptimization, fork preparation and ABI stamping run before whole-program translation.16 source-edit parents pass across SQLite/MariaDB and all four hosts, with both workers observing changed source before explicit invalidation. Timestamp validation stays enabled and revalidation frequency stays zero.

The independent SQLite WordPress screen passes48 parents with187 unchanged frozen inputs, two warmups/five measured rounds, two opposing orders and ordinary controls before/after the translated cases. Each parent covers home/article/admin/posts. Values below are four-page geometric means across both orders. Ordinary uses FILE-only OPcache; translated uses directly shared anonymous OPcache. The VM/ordinary ratios include that configuration difference. They are not pure address-translation costs or native-machine PHP comparisons. This is a same-profile prototype comparison, not full origin/main acceptance.

| Host | Application time ratios | Translated direct / baseline by order |
|---|---|---|
| Node | Translated direct / baseline: **0.9915**<br>Ordinary direct / baseline: **1.0056**<br>Direct translated / own ordinary: **1.8919×**<br>Ratio after ordinary normalization: **0.9860** | First order: **0.9894**<br>Reverse order: **0.9936** |
| Chromium | Translated direct / baseline: **0.9750**<br>Ordinary direct / baseline: **0.9996**<br>Direct translated / own ordinary: **1.4572×**<br>Ratio after ordinary normalization: **0.9754** | First order: **0.9701**<br>Reverse order: **0.9799** |
| Firefox | Translated direct / baseline: **0.9872**<br>Ordinary direct / baseline: **1.0132**<br>Direct translated / own ordinary: **1.4737×**<br>Ratio after ordinary normalization: **0.9743** | First order: **0.9834**<br>Reverse order: **0.9910** |
| WebKit | Translated direct / baseline: **0.9856**<br>Ordinary direct / baseline: **1.0149**<br>Direct translated / own ordinary: **1.2117×**<br>Ratio after ordinary normalization: **0.9711** | First order: **0.9940**<br>Reverse order: **0.9773** |

All host/order four-page translated means favor the hook, but the effect is small. WebKit first-order article regresses to1.0165×; retain it. Ordinary after/before page ratios range0.9265..1.0563 and recorded one-minute load1.62..5.04. No other managed test/build is visible in the pre/post registries; this does not prove a fully idle host. No confidence interval, CPU attribution or actual PHP fast-hit count was collected. Large synthetic clock speedups do not establish a dominant application bottleneck. Keep the hook as a secondary candidate for later combinations; do not promote a general preset from this screen. Full benchmark/memory/conformance/canonical-product acceptance and device-output boundaries remain unrun.

Retained evidence: `.context/timestamp-optimization-20261113/ts05-php-freshness-application`. The campaign remains open: byte/word pathname application pairs, finer cache invalidation, the distinct guest fast-stat route, enabled-timestamp cadence application latency and combinations are still pending.

### TS-02 pathname scanners: independent application pairs

Both byte and word comparisons now pass48 SQLite WordPress parents each, all208 frozen inputs unchanged in each comparison. The baseline is generic translation of the **same** byte/word function, and the candidate substitutes its proved page scanner. Their ordinary artifacts are byte-identical, so ordinary ratios below measure repeated-control variation, not an optimization of ordinary code. Each experiment has separate fresh parents, opposing orders, ordinary before/after brackets, four pages, two warmup/five measured rounds and timestamps1/frequency0. Neither includes the new clock/cache/short-copy factors. Earlier both-database edited-source checks remain retained.

| Scanner / host | Application ratios | Translated page / generic by order |
|---|---|---|
| byte / Node | Translated page / generic: **0.9890**<br>Identical-code ordinary repeat ratio: **1.0082**<br>Page translated / own ordinary: **1.9013×**<br>Normalized by ordinary repeat ratio: **0.9810** | First order: **0.9950**<br>Reverse order: **0.9830** |
| byte / Chromium | Translated page / generic: **1.0016**<br>Identical-code ordinary repeat ratio: **0.9987**<br>Page translated / own ordinary: **1.5160×**<br>Normalized by ordinary repeat ratio: **1.0029** | First order: **1.0109**<br>Reverse order: **0.9924** |
| byte / Firefox | Translated page / generic: **0.9938**<br>Identical-code ordinary repeat ratio: **1.0003**<br>Page translated / own ordinary: **1.5205×**<br>Normalized by ordinary repeat ratio: **0.9935** | First order: **0.9913**<br>Reverse order: **0.9964** |
| byte / WebKit | Translated page / generic: **0.9821**<br>Identical-code ordinary repeat ratio: **1.0051**<br>Page translated / own ordinary: **1.2433×**<br>Normalized by ordinary repeat ratio: **0.9771** | First order: **0.9737**<br>Reverse order: **0.9905** |
| word / Node | Translated page / generic: **1.0006**<br>Identical-code ordinary repeat ratio: **0.9984**<br>Page translated / own ordinary: **1.9128×**<br>Normalized by ordinary repeat ratio: **1.0022** | First order: **1.0011**<br>Reverse order: **1.0000** |
| word / Chromium | Translated page / generic: **0.9989**<br>Identical-code ordinary repeat ratio: **1.0002**<br>Page translated / own ordinary: **1.5124×**<br>Normalized by ordinary repeat ratio: **0.9987** | First order: **0.9991**<br>Reverse order: **0.9986** |
| word / Firefox | Translated page / generic: **1.0145**<br>Identical-code ordinary repeat ratio: **0.9895**<br>Page translated / own ordinary: **1.5602×**<br>Normalized by ordinary repeat ratio: **1.0252** | First order: **1.0232**<br>Reverse order: **1.0059** |
| word / WebKit | Translated page / generic: **0.9759**<br>Identical-code ordinary repeat ratio: **1.0011**<br>Page translated / own ordinary: **1.2438×**<br>Normalized by ordinary repeat ratio: **0.9748** | First order: **1.0096**<br>Reverse order: **0.9433** |

These do not select a common preset. Byte scanning is small/mixed; word scanning regresses in Firefox, while WebKit favors it only in aggregate and reverses by order. Chromium byte scanning also reverses by order. Preserve both mechanisms and the negative/order cases for future workloads. VM/ordinary includes shared-vs-FILE OPcache configuration and is not pure translation overhead. Normalization by noisy ordinary repeats is diagnostic, not a confidence interval or causal adjustment. This is a bounded prototype screen, not origin/main/full-platform acceptance.

Byte screen ordinary after/before range: 0.9316..1.0618. Recorded one-minute load range: 1.34..3.66.

Word screen ordinary after/before range: 0.9685..1.0352. Recorded one-minute load range: 1.70..3.83.

Retained evidence: `.context/timestamp-optimization-20261113/ts02-application-pairs`. Pre/post managed-job registries accompany each raw run; no other managed build/test is visible during these timing parents.

### TS-07 latency with an explicitly different revalidation cadence

This compares `validate_timestamps=1` with `revalidate_freq=0` versus `2`; it is a policy tradeoff, **not a same-freshness optimization**. The separate earlier32-parent policy gate measured shared first-new responses1.998..2.965seconds after edit (including queueing/poll sampling), while FILE-only controls saw new source in their first6.5..22.2ms poll. Primary measurements and the interactive preview retain frequency zero.

The separate SQLite WordPress latency matrix passes48 parents/all268 frozen inputs unchanged: four pages, two warmup/five measured rounds, opposing orders and ordinary brackets. The reader checks each actual ini frequency, including the candidate value. Ratios are four-page geometric means across both orders. No new clock/cache/scanner/short-copy factor is combined.

| Host | Frequency-two / frequency-zero application ratios | Translated policy ratio by order |
|---|---|---|
| Node | Translated policy ratio: **0.7369**<br>Ordinary policy ratio: **0.9991**<br>Frequency-two translated / own ordinary: **1.4342×**<br>Policy ratio after ordinary normalization: **0.7376** | First order: **0.7255**<br>Reverse order: **0.7485** |
| Chromium | Translated policy ratio: **0.7962**<br>Ordinary policy ratio: **1.0028**<br>Frequency-two translated / own ordinary: **1.2039×**<br>Policy ratio after ordinary normalization: **0.7939** | First order: **0.8216**<br>Reverse order: **0.7715** |
| Firefox | Translated policy ratio: **0.8188**<br>Ordinary policy ratio: **0.9900**<br>Frequency-two translated / own ordinary: **1.2616×**<br>Policy ratio after ordinary normalization: **0.8271** | First order: **0.8121**<br>Reverse order: **0.8255** |
| WebKit | Translated policy ratio: **0.7680**<br>Ordinary policy ratio: **0.9934**<br>Frequency-two translated / own ordinary: **0.9916×**<br>Policy ratio after ordinary normalization: **0.7730** | First order: **0.7968**<br>Reverse order: **0.7402** |

Translated time falls roughly18..26% in this request pattern. This supports investigating validation work; it does not isolate stat CPU or guarantee the same benefit from a fresh-on-every-request implementation. The WebKit near-parity VM/ordinary result includes shared-vs-FILE cache configuration and different observed freshness behavior, so it is not pure translation parity. Ordinary after/before drift: 0.9271..1.0637. Recorded one-minute load: 2.20..5.31. All per-page/order samples remain; no confidence interval or full acceptance claim. Pre/post registries show no other managed build/test during the timing run.

Retained evidence: `.context/timestamp-optimization-20261113/ts07-application-timing`; the earlier edited-source/detection evidence remains `ts07-policy-pre-timing`. No configuration is promoted.

### TS-06 narrower cache invalidation: completed independent screen

This variant preserves the positive rootfs/tmpfs metadata cache across read-only `fstat` and `readlink`, in addition to `lstat`. Other backend entries still clear it. It adds no TTL, host-mount caching or guest fast-stat route. Full focused native backend inventories pass (rootfs297, tmpfs39), including retention and mutation checks. The normal kernel recipe builds successfully after provisioning original hash-verified ABI fixtures; the first missing-fixture failure is retained.

Freshness16, CLI micro48 and SQLite WordPress72 parents pass, with all215 frozen inputs unchanged. The micro loops are filesystem stat/lstat/missing controls, not OPcache validation or a dedicated fstat/readlink interleaving timing. Application timing compares no cache, conservative cache and finer invalidation in opposing orders with ordinary brackets, four pages, two warmup/five measured rounds. Validation1/frequency0 throughout. Four-page geometric means across both orders (smaller ratios favor candidate):

| Host | Translated application ratios | Controls and opposing orders |
|---|---|---|
| Node | Conservative / no cache: **0.9979**<br>Finer / no cache: **0.9995**<br>Finer / conservative: **1.0016** | Finer ordinary / baseline: **0.9914**<br>Finer translated / own ordinary: **1.9037×**<br>Finer first order / no cache: **1.0130**<br>Finer reverse order / no cache: **0.9862** |
| Chromium | Conservative / no cache: **1.0025**<br>Finer / no cache: **0.9991**<br>Finer / conservative: **0.9966** | Finer ordinary / baseline: **0.9984**<br>Finer translated / own ordinary: **1.5235×**<br>Finer first order / no cache: **0.9982**<br>Finer reverse order / no cache: **1.0000** |
| Firefox | Conservative / no cache: **0.9998**<br>Finer / no cache: **0.9949**<br>Finer / conservative: **0.9951** | Finer ordinary / baseline: **1.0028**<br>Finer translated / own ordinary: **1.4947×**<br>Finer first order / no cache: **1.0006**<br>Finer reverse order / no cache: **0.9892** |
| WebKit | Conservative / no cache: **1.0242**<br>Finer / no cache: **1.0085**<br>Finer / conservative: **0.9847** | Finer ordinary / baseline: **1.0047**<br>Finer translated / own ordinary: **1.2596×**<br>Finer first order / no cache: **0.9896**<br>Finer reverse order / no cache: **1.0278** |

No clear common application benefit: the finer variant is roughly unchanged in Node/Chromium, a small Firefox improvement and a WebKit regression against no cache. Preservation improves over the conservative cache in three hosts, but does not establish a general win over no cache. All page/order reversals and regressions are retained. Ordinary after/before page ratios: 0.9644..1.0277; recorded one-minute load: 2.21..4.41. No confidence interval, isolated CPU attribution or common preset promotion. Ordinary means untranslated Wasm in the same engine; VM/ordinary includes shared-anonymous versus FILE-only OPcache configuration.

Retained stage: `.context/timestamp-optimization-20261113/ts06-finer-runtime-screen`; source/build failures remain in `ts06-finer-pre-application`. The distinct guest fast-stat proposal is still unimplemented and is not credited as tested by these results.

## TS05-R1 implemented independently; PHP screen pending

The VM-only clock renewal hypothesis above is now implemented as an opt-in private runtime build flag. It retains the known pointer/clock/format after successful Stat11/Lstat12/Fstat6/Fstatat93, performs the existing late task/signal/mapping eligibility query, and publishes at the fresh current epoch. Each fast reader samples current time and checks fresh PTE write rights. No time or stat payload is cached. Ordinary memory retains original policy because its writer lacks the same fresh PTE proof.

Actual libc mechanism16 parents pass across Node/Chromium/Firefox/WebKit, both modes and old/new runtime. Metadata/clock alternation fast calls out of256 are251/256/252/255 in the renewed VM variant, versus0 in baseline and renewed ordinary. RO and unmapped output after metadata falls back; missing-file error does not renew. Advanced lifecycle/signal8, mapping8 and Node logical2 regression parents also pass. These are counts/semantics, not PHP timing. Initial unrestricted profiles were built but never executed; a reserved-identifier build failure is retained and fixed with an explicit nonreserved import. PHP freshness16 and latency48 are the next tests. Distinct guest fast-stat remains unimplemented.

### TS05-R1 VM clock renewal after metadata: completed independent screen

The earlier implemented-mechanism/pending-PHP status is superseded here. Successful metadata calls can renew a known clock pointer/ID/format using the existing late authoritative task/signal eligibility query. The worker samples current time and checks fresh PTE output rights. No time or stat payload is cached. Ordinary keeps the original policy because it lacks the same fresh PTE permission proof. The build flag is opt-in; no default changes.

Both variants use the **same earlier direct-clock-hook PHP artifacts and kernel**. This is renewal versus the original direct-clock runtime, not versus pre-clock or origin/main. No short-copy/scanner/scalar/cache factor is added. Candidate freshness16 passes across SQLite/MariaDB, both modes and all four hosts; WordPress timing48 passes all525 frozen inputs unchanged (SQLite, four pages, two warmup/five measured rounds, opposing orders and ordinary brackets). Validation1/frequency0 throughout. Mechanism16 and advanced/mapping/logical regression18 parents remain separate counts/semantics evidence. Initial unrestricted profiles were never executed; reserved-identifier build failure retained.

| Host | Application ratios across both orders | Translated ratio by order |
|---|---|---|
| Node | Renewal / original direct clock: **0.9530**<br>Ordinary control ratio: **1.0013**<br>Renewed translated / own ordinary: **1.7693×**<br>Renewal ratio after ordinary normalization: **0.9517** | First order: **0.9556**<br>Reverse order: **0.9503** |
| Chromium | Renewal / original direct clock: **0.9521**<br>Ordinary control ratio: **1.0011**<br>Renewed translated / own ordinary: **1.4152×**<br>Renewal ratio after ordinary normalization: **0.9511** | First order: **0.9536**<br>Reverse order: **0.9507** |
| Firefox | Renewal / original direct clock: **0.9542**<br>Ordinary control ratio: **0.9945**<br>Renewed translated / own ordinary: **1.4291×**<br>Renewal ratio after ordinary normalization: **0.9594** | First order: **0.9428**<br>Reverse order: **0.9657** |
| WebKit | Renewal / original direct clock: **0.9403**<br>Ordinary control ratio: **1.0038**<br>Renewed translated / own ordinary: **1.1266×**<br>Renewal ratio after ordinary normalization: **0.9368** | First order: **0.9567**<br>Reverse order: **0.9242** |

Translated aggregate time falls4.6..6.0% relative to the original direct-clock prototype. All host/order geometric means favor renewal: True. Individual translated page/order regressions retained: []. Ordinary after/before page ratios: 0.9345..1.0556; recorded one-minute load: 2.69..4.65. Ordinary means untranslated Wasm in the same engine, not machine-native PHP. VM/ordinary includes shared-anonymous versus FILE-only OPcache configuration. No confidence interval, CPU attribution, real PHP fast-hit census, origin/main acceptance, or multiplicative gain inferred from separate runs. This is a promising combination candidate, not a default promotion. The stat kernel build started only after timing reached terminal success.

Retained stage: `.context/timestamp-optimization-20261113/ts05-metadata-clock-renewal`; raw plans, source preimages, failures, semantics and timings all retained.

### TS-06 distinct guest fast-stat: actual bounded prototype, PHP screen pending

This supersedes the earlier unimplemented-design status. A separate `kandelo.stat.v1` import and libc opt-in reuse the normal opaque channel record and descriptor-driven unmarshal. The host does not decode stat fields or resolve paths. The late kernel export recomputes a fresh normal stat snapshot, proves actual rootfs/tmpfs dispatch for every component, and checks complete encoded fields. Initial scope is short absolute paths, regular files/directories, no symlinks/dot components, supported stat/lstat/AT_FDCWD fstatat flags, one running main task and exact process/image binding. Every ordinary kernel entry/ingress invalidates the single-entry epoch. No TTL or cached-time policy is introduced.

The worker matches every request descriptor/scalar/path byte (excluding only the kernel-proved OUT payload), checks fresh VM PTE read/write rights and physical bounds, rechecks epoch/busy/retired state, then writes only the opaque output span. Ordinary memory, copying mappings, threads, borrowed/64-bit modes, unsupported providers/shapes and unavailable capability fall back. Not every fallback boundary has an actual new guest regression test yet. Current provider branding remains conservative. No default promotion or full acceptance claim.

Focused native owned-snapshot semantics/codec1 and native extension-admission2 tests pass; generated extension check, normal optional-export snapshot/kernel recipe and host type-check pass. The actual normal-SDK/fork/stamp/translation guest passes16 parents across all four hosts, both models and factor off/on. It tests source writes, rename/removal/native permissions/record malformation, request mismatch, errno, signals, fork and another process's file mapping across the relevant native/guest checks. In each host the translated candidate has256 fast/0 slow explicit queries and7 ordinary stat channel calls, versus0 fast/256 slow and328 stat calls in baseline and ordinary cases. The reduction includes the actual opt-in libc loop. These are mechanism counts, not latency or PHP results.

The first16-parent mechanism screen missed a boundary: another process could hold a kernel-owned file mapping while the caller held none. A new negative guest exits35 on the old kernel because the fast path was admitted. This demonstrates an admission hole, not a measured stale-mtime response. The repaired issuer refuses while the machine has **any kernel-owned file backing**; the new16-parent matrix passes that case. Anonymous shared OPcache bytes carry no file metadata and remain admissible. Initial code/results and the negative control are retained.

Build/provenance failures are preserved: missing private sysroots, then an incorrect single-sysroot override for both architectures; correct separate read-only sysroots allow the normal recipe to pass. A source-backup command raced a later C probe edit during shell startup. The raced copy is retained; reconstructed v1 reproduces the original linked binary exactly when compiled at its original source filename. The first different-filename check failed solely in `kandelo.calltypes` metadata, confirmed by section hashes. The guarded kernel recipe itself succeeded before that separate assertion failed; the overall job remains recorded failed. The exact reproduction is a separate successful receipt, not a rewritten job result.

PHP CLI/FPM now relink through normal private SDK/glue, preoptimization, fork preparation, ABI stamping and VM translation using existing completed CALL/O2/no-LTO objects. Baseline binaries reproduce the prior hashes exactly. This is incremental private relinking, not a canonical full image build. Freshness16, CLI filesystem micro32 and SQLite WordPress48 are planned under validation1/frequency0 with matched controls/opposing orders. No PHP speedup is known yet. Retained mechanism/build stage: `.context/timestamp-optimization-20261113/ts06-guest-stat-mechanism-build`.

TS06 initial CLI screen completes32 parents/all358 inputs: VM stat C/B Node/Chrome/FF/WK .05316/.05407/.07312/.06925; VM lstat1.0719/1.0354/1.0439/1.0377, missing1.0005/1.0317/.9976/.9324. Ordinary stat1.4908/1.4325/1.5107/1.3512 reflects a prototype defect: issuer computes unused snapshots even though native reader always refuses. Keep this result, do not advertise VM/own ordinary parity from it. Application attempt1 deliberately stopped143 before elapsed outcomes inspected, based only on completed micro results. New independent builder/profile gates stat issuance on VirtualMemory and will be revalidated/retested; original builder/source/358-input plan remain untouched. No application speedup known yet.

### TS06 initial guest-stat CLI timing, including the ordinary issuance defect

These32 parents pass all358 frozen inputs. This is `php -n` filesystem stat/lstat/missing looping, **not OPcache request validation, pure stat CPU or WordPress latency**. Two warmup/five measured rounds, opposing orders, all four engines and both models. Ratios are candidate/baseline geometric means across orders, smaller favors candidate. The ordinary reader always refuses; the initial issuer still did duplicate snapshot work there. Retain that overhead as a negative result. Do not infer VM/ordinary parity from the slower ordinary prototype.

| Host | Translated CLI ratios | Ordinary CLI ratios (initial unused issuance) |
|---|---|---|
| Node | Stat loop: **0.0532**<br>Lstat loop: **1.0719**<br>Missing loop: **1.0005** | Stat loop: **1.4908**<br>Lstat loop: **1.0723**<br>Missing loop: **1.0795** |
| Chromium | Stat loop: **0.0541**<br>Lstat loop: **1.0354**<br>Missing loop: **1.0317** | Stat loop: **1.4325**<br>Lstat loop: **1.0674**<br>Missing loop: **1.0129** |
| Firefox | Stat loop: **0.0731**<br>Lstat loop: **1.0439**<br>Missing loop: **0.9976** | Stat loop: **1.5107**<br>Lstat loop: **1.0765**<br>Missing loop: **1.0207** |
| WebKit | Stat loop: **0.0693**<br>Lstat loop: **1.0377**<br>Missing loop: **0.9324** | Stat loop: **1.3512**<br>Lstat loop: **1.0551**<br>Missing loop: **0.9978** |

The eligible repeated-stat loop is roughly14..19times faster, while lstat and misses are mixed/slower. Ordinary stat regresses35..51% from unnecessary producer work. Both successes and negatives remain. The old WordPress attempt was stopped143 before elapsed outcomes were inspected, based on this completed micro result. A separate builder/profile2 now requires VirtualMemory at issuance as well as reading, with exactly the same PHP artifacts and kernel; revised mechanism, freshness and latency checks are separate. No application estimate is admitted from the interrupted run. Retained stage `.context/timestamp-optimization-20261113/ts06-guest-stat-initial-runtime`.

### TS06 guest stat with VM-only issuance: complete independent screen

The revised issuer allocates/certifies only VirtualMemory processes, matching the reader's capability. It passes mechanism16 and PHP freshness16 (both databases/models/all hosts); CLI filesystem micro32 and SQLite WordPress48 pass all372 frozen inputs unchanged. The same PHP binaries/kernel as the first prototype are used. The original 35..51% ordinary stat-loop penalty is retained separately; the VM-only guard removes that unused-snapshot producer work. No direct-clock hook, renewal, scalar/copy/scanner/cache factor is combined here. Primary timestamp validation1/frequency0 throughout.

Revised CLI ratios remain useful for repeated regular-file stat, while lstat is slower. These are PHP `-n` filesystem loops, not OPcache validation or pure stat CPU:

| Host | Translated CLI ratios | Ordinary CLI ratios |
|---|---|---|
| Node | Stat loop: **0.0531**<br>Lstat loop: **1.0380**<br>Missing loop: **0.9976** | Stat loop: **1.0121**<br>Lstat loop: **0.9939**<br>Missing loop: **1.0044** |
| Chromium | Stat loop: **0.0531**<br>Lstat loop: **1.0421**<br>Missing loop: **1.0034** | Stat loop: **1.0021**<br>Lstat loop: **1.0071**<br>Missing loop: **0.9861** |
| Firefox | Stat loop: **0.0743**<br>Lstat loop: **1.0699**<br>Missing loop: **0.9959** | Stat loop: **1.0005**<br>Lstat loop: **1.0062**<br>Missing loop: **0.9726** |
| WebKit | Stat loop: **0.0707**<br>Lstat loop: **1.0835**<br>Missing loop: **0.9685** | Stat loop: **0.9897**<br>Lstat loop: **0.9869**<br>Missing loop: **0.9824** |

The separate real WordPress result regresses in all hosts. Four pages, two warmup/five measured rounds, opposing orders and ordinary brackets; geometric means across pages/orders:

| Host | Application ratios | Translated ratio by order |
|---|---|---|
| Node | Guest stat / baseline: **1.0355**<br>Ordinary control ratio: **0.9955**<br>Candidate translated / own ordinary: **1.9587×**<br>Ratio after ordinary normalization: **1.0401** | First order: **1.0378**<br>Reverse order: **1.0331** |
| Chromium | Guest stat / baseline: **1.0354**<br>Ordinary control ratio: **1.0091**<br>Candidate translated / own ordinary: **1.5419×**<br>Ratio after ordinary normalization: **1.0261** | First order: **1.0398**<br>Reverse order: **1.0310** |
| Firefox | Guest stat / baseline: **1.0419**<br>Ordinary control ratio: **1.0060**<br>Candidate translated / own ordinary: **1.5677×**<br>Ratio after ordinary normalization: **1.0357** | First order: **1.0427**<br>Reverse order: **1.0412** |
| WebKit | Guest stat / baseline: **1.0118**<br>Ordinary control ratio: **1.0078**<br>Candidate translated / own ordinary: **1.2693×**<br>Ratio after ordinary normalization: **1.0039** | First order: **1.0145**<br>Reverse order: **1.0091** |

This strict single-entry design is not a WordPress recommendation: translated aggregate time increases1.2..4.2%. The normal-path fresh snapshot and miss cost are a plausible explanation from the implementation, not a measured CPU attribution; no real PHP fast-hit census was collected. Retain it for repeated-stat workloads and future designs rather than discard the concept. The broader combination will explicitly test its interaction with clock renewal/cache/reuse; no interaction gain is assumed. Ordinary after/before page drift: 0.9416..1.0723; recorded one-minute load: 1.55..7.91. Raw per-page/order samples and controls retained, no CI/full-platform acceptance/default promotion. Ordinary means untranslated Wasm in the same engine, not machine-native PHP. VM/ordinary includes anonymous-shared versus FILE-only OPcache configuration.

The first interrupted application matrix has no admitted estimate. Its partial bytes/failed job remain in the earlier archive. Revised retained stage: `.context/timestamp-optimization-20261113/ts06-guest-stat-vm-issuer-runtime`. All seven timestamp families now have individual bounded screens; the planned strong and broader combinations remain unbuilt/untested at this documentation milestone.

### Timestamp combinations: mechanisms and freshness before timing

All seven timestamp families now have individual bounded screens. The combined experiment uses matched baseline, **strong** (short64 copies plus direct clock and VM renewal after metadata), and **broad-compatible** (strong plus TS01 stat reuse, page-byte pathname scanning, DataView scalar adaptation, finer backend cache and bounded guest stat). All primary cases retain timestamp validation1/frequency0. Frequency2 remains a separately labeled different-freshness policy result.

The literal bundle with both DataView and typed scalar adapters is **invalid under the differential mechanism checks**, and has no admitted latency estimate. Scalar203 passes, but the copy check catches an observable custom Array.at hook skipped by the typed scalar shortcut during copy fallback. That failure and all sources remain. The compatible bundle chooses DataView-only; it is not silently represented as every possible variant combined. Typed adaptation remains a follow-up requiring guarded composition before performance testing.

A separate actual mixed clock/stat guest caught certificate ping-pong: after late stat publication, another clock eligibility entry invalidated its epoch, leaving zero stat hits (guest exits17). The final private host reuses the successful same-channel late Rust snapshot's authoritative running-main-task/no-sibling/no-signal check at its current epoch for clock publication; existing clock provider/key/mapping/channel checks remain. No new epoch is attached to old stat payload. This is a generic capability interaction fix, not a PHP shortcut or ABI change.

The final compatible source passes native338 (rootfs297, tmpfs39, focused reuse/snapshot2), normal kernel/optional ABI checks, normal private SDK PHP relink/preopt/fork/stamp/exact CString proof and translation, and host type-check. Combined component12 parents pass203 scalar,44 copy and1175 pathname assertions per host. Actual normal C guests48 pass on Node/Chromium/Firefox/WebKit, both models and both candidate profiles, including clock/stat/mixed operations, sibling-thread fallback and mapped-file refusal. The broad mixed VM guest has64 clock plus64 stat hits in each host after coalescing; ordinary has zero. These are mechanism counts, not latency.

PHP edited-source freshness32 parents passes both candidates, databases and models on all hosts, all374 frozen inputs unchanged. Diagnostic-free CLI micro48 and SQLite WordPress72 remain pending. The kernels/GLUE profiles are experimental; no full canonical image/conformance/browser-memory/all-benchmark acceptance or default promotion. Ordinary means same-engine untranslated Wasm; application VM/ordinary includes anonymous-shared versus FILE-only OPcache. All build preparation failures (ambiguous source anchor, missing generic translator proof inventory, missing Playwright artifact-root environment) are retained, alongside semantic failures; none is represented as an engine defect.

Retained `.context/timestamp-optimization-20261113/timestamp-combination-build-mechanisms`327files/9354 input references; source preimages recover the earlier builder/worker exactly. No timing inference from individual ratios or invalid combinations.

### Expanded scalar admission: both shortcuts have a semantic gap

This supersedes the earlier DataView-only "compatible" classification. The combined copy check exposed a typed-element shortcut skipping an observable Array.at callback when the copy path fell back. A targeted **Node** negative without any copy optimization now reproduces the same issue in each scalar accessor independently: baseline typed and DataView reads each invoke112 Array.at callbacks; typed-fast typed reads invoke0, DataView-fast DataView reads invoke0. All112 byte values remain correct. The original203 checks covered values/mappings/permissions but missed this modified-intrinsic behavior. Passing the bounded checks was never full JavaScript API equivalence acceptance; this new concrete counterexample is retained.

Both scalar alternatives are now **not admitted for the final combined candidate**. Their earlier individual micro/application measurements remain as historical experimental results, qualified by this newly found semantic gap. They require conservative admission for modified intrinsics or equivalent callback behavior before promotion. Neither idea is discarded. The literal all-factor bundle has no admitted application timing, and the provisional DataView-only combination's freshness32/CLI micro48 are retained separately rather than presented as final acceptance.

Final measured candidates are strong (short64+direct clock+VM clock renewal) and the broader admitted subset (strong+TS01 metadata reuse+page-byte scanner+finer kernel cache+bounded VM guest stat with shared final eligibility). Both scalar variants are explicitly omitted. New broad profiles5 contain no scalar flag; original PHP/kernel artifacts remain identical. Its actual clock/stat/mixed guests24 pass all hosts/models, including simultaneous64clock/64stat hits and sibling fallback. Unchanged strong mechanism/freshness evidence remains. New broad PHP freshness16 and matched final timing matrices are pending. No latency estimate is inferred from the rejected bundles.

Evidence: `.scratch/timestamp-scalar-intrinsic-negative-1/result.json`, full script and original combined copy failure; final runtime plan `.scratch/timestamp-combination-php-plan-2/manifest.json`. Ordinary remains same-engine untranslated Wasm, not machine-native PHP. Primary timestamp policy remains validation1/frequency0.
