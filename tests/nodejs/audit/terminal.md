# Terminal family source audit

State: **source review complete with gaps**. Public constructors, helpers and final stdio factories
were inspected against the pinned tty/readline source and documentation.
The implementation gaps below apply to the shared guest runtime on all
four hosts by source inference. No runtime validation was executed.

The scoped public [TTY contract review](tty-contracts.md) is now complete
with gaps. It retains every tty documentation/native descriptor obligation,
constructors/fields, inherited owners, POSIX fd reopen/mode/close behavior,
color/cursor/resize and stdio integration. The separate
[readline/REPL contract review](readline-repl-contracts.md) now completes
the full terminal source requirements, including all 243 original family
obligations. Shared Socket/stream/process/VM/loader implementation and
their family audits remain distinct; no current-candidate conformance is
established by this source completion.

## Source routes

- Public tty registry: `packages/registry/node-compat/bootstrap.js`:
  5799–5803. ReadStream/WriteStream are empty subclasses of generic
  Readable/Writable. They do not use their fd as an owned terminal handle.
- Public readline registry: bootstrap:5817–5830. createInterface returns
  an EventEmitter with a few ad-hoc methods; question writes to process
  stdout and immediately returns an empty answer through its callback.
- Public readline/promises and repl: no builtin registry entries. Their
  documented methods, inherited surfaces and instance lifecycle are absent
  through the public import path.
- Cursor helpers: bootstrap:1659–1693. Four readline exports share these
  functions, also used by the process stdout/stderr facades.
- Stdio factories: bootstrap:1695–1785 and 1809–2008. These are plain
  objects with independent listener maps, not the pinned stream/tty classes.
  The stdin path has real cancellable native descriptor reads, but that
  does not make the whole object a conforming ReadStream.
- SpiderMonkey adapter: `packages/registry/spidermonkey/node-compat/adapter.js`:
  352–355 and 594. isatty forwards to shell os; window size and raw mode
  are conditional calls whose required underlying methods are not added
  by the inspected package patches/native registration.

Pinned comparison owners are `lib/tty.js`,
`lib/internal/readline/callbacks.js`, `lib/readline.js`,
`lib/readline/promises.js`, `lib/internal/readline/interface.js`,
`lib/repl.js` and the corresponding public API documents.

## Concrete findings

| ID | Public requirement | Source observation | Owning prerequisites |
|---|---|---|---|
| T-002 | tty constructors and inherited socket behavior | Empty class bodies inherit generic Readable/Writable constructors, not Node's callable fd-based net.Socket/TTY wrappers. Required isTTY/isRaw/rawMode/columns/rows and TTY methods are not installed | Real fd validation/ownership, TTY native binding and socket/stream inheritance |
| T-003 | tty.isatty input contract | Public export directly uses adapter os.isatty. Native shell helper converts with ToInt32 before libc isatty, whereas pinned public tty.isatty first checks integer, nonnegative and int32 bounds | Public argument semantics, real underlying tty state; lower libc capability already exists |
| T-004 | readline interface input, options, events and shutdown | createInterface does not attach input or implement editing/history/completion, terminal mode, signals, pause/resume or line delivery. close merely emits close; repeated/lifetime behavior is not Node's interface state machine | Stream input ownership, actual terminal mode, key decoder, scheduler and cleanup |
| T-005 | readline.question and prompt methods | question ignores configured output/input/options and calls cb('') immediately. prompt/setPrompt are no-ops; getPrompt/write/getCursorPos, line/cursor state, async iterator and dispose are missing | Interface state machine, actual input/output and abortable question lifecycle |
| T-006 | Cursor helper completion/backpressure/validation | `_writeControl` discards stream.write's return and invokes cb immediately instead of passing it to the write. Helpers always return true, coerce positions with bitwise operations and do not implement pinned null-stream/NaN/callback validation | Writable completion and error policy, captured validators and exact control encoding |
| T-007 | tty raw and binary I/O modes | Public tty.ReadStream has no setRawMode. process.stdin's separate method coerces every input to boolean, updates isRaw after an optional native no-op and has no rawMode. Pinned Node 26 distinguishes false/'raw'/'io' and reports actual terminal-setting errors | Guest termios getter/setter, native binding, exact mode state and error delivery |
| T-008 | Terminal size and resize events | Stdio dimensions fall back to 80×24 when adapter's absent ttyGetWinSize returns null. SIGWINCH cache refresh registers through adapter os.signal, which is empty. Merely caching size does not observe actual changes | TIOCGWINSZ binding and actual signal delivery/resize lifecycle |
| T-009 | process stdio's inherited stream/EventEmitter behavior | Facades have independent hand-written listener maps; callbacks may run synchronously, writes always return true, stdin.read always null and unpipe returns without detaching a destination. This is not complete Writable/Readable or EventEmitter behavior | Pinned stream/event integration, fd read/write scheduling and process-specific end rules |
| T-010 | tty.WriteStream color, dimensions, control and resize methods | getColorDepth/hasColors/getWindowSize and TTY-specific output methods are absent from public class. Similar methods on a plain process.stdout object do not implement the public class | TTY handle, environment/color policy, terminal dimensions and descriptors |
| T-011 | readline/promises | Entire public namespace missing, including promise question, transactional Readline actions, commit/rollback and inherited interface methods | Real callback/shared interface, write completion and cancellation |
| T-012 | repl | Public REPLServer/start/builtinModules/Recoverable and evaluation, context, completion/history/commands are absent. A shell's interactive evaluator is not the public node:repl implementation | Readline, module loading, VM contexts, diagnostics and actual terminal I/O |
| T-013 | Target iterator and signal questions | Target source uses EventEmitter.on with error delivery and no emitter.close on return, unlike readline prose. Ctrl-C default close differs from pause prose | Preserve exact native controls, not a guessed candidate-only defect |
| T-014 | REPL error ownership | Target uses ALS/additive process exception capture, retains a nested listener guard and active-domain interaction, while old/new prose differs. Candidate has no REPL or additive capture bridge | Actual per-session context and process fatal/capture/VM state |
| T-015 | Target history questions | Nonterminal history initialization and error callback prose differ from actual owner paths; flush/replacement/close cases need controls | Real guest history/FileHandle/permission and lifetime owner |
| T-016 | Full namespace/inherited/legacy metadata | Callback Interface, promises identity, inherited base, legacy proxies, function metadata, REPL mode/parser/writer/getter state are missing or wrong | Actual constructors and owners, not export-shaped placeholders |
| T-017 | Standalone Node REPL | No Node interactive-entry/history/environment/eval/exit integration; shell evaluator is a separate API | CLI selection, actual guest input/VM/loader/process state |

