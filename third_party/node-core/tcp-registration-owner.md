# Plain TCP registration owner foundation

This partial native foundation separates actual event registration from owning
an fd, pending GC roots, consumed bytes, request lifetime and ref/unref. It does
not activate public supplied-fd Server listening. The original supplied-fd
SUPPLIED-FD-REVIEW-001 remains open until actual listener, modern TCP, TLS and
legacy registration/publication prerequisites compose.

Each real portable socket Owner now owns a Registration alongside its exact
descriptor/generation. Actual read start/stop, post-init write queue admission,
connect syscall/submission and close change the state. Native poll collection
and real portable poll/send/connect progress consume it. No user properties,
process metadata, fake capability table or public writable flag supplies event
interest. Ownership/ref alone leaves registration empty. Close and transfer
clear it before releasing fd; transfer refuses still-active event interest.
Actual sizeof(Owner)/native-state accounting includes the added inline state.

Queued writes use the existing original-allocation material and native
WRITEWRAP queue/callback/frame owners. Try-write completion creates no poll
registration. A real submitted remainder admits POLLOUT; actual progress polls
and sends the same vectors. Success retains registration through its native
oncomplete getter/callback/after/tick scope and drains only afterward, unless
nested actual queued remainders still own demand. Failure stops write interest
before error publication; a rooted completion cannot rearm it. During connect,
queued writes wait for actual connect completion. Connect syscall/getsockopt
retire connect interest before callback; successful queued output retains its
independent cause, and failure removes both causes. EINPROGRESS remains waiting.

Read demand is independent of material: stopping an already-consumed read
removes interest while retained bytes/ticket still exist. Positive callbacks
retain POLLIN unless stopped. EOF removes it before callback; a non-EOF error
keeps its actual registration through callback and stops afterward, matching
the distinct target phases. The real native callback scope remains the owner;
no second simulated callback engine is added. The private query is explicitly
KandeloPlainTcpRegisteredEvents(cx,fd), used by actual native readiness
collection, not a claim to describe TLS/TTY/legacy registrations.

One bounded Darwin-native C++20 helper compiled the actual changed full header
with its exact retained-memory/write-material dependencies, then ran once.
Eight groups used real nonblocking socket I/O, original backing, backpressure,
queued completion/drain, EPIPE/reset error, consumed-read stop, EOF, TCP reset
read error, real connect/queued-write and refused-connect transitions. Native
callbacks are exercised as explicit portable completion-policy boundaries;
the guest JSAPI, actual native C++ callback consumer and its ALS/fatal/GC/realm
code remain uncompiled/unexecuted. The helper does not call Node as candidate
and performs no unsafe same-fd double ownership probe. Source identities,
compiler version/path/hash, argv, result, artifact SHA and runtime output are
retained. Compilation accounting is one attempt/zero failures, not an engine
or library build. No normal generation, product build or overall suite ran.

Remaining prerequisites are implementation gaps, not exclusions: compose
9f122... listener Listen/ReadRegistered and its real poll/accept/onconnection
consumer, plus465c5303... actual socketListenerStart registration successor; attach a truthful TLS encrypted pump/watch registration owner;
repair/trace legacy Promise-watch completion/unlink phases; connect the final
supplied-fd query only after those consumers are real. Exact target batching,
ready-event coalescing, callback reentry, failed-callback/fatal recovery, polling
fairness, GC/OOM/Worker and four-host behavior are not established by this
portable control. All original supplied-fd chooser/flags/Pipe/cluster/async
metadata/close-init SIGBUS nonpasses remain unchanged. No default syscall,
ABI55, source pin or kernel policy changes are included.

Audit relation: network-contracts.md N-011 fd admission and N-013 native
resource/loop chronology receive a shared owning prerequisite; N-015 stream
lifecycle is related. No original definition, finding/family closure, runtime
conformance or provider certification is claimed. Integrate the two raw code
hunks and this document additively, preserving actual current listener/TLS and
other TCP owners. Existing runtime inputs already cover the header/fragment;
no executable build script, generated core, recipe revision or engine patch is
supplied. Parent owns current combined staging/source/package checks.


