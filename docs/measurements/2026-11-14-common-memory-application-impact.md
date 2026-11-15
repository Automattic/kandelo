# Current PHP-FPM memory and latency impact — November 14, 2026

Shared OPcache works with the current execution-stop contract and timestamp
validation, but this two-worker WordPress comparison does **not** support
making translated FPM the general default. Shared OPcache takes 0.50–0.60 times
the instrumented FILE-only request time across the four-page comparisons. It
usually remains slower than ordinary Wasm, and whole-host memory cost is often
higher even when guest mapped bytes fall. WebKit/MariaDB is near ordinary
latency in this sample; Firefox/SQLite has a modestly lower observed footprint.
Neither observation establishes statistical significance or a general win.

One instrumented binary can select either cache backend at service startup.
Both modes still require the translated-memory host and group. The ordinary
loader refuses that binary; there is no ordinary-speed execution path inside
it today. Keeping one deployment package with two executable variants is a
possible future packaging choice, not an implemented automatic selection path.

## Controls and method

| Configuration | FPM executable | OPcache backend |
|---|---|---|
| Ordinary FILE | Normal, untranslated Wasm | FILE-only |
| VM FILE | Current translated Wasm | FILE-only |
| VM shared | **Same executable as VM FILE** | Anonymous shared memory |

"Native" in raw arm identifiers means ordinary Wasm, not machine-native PHP.
All configurations use the same source-built experimental host profile and
matching kernel; ordinary programs use separate linear memories and create no
translated roots. The ordinary-runtime target-branch benchmark is a separate
comparison. VM/ordinary includes experimental PHP build and direct-clock
changes as well as translation; it is not a pure translation tax. VM shared/VM
FILE compares backend selection in exactly the same binary.

PHP is 8.5.12; WordPress uses SQLite or MariaDB, two FPM workers plus the master,
32 MiB configured OPcache, PHP JIT disabled, timestamp validation enabled, and
`opcache.revalidate_freq=0`. Homepage, article, authenticated admin and REST
posts responses are checked. Admin login, both worker PIDs, the configured
cache backend and actual shared cache population are required. Separate SQLite
source-edit controls pass on Node, Chromium, Firefox and WebKit; their timings
were collected under build load and excluded from this comparison.

The source image contains 1,500 prebuilt FILE-cache objects totaling 45,251,192
logical bytes (43.2 MiB). The controlled fixture removes these from **every**
configuration, leaves empty directories and removes the baked-in FPM. Each
parent installs the selected binary through the ordinary worker-owned VFS
before starting services. OS caches are not flushed. The live preview still
uses its original image; these fixture footprints do not describe that
preview's RAM directly. Reusing a previously populated cross-build FILE cache
was not part of the comparison.

There are 48 fresh timing parents: three configurations, both databases, four
hosts and two opposite configuration orders. Each parent performs four warmup
rounds and seven measured rounds of four pages: 1,344 measured requests. Each
page's seven samples produce one median per parent; the ratios below are the
geometric mean of the four page-median ratios, keeping both orders separate.
This is post-four-round sequential request latency, not saturation throughput
or proof of fully settled, long-running performance.

Resource runs use separate fresh parents, four warmup and three sampled
rounds. Their request durations are excluded from latency analysis. Each
reported footprint is the median of three warm checkpoints in one parent.
There are 48 analyzed resource parents and 144 warm OS samples. Two parents per
case do not support confidence intervals or statistical-significance claims;
rounds and checkpoints within a parent are correlated.

Environment: Apple M5 Max, 18 logical CPUs and 48 GiB memory; macOS arm64.
Node 24.15.0, Chromium 153.0.8010.12, Firefox 155.0 and Playwright WebKit 26.6.
Observed minimum timer increments are approximately 0.000041 ms, 0.005 ms,
0.020 ms and 0.020 ms respectively. Existing previews remain running. Build
jobs completed before timing began and the two timing campaigns run serially;
load averages are retained. This does not prove whole-machine idleness.

