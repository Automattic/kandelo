# Console output and state source owners

O-004/005/006/007 have partial source implementations. No observability
finding, family or four-host conformance is closed. The exact Node 26.13.0
pin and frozen audit remain unchanged.

## Source and ownership

console-platform-adapter.js loads full hash-checked lib/console.js,
internal/console/constructor.js, global.js, cli_table.js, util/debuglog.js,
trace_events.js and constants.js from the exact target. The manifest also
retains bootstrap and util references; exposeNamespace is selected with its
own exact section hash. Private factories have null prototypes and cached
exports, claim before evaluation, and roll back failed evaluation.

The builtin console and installed global namespace select the same actual
owner. The old separate class/default export and global Date.now fallback
are removed. Global namespace prototype, bound methods, descriptors,
constructor/legacy options, per-stream inspect Map, ignoreErrors, labels,
counter/group/timer state and output algorithms come from retained source.
ESM builtin/default namespace integration remains a loader validation gap.

Production dependencies are the actual shared guest process/fd streams,
inspection/formatting/types/Buffer/readline cursor owners, native iterator
preview hook and diagnostics registry. Timers consume process.hrtime;
internal collected records use the native monotonic hook. No embedding host
streams, wall-clock durations, preset output or fake write completion is
supplied in the guest path. Inspector configuration records its actual
missing Node bridge; it does not provide no-op inspector console methods.

Pinned Console publishes console.log/info/debug/warn/error directly. The
previous attachConsole wrapper is removed from the diagnostics owner and
bootstrap, preventing duplicate events. The observer can inspect/mutate the
original arguments before formatting and the actual stream write.

There is one checked source adaptation: absent ErrorCaptureStackTrace uses
an actual engine Error stack. The Trace header derives from that Error;
actual frames remain intact. V8 recapture/frame filtering and exact native
stack formatting are missing implementation, not an accepted engine/platform
exclusion. A native dependency control explicitly removes this capability
without substituting fake caller frames.

The private trace collector owns active category subscriptions and explicit
stop handles. Classic phases follow the retained trace module; matching any
category in a comma-separated group enables an event. Events have actual
monotonic timestamps, immutable records, snapshot/reentrant subscription
semantics and immediate retirement. Empty subscriptions correctly disable
tracing; absence of a shared native flag buffer uses the target checker
fallback. This is an internal foundation, not public trace_events support:
CLI/file writers, complete native producers, inspector sessions, pid/tid/
async attribution and cross-worker trace collection remain unimplemented.
No fabricated public trace metadata or Perfetto backend is advertised.

Recipe revision 52 selects changed bundle/bootstrap bytes. No native engine
patch, host import, syscall or wire ABI is added in this slice. All four
hosts select common source; none has current rebuilt guest evidence.

## Evidence and limits

Nine focused Console controls and ten affected diagnostics controls passed
under the exact native reference. They exercise actual candidate factories;
Node supplies inspection/width, Writable, previewEntries, readline callbacks,
engine stacks and clock dependencies. Controlled timer values are explicit
fixture inputs; production uses actual guest clocks. The missing-capture
control copies intrinsic property descriptors rather than evaluating getters.
It proves the fallback runs on native Node, not SpiderMonkey stack parity.

Four unchanged upstream files passed in candidate/native modes: console
group, count, synchronous write errors and asynchronous write errors. The
preload selects global/CJS console only; all other native dependencies and
assert/common are controls. No upstream assertion, platform identity,
selection skip or error handling expectation is modified. Passing this
selection is not guest stream/error/tick/TTY or four-host conformance.

Two failed invocations remain preserved: the initial command used the wrong
working directory for the local Vitest executable and never loaded tests;
the next run had 18 passes and one fixture getter-copy error in the explicit
missing-capture branch. That fixture error is corrected by copying intrinsic
descriptors. These failures remain distinct from candidate conformance.

## Remaining implementation and validation

Complete actual inspector/task/profile integration and public trace-event
controller/files/CLI/native producer ownership. Complete Performance,
EventTarget, histograms, reports and real process/heap/CPU measurements from
the audit. Five known fabricated capability claims elsewhere remain open.

For Console, validate the combined guest inspection/format/type/byte/native
preview stack, no-ICU/Unicode table width, global/CJS/ESM identity, realm/GC,
property descriptors, hostile getters/proxies, reentrancy, actual stream
errors/listener lifetime and scheduler behavior on all four hosts. Exact
stack capture/filtering and inspector methods remain implementation gaps.
Actual TTY/color/TERM/cursor policy depends on the terminal/fd owners.

Move to independent audited gaps before expanding an overall test campaign.
After the breadth pass, run unchanged applicable upstream files and native
differentials over identified built guest artifacts within build permission.
Skips, unsupported cases and absent capabilities never count as passes.
