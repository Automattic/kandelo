# Early real Socket/TTY constructor ownership for stdio

The current captured process streams are genuine native fd/TTY consumers, but
they are generic Readable/Writable objects. Giving them a public TTY prototype
would not execute tty.ReadStream/WriteStream or net.Socket receiver initialization
and would spoof identity. This slice deliberately does not do that.

## Concrete startup prerequisite implemented

Diagnostics first demands process.stderr while the original bootstrap has not
yet initialized the actual public net.Socket or the lazy TTY module cache. The
real Socket implementation now lives in one hoisted factory and is instantiated
once after actual streams/socket bindings/terminal fd adapters are ready, before
that early stdio demand. The factory body is byte-identical to the previous
module IIFE. Its existing Socket/Server classes, private receiver→native-owner
maps, callable constructor/actual receiver init and method consumers are reused;
no second constructor, transport, provider, fd or facade is introduced.

The IP representation owner is initialized at that same earlier boundary; it
has no resolver/descriptor effects. Existing diagnostics producer registration,
Symbol/WeakMap/WeakSet allocations, Socket option/prototype installation, actual
stream state getter and Server constructor installation are the eager factory
operations. Their dependencies are already initialized at this boundary.
Dialing, DNS lookup, accepted-socket and listening operations remain method/
closure consumers. They do not run while the module is instantiated. The shared
dialer binding is initialized before the factory's real assignment, avoiding a
TDZ. Real address-rule getters, net.Stream alias, DNS/performance/datagram and
TLS owners are still installed later as before.

The public TTY module now has one lazy cache/getter initialized before early
stdio. The real builtin tty getter consumes it; it still evaluates the same
unchanged pinned tty.js over that one actual net.Socket and genuine native TTY
constructor. It does not eagerly construct a TTY, acquire an fd, change raw/
window/blocking/ref modes or duplicate ownership. Readline remains its existing
real lazy dependency, not a replacement implementation.

## Why full captured stdio conversion stays held

The actual process getters continue their current retained stdio paths in this
slice. A follow-on can select real new tty.WriteStream/ReadStream for actual TTY
fds once it also owns the complete publication transaction. It must not first
capture an extra native TTY and then invoke a second public constructor, nor
manufacture an internal constructor flag that returns a preexisting object.
The target new TTY → actual Socket.call(receiver) algorithm must be consumed.

After construction, process stdout/stderr apply the pinned dummy _destroy policy
so the borrowed fd remains open; signal subscription is published in target
order and cache is visible before newListener reentry. If property binding or
SIGWINCH admission throws, cleanup must reach the actual private receiver's
retained native owner, not a mutable public _handle. Net already owns that map;
a bounded internal retirement/admission seam should be added there rather than
closing a guessed fd or copying public metadata. Constructor/init failure,
retained hook resources and a not-returned public receiver also require explicit
publication ownership or exact target GC policy, not an invented synchronous
close result. Existing captured-output rollback cannot simply be reused after
constructing a different public stream with different ownership.

Stdin must use its real public constructor, establish paused readStop and the
pinned deferred pause policy, and preserve genuine raw-mode/reset/exit/close
ownership. It must not add public methods to a generic Readable or detach the
existing retained mode owner while still referenced. Native IOHandle captures,
current-mode sentinel, init-before-fd admission, close phase/ref/read/write/
queued shutdown, rollback and descriptor-reuse constraints stay unchanged.
Exact native init-hook close and unsupported/master/reopen behavior remain
unresolved; the early constructor prerequisite does not certify them.

Public file/pipe/TCP class selection is also incomplete: files need actual
SyncWriteStream/ReadStream autoClose:false semantics and pipe/TCP need their real
Socket/IPC handle admission. Generic fd streams are not those public classes.
The current non-TTY paths are preserved, with that gap explicit; no false TTY
classification, fake window dimensions, host Node delegation or silent class
fallback is added. Worker stdio remains its separate real transport prerequisite.
No full stdio/TTY/readline/module or finding closure is asserted.

## Source/evidence boundary

This is one contextual bootstrap delta plus this document, with exact before/
after identities. Native terminal/Socket/stdio/readline/TTY algorithms are
unchanged. No new runtime input, recipe revision, engine hunk, ABI/pin or
executable-script change is supplied. Parent owns then-current composition and
one normal generation/check boundary. No tests, probes, compiler, generation,
root/index/Git mutation or guest execution ran. Source inspection is not startup,
constructor/GC/OOM/realm/Worker/four-host conformance. Independent review and
actual composed startup validation are required before using this prerequisite
to change the process stream construction path.