## Warm request latency

Smaller ratios favor the numerator. Order 1 is ordinary FILE, VM FILE, VM
shared; order 2 reverses that order. Each number has its own label and line.

| Host / backend | VM FILE / ordinary FILE | VM shared / ordinary FILE | VM shared / VM FILE |
|---|---|---|---|
| node / sqlite | Order 1: **2.834×**<br>Order 2: **2.899×** | Order 1: **1.700×**<br>Order 2: **1.691×** | Order 1: **0.600×**<br>Order 2: **0.583×** |
| node / mariadb | Order 1: **2.666×**<br>Order 2: **2.628×** | Order 1: **1.383×**<br>Order 2: **1.406×** | Order 1: **0.519×**<br>Order 2: **0.535×** |
| chromium / sqlite | Order 1: **2.340×**<br>Order 2: **2.336×** | Order 1: **1.382×**<br>Order 2: **1.380×** | Order 1: **0.591×**<br>Order 2: **0.591×** |
| chromium / mariadb | Order 1: **2.143×**<br>Order 2: **2.095×** | Order 1: **1.134×**<br>Order 2: **1.133×** | Order 1: **0.529×**<br>Order 2: **0.541×** |
| firefox / sqlite | Order 1: **2.604×**<br>Order 2: **2.577×** | Order 1: **1.424×**<br>Order 2: **1.408×** | Order 1: **0.547×**<br>Order 2: **0.546×** |
| firefox / mariadb | Order 1: **2.249×**<br>Order 2: **2.296×** | Order 1: **1.151×**<br>Order 2: **1.149×** | Order 1: **0.512×**<br>Order 2: **0.500×** |
| webkit / sqlite | Order 1: **2.287×**<br>Order 2: **2.230×** | Order 1: **1.189×**<br>Order 2: **1.215×** | Order 1: **0.520×**<br>Order 2: **0.545×** |
| webkit / mariadb | Order 1: **1.945×**<br>Order 2: **1.917×** | Order 1: **0.997×**<br>Order 2: **0.983×** | Order 1: **0.512×**<br>Order 2: **0.513×** |

Shared OPcache recovers a substantial part of the instrumented FILE-only cost.
Its ratio to ordinary FILE is about 1.69–1.70 on Node/SQLite, 1.38–1.41 on
Node/MariaDB, and 1.13–1.42 across Chromium/Firefox cases. WebKit/SQLite is
1.19–1.22; WebKit/MariaDB is 0.983–0.997. Small near-parity differences should
not be treated as an established speedup. Page-level medians below retain
workload differences hidden by the four-page geometric mean.

## OS footprint

These are the macOS `footprint` tool's reported totals for selected host OS
process sets, **not per-FPM RSS** and not guest byte counters. Node includes
its Worker threads. Chromium and Firefox include the owned browser launch
process and `ps`-visible descendants. WebKit also includes the newly launched
WebContent, GPU and networking XPC services from its exact Playwright build.
Other unrelated or unestablished detached services are outside these scopes.
The physical-footprint charge metric is not identical to resident RAM; the
probe retains the tool's raw output rather than summing `ps` RSS.

