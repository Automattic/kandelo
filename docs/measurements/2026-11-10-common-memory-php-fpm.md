# Common-memory PHP-FPM mechanism checks

The experimental profile runs real PHP 8.5.12 FPM with shared OPcache on
Node, Chromium, Firefox and WebKit. This establishes the mechanism in the
bounded profile below. The diagnostic application timings below compare all
three controls; they are estimates for these workloads, not production PHP
or WordPress performance claims.

## Architecture and build boundary

Each process keeps ordinary guest pointer values and a separate virtual
page-table root. All processes in the experimental group import the same
physical shared `WebAssembly.Memory`. The whole-program pass rewrites guest
memory operations after normal fork instrumentation, including generated
continuation code. A child copies private pages and inherits the shared
physical page references. Its new root/scratch bindings are not replayed
from the parent. No continuous per-process shadow memory or syscall-boundary
payload reconciliation implements the anonymous shared mappings.

The host profile bundles the actual host source through an experimental
syntax-tree adapter for virtual typed views, atomics, captured intrinsics,
text conversion, initialization and disposable-Worker messages. The kernel
remains in its normal dedicated worker. Guest memory never travels to the
persistent browser page. The shipping host refuses the experimental artifact
marker unless the profile explicitly opts in; normal ABI and fork admission
remain enabled.

`tools/common-memory-program/build-php-shared.py` copies the normal PHP recipe
into private scratch storage, disables its explicit shared-OPcache refusal,
and builds through the same SDK, declared dependency closure, configuration,
optimization, fork instrumentation and install helpers. It publishes no
package/index/image and leaves the shipping guard unchanged. Newly built
artifacts receive the normal ABI contract stamp before translation. The
first private build required that post-recipe stamp as a separate recorded
step; the driver now performs it itself.

The test image is `local-binaries/partial/shell-partial.vfs.zst`, containing
the rootfs base and PHP. Its SHA-256 is
`49344009c1a09b654a035ac62e4084ee103e1b19040c7ec61cb5ed22a2d52073`.
The kernel SHA-256 is
`1adb2d2cbc4ab9daad25e0bd29723cd2d343a7b58b5491837bd3e45d6f24f6c0`.
The test uses the protected in-kernel pipe APIs to exchange real FastCGI
records with a two-worker FPM pool. It publishes no physical-host listener.

## Observed checks

The frozen profile is `.scratch/common-memory-platform-17/`. Its manifest
pins the host source closure, adapter and build driver. Final raw evidence
and compressed artifacts are retained in
`.context/common-memory-php-stage3-20261110/` in this workspace.

| Host | Version | Shared OPcache scenario | FPM exit / host teardown |
|---|---|---|---|
| Node | 24.15.0, one Wasm compilation task | Passed | Exit 0 / completed |
| Chromium | 153.0.8010.12 | Passed | Exit 0 / completed |
| Firefox | 155.0 | Passed | Exit 0 / completed |
| WebKit | 26.6 | Passed | Exit 0 / completed |

The scenario checks actual process identities and cache counters:

- One worker waits at a VFS barrier while its peer includes a previously
  uncached target. Releasing the held worker proves that it observes the
  published cache entry and executes the cached pointer graph without an
  additional compilation miss.
- A worker invalidates the target while its peer is held. After a source
  update, the peer sees the invalidation, returns the new value and increments
  misses exactly once. Subsequent warm requests reuse that replacement.
- The master replaces a signaled worker. The new PID sees the existing shared
  target and returns the new value without another compilation miss.
- Request-local state starts at one throughout. Guest stderr and host
  diagnostics are empty in the passing scenarios.

The normal SDK C fork probe independently checks private and shared pointer
graphs with actual Wasm atomic wait/notify, before any syscall-boundary copy
could explain the result. It also checks a child's fixed private replacement,
protection changes, remap prefix/zero-tail preservation and unmap/reuse while
the parent's shared value remains unchanged. Its virtualized run passes;
the original separate-memory negative control times out as expected. Earlier
PHP CLI and file-cache-only FPM controls are retained in stages 1 and 2.

