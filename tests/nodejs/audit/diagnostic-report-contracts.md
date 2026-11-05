# Diagnostic report contracts

Completed negative/facade source audit of process.report and the full
diagnostic-report narrative. Target Node 26.13.0, commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. This is documentation and
metadata only, with no runtime execution, tests or builds. The broader
process/OS family's measurement implementations remain a separate audit.

## Public API, configuration and triggers

`lib/internal/process/report.js` owns writeReport/getReport and accessor
properties directory, filename, compact, excludeNetwork, excludeEnv,
signal, reportOnFatalError, reportOnSignal and reportOnUncaughtException.
Methods/accessors are enumerable object-literal properties; mutation,
receiver independence and validation follow their closure-backed owners.
No report class or node:report module is required. Process/builtin/global
identity must lead to the same report object.

writeReport accepts filename and/or an error-context object, validates
filename strings/paths and error objects, synthesizes an error when absent,
checks filesystem permission and returns the resulting filename. getReport
validates optional context, obtains a real native report and JSON-parses it
into a new JS object. The wrapper accepts an object context rather than
enforcing Error instanceof; source and docs' Error type need differential
controls for duck objects/accessors. URLs are not a supported filename
interface. Error stack/property getters and conversion failures have the
native best-effort rules at `src/node_report.cc:417–575`.

String and boolean configuration setters validate inputs. Defaults and
scopes come from node_options.h: directory/filename empty, compact false,
SIGUSR2, reporting flags false, environment/network exclusions false.
Some settings are process-wide under a lock; signal/uncaught options are
isolate-scoped, while exclusions are environment-scoped. Workers must not
receive an arbitrary snapshot pretending to be shared configuration.
Changing signal removes the old handler and conditionally installs the new
one; toggling reportOnSignal manages actual process listeners. The Windows
signal limitation does not exclude guest POSIX signals on browser hosts.

CLI paths include report-on-signal/signal, uncaught exception, fatal error,
compact, directory/dir alias, filename, exclusions and process timeout.
Use each option's actual NODE_OPTIONS permission; the timeout report flag
is not marked allowed-in-env like the ordinary report options. Original
exception/capture-handler policy is in execution.js and node_errors.cc,
not an arbitrary userland catch. Fatal/OOM paths can have no current JS
environment. The timeout watchdog (`node_watchdog.cc:398–430,548–585`)
has its own shutdown/exit path and does not emit normal JS exit callbacks.
These owners are absent from the report facade and depend on real process
fatal/signal/timeout lifecycle (including A-014).

## Schema, actual state and platform branches

Report version is **5** (`node_report.cc:28`). The old example in report.md
contains historical release/CPU/library values and is not a template to
copy as current runtime state. `diagnostic-report-requirements.json`
records every literal emitted field and source location, section/owner,
dynamic schema limitations and the example's complete field paths.

| Report section | Required actual owner | Candidate state / boundary |
|---|---|---|
| header/version/time/PID/thread/cwd/commandLine | Guest process/thread/clock/argv and actual component metadata | Missing; host PID/platform/version must not impersonate guest state |
| OS/CPU/interfaces | Actual selected guest platform profile and virtual network state; excludeNetwork omits interfaces | Missing; embedding hardware/network details are not automatically guest details |
| javascriptStack/errorProperties | Current guest engine frames or supplied context stack/properties, with best-effort failure behavior | Missing binding; actual engine stacks exist, so no whole-section exclusion |
| javascriptHeap/heapSpaces | Actual engine memory, contexts and allocator accounting | Missing; literal V8 space topology/global-handle fields require per-field SpiderMonkey mapping/boundary decisions, never fake values |
| nativeStack | Actual executing guest/native/Wasm stack and symbol information | Missing report bridge; native address/ABI-specific frame representation remains a concrete per-field question |
| resourceUsage/thread usage | Actual process/thread rusage, RSS, available/constrained memory and I/O/fault accounting, correct units and conditional availability | Missing; source zero/fixed measurement facades are not evidence |
| libuv handles/loop | Actual active/ref state, guest fd, socket endpoints/buffers, timer deadlines, TTY sizes, watches, signals, stream queues and provider idle time | No libuv guest loop; precise libuv-specific address/type equivalence needs a field decision. Portable guest resource state is an implementation gap |
| workers | Real child worker reports and thread identity/lifetime | Missing aggregation/interrupt/report ownership; normal report waits, process-timeout report has bounded grace |
| environmentVariables | Actual guest environment unless excluded | Missing; environment whitelist/lost inheritance remains a process prerequisite |
| userLimits | Actual applicable guest rlimits, numeric bytes/seconds and string unlimited, conditional POSIX keys | Missing; no Windows-host exclusion for guest POSIX resource limits |
| sharedObjects | Actual loaded guest native libraries from loader state | Fixed single musl loader pathname, no inspection of actual loaded objects |

`src/node_report_utils.cc` traces each resource variant and conditional
field, including reverse name lookup when not excluded. excludeNetwork
disables DNS lookup but may still report numeric endpoint host/IP values;
it does not redact every endpoint. Report v4 prose/examples say ipv4/ipv6
while current writer literals are ip4/ip6. That target question is
recorded as **O-023**, along with historical example/type differences;
no target or assertion was changed to resolve it.