| Host / backend | Ordinary FILE | VM FILE | VM shared |
|---|---|---|---|
| node / sqlite | Order 1 footprint: **2738.0 MiB**<br>Order 2 footprint: **2688.2 MiB** | Order 1 footprint: **2821.2 MiB**<br>Order 2 footprint: **2798.5 MiB** | Order 1 footprint: **3391.3 MiB**<br>Order 2 footprint: **3296.2 MiB** |
| node / mariadb | Order 1 footprint: **4461.4 MiB**<br>Order 2 footprint: **4546.3 MiB** | Order 1 footprint: **4011.3 MiB**<br>Order 2 footprint: **3861.7 MiB** | Order 1 footprint: **5069.2 MiB**<br>Order 2 footprint: **4961.3 MiB** |
| chromium / sqlite | Order 1 footprint: **2046.3 MiB**<br>Order 2 footprint: **2076.3 MiB** | Order 1 footprint: **2268.2 MiB**<br>Order 2 footprint: **2299.4 MiB** | Order 1 footprint: **2206.9 MiB**<br>Order 2 footprint: **2168.6 MiB** |
| chromium / mariadb | Order 1 footprint: **2807.0 MiB**<br>Order 2 footprint: **2764.1 MiB** | Order 1 footprint: **3007.9 MiB**<br>Order 2 footprint: **3008.8 MiB** | Order 1 footprint: **2950.6 MiB**<br>Order 2 footprint: **2905.0 MiB** |
| firefox / sqlite | Order 1 footprint: **1999.9 MiB**<br>Order 2 footprint: **1984.8 MiB** | Order 1 footprint: **2045.8 MiB**<br>Order 2 footprint: **2046.1 MiB** | Order 1 footprint: **1940.6 MiB**<br>Order 2 footprint: **1949.4 MiB** |
| firefox / mariadb | Order 1 footprint: **2332.0 MiB**<br>Order 2 footprint: **2373.4 MiB** | Order 1 footprint: **2462.1 MiB**<br>Order 2 footprint: **2489.0 MiB** | Order 1 footprint: **2469.9 MiB**<br>Order 2 footprint: **2423.9 MiB** |
| webkit / sqlite | Order 1 footprint: **1898.9 MiB**<br>Order 2 footprint: **1960.1 MiB** | Order 1 footprint: **2823.0 MiB**<br>Order 2 footprint: **2675.1 MiB** | Order 1 footprint: **3032.1 MiB**<br>Order 2 footprint: **2593.2 MiB** |
| webkit / mariadb | Order 1 footprint: **2467.2 MiB**<br>Order 2 footprint: **2449.4 MiB** | Order 1 footprint: **2780.5 MiB**<br>Order 2 footprint: **3026.4 MiB** | Order 1 footprint: **3703.2 MiB**<br>Order 2 footprint: **3697.9 MiB** |

Node shared-mode footprint is higher than both controls in both databases and
orders. Chromium shared mode is lower than instrumented FILE-only, but remains
above ordinary FILE-only. Firefox/SQLite is modestly below both controls;
Firefox/MariaDB remains above ordinary, with mixed order effects against VM
FILE. WebKit shared mode remains above ordinary in both databases and orders;
its SQLite comparison with VM FILE changes direction. No general host-memory
saving is established.

The observations include service Workers, engine allocations, executable state,
image and transport buffers, kernel memory and guest backing. They do not
identify the cause of the additional footprint. Some checkpoint values change
substantially within a parent, so the reported median describes this window,
not a proven long-term plateau, peak requirement or teardown release rate.
A larger OS total is not evidence of an engine defect or a leak.

### WebKit probe correction and excluded samples

A process-tree-only probe misses WebKit's detached XPC services, including the
WebContent process that executes the page and Workers. This was discovered
and the correction declared after 67 primary parents, **before any original
WebKit resource parent started**. All twelve original WebKit resource cases
are excluded uniformly from engine footprint comparisons, regardless of their
values. They remain retained. All twelve are repeated with the same guest
inputs/settings and an XPC-aware probe; latency parents are unchanged.

The corrected probe requires no pre-existing process from this exact cached
WebKit build, one owned launcher, newly created XPC services and an included
WebContent process. It refuses ambiguous build ownership. Thus 108 parents
were collected and 96 analyzed; twelve tree-only resource parents are retained
as excluded. Every analyzed warm footprint reports its selected PIDs, has no
missing selected process, no tool error and no warning. This establishes
coverage of the stated process sets, not every browser-related OS allocation.

## Guest mappings and the single-binary question

