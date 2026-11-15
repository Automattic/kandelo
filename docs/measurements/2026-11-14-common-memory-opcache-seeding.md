# Shared OPcache warming and change notifications

These are isolated cache-policy experiments on the November 14 common-memory
profile. They do not change the published WordPress preview, PHP package,
kernel, ABI or default timestamp policy. Ordinary/native labels mean
untranslated WebAssembly in the same engine, not machine-native PHP.

## Normal PHP already supports warming

[`opcache_compile_file()`](https://www.php.net/manual/en/function.opcache-compile-file.php)
compiles normal cache entries without executing the script. Running it inside
FPM, or sending warmup requests, can populate the FPM pool's cache before user
traffic. A separate CLI process normally populates a different shared segment.
PHP's persistent second-level
[`opcache.file_cache`](https://www.php.net/manual/en/opcache.configuration.php)
can feed shared OPcache when `opcache.file_cache_only=0`.

Kandelo's existing [image prewarmer](../../images/vfs/scripts/opcache-prewarm.ts)
already uses normal PHP compilation to build FILE caches for ordinary images.
This investigation verifies the compatible-seed path with the instrumented
FPM executable and actual shared memory. It does not introduce a PHP cache
format or claim to identify WP Cloud's particular warming implementation.

[`opcache.preload`](https://www.php.net/manual/en/opcache.preloading.php) is a
different lifecycle: preloaded definitions require a PHP restart to replace.
Ordinary warming supports normal invalidation and editable code.

## Pinned inputs and evidence

The [cache-policy fixtures](../../tools/common-memory-program/cache-policy/README.md)
reuse the earlier application's empty-cache image, matching normal source-only
lazy projection, frozen host profile and kernel. Each output records hashes.

- Base image: `8b8b4f33323692706d7187e36be3d672551d0beee2c0917ffc01f6e9c4f0b729`.
- Instrumented FPM: `25b9dcd2abf21ac4ab38a7c3728b7122cbe6d27a908b1ef6dd311cd3e948a294`.
- Ordinary FPM: `68155a156fa1aa617a24ecb4f4c42b91a3d81b30e64c65a8e8c0fe1afa02988f`.
- Kernel: `49c28e914e319db4c762f97a7ba655c0742e29d4dff1b73452071f2ef383de83`.
- Host profile: `.scratch/common-memory-accounting-profile-2`; matching lazy
  projection: `.scratch/common-memory-acceptance-checkout-2/local-binaries/source-only-v1`.

No SDK, PHP or kernel rebuild was needed. These are derived development images,
not new canonical package products. Node uses `offlineEgressLink`; guest
requests still traverse Kandelo's real networking, with no guest listener
published on a host port. Preliminary training before that option recorded
host-port collisions; those runs are mechanism evidence, not timing samples.

## Seed restoration and freshness

The small Node mechanism fixture proves all four stages: FILE training,
empty-shared control, actual seed-to-shared restoration and rejection of an
older seed after source changes. Both workers observe the edited seeded
script with validation enabled at frequency zero. PHP's own INFO message,
`File cached script loaded into memory`, distinguishes restoration from a
silent miss followed by compilation. Successful HTML alone is insufficient.

WordPress training runs use the exact executable and effective cache mode of
their intended consumer. The source tree is normalized to the image's shipping
mtime before loading the generated cache. Binary-safe writes, cache header
magic, copied-byte hashes and FPM ownership are checked.

| Backend / shared seed | Compiled files | Logical FILE-cache bytes | Restored scripts in diagnostic requests |
|---|---:|---:|---:|
| SQLite | Files: 564 | Bytes: 23,676,472 | Restored: 563 |
| MariaDB | Files: 547 | Bytes: 23,043,032 | Restored: 546 |

Node and all six browser cases pass WordPress homepage, login, authenticated
admin, REST, cache configuration, both-worker and edited-source checks.
Chromium, Firefox and WebKit each restore 563/546 scripts for SQLite/MariaDB.
The browser cases also pass the shared memory-boundary probe. Their diagnostic
logging and durations are not browser performance evidence. The initial policy
edit target is separate from WordPress's core; the smaller mechanism directly
edits a seeded script.

Comparing training paths with restored paths identifies the unused entry as
`/etc/kandelo/wordpress-secrets.php`, which is regenerated at boot. A
distributable seed must exclude generated/private runtime configuration rather
than exporting every file produced by a training request. These initial seeds
retain that rejected entry; no distributed seed or timestamp-off WordPress
configuration is promoted. Restoration remains on demand:
it skips compilation when compatible, but still reads/deserializes the cache
and allocates shared structures. It does not eliminate Wasm compilation,
instantiation, FPM startup or fork work.

The corrected exporter subsequently retains only cache entries whose source
bytes match the shipping image. Both final seeds exclude the generated secrets
file: SQLite has 563 entries / 23,674,472 bytes; MariaDB has 546 entries /
23,041,032 bytes. All retained entries restore. Both Node database cases and
six additional browser cases pass with these filtered seeds. They also edit
the already-seeded `wp-includes/version.php`, then require both workers to
execute its new marker with validation enabled, without explicit invalidation.
These are correctness runs with logging, not replacement latency samples.

An initial WordPress seed trained in FILE-only mode reported a compiled
`file_cache_only=1` value after restoration into a genuinely enabled shared
cache. PHP's [optimizer](https://github.com/php/php-src/blob/php-8.5.12/Zend/Optimizer/zend_optimizer.c)
can fold `ini_get()` of `INI_SYSTEM` settings into compiled code. That is a
configuration-compatibility boundary, not evidence that ordinary warming is
unsupported. The final shared seeds train under shared+FILE settings; the
ordinary control has its own ordinary+FILE seed. The incompatible attempt is
retained and excluded from comparisons.

## Timing and memory scope

The Node screen uses four configurations, both databases and two opposite
orders, with a fresh Node parent per case. Three warmup and five measured
rounds exercise homepage, article, authenticated admin and REST. Latency uses
each parent's per-page median, then geometric means across the two parents.
Both orders and individual page regressions remain in the raw analysis.
Eight additional fresh parents collect one warm OS physical-footprint sample
per configuration/database; resource-parent durations are excluded from the
latency comparison.

All WordPress measurements retain timestamp validation and frequency zero.
Image initialization plus FPM/config preparation plus service-to-homepage time
is reported separately from service-only startup. Neither includes network
image transfer, host file reads or module import time. Compressed image sizes
are recorded separately. Logical FILE-cache bytes are not RAM, and guest
mapping accounting is not whole-host footprint. Two timing parents and one
footprint sample per case support descriptive observations only.

All 24 Node parents pass. Node 24.15.0, V8 13.6.233.17-node.48;
recorded one-minute system load is 3.02–5.18. No other managed build or test
was active at the recorded preflight; this does not establish an idle desktop.
All phase-one frozen input hashes matched again before subsequent source edits.
The initial seeds include the rejected runtime-generated entry described above;
filtered-seed correctness is a subsequent gate, not a new timing sample.

| Backend / arm | Image initialization + preparation + first homepage | Service to first homepage | Warm home | Warm article | Warm admin | Warm REST | OS footprint (one separate parent) |
|---|---:|---:|---:|---:|---:|---:|---:|
| sqlite / shared-empty-no-file | Startup: 8.314 s | Service: 7.385 s | home: 521.2 ms | article: 574.7 ms | admin: 558.5 ms | posts: 259.6 ms | Footprint: 3936.2 MiB |
| sqlite / shared-empty-file | Startup: 13.756 s | Service: 12.813 s | home: 520.1 ms | article: 591.5 ms | admin: 546.0 ms | posts: 262.6 ms | Footprint: 4014.2 MiB |
| sqlite / shared-seeded-file | Startup: 7.311 s | Service: 6.303 s | home: 516.3 ms | article: 583.4 ms | admin: 539.7 ms | posts: 255.8 ms | Footprint: 3616.9 MiB |
| sqlite / ordinary-seeded-file | Startup: 3.441 s | Service: 2.400 s | home: 284.2 ms | article: 302.7 ms | admin: 299.7 ms | posts: 226.6 ms | Footprint: 2866.3 MiB |
| mariadb / shared-empty-no-file | Startup: 7.439 s | Service: 6.546 s | home: 391.4 ms | article: 436.3 ms | admin: 416.9 ms | posts: 197.9 ms | Footprint: 4944.6 MiB |
| mariadb / shared-empty-file | Startup: 12.257 s | Service: 11.363 s | home: 394.7 ms | article: 431.9 ms | admin: 414.7 ms | posts: 196.9 ms | Footprint: 3765.8 MiB |
| mariadb / shared-seeded-file | Startup: 6.441 s | Service: 5.437 s | home: 393.5 ms | article: 437.4 ms | admin: 417.0 ms | posts: 197.4 ms | Footprint: 5174.8 MiB |
| mariadb / ordinary-seeded-file | Startup: 3.327 s | Service: 2.352 s | home: 256.3 ms | article: 265.7 ms | admin: 273.7 ms | posts: 202.6 ms | Footprint: 4729.6 MiB |

| Backend / seeded shared reference | Startup ratio | Service ratio | Four-page warm ratio | Footprint ratio (one sample) |
|---|---:|---:|---:|---:|
| sqlite / shared-empty-no-file | Startup: 0.8793× | Service: 0.8535× | Warm: 0.9891× | Footprint: 0.9189× |
| sqlite / shared-empty-file | Startup: 0.5315× | Service: 0.4919× | Warm: 0.9853× | Footprint: 0.9010× |
| sqlite / ordinary-seeded-file | Startup: 2.1245× | Service: 2.6264× | Warm: 1.6334× | Footprint: 1.2619× |
| mariadb / shared-empty-no-file | Startup: 0.8658× | Service: 0.8306× | Warm: 1.0015× | Footprint: 1.0466× |
| mariadb / shared-empty-file | Startup: 0.5255× | Service: 0.4785× | Warm: 1.0045× | Footprint: 1.3742× |
| mariadb / ordinary-seeded-file | Startup: 1.9360× | Service: 2.3112× | Warm: 1.3919× | Footprint: 1.0941× |

Against empty shared OPcache without a FILE path, the seed reduces the recorded
image-initialization/preparation/first-homepage interval by 12.1% (SQLite) and
13.4% (MariaDB). Service-only reductions are 14.6% and 16.9%. Both orders favor
the seed's startup interval. The larger image adds 4.12/3.99 MiB compressed,
which a network transfer must still pay. This is a modest local startup gain,
not a total network-startup result or a confidence interval.

Four-page warm ratios versus that control are 0.9891/1.0015: near neutral,
with SQLite article 1.0395 in one order and 0.9913 in the other retained.
An empty enabled FILE cache is substantially slower to start than shared-only;
its exact CPU/IO contribution was not separately profiled. The normal PHP seed
avoids that empty-cache state. Seeded shared still takes 2.1245/1.9360 times
the ordinary seeded control's startup interval and 1.6334/1.3919 times its warm
four-page latency. Build/configuration differences remain; these are not pure
address-translation multipliers.

The one-point OS results are mixed: seeded/no-FILE shared ratios are
0.9189 (SQLite) and 1.0466 (MariaDB). MariaDB's shared configurations range
3,766–5,175 MiB in these samples. Both physical footprint and Node RSS support
the large process totals; they are not guest cache lengths. Do not treat this
single sample per case as a memory benefit, stable budget or causal diagnosis.


## Change-driven invalidation: working subset and reproduced gaps

The small watcher consumer runs inside the actual shared FPM cache, with
timestamp checks disabled and a compatible FILE seed present. A controlled
request waits for the observer and calls `opcache_invalidate(path,true)` in
that pool. Closed guest writes preserving the old mtime and atomic replacement
both execute the new version across both workers. Explicit invalidation also
prevents the persistent seed from restoring the invalidated version.

The same fixture reproduces two missing-event cases:

| Mutation | Source bytes | Executed cached code before explicit recovery |
|---|---|---|
| Writer retains a writable descriptor after writing/flushing | Version: 4 | Version: 3 |
| Writer uses a hard link outside the watched directory | Version: 5 | Version: 4 |

An observed sentinel write supplies a notification-completion barrier; neither
case leaves the target dirty in the consumer. The held-descriptor close later
produces a hint and permits recovery. The alias case needs explicit target
invalidation. The initial cases preserve mtimes, so ordinary timestamp validation is not
itself a guarantee for those exact edits. A subsequent controlled pair gives
both gap edits changed past mtimes: watcher-only still runs versions 3/4,
whereas validation enabled runs versions 4/5. Both cases recover through the
same shared cache after explicit invalidation. Thus the observer-only proposal
also loses freshness for edits the existing validation path catches.

The [notification contract](../../host/src/vfs/types.ts) promises close/name
hints and explicitly omits mmap writes. Deferred callback delivery also has
no ordering fence against unwrapped nginx requests or includes in an already
running request. The controlled-request prototype does not establish general
cache coherence, and its success subset must not be sold as a safe global
replacement for validation. No WordPress latency win from disabling checks is
claimed here.

The next platform candidate needs authoritative mutation coverage keyed by
inode identity and namespace dependencies, plus a cache-lookup ordering fence
inside PHP before cached code is selected. Scoping that coverage to source
dependencies matters: a global epoch bumped by database/log writes would cause
avoidable invalidation. Unsupported providers, writable mappings, overflow and
path-resolution caches need explicit conservative handling. This work is not
implemented by the existing observer fixture.

## Retained unsuccessful attempts and remaining acceptance

Retain the first binary-staging bug (a text helper corrupted the cache header),
the first edit fixture's target ownership error, the incompatible FILE-only
WordPress seed, the observer fixture's initial PHP quoting error, the attempted
cross-filesystem hard link, its insufficient both-worker readiness loop, and
the initial browser invocation's duplicate-Playwright-instance error. Each
failed run remains separate from its corrected repeat. None is attributed to
a JavaScript engine defect.

The local retained record is `.context/opcache-seed-20261114/`, including raw
attempts, phase-one input copies, analysis replay and filtered-image identities.
The archive replay reproduces the result tables; it is not a claim to have
rebuilt the complete guest environment offline.

No package/default/preview promotion, full canonical rebuild, broad conformance
suite, nine-suite platform performance acceptance, saturated throughput test or
real-device Safari run was performed for these isolated fixtures. Prior
prototype cancellation, startup intermittency and wider regression findings
remain open. Current browser evidence covers the three Playwright engines,
not every user browser. This report does not declare the prototype ready to ship.
