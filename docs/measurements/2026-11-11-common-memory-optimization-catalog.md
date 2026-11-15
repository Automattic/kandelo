# Common-memory application optimization catalog

The [survey synthesis](2026-11-12-common-memory-optimization-survey.md) draws
the practical conclusions, with timestamp validation retained as the primary
case. This file remains the append-only experiment catalog. Every candidate
keeps a stable ID and its original hypothesis. Negative, neutral, failed and
inconclusive experiments remain evidence; none removes an idea from the list.
Later experiments append results instead of replacing earlier observations.

Scope: the opt-in memory32, single-Worker-per-process PHP-FPM profile and real
WordPress SQLite/MariaDB workloads. Native means untranslated Wasm on the same
engine, not machine-code PHP. The existing interactive preview remains frozen.
No default-runtime, production, general POSIX or whole-platform speed claim is
made by an isolated screen. Promotion requires the surrounding acceptance
checks and benchmark scope described in the repository performance guidance.

## Breadth snapshot after phase 59

The original18 candidate IDs have at least a bounded mechanism, feasibility
or measurement screen; CC-05 adds an interpreter-dispatch family. This does
not mean19 application optimizations have been characterized:
the remaining gaps are particularly large for PHP loop/stack/arena proofs,
generic pointer provenance and a real two-memory ABI. Earlier large compiler
and instrumentation matrices consumed disproportionate effort; keep the
next decisions about applicability and coverage before deeper replication.

| Family | Evidence so far | Practical interpretation / remaining gap |
|---|---|---|
| Scalar helpers, alignment, selective inlining (VM-01/02/06/10) | Individual/combined FPM screens; small-offset fusion, aligned atomics and a new eight-profile wrapper-key factorial timed on WordPress | Over94%fewer wrappers adds~1.1MBand has no clear warm increment over fusion in this screen. Fusion helps Chromium/Firefox and regresses WebKit; Node order reversals limit its new result. No universal preset |
| Translation caches and affine arenas (VM-03/09) | Root-header caches regress tested FPM; pinned span near ordinary cost; WordPress affine coverage plus actual instance-global cache tests | Two windows fit40.9% of wrapped attempts. The new per-access guarded cache passes mechanisms but regresses synthetic reads and the WordPress screen on all hosts. Hoisting and other placements remain open |
| Object, loop and stack reuse (VM-04/05/07) | Whole-object/bulk-copy app screens; regional rewrite/app checks; synthetic loop cost; all-host regional coverage diagnostic | Current regional pass bypasses translation for~1.73% of observed WordPress dispatches, all guards hit. Coverage limits its reach; broader frame-origin and loop proofs remain |
| Call effects / pointer provenance (VM-08) | Transitive analysis and52 real-Wasm checks; strict affected-parent dispatch upper bound~0.024%; new all-host constant-address census | Recognized constants account for5.3418%of attempted WordPress dispatches, all reached ranges single-page; includes~20.35%of atomic dispatches. Frequency is not CPU share or a translation-elision proof; generated fork-state ownership remains unclassified Phase56 adds a handwritten constant-VA/width4 guarded cost model:300mechanisms and560timing samples on4hosts; strong scalar resolver-cost signal, smaller/engine-dependent atomic increment. Phase 57 implements automatic selection and all-width/live-mapping mechanisms, reproduces all baseline PHP artifacts, and passes real PHP/both-database WordPress gates. It adds 499,846 bytes to FPM; timestamp-enabled timings find no Node/Chromium constant increment, an unresolved sustained Firefox HTTP504, and inconclusive WebKit control drift. See phase 57; no default promotion. |
| Compiler passes (CC-01/02/03/04) | O3/LTO/PGO/post-Wasm FPM screens; real WordPress PGO+fusion and O3/LTO/fusion matrices | New112-parent compiler screen has no broad O3/LTO gain; fusion again helps Node/Chromium, with adverse WebKit combinations and control drift. No optimal flag set established New16real C-unit admissions show Os/Oz size tradeoffs: modest interpreter-body reduction, larger compiler/cache reduction; Oz grows some largest functions. No linked-program or runtime-size-flag claim. |
| PHP interpreter dispatch (CC-05) | Real CALL/GOTO and new portable Wasm TAILCALL builds; separate C tail-call-feature control, exact Zend API and fork/shared-cache checks | Portable TAILCALL passes small gates but ordinary-addressing Node WordPress startup exhausts the stack in a generated fork transport. CALL+feature passes both database/all-host gates; a64-parent individual/fusion-combined SQLite timing screen is retained below. A minimal pure-PHP loop fails all8portable ordinary/VM cases across4hosts;16CALL/feature controls complete it. Small C counterexamples keep the precise transport-shape explanation open. No default changed |
| Two-memory architecture (ARCH-01) | Four-host mechanisms, alias negative control and mixed-tag read/write cost screen | Shuffled50/50 tags cost2.29–3.35x ordinary reads and2.82–5.28x non-atomic RMW, still below current fused PTE costs in this fixture. Bank provenance matters; actual SDK/fork/PHP integration absent |
| PHP caching/warmup (APP-01/02) | Capacity counters, compile-only preload, all-host timestamp-policy latency | Timestamp-off has the strongest replicated latency result for immutable code. Plain preload screen has little consistent warm benefit and adds~130MiB sampled allocator consumption; no cache-capacity pressure on this corpus |
| Allocation and reuse (RT-01) | Sparse/scratch combinations, mapped-payload mechanisms and new128-round fixed-pool WordPress study on all hosts | Controls fail after373–376sampled pages near512MiB; reuse completes512 at140–144MiB sampled high-water. RSS, process retirement, byte-copy compatibility and speed gains remain unproved Six manual FPM replacements now pass on8parents/all4hosts, but reuse logical allocation grows31.375MiB/replacement, retained roots3→9while live roots stay3. Safe root retirement is a separate unresolved boundary. |

Additional work covers whole-module loop/frame applicability and aligned-atomic
WordPress timing. Actual site counters put the strict readonly-loop candidates
at 0.162–0.163% of dispatch attempts; tracked frame origins reach 0.54%. These
are execution frequencies, not CPU or speedups. The atomic timing screen adds
a modest Firefox signal and adverse WebKit combinations, with little increment
on Node/Chromium. The broader writer-site observer now measures4.344%of attempts,3.642%in
empty-entry loops with stride hints. These are candidate shapes, not safe
elisions or CPU fractions; compiler provenance and mapping-lifetime proofs
remain open. The MariaDB policy screen now favors validation-off on
three browsers; Node latency is inconclusive because its orders and controls
vary sharply. Every negative
and inconclusive idea remains in the catalog.

## Current survey decisions

User steering on November 12: keep timestamp validation enabled as the primary
case for the ongoing memory-optimization investigation. Disabling it remains
an optional application policy; no translation or allocation recommendation
may depend on accepting immutable code. Phase 57 redirects its application
measurement accordingly and preserves the interrupted validation-off batch.

Phase51 checks the exact frozen WordPress image and finds1,500 prebuilt
OPcache files (45,251,192bytes). Screens using image SHA
`2185bdbb403d6a0032dd9dfb8569dd0493aa5d2b218d642699571197297fd831`
inherit that FILE-cache corpus. Fresh engine parents do not imply empty
FILE caches. Retain ordinary-control ratios as preseeded-image results;
empty-cache image admission and a core CLI cross-dispatch compatibility corpus
now pass (phase52). Phase53 proves ordinary CALL cache generation and completes
clean-image CALL wrapper timings; compatibility of the full prebuilt WordPress
corpus and clean-image GOTO/CALL timing remain unproved.
This corrects the phase50 checkpoint's WordPress fresh-cache description.
Shared-mode cases explicitly disable FILE cache and assert populated shared
OPcache; their within-shared-mode candidate comparisons remain separate.


The latest timestamp-enabled factorial (phase59) supports host-specific
byte-copy and scalar-fusion follow-ups, with no universal preset. Node and
Chromium combined results favor the change in both cohorts, while Firefox
reverses and WebKit regresses. Keep validation enabled as the primary case.
The optional immutable-code policy, timestamp validation off (APP-02), has
stronger earlier warm latency results but depends on an explicit update/
invalidation policy; MariaDB confirms the browser signal, while Node remains
inconclusive. Host byte-copy adaptation
(VM-05) is the next promising measured application direction: SQLite and
MariaDB screens include ordinary references, alone/combined comparisons and
opposite orders on all four hosts. Firefox variation, individual-page
regressions and ordinary-control drift limit any universal claim. Small-offset
fusion (VM-10) contributes on some hosts but has adverse WebKit combinations;
enabling every tested optimization is not a justified preset.

Allocation work (RT-01) now has a longer fixed-pool resource result: all four
controls fail near the512MiB ceiling after373–376sampled pages, while reuse
completes512 at a flat140–144MiB sampled high-water. This supports further
prototype validation of reuse, not lower RSS, process retirement, indefinite
stability, byte-copy compatibility or a speedup.
Plain preload (APP-01) is a low-priority addition to the current warm corpus:
it is near neutral alone, gives inconsistent browser increments after the
preset, increases startup time and adds roughly130MiB sampled allocation.
Cold workloads, larger corpora and selective preload remain distinct ideas.
OPcache enlargement has no pressure-based justification on this corpus.

The current root-header and per-access affine caches (VM-03/09) are negative
application results. The affine result does not reject once-per-loop/span
translation: those guards would be paid at a different frequency. Current
regional rewriting (VM-04/07) and conservative call-only analysis (VM-08) have
low observed dispatch coverage, so broader implementation should first show
useful applicability. The two-memory experiment (ARCH-01) demonstrates a
different cost tradeoff for mixed tags; it has no SDK/PHP mapping integration.
O3, LTO, PGO and post-Wasm optimization (CC-01/02/03/04) have measured FPM
results, but no common winning configuration. Real WordPress O3/LTO and PGO timings, plus actual WordPress PGO training,
are now complete bounded screens, including adverse combinations and
ordinary-control drift. No general compiler-default change is justified.
The new wrapper-key factorial adds no clear gain from alignment normalization
or generic large offsets over fusion, despite a large wrapper-count reduction.
Its Node aggregate is inconclusive: generic-alone cohort ratios0.473/1.154
reverse, with one-minute load-before ranging8.69–53.39. Chromium/Firefox fusion
signals and WebKit regressions repeat in both orders; no universal preset follows.

These are research decisions with different evidence depths. The original18
families have bounded screens; they do not all have implemented application
optimizations. CC-05 now has a six-variant generator/executor compile screen
and separate four-host dispatch/tail-call admission checks. Fresh specialized
GOTO builds pass browser PHP/fork/shared-OPcache and both WordPress backends;
virtualized GOTO hits a default-Node compiler OOM. SWITCH and generic handlers
need source compatibility work. The new48-parent browser shared-cache screen is negative for GOTO: outlined
GOTO/CALL ratios2.727Chromium/2.204Firefox/3.765WebKit, with both orders adverse.
Fusion does not rescue the combined candidate. Default Node still fails its
compiler-resource gate. Source-shape alternatives remain retained. RT-01 also has four-host failure-only
growth checks, including a deliberately injected backend rejection.
Remaining experiments include PHP loop/frame/provenance proofs and coverage,
real two-memory ABI/fork integration, broader atomic workloads/replication,
quiet Node policy replication, and sustained allocation/retirement.
Canonical builds, full platform benchmarks, conformance, ABI acceptance and
the browser-memory gate have not been established by these private screens.
The bounded optimization survey and its requirements review are now recorded
in phase60 and the linked synthesis. The remaining engineering experiments
are explicitly retained; survey completion does not establish production
integration or turn these hypotheses into demonstrated benefits.

Broader writer loops (VM-05/07/08) now have measured site reach rather than
only parent-function bounds:4.344%of WordPress dispatch attempts, including
3.642%in empty-entry loops with any stride hint. This supports a focused
applicability/proof experiment, not a large expected gain or permission to
hoist checks. Prior readonly/frame/cache negatives remain intact. Cheap wrapper
key/offset-shape counts, the untested imported-generation-cell binding and
allocation retirement/churn are additional independent directions. Cache-empty
FILE image admission and bounded cache compatibility now pass. Phase53 completes
matched CALL wrapper timings on that image. Generated fork-state spans,
constant-address provenance, standard-Wasm tail-call PHP dispatch, size-oriented
Clang builds and retirement/churn/copy-on-write remain separately retained,
unimplemented follow-ups; their mechanisms and applicability are not established
by the current wrapper experiment.

Phase54 adds actual constant-address coverage before implementing another
fast path. The four-host result agrees closely at5.3418%of attempted dispatches,
including1.1103–1.1104%constant atomics; all reached constant ranges are single-page.
This supports testing constant arithmetic/bounds specialization with live PTE,
permission and atomic reads retained. It does not prove a reusable physical
binding or a speedup. Passive data segments and the absence of an emitted
instruction-origin map leave linked-data ownership and generated fork-state
coverage unresolved. Keep these limits separate from the older C-frame bound.

## Candidates

| ID | Idea and hypothesis | First test / correctness condition | Status |
|---|---|---|---|
| VM-01 | Specialized single-page scalar resolver avoids general span machinery and repeated effective-range validation | All numeric/SIMD/atomic forms, offsets, overflow, permissions, split pages and real FPM; retain slow fallback | First FPM screen complete; modest Node compute signal, browser ranking inconclusive; retained |
| VM-02 | Call scattered-store commit only when staging was selected | Individual store profile, denied-prefix and scattered-store controls; original fork/global indices unchanged | First FPM screen complete; workload/cache dependent, no consistent shared-cache gain; retained |
| VM-03 | Cache a recently translated page and permissions | Compare cache placements; invalidate on mapping effects, root/child change and guest resume; never snapshot shared payload | Root-header variants pass correctness but regress FPM compute on all engines; retained; other placements pending |
| VM-04 | Validate an object span once and reuse the physical base for its fields | Non-faulting guard selects fast path; otherwise preserve original access/fault order | Conservative pass selects139 functions/349 sites; all-host mechanisms/fork/FPM/40 WordPress checks pass; two96-parent screens retained; repeat validates two-worker batches but has mixed results and a Firefox outlier; broader proofs retained |
| VM-05 | Validate a loop span once, with bulk/SIMD fast paths | Contiguity/permission guards, tails, aliases and mapping-changing call barriers | Private byte snapshots pass44 mechanisms/host, both-database controls and actual branch-use diagnostics. SQLite and MariaDB each have48-parent/960-request WordPress latency screens alone and with fusion; all per-page/order/native data retained. Page/backend/load dependence and earlier FPM regressions/Firefox outliers remain. New named-libc parent dispatch bound~2.52% excludes internal/inlined loops; new whole-module scan and actual four-host readonly invariant/stride site union~0.162–0.163%; new102checks/host observer finds actual writer-loop sites4.344%,empty-entry stride-hint sites3.642%,readonly/writer union4.437%; broader SIMD/alias/lifetime proof retained |
| VM-06 | Use proved alignment to remove impossible split-page cases | Actual proof or checked guard; Wasm memarg alignment alone is not proof | Aligned atomic specialization passes mechanisms/fork/FPM/WordPress. New40-parent/800-request shared SQLite timing screen: standalone ratios1.016Node/1.005Chrome/0.975Firefox/1.045WebKit; added to scalar fusion0.996/0.997/0.972/1.040. Modest Firefox signal, no universal gain; all per-page/order/native data retained. Guarded-i32 bounds passes correctness and 48-parent timing screen; Firefox shared compute improves with file-cache regressions, other hosts mixed; retained |
| VM-07 | Translate a private C shadow-stack frame once | Proven frame-relative accesses; derived physical locals must not survive fork replay or remapping unchanged | Regional rewrite selects7910 regions/85290 sites; all-host WordPress diagnostic observes451 active regions and~1.73% fast dispatches,100% guard hits. Timing inconclusive; new five-build origin/loop scan and actual all-host site counters add tracked frame origins~0.54%, before-effects~0.12%, anchor-name~2.32%; no mapping-lifetime/fork-rebinding proof |
| VM-08 | Pointer provenance, escape/liveness and call-effect analysis permit selective translation | A fork-free call tree alone is insufficient: inherited private addresses still differ; unknown aliases fall back | Transitive call-effect first screen complete:52 real-Wasm analysis checks; strict min4 coverage85290→85531 sites, affected parent functions<=0.024% of observed WordPress dispatches. No cross-call rewrite enabled; new producer/versioned frame-origin scan and actual site counts complete; richer pre-fork/alias/exception/loop-write proofs retained |
| VM-09 | Stable private/shared arenas use an affine base offset | Prove/pin mapping lifetime or guard its epoch; mutable shared contents remain live; preserve mmap/mprotect semantics | Observer windows fit40.9% of wrapped attempts; plane+shared address matches81.9% without a whole-plane certificate. Actual scalar instance-global cache passes33 mechanisms/host/mode and real fork/FPM/40 WordPress parents, but regresses array reads and WordPress warm latency; hoisted/other placements retained |
| VM-10 | Selectively inline hot access paths while outlining cold ones | Compare code size, compilation/startup resources and warm execution; retain compact outlined baseline | Small fusion has FPM/WordPress screens; WebKit regressions retained. New eight-profile alignment/generic-large/fusion factorial passes all gates and80-parent/1600-page SQLite timing: no clear new-policy increment over fusion, Chromium/Firefox fusion gains and WebKit regression, Node order reversals inconclusive. All original/page/order/native evidence retained; full-offset/profile-sensitive variants remain open |
| CC-01 | Clang O3 improves PHP and helper code | Match native and VM builds; earlier microbenchmark gains were inconsistent | Individual screens (112 parents), combination (128 parents) and fresh repeat (128 parents) complete; no broad winner; original load-confounded run and later variable/regressive results retained. New112-parent WordPress compiler matrix adds PHP/helper O3 individually, together and with fusion; no broad gain Phase56 adds real O2/O3/Os/Oz admission across four C units:16objects, no linked/runtime claim; size levels retained as per-unit cold/code-size candidates, not a preset. |
| CC-02 | LTO exposes cross-file optimizations | Rebuild compatible dependencies when needed; retain actual emitted-code/hash changes and build failures | Corrected PHP builds/application controls pass; 256-parent matched FPM screen has no broad winner, modest WebKit full-LTO+fusion shared signal, regressions/cohort variation/peer overlap retained; larger code. New112-parent WordPress compiler matrix includes full/ThinLTO alone and with fusion; no broad gain, modest drift-limited WebKit standalone signals and adverse fusion combinations |
| CC-03 | Profile-guided optimization targets WordPress/PHP hot paths | Training profiles separate from timing runs; exercise frontend/admin and test another workload | Existing WordPress+CLI training verified;128-parent held-out FPM screen retained. New48-parent shared WordPress first screen passes: PGO alone mixed, Node PGO+fusion2.396×fusion-only; host/order differences and ordinary-control drift retained. No universal/steady-state winner |
| CC-04 | Translation-aware LLVM or post-Wasm optimization removes work added after ordinary optimization | Follow the supported named-catalog post-optimization contract; audit prototype metadata and cover fork-generated accesses | Post-VM levels built; original WebKit crash retained and independently reproduced; individual and fusion-combined 144-control matrices complete; host/cache-dependent signals, retained |
| CC-05 | Change PHP opcode dispatch from configured CALL to upstream SWITCH/GOTO, with specialization on/off; retain portable explicit-tail-call design | Real target admission/generator probes, consistent PHP/OPcache rebuild through SDK/fork preparation, new ordinal maps and matched ordinary/VM controls; keep dynamic-table consistency semantics | Fresh CALL/GOTO builds complete. Browser CLI/fork/FPM checks and36WordPress cases on SQLite/MariaDB pass; default Node virtualized GOTO has4compiler OOMs, while ordinary GOTO passes. Four optimizing-tier flag variants and post-VM O2 do not cure it; baseline-only engine mode passes diagnostic CLI/FPM checks. New48-parent warm browser screen: outlined GOTO/CALL2.727Chromium/2.204Firefox/3.765WebKit; combined2.638/3.507/3.271, both orders adverse. Ordinary FILE references inherit preseeded image cache; separate empty-cache image now passes32all-host/backend cases; bounded154checks/host CLI compatibility passes. Phase53 adds ordinary CALL cache-generation proof and clean-image CALL wrapper timing; full prebuilt-corpus compatibility and clean-image GOTO/CALL warm timing remain pending. SWITCH/generic failures, tailcalls, handler clusters and wrapper costs retained. Phase55 adds portable standard-Wasm TAILCALL and C-feature-only builds: targeted24API/72runtime parents pass, but portable ordinary Node WordPress fails with stack exhaustion before cache proof. CALL+feature passes48WordPress parents/both databases/all4hosts and8own-build cache proofs; a64-parent individual/fusion-combined SQLite timing screen is retained below. A minimal pure-PHP loop reproduces stack exhaustion all8portable ordinary/VM cases across4hosts, while16CALL/feature controls complete it; simple C counterexamples remain. |
| ARCH-01 | Separate private and shared Wasm memories make proved-private accesses ordinary | Larger alternative to one-common-memory design; evaluate engine support, generic-pointer dispatch and ABI/fork implications | Worker-owned mechanisms/alias negatives pass all four hosts. Earlier loop-invariant-tag reads1.05–1.62x ordinary remain; new dynamic mixed-tag read/write screen passes32 checks/host. Shuffled50/50 reads2.29–3.35x, RMW2.82–5.28x. Still below current fused PTE in this fixture; SDK/fork/PHP integration remains pending |
| APP-01 | OPcache capacity, warmup/preload and cache selection reduce repeated compilation/loading | Use real cache counters; match source corpus; record cold and warm separately | Compile-only preload561files passes Node/browser controls. New48-parent/960-request plain SQLite screen: preload alone near neutral; preset increments inconsistent outside small Node signal, startup/allocation costs retained. File-cache-only preload is not effective in the Node capability check; ordinary remains a separate reference |
| APP-02 | Disabling timestamp checks helps immutable-code requests | Separate explicit immutable benchmark from editable preview; verify updates require invalidation/restart | 24 policy controls and64-parent/1792-page all-host SQLite latency screen pass; shared latency improves14–41% by host/page with both cohorts agreeing; file-cache/CPU regressions retained; New64-parent/1280-request MariaDB screen: shared latency ratios0.745Chrome/0.721Firefox/0.728WebKit with both orders favorable; Node0.674/1.360order split is inconclusive. All24policy controls pass. Separate Node service-wide dispatches fall36.7%; all native/file regressions and drift retained |
| RT-01 | Extent reuse and smaller scratch reduce memory pressure and permit sustained runs | Reclaim only provably unreferenced physical ranges; preserve aliases, fork sharing, zero-fill and worker lifetime | Sparse fork/smaller scratch/preload combinations retained. New unmapped-payload reuse passes all-host mechanisms/FPM/SQLite checks; incremental high-water savings113.1875MiB(Node file),58.5625MiB(Node shared),62.5MiB(browser shared). New128-round fixed-pool study: all-host controls fail near512MiB after373–376sampled pages; reuse completes512 with flat140–144MiB sampled high-water. Phase56 adds48real SIGTERM worker replacements across8FPM parents/all4hosts: cache behavior passes, but retained-root allocation grows31.375MiB/replacement with reuse. Safe reclamation, automatic retirement/cancellation, RSS, byte-copy compatibility and latency proof remain pending |

## Prior evidence, retained without promotion

The [individual and combined microbenchmark report](2026-11-10-common-memory-optimizations.md)
retains scalar/span/page-cache/alignment/bulk/SIMD and compiler profiles.
Span plus explicit SIMD approached its native vector control for dense
arrays; scalar object walks retained overhead. A cached page helped Firefox's
small pointer chase more than the other engines. Automatic vectorization
emitted identical modules in one comparison. These observations do not decide
their PHP-FPM or WordPress value.

The [PHP-FPM application report](2026-11-10-common-memory-php-fpm.md) retains
the expanded instrumentation compiler-memory failures and the outlined mode
that reduced FPM from 55.39 MiB to 36.31 MiB. Expanded mode remains available.
The current PHP recipe uses Clang O2 and Binaryen O2 before fork/VM rewriting;
helpers use O2. No optimal application compiler configuration is established.

## Evaluation protocol

1. Freeze source, module, kernel, image, host-profile and workload hashes.
   Existing preview images and worker bundles are never overwritten by a run.
2. Establish sustained-run memory behavior before selecting warmup/round counts.
3. Use ordinary/file-cache, VM/file-cache and VM/shared-OPcache controls when
   separating translation cost from cache benefit. Compare an instrumentation
   candidate against the same VM/cache configuration, not a different cache.
4. Screen one change at a time. Preserve a matched ordinary reference, baseline
   bracketing, randomized order, cold costs, warm latency and resource counts.
   Profile/counter builds are diagnostic runs, not uninstrumented timing data.
5. Pass mechanism, fork/lifecycle and real shared-cache checks before ranking
   a candidate. Keep expected negative controls and every failed run.
6. Confirm promising candidates on Node and Chromium/Firefox/WebKit, then test
   combinations and useful leave-one-out comparisons. Retain inconclusive
   samples and load/timer uncertainty; do not call an unstable difference a win.

Each result entry records: ID(s), implementation/proof scope, command/run ID,
input/artifact identities, engine/tool versions, correctness verdict, raw data,
native and baseline ratios, startup/memory effects, limitations and next test.
Feasibility-limited candidates remain cataloged with the concrete missing
capability or proof obligation; they are not silently marked unsuccessful.

## Selective translation: proof boundaries

VM-08 cannot use absence of a `fork()` call as its sole proof. A child can
execute a fork-free function that reads a pointer stored before fork. That
pointer is still virtual, and private copies have different physical bases.
Unknown heap pointers therefore retain translation. Mutable shared payloads
must also remain live; a cache may retain a mapping, not copied payload bytes.

Useful analyses can prove stack-frame-relative accesses (VM-07), object or
loop spans (VM-04/05), or fixed arena mappings (VM-09), then reuse a physical
base while the proof holds. A non-faulting guard must fall back to original
accesses rather than changing the order of visible faults or stores.
Mapping-changing calls invalidate that proof. Physical temporaries surviving
fork replay need rematerialization for the child; pointers stored in guest
data must preserve the guest's canonical virtual representation unless the
whole representation and all consumers are changed deliberately.

The first VM-03 design should include an explicit mapping epoch and root
identity, permissions, overflow/split-page fallback and wrap handling. Manual
test remaps, guest growth and host mapping/protection/unmap paths all count
as mutations. New per-instance cache globals must start invalid in a forked
instance rather than being copied as original guest state. A cache with no
complete invalidation protocol is not an acceptable speed experiment.

## Experiment ledger

The first VM/shared SQLite resource diagnostic passes homepage/admin login,
two-worker cache checks and 24 further page requests. Physical allocation
grows from 259.12 MiB after login to 369.00 MiB, within the unchanged 512 MiB
group. This confirms that sustained timing runs need bounded batches or
reclamation; it does not measure a reclamation improvement. The initially
named REST workload actually followed the image's pretty-path fallback to
HTML; its exact source/output is retained and the new fixture explicitly
requests and validates REST JSON. No REST performance claim uses that run.
Evidence: `.context/common-memory-survey-20261111/initial-resource/`.

The next experiments establish matched ordinary/VM controls and screen VM-01
and VM-02 independently and together. Retained campaign evidence belongs under
`.context/common-memory-survey-20261111/`; disposable builds go under unique
`.scratch/` directories.

### VM-01 and VM-02: implementation and correctness

`survey/build-variants.py` freezes four variants: the original outlined
instrumentation, conditional commit alone, the specialized resolver alone,
and both. The original output remains byte identical to the frozen preview
PHP module (`f879effe…`). Conditional commit is opt-in; the source recipe and
default runtime are unchanged. The resolver calls the existing page lookup
directly only when an already bounds-checked scalar access fits in one page.
Cross-page operations preserve the general span/staging path.

All four variants pass Node mechanism checks, 12 browser mechanism trials
(four variants in each engine), eight Node actual SDK fork/FPM checks, and
12 real shared-OPcache browser checks. These include permissions, denied
prefixes, scattered stores, SIMD lanes, numeric offsets/overflow and i64
atomics. Browser checks use Chromium, Firefox and WebKit. This is prototype
evidence, not the full platform conformance/acceptance gate.

### Connection fixture investigation, retained

The first Node timing matrix stopped on one `EBADF` while injecting a
FastCGI connection shortly after FPM startup. Two diagnostic reruns passed;
that does not invalidate the failure or prove a root cause. The fixture
previously selected a listening descriptor and injected the connection in
separate worker RPCs. An experimental same-turn implementation still used
two kernel entries and crashed a WebKit page twice. The exact old frozen
profile passed the control. No browser-engine defect is inferred.

The subsequent fixture performs listener selection and injection inside one
kernel entry, following the existing worker-side HTTP admission model. It
does not retry or suppress errors. All four FPM variants pass on Node and
all browser engines with this fixture. All timing controls are restarted
using that same isolated compiled profile. Failed datasets and fixture
implementations remain in the retained connection diagnostics.

### Initial Node FPM timing screen

All 32 fresh Node parent controls completed with frozen inputs: two cohorts
per variant, native/file-cache brackets, VM/file-cache and VM/shared-cache.
Each launch has 64 warmup rounds, seven measured rounds, real two-worker
concurrent requests, cache checks and clean FPM termination. This screen
compares instrumentation choices against the same PHP build, not against
the destination branch or a fully optimized compiler build.

The browser matrix also completes: 96 controls, for 128 total fresh engine
parents and 55,808 request samples, including warmup/cold/concurrent samples.
The measured single-request comparison uses seven warm samples per workload
per launch; those samples are not seven independent engine launches. Each
variant/cache has two independent launches per host. Default Node 24.15.0,
Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6 are used without Wasm
compiler flags. Artifact hashes and workload identities are checked by
`survey/summarize-fpm.py`; all Node frozen input hashes still match after
browser completion.

Node compute end-to-end latency, geometric mean of per-launch medians:

| Instrumentation | VM/file ms | VM/file ÷ ordinary/file | VM/shared ms | VM/shared ÷ ordinary/file |
|---|---:|---:|---:|---:|
| Baseline | 7.598 | 2.63× | 6.945 | 2.40× |
| VM-01 scalar | 7.226 | 2.50× | 6.672 | 2.30× |
| VM-02 conditional commit | 7.091 | 2.47× | 6.937 | 2.42× |
| Both | 6.981 | 2.41× | 6.663 | 2.30× |

The ordinary compute controls are about 2.87–2.89 ms. VM/file compares the
same file-cache configuration and is the cleaner addressing-cost control.
VM/shared changes cache behavior; its ratio measures the combined system,
not pure address translation cost. For example the include-heavy workload
is 3.799 ms with baseline VM/shared versus 8.010 ms ordinary/file because
shared OPcache avoids repeated file-cache loading. VM-01 increases that
VM/shared workload to 3.918 ms in this screen. A compute-only benefit is not
a uniform application benefit.

For compute with shared OPcache, the following ratios compare each variant
to the baseline VM/shared result, after normalizing each against its own
ordinary brackets. Values below 1 are apparently lower latency. This
normalization does not remove all load, tiering or scheduling uncertainty.

| Host | VM-01 ÷ baseline | VM-02 ÷ baseline | Both ÷ baseline | Interpretation |
|---|---:|---:|---:|---|
| Node | 0.959 | 1.006 | 0.958 | Scalar's two cohorts agree at about 4% lower latency; combined adds no demonstrated shared-cache benefit |
| Chromium | 0.948 | 0.996 | 1.060 | Scalar cohorts disagree (1.102, 0.815); not a stable gain |
| Firefox | 0.986 | 0.977 | 0.788 | Apparent combined gain needs repeat; ordinary bracket variation reaches 91% in the matrix |
| WebKit | 1.093 | 0.943 | 1.013 | No consistent scalar/combined gain; ordinary brackets vary up to 44% |

Host load rises sharply during the browser matrix (recorded load averages
exceed 35). Chromium's scalar native brackets differ by about 50%, and
Firefox/WebKit also show large variation. No outside cause is assigned.
The complete measurements, cohort ratios and native envelopes remain in
the JSON report; none is dropped to improve the comparison. Browser
rankings are inconclusive. The Node resolver result is a candidate for
confirmation, not a promoted default. Conditional commit remains available
because its Node file-cache compute result differs from shared-cache behavior.

Evidence: `.context/common-memory-survey-20261111/phase1/fpm-summary.json`
and `fpm-tables.json`, plus the retained raw matrices. These narrow FPM
diagnostics do not establish real WordPress latency improvements. The
WordPress fixtures validate actual homepage/article/admin/REST and both
worker caches; short correctness runs are kept separate from timings.
Further work should interleave baseline/candidate launches more closely,
confirm in a quieter window, and evaluate mapping reuse and selective
inlining before spending a large compiler rebuild on a weak signal.

### Real WordPress correctness checkpoint

All 40 short application controls pass: ordinary/file plus all four
VM/shared variants, SQLite and MariaDB, Node and each browser engine.
Every trial checks homepage, article, real admin login, authenticated admin
content, parsed REST JSON, cache configuration and responses from both FPM
worker PIDs, then destroys its host. The VM trials use one group and three
roots. Warmup is zero and only one workload round is executed: these are
correctness checks, some running concurrently, and their elapsed times are
not used for an application performance claim.

The complete matched WordPress timing drivers are prepared with ordinary
brackets, reversed candidate order across two cohorts, cache controls,
source/artifact hashes and memory snapshots outside timed requests. Their
full warm matrices have not run. The current preview remains on its frozen
baseline; no candidate is promoted by these checks. Evidence lives in
`phase1/wp-node/`, `phase1/wp-sqlite-browsers/` and
`phase1/wp-mariadb-browsers/` under the campaign evidence directory.

The campaign remains active. VM-01/02 and their combined implementation
are retained alongside neutral/regressive observations. VM-03 mapping-cache
coherency and VM-10 selective inlining are the next instrumentation screens;
stack/span/provenance, compiler/LTO/PGO, cache policy, memory reuse and the
multiple-memory alternative remain in the catalog for later phases.

### VM-03: coherent root-header caches

The next implementation tests one entry and two direct-mapped entries in
the process root's reserved 64-byte header. It adds no guest globals and
does not change original fork snapshot indices. Word 4 is a mapping epoch;
words 5–7 and optionally 8–10 hold each entry's epoch, virtual page and PTE.
Root ownership gives the cache its process identity. Bounds and requested
permissions remain checked, and cross-page/scattered operations retain the
original fallback. Cache data describes mappings; shared payload is always
read from live backing.

Fresh roots start at epoch 1 with invalid cache entries. Host growth,
fork destination updates, anonymous shared marking, mmap/replacement,
mremap, protection and unmap advance a nonzero epoch while the process's
sole Worker is stopped. The cached helper's successful guest `memory.grow`
does likewise. Zero/failed growth leaves it unchanged. Unsigned wrap to zero
permanently disables caching for that root. Legacy epoch-zero roots also
always consult the page table, so these modules remain correct with an
older prototype host that never enables the epoch protocol. No shipping
ABI, package recipe or public preview is changed by this opt-in experiment.

New checks execute actual translated loads/stores after warming each mapping,
then change read/write/atomic permissions, enter PROT_NONE/write-only states,
copy fork mappings over a warmed destination, replace inherited shared
backing, move/shrink/grow mappings and unmap them. They check private child
isolation, live shared writes, old-address faults, holes/zero tails, host and
guest epoch wrap and the legacy bypass. All five controls pass on Node and
in 15 browser mechanism trials. Actual SDK fork/FPM Node checks pass 10/10;
browser shared-OPcache checks pass 15/15 across the same five modules.

The baseline FPM still hashes to `f879effe…`. Cache-only variants are built
with original helpers plus the cache, while the combined variant also uses
VM-01/02. Its direct reference is the existing scalar/conditional module
with identical native SDK source identities, not the unoptimized VM baseline.
The paired manifest records that reference artifact's original provenance.

The timing protocol places each candidate directly beside its matching
reference, with ordinary brackets around each six-launch block. The second
cohort reverses candidate, cache and pair order. Each host ran 36 fresh
parent controls, retaining both cache configurations, 64 warmup rounds and
seven measured rounds.
Wasm-global cache placement remains a separate untested alternative: extra
header loads may offset the saved PTE lookup, and a result for this placement
will not reject the broader caching idea.

The paired matrix completes all 144 controls (36 Node plus 108 browser),
with 62,784 request samples including warmup. The complete inventory,
source/workload identities, default engine settings and matching frozen
Node/browser inputs are validated by `survey/summarize-paired.py`.

Compute request latency ratios, geometric mean across the two cohorts:

| Host | One entry ÷ baseline | Two entries ÷ baseline | Two entries + VM-01/02 ÷ VM-01/02 | Combined ÷ ordinary/file |
|---|---:|---:|---:|---:|
| Node | 1.302 | 1.357 | 1.210 | 2.73× |
| Chromium | 1.205 | 1.315 | 1.207 | 2.80× |
| Firefox | 1.356 | 1.323 | 1.303 | 2.94× |
| WebKit | 1.339 | 1.328 | 1.116 | 2.47× |

These columns use shared OPcache on both sides of each VM/reference pair.
The ordinary/file column includes the cache-model difference; it is not a
pure translation-cost comparison. Same-file-cache compute ratios also
regress: about 19–35% for the cache alone, and 14–22% additional latency
when added to VM-01/02. Empty and include-heavy requests are much closer
to their references, with mixed small differences and occasional noise.
All workload and per-cohort values remain in
`.context/common-memory-survey-20261111/phase2/fpm-summary.json`.

The compute regression appears with both cohort orders and across engines.
Some individual comparisons remain noisy (WebKit combined shared-cache
cohorts are about 1.232 and 1.012), so the exact percentage is not a stable
prediction for another application. This placement is not a promising
default on the measured FPM workloads. Its implementation and all results
remain available. The cause is not yet established: extra metadata traffic,
cache misses and changed engine/compiler inlining are hypotheses, not
measured explanations.

Other VM-03 placements remain candidates. Besides per-instance Wasm globals,
try placing cache data separately from the root fields read by the host;
compare identical lookup logic and collect hit/miss counts in separate
diagnostic builds. A header-placement regression does not rule out those
representations or different application locality. No real WordPress
latency claim is made from this FPM fixture.

All 40 short WordPress correctness controls also pass for this phase:
ordinary/file and baseline/one-entry/two-entry/combined VM/shared, both
SQLite and MariaDB, on Node and all three browser engines. These retain
real login/admin/REST checks, two FPM worker PIDs and populated shared-cache
statistics. The SQLite/MariaDB browser and Node runs overlap deliberately
as correctness checks; no timing ranking uses them. An actual FPM shared
smoke with the two-entry module on the old epoch-zero profile 18 also
passes on Node, in addition to the explicit legacy-root mechanism test.

Phase-two artifacts, exact generated C, compiled host bundles, frozen paired
inputs, complete raw data and verdicts are retained under
`.context/common-memory-survey-20261111/phase2/`. The next VM-10 experiment
will fuse the resolver into a limited subset of outlined access wrappers,
starting with zero offsets. Static FPM counts show 6,857 distinct wrappers;
fusing all of them immediately would add avoidable compilation/code-size
uncertainty. Static counts do not establish dynamic hotness. Broader fusion,
other cache placements and hit/miss diagnostics remain cataloged.

### VM-10: fuse the resolver inside selected outlined wrappers

The new opt-in flags `--fuse-scalars=zero|small|all` require outlined mode.
The initial FPM screen selects offset 0 or offsets through 16, leaving
atomics and SIMD on their original helper paths. Each selected wrapper
performs root validation, unsigned 64-bit endpoint bounds, a one-page
guard, PTE existence and requested permissions directly before its raw
load/store. Split-page cases call the original helper and preserve scatter
staging/commit. Existing function/global/fork indices remain fixed; only
appended wrapper bodies change. Default and scalar/conditional control
modules remain byte-identical to earlier phases.

Zero-offset fusion covers 45 wrappers and 201,572 static source accesses,
adding 4,995 bytes to the FPM module. Small-offset fusion covers 286
wrappers and 367,523 static accesses, adding 31,948 bytes. These are static
counts, not measured dynamic coverage or profile-guided selection. The
combined module includes VM-01/02 and is compared directly to that same
control. Root-header cache helpers are explicitly rejected with fusion
until an integrated cache design is characterized, rather than silently
claiming that the bypassed cache contributes.

New mechanism checks create a sparse 4 GiB virtual address space backed by
only a few physical pages. They accept exact-endpoint numeric accesses and
maximum constant offsets, reject high unsigned overflow without wrapping,
preserve narrow signed/unsigned/i64 and floating behavior, and check holes,
permissions, scatter stores and denied prefixes. All five initial profiles
pass on Node and in 15 browser trials. The all-offset setting also passes
these C mechanisms on Node and all browsers, including the maximum-offset
case; full-offset FPM application timing has not yet run. Actual SDK
fork/FPM checks pass 10/10 on Node.

The first browser FPM matrix passes 14/15, with a WebKit page crash during
the unchanged scalar/conditional control. Three fixed diagnostic repetitions
each of that control and the combined candidate subsequently pass (6/6).
The original failed result and native crash report remain retained. The
native stack includes shared-memory growth and cached-instance update
functions, but this is not a standalone fault attribution or an established
cause. It remains an unresolved validation limitation; no retry hides it.

The complete paired FPM matrix passes 144 controls, with 62,784 samples
including warmup/cold/concurrent requests. Node/browser frozen plans and
inputs match, and the strict summarizer validates the complete inventory.
The earlier failed WebKit short control remains a separate unresolved
limitation; completing this matrix does not explain or erase it.

Shared-cache compute latency ratios (each candidate against its same-cache
reference, geometric mean of two fresh-parent cohorts):

| Host | Zero-offset ÷ baseline | Small-offset ÷ baseline | Small-offset + VM-01/02 ÷ VM-01/02 | Small-offset ÷ ordinary/file |
|---|---:|---:|---:|---:|
| Node | 0.952 | 0.813 | 0.862 | 2.15× |
| Chromium | 0.992 | 0.801 | 0.854 | 1.97× |
| Firefox | 1.305 | 0.790 | 0.824 | 1.99× |
| WebKit | 0.826 | 0.825 | 0.947 | 2.01× |

Small-offset fusion is the most promising shared-cache compute screen so
far: about 17–21% lower latency on all engines. Its individual cohorts are
both below baseline on every host. This is not a uniform workload gain or
a precise prediction for WordPress. Node and Firefox show large scheduling
variation in parts of the matrix; zero-offset Firefox shared-cache compute
cohorts are 0.857 and 1.987, and combined Node file-cache compute regresses
to 1.138× its reference. The corresponding include-heavy file-cache result
is 1.417×. Neither combination nor offset selection is universally optimal.
Chromium's small-offset compute cohorts agree closely (0.806 and 0.796),
with ordinary brackets differing by less than 2%.

The ordinary/file column includes the OPcache-model difference. For a
same-file-cache addressing comparison, small-offset compute costs are
2.37× ordinary on Node, 1.98× Chromium, 2.18× Firefox and 2.48× WebKit.
Keep these separate from the candidate/baseline instrumentation comparison.
All workload/cohort, native envelope, startup and memory data are retained
in `.context/common-memory-survey-20261111/phase3/fpm-summary.json`.

The next application screen ran actual WordPress SQLite on Node with
baseline/small-offset VM/file and VM/shared controls, ordinary/file brackets,
four warmup rounds and seven measured rounds. It used fresh parents and
reversed candidate order in the second cohort. Those measurements are
separate from short correctness runs. MariaDB/browser WordPress timing and
further offset/combination profiles remain pending.

All 12 WordPress timing parents complete, with 528 page samples including
warmup (336 measured). Each VM/cache/profile has two independent parents;
the seven requests per workload per parent are not seven independent
launches. The normal in-kernel HTTP API measures actual nginx/FPM pages,
authenticated admin and parsed REST JSON. Image, kernel, artifact, cache,
flags, sample counts and complete plan are checked by
`survey/summarize-wordpress.py`. Both FPM PIDs and populated shared-cache
status are verified outside timing.

Node SQLite shared-OPcache warm request latency, geometric mean of the
two per-parent medians:

| Workload | Baseline VM/shared | Small-offset VM/shared | Candidate ÷ baseline | Candidate ÷ ordinary/file |
|---|---:|---:|---:|---:|
| Homepage | 554.9 ms | 500.4 ms | 0.902 | 1.91× |
| Article | 655.1 ms | 558.2 ms | 0.852 | 2.01× |
| Authenticated admin | 615.1 ms | 526.3 ms | 0.856 | 1.90× |
| REST posts | 305.6 ms | 283.3 ms | 0.927 | 1.41× |

The same-file-cache comparison also improves in this screen: candidate
ratios are 0.914/0.900/0.891/0.894 for home/article/admin/posts. Shared-cache
results improve in both cohort orders for all four workloads. Physical
group allocation remains identical between baseline and candidate at about
357 MiB for file cache and 318.9 MiB for shared cache, below the existing
512 MiB ceiling. A larger initial reservation or disabled checks did not
produce this result.

These initial application gains are promising, not a final precise effect
size. One baseline/shared parent slows by about 12–15% between its early
and late measured requests; ordinary brackets also vary by up to about
11%. That particularly limits the article/admin percentage. No samples are
removed. Future replication should put each same-cache candidate directly
beside its reference (the current WordPress mode grouping leaves another
cache control between them), retain the reversed order, and measure the
browser/MariaDB workloads before a general WordPress claim. Raw results
and the summary live under `phase3/wordpress-sqlite-node-*` in the campaign
evidence directory.

All 48 short WordPress correctness controls pass as well: ordinary/file
plus all five VM/shared profiles, both databases and all four hosts. These
checks deliberately overlap and use zero warmup/one round; their elapsed
times are not performance evidence. The full-offset mechanism profile,
neutral/regressive zero-offset samples, mixed combinations and the earlier
WebKit control crash remain preserved alongside the positive results.

### WordPress replication: adjacent controls, both databases

The `cache-major-v2` replication completes all 96 fresh engine parents and
4,224 page samples (2,688 measured). Each same-cache baseline/candidate pair
is adjacent, with ordinary/file brackets and reversed middle order in the
second cohort. Every parent uses four warmup and seven measured rounds,
actual login/admin/REST checks and responses from both FPM worker caches.
All four stages ran serially; frozen source, program, kernel, image, host
profile and plan identities match. No samples or failed controls were
removed. This matrix has no failures; earlier failures remain retained.

Small-offset fusion / baseline VM/shared request latency (geometric mean
of two per-parent medians; below 1 means lower latency):

| Host | Database | Home | Article | Admin | REST posts |
|---|---|---:|---:|---:|---:|
| node | sqlite | 0.905 | 0.890 | 0.892 | 0.908 |
| node | mariadb | 0.909 | 0.928 | 0.888 | 0.895 |
| chromium | sqlite | 0.944 | 0.936 | 0.952 | 0.973 |
| chromium | mariadb | 0.920 | 0.917 | 0.916 | 0.940 |
| firefox | sqlite | 0.915 | 0.920 | 0.917 | 0.931 |
| firefox | mariadb | 0.981 | 0.968 | 0.990 | 0.988 |
| webkit | sqlite | 1.036 | 1.037 | 1.043 | 1.026 |
| webkit | mariadb | 1.048 | 1.062 | 1.058 | 1.045 |

Node improves in both cohort orders for all workloads and both cache
configurations, with ordinary bracket variation below 4.6%. Chromium
MariaDB improves in both orders; SQLite shared results are smaller and
less consistent (REST cohorts 1.017 and 0.931). Firefox SQLite shared pairs
agree more closely, but ordinary brackets vary by up to 2.92×; MariaDB
ordinary variation reaches 2.68× and admin/shared cohorts disagree. Its
native-relative and some file-cache effect sizes remain inconclusive.

WebKit shared-cache requests regress in both orders for every workload and
both databases: about 2.6–4.3% SQLite and 4.5–6.2% MariaDB. Its file-cache
SQLite cohorts disagree, while a MariaDB file-cache reference is much
slower in one cohort. Those aggregates do not establish stable large gains
or regressions. Keep the exact cohorts and cold/startup observations rather
than selecting the favorable cache/host. Earlier FPM compute gains do not
predict uniform WordPress gains.

Homepage candidate / ordinary-addressing latency, separating cache models:

| Host | Database | VM/file ÷ ordinary/file | VM/shared ÷ ordinary/file |
|---|---|---:|---:|
| node | sqlite | 3.13× | 2.06× |
| node | mariadb | 2.92× | 1.78× |
| chromium | sqlite | 2.39× | 1.84× |
| chromium | mariadb | 2.21× | 1.39× |
| firefox | sqlite | 1.69× | 1.05× |
| firefox | mariadb | 1.84× | 1.16× |
| webkit | sqlite | 2.85× | 1.65× |
| webkit | mariadb | 2.08× | 1.28× |

The file/file column is the closer addressing-cost control. Shared/file
changes OPcache behavior, so it measures the combined system, not pure
translation overhead. Firefox ratios carry the large ordinary-bracket
uncertainty above. Native means untranslated Wasm on the same engine.

Physical group ceilings remain 512 MiB. Node shared allocations peak at
about 318.9 MiB SQLite and 277 MiB MariaDB in both profiles. Browser file
cache can allocate substantially more (up to about 470 MiB in SQLite);
startup and resource series are retained separately from warm timings.
This is not a claim of lower memory use or universally faster cold startup.

Exact sources, complete raw results, summaries and the job log are retained
under `.context/common-memory-survey-20261111/phase4/`. Reused native, VM and
host-profile binaries were checked against their retained bytes. The run
uses Node 24.15.0, Chromium 153.0.8010.12, Firefox 155.0 and WebKit 26.6 with
default compiler settings. No candidate is promoted; the preview remains
on its frozen baseline. General platform/merge performance and canonical
image/conformance acceptance remain untested.

### Compiler and further instrumentation follow-ups

CC-04 compares ordinary Binaryen O2/O3/Os after VM rewriting. The
repository's documented post-fork optimization contract uses named catalog
bindings and permits these normal passes; closed-world/whole-program GC
type passes remain prohibited. The experiment audits exact Kandelo custom
contracts and exported names/kinds, refreshes prototype global-index report
fields, then checks actual access mechanisms, fork continuations and shared
OPcache before timing. Historical instrumentation counts remain labeled as
counts from the input transform. The build and initial correctness screen have now run; results follow below.

The normal SDK deliberately withholds scheduled Binaryen optimization from
fork-capable links to keep compiler call-graph facts valid until fork
instrumentation. PHP's extra recipe O2 pass optimizes that graph but makes
the raw facts stale. A separate supported-input comparison can measure the
tradeoff; it must retain emitted graph/frame counts, code size and startup,
not assume preserving facts alone causes a speed difference. Clang O3,
LTO and PGO remain separate candidates. The actual resource directory and
`llvm-profdata` are identified; PGO compile/link/runtime support is still
untested, and a missing producible runtime is provisioning work.

Other retained variants include cheaper 32-bit fused bounds with explicit
overflow/page guards; alternate cache placement; guarded object spans in
call-free regions; immutable root bindings; separate metadata memory; a
byte-width host snapshot using existing coalesced span copies; and
conservative physical extent reuse. These are hypotheses with distinct
correctness obligations, not measured improvements. Detailed proof sketches
and compiler input findings are retained in the campaign notes alongside
all previous failed, neutral and regressive results.


### CC-04 initial build and correctness screen

All three post-VM levels build. The first preflight found that the prototype
appends helper code without merging its SIMD/atomic/bulk-memory feature
declarations; hand-written inputs can have no target-features section.
Two failed optimizer invocations remain retained with exact script versions.
The corrected experiment declares these already-used input features to
Binaryen; it does not disable checks or enable closed-world/GC type passes.
All Kandelo custom contracts and named export kinds remain exact, except
prototype report indices refreshed from actual exports. For example the
FPM root global changes from index1780 to7, validating that named binding
and report refresh matter after ordinary optimization.

Baseline FPM is38,072,786bytes. O2/O3/Os outputs are37,916,730 /37,899,508 /
37,885,663bytes, respectively (including refreshed prototype metadata).
Smaller output is not a measured execution-speed gain. All four profiles
pass numeric/SIMD/atomic/scatter/overflow/sparse4GiB/permission/coherency
mechanisms on Node and in12 browser cases. Actual SDK fork and shared FPM
checks pass8/8 on Node; Chromium and Firefox shared FPM checks pass8/8.
WebKit baseline passes, then post-O2 crashes the page; two later cases are
not run because the matrix stops on its first failure.

The retained native report records EXC_BAD_ACCESS at0x10 and a faulting
stack through updateMatchingCachedMemoriesConcurrently, tryGrow and
growShared. This resembles the earlier control crash but is not an
established cause or outside-runtime fault attribution. No workaround,
upstream report or successful retry replaces the failed control. Compiler
performance ranking is deferred while a bounded standalone growth/lifetime
diagnostic is investigated. The exact failed inputs, result, native report
and complete logs are retained under campaign phase5/failures.

Separate tiny normal SDK probes build and execute correctly with O2, O3,
ThinLTO and full LTO; this proves basic toolchain feasibility, not PHP
performance or dependency-wide LTO. Fresh probe copies receive the normal
ABI-contract stamp and execute again without legacy-artifact warnings.
The earlier unstamped results are preserved. PGO compilation reaches a
link failure because the target libclang_rt.profile.a is absent from the
actual Clang resource directory. This is a runtime-provisioning task,
not evidence that PGO cannot work or contributes nothing. All candidates
remain cataloged; PHP rebuilds and measured compiler effects are pending.


### CC-04 follow-up: known runtime boundary and a separate control

The initial WebKit crash is no longer an unreduced outside-runtime
hypothesis. A small independent page containing only WebAssembly/Worker
APIs reproduces the same0x10/cached-memory-update stack; Chromium and
Firefox pass both diagnostic cases. The existing registry already tracks
this exact class as
[JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN](../../tests/runtime-workarounds/JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN/entry.md).
Its normal registered reproduction was rechecked on WebKit26.6/build2359
and crashes in all three attempts. This confirms the runtime boundary;
it does not prove O2 has a performance regression or that every earlier
application crash had no additional cause. No upstream report was sent.

Normal process-local instance retention covers the life of one process's
threads. A common-memory group extends backing lifetime across different
process Workers: one can end while another still grows it. A separate
`platform/build.mjs OUTPUT --pregrow-group` diagnostic profile creates the
backing at its existing maximum before any instance binds. All eight Node
fork/FPM and twelve browser FPM controls pass with that profile, including
WebKit O2/O3/Os. The original default-profile failure remains a separate
result. Omitting the flag produces six bundles byte-identical to the old
frozen profile, verified directly; the preview remains unchanged.

This control changes resources: the physical backing buffer is initially
512 MiB, while allocator-assigned pages remain about271–278MiB in short
Node shared-cache WordPress checks. Buffer length alone is not an RSS
measurement. Virtual growth, page permissions and allocation ceilings
remain checked. Future compiler comparisons hold this backing policy
constant for candidate and reference and label their scope separately from
dynamic-growth results. It is not a complete group retirement design.

The ownership audit initially exposed three prior cache-coherency fixture
constructor uses needing a reviewed exact-count allowance. The first
allowance admitted one occurrence; the final count of three now passes all
ten kernel-scratch contract tests. Both failed audit results are retained.
The registry-wide check separately fails on a pre-existing Firefox entry
referencing missing `host/src/webgl/main-forward.ts` (the same reference is
in HEAD). That unrelated registry issue is not hidden by the successful
narrowed JSC reproduction run.

Tiny PGO provisioning is progressing: the declared LLVM21.1.7 source
archive is already cached, its SHA256 matches the normal package manifest,
and compiler-rt/CMake/include sources are staged privately for a target
runtime build after the current timing work. No host runtime is substituted
and no compiler-rt capability success is claimed yet.

### CC-04 individual timing results (pre-grown backing)

The complete matched matrix passes144 fresh parents and62,784 samples, with
identical frozen Node/browser inputs. These results use the pre-grown
512 MiB common backing on both VM sides; do not pool them with previous
dynamic-growth matrices. Each pair has two reversed fresh-parent cohorts,
64 warmup rounds and7 measured rounds, ordinary/file brackets and both
OPcache configurations. All raw/cohort/cold/resource results remain retained.

Compute latency candidate/reference with shared OPcache on both sides:

| Host | Post-O2 | Post-O3 | Post-Os |
|---|---:|---:|---:|
| node | 1.002 | 0.996 | 1.072 |
| chromium | 1.005 | 1.002 | 0.998 |
| firefox | 0.919 | 1.025 | 1.016 |
| webkit | 1.008 | 1.050 | 1.051 |

Same-file-cache compute candidate/ordinary-addressing costs:

| Host | Post-O2 | Post-O3 | Post-Os |
|---|---:|---:|---:|
| node | 2.39× | 2.42× | 2.39× |
| chromium | 2.45× | 2.45× | 2.44× |
| firefox | 2.63× | 2.39× | 2.50× |
| webkit | 2.49× | 2.49× | 2.48× |

There is no consistent general warm-speed win from another ordinary
Binaryen pass alone. Node/Chromium shared compute is mostly near baseline;
Firefox O2 shared cohorts are 0.847/0.998 with ordinary compute brackets
varying up to 30%, so its aggregate 8% gain is not a stable effect size.
WebKit O3 shared compute cohorts 0.908/1.214 disagree, and Os is 0.997/1.109.
Node Os shared compute also disagrees (1.191/0.965). Retain the regressions
and cohort uncertainty rather than choosing one flag as universally best.

Some narrower signals remain worth preserving: Firefox O2 file-cache
compute cohorts 0.948/0.951 improve, but file-cache includes regress 1.033/1.056.
Firefox Os file-cache includes improve 0.947/0.955 while its shared-cache
version is mixed. Chromium Os shared includes improve 0.988/0.986, a small
operation-specific result. WebKit O2 shared includes 0.991/0.856 is much less
consistent than its aggregate suggests. Empty-request ordinary brackets
reach 1.88× in Chromium; sub-millisecond effects need particular caution.

Native means untranslated Wasm on the same engine. Shared/native ratios
include OPcache-model differences and cannot isolate address translation.
The smaller modules and these warm measurements do not establish a uniform
startup or memory benefit. Complete cold/ready/resource series and ordinary
envelopes remain in phase5/fpm-timings/summary.json. This screen does not
measure real WordPress performance, establish optimal compiler settings or
promote a default. Clang O3/LTO/PGO remain separate application candidates.

All three compiler levels are retained, including neutral results, and are
being combined separately with small-offset fusion. Each combined candidate
will compare directly to that exact fusion reference under the same backing
policy. Neutral standalone results do not decide the combination.

### CC-03 feasibility: usable target profiling runtime

The missing profiling archive has been built privately from all 19 upstream
LLVM 21.1.7 profile-runtime sources using the normal SDK. Actual target
feature probes pass for atomics, fcntl locks, flock and uname. No shared SDK,
package cache, Linux identity or host runtime is substituted. The original
link failure remains retained; a local script's initial source-count error
is preserved separately from target capability results.

A tiny normally stamped guest program writes a usable profile. Matching
`llvm-profdata` reads the expected 1,000 loop iterations, and a separate
profile-optimized binary passes training and held-out inputs. A real
normally instrumented fork probe then passes with ordinary and virtualized
addressing. Both parent and child counters survive normal shutdown: LLVM
reads their combined 3,000 work iterations with both raw-append (`%p`) and
merged (`%m`) output modes. The inherited PID filename is shared in this
case, but contains both valid records; it is not a lost-profile result.

This establishes a working Node target profiling cycle, not a PHP speedup.
Concurrent multiworker output, actual FPM training, graceful shutdown and
held-out application timings remain pending. Exact sources, runtime archive,
programs, profiles, commands and all failed attempts are retained in phase6.
All three post-VM compiler levels combined with small-offset fusion also
pass mechanisms, real fork/FPM checks and 48 short WordPress controls across
both databases and four hosts. Their separate 144-parent warm timing matrix
is running; those short checks provide no performance ranking.

### CC-04 + VM-10: compiler levels combined with small-offset fusion

The combination matrix passes all 144 fresh parents and 62,784 samples.
Reference and candidate use the exact same fusion input and pre-grown
backing; Node/browser inputs and plans match. These are new controls, not
a comparison of unrelated prior runs. All 48 short WordPress correctness
controls pass as well, but no combined real-WordPress timing is claimed.

Compute candidate / fusion-only reference (shared OPcache on both sides):

| Host | Fusion + post-O2 | Fusion + post-O3 | Fusion + post-Os |
|---|---:|---:|---:|
| node | 0.958 | 1.030 | 0.997 |
| chromium | 1.005 | 0.960 | 0.944 |
| firefox | 1.008 | 1.022 | 0.986 |
| webkit | 0.989 | 1.049 | 1.024 |

Same-file-cache compute candidate / fusion-only reference:

| Host | Fusion + post-O2 | Fusion + post-O3 | Fusion + post-Os |
|---|---:|---:|---:|
| node | 0.934 | 0.958 | 0.949 |
| chromium | 0.983 | 1.003 | 0.997 |
| firefox | 0.950 | 1.536 | 1.040 |
| webkit | 1.007 | 0.820 | 1.018 |

Same-file-cache compute candidate / ordinary-addressing Wasm:

| Host | Fusion + post-O2 | Fusion + post-O3 | Fusion + post-Os |
|---|---:|---:|---:|
| node | 2.05× | 2.00× | 1.99× |
| chromium | 2.32× | 1.94× | 1.97× |
| firefox | 1.78× | 3.34× | 2.38× |
| webkit | 2.25× | 1.99× | 2.27× |

The clearest narrow positive signals differ by host/cache: Node O2 shared
compute cohorts are 0.959/0.958 (about 4% lower), and WebKit O3 file-cache
compute is 0.820/0.819 (about 18% lower, ordinary brackets within 1%).
Node O3 shared includes improves 0.939/0.932 while shared compute regresses
1.014/1.047. A neutral standalone compiler pass can therefore contribute in
a combination, but neither level wins every workload. These remain FPM
fixture signals needing application confirmation.

Chromium O3 and Os shared compute aggregates look positive, but their
cohorts disagree: 0.920/1.001 and 0.890/1.000. Firefox O3 file-cache compute
and includes regress sharply in one cohort: compute 1.011/2.335, includes
1.004/4.517. Those observations stay in the results; they do not establish
a stable 54% or 113% compiler regression. Firefox O2 ordinary brackets vary
by up to 3.8× for includes, further limiting native-relative interpretation.
Firefox Os file-cache compute regresses 1.040/1.039, while shared compute
improves 0.984/0.989. WebKit Os shared empty requests regress 1.224/1.206
and includes 1.029/1.190. No flag is a universal winner.

All workload, cohort, ordinary-envelope, cold/startup and resource data are
retained in phase6/fpm-timings/summary.json. Shared/native ratios change the
cache model; the file/file table above is the closer addressing-cost control.
No candidate is promoted. The original dynamic-growth WebKit failure and
all neutral/regressive individual and combined results remain retained.

### CC-01: helper Clang O3 isolated from PHP compiler flags

The helper-only comparison reproduces all five O2 baseline module hashes
exactly. O3 changes helper instructions (including local/register use) but
both helper modules remain 3,729 bytes and both FPM modules remain
38,072,786 bytes. PHP remains the original C-O2 build; no post-VM compiler
pass or scalar fusion is added. Actual fork/shared-FPM checks pass on Node
and all three browsers. Short WordPress checks pass for SQLite and MariaDB
on all four hosts; those short checks do not rank application performance.

The separate unprofiled timing screen passes 48 fresh parents and
20,928 samples, with 64 warmup rounds per control and opposite candidate/
cache order in cohort 2. It uses the same diagnostic pre-grown backing
policy as phases 5/6. Versions: Node v24.15.0, Chromium 153.0.8010.12,
Firefox 155.0 and WebKit 26.6. Native remains ordinary-addressing Wasm.

Compute medians, candidate / helper-O2 reference (lower is better):

| Host | VM/file cache | VM/shared OPcache | VM/file / ordinary/file |
|---|---:|---:|---:|
| Node | 1.077 | 1.025 | 2.65× |
| Chromium | 0.999 | 1.002 | 2.45× |
| Firefox | 1.028 | 0.970 | 2.26× |
| WebKit | 0.996 | 1.037 | 2.50× |

There is no broad helper-O3 win in this screen. Node shared compute
regresses in both cohorts (1.023/1.027), as does Node file compute
(1.038/1.117). Chromium compute is effectively unchanged. Firefox shared
compute cohorts disagree (0.851/1.105), with ordinary compute bracket
drift up to 1.27×; its aggregate is not a stable improvement. WebKit shared
compute also disagrees (0.986/1.090). A small positive WebKit shared-includes
signal survives both orders (0.981/0.986), while shared empty requests
regress slightly (1.014/1.015). Preserve both for application/combination
follow-up rather than declaring O3 universally useless or beneficial.

All empty/compute/includes timings, guest timers, ordinary envelopes,
startup, first requests and memory series are retained in
phase7/helper-timings/summary.json. Module size is unchanged; startup and
memory samples do not establish a uniform resource benefit. No candidate
is promoted, and this fixture does not measure real WordPress speed.

### CC-01: matched compiler-build controls

A separate private normal-recipe PHP C-O3 build completes. Its normal
recipe, version, dependency generations and source HEAD match the original
C-O2 build. The private recipes differ only in the CFLAGS optimization
level; normalized configure commands match and php_config.h is identical.
Dependencies, PHP C++ compilation, the explicit pre-fork Binaryen O2 pass,
normal fork preparation and its post-pass stay fixed. O2 translation
helpers stay fixed. PHP C-only O3 is not an optimized dependency closure.

Both PHP variants pass real shared-FPM checks on all four hosts and short
WordPress checks with both databases. The WordPress image's optional
extension binaries remain its original artifacts. Non-PHP mechanism/fork
probes are unchanged baseline controls; the newly compiled FPM itself
exercises actual PHP fork and shared OPcache. Correctness checks run
separately from the timing matrix.

For this compiler comparison the paired harness binds each mode to its
own ordinary-addressing FPM, with two ordinary brackets per build/cohort.
The schema 2 summary separates ordinary compiler gain, VM compiler gain,
each build's VM/ordinary ratio and their ratio of ratios. That last value
describes relative application addressing cost, including the VM adapter;
it is not a direct per-instruction translation-cost measurement. The
schema 1 plan and summaries reproduce earlier phase 5/6 results exactly.
Synthetic known-ratio controls validate schema 2 arithmetic, and duplicate,
wrong-artifact, wrong-label and unexpected-engine-flag inputs are rejected.
Synthetic numbers are validation evidence only.

The real PHP screen passes 64 fresh parents and 27,904 request samples;
with the helper screen, phase 7 totals 112 parents and 48,832 samples
including warmups (5,488 measured single/concurrent request samples).
Node/browser frozen sources, module bindings and plans match. The PHP
screen uses the same host versions and pre-grown profile as the helper
screen, runs afterward and shares no owned build/correctness jobs. Host
load is recorded; other workspaces were not controlled or guaranteed idle.

Compute medians, PHP C-O3 / C-O2 (helpers O2, lower is better):

| Host | Ordinary/file cache | VM/file cache | VM/shared OPcache | VM/file / own ordinary/file |
|---|---:|---:|---:|---:|
| Node | 1.001 | 1.106 | 1.036 | 2.61× |
| Chromium | 1.001 | 0.991 | 0.999 | 2.44× |
| Firefox | 0.912 | 1.027 | 1.080 | 2.80× |
| WebKit | 1.004 | 1.007 | 0.900 | 2.52× |

WebKit shared compute is the clearest new positive signal: cohorts
0.887/0.915, about 10% lower latency overall, with both ordinary-build
brackets within 0.8%. Its VM/shared-to-own-ordinary ratio is 2.00× versus
2.23× for O2. This changes the cache model relative to the ordinary control;
it does not establish a 10% reduction in per-access translation cost.
WebKit file compute is essentially unchanged/slightly worse and shared
empty requests regress 1.010/1.197. Thus C-O3 is a workload/cache-specific
candidate for WordPress replication, not a host-wide recommendation.

Node shared compute regresses in both orders (1.044/1.027), while ordinary
compute is unchanged with brackets below 1% drift. Node file compute and
includes also regress in both orders, but their magnitudes vary sharply:
1.191/1.027 and 1.192/1.014. Preserve the aggregates without treating 10%
as a stable regression size. Chromium file compute improves slightly in
both cohorts (0.989/0.992), while shared compute/includes are effectively
unchanged. Its shared-empty aggregate gain comes from only one cohort
(0.844/1.005) and remains inconclusive.

Firefox file compute regresses 1.023/1.032, while shared compute disagrees
(1.175/0.993). Its apparent ordinary compute gain has cohorts 0.962/0.863
and ordinary O2 bracket drift up to 1.33×; the 8.8% aggregate gain is not
established as a stable compiler benefit. The corresponding relative-cost
ratio remains reported with the bracket variation, rather than being
interpreted as a precise change in translator overhead.

The ordinary FPM grows from 37,003,204 to 37,188,724 bytes. Cold/ready,
all workload/cohort/guest-timer data, memory snapshots, artifact identities
and ordinary envelopes are retained in phase7/php-timings/summary.json.
No uniform startup/resource improvement is claimed. The original O2 build
receipt predates its explicit ABI stamp by 55 bytes; that receipt remains
unchanged and the timing binds the actual stamped module SHA. New O3
receipts are written after stamping. Both original and stamped identities
are preserved under phase7/build-controls and phase7/php-builds.

These individual screens do not settle combined helper/PHP O3 or real
WordPress performance. Both-O3, useful fusion combinations and application
replication remain in the queue even where an individual showed no win.
All 18 ideas remain cataloged; no default, shipping recipe or interactive
preview has been promoted from these experimental partial-image results.

### CC-01 combination screen and CC-03 application profiling prerequisites

PHP/helper O3 together, and both O3 factors plus small-offset fusion, are
built as separate candidates. They preserve the exact original/fusion-only
module references and each mode's matched ordinary PHP build. Four Node
mechanism controls, eight real fork/FPM controls, twelve browser mechanisms,
twelve browser FPM controls and forty short WordPress controls pass. The
latter cover both databases and four hosts; they are correctness evidence.
The separate128-parent unprofiled paired timing matrix completes; results
follow below.

While known peer builds occupied the host, a concurrent profiling mechanism
completed all eight guest controls. Two synchronized child workers each
reset/work/flush32 times. All four `%m` outputs (ordinary/VM, two repeats)
preserve exactly64 work entries and96,000 loop iterations. All four `%p`
outputs written concurrently under the inherited parent filename are corrupt
and cannot be merged. Preserve this failure alongside the readable sequential
outputs in phase6; neither observation replaces the other. No new toolchain
or POSIX defect is assigned without tracing/reduction.

A full PHP profiling build then links CLI/FPM but fails at the explicit
curl.so link with undefined `__llvm_profile_runtime` relocation. The failed
whole-package result stays failed. Its successfully linked main programs are
prepared in a fresh directory through the exact normal pre-opt/fork/stamp
steps, with an explicitly main-program-only receipt. No optional extension
output or package publication is fabricated. The image extensions remain
their original unprofiled binaries.

Actual profiled FPM collects usable3,934,032-byte `%m` profiles with both
ordinary/file and VM/shared OPcache. LLVM reads exactly eight script
executions, eight executing requests and eight completed requests in each.
The normal zero-second FPM control timeout first killed workers with143
despite master exit0. An explicit normal30-second grace setting allows
both workers and master to exit0 after SIGQUIT. That confirms profile flush
through observed worker exits and counters, rather than master success.

The first real profiled VM/shared WordPress run hits Node/V8 Zone OOM during
optimizing Wasm compilation. Its original source and full stack/log remain.
A separate training-only `--liftoff-only` run succeeds on SQLite and MariaDB,
with the flag recorded, real shared OPcache and all three FPM exits0. Normal
timing controls retain default engine settings. The standard WordPress
fixture is unchanged; normal guest dinit env-file/FPM configuration supplies
the profile filename, PID file and grace setting. A separate CLI coverage
run plus both WordPress profiles merge successfully: LLVM reads40 script,
executing-request and completed-request entries. This includes startup and
fork-inherited counters and is not a phase-reset steady-state-only profile.

The private builder now supports explicit CLI/FPM-only output scope and
applies profiling flags to actual C make rules after normal configure;
unrelated feature-probe main functions must not be treated as stale PHP
profiles. A generated-patch check preserves C++ flags. The earlier profiling
generation header is byte-identical to the ordinary O2 header. Profile-use
builds and held-out timing remain pending; there is no PHP PGO speedup claim.
Complete commands, actual profiles, counter dumps, failed package/engine/
shutdown evidence and scope/provenance notes are retained in phase8 and
phase9. All candidates remain cataloged for the later survey.

### CC-01 combined results: both Clang O3 factors, with/without VM-10

Later load audit: background build metadata shows compilation overlapping
the entire Node stage and part of the browser stage. The known heavy builds
had ended, but a later-started job was missed before launch. This matrix is
load-confounded. Preserve every number below as provisional; repeat the same
matrix in a fresh directory after the current known build, checking inventory
immediately before launch. Do not pool the original into a quiet-run claim.
Exact overlap times and the initial report remain under phase8/load-followup.md
and load-job-times.json. No candidate was promoted from these results.

All128 fresh parents and55,808 samples pass, including6,272 measured
single/concurrent request samples. Each comparison has two opposite-order
cohorts, own-build ordinary brackets and identical frozen Node/browser
inputs. Node v24.15.0, Chromium153.0.8010.12, Firefox155.0, WebKit26.6;
diagnostic pre-grown group backing as in the individual screens. Previously known
owned/peer builds and all training jobs had finished before timing began;
the later load audit above supersedes any interpretation of a quiet host.
Raw load remains recorded. The separate PGO
profile-use build starts only after the whole matrix completes.

Compute latency candidate / its exact reference, lower is better:

| Host | Both O3 / original, file | Both O3 / original, shared | Both O3 + fusion / fusion only, file | Both O3 + fusion / fusion only, shared |
|---|---:|---:|---:|---:|
| Node | 0.736 | 0.846 | 0.869 | 1.024 |
| Chromium | 0.998 | 0.999 | 0.999 | 1.002 |
| Firefox | 0.977 | 0.978 | 0.918 | 1.370 |
| WebKit | 1.003 | 0.998 | 1.245 | 0.884 |

Candidate VM/file / its own ordinary/file compute:

| Host | Both O3 | Both O3 + small fusion |
|---|---:|---:|
| Node | 2.14× | 2.61× |
| Chromium | 2.47× | 1.96× |
| Firefox | 2.73× | 2.08× |
| WebKit | 2.49× | 2.50× |

These aggregates require the cohort/native-bracket qualifications:

- Node's large apparent both-O3 gains vary sharply: file compute
  0.862/0.628, shared0.996/0.719. Ordinary compute brackets vary up to1.56×
  in that pair,2.05× in the fused pair; empty brackets reach3.24×. Do not
  promote the aggregate as a stable15–26% improvement or a precise
  addressing-overhead estimate. Both-O3+fusion shared compute regresses
  1.023/1.025 and shared includes1.043/1.047; retain these smaller consistent
  directions alongside the noisy file-cache results.
- Chromium compute is effectively unchanged in both comparisons, with
  ordinary compute drift at most2%. Both-O3 file includes has one positive
  cohort (0.993/0.835); fused shared-empty likewise has a one-cohort
  regression (1.159/1.000). Ordinary empty brackets approach2×. These do
  not make either compiler combination a uniform winner.
- Firefox both-O3 file compute improves slightly in both orders
  (0.967/0.987), but file empty/includes regress1.081/1.042 and1.072/1.009.
  Shared compute disagrees0.907/1.055. The fused combination's shared
  empty/compute/includes all regress, heavily in one cohort: compute
  1.810/1.036 and includes2.273/1.094. Preserve the failures without calling
  37% or58% a stable regression size. Ordinary compute drift up to1.32×
  also limits native-relative interpretations.
- WebKit both-O3 shared compute is inconclusive (0.920/1.084); the PHP-only
  O3 gain therefore does not establish a both-O3 gain. Adding both O3
  factors to fusion regresses file compute in both orders1.215/1.275,
  with ordinary compute brackets within4.5% and ordinary compiler effect
  near1.00×. Its apparent shared compute gain is confined to one order
  (1.004/0.779), so the0.884 aggregate is not a stable improvement. Shared
  empty also regresses slightly1.015/1.015; file includes1.015/1.086.

All candidate/reference/own-native ratios, guest timers, individual brackets,
empty/compute/includes data, startup/first requests and memory snapshots
remain under phase8/fpm-timings. No consistent startup/resource benefit or
real WordPress speedup is claimed. Code size grows: both-O3 FPM38,274,635
bytes; both-O3+fusion38,306,694, versus38,072,786 original and38,104,734
fusion-only. These combinations are retained despite weak or regressive
signals. They show why individual flag results cannot simply be multiplied
into a promised application gain. No defaults or preview are changed.

### CC-03 profile-use and VM-06/10 bound-form checkpoints

The main-program profile-use build succeeds with stale and unprofiled
diagnostics as errors, normal configure/header controls and unchanged
dependencies/C++/image extensions. Stamped FPM is 36,635,878 bytes, about 1%
smaller than original O2. That is not a speedup or resource-use claim.
PGO alone and PGO+small fusion pass three actual PHP CLI fork/isolation
checks, all-host shared-FPM controls and 40 short WordPress checks. Their
unprofiled own-build ordinary/VM timing remains pending; there is no PGO
application benefit claim yet. Complete build, profiles, modules, control
identity and checks are retained in phase9.

A separate guarded-i32 bound variant now passes mechanisms, real fork/FPM
and 32 short WordPress controls on all four hosts. It rejects pointer-add
wrap and checks page index/width on the one-page fused path, retaining full
split fallback and permissions. It supports the exact 4 GiB endpoint. This
is a bounds subexperiment; the original proved-alignment idea remains
planned. The new translator reproduces all ten original baseline/fusion
module hashes exactly, preserving the default i64 form. Full-offset
mechanism controls, invalid-option rejections and valid-PTE-beyond-limit
negative controls pass. ABI check and 10/10 kernel ownership tests pass.
The FPM module is only 483 bytes smaller; performance is unmeasured. Sources,
proof scope and all results remain in phase10.

The next timing batch is the load-qualified O3 combination repeat, separate
PGO individual/fusion controls and this bounds comparison. Check known
background jobs immediately before launch and preserve later overlap
evidence; none of the compiler combinations is an established universal
winner. Guarded spans, provenance/escape analysis, stack/arena alternatives,
LTO, metadata/cache placements, byte snapshots, cache policy and reuse all
remain in the catalog and retained follow-up notes.

### ARCH-01 two-memory feasibility checkpoint

A synthetic WAT module imports a per-instance private memory and a common
shared memory. Explicit private accesses use ordinary Wasm loads/stores;
generic pointers select an import using a high-bit tag. This is a feature
and alias mechanism test, with no PHP, normal SDK C generation or real
Kandelo fork. Its explicit JavaScript private-byte copy preserves canonical
private/shared pointer values; child private writes remain isolated while
shared writes and atomics remain visible across both instances. Native
bounds, independent private growth, common shared growth and declared
maximum failures pass. The synthetic address convention does not establish
generic mmap/mprotect/remap semantics or a production ABI.

Node24.15.0, Chromium153.0.8010.12, Firefox155.0 and WebKit26.6 all pass
with default engine flags. Browser pages report cross-origin isolation and
no page errors. Every memory/instance lives inside a disposable Worker;
parents receive only diagnostic values. The three memories each declare a
four-page maximum, totaling786,432 bytes of reservation, with393,216 initial
and524,288 final backing bytes. These are buffer sizes, not RSS measurements.

The retained negative control imports the **same Memory object** at both
indices. All four engines accept it and observe the alias. Consequently,
separate import indices alone do not establish disjoint storage or justify
metadata-load hoisting. Any later compiler experiment must preserve this
case or establish a separate admission invariant before relying on it.

The first compile attempt failed on the symbolic atomic memory operand;
the exact failed WAT and compiler log remain retained. An explicit memory
index1 compiles and validates. This fixture correction is not assigned to
an outside compiler defect. Successful source/module/results and the failed
attempt are retained under phase11. This establishes feasibility only;
normal SDK code generation, real fork/worker binding, generic mapping and
permission semantics, shared allocation and PHP/WordPress testing remain
pending. No timing or application speedup is claimed for ARCH-01.

### CC-01 combination repeat

The fresh paired repeat validates all128 parents and55,808 samples, with
the same frozen modules, normal engine flags, own-build ordinary brackets
and reversed pair/cache order. The immediate job inventory at14:38:52UTC
showed no other registered CPU job; final load qualification for the
serialized batch remains pending. The original load-confounded phase8 run
remains separate and unchanged; neither pooling nor favorable selection
is appropriate. Complete repeat data will be retained under phase12.

Compute candidate/reference latency, lower is better:

| Host | Both O3 / original, file | Both O3 / original, shared | Both O3 + fusion / fusion only, file | Both O3 + fusion / fusion only, shared |
|---|---:|---:|---:|---:|
| Node | 1.010 | 1.003 | 1.077 | 1.008 |
| Chromium | 0.999 | 1.002 | 1.003 | 0.940 |
| Firefox | 1.011 | 1.044 | 0.942 | 1.040 |
| WebKit | 1.013 | 1.052 | 1.115 | 0.977 |

The original large Node both-O3 gains do not repeat. Node fused-file
1.077 varies1.008/1.151; fused-shared1.025/0.990 disagrees. Its both-O3
shared-includes result improves0.949/0.971, a workload-specific follow-up
signal. Chromium both-O3 compute stays close to1.00; fused shared0.940
varies0.891/0.992, so this is not a stable6% gain. Firefox both-O3 shared
compute regresses1.019/1.070; fused file improves0.974/0.911 while shared
disagrees1.138/0.951. WebKit both-O3 shared disagrees1.120/0.988. Its fused
file result1.269/0.980 is less consistent than the original1.215/1.275
regression; retain both rather than erase the regression or promise a fixed
size. Fused shared1.000/0.955 is a weak variable signal.

Candidate VM/file compute / its own ordinary/file compute is2.43/2.08×
for Node (both-O3 / both-O3-fused),2.44/1.96× Chromium,2.46/1.99× Firefox
and2.28/2.51× WebKit. These are application ratios, not isolated per-load
costs. Native brackets remain material: WebKit both-O3 ordinary compute
drift reaches1.529× and Firefox reference compute1.247×; empty brackets
reach1.89×. All native compiler/addressing ratios, empty/includes results,
cold costs and memory snapshots remain in the full result. This repeat
does not establish an optimal compiler configuration, resource benefit or
real WordPress speedup. No defaults or preview are changed.

### CC-03 matched-native unprofiled FPM timing

All128 parents and55,808 samples validate using normal engine flags,
the strict profile-use main programs, own-build ordinary controls and both
orders. This is the held-out empty/compute/includes fixture; training used
WordPress/frontend/admin/login/REST/cache status plus CLI coverage. Final
batch load audit remains pending. Raw data and full result will be retained
under phase13; phase9 retains all earlier failures and training provenance.

Compute latency candidate/reference, lower is better. PGO alone references
original; PGO+small fusion references fusion-only:

| Host | PGO file | PGO shared | PGO + fusion file | PGO + fusion shared |
|---|---:|---:|---:|---:|
| Node | 0.972 | 0.979 | 0.952 | 1.012 |
| Chromium | 1.005 | 0.993 | 0.990 | 1.007 |
| Firefox | 0.969 | 1.046 | 0.991 | 1.009 |
| WebKit | 0.991 | 0.904 | 0.885 | 0.987 |

WebKit PGO/shared compute0.896/0.913 is the clearest follow-up signal:
about9.6% lower latency, ordinary compiler ratio0.998 and ordinary brackets
within0.7%. Its shared-includes1.029/0.991 and file-compute1.009/0.974 do
not establish the same gain. With fusion, shared compute0.989/0.986 is only
about1.3% lower; file0.997/0.786 confines the large aggregate gain to one
order. Training and this screen do not establish real WordPress benefit.

Node file compute varies0.997/0.948 for PGO and1.013/0.895 with fusion;
both shared comparisons disagree. PGO shared-empty1.071/1.015 and includes
1.016/1.007 regress. Chromium compute stays near1.00; its large aggregate
shared-empty gains shrink towards neutral in the second order. Firefox PGO
file compute1.025/0.917 disagrees and shared1.095/1.000 gives no repeated
gain. Includes regresses in both caches (file1.057/1.010,shared1.018/1.018);
fused shared compute1.005/1.014 is a small repeated regression. Firefox
ordinary compute brackets reach1.387× and Chromium empty1.933×, limiting
interpretation even without known build overlap at launch.

Candidate VM/file compute / its own ordinary/file is2.35/2.13× Node
(PGO / PGO+fusion),2.45/1.96× Chromium,2.43/2.18× Firefox and2.49/2.19×
WebKit. These remain application ratios; file/shared cache differences are
not isolated address-translation costs. Cold costs, guest timers, concurrent
requests and all memory snapshots remain retained. No broad performance,
resource or optimal-profile claim is made; the explicit main-program-only
build scope and unchanged image extensions remain in force.

### VM-06/10 guarded-i32 bounds timing

All48 parents and20,928 samples validate against the exact small-fusion
i64 reference, fixing original PHP/helper compiler settings. This measures
the bound form, not alignment proof or full-offset PHP fusion. Compute
latency candidate/reference, lower is better:

| Host | File | Shared |
|---|---:|---:|
| Node | 0.912 | 1.013 |
| Chromium | 1.016 | 1.060 |
| Firefox | 1.055 | 0.896 |
| WebKit | 1.008 | 0.993 |

Firefox shared compute0.897/0.895 is a repeated10.4% lower-latency signal,
but file compute regresses1.051/1.059 and file includes1.044/1.060. Ordinary
compute drift reaches1.319×, limiting native-relative inference. Node file
compute0.839/0.992 puts most of its aggregate gain in one order; shared
compute1.002/1.023 and includes1.088/1.014 regress. Chromium shared compute
1.119/1.004 and includes1.223/1.004 put most regression in one order;
file includes improves slightly0.996/0.989. WebKit shared compute0.989/0.996
is a small signal, file compute0.982/1.036 disagrees, and file includes
1.005/1.010 regresses slightly. This is not a uniform improvement.

Candidate VM/file compute / ordinary/file is2.06× Node,2.00× Chromium,
2.23× Firefox and2.25× WebKit. The complete phase14 result retains all
guest timers, cold costs and memory snapshots. The default i64 form and
all earlier results remain available; no alignment inference is introduced.

### Serialized batch load qualification and concurrent requests

Job common-memory-survey-quiet-timings-1111-093852-d9eb finishes successfully
after17m55s:304 fresh parents,132,544 samples including warmup and14,896
measured single/concurrent requests. Frozen inputs match within each matrix
and all three summaries validate complete inventories, actual artifact
bindings, shutdown, flags and diagnostics. No other registered build/test
job starts during14:38:52–14:56:47UTC. The immediately preceding peer runs
finished before launch; the next peer host suite starts14:58:13UTC.
Recorded one-minute load ranges are2.15–5.34 for the O3 repeat,2.24–3.96
for PGO and2.20–3.29 for bounds on this18-CPU host. This is not exclusive
host reservation or proof against unregistered activity. Historical registry
entries without terminal receipts remain explicitly unknown in the load
receipt; no newly registered CPU overlap was found. Initial/final inventory,
UTC stages, raw load and final job receipt are retained.

An additional analyzer reproduces each strict summary exactly, then checks
all4,256 two-request batches (seven rounds per workload, two distinct FPM
worker PIDs, rate/elapsed agreement). This is concurrent batch completion
latency, not a saturation throughput claim. Full same-cache and own-native
ratios/cohorts remain in phases12–14/concurrent-summary.json and reports.
The individual latency signals are not uniformly reproduced under concurrency:

- PGO WebKit shared compute is0.945, with1.009/0.886 cohorts, rather than
  the repeated single-request9.6% gain. PGO+fusion shared compute is0.972
  (0.994/0.950). Chromium PGO shared compute is0.967 (0.964/0.970), while
  fused shared includes is0.927 (0.899/0.955) with file-includes regression
  1.036 (1.051/1.021). Node PGO compute regresses in both caches; fused
  shared compute1.025/1.036 and includes1.042/1.023 regress.
- Bounds Firefox shared compute is0.974 (1.011/0.939), weakening its
  single-request signal; shared includes regresses1.083/1.012. Chromium
  shared includes regresses1.130/1.114. WebKit shared compute regresses
  slightly1.015/1.009 despite its small single-request gain.
- Both-O3 WebKit concurrent compute regresses in both caches: file
  1.033/1.026 and shared1.047/1.069. O3+fusion Node file compute improves
  0.916/0.992 despite its single-request regression; its shared result
  disagrees1.042/0.987. All contradictory outcomes remain evidence.

These screens establish follow-up candidates and tradeoffs. They do not
establish real WordPress speedups or whole-platform acceptance. Small-offset
fusion remains the earlier broader signal; PGO/WebKit and bounds/Firefox
deserve application follow-up without discarding their mixed and negative
results. VM-04 guarded regions and the other cataloged ideas remain next.

### VM-04 automatic object-function proof checkpoint

The first automatic span pass selects whole straight-line, call-free i32
functions whose memory addresses are the exact value of one unchanged local
plus constant memarg offsets. It requires at least two accesses, with a
64KiB span,16KiB body and256-operator budget. It rejects unknown effects,
calls, control flow, base mutation, atomics, memory-derived addresses,
multiple bases and other types. This deliberately bounded proof is not
general object, stack-frame, loop or provenance analysis; those follow-ups
remain cataloged. It selects139 PHP functions with349 static access sites.
Their dynamic frequency and application value remain unmeasured.

A private freestanding `vm_try_span` helper checks virtual/physical bounds,
union permissions and contiguous backing, including cross-page objects,
without trapping or reading payload. Success selects one cloned raw-access
body; failure runs the original translated sequence, preserving the visible
store prefix before a later fault. Only each proved address operand changes;
stored/compared pointer values remain canonical. Physical locals are created
on each entry and cannot cross a call or replay edge in the selected body.
Original source function/global indices and fork bindings stay unchanged.

The proof depends on the existing experimental allocation/mapping contract:
root/PTE/scratch allocations remain distinct from payload, physical extents
are monotonic, and mapping updates happen while the process's sole Worker
is stopped. Current create/grow/mmap/fork paths allocate fresh payload or
preserve payload PTEs; they do not expose metadata pages as guest mappings.
Reuse, concurrent mapping changes or a broader replay region needs a new
proof. This remains trusted opt-in common-memory experimentation, not an
arbitrary-module isolation claim or production ABI admission.

The new option requires its matching private guard helper and rejects
mismatched/duplicate options. All ten baseline/fusion module hashes
reproduce exactly. After adding a read-only export-index diagnostic, the
current translator reproduces baseline and guarded FPM hashes again. Node
and12 browser mechanism controls pass; additional write-only/alias controls
are being checked separately. Shared-FPM controls pass in Node and all
three engines, and the source ownership audit passes10/10. ABI snapshot and
supported baseline checks pass. The new raw helper instance is reviewed as
non-kernel authority over a fixed8MiB fixture backing in a disposable browser
Worker; no process/kernel memory reaches its parent.

An additional C fixture builds through the normal SDK, fork instrumenter
and ABI stamp. Its exported object callees (original indices58/59) are
verified selected, then actually execute after fork. Four VM modes plus
ordinary-memory negative controls pass in Node; all15 browser controls
pass after a fixture callback correction. Private isolation, live shared
fields, canonical pointers and reentry after fixed replacement, protection,
remap and unmap are checked. These supplement the explicit synthetic copy.

Two failures remain evidence. The first SDK fixture driver failed only at
its export-inspection step after successful link/fork/stamp; `wasm-objdump`
reported type-decoding errors. The successful driver uses the translator's
own validating parser; no outside defect is assigned. The first browser
fixture used Node's `(pid,data)` output callback shape; browser callbacks
take `data`, so12 successful guest exits failed marker assertions. All raw
failures and exact original fixture source are retained; the corrected
fixture joins byte output and passes15/15. WordPress correctness and paired
timings remain pending. No speedup or broad platform acceptance is claimed.

Follow-up: the final write-only/aliased-page mechanism controls pass on all
four hosts, and the final source ownership audit passes10/10. All40 short
WordPress controls pass (10 Node,30 browser; both SQLite and MariaDB,
ordinary/file plus four VM/shared modes), including frontend/article/admin/
REST and real OPcache checks. These short concurrent correctness runs are
not used for timing rankings. FPM adds18,051 bytes over each exact reference:
guarded38,090,837 bytes, guarded+fusion38,122,785. Static selection covers
349 of911,550 rewritten memory-operation sites; dynamic importance is not
inferred from that count. Phase15 retains sources, modules, exact failures,
raw checks and proof scope. The96-parent paired FPM screen is prepared for
guard/original and guard+fusion/fusion-only, but has not launched: peer
full-memory and control-products jobs were still running at the immediate
inventory. Preserve a quiet launch and later overlap evidence instead of
timing during that known load. Broader regions, types and proofs remain
planned even if this first narrow implementation has no application gain.

### VM-05 host byte-snapshot mechanism and application use

A private `--byte-slices` host profile preserves the existing adapter's
constructor/from/subarray reference and call order, including argument
conversions. It can replace per-element proxy iteration with the existing
coalesced read body for returned Uint8/Int8/clamped subviews of at least256
elements. It checks genuine private brands, data fields, iteration and
mapping methods, relevant intrinsics and backing identity without invoking
new user getters. Custom/changed methods, unsupported widths and smaller
views fall back. Constructor/from getters returning unchanged native methods
can still be observed normally before a bulk copy. A public `read` override
is not called: the original slice never used that public method either.
Startup assumes standard profile-realm intrinsics, with later customization
checked. This preserves the existing experimental adapter contract, not a
claim of full native TypedArray emulation.

Brand bookkeeping uses identity tokens without original buffer/memory/
backing references, so replacing configurable public fields does not pin
the old address space through the new records. Returned bytes use independent
plain storage. Wider typed elements keep the original path and their separate
NoTear/NaN questions. Mapping/coalescing remains under the existing stopped
single-Worker address-space contract; this is not an atomic payload snapshot.
The first functional smoke used an earlier bookkeeping draft; that source
and result are retained, followed by the token-based version before any
application profile was built. No reclamation or resource benefit is claimed.

All43 baseline/candidate mechanism cases pass on Node24.15.0,
Chromium153.0.8010.12, Firefox155.0 and WebKit26.6. They cover callback order
and counts, mutation during conversion, generator/array iteration, constructor
changes, custom spans/Reflect/Number/Math/backing getters, unused overrides,
small/wide fallback, scatter/aliases/denials, stale buffers and independent
byte output. Each run records16 bulk attempts and27 fallback calls; a denied
later-page attempt still counts as an attempt. The two fixed8MiB backings
stay in the disposable browser Worker; only diagnostic values reach its
parent. Initial32-case results/source remain separate from the43-case run.

All six feature-off host bundles reproduce the frozen baseline exactly;
all six unprofiled candidate bundles also reproduce after adding the later
diagnostics-only option. Default `memory.mjs` is untouched. Real fork,
canonical private/shared fields, mapping reentry and shared FPM checks pass
with the candidate, including guard/fusion combinations. All40 short
WordPress checks pass across both databases and all four hosts. Source
ownership passes10/10, including reviewed intrinsic-prototype captures.
These short busy-host runs are correctness evidence, not performance rankings.

Separate diagnostic profiles expose plain kernel-Worker byte-slice attempt
counters via the existing stats response. Process Workers are excluded.
The initial, superseded profile recorded these after-login to one-request-round bulk attempts:

| Host | SQLite | MariaDB |
|---|---:|---:|
| Node | 1,751 | 1,257 |
| Chromium | 1,751 | 1,258 |
| Firefox | 1,751 | 1,258 |
| WebKit | 1,750 | 1,258 |

All ordinary-addressing controls report zero. Node's fallback deltas are
11,976/10,986 respectively. Counts include startup before the first snapshot
and are not reset; the table uses the difference between two recorded phases.
They establish actual application use of this component, not byte volumes,
whole-process coverage or saved time. Diagnostic request latencies are not
ranked. The timing manifest builder rejects counter-enabled profiles.

The paired harness now supports frozen per-mode host profiles and their
declared bundle identities, requiring each mode's own ordinary brackets.
Routing and stale/missing/bad binding controls pass; old schema1/schema2
summary objects reproduce exactly. A validation-only fixture adds truthful
original-profile annotations to copied older PGO observations to exercise
the analyzer, with deliberately corrupted metadata negative controls.
It is explicitly not new timing data. The128-parent VM-05 individual/fusion
screen is provisioned alongside the still-pending96-parent VM-04 screen.
Neither has launched during known peer CPU work. Source, bundle identities,
all raw checks, counter runs and provenance remain retained for the survey.
Guest loop-span/SIMD transformation, threshold/brand-cost variants and broader
span/provenance ideas remain planned even if this host candidate is neutral.


Follow-up: an explicit constructibility probe caught an API-shape change in
that first candidate. The original class method rejects `new` before entering
the body; the replacement ordinary function had its own prototype and ran a
`from` getter before throwing. The corrected object-method replacement keeps
nonconstructibility, name, arity and descriptor shape. The failed probe,
exact original source and superseded profiles remain evidence. No timing was
run on either superseded profile. Current candidate/diagnostic profiles are
`byte-profile-candidate-2`/`byte-profile-diagnostic-2`; timing uses
`byte-variants-2` and rejects diagnostics.

All44 mechanism cases now pass on all four hosts, with the same16 bulk and27
fallback decisions (constructor rejection does not enter the body). The
corrected profile also passes8 Node platform/FPM controls,12 browser FPM
controls,5 Node and15 browser selected-callee real-fork controls, and40
WordPress checks. The final source ownership audit passes10/10. The corrected
WordPress job succeeded in7m48s; these short checks remain correctness evidence.

Corrected diagnostic runs also pass:3 Node and12 browser controls. Their
kernel-Worker-only after-login to warm-round deltas are:

| Host | SQLite bulk / fallback | MariaDB bulk / fallback |
|---|---:|---:|
| Node | 1,752 / 11,983 | 1,258 / 10,992 |
| Chromium | 1,751 / 11,976 | 1,258 / 10,992 |
| Firefox | 1,752 / 11,983 | 1,259 / 11,000 |
| WebKit | 1,730 / 11,949 | 1,334 / 11,074 |

All seven ordinary controls remain zero. Counts vary with actual IO and
worker delivery, so these observations establish application use, not
cross-engine performance or time saved. Prior counts are retained above.
Current per-profile routing freezes both profiles, maps128 parents (32 per
host), brackets each mode with its own ordinary controls, and rejects stale,
missing or mismatched bindings. Empty/missing-binding analyzer negatives also
pass; three legacy summary objects still reproduce exactly. Uninstrumented
VM-04/VM-05 timing remains pending during known peer browser work.


### VM-04 / VM-05 first paired timing: load-confounded, retained

The serialized job succeeded in14m26s:96 object-guard parents/41,856 samples
and128 byte-profile parents/55,808 samples. Strict sequential inventory,
artifact/source identity, both order cohorts, ordinary brackets, guest
checksums, OPcache mode and teardown checks pass. The new per-profile
ordinary controls completed on all four hosts with frozen identities.
These are FPM compute/includes fixture observations, not WordPress timings.

A peer benchmark started11seconds after our quiet launch inventory. Mid-run
and exact-wait receipts show full benchmark suites plus CPU-heavy provisioning
throughout the run; two shorter peer build/browser checks also overlap.
The screens were designated load-confounded before inspecting timing values.
One-minute load ranges were2.061–6.097 for guards and4.665–7.693 for bytes.
Byte-profile Firefox ordinary includes brackets differ by up to7.044x.
No established speedup, regression magnitude or default-promotion decision
follows from these screens. Keep them separate from any quiet repeat.

Below, ratios are candidate/reference latency, geometric means of the two
cohort median ratios; lower favors candidate. Each combined candidate uses
fusion-only as its reference. All cohort values, startup/memory observations
and ordinary ratios are retained in phase17/observations.json and raw runs.

| Host | Guard mode | Compute file | Compute shared | Includes file | Includes shared |
|---|---|---:|---:|---:|---:|
| node | object-guard | 1.220 | 0.947 | 1.328 | 0.901 |
| node | object-guard-fused | 0.991 | 0.953 | 1.033 | 0.962 |
| chromium | object-guard | 0.909 | 0.992 | 0.980 | 0.993 |
| chromium | object-guard-fused | 0.947 | 1.120 | 0.921 | 1.075 |
| firefox | object-guard | 0.986 | 0.920 | 0.977 | 0.782 |
| firefox | object-guard-fused | 0.921 | 0.983 | 0.916 | 1.093 |
| webkit | object-guard | 0.995 | 0.989 | 0.984 | 1.018 |
| webkit | object-guard-fused | 1.015 | 1.015 | 0.987 | 1.000 |

The narrow guard has no clear general signal in this busy screen. It selects
only349 static sites; dynamic guard frequency/hit rate remains unmeasured.
Broader affine/stack/basic-block proofs stay planned. Do not infer absence
of application value from this first static coverage or mixed timing.

Strict two-worker concurrent analysis rejects the guard matrix: one Firefox
object-guard/vm-file, cohort1/order3, compute round5 batch has PIDs[102,102].
All requests passed semantic checks, but this pair used one worker. The
analyzer remains strict, and no complete two-worker guard summary is emitted.
Both workers being warm and serving some timed requests does not guarantee
that each Promise.all pair uses both. Preserve this scheduling limitation;
future throughput work must prove actual worker participation, not retry
until a favorable result or insert an unreported timing sleep.

The byte-profile matrix passes the stricter analysis for all1,792 two-worker
batches. Shared-cache observations, still load-confounded:

| Host | Byte mode | Compute / ref | Includes / ref | Includes batch / ref | Compute / own ordinary | Includes / own ordinary |
|---|---|---:|---:|---:|---:|---:|
| node | byte-slices | 0.831 | 0.761 | 0.733 | 2.318 | 0.372 |
| node | byte-slices-fused | 0.831 | 0.720 | 0.677 | 1.935 | 0.386 |
| chromium | byte-slices | 0.987 | 0.668 | 0.747 | 2.417 | 0.312 |
| chromium | byte-slices-fused | 0.892 | 0.699 | 0.726 | 1.961 | 0.309 |
| firefox | byte-slices | 0.897 | 0.880 | 0.763 | 1.248 | 0.230 |
| firefox | byte-slices-fused | 0.972 | 0.988 | 0.788 | 1.739 | 0.369 |
| webkit | byte-slices | 0.895 | 0.696 | 0.719 | 1.507 | 0.235 |
| webkit | byte-slices-fused | 0.805 | 0.845 | 0.738 | 1.486 | 0.319 |

Ordinary means untranslated Wasm on that engine, with the same original
PHP/helper C-O2 and file-backed OPcache. Shared/ordinary ratios also include
the cache-mode difference; they do not isolate translation cost. The byte
candidate and its reference use identical guest Wasm, differing only in
their frozen host profiles. Diagnostic counters are disabled in these runs.

Byte copies are a promising quiet-repeat priority, especially shared includes,
rather than an established gain. Negative observations remain: Firefox
file-cache includes ratios are1.196 standalone and1.152 with fusion;
two-request ratios are1.073/1.074. Some cohort results reverse direction.
Combined effects are not uniformly additive. No broad compiler-optimality,
WordPress speedup or memory-reclamation claim is made.

All shared-mode resource snapshots retain the536,870,912-byte group buffer/
ceiling and151,191,552-byte allocated extent count; kernel page counts are
also retained. These logical counters are not RSS or reclamation evidence.
Listener-ready/first-request values vary under the same load and remain
raw observations, not a startup improvement claim.

Phase17 retains the two full matrices, strict concurrent failure and offending
batch, byte concurrent report, full cohort/native/resource data, source
closure, stage clocks and overlap receipts. Next: quiet replication with
fresh outputs once the known peer CPU job is terminal; do independent LTO
or stack/provenance feasibility work if peer work continues. Preserve every
earlier version, failed probe, neutral idea and negative observation.


### CC-02 LTO: multi-file fork, jump lowering and retained PHP failures

A three-translation-unit SDK fixture compares ordinary O2, full LTO and
ThinLTO, each directly after link and after the normal PHP-like pre-fork
Binaryen O2 stage. A volatile runtime-selected callback table retains real
indirect calls. A non-inlined bridge keeps a C frame, canonical heap/stack/
function pointers and values live across the callback fork; child/parent
private state is checked. A raw atomic publish/acknowledge handshake proves
shared bytes while both processes live, before pipe/exit synchronization.
The ordinary separate-memory negative times out the handshake and reaps its
child before returning26. This is a mechanism fixture, not application timing.

The first corrected fork-only fixture passes96 controls (24 each on Node,
Chromium, Firefox and WebKit). The stronger final version keeps a real
setjmp context active across fork and uses longjmp in both resulting processes.
With the three LTO-backend settings below it also passes96 controls, including
24 ordinary live-sharing negatives. All artifact identities, output/error
channels and host teardown checks are verified. Full/ThinLTO emitted code
differs; equal rounded byte counts do not imply identical modules.

Three earlier fixture mistakes remain evidence: an unsupported wasm-dis
--enable-all inspection option; treating current post-reaping root counts as
historical fork counts; and observing shared bytes after pipe I/O/child exit.
That last probe let ordinary memory pass because mappings synchronize at
syscall boundaries. The final atomic handshake removes that false live-sharing
proof. Earlier sources/results are retained, with no outside runtime blamed.

Actual main-program PHP full-LTO and ThinLTO builds were attempted separately
with PHP C-O2, original dependencies/C++ and the normal pre-fork Binaryen/fork
stages. Both fail at CLI link with undefined setjmp/longjmp: full after4m01s,
Thin after3m26s. Neither receipt is complete; no FPM artifact or timing can be
claimed from these builds. Raw logs, exact private builder/recipe, configure/
Makefile/header inputs and representative bitcode remain retained.

Adding an active jump context to the small fixture reproduces both naive
LTO link failures. LLD must receive the backend settings that an ordinary
SDK frontend compile already supplies. Two settings fix the unresolved symbols
but still emit an uncaught throw without a catch path; Node and Chromium
execution fails. The complete tested LTO-link configuration is:

```text
-Wl,--mllvm=-wasm-enable-sjlj
-Wl,--mllvm=-wasm-use-legacy-eh=false
-Wl,--mllvm=-exception-model=wasm
```

The two-flag failed module has zero try_table sites. With the Wasm exception
model explicitly passed, the stronger all-host fixture passes. This is a
compiler/backend configuration finding, not a confirmed LLVM runtime defect.
Normal SDK/default recipes are unchanged. The private PHP builder now applies
these flags to EXTRA_LDFLAGS_PROGRAM after normal configure; -flto=full/thin
goes to CFLAGS_CLEAN. The actual generated patch executes on a copied normal
Makefile and changes only the program-link flags; both CLI/FPM consume them.
Fresh PHP builds with this correction have not yet run.

Final stronger fixture sizes (bytes; not PHP sizes or performance estimates):

| Compiler / preparation | Ordinary | Virtualized | Facts hash matches | Analysis |
|---|---:|---:|---|---|
| none-raw | 53,168 | 66,734 | True | facts |
| none-preopt | 52,211 | 69,420 | False | builtin |
| full-raw | 53,095 | 66,842 | True | facts |
| full-preopt | 52,357 | 69,808 | False | builtin |
| thin-raw | 53,095 | 66,842 | True | facts |
| thin-preopt | 52,357 | 69,808 | False | builtin |

Raw fixtures use compiler facts; pre-optimized fixtures reject their stale
code binding and use the existing fallback, exactly as the normal PHP stage
requires. Passing this small raw-LTO example does not prove that arbitrary
pre-LTO per-function facts describe every post-LTO transformation. No new
raw-facts PHP experiment or bypass of the pre-fork optimization is introduced.

Source ownership passes10/10 twice (162.45s and145.64s); authority-facing
runner sources are unchanged since the final audit. No raw guest memory is
sent to persistent browser realms; the existing pre-grown diagnostic profile
is reused. Evidence uses the existing partial shell plus PHP image, SHA256
49344009c1a09b654a035ac62e4084ee103e1b19040c7ec61cb5ed22a2d52073.
Canonical images and whole-platform acceptance were not rebuilt/run.

Next: fresh full/ThinLTO PHP builds with the verified backend configuration,
then translated CLI/FPM correctness, WordPress checks and matched ordinary/
VM timing. build-lto-variants.py prepares LTO alone and with small fusion,
requiring complete corrected build receipts, exact original references and
matching normalized configure/header inputs; that application manifest has
not yet been produced. LTO+PGO, C++/dependency-wide LTO and all prior candidates
remain cataloged for later characterization, regardless of these failures.
No LTO speedup, optimal compiler setting or default-runtime support is claimed.


### VM-04 / VM-05 repeat: overlap and slow Firefox controls

A fresh repeat runs byte profiles before object guards, with the same frozen
manifests/modules/profiles/ordinary controls as phase17. No source edits or
owned CPU builds/tests occur during timing. It succeeds14m47s:128 byte
parents/55,808 samples and96 guard parents/41,856 samples. Strict sequential
inventory/artifact/control checks pass. All1,792 byte and1,344 guard two-request
batches also use two PIDs and pass strict concurrent analysis. The first
guard screen's same-worker failure remains separate; no samples were filtered.

A package build starts in the inventory/start race, one second before ours.
Later builds, regressions and short isolation tests also overlap. Byte load
range3.981–18.167; guard4.063–14.840. These are observations with recorded
workload, not wholly quiet replications. Exact registry timestamps and full
bracket/control intervals are retained. Older records lacking terminal
receipts are potential overlaps, not proof those jobs remain live. Known idle
previews are separate; absence of registered work does not prove an idle OS.

Ratios below are geometric means of the two cohort median latency ratios;
lower favors the candidate. Combined modes use fusion-only as reference.
All cohorts, own ordinary/native ratios, guest-wall timers and resource
fields remain in phase19/observations.json. Prior screen values are not pooled.

| Host | Byte mode | Shared compute / ref | Shared includes / ref | Shared includes batch / ref | File includes / ref |
|---|---|---:|---:|---:|---:|
| node | byte-slices | 0.854 | 0.730 | 0.681 | 1.052 |
| node | byte-slices-fused | 0.833 | 0.782 | 0.665 | 0.937 |
| chromium | byte-slices | 0.940 | 0.782 | 0.743 | 0.956 |
| chromium | byte-slices-fused | 0.999 | 0.683 | 0.732 | 0.747 |
| firefox | byte-slices | 0.484 | 0.409 | 0.334 | 1.015 |
| firefox | byte-slices-fused | 0.936 | 0.964 | 0.846 | 1.042 |
| webkit | byte-slices | 0.905 | 0.837 | 0.874 | 0.988 |
| webkit | byte-slices-fused | 0.896 | 0.961 | 0.762 | 1.118 |

Byte copies still merit actual WordPress profiling/timing, especially shared
IO. They are not a universal win: WebKit fused file-includes is1.118
(cohorts1.140/1.097), while shared includes is.961. Firefox standalone shared
includes .409 comes from .166/1.005 cohorts; do not advertise the aggregate as
a dependable59% gain. Node byte-only shared compute is.854/reference and
1.965/own ordinary-file; shared includes is.730/reference and.274/ordinary.
Shared/ordinary comparisons include the OPcache mode difference and do not
isolate addressing cost or show translation beating equal-cache ordinary code.

Node byte-only file compute has request-wall ratio.850 with guest-timer1.003;
shared compute is.854 with guest-timer.991. Candidate/reference guest Wasm
is identical. These observations are consistent with a benefit outside the
timed numeric body, but do not prove CPU attribution. Guest time is wall
time too and is affected by scheduling. No CPU-clock diagnostic has run.

| Host | Guard mode | Compute file | Compute shared | Includes file | Includes shared |
|---|---|---:|---:|---:|---:|
| node | object-guard | 1.023 | 0.965 | 1.046 | 0.963 |
| node | object-guard-fused | 1.018 | 1.010 | 1.034 | 0.990 |
| chromium | object-guard | 0.984 | 0.997 | 0.977 | 1.004 |
| chromium | object-guard-fused | 0.992 | 1.088 | 0.972 | 0.998 |
| firefox | object-guard | 1.032 | 1.016 | 1.056 | 1.029 |
| firefox | object-guard-fused | 1.026 | 1.940 | 0.972 | 2.222 |
| webkit | object-guard | 0.985 | 0.997 | 1.003 | 0.995 |
| webkit | object-guard-fused | 0.902 | 0.999 | 0.876 | 0.992 |

The narrow guard still has no convincing general gain. Firefox guard+fusion
shared includes2.222 comes from .973/5.077 cohorts; shared compute1.940 from
.986/3.817. The bad run stays included. Broader span/stack/affine proofs,
dynamic guard coverage and other placements stay planned;349 static sites
do not establish or exclude broader application value.

Warmup diagnostics investigate two extreme Firefox controls: byte-reference
baseline/shared cohort0 and guarded+fusion/shared cohort1. Both workers finish
roughly62–66 warm requests per workload; both are slow in each bad run. Counts
alone do not explain the difference. Warm empty medians in the first bad
reference are25.44/26.45ms versus4.16/4.32ms in the adjacent byte candidate.
The bad guard candidate has23.47/23.98ms versus4.25/4.28ms in its fusion
reference. Slow fresh-parent behavior appears in both a reference and a
candidate. Its cause is unproven; do not assign an outside runtime defect or
an optimization-specific explanation without a reduction/profile.

Retained measurement follow-ups: separate Node process-CPU diagnostics from
uninstrumented wall timing; verify worker ownership/clock cost; inspect phase
traces/warmup plateaus and byte-copy volumes; run real WordPress comparisons.
CPU counters would include host/worker/JIT work and do not remove cache or
thermal effects. Browser wall clocks must not be relabeled CPU time.

A report-path error overwrote two generated phase17 summaries during analysis.
Raw inputs were unchanged. The original immutable driver regenerated both
summaries, and all7,214 historical manifest hashes verified restored. The
mistaken outputs/driver are retained under phase19/report-path-error. A
checked exact output anchor and fresh-file rejection now protect repeat
reports; a second-run negative leaves output hashes unchanged. The initial
catalog-generation attempt failed before writing; this section uses corrected
phase19 data. No timing values were removed or altered.

Corrected full/ThinLTO PHP builds have now started separately from these
completed timings. No application-LTO result is assumed yet.

### CC-02: corrected PHP builds and application correctness

The private C-O2 full-LTO and ThinLTO PHP builds completed with the three
LLD backend settings reduced in phase18. Dependencies, C++, normal configure
results, pre-fork Binaryen optimization, SDK link glue and fork preparation
remain matched to the original build. This is main-program C LTO, not
whole-dependency LTO. No shipping recipe or default compiler setting changed.
The emitted ordinary FPM modules are 39,340,553 bytes for full LTO and
39,882,014 bytes for ThinLTO, versus 37,003,204 bytes for the original.

Each compiler configuration has its own ordinary-addressing CLI/FPM control.
Four translated candidates cover full/ThinLTO individually and combined with
VM-10 small scalar fusion. Re-emitting the original baseline and fusion FPM
controls reproduced their exact hashes. Ordinary CLI execution, actual PHP
private fork and file-cache FPM checks passed for both compiler configurations;
the four translated CLI private-fork checks also passed. The shared platform
checks passed 12 Node controls and 18 browser FPM controls across Chromium,
Firefox and WebKit. The first browser command selected the wrong test set and
failed with zero tests; that failed attempt is retained and counts as no
browser validation. The corrected selection produced the 18 passes.

WordPress then passed 56 short controls: two database backends (SQLite and
MariaDB), four hosts, and seven configurations per host/backend (one original
ordinary control and six translated modes). The validator checks artifact,
image and kernel hashes, home/article/admin/REST results, authenticated admin,
both FPM worker PIDs, actual shared/file cache configuration, populated shared
OPcache, group state, empty host/page diagnostics and completed teardown.
The intentional init termination during host destruction is retained as exit
137. These runs have zero warmup rounds and one request per workload. They
are correctness evidence, not speed rankings; in particular their ordinary
WordPress control uses the original compiler, not each candidate compiler.
Per-compiler ordinary WordPress controls remain required for matched timings.

Section analysis of all18 ordinary/translated CLI/FPM artifacts found no
`.debug_*` payload. Removing DWARF cannot save bytes in these artifacts;
keep the CC-04 idea for builds that contain it. The ordinary FPM code section
itself grows from 19,789,947 bytes (49,424 defined functions) to 22,136,094
(49,233) with full LTO and 22,093,604 (49,260) with ThinLTO. This is code-size
evidence, not a runtime-speed or resident-memory result. The source of the
remaining data-section size has not been investigated. Retain inspection of
data initialization and private immutable-page sharing as separate research
ideas with the imported-memory, fork, write and aliasing obligations described
in phase20/followups.md.

Phase20 retains corrected build receipts, generated configure/header/Makefile
inputs, emitted modules, failed and corrected runner logs, raw application
results, validation driver and section analysis. The earlier naive PHP link
failures and incomplete LTO backend configuration remain in phase18.
Next is the predeclared matched FPM matrix: four LTO/fusion pairs, both cache
modes, each candidate's ordinary compiler control, reversed launch cohorts,
and all four hosts. No LTO performance benefit or optimality is claimed yet.

### CC-02: matched FPM LTO timing screen

The predeclared matrix completed 256 fresh parents and111,616 request samples, with64 warmup and7 measured rounds. Strict Node/browser inventory, source/artifact/cache/workload identities, shutdown and diagnostic checks passed. All3,584 two-request batches used both real FPM workers. All116 frozen input hashes still matched after the run. Each LTO candidate has its own ordinary compiler control, bracketed twice per cohort. Each candidate is compared to original baseline or original small fusion, as applicable; two reversed cohorts remain separate in the raw report. Ordinary means untranslated Wasm.

These are shared-cache FPM ratios; below1 favors the candidate. Compute/ordinary uses each candidate compiler's own ordinary file-cache build. Therefore a shared/ordinary ratio includes the cache-mode difference. File-cache, guest-wall, empty requests, compiler-only ratios, ordinary bracket drift, startup and memory results are all retained in phase21/observations.json and the full64-row compute/includes table in observations.md.

| Host | Candidate / reference | Shared compute / ref | Shared includes / ref | Compute / own ordinary | Two-request compute / ref | Two-request includes / ref |
|---|---|---:|---:|---:|---:|---:|
| node | php-lto-full / baseline | 1.003 | 0.999 | 2.005 | 0.962 | 1.002 |
| node | php-lto-full-fused / fuse-small | 0.876 | 0.805 | 1.827 | 0.840 | 0.837 |
| node | php-lto-thin / baseline | 0.983 | 0.988 | 2.265 | 1.010 | 0.983 |
| node | php-lto-thin-fused / fuse-small | 0.992 | 0.971 | 1.803 | 1.045 | 0.994 |
| chromium | php-lto-full / baseline | 0.999 | 0.928 | 2.314 | 0.990 | 1.012 |
| chromium | php-lto-full-fused / fuse-small | 1.000 | 0.912 | 1.954 | 0.965 | 0.960 |
| chromium | php-lto-thin / baseline | 1.006 | 1.007 | 2.316 | 0.958 | 1.073 |
| chromium | php-lto-thin-fused / fuse-small | 0.953 | 1.060 | 1.840 | 1.066 | 1.130 |
| firefox | php-lto-full / baseline | 1.041 | 1.075 | 2.497 | 0.994 | 0.971 |
| firefox | php-lto-full-fused / fuse-small | 1.075 | 1.100 | 2.001 | 1.002 | 0.998 |
| firefox | php-lto-thin / baseline | 1.045 | 1.068 | 3.744 | 0.959 | 0.967 |
| firefox | php-lto-thin-fused / fuse-small | 0.988 | 1.004 | 1.996 | 0.983 | 0.977 |
| webkit | php-lto-full / baseline | 1.010 | 0.993 | 2.077 | 0.951 | 1.099 |
| webkit | php-lto-full-fused / fuse-small | 0.950 | 0.949 | 1.962 | 0.915 | 0.786 |
| webkit | php-lto-thin / baseline | 0.991 | 1.013 | 2.034 | 1.083 | 1.026 |
| webkit | php-lto-thin-fused / fuse-small | 1.104 | 1.011 | 1.636 | 1.007 | 0.988 |

Full/ThinLTO alone show no broad shared-cache advantage in this screen. Chromium compute is approximately unchanged, while full LTO has shared-cache Firefox regressions. Full LTO plus fusion has a narrow WebKit sequential signal: shared compute0.950 (cohorts0.925/0.975) and includes0.949 (0.910/0.990). The compute guest-body wall ratio is0.955/0.962. Its concurrent compute cohorts0.823/1.018 do not show the same consistent gain; concurrent includes0.647/0.955 also varies widely. Retain this candidate for application/profile follow-up, without promoting a default.

The larger apparent Node full-LTO+fusion shared gains are cohort-dependent: compute0.876 comes from0.997/0.770 and includes0.805 from1.015/0.638. In the latter second cohort the guest-body wall ratio is1.035, so the whole-request improvement is not evidence of a faster include body. The same candidate has file-cache includes1.254 (1.028/1.528). ThinLTO file-cache regressions also remain: Firefox compute1.322 (0.998/1.753) and includes1.572 (0.994/2.484); WebKit compute1.243 (1.411/1.095) and includes1.267 (1.395/1.150). These outliers and adverse results are not filtered or pooled with earlier screens.

The launch inventory had no known active peer build, but three subsequently started registered engine builds overlap the timing interval: headers19:20:14–19:22:59UTC, const19:27:27–19:30:15, and style19:32:47–19:36:41; this matrix ran19:19:14–19:35:38. Recorded one-minute load ranges3.373–28.940. phase21/overlap.json maps finite registered intervals to individual controls and separately labels16 older open-ended records as potential overlap, not proof of liveness; two known idle previews are separate. No quiet-machine replication or cause of a slow parent is claimed. Guest clocks measure wall time too. All parents and cohort medians remain evidence.

The code-size cost from phase20 remains. Keep LTO, LTO+fusion, dependency-wide LTO, alternative inlining and LTO+PGO on the list; this screen does not justify an automatic compiler change. Real WordPress timings and the additional ordinary-LTO WordPress correctness coverage remain separate work. There is no general-platform performance, canonical-image or conformance claim.

The additional16 ordinary-LTO WordPress controls now pass as well: full and
ThinLTO × SQLite and MariaDB × Node/Chromium/Firefox/WebKit. Artifact hashes,
frontend/admin/REST behavior, both worker PIDs, file-cache configuration and
teardown were verified. They use zero warmup/one round and add correctness
coverage only. Together with phase20, all three compiler configurations have
actual ordinary and translated WordPress correctness evidence; a new paired
WordPress timing protocol is still required for speed comparisons.

### APP-02: actual update and invalidation semantics before timing

The isolated WordPress fixture can now select timestamp validation explicitly;
its default remains enabled. A separate opt-in diagnostic runs after the page
requests. A blacklisted PHP controller creates a cached included PHP file,
reads it through both FPM workers, edits it with a distinct past modification
time, and checks both workers again. Enabled validation must expose version2;
disabled validation must continue exposing version1 until an explicit cache
operation. This uses guest PHP file operations and real OPcache, with no
synthetic cache result or host-clock delay.

The first eight shared-cache controls pass (two policies × four hosts). The
first ordinary file-cache-only control then fails at the assumption that
`opcache_invalidate()` would succeed there. It returns false, while edits with
validation enabled are correctly visible. That failed run and its source are
retained. The tested PHP source explains the boundary: file-cache-only request
startup sets accelerator_enabled=false, and zend_accel_invalidate returns
FAILURE before reaching its disk-cache deletion path. This is a PHP cache-mode
boundary, not evidence of a browser or Kandelo runtime defect.

The revised diagnostic keeps and checks that false API result, then explicitly
removes only the target's matching disk-cache entry through the guest
filesystem. It checks that the entry existed, was removed, and that both
workers subsequently execute version2. Shared mode still requires successful
`opcache_invalidate()` and performs no disk-cache removal. The corrected full
matrix passes24 controls: two policies × ordinary file-cache, virtualized
file-cache and virtualized shared-cache × Node/Chromium/Firefox/WebKit. Actual
artifact/image/kernel identities, effective ini values returned by PHP,
frontend/admin/REST behavior, cache configuration, both worker PIDs in each
probe phase, group state and teardown are verified. The initial eight passes
and one failed control remain separate evidence, not folded into that count.

This is SQLite WordPress correctness evidence with zero warmup/one page round,
not a speed result or MariaDB policy replication. The immutable-code
performance experiment still needs its own matched ordinary policy controls
and declared per-case options; the old cache-major WordPress protocol supplies
only one ordinary compiler/profile/configuration. The editable preview and
shipping cache settings have not changed. Keep both explicit shared cache
invalidation and file-cache removal in the later survey; restarting FPM alone
is not demonstrated here as a substitute for removing a stale disk-cache file.
Phase22 retains all raw results, the failed assumption, corrected diagnostic,
source-boundary evidence and scripts. APP-01 capacity/warmup/preload remains a
separate candidate; it has not been measured by these tests.

### WordPress per-case measurement protocol and APP-02 resource preflight

A separate `wordpress-matched-cases-v1` protocol now declares candidate/reference
pairs, each compiler's ordinary module, per-mode host bundles, and explicit
per-mode application options. The initial supported option is timestamp
validation. Each case's ordinary and virtualized controls receive the same
policy; diagnostics are disabled during timing. Two reversed cohorts each use
eight adjacent controls, including two ordinary brackets per case. The old
cache-major protocol and its historical reports remain unchanged.

The APP-02 manifest uses identical small-fusion VM bytes for enabled/disabled
validation and identical original ordinary compiler and host bytes. Preflight
verifies the16-parent per-host plan, current artifact/bundle hashes, and rejects
six malformed configurations: missing own ordinary control, missing policy,
null policy, unknown application factor, wrong module hash and changed host
bundle. Playwright discovers the expected48 browser controls. Syntax checks
pass; execution of this new complete timing protocol is still pending.

A separate four-control Node resource rehearsal uses two warmup/five measured
rounds (28 page samples per parent), both policies and VM file/shared caches.
All four complete normal WordPress/cache/teardown checks. Peak allocated common
memory is342,425,600 bytes (validation on/file),319,750,144 (on/shared),
360,906,752 (off/file), and319,815,680 (off/shared), below the536,870,912-byte
ceiling. These observations support these run lengths on the tested Node
configuration; they do not establish sustained lifetime reuse, browser resource
behavior or a policy speedup. A peer full build overlapped, and no latency
ranking is drawn from this rehearsal. Initial timing will screen SQLite;
MariaDB performance and other application factors remain separate follow-ups.

### APP-02: separate Node process-CPU diagnostic

A diagnostic wrapper now measures the ordinary Node host's fetch intervals
without changing frozen host bundle or guest program bytes. It matches each
page's URL, payload length and order to the ordinary WordPress fixture. The
first probe passes28 aligned page intervals, retaining eight overlapping cache
status requests separately. The full paired diagnostic then passes16 fresh
Node parents and448 aligned page intervals, with two warmup/five measured
rounds, reversed cohorts and each policy's own ordinary brackets. Frozen inputs
remain unchanged at completion. The plain timing summarizer was actually given
a CPU matrix and rejected it before writing an output; that negative control
and unchanged CPU-summary hash are retained.

CPU here is user+system time for the current Node process, including runtime
threads and background work. It can exceed elapsed time during parallel work,
as described by the [Node24.15 API](https://nodejs.org/download/release/v24.15.0/docs/api/process.html#processcpuusagepreviousvalue).
It is not PHP-only/per-function attribution or browser evidence. Clock-loop
probes include process background work, are not a pure per-call estimate, and
are not subtracted from measurements. Instrumented fetch wall time is kept
separate from CPU and from uninstrumented page latency.

The configuration-only comparison uses identical small-fusion VM bytes,
ordinary compiler and host profile on both sides. Disabled validation is the
candidate; enabled validation is the reference. These are diagnostic ratios,
not a default-policy recommendation. Shared/ordinary also includes the
shared-cache versus file-cache difference.

| Workload | Cache | CPU / ref (cohorts) | CPU / own ordinary | Ordinary policy CPU / ref (cohorts) | Instrumented fetch wall / ref (cohorts) |
|---|---|---:|---:|---:|---:|
| home | vm-file | 1.089 (1.047/1.133) | 2.961 | 1.057 (1.029/1.085) | 1.068 (1.025/1.112) |
| home | vm-shared | 0.756 (0.747/0.766) | 1.341 | 1.057 (1.029/1.085) | 0.762 (0.758/0.766) |
| article | vm-file | 1.055 (1.048/1.062) | 2.810 | 1.048 (1.041/1.056) | 1.059 (1.037/1.081) |
| article | vm-shared | 0.828 (0.828/0.828) | 1.490 | 1.048 (1.041/1.056) | 0.792 (0.792/0.791) |
| admin | vm-file | 1.090 (1.052/1.128) | 2.866 | 1.037 (1.045/1.030) | 1.139 (1.150/1.128) |
| admin | vm-shared | 0.766 (0.765/0.766) | 1.342 | 1.037 (1.045/1.030) | 0.759 (0.735/0.784) |
| posts | vm-file | 1.040 (1.042/1.037) | 2.573 | 1.049 (1.047/1.051) | 1.016 (1.023/1.010) |
| posts | vm-shared | 0.618 (0.598/0.638) | 0.770 | 1.049 (1.047/1.051) | 0.592 (0.593/0.592) |

The shared-cache process-CPU ratios are a promising signal: both cohorts agree
on reductions across home, article, admin and REST. The file-cache regressions,
including the ordinary policy controls, remain evidence. No explanation for
those regressions is established; do not attribute all differences solely to
timestamp syscalls or claim a general cache-policy win.

Actual registry receipts put this diagnostic at20:19:24–20:25:02UTC. The earlier
Sydney full-build finalization ended before it; two later Node continuation
checks overlap its final part (browsers20:23:27–20:24:16 and regressions starting
20:24:46). Thus the earlier active-build observation does not describe the CPU
matrix's whole interval. Recorded one-minute load ranges3.434–5.735. Phase24
maps finite job intervals and older open-ended potential overlaps separately;
those records are not exhaustive OS activity or proof of contention. All
cohorts, ordinary drift and raw requests remain. A quiet uninstrumented
all-host SQLite screen and MariaDB confirmation are still pending.

### APP-02: completed all-host uninstrumented SQLite screen

The configuration-only matrix completes64 fresh parents and1792 page samples in23m33. All16 Node and48 browser controls pass; two reversed cohorts, own ordinary policy/compiler/profile brackets, exact warmup/round/workload inventories, actual cache and group state, authenticated admin/two-worker checks, page diagnostics, artifact/image/kernel identities and teardown are validated. All121 frozen inputs match at stage completion. Both cases use the same small-fusion VM bytes, original ordinary compiler and pregrown host profile. Two warmup/five measured rounds are declared; CPU counters and policy-edit diagnostics are disabled.

These are decreases in median request latency with shared OPcache, expressed as1 minus the geometric mean of the two cohort median ratios. The measured workload is in-kernel HTTP serving, not browser DOM/rendering time. Both cohorts improve for every shared-cache host/page combination. Full ratios, cohort variation, own ordinary comparisons and adverse results remain in phase25/observations.md and the raw strict summary.

| Host | Home | Article | Admin | REST posts |
|---|---:|---:|---:|---:|
| node | 23.3% | 21.0% | 24.9% | 40.7% |
| chromium | 13.8% | 15.0% | 16.2% | 30.8% |
| firefox | 28.5% | 18.8% | 21.3% | 34.0% |
| webkit | 21.7% | 21.2% | 20.6% | 36.9% |

This confirms a practical shared-cache signal beyond the earlier Node CPU counter experiment. It does not establish a general policy win: VM file-cache ratios range0.980–1.063, with mostly small changes and some regressions. Node admin/file is1.043 and Firefox REST/file1.063; individual WebKit file-cache cohorts vary more (article1.124/0.966). Ordinary policy comparisons and bracket drift are retained. The earlier instrumented Node file-cache CPU regressions are not erased because this separate latency screen is less adverse.

With disabled validation, shared-cache HTML/ordinary-file ratios range1.159–1.513 across these hosts/pages, while REST/shared is0.677–0.794 of its own ordinary file-cache control. These compare cache modes as well as translation; they are not a pure address-translation tax. The VM/file controls remain roughly2.00–2.94 times their own ordinary controls. No statement here compares against machine-native PHP.

The earlier edit-visibility tests remain essential: disabled validation keeps stale code until an appropriate explicit cache operation. The editable preview and shipping defaults remain unchanged. This is a small SQLite corpus and sequential page workload; MariaDB, larger/plugin corpora, sustained lifetime/resource reuse and page-load concurrency remain unmeasured by this matrix.

Collection runs20:31:35–20:55:09UTC. The final launch inventory followed an exact terminal wait for the known peer browser job. Two later registered Freeciv checks overlap (pointer20:47:03–20:47:23, fullscreen20:49:08–20:49:35), and recorded one-minute load ranges3.169–13.723. Older open-ended registry records are labeled potential overlap, not liveness; known idle previews are separate. At the user's request a small read-only summary of completed Node/Chromium controls was calculated during Firefox; no builds/tests/source edits were performed for that status read. This is not exhaustive proof of a quiet machine. All cohorts remain; no outlier filtering or pooling with the CPU diagnostic.

Peak common-memory allocation across the VM controls is443,547,648 bytes under the536,870,912-byte ceiling. Cold listener/first-homepage costs, full per-round memory snapshots and actual OPcache statuses are retained in phase25/resources.json; this does not establish indefinite resource reuse.

The user asked whether the investigation was producing enough new learning. The remaining gap is mechanistic attribution, not another broad flag sweep. After preserving this result, prioritize worker CPU profiles, syscall counts and dynamic translation/guard coverage to distinguish translation helpers, PHP execution and host copying. The repository already has a syscall profiler. Broader stack/provenance/arena ideas remain untested rather than silently discarded; see the guarded-region proof proposal in phase24/instrumentation-followups.md.

### APP-02 and VM-10: syscall mechanism and first execution-worker profiles

The next diagnostic adds new attribution evidence instead of another compiler matrix. Six fresh Node WordPress parents pass application/cache/teardown checks, with two warmup/five measured rounds and20 measured pages each. Between the normal resource snapshots, shared OPcache with timestamp validation dispatches46,696 syscalls; disabled validation dispatches29,047 (37.8% fewer). The difference includes10,495 fewer stat calls (12,260→1,765) and7,140 fewer clock_gettime calls (13,193→6,053). File-cache counts stay essentially unchanged, including its ordinary-addressing control. These are service-wide dispatch counts, including background/tail cleanup; profiler handler wall time is not CPU time. Counts and complete results are retained in phase26/syscall-analysis.json and syscall-observations.md.

This supplies a concrete explanation for the earlier14–41% shared-cache latency improvement. It does not establish that filesystem calls explain all remaining overhead. File/shared cache comparisons also change how PHP loads cached code; they do not isolate address translation.

A separate Node diagnostic now profiles both actual FPM execution workers, with one fresh parent each for validation-on/shared, validation-off/shared and ordinary/file. All three WordPress/teardown checks pass. Per-profile native API start/stop boundaries calibrate the profiler clock to the kernel phase clock; only unambiguously enclosed intervals are selected. Two independent toy controls check that calibration against named worker markers. The first FPM attempt exposed a missing private diagnostic forwarding method in DeferredWorkerHandle; its failure is preserved. The corrected diagnostic forwards only through a live backing Worker and verifies exact worker identity at stop. All six ordinary pregrown runtime bundles remain byte-identical when diagnostics are disabled.

The original function indices remain stable. wasmparser0.247 confirms __syscall0(index73) calls66, which calls the generated wait wrapper49501 containing memory.atomic.wait32. Function66 therefore includes syscall bridge work and blocked waits; its residence is not all CPU consumption. Selected bridge samples decrease10,472→7,865 when validation is disabled, while samples in appended memory helpers/wrappers remain similar664→694. This is preliminary localization, consistent with the independent dispatch counts, not a CPU percentage or additional speedup claim. Small-offset load/store wrappers and vm_read_address/vm_write_address are visible; execute_ex is also visible through its export. Inlined work can be charged to original functions, so appended-code samples are not the whole translation cost. Full raw profiles, calibration intervals, adverse/failed probes and limitations remain in phase26.

The important unknowns remain dynamic access/guard counts, stack-relative coverage and pointer provenance. The larger VM-07/08/09 ideas are still planned. These profiles do not justify eliding translation merely because a function cannot fork. Next prioritize diagnostic access counts and hot-function proof coverage before another broad flag sweep. This is Node-only diagnostic attribution using the existing shell partial/WordPress SQLite image, not a new browser, MariaDB, production-runtime or conformance claim.

### VM-06 / VM-08 / VM-10: dynamic access counts identify a concrete target

A separate diagnostic post-pass now counts memory-operation dispatches by original function and wrapper/helper kind. Original indices remain unchanged; per-root64-bit atomic counters live in independent physical diagnostic pages. The pass validates its exact merged helper bytes, rejects unsupported layouts/cache/object profiles, and traps without the diagnostic host marker. Counts are attempted operations, not completed accesses or CPU cost. The diagnostic artifact's times must not be used as latency results.

One fresh WordPress SQLite/shared parent on each of Node, Chromium, Firefox and WebKit passes the normal app/cache/two-worker/teardown checks, with two warmup rounds and one four-page measured round. Each host counts about379.59million dispatches; totals agree within0.005%. I32Load accounts for approximately53.2% and I32Store19.5%. Across2,141 active original functions, the top function accounts for5.2%, top20 for43.2%, and top100 for80.3%. These are dynamic coverage figures for this small corpus, not timing weights. Full function/kind inventories are retained in phase27/analysis.json.

A notable target is the generated module-table generation poll:16.36million calls,4.31% of all counted operations and almost all I64AtomicLoad dispatches. wasmparser maps function27713 to the immutable imported generation address, an atomic load and conditional table reconciliation; the generator is crates/fork-instrument/src/streaming/tables/markers.rs ordinal2. Its semantics remain required. This suggests specializing aligned atomic translation (VM-06/VM-10), or later proving stable imported-control-cell mappings (VM-08/09), rather than deleting the generation check. Aligned atomic accesses cannot straddle a64KiB page after their required alignment check, so a narrower resolver can retain bounds/permissions/overflow/alignment semantics while avoiding the general span path. This is the next concrete implementation experiment; no speed benefit is claimed yet.

Thirteen independent diagnostic mechanism checks pass on each host: exact operation/function accounting,64-bit high bits, scattered accesses, denied-prefix behavior, independent fresh fork counters, private isolation and live shared data, and missing-host rejection. The first Node mechanism incorrectly omitted allocator-header initialization; first browser mechanisms requested an intentionally unsupported JSON asset path. Those failures remain retained, followed by the corrected constructor and a report module in a disposable worker. All three WordPress browser tests in that first six-test job passed; its aggregate was failed3/6. The focused mechanism rerun passes3/3. No new runtime workaround or production ABI/runtime behavior is introduced. Stack/provenance/arena proof coverage remains pending; this counter pass does not establish selective-translation safety.


### Breadth-first reset after user feedback

The user explicitly asked for a broad survey rather than further refinement of one or two techniques. Finish and retain running atomic correctness checks, then park its larger timing matrix. No atomic performance benefit is established. Give stack/provenance/arena/guest-loop/multi-memory/cache-capacity/resource-reuse families bounded first-pass evidence before another deep replication campaign. See phase29/breadth-first-plan.md for the explicit round; the full18-ID objective and all negative results remain.

Atomic closeout: all four configurations pass Node and12 browser mechanism controls, including787 differential atomic checks/configuration. Both new variants pass real shared fork on Node, shared FPM on Node/three browsers and WordPress shared on all hosts; Node WordPress file/shared checks pass. The old cold four-request file-cache smoke failed to observe both workers for both the candidate and byte-identical baseline. The fixture now retains initial responses and uses bounded real startup batches before the same two-PID assertion; corrected baseline/atomic/combined controls pass. Exact failures remain. Plain timing producers now reject diagnostic host profiles, with positive ordinary/negative access/syscall/worker-profile controls retained. These changes affect private tools, not production ABI/runtime or the preview.

The first breadth round supplies distinct evidence:

- **VM-07/08/05 feasibility:** a read-only scan of fork-prepared PHP finds7378 canonical shadow-stack frame constructions,116207 immediate syntactic in-frame sites among904942 memory sites,778 call-free loop/memory functions and one immutable imported-address site. These are syntax matches, not proofs. Only16 frame functions are call-free; all their dynamic accesses amount to an upper bound0.21% of this workload. Call-free loop functions have an upper bound4.43%; broader loop-containing functions account for93.6% of accesses. These are whole-function upper bounds, not measured optimizable shares. This argues for regions bounded by effects/calls, rather than another whole-leaf-only pass.
- **RT-01 smaller scratch:** four fresh Node WordPress controls compare8MiB and1MiB scratch in both file/shared caches, with the same original compiler/small-fusion module, one warmup and one four-request measured round. All app/admin/two-worker/cache/teardown checks pass. Peak physical allocation falls301924352→279904256 bytes(shared) and313327616→291307520(file): exactly21MiB per three-root group. No timing, browser, larger scattered-payload or extent-reuse claim is made. The real1MiB scatter bound remains enforced.
- **APP-01 capacity:** the existing identical diagnostic workload on all four hosts caches564 scripts, uses24990936 bytes and retains8563496 free bytes, with zero OOM/hash restarts. Current capacity pressure does not justify expecting a warm benefit from enlarging this cache. Preload/cold warmup and a larger corpus remain separate experiments; capacity is retained as an idea.
- **VM-05/09 and ARCH-01 first timing screen:** a disposable Node24.15 Worker measures a varying-address, read-only128KiB array. Two reversed cohorts, seven samples/case/cohort, all checksums and guard hit/scatter-fallback checks pass. Relative to its ordinary-addressing Wasm control, per-access PTE translation costs4.585×, a real span guard followed by an untranslated loop1.010×, and high-bit tagged two-memory dispatch1.184×(private)/1.304×(shared). Guard validation and its extra JS/Wasm call are inside the measured interval. This is a cost ceiling for a pinned loop/arena, not PHP results or proof of general mmap/protection/fork/ABI compatibility. Multi-memory uses a different pointer representation. A registered peer Freeciv build is active; no quiet-machine claim. Raw cohorts, load and all cases remain in phase29.

The new first-pass results make loop/span reuse and region-based stack/provenance analysis worth testing next, while leaving the original comparison/combination objective intact. Do not infer speedups from the scratch allocation reduction, static pattern counts or cache headroom.


### Breadth round: native PHP preload, sparse fork backing and regional proofs

Phase30 adds three independent families and a justified application/resource combination. All measurements reuse the frozen WordPress SQLite image, original ordinary compiler and small-fusion FPM. The first screens are Node-only, one warmup and one measured four-page round per fresh parent; they do not establish a latency ranking, browser behavior or general PHP/native performance ratio. The full raw data, actual PHP preload statistics, proof plans, sources and limitations remain in phase30.

**APP-01 native preload:** a normal mixed frontend/admin/REST run supplies561 cached source files. PHP's existing compile-only preload mechanism compiles all561, reports562 scripts including its own preload script,3466 functions and290 classes. WordPress authenticated admin, REST, two-worker cache state and teardown pass. The initial preload case and two timestamp-off factors are retained, including variability. With timestamp checks already disabled, the one-sample preload/reference page ratios are0.805(home),0.851(article),0.857(admin),0.886(REST). These are an incremental first signal, not confirmed benefits. Preload with timestamps enabled/disabled varies noticeably between runs; no cold-start win is established. Native PHP skips timestamp validation for preloaded scripts, so preload versus timestamp-on alone would confound the effects. Training/evaluation use the same small corpus. Immutable preloaded-code lifecycle and larger/unseen corpora remain constraints; the editable preview stays unchanged.

**RT-01 sparse fork allocation:** the prior destination allocates every virtual page before dropping holes and redirecting shared entries. A separate opt-in profile now allocates only root/scratch before the existing committed snapshot copy, then a single extent for the source's unique private pages. Private aliases copy once, shared pages retain live backing and holes remain holes. Eleven checks cover synchronous/asynchronous snapshots, private isolation, aliases and shared visibility. The normal allocator request/lease path still constructs the child; no process runs before copying completes. Three fresh Node WordPress parents pass with equal virtual/private/shared PTE shapes. High-water allocation is287.9375MiB(baseline8MiB scratch),223.8125MiB(sparse8MiB),202.8125MiB(sparse1MiB). Savings are64.125MiB individually and85.125MiB combined with smaller scratch. No existing extent is reclaimed or reused.

**Justified combination:** preload increases allocation high-water to424.125MiB with the old destination allocation. Preload+sparse fork+1MiB scratch passes the same app checks at300MiB. This reduces the allocation cost of preload; the sparse combination's speed is unmeasured. The backing remains the same512MiB shared Memory, so these are consumed allocator capacity figures, not reservation or RSS measurements. Monotonic allocation debt remains.

**VM-04/07/08 regional screen:** wasmparser validates whole-function operand/control stacks, then selects straight-line regions with empty operand-stack boundaries, i32 operations, repeated exact local-derived addresses, an unchanged base local and<=64KiB span. Calls, control and unknown effects are barriers. Six positive/negative core checks pass. The read-only screen selects45070 regions/166885 static sites in10312 functions, substantially broader than349 sites in the old whole-function pass. Requiring>=4 accesses leaves7910 regions/85290 sites;>=8 leaves2822/61258;>=16 leaves1465/45819. This exposes the guard-amortization/coverage tradeoff. Static address plans are not measured dynamic guard hits or an implemented compiler speedup. A future nonfaulting guard must preserve the original fault/write sequence on a miss, and physical temporaries must not cross region/call/fork boundaries. Broader pointer origin/escape proofs remain pending.

The six diagnostics-off host bundles reproduce the original pregrown profile byte-for-byte after the new fork option. Production host sources, ABI, image bytes, shipping defaults and the frozen preview are unchanged. No new outside-runtime defect is alleged. The next compiler work should exercise regional rewriting/actual coverage rather than another whole-leaf-only pass; browser confirmation and stronger matched application timings remain required for promising candidates. The atomic matrix stays parked during this breadth round.

### Breadth follow-through: regional rewriting and browser application/resource checks

Phase31 implements the bounded regional experiment and confirms two other families on browsers. It does not reopen the parked atomic timing matrix. Full source, artifacts, raw data and assertions are retained under `.context/common-memory-survey-20261111/phase31`; `analysis.json` records identities and limitations. Ordinary/native here always means ordinary-addressing Wasm on the same engine, not machine-native PHP.

**Regional translation reuse (VM-04/07/08):** the instrumenter now accepts `--guard-regions=4`, deriving its own plans from validated source operators. A nonfaulting span check selects an untranslated fast body; a miss executes the original translated operations in their original order. Only temporary address operands change; guest pointers retain their virtual representation. Empty-stack boundaries and call/control barriers prevent physical temporaries from being used across a remapping call or fork. This is a local-address proof, not general frame-origin, escape or call-tree analysis. The selected PHP module has7910 regions/85290 static sites in2209 functions. Each candidate adds1418500 bytes, about3.7%, to its reference. Baseline and small-fusion references reproduce their prior hashes exactly.

All four modes pass Node canary/access/bounds/regional checks and12 browser controls across Chromium/Firefox/WebKit. The synthetic guarded fixture observes6 hits/4 misses on every host. Checks preserve an earlier write before a later denied access, an earlier division trap, canonical pointer values, branches, changing base locals, nonempty outer stacks and a remapping call between regions. These diagnostic counters are absent from PHP and timed modules. Both new variants pass actual Node fork and shared-FPM cache publication/invalidation/replacement/private-state checks. All10 fresh-parent Node WordPress controls pass authenticated admin, REST, two-worker/cache and teardown checks. Thirty frozen inputs verify unchanged after timing. Browser WordPress regional application checks and PHP dynamic guard coverage were not run this phase.

**The regional timing screen is inconclusive.** One warmup and one measured mixed four-page round per parent, fixed order, does not establish a ranking. The ordinary reference's closing/opening page ratios are0.588(home),0.863(article),0.590(admin),0.502(REST), with1-minute load averages spanning roughly21–40. The following raw ratios are retained to expose both signals and regressions; sums aggregate the same four requests and are not independent replicated samples:

| Candidate / same-cache reference | File-cache sum ratio | Shared-cache sum ratio |
|---|---:|---:|
| regions / baseline |2.525|0.911|
| regions+small fusion / small fusion |0.981|0.933|

No regional latency benefit, compiler optimum or reliable translation/native tax follows from this screen. The large file-cache regression remains an open observation, not an attributed engine defect. Do not deepen this one candidate before the broader survey's remaining first passes.

**Preload and allocation (APP-01/RT-01):** all9 browser application checks pass: sparse fork, preload, and preload+sparse fork+1MiB scratch on each of Chromium/Firefox/WebKit. All561 requested files compile on each engine, reporting3466 functions/290 classes. Authenticated admin, REST, two worker PIDs, cache state, empty error streams and teardown pass. The three cases use separate contexts but reuse one Playwright browser per project; these are not nine independent parent launches. They confirm behavior and allocation, not latency ranking. Per-engine allocator high-water is223.875MiB(sparse8MiB scratch),426.125MiB(preload),302MiB(preload+sparse1MiB). The matched preload combination saves124.125MiB on all three engines. Backing remains512MiB; this is not RSS, reservation reduction or extent reclamation. The earlier Node controls separately establish the sparse-only saving; there is no new browser baseline/no-preload allocation comparison here.

**Survey decision:** timestamp policy has the strongest replicated WordPress latency evidence, small-offset fusion is host dependent, and preload is promising but not yet latency-confirmed. Sparse allocation has a concrete allocation benefit. Cache enlargement has no pressure-based justification on this corpus; root-header translation caching regressed its tested workloads. Compiler O3/LTO/PGO/post-Wasm screens have host/workload-specific results rather than one universal winner. Loop/affine and tagged two-memory costs remain synthetic evidence. Broader provenance, real PHP multi-memory ABI/mapping integration, safe extent reuse and WordPress-trained PGO remain unfinished, not discarded or classified as ineffective. Keep first-pass breadth ahead of further atomic/cache/regional replication, and preserve every neutral, negative and inconclusive result.

All work remains a private prototype using the existing partial WordPress SQLite image and kernel. No canonical image rebuild, production host/ABI change, full benchmark/conformance acceptance, shipping-default change or frozen-preview replacement occurred in this phase.

### RT-01 first mapped-payload reuse screen

Phase32 tests a distinct remaining resource idea rather than expanding atomic/regional timing. The new opt-in `--reuse-unmapped-pages` host profile reuses discarded mapping payloads. It does not recycle whole process address spaces. Existing lease release, an exited process entry, WeakRef disappearance or elapsed time alone are not treated as writer-quiescence proof. All roots remain explicitly registered, including exited roots; root/scratch retirement and abandoned-snapshot cancellation remain unfinished.

At a successful mapping boundary, the caller's sole Worker is stopped. mmap replacement, munmap and mremap nominate discarded payload pages. The owning kernel realm scans every registered root, including private aliases and PROT_NONE entries, and pending asynchronous fork snapshots. Root/scratch extents and all remaining PTEs pin backing. Captured private fork bytes have independent copies; shared snapshot entries pin live physical payload until successful copy publishes the child's PTEs. Uncompleted/failed snapshots deliberately keep their pins. Eligible pages enter a coalesced first-fit extent pool and are fully zeroed before reuse. The guest C growth allocator remains monotonic under the existing group lock, so its allocations stay disjoint. The flag requires sparse fork backing and rejects the byte-slice combination pending alias-lifetime proof. This is a bounded trusted memory32 experiment, not general concurrent mmap or a completed process-retirement design.

**Mechanisms:** Node and all three browsers pass paired controls. In64 repeated two-page map/unmap cycles, the old allocator adds128 pages(8MiB); reuse adds zero after initial allocation. The strengthened check fills and verifies every byte. Other checks cover private aliases, inherited shared mappings, MAP_FIXED replacement, moving/shrinking remaps, PROT_NONE restoration, asynchronous private copies/live shared pins, an uncompleted snapshot, actual compiled C guest growth, owner-only mutation and double-free rejection. Both transformed profiles also pass the existing virtual-buffer mapping/fork checks. These are ownership/allocation mechanisms, not request-latency measurements.

**Application first screen:** Node runs two shared-FPM controls plus5 WordPress controls: ordinary-addressing file cache and the paired VM profiles in file/shared modes. Both VM profiles use sparse fork backing and1MiB scratch; the reuse flag is the only runtime difference. Compiler, FPM module, kernel and SQLite image are identical. Each WordPress case uses one warmup and one measured mixed four-page round. Node and6 paired browser WordPress cases pass frontend/authenticated admin/REST, two-worker cache state and teardown, with empty error streams. Three additional browser FPM checks pass shared-cache publication, invalidation/recompile, request-private state and replacement-worker reuse. Browser projects reuse one parent across their two WordPress contexts; they are not six independent launches.

| Host/cache | Control high-water, MiB | Reuse high-water, MiB | Incremental saving, MiB |
|---|---:|---:|---:|
| Node/file |283.5000|170.3125|113.1875|
| Node/shared |202.8750|144.3125|58.5625|
| Chromium/shared |202.8750|140.3750|62.5000|
| Firefox/shared |202.8750|140.3750|62.5000|
| WebKit/shared |202.8750|140.3750|62.5000|

Every within-host pair has equal virtual/private/shared PTE byte totals at each recorded checkpoint, so the saving does not come from shrinking the guest workload. Actual reused-page counters are1811(Node file),937(Node shared) and1000(each browser shared). WebKit also records1026 root-held candidate observations; those pages were excluded from reclamation. These are cumulative observations, not unique additional live bytes. Node/browser shared high-water differs; its allocation-order/fragmentation cause is not established. The backing is still512MiB. Figures measure allocator high-water, not RSS, reservation reduction or a confirmed speedup. Raw request times are retained without ranking: fixed-order single-sample screens ran alongside other validation and peer activity. MariaDB and sustained replacement/churn confirmation remain pending.

**Provenance and failures:**206 frozen inputs verify unchanged after the Node run and analysis. The original normal profile and sparse1MiB control each reproduce all six prior runtime bundles byte-for-byte. Documentation was updated after validation; the run-time README is retained separately. The first authority audit found unclassified earlier/new fixture sites and a stale exact-key entry; the second attempt had an invalid owner field on an intrinsic-reference allowance. Both failures remain. After reviewing the actual fixture memory origins and correcting those entries, `host/test/kernel-scratch-contract.test.ts` passes all10 tests. The first analysis-driver attempt had a Python syntax error; its source/log remain alongside the passing corrected analysis. No application check was weakened.

Full source, profile bundles, original/strengthened mechanisms, all raw application data, failed/passing logs and `analysis.json` remain in `.context/common-memory-survey-20261111/phase32`. No normal host runtime/ABI, guest artifact, canonical image, preview or shipping default changed. The full browser-memory/canonical/conformance/performance gates have not run for this private first screen. Mapped-payload reuse now has concrete app allocation evidence; retain it for later timing and sustained-run confirmation while moving the breadth survey to its remaining provenance/arena/multi-memory and WordPress-trained-PGO gaps.

### CC-03 / VM-10: bounded real WordPress factorial first screen

Phase33 closes the missing unprofiled WordPress application comparison without rebuilding PHP or repeating training. **Evidence correction:** the existing PGO artifact was already trained on real WordPress SQLite and MariaDB frontend/admin/login/REST/cache-status requests plus CLI coverage. Recent phase31/32 status/checkpoints described WordPress-trained PGO as unfinished; the missing work was WordPress timing. The original phase9/13 evidence already recorded the actual training. Immutable historical checkpoints remain unchanged; this entry and the current candidate table correct the working state.

The profile-use receipt, merged profile SHA `b7bc2f1eec94e14a3e0e5fd18a298fa785548337e6070f9c69f4143247b8cf23`, all three raw training inputs, original/PGO ordinary modules and four VM artifacts verify against their retained identities. Main C-O2 profile-use precedes post-Wasm translation; source PGO does not optimize subsequently injected helpers. Dependencies, C++/image extensions, O2 helper code, image, kernel and the original pregrown normal host profile remain fixed. Training used timestamp validation on; every evaluation case explicitly turns it off. Training's Liftoff-only instrumentation-collection flags are absent from timed parents. This is the same small WordPress source corpus, not held-out WordPress generalization or an optimal profile. The earlier empty/compute/includes FPM fixture remains separate held-out evidence.

`wordpress-factorial-run.mjs` uses a distinct bounded12-parent plan per host: opening ordinary original/PGO compiler controls, four shared-cache VM configurations in one order, the same four in reversed order with fresh parents, then closing ordinary PGO/original controls. One warmup and three measured mixed four-page rounds are collected per parent. `wordpress-factorial-plan.mjs` defines this protocol; the existing strict five-round/full matched-plan summarizer was not weakened. Node and browsers run serially. Owned job `common-memory-pgo-wordpress-first-1111-191221-7ec7` succeeds after13m31s; all36 browser cases pass in9.7min. All48 fresh-parent application/admin/REST/two-worker/cache/teardown/identity/settings controls and768 page samples validate. There are576 measured warm requests, not576 independent launches. The same162 frozen inputs verify unchanged on both hosts and after collection.

Exploratory early-warm latency ratios, lower is better. Each number is the equal-weight geometric mean of four page-type ratios across two parent cohorts; this is not traffic-weighted throughput or a confirmed speedup:

| Host | PGO / original | PGO+fusion / fusion | Fusion / original | PGO+fusion / original |
|---|---:|---:|---:|---:|
| Node |0.893|2.396|0.778|1.864|
| Chromium |0.802|0.976|0.755|0.737|
| Firefox |0.982|0.945|1.050|0.993|
| WebKit |0.983|1.147|1.176|1.348|

The aggregate is deliberately accompanied by every page/cohort/round in phase33/analysis.json and observations.md. On Node, PGO+fusion/fusion-only page ratios range1.97–3.87 across both orders; the slowdown observation repeats while allocator high-water is identical for those variants. Its cause is not established. PGO alone mainly lowers REST latency in both Node orders; article/admin are near the reference. Chromium PGO-alone article ratios0.741/0.777 and admin0.884/0.850 are repeated leads, while adding PGO after fusion is mixed. Firefox PGO-alone results disagree by order; its apparent combined REST gain is dominated by one order. WebKit PGO alone is near the reference, and the combined aggregate regresses. Nothing here establishes an engine defect, universal preset or additivity of individually useful optimizations.

**Qualification:** a peer bootstrap build was confirmed live before launch. Recorded load includes the benchmark itself and other activity; it cannot assign a cause to the differences. Ordinary opening/closing page medians differ by up to1.47× on Node,1.55× on Chromium,2.51× on Firefox and1.20× on WebKit. No cases are excluded to obtain a preferred result. Only two VM parents/configuration/host and three measured rounds mean this is early-warm first-screen evidence, not established steady-state throughput. The report retains per-case cold homepage costs, all resource snapshots, ordinary compiler ratios and VM/shared-over-own-ordinary/file ratios. The latter include cache-mode effects and must not be called pure address-translation costs. VM-file and MariaDB WordPress timings remain separate follow-ups.

Preserve the promising Chromium PGO-alone signal, the repeated large Node combination slowdown, neutral/order-dependent cases and all compiler options. Follow-ups include a longer warm phase, warming/checking each FPM worker before timing, CPU/call-shape attribution, policy/large-corpus retraining and dynamic selection of fusion sites; they remain ideas rather than explanations or new defaults. Do not immediately expand this into another large compiler replication campaign: the breadth survey still has provenance/call-effect and arena/multi-memory applicability gaps.

Raw data, exact scripts, source/provenance receipts, profiles/modules and observations are retained under `.context/common-memory-survey-20261111/phase33`. No new compiler/package/image build, normal runtime/ABI change, shipping-default change or frozen-preview replacement occurred. This app-specific screen does not establish full platform/canonical/conformance acceptance.

### VM-08: conservative call-effect feasibility and observed coverage bound

Phase34 investigates the user's call-tree idea as a distinct first pass, without enabling another runtime fast path. The new read-only `calls` binary compares the old grammar with direct-call effect closure. Imported calls, indirect/ref calls, atomic/thread operations, growth, exception unwinding, table operations and unknown instructions seed exclusions, propagated through ordinary and tail calls, including recursive cycles. Only i32 signatures enter the current empty-stack region grammar. Caller locals cannot be changed by a callee, but source globals may change. The strict policy also excludes guest-memory writes: ordinary stores/copies may alias syscall-channel fields, so absence of a fork import or atomic notify alone is insufficient. A separate named `PublishPatternOpportunity` policy allows ordinary writes solely to count an unproved opportunity; it is not rewrite eligibility.

The actual libc mapping protocol publishes shared-channel state with an atomic store, notifies the kernel and waits. The scan therefore includes this route instead of treating imported-function absence as a mapping proof. Already transformed modules and exact translator configuration names are rejected, preserving the assumption that source-global updates cannot switch the appended VM root. Legitimate musl `__vm_lock`, `__vm_unlock` and `__vm_wait` exports remain allowed. Source pointers and callee accesses remain virtual; call summaries would only extend a caller guard's lifetime, not make inherited private addresses ordinary in fork-free functions.

Two Rust closure/effect tests and52 real-Wasm analysis checks pass. They cover transitive imports/fork routes, cycles, direct/tail calls, atomic reads and notifications, growth, writes, signatures, table/ref operations, unchanged bases and source admission. In a small fixture, two four-access regions merge across a read-only call; an unknown writer/remapper remains a strict barrier. Catch structure alone is permitted, but explicit throws/rethrows remain excluded. These are parser/proof-selection checks, not execution or latency measurements of a new optimizer.

Static min4-access results:

| Original compiler family | Existing regions/sites | Strict call-aware regions/sites | Call-crossing regions | Write-allowing opportunity sites |
|---|---:|---:|---:|---:|
| Original O2 |7910 /85290|7937 /85531|159|85766|
| WordPress-trained PGO |7542 /75764|7566 /75962|131|76183|

The strict original increment is241 static sites(0.283% of previously selected sites); PGO adds198. Threshold2/8/16 outcomes and guard-count changes are also retained. Larger regions can amortize guards even without adding sites, so static site increments alone are not a performance bound. Strict i32-call-eligible function counts are2703(original) and2764(PGO); write-allowing estimates are5993/6135.

**Observed workload bound:** original function ordinals are linked to the retained phase27 counter artifact by its exact SHA, source-function limit49483/function-base256, unchanged original export ordinals and retained native symbol map. The counter pass preserves original indices and appends its helper. For each of the four hosts, summing *all* attempted memory-operation dispatches of the89 parent functions containing strict min4 call-crossing regions yields approximately0.024% of the four-request WordPress trace. This overcounts the selected regions. The unproved write-allowing variant's184 parent functions sum to approximately0.0704%. These are whole-parent operation-dispatch upper bounds, not CPU fractions, byte counts, dynamic guard-hit counts or predicted speedups. They apply to this original-compiler SQLite/shared-cache trace. PGO has different ordinals and receives no projected dynamic bound.

**Precision limit checked:** the first exclusion policy classified exception instructions as unknown. A refined pass explicitly allows catch control and retains real throw/rethrow exclusions; eligibility counts remain identical. Original fork-prepared PHP has21421 functions containing exception-unwind operations, and PGO has21866. The fork instrumenter's capture emitter actually emits a private-tag throw and `throw_ref`; they are not merely noisy labels to ignore. Handler reachability/context could improve precision, but is not proved here. The existing fork analysis has richer table/ref reachability facts before transformation; it certifies fork-control reachability, not mmap effects or exclusion of syscall-channel aliases. Reusing it safely requires carrying and checking effects through generated capture/replay/loader scaffolding.

**Decision:** this conservative call-only shortcut is a low-priority runtime implementation for the sampled WordPress workload. It is not evidence that general pointer provenance or call-sensitive translation cannot help. Preserve pre-fork effect certificates, precise stack/local/store footprints, call-site/import/table context, handler reachability and epoch revalidation after proved non-forking mapping calls. Revalidation must not replay calls or prior visible writes; physical temporaries still need fresh child binding after fork. Also retain the per-instance affine/global mapping-cache alternative, with its complete publication/wait/import-return/map/protection/unmap/fork invalidation obligation: the kernel Worker cannot directly mutate another Worker's instance globals. Move first-pass breadth to loop/arena/multi-memory costs before deeper call-summary or compiler replication.

All7910 existing min4 plans reproduce exactly, and the existing guarded FPM Wasm reproduces SHA `ae85f9dd844db394437b9000d58dadceb5f6991d954ef4ec8edc86b29b7b84e4`. Final valid-input reports are byte-identical to the preceding scan after source-admission hardening. Initial linkage inspection hit the translator's deliberate reserved-export input rule; the final export-only reader is cross-checked against the normal parser without relaxing admission. An initially over-broad VM prefix check rejected legitimate musl exports; it was narrowed to the actual reserved list, with positive regression checks. Both failed attempts remain, alongside all scan versions, sources and passing results.

Evidence is retained under `.context/common-memory-survey-20261111/phase34`, including `analysis.json`, observations, exact source snapshots, fixtures, source hashes, raw scans and linkage/reproduction checks. No address translation was removed, no cross-call PHP fast path or application speedup was tested, and no normal runtime/ABI/image/default/preview change or full platform acceptance is claimed.


### VM-05/09 and ARCH-01: cross-host synthetic loop/arena cost screen

Phase35 closes the browser cost gap with the same three historical synthetic
Wasm modules, now called through one shared Node/browser probe core. The
historical Node-only worker is unchanged. Every memory/instance stays in a
disposable Worker; the browser page receives only copied JSON. The two ordinary
banks each have a four-page ceiling; the ProgramGroup ceiling is64 pages,
4.5MiB aggregate declared reservation. This lower group ceiling differs from
the old Node screen, so the old/new runs are retained separately. No PHP,
SDK, host adapter, mapping ABI, shipping default or preview is changed.

Six cases read the same varying-address128KiB array with16million iterations:
ordinary private/shared, PTE-per-access, span validation followed by physical
reads, and high-bit tagged private/shared two-memory dispatch. Tag selection
is loop-invariant; this is not a generic mixed-pointer stream. Each case has
an ordered first invocation, five100k warmup calls and seven measured rounds
in each of two opposite orders. One Worker/parent per host supplies84 samples,
336 total; cohorts are not independent parent launches. Setup/compile,
first invocations, checksums, timer steps, load and every sample are retained.
The real span validation and extra JS/Wasm invocation remain inside timing.

Ratios below are geometric means of two cohort-median ratios. Each candidate
uses its own ordinary-addressing bank as reference; native means Wasm on the
same engine, not machine-native PHP. Lower is better:

| Host/runtime | PTE/access | Span once/loop | Tagged private | Tagged shared |
|---|---:|---:|---:|---:|
| Node24.15.0 |4.739|1.004|1.058|1.125|
| Chromium153.0.8010.12 |5.281|0.994|1.052|1.289|
| Firefox155.0 |3.054|0.998|1.415|1.415|
| WebKit26.6 |4.896|1.002|1.618|1.407|

Do not interpret tiny deviations around1.0 as measured speedups. The important
first-screen result is near-ordinary pinned-loop cost across engines and much
lower cost than per-access PTE translation. Final minimum samples are4.58ms
or longer and exceed100 observed clock steps; observed steps are0.005ms in
Chromium and0.020ms in Firefox/WebKit. Chromium PTE cohort ratios vary5.081/
5.489; all individual orders remain. A registered peer nix-world build is
running before the final screen and observed load ranges8.19–14.42. This is
not a quiet-machine or steady-state/application performance claim.

Five mechanism checks per host cover a scattered second page rejecting the
span, correct translated fallback, matching read-denial traps for span and
PTE paths, and restored contiguous acceptance. An initial new negative check
incorrectly expected the existing host span validator to return zero for a
permission fault; it actually traps. Source inspection confirms the export
binds vm_span. The test is corrected to require matching traps, without
changing that validator. vm_span is not the non-faulting vm_try_span used by
the separate regional optimizer. Moving arbitrary faults or stores before
a loop is not justified by this read-only pinned experiment.

Run1 stops at that negative-check failure before browser timing; its exact
source snapshot, error and log remain. Run2 passes all four hosts with the
historical one-million iteration count, but sub-millisecond samples are too
close to browser clock steps for small comparisons. Run3 lengthens work
inside Wasm to16million without adding JS calls per sample. All checks pass,
19 frozen current inputs and five historical build/helper/module identities
verify unchanged. Browser tests use the repository quiet fixture and fail
rather than skip missing engine capabilities. The memory-authority audit
initially reports the four new fixture constructor sites; reviewed ownership
classifications are added and all10 contract tests pass. Logs remain with
the source versions they validated.

**Survey implication:** guarded loop/affine access has an attractive cost
ceiling; a real PHP optimization still needs an origin/span/lifetime proof,
correct fallback/fault order, mapping invalidation and child rematerialization.
Two-memory dispatch also merits retention, but its explicit pointer tag,
ordinary bank bounds and unchanged-bank loop do not implement general mmap
permissions, current pointer ABI or PHP fork. Mixed tags, writes, changing
mappings and real application coverage remain unmeasured by this screen.
This bounded browser extension ends here rather than growing another matrix.

Raw run1/2/3 data, exact source snapshots, inputs, audit logs, analysis and the
breadth summary are retained in phase35 of the survey archive. Full platform
benchmark/conformance, canonical images and browser-memory acceptance were
not run for this private synthetic screen.


### VM-04/07/08: real WordPress regional guard and access coverage

Phase36 measures applicability of the existing min4 regional pass instead of
adding another optimization or timing matrix. The original regional FPM
module (`ae85f9dd844db394437b9000d58dadceb5f6991d954ef4ec8edc86b29b7b84e4`)
and helper remain unchanged. A separate counter pass instruments a diagnostic
copy. The existing frozen access-diagnostic host profile supplies nine physical
counter pages per root; original function counters and new per-region pairs
share the fixed65792-slot budget. Plans exceeding the unused tail are rejected.
Normal host/runtime/ABI, allocator behavior, compiler flags and preview are
unchanged. This is not a new PHP optimization or an uninstrumented speed test.

**Counter correctness:** the ordinary counter output still reproduces the
phase27 artifact SHA `203e98ae28c021f96a8ad18cd97b945bdbc1ce542c07512aa6058821867ae538`
byte-for-byte. Regional mode checks the exact merged helper bodies, matching
source/guard metadata, region inventory, base/span/rights/root arguments,
expected call/tee/if shape and every fast-body site count. It refuses unaccounted
raw source memory operations and unfamiliar fast-body control. Original
function/global ordinals remain unchanged. New counters distinguish original
operation dispatches, actual raw fast-path attempts, guard attempts/hits/misses
and individual region branches. The accounting verifies category/function
totals and aggregate/per-region guard totals independently.

A synthetic four-access region records four fast attempts on a hit and four
translated attempts on scattering. Read-denial records the attempted third
store and preserves prior stores. An arithmetic-trap control records three
actual fast attempts despite four static sites, demonstrating why weighted
static sites must not be reported as executed accesses. Child counters start
independently; missing diagnostic metadata traps. All15 mechanism checks pass
on Node and Chromium/Firefox/WebKit. A strengthened fixture initializes the
writable prefix to8,8 before expecting1,2 after the denied later store; the
three-browser/Node repeat passes. The original fixture and strengthened source
versions remain. Negative tool inputs reject wrong site counts, mismatched
span arguments and the ordinary-helper contract for guarded input.

**Real application:** one fresh parent per host uses the same regional counter
module, frozen access profile, existing WordPress SQLite image, shared OPcache,
timestamps disabled, two warmup rounds and one measured mixed four-page round.
Snapshots bracket the measured requests before the separate cache-status
checks. Counts include background/tail activity between asynchronous snapshots.
Every frontend/article/authenticated-admin/REST, two-worker cache, error-stream
and teardown check passes. Browser execution uses the quiet fixture and keeps
all guest memory in disposable workers. All6 browser tests pass in2.0min;
the Node mechanism/application checks pass.60 frozen app inputs verify stable
at collection completion;14 strengthened-fixture inputs also verify stable.
These are four coverage samples, not independent timing replications.

| Host | Attempted original dispatches | Actual fast attempts | Fast share | Guard hits / attempts | Active regions |
|---|---:|---:|---:|---:|---:|
| Node |378255282|6548985|1.73137%|1522491 /1522491|451|
| Chromium |378253126|6548989|1.73138%|1522498 /1522498|451|
| Firefox |378256759|6549061|1.73138%|1522510 /1522510|451|
| WebKit |378255543|6549025|1.73138%|1522507 /1522507|451|

All observed guards hit; the limitation in this trace is selection coverage,
not failed contiguity/permission validation. Only451 of7910 static regions run,
across187 parent functions. Each successful guard covers~4.3015 actual accesses.
The Node top25 regions supply94.24% of fast accesses, not94.24% of all work.
Counting every dispatch in the187 active parent functions yields an upper
bound~15.80% of all dispatches; that is not a realizable optimization share.
Several hot functions, including execute_ex, have no selected region. Guard
selection needs broader useful origins/control structure, not merely cheaper
validation of these same regions.

**Frame classification limit:** a fresh read-only scan of the exact original
ordinary FPM reproduces the phase29 feasibility JSON byte-for-byte. Joining
source function/base-local IDs identifies135 active regions whose base local
matches a syntactic frame construction. Their weighted hit sites are696903
on Node,10.64% of fast attempts and0.1842% of all attempts. This is a syntactic
local-ID match, not a proof that the local still holds that frame at every
region, a lifetime/alias certificate, or the dynamic fraction of all stack
accesses. It does not justify discarding stack hoisting. The static-only
whole-function frame estimates remain upper bounds; broader frame-origin,
loop, affine-arena and heap-pointer analyses are still distinct opportunities.

**Interpretation:** current regional coverage is too small to make the
phase35 near-native pinned-loop cost a forecast for WordPress. The1.73%
figure is an operation-dispatch fraction, not CPU time, bytes, page-table
lookups saved or a speedup ceiling. Bulk operations each count as one dispatch;
operations have unequal costs and this pass adds guard work. Diagnostic
atomics/calls/code size also invalidate latency ratios from these runs.
The measured gate is useful evidence for deprioritizing more fine tuning of
the same guarded regions while investigating coverage in frequent uncovered
functions and mappings. Safe mapping lifetime and fork rematerialization
remain necessary; mere fork-free call trees remain insufficient.

Failures retained: the first Rust build omitted the Context trait import;
the first regional transform correctly rejected the normal helper supplied
for a synthetic fixture that actually uses the older diagnostic helper.
The matching fixture helper fixes that input mismatch without relaxing body
verification. Ordinary reproduction succeeded in that failed transform run.
All subsequent valid transforms and mechanism/application analyses pass.
No runtime/toolchain defect is alleged. Sources, input hashes, exact helper
variants, failed/passing logs, raw roots/slots, per-region rankings and analysis
remain in phase36 of the retained survey archive. The existing partial shell
and WordPress SQLite artifacts were reused; canonical builds, full platform
benchmark/conformance and browser-memory acceptance were not run for this
private diagnostic. Full goal and all neutral/negative ideas remain active.


The final ordinary ownership suite records9 passing checks and a full-source
check timing out at its300s watchdog (441.88s suite wall time, observed load
42.5→53.0). That suite is not reported as passing. A separate bounded runner
extracts the unchanged authoritative test preamble/policy and its exact audit
call, retaining all source inventory, seeds, allowances, kernel exports and
factory declarations. Its first launch fails to resolve TypeScript from the
scratch directory; resolving the already-declared host dependency corrects
that runner. Job common-memory-regions-authority-1111-213728-fd11 succeeds in
1m18s; the full audit returns zero findings across1021 source files in73.78s,
and the original policy hash remains unchanged. The different elapsed times
do not establish a cause for the suite timeout. Both failures, runner versions,
generated exact policy, result and terminal receipts remain with phase36.

Additional VM-09 follow-up retained: first characterize dense private prefixes
and contiguous shared extents per root, then count dynamic addresses that fit
those affine windows. A guarded affine base could serve that subset while
all other mappings retain the original path. Stable bounds/permissions and
map/protect/unmap/grow/fork publication remain required; cached physical bases
must be rebound for children. Private-plane reservation or relocation would
also need an explicit allocation/reservation budget, not just faster address
arithmetic. No such PHP fast path or coverage measurement is implemented here.
ARCH-01 mixed-tag pointer streams remain another bounded applicability screen;
the phase35 loop-invariant tag result does not answer that question.


### VM-09: real WordPress affine-window applicability

Phase37 tests whether a mapping-based alternative reaches more real accesses
than the narrow regional grammar. `--observe-affine` is a new opt-in private
instrumenter mode, requiring its matching helper and plain outlined accesses.
It observes original base/constant-offset/width/rights before each wrapped
scalar, SIMD or atomic operation, then runs the original translation and
operation unchanged. Bulk copy/fill/init and memory-size/growth dispatches
are excluded from this denominator. No affine fast path is enabled.

The observer scans current PTE geometry on root epoch/page-count changes,
selecting a RW private prefix, largest RW private run and largest accessible
shared run. Contiguity includes physical order, rights and private/shared tag;
protected/unmapped pages split runs. Every observed address still checks live
first/last PTEs and rights/bounds before it contributes to a candidate. A
deliberately untracked-remap fixture detects a stale candidate, excludes that
attempt, and refreshes on the next one. This is an empirical applicability
screen, not an independent certificate that all mutation routes are covered.

A separate address-wise test asks whether private entries outside the prefix
still equal prefixPhysicalBase+virtualAddress. Such matches can occur on both
sides of shared holes in dense fork destinations. They do not prove that a
whole private plane is valid: holes, aliases, permissions, bounds and all
shared exceptions remain necessary. Candidate selection is by mapped size,
not dynamic hotness; additional smaller windows remain another idea.

**Diagnostics and controls:** existing access-diagnostic profiles/nine physical
pages per root are reused byte-for-byte. A64-byte cache occupies their unused
slack; counter/gauge storage adds no further allocation or reservation. The
version2 observer uses one attempt increment plus one16-bin mask classification
for an ordinary valid event; marginals and unions derive from those exact
bins. Invalid bounds/permissions, disabled epochs, stale matches, split-page
attempts and geometry refreshes are separate counters; last-geometry gauges
are never subtracted as cumulative counters. An earlier direct-marginal
version was built but not used for application measurements; its sources,
artifacts and reports remain. No performance comparison uses those diagnostic
implementation versions.

Both ordinary baseline and small-fusion FPM outputs reproduce their old hashes
exactly in both builds. Missing helper/option, expanded mode and fusion
combinations are rejected. Matching diagnostic FPM SHA is
`2880c27f012d4a366a743839b4cd8bc78f15529c9c49201ad0e9e3eb97525eca`;
helper SHA is `3d45217473f51fe3b7630a0edfad3564ecce3f4476ac5073fa494f318e6eea7e`.
Actual original source/global indices are preserved; helper/wrapper additions
remain the existing private transformation model. Normal host/runtime/ABI,
PHP compiler flags, kernel, image and shipping defaults remain unchanged.

**Mechanisms:**36 checks pass on Node and each browser engine. They distinguish
prefix/largest-private/shared selection and a private plane across a shared
hole; cover read-only and PROT_NONE protections, private aliases, stale live
entries, host and actual guest growth, unmap/replacement/moving remaps,
constant-offset overflow, split SIMD, aligned/unaligned atomic behavior,
floating operands, independent fork counters/private bytes/live shared bytes,
disabled epochs and missing diagnostic hosts. Cache state lives in physical
per-root diagnostic pages, never guest payload; only copied scalar JSON leaves
the disposable Worker. These mechanisms do not establish general concurrent
mmap, pthread or untrusted-module isolation. Native backing-growth/retirement
acceptance remains part of a future actual fast-path gate, not this screen.

**Application collection:** owned job common-memory-affine-wordpress-1111-221733-f688
succeeds after2m34s. Node and all6 browser mechanism/application tests pass;
browser tests take1.9min. The same frozen WordPress SQLite image, kernel and
pregrown diagnostic profile run shared OPcache with timestamps disabled,
two warmup rounds and one measured mixed frontend/article/authenticated-admin/
REST round per fresh host parent. Four requests are bracketed before the
separate two-worker cache-status checks. Background/tail work is included
between individually atomic snapshots; they are not a globally atomic table
snapshot. All application/cache/error-stream/teardown checks pass.67 frozen
collection inputs and15 mechanism inputs verify stable at completion.

| Host | Wrapped attempts | Private-prefix share | Largest shared-window share | Prefix+shared share | Plane+shared address matches |
|---|---:|---:|---:|---:|---:|
| Node |377451781|16.1800%|24.7339%|40.9140%|81.9531%|
| Chromium |377456738|16.1801%|24.7338%|40.9139%|81.9490%|
| Firefox |377459111|16.1806%|24.7337%|40.9143%|81.9491%|
| WebKit |377456581|16.1801%|24.7338%|40.9139%|81.9490%|

Largest-private selection chooses the prefix in this workload, so that union
adds no extra coverage here. There are48 geometry refreshes on every host,
zero observed invalid-range/permission/disabled-epoch/stale-entry events and
four split-page attempts. Prefix size is399pages(24.9375MiB); the largest
shared run is513pages(32.0625MiB). Each process's cached window descriptors
are identical at all four logged snapshots, while other mappings/page counts
change. This does not rule out transient changes between snapshots. Complete
per-root counts/gauges, versions, every snapshot and the mixed-bin data remain.

**Interpretation:** this is substantially broader address applicability than
the existing region selector's~1.73% dispatch share, with a slightly different
denominator (phase36 includes bulk/size/growth dispatches). It supports a
bounded actual affine-window fast-path experiment. It is not a measured
speedup, CPU fraction, percentage of bytes, elimination of40.9% of all runtime
work, or evidence that81.9% may safely skip checks. Per-access cache guards and
fallback overhead must be measured against matched ordinary/VM controls.
Counters, extra calls and code size invalidate latency comparisons from these
runs; no elapsed diagnostic time is ranked as application performance.

Retain alternative cache placements despite the earlier root-header cache
regressions. A per-instance-global window cache may avoid repeating PTE work,
but must refresh on root/epoch changes and bind anew in children. Append-only
C guest growth changes page count without an epoch update; old fixed windows
may remain valid but incomplete, a distinction that must be proved explicitly.
Map/protect/unmap/mremap, imports/channel resume and epoch-zero/wrap handling
remain obligations. No physical temporary may survive fork with its parent's
base, and cached mappings must never copy mutable shared payload.

Additional variants retained: two or more private windows selected by dynamic
hotness; a coarse bitmap of fully validated private affine blocks kept in
instance globals, with the original path for exceptional blocks and shared
ranges; address/layout effects of sparse fork and extent reuse; and explicit
private-plane reservation/relocation tradeoffs. The bitmap idea must validate
whole blocks, reject partial/protected/aliased blocks and handle mapping
publication, not infer validity from one sampled address. Dense/sparse layout
combinations may trade allocation capacity against address arithmetic. No
bitmap, extra reservation, relocation or non-diagnostic global fast path was
implemented here. ARCH-01 mixed-tag stream costs remain a separate follow-up.

Sources, both observer designs, byte-exact default reproductions, failed-option
controls, all raw mechanism/application data, analysis, input hashes and job
receipts are retained in phase37 of the survey archive. The existing partial
shell and WordPress SQLite artifacts were reused; no canonical image rebuild,
full platform benchmark/conformance or browser-memory acceptance run is claimed.
The broad survey goal remains active, and all prior negative/inconclusive
compiler/cache/region variants remain cataloged.


The unchanged full-source ownership audit/policy also passes independently in
job common-memory-affine-authority-1111-224809-57bd:1025 files, zero findings,
39.55s audit time,0m42s job time. The original policy hash remains unchanged
during that run. Only the reviewed Worker-local synthetic instance intrinsic
was added to the policy. The complete Vitest suite was not rerun here; its
phase36 timeout remains retained separately. No source filters or repository
timeout changes were used for this audit. Actual non-diagnostic fast-path and
full acceptance checks remain future work.


### VM-09: actual affine-window cache first screen

**Meaning and hypothesis:** within a validated contiguous virtual range,
`backingOffset = virtualAddress + delta`. The backing offset addresses the
shared WebAssembly.Memory, not physical RAM. A forked child keeps canonical
virtual pointers and binds its copied private range to its own delta; shared
ranges retain common backing. The potential saving is repeated PTE lookup,
rights/contiguity decoding and dependent memory loads. The stronger future
variant validates a loop/span once, amortizing the guard across many accesses.
The prior40.9% applicability count is not a speedup or a lifetime certificate.

For example, a canonical pointer of `1000` could address backing byte `9000` in
the parent and `17000` in the child, using private-range deltas `8000` and
`16000`. The stored guest pointer stays `1000` after fork; the mapping binding changes. A
shared range instead uses the same backing binding in both processes. This
is a piecewise affine mapping: one delta cannot describe arbitrary fragmented
pages or ranges with different protection. A checked fast path must cover the
entire accessed span and its permissions, and fall back when that certificate
does not hold. A literal add on every access and a guarded cache lookup on
every access have different costs; the implemented screen measures the latter.

This first implementation is deliberately conservative: nine appended,
unexported, nonshared instance globals cache a RW private prefix and the
largest accessible shared run. Every eligible scalar access checks root,
epoch, logical size, bounds and rights before using the offset; misses execute
the exact previous path. Bind scans happen outside individual hits, on initial
binding or observed root/epoch/pages changes. Root-header words6..11 are
reserved for this mode, which cannot mix with old header caches/diagnostics.
Guest pointer values remain virtual; physical temporaries do not cross a fork.
Atomics/SIMD use their previous paths. No payload snapshot is cached. Epoch0
(including wrap) permanently selects the old translator. This uses the private
single-Worker-per-process stopped-mapping publication protocol; no general
concurrent-remap, pthread, untrusted-isolation or new ABI acceptance claim.

**Artifacts and checks:** baseline FPM f879effe... and small-offset FPM2edbcf32...
reproduce exactly. Affine FPM408ec946... and affine+small e3aa5008... each add
184572bytes(~0.485% of the respective outlined module). All20 fixture/access/
array/fork/FPM transforms succeed and five incompatible option/helper controls
are rejected. Both cache modes pass33 targeted mechanisms plus the existing
numeric/SIMD/atomic/split-access forms on Node, Chromium, Firefox and WebKit
(9 browser tests including timing). An intentional unpublished PTE-write
control returns stale data, proving a hit bypasses the PTE; publishing the
change refreshes correctly. This negative control is not supported untracked
mapping mutation. Root, rights, logical shrink/restore, host/guest growth,
map/protect/unmap/mremap, aliases, splits, overflow, epoch wrap and private child
rebinding/live shared payload checks pass. Real Node fork and shared FPM also
pass for both modes, including cross-worker OPcache publication/invalidation
and worker replacement preserving the cache.

**Synthetic cost:** actual guarded scalar reads over pinned128KiB arrays,
16million reads/sample, seven rounds in each of two reversed cohorts within
one disposable Worker/host. Ordinary Wasm reads the same backing and baseline
data; checksum and setup/first-call data are retained separately. Values below
are geometric means of cohort median ratios to that bank's ordinary Wasm.
These are different kernels from earlier2–3x reports, not a revision to those
results. Each host has140 measured samples; no independent-parent replication
or PHP claim follows from this loop alone.

| Host | Baseline private/shared | Small private/shared | Affine private/shared | Affine+small private/shared |
|---|---|---|---|---|
| node | 5.688/5.934 | 4.621/4.762 | 8.469/9.004 | 13.944/14.488 |
| chromium | 6.349/6.301 | 5.277/5.279 | 7.493/8.064 | 12.595/13.107 |
| firefox | 6.084/6.172 | 3.391/3.262 | 7.987/9.183 | 7.825/8.807 |
| webkit | 5.625/5.493 | 4.881/4.952 | 8.409/8.695 | 12.509/12.292 |

The implementation regresses every loop comparison: affine/baseline1.18–1.58,
affine+small/small2.31–3.04 across hosts/banks. Every sample is longer than4.5ms;
minimum timer steps are0.000041ms(Node),0.005ms(Chromium),0.02ms(Firefox/WebKit).
These do not eliminate order/JIT/load variability. Additional guards, global
loads, branches, calls and generated-code shape are possible explanations,
not measured CPU attribution or an engine defect.

**Actual application:** owned job common-memory-affine-cache-apps-1111-234307-bb6b
succeeded in12m04s: four real fork/FPM checks,10 Node parents and30 browser
parents. Each host has identical ordinary opening/closing builds and two
opposite VM orders, all using the same normal pregrown diagnostics-off host
profile. Existing frozen SQLite WordPress image, shared OPcache, timestamp
validation off for immutable code, one warmup and three measured shuffled
home/article/admin/REST rounds per fresh parent. All40 parents/480 measured
responses pass real page/admin/cache/two-worker/group/teardown controls. All190
outer input hashes were unchanged at completion; each host's collection also
verifies its frozen inputs. This is a bounded first screen, not a stationary
steady-state, startup-latency, held-out-corpus or platform acceptance study.

Ratios are geometric means across per-page medians and then across cohorts;
above1 means longer warm-request latency. Each order is retained explicitly.

| Host | Affine/baseline orders | Affine/baseline combined | Affine+small/small orders | Affine+small/small combined |
|---|---|---|---|---|
| node | 1.237/1.459 | 1.343 | 0.941/1.399 | 1.147 |
| chromium | 1.491/1.390 | 1.440 | 1.550/1.482 | 1.516 |
| firefox | 1.501/1.526 | 1.514 | 0.744/1.610 | 1.094 |
| webkit | 1.819/1.498 | 1.651 | 1.827/1.424 | 1.613 |

Affine alone is slower in both orders on every host. Combined-cache comparisons
on Node and Firefox change direction by order and are not reliable gains;
Chromium/WebKit regress both. Affine+small/baseline is also slower in both
orders on every host. The ordinary closing/opening geometric latency ratios
are0.730(Node),0.970(Chromium),0.876(Firefox),1.027(WebKit). In particular, Node's
27% ordinary drift and Firefox's12% drift limit precision; do not hide this
behind combined numbers. No confidence interval or quiet-machine claim is made.
Every page/cohort/round/load observation and exact runtime version is retained.

| Host | Baseline/ordinary | Small/ordinary | Affine/ordinary | Affine+small/ordinary |
|---|---|---|---|---|
| node | 1.347 | 1.317 | 1.810 | 1.511 |
| chromium | 1.357 | 1.192 | 1.953 | 1.807 |
| firefox | 1.264 | 1.662 | 1.913 | 1.818 |
| webkit | 1.065 | 1.133 | 1.758 | 1.827 |

Ordinary means untranslated Wasm on the same engine. These application ratios
compare VM shared OPcache with ordinary file-cache mode and therefore include
cache-mode effects; they do not isolate translation tax. Small fusion remains
host/order dependent in this short screen; its earlier independent results
are not replaced. No canonical program, image, runtime default or preview was
changed. No full platform benchmark/conformance/ABI acceptance is claimed.

**Decision and preserved variants:** the actual cache mechanism works, but this
per-access guarded implementation is not worth promoting. Park deeper cache
replication and move to another survey family. Keep (a) once-per-loop/span
validation and checked physical-base reuse, (b) a split cold binder/reload path
to test inlining/code-shape hypotheses, (c) boundary-refreshed instance globals
with a complete import/channel/map/protect/unmap/fork publication proof,
(d) monotonic-size/pinned-window variants only after proving their lifetime,
(e) multiple hot private windows or validated block bitmaps and (f) allocator/
layout and two-memory alternatives. Omitting the current per-access checks
without those proofs is not an implemented optimization. These variants remain
ideas to test; this result does not establish that affine addressing in
general is ineffective. The pending unprofiled WordPress byte-snapshot screen
is a distinct next breadth step; MariaDB and longer replication of this cache
are not prioritized by this negative screen.

Raw sources, scripts, exact artifacts, all successful/negative/failed controls,
synthetic and application data, input hashes and job receipts are retained in
phase38 of the survey archive. The first authority-audit attempt rejected an
invalid `authorityOwner` annotation on an intrinsic-escape allowance; the
annotation was corrected without weakening source coverage or policy. Both
receipts are retained. The complete Vitest suite's earlier timeout remains
separate from the direct full-source audit; no full-suite pass is claimed.

The corrected complete-policy direct source audit passes:1030 runtime source
files, zero findings,38.85s audit time; original policy unchanged during the
run. No source filters or repository timeout changes were used.


### VM-05: actual WordPress byte-snapshot latency screen

This phase closes the first missing unprofiled WordPress latency comparison
for the corrected host byte-snapshot candidate. The optimization can replace
per-element virtual-byte proxy iteration with a coalesced copy across proven
mapped spans. It preserves the admitted constructor/iterator/conversion and
fallback contract established by the44-case mechanism screen; it is not a
new guest-loop transformation or full native TypedArray emulation. No program,
compiler, image or normal host source was rebuilt. Corrected candidate-profile-2
and baseline bundles match their frozen manifest inventories; all seven
candidate files also match the retained phase16 corrected profile byte for
byte. The superseded constructible-method candidate-profile-1 was NOT used.

The four modes are baseline, small-offset fusion, byte snapshots alone and
byte snapshots plus fusion. Guest artifacts are identical in each byte pair:
f879effe... for baseline/bytes and2edbcf32... for fusion/fusion+bytes. All own
ordinary controls use untranslated FPMbe6a6eae... with their respective baseline
or byte-enabled host profile. This explicitly captures ordinary-path effects
rather than borrowing a reference-profile ordinary bracket. The plan rejects
missing/mismatched profile/native bindings, identical candidate/reference
profiles and unequal guest artifacts in a byte-only pair;13 positive/negative
routing checks pass. Diagnostic-enabled profiles are rejected by the existing
frozen-input collector.

**Protocol:**12 fresh parents/host,48 total, using the frozen SQLite WordPress
image, shared OPcache and explicit timestamp validationOFF for immutable code.
Each parent performs two warmup and five measured mixed home/article/admin/
REST rounds. Two opposite VM orders are bracketed by four own-profile ordinary
parents per host, each with file-cache OPcache. All48 parents/960 measured
requests pass page content, login/admin, REST JSON, cache/two-PID/group and
teardown checks. Browser controls additionally require no crash/page errors,
stderr/diagnostics, and cross-origin isolation through the standard quiet
fixture. This is a bounded first screen, not a stationary steady-state,
startup-latency, MariaDB latency or platform acceptance claim.

The launch inventory records peer job nix-world2-1111-231401-186c active in
another workspace; exact mid-run and end-run results confirm it remained
live. The retained end inventory also records a SpiderMonkey build
(node-build-config-declared-generator-1112-000806-3697,3m19s) and later Node/
browser controls starting during this collection. These are overlap records,
not CPU attribution or proof of continuous heavy CPU use.
No quiet-machine claim is made. Own timing/build/audit work is serialized;
no source edits occur during collection. Both cohort orders and load values
are retained; no request/sample/slow parent was filtered or replaced.

Below, ratios are geometric means of four per-page median latency ratios;
the two order values and their geometric mean remain separate. Values below1
favor the candidate. These are warm end-to-end requests, not guest CPU time.

| Host | Byte/baseline orders | Byte/baseline combined | Byte+fusion/fusion orders | Byte+fusion/fusion combined |
|---|---|---|---|---|
| node | 0.868/0.908 | 0.888 | 0.888/0.916 | 0.902 |
| chromium | 0.950/0.909 | 0.929 | 0.903/0.909 | 0.906 |
| firefox | 1.965/0.931 | 1.353 | 0.895/0.973 | 0.933 |
| webkit | 0.984/0.949 | 0.967 | 0.955/0.923 | 0.939 |

**Interpretation:** Node byte-only latency is11.2% lower than baseline and
byte+fusion is9.8% lower than fusion; both cohorts favor each byte pair.
Chromium corresponding first-screen reductions are7.1% and9.4%, also favoring
both orders. WebKit shows3.3% and6.1% lower aggregates, but its ordinary drift
and small standalone effect limit precision. Firefox byte-only changes from
1.965 in one order to0.931 in the other; its1.353 combined ratio is not a
stable35% penalty or evidence of a benefit. The slow candidate parent stays
included; no external runtime defect or causal explanation is established.
Firefox bytes-after-fusion is.933 overall (.895/.973), with a small REST
regression in one order. Its closing ordinary controls are46–57% slower than
opening controls. The slow byte-only parent spans one-minute load4.89→17.61;
a peer build overlaps. This strengthens the confounding limitation; it does
not establish the cause of that parent's slowdown.

Combinations are not universally additive. Node/Chromium byte+fusion is
.773/.825 of the unfused baseline. Firefox's .847 aggregate is accompanied
by the variability above. WebKit fusion-only is1.093/baseline, so its final
byte+fusion1.026/baseline does not improve the unfused baseline despite
helping the fused variant. Retain fusion separately rather than selecting
all switches on the strength of individual wins.

**Survey decision:** host bulk-copy adaptation is a promising application
candidate, strongest here on Node/Chromium. It warrants MariaDB confirmation
and later replication; these data do not justify a universal preset or default
promotion. Keep the Firefox inconsistency, WebKit's small signal, prior file-
cache regressions and all original mechanisms. For breadth, the next distinct
cost screen should exercise mixed private/shared pointer streams in ARCH-01,
whose previous tagged-bank result used a loop-invariant tag. MariaDB and
preload latency remain explicit subsequent application work; do not silently
mark them completed. Per-access affine-cache tuning stays parked.

The full page/cohort/round data are authoritative; an overall gain does not
imply every page improves. For each individual pair, page/order ratios below
show every exception as well as the range. Ordinary closing/opening drift is
reported independently for each host profile.

| Host | Pair | Page/order min–max | Page/order ratios>=1 |
|---|---|---|---|
| node | byte-slices/baseline | 0.840–0.964 | none |
| node | byte-slices-fused/fuse-small | 0.851–0.984 | none |
| chromium | byte-slices/baseline | 0.889–1.029 | posts/order0=1.029 |
| chromium | byte-slices-fused/fuse-small | 0.871–0.956 | none |
| firefox | byte-slices/baseline | 0.856–2.043 | home/order0=1.924, article/order0=2.043, admin/order0=2.001, posts/order0=1.898, admin/order1=1.026 |
| firefox | byte-slices-fused/fuse-small | 0.858–1.026 | posts/order1=1.026 |
| webkit | byte-slices/baseline | 0.929–1.055 | admin/order0=1.022, posts/order0=1.055 |
| webkit | byte-slices-fused/fuse-small | 0.857–1.013 | admin/order0=1.013 |

| Host | Baseline ordinary drift | Byte ordinary drift | Byte-profile ordinary / baseline-profile ordinary, orders |
|---|---|---|---|
| node | 0.994 | 1.043 | 1.032/1.083 |
| chromium | 0.861 | 0.982 | 1.025/1.169 |
| firefox | 1.569 | 1.461 | 1.118/1.041 |
| webkit | 0.906 | 0.876 | 1.022/0.989 |

Ordinary-normalized pair/page ratios are also retained in analysis.json to
make profile/control drift visible; they are not a corrected estimate of
pure translation tax. No confidence interval, causal CPU decomposition or
universal additivity claim follows from this first screen.

| Host | Baseline/own ordinary | Fusion/own ordinary | Byte/own ordinary | Byte+fusion/own ordinary | Byte+fusion/baseline |
|---|---|---|---|---|---|
| node | 1.517 | 1.301 | 1.274 | 1.110 | 0.773 |
| chromium | 1.321 | 1.203 | 1.122 | 0.996 | 0.825 |
| firefox | 1.110 | 1.006 | 1.391 | 0.871 | 0.847 |
| webkit | 1.071 | 1.170 | 1.030 | 1.093 | 1.026 |

Ordinary means untranslated Wasm on the same engine, not machine-native PHP.
VM/ordinary compares shared OPcache with file-cache mode and includes those
cache-mode effects. Timing covers only the kernel-Worker byte profile admitted
by the original build; no broader process-Worker coverage or memory/RSS/GC
benefit is inferred. Prior diagnostic branch counts establish actual use but
are separate from these unprofiled timings. Previous load-confounded FPM
screens, file-cache regressions and slow Firefox parents remain retained,
not pooled into this WordPress result or erased by it.

**Evidence:** owned job common-memory-byte-wordpress-1112-000147-3f71, its terminal
receipt (terminal0 after15m12s),48 parent outputs, complete input snapshots, both host profiles,
unchanged guest artifacts, scripts and analysis are retained under phase39.
All outer and collector input hashes are unchanged at collection completion.
The exact complete-policy direct source audit passes with no findings;
its receipt is separate from the earlier full Vitest suite timeout. No full
platform benchmark/conformance/ABI or canonical-image acceptance was run.
The frozen preview and shipping defaults remain untouched. All unsuccessful
compiler/cache/regional/affine candidates and their future variants remain
cataloged. Guest loop/SIMD transformation, byte thresholds/widths and memory/
resource attribution remain separate ideas; this screen does not discard them.

Direct source audit: 1032 files, zero findings, 40.97s; exact original policy unchanged during the run.


### ARCH-01: dynamic mixed-pointer read/write cost

This phase tests a missing condition in the earlier two-memory cost screen:
that screen kept the tag constant throughout each loop. Here each payload
pointer is loaded from memory inside the loop, and its high bit selects the
private or shared bank. A known-private pointer table supplies those pointers;
this does not model a completely generic pointer-chasing structure whose table
address also needs dispatch. High-bit memory32 encoding affords2GiB per bank
and changes the pointer ABI. No PHP/SDK/kernel ABI integration is implemented.

Four controls use the same logical values, address permutation, pointer order
and operation count: ordinary flattened one-memory addressing; tagged routing
to two regions of that same memory; tagged routing to two separate memories;
and the current small-offset-fused PTE translator applied to the ordinary
module. The VM pointer-table load and payload accesses are translated; the
native/tagged tables use their explicit memory. This compares the actual
architectural paths, not just an isolated arithmetic tag test. Its ratios are
a different gather/RMW kernel from earlier sequential2–3x addressing reports.
All memories/instances stay in one disposable Worker/host; only copied JSON
leaves. The aggregate declared maximum reservation is12MiB, not an RSS claim.

There are32768 entries per stream, with a bijective permuted data index and
128KiB data per bank. Seven patterns cover private-only, shared-only,
alternating,256-entry clusters, shuffled50/50 and shuffled approximately1%/99%
shared. Exact shared counts/transitions are retained (the skewed minority is
328/32768). Distinct bank values make misrouting visible. A negative checksum
control rejects using the first tag for an entire mixed stream, closing the
loop-invariance loophole. The table stays private and stable throughout timing;
mutable payloads remain live. These are aligned ordinary scalar accesses,
not volatile/atomic transactions or arbitrary concurrent remapping.

Both reads and non-atomic read-modify-writes perform8388608 iterations/sample.
RMW XORs the selected word with0x5a5a5a5a; even full stream cycles restore all
contents. JS BigInt expected checksums validate every invocation; complete
payload contents across all models are checked after warmup and measured
cohorts.32 mechanism/content checks/host also cover inherited pointer values
after a synthetic private byte copy, private isolation/live shared bytes,
legal aliasing of both memory imports, unaligned native scalar behavior,
bounds failures and VM alias/permission controls. This is not SDK/kernel fork,
general mmap/protection/remap, pthread or application acceptance. Source-level
private/shared names do not imply nonaliasing: the alias control must remain.

**Build and collection:** generated WAT and Wasm validate, including the
instrumented module; six build commands succeed. Owned job
common-memory-mixed-pointers-1112-002930-36f5 succeeds in43s. Node24.15.0,
Chromium153.0.8010.12, Firefox155.0 and WebKit26.6 each pass32checks and784
measured samples (3136total), plus56 ordered first invocations/host. All frozen
run inputs remain unchanged. Seven rounds in each of two reversed control
orders run within ONE Worker/host; patterns themselves have a fixed order.
This is not independent-parent replication, cold/tiering characterization,
stationary steady-state or a quiet-machine/application claim. First/setup
values, timer steps, every sample/checksum and load observations are retained.
Own builds/audits are serialized outside timing. Peer Nix activity is recorded
in the launch inventory; job activity alone does not establish CPU attribution.

Values below are geometric means of the two cohort median ratios to the
ordinary-addressing Wasm control on that same host/pattern/operation. Above1
means slower. Read and RMW controls have separate ordinary denominators.

| Host | Pattern | Two-memory read/RMW | Tagged one-memory read/RMW | Fused PTE read/RMW |
|---|---|---|---|---|
| node | private | 1.112/1.151 | 1.120/1.158 | 8.379/15.876 |
| node | shared | 1.214/1.601 | 1.327/1.366 | 8.468/15.948 |
| node | alternating | 1.152/1.298 | 1.206/1.220 | 9.030/15.436 |
| node | clustered256 | 1.159/1.405 | 1.178/1.212 | 7.685/13.353 |
| node | shuffled50 | 2.488/4.279 | 2.460/5.021 | 8.142/13.977 |
| node | shuffled1 | 1.257/1.287 | 1.272/1.287 | 8.822/15.687 |
| node | shuffled99 | 1.242/1.667 | 1.337/1.423 | 8.739/15.653 |
| chromium | private | 1.124/1.139 | 1.122/1.140 | 8.526/13.143 |
| chromium | shared | 1.450/2.038 | 1.329/1.346 | 8.503/13.142 |
| chromium | alternating | 1.211/1.477 | 1.204/1.244 | 8.444/13.217 |
| chromium | clustered256 | 1.266/1.585 | 1.163/1.198 | 7.467/11.115 |
| chromium | shuffled50 | 2.291/5.279 | 2.418/4.173 | 8.225/11.734 |
| chromium | shuffled1 | 1.297/1.274 | 1.287/1.263 | 8.759/13.259 |
| chromium | shuffled99 | 1.507/2.145 | 1.373/1.439 | 8.520/13.286 |
| firefox | private | 1.295/1.438 | 1.311/1.438 | 4.489/8.200 |
| firefox | shared | 1.329/1.744 | 1.385/1.915 | 4.493/8.194 |
| firefox | alternating | 1.619/1.717 | 1.705/1.660 | 4.508/8.082 |
| firefox | clustered256 | 1.394/1.551 | 1.391/1.601 | 4.183/7.020 |
| firefox | shuffled50 | 2.712/2.825 | 2.574/3.299 | 4.303/7.235 |
| firefox | shuffled1 | 1.492/1.603 | 1.433/1.592 | 4.482/8.217 |
| firefox | shuffled99 | 1.552/1.962 | 1.552/2.041 | 4.439/8.174 |
| webkit | private | 1.562/1.347 | 1.340/1.347 | 8.602/13.433 |
| webkit | shared | 1.595/1.671 | 1.345/1.353 | 8.560/13.305 |
| webkit | alternating | 1.563/1.620 | 1.222/1.318 | 8.575/13.187 |
| webkit | clustered256 | 1.531/1.477 | 1.424/1.303 | 7.448/11.058 |
| webkit | shuffled50 | 3.348/2.944 | 3.289/2.519 | 8.310/11.559 |
| webkit | shuffled1 | 1.806/1.592 | 1.822/1.605 | 8.581/12.920 |
| webkit | shuffled99 | 1.912/1.849 | 1.550/1.586 | 8.606/12.956 |

**Interpretation:** the old constant-tag cost should not stand in for generic
per-pointer cost. Shuffled50/50 two-memory reads are2.29–3.35x ordinary across
hosts, and RMW is2.82–5.28x. Both orders show the large mixed-stream penalty.
Private-only dynamic-table reads are1.11–1.56x and RMW1.14–1.44x. Alternating,
clustered and skewed results differ materially; private/shared percentage
alone does not describe the cost of a program's pointer stream. The benchmark
records source-branch decisions; hardware branch misses, generated-code causes
and compiler/JIT attribution were not profiled.

The tagged one-memory control also has a substantial shuffled-tag penalty,
so tag-dependent routing work is a separate cost from using a second memory.
The additional dual/flat-tagged difference changes by host, pattern and
operation; raw per-cohort comparisons remain in analysis.json. Do not infer
one universal instruction penalty or an outside runtime defect.

The current fused translator is slower than the two-memory control for every
measured pattern/operation on every host and in both cohort medians. In the
shuffled50 case its reads cost4.30–8.31x ordinary and RMW7.23–13.98x. This is a
promising architectural cost signal, not proof that a PHP port becomes faster:
real bank distribution/provenance, generic table pointers, pointer arithmetic,
shared allocation, mapping and fork/ABI integration still need work.

Timer and cohort limits remain visible. Minimum samples exceed2.4ms;
minimum positive clock steps are approximately0.000041ms(Node),0.005ms(Chromium)
and0.02ms(Firefox/WebKit). WebKit shuffled read cohort ratios3.046/3.679 and
RMW3.293/2.633 illustrate variability despite agreeing on a large penalty.
No confidence interval, per-engine optimum or precise CPU cost is claimed.

**Survey decision and retained alternatives:** ARCH-01 merits further design
work, with bank-specific pointer provenance and known-private/known-shared
loads important targets. Retain bank-homogeneous span specialization and
conditional-path/code-shape alternatives, validated bank-run grouping only
where access/fault order is preserved, address-space-aware compiler types,
and allocator/layout choices. No new compiler flag or branchless optimization
was tested here. Loading or storing both banks speculatively is not a proven
substitute: unused-bank bounds, live shared reads, writes, faults and aliasing
remain semantic obligations. Linked-list/generic table-pointer cases,
un-aligned/atomic/SIMD costs and real SDK/PHP integration remain future work.
The negative mixed-tag costs stay in the ledger alongside the favorable
comparison with PTE translation; neither erases earlier results.

For the next distinct application step, retain the pending MariaDB byte-copy
latency confirmation and APP-01 preload warmup/latency screen. Avoid another
large cache/compiler/atomic matrix without a new applicability question.
All prior ideas and all positive/negative/inconclusive observations remain.

Sources, generated WAT/modules, unchanged helper/instrument-tool identities,
raw mechanism/timing results, scripts, source snapshots, input hashes, load
inventory and terminal job receipt are retained in phase40. No application package/image,
canonical runtime, default or frozen preview was changed. No full platform
benchmark/conformance/ABI/browser-memory gate or complete Vitest suite pass is
claimed; the prior full-suite timeout remains separate from direct audit.

The exact complete-policy direct ownership audit passes 1035 runtime files, zero findings, 42.79s. Original policy unchanged during the audit; no source filters or repository timeout changes. Only the three reviewed fixture-owned memory/instance origins were added.


### VM-05 / APP-01: MariaDB byte latency and preload boundary

This phase confirms the byte-snapshot experiment on the existing MariaDB
WordPress variant and establishes an independent APP-01 control boundary.
No new compiler/module/profile/image build is involved. The corrected phase16
byte-profile-candidate-2 and ordinary baseline profile retain their exact seven
file identities. Baseline/byte-only guest FPM remains f879effe...; fusion/
byte+fusion remains2edbcf32...; own-profile ordinary FPM remainsbe6a6eae....
The frozen WordPress image is identical to the SQLite screen, with the normal
`wordpress-mariadb` service selected. Saved startup logs require successful
MariaDB service startup, alongside real frontend/admin/REST operation; the
analysis does not merely trust a configured backend label. The normal config
renderer selects the database from the service's backend configuration.

**APP-01 capability diagnostic (Node only):** a minimal PHP-FPM target defines
one function and one class, and the preload script writes an execution marker.
Each fresh master has two workers. Requests check function/class availability,
actual values37/41, normal sum500500, effective cache mode and preload status.
These are diagnostic capability checks, not WordPress latency observations.
Non-root guest UID/GID1000 is used with the existing partial shell/profile.
Both workers must answer in every mode; all four cases have empty stderr and
host diagnostics, successful requests and teardown. The target is never
included by the request, so function/class presence demonstrates actual
preload uptake rather than merely an ini setting or a cache statistic.

| Mode | Preload requested | Effective preload | Marker compiled | Request count |
|---|---|---|---|---|
| native-file | True | not-preloaded | absent | 4 |
| vm-file | True | not-preloaded | absent | 4 |
| vm-shared | True | preloaded | True | 8 |
| vm-shared-no-preload | False | not-preloaded | absent | 4 |

File-cache-only ordinary and VM runs do not execute this preload script or
expose its definitions. Shared OPcache does, while the shared no-preload
negative control does not. This is an observed Node/profile/target boundary,
not a browser-negative or universal PHP claim. Previous all-browser561-file
shared-preload positives remain separate. The next preload latency experiment
must compare shared-cache preload versus shared-cache no-preload. Ordinary
file-cache timing remains a clearly labeled separate reference, not an
assumed preload-equivalent control. No mode was silently changed to manufacture
matched feature uptake; capability source/results are retained.

**MariaDB byte protocol:** the existing paired fixture/plan now accepts either
SQLite or MariaDB explicitly, recording the backend in settings/scope. The
12-parent/host plan and application settings remain the same: four modes,
two opposite VM orders, two own-profile ordinary opening controls and two
closing controls, immutable-code timestamp checksOFF, two warmup and five
measured shuffled home/article/admin/REST rounds. All48 parents/960 measured
responses pass artifact/profile/backend/ini/page/login/REST/cache/twoPID/group/
teardown checks. The36 browser cases require standard quiet fixtures, no
crashes/page errors/stderr/host diagnostics and cross-origin isolation. All
frozen collector and outer inputs are unchanged at completion. Separate SQLite
source/input snapshots are preserved; its original screen is not rewritten.

Ratios below are geometric means of per-page median request-latency ratios,
then of the two cohorts. Below1 favors byte snapshots; both orders remain
explicit. A combined candidate uses fusion-only as its immediate reference.
These are end-to-end warm requests, not CPU clocks or throughput tests.
Aggregate byte-only reductions are15.7%(Node),15.6%(Chromium),6.6%(Firefox)
and5.3%(WebKit); after-fusion reductions are5.0%,7.8%,4.6%,4.6%. Both orders
favor each aggregate, but Node after-fusion order1 is near-neutral(.993).

| Host | Byte/baseline orders | Combined | Byte+fusion/fusion orders | Combined |
|---|---|---|---|---|
| node | 0.758/0.937 | 0.843 | 0.909/0.993 | 0.950 |
| chromium | 0.788/0.904 | 0.844 | 0.898/0.946 | 0.922 |
| firefox | 0.898/0.971 | 0.934 | 0.950/0.958 | 0.954 |
| webkit | 0.953/0.941 | 0.947 | 0.952/0.957 | 0.954 |

Every per-page/order exception is retained below, including small regressions;
an aggregate benefit does not imply every request improves. No sample,
parent or slow cohort was filtered or replaced.

| Host | Pair | Page/order min–max | Page/order ratios>=1 |
|---|---|---|---|
| node | byte-slices/baseline | 0.639–1.147 | posts/order1=1.147 |
| node | byte-slices-fused/fuse-small | 0.761–1.124 | admin/order1=1.006, posts/order1=1.124 |
| chromium | byte-slices/baseline | 0.674–1.001 | posts/order1=1.001 |
| chromium | byte-slices-fused/fuse-small | 0.829–0.987 | none |
| firefox | byte-slices/baseline | 0.760–1.143 | posts/order1=1.143 |
| firefox | byte-slices-fused/fuse-small | 0.877–1.030 | posts/order0=1.030, article/order1=1.024 |
| webkit | byte-slices/baseline | 0.911–0.999 | none |
| webkit | byte-slices-fused/fuse-small | 0.924–0.997 | none |

| Host | Baseline ordinary drift | Byte-profile ordinary drift | Byte-profile/normal ordinary, orders |
|---|---|---|---|
| node | 0.978 | 0.979 | 1.000/1.001 |
| chromium | 1.099 | 1.196 | 0.972/1.057 |
| firefox | 0.939 | 0.935 | 1.014/1.010 |
| webkit | 1.008 | 0.975 | 1.006/0.972 |

Closing/opening ordinary drift, load and page/order differences limit precision.
A peer SpiderMonkey build and Nix activity appear in the launch inventory.
The build ends after3m32s, about ten seconds into our job; this can overlap
startup but is not proof of interference during measured pages. Later peer
Node/browser controls start after the timing job ends, overlapping only the
functional output checks. End inventory/terminal receipts are retained.
One-minute load ranges are7.70–11.18(Node),6.68–9.72(Chromium),3.84–7.26(Firefox),
4.36–6.74(WebKit). All measured request samples exceed112ms. This is not a quiet-machine,
independent steady-state replication or causal CPU attribution. No confidence
interval is inferred from the small number of fresh parents. Raw ordinary-
normalized ratios remain separate rather than being presented as a correction
that removes scheduling noise.

| Host | Baseline/own ordinary | Fusion/own ordinary | Byte/own ordinary | Byte+fusion/own ordinary | Byte+fusion/baseline |
|---|---|---|---|---|---|
| node | 1.285 | 1.006 | 1.082 | 0.955 | 0.744 |
| chromium | 1.018 | 0.825 | 0.847 | 0.751 | 0.748 |
| firefox | 0.988 | 0.922 | 0.912 | 0.869 | 0.890 |
| webkit | 0.830 | 0.851 | 0.795 | 0.821 | 0.978 |

Ordinary means untranslated Wasm on the same engine, not machine-native PHP.
VM/ordinary compares shared OPcache with file-cache-only mode and includes
cache-mode effects. It does not isolate translation tax or demonstrate that
translated accesses beat identical-cache ordinary addressing.

For survey context, the separate backend screens are shown side by side.
They occurred at different times and loads. Do not pool them or attribute
between-screen differences solely to the database backend.

| Host | SQLite byte/baseline | MariaDB byte/baseline | SQLite byte+fusion/fusion | MariaDB byte+fusion/fusion |
|---|---|---|---|---|
| node | 0.888 | 0.843 | 0.902 | 0.950 |
| chromium | 0.929 | 0.844 | 0.906 | 0.922 |
| firefox | 1.353 | 0.934 | 0.933 | 0.954 |
| webkit | 0.967 | 0.947 | 0.939 | 0.954 |

**Browser fixture correction:** the extra backend-log assertion initially
failed because `wordpress-browser.mjs` incorrectly used Node's `(pid,data)`
callback shape. The actual BrowserKernel contract supplies only `data`.
Historical browser events retain the complete byte array as an indexed JSON
object in the misnamed `pid` field, with an empty decoded text field. The
analyzer now validates contiguous byte keys/uint8 values and decodes that
preserved representation without rewriting any raw file. Recovered startup
markers validate MariaDB and mariadb-ready for all48 original parents.
The initial failed analyzer source/log is retained, followed by a fresh
analysis directory. This is a fixture capture error, not a runtime defect.

Future browser callbacks now take bytes only and record decoded text without
a fabricated PID. All three engines pass fresh functional MariaDB WordPress
checks (zero warmup/one measured round, no pooling with the timing screen),
including decoded startup markers, empty error arrays and teardown. The
original no-stderr checks remain meaningful: even under the old signature,
any emitted stderr chunk would have added an entry and failed that check.
The capture bug affects log representation; guest behavior and recorded
request-clock values were not recomputed or replaced.

**Survey implication:** host byte copies merit further engineering, while
per-page/backend effects, ordinary drift, the original Firefox SQLite
outlier, small WebKit signals and earlier file-cache regressions remain
part of the result. Combining fusion/byte copies must be checked against both
the immediate reference and the original baseline. No universal best preset,
CPU/RSS/GC benefit or default promotion follows. Keep threshold/brand-cost,
width/NoTear, guest loop/SIMD, richer bank/provenance and arena variants as
separate future ideas; none is discarded by these mixed application results.

Next: a plain shared-cache preload/no-preload WordPress screen, with immutable
timestamps alreadyOFF and native ordinary treated as the separate reference
its verified capability permits. The existing preload diagnostic wrappers
must not be pooled as unprofiled latency data. All561-file training/correctness
and allocation evidence remains, including increased allocation high-water.
No PGO retraining is needed: real SQLite/MariaDB+CLI training and phase33
application timing were already completed.

Raw capability and MariaDB outputs, exact modules/profiles, source/input
snapshots, scripts, every page/round/cohort and job receipts are retained under
phase41. Frozen preview, normal runtime/package defaults and images remain
untouched. No canonical image rebuild, whole-platform benchmark/conformance/
ABI/browser-memory gate or full Vitest-suite pass is claimed; its earlier
full-suite timeout remains separate from the complete-policy direct audit.

Direct ownership audit: 1036 runtime files, zero findings, 41.75s, exact original policy unchanged during the run. No source filters or repository timeout changes.


### APP-01: plain preload latency, startup and allocation

This phase replaces the missing plain preload latency comparison with a
bounded shared-cache experiment. It preserves the earlier561-file diagnostic,
small Node warm signal and sparse-fork allocation combinations as separate
observations. No training, PHP/compiler/module/profile/image rebuild or
canonical/default/preview change occurred. The immutable SQLite corpus and
original O2 compiler remain; the preset is small-offset fusion plus the
corrected byte-snapshot host profile, not a universal best preset.

Four configurations are tested: baseline, preload alone, preset, and preset
plus preload. Each preload pair uses the exact same guest artifact and host
profile; baseline/preload use f879effe..., preset/preset-preload use2edbcf32....
All ordinary file references usebe6a6eae... under their own base/preset host
profiles, with preload explicitlyOFF. The phase41 capability boundary remains:
file-cache-only does not give equivalent preload uptake, so the causal
preload comparison is shared-cache VM versus shared-cache VM. VM/ordinary
includes cache/feature effects and is not a pure addressing-cost estimate.

**Implementation and controls:** the local fixture has an explicit optional
`preloadPaths`: undefined preserves legacy behavior/output option shape;
null selects a new unpreloaded control; a validated unique inventory selects
preload. Both on/off cases install the same verification controller before
boot, using normal public VFS/ini operations. Enabled cases require shared
OPcache and the existing FPM nobody user, with PHP's normal compile-only
preload script. No prototype hooks, timed counters or profiler are installed.
The ini is captured, timestamp checks and JIT areOFF. After all timed requests,
completion561/561/no failures, actual persistent absint/WP_Error definitions,
preload statistics and two-PID uptake are checked. The controller uses counts,
not a large scripts/functions dump. Legacy and environment shape controls,
invalid paths/duplicate inventory/profile/guest/ordinary bindings and plan
negatives pass32 checks.3 Node and9 browser functional checks pass before
inputs are frozen; those are not pooled with timing data.

**Collection:** owned job common-memory-preload-wordpress-1112-014222-62e8
succeeds in14m58s.48 fresh parents/960 measured responses cover Node and all
three browsers. Each host has two opposite four-mode VM orders bracketed by
own-profile unpreloaded ordinary parents. Two warmup/five measured shuffled
home/article/admin/REST rounds are performed per parent. All artifact/profile/
backend/ini/page/login/REST/cache/two-PID/group/teardown checks and preload
positive/negative controls pass. All561 requested files compile for every
preloaded parent; each reports3466 functions,290 classes and562 scripts
including its preload script. Raw compiled-state/controller records remain.

Warm ratios below are geometric means across four page medians and then the
two cohorts. Above1 means longer latency. The two order values remain separate;
a combined mean does not remove variability. Ordinary means untranslated Wasm
on the same engine, not machine-native PHP. No sample/slow parent is filtered.

| Host | Preload/baseline orders | Combined | Preload+preset/preset orders | Combined |
|---|---|---|---|---|
| node | 0.994/0.983 | 0.989 | 0.978/0.979 | 0.978 |
| chromium | 1.000/1.005 | 1.003 | 0.928/1.039 | 0.982 |
| firefox | 1.037/0.992 | 1.014 | 0.838/1.100 | 0.960 |
| webkit | 1.037/1.004 | 1.020 | 1.040/0.939 | 0.988 |

**Interpretation:** preload alone is near neutral in this warm corpus: combined
Node .989, Chromium1.003, Firefox1.014, WebKit1.020. Node's preset increment is
small and agrees by order(.978/.979); Chromium(.928/1.039), Firefox(.838/1.100)
and WebKit(1.040/.939) disagree by order. Do not advertise their combined means
as reliable gains. The earlier one-sample15–20% Node lead is not confirmed by
this protocol. Different warmup/preset/conditions mean this does not prove
its cause. Keep cold, larger/unseen corpora, subset/hot-file preload, lifecycle
and resource-policy variants as future ideas; preload in general is not
classified as ineffective. On this workload, the measured costs make it a
lower-priority addition than the existing byte-copy/cache-policy candidates.

| Host | Pair | Page/order min–max | Page/order ratios>=1 |
|---|---|---|---|
| node | preload/baseline | 0.976–1.008 | admin/order0=1.008 |
| node | preset-preload/preset | 0.957–0.991 | none |
| chromium | preload/baseline | 0.973–1.039 | home/order0=1.003, article/order0=1.015, article/order1=1.011, admin/order1=1.039 |
| chromium | preset-preload/preset | 0.874–1.050 | home/order1=1.048, article/order1=1.027, admin/order1=1.031, posts/order1=1.050 |
| firefox | preload/baseline | 0.951–1.094 | home/order0=1.085, article/order0=1.094, posts/order0=1.024 |
| firefox | preset-preload/preset | 0.809–1.174 | home/order1=1.116, article/order1=1.174, admin/order1=1.103, posts/order1=1.014 |
| webkit | preload/baseline | 0.974–1.087 | home/order0=1.020, article/order0=1.087, admin/order0=1.029, posts/order0=1.012, home/order1=1.018, article/order1=1.016, admin/order1=1.008 |
| webkit | preset-preload/preset | 0.918–1.048 | home/order0=1.036, article/order0=1.048, admin/order0=1.037, posts/order0=1.040 |

**Startup:** the next table measures dinit start to first successful homepage,
not full host/page startup. It includes preload and initial page generation,
but configuration/image initialization precede that timer. One startup value
per fresh parent cannot establish a precise cold-start distribution.

| Host | Preload/baseline startup orders | Preload+preset/preset startup orders |
|---|---|---|
| node | 1.029/1.055 | 1.025/1.046 |
| chromium | 1.075/1.079 | 1.043/1.066 |
| firefox | 1.057/1.065 | 1.103/1.048 |
| webkit | 1.051/1.097 | 1.292/1.492 |

Every preload startup ratio is above1 in these cohorts. WebKit's preset
startup ratios1.292/1.492 are particularly costly; no CPU/JIT/root-cause
attribution has been measured. They remain alongside its warm-order variation.

**Allocation:** sampled group allocator consumption at the last measured round
is reported below, before final verification/controller work. It is consumed
capacity, not RSS or reservation. Every VM backing stays512MiB. The additional
preload allocator debt is approximately130MiB; sparse fork/scratch/reuse
alternatives remain separately cataloged, not assumed automatically compatible
or included in this preset. The byte+unmapped-reuse combination is still
explicitly rejected pending its lifetime proof.

| Host | Baseline/preload MiB, orders | Preset/preload+preset MiB, orders |
|---|---|---|
| node | 305.000/434.750; 305.125/434.750 | 305.000/434.750; 305.125/434.750 |
| chromium | 305.000/436.750; 305.125/436.750 | 305.000/436.750; 305.125/436.750 |
| firefox | 305.000/436.750; 305.125/436.750 | 305.000/436.750; 305.125/436.750 |
| webkit | 305.000/436.750; 305.125/440.188 | 305.500/436.625; 301.312/436.625 |

All memory-series snapshots remain in analysis/raw data. The preload Node
example grows405.875MiB after login to416/424.125MiB after warmups, then
426.250,428.375,430.500,432.625,434.750MiB across measured rounds. Continued
sampled growth is visible; this is not proof of reclamation, indefinite churn
or a stationary memory footprint. The old sparse-preload capacity saving and
RT-01 reuse/root-retirement ideas remain important follow-ups.

| Host | Preset/baseline | Preload+preset/baseline | Baseline ordinary drift | Preset ordinary drift |
|---|---|---|---|---|
| node | 0.784 | 0.767 | 0.961 | 0.959 |
| chromium | 0.841 | 0.826 | 1.010 | 1.027 |
| firefox | 0.931 | 0.893 | 0.825 | 0.857 |
| webkit | 1.168 | 1.154 | 1.209 | 1.193 |

The preset result reiterates nonadditivity: Node/Chromium favor it in this
screen, Firefox varies, WebKit's preset/baseline1.168 does not establish a
benefit. Do not select every switch by multiplying independent favorable
microbenchmarks. All own-profile ordinary ratios are retained in analysis;
preloaded VM/ordinary has an intentionally non-preloaded file reference and
must never be labeled a feature-equivalent translation tax.

The launch/end inventories and load values are retained. No quiet-machine,
stationary steady-state or causal CPU claim is made. Ordinary closing/opening
movement of~14–18%(Firefox) and~19–21%(WebKit) limits precision, especially for
small warm effects. These two-cohort means have no inferred confidence interval.
All first/startup, resource and raw page/round/cohort data remain unpooled with
earlier diagnostics. No owned build/profile/audit or source edits overlap the
plain timing interval.

**Retention and survey decision:** keep the original preload hypothesis and all
prior positive/mixed evidence, but don't prioritize this full561-file preload
for the measured warm workload. Lifecycle/restart requirements for immutable
preloaded code, backend-specific inventories, plugin/unseen-code behavior,
resource allocation and cold/short-lived workloads remain distinct questions.
This screen does not establish MariaDB preload compatibility or performance.
The existing frozen preview still uses its own unchanged settings.

The plain source/options/protocol,32 configuration/legacy/negative checks,
12 functional controls,48 timing parents, completion/statistics verification,
exact modules/profiles, scripts/input snapshots and job receipts are retained
under phase42. No application package/image, canonical runtime, compiler
preset or shipping default was changed. No whole-platform benchmark,
conformance/ABI/browser-memory gate or complete Vitest-suite pass is claimed;
its earlier timeout remains separate from the direct audit.

Exact complete-policy direct ownership audit: 1039 runtime files, zero findings, 45.96s; original policy unchanged during the run, no source filters or repository timeout changes.

### CC-01/02: real WordPress compiler and fusion screen

Phase44 fills the missing matched ordinary-build WordPress O3/LTO timing gap
without rebuilding PHP, a profile, an image or the SDK. Existing exact
modules cover PHP C O3, helper O3, both O3, full C LTO and ThinLTO, plus the
available small-offset fusion combinations. Main-program C LTO is not
whole-dependency LTO; dependencies, C++, normal configure decisions, pre-fork
Binaryen and host settings remain those of the original retained builds.
No compiler optimum, shipping preset or causal CPU explanation follows.

**Protocol and checks:** job `common-memory-wordpress-compiler-1112-022817-beae`
succeeded in36m33s. There are28fresh parents/host,112total: ten VM/shared modes
in two opposite orders and four actual ordinary/file-cache PHP builds each
with opening/closing parents. Node24.15.0, Chromium153.0.8010.12, Firefox155.0
and WebKit26.6 use the same normal pregrown diagnostics-off profile, frozen
SQLite WordPress image and explicit immutable-code timestamp-off policy.
No preload or byte-copy preset is enabled. Each parent has two warmup and
five measured shuffled home/article/admin/REST rounds,2240 measured responses
total. Browser output confirms84tests using one worker; each case launches
a fresh browser. All223outer input hashes and each collector's inputs remain
unchanged. All actual page/login/admin/REST/backend/cache/two-PID/group and
teardown checks pass. Three separate own-build ordinary Node preflights and
36configuration/negative-plan checks also pass; their short functional
requests are not pooled into the timing matrix.

**Artifacts:** each mode uses its own PHP compiler ordinary reference.
Helper O3 keeps the original PHP ordinary build; both-O3 modes use the PHP
C-O3 ordinary build. The original source/build ledgers and exact full hashes
are retained with the manifest. VM module identities are:

| Mode | VM bytes | VM SHA prefix | Own ordinary SHA prefix |
|---|---:|---|---|
| baseline |38072786|f879effe0ecb|be6a6eaeebea|
| helper-o3 |38072786|db051cda295d|be6a6eaeebea|
| php-c-o3 |38274635|3b22e017f2ad|aac89505e177|
| both-o3 |38274635|46b8d32c68a8|aac89505e177|
| php-lto-full |40537903|fb2e0b0c8cd9|d1ecc78957ef|
| php-lto-thin |41071286|01a519cfc91a|b4c8924fbea0|
| fuse-small |38104734|2edbcf32ef3c|be6a6eaeebea|
| both-o3-fused |38306694|24fe769c6258|aac89505e177|
| php-lto-full-fused |40570075|b0d87145af4d|d1ecc78957ef|
| php-lto-thin-fused |41103123|0bf6175635e2|b4c8924fbea0|

**Individual and combination effects:** geometric means of page-median
ratios, then across the two orders. Above1 means longer warm-request latency.
Compiler-only rows compare with the same-cache baseline. Combined compiler
rows compare with fusion alone, rather than crediting the compiler for the
fusion contribution. Both orders are shown explicitly.

| Host | Comparison | Order0 | Order1 | Combined |
|---|---|---:|---:|---:|
| node |helper-o3/baseline|1.033|1.021|1.027|
| node |php-c-o3/baseline|1.013|1.023|1.018|
| node |both-o3/baseline|1.003|0.974|0.989|
| node |php-lto-full/baseline|1.008|0.985|0.996|
| node |php-lto-thin/baseline|1.001|1.005|1.003|
| node |fuse-small/baseline|0.865|0.869|0.867|
| node |both-o3-fused/fuse-small|1.016|0.993|1.004|
| node |php-lto-full-fused/fuse-small|1.020|0.978|0.999|
| node |php-lto-thin-fused/fuse-small|1.037|0.991|1.014|
| chromium |helper-o3/baseline|1.016|1.005|1.010|
| chromium |php-c-o3/baseline|1.020|1.010|1.015|
| chromium |both-o3/baseline|1.093|1.003|1.047|
| chromium |php-lto-full/baseline|1.007|1.011|1.009|
| chromium |php-lto-thin/baseline|0.992|1.021|1.006|
| chromium |fuse-small/baseline|0.875|0.904|0.889|
| chromium |both-o3-fused/fuse-small|1.007|1.019|1.013|
| chromium |php-lto-full-fused/fuse-small|1.002|1.015|1.009|
| chromium |php-lto-thin-fused/fuse-small|1.027|1.054|1.040|
| firefox |helper-o3/baseline|1.015|1.007|1.011|
| firefox |php-c-o3/baseline|1.032|0.981|1.006|
| firefox |both-o3/baseline|1.025|0.990|1.008|
| firefox |php-lto-full/baseline|0.994|1.000|0.997|
| firefox |php-lto-thin/baseline|1.007|1.093|1.049|
| firefox |fuse-small/baseline|0.909|1.015|0.960|
| firefox |both-o3-fused/fuse-small|1.069|1.021|1.045|
| firefox |php-lto-full-fused/fuse-small|1.063|0.999|1.031|
| firefox |php-lto-thin-fused/fuse-small|1.053|0.971|1.011|
| webkit |helper-o3/baseline|1.254|0.925|1.077|
| webkit |php-c-o3/baseline|1.067|0.954|1.009|
| webkit |both-o3/baseline|0.992|0.916|0.953|
| webkit |php-lto-full/baseline|0.970|0.954|0.962|
| webkit |php-lto-thin/baseline|0.971|0.936|0.953|
| webkit |fuse-small/baseline|1.024|1.007|1.015|
| webkit |both-o3-fused/fuse-small|1.038|1.057|1.048|
| webkit |php-lto-full-fused/fuse-small|0.984|0.997|0.991|
| webkit |php-lto-thin-fused/fuse-small|1.246|1.072|1.156|

There is no broad O3/LTO warm-latency win. Helper-only and PHP-only O3
are near neutral or slower on most hosts; their WebKit orders disagree.
Both-O3/full/ThinLTO standalone aggregate WebKit leads are modest, while
the large ordinary drift below prevents treating them as reliable gains.
Node/Chromium small fusion again leads by about13%/11% with both orders
agreeing. Adding O3 or LTO to that fusion reference supplies little general
benefit; Chromium ThinLTO+fusion and both-O3+fusion on several hosts regress.
Firefox fusion changes direction by order, and WebKit fusion remains
slightly slower than its baseline. Earlier results are retained separately.

**Fusion added after each compiler:** these rows expose nonadditivity;
they are not compiler-only effects.

| Comparison | Node | Chromium | Firefox | WebKit |
|---|---:|---:|---:|---:|
| both-o3/php-c-o3 |0.971|1.031|1.001|0.945|
| both-o3/helper-o3 |0.963|1.036|0.997|0.885|
| both-o3-fused/both-o3 |0.881|0.861|0.996|1.116|
| php-lto-full-fused/php-lto-full |0.869|0.889|0.993|1.045|
| php-lto-thin-fused/php-lto-thin |0.876|0.920|0.926|1.231|

WebKit ThinLTO+fusion takes1.231x ThinLTO-alone time: orders1.313/1.153
both regress. Its both-O3 and full-LTO combinations also regress relative
to their unfused forms in both orders. This is useful adverse-combination
evidence, not an explanation of JIT/code-shape behavior. All per-page and
per-order results, including regressions hidden by aggregates, remain in
the retained analysis.

**Own ordinary reference:** VM/shared over the same PHP build ordinary/file
ratios include cache-mode effects and are not pure translation tax.

| VM mode | Node | Chromium | Firefox | WebKit |
|---|---:|---:|---:|---:|
| baseline |1.508|1.248|1.196|1.219|
| helper-o3 |1.549|1.261|1.208|1.313|
| php-c-o3 |1.476|1.258|1.219|1.193|
| both-o3 |1.433|1.297|1.220|1.127|
| php-lto-full |1.447|1.238|1.223|1.041|
| php-lto-thin |1.498|1.235|1.259|1.004|
| fuse-small |1.307|1.110|1.148|1.237|
| both-o3-fused |1.262|1.117|1.215|1.257|
| php-lto-full-fused |1.257|1.101|1.214|1.088|
| php-lto-thin-fused |1.312|1.136|1.166|1.235|

**Ordinary compiler and drift controls:** original O2 ordinary is the
denominator for each ordinary compiler effect. Opening/closing drift is
reported for every actual compiler control, not corrected away.

| Host | Ordinary build | Build/original O2 | Closing/opening |
|---|---|---:|---:|
| node |baseline|1.000|1.034|
| node |php-c-o3|1.040|0.981|
| node |php-lto-full|1.038|1.003|
| node |php-lto-thin|1.010|0.998|
| chromium |baseline|1.000|0.957|
| chromium |php-c-o3|1.007|0.964|
| chromium |php-lto-full|1.017|0.926|
| chromium |php-lto-thin|1.017|0.955|
| firefox |baseline|1.000|0.943|
| firefox |php-c-o3|0.987|0.998|
| firefox |php-lto-full|0.975|0.979|
| firefox |php-lto-thin|0.996|1.011|
| webkit |baseline|1.000|1.489|
| webkit |php-c-o3|1.031|1.378|
| webkit |php-lto-full|1.126|1.141|
| webkit |php-lto-thin|1.158|1.104|

WebKit ordinary baseline closing/opening is1.490 and C-O3 is1.378;
full/ThinLTO are1.141/1.104. Smaller apparent WebKit effects therefore do
not establish a compiler recommendation. The start job inventory includes
a running peer Nix job; the final inventory includes a peer browser job.
Retained per-parent timestamps/load and both inventories permit inspection
of overlap. These observations do not assign a causal explanation. There
is no quiet-machine, confidence-interval, balanced-per-worker, long-run
stationary throughput or held-out-corpus claim. Two VM parents/mode/host
remain a bounded first screen, despite the larger overall matrix.

**Startup and allocation:** first successful homepage time begins at dinit
spawn, not whole-host/page creation. Startup ratios for selected pairs are
shown as order0/order1. They do not isolate compilation, JIT or CPU costs.

| Comparison | Node | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| both-o3/baseline |0.975/0.909|1.135/0.993|0.983/1.000|1.054/0.969|
| php-lto-full/baseline |0.978/0.943|1.046/1.014|0.982/1.060|1.448/1.010|
| php-lto-thin/baseline |0.992/0.937|1.025/1.044|0.982/1.147|1.103/1.041|
| fuse-small/baseline |0.821/0.782|0.827/0.884|0.834/1.014|0.896/0.903|
| php-lto-thin-fused/php-lto-thin |0.844/0.861|0.838/0.870|0.930/0.893|0.837/0.892|

Final sampled group allocated capacity is305.000/305.125MiB for the two
orders of every VM mode on Node, Chromium and Firefox. WebKit ranges
300.625–307.500MiB across modes/orders; all individual series are retained.
Physical backing stays512MiB. Equal allocator snapshots do not establish
equal RSS, JIT/code memory, reservation use, reclamation or an allocation
plateau. Larger LTO artifacts remain larger even where warm latency is
near neutral; no debug payload is invented to explain that code size.

**Decision and retained ideas:** leave compiler defaults unchanged. Keep
small fusion selectable for further Node/Chromium experiments, not as a
universal browser preset. Preserve PHP/helper O3, full/ThinLTO and their
combinations for other corpora, larger workloads, dependency-LTO coverage,
different fusion selection and compiler/code-shape profiling. These results
do not prove a technique universally ineffective or the existing O2 optimal.
In response to the request to keep the investigation broad, rotate next
toward allocation lifetime, loop/stack proof applicability and backend cache
behavior, instead of another large compiler matrix.

The complete original-policy source audit covers1041runtime source files
with zero unreviewed failures in39.96s; the original policy is unchanged.
This is separate from the earlier full-Vitest timeout and is not a full-suite
pass. Raw timing/functional/negative checks, exact modules/profile/sources,
analysis, input identities and job evidence are retained under phase44 of
the survey archive. No normal package, image, SDK, runtime default or frozen
preview changed; no canonical/full-platform/conformance/ABI/browser-memory
acceptance is claimed. The broad investigation goal remains active.

### RT-01: bounded fixed-pool allocation lifetime

Phase45 rotates from compiler flags to longer allocation behavior. It uses
the existing exact sparse-fork/1MiB-scratch control and mapped-payload reuse
profiles, with the same small-fusion FPM2edbcf32... and ordinary PHPbe6a6eae...
artifacts, frozen SQLite WordPress image and explicit timestamp-off policy.
Both VM profiles retain the same512MiB pregrown common backing. No module,
image, SDK, profile or normal-runtime behavior is rebuilt for the comparison.
The byte-snapshot/reuse combination remains rejected pending lifetime proof.

**Collection and actual outcomes:** job
`common-memory-wordpress-resource-1112-032651-c5cf` completes collection in
35m09s with218outer frozen input hashes unchanged, plus each collector's
input checks. There are12fresh parents: ordinary/file, VM/shared without
reuse, and VM/shared with reuse on Node24.15.0, Chromium153.0.8010.12,
Firefox155.0 and WebKit26.6. Each parent requests two warmup rounds followed
by128shuffled four-page home/article/admin/REST rounds. Each successful
sample passes the real HTTP/content check; complete cases also pass login,
backend/artifact/cache/two-worker/group and teardown checks.

**Eight application cases pass and four fail.** All ordinary and reuse
cases complete512sampled requests. Node/Chromium/Firefox controls fail after
376successful sampled requests, WebKit after373. Nginx records HTTP500 for
every failure. Node retains actual exit1; Playwright retains6passes/3failed
application tests using one worker. The collector continues independent
cases with retries disabled and distinguishes collection completion from
application success. There is no restart, forced GC, raised ceiling or
relaxed assertion/watchdog within a case. Total successful sampled pages
are5597, plus96warmup pages; cold/login/status requests are separate.

| Host | Ordinary sampled pages / result | Control pages / result | Last control high-water MiB | Reuse pages / result | Last reuse high-water MiB |
|---|---|---|---:|---|---:|
| node |512 / pass|376 / fail|511.1875|512 / pass|144.3125|
| chromium |512 / pass|376 / fail|511.1875|512 / pass|140.3750|
| firefox |512 / pass|376 / fail|511.1875|512 / pass|140.3750|
| webkit |512 / pass|373 / fail|510.8125|512 / pass|140.3750|

Control values are the last recorded complete-round snapshots, before
the failed request; WebKit has one later successful partial-round request.
They are not exact allocator values at the instant of failure. Original
failed response bodies were not retained beyond a short message prefix,
and the old stack serializer omitted that message on Firefox/WebKit.
Access logs establish the HTTP500s; the allocator curves establish
near-ceiling pressure. They do not identify the exact PHP/database cause.

**Curves and live mappings:** all128recorded post-round reuse allocator
values are equal on each host, including the final32rounds. Activity has not
stopped: thousands of pages are reclaimed/reused while the high-water stays
flat. Controls keep growing, with median3.375MiB increments per completed
four-page round. This is an observed interval, not an indefinite plateau
or a predicted number of requests for other configurations.

| Host / mode | After login MiB | After round0 | After round31 | After round63 | Last sampled MiB |
|---|---:|---:|---:|---:|---:|
| node / control |174.1875|206.3125|314.0625|420.1875|511.1875|
| node / reuse |140.3750|144.3125|144.3125|144.3125|144.3125|
| chromium / control |174.1875|206.3125|314.0625|420.1875|511.1875|
| chromium / reuse |136.4375|140.3750|140.3750|140.3750|140.3750|
| firefox / control |174.1875|206.3125|314.0625|420.1875|511.1875|
| firefox / reuse |136.4375|140.3750|140.3750|140.3750|140.3750|
| webkit / control |174.1875|206.4375|313.5000|420.5625|510.8125|
| webkit / reuse |136.4375|140.3750|140.3750|140.3750|140.3750|

The last common complete-round comparison has identical private/shared
PTE byte totals for each host:99.75MiB private and32.0625MiB shared. Its
allocated-capacity differences are:

| Host | Last common phase | Control minus reuse MiB |
|---|---|---:|
| node |warm-93|366.8750|
| chromium |warm-93|370.8125|
| firefox |warm-93|370.8125|
| webkit |warm-92|370.4375|

Node/Chromium/Firefox private and shared PTE totals match at every common
snapshot. WebKit shared totals also match throughout; private totals differ
by64–128KiB at three intermediate snapshots and match at the final common
one. All snapshots remain in one group with three active roots. The PTE
metrics deduplicate physical addresses within each private/shared category;
they are not RSS. Whole common backing remains512MiB in both VM modes.

**Reuse counters at the final sampled round:** these are cumulative page
observations/traffic, not unique bytes saved. Free pages are current pool
stock. Root-held observations remain excluded from reclamation.

| Host | Sweeps | Reclaimed pages | Reused pages | Root-held observations | Free pages |
|---|---:|---:|---:|---:|---:|
| node |2903|7674|7527|0|147|
| chromium |2903|7674|7590|0|84|
| firefox |2903|7674|7590|0|84|
| webkit |2874|7642|7560|1026|82|

Every reuse snapshot tracks exactly three roots and zero pending fork
snapshots. This is a fixed-pool test, not worker replacement or exited-root
retirement. Ordinary-addressing references also complete512sampled pages;
their final aggregate native linear-buffer sizes are249.625MiB(Node),
257.625MiB(Chromium/Firefox) and241.625MiB(WebKit). Chromium/Firefox native
sizes still increase6MiB over the last32rounds, so do not invent a universal
ordinary plateau. These native buffer sums and VM allocator high-waters
are different metrics and do not rank whole-host memory or reservation use.

**Separate failure-observability diagnostic:** after the frozen collection
and analysis, the private fixture gains a bounded16KiB copied failed-response
record and an error serializer that preserves both `String(error)` and the
stack. Successful result shapes remain unchanged. Three quiet browser
checks pass; actual Firefox/WebKit stacks in those checks omit the error
message under the previous serializer. This was our fixture assumption,
not a diagnosed outside-runtime defect. The initial formatter-check command
missed its required artifact-directory environment; that config failure and
the corrected invocation are both retained.

A separate Node control enables PHP error logging, retaining the guest,
profile, workload, ceiling and watchdog. It fails after431sampled requests
with actual exit1, captures an empty HTTP500 response, and records exactly
512MiB allocated after the failure. Its193frozen inputs remain unchanged
during execution. It is not pooled into the original resource study or
treated as an exact request-count replication. The extra-log decoder
mishandles nullable VFS results and records TypeErrors; current source
handles null explicitly, while the at-run source and original result remain
retained. No favorable rerun replaces this inconclusive probe. It supports
capacity-bound behavior but does not establish the exact PHP-level cause.
A failure-only physical `vm_grow` rejection witness is a retained next
diagnostic idea.

**Decision and remaining proof:** mapped-payload reuse now merits practical
prototype follow-through beyond the earlier short allocation screen. Do not
promote it as a latency, RSS, reduced-reservation, indefinite-service or
process-retirement result. Retain real replacement/churn and cancellation
tests, last-writer/alias retirement proofs, MariaDB resource confirmation,
safe byte-snapshot combination, and guest-growth/free-pool integration with
a shared allocator ownership proof. A lower common-memory ceiling is a
separate future experiment only after peak/burst/replacement requirements
are understood; none was raised or lowered in this study.

The original-policy audits pass separately for1043pre-study and1044current
runtime source files, with no unreviewed failures; no policy filters or
timeouts changed. The earlier full-Vitest timeout remains separate. Exact
profiles/modules, original and enriched fixture sources, all successful and
failed results, counters/curves, input hashes, jobs and diagnostic failures
are retained under phase45. No normal default, image, package, SDK or frozen
preview changes, full-platform benchmark/conformance/ABI/browser-memory
acceptance, or whole-platform performance claim follows.

### VM-05: named libc loop coverage bound

A distinct read-only breadth check uses the retained phase27 diagnostic
trace: four SQLite/shared WordPress requests after two warmup rounds on each
host. It selects the explicit exported names `strlen`, `strnlen`, `strcmp`,
`strncmp`, `memcmp`, `memchr`, `strchr`, `strrchr`, `strstr`, `strcspn`,
`strspn`, `memcpy`, `memmove` and `memset`. Eleven parents are active. It
checks exact native/small artifacts, source-function limit49483, counter
function-base256 and selected native export ordinals against the retained
linkage. This is new analysis of old evidence, not a fresh runtime run.

| Host | All dispatches | Selected parent dispatches | Parent fraction | memcmp parent fraction | strlen parent fraction |
|---|---:|---:|---:|---:|---:|
| node |379589613|9571915|2.521648%|2.155226%|0.074538%|
| chromium |379588582|9571964|2.521668%|2.155233%|0.074563%|
| firefox |379604765|9572132|2.521605%|2.155141%|0.074560%|
| webkit |379588372|9571964|2.521669%|2.155234%|0.074563%|

These sum all attempted memory-operation dispatches in the selected
parents, overcounting any particular loop. They are neither CPU fractions
nor predicted speedups and exclude internal/inlined string implementations.
Exported-libc-only specialization has limited observed reach in this trace;
it does not bound general loop optimization or all string work. Preserve
page-at-a-time guarded scans, dual spans for memcmp, tiny-length fallback
and span-length/call-count diagnostics for other corpora. Guards must retain
fault/read order on fallback and read live shared payloads. Prefer whole-
module loop/stack applicability analysis, including unnamed/inlined code,
before building another specialized string optimizer. The broad research
goal remains active.

Phase45 packaging note: the first archive attempt expected an unused formatter
environment directory and failed. Its partial archive, source and log are
retained under `phase45-failed-archive-1`. The corrected archive verifies the
three actual formatter reports; no measurements or original results changed.

### VM-05/07/08: whole-module frame and loop applicability

Phase 46 rotates from exported libc and whole-function filters to every defined
function in five frozen, ordinary-addressing, normally fork-prepared PHP-FPM
modules. The new read-only `feasibility` `origins` binary uses validator operand
arities, local assignment versions, modular i32 expressions, exact stack-frame
constructors, conservative aliases/joins and structured loop effect windows.
It includes unnamed, inlined and fork-generated code. A complex store value
cannot be mistaken for the address operand. Eighteen analyzer tests pass,
including SIMD lane/cmpxchg operands, stale local snapshots, calls/joins,
unreachable control, pure inner loops in calling functions, stride shapes,
large constant displacements and input admission negatives. This tool does
not rewrite PHP or establish optimization eligibility.

| Ordinary module | Functions | Memory sites | Legacy adjacent frame syntax | Actual address uses frame-local name | Tracked definition origin | Origin before intervening effects | Readonly invariant sites | Readonly stride hints |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| original | 49,424 | 904,942 | 116,207 | 144,978 | 7,359 | 2,414 | 299 | 858 |
| php-o3 | 49,396 | 916,696 | 119,237 | 148,946 | 7,457 | 2,404 | 314 | 871 |
| full-lto | 49,233 | 1,080,894 | 145,443 | 178,678 | 7,370 | 2,390 | 377 | 980 |
| thin-lto | 49,260 | 1,073,755 | 145,162 | 178,102 | 7,431 | 2,418 | 348 | 1,106 |
| pgo | 50,470 | 878,042 | 115,245 | 143,347 | 7,469 | 2,553 | 268 | 708 |

The original module reproduces the old 904,942 memory-site and 116,207 adjacent-frame
counts exactly. The existing regional analyzer also reproduces all 7,910 selected
min4 plans, every field unchanged. The new address-producer heuristic recognizes
144,978 sites in the original module, but a frame-local name alone does not prove
its current definition. Tracking actual constructor/alias definitions through
straight-line code finds 7,359 origins; conservative joins discard unknown facts.
The 2,414 before-effects sites exclude any intervening coarse effect from the
constructor. These are overlapping analyses with different conservatism, not
successive validated fast-path implementations. Calls retain virtual origin
but end the strict effect window. Even a tracked origin before effects lacks
a mapping/channel-alias lifetime and physical materialization/fork-entry proof.
Low strict counts do not show that fuller CFG/SSA analysis cannot help.

Readonly loops reject calls, writes, atomics, growth, table effects and unwinds.
An inner loop may qualify even when its surrounding function calls. Invariant
addresses require current local versions and no loop writes to their terms;
large displacements and constants remain candidates rather than being treated
as a span length from zero. Stride/backedge-bound hints remain opportunities:
no induction, CFG, effective-offset range, overflow or permissions certificate
has been proved. Original readonly invariant/stride union is 1,156 static sites.
These exact narrow shapes remain uncommon statically across all five builds;
compiler flag changes alone do not establish useful dynamic coverage.

Function-level linkage to the retained phase 27 trace is preserved separately.
For example, all dispatches in parents containing an invariant loop sum to
3.85%, and parents containing stride hints sum to 5.95%. Anchor-name parents
sum to 26.49%. These old-trace upper bounds include unrelated accesses in those
parents. They must not be reported as candidate-site coverage. The original
function ordinals are not reused for O3/LTO/PGO modules.

To resolve this, the separate access-diagnostics tool now accepts
`--origin-sites NATIVE_MODULE`. It derives classes freshly from those exact
native bytes, then checks all 904,942 original memarg sites by function, complete
call count and operation-kind order against the frozen outlined small-fusion
module. External artifact hashes establish the input provenance; this join is
not a translation-equivalence proof. Four join tests cover exact overlap,
inventory mismatch, missing/extra/reordered/raw accesses and omitted/duplicate
function plans. CLI wrong-native and overwrite negatives pass. Running the
old counter mode reproduces its retained Wasm byte for byte. No fast path is
enabled, no memory layout is extended, and the existing nine counter pages
are reused. Seven overlapping class slots 208–214 are excluded from ordinary
category/function totals. Bulk helpers remain in the dispatch denominator.

Fresh diagnostic runs use one disposable parent per host, two four-page
warmup rounds and one four-page SQLite/shared mixed round, seed 6197. All 247
frozen runtime inputs remain unchanged; Node and browser collectors exit 0.
Both FPM worker/cache/request/group/teardown checks pass. All 30 mechanism checks
per host pass, including exact class overlap, live ordinary results, fork
counter independence, denied/trapping access attempts and the previous
scatter/permissions/64-bit controls. All six browser tests pass with the shared
quiet fixture; synthetic memories remain in disposable Workers and only
copied counts/results reach the browser parent.

| Host/version | All dispatch attempts | Frame-local anchor name | Tracked frame origin | Before effects | Readonly invariant loop | Readonly stride hints | Readonly loop union | All five-class union |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| node v24.15.0 | 379,582,581 | 2.320150% | 0.540149% | 0.120957% | 0.004293% | 0.158012% | 0.162294% | 2.482453% |
| chromium 153.0.8010.12 | 379,587,284 | 2.320141% | 0.540146% | 0.120956% | 0.004293% | 0.158112% | 0.162394% | 2.482545% |
| firefox 155.0 | 379,601,415 | 2.320348% | 0.540149% | 0.120956% | 0.004292% | 0.158372% | 0.162654% | 2.483011% |
| webkit 26.6 | 379,595,411 | 2.320239% | 0.540146% | 0.120956% | 0.004292% | 0.158253% | 0.162535% | 2.482783% |

These are attempted site executions, with overlapping membership, not safe
elisions, CPU fractions, bytes processed or speedups. Counters are individually
atomic; asynchronous snapshots include background/tail work. The instrumented
run times are not latency evidence. All hosts use identical guest/image/kernel
bytes and agree closely on the observed fractions. Forty attempts belong to
both readonly classes on each host, and unions count them once.

The actual readonly-loop union is 0.162–0.163%, much less than its loose parent
function bounds. Frame-name attempts are 2.32%; tracked definition origins are
0.54%, and origins before intervening effects 0.12%. This argues against a large
implementation justified solely by these narrow shapes. It does not bound
broader loops, all stack accesses, other corpora or CPU benefit: individual
accesses have unequal costs, and bulk helpers can process many bytes.

Retain and prioritize distinct next ideas under the same catalog families:

- Broader store-containing loops, including separate source/destination spans.
  Prove writes cannot change relevant mapping/alias state; retain original
  fault/write order and a checked fallback.
- Richer CFG/SSA joins and induction/range/no-wrap proofs. Measure actual reach
  before building a general loop rewrite; current missing facts are not failures
  of the underlying optimization idea.
- Compiler provenance emitted before fork transformation, propagated through
  generated code with explicit child/replay rebinding and mapping lifetime rules.
- Explicit pinned spans/arenas and boundary refresh. The negative per-access
  affine cache result does not measure these different guard frequencies.
- Guarded dual-span string/SIMD/bulk specialization on larger buffers and other
  corpora, preserving tiny-length fallback, live shared bytes and fault order.
- Aligned-atomic timing and MariaDB immutable timestamp-policy confirmation
  remain independent outstanding experiments; avoid churning on cache placement.

The first full-source audit reported two new constructor references in the
synthetic mechanism. Review found fixture-owned VirtualGroup memories with
no kernel imports; an exact two-reference non-kernel classification was added.
The next full audit passes 1,047 files / 0 unreviewed findings with the complete
policy. Both attempts and the policy change are retained. No outside-runtime
defect is alleged. Analyzer tests, diagnostic counts and source audits do not
establish canonical builds, full-suite/platform benchmarks, POSIX conformance,
ABI acceptance or the browser-memory gate. Package recipes, SDK defaults,
normal runtime and frozen WordPress preview are unchanged.

Evidence: `.scratch/common-memory-frame-loop-scan-1`,
`common-memory-frame-loop-analysis-1`, `common-memory-origin-sites-build-1`,
`common-memory-origin-sites-apps-1`, `common-memory-origin-sites-analysis-1`
and retained `phase46/`. Managed scan job
`common-memory-frame-loop-scan-1112-052505-f739` exits 0; dynamic job
`common-memory-origin-site-counts-1112-054055-d416` exits 0 in 1m39s. This phase
adds measured applicability evidence, not a new performance optimization.
The broad research goal remains active.

The first documentation-rendering driver failed on a missing derived-summary
field (`definedFunctions` lives at the scan report root). The corrected driver
reads that field from the original report; both driver versions/logs are retained.
No source analysis, runtime input, measurement or original result changed.

### VM-06/10: aligned atomic WordPress latency

Phase 47 returns to an independent family after the broader resource and
whole-module frame/loop studies. Aligned atomic accesses cannot cross a
64 KiB page after their required alignment check; the existing opt-in
`--fuse-atomics` rewrite specializes constant offsets up to 16 bytes while
retaining effective bounds, overflow, read/write rights, alignment, holes,
live atomic payloads and the unchanged fallback. No check of the module-table
generation is removed. Its observed 4.31% dispatch frequency motivated this
experiment; frequency does not imply CPU cost or speedup.

The four exact retained phase28 artifacts are baseline, atomics alone, small
scalar fusion alone, and both combined. Current files match all recorded
artifact identities; the twelve available phase28 compressed candidate
artifacts also match after decompression. The old archive intentionally
omitted baseline/small byte copies, including newly generated atomic fixtures;
their current bytes match its recorded hashes and all configurations are fully
retained in this phase. The original at-run instrumenter source hash matches
its ledger. No SDK, PHP, helper, package, image or default was rebuilt.

| Configuration | PHP-FPM bytes | SHA-256 |
|---|---:|---|
| baseline | 38,072,786 | `f879effe0ecbcc1c35d21f718e259c15b9edd5c62cdf5f4339b7e2cff534cc9c` |
| atomics | 38,074,940 | `b5f3b05cf8810723c79076d628d638e497e6aae1fd9ac2c98f5258f500dc7ed7` |
| small | 38,104,734 | `2edbcf32ef3c309eefdabec5eaceeb6d6082ca80fc9b1fc0e235ff838b7b89b4` |
| combined | 38,106,888 | `61cf7940b2b4fb9330bf5376b43dc65d9709b83c177f420f55584529334e6959` |

Fresh validation passes all four Node and twelve browser mechanism cases,
including 787 differential atomic checks per configuration/host (56 forms,
offsets, endpoints through exactly 4 GiB, unaligned/bounds/permission faults
and denied-store bytes). Earlier exact-artifact shared fork/FPM/application
controls remain retained rather than being replaced. Fourteen configuration
and rejection checks validate the new plan and actual frozen inputs. The full
source audit passes 1,049 files with no unreviewed findings; no new ownership
classification or outside-runtime workaround was added.

The new uninstrumented WordPress SQLite/shared screen holds the ordinary O2
PHP/helper build, pregrown host profile, image and immutable-code timestamp
policy constant. No preload, byte-copy adapter or diagnostic profile is used.
Each host launches ten independent parents: an ordinary FILE opener, the four
VM configurations, the same four in reverse order, then an ordinary FILE
closer. The common ordinary brackets are justified by identical native guest,
host profile and app policy across all four modes. Two warmup and five measured
four-page rounds per parent yield 40 parents, 800 measured requests and 320
warmup requests. Both workers, admin/service/cache modes, payloads, resource
contracts, guest/image/kernel identities, ordinary flags, teardown and frozen
inner/outer inputs are validated. All 30 browser timing tests and ten Node
parents pass; 237 outer inputs remain stable. The managed job
`common-memory-wordpress-atomic-timings-1112-055939-41a8` exits 0 in 12m22s.

Ratios below are geometric means of opposite-order ratios of per-parent
per-page medians. Lower is better. Requests within a parent are not independent
parent replications; there are two VM parents per configuration/host. Ordinary
means untranslated Wasm on the same engine. Ordinary FILE versus VM/shared
includes OPcache mode effects and is not a pure address-translation tax.

| Host | Atomics/baseline | Scalar/baseline | Combined/scalar | Combined/atomics | Combined/baseline |
|---|---:|---:|---:|---:|---:|
| node | 1.016479 | 0.868427 | 0.995733 | 0.850702 | 0.864721 |
| chromium | 1.004910 | 0.889345 | 0.997227 | 0.882546 | 0.886879 |
| firefox | 0.975135 | 0.901755 | 0.971982 | 0.898839 | 0.876490 |
| webkit | 1.044733 | 1.052195 | 1.040050 | 1.047480 | 1.094336 |

| Host | Baseline/ordinary | Atomics/ordinary | Scalar/ordinary | Combined/ordinary | Ordinary closing/opening |
|---|---:|---:|---:|---:|---:|
| node | 1.482546 | 1.506978 | 1.287483 | 1.281989 | 0.985152 |
| chromium | 1.204373 | 1.210287 | 1.071104 | 1.068133 | 0.999365 |
| firefox | 1.235119 | 1.204408 | 1.113775 | 1.082569 | 1.000878 |
| webkit | 1.078720 | 1.126974 | 1.135024 | 1.180482 | 0.985304 |

| Host | Order | Atomics/baseline | Scalar/baseline | Combined/scalar | Combined/baseline |
|---|---:|---:|---:|---:|---:|
| node | 0 | 1.032935 | 0.867867 | 1.000439 | 0.868248 |
| node | 1 | 1.000286 | 0.868986 | 0.991049 | 0.861208 |
| chromium | 0 | 1.006921 | 0.894704 | 0.994002 | 0.889338 |
| chromium | 1 | 1.002904 | 0.884018 | 1.000462 | 0.884427 |
| firefox | 0 | 0.971002 | 0.879047 | 0.985480 | 0.866284 |
| firefox | 1 | 0.979286 | 0.925050 | 0.958668 | 0.886816 |
| webkit | 0 | 1.075984 | 1.090058 | 0.998607 | 1.088540 |
| webkit | 1 | 1.014388 | 1.015648 | 1.083213 | 1.100163 |

Atomic fusion has a modest Firefox signal: about 2.5% alone and 2.8% added to
scalar fusion. Both orders favor it in aggregate; the incremental orders differ
(0.9855 and 0.9587), so this is a replication candidate, not a confirmed universal
or steady-state gain. Node/Chromium added effects are below 1% with mixed page
and order directions; there is no convincing additional app win here. Their
scalar-only ratios (0.8684/0.8893) again favor small scalar fusion in this screen.
Firefox scalar-only also favors it, with larger order variation.

WebKit is adverse: atomics alone is 1.0447, scalar alone 1.0522 and combined
1.0943 versus baseline. Combined/baseline is slower in both orders
(1.0885/1.1002). Combined/scalar is nearly neutral in the first order (0.9986)
and slower in the reverse (1.0832); report that interaction rather than hiding
it behind the aggregate 1.0401. Ordinary closing/opening drift is roughly 1.5%
on Node/WebKit and near zero on Chromium/Firefox; it does not explain all VM
order differences. No causal runtime/inlining diagnosis is established.

All per-page pair ratios, raw rounds, startup, resources, runtime versions and
load are preserved. In particular, WebKit combined/scalar first-order admin
is 1.0703 despite its nearly neutral four-page aggregate; all four pages are
slower in the reverse order (1.0308–1.1155). Firefox incremental per-page ratios
are below one in both orders (0.9199–0.9962), but the home/article effect is
larger in the reverse order. Do not pool 800 requests into an independent-sample
confidence interval or call this a quiet-machine/universal preset result.

A separate clock-only probe runs after application timings, avoiding concurrent
benchmark load. Each host samples five batches of 50,000 consecutive clock
increments; browser pages use the shared quiet fixture and the same isolated
headers/launch settings. All four checks pass. Observed positive minima and
minimum measured HTTP durations are below; these are empirical increments,
not guaranteed precision or an uncertainty bound. Clock quantization is small
relative to these requests; independent-parent variation still matters.

| Host/version | Observed minimum positive clock increment, ms | Smallest measured HTTP request, ms |
|---|---:|---:|
| node v24.15.0 | 0.000041000 | 158.650958 |
| chromium 153.0.8010.12 | 0.004999995 | 147.700000 |
| firefox 155.0 | 0.020000000 | 192.480000 |
| webkit 26.6 | 0.020000000 | 165.820000 |

Decision: retain atomic fusion for Firefox-focused replication and more atomic-
heavy workloads; do not enable it as a common preset. This bounded result does
not discard other offsets, immutable imported-control specialization or
compiler-sensitive placement. Scalar fusion remains host-dependent. No new
default, published preview or production ABI/runtime behavior changes. Full
platform benchmarks, canonical products, conformance, ABI acceptance and the
browser-memory gate are not established by this private application screen.

One additional idea is cataloged under VM08/09 from read-only source inspection:
specialize the single immutable imported table-generation VA. A per-instance
physical binding with resume/publication refresh, or a dedicated root-header
entry maintained at every PTE publication, could avoid general VA lookup while
retaining the required live atomic generation read. This differs from the
previous negative generic root-header cache. It is entirely unimplemented and
unmeasured. Immutable VA does not prove physical lifetime: grow/fork/map/remap/
protect/unmap, child/replay/side-module ownership, read rights/alignment/bounds
and synchronous Worker resume all require proofs. A JS Global cannot simply
be updated across Worker realms. Dedicated header space must not conflict with
cache/diagnostic layouts, and invalid bindings must preserve original faults.
Current experimental protection/unmap paths can invalidate that cell; do not
assume pinning from kernel reserved ranges alone. Detailed inspection paths
and hashes are retained in `common-memory-phase47-control-cell-review.md` and
its input record. This is an idea, not evidence of safe elision or CPU benefit.

The first preparation driver incorrectly assumed that every old variant had
a compressed phase28 byte copy and failed before any timing run. The corrected
fresh preparation checks all identity records and available compressed copies;
both driver versions/logs and the old omission are retained. No measurement
was rerun or removed. Evidence is under retained `phase47/`, with scratch
`common-memory-atomic-wordpress-variants-2`, `common-memory-atomic-wordpress-apps-1`,
`common-memory-atomic-wordpress-analysis-1`, mechanisms/audit and separate clock
folders. The broad goal remains active. MariaDB timestamp-policy confirmation,
broader writer-loop/provenance reach and resource lifecycle work remain distinct
follow-ups, not reasons to repeat general per-access cache tuning.

### CC-05: initial opcode-dispatch source review (phase 48)

This was the untested hypothesis at the close of phase 48; the phase 49
target/compile results below supersede its status. Read-only inspection of the actual PHP 8.5.12 build source finds
`HAVE_GCC_GLOBAL_REGS` and `HAVE_PRESERVE_NONE` undefined. The generated
`Zend/zend_vm_opcodes.h` consequently selects CALL for this build. The upstream
`Zend/zend_vm_gen.php` exposes `--with-vm-kind=CALL|SWITCH|GOTO|HYBRID`; this is
a separate compiler/runtime-representation idea from O3, LTO and PGO. SWITCH or
computed-label dispatch may change indirect Wasm calls, required table-generation
polls and memory traffic. No generator, build, mechanism or timing has been run
for these alternatives; no speedup or target support is established.

Preserve the potential costs: a much larger execute_ex function can change
compiler resource use, tiering and performance; computed-label lowering needs
a real target probe. Do not fake global-register or architecture capabilities
to force HYBRID/TAILCALL. Handler representation and OPcache must be rebuilt
consistently through normal SDK and fork preparation, with fresh original
function/counter maps and own ordinary controls. Existing table-consistency
checks remain wherever applicable. A declared generator runtime is required;
an undeclared host PHP is not a build input. The source/config snapshots and
hashes are in `common-memory-php-dispatch-review-1`. This candidate is retained
for a separate bounded admission/build screen after the running MariaDB work.

### APP-02: MariaDB timestamp-policy confirmation

Phase 48 extends the timestamp-policy experiment to the other WordPress
backend. The two cases use identical small-scalar-fusion PHP-FPM bytes
(`2edbcf32ef3c309eefdabec5eaceeb6d6082ca80fc9b1fc0e235ff838b7b89b4`),
ordinary O2 PHP (`be6a6eaeebea2c32825acd1da0dd160d6dcc0ad1024bfd9bebc08215d9eae8bb`),
pregrown host profile, database/image and cache capacity. Only timestamp
validation changes. This measures APP02 incrementally on the fixed VM10 build,
not a new unfused-policy interaction or a production/default change.

Read-only inspection verifies resident MariaDB, nginx, dinit, Bash and the
image FPM, plus materialized WordPress source. Nginx configurations explicitly
select MariaDB/SQLite through their FastCGI backend parameter; five resident
bootstrap/config files are recorded. The full image hash is
`2185bdbb403d6a0032dd9dfb8569dd0493aa5d2b218d642699571197297fd831`
(43,980,400 bytes). It also contains 15,082 deferred-file and 59 archive
declarations, all with 32-byte content digests. This freezes their declared
identities; inspection does not materialize or independently fetch those bytes.
The image is not wholly self-contained. The selected WordPress prefix has no
deferred files. The image FPM is replaced with the exact trial artifact before
boot; resident-program inventories are not a new runtime/ABI acceptance test.

Two initial inspection assumptions failed before application testing: requiring
optional deferred PHP CLI to be resident, then requiring all unrelated lazy
packages to be materialized. Both source versions/logs and the recorded facts
are retained. The corrected focused inventory preserves lazy identities and
missing/deferred optional-path observations. No application result was removed
or replaced. The full source audit passes 1,049 files/zero unreviewed findings
with unchanged policy, and sixteen plan/binding/negative checks pass.

Before timings, 24 independent semantic controls pass on Node and the three
browsers: both timestamp policies, ordinary FILE, VM/file and VM/shared. A
guest-created cached target is edited with distinct past mtimes. Both workers
observe the edit with validation on and keep the cached old version with it
off. Explicit shared-cache invalidation then exposes the new version. The
FILE-only invalidation API returns false in this PHP configuration; explicit
removal of that exact diagnostic cache entry exposes the new version. These
are diagnostics in separate parents, never latency samples. The editable
preview continues to validate timestamps.

The clean matrix has 64 independent parents: sixteen per host, two reversed
orders, per-policy ordinary FILE opening/closing brackets and VM/file/shared
cases. Two warmup and five measured four-page rounds yield 1,280 measured and
512 warmup requests. All sixteen Node and 48 browser timing controls pass.
Actual MariaDB service markers, admin/REST payloads, both FPM workers, cache
modes, own guest/image/kernel/profile identities, flags, exact sample inventories,
resource contracts and teardown are validated. All 235 outer inputs and matching
inner input sets remain unchanged. Managed job
`common-memory-mariadb-timestamp-policy-1112-063604-bdff` exits zero in 26m28s,
including the separate semantic controls. No SDK/package/program/image rebuild
or runtime implementation change occurs in this phase.

Ratios are validation-off/on; lower is faster. They use geometric means of
opposite-order ratios of per-parent per-page medians, not independent-request
confidence intervals. Ordinary means untranslated Wasm on the same engine.
Shared versus ordinary FILE includes cache-mode effects and is not a pure
address-translation tax.

| Host | VM/file off/on | VM/shared off/on | Shared first order | Shared reverse order | Ordinary FILE off/on |
|---|---:|---:|---:|---:|---:|
| node | 1.013028 | 0.957506 | 0.674252 | 1.359756 | 0.798755 |
| chromium | 0.969170 | 0.745349 | 0.736612 | 0.754189 | 0.965229 |
| firefox | 1.005249 | 0.721184 | 0.721924 | 0.720444 | 1.044647 |
| webkit | 1.084906 | 0.728004 | 0.743562 | 0.712772 | 1.104022 |

| Host | Shared home off/on | Shared article | Shared admin | Shared REST posts |
|---|---:|---:|---:|---:|
| node | 1.023679 | 1.041696 | 1.035123 | 0.761500 |
| chromium | 0.795901 | 0.822552 | 0.788025 | 0.598239 |
| firefox | 0.764880 | 0.788134 | 0.760052 | 0.590400 |
| webkit | 0.751693 | 0.780650 | 0.768512 | 0.622856 |

| Host | VM/file on / own ordinary | VM/file off / own ordinary | VM/shared on / own ordinary | VM/shared off / own ordinary |
|---|---:|---:|---:|---:|
| node | 2.097150 | 2.659730 | 1.235686 | 1.481277 |
| chromium | 1.908505 | 1.916297 | 1.119992 | 0.864856 |
| firefox | 2.165028 | 2.083376 | 1.203655 | 0.830957 |
| webkit | 2.325363 | 2.285100 | 1.266284 | 0.835002 |

Chromium, Firefox and WebKit shared-cache aggregates improve approximately
25.5%, 27.9% and 27.2%. Every shared-cache page/order comparison on those three
hosts favors validation off. This extends the earlier SQLite signal to this
MariaDB corpus, with the same explicit immutable-code/update-lifecycle condition.
The two studies are separate runs, not pooled samples or a direct database
speed ranking. Larger/plugin/concurrent workloads remain different experiments.

Node is inconclusive despite functional success. Its shared off/on ratios are
0.6743 and 1.3598 across opposite orders; the aggregate 0.9575 must not be read
as a stable 4.2% win. The first ordinary baseline parent has a four-page median
geomean of 720.7 ms versus its closing 223.1 ms; its measured round geomeans
range roughly 615–946 ms. The validation-off/shared parent in the reverse order
is also much slower than its earlier counterpart, while both report 547 cached
scripts and the declared policy. Load varies substantially. Historical registry
timestamps confirm selected
peer-build job lifetimes overlap both anomalous Node parents (baseline ordinary
first parent and reverse-order validation-off/shared), plus other cases. These
are job-lifetime overlaps, not a CPU trace, exhaustive process inventory or
causal explanation. No case is dropped, no favorable rerun replaces it, and ordinary-
normalized Node ratios inherit the control instability.

FILE-cache results are not a common win. VM/file off/on is near neutral or
regressive on Node/Firefox and order-dependent on Chromium/WebKit. WebKit’s
VM/file orders are 0.9727 and 1.2100 despite the 1.0849 aggregate. Ordinary FILE
is approximately 4.5% slower on Firefox and 10.4% slower on WebKit in aggregate;
Chromium and especially Node ordinary policy comparisons also vary by order.
All native brackets, per-page/order values, warm rounds, load, startup and
resources remain in the strict summary. Shared-cache benefits do not establish
a general PHP flag or untranslated-addressing speedup.

Recent separate phase47 clock probes are retained as historical calibration:
all current host versions match them; observed positive increments were
0.000041 ms Node, 0.005 Chromium and 0.020 Firefox/WebKit. Current minimum
measured HTTP durations exceed 119 ms. These empirical increments are not
guaranteed precision, stationary behavior or an uncertainty bound; control/order
variation remains the important limitation. Small differences are not promoted
to confident gains.

A separate AFTER-timing Node-only diagnostic reuses the exact retained
syscall-profile bundle bytes (independently checked against their compressed
archive). Two fresh MariaDB/shared parents use two warmup/five measured rounds
and twenty measured pages each. Both app/cache/worker/teardown checks pass;
all 251 frozen diagnostic inputs remain unchanged. These counts include every
guest process and asynchronous background/tail work; handler wall times are
not CPU and these runs never replace the original latency samples. Numeric
counters are labeled using the frozen generated Kandelo ABI, not Linux numbers.

| Policy | Service-wide dispatches | stat | clock_gettime | read | write |
|---|---:|---:|---:|---:|---:|
| 1 | 47,398 | 10,590 | 15,198 | 2,735 | 190 |
| 0 | 30,025 | 435 | 8,015 | 2,735 | 190 |

Validation off removes 17,373 dispatches (36.7%) in this diagnostic sample, including 10,155 stat and 7,183 clock_gettime calls. Read/write totals are unchanged in this sample; that is not a SQL-query-count measurement.
This supports the filesystem/time-check mechanism across both backends while
leaving the unstable Node wall-time result inconclusive. It does not assign
all remaining cost to address translation or predict a speedup on other hosts.

Decision: immutable-code timestamp policy remains a promising shared-OPcache
option with explicit invalidation/restart requirements. The MariaDB browser
screen supports it; the Node latency estimate needs separate controlled
replication. Keep all FILE/ordinary regressions and the original SQLite CPU
regressions. Do not change the editable preview or ship a new default. No
canonical/full-platform/full-suite/POSIX/ABI/browser-memory acceptance follows
from these private application screens.

Evidence is retained in `phase48/`, from scratch
`common-memory-mariadb-timestamp-campaign-1`, `common-memory-mariadb-timestamp-analysis-1`,
`common-memory-mariadb-timestamp-syscalls-1`, focused image/backend records and
all inspection attempts. Completed-host interim reads are retained and do not
replace the final strict matched summary. The broader writer-loop/provenance
constraints are preserved in `common-memory-phase48-writer-loop-notes.md`.

At the end of phase48, CC05 was a newly cataloged, entirely untested compiler/runtime family. Besides
SWITCH/GOTO dispatch, upstream `--without-specializer` offers a separate code-
size versus per-opcode-work tradeoff, alone or with a dispatch change. Do not
assume its effect or silently drop it. Target admission, a declared generator
runtime, consistent PHP/OPcache rebuild, fork/continuation/new-ordinal proofs
and matched ordinary/VM measurements are still required. No new generator or
compiler probe ran while frozen application timings were active. The active
goal continues with that distinct family or broader writer-loop reach.

Phase48 evidence notes: the first documentation driver used an incorrect Python
assertion expression and failed before changing the catalog; the original
driver/log and corrected driver are retained, with measurements unchanged.
The historical peer-overlap analysis uses only sanitized ids/times/exit fields
and recorded parent intervals; no peer source/log/environment is copied.

The first overlap-analysis driver also had a syntax error before reading or
writing data. Its source/log and the corrected driver are retained; the final
sanitized timeline is separate from the unchanged latency measurements.

### CC-05: six-way target and executor screen (phase 49)

This is a new compiler/runtime-representation screen, separate from O3, LTO,
PGO and per-access caching. The normal configured build uses CALL. The SDK
accepts tiny switch and computed-label examples; the latter lowers to a Wasm
branch table plus a label-table load. Both agree with a scalar reference for
131,232 cases on each of Node, Chromium, Firefox and WebKit. These calls run
only the two exported diagnostic functions in disposable Workers. The real
SDK start glue is linked, but its host imports throw if called and none fires;
this does not exercise program startup, kernel services, PHP or fork.

The actual PHP 8.5.12 generator ran in Kandelo using the existing stamped,
receipt-matched PHP C-O3 CLI, on the existing PHP partial shell. This CLI is a
declared generator input; candidate C compilation stays O2 with no LTO/PGO.
All six CALL/SWITCH/GOTO × specialized/generic cases generated successfully.
The complete set is **four** files: `zend_vm_execute.h`, `zend_vm_opcodes.h`,
`zend_vm_opcodes.c` and `zend_vm_handlers.h`. All are identity checked. Six
negative builder checks reject incomplete/changed/failed generator inputs,
a missing manifest and a premature O3 combination before creating build roots.

A corrected executor-only compile screen uses the normal configured target
headers and SDK C command, with independent objects/logs per variant. It
attempts every variant and retains all failures:

| Variant | Actual SDK executor result |
|---|---|
| CALL, specialized | Compiles; current control |
| GOTO, specialized | Compiles; full PHP link/fork/application checks still pending |
| SWITCH, specialized | Fails: generated initializer uses `zend_vm_opcode_handler_func_t` and CALL handler names absent in this representation |
| CALL, generic | Fails: generated `get_op_data_zval_ptr_undef` calls have no matching helper declaration |
| SWITCH, generic | Fails; generic helper and representation errors retained |
| GOTO, generic | Fails; generic helper error retained |

The fresh normal-recipe SWITCH CLI/FPM build, with all four generated files
verified, independently fails at executor compilation with the same initializer
errors. It produces no completed PHP candidate and is not a passing package.
Source inspection finds an EXTERNAL_LABELS generator branch that emits CALL
function tables for the non-GOTO case; the SWITCH handler type is an integer.
The generic generator's ANY operand rule names the absent helper. These are
observed compatibility boundaries in the current source/configuration, not
runtime or toolchain fault claims. Preserve prospective portable repairs;
operand constants must use the OP_DATA instruction as their base, and undefined
CV/error behavior must stay correct before any repaired candidate is timed.

The two successful unit objects show why smaller generated source is not a
sufficient performance theory:

| Executor unit, before whole-program preparation | Functions | Sum of function-body bytes | Largest body | Static indirect calls |
|---|---:|---:|---:|---:|
| CALL, specialized | 1,234 | 476,331 | 3,290 | 333 |
| GOTO, specialized | 174 | 475,546 | 413,009 | 328 |

GOTO has 99.84% of CALL's total body bytes, but a **125.5× larger largest
function**. Static counts are not executed counts, helper frequencies, CPU or
speedups. Compiler wall times were collected during overlapping builds and
are not runtime benchmarks. GOTO needs full PHP/OPcache/fork preparation and
engine compilation/resource checks before matched ordinary/VM timing. New
function ordinals require fresh observer maps; the original PHP trace cannot
be reused by index.

A separate honest capability probe rejects default-target `musttail` because
the tail-call feature is disabled; `-mtail-call` emits `return_call_indirect`.
The target rejects `preserve_none` when ignored attributes are errors. A tiny
ordinary-C-calling-convention handler chain, explicitly built with
`-mtail-call`, passes 21 checksum cases per host, including a million dynamic
handler transitions, on all four hosts. This retains a portable tail-call
interpreter design as another option. It does not justify faking PHP's native
architecture/calling-convention guards, turning on its existing TAILCALL mode,
or claiming PHP/fork compatibility. No tail-call performance was measured.

Retained preparation failures: the first generator validator rejected legal
`# define` spacing and its old CLI emitted an unstamped legacy warning; the
corrected runs use the receipt-matched stamped CLI. The first build guard
assumed a trailing Makefile space. An initial matrix and second build copied
only three generated files. Fixing that omission did **not** cure SWITCH, so
it is not its final root-cause explanation. All original sources/logs and the
corrected fresh attempts remain. An attempted stop of the superseded unit job
found it already finished; no signal was sent and no result was cancelled.
No timing data was excluded or replaced. Full/canonical images were not built,
the frozen preview was unchanged and no compiler default was promoted.

Evidence: retained `phase49/`, from scratch `common-memory-php-dispatch-generated-3`,
`common-memory-php-dispatch-units-2`, `common-memory-php-switch-specialized-build-3`,
`common-memory-dispatch-admission-1`, `common-memory-php-tailcall-admission-1`,
`common-memory-tailcall-admission-1`, builder negatives and
`common-memory-phase49-analysis-1`. Earlier failed/incomplete attempts are
retained alongside the corrected evidence.

### RT-01: failure-only growth witness (phase 49)

A separate four-host diagnostic exercises the retained exact compiled C
`vm_grow` helper and JS `VirtualMemory.grow`, both with baseline and mapped-page
reuse adapters. Each mode uses a 64MiB physical pool and performs 48 repeated
rejections: guest virtual ceiling, group capacity and backend rejection, for
both C and JS. Backend rejection is deterministic fault injection: the group
header temporarily advertises one page beyond the actual Wasm memory maximum.
That mismatch is deliberately not an admitted production configuration or a
model of general engine OOM.

The stronger final fixture passes **314 checks per host**. Each failure compares
all 64 root-header bytes, all PTEs, every byte of both existing payload pages,
allocator words, physical size and free extents, and checks that the allocator
lock is released. A successful retry then owns exactly the last physical page,
which is zero filled, while every old payload byte remains intact. Further C
and JS growth fail without mutation. The original preliminary fixture checked
sampled payload bytes; it remains separately retained, and the final fixture
adds full byte comparisons.

This is evidence about these failure paths only. It does not establish
concurrent growth, allocator fairness, root retirement, snapshot cancellation,
process replacement/churn, reclaimed-extent alias compatibility, RSS or a
latency gain. Those resource ideas remain open. Evidence is under retained
`phase49/`, scratch `common-memory-growth-failure-1` (preliminary),
`common-memory-growth-failure-2` (full bytes) and the phase49 analysis.

Archive bookkeeping: the first phase49 archive writer looked for job receipts
beside local logs, while this installation keeps them in the global job
registry. It stopped before updating the archive manifest. The corrected writer
retains only the eight owned jobs' sanitized terminal fields, registry hashes
and local logs; the failed writer/log remain. This changed no test or timing
result. The partial archive copy is disposable scratch, and the final evidence
was copied afresh without replacing prior retained files.

### CC-05: full GOTO port, browser WordPress and Node resource boundary (phase 50)

Both specialized CALL and GOTO now have fresh unpublished CLI/FPM builds from
the same normal PHP recipe, source, dependencies, O2 flags, generator manifest,
SDK, pre-fork Binaryen and normal fork/stamp path. All four generated files
are verified before compilation and after the builds. CALL finished in3m59s
and GOTO in10m33s in overlapping builds; those are observations, not controlled
compiler or request benchmarks. Optional shared extensions and canonical images
were not rebuilt. The existing PHP partial shell and selectable WordPress image
remain the test substrates; the frozen preview was unchanged.

The new ordinary FPM hashes are CALL
`ed69422e9d031e0d56676c88e8280937a070caff733a4300f2bcf10dc5fd74a5`
and GOTO `30c507f6ef213fe02c3243748da29a9b6d1a0bb869a1246b8a9d7f46735163a3`.
Each dispatch build is translated independently with the same O2 helper,
first outlined and then combined with small scalar fusion. These are fresh
ordinary controls, not substitutions for the historical PHP trace. Old function
ordinals must not be applied to them.

| Default host | CALL mechanisms | Ordinary GOTO CLI/FILE-FPM | Virtualized GOTO CLI/shared-FPM, outlined and fused |
|---|---|---|---|
| Node24.15.0 | All6cases pass | Both pass | All4parent processes terminate with SIGTRAP and `Fatal process out of memory: Zone` |
| Chromium153.0.8010.12 | Pass | Pass | Pass |
| Firefox | Pass | Pass | Pass |
| WebKit | Pass | Pass | Pass |

CLI checks include array copy-on-write, closures, exceptions/finally,
generators and a fork inside eight recursive PHP calls. Parent and child must
return checksum612 and preserve private cyclic object graphs. FPM shared checks
prove distinct-worker cache publication/reuse, invalidation/recompilation,
request-private state and replacement-worker reuse. Browser CLI originally used
the Node stdout callback signature and failed its output assertions despite
PHP exit0. The original18failed fixture results are retained. Correcting the
one-argument BrowserKernel callback gives18passing fresh CLI cases; the original
18browser FPM passes remain separate. This correction changes no guest program
or Node OOM outcome.

The Node failures include optimizing-compiler frames. Some occur after the
PHP assertions and host destruction complete; they remain failures of the
whole parent process. Neither successful guest output nor an earlier validation
is a substitute for a clean parent exit. No outside-runtime defect is asserted.
A separate Node resource diagnostic holds the outlined GOTO CLI bytes fixed:

| Node option screen | Parent result |
|---|---|
| One Wasm compilation task | SIGTRAP / Zone OOM |
| No Wasm inlining | SIGTRAP / Zone OOM |
| No Wasm loop unrolling | SIGTRAP / Zone OOM |
| No inlining plus no loop unrolling | SIGTRAP / Zone OOM |
| Baseline compiler only (`--liftoff-only`) | CLI/fork check and parent exit pass |

Applying the same baseline-only flag to CALL/GOTO × outlined/fused also passes
all4FPM shared-cache checks. It affects the kernel and guest Workers and is a
diagnostic envelope, not a default-settings fix or latency result. Separately,
post-VM Binaryen O2 preserves named runtime contracts and validates, but the
resulting GOTO CLI and FPM still produce the same default-Node compiler OOM.
Those negative combinations remain candidates for other workloads; they did
not cure this case.

Whole prepared-module sizes explain the concern more accurately than the
previous executor-unit figures alone:

| Prepared FPM | Module bytes | Defined functions | Largest body bytes |
|---|---:|---:|---:|
| CALL, ordinary | 37,003,204 | 49,424 | 177,517 |
| GOTO, ordinary | 36,866,988 | 47,428 | 663,785 |
| CALL, outlined VM | 38,072,786 | 56,296 | 181,089 |
| GOTO, outlined VM | 38,275,783 | 62,014 | 692,878 |

GOTO has fewer original functions but creates14,571 distinct access wrappers
versus CALL's6,857. Static wrapper/body sizes are not execution frequency,
compilation peak memory, CPU fractions or warm performance. Small scalar fusion
changes neither of these maximum-body lengths. The earlier125.5× figure was
for the largest body within the isolated executor object, not these complete
prepared PHP modules.

Browser application admission is now stronger than the small FPM scripts:
**36 WordPress parents /144 four-page correctness requests pass**. This spans
SQLite and MariaDB, outlined/fused GOTO, its own ordinary FILE control and
VM/FILE/shared modes on all three default browsers. Homepage, article, admin,
REST, backend selection, two-worker/cache and clean teardown assertions pass.
These have zero warmup and one measured round solely for functionality;
no speed ranking is drawn from them. Matched warm browser timing remains to do.
Default Node is not currently an admitted virtualized GOTO timing candidate.

Validation boundary retained: local WABT1.0.36 rejects a result type in the
translated CALL CLI, even with all its feature switches. The translator's
wasmparser validator and Node validate the unchanged bytes, and the actual
browser checks execute them. The corrected preparation verifies byte identity
with the first retained translation. `wasm-tools` was unavailable in the
declared dev shell. This is a validator disagreement with preserved versions,
commands and bytes, not evidence of a particular external defect.

Evidence is retained under `phase50/`, including both fresh builds,
`common-memory-php-dispatch-variants-1` (WABT stop), corrected `variants-2`,
original mechanisms and corrected browser CLI, Node flag screens, post-VM O2
and its failed Node checks, code shapes, WordPress preflight and analysis.
No application timing, full platform benchmark, conformance, ABI acceptance,
browser-memory gate or canonical-product claim follows from this phase.

### VM-08 / CC-04: compiler-fact ordering and broader writer-loop follow-up

A separate read-only inspection checks the actual GOTO CLI before and after
normal pre-fork Binaryen O2. On raw linked bytes the sink report accepts the
compiler facts:2,242chunks,30,010definitions,29,997bound definitions,25union
bindings and6signature mismatches. After O2 it correctly rejects the unchanged
facts' code hash and uses conservative closure analysis. No metadata hash was
rebound or forced valid.

This does not by itself establish a useful optimization. Comparing local-name
multisets within each exact module, the raw discovery has22,356local functions
and the facts-based instrumented set22,350: only six are removed. The optimized
module has20,257locals in both its discovery and instrumented set. Import
entries are excluded from these comparisons. Original names/indices differ
after optimization; raw and optimized sets cannot be joined by ordinal. The
facts-based raw sink report was observed still running at8m30s; that live-process
observation is not a controlled analysis benchmark. It does not prove that skipping pre-fork O2 shrinks prepared code or
improves runtime performance. Callsite capture effects remain unmeasured.
Preserve an honest fact-preserving pipeline as an idea, with its source/code
binding, ordinary controls and full fork tests required.

Breadth also extends the retained writer-loop inventory without rewriting a
program. The original PHP module has3,700loops whose only modeled effects are
guest writes,3,443with empty operand-stack entry and1,689of those with stride
hints. O3/LTO/PGO scans retain separate inventories. Write effects include
scalar stores and bulk copy/fill/init. Unknown destinations can alias control
or channel fields; call-free does not establish mapping lifetime or safe
translation elision. Bounds, induction/no-wrap, aliases and fork rebinding
still require proof.

Matching only the historical original module to its retained trace, the parent
functions of empty-entry stride-hint writer loops account for about22% of all
memory dispatches. That is an **upper bound over whole parent functions**, not
actual execution within those loops, CPU, bytes or a speedup. It cannot be
compared directly with the earlier0.16% actual readonly-site frequency. The next
useful screen is an actual site-level writer-loop observer before implementing
larger guarded spans. No GOTO or other compiler profile inherits that trace.

New source-shape ideas remain explicit rather than being discarded: ordinary-C
explicit tail calls, intermediate groups of opcode handlers between CALL and
one large GOTO executor, and generic offset parameters for cold large-offset
wrappers to reduce wrapper proliferation. Those have no PHP performance result
or implementation here. The existing per-access cache failures do not reject
these different placements and frequencies.

### CC-05 / VM-10: warm browser dispatch and cache provenance (phase 51)

Fresh browser parents complete48application/admin/REST/two-worker/cache/
artifact/teardown controls:960measured warm pages and384warmup pages. The
48-parent screen holds the host, helper O2, PHP O2/noLTO/noPGO, SQLite image
and explicit immutable-code timestamp-off policy fixed. Each host runs two
cohorts with reversed VM order and opening/closing ordinary CALL/GOTO FILE
references. Four VM/shared cases form a CALL/GOTO × outlined/small-fusion
factorial. Every parent has two warmup and five measured four-page rounds.
Node has no timing rows because its default GOTO optimizing-compiler
resource gate failed in phase50; no engine flag or fake Node dataset is used.

Ratios below are geometric means of four page-median ratios across two
opposite-order parents per mode. Lower means shorter requests; this is not
a request-weighted workload, throughput, CPU or steady-state confidence claim.

| Browser | GOTO/CALL outlined | Fusion/CALL outlined | GOTO/CALL fused | Fusion/GOTO outlined | Combined/CALL outlined |
|---|---:|---:|---:|---:|---:|
| chromium | 2.7269 | 0.8835 | 2.9859 | 0.9674 | 2.6381 |
| firefox | 2.2045 | 1.1285 | 3.1072 | 1.5907 | 3.5066 |
| webkit | 3.7645 | 1.1552 | 2.8319 | 0.8690 | 3.2714 |

| Browser | Outlined GOTO/CALL, first / reverse order | Combined/CALL, first / reverse order |
|---|---:|---:|
| chromium | 2.839 / 2.619 | 2.648 / 2.628 |
| firefox | 2.167 / 2.243 | 2.105 / 5.841 |
| webkit | 4.812 / 2.945 | 3.835 / 2.791 |

Current GOTO is a lower-priority performance candidate: its direction is adverse
in both orders on all three browsers and it already has the Node resource
failure. This does not discard SWITCH/generic compatibility work, ordinary-C
explicit tail calls or intermediate handler clusters. Large body/wrapper counts
are static observations; no profile here establishes the reason for the loss.
Fusion under CALL is favorable on Chromium in both orders, but Firefox and
WebKit reverse directions; their aggregate values are not universal presets.

The ordinary FILE controls are explicitly **preseeded-image references**.
A read-only image inventory finds1,500materialized cache files in one namespace
(45,251,192bytes;223directories). The empty-cache assertion returns exit1 and
its original inventory/log are retained. This corrects the earlier assumption,
not the observed HTTP/cache/teardown assertions. PHP serializes handler-table
indices and rebinds them through the receiving table; a shared system ID alone
is not a demonstrated cross-dispatch compatibility proof. Empty-cache images
and actual cache-hit/interchangeability tests must precede clean-baseline or
promotion claims. No image or preview was changed in this phase.

All ordinary ratios, per-page values, launch orders, cold listener/first-page
observations and load records remain. Maximum ordinary bracket drift is
1.251Chromium/1.228Firefox/1.679WebKit. No quiet-machine claim or outlier removal.
The within-VM/shared dispatch and fusion comparisons use FILE-cache-disabled
cases, so the baked FILE corpus does not supply their opcode cache.

Evidence: `common-memory-php-dispatch-warm-{manifest,browser,analysis}-1`,
`common-memory-phase51-image-cache.json`, cache-provenance qualification and
all sources/receipts retained under `phase51/`. Timing collection succeeds
after24m41s. All frozen timing inputs verify unchanged. This is bounded
application evidence, not full platform benchmark, canonical build, conformance,
ABI or browser-memory acceptance.

### VM-10 / CC-05: retained wrapper-shape alternatives (phase 51)

`operation_key` encodes the entire source instruction before wrapper
deduplication. In addition to parameterized cold large offsets, retain
normalizing equivalent non-atomic declared-alignment hints to reduce distinct
keys. Alignment hints are not alignment proofs; this cannot remove runtime
split/permission/overflow checks or change atomic validation. SIMD operation
and lane identity stay exact. Count actual key reductions first, then measure
code size, compiler resources and warm requests. No implementation or speed
result is claimed. Generic offset parameters must preserve unsigned64-bit
effective-address checks and original trap/store ordering. Old PHP ordinals
do not establish coldness in the new dispatch builds.

### VM-05/07/08: actual writer-loop sites (phase 51)

The opt-in writer observer measures actual reached original memarg sites
inside loop intervals whose modeled effects are exactly guest-memory-write.
It retains the prior seven origin/readonly classes and adds seven explicit
classes at215–221. Loop nesting forms unions rather than multiplying counts.
Store subsets count memarg scalar/SIMD stores. Bulk copy/fill/init may qualify
a window but do not become scalar-site counts. Direct/indirect calls, atomics,
growth, table operations, unwind and unknown effects exclude the containing
loop. A qualifying nested loop may still be observed inside an excluded parent.

All904,942original memarg operations are joined to the matching outlined PHP
by exact function inventory, per-function operation count and kind order.
The native original PHP hash is
`be6a6eaeebea2c32825acd1da0dd160d6dcc0ad1024bfd9bebc08215d9eae8bb`;
no new CALL/GOTO artifact inherits these ordinals. The prior plain and
seven-class diagnostic output binaries reproduce byte for byte. Twelve Rust
checks pass, including excluded effects, nested readonly/writer unions and
nonempty operand-stack entry. Mechanism102checks/host pass on Node, Chromium,
Firefox and WebKit: skipped/zero-trip/taken paths, exact read/store counts,
nested union, independent fork counters, denied attempted access and the prior
scatter/64-bit/private/shared accounting checks. No fast path is enabled.

One real SQLite/shared diagnostic parent per host runs two warmup four-page
rounds and one measured four-page round with timestamp validation on, matching
the earlier origin screen. Admin/REST/cache/two-worker/identity/teardown and
category/function/class accounting pass. Counts include asynchronous tail work
and use individually atomic snapshots, not a globally atomic service snapshot.

| Host | Attempts | Readonly union | Writer loops | Empty-entry writers | Empty-entry with stride hints | Writer stores | Readonly/writer union |
|---|---:|---:|---:|---:|---:|---:|---:|
| node | 379,588,326 | 0.162270% | 4.343607% | 4.163258% | 3.641569% | 1.924314% | 4.436199% |
| chromium | 379,587,356 | 0.162394% | 4.343714% | 4.163368% | 3.641672% | 1.924364% | 4.436430% |
| firefox | 379,594,357 | 0.162531% | 4.343665% | 4.163323% | 3.641637% | 1.924341% | 4.436519% |
| webkit | 379,588,546 | 0.162535% | 4.343731% | 4.163386% | 3.641692% | 1.924370% | 4.436588% |

The3.642%actual stride-hint-loop fraction replaces neither the old22%whole-
parent upper bound nor the0.16%readonly fraction; they describe different sets.
It is a much more useful estimate of this broader shape's reach. Even4.344%
is neither CPU share nor safe-elision coverage: each operation has unequal
cost, not every loop access has a bounded stride, and unknown stores may alias
control/channel memory. Induction/no-wrap, bounds, permissions, stable mapping,
guard domination, alias exclusions and fork/resume rebinding remain unproved.
The appropriate next test is a limited guard/proof and hot-site attribution,
not assuming that all writer loops can bypass translation.

The first browser collection fails before any browser case: broad test discovery
finds a copied spec in source-at-run and its incomplete copied import tree.
The original Node run succeeds. Exact-file discovery plus source-snapshot
exclusion fixes the browser harness; only the three browser hosts are rerun.
Both attempts, original configuration snapshot, valid Node data and corrected
six browser cases remain retained. The corrected258frozen runtime inputs
verify unchanged. This is a collector correction, not an engine/guest fix.

Evidence: `common-memory-writer-sites-{build,mechanisms,apps,analysis}-1`,
`common-memory-writer-sites-apps-browser-2` and `phase51/`. Full canonical
builds, platform benchmark, POSIX/conformance, ABI and browser-memory acceptance
are not established by these diagnostic checks. The research goal remains active.

### Baseline admission and bounded FILE-cache compatibility (phase 52)

A separate unpublished image removes1,500prebuilt OPcache bytecode files
(45,251,192bytes), retaining223empty cache directories. Recorded non-cache
paths/content/modes/ownership and every lazy binding match the original tree.
The normal Rust image writer roundtrip, layout checks and all10materialized
Wasm artifact-policy checks pass. Source image2185…831 is unchanged; the new
image SHA is
`cfbd0ed8790725d01f5912bbd908633c0166b86204e55feab3d877fd740244d6`
(43,571,706transport bytes, compression level3). This is not an RSS or physical
payload-reclamation measurement. The interactive preview is unchanged.

All32actual WordPress parents/128four-page correctness requests pass on the
new image: Node/Chromium/Firefox/WebKit × SQLite/MariaDB × ordinary CALL,
ordinary GOTO, CALL+small-fusion VM/FILE, and CALL+small-fusion VM/shared.
Admin login, REST content, both FPM worker PIDs, cache mode, populated shared
cache, artifact/image/kernel identities, allocation bounds and teardown pass.
Zero warmup/one round is functional admission, not a latency comparison.
Node virtualized GOTO remains excluded for its real compiler-resource failure.
The253inputs verify stable at collection. The offline key analyzer source
changes only after terminal completion; its exact original source is retained.

A separate ordinary-addressing CLI corpus verifies actual FILE-cache use,
not just successful source execution. Two FILE-only producers independently
cache an entry and library. Fresh same-/cross-dispatch FILE-only consumers
execute the expected library after its source is replaced with a deliberate
exception. Both poisoned-empty-cache consumers fail with that exception and
exit255, as required. Additional shared+FILE/read-only consumers record PHP's
explicit cache-import log for both entry/library; empty-cache success controls
have no import log. Producer cache byte hashes remain unchanged. The payload
exercises interfaces/traits/classes/enums, closures, nested array copy-on-write,
exceptions/finally, generators, match/switch, string mutation and cyclic objects.

**154checks/host pass on all four hosts**, with CALL→CALL, CALL→GOTO,
GOTO→GOTO and GOTO→CALL. Each host's final diagnostic parent launches15fresh
PHP processes, including bootstrap and the two expected failures. The earlier
narrower96checks/host shared+FILE log screen also passes and is retained.
No timed optimization, FPM cache-sharing acceptance, arbitrary opcode coverage
or full prebuilt-WordPress-cache compatibility follows from this core corpus.
All prior preseeded FILE timing ratios keep their original qualification;
new clean-image matched warm timing has not run.

The first probe fails its config check despite a positive cache-import log:
cached `ini_get` expressions report the producer's FILE-only/read-write values
while the consumer's shared cache and read-only log are active. The inspected
PHP optimizer explicitly evaluates `ini_get` for `ZEND_INI_SYSTEM` constants.
The corrected diagnostic moves configuration reads into an uncached `-r`
wrapper. It preserves optimization settings and checks the live consumer
configuration. This is an observed cached-config behavior inside Kandelo,
not a confirmed external-defect claim or a new shipping workaround.

Failed attempts are retained: initial image helper cannot JSON-encode BigInt
lazy inode fields; its corrected copy uses an explicit BigInt representation.
The first wrapper-inventory Python driver has a syntax error before execution;
corrected drivers use fresh output directories. No successful runtime result
is replaced. Evidence: `common-memory-wordpress-empty-cache-{1,2}`,
`common-memory-empty-image-checks-1`, `common-memory-cache-compat-fixtures-{1,2,3}`,
Node attempts1/2/3, browser attempts1/3, phase52analysis and retained `phase52/`.

### VM-10 / CC-05: encoded wrapper-key and signature inventory (phase 52)

The new read-only `wrapper_keys` binary enumerates the same exact encoded
instruction keys as `collect_wrappers`. It reports hypothetical deduplication
policies without rewriting programs. Atomic keys stay exact. Opcode, SIMD lane,
memory index and other immediates remain distinct. A leading key tag separates
a generic offset-parameter signature from a specialized signature; large means
offset greater than16, not dynamically cold. The preliminary inventory lacked
its mixed-signature tag and is retained as a normalization-only count.

| Native FPM build | Exact keys | Normalize non-atomic alignment hints | Parameterize all non-atomic offsets | Both | Parameterize large offsets only | Both, large only |
|---|---:|---:|---:|---:|---:|---:|
| original | 6,857 | 6,235 | 105 | 83 | 383 | 297 |
| call | 6,857 | 6,235 | 105 | 83 | 383 | 297 |
| goto | 14,571 | 13,942 | 105 | 83 | 383 | 297 |

Exact counts match the existing translator:6,857CALL and14,571GOTO keys.
Four targeted Rust checks pass, including atomic identity, lane/opcode
separation, small-offset specialization, generic/specialized signature
distinction and unsigned64-bit offset keys. Alignment-only normalization
would reduce keys by622CALL/629GOTO; it does not prove actual alignment and
must not remove split, permission or overflow checks. Parameterizing large
offsets is worth a prototype because it leaves383keys, or297with alignment
normalization. The original/CALL build has536,722large-offset static sites
out of904,942; GOTO537,512of904,757. These are static sites, not execution.

Fewer wrappers do not imply less code or faster requests: moving offset
constants into call sites adds arguments/immediates and can enlarge original
function bodies or change engine inlining. Small hot wrappers should remain
specialized, and hotness needs matching-build execution evidence. A real
prototype must preserve effective-address width, faults/store ordering and
fork metadata, then compare alignment alone, large-offset parameters alone
and both against the same ordinary/VM controls. No optimization is enabled,
and no performance/resource saving is claimed from this inventory.

`instrument/Cargo.toml` now explicitly names the original binary as default
run target so adding the analysis binary preserves existing invocations.
The original translator source and shipping runtime/SDK/packages are unchanged.

### VM-10: real alignment/generic-offset wrapper factorial (phase 53)

November12: implement the phase52 key policies in the optional translator,
then test their actual code and application costs. The new flags are
`--canonicalize-nonatomic-alignment` and `--generic-large-offsets`, both requiring
outlined accesses. Alignment normalization uses the operation's natural
non-atomic hint; it proves no alignment and removes no split/overflow/permission
checks. Generic offsets above16 become an additional i64 argument after the
existing address/value operands. Keys distinguish generic and specialized
signatures. Atomics keep exact alignment/offset behavior; opcode and SIMD lane
identities stay distinct. Resolution and scattered-store commit use the same
unsigned-bit-preserving offset. Original function/global indices are retained.

Generic large offsets currently reject regional/object guards, affine caches,
atomic fusion and all-offset scalar fusion. The screen uses ordinary helpers
and small-offset scalar fusion. Other accepted combinations need separate
evidence. New policy metadata appears only with a new flag; the default outer
prototype format remains1. Four original CLI/FPM outlined/fused output hashes
match the previous baseline exactly. Shipping runtime, SDK, ABI, packages,
defaults and frozen interactive preview are unchanged. An unused legacy
`ZeroOffset` Rust struct emits a dead-code warning; no build failure is hidden.

The full2x2x2 factorial uses one CALL PHP O2 build, helper O2, no LTO/PGO,
normal fork preparation and the same pre-grown host profile. Static FPM shapes:

| Key policy | Wrappers | Outlined bytes | Small-fused bytes | Defined functions |
|---|---:|---:|---:|---:|
| Exact | 6,857 | 38,072,786 | 38,104,734 | 56,296 |
| Alignment | 6,235 | 38,044,513 | 38,068,578 | 55,674 |
| Generic large | 383 | 39,157,340 | 39,189,288 | 49,822 |
| Both | 297 | 39,153,674 | 39,177,739 | 49,736 |

Untranslated FPM is37,003,204bytes/49,424defined functions. Largest body bytes
are177,517ordinary,181,089exact/alignment and184,056generic/both. Fewer wrappers
do not mean smaller Wasm: call-site constants and arguments add about1.1MBwith
generic offsets. These are static shapes, not engine-native code size or RSS.

Four new translator unit tests and four wrapper-key tests pass. Four negative
option cases reject without output. All48translations finish. The32basic
variant/host cases include512new targeted large-offset assertions covering
unaligned/split/scattered numeric loads/stores, negative zero, SIMD lanes,
unchanged atomics and alignment traps, unsigned4294967295offset overflow,
mixed specialized/generic signatures and denied-store prefix preservation.
Existing growth/map/remap/protection/fork/atomic/bulk checks remain.
The24fresh Node and72fresh browser platform parents pass recursive PHP fork
(depth8/checksum612/private cyclic graphs), real C shared fork, and actual FPM
shared-OPcache publication/invalidation/recompile/replacement. The private
browser FPM fixture was corrected to the actual one-argument stdout callback;
production source was untouched. These are bounded prototype checks, not
general POSIX, retirement or concurrent-mapping acceptance.

Real WordPress admission passes64parents/256four-page requests: all eight
VM/shared profiles, both SQLite/MariaDB and all four hosts. A strict combined
validator checks actual artifact/image/kernel identities, login/admin/REST,
two worker PIDs, cache mode/population, memory bounds and teardown. These
0warmup/1round gates supply no latency ranking.

Ordinary-cache admission is now explicit. Starting from cache-empty image
SHA`cfbd0ed8790725d01f5912bbd908633c0166b86204e55feab3d877fd740244d6`,
every host generates565OPcache files/24,456,992bytes with verified headers.
The two nobody FPM workers use file_cache_only=1, an explicit cache directory
and timestamp validation off. Both workers retain edited v1until explicit
removal/invalidation then observe v2. A teardown snapshot copies VFS metadata
and first40bytes per file, before normal destruction; it contributes no timing.
This is bounded generation/policy evidence, not compatibility of the original
1,500-file prebuilt WordPress corpus. Earlier preseeded-image ratios remain
qualified; no earlier results are replaced.

The clean timing job completes80fresh parents:20per host, two opposite-order
cohorts, ordinary FILE brackets around all eight VM/shared cases. Each parent
uses2warmup/5measured rounds of home/article/admin/posts:1,600measured and
640warmup pages, SQLite. All use timestamp validation off, no preload, no
diagnostics or probe requests. The strict analyzer verifies exact samples,
settings, artifacts/image/kernel, both workers/cache, resource bounds,
teardown and frozen source inputs before calculating15contrasts. No failing
parent, retry, page or outlier is removed.

Below, each entry is a descriptive geometric mean of four page-median ratios
over two cohorts. Lower means shorter elapsed time. Every entry compares with
exact outlined VM/shared; these are not CPU fractions, confidence intervals or
request-weighted throughput. Node aggregates are retained but inconclusive.

| Host | Alignment | Generic large | Both | Small fusion | All three |
|---|---:|---:|---:|---:|---:|
| Node | 1.1597 | 0.7387 | 0.6960 | 0.6654 | 0.6560 |
| Chromium | 1.0166 | 0.9854 | 0.9716 | 0.8797 | 0.8755 |
| Firefox | 0.9940 | 0.9895 | 1.0029 | 0.8960 | 0.8949 |
| WebKit | 1.0090 | 1.0187 | 1.0397 | 1.0630 | 1.0484 |

Increments over fusion-only, keeping all combinations:

| Host | Alignment + fusion / fusion | Generic + fusion / fusion | All three / fusion |
|---|---:|---:|---:|
| Node | 0.9713 | 0.9813 | 0.9859 |
| Chromium | 1.0031 | 0.9841 | 0.9952 |
| Firefox | 0.9981 | 1.0207 | 0.9988 |
| WebKit | 1.0399 | 0.9834 | 0.9862 |

All eight VM/shared profiles also retain their own-build ordinary FILE ratios:

| Profile / ordinary | Node | Chromium | Firefox | WebKit |
|---|---:|---:|---:|---:|
| Exact outlined | 2.3511 | 1.2915 | 1.2551 | 1.0037 |
| Alignment outlined | 2.7267 | 1.3129 | 1.2476 | 1.0128 |
| Generic outlined | 1.7367 | 1.2727 | 1.2419 | 1.0224 |
| Both outlined | 1.6365 | 1.2549 | 1.2588 | 1.0435 |
| Exact fused | 1.5643 | 1.1362 | 1.1245 | 1.0669 |
| Alignment fused | 1.5194 | 1.1397 | 1.1224 | 1.1095 |
| Generic fused | 1.5350 | 1.1182 | 1.1478 | 1.0492 |
| Both fused | 1.5423 | 1.1307 | 1.1232 | 1.0523 |

Ordinary means untranslated Wasm on the same engine. These ratios include
shared-versus-FILE OPcache effects and are not pure address-translation tax.
Versions: Node24.15.0, Chromium153.0.8010.12, Firefox155.0, WebKit26.6.
Ordinary page bracket max/min ranges are1.074–1.211Node,
1.088–1.212Chromium,1.001–1.151Firefox and1.033–1.119WebKit; there is no
quiet-machine claim. Node one-minute load-before spans8.69–53.39, and apparent
gains reverse: generic outlined0.4728/1.1540, both outlined0.3970/1.2203,
fusion0.4115/1.0758and all-three0.3596/1.1966. Alignment alone is adverse in
both Node cohorts1.1439/1.1758; all individual pages/cohorts remain retained.
Do not select Node's favorable aggregate or ascribe causality to load alone.

Chromium fusion0.9014/0.8587and Firefox0.8982/0.8938are favorable in both
orders and all pages; WebKit1.0567/1.0693is adverse in both orders/all pages.
All-three versus fusion is near neutral/mixed on Chromium1.0012/0.9892and
Firefox1.0150/0.9829. Generic + fusion has a small WebKit increment
0.9830/0.9837but remains slower than outlined, and Firefox reverses
1.0644/0.9789. These small policy effects and control drift support no new
universal preset. Generic outlined has no consistent large cold first-page
benefit either: Node9,188/8,176ms versus baseline8,849/8,131;
Chromium5,894/5,865versus5,899/5,974; Firefox6,331/6,312versus6,447/6,439;
WebKit5,319/5,588versus5,411/5,372. Listener times, every cold value, warm
round, load and allocation sample remain in raw results.

Decision: retain both policies and their code-budget/profile-sensitive variants,
but do not promote them from wrapper-count reductions or these warm timings.
Small fusion repeats a useful Chromium/Firefox signal and a WebKit regression;
Node needs a separate quiet matched replication before a new ranking. The
survey continues broadly rather than tuning another offset threshold now.

Retained next hypotheses, unimplemented/unmeasured in phase53:

- VM-07/08/09: identify actual fork-generated save-state/scratch sites before
  testing a span/affine binding. Current frame-storage source distinguishes
  scratch scalars, Wasm locals and local/global/buffer frame addresses. Bind the
  emitter to the artifact and count reached sites honestly; the prior0.54%C-frame
  origin and40.9%affine-window observations do not characterize generated state.
- VM-08/09: measure genuinely constant effective virtual addresses and linked
  data provenance separately from dynamic pointers with large memarg offsets.
  A constant virtual address still needs root/mapping/permission/alias proofs;
  canonical stored pointers and child/resume rebinding must survive.
- CC-05: prototype standard-Wasm explicit-tail-call PHP dispatch. Retained source
  gates upstream TAILCALL on musttail/preserve_none/Clang/named CPU architectures;
  tiny tail-call admission does not prove PHP/fork/OPcache compatibility. Do not
  spoof CPU/Linux or unsupported calling-convention support.
- CC-01/04: Clang-Os/-Oz, no-unroll/inlining-budget choices and their generated
  fork-state costs remain distinct from already-tested post-Wasm-Os/O3/LTO/PGO.
  First inspect actual code/frame shapes, then admit and time matched artifacts.
- RT-01: worker cancellation/replacement, root-generation reuse, retirement,
  private/shared aliases and byte-copy compatibility. The fixed-pool memory
  result proves none of indefinite stability, lower RSS or retirement safety.
  Copy-on-write private backing is another hypothesis: measure pages dirtied,
  cover every scalar/SIMD/atomic/bulk/syscall-output write path, preserve
  object-level aliases and shared mappings. It targets fork/replacement copying;
  no warmed fixed-worker translation saving follows automatically.

Evidence is retained under `.context/common-memory-survey-20261111/phase53/`:
all48translated artifacts, gates, ordinary-cache proof,80timing parents,
analysis/review tables, exact source/frozen references and owned terminal job
receipts. The collector roots are `common-memory-wrapper-{variants,checks,
wordpress-checks,timing,timing-analysis}-1`; cache proof is
`common-memory-wordpress-cache-proof-1`. Final identity/syntax/whitespace checks
verify321frozen inputs and four original baseline byte identities. The first
final-check driver used the wrong parent path for backend-specific admission
manifests and exited1; its source/log/failure receipt remain, and the corrected
driver passes in a fresh output directory without rerunning timings.
All prior negative/failed/inconclusive
experiments remain. These private research screens do not establish canonical
builds, full-platform benchmarks, conformance, ABI or browser-memory acceptance.

### VM-08/09/10: actual constant-address coverage and pipeline shapes (phase 54)

November12: a new opt-in `constants` analyzer view and `--constant-sites`
diagnostic count genuinely constant effective virtual addresses, rather than
treating a large memarg offset as constant pointer provenance. The view follows
modular i32 expressions and straight-line local constants. Local overwrites,
control joins and loop-carried updates conservatively discard knowledge;
globals, loaded pointers and call results stay unknown. Wasm's unsigned memarg
addition remains separate from i32 producer wrapping. The native/outlined join
validates every original function's complete memarg count and operation order,
with external artifact hashes supplying source binding. No translation is
removed. Default origin behavior is unchanged and its prior canary reproduces
byte for byte. New classes occupy208–215with version3originSites metadata.

The eight classes are constant attempts, valid non-atomic loads, valid
non-atomic stores, valid atomics, intrinsic memory32 overflow attempts,
single-page constants, zero-base large-offset constants, and initial active
literal-data containment. They overlap; the load/store/atomic/overflow classes
partition the constant union. A constant VA is not a process-independent
physical address or permission/lifetime proof. Initial-data membership is a
byte-range shape, not ownership or immutability.

The26analyzer tests and15diagnostic tests pass, including eight new producer
tests and three new class/join tests. Four-host mechanism cases pass33checks
each (132total), covering exact class counts, full category/function accounting,
64-bit counters, scattered/denied split accesses, unsigned overflow, local
control joins, independent fork counters, distinct fork-private bytes for the
same constant VA and live permission changes. Mismatched-native and overwrite
negatives reject without output. Original code/checks remain in the diagnostic.

One real WordPress census per host uses the same CALL O2/small-fused FPM,
pregrown diagnostic host, cache-empty image`cfbd0ed8790725d01f5912bbd908633c0166b86204e55feab3d877fd740244d6`,
SQLite/shared OPcache/timestamps off, two warmup rounds then four mixed
home/article/admin/posts pages. All app/content/login/two-worker/cache/resource/
teardown gates pass. Counters bracket the final four pages, before later status
requests. Individual values are atomic; snapshots are not a globally atomic
service transaction and can include neighboring request cleanup or maintenance.
Per-root accounting remains retained. Diagnostic elapsed times are not latency
evidence, and no ordinary-versus-VM speed comparison is claimed here.

Static prepared FPM has36,609recognized constant sites/904,942memarg sites
(4.0455%), comprising28,071non-atomic loads/8,087stores/451atomics and no
intrinsic overflow sites. There are4,719distinct effective starts across35VA
pages and6,298functions. One static constant site crosses a page. These static
address/page/function counts are not a reached-address distribution.

Reached fractions of all attempted guest dispatches, including bulk helpers
in the denominator:

| Host | Total attempts | Constant union | Loads | Stores | Atomics | Single-page constants |
|---|---:|---:|---:|---:|---:|---:|
| Node | 378,247,475 | 5.3418% | 3.0257% | 1.2057% | 1.1104% | 5.3418% |
| Chromium | 378,250,770 | 5.3418% | 3.0257% | 1.2057% | 1.1104% | 5.3418% |
| Firefox | 378,260,469 | 5.3418% | 3.0258% | 1.2057% | 1.1103% | 5.3418% |
| WebKit | 378,252,212 | 5.3418% | 3.0257% | 1.2057% | 1.1104% | 5.3418% |

Every reached constant range fits one page; no intrinsic-overflow or zero-base
large-offset constant attempt is observed. Constant atomics contribute about
4.2million attempts per host,20.3456–20.3458%of all atomic dispatches. Required
atomic payload reads cannot be cached or eliminated on that basis. The third
root also executes1,227–3,681dispatches; it is retained in totals rather than
silently discarded. Both responding FPM worker PIDs contribute nonzero counts.
The small extra activity is consistent with FPM-parent maintenance, but the
counter record alone is not a complete process-role ledger.

The active-data classifier is unavailable for this binary. All three data
segments, totaling16,193,568bytes, are passive in both the retained raw-linked
and prepared PHP artifacts. Thus its zero is not evidence of no linked-data
traffic. Current prepared metadata has fork capability/layout/resume catalogs,
but no emitted instruction-origin map. None of these counts attributes traffic
to generated fork-save/scratch code. The older0.54%C-frame-origin and40.9%affine
observations remain separate; unknown globals/call results/loaded pointers and
discarded join facts may hide further constant or stable-span opportunities.

Source-shape review also compares linked and prepared code. A separate current
pinned Binaryen126`-O2` reconstruction supplies an intermediate shape:

| Stage | Defined functions | Function-body bytes | Largest body |
|---|---:|---:|---:|
| Raw linked PHP | 31,278 | 11,196,399 | 153,116 |
| Reconstructed pre-fork O2 | 27,633 | 9,896,908 | 144,551 |
| Existing prepared PHP | 49,424 | 19,719,458 | 177,517 |

The normal private recipe copies the linked program, runs BinaryenO2, then
normal fork preparation and ABI stamping. The reconstructed intermediate is
not stamped/prepared/executed and has no claimed program compatibility or exact
binding to the existing prepared output. No compiler-fact hash is forged. The
shape difference motivates checking fork-generated code, but is neither
dynamic generated-state coverage nor CPU/engine-code cost. Exact re-preparation
and an honest emitted-origin map are needed before attributing individual
instructions or newly declared functions to a compiler stage.

Retain constant single-page specialization as a VM-06/08/10 hypothesis: fold
proved effective-address, page-offset, overflow and split arithmetic while
retaining the current root's live PTE, logical-range/permission checks and
required atomic payload operation. Check any use of the declared initial
memory bound explicitly; never assume it permits ignoring unmap/mprotect.
This is distinct from caching a physical base across calls/fork, which needs
mapping-lifetime and rebinding proofs. No fast path or speedup was implemented
in phase54. The5.34%attempt frequency is not an upper bound on CPU savings.
Continue independent tail-call/compiler-size/retirement work as well; do not
turn this census into another large threshold-tuning matrix.

Retained failures: first mechanism launch used plain memory.mjs without the
diagnostic adapter and stopped before PHP; corrected fixture uses
accessDiagnosticSource in fresh output roots. First postprocessor assumed only
the two worker roots execute; actual counters show the small third-root
activity. Its source/log/failure receipt remain; corrected validation requires
exactly three active roots, both status PIDs and the extra root, retaining all
contributions. No application run or data was rerun/discarded for that fix.

Evidence roots: `common-memory-constant-{build-tools,artifacts,profile}-1`,
`common-memory-constant-census-{1,2}`, `common-memory-constant-mechanisms-{1,2}`,
`common-memory-constant-analysis-{1,2}`, `common-memory-constant-data-shapes-1`,
`common-memory-constant-pipeline-shapes-{1,2}` and
`common-memory-constant-preopt-1`; retained under phase54of the existing survey
archive with raw linked/prepared/intermediate identities and actual source.
Production/runtime/SDK/ABI/packages/defaults and the frozen preview are
unchanged. These are private applicability diagnostics, not canonical,
full-platform, conformance, ABI or browser-memory acceptance.


### CC-05 / VM-10: portable PHP tail dispatch and separate compiler feature (phase 55)

November12: this is a different compiler/interpreter family from the recent
address-shape census. Three PHP C builds hold O2, no LTO/PGO, normal declared
dependencies and C++ settings constant: existing CALL, CALL with real
`-mtail-call`, and portable TAILCALL with that feature. Each has outlined and
small-fused virtualization, plus its own ordinary-addressing Wasm control.
No product/default/SDK/ABI change or preview replacement is made.

The private `survey/portable-tailcalls.py` adaptation selects TAILCALL only for
real `__wasm__ && __wasm_tail_call__ && HAVE_MUSTTAIL`. It uses the ordinary
Wasm C calling convention, never defines a CPU architecture, Linux or
`HAVE_PRESERVE_NONE`, and preserves required `musttail` sites. Upstream's
CALL-specialized generated headers already contain both tail handlers and the
ordinary single-step handler table. The port scopes/restores the tail macros,
exposes the correct getter interfaces, separates ordinary user-opcode
redispatch from tail dispatch, and declares the single-step local. Both table
interfaces are retained; weakening musttail to hide signature errors is refused.

Three real executor-TU admissions succeed: CALL+feature has1,234functions/
476,319body bytes and75direct/1indirect tail transfers; portable+feature has
2,301/930,771 and580/1,884; portable without the real feature selects CALL and
has1,234/476,331 with no tail transfers. These object counts are not complete
PHP runtime or speed evidence. Initial attempts fail for missing getters,
leaked macros/handler-signature mismatches, then an undeclared single-step
handler; source versions and errors remain. Builder negative options reject
before creating output. Two mistaken CLI starts after a failed editing command
stop at unknown options before compilation; both failures remain.

The two complete PHP builds finish through the normal SDK/recipe, private
sysroot, Binaryen O2, normal fork preparation and ABI stamping. Post-O2 compiler
facts correctly report a code-hash mismatch and use the bounded native
baseline; no facts hash is overridden. Final prepared FPM bytes are37,003,204
(CALL),36,895,645(CALL+feature),37,701,221(portable TAILCALL); function counts
49,424/48,718/50,609 and body bytes19,719,458/19,622,549/20,393,648. Portable adds
805,576file bytes to feature-only. Those are actual final stamped artifacts,
not the intermediate files copied before stamping. Four old CALL CLI/FPM
translation hashes reproduce exactly with the current rebuilt translator.

Separate test-only CLI relinks exercise actual `zend_vm_kind`, real NOP
single-step dispatch, user-opcode registration/redispatch/restoration and a
direct tail-chain sentinel. All24parents pass: three C builds x ordinary/VM
x Node/Chromium/Firefox/WebKit; actual VM kinds are1/1/5. These extra C probes
are absent from performance artifacts, whose hashes are checked unchanged.
The first test-only link omitted the normal private C++ sysroot and fails to
find `-lstdc++`; the corrected relink uses the existing declared private
sysroot, without editing shared SDK state. That failure remains.

All72separate CLI/FPM parents pass on the four hosts: six VM profiles plus
three own-build ordinary controls, each CLI/FPM. CLI includes recursive real
PHP fork, cyclic/private objects, closures, generators, exceptions and
wait/reap. Shared FPM verifies real OPcache publication, invalidation,
recompilation, worker replacement and private request state. Small ordinary
FILE requests do not establish WordPress cache compatibility.

That larger gate catches a real negative: ordinary portable TAILCALL on Node
fails WordPress readiness, repeatedly exhausting the Wasm call stack. FPM
replaces the failed workers and eventually hits the readiness deadline;
raw diagnostic records, status139, stacks and logs remain. The repeated frame
is prepared function29,230at0x140573b: a generated transport's regular
`call_indirect`, followed by the unwind-state check/throw. Source review finds
that tail routes reuse this ordinary transport to preserve process resume and
unwind semantics. This is a concrete instrumentation hypothesis, not a Node
engine-defect claim. Replacing that call with a tail transfer would skip the
post-call state check; no such shortcut or package workaround is applied.
Portable WordPress on browsers/MariaDB and portable latency remain unrun.

Three reduced C cases are useful counterevidence: the simple single-handler
loop succeeds through100,000dispatches on Node under normal fork preparation,
including a statically reachable but unexecuted fork branch. Pre-O2 and a
multiple-handler/exported-entry variant also succeed. Their validators expected
stack failure and therefore fail the diagnostic; the retained guest results
are code0/checksum300000/no host diagnostics. This rejects the broad inference
that any fork-capable indirect tail loop necessarily overflows. The exact PHP
routing shape remains to be isolated. Earlier direct-instantiation reductions
stop on missing real fork-state imports before executing the prepared case;
no inert replacement state owner is used to make them pass. A disassembly
attempt also records an unsupported `wasm-dis --enable-all` option.

The admitted subset is CALL and CALL+feature. Eight separate own-build
ordinary WordPress cache proofs pass on all4hosts:565generated files,
24,456,992bytes each, two-worker reuse across edits with timestamps off and
explicit file-cache removal before version2. The source image starts cache
empty, not with the old1,500-file corpus. All48WordPress application parents
also pass (four VM modes plus two ordinary controls x SQLite/MariaDB x four
hosts),192mixed page requests, login/admin/REST/content, correct cache mode,
two workers, artifact/image/kernel identities, resources and teardown. An
independent inventory audit checks all48raw receipts. The initial all-mode
application job stops at the portable Node failure; it is not a passing gate.
The unique Node output key includes cache label, corrected before that driver
first executed, so VM and ordinary receipts cannot overwrite one another.

The complete planned portable factorial is retained but not executed. The
admitted timing plan keeps two compiler blocks, each with own ordinary FILE
opening/closing brackets and outlined/fused shared modes. The second cohort
reverses compiler and VM order. This is a SQLite first screen, two warmup and
five measured four-page rounds per parent,64parents/1,280measured pages plus
512warmup pages. Its results and limitations follow below.
Ordinary means untranslated Wasm, not machine-native PHP; shared/ordinary
ratios include OPcache cache-mode effects. No full-platform, conformance,
canonical-image, memory-suite or optimal-compiler claim is made.


Next breadth screens (hypotheses, not measured benefits):

| Direction | Bounded next question | Acceptance before a larger matrix |
|---|---|---|
| Constant-site arithmetic (VM-06/08/10) | Can known VA/page/offset remove arithmetic and split checks while retaining current-root live PTE/logical/permission checks and atomic payload access? | Mechanisms for remap/protection/fork/split/overflow, actual admitted-site use, then one individual/fusion combined app screen. The5.34%attempt share is not CPU saving; JIT may already fold part of this work |
| Compiler size (CC-01/04/05) | Do real SDK Os/Oz executor objects reduce the generated-code footprint enough to justify full PHP builds? | Small real-source admission/size screen first; no inference from file size to runtime speed or automatic replacement of O2 |
| Repeated worker retirement (RT-01) | Does mapped-payload reuse remain correct across repeated real FPM worker generations, retaining shared OPcache while releasing private roots? | Content/two-worker/publication/invalidation/replacement and exact root/extent accounting before latency or RSS claims. Prior fixed-pool512-page result does not prove retirement |
| Fork transport shape (CC-05) | Which actual PHP tail route accumulates regular transport frames, given simple C counterexamples? | A bounded PHP-level loop/reduced generated-Wasm example, then a protocol-preserving general fix and full fork regression gates; no package-only skipped checks |

### CC-05 / VM-10: admitted compiler-feature and fusion timings (phase55)

PHP O2/helper O2: CALL versus CALL with C tail-call feature each outlined/fused; portable dispatch excluded after real WordPress stack exhaustion. Own-build ordinary FILE brackets around each compiler block, two opposite compiler/VM parent orders, cache-empty SQLite source image, two warmup/five measured four-page rounds. Shared/ordinary includes cache-mode effects, not pure translation tax; first screen, no quiet-machine or general-platform claim.

All64fresh parents and1,280measured pages pass the strict artifact/content/cache/two-worker/resource/teardown/settings audit;512warmup pages remain separate. No compiler, profile collector or archive compressor owned by this investigation overlaps timing. Machine load is retained; no quiet-machine or outlier-removal claim. Portable dispatch remains excluded after its failed WordPress gate.

Each cell is the geometric mean of four page-median ratios across two opposite-order cohorts. Lower is shorter; these are descriptive first-screen ratios, not confidence intervals, throughput or CPU.

| Host | C feature / CALL | Fusion / CALL | Fusion added to feature | Feature added to fusion | Feature+fusion / CALL |
|---|---:|---:|---:|---:|---:|
| node | 1.0009 | 0.8701 | 0.8786 | 1.0108 | 0.8795 |
| chromium | 0.9914 | 0.8904 | 0.9096 | 1.0128 | 0.9018 |
| firefox | 0.6251 | 0.5608 | 1.1781 | 1.3132 | 0.7365 |
| webkit | 0.9917 | 1.0637 | 1.0467 | 0.9759 | 1.0381 |

Both cohort values for the three standalone/combined comparisons:

| Host | Feature first / reverse | Fusion first / reverse | Combined first / reverse |
|---|---:|---:|---:|
| node | 1.0045 / 0.9974 | 0.8715 / 0.8686 | 0.8755 / 0.8835 |
| chromium | 0.9822 / 1.0008 | 0.8780 / 0.9030 | 0.8880 / 0.9159 |
| firefox | 1.0276 / 0.3803 | 0.8944 / 0.3517 | 0.8991 / 0.6032 |
| webkit | 0.9560 / 1.0288 | 1.0767 / 1.0509 | 0.9981 / 1.0797 |

Ordinary means untranslated Wasm. Shared/ordinary ratios below use each compiler's own FILE-cache bracket in the same cohort/block and include cache-mode effects; they are not a pure translation tax.

| Host | CALL outlined / ordinary | CALL fusion / ordinary | Feature outlined / own ordinary | Feature fusion / own ordinary | Ordinary feature / CALL | Worst per-page bracket drift |
|---|---:|---:|---:|---:|---:|---:|
| node | 1.4414 | 1.2541 | 1.4339 | 1.2599 | 1.0062 | 1.0176 |
| chromium | 1.1893 | 1.0590 | 1.1561 | 1.0516 | 1.0199 | 1.1096 |
| firefox | 1.9623 | 1.1005 | 1.2433 | 1.4648 | 0.9866 | 1.1973 |
| webkit | 1.0127 | 1.0772 | 0.9482 | 0.9925 | 1.0591 | 1.0619 |

All page medians, cohort ratios, own ordinary brackets, loads, runtime versions, cold listener/home timings, resources and raw identities remain in `common-memory-tailcall-timing-2` and `common-memory-tailcall-timing-analysis-2`.
Do not infer a universal compiler preset from a single SQLite first screen; MariaDB application gates are correctness evidence, not a MariaDB latency measurement. Compare page/order/control behavior before selecting another replication.

Interpretation: the feature-only Node ratio1.0009 and opposite-order
1.0045/0.9974 provide no latency benefit in this screen. Chromium0.9914 and
WebKit0.9917 also reverse direction between cohorts. Added to existing fusion,
the feature costs1.0108Node/1.0128Chromium; WebKit's0.9759 aggregate reverses
0.9270/1.0274. There is no consistent feature increment over fusion to promote.
The option remains retained for other workloads/code-size effects.

Fusion alone again shortens Node(0.8701) and Chromium(0.8904) warm page medians,
with both orders favorable; WebKit1.0637 has both orders adverse. Adding the
feature changes those combined ratios to0.8795/0.9018/1.0381. These bounded
results do not justify enabling all flags. WebKit's feature ordinary control
is1.0591of CALL, so its better shared/own-ordinary ratio is not evidence that
its VM request became faster by that amount.

Firefox is inconclusive. Feature-only first/reverse1.0276/0.3803 and
feature-added-to-fusion1.0053/1.7153 disagree sharply; do not report0.6251as a
replicated feature speedup. One-minute system load across Firefox changes
from about2.1to34.6, with up to19.7%per-page native bracket drift. WebKit inherits
load34.6before it falls as low as5.36; its ordinary drift reaches6.2%.
Node/Chromium load ranges are about1.62–2.64/1.98–2.63, with maximum native
bracket drift1.8%/11.0%. Load is context, not a proved explanation of any
individual outlier or engine defect. All original slow parents remain.


### CC-05: minimal pure-PHP loop isolates the dispatch boundary (phase55)

After timing, a100,000-iteration PHP loop runs with `php -n -r`, no WordPress,
database, OPcache configuration or actual fork. It sums `($i &255)` modulo
65,536 and must print checksum28,336. Three real performance CLI builds each
run under ordinary addressing and fused virtualization on all4hosts:
24fresh parents, with actual source/artifact/kernel/image identities frozen.

All16CALL/feature controls complete with code0, the exact checksum and empty
host diagnostics. All8portable TAILCALL cases exhaust the stack: Node,
Chromium and WebKit report139; Firefox reports-1with `too much recursion`.
Both addressing modes fail on every host. This establishes a much smaller
PHP-level reproduction and shows that translation/WordPress/cache setup is
not required. The exact original-to-generated routing shape and a protocol-safe
fix remain open; the successful C counterexamples still constrain generality.
No browser-engine defect is inferred, no fork actually occurs in the loop,
and these diagnostic outcomes are not latency measurements or candidate
acceptance. The failure is retained instead of removing its checks.

Two collector failures remain explicit. The first browser launch omitted the
required `KANDELO_COMMON_MEMORY_ARTIFACTS` and stops before any browser guest;
all six completed Node cases remain. The first Firefox portable-native guest
then exposes an over-specific validator expecting139, despite its real-1and
recursion diagnostic. Its failed assertion, raw status, stack and teardown
remain untouched. Only the seven not-yet-run cases are collected afterward,
using a nonzero-exit-plus-stack-diagnostic classifier. Independent analysis
classifies all24raw outcomes and retains that original assertion failure;
no guest is retried to change the outcome.

The retained roots are `common-memory-tailcall-dispatch-depth-1`,
`common-memory-tailcall-dispatch-depth-browser-2`,
`common-memory-tailcall-dispatch-depth-remaining-3` and
`common-memory-tailcall-dispatch-depth-analysis-1`. Small C non-reproductions
and incomplete direct-instantiation attempts remain alongside them. The
experimental image for WordPress gates/timings is the existing cache-empty
partial WordPress image at
`.scratch/common-memory-wordpress-empty-cache-2/wordpress.vfs.zst`; CLI gates
use the existing partial shell image. No canonical product or full-platform
conformance/browser-memory suite was rebuilt or claimed for this research.


### Breadth round: compiler size, constant-site arithmetic and worker lifetime (phase56)

November12: three independent bounded screens follow the completed dispatch
screen. No production/runtime/SDK/ABI/default or preview changes. Real PHP
compiler units, a constant-address mechanism/cost model, and actual repeated
FPM worker replacement answer different questions; none is used to imply that
the whole optimization survey or general platform acceptance is complete.

#### CC-01/04/05: real compiler-size admission before full rebuilds

The exact normal SDK compile vectors are replayed for four configured CALL
translation units. Only C optimization changes: O2/O3/Os/Oz; no tail-call
feature, LTO/PGO, architecture/Linux macro or weakened diagnostics. Actual
preprocessor output verifies CALL selection, real target feature absence and
size macros. Declared cached dependency headers stay under the shared GC lock;
private outputs preserve every command, object, compiler version, diagnostic
and disassembly. All16objects compile. Existing arithmetic-macro redefinition
warnings remain. Compile wall times are collection context, not a controlled
compile-speed benchmark. No linked/prepared PHP or full-program shrinkage is
claimed from these objects.

| Unit | O2 bytes | Os/O2 | Oz/O2 | O3/O2 | Oz largest/O2 largest |
|---|---:|---:|---:|---:|---:|
| Zend/zend_execute.c | 476331 | 0.9812 | 0.9662 | 1.0021 | 0.9705 |
| Zend/zend_execute_API.c | 19808 | 0.9186 | 0.9025 | 1.0000 | 0.9994 |
| Zend/zend_compile.c | 139486 | 0.7484 | 0.6700 | 1.0541 | 1.2823 |
| ext/opcache/zend_file_cache.c | 37112 | 0.8492 | 0.8628 | 1.0002 | 1.1920 |


These are Wasm function-body bytes (excluding headers/data/debug), not engine
executable memory or CPU. Four-unit totals are unlinked/unweighted sums, not a
PHP binary prediction. Oz reduces interpreter bodies by3.38%, Os by1.88%; the
compiler unit changes much more (Oz33.0%/Os25.2%). But Oz's largest compiler
body grows10,286→13,190(+28.2%) and file-cache largest8,771→10,455(+19.2%). Os
reduces those maxima to7,751/8,463. O3 leaves execute_API code byte-identical
to O2 and grows compiler-unit bodies5.41%. Keep both size options, especially
per-unit/cold-load possibilities; neither is a measured latency improvement or
an optimal compiler configuration. A full build needs runtime/fork/cache and
application controls before any adoption.

A separate historical-object audit finds three of four replayed O2 code sections
byte-identical to the retained earlier build. execute_API differs in immediate
data-address operands, despite the same8,217disassembly instruction lines.
No four-object identity is claimed or forced; all size comparisons use the
fresh O2 control compiled in the same private workspace as Os/Oz/O3. Historical
objects, current objects and the disassembly comparison are retained.

#### VM-06/08/10: fixed-VA guard specialization cost model

A manually written helper specializes one proved shape, VA8192/width4. It
folds effective-address/width/overflow/alignment/split/page-index arithmetic,
while every access still reads the current root, current logical page count,
live PTE, required permissions and physical backing, then performs the actual
load/store/atomic operation. A logical page-count bound is exact for this
known single-page range. An imported mutable root Global is the same actual
Global exported by a normally translated context. No physical pointer or
payload is cached across calls. The helper is not an admitted guest artifact
and carries no forged program/fork metadata; no automatic recognition or
application translation pass is implemented.

The ordinary WAT source, outlined translation, small-scalar fusion, and
scalar+aligned-atomic fusion use the current translator and same helper O2.
The manually specialized helper uses the same root/PTE/payload as a translated
context. Ordinary Wasm uses identical source and an independent shared Memory
with the same16MiB initial/maximum budget. Each host runs in one fresh disposable
Worker; persistent browser code receives only copied scalar results. No memory
growth is needed. Mechanisms cover75checks/host (300total): readonly/writeonly
and denied writes without payload changes, atomics requiring both rights,
missing/zero/bad physical PTEs, current logical bound/null root, remapping,
fork-private bytes, live shared payload/atomic visibility and root rebinding.
These tests do not implement or prove all widths, SIMD, split/overflow sites,
concurrent remapping or compiler constant-producer recognition.

The separate timing stage runs4million iterations per case. Scalar RMW and
atomic-add loops change the payload each iteration; resets/setup are outside
the timer and guards/payload operations inside. Every first invocation and
sample verifies the exact modulo-i32 checksum. Ten cases (five modes x two
operations), two reversed sample orders and seven samples/order produce140
samples/host,560total, plus retained first-invocation timings. Reversed samples
in one Worker are not independent-parent replication. All four-host mechanism
and timing protocols pass. Only this synthetic operation cost is measured.

| Host | Outlined RMW | Scalar RMW | Fused RMW | Constant RMW | Outlined atomic | Fused atomic | Constant atomic |
|---|---:|---:|---:|---:|---:|---:|---:|
| node | 5.0086 | 3.7288 | 3.7131 | 0.9864 | 1.2145 | 1.1163 | 0.9984 |
| chromium | 4.3573 | 3.1868 | 3.1831 | 0.8377 | 1.2833 | 1.1472 | 1.0274 |
| firefox | 11.7112 | 10.6257 | 10.6400 | 2.1473 | 1.9343 | 1.0429 | 1.0400 |
| webkit | 3.5801 | 2.8021 | 2.8021 | 0.5455 | 1.1443 | 1.0508 | 1.0033 |


Constant/fused scalar cohort ratios are0.2733/0.2582Node,
0.2629/0.2634Chromium,0.2091/0.1948Firefox and0.1947/0.1947WebKit. Atomic
constant/fused ratios are0.8903/0.8985,0.8958/0.8954,0.9918/1.0027and
0.9563/0.9533respectively. Thus the new scalar shape has a strong cost-model
signal, while the atomic increment is modest or absent on Firefox. Do not
translate these into a WordPress speedup: phase54recognizes5.34%of attempted
WordPress dispatches, not CPU share, and this model covers only one width/VA.

Some manually specialized scalar results are below the ordinary control. That
is not a negative cost of address translation. Function/helper/import layout
and JIT folding differ, and there is no per-instruction CPU attribution.
Node's ordinary scalar median changes2.455→3.488ms between cohorts; its
constant/native ratios reverse1.2094/0.8045. Constant/fused ratios remain
retained separately. Timer steps are~0.000041msNode,0.005msChromium and0.02ms
Firefox/WebKit; scalar sample medians are at least~1.42ms. The peer job snapshot
has no registered active jobs, but system load/CPU scheduling was not controlled
or profiled and no quiet-machine claim is made. No fresh-parent uncertainty or
PHP benefit is inferred. The next justified test is actual site selection and
application code-size/latency gates, not repeated synthetic threshold tuning.

#### RT-01: repeated actual FPM worker replacement

Eight fresh FPM parents compare the existing sparse/1MiB-scratch control and
unmapped-payload-reuse profiles on Node/Chromium/Firefox/WebKit. Both use the
same ordinary-O2/CALL/small-fused PHP-FPM artifact and unchanged512MiB physical
ceiling. This is shared OPcache on the existing partial shell image, not a
WordPress or latency run. Real requests verify initial publication and
invalidation/recompilation of a cached pointer graph before replacements.

A real held-request VFS barrier keeps one FPM worker busy while the other gets
SIGTERM. Each generation observes that exact victim's exit event and a new
child of the same FPM master; the replacement serves the retained shared-cache
entry without a miss. Releasing the held worker proves both current workers
still see version2/answer500500/private request state1. Six generations per
case mean48actual replacements. All8cases pass content/cache/private-state/
process-event gates; the collector retains every response and exit status,
not a simulated replacement. Browser destruction is recorded; Node commands
return0after the source's awaited host.destroy path. Neither observation is
proof of physical-memory reclamation or a cross-browser termination fence.

Logical allocator high-water curves are identical across the four hosts:

| Profile | Before replacement MiB | After6MiB | MiB per replacement | Sampled live roots | Retained reuse roots |
|---|---:|---:|---:|---:|---:|
| Control |106.6875|296.4375|31.625|3throughout|unavailable|
| Mapped-payload reuse |102.5|290.75|31.375|3throughout|3→9|

These are exact logical arena allocated bytes, not RSS or currently live
payload. Reuse finishes with eight free pages and zero sampled pending
snapshots. The source intentionally keeps every exited root record pinned;
this experiment does not delete them or infer quiescence from process exit,
WeakRef/GC, elapsed time or low memory. The resource curve establishes that
mapped-page reuse alone does not bound worker-generation growth, even though
it previously keeps fixed-pool WordPress allocation flat through512pages.
Browser/Node reuse counters differ in incidental sweep/root-held work; all
raw counters remain rather than forcing identical internal traces.

Safe private-root/payload/scratch retirement is therefore a distinct practical
optimization boundary. It needs explicit ownership/revocation/retirement proofs,
pending snapshot/cancellation and alias handling, and the appropriate full
memory/lifecycle gates before reuse. No root is freed in this phase. Automatic
pm.max_requests retirement, arbitrary churn, WordPress worker generations,
indefinite service, RSS and latency remain unproved. This is a new observed
limit of the private prototype, not a browser defect or a reason to disable
process lifetime checks.

Evidence roots: `common-memory-php-size-units-1`,
`common-memory-worker-replacement-1`, `common-memory-constant-cost-1`,
`common-memory-constant-cost-{checks,bench}-1` and
`common-memory-phase56-analysis-1`; retained with actual source, modules,
objects, controls, commands and all raw results under phase56of the survey
archive. All three bounded screens made progress; none promotes a default or
claims full ABI, conformance, canonical product or browser-memory acceptance.

### VM-08/09/10: automatic constant-address specialization (phase 57)

This follow-up implements the opportunity found in phase 54 and cost-modeled
in phase 56. No production/runtime/SDK/registry/ABI/default or interactive
preview change. The same O2 CALL PHP and O2 helper artifacts are translated
as outlined, small-offset scalar-fused, constant-outlined and constant-fused.
The application factorial does not enable the atomic-fusion option; that
combination is exercised separately in mechanism tests.

#### Soundness and applicability

The producer analysis formerly propagated initial loop parameters as facts
inside the loop, although a backedge can replace them. A regression fails
before the fix; version 2 treats those values as unknown. Loop-written local
facts are invalidated, conservative control joins remain, and fresh local
constant definitions inside loops can still be recognized. Constant-only
analysis now accepts modules without a C stack marker; default origin
analysis keeps its original contract.

The translator computes its plan from validated original bytes and binds
function/operator ordinal, instruction, width, memarg offset, write and
atomic classification. It specializes the geometry of a constant virtual
address, not ownership of physical backing. Each access still checks current
root, current logical pages, current PTE and rights/nonzero backing, then
executes the original load/store/SIMD/atomic instruction. Original operand
production stays in order. There is no retained physical pointer or payload,
initial-data immutability assumption or mapping-lifetime grant. Exact 4 GiB
logical bounds avoid narrowing the endpoint. Unknown/split/overflow/unaligned
atomic sites fall back to existing translation. Other guard/cache/wrapper-key
experiments are rejected with this option in the first implementation.

All 36,608 selected PHP-FPM sites match the full eligible historical identity,
not just its count. Of 36,609 recognized sites, one split-page operation is
ineligible. This preserves the phase 54applicability evidence of 5.3418% of
observed WordPress access attempts, including ~20.35% of atomic dispatches;
it remains an attempt frequency, not CPU share or a speedup forecast.

| PHP-FPM profile | Module bytes | Extra bytes vs same fusion control |
|---|---:|---:|
| outlined | 38072786 | 0 |
| scalar-fused | 38104734 | 0 |
| constant-outlined | 38572632 | 499846 |
| constant-fused | 38604580 | 499846 |

The pass creates 6,219 constant wrappers and 13,069 total, versus 6,857 baseline
wrappers. It can reduce per-access arithmetic at the cost of more generated
functions and ~1.31% module growth. All 4 baseline CLI/FPM outputs are exactly
byte-identical to phase 55's corresponding CALL outputs. Native means the
same ordinary untranslated Wasm, never machine-native PHP.

#### Correctness gates

- 29 producer,10 instrument-main,4 wrapper-key and15 diagnostic-consumer unit checks
  pass; formatting checks pass.
- 940 mechanism assertions per host,3,760 total, cover all scalar widths and
  signed loads, SIMD/lane operations, atomic loads/stores/RMW/cmpxchg/wait/
  notify, operand/fault order, permission denial, missing/invalid backing,
  live remapping, fork-private/shared payload, root rebinding, loop and join
  fallbacks, split-page/no-partial-write, unsigned overflow, unaligned
  atomics and the exact 4 GiB logical endpoint. Fresh disposable Workers own
  every guest memory; persistent parents receive copied results.
- 40 fresh real PHP parents cover all 4 VM profiles plus same-build ordinary
  CLI/FPM on all 4 hosts: recursive fork/private-state checks and shared
  OPcache publication/invalidation/actual worker replacement.
- 40 fresh WordPress parents cover all 4 VM profiles plus same-build ordinary
  FILE control on both SQLite/MariaDB/all 4 hosts,160 measured page requests.
  Independent inventory/artifact/content/cache/two-worker/resource/teardown
  audits pass. The empty-cache source image is the same SHA
  `cfbd0ed8790725d01f5912bbd908633c0166b86204e55feab3d877fd740244d6`;
  unchanged ordinary CALL bytes reuse phase 55's all-host FILE-generation/
  reuse proof. Shared mode explicitly disables FILE cache.
- 9 invalid CLI combinations reject before writing output;2 conditional-commit
  combinations validate. No invalid-option fallback is hidden.

The first Rust compile failed because an already moved operator was reused
for wrapper keys; cloning before encoding fixes it. The first independent
runtime audit incorrectly required two worker PIDs in the initial shared
smoke batch; the dedicated OPcache requests establish both workers. The
corrected audit includes those requests and validates all 40 cases. Both raw
failures and sources are retained; no guest rerun selects a favorable case.

#### Timestamp validation retained

The user explicitly requested continuing with timestamp validation potentially
retained. The first validation-off timing batch was therefore interrupted
through its owned job supervisor (terminal 143/signal 15) after 11 completed
Node parents; the twelfth was in progress. All raw attempts remain, with no
complete-batch receipt or timing ranking. This was a deliberate redirect,
not a guest failure or a favorable-result retry.

Fresh validation-enabled application gates repeat all 40 WordPress cases on
both databases/all four hosts, in addition to the 40 validation-off cases
above. The gate audit binds every app option to enabled validation; the timing audit
also checks recorded PHP INI. The diagnostic below checks the effective value
through `ini_get`, requiring `opcache.validate_timestamps=1`. Another eight fresh diagnostic parents cover
ordinary FILE cache and the combined constant/scalar-fused shared profile on
all four hosts. Real guest file writes change the target mtime from
1600000000 to 1600000060. Both FPM workers must load version 2 immediately
after the edit, before explicit invalidation; then explicit invalidation is
also checked. All pass. Ordinary FILE caches are populated/reused (>50 files),
shared mode leaves no FILE cache files, and actual artifact identities,
content, teardown and frozen inputs pass independent audit. These diagnostics
are separate from latency collection.

A retained follow-up under VM-05/APP-02 is cheaper metadata access/marshalling
with timestamp validation still enabled. First measure authoritative metadata
operations and copied spans, then screen exact-span adapters or redundant
work within a proven no-mutation interval. Any generation-based invalidation
would need correct writes, touch, rename, unlink and alias semantics. No such
optimization is implemented or measured here; neither relaxed freshness nor
immutable-code policy is assumed.

#### Matched SQLite timing

All cases retain `opcache.validate_timestamps=1`. The planned two reverse
VM orders each have ordinary FILE controls before and after, two warmup and
five measured rounds of home/article/admin/posts. The same PHP/helper/compiler
and host profile are used. These are page-median ratios, not throughput, CPU
or a pure translation tax: shared/ordinary also changes the OPcache backend.

The original batch fails on Firefox. Collecting only the previously unattempted
12 WebKit cases and three Firefox controls completes the 48-case inventory:
47 successful parents and one failed parent; 954 successful measured pages
and 384 warmup pages, including 14 measured pages from the failed parent.
The original failure is never rerun or substituted. Independent analysis
verifies the exact inventory, 221 frozen inputs, artifacts, INI, samples,
content/cache/two-worker/resource/teardown evidence, retaining the failed case.
Firefox rankings are withheld. WebKit ratios are descriptive and inconclusive
because its controls and cohort effects vary substantially.

| Host | constants / outlined | scalar fusion / outlined | combined / fusion | combined / constants | combined / outlined |
|---|---:|---:|---:|---:|---:|
| node | 1.0207 | 0.9147 | 1.0284 | 0.9215 | 0.9406 |
| chromium | 0.9977 | 0.9265 | 1.0208 | 0.9480 | 0.9458 |
| firefox | withheld | withheld | withheld | withheld | withheld |
| webkit (inconclusive) | 0.8760 | 0.8813 | 0.9761 | 0.9821 | 0.8603 |

Node scalar fusion improves in both orders (0.9060/0.9234); Chromium also
improves in both (0.9139/0.9393). Constants alone do not improve Node
(1.0349/1.0068), and reverse direction around neutral on Chromium
(0.9864/1.0091). Adding constants to fusion is adverse in aggregate on both,
with a Node order reversal (1.0654/0.9927), so there is no added-speed claim.

WebKit constants/outlined changes from 0.9857 to 0.7785, and fusion/outlined
from 0.9921 to 0.7829. Second-cohort ordinary page-bracket drift is
1.55–1.78x, against 1.02–1.07x in its first cohort. Retain all values; do not
call the 12–14% aggregate a replicated optimization win. Even the smaller
combined/fusion ratio (0.9774/0.9749) needs a cleaner repeat before promotion.

| Host | outlined / ordinary FILE | scalar-fused / ordinary FILE | constants / ordinary FILE | combined / ordinary FILE |
|---|---:|---:|---:|---:|
| node | 2.0377 | 1.8637 | 2.0799 | 1.9167 |
| chromium | 1.6213 | 1.5021 | 1.6175 | 1.5334 |
| firefox | withheld | withheld | withheld | withheld |
| webkit (inconclusive) | 1.4249 | 1.2558 | 1.2483 | 1.2259 |

| Host | largest ordinary page-bracket drift | observed 1-minute load range |
|---|---:|---:|
| node | 1.0853 | 3.58–7.08 |
| chromium | 1.0297 | 4.18–11.52 |
| webkit | 1.7762 | 2.60–17.27 |

Cold listener/first-homepage ratios versus the same outlined VM profile:
these include startup/application work and are not isolated compiler timings.

| Host | profile | listener ratio | first-homepage ratio |
|---|---|---:|---:|
| node | baseline-fused | 0.7265 | 0.8214 |
| node | constant-outlined | 0.7285 | 0.9560 |
| node | constant-fused | 0.7320 | 0.8066 |
| chromium | baseline-fused | 1.0146 | 0.8321 |
| chromium | constant-outlined | 1.0477 | 1.0059 |
| chromium | constant-fused | 1.1163 | 0.8453 |
| webkit | baseline-fused | 0.9457 | 0.7981 |
| webkit | constant-outlined | 1.0048 | 0.9308 |
| webkit | constant-fused | 1.1427 | 0.8440 |

No quiet-machine, confidence-interval, RSS or whole-platform claim. Native
means ordinary untranslated Wasm with FILE OPcache. The roughly 1.86x Node
and 1.50x Chromium fused/ordinary ratios show a material application cost in
this screen, even with shared OPcache. The separate include-heavy fixture
and prior timestamp-off screens answer different workload/policy questions.

The Firefox 155.0 failure is the second constant-outlined cohort, seed 6198.
It completes eight warmup and 14 measured requests. Exact shuffled-prefix
reconstruction identifies the next request as round 3 article `GET /?p=1`.
The response is empty HTTP 504; the fixture calls the host HTTP bridge with
a 120-second request timeout. The outer test later exceeds 320 seconds.
Last recorded allocation is 312,606,720 bytes (~298.13 MiB) against a
536,870,912-byte ceiling, three live roots/one group. This does not establish
capacity as the cause. stderr/host diagnostics are empty; FPM logs only show
normal startup, nginx has no corresponding 504 line, init exit is 137 and
host destruction eventually reports complete. No kernel/process/syscall/PC
snapshot was captured. Origin and root cause remain unresolved; neither an
engine defect nor a transform defect is established. Sustained admission for
the new constant-only profile is therefore open despite the short gates.

Next diagnosis is a separate isolated run with existing process enumeration,
bounded syscall tracing and a long-request snapshot before teardown, alongside
the unchanged outlined control. It is not a retry to replace failed timings.
No such diagnostic rerun, fix or workaround is claimed in this phase.

Raw/analysis evidence: `.context/common-memory-survey-20261111/phase57/`.
Original/continuation plans, controls, cold samples, loads, all page medians,
failure and partial validation-off attempts are retained.

#### Retained constant-wrapper follow-ups

A static follow-up on the actual selected FPM plans finds 4,718 addresses on
35 pages; 36,545 of 36,608 sites have zero memarg offset, with 23 distinct
offsets overall. There are 183 (page, operation, width, static offset) shapes,
or 155 without offset, compared with 6,219 emitted constant wrappers. These
are source-shape counts, not an emitted-wrapper prediction: typed instruction,
lane/atomic immediates and exact geometry still need binding and tests.
Possible later experiments are page-shared wrappers that compute only a low
offset, and profile-guided admission of hot constants. Both aim to retain some
arithmetic saving with less cold code. No implementation or speed benefit is
claimed. The first application's neutral/adverse evidence remains intact.

#### Separate retirement follow-up

A bounded source review identifies stale host wrappers as another root-reuse
owner: VirtualMemory/VirtualBuffer and wire reconstruction retain numeric
root/scratch offsets. An exact terminal worker fence does not alone revoke
those retained host handles or pending snapshot/copy operations. A future
private state machine must bind authority to the exact process generation,
revoke stale handles and handle snapshot cancellation before root/scratch
reuse. A poisoned stale-handle/delayed-operation test is the next mechanism
proposal. No reclamation implementation, RSS saving or speed follows from
this review. Phase 56's replacement-growth result remains unchanged.

These are private research screens using the existing partial shell and
WordPress image. No canonical product, general POSIX/conformance, complete
retirement or whole-platform/browser-memory acceptance is claimed.

### VM-05 / APP-02: retained-validation adapter census and timeout diagnosis (phase 58)

Two bounded investigations follow phase 57. Timestamp validation remains
**enabled**. No production host/kernel/SDK/ABI/default or preview change, no
compiler rebuild or latency recommendation from instrumented runs. The prior
Firefox failure and every earlier neutral/adverse optimization remain evidence.

#### Firefox diagnostic attempt

The unchanged outlined and constant-outlined FPM artifacts each run once in a
fresh Firefox parent with the failing seed 6198, two warmup/five measured rounds,
the same image/profile and the existing 120-second HTTP request timeout. The
private diagnostic attaches the existing syscall subscriber and copied process,
allocation and log snapshots on requests pending for two/ten seconds, HTTP
errors, initialization and before destruction. The outer diagnostic budget is
380 seconds rather than the earlier 320, to allow observation/cleanup; the
request watchdog is unchanged. Every guest memory remains in disposable Workers.

Both diagnostic attempts complete all 28 sampled pages, normal cache/content/
two-worker checks and destruction. The original failure is **not reproduced
under tracing, not fixed**, and is never replaced in the phase 57 timing data.
Tracing/observer RPCs may change scheduling. Pending snapshots in these attempts
are during startup/readiness; no stalled article request is captured. There is
still no process/syscall/PC evidence from the original failed activation.

The constant/outlined attempts receive 84,893/85,139 syscall trace events,
retaining only the last 4,096 each. Stat/fstat/lstat/readlink account for
31.5315%/31.5155% of observed events. Labels come from the actual Kandelo Syscall
enum, not Linux syscall numbers. The existing kernel ring can overwrite events
between drains: these are observed frequencies, not an exact syscall census,
CPU shares or a forecast saving. Real metadata calls are a worthwhile path to
investigate with validation retained, but this attempt establishes no cause for
the old HTTP 504 and makes no engine/transform attribution or workaround.

#### Kernel-realm virtual-view census

The private profile builder adds `--metadata-diagnostics`, instrumenting only
its copied memory adapter. Counters distinguish span attempts, resolved span
runs, typed-element reads/writes, DataView method attempts and bulk read/write
calls. Snapshots contain copied numbers, never guest memory. Scope is the
kernel realm's JS adapter; process-worker counters, native-view operations and
guest Wasm accesses are outside it. Span/DataView units count bytes, resolved
span units count runs; other buckets count calls. Do not sum unlike units.
The diagnostic is separate from timing and may perturb execution.

All six default runtime bundles match before/after adding the option and match
the retained normal pregrown profile byte-for-byte. The original memory adapter
source is unchanged. The instrumented adapter passes the existing scatter,
permission/no-partial-prefix, growth, fork-private/live-shared, wire and mapping
lifecycle checks in a disposable Node Worker; returned counter copies cannot
mutate their owner. Metadata and byte-slice diagnostics are separate profiles
in this first version; no acceptance of untested option combinations follows.

Eight fresh real WordPress SQLite parents cover ordinary FILE and outlined VM
on Node/Chromium/Firefox/WebKit. Each has one warmup/two measured rounds:
96 sampled pages total (32 warmup/64 measured). Observer snapshots bracket
sequential HTTP windows. Independent audit binds the last 12 successful page
windows to exact workload order and response bytes, actual artifacts, image,
recorded INI, cache/two-worker state, empty error streams and destruction.
Node uses seed 6197, browsers 6198; both cases within each host use the same
seed. No cross-host latency or identical-order claim is made.

| Host | span attempts/page | DataView calls/page | typed element calls/page | bulk read+write calls/page | DataView / span attempts |
|---|---:|---:|---:|---:|---:|
| node | 728041.8 | 25583.1 | 681183.1 | 4280.5 | 3.51% |
| chromium | 726521.8 | 25446.6 | 680969.1 | 4269.9 | 3.50% |
| firefox | 727315.5 | 25791.1 | 681325.8 | 4313.2 | 3.55% |
| webkit | 726093.8 | 25427.6 | 680969.1 | 4265.2 | 3.50% |

Ordinary controls have zero virtual-adapter counter deltas; that does not mean
ordinary metadata operations cost zero. The VM counts include any concurrent
service housekeeping inside the observation window. Roughly 93.6–93.8% of span
attempts correspond to typed-element **reads**; no typed-element writes are
observed in these windows. The census does not yet split typed reads by width
or caller. DataView operations are only about 3.5% of span attempts, with
getBigInt64 the largest DataView bucket. These are method frequencies, not CPU
attribution or evidence that eliminating all DataView work saves only 3.5%.

This changes the next experiment's priority: keep stat-structure coalescing,
but first identify the typed-read paths and test the existing guarded byte-copy
adapter with validation enabled, alone and with scalar fusion. Host sources
contain iterator-based typed-array copying and bounded C-string scans, so
page-wise string scanning and shorter byte copies remain specific hypotheses.
They need early-NUL/denied-suffix, split/remapped pages, stale-view bounds,
coercion/intrinsic mutation and alias tests before adoption. No such new fast
path is implemented or measured here, and no timestamp freshness is relaxed.

Evidence is retained under `.context/common-memory-survey-20261111/phase58/`,
with both diagnostics, all controls/profiles, instrumenter sources, fixture
checks, frozen inputs, commands, copied observations and original-failure links.
These use the existing `shell-partial.vfs.zst`/private WordPress experiment
image. No canonical build, general POSIX/conformance, full performance suite,
complete reclamation or browser-memory acceptance is claimed.

### VM-05 / VM-10: byte-copy and scalar fusion with validation retained (phase 59)

This screen evaluates the existing guarded host byte-snapshot adapter, alone
and with small-offset scalar fusion, with timestamp validation **enabled in
every case**. PHP/helper remain O2 CALL. The byte-only pairs use identical
translated guest bytes; only their host profile changes. No constant-address
rewrite or atomic-fusion option is enabled. No production/SDK/ABI/registry/
default/preview change or canonical rebuild.

#### Admission and correctness

The timing input collector previously omitted phase 58’s new metadata
diagnostic marker from its rejection list. It now rejects that profile for
both fallback and per-mode routing, before file inventory; the real plain
normal/byte manifest admits. The old guard’s ENOENT versus corrected explicit
diagnostic rejection is retained. No prior timing used the metadata counters.

- 44 differential byte-snapshot checks per host, 176 total, pass in disposable
  Workers: conversions, intrinsic/hooks, signed/clamped/wide/short fallback,
  aliases, scatter/remap and denied ranges.
- 40 fresh PHP CLI/FPM cases pass on all four hosts; independent audits bind
  actual Node commands/browser case metadata to the intended normal/byte
  profile and artifact. Recursive private fork state, shared OPcache publication,
  invalidation and real worker replacement pass.
- 40 fresh WordPress cases pass on SQLite/MariaDB/all four hosts: four VM
  profiles and ordinary FILE control per backend/host, 160 page samples.
  Independent inventory, content, actual recorded INI, profile/artifact/image,
  cache/two-worker/resources/error-stream/teardown audits pass.
- Four separate plain combined-profile diagnostics prove effective timestamp
  validation through ini_get: both workers load edited PHP version 2 after
  mtime change, **before explicit invalidation**, with no FILE cache in shared
  mode. Same-byte normal-profile ordinary FILE generation/reuse proof from
  phase 57 is retained separately.

The policy collector then fails its final integrity assertion because its
source glob captured its **own live output log** as an empty input. All four
guest cases had already completed successfully. The original collector exit 1,
sources, inputs and output remain unchanged, with no original success receipt.
Independent recovery verifies all actual inputs and exact guest results,
excludes only that proven output (its frozen digest is SHA256 of empty bytes),
and records the output’s final digest. The captured empty preimage is retained.
No guest rerun selects a favorable result. A future explicit-source collector
template is prepared separately and not executed.

A separate five-parent diagnostic confirms actual bulk/fallback use on all
four hosts plus a Node ordinary FILE negative control. Kernel-realm counters
from after login to the last snapshot advance by bulk/fallback 3485/23903 on
Node/Chromium/WebKit and 3486/23910 on Firefox; ordinary is 0/0. These include
the diagnostic workload/window, not all process-worker copies or CPU share.
No counter-enabled profile enters timing.

#### Matched SQLite timings

All **64 fresh parents** pass: 16 per host, two reverse VM orders, with
ordinary FILE controls under **both** normal and byte-enabled host profiles
before and after each cohort. This measures ordinary-path effects rather
than assuming identical host-profile cost. Two warmup/five measured rounds
of home/article/admin/posts produce 1280 measured and 512 warmup samples.
The same empty-cache source image is used; shared OPcache disables FILE cache.
Independent strict analysis verifies exact case/sample inventories, hashes,
profile bindings, settings/INI, content/cache/two-worker/resources/teardown.

Below are geometric means of four page-median ratios over two cohorts; lower
is shorter. They are descriptive, not CPU, request-weighted throughput or
confidence intervals. Keep cohort variation and ordinary drift when reading
the aggregates.

| Host | byte / baseline | fusion / baseline | both / fusion | both / byte | both / baseline |
|---|---:|---:|---:|---:|---:|
| node | 0.9213 | 1.3326 | 0.5957 | 0.8617 | 0.7938 |
| chromium | 0.8252 | 0.8575 | 0.8827 | 0.9172 | 0.7569 |
| firefox | 0.9536 | 0.8890 | 1.4213 | 1.3250 | 1.2635 |
| webkit | 1.2186 | 1.0549 | 1.2373 | 1.0710 | 1.3052 |

The opposing orders expose important instability:

- Node byte/baseline is 0.8901/0.9535; combined/baseline 0.7774/0.8105.
  Fusion alone changes from 0.9139 to 1.9430, so its aggregate regression and
  the apparent 40% increment from adding bytes to fusion are not a clean
  estimate. That adverse parent is retained without retry or trimming.
- Chromium combined/baseline is 0.8640/0.6631 and byte/baseline
  0.9476/0.7187: both directions favor the change, but the magnitude varies
  substantially. Combined/byte is more consistent at 0.9119/0.9226.
- Firefox combined/baseline reverses from 1.9862 to 0.8038; its 1.2635
  aggregate cannot support a combined speedup. Byte alone is 0.9842/0.9240
  and fusion alone 0.9078/0.8706. Functional success does not resolve the
  performance reversal.
- WebKit byte/baseline is 0.9867/1.5051 and combined/baseline
  1.0297/1.6545. Scalar fusion alone is adverse in both orders
  (1.0515/1.0582). Retain these negatives rather than enabling every option.

| Host | baseline / own ordinary | byte / own ordinary | fusion / own ordinary | both / own ordinary |
|---|---:|---:|---:|---:|---:|
| node | 2.0495 | 1.9155 | 2.7311 | 1.6505 |
| chromium | 1.7435 | 1.4484 | 1.4950 | 1.3285 |
| firefox | 1.6749 | 1.4726 | 1.4890 | 1.9512 |
| webkit | 1.3182 | 1.6193 | 1.3905 | 1.7344 |

Ordinary means untranslated Wasm with FILE OPcache. These ratios include
cache-backend effects and unstable VM parents; they are not a pure memory
translation tax. The normal/byte ordinary controls are separately retained.

| Host | largest normal ordinary page-bracket drift | largest byte ordinary page-bracket drift | observed 1-minute load range |
|---|---:|---:|---:|
| node | 1.0998 | 1.0659 | 2.81–14.73 |
| chromium | 1.2050 | 1.2832 | 5.31–16.02 |
| firefox | 1.0732 | 1.5396 | 5.00–16.02 |
| webkit | 1.1617 | 1.3104 | 3.35–20.47 |

Cold listener/first-homepage ratios against the outlined VM profile include
setup and app work, not isolated compiler cost. Cohort-level cold values,
per-page ordinary/profile comparisons, memory and cache states remain in
analysis.json; the following aggregates are descriptive.

| Host | profile | listener ratio | first-homepage ratio |
|---|---|---:|---:|
| node | byte-outlined | 0.8330 | 0.7234 |
| node | baseline-fused | 0.9106 | 0.6920 |
| node | byte-fused | 0.9131 | 0.6256 |
| chromium | byte-outlined | 1.0006 | 0.9225 |
| chromium | baseline-fused | 0.9725 | 0.8213 |
| chromium | byte-fused | 0.9867 | 0.7992 |
| firefox | byte-outlined | 0.9383 | 0.8543 |
| firefox | baseline-fused | 0.9281 | 0.7825 |
| firefox | byte-fused | 1.0774 | 0.9866 |
| webkit | byte-outlined | 1.1775 | 1.1564 |
| webkit | baseline-fused | 0.9249 | 0.8548 |
| webkit | byte-fused | 1.1583 | 1.0037 |

No controlled-system-load, steady-state, confidence-interval, RSS or general
platform claim. The combination merits controlled replication on Node and
Chromium; this screen supports no universal preset. Firefox’s reversal and
WebKit’s adverse results remain first-class evidence. Caller/width attribution,
short copies, page-wise C strings and metadata-structure coalescing remain
separate ideas, not implemented or measured benefits of this screen.

The old phase 57 Firefox constant-only HTTP504 remains unresolved: that
transform is absent here, and this screen does not diagnose or fix it. Root/
private/scratch reclamation and portable-tailcall limitations also remain.
Raw plans, all native/VM controls, loads, cold timings, sources, the collector
failure/recovery and future template are retained under
`.context/common-memory-survey-20261111/phase59/`.
Evidence uses the existing partial shell/private WordPress image; no canonical
build, conformance/full performance suites or browser-memory acceptance.

### Survey synthesis and retained-record completion audit (phase 60)

The requested broad survey now has a separate
[synthesis](2026-11-12-common-memory-optimization-survey.md), preserving all19
stable candidate IDs and their different evidence depths. Timestamp validation
remains the primary application policy; optional immutable-code results do not
control its recommendation. The synthesis distinguishes measured application
effects, mechanism/coverage results, failed candidates and unimplemented
extensions. No family or negative/inconclusive run is removed.

An independent retained-record audit reproduces exact historical summaries
for1152FPM parents: scalar/conditional commit, root caches, fusion, object
regions, postopt, PHP/helper O3, full/ThinLTO and held-out PGO controls. It
independently reconstructs all recorded comparisons and application admission
checks for592WordPress parents: affine cache, preload, compiler, aligned
atomics, both-database byte copies, PGO, clean-image wrapper/feature factorials,
and timestamp-enabled byte/fusion. All four hosts are present. It verifies
308distinct retained input preimages rather than comparing historical inputs
with subsequently edited source files. These are reanalyses, not new timing
replications or evidence of quiet-machine conditions.

The supplementary raw-record audit recomputes regional/origin coverage,
verifies12fixed-pool cases including the4expected capacity failures, checks
48actual FPM replacements, and retains the portable-dispatch failures and
unresolved constant-only Firefox504. The existing original microbenchmark
validator passes81retained identities, eight cohorts,35groups/210000oracle
attempts each,14cases/162comparisons per host, identical auto-vectorization
artifacts and all14all-together report rows. The latest176byte-snapshot
mechanism records also verify across all four hosts.

Audit-reader mistakes are preserved: the first archive-index reader missed
nested compressed-identity ledgers, and two byte-reader attempts misread the
browser wrapper and confused branch counters with an error stream. Corrected
readers use explicit schemas and fresh output directories. No guest run was
retried, no original receipt was converted into a pass and no timing sample
was changed or removed.

The requirement mapping and readers are retained under
`.context/common-memory-survey-20261111/phase60/`. The final integrity audit
checks retention separately from methodology. This completes the systematic
survey deliverable, with no general compiler optimum, universal preset,
platform performance or production acceptance claim. The unchanged private
preview, partial-image scope, safe-retirement gap and all further ideas remain
explicit. No production source, ABI, registry recipe or runtime default is
changed by this phase.

### Quantitative survey table amendment (phase 61)

The synthesis now gives a quantitative anchor for every candidate family:
observed latency ratios where available, otherwise measured coverage,
resource usage or failure counts without an inferred speedup. New percentage
ranges span the two timestamp-enabled cohort aggregates; they are not
confidence intervals or forecasts. Older timestamp-off workloads, FPM versus
WordPress, ordinary denominators and bracket normalization are labeled.
All19families and retained directions remain. Values are extracted from
12verified latency-source reports; no guest or timing run was repeated.
The source aggregate for WebKit GOTO/CALL is3.7644507833; the current synthesis
rounds it to3.764, correcting the earlier3.765 display. The first checker’s
failure on that discrepancy is retained; original historical records remain.
The amendment, source hashes and checks are retained in
`.context/common-memory-survey-20261111/phase61/`.

### Timestamp-preserving metadata follow-up

Shared OPcache still has a backend benefit with validation enabled. A
read-only derivation verifies the16baseline VM/file and VM/shared cases from
phase25: all have effective validate_timestamps=1 and revalidate_freq=0, the
same translated PHP artifact and matching per-cohort host profiles. Shared/
VM-file HTML ratios are0.660Node/0.670Chromium/0.666Firefox/0.674WebKit;
REST ratios are0.514/0.523/0.512/0.530. HTML combines home/article/admin page
medians equally across two cohorts. These earlier SQLite/preseeded-FILE-image
comparisons hold translation in place on both sides; they are not a net
ordinary-addressing advantage, new timing, CPU measurement or forecast.
Derivation, exact source hashes and raw-case admissions are retained in
`.context/common-memory-timestamp-validation-20261113/cache-comparison.json`.

The experimental WordPress builder explicitly sets revalidate_freq=0.
PHP's documented default is2seconds; setting a nonzero frequency retains
automatic timestamp checking but changes its detection interval. This is an
optional cadence tradeoff, not an optimization preserving every-request
freshness. The primary platform experiments should keep validation enabled
and frequency0 unless that tradeoff is deliberately selected.

Further candidates that retain freshness:

- **Reuse metadata within one stat syscall.** Current namespace resolution
  returns a stat record; sys_stat discards it, rechecks the canonical directory
  search chain and fetches final metadata again. Investigate one-pass reuse
  for regular files, preserving credentials, symlinks, special virtual files,
  error ordering and mutation-race behavior. This is source evidence of
  repeated work, not a measured latency gain.
- **Page-wise strings and short copies.** Avoid per-byte translation in
  bounded pathname scans and repeated iterator work in small syscall records.
  Preserve early-NUL behavior, denied suffixes, page splits, remaps, aliases
  and conversion order. Existing large-byte-copy results do not establish a
  short-copy or pathname speedup.
- **Cheaper clock queries.** The earlier Node diagnostic attributes7140fewer
  clock_gettime calls to validation-off, alongside10495fewer stat calls.
  Consider a direct supported clock-query ABI to avoid worker round trips;
  retain actual time, clock-ID/namespace/error and signal contracts rather
  than returning a periodically stale cached clock. Those dispatch counts
  are not CPU savings or proof all time calls originate in OPcache itself.
- **Mutation-coherent lookup/metadata caches.** Kernel-owned generations can
  validate cached directory/inode/metadata results, potentially extending to
  a guest fast-stat path. Every relevant write, truncate, timestamp update,
  rename, link, unlink, permission/namespace change must invalidate correctly.
  External host edits and backends without authoritative invalidation need
  normal fresh lookup fallback; ordinary TTL caches change freshness.

Current host stat serialization already builds a complete host-owned record
and publishes it once. Do not assume generic stat packing is still entirely
per-field virtual writes. First count/time the actual metadata phases and
backend operations; preserve all existing ownership checks. No new fast path,
compiler build, runtime change or timestamp policy was implemented here.

### APP-03: timestamp-preserving metadata implementation screen

The subsequent implementation starts with synchronous reuse, without a
cross-request cache. `sys_stat`, `sys_lstat` and `sys_fstatat` retain the
`ResolvedNamespacePath.stat` returned by their namespace walk. After the
existing virtual-device, procfs, devfs, FIFO and Unix-socket handlers, they
reuse it only when kernel-owned rootfs or tmpfs claims the canonical path.
Foreign host mounts retain their final fresh lookup and search check. The
walk still checks credentials, ancestors, symlinks and trailing-slash errors;
the current implementation also retains the resolver's final verification.
No timestamp setting, PHP compiler input, shared mapping or host default is
changed by this kernel candidate.

Two new Rust tests cover rootfs/tmpfs lookup counts, changes from write and
utimensat, rename/unlink, open-file metadata after unlink, denied ancestors,
symlink/nofollow and directory errors. Test-only counters establish one
namespace walk plus final verification, without a second search walk. They
are absent from the production Wasm build. This is mechanism evidence; the
PHP microbenchmark includes PHP execution and transport as well as lookup.
Reduced lookup counts alone do not attribute elapsed time: retaining the
stat aggregate can also change Wasm copies and compiler decisions. The
current screen does not isolate kernel CPU time or establish which remaining
phase dominates.

The micro screen uses ordinary and virtualized PHP CLI, two opposing orders,
fresh parents on Node/Chromium/Firefox/WebKit, and stat/lstat/missing-path
loops. The missing-path loop is a control: it fails during resolution, before
the new successful-stat reuse. Every iteration clears PHP's stat cache.
Separate candidate application gates exercise SQLite and MariaDB, ordinary
FILE OPcache and translated shared OPcache on each host. The effective
configuration is validate_timestamps=1/revalidate_freq=0; both FPM workers
observe an edited cached PHP target before explicit invalidation.

Keep the next experiments distinct:

- **Page-wise pathname scans.** The C channel marshaler scans C strings one
  byte at a time before copying them. A bounded per-page translation could
  amortize the mapping checks. Stop at NUL before consulting a later page;
  test denied/unmapped suffixes, boundaries, limits and remaps. Translation
  helpers must not retain a physical address across fork or mapping effects.
- **Short scalar/record adapters.** Virtual DataView and typed-element
  access currently allocate span arrays and physical views. Screen a
  checked, same-page path with the existing split-page fallback, retaining
  conversion order, view limits, permissions and physical bounds. This is
  separate from the existing large-byte-copy experiment. No speedup has
  been measured for this proposed change.
- **A capability for direct clock queries.** The ordinary musl time path
  uses the channel, and the WASI clock shim also calls the kernel. The kernel
  validates clock IDs and supplies task-specific logical clocks in image
  builds. The channel is also a signal-delivery boundary. A supported direct
  route needs an explicit provider capability, matching time origins across
  Workers, precision and clock-ID behavior, correct output-pointer checks,
  signal handling, and fallback for deterministic/custom providers. Simply
  reading Date.now() or a periodically cached second does not establish the
  current contract. No direct-clock ABI or application speedup is claimed.
- **Mutation-coherent directory/metadata caches.** This remains a larger
  alternative if repeated lookup is material after transport costs are
  separated. It needs authoritative invalidation for content, timestamps,
  names, links, permissions and namespaces, and fresh fallback for external
  edits. Synchronous stat reuse does not implement that cache.

The initial WordPress timing batch completed Node but stopped at a Chromium
candidate timeout before reaching the other browsers. Its failed record is
retained. A separate instrumented Chromium candidate/baseline reproduction
completed normally and did not explain that original timeout. A fresh full
browser timing matrix uses no automatic retries and does not erase the
failed batch. These experiments do not establish production acceptance.

#### APP-03 measurements and disposition

The checked analysis admits32micro parents,16application gate parents and
48primary application timing parents. The latter combine the original
complete12-parent Node component with a fresh complete36-parent browser
batch. The first browser batch is retained in full:8completed parents, one
320-second outer-test timeout, and27unattempted cases after fail-fast. Its
timeout record has no saved trial progress, so startup, request execution
and destruction cannot be distinguished. The separate two-parent Chromium
diagnostic retains copied live progress and completes both kernels normally;
it is excluded from latency aggregates and does not resolve the failure.
There are no automatic test retries or removed samples.

The before/after kernels were built with the normal kernel recipe into
private output directories. Baseline is the saved pre-change source at
feature-branch HEAD6d5ebb19b245, not a separately built origin/main. Candidate
changes only this synchronous stat implementation in the production build;
the two new tests/counter are cfg(test). All cases use the frozen plain
phase58 host profile and existing PHP O2 CALL/outlined/O2-helper artifacts.
The image starts with an empty FILE cache; shared cases disable FILE cache.
This is the existing private WordPress experiment image, not a new canonical
product build. The interactive preview and its selected kernel are unchanged.

Micro timings are medians of five1500-iteration rounds per parent, after two
warmup rounds. The table combines the two cohort ratios geometrically. They
measure a PHP clearstatcache/stat loop, including PHP and transport, rather
than isolated kernel CPU time. Lower candidate/baseline ratios are shorter.

| Host | Ordinary stat candidate/baseline | Translated stat candidate/baseline | Translated lstat candidate/baseline | Translated missing-path control |
|---|---|---|---|---|
| Node | Ratio: **0.9869** | Ratio: **1.0054** | Ratio: **1.0087** | Ratio: **1.0243** |
| Chromium | Ratio: **0.9849** | Ratio: **0.9872** | Ratio: **1.0190** | Ratio: **1.0200** |
| Firefox | Ratio: **0.9668** | Ratio: **0.9620** | Ratio: **0.9688** | Ratio: **0.9606** |
| WebKit | Ratio: **0.9875** | Ratio: **0.9837** | Ratio: **0.9636** | Ratio: **1.0012** |

Translated stat cohort medians span115–149microseconds/iteration, while
ordinary ones span42–53microseconds. Neither this difference nor the missing
control identifies the responsible CPU phase. In particular, Firefox's
missing-path control improves by a similar aggregate amount despite not
reaching the changed success path. Keep both cohort ratios and absolute
times in the raw analysis; the aggregates are not confidence intervals.

Application timings keep validate_timestamps=1/revalidate_freq=0. Each fresh
parent serves two warmup and five measured rounds of home/article/admin/REST,
for960measured pages in the primary48parents. Ratios use each parent's page
median, then equal-weight geometric means across four pages and two cohorts.
Each kernel also has its own ordinary FILE-cache parents before and after
the translated runs; ordinary brackets are geometric means per page.

| Host | Translated shared OPcache candidate/baseline | Ordinary FILE OPcache candidate/baseline | Translated candidate / own ordinary FILE brackets |
|---|---|---|---|
| Node | First cohort: **1.0008**<br>Second cohort: **1.0242**<br>Combined: **1.0125** | First cohort: **1.0125**<br>Second cohort: **0.9893**<br>Combined: **1.0008** | First cohort: **1.9680**<br>Second cohort: **2.0202** |
| Chromium | First cohort: **1.0095**<br>Second cohort: **1.0019**<br>Combined: **1.0057** | First cohort: **0.9914**<br>Second cohort: **0.9909**<br>Combined: **0.9912** | First cohort: **1.5504**<br>Second cohort: **1.5056** |
| Firefox | First cohort: **0.9977**<br>Second cohort: **0.9803**<br>Combined: **0.9889** | First cohort: **1.0161**<br>Second cohort: **1.0100**<br>Combined: **1.0131** | First cohort: **1.5199**<br>Second cohort: **1.5296** |
| WebKit | First cohort: **0.9803**<br>Second cohort: **0.9862**<br>Combined: **0.9832** | First cohort: **1.0069**<br>Second cohort: **1.0339**<br>Combined: **1.0203** | First cohort: **1.2196**<br>Second cohort: **1.2994** |

The result is small and mixed: about1.2%more elapsed time on Node,0.6%more on
Chromium,1.1%less on Firefox and1.7%less on WebKit. This does not establish a
material application improvement. Normalizing by own ordinary brackets gives
candidate/baseline ratios1.0116/1.0147/0.9762/0.9637 respectively, but does not
remove confounding. Ordinary after/before page ratios span0.7241–1.0497,
including substantial WebKit drift. One-minute load spans2.75–8.65 in the
primary timing components; the failed earlier parent records load12.78 at
start. These are not quiet-machine replications, throughput estimates or a
pure translation-cost comparison. Ordinary means untranslated Wasm in the
same engine; the final column includes the shared-versus-FILE OPcache effect.
Cold startup, every page/cohort, load, allocation counters and destruction
results remain in the analysis and raw records.

Validation outcomes:

- Both new Rust regression tests pass. The runtime-core inventory reports
  3760passes and one failure,
  `unavailable_host_capability_records_which_one` (EINVAL versus expected
  ENOMEM). The exact failure also reproduces with saved pre-change source.
- The workspace Rust suite fails to compile tests because program-policy
  lacks its referenced wasm_posix_shared test dependency. A temporary
  dependency probe exposes an ABI-version type mismatch and lifecycle tests
  calling removed OfdTable/ProcessTable methods. The temporary Cargo changes
  were reverted; none of these failures is relabeled as a pass.
- ABI snapshot/baseline check passes. All32micro parents and16application
  correctness parents pass. The application gates cover both SQLite and
  MariaDB, both cache/addressing modes, and all four hosts, including effective
  INI and changed-source observation by both workers before invalidation.
- Original timing batch fails; the fresh complete browser batch passes.
  Timings cover SQLite, not a timed MariaDB matrix. Full platform benchmark,
  conformance, canonical-product and production acceptance gates remain
  outstanding. No general conformance or merged-branch speedup is claimed.

Keep the candidate and tests as an experimental patch rather than selecting
it for a promised speedup. Prioritize page-wise pathname/short-record adapters
and a supported direct-clock prototype before more variations of this same
lookup cleanup. None of those remaining candidates is implemented by APP-03.
The existing compiler controls are unchanged; this experiment says nothing
new about an optimal compiler flag set.

The [retained evidence](../../.context/common-memory-timestamp-stat-20261113/)
contains the candidate patch, exact source/artifact preimage map, commands,
successful and failed logs, copied diagnostics, raw results and checked
[analysis](../../.context/common-memory-timestamp-stat-20261113/runs/timestamp-stat-analysis-1/analysis.json).
The frozen manifest checks130inputs before and after each matrix component;
retention verifies their actual preimages, including references to unchanged
earlier archived inputs. These checks prove identity and retention, not the
absence of methodological limits or the cause of the original timeout.

### Timestamp optimization campaign: remaining candidates

The user explicitly requested an active goal to try all timestamp-related
ideas one by one after APP-03. APP-03 did not complete that request. The
[campaign inventory](../../.context/timestamp-optimization-campaign-20261113.json)
tracks every remaining item independently; pending work is not counted as
tested. Primary comparisons retain validate_timestamps=1/revalidate_freq=0.

| ID | Candidate | State at campaign start |
|---|---|---|
| TS-01 | Synchronous stat metadata reuse | APP-03 screen retained; small mixed timings and original timeout remain. |
| TS-02 | Page-wise bounded pathname scanning | Pending implementation and measurement. |
| TS-03 | Short scalar adapters | Independent DataView and typed-element same-page prototypes pass mechanism checks on all four hosts; PHP/application measurements pending. |
| TS-04 | Short byte/record copies | Pending; distinct from earlier large-copy experiments. |
| TS-05 | Supported direct clock queries | Pending; requires clock/provider/logical-time/signal/ABI treatment. |
| TS-06 | Mutation-coherent metadata caching | Pending kernel-cache and guest fast-stat variants; external edits need fallback. |
| TS-07 | Revalidation cadence control | Pending separately labeled policy experiment. Retains timestamps but changes detection delay; never presented as equal freshness. |

TS-03 prototypes do not cache a physical mapping or channel view. A fresh
same-page lookup avoids the span array/object and retains permission,
physical-bounds and stale-view checks; cross-page or overridden resolvers
fall back to the original route. Each of the baseline, DataView-only and
typed-only adapters passes203 assertions on Node, Chromium, Firefox and
WebKit. Those are internal adapter mechanism checks, not proof of complete
native-JavaScript API equivalence, browser-memory retirement or application
performance. The candidates remain private build flags. No new compiler
optimization, direct-clock ABI or coherent metadata cache is implied.

#### TS-03 micro/freshness milestone

All48fresh PHP CLI parents complete with the baseline, DataView-only and
typed-element-only profiles. The same pre-APP-03 kernel is bound explicitly
on all sides, so this does not combine scalar adaptation with stat reuse.
Profiles are rebuilt from matching current host inputs, with the existing
pregrown backing control on every side. PHP/helper O2 CALL builds and the
empty-FILE-cache experimental image are unchanged. The raw case admission
checks184frozen inputs and actual kernel/program/profile bindings.

The following ratios compare each translated candidate with its translated
baseline. Each cohort uses a fresh parent and the median of five measured
1500-iteration stat/clearstatcache loops after two warmup loops. These include
PHP and channel transport; they are not bare stat syscall or CPU timings.

| Host | DataView stat candidate/baseline | Typed-element stat candidate/baseline | Typed ordinary stat control candidate/baseline |
|---|---|---|---|
| Node | First cohort: **0.9917**<br>Second cohort: **0.9960**<br>Combined: **0.9938** | First cohort: **0.9203**<br>Second cohort: **0.9689**<br>Combined: **0.9443** | Combined: **0.9593** |
| Chromium | First cohort: **0.9837**<br>Second cohort: **0.9939**<br>Combined: **0.9888** | First cohort: **0.9746**<br>Second cohort: **0.9645**<br>Combined: **0.9696** | Combined: **0.9985** |
| Firefox | First cohort: **0.9749**<br>Second cohort: **0.9541**<br>Combined: **0.9644** | First cohort: **1.0006**<br>Second cohort: **0.8867**<br>Combined: **0.9419** | Combined: **0.9619** |
| WebKit | First cohort: **0.9236**<br>Second cohort: **1.0032**<br>Combined: **0.9626** | First cohort: **0.9102**<br>Second cohort: **0.9986**<br>Combined: **0.9534** | Combined: **0.9637** |

The aggregate typed stat ratios show a possible modest benefit, but ordinary
controls also move and Firefox/WebKit vary substantially by order. WebKit's
translated lstat aggregate is1.0253for typed and1.0311for DataView; this is
not an all-operation win. Full lstat/missing-path ratios and absolute times
are retained. No application improvement follows from these micro results.

Separate32fresh application gate parents pass, covering both optimized
profiles, ordinary FILE and translated shared OPcache, SQLite/MariaDB, and
all four hosts. Effective validate_timestamps=1/revalidate_freq=0 is verified;
both FPM workers observe changed cached source before explicit invalidation.
These diagnostic rounds are not ranked as an application timing experiment.
The prepared independent WordPress timing matrix remains pending at this
milestone, as do the other timestamp candidates and any combination.

The [pre-application evidence](../../.context/timestamp-optimization-20261113/ts03-pre-app/)
retains the mechanisms, profiles/preimage map, raw micro and freshness records,
exact commands and checked analyses. This milestone does not complete the
active goal or establish full platform performance/conformance acceptance.

#### TS-03 WordPress application screen

The independent application matrix completes72fresh parents and verifies all
184frozen inputs. Both candidates retain validation1/frequency0 and use the
pre-stat-reuse kernel, identical PHP O2 CALL/outlined/O2-helper builds and
own-profile ordinary FILE-cache brackets. Each parent serves two warmup and
five measured rounds of home/article/admin/REST. No timing sample is removed
and no parent is retried. The gates above cover both databases; this timing
matrix covers SQLite.

Ratios below are equal-weight geometric means of four page-median ratios.
Combined values also average the two cohorts geometrically. Lower is shorter
request latency, not CPU or traffic-weighted throughput. Ordinary controls
are untranslated Wasm in the same engine, not machine-native PHP.

| Host | DataView / translated baseline | Typed / translated baseline | Ordinary candidate / ordinary baseline |
|---|---|---|---|
| Node | First cohort: **0.9958**<br>Second cohort: **2.1659**<br>Combined: **1.4686** | First cohort: **0.9644**<br>Second cohort: **0.9878**<br>Combined: **0.9760** | DataView first: **1.0072**<br>DataView second: **0.9882**<br>Typed first: **0.9647**<br>Typed second: **0.9823** |
| Chromium | First cohort: **1.1220**<br>Second cohort: **1.0021**<br>Combined: **1.0603** | First cohort: **1.3112**<br>Second cohort: **0.9846**<br>Combined: **1.1362** | DataView first: **1.1064**<br>DataView second: **0.9577**<br>Typed first: **1.0795**<br>Typed second: **0.9738** |
| Firefox | First cohort: **0.9582**<br>Second cohort: **0.9943**<br>Combined: **0.9760** | First cohort: **0.9697**<br>Second cohort: **3.1748**<br>Combined: **1.7546** | DataView first: **0.4549**<br>DataView second: **2.3007**<br>Typed first: **0.4578**<br>Typed second: **0.9889** |
| WebKit | First cohort: **0.9899**<br>Second cohort: **0.9899**<br>Combined: **0.9899** | First cohort: **1.0184**<br>Second cohort: **0.9904**<br>Combined: **1.0043** | DataView first: **1.0162**<br>DataView second: **1.0188**<br>Typed first: **1.0097**<br>Typed second: **1.0181** |

This does not establish a common preset or a reliable general application
gain. Node's typed raw reduction tracks its ordinary controls: own-bracket
normalized ratios are0.9998/1.0056. Node DataView's second parent is adverse
across every page, rather than one discarded request. Chromium's first typed
cohort is adverse even after normalization (1.2146); the second is1.0111.
Firefox's second typed parent is adverse across all pages. Its DataView
normalization reverses2.1064/0.4322 because the ordinary controls themselves
shift dramatically. Do not interpret its combined own-ordinary ratio as a
clean addressing-cost estimate. WebKit's DataView raw ratios are modestly
favorable in both cohorts, but neither these two parents nor this batch
establish a general win.

Ordinary after/before page ratios span0.8711–5.8269 across the batch.
One-minute load spans2.19–63.24; Node records12.81–63.24 and Chromium6.74–25.36.
Waiting for the known peer browser job before starting did not establish a
quiet machine. Load alone also does not prove the cause of a particular
adverse parent. Keep all rounds, cold start, per-page/cohort, allocation and
load results. This screen is negative/inconclusive for selecting a default,
not proof that either technique can never help. No combination is selected.

The [application evidence](../../.context/timestamp-optimization-20261113/ts03-application/)
retains the complete raw matrix, source/preimage references, checked analysis,
commands and receipt. The earlier pre-application milestone remains unchanged.
The active campaign proceeds to short-copy and page-wise string screens;
clock and coherent-cache candidates remain outstanding.

#### TS-04 short-copy operation screen

Four independent private adapter variants admit byte slices from1/16/64/128
through255bytes. Larger copies retain the original iterator route, separating
this idea from the earlier large-copy optimization. Each variant passes44
named mechanism checks on Node and all three browsers: copied values/types,
independent output, boundaries, scattered/aliased pages, permissions, stale
views, conversion/lookup order and modified primitives/hooks. These are16
successful host/variant cases, not PHP integration proof.

The isolated timing screen completes40fresh parents: five modes, two opposing
orders, four hosts. Each measures13sizes at two offsets, including a page
split, with two warmup and five measured1500-copy rounds. These are JavaScript
adapter slice/copy timings, including allocation and output inspection.
Ordinary here is native JavaScript Uint8Array, not untranslated Wasm or PHP.
The following ratios combine the two offsets and two cohorts geometrically;
they are not confidence intervals or available request-time savings.

| Host | Short64 / old virtual copy at112bytes | Short64 / old virtual copy at16bytes | Short64 / old virtual copy at512bytes |
|---|---|---|---|
| Node | Ratio: **0.0958** | Ratio: **1.0051** | Ratio: **1.0246** |
| Chromium | Ratio: **0.1042** | Ratio: **1.0386** | Ratio: **0.9710** |
| Firefox | Ratio: **0.1235** | Ratio: **1.0250** | Ratio: **1.1207** |
| WebKit | Ratio: **0.1861** | Ratio: **1.0914** | Ratio: **1.0638** |

The size dependence matters. The lower-threshold variants also improve
16-byte copies on Node/Chromium/Firefox, but WebKit's corresponding short1
and short16 ratios are1.0021/1.0733. Non-admitted sizes retain bookkeeping
costs; they are not presumed free. All threshold, cohort, offset, ordinary
control and zero-duration cases remain in the raw analysis. One-minute load
spans3.42–6.11. This is a strong operation-level lead, not an application win.

The64–255range is selected for the first independent PHP screen. Its rebuilt
baseline reproduces all six previous baseline bundles byte-for-byte. Private
profile flag `--short-records=64` enables only this range, without stat reuse,
scalar adaptation or large-copy fast paths. The PHP stat-loop, both-database
freshness and WordPress timing stages remain distinct checks. No default or
published preview changes. Evidence is retained under
[the operation screen](../../.context/timestamp-optimization-20261113/ts04-operation/).

#### TS-02 page-wise string helper screen

A standalone Wasm helper prototype now exercises actual virtual mapping roots
and physical backing. It compares an ordinary byte scan, ordinary eight-byte
word scan, per-byte virtual translation, page-wise virtual byte scan and
page-wise virtual word scan. The page variants consult a later page only
after failing to find a NUL in the current readable prefix. Their temporary
physical addresses do not escape the pure scan. The matched mechanism screen
passes on Node/Chromium/Firefox/WebKit, including early NUL, clipped bounds,
mixed-byte word masks, scattered/denied suffixes, fork sharing/private state
and remapping. SDK/PHP-marshaller integration remains unimplemented.

The first eight-parent timing screen used fixed1500-scan batches and an
ordinary byte-loop control. Some short scans quantized to zero; unresolved
ratios remain null. Its word-search candidate also changed the scan algorithm,
so that ordinary comparison is not a matched addressing-cost estimate.
That attempt is retained rather than replaced by the improved design.

The subsequent eight-parent screen adds matched ordinary-word and virtual
page-byte controls. Per-mode batch counts adapt toward20ms, with two warmup
and five measured batches. Addresses vary within batches to prevent C-level
loop-invariant call hoisting; checksums include32-bit wrapping. Actual measured
batch periods span15.84–56.32ms. Two offsets and two opposing orders are retained
per host. Values below are geometric means of those four case ratios, for
this isolated operation with no allocation, channel RPC or PHP execution.

| Host | Page-byte / per-byte translation,112bytes | Page-word / per-byte translation,112bytes | Page-word / matched ordinary-word,112bytes | Page-word / matched ordinary-word,4096bytes |
|---|---|---|---|---|
| Node | Ratio: **0.1255** | Ratio: **0.0330** | Ratio: **1.2897** | Ratio: **1.0603** |
| Chromium | Ratio: **0.1188** | Ratio: **0.0280** | Ratio: **1.2408** | Ratio: **1.0503** |
| Firefox | Ratio: **0.1691** | Ratio: **0.0419** | Ratio: **1.2475** | Ratio: **1.0554** |
| WebKit | Ratio: **0.1925** | Ratio: **0.0361** | Ratio: **1.3512** | Ratio: **1.0962** |

This supports amortizing mapping work over a scan. It does not establish a
whole-PHP gain, source-site coverage, optimal compiler flags or universal
near-native memory addressing. Ordinary means untranslated Wasm in the same
engine, not machine-native execution. In particular, beating the ordinary
byte loop with a word scan does not demonstrate negative translation overhead;
the matched word control still exposes a cost. Short16-byte matched-word
ratios range1.2746–2.1460 across hosts. One-minute load spans4.33–5.30; no quiet
machine or confidence-interval claim. Both attempts, adaptive calibration,
raw medians, all sizes/offsets and source/artifact identities are retained in
[the helper screen](../../.context/timestamp-optimization-20261113/ts02-helper/).

#### TS-04 PHP micro/freshness milestone

The selected64–255byte profile completes32fresh PHP CLI stat-loop parents,
with the same pre-stat-reuse kernel/PHP artifacts and opposing profile orders.
The following stat/clearstatcache ratios retain both cohorts and own ordinary
controls. They include PHP execution and channel transport, not isolated
kernel CPU or WordPress request latency.

| Host | Translated short64 / translated baseline | Ordinary short64-profile / ordinary baseline |
|---|---|---|
| Node | First cohort: **0.5734**<br>Second cohort: **0.5551**<br>Combined: **0.5642** | Combined: **0.9376** |
| Chromium | First cohort: **0.6082**<br>Second cohort: **0.5938**<br>Combined: **0.6010** | Combined: **1.0082** |
| Firefox | First cohort: **1.0532**<br>Second cohort: **0.7952**<br>Combined: **0.9151** | Combined: **0.9856** |
| WebKit | First cohort: **0.7756**<br>Second cohort: **0.6349**<br>Combined: **0.7017** | Combined: **1.0393** |

Node/Chromium/WebKit favor the candidate in both orders. Firefox's first
stat cohort is adverse, despite improvements in lstat/missing-path loops;
retain that variation. This is a materially larger PHP-loop lead than the
earlier stat-reuse/scalar screens. Changing only the host copy path supports
further investigation of marshalling costs, without attributing an exact CPU
fraction or forecasting a request-time percentage.

All16separate application freshness parents pass on both SQLite and MariaDB,
ordinary FILE and translated shared OPcache, and all four hosts. Both workers
observe edited cached source before explicit invalidation, with effective
validate_timestamps=1/revalidate_freq=0. WordPress timing remains pending at
this milestone. The [retained PHP screen](../../.context/timestamp-optimization-20261113/ts04-pre-app/)
keeps all micro/freshness records, fields, bindings, sources and controls.

#### TS-04 WordPress application screen

The independent short64–255-byte host-copy path completes all48fresh-parent
timing cases on Node, Chromium, Firefox and WebKit. These are SQLite WordPress
requests, not MariaDB performance measurements. Each parent serves home,
article, authenticated admin and REST posts after two warmup rounds, followed
by five measured rounds. The two profile orders have separate ordinary
FILE-cache brackets; translated cases use real shared OPcache. All179frozen
inputs still match. Validation remains enabled with revalidate_freq=0.

| Host | Translated candidate / translated baseline | Ordinary candidate-profile / ordinary baseline | Translated candidate / own ordinary brackets |
|---|---|---|---|
| Node | First cohort: **0.8953**<br>Second cohort: **0.8804**<br>Combined: **0.8878** | First cohort: **1.0642**<br>Second cohort: **0.9999**<br>Combined: **1.0316** | Combined: **1.8473** |
| Chromium | First cohort: **0.8952**<br>Second cohort: **0.8980**<br>Combined: **0.8966** | First cohort: **1.0033**<br>Second cohort: **1.0105**<br>Combined: **1.0069** | Combined: **1.4420** |
| Firefox | First cohort: **0.9074**<br>Second cohort: **0.9395**<br>Combined: **0.9233** | First cohort: **0.9855**<br>Second cohort: **0.9964**<br>Combined: **0.9910** | Combined: **1.4533** |
| WebKit | First cohort: **0.9223**<br>Second cohort: **0.9162**<br>Combined: **0.9193** | First cohort: **0.9969**<br>Second cohort: **0.9953**<br>Combined: **0.9961** | Combined: **1.1926** |

Combined values are geometric means of the two cohort four-page ratios;
lower is shorter elapsed time. Every individual page/cohort translated
candidate/baseline ratio is below1, spanning0.8291–0.9832. The four-page
reductions span7.7–11.2%, supporting a shared-memory application candidate
for further validation. This does not generalize the much larger isolated
copy or PHP-loop gains to whole requests. Ordinary means untranslated Wasm
in the same engine, not machine-native PHP. The last column includes the
shared-versus-FILE OPcache configuration difference and other virtualization
costs; it is not an estimate of address translation alone.

Ordinary after/before page medians span0.9475–1.2909, with one-minute load
1.95–4.32. Normalized candidate/baseline four-page ratios are0.8606/0.8905/
0.9317/0.9229 for Node/Chromium/Firefox/WebKit, but that division is a
descriptive control adjustment, not a causal correction or confidence
interval. No parents were dropped or retried. The earlier Firefox stat-loop
reversal remains part of the evidence despite this consistent application
screen. The separate16SQLite/MariaDB freshness parents continue to establish
edited-source observation by both workers before explicit invalidation.

The [application evidence](../../.context/timestamp-optimization-20261113/ts04-application/)
retains all parents, raw samples, admission checks, load, ordinary brackets and
references to all179input preimages. The preview/defaults are unchanged;
full platform benchmarks, canonical builds, conformance and browser-memory
acceptance have not been established. Page-wise string integration, direct
clock queries, coherent caching and cadence controls remain campaign work.

#### TS-02 SDK/PHP integration mechanism milestone

The string prototype now has private SDK-glue and PHP artifacts. The glue
exposes an explicitly selected pure bounded-string helper; a copied offline
translator requires its exact function body, signature and versioned contract
before substituting the page-wise helper. Every invocation reads the current
address-space root. No physical pointer survives a callback or fork-capable
call. The unchanged-glue CLI/FPM relinks reproduce the previous ordinary PHP
hashes exactly. Separate byte-helper and word-helper builds keep generic
translation controls as well as page-wise variants, so later measurements
can separate helper-call, search-algorithm and translation effects.

All16fresh-parent normal-SDK guest probe cases pass across the four hosts:
generic/page-wise byte and generic/page-wise word variants. Each case verifies
40parent checks and four child checks, including an early terminator before a
protected page, bounded failure, word-lane zero detection, stat/lstat at that
edge, private and shared fork state, and fixed remapping. These positive
integration gates complement the standalone helper's1175assertions per host;
they are not PHP OPcache freshness or performance results.

Two harness failures are preserved: the first offline-tool build inherited
the Wasm target and failed before the native target was selected; the first
browser probe launch omitted the required artifacts environment variable,
after all four Node probes passed. No browser cases ran in that failed launch.
The corrected full16-case gate passes without retries inside its run.

The [pre-measurement integration evidence](../../.context/timestamp-optimization-20261113/ts02-integration-pre-micro/)
retains both failures, exact prepared sources, normal build logs, selected
runtime artifacts, proofs and successful guest results. PHP micro/freshness
and application timing remain unrun at this milestone. The next frozen plan
has80PHP micro parents and32SQLite/MariaDB freshness parents; an application
candidate will be chosen after the independent micro screens. No shipping
SDK, ABI, default profile, package projection or interactive preview changed.

#### TS-02 PHP freshness and TS-06 cache mechanism milestone

Both page-wise SDK/PHP variants complete32source-edit parents across SQLite,
MariaDB, ordinary FILE and translated shared OPcache, and all four hosts.
The strict reader admits every parent with all202inputs unchanged. Effective
timestamp validation remains1and frequency0; both FPM workers observe the
edited same-sized source before explicit invalidation. Performance is still
pending. The first micro matrix was deliberately interrupted after a peer
canonical build was discovered, before inspecting its elapsed results; its
partial output and recorded interruption decision are retained, not silently
replaced or presented as a completed screen.

The first TS-06 kernel-owned metadata-cache candidate now exists in an isolated
checkout. Each rootfs/tmpfs backend owns at most32positive records and64KiBof
path-key payload, plus bounded record/container overhead. Only lstat may reuse
them. Every other backend state entry clears the cache before its operation,
including reads that might change atime; allocation refusal simply skips
cache admission. Negative results and external host-mount stats remain on
their original paths. The ordinary namespace resolver still checks ancestor
permissions against current process credentials. This is conservative
invalidation with no TTL, not a complete mutation-site enumeration or a
guest fast-stat capability.

The clean private baseline rebuild exactly reproduces the earlier pre-stat-
reuse kernel. Candidate construction uses the normal kernel recipe and
export guards, with no production/default projection update. Six focused
native tests pass, covering cache bounds/copying, writes/truncation, timestamp
fields, chmod/chown, link counts, parent renames, symlink replacement, and inode
reuse. The full rootfs inventory passes296tests and tmpfs passes38; four of
the focused tests overlap those inventories. All16SQLite/MariaDB FPM freshness
parents also pass across ordinary/shared modes and all four hosts, retaining
validation1/frequency0 and source observation by both workers before explicit
invalidation. No performance or general conformance verdict follows yet.

The new checkout initially lacked ignored frozen ABI fixture binaries, so
the first native test compile failed before running tests. Seven existing
controls were copied byte-for-byte and checked against their pinned manifest;
none was rebuilt or restamped. That failed attempt is retained. The focused
tests and complete backend inventories subsequently pass. Cache micro and
application measurements, the distinct guest fast-stat route, direct clocks,
and combinations remain outstanding.

#### TS-02 PHP micro screen: the helper gain does not scale directly

The first complete PHP stat-loop screen admits all 80 fresh parents with all
202 frozen inputs unchanged. It keeps original-inline, explicit-byte-helper,
generic word-helper, page-wise byte and page-wise word variants. Each has its
own matching ordinary source algorithm; paths in this micro are 27 bytes
including NUL, whereas the earlier highlighted standalone scan was 112 bytes.
Two warmup and five measured loops cover stat, lstat and missing paths, with
clearstatcache on every iteration. Ordinary means untranslated Wasm in the
same engine. The following ratios are geometric means of the two opposing
cohorts, not confidence intervals.

| Host | Page-wise byte / generic byte, translated stat | Page-wise word / generic word, translated stat | Page-wise word / original inline, translated stat | Same-source ordinary word controls, page-profile / generic-profile stat |
|---|---|---|---|---|
| Node | Combined: **0.9985** | Combined: **1.0232** | Combined: **1.0972** | Combined: **1.0284** |
| Chromium | Combined: **1.0020** | Combined: **0.9915** | Combined: **0.9837** | Combined: **0.9758** |
| Firefox | Combined: **0.9769** | Combined: **0.9966** | Combined: **0.9742** | Combined: **1.0027** |
| WebKit | Combined: **0.9737** | Combined: **1.0057** | Combined: **0.9561** | Combined: **0.8435** |

This does not select a common PHP preset. Byte-wise page amortization is near
neutral in Node/Chromium; the word variant is adverse on Node against both
its same-source generic control and the original inline baseline. Same-source
lstat word ratios are 0.9926/0.9944/0.9897/0.9979 across the four hosts, while
missing-path results vary more, including Node's 1.0731 and WebKit's 0.9167.
WebKit's identical ordinary program bytes produce substantial variation
(same-source word missing-path ratio 0.7429), so the apparent reductions are
not clean estimates of an optimization effect. Longer real application paths
could behave differently; WordPress timing remains pending and the ideas stay
in the catalog.

The matrix started with no other registered running job. A new peer validation
job began during it: exact parent timestamps overlap 21 browser parents (one
Firefox and all 20 WebKit parents). That overlap is not proof of CPU contention
at each sample, but it is retained and qualifies those results. One-minute
load spans 1.94–3.35. No rows were removed or retried. The earlier interrupted
attempt remains separate; these are the complete second attempt's raw values.

A separate post-timing static audit confirms that every byte/word CLI/FPM
control retains one direct call to the selected helper from the exported
record marshaller after optimization and fork preparation. The source dispatch
attempts that marshaller for non-RAW stat/lstat/fstatat; it is not merely an
unused exported helper. This is static call coverage, not a dynamic invocation
count or CPU attribution. All 32 source-edit freshness parents already passed.

#### TS-07 enabled timestamps with a different cadence

The separately labeled policy control completes all 32 source-edit parents:
revalidate_freq 0 versus 2, ordinary FILE versus translated shared OPcache,
SQLite/MariaDB, and Node/Chromium/Firefox/WebKit. Every parent keeps
validate_timestamps=1, the existing program/kernel/profile artifacts, both
workers, and the explicit invalidation check. Frequency-zero cases observe
the edit immediately in their next requests. Frequency-two cases poll until
both workers return the new source version before explicit invalidation.

| Host | Shared OPcache first new-version response after edit | FILE-only first new-version response after edit |
|---|---|---|
| Node | Minimum observed: **2260.2 ms**<br>Maximum observed: **2960.9 ms** | Minimum observed: **6.5 ms**<br>Maximum observed: **10.1 ms** |
| Chromium | Minimum observed: **2758.8 ms**<br>Maximum observed: **2857.8 ms** | Minimum observed: **8.7 ms**<br>Maximum observed: **16.2 ms** |
| Firefox | Minimum observed: **2510.1 ms**<br>Maximum observed: **2965.0 ms** | Minimum observed: **20.5 ms**<br>Maximum observed: **22.2 ms** |
| WebKit | Minimum observed: **1997.6 ms**<br>Maximum observed: **2860.8 ms** | Minimum observed: **11.0 ms**<br>Maximum observed: **12.6 ms** |

These ranges combine the two database parents and both workers per host/mode.
Shared cases repeatedly return the old version before detection; FILE-only
cases have no old-version response in their first poll batch. The timing starts
after the edit response, uses 50 ms spacing between concurrent batches of eight
requests, and includes request queueing, code compilation, polling and the
recorded background build. The last response reporting old code is an
observation, not a precise invalidation instant. This is a delay measurement,
not an isolated request-performance or exact maximum-delay guarantee.

The exact built PHP source skips validation when its cached revalidation time
is greater than or equal to the request's whole-second timestamp, and schedules
the next time as request-time plus frequency. That condition is consistent
with nearly three seconds at the configured value of two. This experiment
does not claim frequency two guarantees detection within two seconds. The
primary same-freshness policy stays at zero. Application latency for this
policy tradeoff remains unmeasured.

Retained evidence for this milestone: [string PHP freshness](../../.context/timestamp-optimization-20261113/ts02-php-freshness/),
[string PHP micro and static call audit](../../.context/timestamp-optimization-20261113/ts02-php-micro/),
[kernel-cache mechanisms and freshness](../../.context/timestamp-optimization-20261113/ts06-kernel-pre-micro/),
and [cadence policy observations](../../.context/timestamp-optimization-20261113/ts07-policy-pre-timing/).

#### TS-05 clock provider and gate groundwork

The first direct-clock components are implemented in a private checkout;
they are not a supported guest fast-clock path. The component probe passes
74 assertions in Node and63 in each of Chromium, Firefox and WebKit. It
exercises exact pointer/clock/layout certificates, clock normalization,
timeval conversion, stale identities/epochs, split outputs, no writes on
preflight invalidation, malformed control buffers, retirement/exhaustion,
provider fallback and actual gate FIFO/protocol behavior. Certificates are
manually issued in this probe, so these counts do not establish authoritative
kernel range or signal checks. Node additionally exercises its own hrtime
provider; the browser-performance provider is tested on all four hosts.

The first guard could clear busy after a nested ingress while a protocol
transaction remained active. A retained negative control reproduces the
specific error. Nested operation depth and the complete protocol-transaction
state now keep the guard busy. The initial test invocation exited with an
unresolved Promise and no successful receipt; the next attempt hit its
deadline. Both remain failures. The later runner observes fatal completion
explicitly rather than silently awaiting an operation the gate discarded.

The immutable provider and epoch owner are now installed in the actual private
Node/browser kernel-worker path. A normal SDK-built C program passes in all
four hosts, using ordinary clock/gettimeofday syscalls, including coarse and
encoded CPU IDs and rejection of an unsupported clock. The normal trace
shows that wakeup draining follows logical clock completion before detached
publication. An earlier signal dequeue is therefore insufficient authority
for a later fast read. These diagnostic builds must not be used for latency
claims.

The private gate/retry unit files pass48 tests with the normal reporters and
runtime flags. Their focused configuration omits global setup because both
files construct Wasm fixture bytes in memory. Earlier default-config attempts
failed before tests: first dependency lookup, then missing private sysroot
after baseline provisioning. No full-host or persistent-program acceptance
claim follows from the focused run.

Still required: an independently versioned ordinary guest import and normal
SDK/admission integration, late authoritative range/signal certification,
cross-worker publication/write-race treatment, complete signal/fork/thread/
exec and custom/logical-provider integration tests, then PHP freshness and
matched uninstrumented timing. Direct-clock performance remains unmeasured;
this groundwork is not counted as completing TS-05.

#### TS-06 independent PHP loop screen

The first complete cache micro matrix passes32 parents and the strict reader,
with all192 frozen inputs unchanged. This is the independently rebuilt kernel
cache, with identical PHP/profile inputs and opposing baseline/candidate
orders. The loop runs CLI `php -n -r`, clears PHP's stat cache on every
iteration, and does not exercise OPcache request-time validation. The
application/freshness experiments retain validation enabled and frequency
zero; that policy must not be inferred from these CLI loops. Translated
PHP stat-loop candidate/baseline geometric means across the two orders are
1.0010 in Node,0.9839 in Chromium,1.0241 in Firefox and1.0269 in WebKit.
The lstat ratios are1.0064/1.0069/1.0245/1.0433 in the same host order.
No material loop improvement is established; retain the regressions.

The ordinary untranslated-Wasm stat ratios are0.9822/0.9794/0.9728/1.0972;
ordinary missing-path ratios are1.0118/0.8543/0.9387/1.0408. These and all
per-order samples remain in the analysis rather than being normalized away.
The loop includes PHP, marshalling, transport and kernel work; it is not an
isolated cache lookup or a WordPress result.

The registry was quiet at launch, but a peer browser suite started during
the last six WebKit parent intervals. Those rows remain admitted and labeled;
parent overlap is not evidence of exact per-sample CPU contention. The first
WordPress timing matrix was mistakenly launched before inspecting a registry
output that already showed that peer. Its exact owned process group was
terminated before examining elapsed outcomes; the exit143 partial attempt
and decision are retained. Application timing awaits a separate complete
matrix after the peer is terminal. Guest fast-stat remains unimplemented.

Retained evidence: [clock groundwork and failed attempts](../../.context/timestamp-optimization-20261113/ts05-clock-groundwork/)
and [complete cache micro screen and interrupted application attempt](../../.context/timestamp-optimization-20261113/ts06-php-micro/).
The micro scope qualification above takes precedence over the reader's generic
timestamp-policy string; a later scope addendum records the same correction.

#### TS-06 complete WordPress screen

The separate complete matrix passes48 fresh parents and its strict reader,
with all192 frozen inputs unchanged. Both opposing orders use the same
ordinary/translated PHP binaries and host profile; only the independently
rebuilt kernel cache differs. Four SQLite WordPress pages have two warmups
and five measured rounds per parent, with ordinary controls bracketing the
translated cases. Effective timestamp validation is1 and frequency0. The
earlier16parent source-edit gates cover both SQLite and MariaDB; MariaDB
application latency was not measured in this screen.

| Host | Translated candidate/baseline | Ordinary candidate/baseline | Candidate translated / own ordinary |
|---|---:|---:|---:|
| Node |0.9746|0.9266|1.9677|
| Chromium |1.0058|0.9893|1.6353|
| Firefox |0.9733|1.0358|1.4936|
| WebKit |1.0001|0.9880|1.3028|

These are geometric means of four page-median ratios and the two orders,
not confidence intervals. Ordinary is untranslated Wasm in the same engine.
The last column includes shared-versus-FILE OPcache configuration, so it does
not isolate address-translation cost. Node's order aggregates are1.0137 and
0.9370; Firefox's are0.9353 and1.0129. Both reverse direction. Chromium's
orders are1.0038/1.0078; WebKit's are1.0011/0.9992. Ordinary after/before
page ratios range0.9274–1.3435 in Node,0.9846–1.0290 in Chromium,
0.9270–1.0925 in Firefox and0.9565–1.0425 in WebKit.

The launch registry had no competing build/test, but a later peer memory
gate overlaps41 parent intervals: five Node and all36 browser parents.
All rows remain admitted and the exact intervals are saved. Recorded
one-minute load spans1.96–9.99. These small mixed results and control/order
variation do not establish a reliable common speedup. No preset is selected.
Keep this conservative cache and the ideas for more precise invalidation;
the distinct guest fast-stat route remains unimplemented.

The clock declaration meanwhile builds through the edited private xtask;
normal extension generation and its check pass. Four focused WAT/host unit
tests also pass, alongside the earlier48 gate/retry tests. They exercise
exact namespace/signature admission, missing-host rejection, real worker
namespace fallthrough with unchanged output and borrowed-memory refusal.
The supplied successful query in one test is a mock, not a direct clock.
No normal SDK guest has used this extension or received a fast-clock
certificate yet. Direct-clock performance remains unmeasured.

The extension snapshot check passes when explicitly bound to the frozen
baseline kernel: the base snapshot and generated ABI headers stay current.
The initial invocation without the required kernel path failed and is
retained. This does not prove a newly built kernel admits the new extension,
SDK integration, browser namespace execution or full platform compatibility.

The [verified application archive](../../.context/timestamp-optimization-20261113/ts06-application-verified/)
retains the full48-parent matrix, source/input preimages, peer overlap,
micro-scope addendum and clock declaration tests. The first archival attempt
failed on an absolute script path; its partial directory is not an accepted
archive. A new append-only stage passed readback verification. Original
failure logs and script are retained in the verified stage.

#### TS-05 real guest and libc integration

The direct-clock path now executes through normal SDK/fork-prepared programs,
not just manually certified component calls. An independently versioned
`kandelo.clock.v1` import returns success or explicit fallthrough. The kernel
worker publishes a bounded independent shared certificate record, bound to
the exact PID/TID/image owner and original clock/output pointer. Every kernel
entry invalidates its epoch. A new optional read-only kernel query verifies
live, running, single-threaded task state and no deliverable signal after
wakeup draining, before detached publication. Native output views are freshly
preflighted against current virtual permissions/physical bounds. Unsupported
or stale state uses the ordinary syscall. Time is sampled on every fast call
from the same immutable provider authority used by fallback; it is not a
periodically cached timestamp.

Eight explicit-extension parents pass across ordinary/translated Wasm on
Node, Chromium, Firefox and WebKit. Each performs512 valid clock queries
across realtime/monotonic/process/thread/coarse/boottime/encoded CPU IDs,
checks monotonic readings, output fields and invalid-ID fallthrough. They use
500–504 fast calls per parent; these counts do not measure latency. The
first SDK attempts correctly reject the interface: the native validator's
implemented-namespace list also needed updating. The private SDK driver
freshness stamp now includes its program-ABI and artifact-validator sources.
Normal native admission tests pass2 cases; focused host tests still pass52.

An opt-in libc hook calls the extension before normal clock syscalls,
preserving fallback, errno, pointer narrowing and the original signal flags.
Internal deferred-delivery clocks and cancellation-point requests keep the
ordinary path. Default glue does not import the extension. A normal libc
probe makes512 clock_gettime calls,32 gettimeofday calls and one invalid-ID
check; all16 baseline/direct × ordinary/translated × host parents pass.
Diagnostic clock RPC counts are:

| Host | Baseline ordinary | Baseline translated | Direct ordinary | Direct translated |
|---|---:|---:|---:|---:|
| Node |545|545|3|3|
| Chromium |545|545|3|3|
| Firefox |545|545|5|5|
| WebKit |545|545|5|3|

These are dispatch counts from diagnostic profiles, not performance ratios.
The private diagnostic profile now exposes copied count records on browser
hosts too. Uninstrumented builds remove the temporary clock trace calls;
latency must be measured separately and include guard/fallback overhead.

Eight advanced explicit-extension parents and eight libc-enabled advanced
parents also pass across both memory models/all hosts. They exercise
split-page output, protection changes/unmap refusal, a live sibling forcing
normal fallback, signal-handler clock reentrancy, blocked pending signals,
POSIX timer SIGALRM delivery during a fast loop, ppoll interruption, fork
rebinding and exec replacement. This is bounded mechanism coverage, not full
POSIX, memory-retirement or production acceptance.

Two failed advanced attempts are retained. A repeating2ms setitimer test
receives only one alarm; a separate control with the old kernel/host and no
clock extension also observes one SIGALRM in2.2seconds. Source rounds the
initial alarm to whole seconds and never rearms its stored interval. The
rapid signal test therefore uses the existing POSIX timer API, and the POSIX
status now records the setitimer limit. The first control harness also fails
after guest exit by requesting an unavailable diagnostic getter; the fixed
complete control retains the same guest observation.

Translated sibling startup originally traps at the one-time root initializer.
The private profile now explicitly binds siblings to an initialized root,
allocates separate per-worker scatter-copy scratch and drops their active
segments without replaying process data. The helper's explicit sibling mode
is private to these artifacts. This does not establish concurrent-remap or
general multithreaded acceptance; clock acceleration still refuses siblings.

Still open: actual custom/logical-provider integration checks; synchronization
when a clock output resides in shared/file/device-backed mappings, with
conservative refusal if needed; matched uninstrumented timing; PHP relink,
timestamp freshness and application measurements; and full acceptance. The
existing preview, timestamp policy and selected kernel are unchanged. No
clock latency or PHP improvement is claimed from the RPC reduction.

### TS-05 provider and shared-mapping follow-up

Real normal-worker custom-provider fallback passes8 parents across all four hosts in ordinary and translated memory. Node deterministic-build logical-clock fallback passes2; the browser intentionally has no such public setting. Mapping checks pass8 parents: ordinary anonymous shared, file-backed shared and SysV attachments refuse fast clocks, including private stack outputs, to retain the normal boundary's publication/import work. Translated anonymous mappings already use the same physical bytes and keep fast clocks; translated file-backed and SysV mappings refuse. Recovery after unmap/detach and file readback pass. This is promising for anonymous shared OPcache but PHP timing is still unmeasured. The first translated test incorrectly demanded fallback for physical anonymous sharing; all4 failed expectation rows remain retained alongside the corrected test and an old-profile ordinary negative control.

Mechanism/source retention: `.context/timestamp-optimization-20261113/ts05-real-guest-libc` (40 parents; index SHA25612b1f534774f56b8d550b868d85a2af66dc62bb3e2a74a4cda22848d16df4174) and `.context/timestamp-optimization-20261113/ts05-provider-mapping-fallback`. Neither is latency/PHP/full-platform acceptance.

#### TS-05 first uninstrumented timing screen

The synthetic normal-libc loop now passes32 parents across Node/Chromium/Firefox/WebKit, baseline/direct × ordinary/translated × two opposing orders. Each parent runs two warmup and five measured rounds of20000 clock_gettime and20000 gettimeofday calls. All350 frozen inputs are unchanged. The private runtime creates records only when the main program actually imports the clock extension, avoiding late eligibility-query work for baseline programs. A renewed16-parent libc dispatch/8-parent advanced signal/fork/exec screen passes after that change, and the private host typecheck passes. Timing bundles omit diagnostics/trace-call overhead; the same profile serves both sides. This is an incremental prototype comparison, not a full destination-main benchmark.

Clock_gettime ordinary baseline→direct µs/call by host: Node23.666→0.371, Chromium24.551→0.483, Firefox29.839→0.597, WebKit31.434→0.483. Translated: Node72.298→0.502, Chromium56.891→0.569, Firefox71.186→0.710, WebKit65.969→0.585. Per-host/kind/order data and labeled ratios are in the survey; gettimeofday also improves in both orders on all hosts. These are geometric means of two parent medians, without confidence intervals, including the common loop/check work. No shared mapping, PHP, OPcache validation or application workload is measured here. PHP relink/freshness/app timing remain pending.

Raw plan: `.scratch/timestamp-clock-timing-plan-2/manifest.json`; strict reader: `.scratch/timestamp-clock-timing-analysis-1/analysis.json`. The first freeze script expected a disabled diagnostic metadata key rather than its actual absence and failed before running any timing; the failed attempt is preserved.

#### TS-05 PHP-FPM freshness and application screen

Normal private SDK/glue relinking preserves frozen completed CALL/O2/no-LTO PHP objects and dependencies; baseline CLI/FPM hashes exactly reproduce previous artifacts. Preopt/fork preparation/ABI stamping precede translation.16 direct-hook freshness parents pass on SQLite/MariaDB, ordinary/translated and all four hosts, with timestamps1/frequency0 and both workers seeing edited source before explicit invalidation.

The separate uninstrumented SQLite WordPress48-parent screen passes all187 frozen inputs unchanged. It uses four pages, two warmup/five measured rounds, opposing orders and ordinary before/after brackets. Translated direct/baseline four-page means are Node0.9915, Chromium0.9750, Firefox0.9872, WebKit0.9856. Ordinary means are1.0056/0.9996/1.0132/1.0149. Direct translated/own ordinary means1.8919/1.4572/1.4737/1.2117 include shared-vs-FILE OPcache configuration and are not pure translation overhead. Both orders favor the translated hook overall on every host; retain WebKit first-order article1.0165 regression. Ordinary per-page after/before drift0.9265..1.0563 and load1.62..5.04 are retained; no other managed build/test is visible in the pre/post registry records. No confidence interval, PHP fast-hit census or CPU attribution is claimed.

This is a secondary candidate: its50..144× synthetic clock-loop gain shrinks to roughly0.9..2.5% translated WordPress time reduction, with flat/slower ordinary results. The result does not identify clocks as a dominant PHP bottleneck or justify a common preset. Keep it for combinations and actual hit/miss diagnostics later. Retained stage: `.context/timestamp-optimization-20261113/ts05-php-freshness-application`. Full production acceptance, device-output boundaries and the broader timestamp campaign remain open.

#### TS-02 complete independent WordPress pairs

The byte-page and word-page scanner application comparisons each pass48 fresh parents/all208 frozen inputs unchanged on Node/Chromium/Firefox/WebKit. Each baseline is generic translation of the same byte/word function; ordinary candidate/control artifacts are identical and their ratio is temporal control variation. Timestamps1/frequency0, four SQLite pages, two warmup/five measured rounds, opposing orders and ordinary brackets are retained. No clock, new cache, scalar or short-copy factor is added.

Translated page/generic byte ratios .9890/1.0016/.9938/.9821; word1.0006/.9989/1.0145/.9759. The byte result is small/mixed and reverses by order in Chromium; word regresses in Firefox and reverses by order in WebKit. Per-page/order, identical-code control drift and host load remain in the survey/raw evidence; no common preset or confidence claim. Keep both variants for future workloads, not just the favorable host. Both-database freshness gates from the earlier TS02 stage remain valid. Retained stage `.context/timestamp-optimization-20261113/ts02-application-pairs`; remaining campaign items include finer cache invalidation, guest fast-stat, cadence application latency and combinations.

#### TS-07 enabled-timestamp cadence application screen

The separate frequency0versus2 SQLite WordPress screen passes48 parents/all268 frozen inputs unchanged, across all four hosts and both memory models with opposing orders/ordinary brackets. The reader checks actual frequency2 rather than assuming0. Translated policy ratios Node/Chrome/Firefox/WebKit .7369/.7962/.8188/.7680; ordinary .9991/1.0028/.9900/.9934. Frequency-two VM/own ordinary1.4342/1.2039/1.2616/.9916 includes shared-vs-FILE cache configuration and different observed freshness, not pure translation overhead. Per-page/order/load/control drift remain in the survey/archive.

This18..26% translated reduction comes with the earlier observed1.998..2.965second shared-code detection delay, including poll/queueing effects. Validation stays enabled, but this is not equal freshness, a stat CPU attribution or a default recommendation. Primary frequency0 and the preview remain unchanged. The result makes validation work worth investigating; the unimplemented guest fast-stat route remains an actual open item. Retained stage `.context/timestamp-optimization-20261113/ts07-application-timing`, alongside the earlier32-parent policy/freshness stage.

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


## Format-2 stop-check measurement and placement candidate — 2026-11-14

Required execution-stop polls have a new [standalone instruction report](2026-11-14-common-memory-stop-overhead.md), separate from the historical C/PHP timings. All four hosts pass return/full-memory/revocation controls. Two fresh parent cohorts per host retain 1,296 alternating-order samples. WebKit arithmetic stop increment is 75.1%/74.4%; WebKit calls is 249.5%/248.2%; Firefox atomics is 45.6%/45.7%, each relative to unchecked translation. The report retains every operation, including small differences that do not establish gains. No current-format PHP request estimate is inferred.

Retain **safe poll placement through bounded callees and call-graph cycle analysis** as an unimplemented optimization candidate. A bounded leaf may not need an entry poll when a proven caller bound already guarantees timely polling. Recursive and indirect-call cycles, unbounded loops, long imports, concurrent revocation, kill latency and writes after reported death all need explicit coverage before omitting a check. Do not disable checks or weaken death publication to gain speed. This proposal does not repair cancellation of an indefinite native atomic wait; that remains a separate protocol boundary. Earlier unsuccessful instrumentation and timestamp ideas remain in the catalog unchanged.

Evidence: `.context/common-memory-stop-overhead-20261114/evidence-v2.zip` and its checksum manifest. The original archive is preserved; v2 corrects only the report's rebuild command and archive pointer. Stop checks stay enabled in the integrated profile.

## Ordinary-runtime integration comparison — 2026-11-14

The [full canonical comparison against pinned main](2026-11-14-common-memory-default-regression.md)
now covers all nine enabled suites on Node and Chromium, three rounds per suite
and both orders across eight fresh CLI parents. Every result matches its final
canonical input inventory. Node stdin throughput falls in both orders; Node
exec and dense file-replacement locking time rise in both. Two Chromium database
metrics also exceed the descriptive five-percent threshold in both orders.
The report retains every metric, the order-sensitive WordPress result, artifact
differences, legacy ABI warnings and interrupted preparation attempts. This is
a whole-candidate ordinary-runtime comparison, including preserved unrelated
changes, not a causal feature attribution or current translated-PHP timing.
The original optimization and timestamp measurements above remain unchanged.

## November 14: current-contract application and OS resource follow-up

The [current application report](2026-11-14-common-memory-application-impact.md)
now compares ordinary FILE-only FPM, instrumented FILE-only FPM and the exact
same instrumented executable with shared OPcache. Timestamp validation stays
enabled with zero revalidation interval. There are 48 timing parents and 48
analyzed resource parents across both databases and all four hosts. Twelve
additional tree-only WebKit resource parents are retained and uniformly
excluded after a predeclared correction includes detached WebKit XPC services.
These format-2 results do not overwrite the earlier survey or turn its negative
results into discarded ideas.

| Follow-up idea | Current evidence | Next proof needed |
|---|---|---|
| Whole-host allocation and executable-state profiling | SQLite guest mapped reduction with sharing: **24.375 MiB**<br>Node/SQLite shared footprint, first order: **3391.3 MiB**<br>Node/SQLite ordinary footprint, first order: **2738.0 MiB** | Establish which allocations cause the difference; guest counters do not explain the OS total. No engine-defect or leak attribution is established. |
| Smaller scratch, retained RT-01 candidate | Current scratch per root: **8 MiB**<br>Current three-root runtime allocation: **24.4375 MiB**<br>Earlier logical saving with smaller scratch: **21 MiB** | Repeat current-contract large scatter/copy and lifecycle controls, then measure OS footprint separately. Earlier capacity savings are not current RAM or speed proof. |
| Remove inherited FILE-cache data from shared-mode images | Source objects: **1500**<br>Source logical bytes: **45251192 B** | Check all PHP consumers before changing the image. The controlled fixture removes the data from every arm; this does not measure live-preview RAM savings. |
| Ordinary/translated executable selection within one package | Instrumented FILE / ordinary FILE request-time range: **1.92–2.90×**<br>Shared / instrumented FILE request-time range: **0.50–0.60×** | Current one-binary cache selection works only in the translated runtime. An ordinary-speed dual path or automatic two-artifact package selection is not implemented. Ranges summarize four-page median ratios, not every request. |
| Larger worker pools and sustained workloads | FPM workers per tested pool: **2** | Measure scaling before estimating a break-even point; private heaps, runtime roots and engine state can grow alongside sharing benefits. |

Node's shared-mode footprint is higher than both controls in both databases and
orders. Chromium improves relative to instrumented FILE-only but remains above
ordinary FILE-only. Firefox/SQLite has a modest observed footprint reduction;
the other cases do not establish a general memory win. WebKit/MariaDB is near
ordinary request latency, while most other shared-mode application cases remain
slower. Keep the feature opt-in while retaining every optimization candidate
and the prior adverse ordinary-runtime results for further investigation.

## November 14 follow-up proposals: cache seeding and change-driven invalidation

These are proposed experiments, not changes to the preview or measured wins.
The current profile retains timestamp validation with zero revalidation interval.

**Persistent compiled cache feeding shared OPcache.** PHP supports a second-level
`opcache.file_cache` while `opcache.file_cache_only=0` keeps shared caching
enabled. Generate a compatible seed with the deployed PHP build, source paths,
extensions and settings, then test loading it into shared memory on demand.
Keep timestamp and cache-consistency checks initially. Do not assume the
inherited ordinary-build cache is compatible with the instrumented FPM build.
If this works, a matching seed becomes an alternative use for FILE-cache image
data that shared-only mode currently leaves unused. Count image transfer/load,
cache restoration, service startup, first response, warm latency and OS footprint;
moving compilation before the timer is not a total-startup improvement. See
[PHP's configuration reference](https://www.php.net/manual/en/opcache.configuration.php).

Normal FPM requests or `opcache_compile_file()` within the running FPM cache
can also warm ordinary cache entries. That can move work before navigation,
but does not eliminate it. This differs from PHP's native `opcache.preload`:
preloaded definitions persist until process restart. The older full-preload
experiment above increased startup time/allocation and does not establish a
result for selective seeding in the current profile. Native preloading is not
the initial candidate for editable code; see [PHP's preload lifecycle](https://www.php.net/manual/en/opcache.preloading.php).

**Change-driven opcode invalidation.** A future policy could disable repeated
timestamp checks while authoritative filesystem change generations drive cache
invalidation inside the FPM pool. Shared OPcache makes the opcode invalidation
common to its workers. Coherence must be established before subsequent requests
reuse stale code; an asynchronous UI watcher callback alone is insufficient.
Account for writes/truncation, open descriptors, replacement/deletion, aliases,
path-resolution caches and namespace changes. An ambiguous event, overflow or
untracked provider must force conservative invalidation/restart or retain
timestamp validation; the fallback also needs an ordering proof.

The existing [`subscribeVfsChanges` event contract](../../host/src/vfs/types.ts)
explicitly provides bounded hints emitted on writable-handle close or name
changes, omits memory-mapped writes, and reports overflow as a modified prefix.
The [kernel queue](../../crates/runtime-core/src/fs_changes.rs) and deferred
observer delivery are useful groundwork, not a complete coherence protocol.
Test same-size/same-mtime edits, still-open writers, rename/delete/link changes,
overflow and concurrent requests on both FPM workers before disabling checks.
This differs from TS-06 metadata caching: it replaces PHP's validation policy
instead of accelerating individual metadata queries. No implementation or
speedup estimate is claimed yet.
