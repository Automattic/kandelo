# Readline, promise transactions and REPL contracts

Completed source review of node:readline, node:readline/promises and
node:repl, including their inherited/returned interfaces and narrative
keybindings, commands, CLI and history requirements. Target Node 26.13.0,
source commit `18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.
No runtime tests, probes, compilations or builds were run. Source completion
records missing and partial behavior; it does not certify these modules.

## Final owners and exposure

Candidate bootstrap:5817–5830 exports only createInterface and four cursor
helpers. The factory returns a real EventEmitter with ad-hoc close,
question, prompt and setPrompt properties. It does not read its options,
attach input, instantiate an Interface, retain prompt state or own output.
question writes to process.stdout and synchronously calls cb(''); close
emits close on every call. Its inherited EventEmitter implementation is
real and separately audited, but it is the wrong constructor/prototype
and has no interface state/input/lifetime integration.

There is no public readline.Interface, emitKeypressEvents or promises
property. node:readline/promises and node:repl have no public factory.
Their methods are missing even if their policy names or an interactive
SpiderMonkey shell exist. Source loading/default/named export behavior
remains a separate loader dependency; a namespace entry would not implement
these contracts. **T-016** records the wrong constructor/inheritance and
function metadata: target createInterface is an ordinary four-argument
function; candidate is a one-argument object method. Cursor exports retain
their underscored local function names instead of target names.

Target public readline exports Interface, createInterface, four cursor
helpers, emitKeypressEvents and promises. The promises object is the same
module as readline/promises, which exports Interface, Readline and
createInterface. InterfaceConstructor is the documented shared inherited
base, not an additional own namespace constructor. Target callback
Interface is callable with or without new; promise Interface is a class.
REPLServer is a class requiring new, while start forwards both options
and retained positional arguments to a new instance.

## Interface construction, options and state

Target lib/readline.js and internal/readline/interface.js:162–390 support
input/output/completer/terminal positional arguments or an options object.
The callback wrapper adapts a synchronous completer by its arity, including
mutation of options.completer on the options-object path. The promise
interface awaits its completer instead. Option getters/validation occur
before and during actual state setup; no blanket universal brand or
validation order can replace the source path.

Required state includes actual input/output ownership, terminal selection
from explicit option or output.isTTY, prompt, UTF-8 decoder, line/cursor,
CRLF delay (minimum 100, Infinity allowed), escape timeout (finite option,
500 default), positive uint32 tabSize (8 default), history defaults and
abort listener. History is a real ReplHistory owner with configurable
per-instance enumerable history/historyIndex/historySize/isFlushing
accessors, not just an array-shaped property. Public columns is inherited
and reads output.columns or Infinity; line/cursor positions are distinct
from screen display width.

Construction subscribes to input error/end and either data or keypress;
terminal input sets raw mode and output resize refreshes display. It starts
input consumption immediately, before a later async iterator is requested.
Nonterminal input owns a StringDecoder and buffers partial UTF-8/lines;
end delivers an unfinished nonempty line before close. LF/CR/CRLF and the
source's Unicode line separators, chunk splits and elapsed CRLF delay
have actual state. Terminal input owns cursor/history/edit/undo/redo/kill
ring and multiline state. Candidate owns none of these (T-004/T-005).

The target also retains underscore method and accessor compatibility
explicitly in lib/readline.js:213–463. Those aliases route to the actual
shared algorithms; they are not evidence of separate implementations.
The matrix preserves those source/captured obligations and private symbols
as metadata, with private implementation details distinguished from public
and explicit backward-compatibility surfaces.

## Methods, events, cancellation and lifetime

| Contract | Actual target requirements and candidate disposition |
|---|---|
| close / Symbol.dispose | Close once, pause input, disable terminal raw mode, mark closed, emit close and detach owned input/error/end/keypress/resize/abort listeners. Dispose is a named wrapper calling close, not strict function identity. Candidate only repeatedly emits close |
| pause / resume | Operate on actual input, track paused state and emit events on transitions; closed interface throws ERR_USE_AFTER_CLOSE, already-in-state can return undefined. An entered data callback can still deliver subsequent lines |
| setPrompt / getPrompt / prompt | Retain actual prompt, resume when needed, preserve/reset cursor, refresh terminal or write configured output; absent output suppresses writes. setPrompt stores its argument and output validation can occur later; do not invent eager coercion |
| write | Feed the input state machine, with terminal key override and nonterminal decoder path; resume if paused and reject after close. This is not stream.write to stdout |
| line / cursor / getCursorPos | Actual current input, UTF-16 cursor and prompt+input screen rows/cols, stripping VT codes and accounting for tabs, width/wrap and multiline prefixes |
| callback question | Query becomes temporary prompt, wait for next line, answer-only callback, restore prior prompt, reject use after close; another active question prompts again rather than replacing it. Abort uses protected one-shot listener and cancellation cleanup |
| promisify.custom question | Distinct Promise wrapper, rejection with AbortError/cause, actual question/cancellation and option lookup paths; not the callback-as-Node-style-error convention |
| promise question | Actual Promise executor, protected signal listener, preabort/error rejection, stored rejection route for terminal Ctrl-C/D and answer cleanup; module missing |
| close/error/line/history/pause/resume events | Actual stream/error/input/history transitions; history listeners can mutate the retained array before persistence. The fact an EventEmitter can emit these strings is insufficient |
| SIGINT/SIGTSTP/SIGCONT | Terminal key decoding, listener override/default close or POSIX stop, guest process signal handling, resume/raw-mode/display restoration and cleanup; Windows exclusions are target platform branches, not guest host identity |
| async iterator | Target caches EventEmitter.on(line) iterator, first-argument values, close event, high watermark 1024 and actual inherited AsyncIterator/disposal behavior; candidate has no method |

**T-013 — target iterator/event disagreements:** readline.md says input
errors are not forwarded and iterator break/return calls rl.close. Target
interface.js:1586–1597 directly returns EventEmitter.on(this, 'line',
{close:['close'], highWaterMark:1024, privateFirstArgument:true}). Actual
events.js:1192–1241 installs an error listener and its iterator return only
removes listeners/finishes waiters; it does not call emitter.close. Preserve
native controls for actual iteration/error/input lifetime before resolving
the prose. Similarly readline's SIGINT prose describes pause while its
actual Ctrl-C-without-listener branch closes and may reject the current
promise question. These are target questions, separate from the candidate's
definite absent implementation.

emitKeypressEvents is a real UTF-8/code-point escape generator over a
Readable. It lazily attaches data while keypress listeners exist, uses
escapeCodeTimeout for ambiguous trailing ESC, restarts the generator after
a throwing keypress handler, and suppresses completion during paste until
the final character. Closing one interface does not uninstall the stream's
independent decoder. TTY callers must provide raw input; all Readables do
not have to be TTYs. Candidate export and decoder integration are missing.

The full TTY key table is preserved in the requirements artifact. Source
key handling covers insert/delete/word/line movement, Ctrl-C/D/Z, history
and substring search, tab completion, kill/yank/yank-pop, undo/redo and
multiline movement. Target helpers move by code point and display width;
their own combining-character limitation is not permission to invent a
better or different target contract. Terminal escape encoding and actual
guest signals must stay distinct from browser shortcut interception.

## Cursor helpers and Promise transactions

T-006 is confirmed against internal/readline/callbacks.js. Target helpers
validate callbacks, return stream.write's backpressure boolean and pass
the callback to that write. Null streams/no-op movement schedule callbacks
on nextTick with null, returning true. cursorTo explicitly rejects NaN
and missing x with numeric y, and formats original number values rather
than clamping/bitwise truncation. moveCursor uses actual signs and avoids
writing when no displacement. clearLine chooses direction by sign, not
strict integer validation.

Candidate _writeControl discards write return, invokes callback immediately
without null and returns true. cursorTo clamps/coerces with bitwise math,
helpers write to null streams and even empty moves issue a write. Its extra
clearLine(stream, callback) overload is not in the pinned helper algorithm.
These are wrong dependency/observable behaviors even before the stdio
facades' independent stream gaps.

Promise Readline is a separate private-field branded transaction object,
not an input Interface. It requires an actually writable stream (TTY prose
does not mean the source enforces isTTY), optional boolean autoCommit,
integer positions/displacements and clear direction -1..1. Action methods
return this and accumulate ordered CSI strings. autoCommit schedules writes
on nextTick, not synchronously. rollback discards pending actions and
returns this; commit writes even an empty joined queue, clears it and
returns a Promise fulfilled from the write callback. Source promise/error
behavior follows that callback/executor; do not add an invented rollback
or rejection policy without native evidence. All this is missing (T-011).

## REPL evaluation, metadata and public state

REPLServer inherits the actual callback readline Interface and owns
context, input/output, eval/writer/completer, command dictionary, buffered
multiline/editor state, terminal/history and per-session errors/results.
start accepts options or a prompt string/legacy positional arguments.
Required options include terminal/useColors/useGlobal/ignoreUndefined,
strict/sloppy mode symbols, eval/writer/completer, breakEvalOnSigint,
preview and synchronous handleError. Custom eval plus breakEvalOnSigint
is rejected; removed options.domain is rejected. Input/output legacy stream
aliases have actual configurable nonenumerable getters/setters and pending
deprecation behavior.

Namespace also exports writer with mutable options, Recoverable extending
SyntaxError with .err, REPL_MODE_SLOPPY/STRICT symbols and source-discovered
isValidSyntax. The latter parses both input and an expression assignment
using the target Acorn parser with await-outside-function enabled, returning
a boolean. builtinModules and legacy _builtinLibs are nonenumerable
configurable getter/setters sharing a mutable internal value, with warning
policy under pending-deprecation; they are not static snapshots of the
entire module builtin list. **T-016** retains this namespace/returned and
inherited metadata beyond the incomplete saved native capture.

The default evaluator creates actual VM scripts/contexts and resource names,
handles object-literal wrapping, strict mode, recoverable multiline syntax,
top-level await transformation and dynamic import resolution relative to
guest cwd. It pauses/buffers input during async evaluation, restores
terminal mode after SIGINT-watched evaluation and resumes in finally.
VM interruption, parser/module graph and context isolation are owning
engine/loader prerequisites, not a justification to replace eval with
echo or the shell REPL. Candidate public module is wholly missing (T-012).

createContext/resetContext construct actual globals or an independent VM
context, module/require paths and lazy builtins, reset lines/context and
emit reset. `_`/`_error` track the last result/error until explicitly assigned;
their accessors and diagnostic output have real state. displayPrompt and
setPrompt distinguish initial and continuation prompts; clearBufferedCommand
changes pending source. defineCommand accepts a function or validates an
action object, invokes it with the REPL receiver and string remainder.
Default .break/.clear/.exit/.help/.save/.load/.editor and reverse-i-search
must use actual context/files/input/output/command state, including editor
availability only in terminal mode. Public custom writer and shared
writer.options control real inspect output, not fixed successful text.

**T-014 — target error-routing disagreement:** old REPL prose says a domain
owns every session and forbids process exception capture; newer prose says
uncaughtException listeners are freely usable. Source repl.js:180–232 uses
AsyncLocalStorage plus process.addUncaughtExceptionCaptureCallback, while
its process newListener guard still rejects uncaughtException registration
inside an active nested REPL context. Runtime eval also preserves an
explicit active process.domain error-listener branch. The actual primary
prerequisites are ALS, additive process capture, fatal routing, VM and
correct callback lifetime; importing node:domain alone is insufficient.
Candidate has no additive process capture implementation and general fatal
handling remains A-014. Resolve target source/prose disagreements later;
do not implement obsolete domain assumptions based solely on the prose.

## History, shutdown and CLI

setupHistory accepts a legacy path or config with filePath/size/duplicates/
callback. The actual ReplHistory owner trims paths, resolves the guest home
directory, checks write permission, opens files with owner-only mode,
loads/merges history already entered during async reads, truncates/writes
through real FileHandles, debounces writes and closes on exit. REPL close
waits for a pending flush/handle close before calling the inherited close;
an exit event and a closed UI attachment are not interchangeable lifetimes.
Multi-session history/context/capture state must remain per owner.

**T-015 — target history questions:** docs say history initialization is
terminal-only; actual InterfaceConstructor creates ReplHistory and validates
history even outside that branch. setupHistory's documented error callback
contrasts with error paths that print and call onReadyCallback(null, ctx).
Repeated setup/replaced owners, erroring writes and exact close/flush
delivery remain native controls, rather than assumed Kandelo-only defects.

Standalone entry source internal/main/repl.js and internal/repl.js supplies
interactive/no-main/TTY selection, -i with eval, external module override,
input-type rejection, global context, SIGINT handling and actual exit.
NODE_REPL_HISTORY is trimmed, empty disables persistence; history size
uses positive Number input or default 1000; mode and NODE_NO_READLINE
change actual selection. Programmatic defaults and standalone defaults
are different. **T-017** records the missing guest Node CLI/REPL integration;
the SpiderMonkey shell's interactive evaluator is not this entry path.

## Layers, four hosts and evidence

The TTY report traces libc termios/ioctl, guest kernel terminal/PTY state,
native fd ownership and missing SpiderMonkey bindings. Additional host
trace: node-kernel-host.ts:604–611 and browser-kernel-host.ts:1443–1450 send
PTY bytes/resizes to the common kernel worker; kernel-worker.ts:7690 onward
stages bounded exact bytes into kernel_pty_master_write and drains wakeups.
LiveKernelHost.attachPty retains session identity and routes actual bytes/
dimensions; browser PtyTerminal wires xterm input/output/resize. Headless
Node callers can feed bytes through the same PTY contract. None substitutes
for a missing guest readline parser or Node TTY class.

Browser-reserved key gestures and terminal escape encodings require actual
host/fixture evidence; equivalent input bytes can still test the guest
algorithm. No blanket browser exclusion has been accepted. Node, Chromium,
Firefox and WebKit share the missing modules/facade source; outer scheduling,
signals/input gestures, memory and worker teardown need separate evidence.

Existing reports in existing-evidence.json/historical-evidence-index.json
retain exact source/artifact identities and statuses. They predate this
unbuilt source candidate. The initial per-host baseline's common helper
failures cannot establish readline body behavior; no new current-candidate
or native conformance evidence was created here.

The future catalog records unchanged upstream file hashes/Flags/Env and
available pseudo-TTY input/output companions. Launchers need actual PTY,
message output, GC/signals/VM/native fixtures, pummel and known-issue policy;
file counts are not subtest/assertion coverage. Proposed native/four-host
controls include invalid/getter/overload/descriptor/alias behavior, streaming
UTF-8/newlines, actual input/output/backpressure, prompt/abort/close races,
iterator error/break lifetime, terminal edits/keybindings, history persistence/
permissions/failure/teardown, multiple contexts, eval/await/SIGINT/commands,
writer and CLI environment. Preserve every skip, unsupported, timeout and
harness error. Execution and fixes require later explicit authorization.