## Failures retained and corrected

The first protection integration missed the record-based syscall path.
Musl's metadata allocator mapped `PROT_NONE`, successfully called `mprotect`,
then trapped because the virtual PTE still denied access. Updating permissions
at successful common completion covers that path too.

WebKit's asynchronous fork path initially captured an ordinary byte snapshot,
losing the sharing metadata. It now captures private physical pages before
yielding and retains live shared PTE references. The normal allocator still
owns admission, fresh allocation and retirement.

One Node default-settings run passed the application assertions and exited
FPM cleanly, then the Node process exhausted memory in V8 background
compilation (`Fatal process out of memory: Zone`, exit 133). This is retained
as a failed overall run. Repeats with
`node --wasm-num-compilation-tasks=1` completed cleanly. Those results describe
that resource envelope; they do not establish default-settings stability.
Any Node timing comparison must apply and disclose the same flag for every
control. No engine-defect diagnosis is asserted here.

## Compact instrumentation and timing controls

The first expanded instrumentation inserts translation arguments and commit
code at each access. Its full warm trial passed the application assertions
but still ended in compiler OOM with one compilation task; disabling Wasm
inlining did not prevent that failure. Both runs are retained as failures.

The optional `--outline-accesses` pass instead interns a typed wrapper for
each distinct memory operation and immediate combination. Each wrapper keeps
the same virtual bounds, protection, scatter and atomic checks. Guest code
calls that wrapper with the original operation's operands. Original function
and global indices stay unchanged. This deduplicates 6,857 access forms in
the rebuilt FPM artifact and reduces it from 55.39 MiB to 36.31 MiB; the
untranslated artifact is 35.29 MiB. The expanded mode remains available.
The maximum function body falls from 398,218 to 181,089 bytes, close to the
untranslated maximum of 177,517 bytes. Regenerating the expanded mode with
the current tool produces the exact same code-section hash as the retained
original expanded artifact; the added profile metadata is the only relevant
reporting difference. The earlier instrumentation has not been discarded.

The outlined mode passes default-settings Node warm trials and all 32 final
control runs. No engine compilation flags are used in the final cohort.
That establishes stability for these runs, not every PHP workload. Additional
four-host checks cover nonzero offsets, scattered numeric access, distinct
SIMD lane immediates, 64-bit atomic signatures/results/alignment/timeouts,
effective-address overflow and denied-store prefix atomicity. The normal SDK
fork/lifecycle probe and real shared-OPcache scenario pass in this mode too.

The three controls use the same rebuilt PHP source, kernel, partial image,
generated workload files, FastCGI transport and host profile 18:

1. `native-file`: untranslated Wasm, file-cache-only OPcache.
2. `vm-file`: outlined virtual addressing, file-cache-only OPcache.
3. `vm-shared`: outlined virtual addressing, shared OPcache, no file cache.

Here **native means ordinary, untranslated Wasm addressing on the same
engine**, not a native machine-code PHP build. The ordinary control runs
through the same opt-in host bundle, selecting its native memory path.

Each host has two fresh-parent cohorts. Each cohort runs ordinary → two VM
controls → ordinary, reversing the VM order in the second cohort. Each trial
creates a fresh Node or browser parent process, kernel and FPM pool. One
group runs at a time. After three cold requests, 64 warmup batches exercise
each workload twice concurrently; seven measured rounds then randomize the
three workloads and two-request throughput batches. Both FPM workers must
have served warmup requests before measurement. Checksums, private request
state, cache mode, two worker PIDs, three VM roots versus zero native roots,
clean FPM exit and host teardown are required. File-cache controls produce
28 cache files; shared controls produce none and report enabled shared OPcache.

There are 32 final trials and 13,952 workload responses, including warmup.
The seven warm serial samples per workload per trial are summarized by their
median. Tables use geometric means of those medians across the fresh trials.
Ratios use the geometric mean of the two ordinary brackets in each cohort.
Two cohorts are insufficient for a precise statistical confidence interval;
the bracket envelopes below show observed baseline variation instead.

## Diagnostic application results

