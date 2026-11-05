# Process, child-process and OS source review

State: **source review complete with gaps**; see [complete contracts](process-contracts.md)
and `process-requirements.json`. This records source findings, not runtime results.
The complete crosswalk retains all 778 original obligations and scoped reviews.
The initial observations below are supplemented by the complete contract report. No new execution,
compilation or build was performed.

## Ownership and exposure

The process object is an EventEmitter constructed in
`packages/registry/node-compat/bootstrap.js`:1381–1637. It supplies the
global and builtin process identity; stdio is separately reviewed in
[terminal.md](terminal.md), and clocks/reports/usage in
[observability.md](observability.md). The OS facade is at 2529–2596;
child_process at 3533–3958; the cluster entry at 5846 is only role flags.
These are shared guest implementations on all four embedding hosts.

There is real process creation and fd ownership beneath the facade:
`js.cpp`:1728–1977 in the identified source snapshot implements spawn,
wait and kill; its synchronous controller starts at 1978. libc
posix_spawn/file actions and the kernel process/fd tables own guest state.
Embedding-host process APIs must not replace that state. Async child pipes
use real fd reads/writes and stream cancellation, and close is gated on
reaping plus terminal output-stream state. Those real paths are not proof
of complete child-process behavior.

## Findings

| ID | Required behavior | Source observation | Owning dependency |
|---|---|---|---|
| PROC-001 | Complete, mutable process environment; enumeration and inheritance | Bootstrap seeds a whitelist and lazily caches other reads. Proxy has no complete ownKeys source. Adapter `std.setenv/unsetenv` at 263–277 are no-ops. Deleting an inherited key can fetch it again; native getenv and JavaScript state diverge. Child default env uses Object.keys and loses unaccessed inherited keys | Native environment enumeration/mutation, descriptors and child environment snapshots |
| PROC-002 | Actual guest parent and creation mask | ppid is preset 0; umask always returns 022 without mutation. Kernel getppid and `sys_umask` exist (`syscalls.rs`:10592,19756) | Bind actual guest process state; validation and previous-mask semantics |
| PROC-003 | Termination distinguishes signal death from ordinary exit | abort calls std.exit(134), rather than generating SIGABRT termination. The complete review identifies missing beforeExit rescheduling and native fatal/rejection delivery; exact runtime ordering remains unvalidated | Kernel signal/wait status, async/fatal-event policy |
| PROC-004 | Truthful public resource/identity information | OS cpus, memory, load, interfaces, userInfo and priorities are presets or no-ops; availableParallelism derives from the preset cpu list. OS release/type/version differ from actual kernel uname fields | Guest resource accounting, credentials/network tables and metadata bindings |
| PROC-005 | Complete process metadata, capability and control APIs | features/config are empty, moduleLoadList never tracks loading; groups/setters and many public control/resource APIs are absent | Exact public-surface reconciliation and actual capabilities, without advertising unavailable Node internals |
| CP-001 | kill(0) probes; invalid signals reject | Bootstrap:3880–3883 applies signum || 15. Numeric zero and unknown signal names become SIGTERM. process.kill has a distinct implementation that preserves zero; it must not be conflated with this defect | Child signal normalization and real kernel kill |
| CP-002 | ChildProcess identity, fields, methods and events | spawn returns a plain EventEmitter while exported ChildProcess is a separate empty wrapper. spawn event, public exitCode/signalCode/stdio metadata, IPC/ref/dispose and other methods are missing | Real child owner, stream/fd references, IPC and event ordering |
| CP-003 | Failure reports and owned resources settle correctly | Pipe allocation precedes the spawn try block, so an allocation failure after earlier pipes bypasses that cleanup. Spawn failure queues error and returns dummy streams but no close path. wait Promise has no rejection handler | Allocate/rollback ownership, one terminal result, close/error ordering |
| CP-004 | Argument, shell, env, stdio and lifecycle options | Async shell ignores a custom shell path; only first three stdio entries are handled. Overload validation, uid/gid, argv0, abort/timeout and extra channels are incomplete. Sync controller differs and has actual poll/deadline/maxBuffer behavior | Shared normalization, native spawn options, cancellation and extra fd/IPC ownership |
| CP-005 | exec/execFile byte limits, encoding and completion | Callback path accumulates Buffer chunks into strings with +=; requested encodings, split multibyte sequences, maxBuffer and timeout are not faithfully modeled | Streaming decoders, bounded buffers, abort/timeout and callback-once policy |
| CP-006 | Reaping preserves actual result or error | Native WaitPid at js.cpp:1905 and dispatchChild at 1076 turn ECHILD into successful exit 0. This loses the distinction between known success and unavailable status | Kernel wait ownership and native error propagation |
| PROC-006 | Real cluster API and worker distribution | Only isMaster/isPrimary/isWorker flags are present; setup, fork, workers, scheduling, IPC and lifecycle absent | Child processes, IPC, server sharing and real cluster state |
| PROC-007 | Permission activation, enforcement/audit and process.permission.has | No permission CLI/model or runtime API. Filesystem/stream adapter callbacks explicitly return false for permissionEnabled. Absence of process.permission in an ordinary unflagged run is valid; enabled enforce/audit behavior is missing | CLI activation, checks at all resource owners, diagnostics publication and scoped decisions; guest POSIX credentials are a separate mechanism |
| PROC-008 | DotEnv parsing and process.loadEnvFile/CLI environment loading | No reviewed programmatic loadEnvFile or complete DotEnv CLI path. Target environment_variables.md defines names, quoting, comments, spacing and export prefixes, not shell evaluation | Text parsing, fs/errors and real environment mutation, util.parseEnv and CLI precedence |

