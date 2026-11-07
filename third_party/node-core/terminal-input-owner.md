# Captured stdio input ownership prerequisite

This source implements a genuinely consumed captured TTY-input prerequisite.
It does **not** implement public tty.ReadStream/WriteStream constructors,
Socket inheritance or complete Node core/TTY compatibility. The callback
follow-up below adds actual native I/O resource ownership, not public TTY
constructor activation.

## Why a prerequisite

Pinned26.13.0 lib/tty.js constructs ordinary callable functions whose native
TTY handle is admitted by net.Socket.call(..., {handle, manualStart, ...options}).
Current SocketCore ignores that handle/manualStart route and fd admission always
creates a TCPWRAP owner with socket-specific shutdown/write operations. Existing
public TTY exports are generic stream subclasses. Putting the pinned TTY frontend
on that transport would not create a real TTY. The next implementation gap is
shared StreamBase/TTY handle admission and native lifecycle, followed by the
public constructors with the actual Socket/Duplex hierarchy/options/descriptors.

Existing borrowed stdin mode captured a descriptor only for termios; ordinary
reads still used future numeric fd0 and directly set O_NONBLOCK on its OFD.
A close/reuse could redirect later reads and aliases shared its flag changes.

## Source behavior

InputHandle reuses the existing verified OutputHandle slave reopen, actual
terminal identity checks, dup2 initialization and same-number reopen protection.
Only the actual isolated OFD becomes nonblocking. Mode uses a real duplicate of
that same captured terminal; teardown closes only owned extras and preserves the
borrowed supplied number, including a later replacement at that number.
Master/unreopenable paths return their real ENOTSUP and retain the existing
borrowed fallback; their alias/backpressure/identity gaps are not fixed.

The native opaque terminal lease routes reads directly into the existing actual
fd-read reactor. No private numeric fd escapes to JavaScript. Actual pending
request storage retains the opaque lease and exact read Promise. Control checks
that pair, changes its real loop reference or detaches/cancels that exact read.
Close marks admission closed, unlinks the request before Promise hooks can
reenter, then releases the captured fd. Reactor completion detaches before
publishing and does not carry a raw next pointer across JS. Promise hooks cannot
make a preallocation cached fd valid after reentrant close. Reusable roots live
until actual watch deletion. Silent context teardown does not enter JS.

The actual fd-readable path consumes this owner for supported stdin TTYs and
binds mode operations to the same lease. Public .fd mutation and public close
events do not select transport or retire resources. Non-TTY/unsupported fallback
keeps the original generic path. Constructor/publication errors close the real
new owner while preserving the original exception. The initial captured-input slice added no ABI, FileType, kernel/host API,
provider identity or public Socket facade. The callback follow-up below now
consumes genuine native I/O resource lifecycle; public Socket admission is
still incomplete.

## Evidence and remaining gaps

The separate canonical-mode descriptor test passes14 actual PTY/OFD/read/reuse/
close checks. Exact pinned native Node reference also reads the original PTY
after public fd replacement, keeps the replacement open and observes actual
native TTY material. These controls do not compile/run the production JSAPI
reactor, cancellation/ref/GC/OOM/realm/fatal/shutdown/Worker code. Five tiny
native compiles succeeded; no engine/kernel/package/product build or overall
suite ran. Focused source checks/staging are recorded separately.

**The original strict mode comparison remains nonpassing.** All three portable
raw-to-normal control versions still abort; their exact sources and stderr remain
in the immutable handoff. Later matched diagnostics use the same operations and
readiness setup for actual Node, the portable owner and a direct-libc branch in
one shared addon. All22full-attribute phase comparisons and93resource/I/O checks
agree. With no persistent watcher all three retain PENDIN immediately after
normal mode; the same real kqueue setup restores initial words for all three,
and the same later poll clears the bit for all three. Nine literal restoration
nonpasses and the original R3 SIGABRT remain separately recorded. No masking,
candidate-only flush/read, mode algorithm change or external-runtime defect/
platform exclusion is justified. This is native diagnostic evidence, not guest
termios/reactor or full TTY conformance. See the integration record and exact
immutable tty-restoration-diagnostic-agent results/analysis.