The native report loops through actual heap spaces, limits, libraries,
metadata, error properties and workers. Literal-field extraction is only
an index: dynamic keys and conditional values must retain their source
owners. Source ownership and concrete absence are established here;
field-specific engine/platform mapping remains explicitly unresolved.
No accepted whole-report boundary is recorded.

## Files, errors and worker lifetime

`TriggerNodeReport` at node_report.cc:845–1040 selects explicit filename,
configured filename or generated timestamp/PID/sequence. Configured
directory applies to files. stdout/stderr bypass directory and must remain
open; stderr avoids mixing completion text into its JSON. File-open
failure writes a diagnostic and returns an empty filename. Permission
denial has the wrapper and native checks; do not replace actual guest VFS
errors with unconditional success. Compact formatting affects file output;
getReport returns parsed data rather than the raw compact stream.

Report generation interrupts child workers and retains shared callback
state even if a timeout report stops waiting before a blocked worker
responds (`node_report.cc:229–276`). Normal reports wait for expected
worker responses; timeout reports omit late/nonresponding workers after
the bounded grace period. Correct teardown must not leave callbacks
pointing to freed stack storage or stop unrelated workers.

Candidate bootstrap:1583–1589 implements only getReport returning a newly
allocated object with a fixed sharedObjects array. It ignores context,
has none of the configuration/accessors/triggers/file/worker behavior and
does not query the real loader. **O-013** remains a concrete implementation
gap, including its apparently successful but manufactured loaded-library
result. The separate Claude/npm/Bun work is preserved; no implementation
change was made to this metadata consumer path.

## Evidence and later validation

### Scoped process measurement review

The five measurement APIs previously listed in the observability survey
are source-reconciled here; this does not finish the process family.
`internal/process/per_thread.js:78–101,127–162,216–227` and
`src/node_process_methods.cc:114–136,211–248,289–298,718–733` own the target
wrappers and native measurements. `internal/bootstrap/node.js:158–205`
installs them on the shared process object.

| API | Actual target contract | Candidate gap |
|---|---|---|
| hrtime | Monotonic arbitrary-origin seconds/ns array; optional array exactly length two; subtraction/borrow and target coercion/error order | Date.now wall time; truthy-only previous check and no array/length validation |
| hrtime.bigint | Same monotonic source as bigint nanoseconds; own function property installed as hrtimeBigInt; extra arguments ignored | BigInt conversion of wall-clock milliseconds; wrong callable metadata/name |
| uptime | Monotonic seconds since actual process start, including fractional seconds; native uv_update_time side effect | Wall-clock elapsed since late bootstrap `_startTime` |
| cpuUsage | Actual process user/system microseconds and optional delta; truthy previous validation reads user/system with nonnegative safe-range checks, then native rusage errors | Fixed zero or negated previous values, without proper validation or actual accounting |
| memoryUsage / memoryUsage.rss | Actual byte counts; RSS process-wide, engine/external/ArrayBuffer accounting scoped appropriately to current worker; own rss function and native failures | Five zeros, missing rss helper, no actual native/engine allocator bridge |

The original wrapper functions preserve normal inherited Function behavior
and their declared names/arity; assigned properties are ordinary writable,
enumerable/configurable properties unless the native binding specifies
otherwise. Native RSS/uptime function construction differs from an
ordinary JS constructor, so exact descriptor/callability controls remain
part of later validation, not invented functions in the audit.

The candidate wall-clock helper is bootstrap:1639–1644. Real guest
monotonic clock capability is traced in the timer review; these functions
do not use it. Runtime-core sys_getrusage at syscalls.rs:21055–21071
validates selectors/buffer and fills **all statistics with zeros**.
Connecting to it would still not implement CPU accounting. Its comment
about unavailable runtime metrics is not proof that all guest accounting
is impossible. Engine/allocator counters, worker scope and actual guest
RSS/CPU definitions require their owning layers and per-host analysis;
outer-host totals or elapsed time cannot be relabeled as guest CPU/RSS.
No blanket boundary is accepted. O-012 covers these concrete gaps.

Detailed process measurement requirement sections/source hashes and
future unchanged candidates are retained in the report artifacts. Other
process measurements, including threadCpuUsage/resourceUsage and available
or constrained memory, remain in the incomplete process-family audit.

All four hosts share this guest facade. Current-candidate runtime
conformance is unestablished on each. Historical report tests/statuses
retain exact artifact identities in the evidence archive. Proposed
unchanged test/report and related parallel/worker/permission/message
sources are cataloged, with original flags, fixture binaries, fatal/signal
launch semantics and expected outputs. No death/signal test was run.

Future native controls should cover descriptors/aliases, context getters,
setter validation/scopes, permission ordering, actual schema/version and
field presence/types/units, changed resource/loader/environment state,
exclusions versus numeric endpoints, stdout/stderr/files and error paths,
CLI triggers, worker interruption/timeout/cleanup and signal reconfiguration.
Choose field-specific boundaries during review before implementation;
this audit does not authorize either those fixes or new runtime controls.