Source references for native functions mean
`.context/node45-fs-readfile-engine-reference/js/src/shell/js.cpp`, hashed
in the audit state. These observations must be invalidated if that source
candidate changes.

`crates/runtime-core/src/syscalls.rs`:19765 constructs uname values
wasm-posix/localhost/1.0.0/kandelo/wasm32. libc routes uname via kernel
syscall dispatch (`libc/glue/syscall_glue.c`:891;
`crates/kernel/src/wasm_api.rs`:13097). The OS facade does not use this
path. Its hardcoded 6.0.0-wasm release is therefore not the actual guest
kernel release. Current process.platform is truthfully **kandelo** and
arch is **wasm32**; this audit does not prescribe Linux identity.

Actual syscall existence is insufficient: getpriority/setpriority store a
guest nice value (`syscalls.rs`:21074,21088), while getrusage at 21055
currently fills zeroed statistics. Wrapping the latter would still not
provide real CPU accounting. Host CPU/memory totals likewise do not
automatically describe guest limits or usage.

## Host differences, evidence and outstanding questions

Shared facade gaps affect all four hosts by source inference. Actual
spawn, fd readiness, worker scheduling, cancellation and guest signals
cross different embedding event loops and require independent later
evidence. No newly accepted platform boundary excuses these missing
bindings. Browser sandboxing alone does not prevent guest processes or
guest credentials.

Historical child_process and lifecycle reports retain their exact older
artifact identities; none establish this candidate's conformance. Later
unchanged upstream selections should include process-env, process-umask,
process-exit/beforeexit, process-warning, child-process-kill/spawn/exec,
stdio, signal, cluster and OS tests, with real process/pipe fixtures.
Native controls must distinguish kill(0) from termination, failed spawn
from exit, signal death from numeric 134, complete inherited environment,
drained output from early exit, partial pipe-allocation failure and
already-reaped status. Tests are proposed, not authorized or executed.

The complete report now distinguishes actual native/controller state from
missing public/returned/descriptor/alias/error and native event owners,
permission has/drop and activation, Refable/finalization/resource metadata,
child stdin cleanup and IPC/cluster requirements. Exact failure/GC/ref/
validation/event/native callback/timeout/teardown controls and physical/ABI
field applicability remain explicit source/native questions. No current
four-host runtime conformance is established.
