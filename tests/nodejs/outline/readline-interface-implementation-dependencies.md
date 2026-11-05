# Readline interface input and lifecycle source owners

T-004/005/011/013/016 now have shared callback/promise interface, key decoder
and history source owners. The exact Node 26.13.0 pin and frozen audit remain
unchanged. No terminal-family finding or four-host conformance closes.

## Actual source and dependency ownership

readline-platform-adapter.js loads the full unchanged lib/readline.js,
readline/promises.js, internal/readline/interface.js, utils.js,
emitKeypressEvents.js and internal/repl/history.js from hash-checked target
inputs. Existing callback cursor/transaction modules remain shared imports.
The private module cache claims before evaluation, preserves circular
exports/symbol/class identity and retires failed evaluation entries. Factory
lookup has no Object.prototype inheritance. Callback readline.promises and
the separate promises builtin select the same actual module owner.

Bootstrap replaces the no-input EventEmitter facade, immediate empty answer
and no-op prompt methods with these actual constructors and state machines.
Input/data/end/error/keypress/resize listeners, decoder state, CRLF/time policy,
Unicode line separators, question/prompt/abort state, editing/history, pause/
resume and close now have retained source owners. Iterator error/backpressure
and return policy uses the actual EventEmitter.on owner and its private
kFirstEventParam symbol. Returning an iterator does not itself close the
interface; this follows exact source/native behavior rather than conflicting
readline prose. Constructor/legacy/inherited/symbol contracts come from the
retained public/shared classes, not new export-shaped placeholders.

The guest path selects actual existing candidate streams, StringDecoder,
EventEmitter/event/abort helpers, timer facade, filesystem/path/OS and
inspection owners. Internal event symbols are imported from the same event
module cache used by installed helpers. The timer dependency is the real
guest timers object, not the embedding host or raw global timer API.
StringDecoder retains its byte-boundary state; line parsing does not invent
EOF, answers or successful shutdown of another resource.

Native TTY/raw-mode, width and persistent REPL owners remain distinct. The
existing inspection no-ICU fallback is selected by the current guest source,
which is not evidence for complete ICU/emoji/display-column behavior.
Persistent history does not infer a Node permission policy from the mutable
public process.permission property: its missing policy owner explicitly
throws ERR_METHOD_NOT_IMPLEMENTED when activation reaches that dependency.
History arrays/navigation are real; persistent history and the REPL namespace
are not thereby implemented. Those are implementation gaps, not accepted
browser/platform boundaries.

Recipe revision 51 binds the changed generated bundle/bootstrap source.
There are no native engine patches, new host imports, syscalls or wire ABI
changes in this slice. Node/Chromium/Firefox/WebKit select the same source,
but none has current rebuilt guest validation for it.

## Evidence and limits

Eight new interface controls and six existing cursor/transaction/isatty
controls pass. They exercise actual retained interface/key/history and
candidate StringDecoder source over explicit native Node event/stream/
Buffer/TextDecoder/timer/width/fs/permission boundaries. Ordinary input,
EOF and close-once, question/abort, iterator-return, pause/resume/error and
controlled ASCII editing/history traces match the exact native reference.
The terminal-like stream records setRawMode calls; it is not a real guest
PTY or termios test. Native width controls do not validate the guest fallback.

Four unchanged upstream files pass in candidate/native modes: line separators,
CRLF across chunks, keypress decoding and input-error delivery. Only CJS
readline builtin objects are selected by the preload. All other engine,
stream/event/native dependencies remain reference controls; no assertions,
platform identity or test inventory is changed. TERM is explicitly selected
for the fixture rather than inherited accidentally.

The first run's fourteen raw failed tests are retained: the fork worker
configuration replaced the invoking node flags and omitted the internal
dependency-control flag. The scoped core config now carries it explicitly.
The next run's CJS-versus-ESM namespace default/interop assertion mismatch is
also retained; the intended CJS export comparison now uses a CJS reference.
This does not establish ESM loader namespace conformance. Later passing
repetitions are not added as new API coverage.

## Remaining work and subsequent validation

Real stdin/stdout TTY descriptors, ReadStream/WriteStream classes, termios
raw/restore, terminal resize/geometry and POSIX signal/job control need owning
platform implementation and native PTY controls. ICU/Unicode width and
editing/combining/emoji/ambiguous-character behavior need actual guest evidence.
Permissions/persistent-history files, shutdown/flush failures and actual REPL
evaluation/history/completion/context/CLI state remain incomplete.

Guest stream/decoder/event/tick/abort integration, iterator watermarks/errors,
prompt reentrancy/concurrent/closed questions, callback exceptions, native
descriptors/symbols/brands and listener/GC/realm/resource retirement remain
unvalidated or dependent on other partial owners. Source import is not proof
of those behaviors. Later validation should include the full unchanged
readline interface/promises/iterator/TTY suites, pseudo-tty tests and actual
rebuilt guest artifacts across all four hosts. No overall suite or product
rebuild ran. Continue independent audited source owners before expanding
this terminal-specific campaign.
