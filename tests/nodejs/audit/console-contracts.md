# Console public contracts

This is a complete source review of the `node:console` public module and
global console exposure, with concrete implementation gaps. It does not
complete the observability family or establish runtime conformance.
No tests, runtime probes or builds were run. Target: Node 26.13.0,
commit `18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.

The requirements artifact retains each full public-document section,
member/descriptor dispositions, source identities and unresolved questions.
Future unchanged tests are cataloged separately. Formatter, stream,
terminal and inspector prerequisites retain their own incomplete audits;
this review does not sign off those dependencies.

## Module, global, constructor and metadata

Target `lib/console.js` exports `internal/console/global`. Thus the module
is the global namespace object, which also owns `Console`; an object with
only `{Console, default: Console}` is not that namespace. The global
object has an extra empty object in its prototype chain, copies prototype
descriptors including symbols, binds methods to itself and exposes a
configurable `Symbol.toStringTag` of `console`.

`Console` is callable with or without `new`, accepts legacy positional
stream arguments or options, and requires stdout plus a write-capable
stderr (defaulting to stdout). It validates color mode, integer indentation
in 0–1000, inspect options and incompatible color choices. An inspect
options Map can assign distinct options per output stream; it is retained
by a WeakMap, not copied once as common options. Color mode auto is
evaluated against the actual stream and FORCE_COLOR environment.

`lib/internal/console/constructor.js:100–193` binds enumerable prototype
methods from the instance so subclass overrides participate, and names
each bound function after its property. Extracted methods retain their
receiver. Prototype method assignments are enumerable, unlike class
method declarations. The well-known `Symbol.hasInstance` consults a
private marker, allowing the global object to pass `instanceof Console`
without Console.prototype in its chain. Its own function/prototype
descriptor is a retained source-visible metadata requirement. Private
helper symbols are not independently supported public APIs; their
captured descriptors still reveal actual construction, receiver and
format/write behavior. Legacy `_stdout`, `_stderr`, `_ignoreErrors` and
`_times` observations are retained separately from public documentation.

Kandelo's class (`bootstrap.js:5856–5888`) instead defaults absent options
to process streams, ignores positional arguments and option validation,
stores `_out`/`_err`, and does not bind methods. Global console is created
by SpiderMonkey's `DefineConsole` (`js.cpp:14641–14653`) and patched at
bootstrap:6937–6984. Neither path constructs the target namespace,
prototype, symbols, callable constructor or bound-method metadata.
Shared CJS/ESM loader aliases/defaults cannot repair that wrong owner.

## Complete public operation review

| Public operation | Target requirement and owner | Kandelo observation |
|---|---|---|
| log/info/debug | stdout, newline and formatWithOptions; distinct diagnostics channels publish original argument array before formatting (`constructor.js:410–436`) | Class manually joins string/inspect results; module has no method. Global log/info/debug use shell Print, which performs ToString rather than util formatting |
| warn/error | Same formatting on stderr; distinct diagnostics channels (`438–452`) | Class catches write exceptions; global warn aliases fallback error but has no full formatting/options/diagnostics |
| assert | Truthiness; falsy emits formatted Assertion failed text via warn; no thrown assertion error; empty/nonstring message has distinct formatting (`479–491`) | Class/global always prepend a literal `Assertion failed:` argument; wrong empty-message punctuation/formatting |
| dir | inspect with options and custom inspection disabled by default (`454–460`); output to stdout | Ignores options and uses ordinary util.inspect, including custom hooks; class may inspect the inspected string again through writeLine |
| dirxml | Prototype alias to log, then independently bound on instances; no XML formatter (`680`) | Missing class and global method |
| trace | Formatted stderr message and actual stack excluding the trace wrapper via ErrorCaptureStackTrace (`470–477`) | Class prints literal Trace prefix without a stack; no global fallback |
| count | Per-instance Map, default only for undefined, template-string label coercion rejecting Symbol, increment/output plus trace counter (`505–517`) | Empty class method; global ordinary object has prototype-key collisions, truthy-default labels and no trace event |
| countReset | Delete existing count, warn if absent, trace zero (`520–528`) | Empty class method; global sets zero with no warning. Source checks Map.has before its later label coercion; preserve that target edge for control |
| group/groupCollapsed | Print labels at current indentation, then add configured width; alias source functions, later bound independently (`530–538,681`) | Empty class methods. Global increments unused depth; does not indent and lacks groupCollapsed |
| groupEnd | Remove one indentation step; apply indentation to every output line (`540–550,286–299`) | Empty class method; global depth has no output effect |
| time | Unique per-instance label, monotonic hrtime start, duplicate warning and trace begin; coercion preserves empty/zero labels | Empty class method; global wall-clock ordinary object overwrites duplicate starts and uses truthy defaults |
| timeLog | Elapsed time without removing timer, human-readable units, additional formatted data, missing-label warning, trace instant | Empty class method; global prints wall-clock milliseconds, no additional data/warning/trace |
| timeEnd | Log elapsed time, remove label, trace end, appropriate unit formatting and missing-label behavior | Empty class method; global substitutes current time for absent/falsy stored starts |
| table | Validate properties array; primitive fallback; real object/array/typed-array/Map/Set/iterator rows and columns, bounded cell inspection, Unicode-width box drawing (`552–669`, `internal/cli_table.js`) | Class/global simply log the input; properties ignored and no table renderer |
| clear | No output for non-TTY or TERM=dumb; otherwise cursorTo(0,0) and clearScreenDown on actual stdout (`494–503`) | Empty class method; missing global fallback despite guest terminal/ANSI helper capability |
| profile/profileEnd/timeStamp | Inspector-only visible methods; real CPU profile and timeline integration when inspector is active; silent output when inactive | No class/global implementation or inspector bridge. Target installs these on global namespace through VM inspector; they are not ordinary Console.prototype methods |

“Alias” in docs does not always mean strict identity: info/debug/warn have
separate source functions and separate diagnostics channels. dirxml/log
and groupCollapsed/group share prototype functions, but binding creates
separate instance/global function objects. The audit records those exact
levels instead of adding a false strict-equality requirement.

Timers delegate to `lib/internal/util/debuglog.js:174–340`: formatting
switches among milliseconds, seconds and longer durations; trace label
escaping and tracing flags are separate from display. They use the real
hrtime source. Kandelo has an existing native monotonic clock, so the
global wall-clock timer fallback is an implementation gap. Its public
hrtime facade is itself an observability prerequisite, not signed off.

## Stream errors, output bytes and lifecycle

Target write path (`constructor.js:280–323,392–407`) adds group indentation
to each embedded newline and a final newline. With ignoreErrors=false,
the actual stream write error propagates. With ignoreErrors=true it
handles both synchronous throws and asynchronous write callbacks/events,
temporarily registers/removes an error listener and preserves stack
overflow errors. It does not unconditionally swallow every error.
Formatting, option getters and diagnostics publication occur outside that
write-error catch. Console does not own/close the supplied streams or
promise that every stream writes synchronously; process I/O and Writable
ownership govern completion and shutdown.

Kandelo writeLine catches the entire formatting/write operation and omits
the callback/error-listener path. This can suppress user coercion or
inspection errors as well as write errors. Its default stdio object
(`bootstrap.js:1695–1758`) synchronously puts/flushes strings, calls back
immediately and always reports true; a typed-array write discards the
native byte count. That path is a partial stream facade, not a universal
Console requirement. A correct Console cannot compensate for missing
Writable/stdio backpressure or error semantics by claiming success.

Global log takes another path: frozen shell source `PrintInternal` at
`js.cpp:7250–7274` converts each value with JS::ToString and prints UTF-8
through `%s`, followed by newline/fflush. Embedded NUL truncates each
argument at that C-string boundary. Class and fallback stderr string
output use stdio helpers instead; the global log path is neither the
class formatter nor a call to process.stdout.write. This is **O-017**,
a concrete source byte/format/ownership discrepancy, not a measured run.

The underlying libc write/syscall/runtime fd path has real guest
descriptors, pipes/TTYs and host I/O (`sys_write` at
`crates/runtime-core/src/syscalls.rs:6372` onward). The facade bypasses
its short-write/error reporting rather than lacking every output device.
Current source review does not assert complete lower I/O conformance.

## Inspector additions and source-discovered contracts

`internal/util/inspector.js:83–102` wraps shared Node methods with the VM
console and adds VM-only methods. Native `InspectorConsoleCall` at
`src/inspector_js_api.cc:193–219` invokes active inspector behavior with a
recursion guard before the Node method. It does not replace normal output
with debug output. Snapshot reconstruction preserves those extra methods.

The saved native namespace also exposes undocumented `context` and
`createTask`. They remain source-discovered observations, not invented
Console.prototype methods. V8 `builtins-console.cc:264–315` constructs a
distinct named/context-ID console with VM methods, not a Node stream
logger. `deps/v8/src/inspector/v8-console.cc:494–627,846–856` validates
nonempty task names, returns a branded task with run(callback), preserves
callback result/throw and pairs async task start/finish; weak cleanup
cancels the scheduled task. These are absent guest capabilities and need
an explicit later API-scope/engine mapping decision. No blanket V8
exclusion is applied to portable console logging or profiling behavior.

**O-018:** Constructor callable/binding/subclass/descriptor/hasInstance
behavior is missing in addition to overload and namespace gaps O-004–005.
**O-019:** Ignore-errors state, async write-error ownership, formatting
error propagation and stack-overflow behavior differ (extends O-006).
O-007 also covers the actual stateful controls and conditional inspector
producers; missing generic state is not a browser boundary.

## Host differences, evidence and later controls

All four outer hosts execute the common guest Console/global code. Their
guest fd/terminal backends and scheduling differ; the outer browser or
Node console is not the guest console. No current candidate four-host
evidence exists. Historical suite statuses remain in the durable evidence
archive and cannot establish current constructor/formatter correctness.

Later unchanged tests must preserve message expected-output files,
console fixtures, pseudo-TTY behavior, real stream/child-process cases,
inspector activation and trace/diagnostics assertions. Catalog inclusion
does not prove all those prerequisites or assertion coverage.

Native controls should separately inspect module/global/ESM identity,
own/prototype/symbol descriptors, callable/new/subclass/extracted methods,
semantic aliases, stream option Maps and mutations, error/overflow/async
cleanup, embedded NUL/Unicode, custom-inspect side effects, all formatting
specifiers, per-instance counters/timers/groups, label coercion/warnings,
terminal branches, table shapes/non-consuming iterator inspection,
diagnostics events and active/inactive inspector task/profile lifecycle.
CountReset coercion, inspector extension applicability, partial I/O and
error propagation remain explicit later controls. They are not authorized
to run in this audit phase.
