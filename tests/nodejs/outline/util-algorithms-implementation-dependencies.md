# Public util algorithm owners

V-008/V-019–023 remain partial. Exact Node 26.13.0/source/native pins and the
completed frozen audit are unchanged. These are implementation-source and
native-control results, not a completed util module or four-host conformance.

## Actual portable algorithms and dependency owners

util-algorithms-adapter.js installs full unchanged parse_args/parse_args.js,
parse_args/utils.js, util/diff.js, util/debounce.js and util/throttle.js. It
selects the exact pure Myers algorithm from the full checked assert source;
unused assertion rendering/color functions are not substituted as algorithms.
All full references and selected sections are pinned and checked by build.py.
Actual public algorithm code owns parsing/coercion/defaults/tokens/negation,
null-prototype dictionaries and prototype-name handling, validation/errors,
diff operations, debounce/throttle state, concurrency/overflow/queues,
cancellation/flush/pending/ref/unref, abort causes and promise outcomes.

The per-context native module cache registers before evaluation and retires
failed evaluations before retry. Captured primordials and existing exact
values/errors/validators, real guest timer objects, private addAbortListener,
actual handled-promise operation and native monotonic timer clock supply the
dependencies. No wall-clock value, fabricated timer/Promise state, swallowed
failure or successful no-op is supplied. Timer maximum comes from the pinned
internal/timers constant. Throttle uses integer monotonic milliseconds minus
the captured integer boot-time base, matching the target clock's integer
read/subtract policy. Guest timer scheduling/clock-origin/ref/rejection/abort
and engine behavior still require validation; native controls do not establish
those dependencies as conformant.

Patch 71 extends the real CLI parser's state with the parsed eval source.
The original supported inline/equal/separate option branches own this field;
bootstrap captures it before user code. parseArgs default argument selection
therefore uses actual immutable parsed state, not mutable process.execArgv or
an argv heuristic. Its current process.argv is still read as the pinned
algorithm requires. Missing metadata fails explicitly. Empty eval strings
retain the target's special length==0 behavior. This patch does not implement
print flags, all NODE_OPTIONS, workers or exact execution of repeated eval
flags; those CLI owner gaps remain. Recipe57 binds changed source; JSAPI/CLI
native source is uncompiled. No new kernel/syscall/import/wire ABI is added.

## Explicit namespace deviation

The debounce/throttle descriptors are the exact public JavaScript getter
section from util.js, sharing actual cached module identity. parseArgs/diff
currently use a JavaScript lazy accessor which becomes a writable data
property on an ordinary first read. V8's native SetLazyDataProperty has no
visible JavaScript getter and behaves differently during descriptor lookup,
freeze/seal/inheritance/realm operations. This is a fixable engine/embedding
implementation gap, not an accepted platform exclusion. Frozen namespaces
remain usable: the accessor returns the actual module function without trying
to redefine a nonconfigurable property. Complete descriptor/receiver/realm
fidelity is not claimed, even though the algorithm implementations are real.

## Evidence and preserved history

Eight focused scenarios pass: parser tokens/defaults/prototype names, parser
errors, mutable argv with immutable native option state, string/line diffs,
debounce results/control/cancel, throttle concurrency/queue/ref state, abort
causes and post-access function/property metadata plus frozen namespace use.
The native Node reference supplies real engine/timers/abort/clock/options.
These controls do not execute the guest bootstrap clock or new CLI patch.
The initial seven passing controls and identified source inputs are retained
as history before the freeze guard and extra property assertions. Its original
per-case raw logs were accidentally overwritten by the second run before
versioned paths were introduced. The aggregate log, report with original hashes
and selected input copies remain, but complete historical raw closure is lost;
that stage is not final evidence. Current final raw logs are retained under
versioned r2 paths. Repeated cases are not additional coverage.

Four unchanged files pass as candidate and separately as native:
test-parse-args.mjs, test-util-debounce.js, test-util-throttle.js and
test-util-throttle-timing.js. Timer mocks in the unchanged timing file use the
actual native timer/clock control boundary. CJS lazy getters load candidate
algorithms after mocks; the candidate parseArgs value is installed in the
actual builtin ESM namespace for that file's named import. Other util members,
engine/async hooks/timers/options/assert/runner/common remain native controls.
The parse-args file's children have explicit command lines without candidate
preload, so their nine CLI checks are native evidence only. No child stderr
or warning is filtered, and no assertion/identity is changed. The focused
current-process default-args check is distinct from those native CLI children.

The first upstream stage and its exact selected inputs/logs remain historical
before the freeze/clock source refinements; final stage replaces no historical
outcome. First source generation failed its selector guard because the timeout
constant selection included following declarations. The selector now ends at
its semicolon and still asserts the exact target expression. That raw static
failure remains retained; it was not a runtime test failure or outside defect.

## Remaining dependencies and validation

* Native invisible lazy data properties, exact getter/setter/descriptor,
  frozen/inherited/proxy/realm/cache-error metadata behavior.
* Guest Promise.withResolvers/handled-promise, async resource hooks, rejections,
  private AbortSignal/listener/disposal behavior, timer cancel/ref/shutdown,
  monotonic clock and integer origin/rounding under all hosts.
* Full CLI option activation and per-worker parsed-state ownership, ESM
  namespace updates/cache/load lifecycle and all audited util/URL/encoding/
  styling/inspection/stack/source-map/native error requirements.
* Compile identified native source within user build authorization, then run
  unchanged parser/control/timing/exit/worker coverage and native differentials
  on Node, Chromium, Firefox and WebKit. Keep all skips/unsupported/timeouts/
  harness failures visible. No overall suite or full product rebuild ran.

Move to other independent audited owners before expanding this subsystem's
validation campaign. No API/finding/family is marked complete by this slice.
