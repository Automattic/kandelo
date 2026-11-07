# Borrowed stdio output TTY methods and geometry

This bounded slice installs the exact pinned Node v26.13.0 output methods
from lib/tty.js on the existing borrowed stdout/stderr FD Writable. It does
not turn that Writable into a complete public net.Socket/tty.WriteStream.
Public TTY constructors, actual native TTY I/O-handle adoption/reopening and
inherited identity remain implementation gaps.

Binding first uses real isatty; pipes/files do not acquire TTY fields or
methods. Columns/rows are writable enumerable data fields initialized only
from successful actual TIOCGWINSZ. getWindowSize returns cached current
fields. _refreshSize queries the actual borrowed fd, preserves fields and
emits the actual errno on failure, and updates/emits resize only when the
measured dimensions change. The sole reviewed source seam replaces native
_handle.getWindowSize with the existing native OS tty-size packet; no fake
_handle or default dimensions are provided. Color policy reuses the existing
unchanged internal/tty module. Cursor helpers use the existing actual lazy
readline module and preserve its validation, write result and callback path.

No new fd is adopted, closed, duplicated or reflagged. Existing stdio
Writable destruction retains its borrowed process descriptor. The private
output binding is weak and does not manufacture a native stream owner.
Refreshing from signal consumers checks that binding, rather than trusting a
mutable public isTTY flag. Signal registration, masks, activation and delivery
remain a separate owner and were not implemented or validated here.

Real native PTY controls retain one nonpassing backend finding: on POSIX
native stdout's blocking TTY write can finish synchronously and return true
at HWM=1, whereas the current genuine asynchronous fd Writable returns false.
The cursor methods correctly expose that difference. Same-real-asynchronous-
Writable delegation returns false identically; no result override or fake
queue size fixes the missing blocking TTY backend. A synchronous filesystem
syscall exists, but does not alone provide the required descriptor/OFD flag,
reopening, write-completion and close ownership. The full TTY I/O handle is
still necessary; source implementation here is not complete TTY compatibility.

Public methods' prototype location/Socket inheritance, generic borrowing of
_refreshSize onto foreign native handles, fd reuse/adoption behavior, full
readline/REPL, drain/termios reset policy and actual guest engine/four-host
validation remain open. Component controls use an actual development-host
PTY and production WindowSize helper with explicit native stream/readline/
error/UTF8 dependencies. They do not establish guest ioctl/JSAPI behavior.


## Bounded native output owner follow-up

`OutputHandle` in terminal-operations.h now verifies a slave-terminal reopening,
keeps an extra owned fd and initializes the same public fd number on its new
open-file description. It selects actual blocking status without changing
stdin's old shared description. Native tty-output operations extend the existing
real terminal lease, and its finalization/environment cleanup closes only the
extra fd. Ordinary stdio dummyDestroy preserves the public fd and reusable
writer. The private transport callback follows a real full native write/error;
Writable owns callback scheduling and the observable HWM result. There is no
fabricated _handle, queue size or cursor return override.

The previously retained real-PTY HWM=1 assertion now passes in a separate native
component run using the actual production header and actual fd-stream factory:
12/12 original groups match the pinned native reference with identical bytes.
Seven additional native comparisons prove inherited stdin/stdout flag alias
isolation, continued writes to the captured TTY after public-fd reuse, exact
view offsets and closing only the extra descriptor. These are local native
POSIX/source components; the production SpiderMonkey JSAPI fragment and guest
Node/Chromium/Firefox/WebKit behavior remain uncompiled/unvalidated.

This is a bounded implementation. Guest /dev/tty can alias stdin; masters,
unavailable tty names or unsafe reopening retain the existing real borrowed
asynchronous transport and its blocking/backpressure gap. An externally changed
O_NONBLOCK or initially partial try-write needs real queued WriteWrap/async
resource ownership before full Node metadata/timing parity can be claimed.
The scalar owner preserves actual transfer/error counts, but it does not
establish complete native WriteWrap ordering. Its initial full blocking-write
path has no asynchronous outstanding fd work to keep alive or cancel. Complete
public Socket/TTY inheritance, TTYWRAP resource metadata/ref controls, close
callbacks, constructors, private SIGWINCH registration and termios/REPL behavior
remain independent. No kernel, libc, host or ABI contract is changed by this
compatibility/native-owner slice.