## Pending-dispatch and failed-connect queue correction

The original foundation's eight portable groups do not cover an open refused
connect with queued writes or a second admitted write after the first errors.
Independent review TCP-REGISTRATION-REVIEW-001 established both stranding paths;
its original source/evidence remain immutable. This additive correction supplies
a real pending-write-dispatch token distinct from active POLLOUT, following the
uv__io_feed versus uv__io_start distinction. A queued completion/error feeds
pending progress without asserting that a poll watcher is registered. The next
actual queued nonblocking attempt consumes that authority; only real remaining
bytes/EAGAIN rearms active polling. Draining the actual queue/callbacks clears
both causes. No forced registration, fake success or handle close is used.

After a failed connect callback/after/tick scope returns, actual same-parent
admitted incomplete writes become ECANCELED. Writes admitted by the connect
callback are included in that flush cut. A rooted completed-request snapshot is
then ordered by actual native write sequence and reserved against nested loop
dispatch. Existing KandeloDispatchSocketWrite owns each original callback/frame/
error/retirement. Writes created later by these write-completion callbacks are
outside the fixed batch. A stopped/fatal boundary cancels native queue state
without invoking JS while an original exception is pending; allocation failure
leaves real canceled/completed requests eligible for later recovery/close. A
closed parent retains its existing cancellation path. This is actual request
ownership, not a new callback engine or fabricated ready event.

One additional low-debug C++20 helper compile and one focused run passed two
real socket-I/O groups: refused TCP owner remains open through two queued
ECANCELED completions, and a second admitted write progresses after first-write
EPIPE/reset while active POLLOUT remains false. Exact original source/span and
header dependencies, compiler/artifact identities and output are retained.
Original eight groups were not rerun; no unsafe double-fd ownership probe ran.
The native rooted snapshot, JSAPI callback/fatal/reentry/OOM path remains
uncompiled/unexecuted, as do guest/four-host behavior and listener/TLS/legacy/
supplied-fd activation prerequisites. The additional compiler attempt is one,
zero failures, pending parent credit once; it does not recount the original
foundation's one attempt.


## Admitted empty writes, callback scope and stopping correction

The pending-dispatch correction65c08 remains immutable and is not source-ready
by itself. Its independent review aaa44395 confirmed three P2s: zero-byte
incomplete writes were omitted by the byte-policy drain predicate; failed-
connect write callbacks ran before the connect CallbackScope destructor; and
a stopped environment could enter the first write's oncomplete getter before
the stopping fence. The separate adversarial self-review9467d7 is not an
independent approval.

Callback retirement now asks whether an actual same-parent admitted incomplete
request remains, including zero bytes. The old Remaining-based predicate still
owns try-write byte admission. The complete connect callback lexical scope,
including its request retirement and callback-active guards, ends before the
canceled-write batch starts. This uses the real scope destructor and preserves
each subsequent write callback's ordinary depth/checkpoint/fatal boundary;
there is no counter edit or substitute checkpoint. The rooted connect request
and parent remain alive across this transition.

On stopping or an original pending exception, actual queued cancellation still
runs without entering JavaScript. The flush fences stopping/exception before
batch allocation and again before each reused write dispatcher, whose
oncomplete Get/writeStatus Set precede its CallbackScope admission. No new
property hooks run after those fences. A failed callback retains its original
pending error, actual completed requests and existing close/recovery ownership.
This follows the pinned can_call_into_js check before completion property Get;
it does not manufacture callback success or poll registration.

This successor is source-only: zero new runtime checks, compiler attempts,
normal generations or root/index changes. The two historical portable groups
and their one helper attempt belong only to65c08; they do not execute these
native predicates, scope/destructor or stop fences. Actual JSAPI/GC/OOM/realm,
fatal/stop/reentry/Worker and four-host validation remain open, as do all
listener/TLS/legacy/supplied-fd activation prerequisites. No public network
conformance or finding closure is claimed.
