# Public TTY contracts

Completed scoped source audit of `node:tty`, with implementation gaps.
The separate readline/REPL review now completes the remaining terminal
source requirements. Inherited Socket/stream implementation, integration
and runtime evidence remain distinct and incomplete. No runtime execution,
tests or builds were performed. Target Node 26.13.0, commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.

`tty-requirements.json` retains every documentation section, native
descriptor, source-discovered property and inherited-owner obligation.
Its catalog preserves unchanged future case identities and flags.

## Constructors, aliases, inherited owners and fd lifetime

The namespace has three exports: isatty, ReadStream and WriteStream.
Target lib/tty.js uses ordinary functions callable with or without new,
validates nonnegative signed-int32 descriptors and initializes a real
native TTY handle, raising ERR_INVALID_FD or ERR_TTY_INIT_FAILED through
the actual path. Constructor/prototype inheritance is net.Socket, not
generic Readable or Writable. Prototype-assigned functions have ordinary
enumerable/writable/configurable descriptors and retain normal Function
metadata. ReadStream installs own isRaw=false, rawMode=false, isTTY=true;
WriteStream inherits isTTY=true and installs dimensions only on successful
window-size retrieval.

ReadStream options spread **after** handle/manualStart/high-water-mark
defaults (`tty.js:70–75`); do not assume those defaults cannot be
overridden. The complete public inherited Socket/Duplex/stream/events
surface, getters, iterator/disposal symbols and constructors must use the
actual handle and brands. Requirements are retained by owning module in
the metadata, with those dependent implementation audits still open.

Target `src/tty_wrap.cc` connects JS to LibuvStreamWrap/TTYWRAP, native
errors, window ioctls and modes. POSIX `deps/uv/src/unix/tty.c:134–240`
inspects descriptor type/access flags, attempts to reopen a slave terminal,
dup2s the replacement over the original number and retains the new
descriptor as its stream owner. A fallback uses blocking writes; failures
restore applicable state. Therefore neither “always closes the supplied
fd” nor “always harmlessly duplicates it” is a sufficient lifetime model.
Close/reset must follow actual adopted/reopened descriptor ownership.
Target Windows native console initialization is a distinct platform
branch, not the required backend for Kandelo's POSIX guest.

Candidate registry bootstrap:5799–5803 exposes empty class extensions of
Readable/Writable. The fd is treated as a generic stream constructor
argument; no TTY handle, correct Socket hierarchy, callable constructor,
fd validation, fields or TTY methods are installed. Generic inherited
stream methods are real code, but do not make an empty fd wrapper a
terminal. These are T-002 and T-010, not accepted platform boundaries.

## Complete public member dispositions

| Member | Target requirement | Candidate |
|---|---|---|
| isatty | Number.isInteger, 0..2147483647 filter before native detection; invalid/non-TTY fd returns false, without coercing arbitrary input | Direct adapter os.isatty → shell ToInt32 → libc; wrong coercion/range/arity behavior (T-003) |
| ReadStream.isRaw/rawMode/isTTY | Initial false/false/true even if terminal initially raw; update only by actual successful mode operation | Missing public class fields; separate stdin facade only has boolean isRaw |
| ReadStream.setRawMode | false/default, raw, io; invalid strings ERR_INVALID_ARG_VALUE, other values truthiness; actual native error emits error and preserves old metadata; returns this | Absent class method; stdin adapter can do nothing while changing isRaw and cannot distinguish io (T-007) |
| WriteStream.isTTY | Inherited true on public instance | Missing |
| columns/rows/getWindowSize | Actual initial dimensions when successful, cached fields, returns current [columns,rows] | Absent class members; separate stdio fallback values are not measured size |
| resize/_refreshSize | Query real handle, emit native error on failure; only update/emit once dimensions change; no callback args | Missing class path; stdio's signal hook is inert through adapter os.signal (T-008) |
| cursorTo/moveCursor/clearLine/clearScreenDown | Delegate to public lazy readline module, real write boolean/backpressure and callback completion; target callback/NaN/coordinate validation | Absent class methods; plain stdout helpers discard return/callback scheduling and clamp/coerce positions (T-006) |
| getColorDepth | Target environment policy and explicit env overload, returns 1/4/8/24; FORCE_COLOR priority and warning, NO_COLOR/NODE_DISABLE_COLORS/TERM, CI/terminal detection | Missing class method; console internal color helpers do not install it |
| hasColors | Count/env overload, minimum integer count 2/default16, target getColorDepth result | Missing |