Master/unreopenable/backpressure nonpasses from earlier seals are unchanged.
Concurrent guest close/fork, late failure transaction details, per-context native
lifecycle, partial initialization/exception races, shared StreamBase/TTY admission,
public constructors/Socket inheritance/options, private SIGWINCH and all four
identified guest hosts remain incomplete. Do not report the TTY family complete.


## Native callback/read resource prerequisite

Captured input now has an actual native readiness-callback route. Start queues
one watch rooted by the captured terminal object and exact callback; no private
Promise read/then chain changes the callback's owner. The reactor detaches the
watch before entering JS, copies actual bytes/EOF/errno in the owning realm,
and invokes the callback through the shared native callback/uncaught recovery/
after/checkpoint owner. The real input/output native object captures its async
ID, trigger, frame and TTYWRAP provider; explicit close, finalization and context
shutdown retire that ID exactly once. Mode-only borrowed leases keep their
separate non-I/O identity. Native init occurs after the captured descriptor has
been acquired; exact public constructor failed-init/order semantics remain a
later obligation, not established by this private stdio ownership seam.

Readable demand consumes the callback route. Pause cancels its actual watch and
clears demand; ref/unref persists native policy across rearmed reads; destroy
cancels before releasing the captured descriptor. Pending callback/owner roots
last through callback recovery and checkpoints, including reentrant close. Stop
never silently abandons a legacy Promise read. Callback start/stop/ref return
allocation-free result scalars after committing their operation, so a subsequent
packet allocation cannot hide an actual published watch/control transition.
Legacy Promise/control operations remain available separately. Errors preserve
native errno; the callback protocol is private typed delivery, not a fabricated
StreamBase state array or JS _handle. No backend capability/platform is spoofed.

The shared reactor registry must be context-thread owned: the separate owning
correction makes its list thread_local, matching actual foreground JS-root
creation/dispatch/cleanup and independent Worker loops. That correction does
not itself implement comprehensive generic numeric fd request shutdown. Native
terminal teardown does cancel its exact lease watches while JSContext lives.

Focused source-component controls use the exact pinned native Node26.13.0,
actual PTYs, real native TTY readiness/onread and the actual candidate terminal/
fd-readable factories. Bytes, EOF, pause/read cancellation, native ref/unref,
callback resource ownership, close and absence of private read Promise creation
are scoped evidence. The production SpiderMonkey callback/JSAPI source remains
uncompiled/unrun; those component controls use real native Node owners as
explicit fixture dependencies, never as Kandelo's production backend.

Public ReadStream/WriteStream remain the existing incomplete exports. Actual
Socket options.handle/manualStart admission, shared native StreamBase methods/
prototype/error shapes, failed-init and close completion ordering, public
constructor hierarchy/options, writes' WriteWrap semantics, SIGWINCH activation,
raw-mode nonpasses, generic borrowed fallback, fatal/GC/OOM/foreign-realm/Worker
conformance and identified-artifact evidence on all four hosts remain open.


## Shared callable Socket receiver/admission prerequisite

A later source slice initializes the actual inheriting net.Socket receiver
through the pinned Duplex/options/validation algorithms. The current transport
association resets before option spreading, without closing an independently
retained old handle; Duplex initializes on the actual receiver. Existing genuine TCP handles can now take
options.handle/manualStart/pauseOnCreate; native admission precedes mutable
wrapper binding, actual reference state is preserved, and partial supplied-
handle binding failure retains the real owner for the receiver's later close.
Fresh internally acquired owners retain their rollback path. Strings keep the
pinned decodeStrings=false policy and are encoded into actual byte material
before the native span writer consumes them.

This does not admit this terminal lease as a StreamBase. Public TTY exports
are still unchanged. The native TTY must first expose genuinely consumed
configure/onread/write/request/state/control/queued-close owners, and Socket
transport shutdown/address operations must support that real kind. Public
TTY callable constructors and inherited options/descriptor/init/error order
remain incomplete. The source slice adds no fake TTY handle or provider data.
Native TCP component evidence does not compile or execute the guest admission
or terminal owners and does not establish four-host conformance.


## Captured TTY read material and partial native stream owner