The guest counter comparison is reproducible across all four hosts and both
orders. FPM's unique mapped bytes fall from 156.0625 MiB in instrumented
FILE-only mode to 131.6875 MiB with shared OPcache for SQLite, and 131.5625 MiB
for MariaDB. These are reductions of 24.375 MiB and 24.500 MiB respectively.
They do not predict the OS footprint above.

The shared column per FPM process is 64 KiB in FILE-only mode, or 32 MiB plus
64 KiB in shared-OPcache mode. FPM's scoreboard uses shared anonymous memory
independently of OPcache. Adding the three processes' shared columns would
count the same backing repeatedly. Attributed bytes divide actual mappings
among their users; the group total counts page identities within the Wasm
backing once.
Every resource snapshot reconciles attributed FPM bytes to the group's unique
mapped bytes and all allocation buckets to backing capacity.

The current group also allocates 24.4375 MiB for runtime metadata and scratch
across three FPM roots. It retains the same 512 MiB pregrown backing capacity
in both modes. Capacity, allocator consumption, mapped payload and resident
memory are different quantities. Ordinary linear-buffer totals and translated
mapped-page totals have different coverage and should not be compared as
identical measures of used heap.

FILE-only cache inventory is 564 files / 24,456,240 logical bytes for SQLite,
and 547 files / 23,809,448 bytes for MariaDB. Shared mode has zero FILE-cache
objects. These logical VFS lengths are not RAM measurements. The cache status
endpoint reports a populated shared cache on both workers.

Changing OPcache configuration at startup therefore works with one instrumented
artifact, but does not remove translation, execution-stop polls, root metadata,
scratch or group reservation. A normal built-host negative control refuses
it with `requires the opt-in common-memory prototype host` and reported exit -1;
cleanup succeeds. No runtime hot switch or ordinary-loader fast path is claimed.

## Recommendations and retained ideas

1. Keep the feature opt-in for software requiring real shared pointer graphs.
   This is useful semantics; a universal WordPress speed/RAM benefit is not
   supported by the current small-pool measurements. Retain ordinary FPM for
   the ordinary path rather than selecting instrumented FILE-only as a default.
2. Profile whole-host allocation and executable/Worker costs separately from
   request timings. The OS footprint is much larger than the guest mapping
   delta. Establish the cause before attributing it to translation, an engine
   or a leak; these samples alone do not do so.
3. Revisit the catalog's smaller-scratch experiment. The integrated profile
   still allocates 8 MiB per root. Earlier 1 MiB experiments saved 21 MiB of
   logical allocator capacity for three roots; they do not prove current
   execution-stop/scatter behavior, host-RAM savings or a speedup. Current
   large-payload and lifecycle controls are required before promotion.
4. Review inherited FILE-cache data in the shared-mode image, including other
   PHP consumers, before removing it. The 43.2 MiB logical source corpus is a
   concrete image-hygiene lead, not an established RAM saving.
5. Measure larger worker pools and sustained workloads before estimating a
   break-even point. Shared-cache benefit may amortize differently, while
   private heaps, translated roots and engine costs can also grow. Two workers
   do not justify a linear extrapolation. Keep the earlier optimization
   catalog, including negative results, for these follow-ups.

The [ordinary-runtime comparison](2026-11-14-common-memory-pr-regression.md)
separately evaluates the committed PR against pinned main. Application success
here does not clear its regression leads or the prototype's documented native
atomic-wait cancellation boundary, earlier intermittent startup stall, broader
source-test failures or remaining release acceptance work. See the
[current prototype scope](../experimental-common-memory.md).

## Inputs, reproduction and retained evidence

Runtime candidate: `897db3712f83a92c55925846853efa97bd27b450`, with a source-built
profile whose 335 runtime input hashes and six output module hashes are
retained. Image SHA-256:
`8b8b4f33323692706d7187e36be3d672551d0beee2c0917ffc01f6e9c4f0b729`.
Ordinary FPM SHA-256:
`68155a156fa1aa617a24ecb4f4c42b91a3d81b30e64c65a8e8c0fe1afa02988f`.
Both VM modes use FPM SHA-256:
`25b9dcd2abf21ac4ab38a7c3728b7122cbe6d27a908b1ef6dd311cd3e948a294`.
Kernel SHA-256:
`49c28e914e319db4c762f97a7ba655c0742e29d4dff1b73452071f2ef383de83`.