T-001 in the family survey records the initial placeholder discovery.
This review traces that finding past the export to the actual lower-layer
capabilities. No missing API above has an accepted engine/platform
exclusion.

## Native, libc and kernel capability

`0012-kandelo-node-compat-shell-entry.patch` defines shell os_isatty and
registers it on the shell OS object. The adapter correctly reaches an
actual libc isatty operation when that helper is present. Its ToInt32
conversion is not the same as Node's public range/type filter.

The inspected SpiderMonkey native source/patch set contains no
setRawMode or ttyGetWinSize registration. The adapter's raw-mode function
exists regardless, so bootstrap's typeof check succeeds and the optional
native call can do nothing while isRaw changes. The source comment naming
`node-native.c` refers to a different implementation route; it does not
establish a SpiderMonkey binding.

Lower-layer terminal support is present:

- `crates/runtime-core/src/syscalls.rs`:17211–17270 implements actual
  tcgetattr/tcsetattr against terminal or PTY state, including action,
  descriptor and exact-buffer validation.
- The same file's ioctl path at 17847 implements TIOCGWINSZ and adjacent
  code implements TIOCSWINSZ using actual guest terminal dimensions.
- `crates/runtime-core/src/terminal.rs` owns termios flags, input line
  discipline, signal-character handling, echo and mode transitions.
- `crates/runtime-core/src/pty.rs` owns guest PTY pairs.

Therefore the absent JavaScript/native TTY bridge must not be labeled
"browsers cannot support terminals." All four hosts run the same guest
terminal model. Browser terminal rendering/input and Node host fixtures
still need their own end-to-end source/fixture review; no runtime parity
claim follows from the common kernel.

## Descriptors, inherited APIs and lifecycle

The TTY scoped review now accounts for its public properties/symbols, callable
legacy constructors, net.Socket inheritance, process-specific stdio end
rules, per-fd ownership, encoding, ref/unref, read cancellation and terminal
reset at exit. Public tty class absence of behavior and stdio's independent
facades are separate gaps. In particular, real stdin read cancellation
does not prove raw mode, output backpressure, correct resize notification
or readline question semantics.

Inherited implementation semantics remain assigned to Socket/stream/event
owners rather than treated as passing because of a class declaration.
The scoped review also retains lower questions about TCSADRAIN's absent
distinct wait at sys_tcsetattr and default-size fallback on a failed PTY
lookup. Their reachability/lifetime consequences are not runtime findings.

The detailed readline/REPL review now includes required keybindings and
narrative behavior outside method headings, inherited and legacy aliases,
REPL environment/history/standalone distinctions, validation/error order,
Promise cursor transactions and actual exception/context ownership.
Unresolved target questions remain explicitly T-013–T-015; they require
later native controls, not unauthorized execution during the audit.

## Proposed later validation, not executed

Use unchanged parallel readline/REPL tests and the actual pseudo-tty suite
launcher, not a pipe substituted for a terminal. The pinned tree contains
`test/pseudo-tty/test-tty-stream-constructors.js`,
`test-tty-stdout-resize.js`, `test-tty-isatty.js`,
`test-tty-color-support.js`, `test-tty-stdin-end.js` and
`test-tty-stdout-end.js`, with expected-output companions where supplied.
The pummel REPL paste case and known-issues REPL context case need their
own category/applicability review.

Native controls should compare real termios before/after false/'raw'/'io',
input bytes and signal generation, terminal size mutation and resize
events, invalid/closed/non-TTY descriptors, helper write return/callback
ordering, and actual question input/abort/close. Retain native reference
identity and separate outcomes for Node, Chromium, Firefox and WebKit.
No such new execution is authorized under the audit-only goal.
