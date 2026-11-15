# Experimental common-memory process groups

Status: source-checkout prototype with the bounded validation below. The feature
is opt-in and has not completed release acceptance. Existing process memory
remains the default.

A November 14 failure screen found that a syscall-free child could continue
changing an anonymous shared atomic word after its parent observes signal death
through `waitpid`. This reproduces on Node, Chromium, Firefox and WebKit with
the earlier format-1 profile. The kernel published exit before the host's bounded
Worker retirement finished. Quarantine prevented backing reuse but did not
prevent writes through a peer's existing shared alias. Resolving that execution
stop and exit publication boundary is required for prototype acceptance. The
new format-2 profile defers signal cleanup and wait status until execution has
stopped, using atomic stop checks at translated function entries and loop
headers. Browser retirement requires the exact Worker acknowledgement; Node
can also prove execution stop through an awaited thread termination, while
still quarantining a backing that lacks its wrapper acknowledgement. An
unproven browser stop contains the group instead of publishing a successful
signal death. Mixed old/new prototype contracts are refused.

A later cancellation probe exposes a remaining boundary: a child blocked in
an indefinite native `memory.atomic.wait32` cannot reach these stop polls.
Node's awaited Worker termination stops and reaps it, retaining its backing
in quarantine. Chromium, Firefox and WebKit instead fail the kernel instance
because the individual execution-stop acknowledgement is unavailable. They
do not publish a successful child death or authorize backing reuse. This is
whole-group containment, not successful per-process `SIGKILL` support for
that blocked state. The current PHP-FPM artifact contains two translated
wait32 instructions; the passing replacement screens do not prove every
possible wait site can be interrupted. A cancellation-aware wait protocol
needs separate design and validation before that broader claim.

The previously failing four-child screen now passes on Node and all three
browsers, with five exact generation acknowledgements per host. This is a
bounded correctness screen, not complete failure acceptance or a measurement
of the new checks' performance cost. The latest profile also passes the
32-fork, 16-exec and 16-SIGKILL lifecycle fixture on all four hosts, with 49
exact generation retirement acknowledgements each. An attempted exec of an
older prototype is rejected with `ENOEXEC` while preserving the original
process and its private state, on all four hosts. The
reproducer is `tools/common-memory-program/uncooperative-exit.c`, with retained
results in `.context/common-memory-uncooperative-exit-screen-20261114.json`.

The demonstrated target is trusted memory32 prefork applications with one
Worker per process. Processes use distinct virtual mapping roots in one
shared physical `WebAssembly.Memory`. Fork preserves virtual pointers: private
pages are copied and anonymous shared mappings retain the same physical pages.
PHP-FPM can therefore share actual OPcache pointer graphs. Group members must
trust each other; the physical backing does not isolate them.

The direct-alias mechanism demonstrated here covers inherited anonymous shared
mappings. It does not establish directly shared backing for independently
attached System V segments. Existing System V attachment tracking and
syscall-boundary mirror synchronization are separate mechanisms. In particular,
a passing `libc-test` `ipc_shm` control checks a write, detach, fork and reattach;
it does not prove concurrent load/store visibility between live attachments.

These backing groups are separate from POSIX process groups and sessions.
The current profile places translated programs in its kernel Worker's single
backing group; it does not expose a general group-creation API. An ordinary
executable continues to use ordinary process memory in the same machine.

## Memory inspection

Internals → Procs uses the same numeric backing-accounting API on Node and
browser hosts. It shows attributed, private, shared and virtual bytes per
process, and an expandable group breakdown. Sharing is determined from actual
backing references rather than `MAP_SHARED` flags. The OPcache mapping appears
in each FPM process's Shared column, but contributes only its proportional
share to Attributed and is counted once in the group's Unique mapped total.