The full color policy is `lib/internal/tty.js`: FORCE_COLOR recognized
string values, ignored-disable warning once, guest platform Windows
branch, TMUX/Azure/CI/TeamCity/TERM_PROGRAM/truecolor/256/TERM/regex and
COLORTERM precedence. It intentionally supports an explicit env object;
those policy inputs are not a reason to spoof process.platform. Candidate
process.env inheritance/whitelisting is a separate process prerequisite.

Target raw mode maps to RAW_VT in JS and normalizes to raw on POSIX.
`uv_tty_set_mode` at tty.c:288–355 preserves original termios, drains
output before applying changes and changes recorded mode only on success.
Input raw mode disables canonical/echo/signal processing but retains
output processing; io applies cfmakeraw including output transformation
changes. Close/reset restores saved terminal state where the native
implementation owns it. A boolean-only no-op cannot implement this.

## Process stdio and real lower capabilities

Public manually constructed streams and process stdio have different
lifetime policies. Target bootstrap switches initialize TTY stdio through
these classes, pause stdin appropriately and prevent ordinary stdout/
stderr destruction from closing process descriptors. SIGWINCH handlers
call _refreshSize, and snapshot cleanup restores and detaches real owners
(`internal/bootstrap/switches/is_main_thread.js:130–283`).

Kandelo's independent stdio objects at bootstrap:1695–2008 instead have
handwritten listeners, immediate write callbacks/true returns, default
80×24 dimensions and cancellable native stdin reads. That real read path
does not provide Socket/TTY identity, raw state, backpressure or resize.
`adapter.js:352–355,594` forwards optional ttyGetWinSize/setRawMode but
the reviewed native registration/patch set provides neither operation.
The adapter function's existence is insufficient: it can silently return
without changing termios. Signal registration is an empty adapter method.

Libc isatty is real. Guest tcgetattr/tcsetattr, TIOCGWINSZ/TIOCSWINSZ,
PTYs, termios flags/line discipline and signal generation are real lower
facilities, traced in [terminal.md](terminal.md). Missing public/native
bridges are implementation gaps. The browser host's own OS console rules
must not replace guest POSIX terminal semantics. Rendering/input fixtures
still require later host-specific verification on all four hosts.

One lower-layer question is concrete: sys_tcsetattr validates TCSADRAIN
but applies termios through the same path as TCSANOW, with no distinct
output-drain wait at that owner. Whether pending output is possible at
the transition, and which owner must wait, remains a source/later-control
question; syscall presence alone does not prove the target drain contract.
TIOCGWINSZ also substitutes default dimensions if a PTY lookup fails;
reachability of that owner mismatch requires the PTY lifetime audit.
Neither observation is runtime evidence or a justified platform boundary.

## Evidence, open questions and later controls

No current-candidate runtime conformance is established. Historical
results keep original statuses/artifact identities. All four hosts share
the guest class/adapter gaps; that is a source inference, not a run.

Later unchanged pseudo-tty/parallel/message cases need real PTYs and
original input/output helpers, not pipe substitution or exit-status-only
assertions. Native controls should inspect namespace/constructor/prototype/
inherited/symbol metadata, invalid/coercible fd behavior, reopen/adopt/
close lifetimes, options overriding defaults, actual termios bytes and
false/raw/io restoration, callbacks/errors/backpressure, color option
precedence/warnings, dimensions and changed-only resize, and process stdio
destruction/cancellation/shutdown. These are proposed, unrun controls.

Full dependency semantics in Socket/streams/events, target POSIX fallback
branches for unusual/non-TTY descriptors, multi-handle termios reset and
host fixture ownership remain explicit questions. They do not turn the
missing TTY bridge into passing support or an engine limitation.
