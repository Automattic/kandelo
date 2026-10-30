# WebKit process-memory construction controls — 2026-10-23

## Scope

This investigates a runtime blocker to persistent WordPress/MariaDB workload
acceptance, not OPFS throughput or filesystem corruption. The tested computer
uses ABI 51. The host is macOS 27.0.1 with 36 GiB of physical memory;
Playwright's installed WebKit manifest identifies revision 2359, version 26.6.
These are desktop headless results, not shipping Safari or mobile acceptance.

Public checkpoint 1.32 constructs process memories in disposable workers,
without the previous synchronous owner-realm fallback. Its normal editor,
post/upload and source-free recovery cases pass on all three engines. Its
larger WebKit workload fails with native allocation errors during guest
mutations, before the intended recovery phases. Chromium and Firefox pass
both live and optional-checkpoint versions of that workload.

## Controls and observations

| Control | Result | What it establishes |
| --- | --- | --- |
| Real 100-cycle fork/exec test, non-OPFS image | Passes on Chromium, Firefox and WebKit | Exact process retirement can progress in this smaller workload; not proof about larger application churn |
| Sixteen held memories plus 128 sequential disposable-worker allocations; initial one page, maximum 1 GiB | Refuses after 22 iterations; zero finalizations observed, 22 weak targets still reachable | Native reservation refusal can occur independently of OPFS and substantial resident payload |
| Same probe with direct owner-realm construction | Completes 128 iterations; 127 finalizations observed, one weak target reachable | Construction realm materially changes this probe's collection behavior |
| Disposable-worker probe with maximum 256 MiB | Refuses after 105 iterations; zero finalizations observed | A smaller ceiling postpones this failure; it does not demonstrate a general recovery solution |
| Frozen 1.32 WordPress/MariaDB, private control disabling only the factory selection | Both WebKit live and optional-checkpoint mixed workloads pass | Canonical owner allocation is a candidate to investigate, not yet a published runtime fix |

The synthetic probe holds sixteen real memories and weakly observes discarded
memory wrappers. It does not access their buffers or instantiate guest
programs; initial allocation is 64 KiB, and no large payload is touched.
Collection counters are observations, not ownership or admission authority.
The original failing probe receipts remain failures. The direct application
control changes the allocator's synchronous/asynchronous path too: it uses
the existing synchronous fork-clone helper instead of the factory's temporary
fork snapshot. It is not an isolated constructor-latency benchmark.

Both real application control cases retain their ordinary deadlines and
workload: SQL changes, media deletion/upload, 512 namespace entries, four
8 MiB guest files, byte/hash checks, and source-free recovery. One also takes
an optional image checkpoint. The public frozen site and native artifacts
remain unchanged. Two passing cases do not rule out the earlier intermittent
post-checkpoint readiness failure or establish a portable collection deadline.

## Error propagation

Native constructor exhaustion originally reached the exec path as an
unclassified `RangeError`, producing guest `EIO`. The current allocator source
classifies constructor `RangeError` as `ProcessMemoryCapacityError` with
`ENOMEM`, retains its cause, and returns failed pending admission credits.
Only the constructor boundary is classified; cancellation and unrelated errors
keep their original identity. Synchronous and asynchronous allocation share
this behavior, so existing Node/browser exec and spawn handlers receive their
ordinary resource-error type. This does not reclaim a native reservation.

Both new unit regressions fail against the previous allocator. The final
focused cohort passes 38 cases in three Node files. Twelve real-browser
allocation/snapshot/refusal cases pass across all three engines with no
retries or skips. The forced-constructor-refusal browser fixture uses an
invalid descriptor at its test factory boundary; it tests transport and error
classification, not physical memory exhaustion or a guest exec syscall.

## Evidence and limits

Private evidence prefixes under `.context/`:

- `persistence-native-memory-churn-rebuilt`: three engine cases, with fixture
  source/artifact hashes checked before and after. The initial attempt was
  refused before execution because its two guest fixtures had stale ABI
  digests. Both were then rebuilt through the local SDK, fork instrumenter and
  ABI stamper; the earlier failed receipt is retained separately.
- `persistence-native-wrapper-probe`: all three synthetic controls, including
  the two failures. The source audit passes after the cohort.
- `persistence-direct-memory-control`: the two passing application controls,
  exact-string private server modification, and frozen-site/source audits.
- `persistence-native-errno-red`, `persistence-native-errno-green-final`, and
  `persistence-native-errno-browser`: error-classification regression evidence.
  An intermediate unit receipt also retains a mock-constructor fixture failure;
  restoring the native constructor before the healthy allocation fixes that
  test, not the production allocator.

Current WebKit source distinguishes VM-local collection retries from the
process-wide buffer manager. This is consistent with the observed realm
difference, not proof of an engine defect in the pinned runtime. See
[Wasm memory allocation](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/JavaScriptCore/wasm/WasmMemory.cpp)
and [the buffer manager](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/JavaScriptCore/runtime/BufferMemoryHandle.cpp).

A separate read-only review supports canonical construction as the minimal
candidate, provided synchronous fork snapshot ownership, creator admission,
rollback and close-before-drain shutdown remain intact. The current source
removes factory selection from the browser kernel entry without redesigning
those protocols. The normal 1.33 build passes 120 Node cases in ten files,
host declarations, ABI checks and the frozen frontend build; its three native
artifacts remain identical to 1.31. The rebuilt integrated cohort passes:

- One real Node MariaDB mixed workload with source-free live recovery.
- Eighteen browser allocation/refusal/churn cases. Six churn cases complete
  600 fork/exec cycles across two process ceilings and three engines.
- Six WordPress SQLite/MariaDB editor/post/upload/source-free recovery cases.
- Six MariaDB mixed live/optional-checkpoint workloads across three engines.
- Both WebKit mixed workloads using constrained-profile URLs on the desktop.

There are no browser retries or skips. Source, native, site and selected
test-source audits pass after the cohort. Evidence lives under
`.context/persistence-checkpoint-1-33-*`. The integrated application cohort
takes 23 minutes 32 seconds including its prerequisite wait; this is suite
duration, not boot or filesystem latency. Public 1.33 contains this candidate.
These results do not explain the older Chromium readiness failure, substitute
for complete release/conformance validation, or prove physical-mobile behavior.

A separate SDK-built guest program also passes on Node and all three browser
engines. Under a 48 MiB aggregate process budget, exec of a valid 64 MiB-minimum
target returns `ENOMEM`; the original PID and stdout's `FD_CLOEXEC` state remain
intact, and a subsequent `posix_spawn`/wait succeeds with its expected status.
This exercises real guest process rollback under host admission refusal, not
native engine exhaustion or OPFS recovery. The private evidence prefix is
`.context/persistence-guest-memory-refusal-owned-server`; source/artifact hashes
pass after the run. Retaining that private guest program as a repository CI
regression remains a release follow-up. Earlier receipts retain an unused
legacy-kernel hash-path error and a private preview working-directory error;
neither was a successful browser guest test.
Do not restore the unsafe owner fallback, raise ceilings, rely on finalizers
for progress, or count resource refusal as successful workload acceptance.

## Constrained 1.34 followup

The frozen 1.34 artifact is not accepted by the earlier 1.33 results. Its
original constrained application cohort fails both cases. A subsequent
bounded private correlation probe passes the live workload in 83.924 seconds,
but the maintenance workload fails in 262.380 seconds. This failure is during
source-blocked guest verification after the additional refresh, not initial
installation or the earlier successful checkpoint verification. Private
receipts are under `.context/persistence-liveness-1-34-*`.

The failing worker's repeated final observations show:

- OPFS operation sequence and completed sequence both equal 5,917.
- Native kernel entry/completion sequence both equal 229,358, with no active
  native export; the last completed export is
  `kernel_wait_deadline_remaining_ns`.
- Host phase 40 marks entry to synchronous native `WebAssembly.Memory`
  construction. Neither its normal return phase 41 nor its throw phase 42 is
  reached in those observations.
- Independent kernel-worker echo messages cease receiving replies.

This localizes that reproduced pause to a native memory-construction boundary,
not an active filesystem read or kernel export. The observer does not record
the constructor descriptor or a native process stack. The recorded native
argument fields are not the memory descriptor and must not be interpreted as
its initial or maximum pages. No constructor exception, reservation limit or
engine defect is established. Instrumentation and concurrent machine load
remain caveats, and the pause has not been reproduced against the newer
shutdown-fencing source candidate.

Service-worker diagnostic messages time out in both the successful and failed
cases. That part of the probe lacks a valid healthy control and cannot
attribute the failure to routing. An HTTP-only check subsequently confirms
that the original private preview serves the kernel probe but not the service-
worker probe: Vite's local CORS configuration middleware handles the service
worker before that diagnostic plugin. Frozen-directory audits do not audit
this intentionally source-derived preview response. The receipt is
`.context/persistence-liveness-original-serving-check.log`.

The next bounded diagnostic should capture
the actual constructor descriptor, validate the service-worker control, and
capture a native stack of the positively identified test-owned WebKit process
while the pause persists. It must not sample or terminate the user's browser,
erase retained computers, increase declared memory ceilings, or substitute
constructor refusal for successful application completion.

The real guest exec-refusal regression is now retained in the repository and
passes on Node and all three browser engines, including real-OPFS
shutdown/reopen acceptance in the latter cohort. Its earlier private-only
status above is historical. This still does not explain a native constructor
that fails to return.

### Descriptor followup

The successor private observer records constructor descriptors in a second
64-byte shared diagnostic buffer. Three Node observer checks pass, including
pre-entry visibility, unchanged native exception identity and avoiding extra
descriptor-getter evaluation. Its first browser invocation fails collection
because a private test imports CommonJS named exports; that receipt is not a
browser pass. After correcting that fixture, the healthy service-worker
request/reply control passes.

The constrained WebKit live workload then fails during initial guest mutation
setup. The pending 31st shared-memory constructor requests 149 initial pages
(9.3125 MiB) and a 4,096-page maximum (256 MiB). Its completion counter remains
30. Native OPFS and kernel-entry counters are complete and the independent
kernel echo is absent, while the now-validated service-worker observer still
responds and records forwarded HTTP requests. This strengthens the localization
to the kernel worker's native allocation boundary, not service-worker routing.
It is still not evidence of an OOM exception or storage corruption.

The OS sampler refuses to act because it cannot positively identify an owned
WebContent process from the inherited marker/home fields. No native stack is
captured and no user process is sampled. The maintenance case is not run after
the first workload failure. Source, frozen-site and native-artifact audits
pass; receipts use `.context/persistence-native-memory-descriptor-1-34-fixed-*`.

Main subsequently gained ABI-52 runtime lifecycle fixes in `1ddfafc87`. Their
integration must precede further conclusions about the current implementation;
these failures exercise the older frozen ABI-51 checkpoint, not rebased main.