Use the [impact fixture instructions](../../tools/common-memory-program/impact/README.md)
for preparation, fresh-parent execution and strict analysis. Frozen plans,
raw request/checkpoint results, OS tool JSON/text, selected PID provenance,
source/artifact hashes, original failed controls and excluded WebKit samples
are retained under `.context/common-memory-application-impact-20261114/`.
The archive manifest records read-back verification. Its content-addressed
input store permits offline reanalysis without the original absolute checkout
paths. Earlier missing browser discovery and ordinary-loader probe errors are
kept as failed preparation attempts, not application or performance passes.
The slow debug build-finalization attempt was stopped and resumed through the
proper release build tool; its profile/log and successful normal build are
retained separately from the measured parents.

## Service startup and first homepage

These seconds include service launch and the first successful homepage,
including readiness retries; image/host initialization and FPM installation
precede the timer. Guest FILE caches start empty. This does not estimate the
cold start of a previously populated FILE-cache image.

| Host / backend | Ordinary FILE | VM FILE | VM shared |
|---|---|---|---|
| node / sqlite | Order 1 first homepage: **2.72 s**<br>Order 2 first homepage: **2.70 s** | Order 1 first homepage: **12.00 s**<br>Order 2 first homepage: **12.11 s** | Order 1 first homepage: **6.95 s**<br>Order 2 first homepage: **7.00 s** |
| node / mariadb | Order 1 first homepage: **2.81 s**<br>Order 2 first homepage: **2.79 s** | Order 1 first homepage: **11.39 s**<br>Order 2 first homepage: **11.22 s** | Order 1 first homepage: **6.35 s**<br>Order 2 first homepage: **6.46 s** |
| chromium / sqlite | Order 1 first homepage: **2.94 s**<br>Order 2 first homepage: **2.91 s** | Order 1 first homepage: **10.47 s**<br>Order 2 first homepage: **10.36 s** | Order 1 first homepage: **6.53 s**<br>Order 2 first homepage: **6.51 s** |
| chromium / mariadb | Order 1 first homepage: **4.43 s**<br>Order 2 first homepage: **4.47 s** | Order 1 first homepage: **11.12 s**<br>Order 2 first homepage: **11.17 s** | Order 1 first homepage: **7.31 s**<br>Order 2 first homepage: **7.39 s** |
| firefox / sqlite | Order 1 first homepage: **2.70 s**<br>Order 2 first homepage: **2.76 s** | Order 1 first homepage: **11.59 s**<br>Order 2 first homepage: **11.54 s** | Order 1 first homepage: **6.56 s**<br>Order 2 first homepage: **6.42 s** |
| firefox / mariadb | Order 1 first homepage: **3.67 s**<br>Order 2 first homepage: **3.66 s** | Order 1 first homepage: **11.67 s**<br>Order 2 first homepage: **11.67 s** | Order 1 first homepage: **6.68 s**<br>Order 2 first homepage: **6.68 s** |
| webkit / sqlite | Order 1 first homepage: **3.54 s**<br>Order 2 first homepage: **3.05 s** | Order 1 first homepage: **11.72 s**<br>Order 2 first homepage: **12.21 s** | Order 1 first homepage: **5.74 s**<br>Order 2 first homepage: **5.92 s** |
| webkit / mariadb | Order 1 first homepage: **3.76 s**<br>Order 2 first homepage: **3.76 s** | Order 1 first homepage: **12.14 s**<br>Order 2 first homepage: **11.75 s** | Order 1 first homepage: **6.02 s**<br>Order 2 first homepage: **5.92 s** |

## Translated guest accounting