Warm end-to-end FastCGI latency in milliseconds, including request/response
transport and FPM work:

| Host | Object traversal: ordinary/file | VM/file | VM/shared | 24 includes: ordinary/file | VM/file | VM/shared |
|---|---:|---:|---:|---:|---:|---:|
| Node | 3.10 | 10.75 | 9.45 | 9.56 | 29.64 | 5.95 |
| Chromium | 2.75 | 7.46 | 6.77 | 8.88 | 17.53 | 4.18 |
| Firefox | 3.53 | 9.32 | 8.71 | 10.68 | 19.60 | 4.51 |
| WebKit | 3.03 | 6.95 | 6.90 | 10.89 | 18.84 | 4.30 |

The object workload builds a 256-object ring and traverses 16,384 links.
With shared OPcache it takes **2.28–3.05×** ordinary/file-cache request time
across engines. Its guest-body time is about **4.5–5.3×** the ordinary guest
body; fixed request costs dilute the end-to-end ratio. This prototype still
has a substantial cost on memory-heavy interpreter work.

The include workload loads 24 files defining 768 small PHP functions.
Virtual addressing with file cache costs **1.73–3.10×** ordinary/file-cache
request time. With shared OPcache, request time falls to **0.39–0.62×** the
ordinary/file-cache baseline: about **1.6–2.5× faster** for this cache-heavy
fixture. Avoiding repeated file-cache loading more than offsets translation
in this case. This does not predict the outcome for an arbitrary PHP app.

Observed baseline-bracket envelopes for VM/shared versus ordinary/file-cache
request time:

| Host | Object traversal | 24 includes |
|---|---:|---:|
| Node | 3.01–3.10× | 0.56–0.68× |
| Chromium | 2.44–2.49× | 0.39–0.53× |
| Firefox | 2.21–2.62× | 0.41–0.45× |
| WebKit | 1.77–2.50× | 0.35–0.41× |

Two-request batch throughput, requests/second; this is a bounded client
diagnostic, not a saturated server benchmark:

| Host | Object: ordinary/file | VM/file | VM/shared | Includes: ordinary/file | VM/file | VM/shared |
|---|---:|---:|---:|---:|---:|---:|
| Node | 545 | 142 | 169 | 166 | 45 | 245 |
| Chromium | 708 | 214 | 235 | 205 | 81 | 361 |
| Firefox | 421 | 179 | 189 | 122 | 61 | 313 |
| WebKit | 483 | 235 | 241 | 148 | 79 | 352 |

The empty JSON response takes approximately 2.5–3.2 ms on ordinary memory,
4.1–6.7 ms on VM/file and 4.3–5.8 ms on VM/shared. That floor includes the
host pipe RPCs and 1 ms client polling yield. Guest timers exclude main-file
cache loading, header generation and transport. Minimum observed successive
guest clock-call intervals are roughly 15–21 µs on ordinary memory and
40–80 µs on VM; these include syscall overhead and are not a direct timer
resolution measurement. Small timing differences near those floors should
not be interpreted as intrinsic translation costs.

Cold startup is separate. The master's listener becomes visible after about
0.31–0.48 s ordinarily, 0.33–0.52 s with VM/file and 0.34–0.55 s with
VM/shared. The first include response after listener visibility takes about
0.25–0.31 s, 0.33–0.47 s and 0.25–0.33 s respectively. Listener visibility
precedes complete worker readiness, so first-request cost includes cold
worker startup. Pure fork latency is not isolated by these measurements.

## Memory accounting and uncertainty

The three-process ordinary/file pool has approximately 91–92 MiB of logical
native linear buffers. VM/file allocates about 120 MiB in its physical group;
VM/shared allocates about 144 MiB. Those group totals include metadata,
8 MiB scratch per process, initial allocations later replaced by shared PTEs,
and monotonic extents that are not reclaimed. VM/shared's live roots refer
to approximately 90.9 MiB of unique private PTE backing and 8.06 MiB of unique
shared backing. The shared pages are counted once, including OPcache and
the FPM scoreboard. The physical group ceiling is 512 MiB.

