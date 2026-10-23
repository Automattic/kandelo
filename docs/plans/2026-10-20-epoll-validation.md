# epoll implementation and validation, 2026-10-20

This records the work in the montevideo workspace at base commit
`6fe83ed27c00f50a8a97bb9b4329214f3737fd87`, with uncommitted epoll changes.
The [behavior matrix](../epoll.md) separates implemented contracts from
validation evidence. This is not a complete Linux compatibility or merge
validation claim.

The [current-main integration](#integration-with-current-main) supersedes
the historical partial-build results below.

## Implemented changes

The kernel now records backing notifications separately from current
readiness, consumes edge candidates, disables one-shot interests, and rearms
on MOD. It reports requested read-half-close and normal-event aliases,
preserves unconditional errors/hangups, rotates bounded batches, validates
nested graphs and exclusive flags, and rejects unpollable objects.

Registrations retain the original open-file-description identity without
owning its lifetime. Delivery can resolve an owner in another process or a
supported backing retained in transit. Parked waits separately pin their
epoll description and have exact tokens for cancellation across close,
descriptor reuse, exec, and late worker retirement. Shared pipe-backed stream
shutdown now changes the connection half observed by inherited descriptors.

Both hosts use the same yielding wait scheduler. Built-in transport counters
record asynchronous notifications independently of current readiness.
Adapters without this history fail edge/exclusive waits with EOPNOTSUPP.
The event record remains 16 bytes with 64-bit data at offset eight on both
guest targets. DEL ignores its event pointer. ABI 51 includes the semantic
change, new wait-token exports, required network-history import, generated
constants, and the scheduled promotion of existing cursor exports.

## Validation procedure

All build/test commands below run through `scripts/dev-shell.sh`; `run.sh`
enters that environment itself. Long commands use `scripts/agent-job`.
Raw logs are retained in this workspace's gitignored `.context/` directory.

| Check | Command / scope | Result |
|---|---|---|
| Rust workspace | `cargo test --workspace --exclude xtask --target "$(rustc -vV \| awk '/^host/ {print $2}')"` | 2,930 passed; `.context/epoll-rust-final4.log` |
| Isolated kernel | `./run.sh build kernel` | Passed through normal SourceOnly publication, job `run.sh-build-kernel-1020-194536-d606` |
| ABI | `bash scripts/check-abi-version.sh` | Passed: snapshot, generated bindings and version bump consistent; `.context/epoll-abi-final4.log` |
| Host build | `cd host && npm run build` | Passed, including declaration generation |
| Focused host source | Vitest: network-readiness-generation, virtual-network, remote-session-network, readiness-deadline, kernel-scratch-transfer-boundaries, generated-abi, host-adapter-manifest | 7 files, 240 tests passed; `.context/epoll-host-source-final.log` |
| Guest Node | Vitest: epoll-semantics, timerfd-signalfd-scratch, abi-version | 8 tests passed across both guest widths; `.context/epoll-guest-node-final.log` |
| Chromium / Firefox / WebKit guests | `npx playwright test test/epoll-semantics.spec.ts --project=chromium --project=firefox --project=webkit --workers=1` | All six cases passed, including the final simultaneous catcher/ready-batch regression; `.context/epoll-browser-last.log` |
| Browser memory boundary | `node --import tsx/esm --test test/browser-memory-boundary.test.ts` from browser app | 7 tests passed; `.context/epoll-memory-boundary.log` |
| Source memory/lifecycle gate | `cd host && npx vitest run --config vitest.browser-memory.config.ts` | 14 files, 162 tests passed; `.context/epoll-memory-source-final.log` |
| Remote TCP history | `cd host && npx vitest run test/remote-tcp.test.ts` | 16 passed, including link admission disappearing/reappearing between observations; `.context/epoll-remote-tcp-final.log` |
| Final wait/signal regressions | Vitest: select-signal-outcome, epoll-semantics, kernel-scratch-transfer-boundaries | 185 passed; `.context/epoll-host-last.log`; includes exited-task ordering and preserving a ready one-shot batch when a catcher also runs |
| Resolver bundle | Regenerated using `scripts/build-resolve-binary-bundle.sh`, then `scripts/test-resolve-binary-bundle.sh` | Passed; required because the standalone shell resolver embeds ABI constants |
| xtask | `cargo test -p xtask --target <host-target>` | 716 passed, 1 failed: `vfs_image_describe::corpus_tests::the_corpus_deferred_sets_are_read`; `.context/epoll-xtask2.log` |
| Browser assets | `bash scripts/ci-check-browser-assets.sh` | Failed: 154 product imports unavailable in the partial build; the memory64 fixture and Pages-size subchecks passed; `.context/epoll-browser-assets2.log` |

The 2026-10-20 iteration's published kernel SHA-256 is
`d532acf5bc9741a6b7ec445c296ebe6b502dd4b0e2ad6deb00d5cb0e8df6e55a`.
That iteration's guest SHA-256 values are
`d4f47996ce7582ac88eb5cb6e9ffc3beb23d4050238533239377d8a867de4876`
(wasm32) and
`9abf5f1c63ae7d62585bc38709df569d796a486bf554818c9d4309e275de437a`
(wasm64).

The existing `programs/blocked-syscall-signal-death.c` probe was also built
in isolation with `wasm32posix-cc`, fork-instrumented, and stamped using
`xtask stamp-abi-contract`. Running it through `runCentralizedProgram` with
an empty image returned exit 0, `PASS`, empty stderr and no host diagnostics.
The final log is `.context/epoll-signal-run-final.log`. Its first run exposed
an exited-task dequeue error in epoll/pselect completion. Both wait paths
now settle authoritative signal death before querying that exited task,
with explicit host regressions added for the ordering.

The xtask failure is a corpus prerequisite: the partial local image inventory
contains no deferred entries. The test requires at least one such shipped
image. Its assertion remains enabled. The initially outdated multiplexing
metadata expectation was updated for the newly generated event constants
and passed in the second full xtask run.

The guest probe uses normal SDK/libc/channel marshalling and production
dedicated workers. It checks notification arrivals while still readable,
drain/refill between waits, stale candidate rechecks, ADD/MOD, one-shot,
fairness, duplicate lifetime, nested epoll, socket RDHUP/OOB, zero-byte
datagrams, pthread waiters and registration, empty-set timeouts, EINTR and
signal-mask restoration, signalfd, timerfd, PTYs, CLOEXEC and exec. The wasm32
case also exercises fork with the watched target retained only by a child;
the wasm64 case does not claim fork instrumentation support. Seventeen new
kernel regressions include sibling ownership, exclusive selection, stable
parked descriptions, final cleanup, and late cancellation tokens.

Browser probes explicitly select an empty image, matching Node's
`useDefaultRootfs: false`, and install the exec-self executable using the
normal image writer. The shared test runner now accepts an explicit
`seedEtc: false`; its normal rootfs seeding default is unchanged. No default
rootfs, application output, socket, or epoll result is simulated.

## Deferred or unavailable evidence

The user instructed us to hold the entire app build while other builds run,
and allowed isolated testing builds. The initial full setup was stopped;
subsequent builds are confined to kernel, host, SDK guest fixtures and tests.

The following conformance commands were attempted after the isolated kernel
was ready:

```sh
bash scripts/run-libc-tests.sh functional
bash scripts/run-libc-tests.sh regression
bash scripts/run-posix-tests.sh sigprocmask sigsuspend sigpending sigtimedwait sigwaitinfo
bash scripts/run-sortix-tests.sh io signal process
```

The runners require canonical rootfs and/or optional program closures that
the partial build has not produced. They fail in artifact preparation before
providing usable guest semantic evidence. The second attempts were stopped
with SIGTERM (143) after confirming that prerequisite failure. The regression
half of the sequential libc command did not run. The full libc, POSIX and
Sortix inventories remain unrun. Existing dirty Sortix source files were
preserved.

The full browser asset check failed artifact preparation as recorded above.
Full host/browser suites, the repeated application memory-switch gate,
native Safari follow-up, and Node/browser benchmark suites remain unrun.
No performance claim is made. Playwright WebKit results are not native
Safari evidence. A resolver-dependent poll-timeout test was skipped because
its program package is missing; it is not counted as passing guest evidence.

At that checkpoint no native Linux reference probe was executed: the local Docker client had no
running daemon. Ambiguous notification and exclusive/depth details were
checked against Linux's primary `fs/pipe.c` and `fs/eventpoll.c` sources,
linked from the matrix. This source review is distinct from executing a
Linux comparison.

## mio conclusion and remaining limits

The EPOLLET, EPOLLRDHUP, rearm and fd-lifetime combinations used by mio
0.7.6 are exercised by the guest/kernel probes. The syscall evidence supports
using those operations on the tested transports and pollable objects.
An actual Rust mio integration was not run, so mio integration remains an
inference, not a measured result. termchat and its dependencies were not
changed.

This work does not repair existing process-local datagram queues, mutable
socket state, or KMS sidecars/event rings across fork. These are applicable
platform gaps, not inherent browser limitations. Cross-process socket
transfer remains unsupported. Custom network adapters need notification counters for
edge/exclusive waits. Linux suspend/capability/quota controls, epoll busy-poll
ioctls and epoll_pwait2 are not exposed. These limits and the deferred
validation prevent a claim of complete Linux compatibility.

## 2026-10-21 resumed validation

The user authorized resuming the full build. Job
`run.sh-setup-1021-075520-f306` runs `./run.sh setup` through the normal
bootstrap graph. The following results supersede the corresponding deferred
statuses above as each resumed check finishes.

An isolated Rust probe pinned mio to exactly 0.7.6 with `os-poll`, `os-ext`
and `net`. It used the SDK's private Rust sysroot and existing Kandelo libc
fork, then invoked `wasm32posix-cargo build --release`. The Rust sysroot
built, but unmodified mio failed to compile: its platform gates exclude
Kandelo's selector, waker, Unix pipe and TCP paths (four compiler errors).
This is a dependency target-selection boundary before runtime, not evidence
of an epoll syscall failure. No mio code, application dependency, or SDK
target identity was changed. The build log is
`.context/epoll-20261021-mio-build.log`; job
`epoll-check-20261021.sh-mio-build-bash-1021-080117-56b3` exited 101.

A pristine Sortix source checkout was prepared on the case-sensitive volume
at `/Volumes/KandeloCaseBuild/montevideo-epoll-os-test`, pinned to the
repository's submodule commit
`7e8f0082ab0b58ad3383a8abbf47dc4b40dcf25d`. The original dirty submodule is
untouched.

Docker Desktop was then started. A native reference probe passed on
Linux `7.0.12-linuxkit`, aarch64, using `gcc:14-bookworm` with image digest
`sha256:5e927c284bf55a7dc796262e311a0703344f62f41f5621eb56843111b1d37e15`.
It confirmed pipe notification after a new write while already readable,
stale-candidate recheck, drain/refill, four accepted nesting edges and ELOOP
on the fifth, exclusive flag combinations, ignored DEL pointers, EPERM for
regular files, and stream peer SHUT_WR returning IN/OUT/RDHUP without
ERR/HUP. The native event record is also 16 bytes on this architecture.
The log is `.context/epoll-20261021-linux-reference2.log`. The first pull
attempt failed because the declared dev shell excludes Docker's credential
helper; the passing run used an isolated empty client config and the
existing daemon socket. A redundant cached-image attempt compiled but
could not execute from its noexec temporary mount; it is not passing
reference evidence.

The full guest source was also compiled natively. Its first run exposed a
test assumption after consuming AF_UNIX urgent data: Linux still reports
IN/OUT because the receive queue retains an empty record. A dedicated
native probe confirmed PRI for urgent data and mask `0x5` after consuming
it; log `.context/epoll-20261021-linux-oob.log`. Separating that case from
the half-close socket pair avoids assuming the internal queue representation.

The comparison also exposed a signal-ordering mismatch in Kandelo: Linux
returns an already-ready one-shot event and restores the original blocked
mask, leaving a signal pending that the temporary wait mask would unblock.
The next empty blocking pwait can then deliver it with EINTR. The native
diagnostic showed return 1, the original event data, and the handler count
unchanged. The native guest probe passed after adopting these expectations;
log `.context/epoll-20261021-linux-guest4.log`. Only the raw legacy
SYS_epoll_create assertion was conditionalized because Linux aarch64 does
not expose that syscall; the Kandelo targets do expose it and retain that
assertion. The matching kernel correction and final reruns are pending
completion of the active setup job, so its build inputs remain stable.

An additional isolated SDK/fork-instrumented guest checked that default
ignored SIGCHLD from a child exit does not interrupt an empty timed wait.
Both native Linux and the current Kandelo Node host returned zero after
the timeout (210 ms and 203 ms respectively for a 200 ms wait), with the
child reaped, guest exit zero, empty stderr and no host diagnostics.
The log is `.context/epoll-20261021-default-signal.log`. This is distinct
from the pending ready-event/temporary-mask correction above.

A direct Rust libc probe compiled with the same private SDK Rust sysroot
and existing libc fork, then ran on the Node host with an empty image.
It passed event record size 16 / payload offset eight, full 64-bit data,
eventfd notification while still readable, one-shot disablement and MOD
rearm, and stream RDHUP with IN/OUT and no fabricated HUP. The SDK Rust
libc fork retains Linux's raw `SYS_epoll_pwait2 = 441` even though Kandelo
does not implement it; the probe confirmed ENOSYS. The guest exited zero,
printed `RUST_EPOLL_LIBC_PASS`, and had empty stderr and no host diagnostics.
The log is `.context/epoll-20261021-rust-libc.log`. This is wasm32 Node
evidence, not a mio runtime or Rust browser integration result. The normal
C guest remains the two-width, three-browser probe.

A separate detached baseline checkout records destination commit
`88b119483fbf93f9f8ea41b0773da09f40223f22` (the compiler and JavaScript
test-tool update). Its own root, host and browser dependencies were
installed from their lockfiles. Targeted normal provisioning then built its
own SDKs, host, kernel, rootfs, WordPress closure, MariaDB programs/images
for both widths, and developer/benchmark fixtures. Job
`epoll-baseline-build.sh-1021-085230-42e2` passed after 29m33s. An earlier
invocation stopped because the wrapper supplied a relative output root;
the corrected invocation uses the required absolute root. No baseline
runtime or performance result has been obtained yet.

The candidate's full setup job `run.sh-setup-1021-075520-f306` subsequently
passed after 2h16m: all 186 nodes, SourceOnly publication, canonical rootfs,
and the host build including declarations. This was before applying the
final temporary-mask correction found by the native comparison.

Two new kernel mask regressions first failed against that code (original
blocked mask lost on ready/zero-timeout and early validation returns).
After the correction both passed. Logs:
`.context/epoll-20261021-mask-red.log` and
`.context/epoll-20261021-mask-green.log`. The completion path now restores
the mask for every completed result except EINTR; internal EAGAIN keeps
the parked wait's context. Validation and allocation errors share that
cleanup, including host-preinstalled scopes.

The updated repository C source then passed directly on native Linux,
without a temporary source adaptation. It includes invalid output pointer
and epoll descriptor errors with a pending temporarily unblocked signal,
the following ready one-shot result, retained pending signal, and subsequent
EINTR. Log: `.context/epoll-20261021-linux-guest-final2.log`. An initial
retry could not connect because Docker's daemon had stopped; it was restarted.

The final mask correction passed the full Rust workspace: 2,932 passed,
zero failed/ignored (`.context/epoll-20261021-rust-full.log`). The host
signal file passed all eight tests after its new output-range regression
first failed (`host-mask-red4` / `host-mask-green` logs). ABI snapshot,
generated headers/bindings, and version bump checks passed
(`.context/epoll-20261021-abi.log`).

Final setup job `run.sh-setup-1021-104342-1a5c` passed after 29m39s with
the corrected code: 186/186 nodes, zero failures, SourceOnly publication,
rootfs and host declarations. The preview had 157 cached nodes and 29
checks/rebuilds; the large compiler artifacts were reused.

The baseline artifact preflight then passed: 80 complete closures, zero
incomplete/failed, and 21 packages outside the selection not built. Its
worktree remains clean. The report is `.context/epoll-baseline-closures.json`
(human-readable output despite the filename).

Native Safari follow-up could not start. On macOS 27.0.1, SafariDriver
27.0.1 repeatedly returned session-creation timeouts while connecting to
Safari. The availability wrapper also failed parsing curl's concatenated
retry responses; no guest ran. Independent native UI access by both app
name and bundle ID returned `cgWindowNotFound`. No native Safari switching
cycles have completed. Log: `.context/epoll-20261021-safari-availability.log`.

The final kernel also passed the isolated Node Rust libc, ignored-default
SIGCHLD timeout, and blocked-syscall signal-death probes again. They exited
zero with clean stderr and no host diagnostics
(`.context/epoll-20261021-isolated-final.log`).

With the full product inventory present, the complete xtask run passed:
717 unit tests and six integration tests, with none ignored or filtered.
This supersedes the earlier deferred-image corpus prerequisite failure.
Command: `cargo test -p xtask --target <host-target>` through the declared
dev shell. Log: `.context/epoll-20261021-xtask-final.log`.

## Final published-kernel suite results

Prerequisite job `epoll-final-prerequisites.sh-1021-111344-0b64` passed
after 29m11s. It built the developer, example, benchmark and test fixtures
through `scripts/build-programs.sh`, prepared WordPress through its normal
setup script, and built `mariadb-vfs` and `mariadb64-vfs` through `run.sh`.
Artifact preflight reported 95 complete closures, zero incomplete/failed,
and six packages not built: erlang, erlang-vfs, perl-vfs, python-vfs,
redis-vfs and texlive, all wasm32. No missing closure was hidden or relaxed.

| Check | Command / scope | Result |
|---|---|---|
| Focused Node | Vitest: epoll-semantics, epoll-pwait-sigmask, timerfd-signalfd-scratch, select-signal-outcome, kernel-scratch-contract | 5 files, 21 passed, zero skipped/failed; `.context/epoll-20261021-node-final.log` |
| libc functional/regression | `bash scripts/ci-run-test-suite.sh libc functional-regression` | 125 total: 121 PASS, 3 XFAIL, 1 FLAKE-PASS, zero FAIL/BUILD/TIMEOUT; `.context/epoll-20261021-libc-final.log` |
| POSIX signal interfaces | `bash scripts/run-posix-tests.sh sigprocmask sigsuspend sigpending sigtimedwait sigwaitinfo` | 33 passed, zero failed/skipped/unresolved/build/timeout; `.context/epoll-20261021-posix-final.log` |

The libc expected failures remain `functional/pthread_cancel`,
`regression/malloc-brk-fail`, and `regression/tls_get_new-dtv`.
`regression/pthread_cond-smasher` passed on the runner's retry and is
reported separately as FLAKE-PASS. No expectation was changed for this run.
The POSIX source tree contains no poll, select or epoll interface tests;
these five interfaces exercise the affected signal-mask and wait contract.

The first broad host run completed 561 files: 546 passed, nine failed, six
fully skipped. Of 5,260 tests, 5,222 passed, 17 failed and 21 skipped, with
zero load failures. Log: `.context/epoll-20261021-host-final.log`.
Six initialization failures came from newly exposed cursor fixture exports
without implementations; selecting each fixture's actual mocked operations
restored all eight initialization tests. Three reference-replay failures
were ABI-50 WAT fixtures. Their reviewed sources now declare ABI 51, and
the checked GC byte fixture was freshly assembled with `wat = 1.247.0`
(the repository lockfile version). Both exception cases and the GC case
passed after that rebuild. Logs: `initialization-green`,
`regenerate-gc-fixture`, and `reference-fixtures-green2` under the same
`.context/epoll-20261021-` prefix.

Seven broad-host failures were reproduced independently of these epoll
changes. The baseline's original lifecycle tests passed 69/69; running a
byte-identical copy of the starting branch's lifecycle expectations against
that unchanged baseline worker reproduced the two failures. Gallery order,
SDL_mixer recipe expectations and fixture-consumer ownership reproduced four
more failures on the baseline. After normal baseline rootfs preparation,
its getgrent test reproduced the seventh (nine expected groups versus ten
actual groups, including `nobody`). Logs: `lifecycle-baseline`,
`source-baseline`, `baseline-rootfs`, and `extra-baseline`. No unrelated
expectation was weakened. The export-contract failure caught four missing
names in both build/startup guard lists; those lists now match ABI 51.
The broad CI command stopped before resource-isolated/Bun execution because
its main run failed; later checks must not imply that command was green.

The default browser asset inventory and browser CI precheck each failed on
the intentionally deferred legacy Erlang image; Playwright did not start
in that CI attempt. Explicit SourceOnly bindings, matching normal
`run.sh prepare-browser`, resolved all 140 production imports and passed
Pages-size and all nine memory64 fixture checks. Logs: `browser-assets-final`,
`browser-final`, and `browser-assets-sourceonly`. The inventory policy and
legacy failure remain visible rather than being rewritten as success.

The focused browser epoll run passed all six production-worker cases:
wasm32/wasm64 in Chromium, Firefox and WebKit (`browser-epoll-final`). The
full memory gate also passed: seven initial boundary checks, 14 host files /
162 tests, three teardown tests on Node and again on Bun, and nine browser
cases with zero skips. Each engine completed four Doom → Quake → WordPress
cycles in one persistent page with trusted audio activation. Log:
`browser-memory-final`. These runs preceded the socket-mask additions below.

A final native cross-check exposed socket masks inherited from poll:
local write shutdown could suppress all events, and full Unix shutdown
omitted requested writable bits. Native Linux 7.0.12-linuxkit/aarch64
produced 25 exact masks covering both local/peer shutdown, close, Unix
stream/datagram pairs, loopback TCP pairs and unconnected sockets. Logs:
`linux-close`, `linux-close2`, and `linux-close3`. The isolated SDK guest and
two kernel regressions first failed; the new epoll socket mapping now
matches the tested Linux masks, including protocol-specific WRBAND.

A write-band-only backpressure regression then failed on datagram dequeue.
Capacity notifications now include WRBAND, and the receiver's last OFD owner
notifies waiting senders. The regression passed for stream and datagram
drain/final-close paths, while a surviving receiver alias kept the queue
alive. Logs: `band-kernel-red` / `band-kernel-green`. The expanded repository
C guest passed directly on Linux, including the new TCP and write-band
cases (`native-expanded-final`). The complete Rust workspace then passed
2,935 tests, zero failed/ignored (`rust-expanded-final`). The new epoll test
file now contains 22 regressions. Final published-kernel checks follow.

## Current-tree publication and verification

The socket-mask and write-band fixes were published through `./run.sh setup`,
job `run.sh-setup-1021-133303-ebf9`: 186/186 nodes completed, zero failed or
blocked, in 15m28s. The standalone MariaDB images for both widths were then
refreshed through their normal recipes. Artifact preflight again reported
95 complete closures, zero incomplete/failed, and six unbuilt packages.
Production inputs were held fixed throughout the following checks.

| Check | Current-tree result | Log under `.context/` |
|---|---|---|
| Rust workspace | 2,935 passed, zero failed/ignored | `epoll-20261021-rust-expanded-final.log` |
| ABI | Snapshot, generated C/TypeScript bindings and ABI 50 → 51 consistency passed | `epoll-20261021-abi-expanded-final.log` |
| Native Linux C guest | Passed, including all 25 exact socket masks and write-band lifetime cases | `epoll-20261021-native-expanded-final.log` |
| SDK guest / Linux comparison | All 25 printed socket masks matched; exit 0, clean stderr and diagnostics | `epoll-20261021-close-guest-green.log` |
| Rust libc and signal probes | Node wasm32 Rust libc, ignored-default-SIGCHLD timeout and blocked-syscall signal death passed | `epoll-20261021-isolated-published.log` |
| Focused Node | 11 files, 50 tests passed; zero failed/skipped | `epoll-20261021-node-published.log` |
| libc functional/regression | 125 total: 121 PASS, 3 XFAIL, 1 FLAKE-PASS; zero unexpected/build/timeout failures | `epoll-20261021-libc-published.log` |
| POSIX signal interfaces | 33 passed; zero failed/skipped/unresolved/build/timeout | `epoll-20261021-posix-published.log` |
| Sortix runtime | 431 total: 416 PASS, 13 XFAIL, 2 SKIP; zero failed/build/timeout | `epoll-20261021-sortix-published.log` |
| Resource-isolated host | All three declared Ruby spawn cases passed, each in a fresh process | `epoll-20261021-resource-published.log` |
| Focused browser epoll | Six passed: wasm32 and wasm64 on Chromium, Firefox and WebKit; zero skips | `epoll-20261021-browser-epoll-published.log` |

The focused Node selection includes both guest widths, pwait mask handling,
timerfd/signalfd scratch transfer, select signal outcomes, scratch contracts,
the complete required-export contract, initialization lifetime, rebuilt
exception/GC reference fixtures, notification counters and remote TCP.
Both initialization fixture repairs and all four export-guard additions are
therefore covered in the same published-kernel run.

The full SourceOnly browser CI attempt passed production asset preparation,
then timed out at its 20-minute Chromium limit (exit 124). It encountered
Freeciv cursor/pointer assertions; retained traces are under
`.context/epoll-browser-failures/`. The timeout left its Vite server running
on port 5417. Consequently the subsequent cross-engine contracts and the
browser portion of the memory gate could not acquire their server port.
The memory gate's source, host and Node/Bun phases completed, but this is
not a passing complete memory-gate result. Those checks require rerunning.

At the user's request, `git fetch origin main` found new main commit
`89ed8af01e0b9f7fe438f66a963d7d8cd44f0a65`. It includes graphics follow-up
`11f804452872d4723d75a71e58b47414ac730eb1` (#1551), whose source and validation
record address shared cursor-buffer publication, display/terminal handoff
and these Freeciv tests. That record reports all 36 Chromium Freeciv cases
passing at both densities. This is the upstream change's recorded evidence,
not a combined-tree test result from this workspace.

The queued old-baseline Freeciv comparison and old-tree full host/xtask
rerun were stopped with SIGTERM before their test results were collected
(jobs `epoll-ui-queue.sh-1021-143219-baf2` and
`epoll-post-queue.sh-1021-135554-cb13`, exit 143). The orphan Vite server was
also stopped. The epoll changes are being carried onto current main, and
combined-tree validation will supersede the results above.

## Integration with current main

The reported Freeciv pointer-capture failure is resolved by main's
`11f804452872d4723d75a71e58b47414ac730eb1` (PR #1551, shared graphics buffers
and terminal handoff). This is confirmed on the combined tree by the eight
previously failing graphics cases at both densities and the 12 imported-cursor
cases across three engines below. No additional Freeciv fix was made here.

The current branch was fast-forwarded to
`89ed8af01e0b9f7fe438f66a963d7d8cd44f0a65` without renaming it. The complete
epoll patch reapplied without conflicts; its tracked diff statistics against
the new base are unchanged. A safety stash and binary patch are retained
locally. The unrelated dirty Sortix submodule and `.serena/` are preserved.
The separate benchmark baseline was also advanced to that exact main commit
and remains clean. Both sides must rebuild their own ABI-matched products.

Main's updated validation guidance includes Freeciv and LÖVE in the
four-cycle browser memory sequence. It also requires an explicit user
request for native desktop testing; no new native Safari run is requested
for this integration. Earlier native availability attempts above are
historical and are not combined-tree evidence.

Normal combined-tree setup passed in job
`run.sh-setup-1021-152152-7a11`: 187/187 nodes, zero failed/blocked,
26m26s including final publication and host declarations. Locked dependencies
for host, browser app and image tooling were installed with `npm ci` through
the declared dev shell. No production input changed during the build.

The current-main baseline refresh also passed, job
`epoll-baseline-build.sh-1021-152237-f15e`, in 33m45s. It used its own
ABI-50 SDKs, kernel, host, rootfs, WordPress, benchmark fixtures and both
standalone MariaDB images. It shares the normal source cache with the
candidate, while keeping runtime artifacts in its separate clean worktree.

Combined-tree preparation refreshed both standalone database images and
reported 95 complete artifact closures, zero incomplete/failed, and six
unbuilt packages. Results below use the frozen ABI-51 candidate on current
main; they supersede pre-integration results for the same check.

| Check | Combined-tree result | Log under `.context/` |
|---|---|---|
| Rust workspace | 2,936 passed across 44 test/doc binaries; zero failed/ignored | `epoll-20261021-rust-combined.log` |
| ABI | Snapshot, generated headers/bindings and ABI 50 → 51 consistency passed | `epoll-20261021-abi-combined.log` |
| Native socket-mask comparison | All 25 SDK guest masks matched the recorded Linux probe | `epoll-20261021-close-combined.log` |
| Rust libc and signal probes | All passed with clean stderr and host diagnostics | `epoll-20261021-isolated-combined.log` |
| Focused Node | 11 files, 50 tests passed; zero failed/skipped | `epoll-20261021-node-combined.log` |
| Freeciv graphics follow-up | Eight passed in 3m: prior four failure types at both display densities; zero skips/retries | `epoll-20261021-freeciv-fresh.log` |
| Imported cursor browser cases | 12 passed across Chromium, Firefox and WebKit; zero skips | `epoll-20261021-cursor-fresh.log` |
| Guest epoll browser cases | Six passed: wasm32 and wasm64 on all three engines; zero skips | `epoll-20261021-browser-epoll-fresh.log` |
| libc functional/regression | 125 total: 121 PASS, 3 XFAIL, 1 FLAKE-PASS; zero unexpected/build/timeout failures | `epoll-20261021-libc-combined.log` |
| POSIX signal interfaces | All 33 passed; zero failed/skipped/unresolved/build/timeout | `epoll-20261021-posix-combined.log` |
| Sortix runtime, 18 workers | 195 PASS, 2 XFAIL, 2 SKIP, 221 TIMEOUT and 11 timeout-based XFAIL mismatches; run failed | `epoll-20261021-sortix-combined.log` |
| Sortix runtime, four workers | 431 total: 416 PASS, 13 XFAIL, 2 SKIP; zero FAIL/XPASS/BUILD/TIMEOUT | `epoll-20261021-sortix-low-concurrency.log` |
| Isolated timed-out limit guest | The unchanged `_POSIX2_BC_BASE_MAX.wasm` passed alone through the normal Node CLI with the same 35-second outer timeout | `epoll-20261021-sortix-limit-isolated.log` |
| Full xtask | 717 unit and six integration tests passed; zero failed/ignored | `epoll-20261021-xtask-combined.log` |
| Resource-isolated host | All three declared Ruby spawn cases passed, each in a fresh process | `epoll-20261021-resource-combined.log` |
| Cross-engine browser contracts | All 78 passed in 50.2s across Chromium, Firefox and WebKit; zero skips | `epoll-20261021-browser-contracts-combined.log` |

Every unexpected Sortix result in that run was a timeout; the 11 failures
were expected output failures that timed out instead. A contemporaneous
machine snapshot showed multiple heavy builds and substantial filesystem
event activity (`.context/epoll-sortix-contention.txt`). This and the
isolated pass suggested contention. The complete four-worker runtime rerun
then passed with the same 431-case inventory, expectations and timeout
budgets: 416 PASS, 13 XFAIL, two SKIP and zero unexpected/build/timeout
failures. No production code changed between these runs. The original
failed result remains recorded separately.

The first combined browser attempts were invalid: port 5419 belonged to
another workspace. CI-mode Freeciv/cursor runs rejected the occupied server
before executing cases; the non-CI epoll invocation reused that foreign
server. Its outcomes are not candidate evidence. Job
`epoll-combined-queue.sh-1021-152202-dd37` was stopped with SIGTERM (143)
after collecting the passing checks above. The peer server was untouched.
Remaining checks resume with a fresh available port per invocation,
explicit SourceOnly selection and CI mode to disable server reuse.

The full host run completed all 563 files with zero load failures:
538 passed, 19 failed, six fully skipped. Of 5,275 tests, 5,218 passed,
36 failed and 21 skipped (33m33.88s). Its machine-load report recorded
118.5 at start and 84.7 at end on 18 CPUs, with other agent jobs using
substantial CPU. Local CI was unset, so the normal configuration used four
workers. Log: `.context/epoll-20261021-host-combined.log`.

The 36 failures comprise 25 explicit timeouts, two real-time audio-budget
failures, seven source/catalog assertion mismatches and two compositor
observation mismatches. The static scratch audit passed earlier in the
same frozen tree in 116.6s, but exceeded its 180s budget in this run and
finished after 435s. No test timeout or expectation has been relaxed.

All seven source/catalog mismatches were independently reproduced using
the clean ABI-50 baseline at the same `89ed8af01e` main commit, with CI mode
and the seven exact test names selected. Six files loaded; all seven selected
cases failed identically, with 76 non-target cases filtered out. The baseline
remains clean. Log: `.context/epoll-20261021-main-source-baseline.log`, job
`npx-vitest-run-1021-174040-1fd0`. They concern stb-source's missing build
sidecar, fixture consumer ownership, two SDL_mixer recipe assertions, the
LÖVE dock description, gallery order and group enumeration. These are not
epoll regressions, and their assertions remain unchanged.

All 216 tests in the 13 affected files passed on a subsequent CI-mode
one-worker run, including the 29 previously failing cases and both
compositor observations. No assertion, real-time limit or timeout changed.
The scratch audit passed in 177.7s. Log:
`.context/epoll-20261021-host-target-single-worker.log`, job
`epoll-host-target-recheck.sh-1021-174515-a0ad`, 7m40.76s. These scoped
results supplement the failed full run; they do not turn that run into a
passing CI command. The seven baseline-reproduced assertions remain red.

The queue shell was held at the completed host-run boundary while these
comparisons ran, then resumed as system load fell to roughly 17 on 18 CPUs.
Remaining browser and resource phases continue with fresh servers. Benchmarks
still require a quieter measurement window.

The SourceOnly Chromium CI invocation selected 325 cases but reached the
unchanged 20-minute outer limit (exit 124); its inventory did not finish.
The dot reporter emitted 84 pass marks, one skip and one failure before
termination. These are partial progress, not a completed suite result.
The preserved failure was `ffplay runs as a Wayland client in the Omarchy
desktop`: its initial 240-second wait for `BAR_WORKSPACE active=1` expired
before ffplay was launched. The visible terminal ended at `WLC_RENDERER gpu`.
Its trace, screenshot and error context are retained under
`.context/epoll-browser-combined-failures/`. An exact clean-main/candidate
comparison subsequently reproduced the same initial 240-second workspace
assertion failure on both sides, using each side's own ABI-matched products,
fresh servers and unchanged assertions/timeouts. Both terminal captures ended
at `COMPOSITOR_UP w=1920 h=1080` and `FLIP fb=1 first=1`, without the workspace
line. Thus this startup failure is also present on clean main; its root cause
was not investigated as part of the epoll change. Logs are
`.context/epoll-20261021-omarchy-ffplay-{baseline,candidate}.log`; traces and
screenshots are preserved in `.context/epoll-omarchy-{baseline,candidate}-results/`.
The baseline remains clean. The separate cross-engine contract and complete
memory gates both passed.

The combined memory gate passed seven source-boundary checks, all 162
host ownership/teardown tests in 14 files (172.89s), and all three lifecycle
tests in two files on each of Node (35.93s) and Bun (25.76s). All of these
phases reported zero failed or skipped tests. All nine browser cases passed
in 12.6m with zero skips, retries or unexpected outcomes. Four Doom → Quake
→ Freeciv → LÖVE → WordPress cycles passed in each engine's persistent page:
Chromium 3.1m, Firefox 6.0m and WebKit 3.3m. This is 60 app launches across
the three persistent pages, with the exit-trap/probe checks also passing.
The complete memory gate exited zero. Native Safari was not requested or
run. Log: `.context/epoll-20261021-browser-memory-combined.log`.

The tested artifact hashes are recorded with resolved paths, sizes, source
hashes, both ABI versions and base commit in
`.context/epoll-final-artifacts.json`:

| Candidate artifact | SHA-256 |
|---|---|
| Published kernel | `4ad4f5914a158c7c6544015870c3d3f3d8cc2ccabee1b760a4258f62407f16bd` |
| wasm32 epoll guest | `45e797fc0bc813f83958120e8b1e5bd8a4cc052aeff03615187c1d40fc7e894f` |
| wasm64 epoll guest | `8c27646217a391b14cc159861bc8c86d8120b5af4f550d51d0e50504e2e79664` |

## Final performance validation — 2026-10-22

No production source changed after the recorded main integration. After the
heavy peer jobs ended, all nine runnable suites completed on Node and Chromium
on both revisions, three rounds each, in job
`epoll-final-benchmarks.sh-1022-162707-0364` (9m13s, exit zero). The harness
verified nine nonempty suites with finite metrics in all four results. The
Erlang suite remains disabled by the existing harness.

The baseline is the clean recorded main commit `89ed8af01e`, ABI 50; the
candidate is that commit plus this epoll patch, ABI 51. Each used its own SDK,
kernel, host and ABI-matched programs/images. Both Node and browser metadata
confirm baseline kernel SHA-256
`80657c687f68a0441b5b726176e7fa8b6af92bf5a8e994d33e2cbed106fa8635`
and the candidate kernel hash listed above. Complete artifact hashes and
selected paths are embedded in the four result JSON files.

Order was baseline Node, candidate Node, baseline browser, candidate browser.
Phase-start load averages were 2.61, 4.30, 4.95 and 3.09 on 18 CPUs; the
activity snapshots showed no competing active agent jobs. They retain process
and job inventories. Each three-round host run shares one Node or Chromium
parent process; these are not independent parent-process replicates. The
first and repeated spawn metrics remain separate.

Full original results are `.context/epoll-benchmark-{baseline,candidate}-
{node,browser}.json`; comparison tables are
`.context/epoll-benchmark-compare-{node,browser}.md`. Their filenames and
logs retain the earlier validation prefix, but timestamps identify this
October 22 measurement.

The initial comparison flagged seven slowdown metrics above 5%. A separate
candidate-then-baseline recheck retained the same suite workloads and three
rounds, in fresh parent processes per selected suite. All ten scoped runs
passed in job `epoll-benchmark-recheck.sh-1022-163752-f6b3` (3m36s). Original
results were preserved. None of those seven flags exceeded 5% in the
reverse-order check:

| Host / metric | Initial baseline → candidate | Initial change | Reverse-order baseline → candidate | Recheck change |
|---|---|---|---|---|
| node / syscall-io/epoll_ready_us_per_op | 21.98 → 26.15 | +19.0% | 25.49 → 23.13 | -9.3% |
| node / mariadb-aria-64/query_select_ms | 104.44 → 112.66 | +7.9% | 111.55 → 114.27 | +2.4% |
| node / mariadb-innodb/query_join_ms | 88.97 → 93.59 | +5.2% | 92.58 → 91.15 | -1.5% |
| browser / syscall-io/pipe_mbps | 62.50 → 58.82 | -5.9% | 58.82 → 58.82 | +0.0% |
| browser / mariadb-innodb-64/query_create_ms | 22.63 → 25.55 | +12.9% | 22.52 → 20.60 | -8.5% |
| browser / mariadb-innodb-64/query_insert_ms | 122.92 → 135.35 | +10.1% | 117.93 → 115.04 | -2.5% |
| browser / mariadb-innodb-64/query_join_ms | 1.78 → 2.39 | +34.3% | 1.80 → 1.86 | +3.3% |

The pipe metric is throughput (MB/s, higher is better); other rows are
latencies in the metric name's units. Recheck JSON and stdout are retained as
`.context/epoll-benchmark-recheck-*`, with the seven comparisons in
`.context/epoll-benchmark-flag-rechecks.json`. These results vary between runs
and do not establish a broad performance improvement or no-regression claim.

The separate clock-only diagnostic measured minimum positive `performance.now()`
steps of about 0.000041 ms on Node 24.15.0 and 0.005 ms on cross-origin-isolated
Chromium 153.0.8010.12. It ran no guest workload. This is distinct from the
browser guest `gettimeofday()` clock, whose millisecond granularity limits
short guest measurements. Three repeated rounds do not remove that
quantization. See `.context/epoll-benchmark-clock.json` and the existing
[profiling guidance](../profiling.md). No causal attribution to GC or an
individual kernel phase is made; no CPU/allocation profile was collected.

## Final validation scope

The implementation and required measured comparisons are complete for this
recorded tree. The full host command remains red because of the seven
baseline-reproduced source/catalog assertions. The broad Chromium CI run
remains incomplete after its 20-minute timeout; its Omarchy startup assertion
was reproduced on both revisions. Passing focused checks and the complete
memory gate do not turn either broad command into a pass.

Libc math, the remaining Open POSIX interfaces, and Sortix include/basic
were considered but not run for this epoll change. Native Safari was not
requested. Unmodified mio runtime integration remains blocked by its Kandelo
platform gates; only the documented guest syscall and Rust libc probes ran.
External network ET behavior is inferred from transport-history tests plus
local guest network coverage, not a separate external-backend guest proof.
Forked datagram queues and KMS event-sidecar sharing remain applicable
platform gaps. See [the epoll matrix](../epoll.md) for the full limitations.

## Libevent integration — 2026-10-22

After the preceding epoll validation, the user authorized a libevent port
to demonstrate a real consumer of the completed semantics. New registry
packages provide the libevent 2.1.12 static libraries and its unchanged
upstream regression executable for wasm32 and wasm64. See
[the libevent reference](../libevent.md) for build commands and supported
outputs. No upstream source patch or Linux identity define was needed.

The wasm64 build exposed an existing shared-instrumenter defect: the
`wpk_fork_resume_thread` lexical call supplied i32 to a table64 index. The
fix widens the unsigned index according to the original table, independent
of memory width. Its public signature and frame format are unchanged;
previously valid artifacts remain valid, so no additional ABI bump is
needed beyond epoll's ABI 51. A new regression first failed validation
before the fix and then passed for all four memory/table width pairs.

The baseline is the recorded main commit `89ed8af01e0b9f7fe438f66a963d7d8cd44f0a65`,
ABI 50, in `.context/epoll-baseline-20261021`. For this new comparison it
has a controlled overlay: the new recipes with ABI floors set to 50, the
same instrumenter fix, and identical test harness files. Kernel, libc,
SDK, and production host runtime sources remain at that commit. Each
side built its own libraries, guest artifacts, and kernel through the
normal SourceOnly resolver. Neither side borrowed the other's ABI
artifacts. The prior clean-baseline benchmark and failure results above
precede this overlay and remain separate historical evidence.

At the end of this work `origin/main` pointed at `f602474ed4eb1f2d43befeda57e4562592ac901b`;
the libevent runtime comparison is against the explicitly pinned older
main commit, not a claim about running that newer tree.

Each runner first requires `EV_FEATURE_ET | EV_FEATURE_EARLY_CLOSE` and
verifies the requested backend: `epoll` or `epoll (with changelist)`.
It then executes the exact three upstream `et/` cases and nine
`main/simpleclose` cases, including normal upstream fork isolation.

| Host | Architectures × epoll modes | Recorded main per configuration | Candidate per configuration |
|---|---|---|---|
| Node 24.15.0 | 2 × 2 | 2 PASS, 10 FAIL, 0 SKIP | 12 PASS, 0 SKIP |
| Chromium | 2 × 2 | 2 PASS, 10 FAIL, 0 SKIP | 12 PASS, 0 SKIP |
| Firefox | 2 × 2 | 2 PASS, 10 FAIL, 0 SKIP | 12 PASS, 0 SKIP |
| WebKit | 2 × 2 | 2 PASS, 10 FAIL, 0 SKIP | 12 PASS, 0 SKIP |

The candidate completes **192 upstream case executions**. Main's
`et/et` and `et/et_multiple_events` callbacks fire twice instead of once;
all eight EV_CLOSED close/shutdown variants fail. Both revisions pass
`main/simpleclose_rw` and `et/et_mix_error`. Thus this demonstrates
observable upstream correctness improvements, not merely successful
linking or a backend feature flag. Candidate checks also require clean
guest stderr, host diagnostics, and browser page errors.

Final local jobs and preserved logs:

- Candidate minimal projection: `cargo-xtask-local-build-1022-185038-4b09`,
  exit 0; baseline: `cargo-xtask-local-build-1022-185046-370a`, exit 0.
  Both select `kernel`, `libevent-tests`, and `libevent-tests64` from
  `packages/sets/local-supported.toml` with the shared default source cache.
  Logs: `.context/libevent-{candidate,baseline}-build.log`.
- Candidate Node: `npx-vitest-run-1022-185355-52ee`, exit 0;
  `CI=1 npx vitest run test/libevent.test.ts test/epoll-semantics.test.ts`
  from `host`, with SourceOnly policy and the candidate projection.
  Two files, six runner tests pass, zero skips: four libevent configurations
  plus both existing epoll guests. `.context/libevent-node-candidate.log`.
- Baseline Node: `npx-vitest-run-1022-185204-44c0`, exit 1 as expected;
  the same four libevent runner configurations all reach and report the
  upstream failures. `.context/libevent-node-baseline.log`.
- Candidate browsers: `epoll-fresh-browser.sh-bash--c-1022-185328-35b6`,
  exit 0; `npx playwright test test/libevent.spec.ts
  test/epoll-semantics.spec.ts --workers=1` from `apps/browser-demos`.
  **18 runner tests pass**: 12 libevent configurations and six epoll cases.
  `.context/libevent-browser-candidate.log`.
- Baseline browsers: `epoll-fresh-root-browser.sh-Users-brando-1022-185329-866a`,
  exit 1 as expected; all 12 configurations reach the identical upstream
  10/12 failure summary. `.context/libevent-browser-baseline.log` and
  `.context/libevent-main-browser-failures/` preserve traces and screenshots.
  Both browser commands use fresh servers, explicitly selected SourceOnly
  roots, and all three engines; no external CI service was used.
- `cargo test -p fork-instrument --target aarch64-apple-darwin`:
  **388 pass**, including the new validator regression.
  `.context/libevent-fork-instrument-tests.log`.
- Final `cargo test --workspace --exclude xtask --target aarch64-apple-darwin`:
  **2,937 pass**, zero failures or ignored tests across 44 result summaries
  (37 executable suites plus documentation tests). Job
  `cargo-test---workspace-1022-185505-5adb`, exit 0;
  `.context/libevent-workspace-rust.log`.
- Final `cargo test -p xtask --target aarch64-apple-darwin`:
  **717 unit and six integration tests pass**, zero failures. Job
  `cargo-test--p-1022-185720-4919`, exit 0;
  `.context/libevent-xtask.log`.
- `scripts/dev-shell.sh bash scripts/check-abi-version.sh`: exit 0,
  snapshot in sync and ABI-51 bump consistent.
  `.context/libevent-abi-check.log`.

All build and verification commands use `scripts/dev-shell.sh`.
`.context/libevent-final-artifacts.json` records the source archive SHA,
both exact kernel/probe/regression artifact hashes, the shared instrumenter
source hash, and the baseline overlay. The kernel hashes differ from the
earlier validation's artifacts because these are newly stamped resolver
builds; the new runtime work here is confined to the instrumenter fix.

Setup/debug failures were retained separately: an invalid `run.sh build`
invocation was canceled; the initial direct-resolver installer needed an
explicit fork policy; pre-fix wasm64 instrumentation rejected invalid
output; an initial minimal projection omitted the kernel; and initial
browser fixtures fetched projection files through raw `/@fs/` URLs and
were correctly refused with 403. The final browser fixtures use the
existing verified `devServerAssetUrl` path. None of those setup runs are
counted as successful guest coverage or as baseline epoll failures.

The complete libevent suite, downstream tmux/memcached applications, and
native Safari were not run. The package excludes optional OpenSSL
integration. This addition changes no kernel syscall or host memory
ownership code; prior conformance and memory-gate results above were not
rerun for the library recipes and build-tool correction. No libevent
performance measurement or broader compatibility claim is made.