The current 512 MiB pregrown buffer is reported separately from mapped payload,
runtime metadata/scratch, retained roots or fork pins, reusable pages and
space beyond the allocator's high-water extent. Unexplained allocations remain
explicit. Inspection does not authorize reclamation or pause Workers, and none
of these counters measures host resident RAM. See
[guest memory accounting](architecture.md#guest-memory-accounting) for exact
definitions and the ordinary-linear-memory boundary.

`tools/common-memory-program/wordpress/check-node.ts` checks both backends'
accounting against their mapped-page union and reconciles all group buckets.
`memory-accounting.spec.ts` in the same directory checks the real Internals UI,
ordinary nginx memories, three FPM processes sharing OPcache, proportional
totals, expansion/refresh and the browser memory boundary. Run it against a
freshly built profile and preview using the existing WordPress Playwright
configuration and `--grep 'Internals memory accounting'`.

## Ownership and retirement

The normal process-memory allocator releases a registered backing only after
its final alias lease is consumed. Both host lifecycle paths already detach
the exact execution generation, settle its channel listeners and establish
Worker quiescence before a normal release. Forced retirement retains a
quarantined root and cannot recycle its physical pages.

`host/src/common-memory-page-ownership.ts` tracks root metadata, scratch,
mapped payload and captured-fork pins. Retiring one process does not release
pages still named by another root or pending fork snapshot. Async allocation
closes snapshot ownership on completion and failure. Reclaimed extents are
zeroed before publication. Reused roots have an incarnation distinct from the
mapping epoch; old virtual handles, views and wire packets must refuse a
successor at the same physical root address.

Build the opt-in host adapter from a source checkout into a fresh directory:

```sh
scripts/dev-shell.sh node host/build-common-memory.mjs \
  .scratch/a-fresh-common-memory-profile
```

The existing pregrowth profile and its runtime workaround remain documented
in the [experimental program guide](../tools/common-memory-program/README.md).
This explicit source-build entry emits Node/browser host and Worker modules,
plus a versioned manifest of source and output hashes. Import its
`node-kernel-host.mjs` or `browser-kernel-host.mjs` and provide the matching
kernel explicitly. It preserves normal Node networking. The research compiler's
internal-network fixture remains a separate choice. The adapter caps the
physical group at 512 MiB and currently pregrows that backing; this is a
reservation and memory cost, not a promise of a 512 MiB application heap.

Translate an ordinary linked memory32 executable through the checkout SDK:

```sh
scripts/dev-shell.sh sdk/bin/wasm32posix-cc -O2 -pthread program.c -o ordinary.wasm
scripts/dev-shell.sh sdk/bin/wasm32posix-common-memory ordinary.wasm -o grouped.wasm
```

The explicit compiler option `--experimental-clock-query-v1` enables the
optional clock import in newly linked memory32 executables. It samples current
time on every admitted read; it does not cache timestamps. Unsupported output
mappings, providers, task or signal states use the normal syscall path. The
ordinary compiler invocation and host build keep this path disabled. The
common-memory source profile enables it with renewal after successful metadata
calls, using a fresh kernel eligibility decision and fresh writable-page checks.

The post-link command is currently a native build-machine tool requiring this
source checkout and its declared dev shell. It checks the program ABI, refuses
conflicting contract digests, objects, side modules and already translated
inputs, uses normal fork preparation, and validates translated bytes before
publication. It preserves the input. It does not expose the survey's research
instrumentation flags as supported SDK options.

`php-common-memory` is a separate experimental recipe, absent from default
product selection. It builds translated CLI/FPM executables with opt-in shared
OPcache and omits dynamic extension outputs. The ordinary `php` recipe retains
its file-cache-only guard. Revision 3 builds through the normal source-only
resolver with the clock option and format-2 execution-stop checks. `wordpress-common-memory` derives a separate
image from `wordpress-family-vfs`, replacing only FPM and enabling shared
OPcache with timestamp validation and zero revalidation interval. Both recipes
are explicitly excluded from default product selection. Their existence and
the profile manifest do not establish release readiness.

### Reusing an instrumented PHP-FPM binary

One translated FPM executable can select either shared OPcache or FILE-only
OPcache through `php.ini` at service startup. Changing the cache backend does
not remove address translation, execution-stop checks or the group allocator.
FPM also uses anonymous shared memory for its own scoreboard, independently of
OPcache. The current two-worker fixture maps 64 KiB shared per process with
FILE-only OPcache, and 32 MiB plus 64 KiB with shared OPcache.

A translated executable may be its group's only live process; it still needs
the translated runtime. FPM forks stay within that group.

This is binary reuse within the translated runtime. The ordinary host refuses
the instrumented program with `requires the opt-in common-memory prototype
host`; changing OPcache settings cannot make it use ordinary direct addressing.
An instrumented program still needs the translated root/page-table bindings
and compatible memory-model admission, even if its application never requests
shared OPcache. A single deployment package could carry ordinary and translated
variants, but an ordinary-speed execution path inside one translated artifact
has not been implemented.

### Warming shared OPcache

Normal PHP can populate OPcache before user traffic. Calling
[`opcache_compile_file()`](https://www.php.net/manual/en/function.opcache-compile-file.php)
inside the running FPM pool compiles ordinary, invalidatable cache entries
without executing those files. Warmup requests can populate the same cache.
A separate CLI process ordinarily warms its own cache, rather than the FPM
pool's shared segment.

PHP also supports a persistent second-level `opcache.file_cache` alongside
shared caching (`opcache.file_cache_only=0`). Kandelo already has a
[build-time FILE-cache prewarmer](../images/vfs/scripts/opcache-prewarm.ts)
for its ordinary PHP images. The common-memory experiment can load compatible
compiled files into shared OPcache on demand; it needs no new PHP cache format.
Seeds must match the PHP build, paths, source timestamps and configuration.
Configuration-dependent expressions can already be compiled into a seed.

This differs from `opcache.preload`, whose preloaded definitions require a PHP
restart to replace. Ordinary warming retains editable-code invalidation.
The isolated [cache-policy fixtures](../tools/common-memory-program/cache-policy/README.md)
exercise seed restoration, edited-source freshness and the limitations of
observer-driven invalidation. They do not change the published preview or
disable its timestamp validation.

## Current format-2 retirement screen

On November 14, normal resolver-built PHP-FPM revision 3 repeated the 24-worker
replacement screen on Node, Chromium, Firefox and WebKit using the current
format-2 host and kernel. All four passed 53 checked FastCGI requests, shared
cache publication/invalidation, cached pointer graph reuse by replacement
workers and request-local state isolation. Timestamp validation remained on
with `opcache.revalidate_freq=0`. Each replaced worker had an exact-generation
quiescence acknowledgement. Retained results are in
`.context/common-memory-stop-php-recycling-screen-20261114.json`.

This does not establish WordPress image acceptance or the new stop checks'
performance. The image build and broad acceptance suite remain separate gates.
Accounting now includes an allocator-owned backing even after its final live
root retires. The 512 MiB backing reservation remains allocated while the group
owner lives; zero live roots is not a claim of released memory. Logical page
allocation, reserved backing bytes and process RSS are distinct measurements.

## Application checks and remaining gaps

The rebuilt format-2 PHP-FPM passes both WordPress database variants on Node
and the six homepage/admin/shared-OPcache/browser-memory checks across Chromium,
Firefox and WebKit. This image is a composer smoke build using a retained
normal `wordpress-family-vfs` base and the normal resolver-built PHP revision 3;
it is separate from fresh whole-graph image acceptance.

A later normal resolver build of `wordpress-common-memory` revision 2, with
fresh PHP revision 3, completed and passed the filesystem-layout audit. That
image passes both Node database checks and all six browser homepage, admin,
shared-cache and memory-boundary cases. It also passes three boot/edit/destroy
cycles per database and browser in persistent pages: 18 completed cycles with
source edits observed by both FPM workers. The first GUI attempt used an older
lazy-binary projection and correctly failed the `coreutils.wasm` integrity
check. Binding the preview to the matching normal projection resolves that
specific setup error. The failed attempt remains recorded. See
`.context/common-memory-fresh-wordpress-cycles-screen-20261114.json` and
`.context/common-memory-fresh-normal-image-20261114/manifest.json`.

The latest image rebuilt after the typed factory-cancellation fix has SHA-256
`2ae2e85c8a4f7a1ac3dee2d3933818b1848adbfe2690de9ad8137bd1b6eb6f56`.
It passes both Node backend checks, all six browser homepage/admin/shared-cache
checks, and eighteen more persistent-page source-edit/destroy cycles with the
current source profile. The preview's opaque executable asset also matches its
selected normal projection byte-for-byte. These results are retained in
`.context/common-memory-current10-application-20261114/` and
`.context/common-memory-current10-gui-20261114/`.
The GUI logs retain two empty-URL service-worker diagnostics (Firefox, one per
backend) and one HTTP 502 resource diagnostic (WebKit/SQLite, URL unrecorded).
The required page, cache, admin and memory-boundary assertions passed; these
diagnostics have not been assigned an engine cause or explained away.

The current host/kernel also ran three boot/edit/destroy cycles in one persistent
page for each database variant and browser. Five cases passed. Chromium/SQLite
completed its first cycle, then stalled before process admission in the next
boot. An isolated retry completed all three cycles. Both outcomes are retained:
this remains an intermittent startup failure, not a clean lifecycle acceptance
result. Timestamp validation and zero revalidation interval stayed enabled;
source freshness checks exercised both FPM workers without an invalidation API.
See `.context/common-memory-wordpress-current9-recycle-screen-20261114.json`.

The current format-2 host/kernel also passes the advanced clock controls on
Node and all three browsers, both enabled and disabled: POSIX timers, signal
masks, interrupted waits, mapping permissions, thread refusal and fork/exec.
The disabled control records zero direct reads. These are mechanism checks,
not latency measurements.

An additional enabled/disabled interval-timer screen passes on all four hosts
without suppressing signal delivery. It preserves the existing `ITIMER_REAL`
limitation: a requested 2 ms interval produces one alarm during a 2.2 s window.
This is a compatibility observation, not periodic-timer conformance.

The broader ordinary-process browser-memory gate subsequently passed 17 of 18
browser cases and failed WebKit's machine-switching diagnostic assertion:
terminal teardown cancelled an unpublished allocation, but the generic error
was reported as a fork launch failure. The host now carries the closed creator
gate's private cancellation identity through the allocation factory, after
normal child rollback. Constructor/transport failures and failed allocation
Worker termination remain visible failures. Regression tests cover those
negative controls. The required `./run.sh test browser-memory` repeat now
passes from an isolated, normally prepared checkout: 295 memory unit cases,
3 Node teardown cases, 7 Bun cases, and all 18 browser cases. Each engine
completes four constrained-budget switching cycles through the real games,
desktops, terminal sessions and WordPress. The earlier WebKit failure remains
retained alongside this corrected run. A Firefox storage-directory cleanup
`EACCES` diagnostic is also retained. The 15 focused common-memory browser
cases pass separately. This does not clear the earlier intermittent startup
stall or the native atomic-wait cancellation boundary. Evidence is in
`.context/common-memory-browser-memory-pass-20261114/manifest.json`.

A separate ordinary-process compatibility selection matches a normally
provisioned, unchanged `origin/main` at
`f8612113e7bd52a5ce31011d556d7ce1519424be`. On both Node and Chromium,
`libc-test` passes eight selected clock, semaphore, IPC and process cases;
the Open POSIX kill/unmapping selection has ten passes and the same two
reason-checked expected unmapping failures. Neither side has a build error,
timeout or unexpected result in these selections. This is bounded regression
coverage for ordinary processes, not full POSIX or translated-program
conformance. The two manifests are
`.context/common-memory-native-baseline-compatibility-20261114/manifest.json`
and `.context/common-memory-candidate-native-compatibility-20261114.json`.

The last broader source-test repeat recorded 6,820 passes and twelve failures,
with no skipped or unloaded tests. Those twelve names and first assertion
messages also occur in the unchanged-HEAD subset. Two earlier fixture failures
were separately investigated with a normally built image module and corrected
global fixture preparation; the relevant 41 login/VFS tests then passed. This
is bounded failure triage, not a clean full baseline or source-suite result.
The later cancellation regression tests pass in the current 295-case memory
selection; the entire broader source selection was not repeated after those
additions. See `.context/common-memory-source-test-triage-20261114.json`.

The new execution-stop polls now have a [standalone instruction measurement](measurements/2026-11-14-common-memory-stop-overhead.md)
on Node and all three browser engines, with matched unvirtualized and unchecked
translation controls. It finds substantial costs in some tight loops, especially
WebKit calls and Firefox atomics. A later
[current-contract application comparison](measurements/2026-11-14-common-memory-application-impact.md)
now measures both WordPress databases on Node and all three browser engines,
with timestamp validation and separate OS resource runs. Shared OPcache takes
about half the instrumented FILE-only request time, but usually remains slower
than ordinary Wasm. Guest mapped bytes fall while observed host footprint is
often higher; the report retains both orders and the WebKit XPC probe correction.
The earlier survey remains historical. The full browser-memory gate passes as
described above. The
[ordinary-runtime before/after comparison](measurements/2026-11-14-common-memory-default-regression.md)
now completes all nine enabled suites on Node and Chromium in both orders.
It retains higher Node exec/locking costs and lower stdin throughput in both
orders, plus two Chromium database flags. All eight results match their final
canonical input inventories. This compares the whole candidate against
pinned main, including differing application artifacts and preserved unrelated
changes; it does not isolate this feature or establish performance neutrality.
Broader conformance and cause-specific regression investigation remain open.

A [fresh committed-PR comparison](measurements/2026-11-14-common-memory-pr-regression.md)
repeats all nine enabled ordinary-runtime suites against the same pinned main
with eight new CLI parents, including the final accounting code. All selected
inputs match their final inventories. It retains adverse Node dense file
replacement and Aria select results, Chromium startup costs, and smaller
same-direction Node stdin/exec changes, alongside favorable and mixed values.
This does not establish ordinary-runtime performance neutrality or assign the
differences to the shared-memory feature alone.

## First retirement screen

On November 13, 2026, normal SDK-built PHP-FPM completed 24 actual worker
replacements on each of Node, Chromium, Firefox and WebKit. Each replacement
had an exact-generation quiescence acknowledgement. Shared OPcache pointer
graphs, publication, invalidation, replacement-worker reuse and request-local
state passed 53 checked FastCGI requests per host. Timestamp validation stayed
enabled with `opcache.revalidate_freq=0`.

All four hosts had the same logical allocator curve:

| Measurement | Observed value |
|---|---|
| Initial allocation | Allocated bytes: **123.5 MiB** |
| Peak allocation | Allocated bytes: **153.625 MiB** |
| Last twelve replacement samples | Allocated bytes per sample: **153.625 MiB** |
| Live and retained roots after each replacement | Root count: **3** |
| Pending snapshots after each replacement | Snapshot count: **0** |
| Quarantined roots in this graceful-replacement fixture | Root count: **0** |

Separate component checks on all four hosts exercise stale handles/views/wire
packets, snapshot cancellation after source retirement, forced quarantine and
256 create/retire cycles with flat allocation. Focused normal allocator and
generation-detach tests pass 67 cases; host TypeScript checking passes.

These are bounded resource and correctness screens, not RSS measurements,
latency estimates, indefinite service or complete failure-path acceptance.
The [strict result](../.context/common-memory-retirement-screen-20261113.json)
records source hashes and the per-host summaries. Earlier failures and the
original retained-root growth remain evidence.

## Remaining integration gates

The later screens below cover normal SDK/package admission, unsupported
operations, unpublished rollback, snapshot cancellation, fork/exec/signals,
bounded FPM recycling and both WordPress databases with source edits. Fresh
normal-resolver image production and the complete browser-memory gate have
passed. The bounded ordinary-process conformance comparison and full canonical
target-branch benchmark coverage are described above. Sustained failure/quarantine
recovery, the retained performance regression leads and broader conformance
remain acceptance work. The separate loopback preview is an explicitly
experimental candidate; it does not establish those broader gates.

### Admission and rollback hardening

A subsequent screen adds source-owned cancellation when async admission rejects
an unpublished backing. An already admitted backing returned twice by a faulty
factory cannot be cancelled. A construction result already exposed to a Worker
is quarantined. Root-incarnation loads/stores are atomic and use reserved root
header word 15, outside the earlier experimental mapping-cache slots.

A retained negative control demonstrates that the old adapter instantiated an
untranslated module before rejecting its missing contract: its Wasm start
function had already written into the physical group. The revised adapter
checks the contract and bindings before asynchronous byte/module instantiation
and synchronous instance construction. This also refuses untranslated side
modules before their startup or active data can touch group memory.

The hardened profile passes 27 component checks and another 24-worker FPM
replacement screen on each of the four hosts. The focused ownership suite now
passes 69 tests and host TypeScript checking passes. The allocation plateau and
three-root invariant remain. These screens still do not establish public SDK
packaging, unsupported-operation admission or release readiness.

The selected optimization candidate is short copies plus direct clocks and VM
clock renewal. The [optimization survey](measurements/2026-11-12-common-memory-optimization-survey.md)
retains its measured limits and rejected alternatives. Both scalar shortcuts
remain excluded. No speedup is inferred from this retirement screen.

### Kernel policy and SDK admission screen

An additive optional kernel export binds the actual backing's memory model to
an exact execution generation. Shared-group admission requires memory32 with
one thread. Fork inherits the model; exec registration configures its new
backing. File-backed `MAP_SHARED`, thread-style clone and vfork return
`EOPNOTSUPP` before creating mappings, threads or children. Ordinary process
memory keeps its existing behavior. A group profile refuses a kernel without
the capability before running guest code. The program ABI digest is unchanged.

The SDK-built C probe passes grouped admission, ordinary positive controls and
old-kernel refusal on Node, Chromium, Firefox and WebKit. The ordinary control
actually creates a thread, maps a shared file and completes vfork. In the
grouped probe, the direct clone import checks `EOPNOTSUPP`; musl's
`pthread_create` intentionally maps clone failures to `EAGAIN`. The probe also
checks that private file mapping works. All nine browser cases pass.

The updated kernel separately passes another 24-replacement FPM screen on all
four hosts with the same allocation plateau and OPcache checks. That FPM screen
uses the retained research PHP artifact and host profile, rather than the new
package recipe. The public profile currently includes short copies; direct
clock and VM clock-renewal integration were pending at this stage. Package validation,
broader failure/lifecycle gates and release acceptance remain incomplete.

### Fork, exec and signal screen

A second SDK-built C probe completes 32 forks, 16 exec replacements and 16
`SIGKILL` exits on each of Node, Chromium, Firefox and WebKit. It checks caught
signals, parent-private state, shared publication after child exit, fresh exec
initializers and zero-filled new anonymous mappings. The fixture retries
`waitpid` on `EINTR`. Each host records 49 admitted and 49 retired execution
generations, all with exact quiescence acknowledgements; exec accounts for 16
superseded generations.

The source-only host browser-memory selection passes 268 tests, including its
memory-authority audit. This is a component of the full browser-memory gate;
it does not include the canonical image preparation and repeated machine
switching. SDK refusal checks preserve both the input and an existing output
when rejecting a conflicting ABI digest, already translated input or identical
input/output path. None of these screens supplies throughput or RSS
measurements, sustained failure-quarantine recovery or final release acceptance.

### Source-integrated clock and package screen

The opt-in source profile now contains direct clocks and VM metadata renewal,
plus short copies. Both scalar shortcuts remain excluded. The normal SDK and
`php-common-memory` revision 2 produce the tested executable; no private PHP
binary is substituted. This package completes 24 actual worker replacements
and 53 checked requests on each of Node, Chromium, Firefox and WebKit, retaining
the allocator plateau above and timestamp validation. The full workspace Rust
suite passes with xtask excluded. The separate xtask run passes its 905 unit
tests and 11 integration tests after adding the explicit package exclusions,
completing the image-module cache closure and removing an obsolete workaround
registry reference to a nonexistent source file.

SDK-built C probes compare the profile with an otherwise matching clock-disabled
profile. All metadata operations still execute. Counts measure the mechanism,
not latency or a WordPress speedup:

| Probe | Node | Chromium | Firefox | WebKit |
|---|---|---|---|---|
| Repeated clock reads | Requested reads: **128**<br>Enabled clock syscalls: **1**<br>Disabled clock syscalls: **128** | Requested reads: **128**<br>Enabled clock syscalls: **1**<br>Disabled clock syscalls: **128** | Requested reads: **128**<br>Enabled clock syscalls: **1**<br>Disabled clock syscalls: **128** | Requested reads: **128**<br>Enabled clock syscalls: **1**<br>Disabled clock syscalls: **128** |
| Interleaved metadata and clocks | Metadata checks per arm: **128**<br>Enabled clock syscalls: **3**<br>Disabled clock syscalls: **129** | Metadata checks per arm: **128**<br>Enabled clock syscalls: **3**<br>Disabled clock syscalls: **129** | Metadata checks per arm: **128**<br>Enabled clock syscalls: **6**<br>Disabled clock syscalls: **129** | Metadata checks per arm: **128**<br>Enabled clock syscalls: **3**<br>Disabled clock syscalls: **129** |
| Renewal across four metadata APIs | Metadata checks: **256**<br>Direct reads: **249**<br>Fallback reads: **7** | Metadata checks: **256**<br>Direct reads: **255**<br>Fallback reads: **1** | Metadata checks: **256**<br>Direct reads: **251**<br>Fallback reads: **5** | Metadata checks: **256**<br>Direct reads: **254**<br>Fallback reads: **2** |

The disabled renewal control takes the syscall path for every read. Protected,
unmapped and split-page output cases check permission/fallback behavior. Earlier
Node probes with a surviving trace-poll interval were terminated and retained
as failures; the destructor now stops that interval, with a regression test,
and final probes exit normally. Always-on research trace instrumentation is
absent from the integrated source. Historical survey timings therefore remain
historical; this build needs fresh application measurements.

An additional SDK-built guest passes with direct clocks enabled and disabled on
all four hosts. It exercises repeating POSIX timers (`timer_create`), caught
signals, blocked pending signals and delivery on unblocking, `ppoll` interruption,
protected/unmapped output, thread refusal and clock state after fork and exec.
The disabled arm observes zero direct reads. This does not establish complete
signal conformance or repair the earlier survey's legacy `setitimer` finding.

Inputs, outputs, failures and an independently verified compressed preimage
archive are retained under
`.context/common-memory-integration-20261113/clock-integration-screen/`.
The strict summaries are
`.context/common-memory-clock-mechanism-screen-20261113.json` and
`.context/common-memory-packaged-clock-fpm-screen-20261113.json`.