These are Wasm buffer/PTE allocation measurements, **not host RSS**. The
prototype currently allocates more linear backing than the ordinary/file
control; it has not demonstrated a total-memory saving. Reclaiming abandoned
extents and reducing scratch are future work.

The machine has 18 logical CPUs and 48 GiB RAM. Other workspaces were active;
per-trial host load averages are retained. Native brackets and the two
cohorts expose meaningful variation. A first 16-warmup cohort was retained
and then repeated with 64 warmup batches because Firefox's native baseline
drifted substantially. The final numbers above use only the longer warmup
cohort; both complete datasets and all failed compiler diagnostics remain
available. These estimates are bounded to the generated workloads, host
versions and shared-machine conditions, not a quiet-machine performance
guarantee or an estimate of all PHP-FPM deployments.

Full source/artifact identities, raw trials and the summary are retained in
`.context/common-memory-php-stage4-20261110/`. The shorter-warmup dataset is in
`.context/common-memory-php-timing-screen-20261110/`. The summary script rejects
missing trials, mismatched workloads/artifacts, non-default Node flags,
failed cache/address-model checks and incomplete sample inventories.

## Remaining scope

The profile admits trusted memory32 programs with one running Worker per
process. The physical group is bounded to 512 MiB and uses a monotonic
allocator; physical extents are not reclaimed yet. General mapping rollback,
file-backed shared mapping identity, loaded extensions, threads, concurrent
remap, fault-to-POSIX-signal delivery and arbitrary-module isolation remain
incomplete. Concurrent direct Wasm growth and host allocation have not been
validated. This is an opt-in
prototype, with no merge-readiness or general POSIX-conformance claim.

The smoke's sleeps and worker barriers do not enter the timing workloads.
All previous optimization candidates remain available; this stage has not
established their individual PHP-FPM contribution.

The ordinary runtime's repository-required `browser-memory` coverage completed
in phases. Source protocol checks passed 7/7 and current browser product
preparation plus the host build completed. The first host audit found 14 new
prototype Memory/Instance authority sites requiring explicit ownership review.
Exact per-site declarations now classify standalone fixtures as non-kernel,
the group allocator as process memory, and the generic whole-host
instantiation adapter conservatively as kernel authority. No paths were
excluded and the audit remains enabled. All 253 host memory/lifecycle tests
then passed; Node teardown passed 3/3 and Bun teardown passed 7/7.

The first three-engine switching attempt was interrupted while Cage held
pointer capture: the test clicked Library without the UI's documented Escape
release. The shared test helper now presses Escape when captured and verifies
release before clicking the toolbar. No runtime code or memory assertions
changed. Reusing the unchanged prepared products, the exact remaining gate
commands exited zero: **18/18 browser cases passed**, with zero skipped,
flaky or unexpected results. Each engine completed four machine-switching
cycles in the same page realm, alongside audio activation and worker-exit
checks. The long cases took 6.3 minutes on Chromium, 9.4 on Firefox and 6.8
on WebKit. Raw initial, interrupted and final results are retained; the
original single command is not represented as an uninterrupted green run.
The runner emitted a nonfatal permission warning while deleting a Firefox
scratch `Documents` directory after all cases passed; this is retained in
the final log.

This surrounding gate exercises the ordinary runtime and supplements the
separate opt-in prototype checks. Full canonical-image acceptance, complete
host/POSIX conformance, full platform benchmarks and native Safari testing
were not run for this prototype. The bounded measurements and mechanism
checks above do not establish those broader acceptance claims.

The surrounding ABI selection finished with 22 passes and one pre-existing
assertion failure in `host/test/generated-abi.test.ts`. It compares generated
`SYSCALL_ARGS` with only `snapshot.syscall_arg_descriptors`, omitting the
declared `KLOG_V1` extension request 600. The generated table equals the union
of that syscall table and `snapshot.extension_requests.descriptors`.
The test, generated table and snapshot are byte-identical to `HEAD`; the
prototype changes none of them. This is recorded as a failed suite, not
reported as green or silently corrected as part of the prototype.
