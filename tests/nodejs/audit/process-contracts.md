# Process, OS, child-process, cluster and permission contracts

Source review: **complete with gaps**, covering all 778 original process-family
obligations: 265 documentation sections and 513 native descriptor observations.
Public, inherited, returned, symbol, overload, error, asynchronous and lifecycle
requirements are reconciled with actual guest owners; source-exposed private
capture paths remain explicitly distinct from required stable exports.
Implementation completeness and current four-host runtime conformance remain
unestablished. No new runtime tests, probes, compilation or builds ran.

The exact target is unchanged Node 26.13.0, commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`; native references and official
verification are in target-pins.md. The candidate remains unbuilt. Existing
process.report source review is retained, rather than counted as a newly
implemented report. Related async, terminal, observability, loading, worker,
values, network and native integration findings remain dependencies.

## Actual ownership and public contracts

| Surface | Required behavior and actual source disposition |
|---|---|
| process/global/module identity | One actual EventEmitter instance, bootstrap:1427–1596, exported as process and global process; final global accessor descriptors at 7390–7448. EventEmitter inheritance is real, but native process subscriptions and source-specific error/async scopes do not follow just from that prototype. |
| version/versions/release/arch/platform | Actual guest capability/identity and per-field build metadata, not outer host OS/Node/V8/libuv identity. Candidate intentionally identifies kandelo/wasm32 and compatibility target version; compression versions have a real native source. Missing V8/libuv is explicit, not a reason to claim their APIs conform. features/config/moduleLoadList remain incomplete. |
| argv/argv0/execArgv/execPath/title | Entry argv is captured by native adapter and installed at bootstrap:6513–6515; execArgv comes from limited actual native CLI parsing. execPath is fixed /usr/bin/node, title is ordinary JS state, not a native process-title binding. Real executable path/aliases/arguments/worker inheritance and source descriptors remain requirements. |
| cwd/chdir | Real os.getcwd/chdir and cached JS cwd, errors on nonzero native return. Exact URL/string validation, worker restrictions and cross-native mutation/caching need reconciliation; guest cwd, not host cwd. |
| env/loadEnvFile/DotEnv | Lazy real std.getenv fallback beyond seeded keys, but incomplete own-key/has/descriptor behavior and adapter native set/unset no-ops. Default child environment enumeration loses unread inherited variables. loadEnvFile and util.parseEnv/CLI DotEnv loading absent; quoted multiline/string/comment/whitespace/export and precedence rules are not shell expansion. |
| uid/euid/gid/egid and supplementary groups | Four getters call native credentials and libc get*id, js.cpp:2155–2170, rather than USER metadata. getgroups/initgroups and setuid/seteuid/setgid/setegid/setgroups bindings absent although real guest credential/group operations exist below. Worker/platform restrictions, names/IDs/errors and process-wide ownership are required. |
| pid/ppid/umask | pid uses actual guest os.getpid; ppid fixed 0 and umask fixed 022/no mutation despite actual kernel parent and creation-mask state. Correct prior-mask, validation, threads and file-creation inheritance must use that state. |
| kill/abort/signals | process.kill preserves numeric zero probes and real native kill/errors; ChildProcess.kill differs and incorrectly maps zero/unknown names to SIGTERM. abort exits numerically 134 instead of SIGABRT wait status. Registering process.on('SIG...') currently only registers JS events; native signal subscription/delivery is missing. |
| exit/exitCode/natural completion | Real validated int32 exitCode accessor and explicit exit-once path; native file/eval job/timer/I/O drain and finalizer preserve assigned exit codes and pending ESM status13. Natural exit event exists. beforeExit rescheduling and full fatal/rejection/monitor/capture policy do not. |
| nextTick/warnings/fatal/Promise events | Real async queue and warning normalization/event/printing path; async/deprecation reports apply. Missing native-to-process uncaughtException/Monitor, capture callbacks, rejectionHandled/unhandledRejection, workerMessage and active signal/resource events cannot be supplied by on() alone. Default shell fatal exit is real but not complete Node event policy. |
| hrtime/uptime/CPU/memory/resources | hrtime uses Date.now at bootstrap:1641; uptime is wall-time subtraction; memoryUsage all zeros, cpuUsage zeros/minus previous. threadCpuUsage/resourceUsage/availableMemory/constrainedMemory/getActiveResourcesInfo and memoryUsage.rss integration incomplete/missing. Native timer scheduling being monotonic does not repair these public clocks. |
| finalization/ref/unref | Missing actual finalization register/registerBeforeExit/unregister and process.ref/unref. Target weak ownership, returned descriptor/replaceability, exit/beforeExit callbacks and Refable symbol/fallback call order matter; emitting an exit event is not the whole owner. |
| report/source maps/debug/addons/execve | Report remains scoped negative/facade review. Source-map enabled controls, debug/capture/native-addon bridge and execve are missing or incomplete in their owning loading/engine/native layers. execve must preserve failed-call state, replace on success without JS exit/cleanup and return accurate errors; generic guest exec capability alone is not public integration. |
| stdio | Actual fd read/write/cancel facades share terminal state and are not complete Readable/Writable owners; see STR-011 and terminal contracts. Descriptor/tag/prototype/backpressure/error/drain/I/O/TTY/ref requirements remain. |
| os | Guest ABI LE, POSIX EOL and /dev/null are applicable. Most measurements/account data are presets, version empty, priorities no-op, machine absent; homedir/tmpdir/hostname partial fallbacks. Function Symbol.toPrimitive, module/constant descriptors, options/Buffer strings, errors and complete conditional constants require their exact owners. |
| child_process | Actual async/sync native child launch and pipes exist. spawn returns plain EventEmitter, not exported ChildProcess; full public/returned identity, lifecycle fields, IPC/fork, ref/dispose and callback/Promise owners remain incomplete. Details below. |
| cluster | Only ordinary main-role flags exist, bootstrap:5845–5849. setupPrimary/setupMaster/settings/workers/Worker/scheduling policies and events, fork/env/IPC/server sharing/disconnect/graceful exit absent. Do not mistake module Worker for worker_threads.Worker or a guest fork for cluster orchestration. |
| permissions | Ordinary unflagged absence of process.permission is valid. Enabled enforce/audit modes, has/drop, scope/path/URL/byte references, CLI options and real owner checks are missing. Guest POSIX credentials are distinct. |

Exact target source owners: lib/internal/bootstrap/node.js, internal/process/
per_thread.js, execution.js, promises.js, task_queues.js, warning.js,
finalization.js and permission.js; lib/os.js; lib/child_process.js and
internal/child_process.js; lib/cluster.js and internal/cluster/{primary,
child,worker,round_robin_handle,shared_handle}.js. The requirements ledger
retains complete document ranges and captures plus returned/source declarations.

## Native, libc, kernel and host trace

Async launch reaches `_spawnWithPath` at bootstrap:3714–3741. It searches the
**child environment's PATH**, resolves relative entries against child cwd,
preserves pathname component/symlink traversal for the kernel and defers
EACCES while trying ENOENT/ENOTDIR candidates. There is no stat-before-exec
success shortcut. Lack of complete JS normalization does not negate this
real launch behavior.

Native `KandeloNativeSpawn`, frozen js.cpp:1728–1900, owns encoded argv/env,
posix_spawn file actions/attributes and destruction on normal/error paths.
Actions include dup2/close/open/chdir; detached sets POSIX_SPAWN_SETSID and
pgroup state can be supplied. Native API supports neither a full Node
ChildProcess owner nor Node IPC protocol by itself. Sync uid/gid requests
return ENOSYS before launch; async options can be ignored, a separate gap.

`libc/musl-overlay/src/process/wasm32posix/posix_spawn.c:225–399` validates
counts/length/ARG_MAX/wire limits and allocation, marshals strings and
insertion-ordered actions plus masks/attributes, then sends SYS_SPAWN.
Runtime-core spawn.rs:159–308,348 onward validates request ranges/records.
`crates/kernel/src/wasm_api.rs:3191–3245,4353–4378` binds the explicit parent
and caller TID, prepares and commits the guest target and publishes only the
fully launched child. Runtime-core process/credential/exec/wait owners keep
real cwd/credentials/mask/fd/OFD/status state. Existence of this path is not
proof of every failure rollback or native JS ownership branch.

`host/src/kernel-worker.ts:20630–20717,20989–21034` enters the kernel with
actual caller context, reports missing onSpawn as ENOSYS, retains child
metadata/target authority and installs host fd mirrors with rollback on
failure. Node entry:1100 and browser entry:1112 both supply actual onSpawn
callbacks, owned-job inheritance and process Worker launch; browser wait/
message/teardown paths differ. Chromium, Firefox and WebKit share that browser
entry. Guest processes and fds remain guest objects, not outer host PIDs/fds.
Browser sandboxing does not make virtual guest child processes impossible.

Async wait, js.cpp:1044–1094,1905–1935, polls real waitpid(WNOHANG) and
preserves normal versus signal termination. It wrongly resolves ECHILD as
successful exit0, and other wait failures lack complete rejection handling.
Runtime-core wait_child.rs owns selection/options, stopped/continued/exited
records, atomic reap/publication and ECHILD. Its real failure must not become
native success. JS streams own their actual pending read/cancel/close, but
wait rejection and child stdin close on exit remain gaps.

Sync controller, js.cpp:1950–2152, adopts each parent fd by setting its JS
ownership slot to -1, copies nonshared input, owns buffers/child/reap cleanup,
uses native monotonic deadline and poll/short writes/reads, closes pipes and
kills/reaps on failure without reentering parent JS. It distinguishes ECHILD
from success. It aggregates captured output for maxBuffer and tests the limit
only when >0, as exact target src/spawn_sync.cc:648–655 does. Do not invent
an aggregate-versus-per-stream or zero-limit mismatch. Actual timeout,
ignored signals, error precedence, descendant-held pipes, allocation and
partial result cleanup still need native controls; a timeout can wait for a
child that ignores its configured signal in the native reference too.

Kernel syscalls.rs supplies actual getppid/get*id at 10592–10614, umask at
19756, credential setters at 20999–21016 and supplementary groups at
21345–21387. getrusage at 21055 zero-fills statistics; exposing it unchanged
would still not implement real CPU accounting. Priority state at 21074–21101
stores guest nice with checks, without proving scheduler effectiveness.
uname at 19765 returns wasm-posix/localhost/1.0.0/kandelo/wasm32; the JS
6.0.0-wasm release is not that kernel state. These are implementation gaps,
not permission to borrow outer-host measurements or Linux identity.

## Findings beyond the initial survey

PROC-001–008 and CP-001–006 remain as clarified by the trace above.

| ID | Concrete finding and references | Shared prerequisite |
|---|---|---|
| PROC-009 | Natural exit-once/failure/finalization paths exist (bootstrap:6438–6453,7379–7384; js.cpp:16214–16270), but no beforeExit rescheduling checkpoint or native-to-process fatal/monitor/capture/rejection policy. EventEmitter listener presence is insufficient. Target execution.js:117–214 has real primary/auxiliary capture and monitor behavior. | Native scheduler/job/fatal ownership and EventEmitter/async context |
| PROC-010 | finalization object and ref/unref absent. Target finalization.js has actual WeakRef/registry/event-owned callbacks, and per_thread.js:532–544 tries Symbol.for('nodejs.ref'/'nodejs.unref') before the legacy method. Missing methods cannot be justified by some timer/socket ref operations already working. | Per-resource liveness, weak/GC/exit/beforeExit and returned descriptors |
| PROC-011 | Permission Model lacks enabled enforce/audit and irreversible drop, not only has. drop affects future checks and exact grants, does not revoke open resources; target internal/process/permission.js and pre_execution.js:716–784 specify actual normalization and initialization. Adapter permissionEnabled callbacks return false. | All fs/net/process/worker/addon/WASI/FFI/inspector/STORE owners, diagnostics and CLI |
| PROC-012 | OS function primitive conversion and descriptors differ: target os.js attaches Symbol.toPrimitive to selected callables, freezes signal constants and defines EOL/devNull non-writable, constants non-writable/non-configurable. Candidate plain assignment leaves different descriptors; availableParallelism derives from one preset CPU, setPriority no-op. Full conditional constants and userInfo encoding/options remain missing. | Actual guest measurements/credential/name tables, correct value/descriptor contracts |
| PROC-013 | Lazy getenv lookup means unseeded keys can be readable; no ownKeys/has/defineProperty native environment integration, and adapter setenv/unsetenv no-ops. Own-key child inheritance depends on prior reads; deletion can resurrect a native value. Node env key/value validation, descriptors, string conversion, workers and mutations need real owner integration. | Native environment enumeration/mutation, per-worker state and child snapshots; DOC-010 |
| PROC-014 | Public hrtime/uptime depend on wall time; CPU/memory return fabricated zero/preset results. Several resource/control APIs missing. Kernel zero getrusage cannot be described as implemented usage. process.report's musl object list is a facade, not native-loaded-object evidence. | Real monotonic/public time and guest/engine/native allocation/CPU/resource accounting |
| PROC-015 | argv setup/execArgv are real but limited; title/execPath/config/features/moduleLoadList and flags/native controls do not describe complete actual executable/build/resource state. Preserve truthful kandelo/wasm32 and explicit missing engine/ABI fields. | Native entry/loading/metadata/platform decisions, not spoofed Node/V8/libuv support |
| CP-007 | Async normalization accepts/ignores unsupported options, custom shell path ignored, exec overwrites custom shell with true, extra stdio/IPC omitted. Partial pipe allocation happens before cleanup try. Real child PATH search does not repair these errors. bootstrap:3714–3814,3936–3947. | Shared argument/URL/encoding/credential/stdio/env normalization and transactional ownership |
| CP-008 | Target child owner destroys stdin on process exit (internal/child_process.js:307–309). Candidate wait handler only emits exit/resumes outputs; it never destroys child.stdin. Its owned write fd closes only through final/destroy. A caller retaining an unended stdin can therefore retain that descriptor after exit. Native wait failure has no rejection handler either. bootstrap:3816–3832,3872–3884. | Child terminal state, descriptor lifetime, cancellation/ref and reaping |
| CP-009 | Sync launch has real adoption/deadline/limit/reap ownership; async wait still fabricates ECHILD success. Falsy top-level input is also ignored by target child_process.js:951, so that truthiness check alone is not a mismatch. Error/result metadata, OS-level error-versus-exception policy, flags and fd/descendant/failure edges remain exact-target questions; do not claim the sync controller is a stub or aggregate maxBuffer is inherently wrong. | Native controller/libc/kernel/POSIX wait/pipe/error ownership |
| CP-010 | exec/execFile accumulate per-chunk strings without complete encoding/Buffer/maxBuffer/timeout handling. Target custom promisify returns {stdout,stderr} and attaches child; candidate lacks those descriptors, so ordinary util.promisify is insufficient. Callback error/close/once/abort and consumer exceptions need actual lifecycle owners, not just waiting for close. bootstrap:3909–3949; target child_process.js:244–265,530. | Streaming decoder/bytes/limits, callback/Promise identity and once/terminal control |

Candidate spawn returns a plain EventEmitter while exported ChildProcess has
only EventEmitter inheritance (3952–3958); instanceof/subclass/prototype.spawn,
kill/ref/unref/Symbol.dispose, connected/channel/send/disconnect, spawnargs,
spawnfile, exitCode/signalCode/stdio and ordered spawn/error/exit/close events
are required owners, including APIs installed on returned objects rather than
own module exports. Source capture alone does not establish inherited methods.
Cluster Worker similarly inherits EventEmitter and adds its own process/id/
state/send/destroy/disconnect/isDead/isConnected behavior, not an alias for
ChildProcess or worker_threads.Worker.

## Permission, environment and platform applicability

Permission flags change access at resource owners, not POSIX UID/GID or browser
origin policy. Enforce rejects unauthorized operations with actual permission/
resource errors; audit publishes violations without denying. --permission
wins over audit when both are set. Existing fd access and initialization-time
operator file reads have target-specific constraints; do not invent broader
protection or retroactive revocation. process.permission absent without
activation is correct. drop/has accept reference types according to scope;
raw byte fs paths must not be lossy-decoded. Worker execArgv inheritance and
explicit replacement govern model setup, rather than unconditional inheritance
of in-memory permission state. See permissions.md:337–382 for exact limits.

DotEnv name/value/quote/comment/spacing/export rules, loadEnvFile, util.parseEnv
and CLI env-file initialization/precedence are distinct public contracts.
Native getenv can see values not yet enumerated in JS; native set/unset and
worker/spawn copies need actual guest state. No new files were parsed by a
runtime probe in this audit. Source requirement extraction is metadata only.

Worker-disallowed process APIs, Windows-only signal/exec restrictions, native
addon ABI and physical performance/hardware metadata require concrete per-API
boundaries. They do not excuse guest umask/ppid/env/credentials, local IPC,
beforeExit or missing JS normalization. No new engine defect is established.

## Evidence, unresolved questions and later controls

Historical baseline and selected child/process/exit fixtures retain their
identified older source/artifact/host results in the unchanged archive/index.
Most baseline cases stop in common/index at missing net metadata. Neither
that failure nor an older narrow child success validates this unbuilt source.
The old Firefox exit-fixture timeout is historical and unresolved for this
candidate; it is not an established engine boundary or current rerun result.
No pass/skip/unsupported/timeout/harness-error/pending status is upgraded.

After separate authorization, use unchanged exact-pin tests in all applicable
categories and real process/pipe/signal/IPC/native fixtures, with matching
native 26.13.0 controls and separate per-host artifact/backend identities.
Priorities: environment native reads/enumeration/deletion/spawn/worker copies;
kill0/unknown names/permission/signal status; beforeExit rescheduling and
fatal/monitor/capture/rejection order; exit code and event listeners; stdin
closure, partially allocated pipes, short I/O, fd reuse, reaping/ECHILD;
spawn/exec shell/PATH/cwd/uid/gid/stdio and custom promisify; sync deadlines/
maxBuffer/ignored signal/descendants/cleanup; cluster IPC/socket distribution;
permission enforce/audit/drop and open-resource behavior; actual OS/time/usage/
metadata and descriptor/symbol/alias/brand behavior.

Open source/native questions remain explicit: precise capture-callback
interaction (target prose/comment and primary-versus-auxiliary source priority),
parent/native/worker environment mutation and full descriptors, source-specific
error/validation/async order, every OOM/cancel/GC/ref/teardown branch, supported
native ABI/physical hardware field applicability, unchanged fixture/flag closure
and current four-host results. They do not authorize implementation or probes
and do not prevent completing the remaining broad source audit.
