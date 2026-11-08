# Go `GOOS=kandelo` Port — Milestone 1 Implementation Plan

## Current checkpoint — 2026-11-08

**Current WordPress UI/persistence selection finishes 32 passes / one failure.**
`7f59` completes all 33 cases with no skips or retries. All ordinary
login/editor/post/template cases pass across Chromium, Firefox and WebKit.
Both Caddy persistence modes pass in Chromium and WebKit; Firefox library
persistence passes. Firefox experimental persistence fails during its first
post publication, before the source image is disabled or the machine is
restarted. Its welcome dialog remains visible after the trusted Close click.
The saved canvas contains a visible Add title field, but the locator handler
waits for the dialog to disappear. Related WordPress REST POSTs receive the
development server's 503 service-worker-route fallback. The captured Caddy
process and startup log remain present; these observations do not establish
a guest-server crash, persistence failure, or browser-engine defect.

The full report, screenshots, service log, process snapshot and page lifecycle
events remain under the normal checkout's `7f59` job and browser run
`6cbe6fbe-8577-46a3-b4cc-ca90244b971a`. The request path and missing welcome
preference save still need diagnosis. No application patch, timeout increase
or weakened assertion is adopted. Media6 `bf0e` now runs; corrected cache9
`349e` and archive/signal browser63 `e151` follow serially. Independent normal
four-consumer reproducibility job `c981` awaits canonical publication and
the existing publishers before force-building target recipes. Canonical
`f2f6` advances to Qt configuration. Preview5495 still answers HTTP; final
canonical, conformance, memory and comparative-performance gates remain open.


**Current-artifact browser runtime and WordPress traffic gates pass.**
`7dba` completes the fresh wait/netpoll/memory selection: 15 cases across
Chromium, Firefox and WebKit, no skips or retries, 51.1 seconds of browser
execution. The queue-inclusive job duration is 23m29s. `4f80` rebuilds
maintained archive/export/signal/retirement fixtures with the selected clean
f605 compiler and this checkout's own current SDK, then passes 19 Node
checks in 1m09s. Its compilation cache is cleaned after success; executable
fixtures, provenance and raw logs remain. The 63-case browser counterpart
`e151` is queued. Neither result completes the full Go/POSIX/cgo inventory.

`d6b0` passes all six current WordPress HTTP/traffic/memory cases in 17
minutes of browser execution (36m30s including queue): classic and real
Caddy on each engine, two configured PHP threads, 120 validated WordPress
requests at a minimum 500 ms cadence, editor bursts/parallel requests,
four Caddy SIGKILL recoveries, held-PHP draining and cooperative teardown.
Both unchanged optimizer probes (96/768 conditions) pass twice per case.
Maps and storage-admission metadata are now captured alongside the existing
linear-memory, upstream and native observations. This is instrumented
functional evidence under concurrent canonical-build load, not throughput.

WebKit's OS whole-run peak is 7.4 GiB for classic and 5.2 GiB for Caddy;
sixty seconds after destruction, the same pages retain 827.2 and 584.3 MiB
respectively. Caddy's traffic backing stays at 719,257,600 bytes while
Go Sys ranges from 42,663,936 to 43,712,512 bytes. This single run on new
artifacts and expanded diagnostics establishes no improvement over older
runs and no acceptable resource budget. Cumulative module compilations
increase from seven to eight in some cases; this does not count live
instances or identify engine allocations. See the
[memory checkpoint](2026-11-08-wordpress-webkit-memory-checkpoint.md#current-normal49-artifacts-and-tooling-limits)
for ownership and measurement limits.

The ordinary native heap tool cannot enumerate the WebKit Malloc zone;
its successful exit therefore does not establish an allocation inventory.
The referenced JavaScriptCore framework exists as a regular file. A separate
five-second Xcode allocation-profiler control stops before recording in
macOS authorization; its stack/logs and incomplete trace are retained.
Only that owned profiler is terminated after graceful termination fails.
No authorization is granted or bypassed, and no user app is closed.
This diagnostic boundary does not stop independent validation. The guest
procfs VmSize placeholder is also recorded explicitly, not used as memory
measurement. No Go/PHP/compiler/runtime algorithm change is made.

All nine cases of the original cache run `4568` fail at the same flattened
terminal assertion, after their privacy/edit/expiry checks; stock automatic
GC is not reached. The original report and imported nonpass record remain.
The exact guest-file checks in `f1bb447d6` are pushed; corrected `349e`
awaits the existing serial selections. The rendered UI33 run `7f59` passes
all eleven Chromium cases, including both source-free persistence modes,
and is progressing through Firefox. Media6 `bf0e` follows it. No aggregate
UI33, media6 or corrected automatic-cache pass is claimed yet.

Canonical `f2f6` completes and normally publishes guest Clang, then advances
to CPython. Its attempted stack sample races that actual completion and
finds the old process absent; it is not a stuck-build diagnosis. Current
warm canonical `ca1f` and baseline `adf8` still await the producer's terminal
result. Preview5495 remains pinned. Final canonical/conformance/memory-gate,
sustained and fair benchmark acceptance remain open; the goal stays active.



**WordPress49 cron passes all three engines; fresh runtime probes pass Node.**
`wordpress49-strict-cron-three-engines-1108-073243-217a` passes in 14m36s:
Chromium, Firefox and WebKit, no retries or skips. Each case exercises real
automatic WordPress cron delivery with public headers, a full stopped
minute, restart, Caddy SIGKILL recovery, FPM/classic switching, the next
FPM tick, held-PHP draining and cooperative init shutdown. The image,
kernel and Go programs are the new normal49 cohort recorded below.

`wordpress49-current-runtime-node-1108-073527-6fd2` builds five fresh
maintained probes with the explicitly selected clean f605 prototype and
this checkout's own current SDK. Both plain-Go/cgo wait and netpoll cases,
plus cgo memory accounting, pass in Node; the job takes 43 seconds.
The waits retain zero/short/multi-checkpoint deadlines, notification races,
indefinite wakeups and blocking-I/O scheduler release. The memory probe
collects dead 64 MiB Go allocations and reuses its linear backing while a
32 MiB C allocation remains live: linear size starts at 560,726,016 bytes
and settles at 594,804,736 bytes through repeated allocations. Go's
released-page count is logical accounting, not physical reclamation.
The explicit fixture compiler is not a new independent package bootstrap;
full current Go/POSIX/cgo and three-browser acceptance remain separate.

The current nine-case automatic stock-cache run `4568` exposes a fixture
assertion error: xterm DOM text concatenates displayed rows, so splitting
it on newlines cannot prove the actual header-file lines. All three
Chromium cases reach that check with the expected header substrings after
privacy, post/template invalidation and expiry checks. The corrected
fixture runs exact-line `grep` inside the guest and requires its zero exit
status through the normal terminal protocol. It leaves application,
service, host and kernel behavior unchanged. The original run continues
on frozen source; its evidence is preserved. Corrected three-engine run
`349e` is queued after the existing serial browser selections.

Current normal49 runtime15, expanded HTTP/memory6, rendered UI33 and
media6 selections are queued serially. Canonical `f2f6` reaches guest Clang
instrumentation; warm current-source refresh `ca1f` waits for its terminal
result and reuses completed normal cache entries. Its separate capture
binds the new daemon/kernel identities rather than the earlier cohort.
The baseline remains queued. Preview5495 stays pinned and verified; no
final canonical, native-memory budget or throughput pass is claimed.



**Normal WordPress49 build and replacement preview verified.** Own-SDK job
`wordpress-cron-normal-partial-v2-1108-070359-5564` passes in 13m25s:
normal partial image composition, filesystem layout, both existing real
WordPress Node service profiles and the strengthened cron lifecycle case
(three passes, no skips). Package checks
`wordpress49-go-consumer-node-1108-072314-ef5e` also pass for both fresh
FrankenPHP programs, including 32 requests at concurrency four and
Go-backed string lifetimes across garbage collection. These checks use
kernel `7e2593cdb90a`, classic `380ff5931ad3` and Caddy `b0f2985aef0c`.

The replacement preview is running on port 5495 from frozen source
`95cd1dd170922a881c0c722a63e08df93f8c1f5b`. Its Chromium UI proof
`wordpress49-running-preview-proof-1108-072552-0480` passes in 3m29s,
including provisioning: actual demo login, Appearance Editor, a real
saved template, and guest cron headers matching the actual browser host
and service-worker machine prefix. The served image and kernel hashes
are checked against the normal producer. Image SHA-256 is
`107912d3f8b8e48ce22660537294e1754f8de1000f4e5893754fde8c1d293f8b`
(84,392,850 bytes). URL:

http://127.0.0.1:5495/?vfs=http%3A%2F%2F127.0.0.1%3A5495%2F%40kandelo-partial%2Fimage.vfs.zst&profile=wordpress-frankenphp-caddy

The evidence and screenshot are in the producer checkout's
`.context/wordpress49-preview-proof/`; server job
`wordpress49-candidate-preview-1108-072017-89d6` stays running. The older
5492 preview remains available. This is a normal partial WordPress
FPM/classic/Caddy development image, not final canonical acceptance.
Current three-engine cron, automatic stock-cache cleanup, complete editor,
upload/persistence/recovery coverage, memory budgets and fair performance
comparisons remain open. PHP's optimizer remains unchanged. The separate
canonical producer `f2f6` is still running; its baseline successor is queued.


**Image-owned public URL configuration and current-SDK rebuild.** The
normal partial producer `1e5b` completes its own SDK and selected dependency
builds, including both FrankenPHP programs, then fails after 48m30s exactly
at `lstat /usr/bin/curl` during WordPress47 composition. It retains all
completed cache entries. WordPress49 now installs the declared CLI itself;
family16 copies that explicit image-owned command as well. The earlier
source diagnosis is now reproduced by the normal pipeline, not just an
inferred partial-shell rule.

Fresh own-SDK outputs are kernel `7e2593cdb90a`, classic `380ff5931ad3`
(69,939,907 bytes) and Caddy `b0f2985aef0c` (184,971,183 bytes). These differ
from the retained older cohort and need their own final runtime validation.
Read-only section comparison records the changed code/data/build-key
sections; it is not an independent same-key reproducibility test and does
not establish the cause of each byte difference. Identities are retained in
`wordpress-cron-normal`'s completed-go-artifacts and section-comparison JSON.

Browser init now supplies generic `KANDELO_PUBLIC_URL` metadata after bridge
registration. An image-owned Dinit configuration service atomically prepares
curl's header file from that input. The app no longer recognizes or rewrites
WordPress configuration. Protected candidates retain their original init
environment; absent metadata leaves configured headers unchanged. Control
`a5bc` passes the complete Node scenario in 4m40s with real guest rendering
of public host/prefix, actual curl `@header-file` loading, stop/restart,
Caddy crash recovery, both service switches and held-PHP shutdown. This uses
retained normal45 plus current ordinary configuration, not normal49
acceptance. PHP/Go/compiler code and the guest ABI stay unchanged.

The earlier maintained scenario passes Node (`1f11`, 4m32s) and all three
browsers (`65e1`, 14m49s), zero retries/skips. Its current version now requires
the image-owned configuration service and supplies generic metadata instead
of injecting curl headers itself. That stronger final normal49 gate is
pending, as are the updated stock-cache app test and expanded memory capture.
The normal49 successor can fast-forward the completed own-SDK checkout and
reuse its successful package builds; the full canonical 198-node producer
continues separately on frozen source c51. The verified 5492 preview remains
unchanged.

**Current cron integration and maintained regressions.** The complete
controlled browser scenario `2557` passes Chromium, Firefox and WebKit in
14m37s, zero retries/skips. Its maintained shared Node regression `1f11`
passes in 4m32s with the normal offline egress link. Both use the retained
normal45 image plus the new ordinary Dinit configuration, not final normal
artifacts. A maintained shared browser regression is running as `65e1`.
Two earlier private preload attempts fail before meaningful execution:
`f558` needs the declared tsx loader; `53bb` installs the image-module class
in the parent rather than Vitest's isolated module realm. The final driver
uses Vitest setupFiles and the explicit hash-verified public fixture API.
No product behavior is changed for those harness failures.

Source inspection finds two actual integration gaps before preview
replacement. A partial shell's selection excludes unselected commands even
when the engine builds an image's direct dependency. WordPress48 therefore
installs its declared curl binary itself; family15 consumes that result.
The frozen normal47 producer `1e5b` is still building its useful dependency
closure and will retain its original inputs. The successor can reuse its
own SDK and completed package caches; no final47 composition is claimed.
Also, image composition knows only the generic `/computer` placeholder.
Browser boot now writes cron metadata after the service worker assigns the
real machine prefix and before Dinit starts. Protected candidate images
retain their original configuration; the premature composer input and
persistence fingerprint field are removed. No new Go/PHP/compiler patch,
ABI change or guest-library adaptation is introduced.

The updated stock-cache regression checks the actual cron configuration's
host and exact machine prefix, schedules upstream `wp_cache_gc`, and waits
for the guest Dinit/curl tick. It rejects browser requests to `wp-cron.php`.
This updated app/cache path has not run yet. Current app type checking has
exactly the same 182 diagnostics as the recorded baseline, at identical
locations/codes and no candidate-only errors; this is not a clean type-check
pass. The memory diagnostic now requests existing proc-map and host-storage
metadata counters alongside guest pages/Go/PHP/module counts; the expanded
capture has not run yet and establishes no new memory result.

**Automatic WordPress scheduling has a complete Node lifecycle control.**
The candidate uses ordinary Dinit dependencies and curl configuration to
invoke upstream `wp-cron.php` every sixty seconds while its service activity
runs. No WordPress/PHP/Go algorithm or host timer is substituted. A public
activity groups its server and scheduler; the scheduler depends on the
server. A generic optional activity stop target tells service control to
stop that process dependency with Dinit's `--force`, which stops its whole
dependent group, inhibits automatic restarts and waits for actual server
exit. Other service activities keep their existing generated commands.

Control `3ab1` passes in 4m40s on retained normal WordPress45 with the new
ordinary configuration applied in the image writer. A test-owned action is
scheduled through WordPress and executed by real guest curl/wp-cron. The
control proves inactivity during a full 65-second stop, resumed pending
work after restart, Caddy SIGKILL recovery, FPM and classic switches, no
Caddy scheduler requests during the following FPM minute, and held-PHP
request drain before clean shutdown. The action records the configured
public host/prefix. This proves scheduler ownership, not stock cache-GC
cleanup, rendered UI, normal revision47/family14 or final SDK acceptance.
Earlier `2617` exposes internal-group stop returning before server exit;
`dbd8` proves the stopped interval but fails the private fixture's readiness
probe at its old port8080. The final control declares the actual chosen
port in its service activities. Both failures remain retained.

The candidate declares curl in WordPress's direct dependencies and verifies
its installed path during image composition, so a partial image cannot
silently omit the scheduler command. Browser composition prepares the curl
headers from the public origin and machine prefix, while direct Node
configuration keeps its ordinary loopback endpoint. Browser lifecycle
control `9c8b` fails all three cases while loading its test artifacts,
before kernel startup. Corrected control `2557` uses the maintained
browser-host fixture's owned HTTP transport and passes all three engines
in 14m37s, with zero skips/retries. This remains the controlled normal45
image, not normal47/family14 or final UI/conformance acceptance. The shared
scenario is now being added as maintained Node and browser regressions.
The first maintained Node attempt `f558` stops in its private preload,
before loading tests, because Node's strip-only TypeScript mode rejects a
parameter property. Its corrected driver preloads the declared tsx loader
first; no product source change is needed. The app's strict
TypeScript invocation reports exactly the same 182 diagnostics, at identical
locations/codes, on the current review baseline and candidate; there are no
candidate-only diagnostics, and this is not a clean app type-check pass.
All current source changes remain isolated from the verified preview and
from the frozen full normal build.

**Function-catalog registration now rejects partial state.** A failed
registration previously left reverse recipes for entries before the first
null, even though no module was published. Registration now validates the
complete table before indexing its functions. A regression covers aliases,
unregistered decoding, valid retry and unload; 32 focused source checks and
three pure browser contracts pass on Chromium, Firefox and WebKit, with no
skips or retries. Imported host callbacks also rebind to the fresh instance.
This is a host correctness fix, not a memory or performance claim; no ABI,
guest package or compiler behavior changes. Raw evidence is retained in the
review checkout's `catalog-atomic-unit.log` and
`catalog-atomic-browser-reports`.

A separate bulk-table snapshot candidate remains outside this PR. Two real
Node Go-consumer probes, 46 source/authority checks and three browser
contracts pass; an expanded imported-callback check passes 38 source cases
and all three browsers. One serial WebKit WordPress pair passes both sides,
including 120 requests, crash recovery, held-request drain and destruction.
OS-reported peaks are 14.3 GiB baseline and 11.7 GiB candidate, with 778.0
and 675.2 MiB remaining sixty seconds after destruction. These observations
under concurrent full-build load establish no repeatable improvement,
allocation owner, throughput result or budget pass. Helper instances and
private tables are outside the normal program-module cache counters. Keep
the candidate isolated pending stronger evidence rather than adopt extra
runtime machinery from one pair.

**General fork-retirement admission now has cross-host evidence.** The host
preflights temporary retirement debt before shared-mapping synchronization,
continuation capture or Rust child creation. Host allocator callbacks run
outside kernel authority, and ready or delayed results re-enter through the
normal queue. Exact request, channel and memory-generation checks reject
obsolete continuations; stopped callers remain parked. Snapshot capture
still stays uninterrupted after child commit. There is no app retry, sleep,
forced GC, resource-limit increase, compiler change or guest ABI change.

Eight focused source files pass all 145 checks, including whole-runtime
scratch/authority audits, in 136 seconds. Both host declaration builds pass.
Node control `ea56` passes all three real family-switch cases in 1m54s:
Caddy/FPM sharing, both database backends, saved values and upload isolation.
It uses the immutable older normal family image with only the previously
proved ordinary MariaDB socket configuration restored; this is not a rebuilt
revision-13 acceptance. Browser `75a3` passes classic and Caddy on Chromium,
Firefox and WebKit: six cases, zero skips/retries, in 5m28s. Those exercise
PHP, OPcache, churn, parallel requests, Caddy crash recovery, held-request
drain and destruction on normal older WordPress image `1993e1bc29ef`.
They do not close rendered-editor, sustained, full conformance or final
coherent-artifact memory/lifecycle gates.

Earlier candidate checks retain their failures: one callback initially ran
inside kernel authority; it was moved into the detached host phase. A
ready-path test incorrectly assumed synchronous re-entry; actual queue
behavior is now asserted and documented. The callback-root inventory also
omitted the pre-existing child-rollback hook, and the authority inventory
omitted the upstream WASI regexp benchmark. Both omissions reproduce on
the parent source and are corrected with explicit reviewed entries, without
weakening assertions. All final focused checks pass. The normal full build
remains frozen at `c51ee03b5`; this later host fix still needs a normal warm
image refresh and final conformance/performance validation.

Evidence lives in the `fork-retirement-admission` checkout: private guarded
source config/log `fork-retirement-unit-v4`, `fork-retirement-typecheck`,
Node job `wordpress-family-fork-admission-gated-1108-041655-ea56`, and browser
job `wordpress-fork-admission-three-engines-1108-042633-75a3`. Each controlled
job retains inputs, selected artifact hashes, source diff and raw reports.

**Normal final refresh is publishing on the corrected source.** Job
`f2f6` finishes both own-SDK bootstraps and normal package-index generation,
then starts the complete 198-node validation union at source `c51ee03b5`,
including main `5f484a853eec` and family revision 13. Its historical
summed duration is about 254 minutes, not a promised completion time.
The output projection is new and immutable; existing preview/artifacts
remain pinned. Matching main provisioning `adf8` is queued behind the
refresh, with its own SDK and recorded main guard; no benchmark timings
have run. Prior refresh attempts retain their prerequisite, host-SSH and
stale-generated-index failures separately.

**Guest minute scheduling works in a controlled browser machine.** `e5bb`
passes the full cache/privacy/freshness sequence plus actual Dinit/curl
60-second scheduling of stock `wp-cron.php`. The second real tick removes
expired files and reschedules the stock hook; explicit service stop is
observed. This uses normal full WordPress revision 45, not the partial
preview or final refreshed images. Shipped automatic cron integration,
backend-switch/shutdown/restart behavior and Node/all-engine validation
remain open. See the visitor-cache checkpoint for exact evidence and the
two retained failed attempts. During the gap between normal builds, the
previously authorized one-day/ABI-below-50 cache GC safely collects
595.1 MiB; protected roots and active artifacts remain intact.

**Canonical build finished; family acceptance failed.** `4770` publishes
two normal images and three Go programs, passes layout and both standalone
WordPress Node cases, then fails all three selected family cases. One
switch encounters fork-retirement backpressure; MariaDB requests return
HTTP 500. Control `54a7` proves the family compositor overwrites FPM's
MariaDB socket configuration: original settings fail to connect, ordinary
socket settings connect and serve HTTP 200. The family revision-13 recipe
preserves FPM's configuration; embedded PHP already has a separate file.
Normal rebuilt-family acceptance remains pending. See the
[family checkpoint](2026-11-08-wordpress-family-checkpoint.md).

The review now includes fetched main `5f484a853eec` (Rust guest native-test
fixtures). All earlier queued jobs stop on their failed prerequisite;
none constitutes final validation. The fresh own-SDK refresh reaches SDK
bootstrap, then correctly rejects a stale generated package index before
publication. Its replacement must generate that index normally before
collecting browser demand. No receipts or artifacts are restamped.

**Index-reuse memory pilot does not establish a benefit.** Both sides of
`b633` pass real WebKit HTTP/lifecycle checks, but the candidate's OS peak
is 11.0 GiB versus baseline 9.9 GiB in this one pair. The candidate stays
on its separate branch; no memory fix is adopted or claimed. See the
[phase measurements](2026-11-08-wordpress-webkit-memory-checkpoint.md#module-function-index-ownership-pilot).

**Latest cache gate: six passes across three engines.** Job `7a70` ends
10m54s with classic and real Caddy passing on Chromium, Firefox and WebKit,
zero skips/retries. It covers privacy, post/template invalidation, real
expiry and explicitly requested stock cron cleanup. WordPress's configured
REST client stays in its loaded settings page; this does not close the
separate rendered-editor gate. FPM control `9ef2` separately passes after
ordinary metadata/ownership corrections inside its test-owned machine.
Normal revision-46/family-12 artifacts, automatic cron and final lifecycle
acceptance remain pending. Earlier failures are retained in the linked
visitor-cache report.

The full frozen build now captures two canonical images and three normal
Go programs and has entered Node validation. It is still an older-source
build, not final SDK/latest-main acceptance. A separate general host
candidate `0f7e14b77` reuses module-lifetime function identities instead of
rebuilding their index on every fork transaction. It passes 32 source
checks and both real Go/PHP Node consumer checks; a paired native-memory
pilot is running. Its memory/performance benefit is not established, and
it remains on a separate branch rather than in this PR. No PHP, plugin,
Go-library or compiler algorithm is changed by this candidate.

**Normal PHP-FPM image configuration correction prepared:** the controlled
CGI check observes missing server metadata, then `nginx/1.24.0` after adding
nginx's standard FastCGI parameter; WordPress's expected permalink option
then works (`ee8e`). Stock cache setup next reveals unwritable application
configuration/content paths. A separate FPM control `a2be` observes real
write checks false before ordinary UID/GID ownership changes and true
afterwards, then passes activation/cache-hit/privacy checks. It fails later
on a REST operation and is not full FPM acceptance. The source recipes now
prepare metadata plus ownership of mutable configuration and its parent
directories, with WordPress revision 46/family revision 12. Normal artifact
builds and final Node/browser acceptance remain pending; there is no
WordPress/plugin/PHP/Go algorithm patch. The pinned preview is unchanged.

**Visitor-cache correctness advances:** maintained browser checks now cover
stock plugin activation, anonymous cache hits, authenticated/POST bypass,
post and site-template invalidation, real-clock expiry, and execution of
the scheduled stock GC hook through actual `wp-cron.php`. The selected
ordinary settings disable stale rebuilds and enable clear-on-edit; plugin
and PHP algorithms remain unchanged. Chromium job `5f37` ends two pass /
one fail, zero skips/retries: both FrankenPHP services pass every check;
PHP-FPM fails earlier at its index-prefixed permalink controls. This is
revision-45 partial evidence, not automatic-cron, performance or final
canonical acceptance. See the [visitor-cache checkpoint](2026-11-08-wordpress-visitor-cache-checkpoint.md)
for exact runs, configuration and retained failed attempts. Automatic cron
is still disabled. FastCGI metadata and Firefox/WebKit controls are separate
unfinished checks.

The full frozen build has progressed past Quickshell to Ruby. Orphan-job
cleanup removes 298 abandoned run payloads while preserving active jobs;
removing only this effort's inactive debug caches restores free disk to
15,600,844,800 bytes at measurement. The package cache dry-run finds another
593 MiB eligible under the one-day/ABI-below-50 policy, but application
correctly skips the SourceOnly cache because the running build holds its
lock; zero package-cache bytes are removed. Release tools, SDKs, published
projections and the preview are preserved.

**Latest main integrated without changing the live producer:** the review
branch includes `c3703ba28d6e` (Rust guest tooling) and `b764fbf54856`
(porting documentation). The existing full build keeps frozen source
`04d6418ccf1b`; it has completed Clang/FFmpeg and is instrumenting Quickshell
at the last status check. Its caches remain useful, but its products cannot
serve as latest-main final acceptance. The original SDK-refresh driver
retains its stale-main guard. A separate refresh job `e936` waits for that
guarded driver to terminate, requires its failure and the unchanged family
source, then fast-forwards to reviewed merge `401235689658` only if fetched
main still matches `c3703ba28d6e`. It uses both of its own normal SDKs and a
new immutable output projection. No output from that queued job is claimed.
The previously prepared `faf9` benchmark baseline is now historical;
latest-main benchmark acceptance still needs a corresponding baseline.

**Controlled traffic and worker profiling close:** job `179b` passes three
serial WebKit selections in 9m58s. Each uses the same verified revision-45
partial image, two PHP threads, initial WordPress workload, 120 requests
at a minimum 500 ms cadence, crash recovery and graceful drain. WordPress
traffic grows from 5.2 to a selected 7.3 GiB footprint; tiny PHP and static
traffic stay near 5.1–5.3 GiB. Caddy linear memory stays 685.9 MiB, Go Sys
stays around 40–42 MiB and the module compilation count stays six. These
are single instrumented observations with different response bodies and
collection timing, not throughput or allocation-owner comparisons. The
whole-run peaks are 8.1/5.7/5.7 GiB; the later WordPress peak must not be
attributed entirely to traffic. Sixty-second post-destroy footprints are
851.6/911.1/856.7 MiB. No production memory budget or leak fix is established.

The maintained HTTP/lifecycle fixture now supports fixed request counts,
minimum cadence and WordPress/static/tiny-PHP targets, with exact response
validation and attached workload metadata. Existing duration mode remains
separate and passes both services on Chromium in `8598`: two passes in
53.3 seconds of browser time, zero skips/retries. No application change,
forced collection or engine flag is involved.

Read-only kernel-worker profiling `afe1` also passes, retaining two bounded
CPU traces with 2,261 and 2,180 stacks. It excludes nested Go/PHP workers
and does not measure allocation bytes. Corrected summaries use the first
frame as the observed leaf; the initial opposite-order summaries remain
non-authoritative evidence. Zero sample timestamps cannot be assigned to
precise phases, and source lines refer to Vite-transformed code. No single
allocation owner is established. See the detailed memory checkpoint for
the raw paths and limits. The f605 runtime audit also finds its raw
`atomicWait32` call only inside the bounded checkpoint helper; callers
cover channel/bootstrap, runtime locks, notes and sleep. This source audit
does not replace final runtime validation.

**Live native sampling and browser identity close:** `8b6f` passes in
12m28s including prerequisites (4.7 minutes in the browser). The same
normal partial image handles two-thread WordPress traffic, unchanged PHP
optimizer probes, four crash recoveries and graceful drain. OS peak is
10.5 GiB, Caddy linear memory stays 685.9 MiB through traffic, Go Sys is
40.2–42.4 MiB and sixty-second post-destroy footprint is 624.9 MiB.
Two native CPU samples show active JSCWarmUp allocation stacks and some
Wasm compilation; they do not identify allocation ownership or prove an
engine defect. Interval matching finds the first has no measurement pause,
but the second overlaps a soak measurement even though its finish-time
phase flag is false. Both original samples and the limitation are retained.

The fresh isolated browser installation `7405` exactly matches the tested
JavaScriptCore/WebCore/WebKit framework bytes for declared Playwright
1.63.0/revision2359. No shared browser cache is changed. The first identity
check `d43a` fails on a package-export restriction before downloading; a
resolved metadata-file path fixes that check. The detailed memory report
now includes all three module/source-buffer controls, both server/thread
controls, live sample intervals and browser identity verification. No
engine workaround, Go collector change or application algorithm patch is
adopted. Allocation ownership, final normal artifact refresh and release
acceptance remain open.

**Real file-picker uploads pass both services in all three engines:** job
`wordpress-media-uploader-ready-1108-003452-b8e1` ends PASS in 12m26s;
its six browser cases take 11.0 minutes, with zero skips or retries.
The maintained media-library test now includes the classic and real Caddy
profiles. Each opens WordPress's actual file chooser, uploads 2x2 and
256x256 PNGs through multipart requests, disables the source image, reloads
and requires byte-identical media recovery. The existing MariaDB/nginx
oversized-request 413 check stays on its own stack and is not run in this
selection. The exact revision-45 partial image, kernel, service-worker source
and selected Go daemons pass identity checks before execution. This remains
partial-image evidence, not final canonical acceptance.

The first executed selection `ac35` ends 3 pass / 3 fail in 15m25s: classic
on Chromium and both Firefox cases time out waiting for the first file
chooser; Caddy on Chromium and both WebKit cases pass. Failures retain
post-click uploader/input diagnostics and their original errors. The follow-up
waits for the generated HTML5 upload input to exist and be enabled before
clicking, and records document readiness/input bounds/hit targets without
changing the application. All twelve before-click snapshots in the passing
selection report a complete document. The previous failures did not capture
that instant, so this establishes a passing readiness-aware test rather
than proving the old click timing or fixing every editor intermittency.
The original failure report and imported failure evidence stay separate in
`.context/`; there is no application patch, forced click or chooser bypass.

**Compiled module and source-buffer ownership measured:** two WebKit
controls `aba9` pass in 2m29s without any guest instances or execution.
Compiling the exact 184,971,404-byte Caddy module reaches about 1.3 GiB.
Eight workers retaining only that module settle at a 708.8 MiB phase sample;
retaining source-byte copies as well reaches 2.6 GiB. Sixty seconds after
termination and dropping parent references, the samples are 682.3 MiB and
2.1 GiB. An independent worker-detachment control `d1f9` passes in 69.7s
of browser time (9m29s total including its prerequisite): each worker
acknowledges a detached buffer, and post-destroy footprint reaches 685.4 MiB
at sixty seconds. These are single diagnostic observations, not statistical
or per-worker cost equivalence, instantiation costs, throughput or leak
proof. Production already detaches these pthread payloads after setup;
this supports the existing cleanup policy rather than introducing a new fix.
The detailed memory report retains exact runs, source snapshots and limits.
The first private probe `af44` fails during discovery from two Playwright
installations; importing through the app fixture corrects the test setup.

Live native sampling `wordpress-live-native-stack-attribution-1108-004045-8b6f`
completed as recorded above. It triggers at inspector memory thresholds outside explicit
phase callbacks, binds the owned content PID afresh and retains sampling
start/finish/overlap records. It changes no engine flags or application
algorithms and cannot by itself identify allocation ownership. Prior
phase-bound samples paused request production and remain separate evidence.

The normal final SDK/product refresh `go-final-sdk-product-refresh-1108-004841-b919`
is queued after the old canonical publication, baseline preparation and old
native diagnostic. It guards the frozen family source, verifies latest main
still matches the recorded commit, fast-forwards to the reviewed SDK fix,
bootstraps both of its own SDKs and publishes a new full validation projection.
It preserves the old projection and the verified preview. The private
validation set also admits the deferred standalone Caddy and MariaDB image
needed by consumer/benchmark checks; shipped product exposure is unchanged.
It records the normal cache plan, then requires browser supply, image layout
and identities, four Go consumer Node checks and WordPress/family Node gates.
No output from this queued refresh is claimed yet.

The stale benchmark-source installer is updated to latest-main commit
`faf9b31720e8`; its read-only plan verifies both manifest pins and archives.
The queued installation `9347` waits for successful baseline publication,
then extracts the verified archives afresh and invokes normal WordPress
setup. It no longer trusts an old mutable extracted directory merely because
its archive matches. The first queue wrapper `e520` fails before work because
the old primary job tool has no scratch-directory variable; a private owned
fallback report path fixes that wrapper. No source installation or timings
have run. Final coherent artifact validation, broader lifecycle/accounting,
allocation attribution, visitor-cache policy and all performance gates stay
open. The current preview on 5492 remains pinned; no PHP/Go/Caddy algorithm
changes are introduced by this checkpoint.

**2026-11-08 server/thread memory controls:** job
`wordpress-native-control-matrix-1108-000416-647f` passes both additional
WebKit HTTP/lifecycle selections on the same verified revision-45 partial
image and consumer `2cabd2984735`. Classic with two configured PHP threads
stays at 2.3–2.7 GiB during traffic, with a 2.8 GiB largest phase sample and
2.9 GiB OS historical peak. Caddy with one actual PHP thread reaches a
13.8 GiB phase sample (14.3 GiB OS historical peak), then falls naturally to
4.8 GiB before shutdown while its linear memory stays 646 MiB. Go Sys is
40.7–42.4 MiB; the released thread endpoint confirms one PHP thread at every
measurement. Both selections pass unchanged PHP optimizer probes and held
request draining; Caddy also passes four crash recoveries. They retain
976.8 MiB and 668.3 MiB respectively sixty seconds after destruction.

The one-thread peak rules out PHP capacity alone as a sufficient explanation.
At its largest phase sample, `vmmap` reports 4.8 GiB resident and 7.5 GiB
`SWAPPED` in the broad `WebKit Malloc` class. Physical footprint is not
current resident RAM; these classes do not identify allocation sites or
prove an engine defect. The
[memory checkpoint](2026-11-08-wordpress-webkit-memory-checkpoint.md)
retains the comparison, exact run identities and limitations. A separate
compile/structured-clone-only control is queued behind rendered media tests;
it will not instantiate guest modules or change Go/PHP algorithms.

The completion audit finds the existing real file-picker test only covers
MariaDB/PHP-FPM. It now selects both FrankenPHP profiles too, preserving the
same small/thumbnail-sized multipart uploads and byte-for-byte recovery
with the source image disabled. nginx's existing oversized-body 413 check
remains on its own stack; no equivalent Caddy limit is assumed. The first
private driver attempt `a378` fails before tests because an explicit fixture
path contains `..`; the corrected canonical path starts `ac35`. Normal
browser setup builds its own pinned ABI baseline fixtures rather than
borrowing another SDK. Six browser cases are running; no pass is claimed.
The Go overview is corrected to distinguish historical consumer checks,
current optimized package/partial-image evidence and outstanding final
canonical/full memory-switch gates. Optional stock page cache is installed
but inactive by default. The running preview remains unchanged on 5492.

**Both optimized cgo targets reproduce:** the separate Caddy continuation
`go-caddy-o2-reproduction-1107-233634-d047` passes in 16m47s. Its normal
published revision-22 binary reproduces all 184,971,404 bytes, SHA-256
`cfdba6545bd43e20862d0448d7bb29c0e44ed2b76b239ae4e5da303b5ba3f2c6`.
The Node service check passes 32 requests at concurrency four while Go's
GC count advances from13 to30, with no host diagnostics and SIGTERM exit0.
Together with the retained classic proof, both newest C-O2 target binaries
now reproduce exactly with original Go build IDs. This is a normal target
recipe/output comparison on this Mac, not complete fresh-SDK or cross-host
reproduction; the SDK input-stamp distinction remains in its evidence.
No successful target is rerun merely because aggregate065a ended143.
The normal SDK/image refresh after the native-plugin metadata fix remains
separate required work; live old-source canonical inputs remain frozen.

**Measured WebKit lifecycle and SDK reproducibility checkpoint:** job
`wordpress-current-native-attribution-1107-230923-1640` passes in 5m50s
(browser 4.7m) on the exact revision-45 partial image, current kernel and
Go daemons. Real Caddy/PHP handles WordPress login/editor HTTP requests,
parallel editor bursts, request churn and a 120-second instrumented traffic
phase, then four SIGKILL recoveries and a held-request graceful shutdown.
The unchanged upstream PHP optimizer passes both 96- and 768-condition
probes twice. This is not a rendered-UI or fair throughput comparison.

The content process reaches a rounded OS peak of 10.6 GiB while Go reports
about 40-42 MiB Sys and the Caddy linear memory stays at 685.9 MiB through
the traffic growth. Kernel linear memory is 187.5 MiB. After destruction,
the same page falls from 2.4 GiB to 647.1 MiB over 60 seconds, with the
direct kernel-worker count dropping to zero. Inspector `page` is the large
bucket; two paused-producer native stack samples do not identify allocation
sites. Counters overlap and must not be added. This demonstrates partial
reclamation, not a leak fix or acceptable service budgets. The
[detailed memory checkpoint](2026-11-08-wordpress-webkit-memory-checkpoint.md)
retains versions, source/artifact provenance, measurement boundaries and
next experiments. Module-cache weights are clarified in profiling guidance.

The main-world-versus-locator diagnostic `c558` ends two Firefox passes in
5m11s on the same current image. Earlier one-pass/one-fail attempts remain
recorded; instrumentation and passing repetitions do not establish a UI fix.
The final all-33 gate and broader browser-memory/lifecycle inventory remain
open. The running preview on5492 stays pinned and returns HTTP200.

The normal forced classic revision-41 recipe reproduces all 69,939,352
bytes (`f1314f3e7675`), retaining original Go build IDs, and passes Node PHP,
static-file, OPcache and 32-request/concurrency-four string-lifetime checks
across Go GC cycles, with normal exit0. The aggregate `065a` job is
intentionally stopped143 before its remaining Caddy proof while differing
SDK input stamps are investigated; its completed classic proof is retained.
A Caddy-only continuation `go-caddy-o2-reproduction-1107-233634-d047` is
active. This compares normal target output bytes, not full fresh-SDK or
cross-machine reproducibility; its reference/input distinctions stay explicit.

The SDK investigation finds two native compiler plugins with the same source
key but different Mach-O library IDs containing their temporary paths/PIDs.
Their different hashes enter musl input fingerprints even though the target
libc archives compare byte-identical. A general SDK fix sets the normal
macOS library ID to `@rpath/KandeloCallTypes.dylib` and normalizes the plugin's
own source paths. No Go/PHP/Caddy algorithm changes. A maintained test builds
the plugin under two different source/staging roots, compares full library
bytes, loads both through the declared raw LLVM compiler and checks equal
Wasm objects containing compiler facts: PASS23.5s on macOS. The initial
object-load probe incorrectly used Nix's native-target wrapper; switching
the test to the declared unwrapped LLVM_BIN resolves that test setup error.
Integrated evidence-class validation agrees on all677 files. Linux and the
normal SDK/package/image refresh after this metadata fix are not yet run.

The SDK patch is isolated from the still-running family checkout, whose
source remains04d6418cc. That old-source canonical graph keeps independent
work after its already-recorded missing-submodule failures; its guarded4770
retry and63d2 baseline preparation remain queued. Do not edit those live
inputs or restamp their results as the newer SDK source. Latest main is
fetched again and remainsfaf9b31720e8; ABI55 is unchanged. The original full
goal, final coherent artifact refresh, native allocation attribution,
resource budgets, visitor-cache policy and all performance gates stay open.

**Exact-preview editor observations:** the current revision-45 image
`9cbbb185ced4`, kernel `6f5afada9ae3`, both normal Go daemons and identical
service-worker source pass admission before the Firefox repetitions. Job
`wordpress-current-preview-persistence-v2-1107-224727-d112` ends 1 pass /
1 fail in 5m53s. The failed initial editor has a complete controlled srcdoc
canvas with the actual Add title textbox, while its welcome dialog remains
open after the test's Close action. Caddy and PHP remain running.

A separate read-only click observation ends 1 pass / 1 fail in 6m13s
(`wordpress-welcome-click-observation-1107-225617-175c`). Both cases deliver
a trusted click to the actual welcome Close button. The second failure
occurs later, on reopening the saved post: the canvas contains the correct
editable title, but the outer document's HTML locator times out. This is
not evidence that the title is missing. Immediate preference observations
also look unchanged in the passing case, so they do not establish a lost
click or a preferences-hydration cause. New failure diagnostics compare a
direct main-world document read with the locator observation; the next
selection is still active. No runtime fix is claimed and no checks are
removed or retried inside the test.

Native WebKit attribution job `0cfe` is queued behind the normal canonical
retry and baseline product preparation. It will use the canonical image
and kernel, compare production source identity, retain separate guest,
engine and native counters, sample at most two owned high-footprint
processes, exercise four Caddy crash recoveries and held-request shutdown,
and observe 60 seconds after destruction. It admits host memory separately
from guest budgets and uses no forced collection. The queued job is not a
memory result or a final lifecycle pass.

**Shared-browser delivery investigation and normal build recovery:** the
PHP-FPM Firefox control `wordpress-media-fpm-control-v2-1107-222731-c782`
ends with two failures in 7m10s, both at reopened editor-canvas readiness.
Its screenshot renders the post title and uploaded image; this is not
proof that the expected iframe structure is present. Stronger diagnostics
retain redirect chains, request method/type/frame, service-worker response
and controller information, and failed-frame DOM/editable inventories.
The subsequent diagnostic selection passes once in 1m46s and twice more
in 3m18s (`207a`, `b846`). These mixed outcomes remain intermittent; no
editor fix or final all-33 acceptance is claimed.

The diagnostic captures a separate, reduced delivery defect: WordPress's
unchanged preferences-persistence library uses keepalive Fetch for user
preferences. The POST has no redirect and originates in a controlled
WordPress document, yet Firefox sends it to Vite, which returns the
truthful unhandled-computer-route HTTP503. A complete persistence run
also passes with these failed preference requests, so this does not
establish the cause of the editor observation failures.

A native-API-only GET/POST/PUT control reproduces keepalive bypass on
Playwright Firefox155.0 and an isolated headless profile of installed
Firefox159.0.1. Chromium153.0.8010.12 and WebKit26.6 intercept both ordinary
and keepalive requests. The maintained self-judging reproduction and
explicit delivery limitation are recorded as
`FIREFOX-KEEPALIVE-SW-BYPASS`; registry consistency (12 entries) and its
selected Firefox run pass. No application adaptation or keepalive-disabling
shim is adopted. No upstream report is filed. Native profile cleanup
leaves a macOS-protected temporary Downloads directory, separately from
its successful HTTP observations; no user browser or other agent is closed.

The normal full canonical/family job `60a4` continues independent work
after Harper and kandelo-cc fail because this fresh worktree lacked its
pinned Rust libc submodule. The reviewed submodule is now initialized at
`71d5bfcc1bda`; no recipe/source patch is required. A normal cache-preserving
retry `wordpress-canonical-family-resume-1107-223346-4770` waits for the
first graph to terminate and admits only those exact two failures before
retrying the same projection. Both attempts remain separate evidence.
The canonical images and family runtime tests are still unvalidated.

Latest main is fetched again at `faf9b31720e8`, already included; ABI55
is unchanged. The verified revision-45 preview remains pinned on5492.
The first current-image persistence admission correctly refuses the old
comparison checkout's service-worker source: it lacked the already-tested
Fetch-credentials correction. No browser executes in that three-second
failed admission. That correction is now integrated into the comparison
checkout, so its next browser run must verify the actual served revision-45
image, identical normal kernel/Go programs and identical service-worker
source before testing. This remains partial-image evidence, not canonical
acceptance. A separate latest-main benchmark-product job `63d2` is queued
behind successful canonical/family validation; it performs no timings.
The full original memory, lifecycle, sustained-traffic, cache-policy and
Node/Chromium comparison requirements remain open.

**Revision-45 runtime/configuration and verified replacement preview:** the
normal own-SDK partial refresh completes its image, FHS and exact embedded
program/plugin audits. Both extended Node service cases pass (2/2, no skips),
including disk opcode priming and atomic configuration replacement. Image
`9cbbb185ced4efb4449ad66f58537b42fa51c1d97b44ea54dea809cb22e92e39`
is 83,506,932 bytes; kernel remains `6f5afada9ae3`, classic `f1314f3e7675`,
Caddy `cfdba6545bd4`. The aggregate b192 job exits1 after 43m55s because its
last browser probe assumed an optional upstream cache-hit header was on.
It is false in the stock generated wp-cache-config.php. The retained probe
already shows anonymous cache-marked bodies, logged-in bypass and POST
bypass; this was not another cookie leak or build failure.

A new browser-only run enables the ordinary generated setting
`$wpsc_served_header = true` through maker/sudo, leaving all 92 upstream
plugin files unchanged. Job `wordpress-cache-header-1107-214022-60b2` passes
in 1m05s: the second anonymous response has
`X-WP-Super-Cache: Served supercache file from PHP`, a generated-cache footer
and no admin bar; authenticated GET and anonymous POST have no cache marker
or hit header, with the admin bar only on authenticated GET. All four return
HTTP200. No compiler, image, kernel or PHP-source rebuild is needed for this
fixture configuration correction. Expiry/GC/edit invalidation remain open.

The new ordinary partial app is live on port5492. Proof job
`wordpress-config-preview-proof-v3-1107-214417-67fe` passes in 57 seconds:
actual image/kernel SHA-256, demo Login, Appearance Editor and a real template
save. Its verified-preview.json and screenshot are under configuration
checkout `.context/candidate-partial-preview-proof-v3/`. URL:
<http://127.0.0.1:5492/?vfs=http%3A%2F%2F127.0.0.1%3A5492%2F%40kandelo-partial%2Fimage.vfs.zst&profile=wordpress-frankenphp-caddy>.
Server `wordpress-config-preview-v2-1107-214200-d6c1` remains live, with its
source/artifacts pinned. Older5457/5464/5486 previews remain available. The
first queued proof/build jobs correctly refuse the aggregate failed b192;
the second proof races run.sh's own app dependency installation and fails
module import before browser execution. Once that owned installation and
HTTP readiness finish, v3 passes. These attempts remain separate evidence.

**Persistence follow-up:** title-focus/store-observation rerun 1f1a passes
Chromium and WebKit but fails Firefox before restart: the saved uploaded
block does not render as the required 2x2 PNG in the reopened editor. The
strong assertion remains. The fixture now leaves the active editor before
its external REST content replacement and checks the returned saved content,
so WordPress save/autosave cannot race that external edit. Its Firefox-only
rerun `wordpress-media-recheck-1107-214653-32dc` is active; no pass is claimed
yet. Canonical artifact construction can proceed from the verified new
configuration; final UI acceptance remains a separate required gate.
Main is re-fetched and still faf9b31720e8. No upstream application algorithm
or Go collector/code generator changes are made in these steps.

**Optimized 33-case result and editor fixture correction:** job b446 ends
exit1 after 1h33m including build; browser execution takes 40 minutes with
32 passes and one WebKit experimental-persistence failure. All 27 ordinary
three-engine WordPress UI cases pass, along with all Chromium/Firefox
persistence cases and WebKit library persistence. The failed experimental
case stops at Publish before persistence restart: the welcome dialog is
dismissed only during that click, Publish stays disabled, and the diagnostic
screenshot shows an empty title. Caddy and its PHP threads remain running;
its retained service log has normal startup. Page lifecycle evidence also
records compression-test XHR access-control errors and an unhandled promise;
those are retained, not dismissed as proven unrelated.

The editor helper now clicks the real title field before filling it,
allowing normal pointer actionability checks to dismiss the welcome overlay,
and observes the WordPress editor store receiving the title before Publish.
No forced click, timeout increase, store mutation or application patch. This
matches the already-used template helper's focus behavior and Playwright's
[documented actionability checks](https://playwright.dev/docs/actionability).
The original failed case remains evidence; the correction still needs its
three-engine targeted rerun, queued as
`wordpress-publish-recheck-1107-212850-1f1a` after the configuration preview.
The original artifacts are in comparison checkout test-results run
`509f7e4b-3317-40a0-a5f4-1389eba4d7a3`; page-lifecycle.jsonl and the failed
screenshot retain the exact observations. The global 33-case gate is not
claimed green.

The separate revision-45 build b192 is now active after b446's terminal
result, with the prior failure recorded explicitly. The new configuration
preview/proof jobs 4386/1dc9 remain queued. The canonical/family phase a37c
waits for that actual preview and the corrected persistence rerun before its
own SDK/full normal graph; no independent worktree SDK is borrowed.

**Canonical WordPress family integration prepared:** the family currently
starts from LAMP and copies only SQLite-specific files from the WordPress
image, so it lacks the new Caddy daemon, PHP configuration and service offer.
An isolated composition change copies the exact normal Caddy package and
configuration, selects the family's existing SQLite content directory through
the ordinary process environment, and uses standard Caddy routing for that
site's uploads. The service control preflight now maps Caddy to SQLite while
retaining MariaDB as a separate site. No upstream PHP, FrankenPHP, Caddy or
Go source changes. The canonical WordPress image still offers both standalone
classic and Caddy; the combined family adds real Caddy as the SQLite server
alternative. PHP-FPM receives the same timestamp revalidation settings.

Family revision 11 declares the new activity/profile and carries unchanged
WP Super Cache. A maintained Node case checks Caddy/FPM SQLite data sharing,
MariaDB isolation, static uploads and denied PHP/database paths. The existing
two browser family cases now switch to real Caddy and read the SQLite post
and actual uploaded image without exposing the MariaDB upload. These cases
and the normal canonical/family build have not run yet. They are the next
integration phase after the queued revision-45 configuration preview.

**Build admission and owned-resource cleanup:** disk headroom falls to
about 11 GiB during the browser run. Seven superseded, exact owned Vite
preview process groups on 5417/5451–5456 are retired with SIGTERM; their
exit143 results are intentional cleanup, not validation failures. Verified
previews 5457, 5464 and 5486 remain HTTP200. No other agent or user app is
stopped. Standard Cargo cleanup and removal of only the primary checkout's
remaining idle generated Rust debug directories restore about 10 GiB,
leaving 21.6 GiB free at collection. Source, SDK, release binaries, image
cohorts and evidence are preserved. The primary `.context/` holds the exact
preview retirement manifest, per-job exit logs and debug recovery receipt.

The dry canonical/family and latest-main benchmark plans are prepared.
A fresh projection reports many nodes as will-run because its materialized
members do not yet exist, even when the child can reuse compiled cache
entries. Inspection confirms the normal precheck requires both canonical
cache provenance and matching projected members. The package guide now
makes that distinction explicit; these plan counts are not evidence of
unnecessary recompilation. No canonical build or timing has yet run.

**Optimized artifact checkpoint:** the normal revision-41 classic and
revision-22 Caddy package builds complete at source 7d85f1674, with the
upstream PHP CFG optimizer unchanged. The partial image passes FHS and
embedded daemon/plugin identity audits; both actual Node service cases pass,
including real requests and graceful shutdown. This is job
`frankenphp-cgo-optimized-checkpoint-1107-195055-b446`; its three-engine
33-case rendered UI/persistence gate remains active. All eleven Chromium
cases pass, including both source-independent OPFS persistence backends.
Firefox/WebKit completion is not yet claimed.

| Artifact | Previous partial cohort | New optimized partial cohort |
| --- | ---: | ---: |
| Caddy Wasm | 185,037,671 bytes | 184,971,404 bytes |
| Classic Wasm | 70,004,510 bytes | 69,939,352 bytes |
| Compressed WordPress image | 83,524,699 bytes | 83,507,731 bytes |

The new image is
`969ec16b4d2bdf90edc45e294f1ff61b023594a11160be5fa6452b9ccc0ffca7`;
kernel remains `6f5afada9ae3`. Caddy is `cfdba6545bd4`, classic
`f1314f3e7675`. These historical/new observations are not an independent
same-key reproduction or a speed result. Restoring C compilation's missing
-O2 therefore does not explain most of the image size. The normal pipeline
already applies post-instrumentation size optimization. Linked dependencies,
instrumentation, three bundled server alternatives and PHP bytecode caches
remain substantial contributors; none has been removed to mask the cost.

**Combined configuration validation queued:** job
`wordpress-mutable-config-1107-205359-b192` waits for the frozen 33-case run
before its own normal revision-45 partial build. Its isolated checkout
contains the tested Fetch-credentials correction and both INI changes. It
will audit exact selected programs/plugin bytes, run the extended two-service
Node configuration-replacement checks, then use the actual admin UI to enable
the unchanged cache plugin and test anonymous hits, authenticated bypass and
POST bypass. The old previews remain pinned. Canonical/family artifacts,
full final-cohort browser/memory/lifecycle acceptance, cache expiry/edit
invalidation and both kinds of performance comparisons remain open.

**Mutable PHP configuration fix prepared:** WordPress revision 45 enables
OPcache timestamp validation with revalidate_freq=0 for both PHP-FPM and
FrankenPHP. The image prewarmer already normalizes source timestamps before
compiling, preserving usable bytecode while allowing real plugin edits.
The existing two-service Node gate now includes a PHP fixture that primes
an actual disk opcode entry, atomically replaces its configuration file,
invokes ordinary invalidation and requires a subsequent request to read the
new value. The fixture's PHP syntax and TypeScript loading pass; these
extended Node cases have not yet run on a newly built revision-45 image.
The successful manual INI/restart browser experiment and native control
recorded below justify this ordinary configuration change. No PHP/plugin algorithm
is modified. Normal image construction and final browser/cache/lifecycle
acceptance remain required after the ongoing cgo build completes.

**Visitor-cache investigation and browser credential correction:** the stock
WP Super Cache 3.1.5 plugin activates through the real WordPress admin UI.
Its settings require pretty permalinks; ordinary admin setup satisfies that
prerequisite. The next notice reports WP_CACHE false even though Internals
reads the plugin's inserted true constant on line 2 of wp-config.php, before
WordPress loads on line 76. A native PHP 8.5.12 file-cache-only control also
reads stale code with timestamp validation off: invalidation returns false;
turning validation on reads the changed file. This is a version/configuration
diagnostic, not a general claim about every PHP release or a runtime patch.

On the current c027/6f5a partial, a test-owned browser uses the ordinary maker
terminal, sudo, the installed dinit control socket and actual HTTP readiness
to set validate_timestamps=1/revalidate_freq=0 and restart real Caddy. The
unchanged plugin then enables caching and retains that setting after fresh
navigation (`wordpress-super-cache-revalidation-v4-1107-201609-db8c`, 1m10s).
Earlier attempts retain the normal maker permission error, wrong default
control socket and premature navigation before the listener was ready.
The native control is `.context/php-file-cache-invalidation-control-20261108/`
and browser reports are in the kernel evaluation checkout's owned jobs.
Revision 45 now prepares this INI setting for both server stacks, but its
new image has not yet built. Cron remains disabled;
expiry/garbage collection and post/template invalidation are not validated.

The anonymous cache probe exposes a general browser adapter defect: the
service worker always injects the machine's virtual login cookies, including
for Fetch credentials=omit, so all supposedly anonymous responses remain
logged in and no visitor cache hit is established. The shared bridge now
honors credentials for cookie replay and response storage. The corrected
maintained regression fails its three omit cases before the fix, with the
other nine controls passing, then passes all 12 across Chromium/Firefox/
WebKit after the fix (jobs b5f5/e69c). Initial probes used a response header
the fixture does not emit; they are retained as invalid fixture observations,
not runtime reproductions. Four bootstrap source cases pass. The full
three-engine bridge selection passes 94 cases in 59.6 seconds, with 14
existing documented CDP-only restart skips and zero unexpected/flaky cases
(`cookie-credentials-full-bridge-1107-203051-1725`). This validates the browser
cookie contract, not full WordPress visitor caching or final artifacts.

**Normal optimization build:** the peer cache-lock owner finishes, allowing
the previously authorized protected cache-GC policy to reclaim 16.3 GiB.
The build admits 26,662,543,360 free bytes and starts its own SDK and normal
partial pipeline at source 7d85f1674. Caddy revision 22 links at 139,296,003
bytes before instrumentation: code 84,042,711; data 48,967,177; names 5,865,315.
The exact linked input is retained read-only in job b446's report with hash
2ec5ad70072fb587ee956d626de1fc0f6e525686fa9ef347d01cf6dfcb927f4b.
It is not an admissible instrumented program. Final instrumentation, classic
revision 41, image audits and the queued Node/33-case gates are still active;
no size saving, independent reproduction or performance result is claimed.
Both existing preview sources/artifacts remain pinned until replacement proof.

**Fresh combined-source preview:** the normal partial WordPress rebuild
finishes in 1h27m with its FHS and embedded-program/plugin identity audits.
After the composer correction is integrated, a normal refresh takes 3m20s
with all 43 selected dependency nodes cached. Its image is
`c027dd4441e68c11767deeaf8da6242a37e3ee6ab209f91eff4bc97651abeffe`;
kernel `6f5afada9ae3`, classic `3dafa57690ed`, and Caddy `5da4b0e70382`.
The initial build's complete image/kernel/program bytes are retained before
refreshing the uncached partial output. Different historical hashes are not
treated as independent same-key reproduction.

Both current Node service cases pass in 1m10s, including the normal host
build (`wordpress-current-node-1107-185455-b068`). The normal partial web app
then passes the actual Chromium preview check in 1m05s
(`frankenphp-current-preview-proof-1107-190148-632c`): streamed image hash,
actual fetched kernel hash, the demo login button, Appearance Editor and a
real template save. Source inputs match the combined implementation at
`8842bb2b4`. Screenshot and verified-preview.json are under
`.context/candidate-partial-preview-proof/` in the isolated checkout.
The verified new development URL is
<http://127.0.0.1:5486/?vfs=http%3A%2F%2F127.0.0.1%3A5486%2F%40kandelo-partial%2Fimage.vfs.zst&profile=wordpress-frankenphp-caddy>.
The original 5464 preview remains available. Full 33-case three-engine
UI/persistence, canonical/family, memory/lifecycle and performance acceptance
are still pending. These are partial development artifacts, not release proof.

**Browser infrastructure checkpoint:** the first current 33-case attempt
(`wordpress-current-browser33-1107-190720-3da4`) is stopped after its first
navigation failure, not counted as application validation. Its external
Playwright configuration made Vite start in `.context`, causing React
resolution failures and an HTTP error before WordPress boot. Diagnostics
then consumed the case deadline because their timeout covered the final
Internals click but not opening More. The shared configuration now pins
`webServer.cwd` to the app; the dock helper forwards the timeout through
both actions. An external-config regression passes all 12 selected cases
across Chromium, Firefox and WebKit, including actual app rendering and
cross-origin isolation (`dock-external-regression-v2-1107-193135-c116`,
15.7 seconds). The initial helper attempt retains three incorrect fixture
markup assertions and a missing resolver selection; both test-setup errors
are corrected. Firefox's test-owned storage cleanup still reports EACCES;
this does not turn the successful assertions into a cleanup guarantee.
The current 33-case rendered WordPress/persistence run must be restarted.

**Current kernel wait coverage and disk interruption:** all four existing,
hash-verified f605 wait/netpoll programs pass Node with empty stderr and
host diagnostics (`current-kernel-go-waits-1107-193622-9664`, 51 seconds).
The corresponding 12 Chromium/Firefox/WebKit cases pass on kernel
`6f5afada9ae3` (`current-kernel-go-browser-1107-194258-966b`, 1m07s job).
This refreshes selected functional evidence, not fixture reproduction,
physical reclamation or broad Go conformance. The latter run still uses
the previous cleanup helper and retains its teardown EACCES separately.

The 33-case retry `wordpress-current-browser33-v2-1107-193237-daeb` is
stopped143 after 11m19s: six Chromium cases pass, the Caddy template case
fails before WordPress boots with ENOSPC/overlay storage, and the rest
remain incomplete. It is not an editor-save failure or a passing suite.
Host disk falls from roughly 2 GiB to 600 MiB free. The normal cache-GC
policy previously authorized by the user (unused for one day / below ABI
50) identifies 16.3 GiB, but application safely skips the source cache
because another workspace's build holds its lock; zero bytes are removed.
The unrelated owner is Lansing job `mho22-setup-forkchurn-1107-181256-598b`;
never stop it. Only this idle evaluation checkout's generated Rust debug
outputs are removed, retaining all release binaries, SDK, source, reports,
verified images and previews; free space then reaches 9.4 GiB. The exact failed
Caddy template case then passes, including UI save and fresh-navigation
readback (`wordpress-storage-recovery-pilot-1107-194808-247d`, 56 seconds),
with successful private-home cleanup and no skipped/flaky case. This is
consistent with the observed host disk pressure, not final 33-case
acceptance. Wait for the peer build before applying the same protected
cache-GC policy and starting the new cgo partial build; do not overlap its
large memory/disk demands.

**Private browser storage cleanup:** macOS's deny-delete directory ACLs
are observed on both Firefox's Downloads and nested Library/Application
Support in the run-owned home. Cleanup now visits owned directories only,
removes their ACLs and leaves symbolic links and files untouched. Ten
source cases pass, including actual deny-delete ACLs and linked external
folders whose ACL/content must remain unchanged. Six real browser cases
pass across Chromium, Firefox and WebKit, and their private home is removed
without a cleanup warning (`browser-storage-acls-v3-1107-194157-f545`,
13-second job / browser assertions in its owned report). The first real
attempt was stopped143 because global setup started an unnecessary pinned
historical baseline rebuild; the exact manifest-verified existing cohort
was installed without compilation/restamping. The second attempt passes
six assertions but its explicit cleanup gate fails on the nested ACL;
that failure remains separate. The final helper covers nested folders.

**Cgo optimization evaluation prepared:** a separate checkout restores
explicit O2 for the C portions of both FrankenPHP builds and records linked
and post-instrumentation byte counts. Classic revision 41 and combined
Caddy revision 22 invalidate the appropriate normal package cache entries.
Only build flags/logging change; PHP, Caddy, FrankenPHP and Go algorithms
remain unchanged. Shell syntax and whitespace checks pass; the new recipes
have not yet built or run. Preserve the existing verified preview and
current browser run until the replacement is demonstrated. The evaluation
uses the normal partial WordPress build, with its own SDK and image outputs,
shared content-addressed dependency cache and one package job. Begin only
after the current browser run finishes to avoid overlapping the large
instrumentation and WebKit footprints.

**Image-size investigation:** the current image is 83,524,699 compressed
bytes and embeds 434,019,464 unique file bytes: combined Caddy 185,037,671,
standalone classic 70,004,510, PHP-FPM 36,999,507, WordPress 89,895,580 and
precompiled PHP cache 47,459,112. The combined Caddy has 134,782,834 bytes
of code and 48,368,731 bytes of data, with no large debug sections. PHP is
compiled at O2 and instrumentation defaults to a post-optimization at Os.
The cgo recipes override CGO_CFLAGS with include paths only, replacing Go's
normal O2 defaults for initial C compilation. This is a concrete flag gap,
not a measured explanation for the binary size. A controlled normal build
must capture pre/post instrumentation sizes and evaluate restoring O2;
there is no original reference on the current Caddy output from which to
recover its pre-instrumentation bytes. No stripping or size/performance
claim is adopted. Private measurements: `.context/current-image-size.json`
and `.context/caddy-wasm-sections.json` in the isolated checkout.

**Comparison configuration checkpoint:** the benchmark and composer changes
are integrated in the current PR. One explicitly configured image defaults
to two PHP workers per service, retains source/configured/kernel identities,
uses disposable preparation and checks actual effective capacity on both
hosts. The composer now preserves a smaller explicit static pool and all
other settings, capping only recognized oversized pools. This fixes its
observed rewrite from the requested two workers to six. Dynamic, included
and ambiguous pools remain for ordinary resource-budget enforcement.
The corrected run passes all four actual FPM/Caddy cases on Node/Chromium
in 1m58s (`wordpress-comparison-functional-v4-1107-182848-56ee`, source
`8fa97d2e493e`), using retained partial image `464d553bb3e5` and kernel
`6f5410ea67d0`. The configured image is
`7e2a102c02fc57e5ba65650a287bd588c4c08f9d614a3585c91a0bcb876665da`.
Preparation takes 2,993 ms with level 3 compression; the release image is
unchanged. Earlier attempts retain the missing-writer error, rejected
browser capacity and preparation timeout. The final source selection
passes 82 cases: 25 configuration, 14 composer client and 43 memory-profile
checks, plus its host/declaration build and 676 file classifications.
A broad TypeScript check retains the pre-existing WebGL cast diagnostic;
no new benchmark diagnostic appears. The smoke runs alongside a package
build and is not performance or final-cohort acceptance. Visitor-cache
behavior is still unvalidated. Raw evidence is under the comparison
checkout's `.context/agent-jobs/` and `.context/wordpress-pool-source-gates-v2/`.

**Workflow update:** main's campaign checkpoints and per-run validation
isolation are merged. Both offline-listener fixtures are retained under
distinct names, with one shared backend implementation. Post-merge checks
pass 102 Node cases, all 675 file classifications and three real WordPress
browser-host cases, zero skips/flaky. The browser run selects port 49381
and UUID-owned output. The existing wait-guard registration is refreshed
from the exact main installer and checks current. No new optional client
hook or worker rotation is installed. The generic composer-to-kernel owned
handoff passes its focused composer/lifecycle selection; rendered partial
WordPress UI verification remains next.


**Kernel/process memory separation candidate:** a normal-SDK regression
reproduces redundant kernel growth on Node and all three browser engines,
for both pointer widths. Its guest mappings reach 278,724,608 bytes while
the old kernel follows them to 278,462,464 bytes. After removing the two
legacy growth calls and their helper, the same browser cases keep kernel
capacity at 1,966,080 bytes while guest data, zero-fill, remap, file mapping
and logical refusal checks pass. Forty-two focused Node cases and 36
browser cases pass with zero skips/flaky cases on normal kernel artifact
`3db2d239c003` in the isolated `kernel-memory-separation` checkout. The Node
selection includes unchanged ABI-55 programs and allocator reuse. No Go,
PHP, SDK, process-memory budget or application algorithm changes are made.
This proves separate logical capacities in the focused workload, not lower
native WordPress footprint or full lifecycle/performance acceptance.

The direct-call audit finds `kernel_brk` internal and channel-only; the
normal SDK does not link the retired direct-import glue. The fixture
exercises brk query/refusal, not positive brk growth: normal C startup has
already placed a live mapping beside the break. A proposed custom-entry
fixture was discarded instead of changing the SDK/CRT for this test.
The serial validation run passes 3,966 workspace Rust checks, the ABI
snapshot and all 674 test-file classifications. Selected allocation and
unmapping conformance completes on both Node and Chromium: each host has
seven passes and three documented expected failures, no unexpected ones.
The first Rust run overrode the committed serial setting with two threads
and aborted; that runner-error report is retained separately.

The real WordPress backend gate passes all three engines in 9m13s, zero
skips/flaky cases, with unchanged image `464d553bb3e5` and Caddy
`f5771507fe1e`. It includes 90-second traffic, editor HTTP bursts,
SIGKILL/restart and held-request draining. Kernel capacity stays at
196,673,536 bytes throughout traffic while Caddy reaches 713,031,680.
After restart the kernel high-water mark is 381,747,200 bytes. WebKit
samples reach 7.1G physical footprint and report 890.2M at 60 seconds after
destruction. These vmmap labels are one diagnostic observation, not RSS,
a sustained bound or an improvement percentage. The earlier 9.2G run
completed a different request count; do not infer throughput or physical
savings by subtracting those samples. Repeated recovery still needs testing.

A first application attempt correctly refused a utility body from the
wrong lazy-member cohort before PHP ran. Image inspection verifies the
expected coreutils digest `3bb59de1a992`, while the new projection serves
`ac4624a82d9b`. The test now accepts an explicit asset directory for retained
images and uses the preserved preview's matching, hash-checked transport.
No image digest, receipt or admission check is changed, and no PHP/Go
rebuild is needed for this controlled kernel comparison. Preserve the
failed run as setup evidence, not a kernel regression.

**Next general memory improvement:** the 79.7 MiB compressed image decodes
to about 440 MiB. Current non-owning browser initialization clones that
host-created decoded buffer. A two-case, no-guest-entry WebKit control
compares the existing preserve/owned APIs in distinct content processes:

| Existing API | Initialized footprint | After 10 seconds | Destroyed plus 30 seconds |
| --- | ---: | ---: | ---: |
| Preserve caller input | 2.5G | 2.4G | 2.0G |
| Explicit owned handoff | 1.2G | 716.3M | 175.3M |

Both controls boot the same image and read WordPress 7.0 with no guest
process. Both retain the 83,524,156-byte compressed caller buffer; the
owned path transfers its fresh decoded buffer. This isolates an avoidable
host image handoff cost, not a Go/PHP collector defect. Evaluate a general
Node/browser fix that transfers host-owned decoded buffers while preserving
all caller-owned raw/compressed inputs and the existing raw-copy contract.
The general Node/browser fix now transfers freshly decoded/default buffers
while retaining the raw caller-copy contract. It captures the original
browser input before awaiting initialization, so replacing the options
cannot transfer the caller's raw backing. The compiled host and 91 host
cases pass, including ordinary/shared raw and compressed input preservation.
All six image-only cases pass across Chromium, Firefox and WebKit. With the
fix, the preserve-input WebKit case samples 1.2G at initialization, 715.1M
after ten seconds and 174.9M thirty seconds after destruction; its compressed
caller input remains intact. This is one startup control, not a whole-app
resource bound. The initial control invocation used the wrong Playwright
working directory and failed collection; that report remains separate.

The real backend revalidation also passes all three browsers, with four
SIGKILL/restart cycles, traffic and graceful draining, zero skips/flaky
cases. Kernel capacity rises once to 381,747,200 bytes, then stays there
through all four recoveries on each engine. WebKit still samples a 9.1G
traffic spike and 741.0M sixty seconds after destruction. Eliminating the
startup clone does not resolve execution-time native footprint. The two
browser selections complete together as job
`image-handoff-browser-gates-1107-165141-467c` in 15m08s. Reports are under
`.context/image-handoff-fix-v1/` in the isolated checkout.

The real app's composer returns a new raw buffer, so its normal ephemeral
boot handoff must also use the existing ownership-taking API. That consumer
change remains a proposal until source and rendered UI checks are complete;
the focused compressed-input controls do not validate it.

Reports remain under the isolated checkout's `.context/baseline-tests/`,
`.context/candidate-tests/` and `.context/image-init-control-results-v2/`.
The existing verified WordPress preview remains unchanged. Full canonical
images, rendered final UI, persistence, complete memory/lifecycle and
benchmark acceptance remain open.


**Active migration:** Go 1.28 development `kandelo/wasm32`, with matching
four-byte Go/C pointers and eight-byte scalar alignment. Latest selected Go
source is
[`f60530600f70`](https://github.com/kandelo-dev/go/commit/f60530600f70a5ea905a907ac311ec8bd2ae8ac4).
Latest main `faf9b31720e8` is merged as `c4a197271` in this evaluation
branch; ABI remains 55. The primary preview stays on its verified source.
Implementation/evaluation checkpoints are tracked in draft PR #1492.
The full WordPress service goal remains unfinished.

**Current priority: retry upstream PHP's unchanged optimizer.** The
maintainer asks whether the homogeneous wasm32 build makes the iterative
CFG candidate unnecessary. PHP already had four-byte pointers, so Go's
pointer change alone does not establish that; the current build and call
path need measurement. PHP revision 24 and ZTS revision 10 stop applying
that patch. FrankenPHP classic 40 and combined Caddy 21 rebuild against
that library. The experimental patch remains available for review and is
not applied by the recipes. No other PHP adaptations or Go algorithms
are changed for this comparison.

Use the new normal partial-WordPress workflow for this experiment. It
keeps the rootfs base and the image's own PHP/FPM/FrankenPHP dependencies,
without building unrelated canonical-shell applications. Run focused
optimizer probes and real editor workflows in all three browser engines;
a synthetic-probe result must not substitute for the real WordPress path.
Canonical images, lifecycle and full benchmark acceptance remain open.

The partial experiment passes the normal release `xtask partial-image
wordpress --jobs 1` path in 43m34s. Its 83,524,156-byte WordPress image is
SHA-256 `464d553bb3e5c37910b3c5910fa6d2d7a404d535e6781b387682376a74ddb703`.
The layout audit passes; image inspection verifies both embedded daemons
equal their normal selected package outputs and all 92 cache-plugin files
equal the pinned upstream archive. The ZTS archive contains the original
`compute_postnum_recursive` symbol. Both Node service cases, all three
Caddy browser-host cases and all nine real Caddy UI cases pass, with zero
skips or flaky cases. Chromium, Firefox and WebKit each exercise login,
Appearance → Editor, authenticated post edits and a saved site template.
The separate host cases include cold/warm 96- and 768-condition optimizer
probes at the default optimization level. Keep the upstream PHP optimizer
selected: these current cases provide no reason to restore the candidate.
They do not establish unlimited recursion depth or prove pointer width
alone caused the difference. Reports remain separate under
`.context/php-upstream-optimizer-partial-v1/`; the combined evaluation job
`php-upstream-partial-runtime-1107-143137-b1b1` passes in 13m30s.
This partial leaves unrelated shell applications out and is not canonical
acceptance. The selected kernel remains `6f5410ea67d0`.
The separate benchmark checkout now matches selected main
`1b6f3783d`; its SDK inputs are unchanged from the completed bootstrap.
The benchmark driver requires an explicit final candidate projection.
No new full build or benchmark timing has started.

**Verified development preview:** the normal `./run.sh browser --partial`
server runs at
`http://127.0.0.1:5464/?vfs=http%3A%2F%2F127.0.0.1%3A5464%2F%40kandelo-partial%2Fimage.vfs.zst&profile=wordpress-frankenphp-caddy`.
A separate Chromium check verifies the served image identity, uses the
demo's login button and saves a heading in the real template editor. Its
screenshot shows that test-owned temporary machine after the save.
The preserved
older static preview remains available. This new URL serves the mutable
development partial, not a canonical release artifact.

**Instance-only memory control:** exact new Caddy bytes `f5771507fe1e`
instantiate with diagnostic imports but no program entry/export calls.
All imported functions throw if called; the call count stays zero. Node
passes one instance. WebKit passes two instances in one worker plus one
in each of two additional workers, sharing one 76,087,296-byte linear
memory. Native samples from one fresh WebKit content process report:

| Phase | Physical footprint, vmmap units |
| --- | ---: |
| Compiled module; source reference released | 859.1M |
| Four instances across three workers | 873.3M |
| Worker termination requested | 20.2M |
| Same page after 60 seconds | 18.5M |

This is one diagnostic run, not a service benchmark or a proven bound.
Kandelo host activation setup and Go/PHP execution are absent. It narrows
the several-GiB investigation toward setup/execution costs rather than
module holding or bare instance creation alone. No forced collection,
engine flags or application changes are used. A separate control eagerly
reads all 92,641 resume-catalog function objects through `table.get`:
physical footprint changes from 859.4M to 886.5M in that worker. That
single observation is too small to explain the several-GiB service gap;
no production optimization is adopted from this hypothesis.

**Real backend-workload memory gate:** job
`php-upstream-partial-memory-1107-145451-d164` passes three engine cases
in 10m08s, zero skipped/flaky, on the exact new partial artifacts. It uses
two PHP threads, editor HTTP bursts/parallel requests, a 90-second soak,
SIGKILL/restart, a held-request graceful drain and 60 seconds after
destruction. This is a backend-host diagnostic, not a complete rendered
WordPress UI or full browser-memory gate. WebKit samples report 5.4G
after the first request and 9.2G at the last soak sample (144 requests).
After restart the sample is 5.6G; destruction reports 3.8G, then 832.8M
after 60 seconds in the same page. These are vmmap physical-footprint
labels, not process RSS or a proven sustained bound.

At the last soak sample, Go reports about 2.9 MB live heap and 44.4 MB
Sys, while the two PHP allocator counters total about 62.8 MB. Eight
guest threads remain reported by `/proc`; growth is not explained by a
larger observed worker count. Kernel and Caddy linear capacities both
reach 713,031,680 bytes. They are separate memories: the documented
`ensure_memory_covers` coupling grows kernel memory for guest addresses.
Audit the direct-call assumptions described in
`docs/future-improvements.md` before removing it. None of these counters
adds up to native footprint; VFS/transport, setup, execution and deferred
collection attribution remain open. The high footprint is not resolved
and this functional pass is not production-memory acceptance.

**Visitor-cache configuration follow-up:** both current WordPress stacks
disable OPcache timestamp validation. Stock cache-plugin activation edits
PHP configuration, so the assumption that PHP sources remain static needs
revisiting before activation. Evaluate ordinary timestamp validation or
deployment invalidation, then prove edits become visible with matching
settings in both stacks. This is source inspection, not a demonstrated
stale-bytecode failure. The unchanged-optimizer trial keeps its settings.

**Verified canonical checkpoint before the latest merges:** job
`wordpress-wasm32-stable-1107-121249-d310` passes in 39m48s. All 165 nodes
complete: 157 cached and eight built. WordPress revision 43 is 82,844,469
bytes, SHA-256 `a868328785a6fe769279a2900cf7c369afa61c011ae424740f198ce69355be30`;
the selected kernel is `6f5410ea67d0`. The FHS audit and two Node service
cases pass with zero skips. Image inspection proves WordPress 7.0 and
both embedded FrankenPHP binaries match the independently reproduced
classic-39/Caddy-20 bytes. The first verifier assumed `/usr/bin`; it is
corrected to the builder's real `/usr/sbin` daemon paths without changing
the image. The compiled host build passes. This preserved checkpoint is
not final browser acceptance or proof of the unchanged PHP optimizer.

**Latest-main integration and cache comparison preparation:** main's lazy
preparation/transfer deadlines and cache-key canonicalization are merged,
then the PCM, quiet-browser-fixture and DOS changes through `1b6f3783d`.
Conflicts retain Go secure-startup coverage, memory observations and the
shared silent test fixture. The shell-selection test is classified as a
prepared product because it reaches the image writer. Sixty-three focused
source/layout/lazy-fetch/prepared-exec cases pass before that last merge;
new-merge checks remain required. WP Super Cache 3.1.5 is now a pinned,
unchanged, initially inactive source dependency for WordPress revision 44
and family revision 10. Cache behavior and visitor timing are unvalidated.

**Clean SDK and benchmark preparation:** all 492 declared installed core
outputs (246 per architecture), including headers, are physically equal
to independently built SDKs from clean pinned musl `0784374d`. Existing
submodule edits remain untouched; this is not a full clean-release build.
The separate main checkout passes normal complete SDK bootstrap and
relocatable graphics configuration checks in 2m25s. Its next full product
build remains deferred while the unchanged-optimizer experiment runs.

**Platform corrections integrated for combined validation:** the guest TCP
namespace correction, mmap fresh-page clearing and thread-private startup
buffer retirement are now on the primary branch. Their separate focused
gates are recorded below. Combined final-image, memory/lifecycle and
performance validation remain open; integration does not complete those
gates. The main merge retains both Vite dependency-cache isolation and
main's new partial-image plugin. The plugin's five unit tests pass. The
inventory check exposes two newly merged, unclassified tests; they are
now classified as prepared-product and source-only according to their
actual inputs.
The exact inventory now covers all 667 files. Shell-selection and
registry checks pass all 12 cases with no skips. This invocation also
performs normal SDK fixture preparation, so the concurrent browser run
must not be described as having an entirely idle machine throughout.

**Image build stopped at input drift, not compilation:** job
`wordpress-wasm32-final-1107-054136-cf6a` terminates after 5h43m. Shell
assembly rejects the changed `coreutils-docs` key and blocks WordPress;
the completed package generations remain cached. The earlier offline-link
test change modified `host/test/centralized-test-helper.ts` after the docs
node ran. That helper is an explicitly declared docs build input, which
the parallel-work freeze missed. The resolver correctly refuses to pair
the old receipt (`ac2879a8ba6e`) with the new expected key (`1e6e6bbd7681`).
No receipt is edited or equality check relaxed. The next normal build must
use stable declared inputs and a fresh projection, retaining the failed
log/projection separately. Guidance now covers inputs outside the registry.

**Startup source ownership experiment:** isolated
`.context/thread-startup-bytes` consumes thread-private source buffers
after startup metadata is decoded, using ordinary ArrayBuffer transfer
where available. The kernel keeps its original source for later launches
and fork. The compiler, collector and applications are unchanged. Own
normal image-writer and compiled-host/declaration preparation passes in
4m15s. Seven Go runtime/cgo Node cases, real Caddy/PHP and all eight
unchanged original ABI-program cases pass. A first WebKit service sample
reports `4.8G` physical footprint versus the earlier `5.9G`; these single
observations under build load do not establish a stable reduction. Node
RSS overlaps the exploratory baseline observations, so no Node improvement
is established.

The first expanded browser run has 298 passes and two outer two-minute timeouts
in the full os.Root sweep (Firefox and WebKit), zero skips/flakes. Separate
fresh Firefox invocations of that exact fixture pass on unchanged and
experimental hosts in 87.0s and 88.7s overall, respectively. Those focused
passes do not replace the mixed full result. A fresh browser run now
passes all 300 cases across Chromium, Firefox and WebKit, with zero skips
or flaky cases, in 16m58s overall. It uses the same isolated host
implementation and selected fixtures, with both expensive builds terminal
and no timeout increase. The complete os.Root sweep takes 44.3s, 77.9s
and 115.1s respectively. The last remains close to the two-minute limit;
the earlier failures are retained rather than reclassified. This proves
the selected host/fixture run, not final combined-image acceptance or an
idle-machine performance result. Evidence is the candidate's
`.context/broad-browser-quiet-reports/playwright.Tuow7Z/`.

**Benchmark baseline preparation stopped at missing SDK prerequisites:**
the separate clean main checkout completed its SDK cores, kernel, rootfs
and host preparation. Its full product build then reports 146 successful
nodes, 12 failures and five blocked nodes. Failed graphics consumers lack
normal sysroot DRI/GL archives; ffmpeg rejects its SDL link probe. Its
missing `stdbit.h` message belongs to an optional configure probe and is
not established as the cause of that failure.
This is incomplete baseline preparation, not evidence of a Go regression.
The next attempt must provision the baseline's own complete SDK through
normal bootstrap, preserving the failed report and cached successes.
That checkout has now advanced cleanly to `f762afc10308`; no benchmark
timings have run. The retry script is prepared and syntax checked;
baseline compilation waits for the primary image retry to avoid running
two full product builds at once.

**Pthread fork regressions refreshed:** both nested and concurrent pthread
fork fixtures are compiled through the normal SDK fixture helper, fork
instrumented and ABI-stamped as fresh outputs. Node's existing test now
uses the developer-fixture path instead of querying package-only authority
and silently skipping. Node/browser share one fixture-root helper, with
explicit prepared-root selection for isolated evaluations. Both unchanged
and experimental hosts pass two Node and six three-engine browser cases,
zero skips/flakes. Seven ownership/source-literal checks pass. These prove
real child/grandchild continuations after startup, not physical reclamation.
Evidence is `.context/thread-fork-baseline-gates/` and the isolated
candidate's `.context/thread-fork-gates/`; its broad browser report remains
separate under `.context/broad-browser-reports/`.

**Module/native footprint controls:** a maintained module-only control
passes all three browsers (58.6 seconds), then a separate WebKit run
captures all eight phase-held OS snapshots (25.3 seconds). It compiles the
same normal `606d5174c8a6` artifact but creates zero guest instances. The
WebKit physical footprint reported by vmmap is `856.6M` after dropping the
source-byte reference and `864.9M` with eight extra module-holding workers.
This bounds that one observed transfer increment; it is not a complete
engine allocation census or a reclamation guarantee. The final window
after worker retirement reports `677.7M`, not zero.

A separate fresh-browser real Caddy gate passes (17.8 seconds), with
Go heap 2,443,512 bytes, Go Sys 42,859,644 bytes, two PHP threads and
normal requests/shutdown. Its WebContent RSS is 7,640,170,496 bytes and
vmmap physical footprint is `5.9G`. This is an instrumented tiny-service
observation under build load, not WordPress or a stable production bound.
The large gap remains after proving inexpensive compiled-module transfer.
The observed baseline structured-clones the complete 185,049,722-byte
source buffer into each thread. The integrated ownership correction
retires each thread's private copy after startup. Per-instance costs and
final WordPress attribution remain open; these observations do not
attribute the whole gap to Go or an engine defect.

The native sampler now pairs the browser's own launchd PID domain with
the OS process table. A parent-only attempt misses macOS XPC content
processes and fails visibly; its report is retained separately. The
corrected eight snapshots include owned content-process RSS, physical
footprint and raw mappings, without inspecting another app's memory.
Evidence: `.context/offline-egress-listeners/.context/` under
`module-memory-control/`, `module-memory-control-native/` and
`upstream-memory-metrics/native-process-service/`. No program, compiler,
collector or host runtime behavior changes are made by these controls.

**Upstream memory diagnostics:** the shared test helper now reads real
Caddy Go metrics and FrankenPHP's per-thread PHP allocator endpoint through
ordinary test-owned admin/metrics configuration. A fresh Node service run
and all three browser service cases pass, zero skipped/flaky, on the
unchanged normal Caddy artifact `606d5174c8a6` and isolated kernel
`741aa821cccd`. The browser gate takes 35.1 seconds. The helper passes the
declared native TypeScript check. WordPress host-stage integration is
prepared but has not yet run on the pending replacement image.

One Node collection interval reports Go heap 2,733,096 bytes, Go Sys
42,859,644 bytes and Wasm backing 641,925,120 bytes, with process RSS
5,938,085,888 bytes. An earlier exploratory interval reports 8,647,393,280
bytes RSS. These are instrumented observations under concurrent build
load, not a stable bound or controlled performance comparison. The gap
requires engine/native attribution rather than treating GOMEMLIMIT as a
total service budget. The raw procfs status also exposes a hard-coded zero
VmSize; it is not usable as a backing or residency measurement.

The maintained WebKit inspector adapter passes a separate real-service
gate (18.5 seconds), producing 30 native category observations without a
tracking error. Its direct-worker counts omit nested pthreads; category
sizes are not RSS. The initial adapter resolved a different root Playwright
copy and produced no native observations despite the passing service case;
that invalid diagnostic is retained separately. The corrected adapter uses
the browser app's actual connection. No application source, engine flags
or forced collection are changed. Raw intervals/responses, program identity
and native observations are under
`.context/offline-egress-listeners/.context/upstream-memory-metrics/`.
Full synchronized WordPress attribution, complete worker/instance counts
and final memory/lifecycle/benchmark acceptance remain open.

**Current-compiler thread retirement:** hash-verified f605 fixtures pass
48 simultaneously locked worker Ms across five retirement waves under
both 64-slot and 1,024-slot declarations. Two fresh Node parents exit zero
with empty stderr/diagnostics. All six three-engine browser cases pass,
zero skipped/flaky, in 82.9 seconds; the whole gate takes 2m11s. It uses
the isolated TCP correction's kernel `741aa821cccd` and compiled host.
This refreshes bounded reuse evidence for the selected compiler without
repeating the legacy 256/512-worker stress on this 36 GB machine. Those
higher counts remain historical Go 1.25 evidence. PHP churn, final-image
lifecycle and memory reclamation remain separate gates. Evidence:
`.context/offline-egress-listeners/.context/selected-go-thread-churn/`.
The initial private-script path error ran no guest case and is retained
separately as job `selected-go-thread-churn-1107-095621-5ace` (exit 127).

**General TCP namespace correction validated:** isolated commit
[`67a49efe3`](https://github.com/Automattic/kandelo/commit/67a49efe3)
keeps offline guest listeners out of physical host ports and routes TCP to
the machine's reported IPv4 address through existing kernel connections.
It handles the whole loopback network, preserves actual source/accepted
endpoints and makes IPv4 port-zero allocation skip occupied ports, matching
IPv6. No Go/PHP/Caddy implementation changes are added by this correction.

The rebuilt isolated cohort (kernel `741aa821cccd`) passes all 3,164
runtime-core tests and 79 Node checks, including ten same-process/forked
listener cases and eight tests of unchanged original ABI-55 programs.
Thirty routing cases pass across all three browsers, zero skipped/flaky,
in 46.5 seconds. All four expanded Go programs pass in fresh Node parents
on this compiled host without native listener-collision messages. The same
Go programs pass the updated 12-case browser selection on this kernel,
zero skipped/flaky, in 53.0 seconds. The ABI gate confirms an unchanged
program digest and consistent snapshot/version; all 663 test files are
classified. The source is now integrated into the primary branch after
that image build terminated. Final WordPress and performance gates remain.

Evidence is `.context/offline-egress-listeners/.context/`: the original
backend exposes three tested IPv4 listeners, the first backend correction
reveals the own-address routing gap, and the first full runtime test exposes
the occupied-port allocator gap. Those failures remain separate from the
passing normal publication and gates. Missing original baseline files and
a wrong constructor in the new test are recorded as preparation corrections;
only manifest-verified original baseline bytes are copied, without compiling
or restamping them. The normal verifier then accepts them unchanged.

**Expanded blocking-wait regression gate:** the unchanged f605 runtime now
has plain-Go and cgo fixtures covering zero, short and multi-checkpoint note
deadlines, already-notified notes, timed/indefinite wakeups and twelve
notification/park races. Socket deadlines, readiness, close wakeups and
blocking pipe reads now cross the 100 ms checkpoint interval. Four fresh
Node programs complete successfully, and all 12 Chromium/Firefox/WebKit
cases pass with zero skips/flakes in 53.8 seconds. Evidence is
`.context/go-wait-checkpoint-expanded/`. Only fixture builds disable
linkname checks for private runtime observations; package/compiler sources
and their normal checks are unchanged.

The Node netpoll runs also expose physical-listener collisions. Disabling
external TCP egress does not control listener exposure. Selecting the normal
offline egress link still reproduces it: `OfflineEgressBackend` does not
claim its listener namespace. The isolated checkout
`.context/offline-egress-listeners` adds a production-worker regression:
the unchanged backend exposes all three tested IPv4 listeners to the host;
IPv6 remains private. A backend fix blocks that exposure, then uncovers a
separate kernel gap routing a connection to its own assigned IPv4 address
externally. The general correction is now validated separately above.
Neither change is in the primary host/image build yet;
the initial Node console warnings and both regression observations remain
separate. No clean final Node networking gate is claimed from them.

**Prepared memory conformance:** normal prerequisite publication completes
in 33m11s; a separate Node/Chromium conformance run completes in 2m18s.
Each host has 20 passing libc/POSIX/Sortix cases and four unchanged expected
failures, with zero skips, build failures, runner errors or timeouts. Cases
include shared memory, mapping/unmapping, memory locks, zero allocations,
allocation/thread exhaustion and the existing 64 KiB-page geometry boundary.
The accepted failures remain page-access revocation, privileged memory-lock
limits and that allocation geometry. The run uses its own normal SDK and
ABI-55 kernel `8b975583234a`, not the earlier Go gate's frozen kernel.
The clean pinned Sortix source is on a case-sensitive private volume; both
runners now honor the same source selection. Initial preparation failures
remain intact. Evidence:
`.context/go-mmap-fresh-pages/.context/mmap-vendor-conformance-prepared/`.
This adds focused conformance evidence to the isolated memory candidate;
the final image, full memory/lifecycle gate and controlled benchmarks remain.

**Regexp upstream candidate evaluated:** the approved shared traversal is
selected at f605 for all four normal Go consumers. Native/race checks,
2,022 complete-program comparisons, deep-tree checks and the expanded
297-case browser compiler gate pass. Real FrankenPHP/Caddy passes Node and
all three browser engines, including WebKit. URL compilation is about
50–58% slower on the measured Wasm hosts where the original succeeds;
WebKit's original overflows. This is a demonstrated robustness improvement,
with no established request-throughput improvement. The exported
three-file upstream review patch applies to the preserved baseline and
matches the evaluated source hashes. No upstream submission is made.
See the [full evaluation](2026-11-07-go-regexp-upstream-evaluation.md).

**Further validation preparation:** the alternating benchmark driver now
selects the clean `afeedd583ca5` checkout instead of the historical signal
baseline, verifies that commit, and rejects source movement during a run.
Its syntax and no-timing plan check pass. WordPress 7.0 and SQLite plugin
2.1.16 archives are independently staged and checksum-verified outside
both frozen registries; both checkouts' manifests match. Installation into
the baseline is guarded on successful completion of its normal product
build. No new benchmark timings are claimed.

The isolated memory branch's extra libc/POSIX selection first fails before
guest execution: Node lacks its normal image-writer module, and the browser
projection lacks dash required by the conformance runner. All six runner
logs, contexts and imported nonpassing records remain separate under
`.context/go-mmap-fresh-pages/.context/mmap-vendor-conformance/`. These are
preparation failures, not evidence of a guest mapping regression or a
conformance pass. Job `mmap-vendor-prerequisites-1107-080049-c9e4` builds the
normal kernel/rootfs/exec-support closure in that worktree before a separate
rerun. Primary host/package sources remain frozen during their image build.

**Memory experiment: maintained and compiled-host validation:** follow-up
[`f9360b2c3`](https://github.com/Automattic/kandelo/commit/f9360b2c362172e15dfa18f55627c077191b9029)
adds real worker interleavings and maintained C zeroing tests on the isolated
branch. Its own clean musl checkout and normal SDK builds produce both
architectures' fixtures. The maintained gate passes 247 Node checks
(245 source checks plus two C integrations), all 30 browser checks, zero
skips/flakes, and the 664-file evidence inventory. Actual worker cases cover
both memory widths when a peer appends pages, satisfies the requested
capacity, or leaves a genuine capacity failure. Another eight-file mapping,
shared-memory and pthread selection passes 34 checks. Its fresh raw pthread
fixtures initially emit the legacy ABI warning; the test now builds through
`compileSdkFixture`. All four cases pass again with current stamps and no
legacy warning, preserving the 10/1 architecture repetition counts.

The host production build and declarations pass. The compiled kernel-worker
entry's source fingerprint matches, and both C zeroing cases pass through
that built host. All 152 ownership/budget/audit checks pass. The ABI gate
rebuilds the kernel, verifies the pinned old-program cohort and confirms an
unchanged program digest and consistent snapshot/version. No ABI bump or
audit exception is needed. Job `mmap-maintained-sdk-gates-1107-064536-14b3`
stopped before tests on an unsupported xtask help invocation; the corrected
native Cargo build and complete gate pass as
`mmap-maintained-gates-1107-065249-8e3c` (2m43s). Built-host job
`mmap-built-host-gates-1107-071916-e75f` passes in 1m24s. Evidence is under
`.context/go-mmap-fresh-pages/.context/`. Broader conformance, the full
memory/lifecycle gate, final applications and controlled benchmarks remain
open before adoption. Primary runtime and its live image build are unchanged.

**Latest-main baseline preparation:** clean `afeedd583ca5` completes its own
SDK cores, kernel, rootfs and host build in 37m34s. Kernel SHA-256 is
`f9bad7129738e4aeadca32c05eb0267ec6fff0dd0b7f13ade63ba51197028f1f`;
rootfs is `f833b30d83c21ba541772eafbd4a83eed2a4c0f5430307d2c31ec7c9df4bb877`
and passes the layout audit. Full benchmark-product preparation starts
separately as `benchmark-main-products-1107-063730-874a`, including its own
PHP, both MariaDB architectures, database images, WordPress and micro
fixtures. That first product attempt finds the baseline's uninitialized
Rust libc submodule: Harper, the guest SDK, modeset and termchat fail, so
WordPress is blocked while independent C products continue into the cache.
The owned job is stopped at a cheap tar-configure phase (recorded exit
143), the pinned `71d5bfcc` submodule is initialized without changing main,
and preparation retries as `benchmark-main-products-ready-1107-074030-53fd`.
The first log remains
`benchmark-products-before-rust-libc-init.log`; completed cache entries are
preserved. The private set enables the dormant MariaDB image only for
validation. No timings run under compilation load. WordPress 43's primary
normal build is still in its full shell graph, currently LLVM/Clang.

**Parallel validation preparation:** clean latest-main worktree
`.context/go-benchmark-main-afeed` has its own npm installations and freshly
built wasm32/wasm64 musl SDK cores. Its normal kernel/rootfs publication has
completed; the full product retry is running and no benchmark timings run
alongside compilation. The preserved
older baseline remains unchanged and is not used as latest-main evidence.
The test-evidence inventory exposed three unclassified tests after the
main merge and service-test additions. The retro-emulator and WordPress
service cases are now prepared-product; the terminal-request parser is
source-only. Registry and collected inventory agree for all 662 files.

An isolated host experiment in `.context/go-mmap-fresh-pages` is pushed as
[`c137da096`](https://github.com/Automattic/kandelo/commit/c137da0964a9d93ac1f290477f8a11470f7bb5c0)
on `brandonpayton/mmap-fresh-pages-evaluation`, separate from this PR's
runtime. It avoids
explicitly clearing pages appended by its own `Memory.grow`, using that
operation's actual previous page count. Reused pages, including another
thread's growth, still need clearing. The supported helper retains its void
return value. The experiment passes 239 source tests, six browser helper
cases (memory32 and memory64 on all three engines), and six actual Node C
mmap cases using freshly compiled primary-SDK fixtures and frozen kernel
`a991e3cf`. The expanded browser C gate passes 18/18, zero skips/flakes,
in 15.8 seconds: private/shared file mappings, fixed-address reuse, partial
file-page tails, PROT_NONE followed by mprotect, and in-place/moving remap
prefix/tail preservation. A private harness initially imports a duplicate
Playwright copy, then starts Vite in the wrong directory; both failed or
warned attempts remain separate. The corrected run has no dependency-scan
failure. Evidence is `.context/go-mmap-fresh-pages/.context/`. This host
change is not adopted; maintained test integration, inter-isolate growth,
footprint measurements, final-image lifecycle, conformance and performance
gates remain required. Final application memory benefit is unmeasured.

**Incremental Node memory diagnostic:** three alternating rounds use six
fresh Node parents, the same f605 memory-accounting fixture (`2859460c`)
and kernel (`a991e3cf`), comparing the current primary host with the isolated
growth candidate. Peak RSS is 1,278.50/1,029.88/1,035.91 MiB for primary and
805.08/581.17/581.77 MiB for the candidate; medians are 1,035.91 and
581.77 MiB. All six processes pass the real Go/C allocation/reuse checks.
Initial linear bytes (560,726,016), initial Go Sys (19,922,944), final
linear bytes (594,804,736), final Go Sys (87,425,024) and scavenged
HeapReleased (67,371,008) match exactly across the six runs. The selected
target's sysUnusedOS remains a no-op. This supports reduced page touching
for this Node workload, not physical scavenger reclamation or smaller
linear memory. First-pair peaks are higher for both variants; raw values
are retained. Other compilation was active, so this is not a quiet
benchmark, a main-versus-final comparison, browser/WordPress evidence or a
sustained-memory bound. Evidence and exact host-source hashes are in
`.context/mmap-go-memory-diagnostic/`. The candidate is still unadopted.

**Cgo package reproducibility — stable archive prefixes:** the independent
same-key classic 38 rebuild fails byte equivalence while preserving the
canonical generation. Native Go 1.25.8 and Kandelo/wasm32 f605 controls both
show that changing unused absolute cgo search paths changes binary identity,
even with trimpath. Stable flags produce identical output in both controls.
The optional linker build-ID setting was evaluated only as a control; normal
recipes retain their original Go build IDs.

The two PHP recipes now use `scripts/go-cgo-static-libs.sh` to validate and
link directly from declared dependency prefixes. SDK compatibility archives
use the existing compiler lookup, verified for libm, libutil and unsupported
ucontext. No staging symlinks or temporary library search paths remain;
compiler, library and application algorithms are unchanged in this step.
Classic 39 publishes, passes Node PHP/static/OPcache and 32 lifetime checks
at concurrency four (Go collections 1 to 3, no host diagnostics, normal
shutdown), then passes an independent compiler/bootstrap/target byte-for-byte
rebuild. Combined Caddy 20 also passes normal publication, Node and independent
byte reproduction; the complete four-build/two-Node sequence takes 55m14s
with serial optimization. The refreshed receipt-validated browser cohort
passes 12/12 with zero skips/failures/flakes in 77.8 seconds and no Vite
scan failure. GoHello 33's earlier reproduction and a fresh standalone
Caddy 15 reproduction (6m08s) complete same-Mac independent reproduction
for all four consumers. This does not establish cross-OS reproduction.
WordPress 43 is now building through the full normal shell/image dependency
pipeline, with FHS and Node service gates queued. The saved preview remains
unchanged until its replacement is verified.
Historical 38/19 results below remain scoped to their original artifacts.

**Approved shared regexp improvement is selected for normal rebuilds:**
The prototype branch and all four Go recipes now select f605. It has one
iterative traversal, no collector/code-generator changes, native regexp/race
passes and 2,022 full-program comparisons. Its fresh compiler passes five
standard-library modes and 18 Node runtime/cgo cases. The expanded browser
inventory passes **297/297, zero skipped/flaky, 15m54s**, including all 14
optional cgo-runtime/PHP probes per engine. Source/producer/ABI checks bind
all 61 selected program artifacts to this build. The failed build/inspection
attempts and initial fixture failures remain separate evidence.

The fresh manual C-link fixture initially traps on both A0 and f605 because
its assembly retained legacy `PC >> 16` handles and eight-byte value slots.
Its target-specific wasm32 assembly uses direct C handles and four-byte
values/results while retaining the separate eight-byte continuation slot.
The corrected direct controls, actual Node process and expanded browser
cases pass. No compiler or application correction was needed. Earlier
broad runs loaded a preexisting link-only artifact; their passing result
does not prove its fresh-source provenance.

The exact regexp regression passes Node, six independent WASI architecture/
browser controls and Kandelo's three-engine gate. A private normal-resolver
unadapted FrankenPHP 1.13.5/Caddy 2.11.9 build passes in 7m28s using a newly
bootstrapped f605 compiler. PHP/static/OPcache, 32 concurrent CGI/body checks
during Go collection and normal exit pass Node and all three browsers,
resolving the exercised Caddy WebKit startup failure. Compilation-only
measurements show the cost explicitly: URL compilation is 50–58% slower
on Node/WASI, Chromium and Firefox; WebKit's original overflows. A six-child
Node whole-service diagnostic has medians 5.414 seconds original and 5.452
seconds candidate, with overlapping ranges; it establishes no performance
difference or request-throughput result. Full results and provenance are in
the [evaluation](2026-11-07-go-regexp-upstream-evaluation.md).

Normal GoHello revision 32 builds and passes Node VFS/posix_spawn, but
an independent same-key rebuild correctly fails the cache's byte-equivalence
check. The canonical artifact is preserved. Repeated builds using one
compiler are byte-identical; separately built development compilers have
different tool content IDs. Upstream's development bootstrap discards
ambient GOFLAGS and retains its own scratch paths unless its standard
reproducible-builder mode is selected. The shared helper now selects
`GO_BUILDER_NAME=kandelo-package`, preserving real compiler/build identities.
GoHello 33 now publishes and passes Node VFS/posix_spawn. A fresh resolver
work root independently rebuilds both native compilers and the target;
its Wasm bytes match the canonical generation exactly (SHA-256
`8445a3ef4fe9660d09771631bb506cda46145c87998d85c521ded0386335d209`).
This is same-host/same-declared-environment reproducibility, not a cross-OS
claim. Classic 38, combined 19 and standalone Caddy 15 now publish and pass Node;
the build/Node sequence takes 25m12s. Both FrankenPHP gates check static/
PHP/OPcache and 32 requests at concurrency four, with observed Go collection
(classic 1 to 3; Caddy 16 to 31), normal shutdown and no diagnostics.
All four normal consumers pass three browsers (12/12) on exact preserved
bytes and kernel a991e3cf. The narrow projection omitted rootfs, producing a
Vite app-wide dependency-scan warning despite the passing consumer tests.
The corrected rootfs-inclusive gate passes 12/12, zero skips/failures/flakes,
in 74.5 seconds without a dependency-scan failure. Its 36-node publication
rebuilds rootfs and 20 CLI packages; rootfs passes the FHS layout audit.
The exact Go program and kernel bytes are preserved. At that checkpoint,
larger C-linked independent byte-reproducibility checks remained open.
The stable-prefix checks above subsequently complete them for classic 39
and combined 20, with original Go build IDs retained.
Standalone Caddy is intentionally outside the default bootstrap set and
uses the normal explicit source resolver. An initial private orchestration
attempt used bootstrap for it and stopped before compiling that package.
No compiler source changes are involved. Normal artifact hashes and the
sampled 8.9 GiB native optimizer cost are in the regexp evaluation. Future
large instrumentation runs select documented BINARYEN_CORES=1; no footprint
improvement is claimed yet. WordPress revision 43 and final workflows, memory/lifecycle and performance
gates remain pending. The saved preview is preserved. The original A0
source/toolchain is retained at `.context/go-regexp-baseline-a0`; its existing
compiler is relocated, not independently rebuilt. The prototype's local
f605 developer compiler has also been freshly rebuilt.

The Go browser harness streams program/kernel/image bytes. Its corrected
regexp smoke passes 3/3 and expected slot-exhaustion smoke passes 3/3.
The bare fixture declares an empty icon after the first two runs expose an
unrelated Chromium favicon 404; console errors remain asserted with URLs.
Native `go version -m` cannot parse these Wasm files, so the cohort audit
uses standard producer metadata and fresh-builder receipts. Historical
`*-before` artifacts remain preserved outside the selected cohort.

A private PHP optimization experiment adds a bounded 16-frame local buffer
to the existing portable iterative CFG candidate. Native optimizer results
match (135 passes, one expected failure), and 26 standalone Node graph
cases pass. A six-round three-way native compilation comparison has
WordPress medians 388.15 ms recursive, 388.63 ms heap-stack and 390.37 ms
inline-stack, with overlapping ranges. This does not establish a WordPress
speed improvement. No PHP recipe/artifact changed; native source/binary
snapshots and results are `.context/php-cfg-inline-evaluation/`. All 78 cold-worker browser graph cases also pass. The inline variant is
not adopted: this run establishes no WordPress compilation speed advantage.
The normal PHP recipe and artifact remain unchanged.

**Normal build integration:** the declared Nix Go 1.25.8 builds verified
Go 1.26.10 source, which bootstraps the pinned Go 1.28 compiler. These are
bootstrap versions, not a target downgrade. Native compilers remain private
and target builds use `-trimpath`. All four Go recipes select the new target.
Normal `go-hello` revisions 28, 29 and 30 passed publication; revision 30
(`5954fb32`) passed Node VFS/`posix_spawn` launch. Revision 31 selects
`a0b048e1` and now passes normal publication and the Node VFS/posix_spawn
launcher, with empty stderr/diagnostics and zero fork count. Revision 31 also passes all three browser VFS/posix_spawn launch tests
(3/3, 33.7 seconds). An independent byte-for-byte
reproducibility build remains unrecorded.

**General corrections preserve upstream's collector and code generator:**

- `924bccec` maps C function-table handles through cgo's existing non-heap
  opaque pointer mechanism, retaining ordinary data-pointer roots. It also
  separates eight-byte scalar alignment from four-byte pointer size.
  Both failures were reproduced before correction.
- The scheduler clock must be nosplit during cgo `exitsyscall`/`casgstatus`.
  The first correction (`5954fb32`) also deferred signal dispatch, and a
  browser HTTP drain stalled after its request started. `2ed34c63` preserves
  the established signal checkpoint; handlers already queue Go notifications
  on the system stack. Five repeated drain cases per engine (15 total) and
  six repeated Node wait/GC cases pass.
- `a0b048e1` accepts object-free GNU archives and strictly validated empty
  BSD32 indexes in Wasm C linking. Normal unadapted FrankenPHP linking
  exposed the SDK's valid empty `libm.a`; no application flags were dropped.
  Nonempty/malformed or otherwise unsupported BSD archives still fail.
  Eight parser cases and real archive execution pass on Node and browsers.

**Earlier compiler validation:** clean `a0b048e1` passes seven focused
Node cases, five standard-library builds, host cgo/object-reader/platform
checks and two eight-check WASI controls. Selected Node OS coverage has
60 top-level passes and six nested capability skips; selected syscall
coverage has two top-level passes. Four dependency cases and three x/sys
Unix cases pass. An independent `os.Root` sweep has 65 top-level passes and
35 nested upstream capability skips, including Unix sockets. Seventeen
Node signal/drain/restart/retirement workflows, allocation accounting,
static archives and dynamic exports pass. This is selected coverage, not
complete Go/POSIX conformance.

The broad browser inventories remain **not green**:

| Run | Pass | Fail | Unrun | Findings |
| --- | ---: | ---: | ---: | --- |
| Initial migration, 243 planned | 130 | 5 | 108 | Old Root count, sync display-name argv[0], overlapping package publication |
| Clean `5954fb32`, 255 planned | 135 | 5 | 115 | Two nosplit-only preemption-fixture failures, two valid negative bbolt seed mismatches, one cgo HTTP/SIGTERM stall |
| Clean `a0b048e1`, 255 planned | 254 | 1 | 0 | WebKit regexp native stack overflow; 15.3 minutes; link-only artifact preexisting |

Retain all reports. The Root assertion now retains all 65 cases, and sync
re-exec uses its actual VFS executable path. The preemption fixture
materializes a split-stack frame without manual yielding. Bbolt accepts
its unchanged library's signed seeds. The clock follow-up preserves drain
signals. These corrections all pass in the complete `a0b048e1` browser run.

**WebKit boundary:** the same regexp fixture was compiled for upstream
`wasip1/wasm32` and legacy `wasip1/wasm`, with no Kandelo imports. Both pass
Node, Chromium and Firefox; both overflow WebKit's native call stack in
`regexp/syntax.(*compiler).compile`. The isolated browser WASI host reports
no unimplemented imports on the final control. Earlier incomplete-host
attempts remain recorded separately. This establishes an upstream Wasm
native-depth boundary, not an engine specification defect. The maintainer approved evaluating a single iterative traversal as an
upstream candidate; do not restore the older hybrid fallback or change
code generation. Candidate evaluation is described above. Caddy revision 13 also exits 139 on WebKit with
repeated unnamed native frames; its exact frame identity is not established
by that stripped trace alone.

**Dependency ports:** x/sys
[`488edb01b94c`](https://github.com/kandelo-dev/sys/commit/488edb01b94c3ede6ba278fd664cb16ce7c48a33)
combines wasm32 CPU selection with current Kandelo Unix APIs. Bbolt
[`75fe37b2f432`](https://github.com/kandelo-dev/bbolt/commit/75fe37b2f4323fe67e16257664145809058318b7)
selects existing Wasm mapping constants for both architectures. Readline,
logrus and certificate-transparency need no new source edits for their
current pins; all four focused dependency cases pass on Node and all three
browsers. Bbolt's reopen smoke does not prove durable shared mappings.

**Unadapted FrankenPHP is running:** normal classic revision 35 built and
published in 7m32s (`cargo-xtask-bootstrap-1106-231049-88e5`), after revision
34 exposed the valid empty-archive boundary. It uses Go `a0b048e1`, x/sys
`488edb0`, upstream pointer access and bulk CGI registration, with static
link libraries supplied through upstream's documented build flags. Its
74,628,530-byte artifact has SHA-256
`0023826d4c3961d72e4419a90e952d37709d05f8d2cbb98f0d62324ca0cbb8b6`.

Node passed sequential and four-concurrent 32-request CGI/body checks with
8 KiB query/body fields, `GOGC=1`, `GOMEMLIMIT=32MiB`, two observed collections
during requests, no host diagnostics and normal SIGTERM exit 0. A shared
maintained verifier now checks nine exact fields on Node and browsers.
The maintained classic Node test also passes static HTTP, static OPcache
registration/compilation/cache-file creation and awaited normal exit 0.
All three browser engines pass 32 concurrent requests, observed collection,
PHP/static HTTP and awaited exit 0 (3/3, 17.9 seconds). This proves these
request/string lifetimes; it does not validate WordPress or long uptime.

**Real Caddy:** normal unadapted FrankenPHP+Caddy revision 13 built and
published in 11m23s (`cargo-xtask-bootstrap-1106-234228-caa8`). Its
166,008,395-byte artifact has SHA-256
`a4cba8b8b94945c0a4729242199ba84d9e97fb91657ede359feb2de494380328`.
Node, Chromium and Firefox stop during configuration because Caddy 2.10.2
recognizes `json.RawMessage` by package/name; Go 1.28's default JSONv2 uses
an alias to `jsontext.Value`. A small control reproduces that identity
change on Kandelo32 and both upstream WASI targets. This is not a pointer
or reflection port defect. Upstream fixed it in
[caddyserver/caddy#7274](https://github.com/caddyserver/caddy/pull/7274).

Both recipes now select released Caddy 2.11.9 containing that fix. Standalone
Caddy revision 13 uses its verified source archive; FrankenPHP+Caddy
revision 14 updated the pinned module using ordinary `go get`, leaving
FrankenPHP source and Go's JSON defaults unchanged. Its normal build stopped
on missing transitive `go.sum` entries (job
`cargo-xtask-bootstrap-1106-235851-a08d`, 7m03s). Revision 15 adds the ordinary
`go mod tidy` dependency refresh before compilation. That normal build
(`cargo-xtask-bootstrap-1107-000615-e528`) stopped after 6m14s at the genuine
missing `unix.Dup` target API. The Go fork already implements the kernel
operation, so x/sys now delegates to it in pushed
[`258047d84115`](https://github.com/kandelo-dev/sys/commit/258047d84115d79e9b594f61de9ec45caca492b3).
Node verifies shared file offsets, independent close, close-on-exec clearing
and EBADF. All four Unix cases and the pointer-aggregate/constructor/exit
cases pass across three browsers (21/21, 44.3 seconds). Six corresponding
Node aggregate/constructor/exit cases pass too. The first extra local fixture
attempt inherited the target C compiler into host Rust; its corrected run
is separately recorded. No guest defect or pass is inferred from that error.

FrankenPHP+Caddy revision 16 and standalone Caddy revision 13 select the
new x/sys pin. A maintained Node Caddy package test now covers PHP/static
HTTP, static OPcache cache files, concurrent CGI/GC lifetimes and normal
SIGTERM exit. It still needs to execute on the new published service.
Job `cargo-xtask-bootstrap-1107-001634-d8da` stopped after 8m43s because
FrankenPHP 1.11.0's Caddy command API expects three `LoadConfig` results,
where Caddy 2.11.9 returns four. Its queued runtime/GoHello steps did not
execute. No application patch was added.

Both FrankenPHP recipes now select released 1.13.5, whose upstream module
already pins Caddy 2.11.9; the temporary `go get`/`go mod tidy` override is
removed. Classic revision 36, Caddy revision 17 and WordPress revision 43
select the new sources/dependencies. Active job
`cargo-xtask-bootstrap-1107-002742-daed` first completed normal GoHello31
publication and Node VFS launch. FrankenPHP+Caddy17 then built, instrumented and published normally; the
combined sequence finished in 15m22s. Its maintained Node test passes
PHP/static HTTP, OPcache compilation/cache files, 32 requests at concurrency
four, observed collections 16→32, no host diagnostics and normal SIGTERM
exit 0. The PHP pool starts and remains at two threads. Chromium and Firefox
pass the matching HTTP/lifetime/GC/exit browser test; WebKit exits 139 before
readiness on native call-stack overflow (2 pass/1 fail, 25.7 seconds).
The exact stripped native frame identity is not established by that trace.
Artifact: 184,964,868 bytes, SHA-256
`20c10f8ec00cea0ae470ea6a58eb408383d4e3d38da89be17e738e3a79aeb79d`.
GoHello31 SHA-256:
`45dbb5928ff635f05a69fbe65c16a7f43fa83b270168f90411133def4024da86`.
The now-unused FrankenPHP accessor/scalar-registration patch file is removed;
both recipes build upstream sources without it. Classic36 and the
new WordPress image have not been built. Preserve the historical unadapted
classic35 and Caddy13 evidence as scoped to FrankenPHP 1.11.0.
The standalone Caddy recipe has not yet been built on this target.

**Layout and memory:** WordPress uses latest main's `/srv/www/html` layout;
custom classic defaults, Caddy configuration and related probes now agree.
The remaining held-request shutdown helper and benchmark now also use
main's `/usr/bin/kandelo-service`, `/usr/bin/start-msmtpd` and
`/srv/www/html` paths, matching the actual image builders. Those final
image/runtime/benchmark checks remain unrun. WordPress revision 43 invalidates
the old configuration, but no replacement image or new preview is claimed. The PHP CFG traversal remains an unpromoted
candidate, with no established speed benefit. On the new target the memory
fixture starts with about 535 MiB linear memory versus 19 MiB Go-accounted
system memory. Go's ordinary 32-bit 512 MiB reservation interacts with
Kandelo's mmap-backed address space. Linear byte length is not physical RSS;
reservation semantics and synchronized native footprint still need study.
No collector or reservation-size shortcut has been added.

The preserved revision-39 preview remains HTTP-accessible at port 5457,
with its known PHP native-stack/recovery limitation. It is separate from
the new build and is not a completed production gate.

Evidence: `.context/go32-clean-a0-*`,
`.context/go32-clean-a0-browser-reports/playwright.zfvk7S/`,
`.context/go32-wasi-regexp/browser-results.json`,
`.context/go32-frankenphp-{bulk,concurrent-bulk}-node-result.json`,
`.context/go32-classic-maintained-node.log`,
`.context/go32-classic-bulk-browser-reports/`, and
`.context/go32-caddy-r13-browser-reports/`.

Remaining order:

1. Publish normal f605 Go consumer builds and verify independent package
   reproducibility. The fresh compiler/Node/297-browser and real Caddy gates
   pass; preserve the measured regexp compilation tradeoff.
2. Rebuild coherent WordPress images and verify replacement previews before
   switching the preserved preview.
3. Finish login/editor/post/template saves/uploads and lifecycle/recovery,
   blocking waits, memory accounting, WebKit footprint and resource gates.
4. Run sustained traffic, fair PHP-FPM and user-facing comparisons, and
   planned Node/Chromium benchmarks. Report measured results without a
   presumed speed advantage. PHP recursion remains a separate issue.

**Maintainer priority clarification:** improve Kandelo rather than adapting
applications around incomplete platform support. First audit and fix general
cgo gaps, removing FrankenPHP adaptations those fixes replace. The maintainer
approved that order. Keep the PHP traversal change as an upstream candidate
only if correctness, fragility and performance evidence support the argument
across native platforms as well as browsers. A finite set of measurements
cannot establish that it is faster on every platform. The 184-node build
finished (`8a14`, 30m17s; 170 cached, 14 published), but no final runtime
pass-after is established and the candidate preview is not promoted.

The audit identifies three distinct cases:

- General platform work: the syscall, libc, worker lifecycle, Go target and
  cgo-linking implementations benefit other consumers and remain the
  preferred approach.
- FrankenPHP's approximately 250-line patch changes C-structure access,
  replaces bulk CGI registration with scalar calls, and declares static
  linkage. Some aggregate cgo shapes have since gained general support;
  the continued necessity of each accessor and scalar-call adaptation has
  not been revalidated. Remove obsolete adaptations, and prefer general
  cgo fixes for remaining unsupported shapes. Do not present the package
  patch as complete upstream-compatible cgo support.
- The PHP CFG traversal candidate (`a3df84d29`) and the existing Go
  `regexp/syntax` recursion fallback (`4c644a0` in the Go fork) alter
  upstream library algorithms to accommodate finite native Wasm call
  depth. They do not repair POSIX behavior. The Go fallback is roughly
  100 added lines; the PHP change replaces one function. Their preservation
  of behavior does not by itself settle whether these adaptations fit the
  maintainer's intended portability policy. Go's code generator and
  collector remain unchanged, but its standard library is modified.

The maintainer also suggested a general recursion-to-iteration
instrumentation pass. Assess it after the cgo audit, without changing Go's
collector or code generator. LLVM's existing tail-recursion elimination
handles narrower shapes; PHP's postorder traversal resumes work after the
recursive call and needs explicit continuation frames. Kandelo's fork
continuations are not already a general execution-stack replacement.
Before implementing such a pass, define the accepted call shapes and prove
operand/local preservation, successor and side-effect order, indirect and
cross-instance calls, exceptions/nonlocal exits, cgo reentrancy, thread-local
frame ownership, allocation failure, and coexistence with fork
instrumentation. Reject unsupported shapes explicitly. A direct LLVM
21.1.7 `tailcallelim` check after `-O2` retains the recursive call in the
unchanged standalone PHP traversal; enabling that existing pass alone
does not solve this case. Evidence is
`.context/php-cfg-tailcallelim-assessment.log`. Compare code size,
compile cost, native stack depth, guest allocations and request latency
against unchanged upstream inputs on Node and all three browsers. Prefer
an existing reviewed transformation if it satisfies that contract; do not
introduce a large new execution model just to clear this demo's gate.

References: [LLVM tail-call elimination](https://llvm.org/docs/Passes.html#tailcallelim-tail-call-elimination)
and the [WebAssembly tail-call semantics](https://github.com/WebAssembly/tail-call/blob/main/proposals/tail-call/Overview.md).

### Homogeneous wasm32 cgo checkpoint — 2026-11-06

Go fork `7ae173a6576a7e795eddab67009f9b0517b3b403` is pushed on the separate
`kandelo-wasm32-prototype` branch. It adds a general C-call/callback bridge
to the preceding runtime prototype and registers cgo for this new target.
The production `kandelo-port` branch and every package pin stay unchanged.

The bridge uses ordinary four-byte typed pointers and upstream cgo's
argument/export layouts. It preserves both halves of the eight-byte Go
continuation across callbacks from C-created threads. C function addresses
are Wasm table handles; Go's internal logical program counters remain
separate. The linker records the exact C argument-frame signature because
ordinary wrappers return void while two-result errno wrappers return an
integer. `asmcgocall` selects the matching Wasm call type and preserves
errno. It does not change the cgo frontend's struct or callback layouts.

The cgo import scan parses Wasm objects rather than expecting native object
formats. It accepts only the supported host namespaces. Passive data is
parsed without pretending it already has an address. The C object loader
also stops treating calls inside unused functions as independent roots;
normal linker reachability selects their callees. A regression object
contains an unused reference to a missing function and a live function
that must execute correctly. No unresolved live symbol is ignored.

Unused legacy Kandelo/wasm cgo and startup assembly is removed from this
new branch; upstream legacy WASI assembly is restored. Kandelo's thread
state is separated from the empty WASI/js OS state. The existing VFS-backed
account lookup remains selected in both cgo modes. Go's collector and
upstream wasm32 code generation remain intact, and the prototype does not
carry the old regexp algorithm change.

The clean, pushed Go source was bootstrapped again, then all six Wasm
fixtures were rebuilt, instrumented where required, and ABI stamped. Their
compiler version, clean source revision and SHA-256 hashes are retained in
`.context/go-wasm32-prototype/manifest.json`. The embedded compiler version
identifies `7ae173a6`; source status is clean.

Final checkpoint validation:

- Seven Node cases pass: runtime/atomics, startup/VFS, cgo scalars and
  per-M TLS, typed C structs/function pointers/errno, callbacks from
  Go-owned Ms, callbacks from C-created pthreads, and repeated concurrent
  callbacks with Go/C allocation and collections.
- The same inventory passes 21/21 browser cases in Chromium, Firefox and
  WebKit (44.5 seconds). The foreign-thread case includes pointer returns,
  nested C calls, yields/sleeps, repeated callbacks and Go stack growth.
- The typed-struct test passes pointer-bearing structs by value and reads
  pointer fields directly. It passes an escaping field address to ordinary
  Go `**C.int` callees, checks write-through and retains Go allocations
  through those typed fields across functional collections. Pointer
  atomics also preserve the adjacent four-byte word.
- Full standard-library compilation passes for plain Go on
  `kandelo/wasm32`, `wasip1/wasm32`, `wasip1/wasm` and `js/wasm`, plus
  cgo on `kandelo/wasm32`. Host cgo/object-reader/generated-platform tests
  and both eight-check WASI runtime controls pass.

Commands and the opt-in cgo inventory are in `tests/go/README.md`.
Final logs are `cgo-clean-checkpoint-{build,node,controls,browser}.log`
under `.context/go-wasm32-study-7VN0Qm/`. These are focused tests, not full
Go/cgo conformance, physical reclamation measurements or service proof.

**FrankenPHP source audit:** verified upstream FrankenPHP 1.11.0 source
archive `18ec919af5bfdd65a1224c7e8bbf46b00412c5357cd96663fcf73b61c002e1ff`
now compiles as a Go archive with its original C access, header/version
reads and bulk CGI registration. All 128 Go/C/header/assembly source files
match the source archive byte-for-byte. Only module routing selects the
direct target x/sys fork; `nomercure nowatcher` are the existing upstream
feature tags. No FrankenPHP source patch is applied. This removes the
previous eighteen pointer-field compile failures from the isolated audit.

The audit initially stopped because external x/sys did not select any CPU
implementation for the new architecture. The direct fork now extends the
existing CPU and little-endian selections to `wasm32`, preserving the
existing feature and padding behavior. Its three-line change plus file
renames is pushed at `df34dffa75d5f738769c8a313524a97c2272ef77`. Host CPU
tests, WASI CPU builds on both architectures, new Kandelo CPU/unix builds
in both cgo modes, and the old pinned Go 1.25 Kandelo/wasm build pass.

Audit evidence is `.context/frankenphp-wasm32-audit-aoS7MW/verification.json`
and `upstream.a`; its archive SHA-256 is
`b6059a91559206d7b25482394289f182c3eb150c516ba1129207cd79ad5c0d59`.
PHP ZTS revision-9 headers are compile inputs only. No PHP execution,
final executable link, restored Go-string lifetime in real requests,
FrankenPHP recipe migration or new WordPress preview is claimed. The
experimental PHP traversal candidate remains unpromoted.

Next: finish archive/export/TLS and signal gates on the new compiler,
link the unadapted FrankenPHP application, verify real PHP/WordPress
requests and Go-backed bulk-string lifetimes, then replace the obsolete
production adaptations and rebuild coherent package/image artifacts.
Repeat the final lifecycle/memory and UI workflows, sustained traffic,
fair FPM comparisons and Node/Chromium benchmarks. Native PHP recursion
and WebKit memory costs remain independent release gates.

### Isolated Kandelo/wasm32 runtime prototype — 2026-11-06

The maintainer approved proceeding after the investigation below. The
prototype branch is
[`kandelo-wasm32-prototype`](https://github.com/kandelo-dev/go/tree/kandelo-wasm32-prototype),
with upstream base `5e196a61a223f2590d576909992bea8803d770f9` and initial
Kandelo checkpoint `2b16bffd237d2949aab3763b5181325c0b775f7b`. It remains in
`.context/go-wasm32-study-7VN0Qm/upstream`, separate from `../go-kandelo`.
The compiler builds with the study's verified Go 1.26.10 bootstrap through
`scripts/dev-shell.sh`. No package selects it yet.

The port reuses the existing Kandelo OS/runtime, syscall channel, kernel
mapping allocator, shared-memory atomics and C archive object reader. Its
256 changed paths primarily forward-port that existing target onto Go 1.28
development sources; this is not a new private compiler backend. Upstream
supplies the architecture and code generation. Kandelo adds atomic Wasm
instructions and retains the existing overflow-safe large-frame guard.
The upstream collector remains intact. The legacy regexp algorithm change
is deliberately omitted from this branch.

Pointers, integers and pointer atomics are four bytes; virtual registers,
64-bit alignment and return/resume slots stay eight bytes. Thread startup,
signal registration and C relocations distinguish upstream's dense logical
Go PCs from Wasm function-table handles. Thread startup still captures each
M's own syscall channel, and heap mappings use the shared kernel allocator.
Go 1.28's lock-accounting delta, scavenger zeroing hook and directory-stat
selection are implemented for Kandelo. Scavenged bytes remain reusable;
these changes do not establish physical memory reclamation.

The prototype removes the mixed-width cgo pointer-field mapping and
export-frame marshalling. C pointer fields now retain ordinary typed Go
pointers. Frontend tests require typed pointer elements and an ordinary
16-byte scalar/pointer frame. This does not establish cgo execution: the
first full cgo build currently stops at `cmd/cgo`'s dynamic-import scan,
which still lacks a Wasm object case. The 32-bit runtime C-call bridge,
callback continuations, C-created pthreads, archive/TLS linking and ordinary
FrankenPHP source still require validation before replacing recipes.

Validation through the declared dev shell:

- Host compiler build passes using the verified bootstrap.
- `go build std` passes for `kandelo/wasm32`, `wasip1/wasm32`,
  `wasip1/wasm` and `js/wasm`. Host `cmd/cgo`,
  `cmd/link/internal/loadwasm` and generated `internal/platform` tests pass.
- Both WASI variants retain the eight functional investigation checks on
  Node, including reflection and continuation/stack-growth behavior.
- The new `tests/go/wasm32-prototype` Node inventory passes its runtime
  and VFS/startup programs. The runtime program adds four concurrently
  live locked Ms, shared 32/64-bit bitwise atomics, pointer exchange/CAS
  and an adjacent-word guard against oversized pointer stores.
- `go-wasm32.spec.ts` passes 6/6 cases in Chromium, Firefox and WebKit
  (15.7 seconds). It runs those same runtime and existing startup/VFS
  programs through real kernel/process workers and verifies the program's
  contract digest against the selected kernel. The runtime test checks
  eleven layout values and nine functional categories.

Commands are in `tests/go/README.md`. Runtime GC calls test root retention,
not memory reclamation. No full Go conformance, cgo/browser application,
performance or WordPress readiness claim follows from these focused tests.
Build/control logs are in `.context/go-wasm32-study-7VN0Qm/`; final Node
results are `.context/go-wasm32-prototype/{node,basic-node}.json`.
The first compiler build failed on an unregenerated opcode-name file;
subsequent target gates exposed upstream API/file-selection changes and
obsolete mixed-width unit expectations. Those failures are retained in
the study logs, followed by the successful final runs.

Next: port the general cgo object scan and 32-bit C-call/callback bridge,
prove ordinary typed struct field access and GC lifetimes, then remove the
corresponding FrankenPHP adaptations. Do not promote this compiler based
on plain-Go or frontend tests alone. PHP native call depth and WebKit
memory costs remain independent release gates.

### 32-bit Go/Wasm target investigation — 2026-11-06

**Recommendation:** use upstream's named `wasm32` architecture for an
isolated feasibility prototype, then assess a Kandelo runtime/cgo port.
Avoid a private backend design, operating-system-specific pointer widths
under the existing `wasm` name, or transparent field rewrites that cannot
preserve escaping-address semantics. Kandelo runtime implementation and production
migration are separate decisions from this investigation.

Upstream [proposal #63131](https://github.com/golang/go/issues/63131) is
accepted and still open, with milestone Backlog when checked. It addresses
the same host-layout and Go-pointer-lifetime problem found in this port.
Its planned initial operating-system target is WASI, not Kandelo, and
acceptance does not establish release readiness or a delivery date.

The read-only Gerrit inventory records these immutable current revisions:

| Upstream change | State checked | Scope |
|---|---|---|
| [836648](https://go-review.googlesource.com/c/go/+/836648), `564f7d071a34` | Merged October 29 | Separate pointer and register widths |
| [836651](https://go-review.googlesource.com/c/go/+/836651), `98dfce93f14c` | Merged October 30 | Architecture/type-layout definitions |
| [836652](https://go-review.googlesource.com/c/go/+/836652), `61944466b27f` | Under review | Compiler and assembler code generation |
| [836653](https://go-review.googlesource.com/c/go/+/836653), `ba007912b1fb` | Under review; updated November 5 | Function handles, logical PCs, reflection and linker |
| [836654](https://go-review.googlesource.com/c/go/+/836654), `51c48484e6c1` | Under review | Runtime, assembly, atomics and stack operations |
| [836655](https://go-review.googlesource.com/c/go/+/836655), `6701952c3c2d` | Under review | Shared library/build selections |
| [836656](https://go-review.googlesource.com/c/go/+/836656), `6e4c07ab3e3b` | Under review | Typed WASI pointers |
| [836657](https://go-review.googlesource.com/c/go/+/836657), `5e196a61a223` | Under review | Activate `wasip1/wasm32` and tests |

The eight revisions describe 284 unique paths, including generated files
and build constraints; that is not a count of newly maintained Kandelo
logic. Their proposed target retains 64-bit integer locals/registers and
8-byte stack alignment while making pointers and Go integers 32-bit.
Return/resume slots remain eight bytes, with separate 32-bit logical PCs
and function-table handles. A blanket replacement of eight-byte loads,
stores or offsets would therefore be wrong. This follows the existing
WebAssembly backend and Go collector model, rather than proposing a
Wasm-GC-managed heap or a new collector.

**Layout evidence:** an ordinary SDK-built, instrumented and ABI-stamped
C program runs successfully in Kandelo/Node, with empty stderr and host
diagnostics. A first comparison uses the proposed `{WordSize: 4, MaxAlign: 8}`
Go type model, represented by the identical existing `amd64p32` entry in
`go/types`; that name is used only for modeling. An actual upstream
Go/WASI32 binary now confirms those layouts on Node. For a sample with
scalar, pointer, 64-bit, pointer-to-pointer and tail fields:

| Layout property | SDK C/Kandelo, on Node | Actual Go/WASI32, on Node | Actual Go/WASI legacy control | Go `386` model |
|---|---:|---:|---:|---:|
| Pointer bytes | 4 | 4 | 8 | 4 |
| Go/C integer bytes | 4 | 4 | 8 | 4 |
| `uint64` alignment | 8 | 8 | 8 | 4 |
| Sample struct size | 24 | 24 | 40 | 24 |
| Pointer field offset | 4 | 4 | 8 | 4 |
| 64-bit field offset | 8 | 8 | 16 | 8 |
| Separate `{uint32; uint64; uint8}` struct size | 24 | 24 | 24 | 16 |

All eleven sampled size/alignment/offset values match the actual Go/WASI32
binary. The C and Go programs run separately; this is not a combined cgo
program. A direct target probe on the unchanged Kandelo fork still rejects
`wasip1/wasm32`. The layout-model and C-program evidence is retained in
`.context/wasm32-layout-study/`.

**Unmodified upstream prototype:** current revisions of changes 836652
through 836657 form a direct parent chain. The experiment checks out its
pinned head `5e196a61a223f2590d576909992bea8803d770f9` directly, without
cherry-picking or editing source. The declared Go 1.25.8 tool first builds
official Go 1.26.10 source, verified against its release SHA-256
`fd63e883ba2f2bfca93c1646b31ebef63e2b1e4d2b317c9789d976a68d81f36f`.
That bootstrap builds the upstream Go 1.28 development compiler (`08cc`,
1m38s); its target list contains `wasip1/wasm32`. Both source trees and
caches remain private to `.context/go-wasm32-study-7VN0Qm/`.

The same functional program compiles and runs as both `wasip1/wasm32`
and the legacy `wasip1/wasm` control on Node 24.15.0 (`1848`, 6s). Eight
checks pass on each: an interior pointer retained through Go GC; an
escaping field address with aliasing/write-through; closures/interfaces;
reflection calls; function-handle/PC lookup; stack growth through 256
recursive calls; panic/recover; and goroutine/channel scheduling. The
explicit `runtime.GC` is a functional root-retention check, not a memory
reclamation measurement. Node's normal experimental WASI warning is
retained in host stderr. `git diff --exit-code` confirms the experimental
upstream source remains unchanged.

A separate real cgo compile probe against this upstream compiler rejects
`wasm32` with `cgo: unknown ptrSize for $GOARCH "wasm32"`; no source change
was made to bypass it. This is the first observed cgo integration boundary,
not a claim that adding one table entry completes cgo support. The tests
do not prove Kandelo's Go/Wasm32 host, multiple Ms, C ABI bridge, PHP,
browser execution, full upstream conformance or service readiness.

The actual runtime proof, program hashes, raw warning output and exact
source/bootstrap lock are in `.context/go-wasm32-study-7VN0Qm/`;
`runtime-proof.json` records both targets and the C layout comparison.

**Integration scope:** the series targets a Go 1.28 development tree. Its
bootstrap rule requires at least Go 1.26; the declared shell currently
provides Go 1.25.8 and the Kandelo fork is Go 1.25.6. The isolated source
bootstrap above supplies that requirement without changing the declared
production toolchain. None
of the eight patches passes an individual unchanged `git apply --check`
against this fork. Those are context checks, not sequential cherry-picks,
semantic merge results or proof that backporting is infeasible. A forward
port to a pinned upstream base should be assessed before attempting a
large bespoke backport. The active Kandelo Go checkout and package pins
remain unchanged.

The proposed upstream runtime uses single-threaded WASI scheduling and
`sbrk`, and its platform entry does not enable cgo. Kandelo still needs:

- Native Wasm atomics, multiple Go Ms, per-M syscall channels/TLS,
  startup, scheduler wakeups, signals and cooperative retirement.
- Architecture-correct cgo call/export frames, C-created-thread callback
  bootstrap, GC roots and pinning, constructors, archives and exceptions.
  The current mixed-width special cases in `cmd/cgo/gcc.go` and `out.go`
  are candidates for removal for the new target only after real tests.
- C archive function/data/TLS relocation and callback-table integration
  with upstream's changed function-handle and logical-PC scheme. This is
  a major review point in the existing custom linker, not a name change.
- New architecture selection in runtime assembly, SDK wrappers, package
  recipes and direct dependency ports. Files ending in `_wasm.go` or
  `_wasm.s` are not automatically selected for `wasm32`.

The existing wasm32 C ABI, shared-memory object and fixed-width syscall
transport need not be replaced merely because Go's pointer model changes.
In particular, the channel's six 64-bit argument slots stay fixed-width.
Audit actual host/program exports and layouts before deciding whether a
public ABI bump is necessary; do not assume either a mandatory global
bump or compatibility. Keep the existing target and artifacts intact
through an isolated prototype.

The isolated upstream build and focused runtime proof above complete the
first investigation gate. Next, port Kandelo's threading and channel
runtime in isolation; prove generic cgo layouts, escaping pointer-field addresses,
Go-backed argument lifetime and both callback paths on Node/three
browsers; then try PHP embed and FrankenPHP's original struct/bulk call
paths. Only after those pass should production recipes/images migrate
and the original final lifecycle, editor, traffic and benchmark gates
resume on coherent artifacts.

This route addresses the pointer-ABI mismatch. It does not by itself fix
PHP's native recursion limit, establish the PHP patch's upstream benefit,
reduce engine-managed WebKit memory, or complete the existing service goal.
Potentially smaller Go data structures are not a measured RSS saving.
Full revision hashes, patch hashes, states, file inventories and read-only
context-check logs are retained in `.context/wasm32-upstream-review/`.

### Current cgo adaptation audit — 2026-11-06

The corrected isolated compile audit (`b72e`, 36s) compares verified
FrankenPHP 1.11.0 source with the complete package patch, using pinned Go
`5834adc` and normally built PHP ZTS 9 headers. Unchanged source produces
18 errors in pointer-bearing struct initializers, assignments, nil
comparisons and linked-list access. The patched control compiles. This is
compile-only evidence, not final linking or service execution. The earlier
`91e6` diagnostic did not apply its control patch correctly inside the parent
Git worktree; explicit patch-content guards fix that setup error in `b72e`.

The new general aggregate regression sends 24 distinct 12-byte structs by
value, with C pointer arguments before and after them. It verifies field
order, lengths, pointer identity and every C-owned pointee. Node passes
with empty stderr/diagnostics, and Chromium/Firefox/WebKit pass all three
cases (`063d`, 17s; browser execution 7.5s). The smaller first version also
passed (`d633`, 22s). No Go toolchain or production package changes were
needed for these results.

Restoring the original FrankenPHP bulk call in an isolated source copy
also compiles with explicit 32-bit field conversions. That is not a safe
release fix yet: `toUnsafeChar` addresses Go string storage, and raw
integer fields do not retain Go GC roots. The generic test's C-owned
storage deliberately does not establish that lifetime contract. No bulk
call restoration or recipe revision change is retained in the registry.

The remaining direct-field errors are a structural cross-ABI issue:
stock Go/Wasm pointers are 64-bit, while the C SDK's pointers are 32-bit.
Using ordinary Go pointer fields changes the C struct layout; keeping
32-bit raw fields changes the source-level field operations and GC
visibility. A kernel/POSIX fix cannot reconcile those representations.
Transparent field translation or a shared pointer-width ABI needs a
separate design assessment before invasive toolchain changes. The
maintainer has been asked which boundary to adopt. The current explicit
accessors remain in place, with no claim of unchanged-source cgo support.

**Automatic field translation assessment:** a minimal source example takes
the address of a C pointer field and passes it to ordinary Go code:

```go
func indirect(p **C.int) *C.int { return *p }
func Read(s *C.slot) *C.int { return indirect(&s.pointer) }
```

Here C defines `slot` as a struct containing `int *pointer`. With the same
pinned toolchain, its native Darwin/arm64 archive compiles, while Kandelo's
archive correctly rejects `*uint32` as `**C.int`. The observed command and
results are retained in `.context/cgo-field-address-assessment.log`, with
the reproduction in `.context/cgo-field-address-model/`. This is a compile
diagnostic, not runtime validation or a new production feature.

A getter/setter rewrite does not preserve an escaping field address. A
temporary changes identity, aliasing, concurrent observations and immediate
write-through; casting it to `**C.int` leaves the four/eight-byte storage
mismatch. Full transparent compatibility therefore needs more than local
field rewrites. The current cgo pass rewrites C references/calls rather
than performing such whole-package pointer analysis. Its runtime pointer
checks also use Go field type metadata, so raw integer fields cannot stand
in for GC-traced Go pointers. No automatic translation implementation,
compiler/collector change or additional package adaptation is made.

The decision remains between explicitly scoped mixed-ABI adapters and a
larger common-ABI/translation design. Follow the maintainer's instruction
to discuss before invasive work; do not conceal this boundary in a demo
patch. Generic recursion instrumentation would address a different issue
and cannot repair this source-level pointer representation mismatch.

### PHP upstream-candidate evidence — 2026-11-06

The maintainer's performance condition is not established. The iterative
CFG patch remains experimental in this draft; these results do not approve
its acceptance or promote the candidate preview.

The Kandelo Node optimizer run (`cf91`, exit 1, 1m03s) inventories all 136
upstream cases: 12 pass, 78 are classified unsupported and 46 fail. Every
failure reports the existing requirement for file-cache-only OPcache;
the INI-only activation cases bypass the harness's preflight classification.
The 12 passes alone do not establish optimizer coverage. Raw results and
nonpassing evidence remain in `.context/php-cfg-upstream-zRfGXu/`. No
expectation, PHP guard or SHM limitation was weakened to make this green.

Two native PHP 8.5.12 NTS builds use the same LLVM 21.1.7, configuration and
verified source, differing only by the CFG patch (`6070`, 6m34s). The normal
native `zend_test` extension was built privately to supply one initially
missing test prerequisite; the CLI binary hashes stayed unchanged. Both
native optimizer suites run with OPcache enabled and finish with 135
passes, the same one upstream XFAIL (`verify_return_type.phpt`), no skips
and no unexpected failures. The original baseline run without that
extension is retained separately. This is native regression evidence,
not Kandelo's missing SHM semantics or a complete PHP conformance claim.

Native compilation timings (`977a`, 10s) use five alternating
baseline/candidate pairs on Darwin 27.2 arm64, fresh PHP processes, the
same optimizer mask `0x7ffebfff`, disabled JIT in both builds, and no
concurrent builds/tests from this workspace. One warmup per side precedes
timing. Every input is compiled and cached. WordPress's mutually exclusive
declarations require two fixed identical 748-file batches; no file is
excluded. Native WordPress deprecation diagnostics are retained and must
match on both sides. Earlier unbatched/deprecation-parser harness failures
(`e783`, `0802`) precede valid timing and remain recorded.

| Native compilation workload | Original median (range), ms | Iterative median (range), ms | Median change |
|---|---:|---:|---:|
| WordPress 7.0, all 1,496 PHP files | 392.23 (391.41–406.05) | 404.28 (390.83–427.67) | +3.07% |
| 10,000 small four-branch functions | 64.65 (62.86–66.60) | 63.81 (62.22–72.04) | −1.30% |
| 64 functions with 768 branches each | 66.76 (64.77–68.65) | 65.85 (64.53–67.02) | −1.37% |

These overlapping ranges do not establish a speed improvement or a
statistically significant regression. Rounded PHP allocator peaks and
OPcache storage sizes match in each workload; that does not show zero
extra allocations or equal physical footprint. The patch still allocates
eight bytes per CFG block and frees them for reuse. One native architecture
cannot establish an all-platform benefit. These are compilation timings,
not WordPress request latency, Kandelo timings, or a PHP-FPM comparison.

Evidence lives in `.context/php-cfg-native-nPi7F1/`: source/patch provenance,
both build and PHPT logs, corpus hashes, fixed batch plans, 36 raw workload
records (six warmups plus 30 timed records), and `benchmark-summary.json`.
Native CLI hashes are `7009c08b3869f9bf` (original) and
`dab823ad4eb91d38` (candidate); patch SHA-256 is
`cf25f68113697d69d4354bb5b7aaac22a1396e855617de920c8eed96cb7452c2`.

The active draft is [PR #1492](https://github.com/Automattic/kandelo/pull/1492),
on ABI 55 and main `21cfba152` (last fetched November 5). The Go consumer
recipes pin `5834adc306dddf6784c20e402deeabf643ad9c37`. Go's collector and
code generator remain unchanged.

The current running static preview is port 5457, built from runtime
correction `54e0b054a`. WordPress revision 39 is 79,416,985 bytes, SHA-256
`52c13b187190ae24653bd50e939aaac6a15daef809a3b15df029bc2f70400ee3`;
its kernel remains `bfdf6ce5`. Its image/group HTTP identities and the
actual production worker's heap-checkpoint allocation are verified.
`.context/frankenphp-production-preview-artifacts.json` records the URL
and identities; the previous bundle is retained separately on port 5455.
Both services use the measured two-PHP-thread default.

On this corrected production preview, Firefox and WebKit each pass a
five-minute actual Appearance Editor health interval, requiring one Caddy
startup and no PHP or Go fatal errors (`5644`, 14m05s). Both Node service
workflows pass held-response draining and cooperative retirement (`1cb4`,
51s). Three WebKit Caddy/library save/upload/template/source-free reload
repetitions finish two passes and one failure (`41e5`, 8m32s). The remaining
failure is a native stack overflow in PHP's recursive optimizer CFG
postorder traversal during a later admin request. The demo is not yet
production-ready and that failure is not accepted as a completed gate.

The current Go host passes all 162 ordinary browser cases across three
engines (`3cdd`, 8m24s), three Node and nine browser callback cases (`2230`,
37s), and ten Node signal modes, two Node retirements and 57 browser signal
cases (`b41b`, 2m43s). All four standard-library compile gates and available
upstream Node `os` inventory were validated on pinned Go source `5834adc`:
224 tests/examples pass and 21 existing skips per plain/cgo mode. That is
not the complete upstream Go suite. Current C signal/I/O conformance passes
89 cases per host on Node and Chromium with two existing skips each, no
failures/timeouts, using the same final kernel and rootfs (`c4d6`, 2m42s).

The missing production allocation was a host implementation defect:
tree shaking removed a module-local buffer whose only reader was a test
export. A private worker-global root now retains only the newest eight-byte
ordinary buffer. Its production regression fails before the correction
and passes afterwards in all three engines; the existing four checkpoint
tests pass on both Node and Bun. The engine explanation behind checkpoint
usage remains suspected. No timeout, memory ceiling or ABI is changed.

A standalone unchanged PHP CFG traversal reproduces the finite native
worker-stack boundary without Kandelo imports. Valid optimized PHP with
768 conditionals reproduces the same frame in the real Caddy service;
Chromium/Firefox and the smaller WebKit control pass. A small iterative
traversal agrees with the original on 2,000 generated graphs and handles
16,384-block chains/cycles in all three engines. The permanent real-PHP
regression fails before the correction on WebKit; both Node controls pass.
PHP revision 23 and PHP ZTS revision 9 now share that scoped algorithm patch,
and WordPress advances to revision 40. The normal 184-node rebuild (`8a14`)
finished in 30m17s (170 cached, 14 published). Real package pass-after and
final-image gates remain pending, and candidate promotion is held under
the upstream-benefit criterion above.

The prior revision-39 memory/lifecycle gate passed all 18 browser, 239
ownership, seven boundary, three Node and seven Bun cases (`ba3c`, 20m20s).
The earlier source-served UI gate passed all 27 cases; the previous full
production UI batch passed 26/27, and production persistence 11/12. Those
results retain their recorded artifact/fixture scope and do not substitute
for the final revision-40 gates.

Memory controls distinguish guest linear memory, Go accounting, PHP
allocations and engine/native costs. Go-released pages become reusable;
linear memory does not shrink. The two-thread WebKit control's native
category bucket peaks at 10.61 GiB and falls to 0.28 GiB thirty seconds after
destruction. Six PHP threads can still exceed the content-process footprint
limit. These are scoped observations, not a physical-memory hard cap or an
indefinite plateau. Quiet sustained/fair PHP-FPM comparisons and alternating
nine-suite Node/Chromium measurements remain unrun. The provisioned baseline
`5e25c7365` is an intermediate PR revision, not main; no speed advantage or
main-relative performance claim is established.

The dated entries below preserve historical failures, repairs and exact
measurement scopes. Broader Go/POSIX boundaries remain explicit: child
credentials, inherited blocked masks, native HostFS path/helper distribution,
additional cgo initialization/finalization forms and full upstream conformance.

### Production checkpoint allocation correction — 2026-11-06

The immutable production worker built at `840b49970` contains a checkpoint
function that returns only `100000000n` on JSC. Vite/Terser correctly
eliminates an unread module-local assignment when the test-only getter is
absent. Unrelated eight-byte allocations elsewhere in the bundle initially
confounded a text search; inspecting the actual import establishes the
missing allocation.

The host now roots only the newest eight-byte ordinary buffer on the
worker global under a private symbol. It replaces the previous buffer on
each call and retains no guest address space. No Go compiler, collector,
ABI, wait bound, or guest dependency changes are needed. The new browser
regression bundles only the actual runtime entry, omitting the test reader:
three calls allocate zero buffers before the fix, versus three distinct
eight-byte buffers after it in Chromium, Firefox and WebKit (3/3, 8.9s).
The four existing safepoint tests pass on both Node and Bun, including
real blocking I/O.
ABI checking reports the program digest unchanged. The workaround registry
remains consistent (ten entries, 37 tagged sites); its engine explanation
remains suspected.

The old production persistence batch passes 11/12, including actual PNG
rendering in the editor before leaving it. The failed WebKit Caddy/library
reload subsequently passes a targeted native-observed rerun on the same
old bundle in 2m50s (`7899`, `.context/frankenphp-production-recovery-diagnostic-M6col2/`).
Its native category sum peaks at 8.67 GiB; this is not whole-process physical
footprint, and the observer can perturb timing. The earlier response-pump
failure remains unexplained; it is not proven to result from the missing
checkpoint allocation. The 26/27 production UI result is separately traced
to a fixture awaiting an already-dismissed Shortcuts popup after successful
login. The fixture now accepts that normal dismissal and requires the
unobstructed view before continuing. A final coherent rebuilt cohort and
full production repetitions remain required.

The longer old-production editor check (`db91`) passes Firefox's five-minute
health interval but fails WebKit at the 150-second health request with
`Service Worker context closed`. The page logs a restored service-worker
bridge; Caddy remains PID 111 with one two-thread startup and no fatal Go
log. This does not demonstrate a Caddy crash. The failure and earlier
fork-child launch diagnostic are retained in
`.context/frankenphp-production-editor-soak-zCSKoh/`. The corrected bundle
still needs this real-editor check; do not replace it with the successful
raw-HTTP fixture or accept a failed health request.

Three additional old-bundle WebKit Caddy/library recovery repetitions
(`2771`, 13m10s) finish with one pass and two failures. The new failure
inspector provides the guest service logs: both failures include PHP's
`Maximum execution time of 30+2 seconds exceeded (terminated)` and dinit
reports Caddy exit 124 before restarting it. One subsequent restart also
throws Go's `newosproc: child bootstrap timed out`. Thus these reload
failures do include real guest process exits, unlike the separate
service-worker health failure above. No execution-time or bootstrap limits
are raised. The corrected checkpoint still needs equivalent repetitions.
Raw logs are retained as `.context/old-production-recovery-failure-{1,2}.log`.

### Corrected-host artifact publication — 2026-11-06

The normal 184-node publication and consumer admission pass in 17m49s
(`49d8`: 172 cached, 12 published). WordPress revision 39 is now 79,416,985
bytes, SHA-256
`52c13b187190ae24653bd50e939aaac6a15daef809a3b15df029bc2f70400ee3`.
The admitted kernel remains `bfdf6ce5`. The Go/PHP/Caddy executables are
reused; the host-assisted images rebuild against the corrected host.
The earlier `b5d9a032` UI/persistence results remain scoped to that previous
image and production host. A fresh static production build and its gates
are pending.

C signal/I/O conformance passes again with the corrected host (`c4d6`,
2m42s): Node and Chromium each pass 89 cases with two existing skips, no
failures or timeouts. Both use the final `bfdf6ce5` kernel and the same
new rootfs `8484649a`; the older conformance record used a different kernel.
Evidence: `.context/current-c-conformance-FxaTCF/` and
`.context/checkpoint-c-conformance-evidence.json`. This is not full POSIX
or upstream Go conformance.

The default browser preparer's debug native tool is intentionally stopped
with exit 143 after 13m44s in product finalization. A one-second native
sample shows artifact-policy, receipt and source-identity validation at
about 358 MB physical footprint, rather than a browser/Go memory stall.
Preparation resumes through a freshly built release-profile executable of
the same normal `xtask bootstrap packages` command, followed by unchanged
consumer admission and authenticated-group/frontend building. No policy or identity checks are bypassed, and no artifacts or tracked
build scripts are edited by hand. The cancelled run is not counted as
passing.

The release-profile preparation completes in 3m34s (`6e96`), including
normal default-product publication/admission and the production frontend.
The actual shipped `worker-entry-browser-BvSW-7L8.js` retains the private
symbol/global assignment and a fresh `ArrayBuffer(8)` at each checkpoint.
The immutable preview runs on port 5457 from
`.context/frankenphp-final-browser-build-hLg168/site`; its HTTP image hash
matches `52c13b18`, and its authenticated group is `fcab3ccc` (27,926 bytes).
The first new WebKit Caddy/library save/upload/template/source-free reload
case passes in 1m54s; two more repetitions and five-minute Firefox/WebKit
editor checks are running. This is not yet the full production gate.

### Corrected-host browser results and PHP optimizer stack boundary — 2026-11-06

On the `52c13b18` image and corrected production bundle, both five-minute
actual Appearance Editor health checks pass (Firefox and WebKit, `5644`,
14m05s). Each requires exactly one Caddy/FrankenPHP startup and rejects PHP
and Go fatal errors. Both Node service/drain/retirement workflows also
pass (`1cb4`, 51s). The ordinary Go inventory passes all 162 cases across
three engines (`3cdd`, 8m24s); this count includes the thread-slot ceiling
case. Fresh callback checks pass three Node and nine browser cases (`2230`,
37s); signal/retirement passes ten Node modes, two Node retirements and 57
browser cases (`b41b`, 2m43s). The updated 184-node benchmark projection
also passes normal publication/admission (`68af`, 7m20s, all cached).

Three new production WebKit Caddy/library recovery repetitions finish two
passes and one failure (`41e5`, 8m32s), so recovery is still open. The failed
case reopens the saved homepage, then a later admin/editor request reports
`Maximum call stack size exceeded` in Wasm function 7275 on a PHP thread.
The function's four parameters, CFG block layout and recursive bytecode
identify PHP's `compute_postnum_recursive` in `Zend/Optimizer/zend_cfg.c`;
the static PHP archive also supplies its named object disassembly. This is
distinct from the old PHP hard timeout. Retained evidence:
`.context/frankenphp-checkpoint-production-recovery-koat0o/` and
`.context/new-production-recovery-{service.log,syslog.json}`.

A standalone C probe extracts that unchanged upstream function and block
layout, compiles with the declared unwrapped LLVM, and instantiates modules
with no imports. It checks exact postorder for chains and cycles. Cold
standalone dedicated workers pass depth 512 on WebKit 26.6 but overflow at
1024; Chromium 153 and Firefox 155 pass 4096 and overflow at 8192. A separate
main-page probe has different limits. There is no Kandelo runtime, PHP
runtime, or Go code in these modules. Evidence:
`.context/php-cfg-depth-worker-original.json`; source and original main-page
results remain alongside it. This establishes a bounded native worker
call stack, not an engine specification defect. It does not justify
claiming guest-memory corruption ruled out for every PHP path.

Next: validate a small iterative CFG traversal against the original
postorder and real optimized PHP execution before changing the package.
Keep optimizer behavior, timeout limits and Go's compiler/collector intact.
Final production recovery, full UI/memory gates and sustained/fair timings
remain required after any package correction.

### PHP CFG traversal portability correction — 2026-11-06

A real optimized PHP probe on the unchanged image passes 96 conditionals
in all three engines. At 768 conditionals Chromium/Firefox still return
correct values twice, while WebKit reports the same recursive Wasm function
7275 and loses the PHP worker. OPcache is loaded and its normal optimization
mask remains `0x7ffebfff`. Evidence: `3d97` (35s),
`.context/real-php-cfg-original.json`. The earlier `1726` attempt is only a
fixture setup failure: guessed source-asset URLs returned HTML. The corrected
probe serves normally admitted image/kernel files, checks their hashes in
the browser, and uses the ordinary image-owned lazy transport.

The permanent service regression now exercises 96/768-condition PHP files
twice, checking results, OPcache's unchanged optimization mask and actual
file-cache entries. On the old artifact the WebKit Caddy case fails at the
768-condition request (`11dd`, 44s); both Node service controls pass
(`dc93`, 42s). No failure is accepted or skipped.

The candidate common PHP recipe replaces only the internal CFG postorder
recursion with an explicit traversal frame array. Each frame stores the
block and next successor; first visitation still marks `-2`, successor order
is unchanged, and completion assigns the same postorder number. At most one
frame per block is live. `safe_emalloc` checks the `8 * blocks_count`
allocation, and `efree` releases it after traversal. This memory belongs to
PHP, outside Go's soft memory limit; freeing it establishes reuse, not
physical page reclamation. No optimizer pass or timeout is disabled.

A standalone prototype agrees exactly with the unchanged recursive traversal
on 2,000 generated branching/cyclic graphs (up to 128 blocks), and handles
chains/cycles of 16,384 blocks in cold workers across all three engines.
All 18 probe cases per engine pass, including repeated equivalence checks:
`.context/php-cfg-depth-worker-iterative.json`. The patch applies to the
verified PHP 8.5.12 source. It is a portable algorithm correction at the
already documented native worker-stack boundary, not a Kandelo POSIX stub,
Go collector/code-generator change, or engine specification-defect claim.
That deliberate runtime boundary does not require a new workaround entry
under the registry's "What gets an entry" rules.

PHP revision 23 and PHP ZTS revision 9 share the patch and declare it as an
input. WordPress advances to revision 40. The normal 184-node rebuild
(`8a14`) is running with one package at a time. The Mac has about 14.8 GiB
free plus reusable inactive pages before this build, allowing the previously
measured instrumenter peak without closing other applications. Actual
package/browser pass-after and final-image gates remain pending.

### Remaining release gates

1. Complete the normal PHP 23/ZTS 9/WordPress 40 publication and actual
   pass-after for the real optimized-PHP regression on Node/all three
   browsers. Preserve optimizer configuration and exact results.
2. Repeat the full visible login, editor, post/template saves, uploads,
   source-free persistence/crash recovery, service drain/restart and
   five-minute real-editor checks on coherent final production artifacts.
3. Repeat the full browser memory/lifecycle gate on the final cohort.
   Prior revision-39 evidence is preserved, including Vite cache isolation,
   terminal-channel wake regression and all-engine service retirement.
4. Finish sustained traffic/RSS checks, paired PHP-FPM/classic/Caddy
   measurements and the three alternating rounds of all nine Node/Chromium
   suites. Both cohorts are provisioned; refresh the candidate after PHP
   changes. Report the intermediate baseline and pool/cache differences.
5. Review broader Go/POSIX gaps and document exact support boundaries.
   Keep six-thread WebKit footprint limits and reusable-versus-physical
   memory distinctions explicit.
6. Push validated checkpoints, update this log, draft PR and guidance,
   and keep the verified final-image preview running.

### Terminal-channel notification checkpoint — 2026-11-06

A terminal completion must wake all waiters on its exact channel object.
The former one-waiter notification could wake a queued host observer and
leave the guest parked. The fix marks process/thread exit and teardown
channels before publication, and broadcasts only terminal completions.
Ordinary active-channel notifications remain unchanged. No compiler,
standard-library, libc, kernel, or ABI modification is involved.

- Before: `.context/terminal-channel-observer-before/vitest.JgqCTj/`
  retains the native-waiter regression failure: the guest times out after
  the observer consumes the sole notification.
- After: `.context/terminal-channel-observer-after/vitest.ZDwBiL/`
  records 28/28 checks across six channel/lifecycle suites.
- Job `frankenphp-terminal-wake-real-services-1106-024551-e7df`
  passes both real WordPress services four times each in fresh Node test
  processes: actual held PHP response, zero service/controller exits,
  real service logs, and cooperative machine retirement. Last report:
  `.context/frankenphp-node-image-oNT3U5/`.
- `.context/frankenphp-webkit-host-1deKzl/` retains the separate native
  footprint kill and external memory/phase samples. This is unresolved
  resource evidence, not proof of an engine defect or guest heap leak.

The earlier failed dinit retirement remains historical evidence. Its exact
waiter ordering was not captured, so the focused reproduction and eight
successful real cases do not establish the complete lifecycle release gate.

### Declared browser RSS tooling — 2026-11-06

The first declared-tool attempt (`pkgs.unixtools.ps`) exposes a real Darwin
boundary: its `rss` field requires a system entitlement. It is not retained
in the flake. The existing declared Python now includes pinned psutil, and
`benchmarks/process-rss.py` samples the exact Chromium process IDs returned
by the browser debugging session. Failed queries fail the observation;
missing processes are never silently assigned zero memory. The sum can
still count shared native pages more than once.

The real blank-page Chromium check reads all four reported processes and
records 254,181,376 bytes in `.context/declared-browser-rss-check.log`.
This proves tool availability, not WordPress memory behavior or stability.
The flake is a global package input, so the next build regenerates its
cohort normally instead of bypassing cache identity or ambient host tools.

### Coherent rebuild and ownership audit — 2026-11-06

The first changed-tool union, job
`frankenphp-declared-rss-tool-cohort-1106-030716-9e6b`, ends after 4h53m:
149 packages publish, 15 nodes are cached, SpiderMonkey fails, and 19
consumers remain blocked. Mozilla correctly rejects the unrelated psutil
7.1.2 exposed by the benchmark's declared Python environment; its build
requires psutil at most 5.9.4. No compiler or upstream package patch is
needed. SpiderMonkey revision 16 creates a private, pip-free Python virtual
environment under its resolver work directory, retaining Mozilla's own
requirements. A direct environment check confirms psutil is absent there.
The normal retry, `frankenphp-isolated-python-cohort-1106-104015-9736`,
reuses the completed package cache. Its final result remains pending.

The first broad source-only host memory run records 238/239 passing in
`.context/terminal-wake-memory-source-r9fenE/`. Its audit identifies six
unreviewed allocations in the existing standalone Go/C linker probes.
They instantiate synthetic program modules with private test-owned shared
memory and stub imports, never a Kandelo kernel or live guest memory.
Explicit exact-site allowances preserve the audit's full source inventory.
The corrected run passes all 239 checks in 137.21 seconds:
`.context/terminal-wake-memory-source-6QMYZh/vitest.JCfjqc/`.
This does not replace the prepared-product Node/Bun and repeated browser
switching parts of `./run.sh test browser-memory`.

Caddy is also added to both storage modes in the existing real WordPress
crash-recovery fixture. It must preserve a published post, exact uploaded
PNG, and saved site-template heading with the original image source
disabled. These new cases are not yet run. Optional browser-host memory
samples now also retain ordinary `/proc/<pid>/status` thread counts.

### Terminal wake: broader verification — 2026-11-06

SpiderMonkey revision 16 and its Node adapter build successfully in the
cohort retry, clearing the Python version conflict. The retry then reaches
normal image assembly; coherent final publication is still pending.

- The seven browser memory-boundary checks pass, including nested protocol
  declarations and tiny views retaining whole shared memories:
  `.context/terminal-wake-browser-boundary.log`.
- The host build, including declarations, passes:
  `.context/terminal-wake-host-build.log`.
- `npm run test:teardown:engines` passes 3/3 Node and 7/7 Bun checks with
  no skips. This supplements the 239 source-only memory/ownership checks;
  it does not establish the complete repeated browser-switching gate.
  Evidence: `.context/terminal-wake-node-bun.log`.
- Job `terminal-wake-c-conformance-1106-104757-0c5b` passes 89 Sortix
  signal/I/O cases on Node and 89 on Chromium, with two existing skips
  each and no failures, errors, or timeouts. Its normally published,
  isolated projection and runtime identities are recorded at
  `.context/current-c-conformance-hnjFsx/artifacts.json`.
- Playwright collects all nine visible WordPress cases and eight
  persistence cases in the expanded Chromium inventory. Collection is
  not evidence that those browser workflows ran.

No speed, physical-memory plateau, WebKit kill fix, complete Go/POSIX
conformance, or production-readiness claim follows from these checks.

### Declared-tool cohort published — 2026-11-06

The retry `frankenphp-isolated-python-cohort-1106-104015-9736` succeeds
in 20m36s: all 184 nodes, all 11 products, 172 cached nodes, 12 newly
published nodes, and normal consumer admission. No compiler or upstream
package dependency patch was needed. Result:
`.context/frankenphp-declared-rss-cohort-result.json`.

The rebuilt WordPress image remains revision 37 and is 79,342,248 bytes,
SHA-256 `389ec37e63422e400b7c683031eb803ffb1c975d8242606f4aff49c1bbdeeff5`.
Its kernel SHA-256 is
`bfdf6ce58bbf9a93e769d0262d38d77ebfefb733ba1c4b2cf9ae9ea59029f1cf`.
These identities belong to the new declared-tool cohort; the existing
port-5417 preview still pins the preceding `79c47b29` image. Full rebuilt
app checks and a new preview remain pending.

The post-terminal-wake sample job
`terminal-wake-go-package-all-hosts-1106-110055-f9fe` passes in 44 seconds:
normal kernel/Go-25 publication, C VFS launcher on Node, and all three
browser launch cases. Node records expected output, zero exit, empty stderr
and diagnostics, and fork count zero. Its narrow browser fixture retains
the known unrelated app pre-bundle warning. Evidence:
`.context/go-package-final-AC4WWv/`.

The complete required gate `./run.sh test browser-memory` is running as
`frankenphp-terminal-wake-browser-memory-1106-110233-6159`, owning port
5447. A separate normal cached benchmark projection preserves the full
candidate cohort without relying on the default browser demand's subset.
Neither pending job is a performance result.

### Memory diagnostic controls prepared — 2026-11-06

The standalone candidate benchmark projection completes through normal cache
admission in 9m38s (`go-candidate-benchmark-cached-projection-1106-110429-e338`).
Both baseline and candidate artifact cohorts are available; the alternating
nine-suite Node/Chromium measurements are still unrun.

The browser-host diagnostic accepts `KANDELO_FRANKENPHP_NUM_THREADS` while
retaining six by default. It configures the real Caddyfile or classic dinit
environment and requires actual Caddy startup logs to report the requested
pool size. This supports a controlled native-memory investigation; it does
not change the shipped defaults or establish a memory fix. The new pool
control awaits a browser run after the required lifecycle gate. Native
sampling will retain the owned browser process tree outside the page, with
guest `/proc` thread counts and module/linear-memory snapshots alongside it.

### GC and memory-control review — 2026-11-06

Go's collector manages its heap inside linear memory in this port. Wasm GC
manages separate reference objects; it does not automatically collect the
Go/PHP heaps or reclaim compiled code. Moving Go's heap representation to
Wasm GC would be a separate compiler/runtime effort, outside the maintained
target port's present design.

Two current platform boundaries are concrete: the Go target's
`src/runtime/mem_kandelo.go::sysUnusedOS` is empty, and Kandelo's
`sys_madvise` accepts advice without discarding backing pages. Go's normal
scavenger updates its ready-memory accounting before invoking the OS hook.
This needs a measured accounting/reclamation review; it is not proof that
scavenging explains the observed WebKit kill. The last 499-MiB guest/kernel
snapshot preceded the later 19,981-MB native footprint report, so those are
not synchronized readings or an allocation breakdown.

Recommended work, in order:

1. Audit Go's non-channel waits before broad memory tuning. At the pinned
   target source, `lock2` waits indefinitely in `atomicWait32` and
   `kandeloNoteSleep` can do the same; neither uses the existing host-heap
   checkpoint. The syscall channel does use it. Review scheduler sleeps and
   bootstrap waits too, preserving real wakes and original deadlines.
   Reuse the existing suspected `JSC-BLOCKED-WAIT-GC-STARVATION` contract;
   this source gap does not establish the cause of the native memory kill.
2. Attribute guest heaps, Wasm/JavaScript references, module bytes, instances,
   and native/JIT allocations during identical traffic and pool-size runs.
   Retain measurements outside the page. On macOS a simple descendant-PID
   walk omits WebKit's XPC content processes; the blank-page control confirms
   that limitation. Do not present that partial tree as renderer RSS.
3. Validate Go scavenger accounting with allocation/reuse cycles and
   `debug.FreeOSMemory`, comparing Go statistics, process mappings, linear
   memory, and native footprint. Distinguish reusable pages from physical
   release. Investigate platform discard support before promising it.
4. Extend resource budgeting to worker/pool and module/instance costs, with
   measured defaults and visible refusal when known budgets cannot fit.
   `GOMEMLIMIT` is a soft Go-runtime limit and excludes C/PHP and engine
   allocations; it cannot be treated as the entire service's cap.
5. Audit retained references and asynchronous owners through repeated
   boot/load/drain/destroy cycles and sustained traffic. Keep the normal
   ownership and lifecycle assertions, without forced-GC or reload shortcuts.

References: [Go memory-limit semantics](https://pkg.go.dev/runtime/debug#SetMemoryLimit),
[Wasm GC](https://github.com/WebAssembly/spec/blob/main/proposals/gc/Overview.md),
and [Wasm memory control](https://github.com/WebAssembly/memory-control/blob/main/proposals/memory-control/Overview.md).
These are investigation and platform work items, not new support claims.

### Native attribution and browser-fixture failure — 2026-11-06

A disposable diagnostic reads WebKit 26.6 `Memory.trackingUpdate` events
through the pinned driver's existing inspector connection. The blank-page
control receives four samples with JavaScript, JIT, image, layer, page and
other category sizes. It uses no engine flags, heap snapshots, forced GC,
or driver source patches. Raw control:
`.context/webkit-native-memory-control.json`. This demonstrates a scoped
measurement path, not an attribution of the FrankenPHP footprint.

The first broad browser-memory run passes its source/host/Node/Bun phases
but Chromium's real application page remains blank before Doom starts.
The trace records a SyntaxError: cached `react-dom.js` does not export `t`.
The same pre-boot problem prevents the real audio gesture case from starting.
The dependency optimizer cache is shared across concurrent Vite instances;
its exact isolation fix and browser rerun remain required. This is fixture
failure evidence, not a Go, kernel, Wasm GC, or guest reclamation result.
The owned invalid run was stopped through its verified supervisor after
32m52s (exit 143), preserving partial results and the passed earlier phases.
Durable copies of traces, error contexts, screenshots, console and status:
`.context/terminal-wake-browser-memory-failed/`.
Screenshot: `.context/browser-memory-doom-failure.png`.

### Development dependency-cache ownership — 2026-11-06

Vite development servers now allocate private optimizer-cache directories
through ordinary configuration and remove their own directory on close or
process exit. This prevents independent servers from sharing mutable
optimized-module storage. Production builds and package admission are
unchanged.

The focused browser regression runs two servers against one project with
different dependency transformations, fetches their modules in fresh browser
contexts, and closes each server independently. Chromium, Firefox and WebKit
pass all three cases in 7.4 seconds. Before the fix, the cache-ownership
assertion fails because both servers select the same directory. The small
fixture does not reproduce the exact React export corruption; the real
application rerun remains necessary. Evidence: `.context/vite-cache-after.log`;
before: `.context/vite-cache-before-native-options.log`.

The first rerun (`frankenphp-cache-isolated-browser-memory-1106-123943-2fad`)
fails before browser launch because the intentionally aborted earlier run
left its Vite process group listening on 5447. Exact process ownership,
creation time, working directory and original job records identify that
orphan; only that owned group is retired. The new full gate,
`frankenphp-cache-and-port-browser-memory-1106-125850-da11`, passes in
19m15s: source boundary 7/7, host ownership 239/239, Node teardown 3/3,
Bun teardown 7/7, and all 18 browser cases with no skips or failures. Each
engine completes four constrained-budget switches among Doom, Quake,
Freeciv, LOVE, tmux and WordPress in the same page/audio realm. No forced
GC, per-cycle fresh context, or reload masks retention. This validates the
current host, cache fix and `389ec37e` cohort; the next Go-pinned demo
rebuild is still pending.
The ordinary rebuilt preview on 5451 passes image size/hash checks and
Chromium/Firefox login/site-editor cases (2/2, 2m48s). Evidence:
`.context/frankenphp-current-preview-ui/`.

### Runtime wait coverage checkpoint — 2026-11-06

The Go target's mutex, scheduler-note, bootstrap-acknowledgment and runtime
sleep waits now share the existing bounded host-checkpoint primitive used
by the syscall channel. Predicate loops and note deadlines remain intact;
finite sleep and bootstrap waits retain their total timeout across bounded
intervals. The change touches three target OS files, not the compiler,
collector or upstream packages. Package recipes still pin `1b0cf580` until
this checkpoint completes validation and is pushed.

A runtime-specific probe fails before the change: a 350 ms sleep leaves a
distinct 50 ms policy sentinel unchanged and exits with a panic. Afterward,
plain-Go and actual linked-cgo variants pass three sleeps each in Node,
updating to the host's unbounded policy without shortening the requested
duration. The private-symbol linker flag applies only to this whitebox
fixture. The full three-engine Go inventory passes 159/159 in 8m08s,
including scheduler, clone handoff, locked-thread retirement, sync and
network deadline coverage. The separate accounting fixture adds three
browser passes. All four standard
library compile gates pass: Kandelo with and without cgo, js and wasip1.
Evidence: `.context/go-wait-before-linked.log`,
`.context/go-wait-after.log`, `.context/go-wait-node-modes.log`, and job
`go-runtime-wait-fixtures-and-stdlib-1106-130517-515c`.

This closes a producer-integration gap; it does not establish that missing
checkpoints caused the WebKit footprint kill. The existing blocked-wait GC
workaround remains suspected, and synchronized native measurements remain
necessary.

### WebKit pool control and observer correction — 2026-11-06

On the published Go-`1b0cf580` image, both one-thread and six-thread Caddy
controls fail with native content-process kills: 19,041 MB and 21,029 MB
against the 16,384 MB threshold. Both complete login/editor and the editor
burst first. Reducing the PHP pool alone does not resolve the failure.
Evidence: job `frankenphp-webkit-aligned-pool-controls-1106-131752-1660`,
`.context/frankenphp-webkit-host-t3x7In/` (one thread), and
`.context/frankenphp-webkit-host-mRYAMq/` (six threads).

The initial read-only native-category observer records only the initial
blank-page target. Real navigation replaces the WebKit inspector target;
keeping the old connection loses subsequent samples. These native samples
are not synchronized workload attribution. A corrected diagnostic observes
existing target-commit events, reattaches read-only tracking and worker
lifecycle listeners, and makes no driver-method or engine change. A real
localhost navigation control passes with four samples on the replacement
target. The corrected workload repetition is running; no native-category
root cause is claimed yet. Diagnostics run under concurrent lifecycle-suite
load and are not performance measurements.

The [protocol category definitions](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/protocol/Memory.json)
and [reference Cocoa collector](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/page/cocoa/ResourceUsageThreadCocoa.mm)
also limit interpretation: the JavaScript heap counters come from the
observed VM, while native allocation buckets use process memory tags.
Do not add these into an asserted complete sum of every worker's GC heap,
RSS or the process-kill footprint. Preserve UTC pairing skew and missing
samples explicitly.

### Synchronized native measurements and next artifact build — 2026-11-06

The corrected repetition (`frankenphp-webkit-navigation-aligned-poo-1106-132205-a9d9`)
finishes with two failures and useful synchronized samples. The one-thread
case records 121 native samples, then a 17,635 MB native kill. At the end
of the editor burst, guest/kernel linear memory is 446,300,160 bytes while
the native `page` allocation bucket is about 14.1 GiB; the main observed
JavaScript category is about 0.47 GiB and JIT about 0.05 GiB. Paired receipt
times differ by at most 0.21s across its four recorded stages. The guest
Caddy process reports seven threads. The inspector's one direct page-worker
counter sees the kernel worker, not its nested guest workers.

Between the one-thread login/editor and editor-burst snapshots, its guest
thread count stays at seven and the module cache stays at six compiles with
zero thread-module compiles. That interval's native allocation growth is
not accompanied by more guest threads or a new cache compilation. In the
six-thread control, Caddy stays at thirteen threads throughout traffic and
the soak; compile count remains six until the intentional process restart.
These observations still do not measure individual instance allocation
sizes or identify the retaining JavaScript objects in worker VMs.

The six-thread case records 351 native samples without a native kill. It
completes editor traffic, 40-request churn, a 90-second soak (182 requests),
intentional Caddy SIGKILL/restart and held PHP draining, but fails the
strict initial homepage assertion (504 instead of 200). It is not a passing
application run. Guest linear memory reaches about 799 MiB, while the
native allocation bucket varies around 8.4–10.6 GiB during the soak.
All recorded stage pairings are within 0.24s. These buckets locate a large
cost outside guest linear memory but do not identify its retaining objects
or prove an engine defect. Evidence: `.context/frankenphp-webkit-host-KWtdRZ/`
and `.context/frankenphp-webkit-host-ONzy4Y/`, each with `aligned-memory.json`.

With the original-cohort measurements retained, validated Go source
`5834adc` is pinned in all four consumers. Revisions become Go sample 26,
standalone Caddy 10, FrankenPHP classic 33, FrankenPHP+Caddy 12 and WordPress
38. The normal serialized cohort build passes as
`frankenphp-go-wait-checkpoint-cohort-1106-132832-55fb`: 184 nodes, 178
cached, six published, 18m24s plus consumer admission. The kernel remains
byte-identical (`bfdf6ce5`, ABI 55). Final artifact validation and comparisons
remain pending; the old preview remains identified as revision 37.
The new target-OS waits pass 159/159 browser cases and four standard-library
builds without compiler or collector edits.

### Revision-39 artifacts and first consumers — 2026-11-06

The two-thread image and common service setting publish normally in
`frankenphp-measured-pool-budget-cohort-1106-143439-3a19`: all 184 nodes and
consumer admission pass in 7m47s (180 cached, four published). The image is
79,417,372 bytes, SHA-256
`b5d9a0326b57ac4f4c808cdbd72e068f9a403682be37f8d4652ae26c7b8de438`.
The kernel remains `bfdf6ce5`, ABI 55, and Go remains `5834adc`.

Both real Node service workflows pass in 44s, now requiring their actual
logs to report two PHP threads, completing PHP draining, normal exits and
cooperative retirement. The new port-5454 preview passes image identity and
Chromium/Firefox login and Appearance Editor checks (2/2, 2m53s).
Its URL/identity is `.context/frankenphp-rev39-admitted-preview-artifacts.json`.
The full three-engine visible UI selection is now running. Evidence:
`frankenphp-rev39-node-services-1106-144615-21b6`,
`.context/frankenphp-node-image-n9CBTl/`,
`frankenphp-rev39-preview-identity-ui-1106-144639-918e`.

The Go sample package, revision 26, independently passes its actual C VFS
launcher in Node and all three browser launch cases (36s), with matching ABI
identity, expected output, empty Node stderr/diagnostics and zero fork count.
Evidence: `go-final-package-entry-rev26-1106-144145-bdfa`,
`.context/go-package-final-B5Ocvc/`. A separate normal cached benchmark
projection also passes all 184 nodes and admission in 3m58s; provisioning
is not a timing comparison.

The updated Node comparison configuration also passes a functional smoke
with fresh parent processes for FPM and Caddy. It requires six configured
FPM children and six PHP threads from the actual Caddy log, preserving both
service logs and rejecting restarts or fatal traces. The report records the
observed PHP thread count. Evidence:
`wordpress-rev39-matched-node-pools-1106-145232-27f3`,
`.context/wordpress-node-pool-smoke-HpLw7M/`. It runs for 25 seconds under
concurrent UI validation and supplies no performance conclusion. Quiet
sustained measurements remain pending.

### Final-artifact memory/lifecycle gate — 2026-11-06

`frankenphp-rev39-final-browser-memory-1106-150118-ba3c` passes in 20m20s
on final WordPress revision 39, kernel `bfdf6ce5`, Go `5834adc`. The normal
command is `./run.sh test browser-memory` in the declared dev shell. All
18 browser cases pass across Chromium, Firefox and WebKit with no retries,
skips or failures. Each engine completes four constrained-budget demo
switches in the same page/audio realm, including Doom, Quake, Freeciv,
LÖVE, tmux and WordPress. The source boundary checks (7), host ownership
checks (239), Node teardown (3), Bun teardown (7), and host declaration
build also pass. No forced GC, reload, replacement context, memory-ceiling
increase or app fallback is used to make the gate pass. The WordPress
switch case uses the ordinary MariaDB/FPM profile; it does not replace the
separate embedded-PHP service and persistence workflows.

### Final-artifact embedded-PHP browser services — 2026-11-06

`frankenphp-rev39-final-browser-services-1106-151849-5524` passes all six
classic/Caddy cases across Chromium, Firefox and WebKit in 4m44s. These use
the admitted revision-39 image and real two-thread startup logs, login and
editor HTTP, OPcache artifacts, forty request-churn iterations, twenty
editor burst rounds, ten concurrent editor requests, held-PHP draining and
cooperative machine retirement. Caddy recovers after intentional guest
SIGKILL. No profiler, forced GC or increased memory ceiling is used.
Evidence: `.context/frankenphp-browser-image-xBUp9o/`.

All eighteen embedded-PHP visible UI cases also pass in the broader
`frankenphp-rev39-full-visible-ui-1106-145144-d0e1` run: both profiles,
all three engines, login/editor health, post writes and genuine home
template saves. That broader batch is not a full pass: its gallery FPM
control returns HTTP 500 when creating a post on WebKit. Inspection shows
the gallery FPM shortcut selects `browser-wordpress-family`, whereas the
embedded-PHP profiles select `browser-wordpress`. The comparison fixture
now uses the exact WordPress image's ordinary FPM profile and captures
guest logs on failure. A same-image control run and a separate diagnostic
of the failing family-image case are pending; changing image selection
does not establish the cause of the earlier HTTP 500.

The original broader UI batch finishes at 25 passed / two failed (39m22s).
Both failures are gallery FPM/WebKit: HTTP 500 on post creation and an
editor canvas that never appears. The latter's failure diagnostic waits
on the missing iframe until the 720-second overall test timeout; the
diagnostic is now bounded to five seconds without weakening the editor
assertion. The separate family-image post diagnostic passes in 47s, so
the HTTP 500 is intermittent and remains unexplained. Two earlier private
diagnostic launches fail before running tests because of duplicate
Playwright packages and then an ESM directory import; the final diagnostic
uses the same app-owned Playwright module and passes. These setup failures
are not guest execution results.

### Final-runtime upstream os inventory — 2026-11-06

`go-final-upstream-os-1106-153022-49e0` passes in 1m27s. With image-backed
`/tmp`, both plain Go and cgo pass 224 top-level tests/examples from the
available upstream `os` inventory (215 tests and nine examples), with the
same 21 existing top-level skips and empty guest stderr/host diagnostics.
The runtime source is `5834adc`; the plain executable and pwd helper match
the recorded 159-case browser-gate hashes, and the cgo executable is newly
built, normally fork-instrumented and ABI-stamped. Evidence and exact
program/kernel hashes: `.context/go-final-upstream-os-sW1b6c/`.
This replaces reliance on the older `29e2118` result for this inventory;
it does not establish full upstream runtime conformance.

### Preview navigation and persistence evidence — 2026-11-06

The exact-image FPM control finishes at eight passed / one failed
(`wordpress-rev39-exact-image-fpm-ui-1106-152616-08b0`, 13m06s).
Its Chromium template case remains on the dashboard after entering the
editor URL, with no editor HTTP request in the navigation record and clean
PHP-FPM/nginx service logs. A focused browser reproduction demonstrates
that a late iframe load overwrites an actively edited dock address. It
fails before the fix with `/destination.html` replaced by `/late.html`,
including with the production autofocus behavior enabled. Two earlier
fixture launches fail at setup (missing React preamble, then an iframe
response missing the dev server's isolation headers); they do not establish
the navigation defect.

The generic preview UI now preserves an active address draft, avoids
stealing focus on a delayed iframe load, and resumes location tracking
after commit. Six focused navigation/commit cases pass across Chromium,
Firefox and WebKit in 4.6s (`preview-address-draft-after-1106-154904-a69a`).
The broader WordPress UI batch must now repeat with application and fixture
sources frozen. The HTTP 500 from the original gallery FPM post case is
not reproduced by one standalone run followed by five fresh WebKit repeats
(all pass, 47s and 3m27s); its cause remains unknown.

The first final-image persistence batch finishes at 11 passed / one failed
in 22m55s (`frankenphp-rev39-final-persistence-1106-152202-238d`). The last
WebKit Caddy/library case loses its page-local composer observation before
the intentional restart. While this test was active, an agent edit to the
imported preview fixture caused Vite to log a page reload at 15:43:57.
This invalidates the run's page-local observation evidence; do not relax
the ownership assertion or call that case a pass. New diagnostics retain
worker records before assertions and main-document lifecycle events outside
the page. Repeat the batch without watched-source edits and retain native
browser stderr. Evidence: `.context/frankenphp-final-persistence-XmH0pJ/`.

### Ten-minute WebKit Caddy traffic — 2026-11-06

The default-two-thread revision-39 Caddy service completes ten minutes of
WordPress HTTP traffic, editor bursts, deliberate guest crash/restart,
held-response draining, cooperative machine retirement and thirty seconds
of observation after destruction. `frankenphp-rev39-webkit-ten-minute-soak-1106-153514-6b8d`
passes in 12m13s. The browser exits normally; no inspector profiler,
forced GC, reload, memory-ceiling increase or replacement context is used.
This host fixture uses the static trap-test page, without Vite's HMR client,
so the separate preview-fixture reload does not invalidate its execution.
Fifty external UTC phase/memory records are retained, with unavailable guest
metrics absent after destruction. All 39 periodic traffic samples report
511 MiB combined kernel/guest linear memory and eight Caddy guest threads;
the last periodic count is 1,127 successful requests. These snapshots do not
measure the engine's native footprint. This establishes the bounded workload,
not an indefinite native-memory plateau. Evidence:
`.context/frankenphp-final-webkit-soak-lRA5Zy/`.

The same-image RSS harness also completes four Node/Chromium stack runs
with fifteen-second traffic intervals in 3m52s
(`wordpress-rev39-rss-harness-smoke-1106-152840-5575`). Both native sampling
paths return actual values, and service/startup/log checks pass. It ran
under concurrent functional testing and supports no latency or throughput
comparison. Raw evidence: `.context/wordpress-current-stack-I65rGh/`.

### Frozen-source UI and persistence rerun — 2026-11-06

`frankenphp-rev39-frozen-full-ui-1106-155216-eeed` passes all 27 cases in
30m44s: classic, real Caddy and the same image's FPM control, in Chromium,
Firefox and WebKit. Each covers demo login, Appearance Editor/canvas and
health, authenticated post writes and genuine template saves. Evidence:
`.context/frankenphp-final-visible-ui-FVHCWF/`.

The companion strict persistence command finishes at ten passed / two
failed in 21m15s. All Chromium and WebKit cases pass, including the last
WebKit/library case invalidated by HMR in the prior run. Both Firefox
experimental cases fail while the site-editor welcome dialog remains open:
the save helper requires a heading already to be contenteditable before
the actionability handler can dismiss the dialog. Selecting the actual
heading block instead preserves all template-entity/save assertions and
passes both failed workflows in 4m21s
(`frankenphp-rev39-firefox-template-persis-1106-162454-efc9`). These are
scoped reruns, not a single twelve-case passing command. Evidence:
`.context/frankenphp-final-persistence-FbjIIS/` and
`.context/frankenphp-firefox-template-persistence/`.

Firefox diagnostics also record canceled requests and editor image-policy
warnings. A standalone controlled-srcdoc/synthetic-PNG test passes Chromium
153, Firefox 155 and WebKit 26.6, so it does not reproduce an engine defect.
The first standalone launch omits the repository's existing macOS Firefox
home workaround and fails before that browser starts; the configured run
uses the normal project launch options. A live Caddy/Firefox probe creates
a real media attachment and valid Gutenberg image block: both the actual
editor image and a separate canvas-context Image decode to 2x2, and direct
HTTP returns the same 105-byte PNG with normal same-origin policy headers.
No service-worker/header or dependency patch is made. Two earlier probes
time out looking for an image element and do not establish a policy cause.
Evidence: `.context/srcdoc-corp-configured-probe.log`,
`.context/wordpress-canvas-image-9TgwdB/`. The persistence fixture now writes
a valid image block and requires its real editor image to finish decoding
before navigation; that stronger gate remains under validation.

### Production frontend artifact — 2026-11-06

The documented authenticated asset-group and production Vite build pass in
27s (`frankenphp-final-production-browser-1106-162751-078c`), using the
already normally published/admitted default cohort. The complete output,
including signalling, is `.context/frankenphp-final-browser-build-6wEXQO/site`;
the private product map is absent from it. Public HTTP checks on port 5455
verify the exact 79,417,372-byte WordPress image `b5d9a032` and the
27,926-byte group manifest with SHA-256
`15aee1bdd4be03e8548ec853de54769272171d744a5dc9c5d0e25a73d8e12496`.
This is a local static preview, with no HMR and no hosted publication.
Its browser UI verification remains pending. URLs/identities:
`.context/frankenphp-production-preview-artifacts.json`. The verified
development preview on 5454 remains available while the production UI and
stronger persistence selections run. The same production image supplies
both embedded-PHP profiles and the FPM control.

### Standalone Caddy and byte ownership review — 2026-11-06

Standalone Caddy revision 10 passes its real static HTTP response on Node
and all three browser engines (3/3, 26s total) with the final Go pin.
The program resolves normally from the admitted 184-node projection, with
the same ABI-55 kernel. Node records no host diagnostics or Go panic.
Evidence: `final-standalone-caddy-1106-151503-e0d4`,
`.context/caddy-final-r6eHaF/`.

The host ownership review identifies a further concrete allocation lead:
both Node and browser clone initialization send the full program bytes as
well as the shared compiled module. For FrankenPHP+Caddy that is roughly
206 MB per cloned thread before engine allocations. Thread initialization
currently uses those bytes for reflection, typed owner-import routing,
fork-template identity, and legacy channel TLS detection. A future generic
metadata handoff could remove the redundant byte copies while preserving
those checks. No such change is made or measured here; this source finding
does not quantify its share of the native bucket or establish a leak.

### Final admitted module inventory — 2026-11-06

A read-only structural scan of the normally resolved FrankenPHP+Caddy
package finds 206,036,641 bytes, SHA-256
`57b55a90bce97096b46849de48053f921b3c91a8aff8eda9b121cbda0e27c105`.
It declares 188,168 functions, 61 import entries, six local tables, 3,761
globals and 100,000 data segments. Its 676 exports comprise only 38
functions, 633 globals and five tables; the large function count must not
be mistaken for that many exported JavaScript wrappers. These are binary
structure counts, not native allocation measurements or proof about which
references the engine retains per instance. No compiler, table layout,
export policy or collector change follows from this scan. Evidence:
`.context/frankenphp-final-wasm-shape.json`.

### Measured service budget and common pool setting — 2026-11-06

The revision-38 six-thread WebKit repetition still hits a native kill at
16,821 MB. The one-thread repetition completes all workload/recovery/drain
steps but initially fails a remaining fixture assertion hardcoded to six.
That assertion now checks the requested size; the rerun passes in 3m48s,
including 200 soak requests, cooperative destruction and the post-destroy
window. Evidence: `frankenphp-rev38-single-pool-confirm-1106-141433-583a`,
`.context/frankenphp-webkit-host-aOxbq6/`. Its native allocation bucket peaks
at 5.37 GiB, stays near 5 GiB during traffic and reaches about 0.25 GiB after
destruction. The prior failed assertion and six-thread kill remain failures.

A two-thread control also passes in 3m15s: 198 soak requests, full editor
traffic, intentional restart, draining and cooperative retirement. Its
native bucket peaks at 10.61 GiB, settles near 5.6 GiB during the soak and
falls to about 0.28 GiB after destruction. This is a measured bounded run,
not evidence of indefinite stability. Evidence:
`frankenphp-rev38-two-pool-budget-control-1106-142646-5c4b`,
`.context/frankenphp-webkit-host-8u5hSE/`.

The unchanged binary's static-response controls isolate costs before PHP
requests: without initializing PHP, Caddy has three guest threads, 365 MiB
of combined guest/kernel linear memory and about 3.1 GiB in the native
allocation bucket after idle. With six initialized but idle PHP threads,
it has thirteen guest threads, 412 MiB linear memory and about 8.2 GiB in
that bucket. Both serve 100 static requests, idle thirty seconds and
cooperatively stop; their native buckets fall to 0.28/0.24 GiB thirty
seconds later. This locates substantial cost in the instantiated runtime
and pool before WordPress requests, without identifying individual
retaining objects or blaming an engine defect. Evidence:
`frankenphp-static-vs-idle-php-memory-1106-142012-4275`,
`.context/frankenphp-static-pool-0-X3ylDP/`,
`.context/frankenphp-static-pool-6-NRUOut/`.

The compiled Caddy artifact has only two Wasm atomic-wait functions: the C
channel implementation and Go's shared wait intrinsic. The Go intrinsic has
one direct caller, the new bounded step. No extra generated fork wait is
found. The offline parser reports 188,221 functions. Its first two tool
build attempts fail (incompatible reused Rust dependency artifact, then a
parser API mismatch); the standalone Cargo build and audit subsequently
complete. Evidence: `.context/frankenphp-rev38-wasm-waits-cargo-fixed.log`.

WordPress revision 39 now selects two PHP threads for both embedded
services, with the standard Caddy environment substitution consuming the
same dinit setting as the classic wrapper. This is explicit service sizing;
the six-thread WebKit failure remains a documented limit. It also matches
[FrankenPHP 1.11's guidance](https://github.com/php/frankenphp/blob/v1.11.0/docs/performance.md#number-of-threads-and-workers)
to size the pool for CPU and memory; the guest Go scheduler has one P.
The Node comparison explicitly configures both FPM and FrankenPHP to six
workers, while browser comparisons retain shipped defaults (one/two).
No compiler, dependency or guest-API patch is made for this budget.

The new default and shared environment setting still require normal image
publication and final artifact validation. The live revision-38 preview
remains on 5453 until its replacement is verified.

### Revision-38 preview and shutdown observation — 2026-11-06

The normal `./run.sh browser` on port 5452 is still preparing its default
projection through the debug xtask, observed at 99% CPU after seven minutes.
The separate benchmark projection has already passed all 184 cached nodes
and consumer admission in 4m27s. Serving that complete projection through
standard Vite and the unchanged SourceOnly plugin on 5453 lets app checks
proceed without bypassing build, identity or admission checks. Both roots
contain image `b120951e` and kernel `bfdf6ce5`. The new preview passes the
actual Chromium/Firefox homepage, demo login and site-editor cases.

The browser-host fixture can now keep its page alive after destruction with
`KANDELO_FRANKENPHP_POST_DESTROY_SECONDS` (0–120; default 0; requires memory
diagnostics). All diagnostic phases retain UTC timestamps, including phases
without a live guest snapshot. A real revision-38 classic Chromium workflow
passes in 26s and records 10.005s between destruction and its final stage.
Those records have no guest-memory value; the alignment parser reports
unknown guest metrics as null rather than zero. The diagnostic changes do
not force GC, reload, change production configuration or relax HTTP checks.
Evidence: `frankenphp-rev38-postdestroy-observation-1106-140000-a72a` and
`.context/frankenphp-postdestroy-control-SgdQEB/`.

Matched one/six-thread WebKit controls with 90-second traffic and a
30-second post-destroy window are running on the revision-38 projection as
`frankenphp-rev38-webkit-pool-memory-1106-140211-e92b`. Their results are not
yet known. The full visible UI, persistence, final lifecycle repetitions,
sustained comparisons and nine-suite timings remain release work.

### Wait checkpoint: signals, callbacks and retirement — 2026-11-06

Additional regressions pass on Go `5834adc`: three Node callback cases and
nine callback browser cases (Go-owned M, foreign-pthread stack growth and
concurrent Go/C allocation churn), followed by ten Node signal modes,
two Node cooperative-retirement cases and 57 signal/retirement browser
cases. The browser cases include HTTP draining, cgo restart, collection
during interrupted reads, selected upstream signal tests, fatal defaults,
bounded blocked waits and cooperative shutdown on all three engines.
These fixtures use the unchanged ABI-55 kernel; they are distinct from
validation of the still-building WordPress revision-38 package artifacts.
Evidence: `go-waits-callback-regression-1106-132941-ddfc` (41s),
`go-waits-signals-and-retirement-1106-133003-f8d5` (2m52s), and
`.context/go-waits-validation-evidence.json`.

### Allocation, scavenging and reuse — 2026-11-06

The new real-cgo memory-accounting fixture passes Node and all three
browsers (3/3 browser cases, 13.1s). It touches 32 MiB allocated by C,
repeats four 64 MiB Go allocations with a soft 32 MiB Go limit, invokes
Go's ordinary collection/scavenging API between rounds, and reports a
direct C Wasm-memory size beside Go counters. Dead Go objects collect and
the repeated allocations reuse bounded linear memory.

In Node, linear memory rises from 42,991,616 bytes initially to 76,873,728
with C memory live, then 148,176,896 with the first Go allocation. It stays
at that size through every collection, reuse and C free. After the final
Go collection, HeapReleased is 70,533,120 bytes and Sys minus HeapReleased
is 20,168,704 bytes; neither figure means physical backing was discarded.
The current no-op target scavenging hook is unchanged. This establishes
accounting and reuse behavior, not RSS or whole-service budget enforcement.
Evidence: `.context/go-memory-accounting-node.log` and
`.context/go-memory-accounting-browser.log`.

The fixture's first browser-build attempt rejects an absolute Go package
directory in GOPATH mode before publication. Running from the fixture's
directory fixes that build error; the normal fixture builder then passes.
No production toolchain change is made for this test.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** A Go `hello world` built with a forked `gc` toolchain for
`GOOS=kandelo GOARCH=wasm` instantiates in a Kandelo process worker and
prints to stdout over the native channel-syscall ABI, exiting 0
(single-threaded, `GOMAXPROCS=1`).

**Architecture:** Fork the upstream Go `gc` toolchain, reuse the
`GOARCH=wasm` code generator unchanged, register a new `kandelo` OS,
add a minimal Kandelo runtime OS layer plus a minimal channel-syscall
backend, and modify `cmd/link` to emit an *admissible* module (imported
+ shared memory and the `__abi_version` marker). No threads, no
networking, no exec in this milestone.

**Tech Stack:** Go `gc` toolchain (pin `go1.25.6`), Go runtime/linker
internals (`runtime/`, `cmd/link/internal/wasm`, `cmd/internal/obj/wasm`,
`internal/syslist`, `cmd/dist`, `internal/platform`), Kandelo host
(`host/src/worker-main.ts`, `wasi-detect.ts`, kernel channel ABI in
`libc/glue/channel_syscall.c` and `crates/shared/src/lib.rs`), Node 24
under `scripts/dev-shell.sh`.

**Design reference:** `docs/plans/2026-09-05-go-gc-port-design.md`
(especially "Port strategy", "Syscall backend", "ABI marker and memory
model at link time", and the 2026-09-05 feasibility-gate result).

---

## Reader orientation (assume no Kandelo or Go-internals context)

- **Kandelo runs each process as a Wasm instance in a Web Worker.** It
  talks to a kernel (in its own worker) over a SharedArrayBuffer
  "channel": the program writes a syscall number + args into a shared
  memory region, signals the kernel with Wasm atomics, and blocks until
  the kernel writes the result back. There are **no Wasm imports** for
  syscalls. See `libc/glue/channel_syscall.c` for the C reference
  implementation of this handshake.
- **The host refuses inadmissible modules early.** A program module
  must (a) provide the memory as an *import* so the shared channel lives
  in the program's address space, and (b) carry an `__abi_version`
  marker matching the kernel (ABI 43). Stock Go output satisfies
  neither (feasibility gate, 2026-09-05).
- **Go's toolchain is self-contained.** It has its own compiler,
  assembler, and linker (`cmd/link`), and its own runtime; it does not
  use clang, musl, or `wasm-ld`. Adding an OS means adding Go source
  files named `*_kandelo.go` / `*_kandelo_wasm.go` and rebuilding the
  toolchain with `make.bash`.
- **The one thing we do NOT touch:** the `GOARCH=wasm` code generator
  (`cmd/compile/internal/wasm`, `cmd/internal/obj/wasm`) is
  OS-independent and already implements Asyncify-free goroutine
  switching. Reuse it unchanged except for the atomic-op addition in
  Task 6 if we take the pure-guest handshake route.

---

## Decisions (confirmed 2026-09-07)

1. **Where the Go fork lives.** A fork repo will be created on GitHub
   under the `kandelo-dev/` org. For milestone-1 prototyping, start
   from a local upstream clone at `../go-kandelo` (outside the Kandelo
   repo) and push it to the `kandelo-dev/` fork once that repo exists;
   productionize the committed pinning contract (patch series against a
   pinned source, mirroring `libc/musl`) after milestone 1 lands. Do
   NOT commit a multi-MB Go tree into the Kandelo repo.
2. **Channel handshake mechanism (Task 6).** Attempt Option 1 (pure-
   guest atomic handshake; preserves the zero-import contract; needs a
   wasm backend atomic-op addition). If the backend work balloons, land
   Option 2 (a minimal temporary host import) behind an explicit,
   documented temporary boundary and file the follow-up. Option 2 is
   ABI-visible and requires an ABI review.
3. **Pinned Go version: `go1.25.6`.** This is the version the design's
   file/line hook points were verified against, so pinning to it keeps
   this plan accurate. (Note: as of 2026-09-07 a newer stable Go may
   exist; the assistant's knowledge cutoff predates confirming that.
   The installed toolchain is `go1.25.6`.) Rebase the fork forward to
   the latest stable once milestone 1 works, re-verifying hook points
   at that time.

---

## Prerequisites / environment

- A bootstrap Go to build the fork. `go1.25.6` is installed
  (`/opt/homebrew/Cellar/go/1.25.6/libexec`). `make.bash` bootstraps
  from an existing Go.
- Kandelo provisioning for the end-to-end run (Task 8): a built
  `kernel.wasm` and `npm install`. Build these under
  `scripts/dev-shell.sh` (`./run.sh setup` builds musl + kernel). Do
  this once, before Task 8, not earlier.
- Wasm inspection tooling: `wasm-tools` and/or `wasm-objdump` (check
  availability in the dev shell; the feasibility gate used them).

---

## Task 1: Vendor and build an unmodified Go fork (baseline)

Establish that we can build the toolchain at all before changing it.

**Files:**
- Create: the Go fork tree at the location chosen in Decision 1 (e.g.
  `../go-kandelo`), checked out at the pinned tag.

**Step 1:** Clone/checkout the pinned Go source (Decision 3) to the
chosen location. Record the exact commit/tag in this plan file.

**Step 2:** Build the toolchain:
`cd ../go-kandelo/src && GOROOT_BOOTSTRAP=$(go env GOROOT) ./make.bash`
Expected: builds `../go-kandelo/bin/go` with no errors.

**Step 3:** Sanity-check an existing target builds and runs a hello
world for the host platform:
`../go-kandelo/bin/go run .context/go-gate/hello.go`
Expected: prints the hello line, exit 0.

**Step 4:** Confirm the stock `wasip1` target still builds (we will
mirror it):
`GOOS=wasip1 GOARCH=wasm ../go-kandelo/bin/go build -o /tmp/w.wasm .context/go-gate/hello.go`
Expected: succeeds; `/tmp/w.wasm` exists.

**Step 5:** No commit to the Kandelo repo yet (the fork is external).
Record the baseline commit hash of the fork in this plan.

---

## Task 2: Register `GOOS=kandelo` (deterministic)

Exact hook points, verified against go1.25.6. This task makes
`GOOS=kandelo GOARCH=wasm` a recognized target that the toolchain will
attempt to build (it will fail to link until later tasks — that is
expected).

**Files (in the Go fork):**
- Modify: `src/internal/syslist/syslist.go` — add `"kandelo": true` to
  `KnownOS` (near the `"wasip1": true` entry). Decide `UnixOS`
  membership: add `"kandelo": true` to `UnixOS` **only** if we intend
  `//go:build unix` stdlib files to apply; default to adding it, but
  audit fallout in Task 3.
- Modify: `src/cmd/dist/build.go` — add `"kandelo"` to the `okgoos`
  slice.
- Modify: the generator that produces `src/internal/platform/zosarch.go`
  (do NOT hand-edit the generated file). Add the `{"kandelo","wasm"}`
  `OSArch` pair and a `distInfo` entry (empty literal → `CgoSupported`
  stays `false`, which is correct). Regenerate, then confirm the
  generated `zosarch.go` contains `{"kandelo", "wasm"}: {}`.

**Step 1:** Make the three edits above.

**Step 2:** Rebuild the toolchain: `cd src && ./make.bash`. Expected:
builds without complaint about an unknown GOOS.

**Step 3:** Verify recognition:
`GOOS=kandelo GOARCH=wasm ../bin/go env GOOS GOARCH`
Expected: prints `kandelo` and `wasm`.

**Step 4:** Confirm cgo is reported unsupported (sanity):
a small `go/build` or `internal/platform` check, or observe that
`CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm ../bin/go build` refuses cgo.
Expected: cgo not supported.

**Step 5:** Commit in the fork:
`git commit -am "kandelo: register GOOS=kandelo for GOARCH=wasm"`.

**Note:** After this task, `GOOS=kandelo GOARCH=wasm go build` of a
trivial program will fail — expected, because there are no
`runtime/*_kandelo.go` files yet. That failure mode is the entry point
to Task 3.

---

## Task 3: Minimal runtime OS layer that compiles

Create the `kandelo` runtime files mirroring the `wasip1` set, with the
syscall backend **stubbed** so the runtime compiles and links far
enough to reveal the next real gap. Do not implement real syscalls yet.

**Files (in the Go fork), mirroring the `*_wasip1.go` set:**
- Create: `src/runtime/os_kandelo.go` (mirror `os_wasip1.go`:
  `osinit` support, `walltime`/`nanotime1`, `readRandom`, `exit`,
  `write1`/`fd_write` equivalent — stubbed to `throw` or trap for now).
- Create: `src/runtime/lock_kandelo.go` (mirror `lock_wasip1.go`:
  `notetsleepg` cooperative version; keep single-M assumptions for this
  milestone).
- Create: `src/runtime/mem_kandelo.go` (mirror `mem_wasip1.go`; likely
  just `resetMemoryDataView()` no-op — memory OS hooks come from the
  shared `mem_sbrk.go`, which already builds for `wasm`).
- Create: `src/runtime/rt0_kandelo_wasm.s` (mirror
  `rt0_wasip1_wasm.s`).
- Audit/possibly create: `src/syscall/*_kandelo.go` counterparts of
  `syscall_wasip1.go`, `fs_wasip1.go`, `net_wasip1.go`,
  `os_wasip1.go`, `tables_wasip1.go`. For this milestone, provide the
  minimum that compiles; real bodies land in Task 6 and later
  milestones.

**Step 1:** Copy each `wasip1` file to its `kandelo` name, switch the
build constraint to `kandelo`, and replace the WASI-import syscall
bodies with clearly-marked `throw("kandelo: syscall not yet
implemented")` stubs (except the ones Task 6 will implement).

**Step 2:** Iteratively build and fix compile errors:
`GOOS=kandelo GOARCH=wasm ../bin/go build -o /tmp/k.wasm .context/go-gate/hello.go`
Work the error list down until it either links or fails **only** in the
linker (Task 4/5) rather than the compiler. Record which files the
`unix` build tag pulled in (Decision on `UnixOS`) and whether any are
inappropriate for wasm; narrow `UnixOS` if needed.

**Step 3:** Expected end state for this task: compilation of the Go
program and runtime succeeds; the failure (if any) is now in linking or
at runtime (a syscall stub `throw`), not a missing-OS compile error.

**Step 4:** Commit in the fork:
`git commit -am "kandelo: minimal runtime OS layer (stubbed syscalls)"`.

---

## Task 4: `cmd/link` — imported + shared memory and `__abi_version` (the internal gate)

**This is the highest-uncertainty task and the internal gate for the
milestone.** We do not yet know the exact diffs; this is a spike
followed by implementation. Be honest in the writeup: record findings
before writing code.

**Files (in the Go fork):**
- Investigate then modify: `src/cmd/link/internal/wasm/asm.go` (and
  neighbors in `cmd/link/internal/wasm/`). This is where the Wasm
  module's memory section, imports/exports, and custom sections are
  emitted.

**Step 1 (spike):** Read `cmd/link/internal/wasm/asm.go` and map
exactly where it (a) emits the memory section and its `memory` export,
(b) emits imports, (c) emits globals/exports, (d) could emit a custom
section. Write findings (functions + line ranges) into this plan file
before editing. Cross-reference how Kandelo expects memory to be
imported (module/field name, shared flag, min/max) — see how existing
Kandelo programs are linked (`docs/sdk-guide.md` `--import-memory
--shared-memory --max-memory`, and `host/src/worker-main.ts` /
`wasi-detect.ts` `wasiModuleImportsMemory` for the exact import name the
host looks for, e.g. `env.memory`).

**Pinned native-program admission contract (2026-09-07 spike, with
`host/src` + `libc/glue` evidence).** For the host to instantiate and
accept a native (non-WASI) program:

- **Import `env.memory`** — memory, `shared`, max `16384` pages (1 GiB;
  64 KiB pages). The host creates the shared `WebAssembly.Memory`
  (`host/src/process-memory.ts:314-318`, max 16384) and supplies it as
  `env.memory` (`host/src/worker-main.ts:2358`); the module's declared
  `min` is honored as a floor (`process-memory.ts:123-181`). This
  replaces Go's default defined+exported memory.
- **Export `__abi_version`** as a **function `() -> i32` whose body
  reduces to `i32.const 43`** (value = `crates/shared/src/lib.rs`
  `ABI_VERSION`). The host **byte-parses an exported FUNCTION** named
  `__abi_version` and follows at most one `call` wrapper
  (`host/src/constants.ts:2767-2938`, `worker-main.ts:3145-3176`); it
  never calls the export. A **global** named `__abi_version` does NOT
  satisfy the parser. Mismatch hard-fails; absence only warns.
- **Export `_start`** (reactor entry; already emitted by Go). Both are
  the required executable exports (`host/src/binary-resolver.ts:49`).
- The native path **does not stub imports**: any import the host cannot
  resolve (`wasi_snapshot_preview1.*`, unexpected `env.<fn>`, unknown
  `kernel.*`) is a hard `LinkError` (`worker-main.ts:2314-2333`). Our
  Task-3 stubs import nothing; Task 4 must not introduce stray imports.
- **Omit** the `kandelo.abi.contract` custom section — warn-only when
  missing, but a present-but-wrong digest hard-fails.

To *function* (Task 6, not needed for admission) the module must also
import `env.__channel_base` (mutable `i32` global; every syscall reads
it) and `kernel.kernel_exit` (`(i32)->()`). Neither is required merely
to instantiate/admit, so Task 4 does not add them.

**Task-6 wrinkle surfaced here:** `env.__channel_base` is an *imported
Wasm global*. Go has no mechanism to import a wasm global into runtime
code (`//go:wasmimport` covers functions only). Task 6 must add a
linker/runtime path to read it (emit the global import + a runtime
intrinsic) or obtain the channel base another way (e.g. a kernel
function import). Decide within Task 6.

**Step 2:** Implement: change the linker to **import** memory (`env`/
`memory`, `shared`, `max=16384`) instead of defining+exporting it, for
`GOOS=kandelo`. Guard the change so other targets are unaffected.

**Step 3:** Implement: emit the `__abi_version` marker the host checks.
Confirm the exact form the host requires (an exported global? a custom
section? both?) by reading the host admission path
(`host/src/worker-main.ts` and the ABI constants in
`crates/shared/src/lib.rs` / generated TS). Match that form exactly for
ABI 43. Record the required form in this plan.

**Step 4:** Rebuild toolchain (`./make.bash`) and relink the hello
world:
`GOOS=kandelo GOARCH=wasm ../bin/go build -o /tmp/k.wasm .context/go-gate/hello.go`

**Step 5 (verify the module shape):** Inspect `/tmp/k.wasm`:
- `wasm-tools print /tmp/k.wasm | grep -E "import|memory|__abi_version"`
- Expected: memory is **imported** (not exported), marked shared with a
  max; the `__abi_version` marker is present in the form the host
  requires. Compare against a known-good Kandelo C program's module
  shape.

**Step 6:** Commit in the fork:
`git commit -am "kandelo/link: import shared memory and emit __abi_version"`.

---

## Task 5: Host admits the module (host-side test)

Prove the module now passes Kandelo's pre-instantiation guard — the
exact check that rejected stock Go in the feasibility gate.

**Files (in the Kandelo repo):**
- Test: add a focused check, ideally reusing `host/test/` helpers
  (`host/test/wasi-shim.test.ts`, `host/test/centralized-test-helper.ts`),
  or a small script under `.context/` that imports the real
  `wasi-detect`/`worker-main` guard logic.

**Step 1 (write the failing check):** Point the guard/admission logic
at the pre-Task-4 module (or assert on the message) to confirm the
guard still rejects an exported-memory module — establishing the test
detects the condition.

**Step 2:** Run it. Expected: it reports rejection for the old shape
(the `worker-main.ts:3208-3214` throw / memory-import check).

**Step 3:** Point it at `/tmp/k.wasm` (Task 4 output). Expected: the
memory-model guard **passes** (module imports memory). Note: it may now
fail *later* (missing/incorrect `__abi_version`, or at first syscall) —
that is progress, and tells us the next gap.

**Step 4:** Iterate Task 4 ↔ Task 5 until the module clears the memory
guard and the `__abi_version` admission check.

**Step 5:** Commit the host-side test in the Kandelo repo:
`Test: admit a Kandelo-linked Go module past the memory/ABI guard`.

---

## Task 6: Minimal channel-syscall backend (`write`, `exit`, `clock`, `random`)

Implement the real channel handshake for the few syscalls a hello world
needs.

### Pinned channel protocol (2026-09-07 spike, `crates/shared/src/lib.rs` `mod channel` + `libc/glue/channel_syscall.c`)

Per-instance channel region layout:

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | `status` (u32) — the **atomic** slot |
| 4 | 4 | `syscall_number` |
| 8 | 48 | `args[6]`, each i64 (args are i64 even on wasm32) |
| 56 | 8 | `return_value` (i64) |
| 64 | 4 | `errno_value` (i32) |
| 68 | 4 | `request_flags` (u32; 0 for plain syscalls) |
| 72 | 65536 | `data_buffer` |

`ChannelStatus`: `Idle=0, Pending=1, Complete=2, Error=3`. Handshake
(`__do_syscall_impl`, `channel_syscall.c:843-920`): plain-store
number+args; `atomic.store` PENDING on `status`; `memory.atomic.notify`
(count 1); `memory.atomic.wait32` (expected PENDING, timeout -1); read
`return_value`/`errno_value`; `atomic.store` IDLE. Return to musl form
`err ? -err : result`.

Syscall numbers are **Kandelo's own, not Linux**: `write=4`,
`exit=34` (routed to the `kernel.kernel_exit` function import, not the
channel), `clock_gettime=40`, `getrandom=120`.

The three required atomic ops on `status`: `i32.atomic.store`
(`0xFE 0x17`), `memory.atomic.notify` (`0xFE 0x00`),
`memory.atomic.wait32` (`0xFE 0x01`) — all require a **shared** memory
(Task 4 imports one) and the wasm threads/atomics feature.

### Decision record: Option 1 vs Option 2 (revisit if Option 1 stalls)

Two ways to perform the handshake. **We are pursuing Option 1**; Option
2 is the documented fallback.

**Option 1 — pure-guest atomics (preserves the zero-import native
contract; chosen).** The Go runtime performs the handshake itself.
Requires:
- Adding the three `0xFE` atomic opcodes to Go's wasm assembler
  (`src/cmd/internal/obj/wasm/a.out.go` opcode enum + `anames.go` + a
  new `0xFE`-prefix branch in `writeOpcode`, `wasmobj.go:1418-1438`,
  with memarg encoding: align = log2(access size) = 2 for wait32/notify
  on i32). Go's wasm backend has **no** atomic opcodes today
  (`internal/runtime/atomic/atomic_wasm.go` is all plain access), so
  this is new capability, not a toggle.
- A runtime helper (hand-written `.s`, or an SSA intrinsic) that emits
  those ops for the `status` slot.
- Solving `__channel_base`: it is an imported wasm **global**, and Go
  cannot import a global. Path with no host change: synthesize a
  `__tls_base` export so the host's `setupChannelBase`
  (`host/src/worker-main.ts:4694-4733`) writes `channelOffset` into
  linear memory (at `__tls_base + 0` when `__get_channel_base_addr`
  detection fails), and read it from there in the runtime. (Go does not
  use the clang `__tls_base` TLS model, so this needs linker synthesis.)
- Ensuring the module validates with the atomics feature enabled (the
  memory is already shared from Task 4; confirm the threads feature /
  `target_features` is acceptable to the host).
- Pros: no host change, no ABI bump, Go stays structurally identical to
  C programs (zero syscall imports), and the atomic-opcode work is
  **needed anyway** for the threads milestone (milestone 3).
- Cons: unproven; touches the wasm backend and linker; the
  `__channel_base` acquisition is fiddly for Go.

**Option 2 — host function import (fallback).** Add a general host
import `kernel_channel_syscall(n, a1..a6) -> i64` implemented like the
existing `kernel_clone`/`kernel_exit` (`worker-main.ts:480-559`), which
do the write+`Atomics.store/notify/wait`+read entirely in JS, closing
over `channelOffset`. Go declares `//go:wasmimport kernel
kernel_channel_syscall` and calls it.
- Pros: zero assembler work, zero guest atomics, no `__channel_base`
  needed; reuses a proven, tested host pattern; Go-native mechanism.
- Cons: a host-runtime change (Node **and** browser), an **ABI bump
  (43->44)** + regenerated snapshot, and Go programs carry a
  `kernel.kernel_channel_syscall` import that C programs don't (a
  documented divergence from the zero-import native contract). The
  import is a *general* syscall-submit primitive, so it is an honest
  platform capability, not program-specific behavior.

**Chosen:** Option 1 (2026-09-07), to preserve the zero-import contract
and because the atomic-opcode work is required for milestone 3 anyway.
Fall back to Option 2 if the backend/`__channel_base` work stalls.

### Steps

**Step 1:** Add the three atomic opcodes to the wasm assembler and a
runtime helper that emits them; write a tiny test that assembles a
function using them and confirm `wasm-tools validate` accepts the
module (with the atomics feature).

**Step 2:** Implement `__channel_base` acquisition for Go (synthesize
`__tls_base` export; verify the host's `setupChannelBase` writes the
offset where the runtime reads it).

**Step 3:** Implement the handshake helper in the runtime (marshal
number + args, atomics on `status`, read result/errno) and wire
`write` (4), `clock_gettime` (40), `getrandom` (120) through it; route
`exit` (34) to the `kernel.kernel_exit` import.

**Step 4:** Rebuild toolchain; rebuild hello world; verify shape.
Full end-to-end run is Task 8 (needs kernel provisioning).

**Step 5:** Commit in the fork.

**Note:** this is exploratory — the goal is to make real progress on
Option 1 and learn where it resists. Record findings (esp. the
`__channel_base` mechanism that actually works and the atomics-feature
validation result) back into this file.

### Progress log

**2026-09-07 — Step 1 (atomic opcodes) done (fork `7dff620`).** Added
`AMemoryAtomicNotify` (`0xFE 00`), `AMemoryAtomicWait32` (`0xFE 01`),
`AI32AtomicStore` (`0xFE 17`) to `cmd/internal/obj/wasm/a.out.go` +
`anames.go`, and a `0xFE`-prefix branch in `wasmobj.go` `writeOpcode`
with memarg encoding (align=2 for i32). Emitted via a hand-written `.s`
helper; module `wasm-tools validate`s by default (threads is default-on
in wasm-tools; only fails with `-threads`, and then at the *shared
memory* decl, not the atomic ops). `wasip1`/`js` unaffected; `go test
cmd/internal/obj/wasm` passes.
- **`target_features` finding:** NOT needed for validation or engine
  execution (engines gate on the memory being shared + host enabling
  threads/SharedArrayBuffer). Go's linker doesn't emit one. Add a
  `writeTargetFeaturesSec` only if a downstream Kandelo pipeline tool
  consumes it — not required for milestone 1.

**Discovered blocker (prerequisite, affects Task 7):** the
`GOOS=kandelo` port's `runtime.main` does not reach `main.main` — a
trivial kandelo program keeps `runtime.main` but DCEs the user `main`
package (it survives under `GOOS=js`). So no kandelo program's `main`
runs today, independent of syscalls. Must be fixed before any
end-to-end run. Likely a linker DCE-root / entry-wiring difference for
the new GOOS (compare against how `js`/`wasip1` keep `main.main`).

**Revised next steps for Option 1:** (A) fix `runtime.main -> main.main`
[prerequisite, Task 7/Task 3]; (B) `__channel_base` acquisition for Go
(synthesize `__tls_base` export; host `setupChannelBase` writes the
offset; read it in the runtime); (C) handshake helper using the atomic
opcodes + wire `write`/`clock_gettime`/`getrandom`, route `exit` to
`kernel.kernel_exit`; (D) Task 8 end-to-end (needs `./run.sh setup`).

**2026-09-07 — MILESTONE 1 COMPLETE (Option 1, fork `7ac5bb3`).** A Go
`println("hello, kandelo")` built with `GOOS=kandelo GOARCH=wasm` runs
through the real `CentralizedKernelWorker` and prints, exit 0.
Independently reproduced via a vitest smoke test
(`runCentralizedProgram({programPath:"/tmp/k.wasm", useDefaultRootfs:
false})`): `exitCode: 0`, `stderr: "hello, kandelo\n"` (`println` writes
fd 2). Every stage passed: instantiation (imports `env.memory` shared +
`kernel.kernel_exit`; `__abi_version`=43 matched), channel-base via
`__tls_base` (host wrote the offset into `runtime.kandeloChannelBase` at
0xDB2B8), `write`=4 through the atomic handshake, `clock_gettime`=40 +
`getrandom`=120 during init, clean `kernel_exit`. Option 1 (pure-guest
atomics, zero-import contract preserved) validated end-to-end; Option 2
not needed. Prereqs built: `libc/musl` submodule init'd, `kernel.wasm`
(ABI 43), `npm ci`. (`./run.sh setup` full rootfs is NOT required for a
bare program; its failure was a transient upstream 502 fetching the
`make` package.)

**LATENT RISK — channel-region placement (fix before heavier programs).**
The host pins the channel region at a fixed 16 MiB (Go exports no
`__heap_base`, so the host uses `PROCESS_MEMORY_FALLBACK_BRK_BASE` = 16
MiB; channel at page 257 = 0x1010000). Go assumes it owns linear memory
from `runtime.end` upward and grows its heap into that space with
nothing reserving the channel pages. hello-world (~1.9 MiB) is far below
16 MiB so no collision, but a program whose live heap grows past ~16 MiB
will grow memory across the channel pages and corrupt the syscall
channel. Fix options: have the kandelo runtime reserve the channel
region (learned from `kandeloChannelBase`) so the allocator avoids it,
or export `__heap_base`/place the channel above Go's reservation. This
is the top follow-up.

**2026-09-07 — MILESTONE 2 (real stdlib) — `fmt.Println` + file I/O run
(fork `03d847f`, header fix `c3aeba7`).** Independently reproduced:
`fmt.Println("hello, kandelo")` prints on **stdout** (fd 1), exit 0, via
the real path `fmt` -> `os.Stdout.Write` -> `internal/poll.FD.Write` ->
`syscall.Write` -> channel `write`. File I/O verified with a mounted VFS:
`os.ReadFile("/etc/hostname")` drives `openat`->`fstat`->`read`->`close`
over the channel and returns the bytes; a missing path returns a correct
`ENOENT`. Changes: generalized the runtime handshake to `doSyscall6` and
`//go:linkname`d it into `syscall` (`syscall.kandeloSyscall6`);
implemented the `fs_kandelo.go` leaves (`Write`/`Read`/`Pread`/`Pwrite`/
`Close`/`Seek`/`Fsync`/`Fstat`/`Ftruncate`/`getrandom`) plus
`Open`/`Openat`/`Stat`/`Lstat` via kernel `openat`/`fstatat`; added
`internal/poll`/`os`/`time`/`internal/syscall/unix` `*_kandelo.go` peers.
No new wasm imports (still only `env.memory` + `kernel.kernel_exit`);
`wasip1`/`js` unaffected.
- **Key learning:** the Kandelo channel speaks **Linux/musl syscall
  numbers AND errno values** (musl `__NR_write==4`; errno slot is generic
  musl numbering) — required rewriting the kandelo errno table off WASI
  numbering. Paths/buffers are read **directly from linear memory via raw
  pointers** (NUL-terminated), so no `data_buffer` copy is needed.
- **Remaining gaps for real CLIs:** `os.Args`/environ are empty (need a
  host argc/argv mechanism — likely the `kernel_get_argc`/`kernel_argv_*`
  imports); `usleep`/timers stubbed; path-mutating ops
  (`Mkdir`/`Unlink`/`Rename`/`Chdir`) still ENOSYS; no netpoll
  (synchronous blocking channel); plus the channel-vs-heap 16 MiB risk.

**2026-09-07 — Real CLIs: `os.Args`/environ + path-mutating fs
(fork `c1f2888`).** Independently reproduced: a program run with
`argv:["prog","alpha","beta"]` prints `args: [prog alpha beta]`,
`cwd: /`, and `mkdir`/`write`/`read`/`rename`/`rm`/`rmdir` all succeed
(`<nil>`) against real kernel state, exit 0. `os.Args`/`os.Environ` come
from the host `kernel_get_argc`/`kernel_argv_read`/
`kernel_environ_count`/`kernel_environ_get` function imports (two-step
length-query-then-copy, no trailing NUL) wired into `runtime.goenvs`;
path ops (`mkdirat`/`unlinkat`+`AT_REMOVEDIR`/`renameat`/`chdir`/
`getcwd`/`chmod`/`truncate`/`linkat`/`symlinkat`/`readlinkat`/
`utimensat`) route through `kandeloSyscall6`, and
`internal/syscall/unix/at_kandelo.go` was rewritten to drop the WASI
`path_*` imports. Imports are now `env.memory` + 5 `kernel.*` functions,
zero WASI; validates; `wasip1`/`js`/native `std` still build. Remaining
std gaps (no kandelo port yet): `net`, `os/signal`, `path/filepath`,
`crypto/internal/sysrand`; `Chown` is honest ENOSYS.

**2026-09-07 — Channel-placement hardening (fork `0794818`).**
Guest-only fix, no host change. (1) Linker synthesizes a `__heap_base`
export (= `runtime.end`), so the host drops the channel from the fixed
16 MiB fallback to just above Go's data (`host/src/process-memory.ts`
`computeProcessMemoryLayout` reads `__heap_base`). (2) Runtime starts
Go's break at `blocMax` (top of the host's initial linear memory) so the
heap grows entirely ABOVE the channel; ~1.1 MiB reserved (mostly Go's
own 1 MiB linker init headroom). Rejected the alternatives (freelist
"hole" / 16 MiB placement) as brittle host-layout coupling or ~14 MiB
waste. Independently reproduced: a program allocating 64 MiB then doing
file + stdout syscalls exits 0 with `match: true` and `read:
channel-ok` (no corruption). Exports now include `__heap_base` (global
9) beside `__tls_base`; validates; `wasip1`/`js`/native unaffected; no
ABI bump (`__heap_base` is a guest export the host already consumes).
**Residual risk for MILESTONE 3 (threads):** the host would place a
dynamic pthread thread-slot at `firstThreadSlotPage`, which now equals
where the Go heap starts — so real wasm threads will collide with this
layout and the memory model must be reworked as part of the threads
work. (Go is single-M today; `newosproc` throws, so no thread slot is
requested.)

**2026-09-07 — MILESTONE 3 (threads) Phases 1-2 done.**
*Phase 1 — real atomics (fork `f3d46f3`).* Added the `0xFE` atomic RMW
opcode set (loads/stores/add/and/or/xchg/`cmpxchg`/`fence`) to Go's wasm
assembler and a kandelo-only real-atomics implementation
(`internal/runtime/atomic/atomic_kandelo.{go,s}`); `atomic_wasm.go`
gated to `wasm && !kandelo` so `js`/`wasip1` keep plain-access. A `sync/
atomic` program runs correct through the kernel (`add:15`, `cas:true
100`, `swap:42 7`, `load:0xDEADBEEF`, `andor:15`), exit 0; no regression;
`js`/`wasip1` unchanged. (Note: two and/or sub-opcode bytes in the task
spec were wrong; spec-correct values used and proven by disassembly.
`StorepNoWB` stays a plain store — minor shared-memory pointer-store
soundness gap to revisit at multi-M.)
*Phase 2 — per-M `g` pivot CONFIRMED.* Live host experiment: two
`WebAssembly.Instance`s of one module over one shared `WebAssembly.
Memory` have independent mutable globals (`a=111`, `b=222`) while sharing
linear memory (`b` reads `a`'s write `42`). So each Go M (its own
instance) gets its own `g`/`SP` globals for free with a shared heap —
the design's linchpin holds.
*Host-change/ABI verdict (2026-09-07): (A) NO host change, NO ABI bump.*
Go can drive the existing `centralizedThreadWorkerMain`/`onClone` clone
path with a guest-only delta. The only hard-required child export Go
lacks is `__indirect_function_table` (a one-line `writeExportSec`
addition; `worker-main.ts:5915-5920` throws without it). `__wasm_init_tls`
/`__wasm_thread_init`/`__stack_pointer` are all guarded/optional
(`worker-main.ts:5880-5900`); Go's per-M state is the per-instance wasm
globals SP/g, independent of musl TLS. `kernel_clone` is already a
provided host import (`abi/snapshot.json:1880`); no snapshot/`ABI_VERSION`
change. Per-M channel base: the host already delivers it per-instance via
the `env.__channel_base` imported global (`worker-main.ts:2422-2441`), so
the guest switches from the single-word `__tls_base` trick to importing
that global (needs Go linker/codegen to import + read a wasm global — the
one non-trivial guest-side item). Thread entry: `newosproc` calls
`kernel_clone(fnPtr=PC_F of an exported mstart trampoline, stackPtr,...)`;
host calls it via `table.get(fnPtr)()` (arity 0). Remaining true risks
(guest-side, Phase 4): (1) reading an imported wasm global from Go;
(2) whether the multi-M scheduler actually runs on wasm (unprecedented —
the real unknown, provable only by building it); (3) a heap-ceiling vs
host thread-slot-window memory partition; (4) `sbrk` stays under the
mheap lock. Concurrent `memory.grow` is engine-atomic/monotonic and the
host already handles view-detach — safe, not a blocker.

*Phase 4 is a genuine architectural + novel-runtime commitment; paused
for maintainer go/no-go before implementing.*

**2026-09-30 — Reconciled onto latest main (ABI 45); Phase 4 approved.**
Main advanced 58 commits since the port's baseline; `ABI_VERSION` went
43 -> 45 (the Wayland/DRI desktop stack — GPU buffers, evdev, SDL2 —
additive). Merged `origin/main` into the branch (clean; docs are new
files). Verified the Go-port-critical contracts are UNCHANGED: channel
region layout (all offsets identical), the syscall numbers the port uses
(Write=4, Exit=34, ClockGettime=40, Openat=69, Mkdirat=95, …),
`struct stat` field offsets (only `st_rdev@88` is now populated;
112-byte layout unchanged), the process-memory constants
(`PROCESS_MEMORY_DEFAULT_MAX_PAGES=16384`,
`PROCESS_MEMORY_FALLBACK_BRK_BASE=16 MiB`), `env.__channel_base` still a
process-expected global, and required executable exports still
`["__abi_version","_start"]` — so the Phase-4 host-change verdict still
holds. The thread-worker path changed only a guarded `__stack_pointer`
read (musl pthread vararg stack alignment), which does not affect Go.
**Only fork change needed:** the synthesized `__abi_version` marker
43 -> 45 (fork `3e1d28f`). Reused the sibling `rust-programs-on-kandelo`
worktree's fresh clean-main ABI-45 `kernel.wasm` (its `crates/kernel`/
`crates/shared` match `origin/main` exactly) instead of a duplicate
build. Independently verified `fmt.Println` runs against that ABI-45
kernel: exit 0, stdout `"hello, kandelo\n"`. (Benign: Go binaries lack
the `kandelo.abi.contract` digest stamp — currently warn-and-pass;
track in case that rollout later hard-fails.) Proceeding into Phase 4.

**2026-09-30 — MILESTONE 3 breakthrough: a 2nd M runs (fork `6e0ba54`).**
First gc-Go wasm port to run a second M. Independently reproduced: a Go
`GOOS=kandelo` program spawns a 2nd OS thread via the real kernel path
(`//go:wasmimport kernel kernel_clone` -> kernel `sys_clone` -> host
`centralizedThreadWorkerMain` -> `table.get(PC_F)()`); the new instance
bootstraps its OWN `g`/`SP` and per-M channel base and performs an
observable channel syscall. Output: stdout `"M1: before spawn\nM1: after
spawn\n"`, stderr `"M2 alive via kernel_clone\n"`, exit 0, zero host
diagnostics (no corruption).
- *Phase 4a (fork `04dd1235e`):* exported `__indirect_function_table`,
  per-M `mOS.channelBase`, `wasm_pthread_start` trampoline; single-M
  intact.
- *Phase 4b (fork `6e0ba54`):* (A) bootstrap — a hand-written wasm-asm
  entry `wasmThreadTramp` installs `g` (global 2) and `SP` (global 0)
  from handoff words before any Go code (the `//go:wasmexport` wrapper
  can't be used: it starts with `global.get SP; i32.eqz; call
  notInitialized`); the trampoline must return the entry's i32 to pass
  `WebAssembly.validate`. (B) `newosprocKandelo` writes `g0`/stack to a
  shared handoff under `kandeloCloneLock`, computes
  `PC_F = FuncPCABI0(wasmThreadTramp)>>16` (never hardcoded), and calls
  `kernel_clone` with `CLONE_VM|FS|FILES|SIGHAND|THREAD|SYSVSEM`
  (`tls/ptid/ctid=0`; kernel `sys_clone` requires `VM|THREAD` and gates
  TID/TLS writes behind `SETTLS`/`CHILD_CLEARTID`). (C) per-instance
  wasm globals give per-M `g`/`SP` for free (proven). No imported
  global; `wasip1`/`js` unaffected.

**FUNDAMENTAL DECISION SURFACED — memory partition for many Ms.** Two
allocators share one linear memory: Go's heap grows up from `blocMax`,
and the host thread-slot allocator marches up from `firstThreadSlotPage`
— which sits just below Go's heap. They converge after ~3 threads. The
mechanics milestone holds (slot 0 landed in the forfeited gap below the
heap), but the FULL scheduler (GOMAXPROCS Ms, and extra Ms spawned when
blocking channel syscalls park a worker) needs this resolved. The host
already supports the fix: `computeProcessMemoryLayout` honors
`preallocateThreadSlots` + `threadSlotCount` (reserving the slot arena
below the heap, bounding the allocator via `maxPageExclusive`). The Go
module now exports `__wasm_posix_thread_slots=8`. Resolving it cleanly
means a **host launcher change** (Node+browser) to pass
`preallocateThreadSlots:true` + the guest count — crossing the "no host
change" line the thread-*entry* verdict established, and touching the
process-memory-layout (ABI-adjacent). A guest-only alternative (Go
reserves the arena in its heap-start computation) cannot bound the
host's allocator by itself, so it is not sufficient alone. Paused for
maintainer decision before making the host change.

*Full-scheduler follow-up (after the memory decision):* swap the
trampoline marker for `mstart()` + make `newosprocKandelo` the real
`newosproc`; real per-M parking (`notesleep`/`futex` via `memory.atomic.
wait32`/`notify`); child-ack handshake so the single handoff slot
tolerates >1 in-flight spawn; `dropm`/`mdestroy` slot teardown.

**2026-10-06 — Phase 4 memory-partition work resumed (draft PR #1492).**
Merged current `origin/main` (ABI 47) and began an explicit opt-in
preallocated thread arena for the Go runtime. The earlier suggestion to
preallocate every binary with a positive slot count would also change
existing C pthread programs, including fork and vfork behavior. The
new `__wasm_posix_preallocate_thread_slots=1` declaration leaves their
dynamic layout intact. The host's shared process-memory calculation now
reserves the declared eight Go slots below `brk_base`; the thread
allocator takes ordinary Go M slots from that arena and keeps host-only
control workspaces separate. The ABI snapshot and Go linker's marker
are moving together at ABI 48. The Go fork is now published at
`https://github.com/kandelo-dev/go`, branch `kandelo-port`, commit
`96e1169` (upstream base `go1.25.6`).

**2026-10-06 — Phase 4 memory-partition validation.** Rebuilt the fork
with `make.bash` using Go 1.25.6, then built the existing second-M
probe. Node 24 accepted the resulting Wasm (`WebAssembly.validate`
returned true) and found `__abi_version`,
`__wasm_posix_thread_slots`, and the new preallocation export. A
temporary Vitest through the real `NodeKernelHost` and the ABI-48
kernel returned exit 0, stdout through `M1: after spawn`, stderr
`M2 alive via kernel_clone`, and zero host diagnostics. The focused
layout, allocator, and host parity tests passed (32 total with the
temporary Go probe); the host TypeScript build and ABI snapshot check
also passed. The source is now checked in at `tests/go/second-m/`, with
an executable Node runner and reproduction steps; rebuilding and
running that checked-in fixture yielded the same exit 0 and markers.
This proves the opt-in arena preserves the two-M mechanics
probe, not that the full Go scheduler runs. Browser execution and broad
conformance remain unrun. The broad parser-suite attempt did not load
because a cached SpiderMonkey package artifact predates ABI 48; the
focused parser behavior is exercised by the synthetic Wasm layout
tests. Next: `mstart`, real parking, clone acknowledgment, teardown,
and observable parallel goroutines.

**2026-10-06 — Child-ack handoff (fork `bad577d`).** The parent now holds
the single-M clone lock until the child has consumed the shared `g0` and
stack-top words, captured its per-M channel base, and published an
atomic acknowledgment. A timed `memory.atomic.wait32` fails loudly if
the new Worker never reaches the entry. The checked-in
`tests/go/clone-handoff/` probe requests five Ms in sequence; each
acknowledged child emitted its marker through its own channel. The Node
run returned exit 0, five markers, and zero host diagnostics. This
proves repeated handoff reuse, not concurrent spawns from different Ms:
`lock_kandelo.go` still lacks a cross-thread atomic mutex, and the
child still exits without running `mstart`. Both remain Phase-4 work.

**2026-10-06 — Parallel scheduler slice (fork `973fd0a`).** Replaced the
single-M runtime mutex and note stubs with Wasm atomic compare/exchange,
`memory.atomic.wait32`, and `memory.atomic.notify`; a user-G note wait now
releases its P through `entersyscallblock`. `GOMAXPROCS(2)` is no longer
clamped on Kandelo. A cloned M with a P enters `mstart`, and its trampoline
continues through `wasm_pc_f_loop` after a goroutine switch. The previous
trampoline returned to the host on the first switch, so the M could reach
`execute` but never run the selected G. The no-P clone marker remains as a
separate mechanics path.

The first parallel probe intermittently printed completion but never
exited. Tracing showed `runtime.main` can finish on a worker M, where the
host's `kernel_exit` import issues thread-only `SYS_EXIT`. Go now commits
`SYS_EXIT_GROUP` before that non-returning import. Clock syscall output was
also moved from one shared package buffer to per-M scratch, avoiding
cross-M writes. A minimal `osyield` return replaces the Wasm trap on the
Kandelo build.

The checked-in `tests/go/scheduler/` probe forces two goroutines to overlap
without cooperative yields; five consecutive Node runs exited 0 with
`GOMAXPROCS: 2`, `parallel M: complete`, and no host diagnostics. Its
`exit-worker/` companion keeps M0 busy while another M calls `os.Exit(0)`;
five consecutive Node runs exited 0 with its worker marker and no host
diagnostics. The existing five-clone handoff probe still exits 0 with five
markers and no diagnostics. These are focused Node proofs, not full Go
scheduler conformance. Browser execution, concurrent clone contention,
per-M exit/reaping (`exitThread` is still a Wasm trap), `LockOSThread`,
sysmon/preemption behavior, and broader runtime tests remain. No Kandelo
ABI or host source changed in this slice.

**2026-10-06 — Chromium browser milestone probes.** Added a small Go
stdlib/startup/file-syscall probe and `tests/go/build-browser-fixtures.sh` to
compile it alongside the existing second-M, five-clone, parallel-scheduler,
and worker-exit probes. `apps/browser-demos/test/go-port.spec.ts` runs all
five as real browser process workers through `BrowserKernel`, using a VFS
image assembled in the Playwright Node process and the ABI-48 kernel selected
by the source binary resolver. It asserts exit 0, output markers, exact
clone-marker counts, no host diagnostics, and no page or console errors.

The dedicated Chromium run passed all five tests in 30.5 seconds with one
Playwright worker. The suite is opt-in (`KANDELO_GO_BROWSER_TESTS=1`) because
the external Go fork is not part of default browser-test provisioning; see
`tests/go/README.md` for the exact commands. The normal browser test-runner
page was not used: this checkout lacks its rootfs artifact, and its bundled
`scripts/resolve-binary.sh` still rejects the freshly built kernel although
the source resolver accepts it. The focused browser tests therefore supply
source-resolved kernel bytes explicitly. This proves these five browser-host
paths, not the complete browser demo, full Go runtime conformance, or broad
POSIX behavior. Concurrent clone contention, individual-M exit/reaping,
`LockOSThread`, sysmon/preemption, and broader runtime tests remain.

**2026-10-07 — ABI-48 resolver bundle and concurrent clone/affinity slice.**
The shell resolver rejection was a stale generated
`scripts/resolve-binary.bundle.mjs`: it still embedded ABI 47 after this
branch raised the generated ABI to 48. Regenerating it made
`scripts/test-resolve-binary-bundle.sh` and
`scripts/resolve-binary.sh kernel.wasm` pass. This artifact must be committed
with the ABI-48 Go PR, not independently against ABI-47 `main`; the existing
package-system resolver test already detects bundle drift.

A new concurrent-clone probe forces two scheduler Ms to overlap while each
requests a no-P M, twice. Node and Chromium both completed four clone
handoffs with exact child markers and no host diagnostics, exercising the
atomic handoff lock from separate parents. An initial eight-clone Chromium
probe hit the declared eight-slot limit before departed no-P workers were
fully recycled (`active=8`); reducing the contention probe to four clones
isolates lock behavior without treating slot capacity as solved. Slot reuse
under sustained thread churn remains separate work.

The fork's `LockOSThread` path still returned early on every Wasm target.
Fork commit `3fae0fa` exempts Kandelo from that no-thread guard and from
the template-thread path, because a Kandelo clone starts a fresh Wasm
instance rather than inheriting the parent's thread-local host state. The
new locked-thread probe checks that the binding exists, remains on one M
through 64 scheduler yields, and clears on unlock. It exits 0 with no host
diagnostics in Node and Chromium; `GOOS=js` and `GOOS=wasip1` standard-library
builds still pass. All seven focused Chromium milestone probes pass.
Individual M termination/reaping when a locked goroutine exits without
unlocking remains unimplemented (`exitThread` still traps), as do sysmon,
preemption, and broader Go/stdlib conformance.

**2026-10-08 — Locked-M exit and paced thread-slot recycling.** A focused
Node probe first reproduced a locked goroutine's natural return as an
`exitThread` unreachable trap, killing its thread worker with status 132.
The fork now calls a Kandelo-specific `kernel_thread_exit` import from
`exitThread` (fork commit `8be9c5a`). The shared Node/browser host import
reads the Go runtime's
`freeWait` pointer while its g0 stack is still live, atomically marks the
stack reclaimable, then sends only `SYS_EXIT` for that M and traps out of
the disposable Worker. The existing `kernel_exit` path still handles
process-wide exit; no `EXIT_GROUP` is sent for an individual M. This host
handoff is necessary because a Go-generated Wasm import wrapper rereads
the stack after an assembly-side `freeWait` clear; the initial direct-call
prototype was discarded after disassembly showed that use-after-free risk.

The probe then ran twelve sequential locked-M exits with a 100 ms drain
interval between rounds, exceeding the eight-slot thread arena. Node and
Chromium both exited 0 with no host diagnostics, showing individual M
reaping and paced slot reuse on both hosts. All eight focused Chromium Go
probes pass. The host TypeScript check, focused startup-import Vitest tests,
ABI snapshot check, and `GOOS=js`/`GOOS=wasip1` standard-library builds also
pass. The new import is additive within this unreleased ABI-48 branch and
does not alter an existing import's signature or the ABI snapshot. This
does not prove unpaced burst churn, a larger thread arena, sysmon/preemption,
or full Go/runtime/POSIX conformance; the concurrent eight-slot boundary
observed on 2026-10-07 remains.

**2026-10-08 — Kandelo sysmon and cooperative preemption.** A new
`GOMAXPROCS=1` probe showed the prior runtime delayed a 100 ms timer until a
two-second busy goroutine finished. Fork commit `022ee37` enables Go's
sysmon thread, uses Wasm atomic timed wait for `usleep` rather than returning
immediately,
and sends no-P Ms with an `mstartfn` (including sysmon) through `mstart`
instead of the clone-mechanics probe path. The probe checks that the timer
fires while the busy goroutine is still active, with a primarily arithmetic
loop containing Go call safe points. The existing locked-M exit probe now
retries when sysmon preempts main and the goroutine initially lands on M0.

Six focused Node scheduler probes and all nine Chromium probes exited 0
without host diagnostics. After tightening the busy loop, the sysmon probe
passed three further Node runs; the final nine-probe Chromium suite passed
again. `GOOS=js` and `GOOS=wasip1` standard-library builds and the ABI
snapshot check passed. This is cooperative preemption at Go safe points,
not asynchronous interruption of a call-free Wasm loop:
`preemptMSupported` remains false.
The eight-slot capacity, unpaced thread churn, broader Go runtime tests,
and full POSIX conformance remain open.

**2026-10-08 — Upstream Go package tests and honest I/O boundary (fork
`2aa3c9e`).** The fork now compiles Go's `internal/runtime/atomic` and
`sync` test binaries
for Kandelo: it corrects the Wasm atomic-wait assembly signature, adds
Kandelo's `crypto/internal/sysrand` reader over `getrandom` (including
short-read and `EINTR` handling), and makes the existing Unix path,
signal, and test-environment helpers available to this target. The
`getrandom` path is exercised by the browser basic probe. The syscall
backend no longer reports success for unsupported nonblocking-flag changes;
`fd_fdstat_set_flags` returns `ENOSYS` until it and a real poller exist.

The upstream atomic package's short suite and selected `sync` tests
(`TestMutex`, `TestWaitGroup`, and `TestCondSignal`) pass through the real
Kandelo kernel in Node. They also have opt-in Chromium browser-host tests
alongside the nine existing milestone probes. The final eleven-probe
Chromium run passed in 1.1 minutes with exit 0 and no host diagnostics.
A wider short `sync` run
passes when subprocess-dependent `TestMutexMisuse` and examples are
excluded. The complete short suite does **not** pass: `TestMutexMisuse`
needs `os.Executable`/subprocess support, and `ExamplePool` needs a pipe.
An experimental `pipe2` bridge created the pipe but hung example capture:
the fork's existing fd-flags stub claimed nonblocking success without
changing kernel state, and the runtime still has a fake netpoller. That
bridge was removed rather than masking the missing scheduler/I/O contract.
The `runtime` test binary itself still cannot build because `net` lacks
Kandelo's `netFD`; networking/netpoll belongs to milestone 4. Full
runtime conformance, unpaced thread churn, a policy for CPU-count reporting
(Kandelo's current `sysconf` also reports one), and later networking,
subprocess, and package milestones remain open.
An unpaced 64-round locked-M experiment succeeded three times in Node but
exhausted the declared eight pthread slots in Chromium while exited Ms were
still live. The checked-in paced probe remains the supported claim; its
main goroutine now pins its M so a preemptive migration cannot invalidate
the worker-M identity check.

**2026-10-08 — Configurable Go pthread arena and burst churn (fork
`e27c900`).** The Go
linker's hardcoded eight-slot declaration was the immediate reason a
64-round locked-M burst exhausted the browser arena. The fork now defaults
to 32 preallocated slots (8 MiB of control pages) and accepts
`-ldflags='-kandelothreadslots=N'` for 1–1024 slots. The linker rejects
out-of-range counts; the host's source resolver reads both the default 32
and an explicit four-slot build correctly. No host layout or ABI changed.
The checked-in burst mode starts 64 locked worker Ms without pacing their
exits, alongside the existing twelve-round paced mode. The burst passed
three Node runs with exit 0 and no host diagnostics; the twelve-probe
Chromium suite also passed, including the burst; three further Chromium
burst repeats passed concurrently. `GOOS=js` and `GOOS=wasip1` standard
library builds and the ABI snapshot check passed. This proves slot reuse
under this workload with the larger declared arena, not unbounded Go thread
creation or complete runtime conformance. Programs demanding more concurrent
Ms must choose a larger count and budget its control memory. The runtime
test binary remains blocked on the missing `netFD`, and CPU-count reporting
still follows Kandelo's current `sysconf` value of one.

**2026-10-08 — First real Go socket syscalls (fork `ee860d3`).** Removed
Kandelo from Go's fake socket constant table and added Kandelo's actual
IPv4/IPv6 address layouts, socket constants, and channel-backed stream
operations in `syscall`. The new checked-in Go probe runs IPv4 and IPv6
TCP loopback using `Socket`, `SetsockoptInt`/`GetsockoptInt`, `Bind`,
`Listen`, `Getsockname`, `Connect`, `Accept`, `Getpeername`, and stream
`Write`/`Read`. It exits 0 with `GO SOCKET PASS` and no host diagnostics
in Node and Chromium. The full thirteen-probe Chromium suite passed; the
`GOOS=js` and `GOOS=wasip1` standard-library builds passed. An initial
browser attempt on the default Playwright port failed loading a Vite module;
the fresh-port focused and full runs passed. This is a syscall-level
networking slice, not `net.Dial`: the Kandelo `netFD` and runtime netpoller
are still absent, as are datagram/message syscalls and deadlines. Next,
wire the Go `net` package and poller to Kandelo's socket/epoll contract,
then prove `net.Dial` and a listener through both hosts before HTTP.

**2026-10-08 — Real Go runtime netpoll and nonblocking flags (fork
`63b22e7`).** Replaced Kandelo's fake runtime poller with an epoll-backed,
level-triggered poller and eventfd `netpollBreak`. Its registrations exist
only while a read or write waiter is armed; leaving unarmed descriptors in
epoll caused repeated HUP events from stdio and starved timers. Kandelo
`SetNonblock` and `fcntl(F_GETFL/F_SETFL)` now use the real kernel calls, so
`os.NewFile` can detect and poll a nonblocking socket. A focused probe wraps
an accepted TCP socket in `os.NewFile` and confirms a read deadline expires,
later data wakes a blocked read, and close unblocks another blocked read.
The first implementation failed intermittently on additional Ms because
nonzero-initialized poller fd globals were reset when a new Wasm instance
applied its active data segments to shared memory. Keeping the runtime fd
state zero-initialized, then setting it in `netpollinit`, removed those
failures: eight Node repeats and ten Chromium repeats passed before the
close check; the final close check passed three Node and five Chromium
repeats, and the full fourteen-probe Chromium suite passed. No kernel or
host ABI changed; `GOOS=js` and `GOOS=wasip1` standard-library builds passed.
This proves the focused socket/poller path, not full Go `net` support.
`GOOS=kandelo go build net` still fails at the missing `netFD`; next, add
that package backend and prove `net.Dial` and `net.Listen` on both hosts.

**2026-10-08 — Go `net` and loopback HTTP (fork `a4b548a`).** Enabled
the upstream POSIX `netFD`, address, resolver, TCP, and socket-option paths
for Kandelo, adding the missing syscall socket options and truthful
`ENOSYS` interface enumeration. `GOOS=kandelo go build net` and
`net/http` now succeed. Checked-in probes perform IPv4 and IPv6
`net.Listen`/`net.DialTimeout` exchanges and serve a real HTTP response to
Go's default client. Each passed three Node runs with exit 0 and no host
diagnostics; all sixteen dedicated Chromium probes passed. The HTTP probe
first failed with duplicate `runtime.forcegchelper` goroutines: each new
Wasm thread instance replayed Go's active data segments over shared memory,
resetting package-initialization state. The shared host thread-module
patch now removes an all-active data section from no-Start modules, so only
the process-main instance initializes data. Seven focused host tests and
host typecheck pass; `GOOS=js` and `GOOS=wasip1` standard-library builds
pass. `GOOS=kandelo go build std` still fails in `net/internal/socktest`
and `os/user`. This meets the milestone-4 focused TCP/HTTP checks, not full
Go networking or runtime conformance: datagram/message syscalls and broader
DNS/TLS coverage remain. Next milestone: implement `syscall.StartProcess`
through Kandelo `SYS_SPAWN`, then package integration; finish the recorded
Go-runtime guidance work item at the end.

**2026-10-08 — Go process execution through non-forking spawn (fork
`3296d3f`).** Replaced Kandelo's `syscall.StartProcess`, `Wait4`, `Kill`, and
process-ID stubs with
native channel syscalls. `StartProcess` now encodes the established 40-byte
`SYS_SPAWN` header, argv/env string tables, ordered `CHDIR`/`DUP2`/`CLOSE`
actions, and a PID output slot. It duplicates requested child fds above the
target range with `F_DUPFD_CLOEXEC` before issuing actions, preventing
remapping collisions and parent fd leaks; it enforces path, string, action,
and `ARG_MAX` limits and rejects embedded NULs. The Go port now exposes real
wait status and 144-byte rusage layout, `pipe2`, `dup`, `dup2`, and close-on-exec
flags so `os.Pipe` and `os/exec.Cmd.Output` work. The checked-in self-exec
probe validates child parent PID, cwd, environment, exit code, output capture,
and launch errors. It passes in Node with no host diagnostics, and the
instrumented Node runner records fork-count samples `[0, 0]`; the focused
Chromium probe passes too, and all seventeen Go Chromium probes pass together.
This meets milestone 5's focused shell-out/child management check, not
comprehensive process or signal conformance. Next is
milestone 6: first-class Go package integration through the normal resolver
and VFS path. At this point, directly built Go fixtures still emit the legacy
`kandelo.abi.contract` stamp warning. The recorded Go-runtime-specific agent
guidance follows at the end.

**2026-10-08 — Stamp directly built Go fixtures.** The Go browser-fixture
builder now records exactly its sixteen newly built Wasm outputs and applies
the existing `stamp-abi-contract` tool once to that list. It does not sweep
other files or overwrite stale stamps. The Node exec probe and all Chromium
Go probes now require their fixture digest to equal the running kernel's
digest, preventing the host's warn-and-allow path from masking a missing
stamp. The Node exec probe passes without the misleading legacy-binary
warning, and all seventeen Chromium Go probes pass with matching stamps.
The existing stamp-helper regression test passes. The browser-demo TypeScript
project check still reports unrelated errors outside the changed Go probe
test. This fixes the direct-fixture gap independently of milestone 6;
package integration still needs to produce stamped Go programs through the
normal resolver/VFS build path.

**2026-10-08 — First-class Go package through source-only resolution (fork
`3296d3f`).** Added `go-hello` as a registry program and selected local-build
root. Its recipe obtains the pinned fork commit as a sealed `git_input`, builds
the Kandelo Go toolchain with the dev shell's declared Go bootstrap, and invokes
the SDK's `wasm32posix-go` wrapper. The source-only resolver caches and
ABI-contract-stamps the declared Wasm output; no adjacent fork checkout or
ambient compiler is needed. The package import audit originally rejected the
Go runtime's supported `kernel.kernel_thread_exit` process-worker import, so
its shared typed declaration now admits the exact pointer-width signature
without allowing arbitrary kernel exports. The source-only `go-hello` and
kernel builds succeeded. A C launcher uses `posix_spawn` to run the resolved
Go output from `/bin` in a VFS image: Node exits 0 with both expected markers,
empty stderr/diagnostics, and fork-count sample `[0]`; the equivalent
Chromium browser-host test passes with no console errors. The legacy Default
resolver's artifact remains unstamped and is not used for these runtime
checks. This meets the focused milestone-6 package/VFS smoke criterion, not
full Go conformance or a browser-demo UI test. The remaining discrete plan
item is Go-runtime-specific agent guidance below. During iteration, a
metadata-only manifest license edit left a cached source-only receipt tied to
the previous manifest SHA and caused projection finalization to refuse it;
`cargo xtask clean go-hello` followed by `cargo xtask bootstrap go-hello`
recovered through the supported path. The underlying receipt-refresh behavior
is a package-manager gap, not a Go runtime failure.

**2026-10-08 — RoadRunner-first PHP-server feasibility (fork `bd12cbf`).**
RoadRunner is the first practical integration target: it runs PHP workers as
separate processes and supports a `CGO_ENABLED=0` Go build. FrankenPHP embeds
PHP through cgo, which remains outside this Go/Wasm port. The RoadRunner
v2025.1.6 source is
the latest release compatible with the fork's Go 1.25 toolchain; v2025.1.7
raises the minimum to Go 1.26. This is a pinned feasibility probe, not a
RoadRunner package or a supported server release.

The full `GOOS=kandelo GOARCH=wasm` RoadRunner binary stops in third-party
`fasthttp/tcplisten`: no source file matches the Kandelo target. A narrower
RoadRunner server-core build first exposed missing `os/user` lookup. Enabling
the upstream pure-Go `/etc/passwd` and `/etc/group` parser for Kandelo in the
fork makes public user/group lookup and seven selected upstream parser tests
pass in Node and Chromium with VFS account files. The full nineteen-probe
Chromium Go suite passes. The source-only `go-hello` recipe rebuilt from the
new fork pin and its resolved VFS-launch probe passes in Node and Chromium.
Full `go build std` now fails only in `net/internal/socktest`; this is still
not full standard-library
conformance. The server-core compile then reaches `syscall.ForkLock` and
`SysProcAttr` process-group and credential fields. These are genuine process
integration gaps in the Go fork. Kandelo already has child-atomic
`SETPGROUP` in its `SYS_SPAWN` attributes; explicit child credentials have
no spawn representation. The fork lock must preserve descriptor inheritance
semantics rather than merely satisfy the compiler.

The next broader work is therefore the process-startup and descriptor
contract: wire existing spawn-time group attributes, define honest
credential behavior, and protect descriptor inheritance on both hosts.
After that,
compile a minimal RoadRunner server and demonstrate an HTTP request through
a real PHP worker. The RoadRunner executable and PHP worker have not run;
UDP, DNS, and TLS are not the first blockers for this target. Keep the
Go-runtime-specific agent guidance work item at the end of this plan.

**2026-10-09 — RoadRunner process integration (fork `98dc3f1`).** The Go
fork now serializes its descriptor snapshot and `SYS_SPAWN` call against
third-party non-atomic socket/close-on-exec creation through
`syscall.ForkLock`. `SysProcAttr.Setpgid` and `Pgid` use the existing
Kandelo `SETPGROUP` spawn attribute; negative group IDs fail before spawn.
The Go `Getpgid` wrapper lets the child verify its own group. A requested
`Credential` explicitly returns `ENOSYS`, since no child-atomic credential
action exists in the spawn wire contract. The checked-in Go exec probe now
checks the isolated child's group and the two failure cases. It exits 0 in
Node with three fork-count samples of zero, and the focused Chromium exec
probe passes. No ABI or kernel source changed; the Go package source pin is
updated to this fork commit.

With a generic `net.Listen` adapter for
`roadrunner-server/tcplisten`, the RoadRunner server core and HTTP plugin
compile for Kandelo. A minimal custom entrypoint using RoadRunner's real
server, HTTP, and logging plugins also builds to a 35 MiB Wasm program and
receives this checkout's ABI-contract stamp. The stock all-plugin CLI still
hits unrelated terminal (`goterm`) and reload (`syscall.Exec`) compile gaps.
The full CLI's modified plugin list remains scratch-only.

The checked-in `tests/go/roadrunner/build.sh` now reproducibly builds that
minimal server from pinned upstream source and the listener adapter. The
source-only PHP package supplies the CLI worker. A C supervisor launches the
server, sends a loopback HTTP request, verifies the PHP worker's Goridge
response, terminates the server, and reaps it. The Node test exits 0 with
`ROADRUNNER ROUND TRIP PASS`, empty stderr/host diagnostics, and zero fork
counts; the opt-in Chromium test passes the same VFS-loaded round trip.
Both programs carry the kernel's ABI-contract digest. This proves an actual
RoadRunner-to-PHP request, not a full package, Composer SDK integration,
all-plugin CLI, or Go conformance.

The first Node run exposed a host signal-exit race: `waitpid` wakeup tried
to dequeue a signal from a thread whose process had already exited. The
shared host now retires host-deferred child waiters when the parent is already
host-reaped, before polling or publishing any completion. A focused host
regression test, all 70 process-wait lifecycle tests, and the Node/Chromium
integration run pass. The `go-hello` source-only package rebuilds from fork
`98dc3f1`; its resolved VFS child exits 0 in Node and Chromium. No ABI or
kernel source changed. A real child-credential feature is a separate
POSIX/ABI design task, not a shim for the optional RoadRunner user-switch
setting.

Focused Sortix process/signal conformance was attempted twice, but its
runner never reached a guest test: the worktree lacks the full built-in
program closure. Building `dash` moved the missing artifact to `grep`;
the complete local-build plan has 157 uncached nodes and an estimated
36-minute critical path. This is a provisioning gap, not a conformance
pass or an observed POSIX failure. Full conformance remains merge
validation work after the closure is built.

**2026-10-09 — WordPress RoadRunner local profile (fork `ab8c85d`).** The
existing WordPress SQLite VFS now has an opt-in Node profile that stages the
pinned-source minimal RoadRunner binary, PHP CLI, and a Goridge PHP bridge into
the same boot image. RoadRunner owns public port 3000; the bridge forwards to
the image's unchanged nginx/PHP-FPM application path on guest port 38080.
This is not direct WordPress execution as a RoadRunner worker, a browser
gallery profile, or a source-only RoadRunner package.

Real browser navigation revealed two Go-runtime gaps hidden by the one-request
probe. The exported `syscall` channel entry blocked without releasing its P,
starving concurrent HTTP handling; `entersyscallblock`/`exitsyscall` now wrap
user-g channel calls, while runtime-internal calls stay separate. Guest socket
`write` raised fatal `SIGPIPE` when a browser canceled an asset request; Go
now uses `Send` with `MSG_NOSIGNAL` for sockets and falls back to `write` for
non-sockets. The fork revision is pinned by `go-hello`. No Kandelo ABI or
kernel source changed.

The same-VFS local demo returned WordPress HTTP 200 in Chromium for home and
login, loaded their assets with no failed requests, and served repeated
sequential curl requests. The original focused RoadRunner Node and Chromium
worker round trips pass with the new fork; cross-target `js` and `wasip1`
`os`/`net/http` builds pass. The pinned `go-hello` source-only build and its
resolved VFS child pass in Node and Chromium. The netpoll probe now includes a
raw blocking pipe read under `GOMAXPROCS=1`; it passes in Node and Chromium
without stderr or host diagnostics. A stronger C-pthread concurrent-request browser
probe completed the HTTP checks but repeatedly reported a browser kernel-worker
detach timeout during teardown; it was not retained as a passing regression.
Browser-host concurrency and direct PHP request-lifecycle integration remain
separate work. The Go-runtime-specific guidance item below is complete and
now includes these two lessons.

Next: turn the minimal server into a registry package with a source-only
recipe, then exercise normal package resolution and VFS launch in Node and
Chromium. After that, expand realistic configuration and PHP worker coverage,
and revisit the all-plugin CLI only where its features are needed.

**2026-10-09 — Direct WordPress worker requirement.** The same-VFS proxy
profile is not an acceptable performance demo of RoadRunner as an alternative
to PHP-FPM: its WordPress requests still execute in PHP-FPM. PHP CLI cannot
substitute for an HTTP SAPI by including WordPress in a loop; its SAPI discards
response headers, and a persistent PHP request would also retain request
globals and WordPress state. The next WordPress milestone is a PHP worker
entrypoint with a real per-request PHP lifecycle, not another HTTP proxy or a
one-shot CLI process per request. Keep the current profile only as a Go server
and Goridge integration probe.

Build and validate that milestone in this order:

1. Prototype a dedicated PHP SAPI worker that accepts RoadRunner's pipe
   protocol, maps request method, URI, headers, cookies and body into PHP's
   request environment, and maps PHP status, headers and body back to
   RoadRunner. Reuse PHP module startup across requests but run PHP request
   startup, WordPress entrypoint execution and request shutdown for each one.
2. Prove isolation with two distinct sequential WordPress requests in one
   worker process, including redirects, cookies, POST bodies and PHP `exit`;
   then test concurrent requests across workers. Do this in Node and Chromium
   against the same VFS without starting nginx or PHP-FPM.
3. Add a direct-worker demo profile and compare it with the existing
   nginx/PHP-FPM profile on the same WordPress content, VFS and host, with
   warmup, repeated page/API requests, throughput and latency distributions.
   Report failures and resource limits; make no performance claim until these
   measurements exist. The proxy profile is not a comparison baseline.

This supersedes the WordPress-facing part of the preceding package-first
sequence; packaging the minimal RoadRunner server remains useful, but it does
not by itself meet the direct-worker milestone.

**2026-10-09 — WordPress server pivot to FrankenPHP.** The direct RoadRunner
WordPress worker milestone above is superseded: the desired demo is now
FrankenPHP classic mode executing WordPress directly, without nginx or
PHP-FPM, on the existing WordPress VFS. Remove the RoadRunner-to-FPM
WordPress proxy profile; retain the focused RoadRunner Go/PHP worker probe
as Go process and IPC coverage, not as a WordPress server or benchmark.

FrankenPHP cannot yet be built for Kandelo. Its official source build requires
Go cgo plus a ZTS PHP embed SAPI (`--enable-embed --enable-zts`). The Kandelo
Go port defaults to `CGO_ENABLED=0`; forcing `CGO_ENABLED=1` on a minimal
`C.abs` probe with `CC=wasm32posix-cc` currently stops at
`cgo: unknown ptrSize for $GOARCH "wasm"`. This is only the first error:
the Go wasm `runtime.asmcgocall` and `runtime/cgo` cross-call implementations
are `UNDEF`, and the current PHP package builds CLI and FPM but not a ZTS
embed library. A proxy to FPM or a native-host FrankenPHP sidecar would not
meet the Kandelo demo goal; neither is a substitute for this prerequisite.

Next milestones, in dependency order:

1. Design and implement Kandelo Go/Wasm cgo interoperability, including C/Go
   calls, callbacks, shared memory, linker integration, and pthread behavior.
   First prove a minimal C call and callback in both Node and Chromium; do
   not start FrankenPHP packaging from a failing cgo target.
2. Build PHP's ZTS embed library through the normal package resolver, with
   its required extensions and request-lifecycle behavior. Validate a small
   Go-to-embedded-PHP request on both hosts before WordPress.
3. Port a minimal FrankenPHP `net/http` handler in classic mode, then boot
   the existing WordPress VFS without nginx or PHP-FPM. Verify home, login,
   admin, redirects, cookies, POST, static assets, and repeated requests.
4. Compare against the existing FPM profile on the same VFS/content and host,
   with warmup and repeated latency/throughput measurements. Do not claim a
   performance benefit until both paths are running and measured.

No direct FrankenPHP demo URL or performance result exists yet.

**2026-10-09 — cgo feasibility trace.** A scratch change in the Go fork taught
`cmd/cgo` the correct 32-bit Wasm pointer and integer sizes, moving the
checked-in C-call probe past its first error. Its next build stage tried to
parse a linked Wasm module as ELF, Mach-O, PE or XCOFF for dynamic imports.
Temporarily recognizing the Wasm magic exposed the next independent barrier:
`gccDebug` also needs a real Wasm object reader for DWARF and generated
constant/symbol data. A magic-byte skip is not a correct implementation; it
does not provide the data cgo requires. Beyond parsing, the Go Wasm runtime's
`asmcgocall` and `runtime/cgo` cross-calls still trap, and Go's linker does
not integrate the SDK's C/Wasm objects into the current final module. This
is an ABI, runtime and linker design task, not a package flag. The scratch
parser bypass was discarded rather than promoted as apparent cgo support.

FrankenPHP v1.11.0 is a candidate source pin because its `go.mod` requires
Go 1.25.4, within the fork's Go 1.25 line; current upstream `main` requires
Go 1.27. Source-version compatibility does not remove the cgo and ZTS PHP
embed prerequisites. Do not claim a runnable FrankenPHP port from a cgo
frontend or compile-only result: the first real gate is a C call and C-to-Go
callback executing in the same Kandelo process on Node and Chromium.

**2026-10-09 — FrankenPHP classic-mode integration trace.** Keep the focused
RoadRunner Go/PHP-worker probe as a separate integration test, but do not use
its old WordPress-to-FPM proxy as a performance demo. FrankenPHP's documented
WordPress setup uses classic mode, which executes PHP scripts directly. In
FrankenPHP v1.11.0, `frankenphp_execute_script` calls PHP request startup,
executes the script, and calls request shutdown for each request. This gives
WordPress its normal per-request lifecycle; it does **not** keep WordPress
bootstrapped between requests as FrankenPHP worker mode would. No speedup
over FPM should be assumed without a same-content measurement.

The smallest honest integration gate is the v1.11.0 FrankenPHP Go library,
not the entire Caddy/xcaddy distribution. Its `Init`,
`NewRequestWithContext`, and `ServeHTTP` path can serve a simple PHP file in
classic mode without configuring worker scripts. That is a proof of PHP
execution and response handling, not yet a WordPress server: the eventual
demo also needs real front-controller routing, static-file handling, and the
rest of the browser-visible HTTP behavior. Prefer the upstream Caddy
`php_server` path for that final demo if it can be ported; do not call a
bespoke Go router a drop-in FrankenPHP configuration.

Three independent implementation gates remain before even the library proof:

1. Finish Kandelo Go/Wasm cgo: parse actual Wasm debug/object information,
   link Go and SDK C objects into one module, and implement Go-to-C and
   C-to-Go transitions. The local, uncommitted cgo reader experiment advanced
   beyond the pointer-size error but stopped at unsupported imported Wasm
   globals; forcing the final link also exposed unsupported Go linker
   relocations or an unrecognized C object format. It is not a usable port.
2. Validate C-created pthreads calling back into Go. FrankenPHP v1.11.0
   starts its PHP main and request threads with `pthread_create`, and C
   callbacks enter Go for request data and response writes. A C-call-only
   probe would not exercise the required runtime/thread contract.
3. Build PHP 8.3's ZTS embed SAPI through the package resolver with the
   WordPress extension set, then link it into the Go/C module. The current
   `php` package produces CLI and FPM Wasm outputs but no ZTS `libphp` embed
   library; neither executable can stand in for one.

After these gates, run a simple classic-mode PHP page in Node and Chromium,
then add the actual FrankenPHP/Caddy request routing and serve the existing
WordPress VFS without nginx or FPM. Verify repeated page, admin, redirect,
cookie, POST, and static-asset requests before comparing it to the existing
FPM profile. There is still no runnable Kandelo FrankenPHP binary, demo URL,
or performance result.

**2026-10-09 — cgo frontend and callback probe.** The adjacent Go fork's
uncommitted `cmd/cgo` experiment now accounts for imported Wasm globals in
the linked debug module. The full `cmd/cgo` unit suite passes with that
change. A tracked fixture at `tests/go/cgo/callback` adds both a synchronous
Go-to-C-to-Go callback and a callback from a C-created pthread. With the
scratch frontend, both this fixture and the existing `C.abs` probe compile
their generated Go and C files, then fail at the Go linker's unsupported
PC-relative relocation handling for Kandelo/Wasm. The callback fixture runs
successfully with native-host Go, which checks the fixture but not Kandelo.
Forcing internal linking instead rejects the C Wasm object format. The Wasm
linker currently emits a final module, not a relocatable Go object that
`wasm-ld` can combine with C.
Its `runtime.asmcgocall` and `runtime.cgocallback` implementations also end
in `UNDEF`. Therefore this is a frontend-only advance, not a runnable C
call or callback, and no PHP/FrankenPHP request was executed. The scratch
fork changes are not committed, pushed, or pinned by the package. The next
implementation task is a coherent Go/C Wasm link and cross-call ABI design;
do not mask these failures with a cgo parser skip or package-local shim.

**2026-10-09 — Go/C Wasm link-route inspection.** `llvm-readobj` on the
callback fixture's SDK C object found `linking` and `reloc.CODE` sections:
function-index relocations to `go_double`, `pthread_create`, and
`pthread_join`, global-index relocations to `__stack_pointer` and
`__table_base`, and a table-index relocation for the pthread entry. The
fresh cgo-disabled Go binary is already a final Kandelo Wasm module;
handing it and the C object to `wasm-ld` fails with `out of order section
type: 0`. This does not establish that an external-link implementation is
impossible, only that the current Go output cannot be used as its input.
The next executable linker spike should import one SDK C Wasm object into
Go's internal Wasm linker, resolve its symbols and relocations, and run the
existing C-call probe in one module. It must preserve the imported shared
memory, function table, thread-slot declaration, and ABI stamp. If that
route cannot accommodate C function types, table elements, data and TLS,
evaluate emitting a relocatable Go object instead. Neither route is
implemented, and the C-call and callback probes remain unpassed on Kandelo.

**2026-10-09 — internal Wasm C-object reader spike.** Published fork commit
`85c99ecc12d0dedde902d884369ee1bfbaa40a6f` with an isolated
`cmd/link/internal/loadwasm` reader. It decodes the
SDK object's import names, linking symbol table, section references, and
the function-index, global-index, and table-relative CODE relocations needed
by the current probes; it rejects unsupported CODE relocation types instead
of misinterpreting them. Unit tests cover a small object and malformed
inputs. With `KANDELO_WASM_OBJECT` set to each actual SDK object, the reader
tests pass for the `C.abs` cgo shim (two `_cgo_topofstack` relocations) and
the pthread callback fixture (nine CODE relocations); the decoded entries
match `llvm-readobj`. The cgo build still stops at unsupported Go linker
relocations, and this reader is not yet connected to `ldobj` or the Wasm
emitter. No Go/C call has linked or run on Kandelo, Node, or Chromium. The
next step is to map parsed C function types/bodies, globals, data, table
elements, and relocations into the Go linker's final Wasm layout, beginning
with the C-call shim. Debug relocations and archives remain out of scope for
this reader spike. The `go-hello` package remains pinned to fork commit
`ab8c85d83da6f18ade171f557fd0201344c65ddf`; no Kandelo ABI change or
package pin update is warranted until a usable linker revision exists.

**2026-10-09 — Wasm host-function import and link boundary.** Published Go
fork commit `9c67cfe51e473c76f3a8d15020e9ca79106dcdcd`. The internal
linker now recognizes Kandelo Wasm C objects, loads defined C functions as
text symbols, carries their actual Wasm signatures and bodies into the final
emitter, and patches direct function/global index relocations when their
targets are available. The C-call shim's two `_cgo_topofstack` relocation
sites are verified against its real SDK object, including padded LEB rewrite;
the parser rejects relocations outside function bodies and unsupported kinds.
This is *not* a linked cgo program: a `CGO_ENABLED=1` build with the
uncommitted frontend and `-ldflags=-linkmode=internal` reaches the new loader
but stops on `runtime/cgo`'s `R_WASM_MEMORY_ADDR_REL_SLEB` relocation. That
object also carries data segments and references to `malloc`, `stderr`,
`fwrite`, and `abort`; Go's internal link reports unsupported dynamic-symbol
handling and undefined runtime/cgo symbols. The C-call shim itself invokes
`_cgo_topofstack`, a Go/C calling-convention transition not yet implemented;
`runtime.asmcgocall` and `runtime.cgocallback` still trap. The next work must
model C data/memory/global relocations and archive resolution, then implement
typed Go/C cross-call adapters and runtime/cgo thread attachment before the
C-call and callback probes can run. `cmd/link/...` tests pass; pure-Go
`kandelo`, `js`, and `wasip1` sample builds pass, and the Kandelo sample
validates with Wasm threads enabled. No new C-containing Wasm module was
produced or run on Node or Chromium. The `go-hello` package remains pinned
to `ab8c85d83da6f18ade171f557fd0201344c65ddf`; no Kandelo ABI or
package-pin change accompanies this incomplete link step.

**2026-10-09 — function-only Go/C module proof.** Published fork commit
`450543dc16b46ff49edb4865209bec6c2c4f323e` adds linker reachability
edges for C-to-C calls so dead-code elimination retains the callee. The
checked-in `tests/go/cgo/link-only/test-link.sh` packages a two-function
SDK C object into a cgo-free Go archive, links it with the fork's normal
internal Wasm linker, and validates the resulting Kandelo module with Wasm
threads enabled. `wasm-objdump` confirms both `c_target` and `triple` in the
Go module and a rewritten `call 7 <triple>` in `c_target`; the script passes
in the dev shell. The fixture deliberately only retains a C function value:
it does not execute a Go-to-C call, use `runtime/cgo`, stamp the output for
the Kandelo host, or run on Node/Chromium. This proves C function-body
import and C-to-C function-index relocation in a final Go module, **not**
cgo interoperability. The full `C.abs` build remains stopped at the
`runtime/cgo` memory/data/dynamic-symbol and Go/C adapter barriers above.

**2026-10-09 — initialized C data and executable C-only calls in a Go
module.** Published Go fork commit
`27f85fe4f40aeef2a7469fc9c70b2cf17044bbf6`. Its Wasm object reader
now decodes active data segments, segment alignment, data symbols, and
memory-address CODE relocations, with malformed-object checks. The internal
linker places initialized C data in Go's pointer-free static section,
resolves C memory addresses against that placement, and adds an internal
`__memory_base` global only when a retained C object needs it. This raises
the final module's static-data end before Kandelo allocates host channel
memory, rather than placing C data in Go's heap. Unsupported `reloc.DATA`
and element/global sections fail explicitly; C archives are not resolved.

`scripts/dev-shell.sh bash tests/go/cgo/link-only/test-link.sh` now links
C-to-C and C-data fixtures into a cgo-free Go Wasm module, validates it,
and invokes their C functions through the exported Wasm table on Node and
Chromium. The result is 10 from `c_target(5)` and 12 from `weighted(5)`,
whose second result reads initialized C static data. This is executable
C-in-Go-module evidence, **not** Go-to-C interoperability: no Go runtime
code calls C and no Kandelo process worker executes this module. Focused
`cmd/link/...` and `cmd/cgo` tests pass, pure-Go `kandelo`/`js`/`wasip1`
builds pass, the Kandelo sample validates, and the Kandelo ABI snapshot
check passes. The full `C.abs` link with the uncommitted cgo frontend now
stops at `adddynsym: unsupported binary format` for cgo exports and at
undefined `x_cgo_pthread_key_created` and
`x_cgo_notify_runtime_init_done`. The Go/C cross-call adapters, C runtime
symbols, archive resolution, callback/thread attachment, ZTS PHP embed
library, FrankenPHP classic-mode server, and WordPress demo are still
unimplemented. No package pin or Kandelo ABI version changes in this step.

**2026-10-09 — executable Go→C linker probe and next cgo boundary.** The
checked-in link-only fixture now has a Go Wasm assembly function that calls
`weighted(5)` through the linked C function table, checks the return value
12, and prints `GO TO C DATA PASS`. Its output is stamped with the current
ABI-contract digest before running as a Kandelo process. The Node runner
reported exit 0, that marker, empty stderr, and no host diagnostics. The
opt-in Chromium Playwright process-worker case passed. The older direct
Wasm-table Node/Chromium checks also passed. This proves a narrow same-signature
Go→C call and initialized C data in one process, **not** standard cgo or a
Go callback.

The adjacent fork's WIP commit
`24313139e5ac59367c16370d9a9dd17aa05c0679` now admits validated active
C element segments already covered by Go's full function-table initialization,
resolves C function-pointer slots and `__table_base`, and declares an
exported `__stack_pointer` only for retained C objects that need it. The
opt-in SDK `gcc_libinit.c` object test and focused `cmd/link/internal/loadwasm`,
`ld`, and `wasm` tests passed. With the WIP Wasm cgo frontend and Kandelo-tagged
POSIX `runtime/cgo` C files, the full `C.abs` build moves past the prior ELF
dynamic-symbol, type-index, and element-section failures. A raw C-ABI
`_cgo_topofstack` Wasm function resolves the next C shim call; the link now
stops at `pthread_mutex_lock`, an SDK libc archive member. No normal cgo
binary was emitted. The linker still cannot load SDK C archives or
`reloc.DATA` and cannot execute C wrappers without the `asmcgocall` adapter
and valid C stack state. Focused `cmd/cgo` and linker tests passed; pure-Go
`kandelo`, `js`, and `wasip1` browser-basic builds succeeded.
ABI review: no version bump; the optional `__stack_pointer` export is
already recognized by the host, and this step changes neither the syscall
channel nor an existing required import/export. The package source pin stays
at the last usable pure-Go revision until standard cgo runs.

**2026-10-09 — SDK archive selection reaches TLS and DATA relocations.**
Go fork commit `8e3a5871110968ebd8ce5b562a261b2b34b344d0` marks undefined
Wasm C relocation targets as external references, allowing Go's existing
lazy host-archive loader to select SDK libc members. With the explicit
`-libgcc=<this checkout>/sysroot/lib/libc.a` probe flag, `C.abs` now reaches
those members and reports unsupported `reloc.DATA` plus CODE relocation type
21 (`R_WASM_MEMORY_ADDR_TLS_SLEB`) in musl objects. Focused linker tests pass.
This is not an executable cgo module: the linker still needs DATA relocation,
TLS layout and per-thread TLS addressing, a normal SDK archive lookup path,
and the Go/C runtime adapters above. No Kandelo ABI or package-pin change.

**2026-10-09 — SDK DATA relocation milestone.** Go fork commit
`d2b748a1fb21dd8aaf4373f818af676bce68fe09` parses checked DATA
address relocations and emits Go static-data `R_ADDR` edges so SDK C pointer
initializers relocate with their target symbols. The `lite_malloc.o` SDK
object test and focused linker tests pass. The `C.abs` link with an explicit
SDK libc archive no longer reports DATA errors, but still fails on musl's
type-21 `R_WASM_MEMORY_ADDR_TLS_SLEB` relocations. This requires real
per-thread C TLS allocation and addressing, not treating TLS symbols as
ordinary static data. No executable cgo binary or FrankenPHP demo yet.

TLS design boundary: musl's `_Thread_local` objects use a per-instance
mutable `__tls_base` and LLVM TLS address relocations. The current Go linker
instead exports an immutable `__tls_base` whose value is the address of its
legacy syscall-channel handoff word. The host's pthread startup calls
`__wasm_init_tls(tlsOffset)` when that export exists and separately sets
`__stack_pointer`. A combined Go/C module cannot map LLVM TLS relocations to
the current Go `__tls_base` without corrupting this channel contract. The
next linker/runtime design must give C a distinct mutable TLS base and a
correct TLS template/init export (or migrate Go channel discovery to an
independent import), then validate main-thread, pthread, fork replay, and
Node/Chromium behavior. Do not map TLS offsets into Go static memory or
reuse the immutable channel handoff global as a shortcut.
Go fork commit `3e2250b11e1dcc561ee8d7c0f717dec84d0d392d` makes this
boundary explicit: it rejects TLS CODE relocations and TLS data segments
instead of silently placing thread-local bytes in Go static data. SDK
`abort.o` and `__wasm_tp.o` tests cover those cases. This does not implement
TLS or advance the runnable cgo gate.

**2026-10-09 — normal SDK archive discovery.** Go fork commit
`acc452fd67b8109a4eb9eaf5a7181c94f713af93` uses the existing Go lazy
host-archive loader with the libc path reported by `wasm32posix-cc`; the SDK
driver now answers `--print-file-name=libc.a` from its resolved sysroot. The
normal `C.abs` command, without manual linker flags, selects musl members
and fails explicitly on `__wasm_thread_pointer` TLS relocations. The parser
also decodes those relocations and C function-pointer table relocations, while
the linker still rejects TLS until it has real per-thread layout. The SDK
compiler query and 31 focused `cc.test.ts` cases pass; focused Go linker
tests pass. This changes no existing Kandelo ABI or package source pin.

**2026-10-09 — cross-object C data addresses.** Go fork commit
`2fcbf8c92b29590062c4208cfe89118dfc456c6b` collects defined C data
symbols across host objects and synthesizes immutable Wasm address globals
for cross-object `global.get` relocations. The checked-in link-only fixture
now links a third C object whose `cross_weighted(5)` reads `offset` from a
different C object and returns 13. Direct Wasm-table checks pass in Node and
Chromium. After ABI stamping, the Go assembly call runs in a Kandelo process
with exit 0, expected stdout, empty stderr, and no host diagnostics on Node;
the Chromium process-worker test passes. This remains a cgo-free linker
fixture, not `runtime/cgo` or a PHP embed. The added globals are internal to
C-containing modules, so no Kandelo ABI version or package pin change.

**2026-10-09 — data-only C archive members.** Go fork commit
`686572e8259d21dcd53468d7f2239dc163ac3e94` records C global data
symbols independently of retained C functions and keeps loaded C data
segments in the final module. The fixture moves `offset=7` into a fourth,
function-free object; both `weighted(5)=12` and `cross_weighted(5)=13` now
resolve its address. The direct table tests pass in Node and Chromium, and
the ABI-stamped Go process test passes in Node (exit 0, expected stdout,
empty stderr and diagnostics) and Chromium. Pure-Go `kandelo`, `js`, and
`wasip1` browser-basic builds pass. The normal `C.abs` build still stops at
the explicit musl TLS boundary. No ABI or package pin change.

**2026-10-09 — per-instance C TLS linker proof.** Adjacent Go fork commit
`76410fd` lays out C TLS segments in a bounded 64 KiB
per-thread template, relocates `R_WASM_MEMORY_ADDR_TLS_SLEB`, reserves a
separate main-thread TLS block, emits `__wasm_init_tls`, and calls it before
the Go `_start` entry. C TLS uses a mutable internal global distinct from
the exported legacy `__tls_base` channel handoff. The host already calls
`__wasm_init_tls` with each pthread's TLS/control page. The link-only
fixture now increments a real `_Thread_local` C value from Go and checks
that two Wasm instances over the same memory keep independent TLS bases.
`tests/go/cgo/link-only/test-link.sh` passes direct table checks in Node and
Chromium; the ABI-stamped Kandelo process exits 0 with `GO TO C DATA PASS`
and no host diagnostics on Node, and the Chromium process test passes.
This proves only the fixture's TLS initializer and instance isolation, not
musl or PHP TLS conformance, C-created pthread callbacks, or fork replay.

The same linker work now recognizes C function-pointer DATA relocations,
cross-object GOT-style data globals, weak function definitions, and exported
aliases instead of failing immediately on musl's TLS objects. A second
link-only fixture initializes a C function pointer in DATA, calls through
it from Go, and checks the result in Node and Chromium direct-table tests;
the ABI-stamped Kandelo process also exits 0 on Node and Chromium. Pure-Go
`kandelo`, `js`, and `wasip1` browser-basic builds pass. The normal
`CGO_ENABLED=1` `C.abs` build currently stops at unresolved
`_cgo_sys_thread_start`: Kandelo lacks the platform-specific `runtime/cgo`
thread-start implementation. It still emits no cgo binary. The package pin
stays at the earlier pure-Go fork revision; no ABI change or FrankenPHP demo
is claimed.

Next runtime/cgo boundary: `gcc_util.c` supplies `x_cgo_thread_start` and
calls an operating-system-specific `_cgo_sys_thread_start`, but the fork has
no Kandelo/Wasm implementation. This is not dead code: with `iscgo`,
`runtime.newm` calls `_cgo_thread_start` for new Ms. A platform C thread
start must connect C `pthread_create` to a Go-compatible entry, initialize
musl's thread pointer and C TLS, and capture a per-instance Kandelo channel.
Go's resumable Wasm function type is not the C ABI function-pointer type, so
calling a raw Go table entry as a C `void (*)(void)` is invalid. The same
adapter issue appears in `asmcgocall`, `cgocallback`, and `crosscall2`, all
still `UNDEF` in the fork's Wasm assembly. Do not resolve the linker error
with a no-op thread-start stub or an unverified direct table call.

**2026-10-09 — cgo executable glue and channel checkpoint.** Published Go
fork commit `ead1b2352595dbbb92d61bc82dff61c66c389050`. The Go fork
now keeps Kandelo-owned Go Ms on `newosprocKandelo` even when cgo is
enabled, instead of requiring `_cgo_sys_thread_start` for those Ms. The SDK
exposes its executable glue sources to toolchain consumers; the Go internal
linker compiles and loads the syscall, compiler-rt, and C++ runtime glue
through that SDK path. Its Wasm object reader retains typed function imports;
the final linker maps C `kernel.*` imports into its function index space and
creates an exported, per-instance mutable `__channel_base` for C while
preserving Go's existing channel handoff word. The shared host assigns both
when present. libc archive selection now recognizes TLS-only references,
and C function relocations retain referenced weak functions. These edits
move the normal `C.abs` build from `_cgo_sys_thread_start` to unresolved
`__fini_array_end` in musl's exit path. The link-only fixture now also
calls a C function that reads `__channel_base`; its ABI-stamped process
checks exit 0, `GO TO C DATA PASS`, empty stderr and host diagnostics on
Node, and the matching Chromium Playwright case passes. Direct-table
Node/Chromium checks, focused Go linker tests, SDK compiler tests, pure-Go
`kandelo`/`js`/`wasip1` browser-basic builds, and the ABI snapshot check
pass. There is still **no cgo executable**; the host typecheck encounters
unrelated `rootDir` errors from the OpenSSL package. The added optional
`__channel_base` export preserves existing Go and C process behavior, so no
ABI bump was made. The package pin remains on the earlier pure-Go revision.

**2026-10-09 — first standard-cgo Wasm link, runtime still blocked.**
Published Go fork commit `fbfffde21d6011b85f34837003c3734bbbfa04da`.
The linker now resolves absent weak C data to zero, rejects nonempty
constructor/destructor arrays instead of silently skipping them, and emits
a typed C-ABI `_cgo_topofstack` wrapper around Go's resumable function.
The Kandelo-tagged `runtime/cgo/setenv.go` is included. A forced normal
`CGO_ENABLED=1` build of `C.abs` now emits a Wasm binary, and
`wasm-validate --enable-threads` accepts the raw module. This is **not a
working cgo runtime**. `wasm-fork-instrument` rejects the instrumented
module with `expected valid result type`, so the host refuses the raw
artifact because its retained `kernel_fork` import requires full fork
instrumentation. A separate run of the previously emitted instrumented
artifact reached Go runtime initialization but failed `_cgo_setenv missing`;
the setenv build-tag fix has not been revalidated in a runnable process.
`asmcgocall` remains `UNDEF`; no standard Go-to-C call has executed.
Focused Go linker and cgo frontend tests pass. The Go fork binary is not
yet repinned in the `go-hello` package; ABI version is unchanged.

**2026-10-09 — mixed-module fork instrumentation and next runtime gate.**
The fork instrumenter's Binaryen post-pass now enables the Wasm features
found in its emitted module. Its prior no-flag invocation rejected the
mixed Go/C output despite a valid `target_features` section. The new
shared-memory CLI regression and the full `fork-instrument` crate tests
pass. The normal `C.abs` build, fork instrumentation, ABI stamp, and
Kandelo Node process launch now all complete, but the process traps at
`runtime.abort` during `runtime.main` after `_cgo_setenv` is present.
Disassembly places the trap at an indirect Go function call in cgo runtime
startup; `runtime/cgo/asm_wasm.s` still defines `set_crosscall2` and
`crosscall2` as `UNDEF`, and `runtime/asm_wasm.s` still leaves
`asmcgocall` and `cgocallback` undefined. This is not a passing C call;
there is no Chromium standard-cgo run or PHP embed yet. The narrow
Go-assembly→C process probe continues to pass Node and Chromium.

**2026-10-09 — first standard cgo calls on Node and Chromium.**
Published Go fork commit `6a04d1a208d9f4e506ed7a755d8a3aa74640231b`.
The adjacent Go fork now reserves an 8 MiB C stack below the heap, gives C
calls the `(i32) -> ()` Wasm signature, initializes the main musl thread
pointer before C work, and replaces the undefined `set_crosscall2` startup
routine with a typed C initializer. The C callback entry deliberately traps
until a real Go/C callback transition exists. `cmd/cgo` now pads the generated
argument frame at the Go/Wasm 8-byte boundary while retaining the SDK's
4-byte C pointer size; the focused frame-layout unit test covers a pointer
between scalars. The normal `C.abs` probe also calls C functions with three
scalars and with pointers in first and middle argument positions. A forced
build validates, fork-instruments, receives the current ABI stamp, and exits
0 with `CGO ABS PASS`, empty stderr, and no host diagnostics in both the
Node process and Chromium browser-host test. The C stack is only safe on the
main Go M; a C call from another Go M traps rather than sharing it.

The same-thread callback fixture now links and validates after retaining a
Go callback referenced through a C function-address global. Its Node run
still traps at the explicit `crosscall2` callback boundary. The combined
same-thread/pthread fixture also links and validates after retaining musl's
local function aliases, but has not passed its process gate. Full musl
startup, C-created thread attachment, callbacks, PHP ZTS, FrankenPHP,
and the WordPress demo remain unimplemented. The `go-hello` package still
pins the earlier pure-Go fork revision; there is no PHP/FrankenPHP
performance claim. Focused Go
`cmd/cgo`, `cmd/link/internal/loadwasm`, `cmd/link/internal/ld`, and
`cmd/link/internal/wasm` tests pass. Pure-Go Kandelo browser fixtures
rebuild, and all 20 opt-in Chromium Go-port tests pass, including the new
standard-cgo process case. Forced
`js` and `wasip1` browser-basic builds validate; the ABI snapshot check
passes. No PHP or POSIX conformance suite was run at this checkpoint.
Follow-up source tracing found that the host sets a child instance's C
`__stack_pointer` from `kernel_clone`'s stack argument, but native Go M
creation passes the g0 stack top. Reusing that as a C stack would corrupt
live g0 frames; a separate per-M C stack and thread-pointer initialization
must precede lifting the current trap. The C-to-Go trampoline must also
respect Go/Wasm's resumable scheduler convention across a synchronous C
callback. These are design constraints, not yet passing behavior.

**2026-10-09 — Go-created secondary M has its own C stack and musl state.**
Published Go fork commit `fc42f1a2d2a59d8d8c8d383bf95c77a8e387bc8f`.
The adjacent Go fork now allocates a distinct 8 MiB C stack for every
Go-created M in a cgo process and reclaims it when the M's g0 stack is
reaped. C state is kept behind a pointer so the native Go `m` still fits
its required allocation size class. `kernel_clone` receives that C stack
top instead of the live g0 stack top. The host sets the child's C stack
pointer and musl thread pointer; the child calls `__init_tp` before
entering the scheduler.
The standard cgo fixture locks the main Go M, makes Go-to-C calls across
four worker rounds, and verifies distinct `pthread_self()` values and
isolated `errno`. Forced build, Wasm validation, fork instrumentation,
and ABI stamp pass; the Node process exits 0 with `CGO ABS PASS`, empty stderr and no host
diagnostics. The focused Chromium browser-host test also passes. Focused
Go cgo/linker tests, forced `kandelo`, `js`, and `wasip1` pure-Go builds,
the ABI snapshot check, and all 20 opt-in Chromium Go-port tests pass.
This establishes Go-created M isolation for simple calls, not C-created
pthread attachment, callbacks, full libc startup, PHP ZTS, or WordPress.

**2026-10-09 — callbacks into Go-owned threads execute on Node and Chromium.**
Published Go fork commit `926b131d8d969757cbf0aed04c013c5c67e2868b`.
The Go fork now supplies a C-ABI `crosscall2` through a Go Wasm export
wrapper. It resumes the Go callback before returning to the still-live C
Wasm call stack, including when the callback yields to the scheduler. The
internal linker maps C relocations to that Go export and traverses Go
dependencies that C relocation loading had marked reachable before the
dead-code pass. The Go-owned callback fixture calls back into Go on the
main and a second Go M. In each callback it yields, waits on a timer, and
makes a nested Go-to-C call. Forced build, Wasm validation, instrumentation,
and ABI stamp pass; Node exits 0 with `CGO CALLBACK PASS`, empty stderr,
and no host diagnostics. The focused Chromium browser-host test and all
21 opt-in Go-port browser-host tests pass. Focused Go cgo/linker tests,
forced `js`/`wasip1` builds, and the Kandelo ABI snapshot check pass.

The combined C-created pthread fixture also links and validates but fails
its Node process gate. The new pthread instance has no Go `g`, Go stack
pointer, attached M/P, or per-M Go channel. Its call to the Go-owned export
wrapper hits `runtime.notInitialized`; the attempted Go diagnostic then
faults on an uninitialized channel. This is a known unsupported path, not
a passing callback or PHP-ZTS claim. Full libc startup is still missing.

**2026-10-09 — Go-led libc environment startup and mutation.** Published
Go fork commit `8aec831cb5d6d3b9f2a0bb1c9d18aeabd4f2929a`. The musl
overlay now isolates `__init_libc` from C process entry, allowing a Go-led
cgo program to initialize libc without pulling in the C runtime's `_start`
and incompatible constructor references. The Go runtime builds a
process-lifetime C-width environment and program-name table through its own
allocator, avoiding a separate C `mmap` allocation that collided with Go
heap growth. `runtime/cgo` passes that table to musl initialization. The
Kandelo `setenv_c`/`unsetenv_c` frames use 32-bit C pointers rather than
Go's 64-bit pointers. The standard cgo fixture verifies C `getenv` at
startup, Go `os.Setenv` and `os.Unsetenv` reflected in C, a Go GC, existing
scalar/pointer calls, and per-M `pthread_self`/`errno`. The raw Wasm
validates, fork-instruments, and receives the current ABI stamp; Node
exits 0 with empty stderr and diagnostics. The focused Chromium standard
cgo and Go-owned callback cases pass. Focused Go cgo/linker tests pass;
`fmt`, `net`, `os`, and `runtime` build with cgo disabled for `kandelo`,
`js`, and `wasip1`; the Kandelo ABI snapshot check passes. Follow-up Go
fork commit `00a02c890d2da06c82e5c359904bc160ddd3949c` adds Kandelo to
the socket-test helper build tags, closing the `net/internal/socktest.Sockets`
failure; forced cgo-disabled `go build -a std` now passes for `kandelo`,
`js`, and `wasip1`. The first narrow libc-test
attempt cannot resolve missing rootfs/builtin artifacts; provisioning and
rerun are required before claiming C-process conformance.

This is **not** complete libc startup: nonempty C constructor arrays still
fail in the linker, destructor execution is unproven, and secure-exec
behavior has not been exercised in a Go-led process. The C-created pthread
fixture still traps in `runtime.canpanic` with no Go `g`/stack/channel,
exiting 139 on Node; libc initialization did not attach that thread.

**2026-10-09 — Wasm C constructor metadata executes before Go main.**
Published Go fork commit `dbec8a76cecd897e5e09c3b8b5770194138202ef`.
The linker now parses standard Wasm `INIT_FUNCS` metadata, orders functions
by priority, emits one C-ABI function-pointer table, and runs it after
musl initialization. It provides the static `__dso_handle` required by C
destructor registration. A cgo-disabled mixed C/Go link with constructor
metadata now fails explicitly rather than silently skipping it. The
tracked cgo fixture checks two priority levels and a registered C
destructor that it dispatches explicitly. Its raw Wasm validates, fork-
instruments, receives the ABI stamp, and exits 0 on Node with
`CGO CONSTRUCTORS PASS`, empty stderr, and no host diagnostics. The focused
Chromium case and all 22 opt-in Chromium Go-port process cases pass.
The standard cgo and Go-owned callback probes were rebuilt under this
linker and pass on Node. Focused Go cgo/linker tests pass.

This does **not** prove automatic C exit-handler execution when Go exits;
Go's normal exit bypasses musl `exit`, as it does on native Go systems.
Explicit `.init_array`/`.fini_array` segments remain rejected, and secure
startup in a Go-led process is still untested. C-created pthreads still
cannot call Go; PHP ZTS and FrankenPHP remain unbuilt. The go-hello package
pin and Kandelo ABI version are unchanged.

**2026-10-09 — C-created pthread callback and shared memory allocator.**
The Go fork now exports a typed C-thread bootstrap and musl's
`__wasm_thread_init`, attaches a C-created pthread through `needm`, and gives
it a Go bootstrap stack and the thread's Kandelo syscall channel. The callback
probe calls Go twice on each C-created pthread, yields and waits on a timer in
each callback, and repeats from a second Go M. Its ABI-stamped, fork-instrumented
Wasm exits 0 on Node with `CGO CALLBACK PASS`, empty stderr, and no host
diagnostics. A focused Chromium process run also passes. This is a callback
milestone, not PHP or general cgo conformance.

Repeat runs exposed a second, independent race: the shared Go channel handoff
word could be overwritten when a C pthread and Go M started concurrently.
The cgo runtime now reads the per-instance C `__channel_base` global instead
of that shared word. Ten clean Node callback process runs and three serial
Chromium runs pass after the fix, all with empty stderr and no host
diagnostics. A parallel three-worker Chromium repeat timed out before this
race was fixed; it is not evidence of passing concurrent-process load.
The stronger Chromium run exposed a real allocator collision: Go's original
contiguous `sbrk` growth lost access to later pages when a C pthread mapped
above the break, and an 8 MiB Go-created-M C stack then failed. Kandelo Go
runtime allocations now use the same kernel `mmap`/`munmap` address manager as
C, including reserved Go arenas and fixed-address commits. The strengthened
callback passes on both hosts after that change. Forced cgo-disabled std builds
for `kandelo`, `js`, and `wasip1`, focused cgo/linker tests, and ABI snapshot
check pass. A narrow libc `env`/`argv`/`tls_init` conformance invocation could
not resolve the required rootfs/builtin artifacts; `./run.sh setup` finished
with unrelated `librsvg` and `rsvg-convert` package failures. The broader
browser run, libc conformance, PHP ZTS, and FrankenPHP remain separate gates;
no WordPress/FrankenPHP demo is running.

The `go-hello` package input now pins fork commit
`44b8926f137a7ea1887ded013f08e90cfc793523`; its resolver build remains
a separate validation gate.

Remaining work, in dependency order:

1. Finish Go/C runtime semantics: handle explicit `.init_array` and
   `.fini_array` segments where needed, validate secure-exec behavior,
   define C shutdown expectations, and review callback safety and the
   mixed-width `cmd/cgo` frontend beyond the passing probes.
2. Stress and harden C-created pthread attachment and shared Go/C memory
   allocation beyond the focused Node and Chromium callback process tests,
   including concurrent callbacks, reclaim, limits, and libc conformance.
3. Build PHP ZTS embed through the normal SDK/resolver, prove PHP lifecycle,
   port FrankenPHP classic mode, and deliver the WordPress VFS demo without
   nginx or PHP-FPM. Measure performance only after the Kandelo server runs.
4. Recheck ABI, pure-Go `kandelo`/`js`/`wasip1` regressions, package pin,
   browser end-to-end behavior, conformance, and Go-runtime guidance before
   closing the draft PR.

**2026-10-10 — static archive selection and PHP ZTS build in progress.**
The adjacent Go linker now consumes cgo library search flags and pulls C Wasm
archive members reached by C code relocations, including a second member
called by the first. The checked-in `tests/go/cgo/static-archive` fixture
builds through normal cgo, then runs with the Kandelo kernel in Node and
Chromium with empty stderr and host diagnostics. The linker changes are not
yet pinned by a registry package and do not establish that a large PHP archive
can link. A `php-zts` resolver recipe now requests PHP 8.3.15's static embed
SAPI, ZTS, and the WordPress extension set; its first source build is still
running. The existing `go-hello` package resolves and runs directly; its
`posix_spawn` package-launch test has passed repeatedly after one earlier
stalled attempt. Do not claim that stall fixed without a reproduced cause.

The immediate gates are: complete and verify the PHP ZTS resolver build;
link a minimal PHP embed lifecycle probe through the Kandelo Go/C linker;
then compile upstream FrankenPHP classic mode, serve a simple PHP request,
and only then integrate the existing WordPress VFS without FPM. Repeat Node
and Chromium request tests, conformance, ABI, and package checks before any
performance or completion claim. No Kandelo FrankenPHP demo URL exists yet.

**2026-10-10 — PHP embed lifecycle passes; FrankenPHP reveals mixed-width
cgo layout.** The `php-zts` resolver build completed. The Go linker now
imports the host's `__c_longjmp` tag and VM-interrupt function, resolves
object-local functions and weak/strong C data across the PHP, ICU, libc++,
curl, and libc archives, and preserves the Go-owned 8-byte `_cgo_yield`
storage required when C pointers are 4 bytes. The checked-in
`tests/go/cgo/php-embed` fixture builds through the SDK and package resolver,
validates and fork-instruments its roughly 40 MiB raw module, and executes
PHP init, evaluation, and shutdown in Node and Chromium with exit 0, both
output markers, empty stderr, and no host diagnostics. PHP Fibers' always-
compiled ucontext references link only against Kandelo's documented
abort-on-use unsupported library; the probe does not use Fibers.

Upstream FrankenPHP v1.11.0, with hot reload and Mercure excluded, now
*compiles and links* into a Kandelo Go/C module in a scratch checkout. Its
first Node classic-mode attempt failed before request handling: `Version()`
received a C struct with 4-byte pointer fields that `cmd/cgo` generated as
8-byte Go pointer fields, causing a huge invalid `GoString` allocation.
A scratch C-accessor change removed that immediate layout mismatch; the
resulting module is being tested. The same dependency graph also exposed
`golang.org/x/sys/cpu`'s zero cache-line padding for generic Wasm, which
breaks Otter's compile-time sizes on a threaded Kandelo target. Its
Kandelo-only 64-byte adaptation is still scratch, not a reviewed package
patch. The PHP ZTS recipe has a revised header macro patch rebuilding in
the resolver; neither a FrankenPHP package nor WordPress demo is published.

**2026-10-10 — FrankenPHP classic executes a PHP request on Kandelo.**
Fork commit `471e7821508c58ed5d2022e52adf3abac3539e87` adds cgo static
archive selection, Wasm tag imports, C data/function symbol fixes, foreign
callback C-stack reentry, and byte-exact exported callback frames. Before the
frame fix, the C-created PHP thread received a null script pointer even
though its Go callback returned a pinned string; a callback fixture now
checks a mixed scalar/pointer result on a C-created pthread. The PHP ZTS
resolver revision 2 removes a header macro redefinition that upstream
FrankenPHP treats as an error. The embed lifecycle fixture passes Node and
Chromium against that revision, as do the callback and static-archive browser
gates. Focused Go cgo/linker tests and forced cgo-disabled `kandelo`, `js`,
and `wasip1` standard-library builds pass.

Upstream FrankenPHP v1.11.0, with a local `x/sys` cache-line adaptation and
C accessors for mislaid pointer-bearing PHP structs, now initializes its
embedded PHP runtime and handles a classic-mode PHP request in the Kandelo
Node host: `FRANKENPHP CLASSIC PASS`, exit 0. The first PHP execution had
faulted while reading a `zend_llist` header field directly through Go's
64-bit pointer layout; C accessors remove that mismatch. Request-info
fields need the same treatment for WordPress and are being applied in the
package patch. A new `frankenphp-classic` source package and a WordPress
profile sharing the existing VFS are in progress, not yet validated or
published. There is still no running demo URL or performance result.

**2026-10-10 — resolver-built FrankenPHP serves HTTP on both hosts.**
The `frankenphp-classic@1.11.0` source recipe builds the v1.11.0 Go library
and PHP ZTS archive through the pinned Kandelo Go fork. The package carries
scoped C-accessor patches for mixed-width PHP structs and registers CGI
variables through scalar/pointer C calls rather than a pointer-bearing
struct-by-value argument. A first real HTTP request exposed the missing
Kandelo build tag on Go's Unix MIME registry; fork commit
`0d3e83bce3f6329d80074361a7c00a9a3c7ba89c` fixes that runtime/stdlib
gap. The package recipe now fork-instruments and ABI-stamps the produced
module explicitly; `install_local_binary` did not stamp it automatically.

Resolver revision 6 succeeds. Its Node test requests a rewritten PHP URL
and a static text asset through `fetchInKernel`: both return 200, PHP sees
the original request URI and script name, headers are correct, and host
diagnostics are empty. The matching Chromium browser-host test passes.
This is actual embedded PHP served by FrankenPHP, not FPM or a proxy. The
package patch currently makes 23 separate Go-to-C calls for CGI variables;
there is no performance claim until the application is measured. The
WordPress profile has been added to the existing VFS recipe, but its
full source-only image build and end-to-end requests remain in progress.

**2026-10-10 — WordPress VFS exposes a foreign-callback stack boundary.**
The existing shell/WordPress VFS builder, with FrankenPHP as an alternate
dinit service, produces a 266 MiB raw / 50 MiB compressed image and
preinstalls WordPress SQLite. A first in-kernel homepage request reached
FrankenPHP's PHP output callback, then aborted during Go stack growth:
the synthetic C-created-thread callback frame exposed a C pointer as its
return PC. Fork commit `24e918744d0fe8d932e120654dcfba822d7acfd5`
marks that frame as the stack top. A strengthened callback fixture now
forces stack growth on a C-created pthread and passes in Node and Chromium.
The next WordPress request reached PHP output but exposed a second stack
boundary: the callback adapter restored an absolute idle stack pointer
after Go had relocated that stack. Fork commit
`5cf3a87e416c6d6c5f05a27fd74e45fce3a5aec8` preserves the offset
from the stack high bound instead. The fixture now repeats deep callbacks
on one C pthread and passes in Node and Chromium. `frankenphp-classic`
revision 8 and `go-hello` revision 6 pin both fixes.
The WordPress end-to-end rerun against the rebuilt binary remains open;
this checkpoint is not a working WordPress or performance claim.

**2026-10-10 — WordPress PHP requests pass on Node and Chromium hosts.**
The direct image builder now embeds revision-8 FrankenPHP alongside the
existing nginx/PHP-FPM stack, adds a separate dinit target and profile,
and gives embedded PHP its own `PHPRC` so it does not attempt to load
FPM's dynamic OPcache module. The preinstalled SQLite image responds to
`GET /` in the Node kernel host with HTTP 200 and a 68 KiB WordPress
homepage, with no host diagnostics. A direct Chromium kernel-host test
boots the same VFS, gets HTTP 200 for the homepage and WordPress login
form, and shuts down dinit without diagnostics. These are application
requests executed in FrankenPHP classic mode, not FPM or a proxy.

The full WordPress package build is still resolving the canonical shell
dependency tree. This invocation was later found to use the default resolver
policy, not `source-only-v1`; see the correction below. Its prior projection
is stale, so the
gallery/UI test cannot load the image yet; the direct browser-host test
uses the built VFS bytes without bypassing the kernel. Pending gates are
the resolver-built image, gallery login flow, durable running demo URL,
ABI and package pin checks, and any defensible performance comparison.

**2026-10-10 — Direct WordPress admin flow passes.** The Node-host
FrankenPHP demo boots the verified direct-build VFS through dinit and serves
the preinstalled site at `http://localhost:3000/`. A Chromium Playwright
session navigated to `/wp-login.php`, submitted the image's preinstalled
admin credentials, and reached the real WordPress admin UI. The direct
Chromium kernel-host test independently received the homepage and login
form from embedded PHP. Neither path starts nginx or PHP-FPM. This is an
application-behavior check, not an application-performance comparison.

The remaining gates, in order, are:

1. Complete the source-only WordPress resolver build, including its
   canonical shell dependency tree; then rebuild with the current package
   revisions and verify the projected VFS image.
2. Run the Node demo without a direct-image override, the browser gallery
   profile and admin flow, and the merge-gate profile test against that
   resolver-owned image.
3. Recheck the package pin, ABI snapshot, and relevant Node/Chromium probes;
   record any conformance suites that remain unrun or blocked. Compare
   WordPress application performance only with measured, comparable runs.
4. Keep the draft PR and this log aligned with the evidence. Broader Go/C
   conformance remains distinct from the WordPress demo: explicit C
   initializer/finalizer handling, secure-exec and C shutdown semantics,
   general callback/thread stress, and wider libc/POSIX coverage have not
   been established by these focused probes.

**2026-10-10 — Shell dependency Rust compiler unblocked.** The first full
WordPress resolution, inadvertently run under the resolver's default policy,
built many canonical shell packages but stopped when
SpiderMonkey's Mozilla configure selected the user's Rustup `stable`
compiler after entering its external source directory. That compiler lacked
the Wasm standard library; it was not a Go/FrankenPHP failure. The
SpiderMonkey recipe now exports the absolute compiler selected by Kandelo's
pinned dev shell. Its revision-15 package resolver build succeeded under the
default policy.
A default-policy WordPress retry then stopped at a browser bundle that
requires the source-only verified-source handoff. The WordPress resolver was
restarted with `WASM_POSIX_RESOLUTION_POLICY=source-only-v1` and the current
package revisions; the projected image and browser gallery checks remain
pending. Neither failed default-policy run is source-only evidence.

**2026-10-10 — Source-only FrankenPHP package stamping fixed.** The first
actual source-only WordPress resolution built through its shell and PHP ZTS
dependencies, then rejected `frankenphp-classic` because its recipe had
already stamped the Wasm with `kandelo.abi.contract`. The source-only resolver
owns that stamp and correctly refuses a duplicate. The recipe now stamps
only for default-policy/direct builds; revision 9 resolves under
`source-only-v1`. A new WordPress resolution is running against that verified
dependency. The revision-9 source-only artifact independently served PHP and
static HTTP in Node and Chromium with no host diagnostics. This fixes package
distribution and preserves the request behavior already established; it is
not WordPress gallery validation.

**2026-10-10 — Source-only WordPress gallery and admin pass.** Revision-21
WordPress resolved under `source-only-v1` with revision-9 FrankenPHP, then
`xtask bootstrap wordpress` published the verified image. The resolver-owned
image passes a Node demo admin login with no image override, a direct
Chromium kernel-host PHP request, the focused browser profile admin login,
and the gallery Launch/admin merge-gate case. The browser tests use the
product's actual Vite image URL; an earlier synthetic `page.route` URL was
intercepted by the service worker and returned HTML instead of the VFS, so
it was not valid end-to-end evidence. The canonical source-only projection
required current ownership for other authored service assets before Vite
could load any gallery machine; the selected service products and the
remaining MariaDB test/Wasm64 artifacts were published for that test.

`./run.sh browser` triggers the entire local-build set and stopped on two
unrelated package failures outside the selected WordPress/service closure.
Those failures are not evidence against FrankenPHP; they also mean this
full-tree command is not a passing validation claim. Restore the selected
projection after that failed run, then use the direct Vite server to keep a
live browser demo available. No WordPress performance comparison has been
made, and broader Go/C conformance gaps from the list above remain open.

**2026-10-10 — FrankenPHP demo integration gates complete.** After restoring
the selected source-only projection, all 149 authored browser imports that
have physical files have current projection ownership. The final focused
Chromium run passed three cases in one worker: the real product-profile
homepage/admin flow, Gallery Launch/admin flow, and Node-host demo/admin
flow. The test now resolves the product URL through the same fixture as the
gallery, rather than mocking a service-worker-intercepted request. The
source-only FrankenPHP artifact independently served PHP and static HTTP in
Node and Chromium; the source-only WordPress image served requests in the
direct Chromium kernel host. ABI snapshot, the Go cgo frontend test, pure-Go
`kandelo`/`js`/`wasip1` std builds, and libc-test `env`, `argv`, and
`tls_init` cases pass. These are focused gates, not full Go or POSIX
conformance.

The resolved Node demo runs at `http://localhost:3000/` and the direct Vite
browser app at `http://127.0.0.1:5401/`; Gallery can launch "WordPress on
FrankenPHP" from the same `wordpress.vfs.zst` used by the existing
nginx/PHP-FPM profile. `./run.sh browser` still cannot start because its
entire local-build set fails on two unrelated packages, so this live Vite
server was started directly after successful selected-product builds. A
measured WordPress performance comparison and the broader Go/C runtime
semantics (explicit init/fini arrays, secure-exec, automatic C shutdown,
general callback/thread stress and wider conformance) remain open.

**2026-10-10 — Go/cgo secure-startup gate.** A new Go/cgo child is launched
through a real set-ID VFS exec and a subsequent `posix_spawn`, both preserving
and resetting effective IDs. On Node and Chromium it observes the exact
kernel-owned secure marker through musl `issetugid`, `getauxval(AT_SECURE)`,
and `secure_getenv`; each result agrees with the expected image state, with
empty stderr and host diagnostics. This closes the focused Go-led secure-exec
startup gate, not a broad Go environment-security audit. The remaining order
is explicit `.init_array`/`.fini_array` layout and C shutdown expectations;
then general foreign-thread/callback and shared-memory reclaim/limit stress;
then broader Go, libc, and POSIX conformance and a measured WordPress
performance comparison. The FrankenPHP demo integration gates above remain
complete. The draft PR remains the single review target.

**2026-10-10 — metadata-only C init arrays and C-owned shutdown.** Fork
`b2ffde7ef08137e962f954b17b74603badf67d28` accepts the zero-filled
`.init_array.150` segments LLVM emits only when matching `INIT_FUNCS`
metadata supplies the callable constructor. It still rejects nonzero,
relocated, exported, or referenced array data. The constructor fixture now
checks priority-150 dispatch before the existing priority-200/300 functions
on Node and Chromium. A separate mode enters C `exit(0)` and verifies the
registered destructor runs on both hosts with empty stderr/diagnostics. Go
main return is not claimed to dispatch C exit handlers; LLVM itself rejects
`.fini_array` sections at compile time. `cmd/link/internal/ld`,
`cmd/link/internal/loadwasm`, and `cmd/cgo` tests pass. `go-hello` revision 7
and `frankenphp-classic` revision 10 pin the new fork commit; the source-only
package rebuild and WordPress regression are the next distribution gate.

**2026-10-10 — bounded concurrent foreign-thread stress.** The C-created
pthread callback fixture now runs three simultaneous callbacks for eight
rounds, freeing C allocations and forcing Go allocation/GC between rounds.
The stamped program passes Node and Chromium process gates with empty stderr
and host diagnostics. This exercises contention and a repeated reclaim path,
but not the configured thread-slot ceiling, long-running PHP worker churn,
or broad allocator/POSIX conformance. The Go fork itself is unchanged by this
fixture; package distribution still requires the resolver-owned WordPress
image from the new fork pin.

**2026-10-10 — pinned fork package regression.** The source-only resolver
built `go-hello` revision 7 and WordPress revision 21 with
`frankenphp-classic` revision 10 from fork `b2ffde7`; `xtask bootstrap
wordpress` republished the new image. Three focused Chromium cases then
passed in one run against that image: product-profile homepage/admin login,
gallery Launch/admin login, and the Node-host counterpart admin login. This
also verifies that metadata-only initializer support does not regress the
FrankenPHP WordPress route. Go package VFS launch, ABI snapshot, wider
conformance, performance comparison, and restarting the live demo on the new
projection remain as final handoff checks.

**2026-10-10 — resolver and live-demo handoff.** The source-only projection
now contains revision-7 `go-hello` and the new WordPress image. The resolved
Go package launches from a VFS child in Node and Chromium; Node reports zero
forks, and both hosts have empty stderr/diagnostics. ABI snapshot and pure-Go
`kandelo`/`js`/`wasip1` standard-library builds pass. The Node WordPress
demo restarted without an image override on the new projection and serves
homepage and login HTTP 200. The browser Vite app serves the new source-only
image and its WordPress/FrankenPHP profile loads in a manual Chromium session.
The broader Go browser suite is running; no application performance comparison
or complete Go/POSIX conformance claim is made.

**2026-10-10 — full focused Go browser suite and exploratory WordPress timing.**
All 27 Chromium Go-port cases pass, including process, network, stdlib,
PHP-embed, cgo callbacks, constructor order, C-owned exit, and the new
concurrent callback stress case. The `go-hello` revision-7 VFS launch also
passes Node and Chromium, with zero Node forks. A focused libc-test run passes
`pthread_mutex`, `pthread_cond`, and `pthread_tsd` (3/3); `tls_align` was
excluded because its companion `.mk` DSO is skipped by the runner and an
explicit invocation cannot link its helper. This is not a full libc-test run.

For a bounded browser-only application comparison, Chromium booted each
profile from the same source-only `wordpress.vfs.zst`, then fetched 15 dynamic
homepage URLs per profile (three warmups, 12 measured, full response body),
twice in alternating order. The two nginx/PHP-FPM sample medians were 713 and
721 ms; FrankenPHP classic's were 744 and 737 ms. The raw 48 samples are in
`.context/wordpress-stack-bench.log`, and the local bench script is in
`.context/wordpress-stack-bench.mjs`. This single-machine, sequential,
browser-proxy measurement shows no demonstrated FrankenPHP latency advantage;
it is not a throughput, cold-start, Node-host, or statistically powered
comparison. No general performance claim follows from it.

Remaining before **complete Go/C support** can be claimed: distinguish and
implement real initializer/finalizer array data if a source needs it (LLVM
currently rejects `.fini_array`); decide and test C exit-handler policy when
Go main returns; exercise thread-slot ceiling, extended PHP worker churn,
allocation limits, and callback races; run broader Go stdlib, libc-test,
Sortix/POSIX and cross-browser conformance. The FrankenPHP demo itself is
integrated and running; these remaining items are platform-wide rather than
demo-specific. The unrelated full-tree `./run.sh browser` failures in
`librsvg` and `rsvg-convert` remain a separate build issue.

**2026-10-10 — broader libc functional coverage.** The full musl libc-test
`functional` runner completed: 62 PASS, zero unexpected FAIL/BUILD/TIMEOUT,
and one expected `pthread_cancel` XFAIL for asynchronous cancellation that
Wasm cannot preempt. This supersedes the narrow three-case pthread run as
libc functional evidence, but is not the libc regression/math categories,
the Open POSIX Test Suite, Sortix os-test, or full Go standard-library tests.

**2026-10-10 — Open POSIX runner preflight and suite pass.** The first full
Open POSIX invocation timed out before guest execution because every test
launched a cold release `xtask` build inside its 30-second watchdog. The
runner now prepares the exact release checker once before entering per-test
timeouts and exports its path; its focused `asctime`/`clock` retry passed
3/3. The corrected full Open POSIX Test Suite then completed 179 cases:
174 PASS, three documented XFAIL (`mlock` and `munmap`), two unsupported
scheduler-priority SKIP, and zero unexpected failures, build errors,
unresolved cases, or timeouts. This is real C/POSIX conformance evidence,
not full Go stdlib or cross-browser POSIX conformance. Libc regression/math
and Sortix coverage remain separate.

**2026-10-10 — complete available musl libc-test categories.** The full
`regression` runner completed 59 PASS, two documented XFAIL, and one
`pthread_cond-smasher` FLAKE-PASS (62 total); the full `math` runner completed
185 PASS and 14 documented XFAIL (199 total). Together with `functional`,
the three categories ran 324 cases: 306 PASS, 17 documented XFAIL, and one
FLAKE-PASS, with zero unexpected failures, build errors, or timeouts. These
are C/libc conformance suites, not Go standard-library tests. They do not
erase the documented XFAIL boundaries.

**2026-10-10 — Go browser parity and shutdown policy.** The focused Go/C
runtime suite now runs in Chromium, Firefox, and WebKit. Its 31 cases per
engine include Go-owned return, `os.Exit`, C `exit(0)`, and C `_exit(0)`.
Go-led exits and C `_exit` bypass C handlers; C `exit(0)` dispatches them.
The four modes also pass in Node. The full browser matrix passed 93/93;
a three-engine smoke test also passed with a fresh Playwright-owned Vite
server. This intentionally follows Kandelo's
Linux-style raw `exit_group` Go runtime path, not observed native macOS
Go/cgo C-handler behavior. It is focused lifecycle evidence, not full Go
stdlib conformance or cross-engine WordPress behavior.

**2026-10-10 — Go filesystem/ownership conformance and refreshed packages.**
Fork commit `aff9084745912a3b0aedcda1214a0c809c3ace25` fixes Kandelo
directory enumeration, seek position, zero-inode entries, kernel-owned mode
bits, and path/fd/symlink ownership syscalls. Selected upstream Go `os`
(14 tests) and `syscall` (two tests) now pass on Node, Chromium, Firefox,
and WebKit. Pure-Go `kandelo`, `js`, and `wasip1` standard-library builds and
focused `cmd/cgo`/`cmd/link` host tests pass. These are selected upstream
cases, not the complete Go standard-library suites.

The source-only `go-hello` revision 8 and `frankenphp-classic` revision 11
packages now pin that fork commit. Both resolver bootstraps pass, including
the revision-21 WordPress image. The `go-hello` package VFS launch passes
Node and all three browsers (3/3 browser); direct FrankenPHP PHP/static HTTP
passes Node and all three browsers (3/3 browser). The WordPress/FrankenPHP
homepage, admin, and Gallery browser flow passes 3/3 in Chromium on that
image. The focused Go browser suite passes 33 cases per engine, 99/99 total,
including the selected upstream `os` and `syscall` cases. This supersedes the
31-per-engine checkpoint above. The live Node demo serves HTTP 200 at
`http://localhost:3000/`; the source-only browser image is served from the
Vite app at `http://127.0.0.1:5401/`. Neither the exploratory timing nor
these correctness gates show a FrankenPHP performance advantage.

**2026-10-10 — Go open-flag ABI and wider upstream `os` coverage.** A wider
upstream `os` run revealed `TestMkdirAll/InRoot` returned the wrong error
path: the fork's `O_DIRECTORY` and `O_NOFOLLOW` values did not match Kandelo's
kernel flags, so a regular file could be opened as an intermediate directory.
Fork commit `e2cb38f430915ba703332d91eb9950643c89a84e` aligns those
flags and `O_SYNC` with the Kandelo/musl constants. The selected `os` set now
includes 30 upstream top-level tests, including root-relative `MkdirAll`,
recursive removal, symlink/rename, file read/write, temporary paths,
directory seek/rewind, and root-relative open/symlink containment. All 30
pass on Node; two AF_UNIX-dependent subcases skip because that socket family
is unsupported. The combined probe passes on Chromium, Firefox, and WebKit
(3/3). The VFS supplies the upstream test files/directories these tests
normally find in Go's source checkout; the
initial missing-fixture failures were not platform failures. This does not
establish full upstream `os` conformance. Package revision 9 of `go-hello`
and revision 12 of `frankenphp-classic` pin the new fork commit; their
source-only bootstrap and WordPress image validation are pending below.

**2026-10-10 — refreshed fork/package/demo validation.** The dev-shell Go
fork rebuild succeeds. Pure-Go `kandelo`, `js`, and `wasip1` standard-library
builds and focused `cmd/cgo`, `cmd/link/internal/ld`, and
`cmd/link/internal/loadwasm` host tests pass. The full focused Go browser
matrix passes 99/99 (33 per engine) with the corrected open flags and 30
selected upstream `os` tests in its filesystem probe. Source-only bootstrap
of `go-hello` revision 9 and WordPress revision 21 succeeds; the latter
includes `frankenphp-classic` revision 12. The resolved Go package VFS
launch passes Node with zero forks and passes Chromium, Firefox, and WebKit
(3/3). Direct FrankenPHP PHP/static HTTP passes Node and all three browsers
(3/3). The WordPress/FrankenPHP direct kernel-host request, preinstalled
homepage/admin profile, and Node-host admin counterpart pass 3/3 Chromium
on the current source-only image. A first UI run failed before boot on a
Vite `react-dom` optimizer export mismatch while another Vite server was
active; stopping the concurrent server, forcing source-only dependency
optimization, and rerunning the same 3 cases passed. This was not evidence
of a Go/FrankenPHP process failure.

The live Node homepage and login return HTTP 200 at
`http://localhost:3000/`, and the refreshed source-only browser app at
`http://127.0.0.1:5401/` reaches the `wordpress-frankenphp` profile with
status Running and the WordPress homepage. The exact image URL is stored in
`.context/frankenphp-live-url.log`; its asset digest is
`a11cb3b5f83f3314fa6da2e9414f6bfd625d5920dbf4e7bf4995dc779d6a3daa`.
The current screenshot is `.context/frankenphp-browser-demo.png`. These
correctness results do not turn the exploratory timing into a performance
advantage or full Go/POSIX conformance claim.

**2026-10-10 — declared Go thread-slot ceiling.** An additional linker
fixture sets `-kandelothreadslots=1`. The Go runtime requests another M
before `main`, so the kernel host rejects the second allocation with an
explicit `pthread slot limit exhausted (limit=1, active=1)` diagnostic;
Go exits nonzero with `newosproc: kernel_clone failed`. The negative boundary
passes the Node runner and Chromium, Firefox, and WebKit focused tests
(3/3), without hanging or silently exceeding the declared control arena.
This closes the one-slot exhaustion case, not upper-count bounds, extended
thread churn, or allocator pressure. Rebuilding all 21 opt-in Go browser
fixtures through the standard ABI-stamping script succeeds, and the full
suite including the ceiling case passes 102/102 (34 per engine) against the
same live source-only Vite server.

**2026-10-10 — wider `os.Root` sweep and POSIX remove-dot fix.** A Node run
of upstream `TestRoot*` found genuine shared-platform gaps beyond the
selected `os` cases: SharedFS rounds `Chtimes` to milliseconds, `linkat` does
not preserve symlink-source hard-link behavior, renaming an opened directory
breaks later fd-relative lookup because its OFD remembers a pathname, and
some root-relative rename/dot cases disagree with upstream Go. At this sweep,
`TestRootDirFS` lacked its source-tree testdata in the VFS; the follow-up
below staged the fixture and uncovered a separate Go channel defect.
The concrete `TestRootRemoveDot` failure was a Kandelo syscall defect:
`unlinkat(..., AT_REMOVEDIR)` could canonicalize `.` to the opened root and
remove it. `runtime-core` now rejects a final `.` with EINVAL for `rmdir`
and `unlinkat(..., AT_REMOVEDIR)` before host mutation. The focused Rust
regression, all 1,715 runtime-core unit tests and six doc-tests, Sortix
`basic/unistd/rmdir`, and upstream Go `TestRootRemoveDot` pass on Node. The
selected upstream `os` set is now 31 top-level tests and passes on Node;
its combined browser probe passes Chromium, Firefox, and WebKit (3/3) with
the rebuilt kernel. The full upstream `os.Root` sweep still fails on the
other gaps above; it is not claimed as conformance. The symlink-source
`linkat` failure is a Node/macOS scratch-mount boundary: the test's `/tmp`
is a host-filesystem mount despite the root image being SharedFS, and
`HostFileSystem` calls Node's `fs.linkSync`, which follows a source symlink
on macOS. A native no-follow host operation or equivalent backend design
is needed; changing Go's test expectation would hide the platform gap.
The source-only WordPress image was republished after the
kernel change, and the direct-kernel, browser UI, and Node-host
FrankenPHP Chromium checks passed 3/3. The rebuilt-image Node server returns
HTTP 200 for the homepage and login page. The full focused Go browser
matrix passes 102/102 (34 each on Chromium, Firefox, and WebKit) against
this kernel. The live source-only browser profile also reaches Running and
renders the WordPress homepage, using the republished image whose SHA-256 is
`e20fb208d2732e4df062f2e1d28ad63852ed6f4663927dd53796110a9ece9c7b`.

**2026-10-10 — `os.Root` DirFS seek follow-up.** The upstream
`TestRootDirFS` source-tree fixture has only three empty files, which are now
staged in the Node and browser test VFS images. This exposed a real Go fork
channel-argument defect: `syscall.fd_seek` sent a full `int64` offset in one
slot and put whence in the next, but Kandelo `lseek` expects separate 32-bit
low and high offset slots before whence. `Seek(0, SEEK_CUR)` consequently
returned `1<<32` after an empty-file EOF read. Fork commit
`7c639cb7fd655cfdfa600b79c8ba1fbdf06cb502` fixes the argument split;
`go-hello` rev10 and `frankenphp-classic` rev13 pin it, and WordPress rev22
rebuilds with that dependency. Upstream `TestSeek` and `TestSeekError` also
pass on Node, covering large offsets, negative offsets, and ESPIPE. The
selected upstream `os` set is now 34 top-level tests and passes on Node;
its initial 32-case browser probe passed Chromium, Firefox, and WebKit
(3/3). Including `TestSeek` initially exposed an independent browser
SharedFS defect: it rejected logical `lseek` positions above the filesystem's
maximum writable file size, even though no file data was allocated. SharedFS
now accepts safe-integer nonnegative logical seeks while retaining EFBIG on
writes beyond its storage limit. The targeted SharedFS unit file passes
10/10, and the complete 34-case `os` probe passes Chromium, Firefox, and
WebKit (3/3). The full broader `os.Root` sweep still
has the timestamp, host-symlink-link, dirfd-after-rename, and rename-dot
gaps listed below. Rebuild and revalidate the source-only WordPress image
after the new fork pin before claiming the browser demo at this checkpoint.

**2026-10-10 — published seek follow-up and demo verification.** Source-only
bootstrap published `frankenphp-classic` rev13, WordPress rev22, and
`go-hello` rev10 from the pinned fork. The complete focused Go browser
matrix passed 102/102 (34 per Chromium, Firefox, and WebKit) with the new
34-case upstream `os` selection. Resolved `go-hello` launches through the
Node VFS with zero forks; direct FrankenPHP PHP/static HTTP passes Node and
all three browsers (6/6 combined with the Go package launch). Rebuilt
WordPress/FrankenPHP direct kernel-host, browser homepage/admin, and Node
counterpart pass Chromium 3/3. The live Node homepage and login both return
HTTP 200; the live source-only browser profile reaches Running and renders
WordPress. The WordPress VFS SHA-256 is
`5023ff29fa5c7b505896b16625af0d308aa7d5a9ca5a5ee47c06f6aaae7ab284`.
A fresh full upstream `TestRoot*` Node sweep passes `TestRootDirFS` and
`TestRootRemoveDot`; its only four failing top-level tests are
`TestRootChtimes`, `TestRootLinkFrom`, `TestRootConsistencyRename`, and
`TestRootRenameAfterOpen`, matching the four filesystem gaps below.
A concurrent full Open POSIX rerun was invalidated when package bootstrap
regenerated its program index mid-suite; its apparent failures were not
platform-conformance evidence. A subsequent clean full run against this
kernel and host completed with 174 PASS, 3 expected XFAIL, 2 SKIP, and zero
unexpected failures (179 total).

**2026-10-10 — rename-from-dot parity.** `TestRootConsistencyRename` showed
plain `os.Rename("dir/.", "dir/other")` could succeed after Kandelo's
component walker canonicalized `dir/.` to `dir`, while root-relative
`renameat` correctly returned EINVAL. Both `rename` and `renameat` now reject
a final `.` before host mutation. The Rust regression passes; all 1,716
runtime-core unit tests and six doc-tests pass. Upstream
`TestRootConsistencyRename` passes on Node, as does the 35-case selected
`os` set; its focused browser probe passes Chromium, Firefox, and WebKit
(3/3). A fresh full upstream `TestRoot*` Node sweep now has exactly three
failing top-level tests: `TestRootChtimes`, `TestRootLinkFrom`, and
`TestRootRenameAfterOpen`. The ABI snapshot check passes. The source-only
WordPress image must be republished and revalidated after this kernel change.

The source-only WordPress bootstrap subsequently republished the image at
`local-binaries/source-only-v1/programs/wasm32/wordpress.vfs.zst` (SHA-256
`c01e8902413bf116467d0aca1bbb8eab856a0964fb8bd436e501e01a223a2fad`,
52,708,842 bytes). Browser and direct HTTP checks against this exact image
remain the release gate. The rebuilt-image Node demo subsequently served
the homepage and login with HTTP 200 and redirected `/wp-admin/` to login
with HTTP 302. The resolved Go package VFS launcher again exited 0 with
zero forks, and direct FrankenPHP again served PHP and a static asset with
HTTP 200 and no host diagnostics against the rebuilt kernel.

The full focused Go browser matrix passes 102/102 (34 probes each in
Chromium, Firefox, and WebKit). Resolved Go package launch and direct
FrankenPHP PHP/static HTTP pass 6/6 across those browsers. The focused
Node HostFileSystem path-resolution suite passes 9/9; the ABI snapshot
check passes after the commit.

The rebuilt-image WordPress/FrankenPHP direct kernel-host request, browser
homepage/admin flow, and Node-host admin counterpart pass 3/3 in Chromium.
The first UI run loaded a stale Vite optimized React dependency and showed
a blank page; moving the generated `.vite` cache aside and rerunning all
three tests on a fresh cache resolved that runner failure. Neither PHP nor
the Kandelo kernel reported a failure in that trace.

The live source-only browser profile loaded this exact image at the
`wordpress-frankenphp` route: Chromium reported HTTP 200, a running machine,
and the preinstalled "WordPress on Kandelo" homepage. Its companion Node
server remained available at `http://localhost:3000/`.
The fresh full Open POSIX run against this renamed-dot kernel completed
with 174 PASS, three documented XFAIL, two SKIP, and zero unexpected
failures (179 cases total).

**2026-10-10 — current-main reconciliation and fresh distribution.** The
draft branch merged the advancing `main` without rewriting contributor
history. Fork-instrument retains Go's Wasm feature flags alongside main's
explicit `--keep-names` policy; its seven post-optimize CLI tests pass. The
generated resolver bundle was regenerated from the merged source and its
standalone check passes. ABI snapshot validation passes. A kernel rebuild
invalidated the prior source-only program projection, so the full WordPress
shell closure was rebuilt. One parallel `coreutils-docs` help-capture
timed out after 30 seconds under build contention; retrying that package
alone passed, then WordPress and `go-hello` republished successfully. The
new WordPress VFS is SHA-256
`2a80eca8f4eb390458cbbf038466bab2d07f0a043ca1de34ea2989d2de7d737d`
(52,291,643 bytes).

Go browser fixtures now build in a fresh staging directory before their
ABI stamp and publication; rerunning the builder twice over existing
outputs succeeded, instead of attempting to restamp stale Wasm after an
ABI snapshot change. Source-only Vite also rejected an unrelated `dash`
asset imported by the rootfs lazy-file map: `dash` is not in rootfs's
declared package closure or VFS manifest. Removing that unused import
keeps the browser loader faithful to the image rather than accepting an
orphaned local binary.

On the merged tree, 1,719 runtime-core unit and six doc tests pass. The
selected upstream Go `os` and `syscall` probes and the resolved Go package
launcher pass in Node, as does direct FrankenPHP PHP/static HTTP. After
rebuilding the cgo fixtures from source and stamping the current ABI,
the focused Go browser matrix passes 102/102 across Chromium, Firefox,
and WebKit. Resolved Go package and direct FrankenPHP browser checks pass
6/6; rebuilt-image WordPress direct kernel-host, browser homepage/admin,
and Node-host checks pass 3/3 in Chromium. The live Node homepage/login
return HTTP 200, and a manual source-only browser run loads the WordPress
homepage with the machine running and no page errors. The first full Open
POSIX attempt on the merged tree failed before guest launch: its isolated
runner eagerly resolved unrelated optional builtin programs against an
incomplete old local package tier. The Open POSIX cases stage only their
own executable fixtures, so the runner now requests the existing `explicit`
builtin mode, as the libc conformance runner already does. An individual
`asctime/1-1` case passes with that mode. The full merged-tree rerun
completed 179 cases: 174 PASS, three documented XFAIL, two SKIP, zero
unexpected failures.

The complete upstream `TestRoot*` Node sweep on the merged kernel still has
exactly three failing top-level cases: `TestRootChtimes`,
`TestRootLinkFrom`, and `TestRootRenameAfterOpen`. This confirms the
filesystem gaps below remain open; it does not establish the browser result
for those unselected cases.

The upstream `os` test binary lists 224 top-level cases. Of 28 additional
cases tried against the merged Node kernel, 25 passed, two skipped for
existing Go test prerequisites, and `TestExecutable` failed because the Go
fork has no Kandelo implementation. Kandelo's `/proc/self/exe` currently
reads `argv[0]`, which is not a reliable executable VFS path, so the proper
next step is to make the process/exec identity authoritative and only then
implement the Go API. The 25 passing cases are now in the selected suite:
60 top-level `os` cases pass in Node with no stderr or host diagnostics,
and the expanded selection passes in Chromium, Firefox, and WebKit.
The full Go+cgo browser matrix with this expanded selection passes 102/102
(34 probes in each engine) with two Playwright workers. An earlier
three-worker attempt passed 99/102 but timed out in three unrelated
socket/clone probes; all nine engine/probe combinations passed on a focused
rerun. The two-worker full pass is the current clean matrix, while the
three-worker timeout remains a concurrency/load signal to investigate
before claiming stress robustness.

A new opt-in `-kandelothreadslots=64` probe holds 48 distinct locked Go Ms
concurrently and exits without diagnostics in Node. The first browser run
exited 0 in every engine but reported that graceful kernel-worker detach
exceeded its two-second bound: browser teardown had serialized a 250 ms
settle for each thread. Browser and Node per-process thread retirement now
starts independent terminations together while releasing each thread's
exact exit ownership only after its own termination settles. The focused
48-thread browser probe passes in Chromium, Firefox, and WebKit (3/3), and
the host's process-generation parity tests and typecheck pass. The combined
Go+cgo browser matrix including this opt-in probe passes 105/105 across
Chromium, Firefox, and WebKit with one worker. A two-worker attempt passed
104/105; WebKit's five-second worker-M exit watchdog fired once under load,
but five repeat runs of that case interleaved with five high-thread probes
passed. Host process-wait and pthread-trap regression tests pass 73/73, and
both WordPress/FrankenPHP Chromium browser gates pass 2/2 after the cleanup
change. This is a bounded 48-thread result, not a maximum-slot stress claim.
The whole-tree browser asset check still fails on 13 unavailable imports
(including `dash`, Erlang, alternate demo images, and MariaDB outputs)
outside the selected WordPress/FrankenPHP source-only closure. The focused
product browser tests above resolve and run their declared assets; the broad
asset check is not green on this checkout.

**2026-10-10 — paired WordPress service-stack latency benchmark.** Added
`benchmarks/wordpress-stack.ts` to boot each preinstalled WordPress profile
from the same source-only VFS on Node and Chromium. The browser runner checks
the VFS SHA-256 against the Node input before measurement; Node assigns fresh
HTTP/SMTP ports per run to avoid collision with the live demo. Four rounds
alternate profile order, with three warmups and 12 full-body dynamic homepage
requests per round. The raw 192 measured request latencies, startup timings,
image digest, and summaries are in `.context/wordpress-stack-benchmark.json`.
The image digest is
`2a80eca8f4eb390458cbbf038466bab2d07f0a043ca1de34ea2989d2de7d737d`.
Each host/profile has 48 valid request samples. Node nginx/FPM median/p90:
633/706 ms; Node FrankenPHP: 787/811 ms. Chromium nginx/FPM: 705/841 ms;
Chromium FrankenPHP: 734/767 ms. These single-machine latency samples do
not demonstrate a FrankenPHP advantage; they do not establish throughput or
statistical superiority. The Node FrankenPHP teardown occasionally warns
that its bounded cooperative drain fell back to forced worker termination
after sampling; no request failed, but teardown load is a measurement caveat.

**2026-10-10 — exact filesystem timestamps across Node and browser hosts.**
The upstream Go `TestRootChtimes` failure crossed two backends: Node's `/tmp`
is host-backed and discarded sub-millisecond values in its virtual metadata
overlay, while browser `/tmp` is SharedFS-backed and stored only integer
milliseconds. SharedFS now allocates an optional 4 KiB timestamp block only
when an inode needs exact sub-millisecond or pre-epoch times; the ordinary
millisecond inode fields and existing portable image format remain readable.
The Node overlay keeps exact requested nanoseconds alongside native times,
and the Wasm stat bridge prefers exact backend values without multiplying a
large epoch-millisecond floating-point number into imprecise nanoseconds.
`_PC_TIMESTAMP_RESOLUTION` now reports 1 ns on these backends. Focused host
and pathconf tests pass 37/37, including an exact-time VFS image round-trip
and same-millisecond external native-mutation detection. The host package
builds, the ABI snapshot check passes, and upstream `TestRootChtimes` passes
in Node and in Chromium, Firefox,
and WebKit (3/3). The `browser-basic` Go program now also sets fixed,
non-millisecond atime and mtime through `os.Chtimes` on browser `/tmp` and
checks both `os.Stat` and `syscall.Stat` round-trip; its rebuilt fixture
passes in Chromium, Firefox, and WebKit (3/3). The complete Node `TestRoot*`
sweep now has exactly two failing top-level cases: `TestRootLinkFrom` and
`TestRootRenameAfterOpen`.
The first broad Open POSIX rerun finished 173 PASS, one FAIL, three XFAIL,
and two SKIP: the lone failure was a package source-projection error before
guest launch in `sched_get_priority_min/1-1`, not a scheduling assertion.
That interface passes 4/4 with one documented SKIP on an isolated rerun. The
second full rerun is clean: 174 PASS, zero FAIL, three documented XFAIL, and
two SKIP (179 total). The three-browser full Root sweep remains unrun.

**2026-10-10 — next-gate ownership audit.** `TestRootLinkFrom` reaches
Node/macOS `fs.linkSync`, which follows final source symlinks despite the
kernel's no-follow `linkat` resolution; SharedFS already links their inode.
Do not fake a hard link with a copied symlink or change Go's expectation.
Node exposes no no-follow `linkat` flag through its ordinary `fs` API, so a
native capability or an equivalent truthful host implementation is needed.
`TestRootRenameAfterOpen` reaches `resolve_at_path`, which derives every
relative lookup from the directory OFD's remembered pathname; a renamed
directory invalidates that spelling even though the OFD's backend handle
still names the live object. The fix must preserve that identity across
processes and rename operations, not create a pathname alias visible to
unrelated absolute lookups. For `os.Executable`, the process needs a separate
authoritative VFS executable path: `/proc/self/exe` currently reads mutable
`argv[0]`. VFS-path launches can provide the selected path, prepared exec
targets already retain a diagnostic path, fork must inherit the identity,
and direct byte launches must report no path rather than inventing one.
An added kernel export or fork-state field requires an ABI review before the
Go fork reads procfs.

The rebuilt-fixture full Go browser baseline passes 69/69 with one worker:
23 probes across Chromium, Firefox, and WebKit. It includes both the upstream
`TestRootChtimes` probe and the fixed-nanosecond `browser-basic` round-trip.
The post-timestamp full opt-in Go/cgo/high-thread matrix also passes 108/108
with one worker across the same three browsers, including the C pthread
callback stress and 48-live-M/64-slot cases.

**2026-10-11 — executable identity and upstream Go API.** The kernel now
retains a selected executable VFS path independently of mutable `argv[0]`.
Top-level VFS launches publish the resolved path after process registration;
prepared exec/spawn commits replace it, fork copies it from the parent, and
direct byte launches leave it absent. `/proc/self/exe` reports that identity
or `ENOENT`, never a made-up display name. The Go fork implements
`os.Executable` through procfs at commit
`6bb9175625d8ea5863b40077866251a1ab67b4c6`; `go-hello` rev11 pins
that commit. The export is an additive-compatible ABI snapshot change, not an
`ABI_VERSION` bump, but it changes the ABI-contract digest: old Wasm artifacts
must be rebuilt, not restamped. Vitest fixture freshness now includes the ABI
snapshot so such changes rebuild fixtures before the stamp gate. The Go fork
builds, and `os` test binaries compile for Kandelo, `js`, and `wasip1` Wasm.
Rust procfs and fork identity tests pass; the host package builds; focused
host tests pass 299/299. Direct-byte and VFS Go exec probes pass on Node,
and upstream `TestExecutable` passes on Node and Chromium, Firefox, and
WebKit. Focused direct-byte and VFS browser exec probes pass 6/6 across those
engines. This closes the executable-identity subtask, not the wider Go
standard-library/runtime audit. The changed digest invalidates the previous
local WordPress/FrankenPHP artifacts until their package closure is rebuilt.
The new ABI-fixture-input regression test passes 5/5 in the pinned dev shell.
A concurrent whole-Go three-browser sweep was stopped after the WordPress
closure rebuild saturated the host: focused executable probes had passed
separately, but several unrelated full-suite cases timed out under that load.
Rerun the broad sweep after package publishing; do not count this interrupted
run as conformance evidence.

**2026-10-11 — live dirfd identity after rename.** Directory OFDs now
share a live pathname cell across dup/fork/SCM_RIGHTS, and all processes in
the same kernel share a weak registry of open directory cells. A successful
`rename`/`renameat` moves the cells for the renamed directory and its open
descendants; descriptors to a replaced destination become unlinked instead
of aliasing the new occupant. Relative `*at` lookups, directory iteration,
`fchdir`, and fd readlinks use the live cell, not the opening pathname.
Four focused Rust tests pass for same-table, cross-table, process-table, and
`openat` behavior; the full Rust workspace suite passes. The rebuilt kernel
passes upstream `TestRootRenameAfterOpen` in Node with empty stderr and host
diagnostics. The same case passes 3/3 in Chromium, Firefox, and WebKit after
the source-only index published. The first browser attempt was a setup-only
size mismatch while the kernel member and its index were being finalized;
it did not launch a guest. The ABI snapshot check passes. Node/macOS
symlink-source `TestRootLinkFrom` remains open.

**2026-10-11 — native symlink-inode linking and complete Root sweep.**
Node/macOS `fs.linkSync` follows the final symlink, so the host-backed VFS
now invokes an exact `linkat` helper with `AT_SYMLINK_NOFOLLOW_ANY` for that
case. It compiles lazily from fixed C source and maps the native errno back
to the host error code; if no C compiler is available, it reports `ENOSYS`
rather than faking a hard link. The focused HostFileSystem suite passes
11/11, including symlink inode identity and `EEXIST`. Upstream
`TestRootLinkFrom` passes in Node and as a focused probe 3/3 in Chromium,
Firefox, and WebKit. The full Node `TestRoot*` sweep passes all 43 top-level
tests with zero failures, empty stderr/diagnostics, and 30 documented AF_UNIX
subcase skips. The full browser sweep passes 3/3 across those engines after
staging its `testdata/dirfs` files; an earlier fixture-omission run failed
only `TestRootDirFS` before this correction. Packaging a native helper without
a runtime compiler remains a portability follow-up.

**2026-10-11 — maximum declared Go thread arena.** A test-only build of the
same 48-live-M probe declares 1,024 slots, reserving 256 MiB of control
pages. It passes with empty stderr and host diagnostics on Node and 3/3 in
Chromium, Firefox, and WebKit. This exercises the supported declaration and
arena layout, not 1,024 simultaneously live Ms or long-lived PHP churn.

**2026-10-11 — mixed-width C aggregate layout.** Fork commit
`476693721f81cc913026ef78456d91ca52bbec2c` is pushed to
`kandelo-dev/go` on `kandelo-port`. A C struct with one
interleaved 4-byte pointer became a 24-byte Go struct before this change,
rather than the 12-byte C layout. The expanded probe adds a fixed pointer
array and requires the correct 20-byte layout. The Go cgo
frontend now exposes pointer-bearing struct fields as raw 4-byte integers
on Kandelo/Wasm. A focused probe checks field offsets, C pointer identity,
struct return, and a by-value C call; it passes in Node and 3/3 in Chromium,
Firefox, and WebKit with empty stderr and diagnostics. The full `cmd/cgo`
unit suite, the existing C-call Node probe, and `os` test-binary cross-builds
for `js` and `wasip1` pass. This does not establish arbitrary aggregate ABI
mapping or safe retention of Go-managed pointers in C fields. Canonical LLVM C
`.init_array` declarations emit `INIT_FUNCS` metadata and zero-filled data;
an explicit `.fini_array` declaration is rejected by the SDK LLVM backend
before the Go linker runs. Non-metadata initializer/finalizer arrays remain
a conditional linker/toolchain gate, not a current FrankenPHP blocker. The
WordPress closure bootstrap started before this fork revision and still uses
its previous source pin; update the Go package pins and rebuild after that
bootstrap publishes.

**2026-10-11 — upstream Go process and pipe conformance expansion.** Fork
commit `8fd249d` is pushed to `kandelo-dev/go` on `kandelo-port`.
`syscall.Getuid`, `Geteuid`, `Getgid`, `Getegid`, `Getgroups`,
`Setgroups`, `Setresuid`, and `Setresgid` now use Kandelo's credential
syscalls rather than fabricated IDs/groups. A credential-transition probe
passes on Node and Chromium/Firefox/WebKit. Go runtime startup ignores
SIGPIPE through the kernel; Go `os.File.Write` restores the default
disposition or delivers `signal.Notify` as appropriate. Upstream `TestEPIPE`,
`TestStdPipe`, and `TestPipeIOCloseRace` pass in Node and all three browsers;
the POSIX errno text used by Go is now lowercase. This is not a claim of
general asynchronous signal delivery.

The broader upstream `os` sweep revealed two independent process-start
gaps. Shared host spawn preflight had resolved a relative executable against
the *parent* CWD even when a child `chdir` action changes its effective exec
path; preflight now projects ordered `chdir` actions before checking the
candidate, while Rust still resolves the authoritative target after applying
actions. Go's `os/exec.LookPath` was still linked to the generic Wasm
always-not-found stub. Kandelo now uses the Unix lookup path and its real
`faccessat2(AT_EACCESS)` syscall. Upstream `TestExecutable` from a non-root
parent CWD and both absolute/relative `TestStartProcess` subcases pass in
Node and in Chromium/Firefox/WebKit 6/6 with empty stderr and diagnostics.
The Go fork's `os/exec` test binary cross-builds for Kandelo, `js`, and
`wasip1`.
The same preflight now uses a kernel-owned directory-FD path for an inherited
`fchdir` action when earlier file actions have not changed that FD. The
focused Sortix `posix_spawn_file_actions_addfchdir` program passes in Node
and 3/3 in Chromium, Firefox, and WebKit with empty stderr and diagnostics.

The VFS-backed full upstream `os` test runner now provisions the Go source
tree, testdata, `/etc` account files, a `pwd` child program, and a non-root
CWD. Its first unrestricted sweep reached over a thousand passing cases but
timed out in `TestReadNonblockingFd`. A C child confirmed the kernel preserved
the parent's blocking pipe status across spawn; an instrumented Go child
identified the real cause: an inherited WASI-era `syscall` initializer
unconditionally set all three standard descriptors to nonblocking before
Go's `os.NewFile` examined them. That initializer is removed. The isolated
upstream `TestReadNonblockingFd` now passes in Node. The unrestricted
VFS-backed upstream `os` run passes 205 top-level tests (1,250 passing
test/subtest cases, 49 skips) with empty stderr and diagnostics. The focused
`TestReadNonblockingFd` browser probe passes 3/3 in Chromium, Firefox, and
WebKit with empty stderr and diagnostics. This still does not establish
complete Go standard-library conformance beyond `os`.

Fork commit `a011708` is pushed to `kandelo-port`. The full upstream
`syscall` test binary initially exposed the inherited
`clock_time_get` ENOSYS stub. Go now reads a kernel `CLOCK_REALTIME`
timespec through channel syscall 40 and converts it to `Timeval`; the
unrestricted upstream `syscall` test run passes all five top-level tests
in Node, including `TestGettimeofday`, with no skips, stderr, or host
diagnostics. The focused `TestGettimeofday` browser probe passes 3/3 in
Chromium, Firefox, and WebKit with empty stderr and diagnostics.

The cgo aggregate probe now checks a 40-byte nested struct containing a
64-bit integer, a 64-bit float, a 32-bit C data pointer, a function pointer,
and a narrow tail field. It validates nested offsets, C return, and a
by-value C argument, and passes in Node and 3/3 in Chromium, Firefox, and
WebKit with empty stderr and diagnostics. The earlier interleaved-pointer/array
case remains in the same probe. This tests representative
mixed-width aggregate forms, not every ABI class or retention of Go-managed
pointers inside C memory.

The complete available pure-Go `os/user` test set passes 12/12 top-level
tests on Node and 3/3 in Chromium, Firefox, and WebKit. The VFS supplies
matching `/etc/passwd` and `/etc/group` files, including the truthful root
account/group. The earlier seven-test parser-only selection did not exercise
`Current` or live group IDs; this expanded run does.

The available upstream `sync` test set passes 48/48 top-level tests on Node
when launched from a VFS executable (empty stderr and diagnostics). A direct
byte launch produced a single harness-only `TestMutexMisuse` failure because
`os.Executable` correctly returns `ENOENT` without a VFS identity; the
VFS-backed rerun gives the test its required self-exec path. The first
full-short browser attempt timed out in WebKit during `TestMutexMisuse` after
Chromium and Firefox passed. A WebKit-only traced rerun passed in 31.7
seconds; then a clean combined Chromium/Firefox/WebKit rerun passed 3/3 in
1.8 minutes, including the subprocess misuse case. The initial timeout was
not reproducible in either retry; keep it visible as a flake observation.

A VFS-backed upstream `os/exec` short sweep passes 28 top-level tests on
Node, including `LookPath`, relative self-exec, pipes, file-descriptor
inheritance/races, exit status, context cancellation, and error propagation.
Three tests skip because the VFS intentionally omits an executable `go` or
`echo` tool, or short mode avoids building a helper. Five signal/concurrency
tests were excluded from this first sweep. A separate Node run passes
`TestConcurrentExec` and `TestPathRace` with empty stderr and diagnostics,
leaving three signal-related cases to assess. The initial six-case
process/lookup sweep also passes with no stderr or host diagnostics. Do not
infer complete `os/exec` conformance.

A new source-built `os/exec` test fixture is stamped with the current ABI
digest and launched from VFS in browsers. Six upstream process/lookup tests
pass together 3/3 across Chromium, Firefox, and WebKit (52.3, 90, and 56.3
seconds respectively) with empty stderr, host diagnostics, and page errors.
The probe serializes its subprocess-heavy tests under the browser memory
budget; this is not a browser-wide `os/exec` conformance run.

The first signal-focused `os/exec` run exposed a real gap:
`TestWaitInterrupt` fails its `SIGINT-handled` and `WaitDelay` subcases
because the child exits from SIGINT instead of running Go's notification
handler. The run exits 1 with empty host stderr/diagnostics. `TestWaitid`
and `TestSIGCHLD` did not run at all: the fork does not yet classify
`GOOS=kandelo` under the `unix` build tag, so upstream
`exec_posix_test.go` is omitted. Registering Kandelo as Unix in both Go
build-tag maps is being probed; it may pull in OS implementation files that
need Kandelo-specific exclusions and genuine signal delivery support.

The remaining Go/C platform gates, in recommended order, are:

1. Harden the Node/macOS native no-follow `linkat` helper for distribution
   without an ambient C compiler, and audit externally mutated host-backed
   directory paths. The upstream `TestRoot*` sweep passes 43/43 top-level
   cases in Node and as a complete probe in all three browsers with the
   required source-tree fixtures.
2. Expand Go standard-library and runtime conformance beyond the complete
   available `os`, `syscall`, and pure-Go `os/user` suites and selected
   runtime probes. Close the skipped/excluded `os/exec` cases and broaden its
   browser coverage; track genuine browser boundaries such as AF_UNIX
   separately from bugs.
3. Support real relocated/non-metadata C initializer and finalizer arrays
   if needed by source ports; the current LLVM toolchain rejects
   `.fini_array` before Kandelo's linker sees it.
4. Extend mixed-width cgo coverage beyond the now-passing pointer-bearing,
   pointer-array, and nested 64-bit integer/float/function-pointer aggregate
   return/by-value probes. Raw C address fields are 4-byte integers, not
   Go-managed pointers; PHP still uses explicit C accessors and scalar
   registration at its interop boundary.
5. Exercise 1,024 simultaneously live threads, longer PHP worker churn,
   allocator pressure, and concurrent callbacks. The one-slot failure,
   48-live-M/64-slot probe, and 48-live-M/1,024-slot declaration probe cover
   arena boundaries but not full concurrency or long-lived PHP stability.
6. Provision the full built-in program closure and rerun Sortix os-test;
   repeat broad POSIX conformance after further kernel/host changes. The
   current Open POSIX suite passes with its documented XFAIL/SKIP cases.
7. Extend the now-runnable paired WordPress latency benchmark to throughput,
   multi-client load, and statistically powered repeats before making an
   application-performance superiority claim. The first Node/Chromium
   comparison demonstrates no FrankenPHP latency advantage.

---

## Task 7: Wire process start and args/env/stdout as needed

Ensure `_start`/`rt0`, `args`/`environ`, and stdout fd routing are
correct enough for `fmt.Println` to reach the terminal.

**Files (in the Go fork):**
- `src/runtime/rt0_kandelo_wasm.s`, `src/runtime/os_kandelo.go`
  (`args`/`environ`/`goenvs`), and the stdout path.

**Step 1:** Confirm the entry point runs `runtime` init and `main` on
Kandelo (mirror `rt0_wasip1_wasm.s`). Implement `goenvs`/args as
needed via channel syscalls or the Kandelo process-args mechanism
(record which Kandelo provides).

**Step 2:** Rebuild; proceed to Task 8 for the observable check.

**Step 3:** Commit in the fork.

---

## Task 8: End-to-end — hello world runs in a Kandelo worker (milestone success)

**Files (in the Kandelo repo):**
- Test/harness: reuse `runCentralizedProgram`
  (`host/test/centralized-test-helper.ts`) or the closest existing
  runner to launch `/tmp/k.wasm` through the real
  `CentralizedKernelWorker`.

**Step 1 (provision):** Under `scripts/dev-shell.sh`, run `./run.sh
setup` (builds musl + `kernel.wasm`) and `npm install` if not already
present. This is the one heavier provisioning step; do it now.

**Step 2 (write the end-to-end test):** A test that runs `/tmp/k.wasm`
via the centralized kernel and asserts stdout contains the hello line
and exit code is 0.

**Step 3:** Run it under `scripts/dev-shell.sh`. Capture literal
output. Expected: the hello line prints; exit 0.

**Step 4 (parity):** Note host parity is a contract. Full browser
validation via `./run.sh browser` is a follow-up within this milestone;
at minimum, confirm nothing in the path is Node-specific. Record what
was and was not run.

**Step 5:** Commit the end-to-end test in the Kandelo repo:
`Test: Go GOOS=kandelo hello world runs end-to-end via the kernel`.

---

## Milestone exit criteria

- A Go `hello world` built with the forked `GOOS=kandelo GOARCH=wasm`
  toolchain **instantiates** in a Kandelo process worker (passes the
  memory + `__abi_version` guards) and **runs**, printing to stdout via
  the channel ABI and exiting 0, verified by an end-to-end test under
  `scripts/dev-shell.sh` on Node.
- The Go fork is reproducible from a pinned upstream version plus the
  recorded changes (Decision 1's storage productionized, or at least
  the exact patch set captured).
- The design doc is updated with anything the implementation revealed
  (especially the exact `__abi_version` form and the chosen channel
  handshake mechanism), per the documentation contract.

## Explicitly out of scope for milestone 1

Threads/parallelism (`clone`/`newosproc`), networking (`net.Dial`,
netpoller), `os/exec`/`SYS_SPAWN`, cgo, browser-parity hardening beyond
a smoke check, and SDK/package-system integration. These are
milestones 3–6 in the design doc.

## Risks specific to this milestone

- **Task 4 (`cmd/link`) is the real unknown.** If importing shared
  memory from Go's linker proves large, timebox the spike and report
  findings before committing to an approach; it remains the internal
  gate and everything downstream depends on it.
- **Channel handshake atomics (Task 6, Option 1)** may require more
  wasm-backend work than expected; Option 2 (temporary host import) is
  the documented fallback and needs an ABI note.
- **`unix` build-tag fallout (Task 3)** may pull stdlib files that
  assume real syscalls; be prepared to narrow `UnixOS` membership or
  add `kandelo`-specific overrides.

---

## Follow-up work item: Go-runtime-specific agent guidance

**Completed 2026-10-09.** `docs/agent-guidance/go-runtime.md` is linked from
`CLAUDE.md` and routes fork/runtime work separately from registry package
porting. It records the build, ABI, per-M memory/channel, `exitThread`,
Node/browser probe, and progress-log contracts below.

Add a focused guide for extending the `GOOS=kandelo` Go runtime port. Route
agents to it from `CLAUDE.md` and distinguish it from the registry-package
porting skill. Cover the adjacent Go fork and its bootstrap/build commands;
the shared-memory, thread-slot, per-M channel, and Wasm import contracts;
Node and browser probe workflows; ABI/version decisions; and how to record
fork commits and validation in this progress log and the Kandelo PR. Include
the `exitThread` stack-reclamation ordering pitfall as a concrete example.
Done when an agent can reproduce a Go runtime probe, identify which repo owns
the fix, and report exact Node/browser evidence without relying on prior chat.

## 2026-10-11: Unix build-tag expansion and remaining completion gates

The adjacent Go fork now classifies `kandelo` as Unix in both build-tag maps
at `ff20ff3a8d1a6087ca5960832dd13a2751edf316`, followed by the cgo
selection fix at `741ef166026f15bf8c65b05c8518c263d3d03315`.
Target-specific build
constraints retain Kandelo's Wasm runtime, syscall, and polling paths instead
of accidentally selecting native Unix implementations. The fork now routes
`Fchownat` through the existing kernel syscall and carries `Stat_t.Rdev` plus
nanosecond access/change times into `archive/tar` headers. Its complete
standard-library build succeeds for Kandelo, JS/Wasm, and WASI/Wasm; the
`CGO_ENABLED=1` Kandelo standard-library build also succeeds, and the
`go/build` Unix classification regression passes. The cgo-mode `os/user`
test binary passes six top-level cases, and a cgo-built VFS account program
passes its current-user, lookup, and group-ID checks. A cgo-built `net` test
binary compiles and passes two focused parser cases; AF_UNIX ancillary
rights and IP TTL/hop options remain unsupported. These are build and
focused-behavior results, not general Go conformance.
The cgo-built VFS account browser probe passes in Chromium, Firefox, and
WebKit. Its first Firefox attempt timed out while the large FrankenPHP
package rebuild was compiling the Go toolchain; an isolated rerun passed.

With source and data fixtures in VFS, the expanded upstream `os` suite passes
213 top-level cases in Node when excluding only `TestGetwdDeep` and
`TestGetwdDeepWithPWDSet`. Both deep-path cases fail on the default Node/macOS
host-backed `/tmp` at about 1,024 native pathname bytes although the short
relative component is valid; macOS reports `getconf PATH_MAX /tmp` as 1024.
With image-backed `/tmp`, the complete 215-case upstream `os` suite passes
in Node without excluding either case (21 top-level skips from upstream
platform/tool availability). Browser SharedFS passes both cases in Chromium,
Firefox, and WebKit. The
upstream `TestRoot*` sweep now passes 47/47 in Node and as one probe in each
browser engine. Five newly included Unix `os/exec` path/wait cases pass on
Node and in each browser engine. The complete upstream `archive/tar` suite
passes 44/44 on Node and as one probe in each browser engine. The new
four-probe browser matrix passes 12/12 across the three engines. These runs
use fresh ABI-stamped fixtures, empty stderr, and no host diagnostics.

The selected WordPress source-only closure now publishes with image SHA-256
`d9dadfc478fa8c1ec53b4a4987eab7b5ecbb27bb8f1ca9d6c84aea9d659714b4`.
The fresh-image Node paired service smoke passes for nginx/PHP-FPM and
FrankenPHP classic. Chromium passes both the direct PHP homepage/login gate
and the browser demo homepage/admin flow (2/2). The direct browser test first
loaded the stale `local-binaries/kernel.wasm`, which lacked the required
`kernel_set_executable_path` export, and failed before PHP; it now uses the
selected resolver kernel and passes. A Vite server from the prior day also
caused a misleading stale-run failure, so the passing run used a fresh server
on a dedicated port. The cgo account and complete `archive/tar` probes pass
4/4 across Chromium and Firefox after publication.

A four-round paired WordPress run on that image completed on Node and
Chromium with two warmups, 12 serial request samples, four concurrent
clients, and 12 requests per client for each profile and round. The raw
report is `.context/wordpress-stack-rev17-paired.json` (untracked local
evidence). Node request medians are 671 ms for nginx/PHP-FPM and 812 ms for
FrankenPHP; median throughput is 2.15 versus 1.87 requests/s. Chromium
request medians are 728 versus 755 ms, while median throughput is 1.99
versus 2.14 requests/s. These small runs are mixed and do not establish
FrankenPHP superiority. A first full attempt completed Node sampling but
the browser sampler failed before measurement because an esbuild-injected
`__name` helper was absent inside `page.evaluate`; a browser-only smoke and
the complete paired rerun pass after using self-contained in-page loops.
Node FrankenPHP teardown still occasionally force-terminates live workers.
The current source-only image also serves the preinstalled site and login
at `http://localhost:3000/` through the Kandelo Node host.

The complete opt-in Go browser matrix now passes 129/129 probes across
Chromium (43/43), Firefox (43/43), and WebKit (43/43) on a dedicated fresh
Vite server. The first combined run exhausted the Playwright Node worker's
4 GiB heap after 35 passes because the test sent each VFS image to
`page.evaluate` as a large JavaScript number array. The browser harness now
serves exact image bytes through a test-owned route and fetches an
`ArrayBuffer` inside the page, like its program and kernel bytes. A focused
four-probe rerun passed first; the full Chromium and Firefox/WebKit runs
then passed without the worker out-of-memory failure. The initial combined
run was interrupted, not counted as a pass.

The full source-only local build now succeeds for all 184 nodes and all
eight browser products. Its first run built 43 previously uncached nodes
but failed `librsvg` and `rsvg-convert` because this worktree had not
initialized `sdk/rust/libc-upstream`; after checking out the pinned
submodule, a retry built those last two nodes and finalized the complete
closure. This was a provisioning failure, not a Go or graphics compiler
regression. The post-closure Open POSIX Test Suite rerun reports 174 PASS,
zero FAIL, three documented XFAIL, and two SKIP (179 total). The Sortix
`--all` run uses a pristine pinned source checkout on a case-sensitive APFS
volume; the worktree's case-insensitive submodule cannot represent its
distinct `PRIX16.c` and `PRIx16.c` filenames faithfully.

The first full Sortix `--all` run finished with 5,052 PASS, six FAIL, 23
documented XFAIL, 50 SKIP, and four TIMEOUT (5,135 total). Every failure
was a host-side package-checker error, not guest output: parallel resolver
processes rebuilt the same private `xtask` path and some lost the executable
while another build replaced it. The timeouts happened under that loaded
parallel run. The Sortix runner now exports the release `xtask` it already
prepares to stamp ABI digests as `WASM_POSIX_XTASK_BIN`, so each guest uses
the same stable checker rather than starting another Cargo build. All six
failures and all four timeouts pass in isolated focused reruns (7 basic,
one I/O, two UDP). A second complete `--all` run is in progress; these
focused passes do not establish that the broad run is green.

The second full Sortix `--all` run reports 5,059 PASS, zero FAIL, 23
documented XFAIL, 50 SKIP, and three TIMEOUT. It returned status zero
despite those timeouts: the runner counted but did not include
`TIMEOUT_COUNT` in its final failure condition. That reporting defect is
fixed, with a forced-timeout test proving the runner now exits nonzero.
The remaining timeout cases (`poll`, `select`, and legacy `sys_time/select`)
fill and drain a 64 KiB pipe one byte per syscall, so a 30-second wall-time
budget is too small when 14 guests contend. They passed individually under
the 30-second budget; their parallel budget is now six times the configured
base timeout. The full parallel `basic` rerun now passes 938 cases, eight
documented XFAIL, zero FAIL, and zero TIMEOUT across all 946 cases. The
earlier zero-exit `--all` run must not be cited as a clean conformance pass;
the non-basic suites had not yet been rerun with the corrected final status.
The corrected full `--all` rerun now exits zero after 5,062 PASS, zero FAIL,
23 documented XFAIL, 50 SKIP, and zero TIMEOUT across 5,135 cases. This
closes the broad Sortix rerun gate without reclassifying expected failures
or skips as passes.

The mixed-width cgo probe now additionally returns a packed 14-byte C
struct containing an unaligned 32-bit C pointer and an unaligned 64-bit
integer, inspects its exact bytes in Go, and passes it back by value to C.
The fresh instrumented and ABI-stamped probe passes on Node with empty
stderr/diagnostics and 3/3 in Chromium, Firefox, and WebKit. This extends
the tested ABI shapes; it does not prove arbitrary packed aggregates or
Go-managed pointer retention in C memory.

The declared-1,024-slot Go fixture now takes a selectable live locked-M
count. Fresh 256-worker runs pass in Node, Chromium, Firefox, and WebKit;
512 workers pass in Node. The main M occupies a slot, so the fixture allows
up to 1,023 workers. The 512-worker Node run consumed a 30.4 GB peak memory
footprint (12.1 GB maximum resident set) on this 36 GB host. Doubling that
count would risk exhausting the host; the complete 1,024-live-M gate needs
lower per-worker overhead or a larger host. This does not cover long-lived
worker churn or 512 workers in the browser.

The same fixture now accepts multiple waves and leaves each worker goroutine
locked when it returns, forcing Go to retire that M instead of merely
parking it for reuse. Five waves of 48 distinct live Ms pass in Node and
3/3 in Chromium, Firefox, and WebKit under the 1,024-slot declaration, with
empty guest stderr and host diagnostics. The same five waves pass on the
64-slot fixture in Node and 3/3 browsers; 240 total worker Ms exceed that
ceiling, so the run also checks actual slot reclaim. This closes a bounded
Go-thread turnover probe, not sustained PHP-worker churn or allocator
pressure.

The WordPress/FrankenPHP host gates now accept an opt-in count of extra
dynamic PHP requests on the same server boot, alternating the homepage and
login with distinct query strings. Forty additional requests pass against
the fresh source-only WordPress image on both the Node-host demo and the
Chromium kernel host. The Node test also completes its admin login after
the request sequence; the browser host reports no diagnostics or panic.
These bounded requests do not prove sustained PHP-worker reuse, allocator
stability, or a performance advantage.

The browser asset check used to run one source-projection freshness check per
import (151 default imports), taking over six minutes without reaching its
result under the completed closure. It now batches package-owned imports
through one verified resolver generation, while retaining individual error
diagnostics for unresolved imports. The source-only check resolves all 137
selected imports; the default gallery check finishes in 53 seconds and
still reports four unavailable optional imports: Erlang VFS, `fbtest`, and
the wasm32/wasm64 MariaDB VFS products. The focused package-system Vitest
suite passes 30 cases with two skips. This does not make the default asset
check green or imply those optional products were built by local-build.

Remaining work, in recommended order:

1. Close the Node/macOS HostFS deep-relative-path mismatch without weakening
   guest path safety, and distribute native no-follow `linkat` without an
   ambient compiler. Audit externally changed host-backed directories.
2. Complete Go signal delivery and child credential handling, then run the
   remaining upstream `os/exec`, standard-library, and runtime suites in
   Node and browsers. `TestWaitInterrupt` still exposes handled-SIGINT and
   WaitDelay gaps; requested child credentials still return honest `ENOSYS`.
3. Broaden cgo ABI coverage and support real relocated C initializer/finalizer
   arrays where needed by source ports. The current LLVM path rejects
   `.fini_array` before Kandelo's linker can handle it.
4. Exercise 1,024 simultaneously live Go Ms, sustained PHP-worker churn,
   allocator pressure, and callback concurrency. The current evidence reaches
   513 live Ms in Node and 257 in each browser, five 48-worker retirement
   waves in each host, and 40 extra PHP requests on one WordPress server boot
   in Node and Chromium. The 512-worker Node run nearly fills this host's
   memory footprint budget.
5. Before any broad performance superiority claim, compare additional
   hardware and browser engines. Two independent four-round runs on this
   machine show mixed Node/Chromium outcomes; no overall advantage follows.
   This measurement gate is separate from Go correctness.

The first two gaps are not merely missing test fixtures. The current Node
`HostFileSystem.safePath` builds full native pathnames, so macOS reaches its
native path limit before Kandelo's guest limit; a local `/dev/fd/N/child`
prototype returned `ENOENT`, not an fd-relative lookup. A safe fix needs
native fd-relative operations that preserve directory identity during
external mutation. The exact no-follow `linkat` path likewise still compiles
its native helper on first use; a published host needs a reviewed native
artifact distribution path. In the Go fork, `runtime/os_wasm.go` still has
no-op signal enable/disable hooks, while `syscall.StartProcess` rejects
requested child credentials with `ENOSYS`; the current spawn wire has no
arbitrary UID/GID/group fields. Signal handling and child credentials need
runtime and spawn-protocol designs, not a test-only skip or fabricated
success.

An independent second four-round paired WordPress run used the same
SHA-256-verified VFS image and alternated profile order on Node and
Chromium. Its raw report is
`.context/wordpress-stack-rev17-independent.json`. Each host/profile has
48 serial request samples and 192 concurrent requests. Node median request
latency is 651 ms for nginx/PHP-FPM versus 810 ms for FrankenPHP, with
median throughput 2.17 versus 1.87 requests/s. Chromium median request
latency is 710 versus 737 ms, with median throughput 2.00 versus 2.22
requests/s. The earlier independent run showed the same direction on
each host. This supports only a workload- and host-bounded Chromium
throughput advantage, not an overall WordPress performance advantage;
FrankenPHP is slower on the Node host and has higher request latency on
both. The Node host still sometimes reports forced worker termination
while destroying the live FrankenPHP service after measurements.

The paired benchmark now receives dinit's process ID from the shared
service-VFS boot helper, sends it SIGTERM after measurements, waits up to
five seconds for its exit, and only then destroys the Node host. A fresh
four-round Node-only run on the same image logs each service's stopped
state and no force-termination warning. Its raw report is
`.context/wordpress-stack-graceful-node.json`: median request latency is
664 versus 798 ms and median throughput 2.16 versus 1.87 requests/s,
listing nginx/PHP-FPM before FrankenPHP. This closes the benchmark's
live-service teardown issue, not generic host destroy semantics or an
overall FrankenPHP speed claim.

**2026-10-12 — Production-representative WordPress/FrankenPHP checkpoint.**
The acceptance target now has two distinct comparisons: uncached PHP runtime
behavior against a comparably configured nginx/PHP-FPM profile, and a
visitor-facing stack comparison where each side may use its production-style
page cache. The latter must verify cache freshness and bypass for logged-in,
admin, and other personalized requests; a cached-stack win must not be
described as a PHP-runtime win. The official FrankenPHP WordPress setup uses
Caddy's `php_server`; FrankenWP adds a Caddy page-cache module. The current
Kandelo profile still uses FrankenPHP's Go library behind a small custom
router, without Caddy or a page cache, and is not a production-ready stand-in
for those deployments.

A source build of FrankenPHP v1.11.0's actual Caddy module was attempted with
the pinned Kandelo Go fork. The full and reduced import sets both stopped
before linking in Unix-dependent Go packages: `x/sys/unix` lacks the target's
socket options and mapped-file APIs, while bbolt, readline, and certificate
packages also lack Kandelo target selections. These are genuine Go-target and
dependency-port tasks, not a Caddyfile or WordPress routing bug. Experimental
Caddy package and profile wiring was reverted, so the checked-in resolver
recipe still produces only the working Go-library classic binary. No Caddy
binary or Caddy-backed WordPress result is claimed.

As a bounded preparation step, `FRANKENPHP_NUM_THREADS` is now validated by
the classic binary; the WordPress profile requests six PHP threads rather than
the earlier fixed two, matching the baseline FPM pool's configured six child
processes in count, not necessarily in memory or scheduling cost. Package
revisions are `frankenphp-classic` 18 and WordPress 23. The standalone
FrankenPHP Node probe passed with three configured threads, direct PHP and
static HTTP, and no host diagnostics. Source-only WordPress bootstrap
published image SHA-256
`4136d937629065e3147b3cb587b86212f9cc7c7316c05ccd1e4df3a680e7dba7`.
The rebuilt image passed the direct Chromium kernel-host homepage/login gate,
which also reads the service log to verify `num_threads=6`,
the Chromium gallery homepage/admin gate, and the Node-host browser counterpart
admin flow (3/3). This is correctness evidence for the tuned *existing*
profile, not a Caddy or performance result. The PHP ZTS embed build still
omits OPcache while the FPM image includes and prewarms it, so the previous
paired benchmark cannot be interpreted as a fair runtime comparison.
An exploratory two-round Node paired run on the same image used one warmup,
six serial samples, and three concurrent clients per profile: nginx/FPM
request medians were 642 and 709 ms, while FrankenPHP's were 796 and
785 ms. The raw report is `.context/wordpress-six-thread-node.json`.
This small Node-only check establishes neither a tuned comparison nor a
performance advantage; it leaves the ZTS OPcache and Caddy-path gaps open.

Next, port the Caddy dependency graph through genuine Kandelo Go/POSIX
implementations and build a source-only Caddy/FrankenPHP package. Then switch
the WordPress profile to a reviewed Caddyfile with `php_server`, verify both
hosts, and test real-world operational behavior (configuration, limits,
shutdown, writes, redirects, assets, and failures). Bring PHP acceleration
features into parity or report the incompatibility explicitly. Only then add
a cache-enabled visitor-facing profile with safe invalidation and bypass,
followed by independent uncached-runtime and whole-stack load comparisons.

**2026-10-12 — ZTS OPcache feasibility check.** PHP's upstream
`ext/opcache/config.m4` unconditionally selects a shared Zend extension.
Enabling it in `php-zts` made the default `make` fail at libtool's unsupported
Wasm shared-module output. Building `libphp.la` separately and linking the
ZTS OPcache objects with the SDK's side-module linker did produce a resolver-
verified `opcache-zts.so`. That did not make it loadable in the Go executable:
the module imports hundreds of PHP/Zend symbols, including
`zend_string_hash_func` and `php_request_startup`, while the current
FrankenPHP Go/Wasm binary exports neither of those symbols. The Go internal
linker needs a general way to retain and export C symbols required by
`dlopen` side modules, followed by an import-closure and live-load test on
Node.js and Chromium. The experimental PHP package changes were reverted;
the working demo still has no ZTS OPcache. A PHP-FPM OPcache file cache also
cannot simply be assumed compatible with the ZTS build; check the cache
identity and prewarm strategy independently once loading works. No runtime
or performance parity is claimed from this compile-only experiment.

**2026-10-12 — WordPress site-editor memory regression.** The existing
FrankenPHP browser profile booted and logged in, but Appearance → Editor
reproducibly led to HTTP 500. The guest service log reported repeated
`mmap() failed: [12] Out of memory`, and the process table showed the
combined Go/PHP process at 254.8 MiB against its requested 256 MiB
address space. The direct Chromium kernel-host editor request succeeded
with a 1 GiB ceiling. The FrankenPHP profile and its Node counterpart
now request 16,384 Wasm pages (1 GiB); the nginx/PHP-FPM profile keeps
its separate 256 MiB process ceilings. WordPress recipe revision 24
produced source-only image
SHA-256 `0fd69bbd13ed4cbb7549b42594ae8dbe54f1adb765e1d0c9bdf9422307501bc2`.
The persistent Vite server initially kept advertising the old image hash
after the build; restarting it was necessary before the UI test used the
new artifact. With the new image, the authenticated site editor and a
subsequent uncached editor request passed twice each in Chromium and
macOS WebKit. The Node-host editor path passed once. This establishes
only the desktop 1 GiB profile. The constrained browser memory profile
still clamps each process to 256 MiB, so mobile Safari is not covered by
this fix; its FrankenPHP editor needs a separate memory-budget or
architecture solution.
An exploratory post-editor check also exposed an intermittent WebKit
service-worker 503 reporting an offline computer while the dock still
showed the machine running. Changing owner-client enumeration alone did
not resolve it and was reverted. That bridge-lifecycle issue remains
separate from the reported Appearance → Editor failure and is not fixed.

**2026-10-12 — Firefox site-editor follow-up.** The user opened the new
1 GiB image URL in Firefox, used the demo's admin-login button, and later
reported that it seemed to be working better; the earlier short-lived
failure was not reproduced. The browser UI gate now supports a timed soak
of authenticated Appearance → Editor requests and captures browser and
guest diagnostics on failure. On the new image, a 180-second Chromium
soak and a 180-second Firefox soak passed; three further 120-second
Firefox sessions also passed. These runs exercise editor loads and
uncached requests, not editing or saving content, and do not establish
the cause of the user's earlier failure. A 180-second macOS WebKit soak
returned HTTP 503 at 60 seconds after five successful samples. Its
service-worker response said the computer was offline even though the
dock still showed it running, so the browser bridge remains an open
issue. An optional rebase onto `origin/main` was attempted and aborted:
main has ABI version 49 while this branch's source-only artifacts use
version 48, and the rebase conflicts in ABI and host/kernel contract
files. Integrating those contracts and rebuilding the affected artifacts
requires separate validation; no rebase or performance gain is claimed.

**2026-10-12 — Rebase onto main and ABI 50 integration.** The feature
branch was subsequently rebased onto `fe2712d6b` (the current main at
the time). Main's kernel-owned root filesystem and handle-only host
mounts replaced the removed SharedFS/MemoryFileSystem paths. Go and
FrankenPHP Node/browser fixtures now build images with the Rust-backed
`KandeloImageFs`; the old image hash and prior browser-soak results
remain ABI-48 evidence, not validation of this rebased tree. The
opt-in preallocated Go thread-slot layout changes the process-memory
contract relative to main's ABI 49, so this branch now declares ABI 50,
regenerates the snapshot and host/libc constants, and updates its Go,
PHP-ZTS, FrankenPHP, and WordPress package recipes. The ABI check passes.
Focused runtime-core directory-path and rename-dot tests pass, the
fork-instrument post-optimization suite passes 7/7, and the host
pathconf/host-filesystem suite passes 19/19 after preserving exact
nanosecond resolution for host mounts. A whole-tree ABI-50 setup build
was deliberately stopped after 65 minutes while compiling unrelated
Clang/Qt products. A WordPress-only resolver bootstrap is underway;
new WordPress/FrankenPHP Node and browser behavior is **not yet
validated** on ABI 50. A new image must be published before reusing
the live demo URL.

**2026-10-12 — ABI-50 FrankenPHP and WordPress rebuild.** The first
source-only WordPress bootstrap failed after the pinned Go linker's
`__abi_version` marker emitted 48 despite the package metadata declaring
50. The Go fork now emits 50 at `8110e3ac49c1d172fbb853f5e914dfa9ddccecff`;
`go-hello` rev15 and `frankenphp-classic` rev20 pin it. A fresh bootstrap
then published an ABI-50 FrankenPHP binary and WordPress image. The first
Chromium WordPress request exposed a separate image service-graph error:
FrankenPHP did not depend on main's new `wordpress-secrets` first-boot
service, so PHP reached the deliberate placeholder and failed. WordPress
rev26 adds that dependency. The subsequent image is SHA-256
`50fd0d7fda78ebc673a5fb6b1be8a51ef189ce3f2a9d6430f2e40b3591a753d9`.
The complete ABI-50 `./run.sh setup` succeeds, refreshing older optional
gallery artifacts that prevented the app-level Vite gate from booting.
The FrankenPHP PHP/static Node smoke and direct Chromium WordPress
homepage/login gate pass. The app-level admin-login and Appearance → Editor
gate, including two uncached editor requests over 20 seconds, passes once
each in Chromium, Firefox, and WebKit. The Node WordPress/FrankenPHP demo
returns HTTP 200 for the homepage and login. The new kernel, Go hello,
and FrankenPHP Wasm validate as ABI 50. These are bounded functional
checks, not a renewed sustained-soak or performance claim; the earlier
intermittent WebKit service-worker 503 remains open.

**2026-10-13 — Main refresh and Caddy maintainability gate.** Rebased
onto main `008210569`, which changes cache garbage collection without
conflicting with the Go port. The ABI snapshot check and 30 focused
`xtask` cache-GC unit tests plus two cache-GC integration tests pass.
Before adding Caddy support, the user asked to stop if it requires a
large collection of Go compiler or library patches. The existing Go
fork already differs from its Go 1.25.6 base in 241 files, with about
9,214 inserted lines; that is existing platform-port work, not new Caddy
work. The earlier Caddy build stopped in `x/sys/unix` and several other
dependencies before linking. Do not start a patch cascade merely to
make the Caddy build pass. First agree on a bounded, upstreamable API
scope or a simpler production-demo target; no new Go/Caddy changes were
made at this gate.

**2026-10-13 — Bounded Caddy API inventory; stop gate reached.** Without
editing the Go fork, dependencies, or package recipes, cross-compiled the
stock Caddy v2.10.2 package and its `cmd/caddy` executable from FrankenPHP
v1.11.0's pinned Caddy module with `GOOS=kandelo GOARCH=wasm`,
`CGO_ENABLED=0`, and readonly module metadata. The package stops on three
missing `x/sys/unix` socket symbols (`SO_REUSEPORT`, `SOL_SOCKET`, and
`SetsockoptInt`). The executable stops before linking in ten packages:
Caddy and gRPC need socket options; ristretto, both badger versions, and
Tailscale's certificate paths need `x/sys/unix` mmap, sync/advice, open, or
access APIs; bbolt lacks a `wasm` architecture constant; readline and
logrus have no selected terminal implementation; and Google's certificate
transparency X.509 fork has no selected system-root implementation. The
target selects only `vgetrandom_unsupported.go` from `x/sys/unix`, so
adding three constants to the Go standard library would not fix this.
Kandelo already exposes socket options and partial file-backed `mmap`,
but their semantics need checking against these consumers, especially
database durability and shared mappings. These ten are first-pass compile
failures, not an exhaustive dependency inventory; the FrankenPHP/PHP cgo
link, runtime behavior, and browser execution were not tested here.

This exceeds the agreed small, reviewable Caddy change budget. Do not
add a pile of local Go-fork or module-cache patches to force the build.
If production Caddy remains the chosen target, split it into separately
reviewed upstreamable work: define and test an honest Kandelo `x/sys/unix`
surface against kernel/POSIX behavior; add explicit Kandelo/Wasm target
selection to each affected dependency; then repeat compilation and
runtime tests before integrating FrankenPHP's Caddy `php_server`. The
existing library-based WordPress profile remains a functional tech demo,
not a production-representative Caddy deployment. No new compiler,
standard-library, dependency, or package changes were made in this audit.

**2026-10-13 — Public Go mmap binding, not a Caddy workaround.** The Go
fork now exposes `syscall.Mmap`, `Munmap`, and `Msync` for Kandelo through
its existing syscall channel and kernel mapping manager (fork
`935d07526a83289221d3df22bf0d798430f1015f`). This is a Go-target
platform API, not a Caddy or FrankenPHP source patch. The fork's focused
`syscall` test covers anonymous mappings, file-backed private isolation,
shared writeback through `msync`, exact unmap ownership, and invalid
zero-length mapping. The test passes in Node and Chromium, Firefox, and
WebKit with ABI-50 artifacts and no host diagnostics. `go-hello` rev16 and
`frankenphp-classic` rev21 pin the fork commit; both source package builds
pass, and the new FrankenPHP binary serves PHP and a static asset in a
Chromium smoke test. These are bounded API and rebuild checks, not a new
WordPress image test or a production Caddy build. Kandelo's documented
`MAP_SHARED`/`msync` limits still apply, and Caddy still needs a reviewed
`x/sys/unix` target port and the other dependency ports from the inventory.

**2026-10-13 — Direct x/sys target port.** The Go fork
`ee2c1b39515cc4b2215db302d07b3efff491c6a1` adds channel-backed
`Access`, `Flock`, and `Madvise` plus the Kandelo constants needed by
`golang.org/x/sys/unix`. The new direct x/sys fork
`9619e743cfc817e3a67db8c1a10124675cd80e89` provides Kandelo
`unix` and `cpu` target files. FrankenPHP rev22 pins both forks and
removes its local x/sys patch; go-hello rev17 pins the Go fork. Focused
Go and x/sys syscall tests pass in Node and Chromium, Firefox, and
WebKit, including file-backed mapping writeback, advisory-lock
contention, and socket-option get/set. These tests do not establish
`SO_REUSEPORT` duplicate binds, durable database sync, or general
`x/sys/unix` coverage. The stock Caddy executable now compiles past
the x/sys and Badger API errors but remains blocked by four separate
dependency target-selection families: bbolt, readline, logrus, and
certificate-transparency-go/x509. Do not patch all four into the
FrankenPHP recipe; each needs a bounded direct target port or a
reviewed platform feature as appropriate. The `go-hello` rev17 and
`frankenphp-classic` rev22 source package builds pass. The rebuilt
FrankenPHP serves PHP and a static asset in a Chromium HTTP smoke test.
The ABI snapshot check passes. This does not rebuild the WordPress
image or retest the logged-in editor workflow, and is not a Caddy
or production-readiness claim.

**2026-10-13 — Direct Caddy dependency ports.** Four independently
pinned target ports now cover bbolt's Wasm mapping bounds
(`6accd6ff6ff9122aa6db6398ae381b2fe2e2663a`), readline's PTY
terminal path (`cd55beaf2b93d4becc3100a4a06e186b5e69d85d`),
logrus's terminal detection (`179e7a7ca539075feb85112492d10d9b43e14fe6`),
and certificate-transparency-go's VFS root selection
(`c990f3c1f5e54d4e69b7b7479c30176387dab20c`). The Go fork
`7f6127f51939f64026f0aa2658fd772100899e17` adds typed terminal
and resource-limit syscalls and existing kernel `mlock`/`munlock`
bindings; x/sys `2b06cffea3dd9037ae3d2742e6f092913a88583f`
exposes those APIs. These are target implementations in direct forks,
not changes to Caddy's or FrankenPHP's source. Stock Caddy v2.10.2
`cmd/caddy` now cross-compiles with `CGO_ENABLED=0` in the local
six-module workspace. Focused package tests pass in Node and 18/18
Chromium/Firefox/WebKit cases: bbolt VFS reopen, readline PTY raw
mode, logrus terminal detection, certificate loading, and Go PTY
state. This does not prove database durability, `mlock` residency,
Caddy runtime behavior, or FrankenPHP's cgo link. A source-only Caddy
package recipe pins all six forks and builds successfully. The
fork-instrumented, ABI-50 Caddy binary serves a VFS static file over
HTTP 200 in Node, Chromium, and Firefox. WebKit fails before readiness
with a `Maximum call stack size exceeded` diagnostic in
`regexp_syntax.__compiler_.compile`; this is a browser Wasm call-stack
boundary to investigate, not evidence of a missing Caddy dependency
API. The full FrankenPHP/Caddy entry point still requires the separate
PHP/cgo link and `php_server` runtime validation before a Caddy-backed
WordPress profile can replace the classic profile.

**2026-10-14 — FrankenPHP/Caddy package and WordPress profile in progress.**
FrankenPHP v1.11.0's Caddy module now links the pinned PHP ZTS archive and
the six direct Go target forks without another upstream source patch. The
new `frankenphp-caddy` ABI-50 package completed a normal resolver build;
its published artifact serves PHP through Caddy's `php_server` and a static
VFS file with HTTP 200 in Node, Chromium, and Firefox. The WordPress image
recipe now embeds this executable and Caddyfile, adds a dinit service and
separate gallery profile, and preserves the existing nginx/PHP-FPM and
FrankenPHP classic profiles. This is package and small HTTP-fixture evidence,
not yet a working WordPress/Caddy image or logged-in editor result. WebKit
still exits before readiness with a repeated Wasm call-stack overflow; its
root cause has not been established. A full `./run.sh build wp-vfs` began
rebuilding 133 local-set nodes and was stopped at 64/133 when available disk
fell below 6 GiB; the targeted WordPress package resolver is being used
instead. No Go compiler or standard-library patch was added for this step.

**2026-10-14 — WordPress image retry and disk gate.** The normal WordPress
resolver first failed after building SpiderMonkey because the existing
`node-browser-bundle` script required `WASM_POSIX_DEP_SOURCE_DIR`; the default
archive resolver supplies the pinned URL and digest, not a source-directory
handoff. The bundle now stages its manifest-pinned npm source through the
shared verified-source helper, and its focused wasm32 resolver build
passes. Cache GC with a one-day age limit and ABI floor 50 reclaimed 5.6 GiB.
The WordPress retry advanced into the shell image's Clang dependency, but was
stopped at 16% of that build when free disk fell to 3.5 GiB. The aborted
Clang work directory was removed, restoring 6.3 GiB free. No new WordPress
VFS was published, so the Caddy-backed WordPress service, editor, and browser
profile remain unvalidated. Next: secure enough build space for the ABI-50
shell closure, complete the WordPress image, then run Node and browser editor
soaks. Separately, diagnose the WebKit Caddy startup stack overflow without
patching Go's compiler or standard library.

**2026-10-14 — ABI-50 WordPress/FrankenPHP+Caddy image and browser validation.**
The normal resolver published the WordPress 7.0 rev27 ABI-50 image after the
disk-space gate was cleared. The full `./run.sh build wp-vfs` SourceOnly build
also completed (133 nodes); `dash` was bootstrapped into that projection as
the remaining required browser binary. A real Node-host demo served the
homepage (HTTP 200), login redirect (HTTP 302), and authenticated
`/wp-admin/site-editor.php` (HTTP 200). The direct Chromium browser-host test
passed. The Kandelo browser-app UI test passed in Chromium and Firefox with
the SourceOnly projection explicitly selected: both loaded the preinstalled
site, used the demo-guide admin login, opened Appearance → Editor, and
returned HTTP 200 for repeated editor requests during a 30-second soak.
The live Vite-hosted Kandelo demo also rendered the WordPress homepage with
the `wordpress-frankenphp-caddy` profile. These checks exercise Caddy's
`php_server` and FrankenPHP's embedded PHP, not nginx or PHP-FPM. No Go
compiler or standard-library source patch was added.

WebKit is still **not working** for this profile: the same UI test failed
before HTTP readiness with `Maximum call stack size exceeded` in the
FrankenPHP/Caddy process worker. The current image does not establish its
root cause. Next: isolate that WebKit call-stack failure (including whether
unused Caddy standard modules contribute), make a maintainable target or
module-selection fix rather than a compiler/library survival patch, and
repeat the full editor test in WebKit. After cross-browser functionality,
run longer uptime/concurrency and fair PHP-FPM-versus-FrankenPHP tests before
calling the demo production-ready or making a performance claim.

**2026-10-14 — Caddy stack comparison and WebKit diagnosis.**
`benchmarks/wordpress-stack.ts` now accepts `--alternative=caddy` and
compares the preinstalled nginx/PHP-FPM and FrankenPHP+Caddy profiles from
the same SHA-256-verified ABI-50 SourceOnly image in Node and Chromium.
Four rounds alternated profile order; each host/profile collected 48
full-body dynamic homepage timings and 64 requests in four-client phases.
The raw report is `.context/wordpress-caddy-benchmark-abi50.json` (image
SHA-256 `dc19a32b3372fa0f0163ef21eb14328aab33ef4374191afc344af4197bb6e1af`).
Node nginx/FPM versus Caddy median request latency was 421 versus 689 ms,
median startup 11.2 versus 21.3 seconds, and median throughput 4.27 versus
3.83 requests/s. Chromium latency was 395 versus 596 ms, startup 21.1
versus 24.7 seconds, and throughput 5.12 versus 5.14 requests/s. This
one-machine workload shows no Caddy performance advantage. It is a
user-facing stack comparison, **not** an isolated PHP-runtime comparison:
FPM uses prewarmed OPcache, the ZTS embed does not, and the Caddy profile
has a larger Wasm memory ceiling.

A separate package experiment imported Caddy standard modules without its
unused templates module, but the WebKit PHP/static fixture still crashed
before readiness with the same Wasm call-stack overflow. FrankenPHP's
`php_server` imports Caddy's file server, which itself imports templates
and Goldmark, so that experiment did not actually remove Goldmark. The
module-selection edit was reverted and the rev1 package artifact restored.
WebKit's root cause and a maintainable solution remain open; no Caddy,
FrankenPHP, Go compiler, or Go standard-library source patch was kept.

**2026-10-15 — WebKit call-stack cause narrowed.** A temporary normal
resolver build of FrankenPHP+Caddy with fork-instrumenter `--keep-names`
failed the focused WebKit PHP/static fixture before readiness with repeated
`regexp_syntax.__compiler_.compile` frames, not an anonymous function.
The shipped build was restored after diagnosis. Caddy's file server imports
templates and Goldmark transitively; Goldmark's linkify URL regex includes
`{1,256}`. A native Go `regexp/syntax` probe measured simplified AST
depth 512 for a representative prefix of that pattern (511 even for
`a{1,256}`). This strongly
connects a deep recursive regex compile to WebKit's Wasm call-stack limit,
but does not yet prove which exact initialization-time pattern first
overflows there. A general stack-safe regex compilation strategy would
touch the Go standard library, contrary to the preference against a pile
of survival patches; discuss a small, upstreamable design before changing
that library. No Go or package-source change was kept. The WebKit demo
still fails; Node, Chromium, and Firefox results are unaffected.

**2026-10-15 — Longer editor and authenticated-write validation.** The
ABI-50 SourceOnly WordPress/Caddy profile passed the full browser UI test
in Chromium and Firefox with 180-second editor soaks (18 repeated editor
GETs per engine). A new browser test logs in through the demo guide, uses
WordPress's own REST nonce to publish and update a post, checks both
versions through frontend HTTP, and deletes the post. It passes for both
FrankenPHP classic and FrankenPHP+Caddy in Chromium and Firefox (4/4).
The same create/read/update/read/delete path passed through the Caddy Node
demo. These checks establish authenticated SQLite-backed writes in those
hosts; they do not prove every site-editor UI save flow.

The earlier unattended Node Caddy demo then ended after roughly 3 hours
41 minutes: dinit reported the Caddy process exited with code 2, but dinit
itself returned 0, so the old demo helper misleadingly reported success.
Its guest service log was not captured, leaving the cause unknown. The
shared server-demo helper now treats any unrequested dinit exit as failure
and can print a selected guest service log before teardown; the Caddy demo
selects `/var/log/frankenphp-caddy.log`. A focused Vitest case passes for
both the nonzero exit and log output. A fresh Node Caddy demo is running
with that diagnostic path, but long-idle stability is not yet established.

The classic profile also failed once in the Firefox browser UI during a
30-second site-editor soak: its process exited with code 2 amid Gutenberg's
concurrent REST and compression-test requests, leaving the HTTP bridge with
no listener. The VFS inspector becomes unavailable after init exits, so the
guest service log was not captured and the cause remains unknown. A direct
Firefox kernel-host test with eight rounds of those two concurrent request
types passed; three subsequent Firefox UI editor reruns also passed. This
is an intermittent failure, not evidence that the issue is fixed. A
temporary browser-app log probe was removed after those runs. The Node
FrankenPHP demo helpers now capture bounded service-log tails on unexpected
init exit, with a five-second read timeout, so a future long-run failure
can retain its guest diagnostics without leaving the helper hanging.

The expanded direct browser-host gate passed its eight-round editor burst
for both profiles in Chromium and for classic in Firefox. Caddy's first
homepage request returned 504 once in Firefox after the 30-second request
deadline; two isolated Firefox Caddy reruns passed. No guest crash was
observed in that case, but the intermittent timeout still needs diagnosis.

**2026-10-15 — Preserve browser guest-log inspection after init exits.**
The browser app's VFS inspector had waited forever for `running` status
after the machine entered `error`, even though the kernel and its guest
files remained attached. It now reads through `KernelHost` in either
`running` or `error`, while still waiting during boot. A browser fixture
mounts the real inspector and host contract around an attached VFS, then
transitions to error and reads a guest service log. The focused fixture
passes in Chromium, Firefox, and WebKit. This opens a way to capture the
next intermittent classic crash's actual guest log; it does not explain
the prior crash by itself.

With the error-state inspector available, a longer Firefox classic UI
run reproduced the failure three times in 12 30-second editor attempts
(nine passed). The guest log identifies `fatal error: runtime: split stack
overflow`, not a WordPress/PHP exception. One trace has goroutine 228's
4 KiB stack at `[0x3454000, 0x3455000]`, and `newstack` sees SP
`0x3453f78`, below the low bound. The stack is in
`net/http.(*chunkWriter).writeHeader` calling
`net/http.(*Server).doKeepAlives`. The Go compiler reports a 2,776-byte
frame for `writeHeader`, without `NOSPLIT`; its entry should have grown
the stack. Why the check did not protect this call remains to be traced.
An eight-repeat follow-up, which attached the full 64 KiB VFS preview
on failure and printed its head, reproduced the same split-stack error
once (seven passed). An earlier 8/8 pass therefore did not establish
stability. The browser UI test now checks that it can read the service
log during normal operation and retains it when the editor fails.
Chromium and Firefox passed that normal editor/log-inspection gate for
both classic and Caddy (4/4). No Go compiler or library fix, package
workaround, or claimed stability improvement is included here.

**2026-10-15 — Fix Go Wasm large-frame stack checks during preemption.**
The Kandelo Go fork's Wasm compiler encoded the large-frame stack check as
`SP <= stackguard0 + (framesize - StackSmall)`. When Go preemption sets
`stackguard0` to `stackPreempt`, the 32-bit addition wraps to a low address
and incorrectly skips stack growth. A single compiler fix replaces this
with an unsigned `SP <= stackguard0 || SP - stackguard0 <= framesize - StackSmall`
check. It is in `kandelo-dev/go` commit `60aa39d104e8783f99045edb226cae8bf4303d42`;
the Go, Caddy, and FrankenPHP package recipes now pin it. This is a general
Go/Wasm compiler correction, not a WordPress or package workaround.

With the old pinned compiler, the `http-basic` probe compiled using Go's
`-d=maymorestack=runtime.mayMoreStackPreempt` hook fails deterministically
in Node with the same `net/http.(*chunkWriter).writeHeader` split-stack
trace as the intermittent Firefox WordPress editor crash. The fixed
compiler's fresh-cache build completes the same instrumented Node probe.
The browser fixture now builds and runs that regression: Chromium and
Firefox pass; WebKit timed out once when all three engines ran together,
then passed in isolation. The Go fork builds its `js`, `wasip1`, and
Kandelo standard libraries, with Kandelo also built in cgo mode. These
gates verify the compiler defect and fix, not the rebuilt WordPress demo.
Next: rebuild package and image artifacts from the new pin, repeat the
Firefox editor workflow, and continue diagnosing Caddy's WebKit native
regexp call-stack overflow.

**2026-10-15 — Rebuilt WordPress on the fixed Go toolchain.**
The normal resolver built Go hello, FrankenPHP classic, standalone Caddy,
and FrankenPHP+Caddy from the pinned compiler. The SourceOnly
`./run.sh build wp-vfs` then published a new WordPress 7.0 image with
SHA-256 `5b83dc5582e79888fbcd8ea9ff89f0d3690e406082c1b6c6f883f50f37138c62`.
The public-directory copy still has the prior image hash; these checks
explicitly select the SourceOnly projection, whose Vite asset URL carries
the new digest. A pre-existing Vite server on port 5401 had captured an
older SourceOnly snapshot and rejected the new kernel member size; using
a fresh test port resolved that test-environment mismatch.

On the new image, Chromium and Firefox each passed the classic and Caddy
site-editor workflow plus authenticated post create/read/update/read/delete
(8/8 browser cases, 30-second editor soaks). The previously intermittent
Firefox classic editor passed twelve further independent 30-second soaks
(12/12). This is strong evidence for the fixed split-stack check, not proof
that every editor workload or long-running server is stable. The new Node
FrankenPHP+Caddy demo serves the homepage and login with HTTP 200. It was
started while an older Node demo occupied SMTP port 1025, so its startup
log includes an `EADDRINUSE` for that secondary listener; run it alone
before treating this as a clean full-service startup gate.

WebKit passed the classic site-editor workflow but the Caddy profile
still failed before readiness with `Maximum call stack size exceeded`
in the process worker (one pass, one fail). The compiler preemption fix
does not address Caddy's separate regexp compilation recursion. Before
claiming cross-browser or production-ready Caddy support, isolate a
maintainable general fix for that stack boundary, finish long-uptime
checks, and repeat paired runtime and user-facing performance comparisons
with the rebuilt image. Cache GC using the previously chosen one-day age
and ABI-50 floor reclaimed 19.5 GiB before the image rebuild.

**2026-10-15 — Isolate WebKit Caddy regexp compilation overflow.**
An exact Goldmark linkify expression fails a small Go browser probe on
WebKit with the same `regexp_syntax.__compiler_.compile` stack overflow as
FrankenPHP+Caddy; Chromium passes. A shorter expression does not reproduce
it. Flattening counted repeats in `regexp/syntax.Simplify` was rejected
because it changes lazy-capture semantics. Instead, the Kandelo Go fork
uses an iterative compiler fallback for deeply nested syntax trees in
commit `4c644a03afc645936fa9322b840dc73bd53cdc87`. Native regexp tests,
cross-target standard library builds, and bytecode/submatch differential
checks pass. The exact Goldmark probe now passes Chromium, Firefox, and
WebKit. Four Go package recipes pin that fork commit; a fresh WordPress
SourceOnly image build is running. Full Caddy/WebKit editor validation is
still pending and browser parity is not yet claimed.

**2026-10-15 — Validate rebuilt FrankenPHP+Caddy in WebKit.**
The first SourceOnly image build failed when concurrent FrankenPHP+Caddy
instrumentation was killed under disk pressure. An ordinary isolated
FrankenPHP+Caddy build passed; the SourceOnly image rebuild then passed after
clearing regenerable caches. Its WordPress image SHA-256 is
`6fbec811085e46f81b255cc5d86046bcab2f71fc50c1ffebf089fc270b9ea563`.
The fresh Vite server initially rejected a stale `dash.wasm` file absent
from its pinned SourceOnly projection; running the normal `xtask bootstrap
dash` path restored projection ownership. Direct `build-deps resolve dash`
populated the compiled cache but not the browser projection, so it was not
enough. No Vite resolver bypass was used.

With a fresh Vite port and this projection, the once-failing WebKit
FrankenPHP+Caddy site-editor test passed its 30-second soak. The full
WordPress UI suite then passed 12/12 cases: classic and Caddy site-editor
soaks plus authenticated post create/read/update/read/delete in Chromium,
Firefox, and WebKit. This establishes cross-browser parity for the tested
workflows; clean Node startup is checked separately below, while longer
uptime and paired performance evidence remain open.

The new Go pin also passed normal resolver builds of standalone Caddy and
Go hello. A fresh Node FrankenPHP+Caddy demo started all four services,
including SMTP capture, without `EADDRINUSE`; its homepage and login serve
HTTP 200 and the unauthenticated admin redirects as expected. An older Node
demo stayed alive and served HTTP 200 for more than five hours before being
stopped to free its SMTP port. That is idle-uptime evidence for the prior
image, not a long-uptime gate for this rebuilt one.

**2026-10-17 — Recheck uptime and paired stack performance without retaining browser guests.**
The rebuilt-image Node FrankenPHP+Caddy demo remained running for nearly
60 hours and still returned HTTP 200 for the homepage and login. This is
long idle-uptime evidence, not a sustained-traffic or restart/recovery test.
An attempted four-round Node+Chromium comparison was stopped during its
third browser round after a Chromium renderer reached roughly 10 GiB RSS;
its incomplete results were discarded. The benchmark had reused a single
Chromium browser/context across profiles and rounds, and closing pages had
not reclaimed the accumulated guest memory. The harness now launches and
closes a fresh browser for each browser profile/round. A two-round minimal
smoke passed with no Chromium process left behind; a full four-round browser
run then passed, with the renderer around 1 GiB RSS at a mid-run check and
no renderer remaining afterward.

The full current-image benchmark used SHA-256
`6fbec811085e46f81b255cc5d86046bcab2f71fc50c1ffebf089fc270b9ea563`,
four alternating-order rounds, 48 dynamic homepage samples per host/profile,
and 16 requests per four-client throughput phase. Raw reports are
`.context/wordpress-caddy-node-benchmark-regexp.json` and
`.context/wordpress-caddy-browser-benchmark-regexp.json`. Node nginx/FPM
versus FrankenPHP+Caddy request medians were 457 versus 756 ms, startup
medians 11.9 versus 23.4 seconds, and throughput medians 4.12 versus
3.68 requests/s. Chromium request medians were 420 versus 684 ms, startup
medians 21.6 versus 26.8 seconds, and throughput medians 5.00 versus
5.05 requests/s. This user-facing uncached stack comparison does not show
a Caddy advantage. It is not a fair isolated PHP-runtime comparison because
FPM has prewarmed OPcache while the ZTS embed does not. An accelerated
FrankenPHP configuration or a safe visitor-facing cache comparison remains
necessary before making a stronger performance conclusion.

A separate five-minute, two-client uncached-homepage soak against the same
long-running Node FrankenPHP+Caddy demo returned 664/664 valid HTTP 200
responses, with the slowest request at 1,122 ms; the service still answered
afterward. Its host Node process reached about 2 GiB RSS by the end. That
is a resource-use observation, not proof of a leak or a bounded steady
state. The diagnostic Node server and older stale demo servers were stopped
to return memory to the user's machine; the latest Vite browser demo remains
live. Production readiness still needs a measured memory plateau, repeated
restart/recovery checks, and an accelerated or cache-enabled configuration
whose personalized-request bypass and invalidation are verified.

**2026-10-17 — Supervise FrankenPHP+Caddy crash recovery.**
The WordPress image now sets dinit's `restart = true` with a one-second delay
for FrankenPHP+Caddy, instead of leaving the HTTP service stopped after an
unexpected exit. The normal SourceOnly WordPress image rebuilt successfully
as recipe revision 28 (SHA-256
`b698ca89edbf300a899a090c02919b871f90d4c28e1ad94c8b369e04f7a7f45a`).
A browser-host regression sends SIGKILL to the live Caddy guest process,
waits for a different listener PID, and confirms WordPress serves HTTP 200
afterward. Chromium, Firefox, and WebKit each passed. The equivalent Node
guest test also recovered, from PID 103 to PID 117, and served the homepage.
The rebuilt image also passed the Chromium user-facing Caddy demo's login,
site-editor, and 20-second editor soak. A fresh SourceOnly Vite process on
port 5415 serves the new image by its content-addressed URL; the older
port-5414 preview remains unchanged. These checks prove one crash/restart
cycle on the rebuilt image, not a multi-day reliability or memory-plateau
guarantee.

The upstream Caddy Sidekick WordPress page-cache module was evaluated as a
separate user-facing acceleration path, but was not shipped. The
upstream commit inspected (`ee528d8bbf3cf4852e335da153dfbd264002c690`)
defaults its purge token to `dead-beef`, its auto-installed purge plugin
disables TLS certificate verification for purge requests, and the plugin's
post-save handler does not invalidate the homepage. Those are unsuitable
defaults for a production-ready WordPress comparison without additional
integration and security work. A pinned module-inclusion build reached the
fork-instrumentation stage but was stopped after the instrumenter exceeded
6 GiB resident memory and reported host free memory fell near 40%; the
experimental package edits were reverted. This is not evidence that the
module fails to compile, only that this particular approach is presently
unproven and resource-intensive. Prefer a reviewed cache/invalidation
contract or general OPcache support over shipping the module blindly.

**2026-10-17 — Recheck Node memory under controlled WordPress traffic.**
A fresh Node FrankenPHP+Caddy guest with six PHP threads reached 12.5 GiB
host RSS after startup and settled near 11.7 GiB during three minutes of
two-client homepage traffic (358/358 valid HTTP 200 responses). `vmmap`
reported an 11.7 GiB physical footprint, with roughly 6.5 GiB resident
in large malloc regions and 3.3 GiB in app-specific tag-16 regions. The
V8 heap was only about 20 MiB; the bulk is native/external memory. A
longer run was stopped when `top` showed only about 4 GiB system memory
unused. A one-minute diagnostic with the same image but two PHP threads
still reached about 9.6 GiB RSS (97/97 valid responses). These samples do
not establish a leak or a plateau; the earlier roughly 2 GiB observation
was not reproduced under this direct process-RSS measurement and must not
be used as a memory bound. `memory_pressure -Q` reported roughly 89% free
even while `top` showed little unused physical memory, so it is not a
sufficient guard for this workload. Before calling this production-ready,
isolate native memory among the large Go/Caddy Wasm module, Wasm worker
instances, and image preparation, then reduce and measure its steady-state
footprint on both Node and browser. Do not hide it by only lowering PHP
thread count: two threads still leave a multi-GiB footprint.

**2026-10-17 — Isolate the high Node footprint without another full soak.**
In fresh single-purpose Node processes, reading the compressed WordPress image
raised RSS from 93 to 168 MiB, loading it through the image module raised RSS
to 1,106 MiB, and saving the configured 461 MB rootfs image raised RSS to
1,570 MiB. A separate Caddy Wasm probe raised RSS from 64 to 444 MiB after
reading and compiling the 177 MiB binary; instantiating that compiled module
without executing its entry point raised it only to 469 MiB. These are
process-level observations, not an additive memory breakdown of the live demo.
Repeating that non-executing instantiation with the imported shared memory's
maximum reduced from 16,384 to 8,192 pages produced the same 469 MiB RSS;
that does not establish how a running guest behaves under the lower ceiling.

The full Caddy guest in Node reached 3,193 MiB after dinit spawned and
12,794 MiB after homepage readiness. Its module cache reported four compiles
covering 188 MB of input bytes, no separate thread compiles, and a live guest
linear-memory allocation of about 200 MiB for the Caddy process. The same
WordPress image running FrankenPHP classic reached 3,204 MiB after dinit and
7,325 MiB at homepage readiness; its classic Wasm binary is 69 MiB rather
than Caddy's 177 MiB. Thus image preparation, a single Wasm compile, and the
guest's live linear memory do not independently explain the Caddy run's
roughly 12.8 GiB RSS. The large increment occurs while executing the much
larger Go/Caddy module and its workers; Wasm native-code generation or
per-worker state remains a hypothesis, not a proven allocation attribution.
The Caddy Wasm has about 182,000 functions and 109 MiB of code-section input.
FrankenPHP classic has about 76,500 functions and 39 MiB of code-section
input. Both have 100,000 data segments because upstream Go's Wasm linker
deliberately caps its zero-skipping data segmentation there; the identical
count alone does not identify a Caddy-specific defect. With Node's
`--print-wasm-offheap-memory-size`, the compiled but nonexecuting Caddy
module reported about 188 MiB of V8 NativeModule off-heap memory at exit.
That measurement further rules out one idle compiled module as the sole
explanation for the live process's multi-GiB native footprint; it does not
measure native code or instance state after execution begins.

A separate standalone Caddy v2.10.2 static-file probe, with no PHP or
WordPress image, served HTTP 200 from the VFS with empty diagnostics. A
guarded sample saw 2,729 MiB peak Node RSS before that short process exited.
Its binary has about 61,000 functions and 53 MiB of code-section input.
This shows that a plain Go/Caddy server can itself consume multi-GiB host
memory on this Node/macOS setup, but the binary and image differ from the
FrankenPHP+Caddy run, so subtracting their RSS totals would not isolate
PHP's contribution. A second probe requesting V8's exit-time off-heap report
was terminated by the resource guard when system unused memory fell to
1,922 MiB; it produced no usable off-heap report. Do not repeat full guests
under this headroom.

With headroom restored, a guarded rerun of standalone Caddy static HTTP
passed again and peaked at 2,824 MiB Node RSS. Stage samples were 92 MiB
before image creation, 695 MiB after the small VFS image was saved, 1,096
MiB after kernel initialization, 1,464 MiB just after Caddy spawn, and
2,824 MiB at HTTP readiness. The live Caddy process reported about 68 MiB
guest linear memory. The module cache reported two compiles, one for the
program and one patched thread module, covering 164 MB of Wasm input; V8's
exit-time NativeModule off-heap reports totaled roughly 180 MB. `vmmap`
reported a 2.6 GiB physical footprint: about 1.2 GiB resident in Malloc
Large, 526 MiB resident in Malloc Large (empty), and 658 MiB resident in
app-specific tag-16 regions. Those region totals must not be added to the
guest or V8 module counters as though they were separate allocations. This
strengthens the conclusion that neither guest linear memory nor compiled-
module bytes alone
explain host RSS. It does not identify which active Caddy/Go allocations
remain necessary, prove a leak, or establish a production memory bound.

A controlled rerun with a 512 MiB guest memory ceiling is prepared but not
run: other active Conductor processes left only 3–8 GiB unused physical
memory, below the observed Caddy guest footprint. Do not turn the diagnostic
ceiling into a production limit without a successful site-editor and restart
gate on both hosts. Next isolate live thread/instance counts and native Wasm
code memory with bounded instrumentation when system headroom permits; then
measure a memory plateau and revisit acceleration. The prior 2 GiB sample
remains unsuitable as a production memory bound.

The Go-runtime-specific guidance now distinguishes Wasm input-byte cache
stats, guest linear memory, and native host footprint, and documents bounded
Node/browser profiling. No runtime behavior or package build changed in this
diagnostic step.

**2026-10-17 — Transfer Node's private rootfs image copy.** The Node host
previously copied a caller's image into a private `ArrayBuffer`, then
structured-cloned that buffer into its kernel worker. It now transfers the
private buffer instead; an `ArrayBuffer` caller is also copied first so the
caller remains undetached. The browser already distinguishes copy-preserving
`initFromImage` from explicit ownership-taking `initFromOwnedImage`.
The focused Node host test passed 3/3 cases, including byte-view and
ArrayBuffer ownership checks plus a real VFS read. The existing Node rootfs
export/reboot suite also passed 9/9 cases (with its known legacy ABI-stamp
warnings), and `host`'s declaration build/typecheck passed. The default-
rootfs image-build-determinism suite failed 3/4 with `rootfs read failed`;
reverting only the Node handoff change and rerunning produced the same 3/4
failures, so that suite is not evidence of a new transport regression.
The handoff change was then restored. This removes one image-
sized transport copy by inspection, but no before/after physical-memory or
application benchmark was run, and the multi-GiB live Go/Caddy footprint
remains open. The browser host code was unchanged; its existing copy-preserving
and ownership-taking tests were not rerun in this diagnostic step.

**2026-10-17 — Prefer the current package rootfs over a stale legacy image.**
The default Node rootfs test's `rootfs read failed` was not caused by the
private-buffer transfer. The selected `host/wasm/rootfs.vfs.zst` recorded
SHA-256 `1a28c52f…` for its deferred `/usr/bin/bash`, while the current
SourceOnly Bash has the same 1,884,697-byte length but SHA-256
`15ca1c67…`. The lazy fetch completed, then the kernel rejected the digest;
the current SourceOnly `programs/rootfs.vfs.zst` records `15ca1c67…`.
Default Node boot now prefers that resolver-managed package image and uses
the legacy image only when the package output is genuinely absent. Package
policy rejections remain errors rather than silently falling back.
The focused Node host suite passed 6/6, covering package priority, absence
fallback, policy rejection, and caller-buffer ownership. A direct default-
rootfs probe then read both `/usr/bin/bash` and `/bin/bash` successfully
(1,884,697 bytes each) through lazy fetch. After the other workspace's
WebKit worker exited and headroom returned, the full Node image-build-
determinism suite passed 4/4 and the Node host-mounts suite passed 16/16
against the new default selection. These establish the tested Node default
rootfs, lazy Bash, deterministic clock/entropy, and mount paths; they do
not measure the FrankenPHP+Caddy guest's steady-state memory or browser
performance.

**2026-10-17 — Let one-shot Node service demos surrender their image.**
The existing Node handoff preserved caller bytes by copying the raw rootfs
before transfer, but `bootDinitServiceVfs` owns the image freshly exported
by the image writer and never reuses it. Node now has an explicit
`takeRootfsImageOwnership` option for a whole `ArrayBuffer`; the helper uses
it to transfer its raw image without that private copy. Ordinary callers
retain copy-preserving behavior. The focused Node host suite passed 8/8,
including detachment, a real VFS read, and rejection of an ownership-taking
byte view. Host declaration build/typecheck passed. A direct standalone
TypeScript check of the service helper reached an unrelated pre-existing
`host/src/webgl/query.ts` TS2352 error; it did not report a helper error.
The prepared-product service VFS suite then passed 4/4 with a tiny Dinit
image that the real helper imports, edits, re-exports, transfers, and boots.
It reads the edited file through the running host's VFS. The combined
service/Node host run passed 12/12, and host typecheck passed again.
No before/after WordPress RSS or browser benchmark was run for this change,
so its application-level memory benefit is not yet measured.

**2026-10-17 — Export linked C symbols to Go/cgo side modules.** The Go
fork's Kandelo internal linker now accepts explicit
`-Wl,--export-dynamic-symbol=<name>` requests through Go's `-extldflags`.
It selects archive members, roots requested functions through dead-code
elimination, and emits function exports or immutable data-address globals.
`-ldl` selects the SDK's real Wasm `dlopen` glue rather than an empty
compatibility archive. This is a general target feature, not a PHP package
patch. The fork commit is `b2a32e2878f3c341b8a12b3b93a9cc997c8d5116`;
all four Go-consuming package recipes now pin it and increment their output
revisions. The Go toolchain rebuilt, a pure-Go program cross-built for js
and WASI, and the pre-existing cgo static-archive Node probe still passed.
The new `cgo/c-exports` fixture rejects a missing requested symbol and
loads a side module that imports an otherwise-unused C function and data
symbol. Its ABI-stamped Node process passed with empty stderr/diagnostics,
and the focused Chromium, Firefox, and WebKit browser process gates passed
3/3. The `go-hello` SourceOnly package rebuilt from the new pin. These are
not evidence that OPcache's hundreds of Zend/PHP imports resolve or that
the WordPress Caddy stack has improved performance. Next rebuild the other
three pinned packages, then attempt the PHP ZTS OPcache import closure and
live load without package-specific symbol shims. The standalone Caddy
SourceOnly package also rebuilt from the new pin; FrankenPHP classic and
Caddy package rebuilds remain outstanding. The classic package compiled its
Go/PHP executable, but fork instrumentation reached 10.6 GiB RSS while
the host reported under 0.1 GiB unused. The instrumenter was terminated
to avoid exhausting the user's machine; the SourceOnly package did not
publish, and the Caddy package was not started. This is a resource gate,
not a compiler or runtime success/failure result.

**2026-10-17 — Package ZTS OPcache without PHP-specific linker shims.**
The `php-zts` SourceOnly recipe now requests PHP's upstream shared OPcache
extension, builds the static embed target separately to avoid PHP libtool's
unsupported Wasm shared-link command, and links the PIC extension objects
with the SDK's side-module linker. The existing CLI/FPM OPcache module uses
the same helper, including fork instrumentation and the side-module ABI
marker. The revised ZTS package (revision 5) rebuilt and resolver-validated
`libphp.a` and `opcache-zts.so`; the latter is 279 KiB and imports 290
entries (242 functions, 42 globals, two tags, one memory, three tables).
The first live-load attempt identified a missing mutable `__tls_base` export;
the ZTS side-module link now requests it, matching Kandelo's fork-replay
contract. A general import-enumeration utility derives explicit C exports
from side modules; the small side-module fixture still passes on Node and
three browser engines with generated requests. The PHP embed fixture links
the real OPcache import closure and `dlopen`s the ZTS module after PHP
initialization. Its ABI-stamped Node run exited 0 with empty stderr and
host diagnostics; Chromium, Firefox, and WebKit passed the focused browser
gate 3/3. This is live module loading, not Zend registration or accelerated
execution. FrankenPHP and WordPress have not been rebuilt on this package
pin, and no OPcache performance claim follows. Full FrankenPHP
instrumentation remains a memory-headroom gate.

An exploratory `zend_extension` INI boot in the PHP embed fixture confirmed
that PHP read the INI and registered OPcache, but PHP upstream refused to
activate caching for the `embed` SAPI: its built-in supported-SAPI check
explicitly names FrankenPHP, not `embed`. This is not a Kandelo loader
failure; do not rename the test SAPI to fake activation. The exploratory
mode was removed. Activate and test the module in real FrankenPHP instead.
The existing PHP CLI/FPM SourceOnly package also rebuilt successfully
after its OPcache side-module link was moved into the shared helper; this
is a build regression check, not a fresh CLI/FPM runtime soak. After the
fixture cleanup, both ABI-stamped Node probes passed again, and the combined
PHP embed, ZTS OPcache `dlopen`, and generic C-export browser run passed 9/9
across Chromium, Firefox, and WebKit.

**2026-10-17 — Wire real FrankenPHP OPcache activation through packages and
the WordPress image.** Both FrankenPHP package builds now derive the ZTS
side module's required C exports from its Wasm imports and pass them through
the Go fork's general external-linker export option; the upstream cgo link
line also selects the SDK's `dlopen` library. The `php-zts` package projects
its OPcache side module as a named VFS product input. WordPress declares
`php-zts` directly, stages the module separately from FPM's NTS module,
and uses its own FrankenPHP INI and file-cache directory. The file cache is
not prewarmed; no performance result is implied. Shell syntax, diff checks,
the VFS product catalog tests (3/3), the package-output projection shell
test, and importing the image builder under
the dev shell passed. The ZTS revision 6, classic revision 24, Caddy revision
3, and WordPress revision 29 packages have **not** been rebuilt or booted
on these changes. The system had only 0.35–5.5 GiB free during this step,
well below the prior 10.6 GiB classic instrumenter peak, so a full rebuild
would risk exhausting shared machine memory. Next: rebuild when safe,
verify actual OPcache activation in the FrankenPHP SAPI on Node and all
three browser engines, then run the WordPress editor workflow and measure
memory/performance against PHP-FPM.

**2026-10-17 — Add real-SAPI activation gates before the memory-safe
rebuild.** The standalone FrankenPHP classic Node runner now accepts an
optional ZTS OPcache module. It stages a real INI and side module, then
asks FrankenPHP to compile and cache a separate PHP file. The WordPress
browser-host gate performs the same request-level check for both classic
and Caddy before checking login, editor, and restart behavior. These are
actual PHP API observations (`opcache_get_status`, `opcache_compile_file`,
`opcache_is_script_cached`), not a declaration that the module loaded.
Playwright discovered all six browser-host cases and esbuild parsed both
changed TypeScript files. The tests have not executed against the revised
FrankenPHP/WordPress packages because those artifacts remain unbuilt; no
OPcache activation or performance result is claimed. The older Go linker
emitted 100,000 data segments for the 69 MiB classic Wasm, but no evidence
yet establishes whether that or the instrumented function IR caused the
10.6 GiB peak. Do not change the linker or instrumenter on that guess.

The first activation probe exposed an incorrect assumption in the image
recipe: PHP's file-cache-only mode reports `opcache_enabled=false`, and
`opcache_is_script_cached` did not establish a hit. A local PHP 8.4
diagnostic showed that normal shared-memory OPcache reports activation,
but a newly written test file needs `opcache.file_update_protection=0`
before the immediate compile/cache check can pass. FrankenPHP runs PHP
threads inside one process, unlike the separate FPM worker processes, so
the WordPress recipe now uses a 64 MiB shared OPcache instead of FPM's
file-cache-only setting. The Node test fixture uses the same INI options;
WordPress revision 30 reflects the changed image bytes. This is a
configuration correction based on PHP behavior, **not** a Kandelo runtime
result. The real ZTS module and FrankenPHP SAPI still need to be built and
run before activation can be claimed.

**2026-10-17 — Rebuild the revised ZTS package under shared-memory
pressure.** A first revision-6 SourceOnly attempt was stopped during
configure when free RAM fell below 1 GiB while another workspace's
browser suite was active; this was a deliberate resource stop, not a
source failure. After that suite completed, the revision-6 PHP-ZTS
resolver build passed in 4m51s. It published `libphp.a` (91 MiB) and
`opcache-zts.so` (279 KiB). The OPcache side-module SHA-256 exactly
matches the previously Node/browser-loaded revision-5 module
(`37b5be3108c232d81379689b91e47df1560c4ca2a90447d2e0bc81e19a30dcd6`),
as expected because revision 6 only adds VFS product projection. This
does not prove the new product selector was projected: the package was
resolved without a product selection. WABT `wasm-validate` still rejects
the existing module at byte `0x223` even with `--enable-all`, despite the
prior Node/browser `dlopen` evidence; do not use this WABT result as a
runtime verdict. A new peer browser suite again reduced unused RAM below
0.5 GiB, so the much larger FrankenPHP instrumenter was not started.

**2026-10-17 — Measure the revised classic link before instrumentation.**
After the peer browser suite finished, a diagnostic fork-tool override
copied the raw revision-24 FrankenPHP classic executable out of the
resolver work directory and intentionally stopped that package build
before fork instrumentation. No invalid executable was published. The
raw Wasm is 56 MiB, with 43,502 defined functions, 100,000 data
segments, and 255 exports. Comparing its export section with the
revision-6 ZTS OPcache module's import-derived list found all 242
requested symbols present, so the new Go external-linker export flags
work for the real FrankenPHP/PHP static link. The instrumenter's
`--sink-report` analysis completed in 9.31 seconds with 1.93 GiB peak
resident memory and marked 34,233 functions in its conservative fork
closure (`source=closure`). This is strong evidence of why the full
rewrite is expensive, not proof that any specific algorithm or data
segment policy causes its earlier 10.6 GiB peak. Full fork
instrumentation, ABI stamping, Node/Chromium boot, and WordPress
verification remain open. Do not publish or run the raw diagnostic Wasm
as a Kandelo package.

**2026-10-17 — Bound fork reference-analysis lifetime.** The instrumenter
used to retain reference-liveness analyses for every activation before
rewriting any function. Analysis reads one function's original body and
the fixed fork-target set; each unprocessed function still has its
original body, so the transform now computes that analysis immediately
before rewriting the corresponding function and releases it afterwards.
This is a generic instrumenter memory change, not a Go or PHP package
patch, and does not change fork metadata or the emitted ABI. The full
`fork-instrument` crate suite passed 388 tests. Four representative
WAT fixtures (nested regions, nested direct/indirect calls, and legacy
catch) emitted byte-identical Wasm with old and new tools. A bounded
3,000-function/16-call reference fixture also emitted identical Wasm;
its peak resident size fell from 248 MB to 205 MB. This measurement
does **not** establish the large FrankenPHP build's new peak: the prior
full rewrite reached 10.6 GiB and current free memory remains below
that. `cargo fmt --all --check` reports pre-existing formatting diffs
outside this change. The ABI snapshot check also fails on unrelated
existing kernel/export/IOCTL differences; no ABI files or public
instrumentation layout changed here. Full FrankenPHP instrumentation,
Node/Chromium boot, and WordPress validation remain open.

**2026-10-17 — Test pre-instrument optimization before changing the
FrankenPHP recipes.** The raw classic executable's active element
segment lists all 43,502 defined functions, so omitting resume thunks
for non-table functions cannot materially shrink this Go build. The
instrumenter's documented pre-optimization pipeline was also tested on
the captured raw executable, without publishing either output. Binaryen
126 with `--all-features -Os` and `-O2` produced approximately 51–52 MiB
modules with 40,505 functions; the fork-closure report still selected
33,027 activations, only 3.5% fewer than raw. The `-O2` optimization
itself peaked at 1.26 GiB RSS, and its fork-closure analysis peaked at
1.80 GiB versus 1.93 GiB for raw. This does not plausibly remove the
full rewrite's observed 10.6 GiB memory gate. WABT 1.0.36 reports an
invalid block signature in both optimized outputs, but Node 24's
`WebAssembly.validate` accepts raw, `-Os`, and `-O2`; this conflicting
validator evidence is not a browser/runtime behavior test. The proposed
recipe edits were reverted rather than introduce an unvalidated
pre-optimization step for both FrankenPHP executables. Next establish
safe memory headroom and measure the full instrumenter after the
reference-analysis lifetime change, then build and run the package.

**2026-10-17 — Recheck the published ZTS module in Node and Chromium.**
The SourceOnly revision-6 `opcache-zts.so` has the same SHA-256 as the
browser fixture's previously tested module. The current ABI-stamped
Go/PHP embed probe, selected source resolver kernel, and actual
revision-6 module passed the focused Node run with clean stderr and
host diagnostics (`PHP EMBED PASS`, `GO PHP EMBED PASS`, and
`PHP OPCACHE DLOPEN PASS`). The focused Chromium browser-host test
also passed 1/1 using the byte-identical fixture module and current
source resolver kernel. A first Chromium attempt reused a Vite server
started on October 12 at port 5401; its old asset index rejected the
new kernel member size and caused a page-console 500 even though the
guest probe's assertions had passed. A fresh Playwright server on port
5429 passed without that error. These checks establish ZTS embed and
module loading, **not** OPcache activation in the FrankenPHP SAPI or
WordPress behavior; those require the still-unbuilt executable.

**2026-10-17 — Stop duplicating source instructions during fork rewrite.**
The top-level and nested switch transforms used to take each original
instruction region from Walrus and then clone every surviving
instruction into partition chunks, retaining the original allocation
until the function returned. The final rewrite now partitions the taken
region by ownership. Read-only pre-analysis still clones where it needs
an owned partition; this change does not alter call-site classification,
continuation metadata, or the ABI. All 388 `fork-instrument` crate tests
passed. Four nested/legacy WAT fixtures and the 3,000-function reference
stress fixture emitted byte-identical Wasm versus the pre-change tool.
The stress run used 210 MiB peak RSS, versus 205 MiB in the immediately
preceding run; this is not evidence of a peak reduction at that scale.
The change removes a transient full-region duplicate, but the new peak
for the 34,233-activation FrankenPHP executable remains **unmeasured**.
Do not treat this as clearance to rebuild under the current roughly
5 GiB of unused system memory.

**2026-10-17 — Pause at the FrankenPHP memory gate.** A bounded
inspection of the captured raw classic Wasm found that all 100,000 data
segments are active. Their offsets increase and every neighboring pair
has a gap; the segments contain about 32.3 MiB of payload. The current
module-state planner converts each active segment to a passive one and
adds an offset global before generating replay initialization. This is
a concrete place to investigate instrumentation size, but no segment
coalescing or replay change has been made: gap sizes, data-index uses,
overlap semantics, and fork-child initialization must be checked before
any such transform could be sound. During this inspection, system unused
memory fell to about 1.5 GiB. No full instrumenter or package build was
started. Resume only when sufficient memory is available; first measure
the new full-instrumenter peak safely, then rebuild FrankenPHP and the
WordPress image and run the real OPcache/Node/Chromium gates.

**2026-10-19 — Remove unnecessary globals for literal segment offsets.**
The captured revision-24 FrankenPHP classic input has exactly 100,000
active data segments, and `wasm-objdump` reports an `i32` literal offset
for every one. The generic fork module-state planner now emits that
literal directly in its bootstrap helper rather than allocating an
immutable offset global per segment. Nonliteral offsets still retain an
immutable global, preserving WebAssembly's extended-constant evaluation
and imported-global semantics. The transform does not merge segments,
fill the gaps between them, change their indices, or change fork-child
data replay. A new regression covers mixed literal/imported-global
offsets and checks the emitted bootstrap operands; all 389
`fork-instrument` crate tests passed. The previous
workspace-wide formatting check found unrelated preexisting formatting
drift; the new code was checked against `rustfmt` suggestions. This is
an instrumenter-size reduction opportunity, not evidence of a lower
full-build RSS peak. No full FrankenPHP rebuild or browser demo run was
started under the current memory headroom.

**2026-10-19 — Check latest-main integration and ABI policy.**
`origin/main` advanced 27 commits to `90283c479`, including independent
ABI 50 network changes. A local trial merge had four content conflicts:
the ABI summary, ABI guide, Node worker-transfer list, and generated
resolver bundle. The combined generated resolver bundle matched the
source, and the Node transfer list can preserve both rootfs-image
ownership and remote-peer ports. However, the ABI snapshot classifier
compared the merged snapshot against current main
and rejected the added preallocated-thread-slot declaration as a
change to the existing `process_memory_layout` section. The trial
merge was discarded before push; the branch remains on its previous
base with the two offset-replay commits pushed. A correct integration
requires ABI 51, an updated snapshot, regenerated ABI constants, and
rebuilt ABI-bound artifacts, not a relaxed compatibility check.
A direct host `tsc` run also reported existing unrelated project-wide
errors; focused Vitest was stopped during its all-fixture global setup
when system unused memory fell below 2 GiB. Neither result validates
the merged host runtime. Do not start the full FrankenPHP build at that
headroom.

**2026-10-19 — Bound active-data replay helper size.** The generic
module-state transform previously put every active-data `memory.init`
and `data.drop` operation into one bootstrap function. For the 100,000-
segment Go linker output, that made very large individual Wasm functions
in addition to the segment metadata. The transform now keeps small
modules unchanged but splits modules with more than 1,024 active data
segments into ordered helpers of at most 1,024 segments each, separately
for parent initialization and thread-only segment consumption. A
2,050-segment regression validates both three-helper paths, instruction
counts, and the emitted Wasm; all 390 fork-instrument crate tests passed
on the final change.
This bounds individual helper size without coalescing data or changing
replay order, but does not establish a lower total instrumenter RSS or a
successful FrankenPHP build. The full build still needs more free RAM.

**2026-11-05 — Integrate the latest main and retain the ABI-55 program baseline.**
Merged `origin/main` at `21cfba152` into the draft branch. Main's native,
streaming fork instrumenter replaces the old Walrus module-state rewrite;
the old literal-offset and helper-partition edits no longer apply to the
active instrumenter. Its full FrankenPHP peak RSS remains unmeasured.
Main also replaced the TypeScript SDK compiler driver with `kandelo-cc`, so
the Go linker's `--print-file-name` queries now resolve through the Rust
driver. Its focused Rust test passes.

The new preallocated-thread-slot export initially changed the program
memory-layout snapshot, and an ABI-56 trial failed the frozen ABI-55
baseline gate. Programs without this optional export retain the original
memory layout. The export is now recorded in the kernel-host adapter
surface, with host adapter version 5 and program ABI 55. The regenerated
snapshot, frozen baseline check, and resolver-bundle check pass. The host
process-memory suite passes 8/8, including absent, valid, and invalid
preallocation declarations. New Go binaries that require preallocation
need this host behavior; forward compatibility with older hosts is not
claimed.

The merge also brought main's fallible I/O memory budget. Directory OFD
rename tracking now uses budgeted paths, weak registry references, and a
prepare/publish step so allocation can fail before a successful filesystem
rename. The directory-path tests pass (3 focused assertions across the OFD
and process-table suites), and `cargo check --workspace` passes. The first
full `runtime-core --lib` run had 3,159 passes and two failures: the older
host-path mock test was incompatible with main's handle-only foreign-mount
contract and has been removed; a real-rootfs test read a stale September
source-only image and failed to mount it. Refresh the image through the
normal build path before rerunning that full suite. This is not a full
runtime or browser validation of the merge.

Next rebuild the ABI-55 FrankenPHP artifacts and WordPress image on the new
streaming instrumenter, measure the full instrumenter and live server RSS,
then rerun the Node and Chromium/Firefox/WebKit editor, restart, and
benchmark gates. Main's package registry and SDK changes need a normal
resolver build, not only source compilation.

**2026-11-05 — PHP-ZTS embed rebuild exposed a variant-selection bug and
a WebAssembly TLS limit.** The first PHP 8.5.12 resolver build published
`libphp.a` and `opcache-zts.so`, but FrankenPHP could not compile: the
required `sapi/embed/php_embed.h` was absent. The shared PHP recipe
declared ZTS/embed configure flags yet still hardcoded CLI/FPM flags, so
that successful package build did not produce a usable embed library.
The recipe now passes its selected SAPI and extension flags to configure.
This also changes the CLI/FPM artifact; its recipe revision was advanced.

The corrected 8.5.12 configure and static embed library build succeeded,
then the separate OPcache side-module link failed: `wasm-ld` rejects
`R_WASM_MEMORY_ADDR_TLS_SLEB` against external `_tsrm_ls_cache` in
`ZendAccelerator.o`. The Wasm toolchain cannot currently resolve that
cross-module TLS relocation. A local `-femulated-tls` compile probe still
emitted the same relocation. Do not add a duplicate TLS variable or a
package-specific linker bypass. An attempted PHP 8.3.36 fallback stopped
at the first PHP 8.5-specific source patch; adapting that shared patch set
to an older line would increase maintenance. PHP 8.5's upstream OPcache
configuration builds the extension into PHP, matching FrankenPHP's static
binary route. The ZTS recipe now requests PHP 8.5.12 with static OPcache,
publishes only `libphp.a`, and the FrankenPHP recipes no longer request a
separate OPcache side module or its export list. The WordPress image was
reconciled with main's PHP 8.5 FPM package and again declares both
FrankenPHP executables as dependencies. The new embed output,
FrankenPHP link, WordPress image, and live OPcache activation still need
validation.

The normal resolver build of PHP-ZTS 8.5.12 revision 8 succeeded in
4m40s. Its installed headers contain `sapi/embed/php_embed.h`, and its
117 MiB `libphp.a` defines `zif_opcache_get_status`. This verifies the
embed build output and the OPcache symbol in the archive, not the
FrankenPHP link or runtime activation. Shell syntax and diff checks pass
for the changed recipes; esbuild parsed the WordPress image builder and
classic server probe. A direct Node import check could not run because
this checkout lacks `@noble/hashes`; it is not counted as a pass.

The first FrankenPHP classic link succeeded, then resolver admission
rejected its program: the pinned Go fork still emitted ABI 50, and the
package import audit did not declare Go's `kernel.kernel_thread_exit`
process-worker import. The host already supplies that import on Node and
browser workers; its declaration now lives in the shared program import
contract and the SDK-derived resolver audit. The Go fork's linker marker
was updated to ABI 55 (`b3596ee`), published, and repinned in all four
Go-consuming recipes. The Go fork bootstrap and focused linker test pass,
the xtask package-import suite passes 8/8, and the ABI snapshot/digest
check reports unchanged program surface. The classic revision-26 resolver
build then completed after 16m22s and published an ABI-55 Wasm executable.
Much of that run rebuilt PHP-ZTS after the program-contract source changed.
This verifies the FrankenPHP static-PHP link and package admission, not
WordPress or live OPcache behavior. The FrankenPHP+Caddy revision-5
resolver build also completed successfully in 4m35s on the same ABI-55
Go fork and PHP-ZTS archive. Both executables are published; the
WordPress image and live OPcache behavior remain unverified.

**2026-11-05 — Refresh local image-build prerequisites.** The first
WordPress revision-29 resolver attempt ran 25m46s and reached the rootfs
package, which failed because the worktree's staged image-module Wasm
lacked the current loaded-capacity export. `crates/kandelo-image-module/
build-wasm.sh` rebuilt both modules; `--verify-fresh` confirms their
source keys match. The next attempt reached `modeset` but found DRI/EGL/
GLES sysroot archives absent. `scripts/build-musl.sh --ensure` restored
those documented graphics stubs, and their libraries are present in
`sysroot/lib`. The byacc fetch emitted transient HTTP 403 retries but
verified and built the archive; no source URL change was needed. The
WordPress resolver is now retrying against these refreshed local inputs.

The subsequent WordPress resolve built more shell packages but failed after
48m53s when GitHub's HarfBuzz 10.1.0 release download returned repeated
HTTP 504 responses. The OmniOS mirror serves a byte-identical archive:
the downloaded SHA-256 is `6ce3520f2d089a33cef0fc48321334b8e0b72141f6a763719aaaecd2779ecb82`,
matching the existing manifest. HarfBuzz now fetches that verified mirror
without changing its source contents or its build procedure. The new URL
and recipe revision passed a focused normal resolver build in 35 seconds.
The WordPress image has not been published yet.

The next WordPress resolver attempt passed HarfBuzz and spent CPU time
instrumenting large shell applications, then failed after 35m35s on
`libmad@0.16.4`: Debian's rolling pool URL now returns HTTP 404. The
same `libmad_0.16.4.orig.tar.xz` from an Ubuntu archive mirror has
SHA-256 `cd4c3aa4bf894c957b9b8662eca109927b43b19adafc4ff67eb5349d29d45198`,
exactly the pinned digest. The package now uses that URL without changing
the source bytes or build procedure. The focused normal resolver build
passed in 14 seconds. WordPress still needs a completed resolver build.

**2026-11-05 — Restore host imports lost in the latest-main merge.**
The first FrankenPHP classic Node probe failed before launch: NodeKernelHost
referenced an undeclared `takeRootfsImageOwnership`, and the process worker
rejected the Go executable's declared `kernel.kernel_thread_exit` import.
The merged Node host now restores its documented explicit image-ownership
option and transfers its private image buffer to the worker. The process
worker again provides the ABI-55 thread-exit import, clearing the wait word
and publishing thread exit through the existing channel. Eight focused
Node image-init tests and 24 startup/import tests passed. The classic probe
then reached PHP startup and reported that its OPcache INI lacked the
`file_cache_only=1` setting required by this Kandelo PHP package. The same
invalid shared-memory OPcache configuration exists in the WordPress image
recipe; PHP and demo configuration must be reconciled before live activation
can be claimed. The WordPress resolver remains in the long Clang guest-tool
build, and no WordPress/Chromium result is claimed yet.

The host TypeScript check also exposed a preexisting merge syntax error in
browser thread-worker teardown: an incomplete `Promise.all(...map(...))`
closure and a stale `t` reference. Both are corrected. That check also
found that the earlier thread-exit implementation's `ExecRetirement` class
was removed by main; the Go import now delegates to the current `kernel_exit`
path after clearing its wait word, preserving current process retirement.
The host TypeScript check still reports unrelated existing errors (including
browser artifact aliases, a kernel-worker symbol, and external TLS sources),
so it is not claimed as a passing host-wide typecheck.

A disposable Node diagnostic with `opcache.file_cache_only=1` and a writable
`/var/cache/opcache` then booted FrankenPHP classic on ABI 55. It returned
HTTP 200 for PHP and a static asset, loaded the built-in OPcache extension,
compiled a target script, and wrote its `.bin` file in the shared VFS cache.
No host diagnostic was emitted. As expected for this PHP mode,
`opcache_get_status(false)` reports `opcache_enabled=false` and
`opcache_is_script_cached()` returns false even though the cache file exists.
The browser probe now checks the configured file-cache-only mode and the
written cache file instead; Playwright lists all six cases, but none has run
on the new WordPress image yet.

The WordPress revision-29 resolver retry ran 2h19m, completed the guest Clang
build and instrumentation, then failed when the NetHack guest build spawned
its `makedefs` generator. The real error was a `ReferenceError` in the host
kernel worker: `resolveExecPathAgainstCwd` called `normalizeExecPath`, which
the latest-main merge had removed. The guest saw this as `EIO`; earlier
`/bin/which` warnings belonged to unrelated libraries that built normally.
Exec path resolution now uses the existing absolute guest path normalizer,
which is also used for shared mappings. Focused Node guest-spawn tests pass
(5 tests). The checked-in classic probe and WordPress image recipe now set
OPcache file-cache-only mode; the WordPress image revision is 30. The focused
NetHack build, full WordPress resolver, and browser runtime gates still need
to run on these changes.
The checked-in FrankenPHP classic Node probe now passes: PHP and a static
asset return HTTP 200, the built-in OPcache compiles a target script into the
file cache, and no host diagnostic is emitted. This is standalone classic
SAPI evidence; it does not yet establish WordPress behavior.
The focused normal NetHack resolver build then passed in 4m23s on the fixed
kernel worker, including its guest `makedefs` execution. This closes the
specific `EIO` path observed in the prior WordPress image attempt; the
whole image must still be rebuilt and booted.

The WordPress revision-30 normal resolver build then succeeded in 26m46s,
publishing `wordpress.vfs.zst` as an ABI-55 package. The compressed image is
76 MiB and has SHA-256
`04b320c8d2e2535e17e59e8d69416c30a2561c2beeebec3e2904016769c45a63`.
This establishes package publication only; Node boot, Chromium editor flow,
OPcache behavior inside WordPress, and comparative performance are still
pending.
The published image booted the real FrankenPHP classic dinit service in the
Node kernel host on localhost:3129. HTTP returned 200 for the WordPress
homepage and login form, 302 for the admin login POST, and 200 for
`/wp-admin/site-editor.php` with the actual WordPress editor document.
The server identified itself as FrankenPHP and PHP 8.5.12; dinit reported
`wp-config-init`, `smtp-capture`, `wordpress-secrets`, and
`frankenphp-classic` ready. This verifies the Node request path, not the
editor's browser JavaScript, long-running stability, or a performance gain.

**2026-11-05 — Browser WordPress and service-catalog integration.** The
ABI-55 revision-30 image passed the browser-kernel host tests in Chromium:
FrankenPHP classic served WordPress, including 40 request churn iterations
and 20 editor burst rounds; Caddy passed including restart. The focused
Firefox classic test also passed. These tests exercise real browser Wasm
execution and HTTP, but do not run the visible WordPress editor JavaScript.
The first full Chromium UI run rendered the WordPress homepage and then
timed out at its obsolete `Demo guide` selector. Latest main's dock exposes
`Shortcuts` only for running services declared inside the image; the existing
WordPress image had only profile guide data and an old dinit control socket.
Revision 31 is being wired to the shared service-activity contract: a guest
service catalog, service controller, `/sbin/kandelo-init`, and current UI test
selectors. This integration has not yet been rebuilt or validated.

At the RAM checkpoint, `memory_pressure -Q` reported 79% free on the 36 GiB
host. The largest observed current process was WebKit content at 1.3 GiB RSS.
The earlier 10.6 GiB FrankenPHP instrumenter peak was historical; it does
not describe current memory pressure. Build time and the UI test timeout are
separate from host RAM scarcity.

The revision-31 normal resolver build passed in 2m09s. The visible app test
could not reach the image because Vite requires one complete provenance tier
for all its assets and this checkout's source-only projection is absent.
`./run.sh local-build --plan` initially rejected the supported set because
standalone `caddy` (an older, separate package from `frankenphp-caddy`) had
no disposition. It is now explicitly excluded, preserving its dormant status.
The plan also rejected a `php-zts` product entry that named a nonexistent
`opcache-zts` output; ZTS is a build library in FrankenPHP's dependency graph,
not an embedded WordPress image output. The product manifest now omits that
invalid entry and names the embedded service activity control program. The
source-only plan validates with 178 nodes to run and estimates about 128
minutes on the current empty source-only cache. The browser app gate remains
pending until that projection is materialized.

The revision-31 image has now also passed a Node runtime probe through the
new image-owned `/sbin/kandelo-init frankenphp-classic` path: the guest
`kandelo-service inspect` reported `frankenphp-classic` running and enabled,
with nginx and Caddy not loaded, and the WordPress homepage returned HTTP
200. A first ad hoc probe bound host port 8080, which was already occupied by
an SSH listener; it timed out at HTTP readiness. The same probe passed on
localhost:3129. A repeatable opt-in Node test now selects an available port,
loads the built image, boots via the service controller, checks its guest
status, and fetches the homepage. It passed 1/1 under the declared dev shell.
An earlier test attempt exited before HTTP readiness on an OS-assigned high
port but did not capture guest logs; the test now includes those logs on
failure and the immediate rerun passed. That transient failure remains
unexplained, and teardown still reports a forced drain for live guest
processes. Neither observation is claimed resolved. The full source-only
projection remains in progress, so the visible Chromium app gate is pending.

The published revision-31 image passed the focused Chromium browser-kernel
host gates: FrankenPHP classic served WordPress while the test ran 40 request
churn iterations and 20 editor burst rounds (27.1s), and the Caddy profile
passed its separate browser-host case including restart (15.8s). Both used
the actual revision-31 resolver image. These are browser Wasm/HTTP results;
they do not yet verify the visible site editor JavaScript in the app. The
source-only projection required for that app test remains in progress.

**2026-11-05 — Align Go/PHP embed gates with static ZTS OPcache.** The
revision-8 `php-zts` package publishes `libphp.a` with built-in OPcache;
the old Go embed fixture still copied the removed `opcache-zts.so`, requested
its dynamic exports, and used `dlopen`. The fixture now links the static
library and, in its opt-in mode, loads a guest `PHPRC` INI that enables
file-cache-only OPcache and asks PHP whether the Zend extension and its
configuration API registered. The first check failed because its
`zend_eval_string` expression contained a literal `return`; Zend returned
`FAILURE` before evaluating the extension query. Removing that keyword
corrected the probe without changing the PHP package or Go compiler. The
normal fixture build passed in 2m12s; both Node modes then exited 0 with
empty stderr and host diagnostics. The focused static-registration browser
probe passed in Chromium, Firefox, and WebKit (3/3). This proves embedded
registration, not accelerated requests; the separate FrankenPHP SAPI and
WordPress browser-host tests cover the file-cache request path. The visible
WordPress editor and full source-only app projection remain pending.

**2026-11-05 — Full source-only projection and visible classic app gate.**
The revision-31 source-only local build completed in 2h41m: 178/178 nodes,
11/11 products, 23 cache hits, 155 builds, and the consumer check passed.
It published the complete `local-binaries/source-only-v1` projection,
including the current WordPress image. The opt-in visible Chromium app test
then used that projection to load the FrankenPHP classic profile, reach the
preinstalled homepage, log in through the Shortcuts UI, open Appearance →
Editor, and keep editor HTML requests at HTTP 200 through a 20-second soak.
The case passed in 3.8m. Its editor assertion checks a visible iframe, so
this result establishes navigation and server health, not that editing and
saving through the site editor JavaScript work. Authenticated post-edit
persistence, the equivalent Caddy app flow, longer stability, and comparative
performance remain separate gates.

The separate visible Chromium classic-profile test for authenticated post
edits passed in 2.1m. It logged in through the same Shortcuts UI, created a
published post through WordPress's authenticated REST API, read the initial
content from the site, updated it, read back the changed content, and deleted
the post. This checks PHP, database writes, auth cookies, and persistence
within one live machine; it does not exercise the site editor's Save button.

The matching Caddy-profile visible Chromium cases passed under the declared
dev shell: preinstalled site, admin login, site-editor navigation, and a
20-second health soak (3.6m); authenticated publish/read/update/read/delete
through WordPress REST (1.3m). The combined run passed 2/2 in 5.0m. Both
profiles still need a stronger editor-JavaScript assertion. The classic
case is being extended to open the default template and verify rendered
editor blocks inside `editor-canvas`.

The strengthened classic Chromium app case passed under the declared dev
shell in 2.7m. It navigated through Appearance → Editor, opened the default
Twenty Twenty-Five index template in edit mode, found a visible `[data-block]`
inside the named `editor-canvas` iframe, and completed the same server-health
and service-log checks. This is direct evidence that the site editor's
JavaScript rendered editable blocks in the browser; Save and reload remain
unverified through that UI.

The same strengthened rendered-block case passed for the Caddy profile in
Chromium under the declared dev shell (2.8m). Both FrankenPHP profiles now
reach the visible editor canvas and render blocks from the real WordPress
template on the projected source-only image. This does not yet establish
editing and saving a template through the browser UI or a long-term server
memory plateau.

**2026-11-05 — Verify the site editor Save workflow.** The first classic
Chromium save probe changed the default template's heading but waited the
full 12-minute test timeout for a Save button. Its failure screenshot and
accessibility snapshot showed the enabled Save button behind WordPress's
first-run welcome dialog, while the Kandelo Shortcuts dialog also remained
open. This was a test interaction error, not evidence of a FrankenPHP save
failure. After dismissing both dialogs and bounding the click to 30 seconds,
Save succeeded. The final classic test passed in 2.3m: it edited the heading,
clicked Save, waited for the Save button to disappear, navigated to a fresh
editor URL, and found the changed heading again. The matching Caddy-profile
persistence case passed under the declared dev shell in 2.3m with the same
edit, Save, and reload assertions. These are browser UI and same-machine
persistence checks; they do not establish cross-session browser storage
durability or production uptime.

The existing Chromium OPFS recovery test now includes the
`wordpress-frankenphp` profile. Its saved-computer (`library`) case passed
in 1.7m, and its experimental resizable-storage case passed in 1.7m. In
each case it published a post, uploaded an image, embedded the image in the
post, disabled the original VFS image source, crashed the Chromium process,
relaunched the persistent browser context, and verified the post, image bytes,
admin login, and post-editor readiness after recovery. The source image was
requested once and not requested during recovery. This verifies browser
process recovery for posts and media on the classic profile. It does not
separately verify that the edited site template survives a browser crash, or
establish durability if browser storage is cleared.

The current projected revision-31 classic profile also passed its visible
Firefox app gates under the declared dev shell: homepage, Shortcuts login,
rendered site-editor blocks and a 20-second HTTP health check (2.3m);
template heading edit, Save and fresh editor navigation with the saved
heading (1.9m); and authenticated post publish/read/update/read/delete
(1.7m). These are Firefox runs of the same image and test assertions used
in Chromium. The Caddy profile and WebKit app flows are still unverified
on this current projection.

**2026-11-05 — WebKit WordPress isolation on the current image.** The first
visible WebKit classic run failed before machine setup with an OPFS
`UnknownError`: Playwright's ephemeral WebKit context has no persistent
backing store, as existing OPFS tests document. The WordPress app spec now
uses the shared persistent-page fixture; no runtime/package fallback was
added. With that fixture the actual site-editor template Save/reload case
passed in 1.5m and authenticated post edits passed in 1.4m. These show
working WordPress PHP writes through the full WebKit app path, but the
separate editor-health case remains intermittent. One run rendered blocks
then aborted a follow-up PHP fetch after 30 seconds, with several editor
AJAX/REST requests reporting access-control failures; another failed to
show the editor iframe within 60 seconds. The guest boot log in those runs
reached `frankenphp-classic listening` and `HTTP preview ready`, while
the VFS inspector remained at `Loading...` during failure capture. A
preview-frame health request and bounded browser-state attachments are
now used for more faithful diagnosis; they do not turn those failures green.

The direct WebKit `BrowserKernel.fetchInKernel` WordPress test passed with
no extra traffic (12.9s), one editor burst (13.2s), 20 editor bursts
(31.6s), and 40 additional PHP requests (27.9s). A combined run with
20 bursts and 40 requests lost its page evaluation context after about
one minute; an immediate repeat passed in 54.1s. The combined result is
intermittent, not a stable pass. System-wide `memory_pressure -Q` reported
76–77% free around these runs, which does not rule out a per-WebKit-process
limit. No Go compiler, PHP, package, or runtime workaround is inferred
from this evidence. The remaining WebKit work is to capture the failing
request/process state and isolate the guest/bridge or engine boundary.
The same persistent-profile app fixture passed the classic editor-health
case in Chromium (1.8m) and Firefox (2.5m), so this fixture change has
been rechecked in the two previously passing engines.

**2026-11-05 — WebKit editor control and concurrency diagnosis.** A repeated
classic visible-app run failed after rendering the template: its 30-second
uncached editor PHP health request aborted, ten WordPress REST/AJAX requests
had remained outstanding for about 45 seconds, and the VFS inspector stayed
at `Loading…`. The same current image's nginx/PHP-FPM profile passed the
identical WebKit editor and health flow in 1.9m. The FrankenPHP+Caddy
profile also passed it in 2.2m. During that Caddy run one WebKit content
process reached about 8.97 GiB RSS at 1m54s; this is a sampled footprint,
not a peak or a leak measurement. A direct WebKit BrowserKernel test of ten
parallel editor PHP/REST requests through classic mode passed in 14.4s for
the complete startup and request test, without the visible app's service
worker or navigation path.

Waiting for the site-editor hub document's `readyState=complete` before
opening its template let one focused classic WebKit run pass the editor and
20-second health case in 1.9m. A subsequent three-case sequential WebKit
suite on that version contradicted a fix: the editor-health case aborted
another PHP fetch, authenticated post edits passed, and template Save/reload
never rendered its canvas (2 failed, 1 passed in 8m04s). The latter failure
screenshot shows a Kandelo app inside the WordPress preview, including a
nested machine whose kernel boot reported `Out of memory`; this suggests an
app-namespace navigation reached the SPA fallback without the service
worker, but the exact request/registration sequence is not yet captured.
The editor-health failure still showed pending PHP requests and a loading
VFS inspector. These observations leave both the guest/bridge request stall
and the preview routing failure open. The next investigation must capture
service-worker control and response provenance during navigation, then
address the actual platform boundary. No browser-engine defect is claimed.

**2026-11-05 — Refuse unhandled computer routes at the Vite boundary.** A
raw request that bypassed the browser service worker for
`/computer/missing/wp-admin/site-editor.php` returned HTTP 200 with Vite's
app-shell fallback before the change. Vite's development and preview
middleware now returns an explicit, non-cacheable HTTP 503 for the
`/computer` namespace. A focused raw-route browser test covers the bare
path and a named editor path; it passed in Chromium, Firefox and WebKit
after failing with HTTP 200 before the change. This prevents recursive
Kandelo boots when the local static server receives a missed bridge route.
It does not restore a lost service worker or fix the classic PHP request
stall, and deployed static hosts need the same route policy. The broader
`ci-check-browser-assets.sh` check reached its resolver stage but failed
because this SourceOnly checkout lacks six unrelated optional artifacts
(Erlang, `fbtest`, and MariaDB); its size and memory64 prechecks passed.
The real classic Chromium app editor/20-second health case still passed
with the Vite guard in place (1.9m). An attempted browser TypeScript
project check returned 181 errors in host and shared dependencies, with
no diagnostics naming the changed Vite config or test file; this is not
a passing typecheck.

**2026-11-05 — Capture preview redirect provenance and use visible navigation.**
The classic WebKit template test now records navigation responses, whether
the service worker supplied each response, the preview's controller, and
pending requests when rendering fails. A failing run captured a WordPress
302 served by the service worker, followed by a same-origin redirect target
that returned Vite's 503 guard without the service worker. The resulting
document still reported the expected service-worker controller. This
establishes where that navigation escaped the bridge; it does not establish
whether the cause is Kandelo, browser automation, or the browser engine.
The guard prevented the recursive app boot seen in earlier failures.

The editor tests now navigate through the visible preview address bar and
Enter key, exercising the app's ordinary navigation path. Classic WebKit
template edit, Save, and reload passed in a focused run (1.6m) and again
in a sequential editor-health/Save run (48.3s for Save). The same sequential
run still failed its separate editor-health case: the editor iframe did not
appear within 60 seconds and the VFS inspector remained at `Loading…`.
Consequently neither the request stall nor redirect escape is considered
fixed by the test interaction change. No compiler, package, or runtime
workaround was added.

A standalone service-worker fixture containing no Kandelo code passed 20
same-origin 302 iframe redirects in bundled WebKit 26.6: ten through
Playwright `Frame.goto` and ten through `location.assign`. Every final
response came from the service worker and no target reached the static
server. The fixture used the app's cross-origin isolation headers. This
simple pattern does not reproduce the observed failure; the live bridge,
navigation timing, or workload still needs reduction. Evidence and fixture
are in `.context/sw-redirect-repro.log` and `.context/sw-redirect-repro.mjs`.

A fresh fetch confirmed that `origin/main` at `21cfba152` is already an
ancestor of this branch: 187 branch commits ahead and zero main commits
missing at this checkpoint. No additional rebase was necessary.

The visible-address-bar test changes passed all four focused classic
regression cases under the declared dev shell: Chromium editor rendering
and 20-second HTTP health (1.7m), Chromium template Save/reload (40.4s),
Firefox editor rendering and health (1.6m), and Firefox template Save/reload
(1.2m). The combined run passed 4/4 in 5.3m. These changes affect browser
test interactions and diagnostics only; kernel, Node host, packages, ABI,
and the revision-31 image were not changed or rebuilt at this checkpoint.

**2026-11-05 — Reduce redirects and locate the stalled worker.** Added a
bridge-only iframe redirect test using the actual service worker and a
message-port HTTP fixture, without PHP or a guest kernel. Both Playwright
navigation and `location.assign` follow the WordPress-shaped 302 URL and
render the guest-only destination body in Chromium, Firefox, and WebKit
(6/6 in 5.9s). The initial test's service-worker protocol flag returned
false in Firefox despite successful bridge content; the final assertion
uses the actual guest-only response body in every engine instead.

A focused full-app WebKit editor/health retry passed in 1.8m. The subsequent
three-run diagnostic series failed all three cases in 5m49s: two waited
over 65 seconds for the editor document, and one rendered the canvas before
its health request stalled with ten other requests outstanding. A bounded
read-only evaluation in the dedicated kernel worker timed out in every
failure. This narrows the stall beyond the service worker: the kernel
worker's event loop was not answering the diagnostic either. It does not
identify the blocking operation or establish an engine defect. Structured
attachments are retained in `.context/webkit-editor-reduction.json`.

The 31 core Go fixtures were rebuilt and stamped for current ABI 55 from
the pinned `b3596ee` fork. The full image-backed Node `os` run completed
with 213 top-level passes, two failures, and 21 skips, empty stderr, and no
host diagnostics. `TestExecutable` and `TestStartProcess/relative` fail
because the kernel's spawn precheck resolves the executable against the
parent CWD before the requested child `chdir` action. The kernel must
validate launch paths in the context where they will execute; fixing the
Go test or canonicalizing its arguments in the Go port would hide the
platform error. The old ABI-50 fixture instructions and stale standalone
Caddy limitation in `tests/go/README.md` were corrected. Evidence is in
`.context/go-os-current-vfs.log`. The spawn fix and its Node/browser
regressions are the next checkpoint.

**2026-11-05 — Validate spawn targets in the child's lookup context.** The
kernel's early spawn probe is now limited to requests without file actions
or `RESETIDS`. Such requests preserve the parent's lookup context. Requests
that can change the child's CWD, descriptor targets, or credentials instead
use the existing retained-target admission after child construction and its
single file-action pass. This removes a false parent-CWD rejection without
adding a Go workaround or duplicating the kernel's path resolver. Invalid
targets in these requests can consequently fail after their file actions;
the parent-context probe is not a guarantee that such actions have no
effects when a launch fails. The architecture and focused agent guidance
now describe the actual boundary.

| Current ABI-55 upstream Node `os` run | Before | After |
| --- | ---: | ---: |
| Top-level passes | 213 | 215 |
| Top-level failures | 2 | 0 |
| Top-level skips | 21 | 21 |

Both full runs used the same rebuilt Go fixtures and image-backed `/tmp`;
the fixed run had empty stderr and no host diagnostics. The focused
`TestExecutable` and absolute/relative `TestStartProcess` Node run also
passed. The corresponding existing browser probes passed 9/9 across
Chromium, Firefox, and WebKit in 25.3s. `check-abi-version.sh` passed and
reported an unchanged program digest: this restores the existing
post-action launch semantics without changing the wire format, pointer
layout, or valid program contract. No program rebuild or ABI bump is
needed for this admission correction.

The kernel source build passed in 2m28s. Its source-only projection dropped
dependent VFS products whose build identity was no longer current, so a
normal full local build is refreshing those products. An attempted seven
case Sortix spawn run failed in the host harness before guest execution
because the rootfs product was absent from that intermediate projection;
it is not conformance evidence and must be rerun after provisioning.

The pinned `b3596ee` fork also passed full standard-library builds under the
declared dev shell for `kandelo/wasm` with `CGO_ENABLED=0` and `1`, and for
the upstream `js/wasm` and `wasip1/wasm` targets with cgo disabled. All used
`go build -p 2 std`; Kandelo cgo selected `CC=wasm32posix-cc`. Logs are in
`.context/go-stdlib-matrix.log` and its four target logs. These are compile
gates, not runtime or standard-library conformance claims.

The full source projection is now refreshed: all 178 nodes and 11 products
passed, followed by the published-consumer check. The original debug
bootstrap completed image generation but was deliberately terminated after
30m05s while finalizing; a native stack sample showed source-input SHA-256
hashing, with a sampled finalizer footprint of 17.4 MiB. A freshly checked
release `xtask` reran the same bootstrap under the declared tool PATH,
reused every completed cache output, published the projection, and passed
its consumer check in 3m02s (151.4s finalization, 5.1s consumer check).
No source-build checks or package inputs were bypassed or changed. These
are different cache states, not a paired performance benchmark, and say
nothing about Go/PHP request performance. The successful job is
`source-products-release-1105-152709-0665`; the ignored reproducible command
is `.context/bootstrap-release.sh`.

After publication, the normal Sortix runner passed all seven selected spawn
cases with zero skips, expected failures, build failures, or timeouts:
`posix_spawn`, `posix_spawnp`, and the `addchdir`, `addfchdir`, `addopen`,
`addclose`, and `adddup2` file actions. Evidence is in
`.context/spawn-context-sortix-final.log`. This completes the C conformance
gate for the spawn-context correction alongside the 215-case Node `os`
sweep and nine browser launch probes. The editor stall remains separate.

**2026-11-05 — Correct the site-editor Save evidence.** The stronger crash
drill exposed a test error in the earlier Save cases: the first editable
`h1` inside the Query Loop was a post title, not content owned by the
`wp_template` entity. A live browser inspection showed the changed text
among the posts while the Blog heading remained unchanged. WordPress's
entity store reported `saving=false`, `dirty=false`, and no changed text
in the template record. Consequently the earlier Save/reload passes show
post-title editing through the site editor, not template modification;
the earlier entries must not be cited as proof of a saved template.

The first recovery attempt also targeted `index`, while the homepage uses
the separate `home` template. Both files were read from the actual built
image. The corrected drill targets `home` and requires a public homepage
readback before crashing, then checks both the page and editor afterward.
The shared Save helper is being changed to insert a real static Heading
block through the UI and wait for the template entity's committed content,
not merely for the Save button to disappear. These stronger cases are not
yet passing evidence. No PHP, Go compiler, or runtime workaround was added
for these test interaction failures.

The corrected classic Chromium Save/reload case now passes in 1m24s
(`frankenphp-template-entity-save-1105-155923-ebba`). It inserts a static
Heading through the block inserter, changes it through the editable canvas,
clicks Save, and waits for the public WordPress entity store to show the
changed `wp_template` record with no active save or pending edits. A fresh
editor navigation then finds that same Heading block. The store is only
read for completion evidence; all edits use the visible UI. The homepage
template's stronger browser-crash recovery checks are running separately.

**2026-11-05 — Recover real template edits after a browser crash.** The
initial two recovery cases rejected a second insertion-context error:
WordPress retained the post-content insertion point from publishing a post,
so even a newly inserted static Heading belonged to that post. Read-only
inspection showed the Heading under `core/post-content` and unchanged
`home` template content. The helper now selects the template's Blog heading
before inserting and requires that the intended template becomes dirty
before Save. This corrects the test, without changing WordPress or runtime
behavior. The general entity-ownership lesson is in the validation guide.

Both strengthened Chromium cases now pass on the current source projection
(`frankenphp-template-owner-recovery-1105-160939-b6d8`, 3m17s total). They
publish a post through the editor, upload and embed a PNG, insert and save a
Heading in `twentytwentyfive//home`, and verify the public homepage. Then
they disable the original image source, crash the Chromium browser process,
and relaunch the same persistent profile. The homepage and site editor both
contain the changed template; the published post and exact uploaded bytes
also survive. The source is requested exactly once for installation and
never during recovery, and neither test creates an image checkpoint. Both
experimental resizable OPFS and ordinary saved-computer storage passed
(1.9m and 1.3m respectively). This is a bounded crash-recovery gate, not
protection against clearing browser storage or proof of long-term uptime.
Screenshots are `.context/frankenphp-template-after-restart-experimental-chromium.png`
and `.context/frankenphp-template-after-restart-library-chromium.png`.

The browser reference now describes all three actual WordPress profiles
and built-in ZTS file-cache-only OPcache instead of obsolete port blockers.
WebKit editor-health stalls, broader Go/POSIX gaps, physical-memory plateau,
Node readiness/teardown, and current performance comparisons remain open.

**2026-11-05 — Retire blocked Go workers through the normal channel.** Three
fresh Node service-controller boots passed on revision 31, with zero skips
(`node-wordpress-service-repeat-1105-161634-c6db`, 1m44s total). The older
readiness failure did not recur, but every run still warned that shutdown
had to force-terminate a live guest. The Go channel completion path ignored
the host's terminal `SIGKILL` marker, so a woken Go read could return to the
channel instead of unwinding its disposable worker. This is missing target
runtime integration, not evidence of an engine defect or a PHP workaround.

The direct Go fork now recognizes that marker after channel completion and
enters the existing non-returning `kernel_exit` import, matching libc. It
does not issue another syscall or reinterpret ordinary catchable signals.
Fork `c925e9c9ca8c63c549053fd07d3fe0799473d4e0` is pushed. The behavioral
change is ten added lines in the Kandelo runtime, plus gofmt alignment;
there is no compiler, linker, PHP, or dependency-package patch.

The new `tests/go/retirement` fixture blocks in a pipe read and observes the
host's actual shutdown drain. Before the change, the Node plain-Go case and
both Chromium variants failed because zero of one guests drained before
forced termination. After rebuilding from the fixed fork, plain-Go and cgo
variants pass in Node and all three browsers (2 Node and 6 browser checks),
with one of one guests drained, empty stderr, and no host diagnostics. The
four-target standard-library compilation matrix also passes: Kandelo with
cgo disabled/enabled and upstream js/wasm and wasip1/wasm. All 31 core Go
fixtures were refreshed; their broader browser run is in progress. This
uses the existing ABI-55 marker and import contract; no ABI change is made.

Go hello, standalone Caddy, and both FrankenPHP recipes are being repinned
to the fixed fork; the WordPress image revision is 32. Their package/image
rebuilds and the actual WordPress service's shutdown remain pending, so the
small-fixture results do not yet establish that the packaged service drains.

The separate WebKit worker-baseline editor run failed in 2m13s. Its worker
answered `performance.now()` after the homepage (`16006.04` ms) but stopped
answering during editor activity, while the health fetch and VFS inspector
also stalled. This confirms that the diagnostic can work in that same live
machine; it does not locate the blocking operation. Native sampling began
during editor navigation and showed active worker dispatch and OPFS reads,
not an identified long-blocking operation. Evidence is in
`.context/webkit-editor-worker-baseline.json` and
`.context/webkit-worker-baseline-content.sample.txt`. No WebKit fix or
upstream-engine root cause is claimed.

The broader Go browser run completed with 144 passes and three failures
(`go-core-retirement-regression-1105-162250-f310`, 6m37s). All three were
the same stale fixture expectation, one per engine: the byte-launch exec
probe expected `/proc/self/exe` to be absent. Current main instead retains
a host-supplied executable object whose diagnostic name carries
` (deleted)`, as documented in `docs/posix-status.md` and covered by the
kernel's host-executable tests. The probe now checks agreement between
`os.Executable` and the actual procfs link and opens that object to verify
its Wasm magic. No kernel or Go-library behavior was changed for this test.
The corrected byte-launch and existing forged-argv VFS-launch probes pass
6/6 across the three browsers (29s); both Node paths pass with clean stderr
and diagnostics and zero captured forks for the byte-launch path. Those
are targeted reruns, not a replacement full-inventory report.

The rebuilt fork's full image-backed upstream Node `os` sweep also passed
215 top-level cases with zero failures, 21 skips, empty guest stderr and no
host diagnostics. The host console still reports an attempt to publish
guest port 49152 where this Mac's `rapportd` already listens; no native
service was stopped. The guest suite passes despite that host listener
warning. `check-abi-version.sh` passes with the program digest unchanged.

The checked-in WordPress Node service test now requires the real service
tree to finish its cooperative drain before forced termination and checks
host diagnostics. It must run against the new image; the prior three boots
only establish readiness on revision 31. The source build plan reuses 160
of 178 nodes and estimates roughly 35 minutes for the refreshed Go consumers
and revision-32 WordPress products. Builds will run serially to limit memory
pressure. Standalone Caddy is excluded from the ordinary local-supported
set and requires its separate package build.

**2026-11-05 — Publish the retirement-aware server image.** The serial
source build passed all 178 nodes and 11 products, then the published
consumer check, in 14m14s (`go-retirement-source-products-1105-163218-ba42`).
It rebuilt both FrankenPHP packages and published revision-32 WordPress
with SHA-256 `9dbe6dc206daf91f6831c21e4b3908cc7ad859d7a67f64a98308b8515e1fe88b`.
Finalization took 151.1s and its consumer check 5.1s. The strengthened Node
service-controller test now covers classic and Caddy separately, and the
browser-host request/restart gate also records cooperative drain progress.
Those runtime gates are running or pending; source publication alone is
not their validation.

The prior revision-31 image is preserved locally as
`.context/wordpress-retirement-before.vfs.zst`, SHA-256
`90c30ae558b3c12c97b622639c9319577ec3ee0e30286c604cf186fd4b03edbe`.
It is a recorded baseline artifact, not a substitute for current resolver
output. No performance measurement of the retirement change has been made.
The profiling reference now describes current ZTS OPcache support and the
distinction between FPM's prewarmed cache, warm requests, and cold startup;
it no longer incorrectly says FrankenPHP has no OPcache.

The new Node service gate passes both real stacks on revision 32
(`wordpress-retirement-node-services-1105-164641-fdf5`, 56s total).
Classic took 12.8s and Caddy 18.7s within the test runner. Each boot used
the image-owned `/sbin/kandelo-init`, verified the selected service running
and alternatives disabled, fetched the WordPress homepage, and completed
all worker retirement during the cooperative drain. No forced-drain warning
or host diagnostic was emitted. This validates this shutdown operation;
it does not establish application-level completion of in-flight requests
on SIGTERM or explain the earlier intermittent readiness failure.

The heavier browser-host run passed five of six cases in 5m12s
(`wordpress-retirement-browser-hosts-1105-164813-5118`). Both stacks pass
in Chromium and Firefox, and Caddy passes in WebKit. The passing cases
verify real OPcache file-cache artifacts, login/editor HTTP, 40 churn
iterations, 20 editor-burst rounds, ten parallel editor requests, cooperative
worker retirement, and Caddy's supervised SIGKILL recovery. WebKit classic
lost its page execution context after about one minute; this run did not
identify a navigation or native crash responsible. It is not a pass and
must not be concealed by the passing Caddy case. Visible Chromium app
cases for both stacks and the separate standalone Caddy package rebuild
are now running.

**2026-11-05 — Validate current Chromium editing and standalone Caddy.**
All six visible Chromium cases pass on revision 32
(`wordpress-retirement-ui-chromium-1105-165337-1c73`, 5m57s): both stacks
serve the installed site, log in through Shortcuts, render the editor's
blocks, answer editor health requests, persist authenticated post writes,
and insert/save/reload an actual template-owned Heading block. The older
revision-31 crash-durability evidence is not relabeled as a current-image
run; that rerun and Caddy's visible Firefox flow remain next.

The separate normal resolver build of standalone Caddy revision 4 passed
in 2m35s (`caddy-retirement-package-1105-165345-1ece`). Node serves its
expected VFS file with HTTP 200 and no host diagnostic. The first browser
attempts could not fetch the external resolver cache path: Vite correctly
returned `403 Forbidden resolver-cache path`. Serving the fixture through
`route.fulfill` then closed Chromium's debugging connection, consistently
even in isolation. A native browser log identified a 104,857,600-byte
DevTools pipe capacity error. The program file is 104,394,638 bytes, which
expands beyond that cap when base64-encoded for `route.fulfill`; an initial
image-array diagnosis was incomplete. Changing the image transfer alone
did not fix it. These were fixture transport failures before guest execution,
not a Caddy or compiler defect.

The new shared `support/streamed-artifacts.ts` fixture serves only declared
files/bytes on a test-owned loopback HTTP server and closes it afterward.
The Caddy probe retains its ABI digest check, fetches raw image/program
bytes, and does not change Vite's resolver-cache boundary. It now passes
3/3 across Chromium, Firefox, and WebKit in 14s
(`caddy-streamed-browser-fixture-1105-170326-c5d4`). This also closes the
previously unverified standalone-Caddy WebKit artifact gate. No browser
workaround, compiler/package patch, or runtime-defect registry entry is
needed for this test-transport correction.

**2026-11-05 — Verify Firefox editing and revision-32 crash durability.**
Caddy's three visible Firefox app cases pass in 5m05s
(`wordpress-caddy-current-firefox-1105-170607-2452`): site/admin/editor
rendering and health, authenticated post writes, and a genuine template
Heading inserted, saved and found after fresh editor navigation. Both
Chromium crash-durability cases also pass on revision 32 in 3m37s
(`wordpress-current-template-durability-1105-170607-663a`). Posts, exact PNG
bytes and the saved homepage template survive a browser-process crash in
experimental and saved-computer storage with the original image source
disabled and no image checkpoint. Screenshots at the existing
`.context/frankenphp-template-after-restart-*-chromium.png` paths now show
this current-image run.

Current-image WebKit editor diagnosis is next, with a native stack capture
armed from the actual editor-health request rather than sampling an earlier
healthy navigation. General Go signal notification is also still missing:
the wasm runtime's `sigenable`, `sigdisable` and `sigignore` remain no-ops.
The retirement fix does not implement these hooks or prove Caddy completes
in-flight requests after SIGTERM. Any signal port must preserve the real
kernel handler/mask state and C/Go callback boundaries, not patch Caddy.

The first current-image classic WebKit editor-health run passed in 1m52s
(`webkit-current-editor-stall-1105-171428-8a5e`). Its native sampler was
armed from the owned Playwright process to capture a health request still
pending after 25s; no request met that condition, so no stalled stack was
captured. The run does not resolve the earlier intermittent failure. A full
six-case visible WebKit flow is running without that diagnostic attachment.


**2026-11-05 — Finish the current-image WebKit UI run.**
The full revision-32 run finishes 4/6 in 7m47s
(`wordpress-current-webkit-ui-1105-171701-18ab`). All three Caddy cases pass:
editor rendering/health, post writes, and actual template save/reload.
Classic post writes pass, but its editor-health case fails and its template
navigation reaches the static server's 503 guard despite an existing service
worker controller. This is intermittent; the isolated health run passed.
Neither that routing failure nor the separate browser-host page-context
loss has an established browser-engine cause. The primary Caddy profile's
visible workflows now pass in Chromium, Firefox, and WebKit.

**2026-11-05 — Port cooperative Go signals through shared libc.**
Go fork `70f6cbfdb602c4fddefc9145334772a3757b9248` is pushed. It replaces
the target's signal-enable/disable/ignore stubs with real dispositions and
Go signal-queue delivery. Upstream tests exposed a preexisting omitted
`SIGSTKFLT` slot: Go's `SIGWINCH` was incorrectly signal 27. Target constants
now match the SDK. Nonfatal asynchronous Go defaults are retained; fatal
Stop/delivery races re-raise the actual kernel signal instead of losing it.
Native signal-context unwinding, asynchronous preemption, and management
of inherited blocked masks remain unsupported.

The SDK adds typed syscall completion and an already-pending C-signal
dispatcher. Go's cgo public syscalls enter libc through the normal cgo
transition, preserving libc's handler info, alternate stack, masks,
restart classification, and deadline accounting. The result keeps its
64-bit value separate from errno. Existing C syscall entry points retain
their negative-errno/long convention. Internal Go calls with no scheduler P
collect C-delivered Go notifications before queuing them on the system
stack. This is target-runtime/C integration, not a compiler or Caddy patch.

- The final focused browser run passes 33/33 in 1m47s
  (`go-signals-libc-bridge-browsers-1105-175333-6f4a`). Both Go modes cover
  notifications, Ignore, default SIGTERM after Reset/Stop, an 8 GiB logical
  seek, and graceful HTTP shutdown. Cgo additionally covers a C pthread
  entering Go, SA_SIGINFO/SA_ONSTACK, mask restoration, and SA_RESTART.
  The restart probe signals an observed blocked read and requires two read
  dispatches. Each mode/engine also runs ten selected upstream signal tests.
- The broader Node upstream run passes 14 top-level cases per mode,
  including concurrent Stop, the ten-child atomic Stop race, SIGCONT, and
  timing (`.context/go-signals-upstream-broader.log`). Guest stderr and
  diagnostic callbacks are empty. Focused Node restart and HTTP probes pass.
- Full standard-library compilation passes for Kandelo cgo off/on and
  upstream js/wasm and wasip1/wasm. The ABI snapshot check passes: program
  digest unchanged, ABI 55 retained. These are compile/ABI gates, not full
  Go conformance or proof of Caddy/PHP request draining.
- Node Sortix signal/I/O has 88 passes, two existing skips, and one missing
  built fixture. The one-case default-usr1-exec rerun passes. The browser
  runner first failed all 34 executable cases before guest startup while
  loading the stale October rootfs. After rebuilding the canonical rootfs
  normally, its signal suite passes 34 cases with two existing skips and no
  failures/errors (`go-signals-libc-sortix-browser-current-r-1105-175744-75b9`).
  An earlier browser build was canceled to avoid overlapping its shared
  fixture outputs with the Node build; do not run those two builders together.

Pin go-hello revision 21, classic revision 28, FrankenPHP+Caddy revision 7,
and standalone Caddy revision 5 to the pushed fork; WordPress revision 33
will refresh the image. The verified revision-32 image is preserved for
comparison at `.context/wordpress-before-signals-rev32.vfs.zst`, SHA-256
`9dbe6dc206daf91f6831c21e4b3908cc7ad859d7a67f64a98308b8515e1fe88b`.
Next: rebuild source products, validate actual Caddy/PHP SIGTERM draining,
then perform the required syscall/application benchmark comparisons on Node
and browser. No performance result is claimed for this syscall-path change.


**2026-11-05 — Restore fatal Go diagnostics and expand exec regression coverage.**
The new signal port makes upstream `os/exec` SIGCHLD, wait, handled/ignored
SIGINT, and WaitDelay paths work. The first pure-Go run failed only
`TestWaitInterrupt/SIGQUIT`: kernel default termination did not produce Go's
required goroutine dump. Fork commit
`f4353693610e62ad9d7c4f3a4151710fdcb75034` reuses Go's generic signal policy
table for Kandelo's matching signal numbers and uses the existing Go fatal
traceback at the cooperative delivery checkpoint. It reports real goroutine
stacks and exits 2; it does not fabricate a native signal context. Both Go
modes now pass all three selected upstream top-level tests, including all
seven WaitInterrupt subcases (`.context/go-signals-os-exec-traceback.log`).
A further 12-case cgo `os` regression run passes stat, file I/O, links,
ownership, truncation, seek, and Root.DirFS with clean guest diagnostics.
The four-target standard-library compilation matrix also passes again.

The prior 33-case browser signal suite passes again in 1m41s
(`go-signals-traceback-browsers-1105-181758-2174`). The expanded 39-case run also passes in 1m44s
(`go-signals-fatal-browser-check-1105-182043-56d8`), explicitly checking
default SIGQUIT dumps and exit 2 in both modes in all three browsers. Actual
Caddy/PHP drain tests are prepared for Node and browsers but not yet run:
a PHP request waits in its worker until the service controller has issued
SIGTERM, then must return its full body before Caddy exits normally.

The source build with the earlier signal pin was intentionally canceled
after 19m15s while compiling Binaryen, before rebuilding the large Caddy
consumer. Its completed dependency nodes remain in the content-addressed
cache. Advance the pins before restarting so the resulting image includes
the fatal-diagnostic fix too: go-hello 22, classic 29, FrankenPHP+Caddy 8,
standalone Caddy 6, and WordPress 34. No compiler change was needed.
An isolated detached checkout at `.context/go-signals-baseline` retains the
previous `5e25c7365` source for forthcoming incremental performance checks.


The upstream exec rerun uses the shared VFS harness with source package
`os/exec` and filter `^(TestWaitInterrupt|TestWaitid|TestSIGCHLD)$`. For each
mode, build `go test -c os/exec` with `GOOS=kandelo GOARCH=wasm`, instrument
the cgo output, and stamp freshly built outputs through the normal helper.
The exact runner arguments are:

```sh
KANDELO_GO_IMAGE_TMP=1 KANDELO_GO_TEST_TIMEOUT_MS=180000 \
  node --import tsx tests/go/os-stdlib/run-full-vfs.ts \
  .context/go-signals/cgo-exec.wasm local-binaries/source-only-v1/kernel.wasm \
  .context/go-browser/os-pwd.wasm \
  '^(TestWaitInterrupt|TestWaitid|TestSIGCHLD)$' '' os/exec
```

The shared PHP/Caddy drain probe type-checks in strict mode; its real Node
and browser execution still awaits the rebuilt image.


**2026-11-05 — Adopt the existing heap-safepoint contract in Go waits.**
Go's internal channel wait was still unbounded, even though the C SDK had
already adopted `kernel.kernel_heap_safepoint` for the suspected JSC blocked
wait/GC interaction. The cgo public-syscall bridge alone did not cover
internal Go futex waits. Fork commit
`930124371e660e1a2cac92cd7f78771a7716bc31` adds the same 100 ms first bound,
existing host import, and atomic retention of the host's next bound. It
keeps the original syscall pending and preserves its completion. Node and
non-JSC browsers disable the bound after the first host answer. The
registered runtime cause remains suspected; this does not establish the
cause of the classic WordPress stalls.

Both Node blocked-read probes pass. The expanded browser suite passes
45/45 in 1m43s (`go-safepoint-browser-async-module-check-1105-183529-3f1c`),
including both modes' import-presence and 400 ms blocked-read checks. The
first run had 43 passes and two Chromium fixture errors: the import check
synchronously compiled a module above the browser's 8 MB main-thread cap.
Using the supported asynchronous compile API fixes those checks. The
standard-library compile matrix, unchanged ABI-55 digest/snapshot check,
and runtime-workaround registry check all pass. The existing registry entry
now links the tagged external Go site for future retirement.

The source build using the preceding pin was stopped after 13m39s, just
after completing ncurses, to advance the Go producer pin before the large
consumer rebuild. Completed dependency nodes remain cached. Recipes now
select go-hello 23, classic 30, FrankenPHP+Caddy 9, standalone Caddy 7, and
WordPress 35. Actual PHP/Caddy drain, current-image browser workflows,
longer uptime/memory checks, and incremental benchmarks still follow the
source-product rebuild.


The safepoint-pinned runtime also passes both Node and all six browser
retirement probes after rebuilding the fixtures
(`.context/go-safepoint-retirement.log`). Every case completes cooperative
retirement with clean guest stderr and diagnostics. The active source
rebuild is `go-safepoint-source-products-1105-183847-8b11`; its registry
snapshot is stable at the revision-35 recipes. The application-level
PHP/Caddy drain test is still unrun until that image is available.


**2026-11-05 — Preserve syscall state for runtime-owned cgo signals.**
Source review found that Go-owned signal notification entered the ordinary
user cgo callback transition. That transition allows a Go stack to move,
while libc may still hold pointers into that stack, including the typed
syscall completion frame. Go fork
`29e21182116f32de46a7792402860a88ccb1178c` handles this runtime-owned
notification on the system stack instead, preserving syscall state until
C returns. It leaves ordinary foreign-pthread callbacks unchanged. This
is a twelve-line target-runtime change, not a compiler or consumer patch.

The new signal/GC fixture waits for each actual blocked read, triggers GC
from another goroutine, then delivers SIGUSR1 and checks both EINTR and
notification. Both Node modes pass twelve rounds with clean guest stderr
and diagnostics. The expanded browser suite passes 51/51 in 2m35s including
fixture builds (`go-signal-system-stack-browser-1105-190444-1170`). The
Kandelo cgo-disabled/enabled, js/wasm, and wasip1/wasm standard-library
compile matrix passes; the portable test helpers pass strict TypeScript.
The first compile invocation omitted `CC=wasm32posix-cc` and failed the
C pointer-width check; the corrected target compiler invocation passes.

The prior implementation also passed both Node GC fixtures and no stack
relocation was observed. Do not describe this as reproduced corruption or
the established cause of WordPress failures. The source build continues
with its stable 9301243/revision-35 snapshot; the new callback commit is
pushed but not yet pinned or part of an application image. The real
PHP/Caddy shutdown probe is still pending that image.


The new callback pin also passes the existing ordinary callback regression
selection after rebuilding and stamping both artifacts. All three Node
probes pass with clean stderr/diagnostics; Chromium, Firefox, and WebKit
pass all nine browser cases in 23 seconds. These include Go-owned callbacks
that yield and call C again, stack growth on C-created pthreads, and eight
rounds of concurrent Go/C allocation churn
(`go-signal-callback-regression-1105-191037-1ebc`, 42 seconds including builds).

A freshly built, instrumented, and stamped cgo-enabled upstream `os` binary
passes the complete image-backed VFS run: 224 top-level tests/examples,
21 skips, zero failures, empty guest stderr and host diagnostics. Raw output
is `.context/go-signal-system-stack-os.json`; build and host-console output
is `.context/go-signal-system-stack-os-build.log`. The latter retains the
existing macOS port-49152 publication warning; no host service was stopped.
This is a runtime/standard-library gate, not validation of the pending
WordPress image.


The rebuilt full Go browser inventory runs 147 cases: 146 pass and one
Chromium upstream `os/exec` Unix-path/wait case fails in `TestWaitid` with
child exit status 1 (`go-core-current-runtime-1105-191504-61b5`, 7m04s
including fixture builds). The same case passes in Firefox and WebKit;
three focused Chromium repeats also pass (35 seconds). This remains an
intermittent failure, not a green full-inventory result. Its actual failure
payload and source-log hash are retained under
`.context/branch-failures/go-signals/`. A smaller stop/continue pipe
reproducer with child-error capture is running before any behavior change.


**2026-11-05 — Add reproducible sustained-load and native-RSS sampling.**
The existing paired stack benchmark now accepts `--soak-seconds` and
`--image-path`, validates every sustained-load response, and records
request counts plus native RSS every fifteen seconds. This optional phase
follows timed latency/throughput phases. Node rounds now run in separate
child processes, record each child PID, and wait for its exit before the
next round. Chromium already launches a fresh browser per round; its RSS
collector sums the processes reported by the browser debugging session.
That sum can double-count shared pages and is not unique physical footprint.

The first Node smoke run exposed memory retained across profiles in the
same parent. After process isolation, the two-profile smoke passes again
with distinct PIDs and image revision 32, SHA-256
`9dbe6dc206daf91f6831c21e4b3908cc7ad859d7a67f64a98308b8515e1fe88b`.
FPM completes 32 requests in its fifteen-second phase and classic completes
58. Whole-process RSS samples are approximately 5.08 -> 4.72 GiB for FPM
and 9.04 -> 8.02 GiB for classic. These include image staging, native code,
kernel/guest workers, and allocator pages. They are not PHP-only footprints,
current-image measurements, evidence of a plateau, or performance comparisons:
compilers and another probe were active, and the timed smoke has one sample.
Raw provenance and measurements are in
`.context/wordpress-isolated-soak-smoke.json`; the complete command and log
are in `wordpress-isolated-soak-smoke-1105-192927-5e10` (1m03s).

The archived-image Node smoke validates the harness only. Its Chromium
RSS/sustained-load path and long runs still await the current application
image. A direct TypeScript invocation cannot type-check the whole benchmark
import graph because of existing Vite-only imports and browser filesystem
ambient types; its diagnostics are retained in
`.context/wordpress-stack-typecheck.log`. The strict portable graceful-PHP
helper check passes. Actual PHP/Caddy shutdown remains pending.

The standalone stop/continue reproducer passes 200 rounds in each Node
mode with clean child stderr/diagnostics (2m42s including builds). Its
Chromium preparation first hit duplicate Playwright installations and an
ES-module directory import; neither attempt ran guest tests. The corrected
module/runner selection is now running. These observations do not establish
the cause of the upstream Chromium TestWaitid failure.


**2026-11-05 — Preserve blocked I/O retry authority across SIGCONT.**
A diagnostic overlay of upstream `os/exec` TestWaitid forwards child stderr
and prints its read error. One hundred Chromium repeats reproduce nine
failures: `read /dev/stdin: device or resource busy`. This changes only the
test build; the runtime and standard-library implementation remain intact.
The earlier standalone 200-round probes pass in Node and Chromium; an
exact two-write variant also passes in Node. The original upstream test
provides the failing scheduling sequence.

The shared host's resume barrier re-armed all deferred channels through a
fresh mailbox listener. A deferred blocked read still owns its original
Rust open-file-description binding; a new request with token zero therefore
correctly receives EBUSY from Rust. Resume now sends such channels through
the existing frozen retry plan and target token, while fresh requests keep
the ordinary listener. This is a shared Node/browser host correction, with
no guest-library workaround, new ABI field, or relaxed kernel admission.

A deterministic wasm32/wasm64 regression fails with EBUSY before the fix
and passes afterward, also checking the original fd, destination, payload,
and exactly-once binding release after guest request bytes change. All four
related host suites pass 185/185 with no skips
(`.context/stopped-read-retry-current.log`). The initial broad rerun had one
stale source-text assertion for the earlier typed libc wrapper; its update
preserves cancellation-point argument checks. Failure excerpts are retained
under `.context/branch-failures/go-signals/`.

The Chromium diagnostic selection passes 100/100 upstream repetitions with
clean stderr/diagnostics after the fix
(`go-waitid-resume-retry-fixed-1105-194403-b745`, 1m27s). Newly rebuilt cgo
and current pure-Go exec binaries each pass twenty unmodified TestWaitid
repetitions in Node, also clean
(`go-waitid-node-resume-fixed-1105-194558-c1c6`, 24 seconds including build).
The ordinary browser inventory now includes a twenty-repeat unmodified
upstream stop/continue case per engine; its full 150-case run is ongoing.
ABI 55's digest/snapshot check remains unchanged and passes; the existing
runtime-workaround registry also remains consistent. This defect belongs
to Kandelo's host, and needs no external-runtime workaround entry.


The full ordinary browser inventory now passes 150/150 across Chromium,
Firefox, and WebKit (`go-core-resume-retry-fixed-1105-194514-9160`, 8m07s).
That includes twenty unmodified upstream TestWaitid repetitions per engine.
Together with the deterministic wasm32/wasm64 regressions, this validates
the shared host's retry-token correction; it does not establish the cause
of the separate classic WordPress/WebKit editor stalls.

The subsequent sequential Sortix signal/I/O run does not execute guests:
Node reports 89 resolver failures and two existing skips; browser reports
89 runner errors and the same skips. The active source build has staged a
new rootfs of 173194 bytes while the previous published projection still
records 173050 bytes. The resolver correctly refuses the mismatched cohort.
The source build log records that new rootfs at its rootfs/wasm32 node;
its final publication must finish before rerunning these conformance suites.
No integrity check is weakened. Raw reports remain in
`.context/stopped-read-sortix-{node,browser}.log`.

Branch-only diagnostic excerpts are kept in
`.context/branch-failures/go-signals/`, following the repository's failure
recording policy. The earlier committed baseline inventory remains intact;
the progress log retains the branch commands, results, and root cause.


The validation guide now records the observed staged-member/published-
projection boundary so future consumers wait for finalization instead of
misdiagnosing or overwriting an in-progress output. Go profiling guidance
links the now-isolated Node stack benchmark and its RSS scope. These are
documentation changes; they add no runtime validation claim.

A separate revision-32 image staging diagnostic records roughly 99 MiB RSS
before loading, 1179 MiB after image load, and 1658 MiB after saving the
configured 500162899-byte image, before guest execution
(`.context/wordpress-rev32-memory-stages-current.log`). This separates part
of the harness cost from executing PHP/Go; it is not a decomposition of
steady-state server footprint or a memory leak diagnosis.

Baseline provisioning compiled PHP and both MariaDB architectures, then
its direct `bootstrap rootfs` host step failed on missing login output.
The corrected final preparation selects kernel, PHP, both MariaDB variants,
and the rootfs package in one normal source-build closure before building
the benchmark fixtures. Separate filtered bootstraps replace the published
projection, so the final union matters. For the candidate, selecting
`demanded` plus `mariadb64` preserves the normal eleven products while
adding the memory64 database inputs required by the complete benchmark.

**2026-11-05 — Prepare the incremental comparison baseline.**
The corrected baseline union build succeeds in 24m01s
(`go-signal-baseline-final-1105-200509-5aee`). Its normal resolver admits
the kernel, rootfs, PHP, and both MariaDB server/client architectures.
The initial microbenchmark attempt stops before execution because the
baseline's Node worker bundle is missing. After building that baseline's
host package normally, all four microbenchmark suites run in Node
(`go-baseline-micro-provisioning-ready-1105-203504-8b03`, 11 seconds) and
Chromium (`go-baseline-browser-micro-provisioning-1105-203525-a960`,
19 seconds). The suites are syscall I/O, stdin throughput, process
lifecycle, and spawn scratch. These single-round provisioning runs occur
alongside the main compiler build and support no performance claim.

The dormant MariaDB image recipe also builds normally for wasm32 and
wasm64 through `build-deps resolve --source-only`
(`go-baseline-database-images-1105-204250-41f6`, 1m09s). It retains its
dormant product status. The benchmark-only baseline set admits that recipe
and publishes it with the existing prerequisite union; source caches and
the baseline's own SDK remain authoritative. Application execution and the
quiet-machine incremental comparison are still pending.

The benchmark-only union then publishes successfully in 1m27s
(`go-baseline-benchmark-union-1105-204443-7a7b`), reusing all 41 package
nodes. Normal source-only admission confirms both database images together
with PHP and the rootfs. All nine Node suites execute in one single-round
provisioning run (`go-baseline-node-all-suite-provisioning-1105-204853-39a2`,
37 seconds). All four MariaDB Chromium suites also execute
(`go-baseline-browser-databases-1105-205000-b550`, 31 seconds), bringing the
browser provisioning scope to eight of nine suites. These are executions
under compiler load, not before/after performance evidence. The baseline's
full canonical WordPress image is building through the normal package graph
before the ninth browser suite; no smaller substitute image is used.

**2026-11-05 — Locate the broader spawn and mask boundaries.**
Read-only review confirms that child credentials are a missing spawn
contract: Rust's `SpawnAttrs` carries no requested uid/gid/groups, while
RESETIDS only resets inherited effective IDs. The wire header padding is
explicitly ignored until a later ABI assigns it semantics. Go's current
`Credential` rejection is therefore truthful; no parent-credential mutation
or launcher wrapper is introduced.

Inherited-mask management also needs early thread lifecycle support.
`runtime.needm` saves and blocks signals before attaching an M or g, but
Kandelo's raw channel helper dereferences `getg().m.channelBase`. The shared
Wasm mask type and lifecycle hooks remain stubs. The Go runtime guide now
records these actual hook points and the required inherited-mask/foreign-
callback validation. No Go source, compiler, package recipe, kernel, or ABI
is changed by this review. The current image builds remain uninterrupted.

The cgo guide's older link-only paragraph also described constructor arrays
and callback/TLS work as entirely unfinished. It now matches the current
linker and the existing constructor fixture: metadata-backed, zero-filled
initializer storage is supported; referenced, relocated, exported, or
nonzero arrays and explicit nonempty finalizer arrays remain rejected.
Registered C exit handlers already have separate Go-return, `os.Exit`, C
`exit`, and C `_exit` cases. This is a guidance correction; no runtime
behavior changes or new test passes are claimed.

**2026-11-05 — Strengthen the prepared PHP shutdown gate.**
The shared Node/browser probe now holds PHP until SIGTERM is observed and
Rust's listener table confirms that the server has stopped listening. Only
then does it release the request, require the exact HTTP response, and
require both server and dinitctl exit status zero. This closes a fixture race:
releasing PHP immediately after the signal syscall could finish the request
before the shutdown handler starts. Close traces record syscall entry, so
the probe checks real network state rather than assuming completion.
Caddy 2.10.2's selected Unix listener wrapper closes the underlying listener
on HTTP shutdown, matching this barrier.

The helper passes strict checking with the repository host TypeScript
compiler (`.context/frankenphp-graceful-listener-typecheck.log`). An initial
root-level npx attempt selected an unrelated `tsc` command and failed before
checking the file; it was corrected to the declared host compiler. Actual
Node/browser execution of this stronger gate still awaits image publication.
The Node case preserves the service log's beginning and end, plus the live
listener process's status when available, if the drain probe fails. This
keeps fatal headers and signal-mask evidence available before teardown.

**2026-11-05 — Add a public Go support overview.**
`docs/go.md`, linked from the main README, SDK guide, and probe README,
collects the normal package entry points, bounded runtime/cgo coverage,
remaining platform gaps, and the actual embedded-PHP WordPress profiles.
It distinguishes the native Go compiler from cgo's SDK C compiler and
records that the `wasm32posix-go` convenience wrapper currently forces
pure-Go mode. Existing cgo recipes use the fork's ordinary Go CLI with
the SDK C compiler and the normal installer.

No SDK file is changed: `sdk/bin` and `sdk/package.json` are global package
cache inputs, so edits there would invalidate the active source builds.
The overview's repository links resolve and `git diff --check` passes.
This documentation adds no runtime or performance validation claim.

**2026-11-05 — Reject an incomplete component-image shortcut.**
The new Caddy producer passes normal source-cache admission while the full
image is still building. A separately scoped component attempt combines it
with the archived revision-32 image, but fails in six seconds before
FrankenPHP starts: the service launcher cannot execute `/usr/bin/id`
(`EIO`). Offline inspection confirms that `id` and its coreutils hard links
are deferred image entries; the archive alone does not contain their bytes.
This mixed-generation fixture does not establish PHP or Go shutdown behavior.

The attempt is abandoned rather than manually replacing dependencies or
duplicating the normal image builder's executable/companion closure. The
temporary kernel override is removed from the Node test. The job
`frankenphp-caddy-component-drain-1105-224725-a062` and the deferred-entry
inspection remain under `.context/` as failure evidence. Normal coherent
image publication remains the prerequisite for the real PHP shutdown gate;
resolver integrity checks are unchanged.

**2026-11-05 — Align the final service shutdown deadlines.**
Review finds a real configuration mismatch in the prepared classic shutdown
change: the Go HTTP server allows 20 seconds to drain, but the packaged dinit
defaults to SIGKILL after 10 seconds (`build-dinit.sh`). The current image
does not override that deadline for either FrankenPHP service. Caddy's
current configuration also leaves its HTTP grace period unbounded.

The final-image patch now prepares an explicit 20-second Caddy grace period
and 30-second dinit stop deadlines for both services, allowing cleanup after
HTTP draining. It uses ordinary upstream configuration, without changing
dinit, Go, or PHP. This image-input patch is not applied during the active
build; it belongs with WordPress revision 36 and the final source pin.
Patch applicability and browser-runner shell syntax pass. Actual application
shutdown evidence remains pending coherent image publication.

**2026-11-05 — Apply the final consumer pin and shutdown implementation.**
The revision-35 full-product job is deliberately stopped through its verified
supervisor after 4h29m (exit 143), while starting SpiderMonkey. Its process
group is confirmed empty before registry edits. Completed source-cache
entries, including Clang, PHP-ZTS, ScummVM, and Freeciv, remain available;
no cache is deleted. This avoids publishing a known superseded image before
the final source pin and deadline corrections. The independent baseline
build continues unchanged, now instrumenting Clang's wasm-ld.

All four Go consumers now pin the tested `29e2118` source. The classic entry
point uses standard `signal.NotifyContext` and `http.Server.Shutdown`, waits
for active PHP handlers, and performs deferred PHP cleanup before returning
an error to `main`. Deferred HTTP close also covers abnormal Serve returns.
Both image services allow 30 seconds before supervisor SIGKILL; both HTTP
servers have a 20-second grace period. WordPress is revision 36.

Node and browser service cases now require the held-PHP drain for both
profiles. The helper passes strict host TypeScript checking and the Go
source passes formatting inspection. The normal final build also includes
standalone Caddy, MariaDB64, and both dormant MariaDB VFS images for the
remaining validation scope, without changing shipped product exposure.
Actual final-image build and application evidence remain pending.

The first final-build command stops before compiling in 15 seconds
(`go-final-php-drain-products-1105-231020-f233`): the planner correctly
rejects mixing its exclusive `demanded` alias with extra filters. The
validation runner is corrected to read the normal supported set's 11 active
product IDs, obtain normal host binary demands from the existing supply
checker, and add the four validation-only filters. The resulting 52 explicit
filters form one normal source-build union. The existing published-consumer
checker runs after publication too. No planner or integrity rule changes.
The corrected job is `go-final-php-drain-union-1105-231210-da9d`.

**2026-11-05 — Complete current C signal/I/O conformance on both hosts.**
The normal builder publishes a separate kernel/rootfs validation projection
while the WordPress build continues. All 22 package nodes reuse verified
source-cache entries. An initial admission command uses the wrong rootfs
alias and stops before tests; the corrected canonical request is
`programs/rootfs.vfs.zst`.

Node then passes 89 cases with two existing skips, zero failures, and zero
timeouts (`go-current-c-conformance-admitted-1105-232220-006d`). Chromium's
first attempt records 89 runner errors and two skips before guest execution:
its shared exec fixture imports dash, which the rootfs-only closure does not
include. A normal 23-node publication adds dash, reuses every cached node,
and admits all five exec fixture imports. The browser-only rerun passes
89 cases with two existing skips, zero failures/errors, and zero timeouts
(`go-current-c-browser-with-dash-1105-232853-bd37`, 2m58s). Node is not
unnecessarily rerun. The skips are the existing implementation-defined
`signal()`/SA_RESTART cases; no allowance changes.

Both hosts use the same ABI-55 kernel (`86e9efa8…`), 173,194-byte rootfs
(`fcfddca5…`), and identical host source hashes. The artifact records, raw
logs, initial failures, and evidence index remain in `.context/`. This closes
the targeted C signal/I/O gate; it establishes neither full POSIX/Go
conformance nor FrankenPHP application shutdown. The WordPress revision-36
build has advanced through MariaDB64 into the new classic executable; the
baseline build remains separate.

**2026-11-06 — Publish the final image and exercise actual service shutdown.**
The final normal source union succeeds in 47m28s: 183/183 nodes, all 11
products, 159 cached dispositions, and 24 published dispositions. The
published-consumer checker also exits zero. WordPress revision 36 is
79,346,339 bytes with SHA-256 `784804ed…`; Go consumers use `29e2118`.

The optional `go-hello` sample is not selected by the default demand graph.
A separate normal kernel/sample projection builds revision 24 and passes
the existing C `posix_spawn` launcher in Node and Chromium/Firefox/WebKit
(three browser passes). ABI digests match; Node has both markers, no stderr
or host diagnostics, and fork count zero. Vite skips general app pre-bundling
because that two-package fixture omits rootfs. The selected probes have no
runtime errors; this is not evidence for the complete app.

An attempt to publish WordPress early overlaps the main image producer.
The cache correctly rejects the second image's differing bytes and preserves
the first winner. No cache entry is overwritten or integrity check relaxed.
The cached retry publishes normally, then both Node tests reach real PHP.
They fail before SIGTERM because the prepared probe assumes `/tmp/dinitctl`,
while the current image controller uses `/run/kandelo-services/dinitctl`.
The shared probe now invokes the public `kandelo-service stop` command;
the browser-host fixture also boots through `/sbin/kandelo-init`.

With that test correction, both profiles close their listeners, finish the
held PHP response, and return zero server/controller exits. Classic passes
the full Node case. Caddy subsequently fails cooperative machine destruction
with a forced-retirement warning (four of five woken processes drained).
A Caddy-only rerun passes; bounded fresh-process repetitions stop at the
first failure and retain process-lifecycle evidence. No Go or host runtime
fix is claimed for that intermittent condition. The helper's strict type
check passes. The first failed attempts remain under `.context/`.

The bounded repetition reproduces the teardown failure on its first run.
Its lifecycle also exposes an earlier Caddy exit with status 2 followed by
supervisor restart; the replacement's PHP drain still succeeds. Capturing
the service log before destruction identifies `runtime: epoll_ctl arm failed
with 1` / `fatal error: runtime: netpollarm failed` while
`crypto/x509.loadSystemRoots` reads the certificate file. A later test that
otherwise passes contains that fatal trace too. Node and browser-host cases
now reject Go panic/fatal headers in the service log, so restart cannot hide
the original failure.

Read-only tracing locates the boundary: Kandelo correctly rejects regular
files from epoll with EPERM, but the Go target's `netpollopen` returns success
without registration. Go therefore leaves the file nonblocking and later
tries to arm epoll when a deferred VFS read returns EAGAIN. The next step is
a deterministic regular-file deadline regression and a target-runtime
registration correction, preserving the ordinary blocking-file fallback.
No compiler, library, or kernel patch has yet been applied for this failure.

**2026-11-06 — Correct target-runtime descriptor pollability.**
The extended `netpoll-basic` fixture fails deterministically on the preceding
Go source in both plain-Go and cgo modes: a regular file incorrectly accepts
a deadline instead of returning `os.ErrNoDeadline`. Go fork commit
`1b0cf58011c425efe571b67dc134513b0760ad83` (pushed) changes only the target's
`netpollopen`: probe epoll registration, return its error, and remove a
successful probe interest. Go's unchanged `os.File` code then restores
blocking I/O for unsupported descriptors. Removing the probe also preserves
the existing lazy poller's idle-HUP behavior. The change has eight inserted
lines and one deletion; no compiler, dependency, kernel, or ABI change.

| Mode | Before | After |
| --- | --- | --- |
| Plain Go | Exit 2: regular file accepts deadline | Exit 0: full netpoll probe |
| Cgo | Exit 2: regular file accepts deadline | Exit 0: full netpoll probe |

Both after-runs have the expected marker, empty guest stderr, and no host
diagnostics. The probe retains TCP deadline/readiness, close-unblocks-read,
and blocking-pipe scheduler checks. Both modes pass in Chromium, Firefox,
and WebKit: six browser cases. The normal fixture rebuild and all four
standard-library compile gates also pass (Kandelo cgo off/on, js/wasm,
wasip1/wasm). The full ordinary Go browser inventory is now running before
consumer pins change. The packaged image still uses `29e2118`; actual Caddy
clean startup, browser PHP draining, and machine retirement need a rebuilt
consumer image. No application-level correction is claimed yet.

The complete ordinary browser inventory then passes 153/153 in 7m39s
(`go-netpoll-full-browser-1106-003213-ad4b`). Only after that terminal success
do the four consumer recipes move to `1b0cf58`: go-hello revision 25,
FrankenPHP classic 32, FrankenPHP+Caddy 11, and standalone Caddy 9. WordPress
moves to revision 37. The next normal source union explicitly includes the
optional Go sample alongside the previous products and benchmark inputs.
No overlapping WordPress image builds are started. The revised image must
still prove startup without a fatal trace or hidden restart, actual PHP
draining on both hosts, and complete machine retirement.

The porting skill's reference table now routes Go packages directly to the
public support overview, plain-Go/cgo registry examples, and the focused Go
runtime/linker guide. This completes the guidance-discovery link for the
earlier Go-specific guidance work item. It changes documentation only.

**2026-11-06 — Validate revision 37 through both actual Node services.**
The coherent source union succeeds in 19m56s: 184/184 nodes, all 11
products, 178 cached and six published dispositions. The normal
published-consumer checker exits zero. WordPress revision 37 is 79,330,377
bytes, SHA-256 `79c47b29053245fc4a295af30dfa41a1ea655b7515ec1654b9460fc2a15c1beb`.
The Go source is `1b0cf58`; the ABI-55 kernel bytes are unchanged.

Both actual Node service tests then pass in 49 seconds
(`frankenphp-rev37-node-services-1106-010838-19e4`). Classic and Caddy
start through the image's ordinary init/controller, serve WordPress,
close the actual listener after SIGTERM, complete a held PHP response,
and return zero server/controller exits. Both machines retire their
workers cooperatively. Neither service log contains a Go panic/fatal
header; Caddy no longer emits the observed certificate-read panic or
HTTP shutdown deadline warning in this run. This establishes the two
current Node cases, not the absence of every intermittent failure.
Artifact identities and raw service logs are retained under
`.context/frankenphp-node-image-VT1Wsf/`.

The normal `./run.sh browser` preview is preparing its cached projection
on port 5417. Browser startup/editor checks and the remaining current-image
load, recovery, and performance gates are still pending. The original
independent benchmark-baseline build continues without being restarted.

The normal browser preparation then succeeds: 178/178 cached nodes, all
11 products, and the published-consumer check. Its final artifact
verification takes 981.9 seconds; no source package rebuild is needed.
The persistent Vite preview is running on loopback port 5417. The gallery's
ordinary image/profile URL resolves to the exact revision-37 SHA-256 and
size above, checked against the actual HTTP response rather than inferred
from a filename (`.context/frankenphp-preview-artifacts.json`).

The visible Caddy UI test passes in Chromium and Firefox (two passes in
2m50s): homepage, Shortcuts admin login, Appearance/site editor, template
canvas blocks, and 20 seconds of editor HTTP health. The test now also
rejects Go panic/fatal headers in the real service log, so supervisor
recovery cannot hide a server crash. Broader current-image validation and
performance measurements remain pending. Preview UI evidence is under
`.context/frankenphp-preview-ui-IAnRUG/`.

**2026-11-06 — Exercise heavier browser traffic and retain failure evidence.**
The first six browser-host cases stop before PHP starts: the direct host
fixture omits the app's lazy-asset transport, so the service controller
cannot execute deferred `/usr/bin/id`. Using the existing
`imageOwnedLazyAssetDirectory` helper fixes that fixture without rewriting
the image or changing runtime resolution. The corrected run passes five
cases in 3m42s: classic and Caddy on Chromium/Firefox, plus classic on WebKit.
Those cases include real OPcache cache files, 40 request-churn iterations,
20 editor burst rounds, ten parallel editor requests, held-PHP shutdown,
and cooperative machine destruction. Caddy also recovers after deliberate
SIGKILL. WebKit Caddy loses its page evaluation context.

The browser fixture now saves service logs as actual artifact files and
records workload phases outside the page. A bounded WebKit repetition
stops at its first failure: classic reloads the same URL about 60 seconds
after navigation, during request churn. A further native-log run passes
classic and fails Caddy. The browser reports that its content-process
footprint is 21,182 MB against a 16,384 MB kill threshold. This establishes
the observed process-kill reason, not the source of the memory use or an
engine defect. A separate plain-page 70-second control passes without a
reload. Traces and phase evidence remain in
`.context/frankenphp-webkit-host-n4geqB/` and
`.context/frankenphp-webkit-host-R01rUZ/`.

The Node log guard is strengthened too. Its shared demo setup removes the
classic logfile directive, so the prior assertion could examine a `missing`
placeholder. The test now preserves the image's original service config,
requires the actual log and startup marker, and saves both profile logs.
Classic passes. Caddy again completes the exact held PHP response and
returns zero server/controller exits, with a clean service log, but machine
destruction drains only three of four reported processes before forced
retirement. Init has no recorded exit event. This preserves the separate
intermittent teardown failure; the file-poll correction does not resolve it.
Evidence is `.context/frankenphp-node-image-HCImlw/`.

The current normal Go sample package (revision 25, source `1b0cf58`) also
passes its C VFS launcher in Node and all three browsers: three browser
cases, matching ABI stamps, expected markers, empty Node stderr and host
diagnostics, and zero Node fork count. Its isolated two-package publication
retains the known unrelated app pre-bundle warning; the selected probes
have no runtime failure. Evidence is `.context/go-package-final-ubOYPz/`.

The paired stack harness now preserves and checks actual service logs,
rejects Go fatal traces and repeated FrankenPHP startup markers, and checks
the Go server's listener identity across the measured workload. nginx's
shared listener legitimately rotates between worker PIDs. The browser pair
also selects both profiles inside the alternative's one hash-verified
image: the gallery's FPM shortcut belongs to a different multi-image product.
The previous two attempts correctly expose these fixture assumptions.
Node then completes both profiles with 15-second RSS phases, but the browser
RSS path stops because `ps` is absent from the declared dev shell. That
tooling gate remains open. The corrected HTTP/log path without a soak passes all four Node/Chromium
profile rounds for the FPM/Caddy pair in 2m28s, then all four for the
FPM/classic pair in 2m22s. Both reports retain the actual service logs and
exact image hash. These checks establish neither browser RSS nor long-term
stability.
All smoke runs occur under baseline-build load and support no speed claim.

The branch's raw logs, job metadata, terminal results and observation index
are retained in `.context/frankenphp-rev37-validation-evidence/`. Failure
records remain separate from later observations. No Go/compiler, package,
libc, SDK, or kernel change is made for these new findings.

The paired smoke reports are `.context/wordpress-current-stack-J5Qam5/`
and `.context/wordpress-current-stack-5D2PiL/`. The Node control uses six
FPM children; the browser uses the image's current one-child FPM default.
Both FrankenPHP profiles use six threads. This configuration difference is
now explicit in the profiling guide. Ad hoc strict checking with the
repo-pinned TypeScript 7 CLI still reports six diagnostics in imported
files; it reports none in the benchmark itself. The three prior benchmark
result/IPC type errors are corrected. This is not a full type-check pass.

The original incremental-baseline job drains after five hours and reports
three failures (`kandelo-cc`, `termchat`, `wasm-fork-instrument`), each from
an uninitialized `sdk/rust/libc-upstream` submodule. Its successful source
cache entries remain intact. The baseline's recorded libc gitlink
`71d5bfcc1bda05da1783666fc2cd7d9669c9c4c8` is initialized normally, and
`go-baseline-wordpress-rust-ready-1106-021122-0abc` resumes the same source
union. No baseline recipe or implementation is patched. Canonical baseline
WordPress admission and the ninth Chromium provisioning case still await
that build's terminal result.