Each cell uses the median of the three warm checkpoints. Shared-per-process
bytes overlap other processes; mapped-once bytes deduplicate backing pages.
Runtime allocation and backing/kernel capacities are separate from mappings
and OS footprint. Full allocation buckets, including reusable and retained
pages, are available in the JSON records.

| Host / backend / order | VM FILE | VM shared |
|---|---|---|
| node / sqlite / 1 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.69 MiB**<br>Private sum: **99.62 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| node / sqlite / 2 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.69 MiB**<br>Private sum: **99.62 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| node / mariadb / 1 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.56 MiB**<br>Private sum: **99.50 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| node / mariadb / 2 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.56 MiB**<br>Private sum: **99.50 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| chromium / sqlite / 1 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.69 MiB**<br>Private sum: **99.62 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| chromium / sqlite / 2 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.69 MiB**<br>Private sum: **99.62 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| chromium / mariadb / 1 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.56 MiB**<br>Private sum: **99.50 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| chromium / mariadb / 2 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.56 MiB**<br>Private sum: **99.50 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| firefox / sqlite / 1 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.69 MiB**<br>Private sum: **99.62 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| firefox / sqlite / 2 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.69 MiB**<br>Private sum: **99.62 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| firefox / mariadb / 1 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **168.38 MiB** | Mapped once: **131.56 MiB**<br>Private sum: **99.50 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **168.38 MiB** |
| firefox / mariadb / 2 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **168.38 MiB** | Mapped once: **131.56 MiB**<br>Private sum: **99.50 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **168.38 MiB** |
| webkit / sqlite / 1 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.69 MiB**<br>Private sum: **99.62 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| webkit / sqlite / 2 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.69 MiB**<br>Private sum: **99.62 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| webkit / mariadb / 1 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.56 MiB**<br>Private sum: **99.50 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |
| webkit / mariadb / 2 | Mapped once: **156.06 MiB**<br>Private sum: **156.00 MiB**<br>Shared per FPM process: **0.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** | Mapped once: **131.56 MiB**<br>Private sum: **99.50 MiB**<br>Shared per FPM process: **32.0625 MiB**<br>Backing capacity: **512.00 MiB**<br>Runtime allocation: **24.44 MiB**<br>Kernel capacity: **144.25 MiB** |

## Page-level latency

Each number is one fresh parent's median over seven measured requests for
that page. The four page medians feed the geometric ratios above.