The next additive source slice consumes actual native configureRead/onread,
readStart/readStop, ref/unref/hasRef, getAsyncId/fd and queued-close methods on
this genuine TTY I/O class. These are a partial native owner, not admission as
an implemented public StreamBase or activation of public tty constructors.
Non-TTY input and unsupported reopen paths keep their existing real fallback;
no TTY resource is manufactured for a pipe, file or failed descriptor open.

The actual captured InputHandle remains read authority. A generation/sequence
read ticket owns its real native byte allocation, actual count/EOF/errno and
waiting/ready/delivering/admitted lifetime. Stopping an unread reservation
retires it; already-consumed material stays rooted for resume and pre-admission
publication retry. Actual ArrayBuffer/callback arguments are rooted before
admission. Once admitted, an exception does not replay bytes. Native requests
retain original material/accounting through callback/after/checkpoint retirement.
The real pinned shared stream-state binding derives count/error/offset from
that material; it is not a new fabricated TTY state array. Wrapper checks occur
before entering the actual view realm; JS errors are reported outside no-GC
raw-storage scopes.

The private fd-readable stdio factory now consumes this route. Its one-shot
consumer stops actual continuous native demand before calling Readable and
rearms only when real demand returns. There is no private read Promise on that
route. Stopped consumed material has no active loop reference but remains
rooted until resumed or closed. A queued close first closes owned extra fds,
never the borrowed public number, then cancels exactly queued requests. Its
native resource/root survives detached in-flight requests and closes through
the actual native callback scope before roots are cleared and destroy queued.
Repeated close does not replace its first completion callback. Silent context
teardown cancels exact requests and unregisters roots while the context lives.

Evidence is bounded: one tiny native C++20 control compiles the production
portable read queue and captured InputHandle against real Darwin PTYs; 27 named
material/OFD/stop/resume/admission/error/EOF checks pass. Two native-Node-backed
factory scenarios match the pinned26.13.0 reference for bytes/errors/close and
create no private read Promise; an intentional callback-disabled negative still
fails. That fixture's explicit adapter uses Node's real native TTY, shared
stream state, bytes, async resource and transport. It does not compile or execute
Kandelo's native JSAPI, realm, callback recovery, queued-close or GC paths.
Normal source generation/staging, bootstrap syntax, unchanged Mozilla style
and the conservative880-file input check pass separately. A first private
source setup attempt failed on an omitted codec patch file; its failure remains
recorded. No engine/product build or overall/four-host runtime suite ran.

Public callable/new/subclass TTY construction, early public TTYWrap birth and
failed-open init order, genuine generic kind admission, TTY writes/WriteWrap,
shutdown, full control/prototype/descriptors, GC-close ordering, fatal/OOM/CCW/
foreign-realm and Worker conformance remain implementation/validation gaps.
Legacy private Promise/callback operations are preserved and have not acquired
the new stream material publication retry guarantees. The original raw-mode
SIGABRT/restoration interpretation, master/unreopenable/backpressure and guest
termios/drain/SIGWINCH gaps are unchanged. No TTY audit finding is closed here.


## Continuous read demand across callback checkpoint failure

The additive integration review found that deleting an admitted read watch
before returning a failed after/checkpoint result could leave Reading=true
without a reactor request. The outer process loop can recover that exception
and continue. A genuine per-owner read-demand root now survives that boundary;
ordinary exception-free native dispatch arms its next actual reservation.
No JS or fallible rearm runs while the original exception is pending. Active
read demand controls its real loop reference; stop/close/EOF/terminal error and
context teardown clear that anchor when demand actually ends. Existing stopped
ready material remains independently rooted by its exact request. Native rearm
allocation failure preserves previously active demand/material for continuation.

Reentrant start during detached pre-admission delivery may resume demand but
cannot queue a second watch for the same delivering ticket. This guards the
native ownership invariant; no guest wrapper-reentry reproduction is claimed.

The diagnosis is source-level over source213 and pinned callback/loop owners.
A focused pinned native TTY continuous-read/nextTick exception recovery control
is independent target evidence. It does not execute the new Kandelo JSAPI or
recovery path. Guest C++/GC/realm/fatal/Worker validation remains pending; public
TTY constructors/kind admission/write/shutdown and prior nonpasses remain open.