| Host / backend / page | Ordinary FILE | VM FILE | VM shared |
|---|---|---|---|
| node / sqlite / home | Order 1 median: **258.63 ms**<br>Order 2 median: **263.06 ms** | Order 1 median: **750.77 ms**<br>Order 2 median: **778.37 ms** | Order 1 median: **486.91 ms**<br>Order 2 median: **484.65 ms** |
| node / sqlite / article | Order 1 median: **274.62 ms**<br>Order 2 median: **276.93 ms** | Order 1 median: **811.89 ms**<br>Order 2 median: **835.43 ms** | Order 1 median: **540.93 ms**<br>Order 2 median: **546.92 ms** |
| node / sqlite / admin | Order 1 median: **271.41 ms**<br>Order 2 median: **274.52 ms** | Order 1 median: **808.55 ms**<br>Order 2 median: **834.71 ms** | Order 1 median: **513.35 ms**<br>Order 2 median: **511.99 ms** |
| node / sqlite / posts | Order 1 median: **204.04 ms**<br>Order 2 median: **204.58 ms** | Order 1 median: **515.03 ms**<br>Order 2 median: **532.21 ms** | Order 1 median: **242.71 ms**<br>Order 2 median: **246.56 ms** |
| node / mariadb / home | Order 1 median: **250.36 ms**<br>Order 2 median: **243.24 ms** | Order 1 median: **673.93 ms**<br>Order 2 median: **658.61 ms** | Order 1 median: **378.61 ms**<br>Order 2 median: **380.69 ms** |
| node / mariadb / article | Order 1 median: **260.12 ms**<br>Order 2 median: **258.88 ms** | Order 1 median: **716.89 ms**<br>Order 2 median: **700.41 ms** | Order 1 median: **418.12 ms**<br>Order 2 median: **422.96 ms** |
| node / mariadb / admin | Order 1 median: **261.31 ms**<br>Order 2 median: **259.97 ms** | Order 1 median: **724.51 ms**<br>Order 2 median: **711.03 ms** | Order 1 median: **400.09 ms**<br>Order 2 median: **404.27 ms** |
| node / mariadb / posts | Order 1 median: **195.10 ms**<br>Order 2 median: **196.18 ms** | Order 1 median: **478.82 ms**<br>Order 2 median: **466.78 ms** | Order 1 median: **191.76 ms**<br>Order 2 median: **192.55 ms** |
| chromium / sqlite / home | Order 1 median: **287.37 ms**<br>Order 2 median: **285.06 ms** | Order 1 median: **683.17 ms**<br>Order 2 median: **683.18 ms** | Order 1 median: **431.10 ms**<br>Order 2 median: **431.17 ms** |
| chromium / sqlite / article | Order 1 median: **303.31 ms**<br>Order 2 median: **301.10 ms** | Order 1 median: **735.08 ms**<br>Order 2 median: **735.53 ms** | Order 1 median: **487.22 ms**<br>Order 2 median: **481.88 ms** |
| chromium / sqlite / admin | Order 1 median: **295.71 ms**<br>Order 2 median: **295.78 ms** | Order 1 median: **733.12 ms**<br>Order 2 median: **728.38 ms** | Order 1 median: **452.90 ms**<br>Order 2 median: **452.97 ms** |
| chromium / sqlite / posts | Order 1 median: **223.10 ms**<br>Order 2 median: **225.09 ms** | Order 1 median: **468.34 ms**<br>Order 2 median: **464.88 ms** | Order 1 median: **220.39 ms**<br>Order 2 median: **220.07 ms** |
| chromium / mariadb / home | Order 1 median: **272.66 ms**<br>Order 2 median: **275.13 ms** | Order 1 median: **595.56 ms**<br>Order 2 median: **592.22 ms** | Order 1 median: **339.98 ms**<br>Order 2 median: **343.82 ms** |
| chromium / mariadb / article | Order 1 median: **284.67 ms**<br>Order 2 median: **288.40 ms** | Order 1 median: **638.71 ms**<br>Order 2 median: **625.29 ms** | Order 1 median: **376.33 ms**<br>Order 2 median: **379.65 ms** |
| chromium / mariadb / admin | Order 1 median: **287.44 ms**<br>Order 2 median: **289.75 ms** | Order 1 median: **639.19 ms**<br>Order 2 median: **632.75 ms** | Order 1 median: **359.40 ms**<br>Order 2 median: **363.67 ms** |
| chromium / mariadb / posts | Order 1 median: **215.07 ms**<br>Order 2 median: **219.07 ms** | Order 1 median: **416.58 ms**<br>Order 2 median: **414.34 ms** | Order 1 median: **172.72 ms**<br>Order 2 median: **174.93 ms** |
| firefox / sqlite / home | Order 1 median: **352.80 ms**<br>Order 2 median: **356.24 ms** | Order 1 median: **950.34 ms**<br>Order 2 median: **930.44 ms** | Order 1 median: **547.50 ms**<br>Order 2 median: **548.48 ms** |
| firefox / sqlite / article | Order 1 median: **377.28 ms**<br>Order 2 median: **380.02 ms** | Order 1 median: **1012.18 ms**<br>Order 2 median: **1000.86 ms** | Order 1 median: **624.64 ms**<br>Order 2 median: **620.56 ms** |
| firefox / sqlite / admin | Order 1 median: **372.36 ms**<br>Order 2 median: **374.98 ms** | Order 1 median: **1009.44 ms**<br>Order 2 median: **1015.58 ms** | Order 1 median: **581.02 ms**<br>Order 2 median: **577.34 ms** |
| firefox / sqlite / posts | Order 1 median: **275.88 ms**<br>Order 2 median: **278.44 ms** | Order 1 median: **647.52 ms**<br>Order 2 median: **659.14 ms** | Order 1 median: **282.70 ms**<br>Order 2 median: **282.40 ms** |
| firefox / mariadb / home | Order 1 median: **359.98 ms**<br>Order 2 median: **371.82 ms** | Order 1 median: **820.28 ms**<br>Order 2 median: **847.54 ms** | Order 1 median: **455.90 ms**<br>Order 2 median: **468.42 ms** |
| firefox / mariadb / article | Order 1 median: **382.48 ms**<br>Order 2 median: **380.38 ms** | Order 1 median: **891.82 ms**<br>Order 2 median: **899.34 ms** | Order 1 median: **508.62 ms**<br>Order 2 median: **498.44 ms** |
| firefox / mariadb / admin | Order 1 median: **405.88 ms**<br>Order 2 median: **388.60 ms** | Order 1 median: **906.04 ms**<br>Order 2 median: **921.74 ms** | Order 1 median: **489.60 ms**<br>Order 2 median: **487.80 ms** |
| firefox / mariadb / posts | Order 1 median: **284.72 ms**<br>Order 2 median: **281.42 ms** | Order 1 median: **613.86 ms**<br>Order 2 median: **612.22 ms** | Order 1 median: **246.30 ms**<br>Order 2 median: **236.70 ms** |
| webkit / sqlite / home | Order 1 median: **357.18 ms**<br>Order 2 median: **353.98 ms** | Order 1 median: **809.30 ms**<br>Order 2 median: **813.64 ms** | Order 1 median: **459.48 ms**<br>Order 2 median: **462.20 ms** |
| webkit / sqlite / article | Order 1 median: **368.66 ms**<br>Order 2 median: **371.66 ms** | Order 1 median: **900.56 ms**<br>Order 2 median: **861.62 ms** | Order 1 median: **530.18 ms**<br>Order 2 median: **539.98 ms** |
| webkit / sqlite / admin | Order 1 median: **372.10 ms**<br>Order 2 median: **372.34 ms** | Order 1 median: **909.52 ms**<br>Order 2 median: **853.76 ms** | Order 1 median: **469.98 ms**<br>Order 2 median: **512.16 ms** |
| webkit / sqlite / posts | Order 1 median: **282.40 ms**<br>Order 2 median: **282.98 ms** | Order 1 median: **571.16 ms**<br>Order 2 median: **572.90 ms** | Order 1 median: **241.36 ms**<br>Order 2 median: **236.40 ms** |
| webkit / mariadb / home | Order 1 median: **351.58 ms**<br>Order 2 median: **343.92 ms** | Order 1 median: **694.02 ms**<br>Order 2 median: **666.96 ms** | Order 1 median: **377.12 ms**<br>Order 2 median: **376.92 ms** |
| webkit / mariadb / article | Order 1 median: **363.94 ms**<br>Order 2 median: **362.62 ms** | Order 1 median: **705.08 ms**<br>Order 2 median: **719.86 ms** | Order 1 median: **437.02 ms**<br>Order 2 median: **420.20 ms** |
| webkit / mariadb / admin | Order 1 median: **374.44 ms**<br>Order 2 median: **369.54 ms** | Order 1 median: **745.60 ms**<br>Order 2 median: **729.28 ms** | Order 1 median: **398.14 ms**<br>Order 2 median: **387.58 ms** |
| webkit / mariadb / posts | Order 1 median: **271.80 ms**<br>Order 2 median: **274.40 ms** | Order 1 median: **510.84 ms**<br>Order 2 median: **487.62 ms** | Order 1 median: **195.90 ms**<br>Order 2 median: **192.42 ms** |
