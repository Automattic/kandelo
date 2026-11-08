# Actual TLS registered-interest ownership

The real TLS watch collector and encrypted-output pump now consume the same
per-owner descriptor/event helpers used by the held native union query. No
public query/export, supplied-fd adoption or capability claim is activated.
Owning descriptor, live roots, request/reference counts and pending BIO bytes
are not readiness. Existing current271 plain TCP registration/receipt ownership
remains authoritative; legacy272 must compose separately and is not overwritten.

A captured TCP TransportWrite in Writing owns POLLOUT for its exact attached
transport, request pointer and generation. Actual EAGAIN/partial work preserves
that phase. Success/error/cancel changes it to Ready, which has no fd event; its
real acknowledgment is local continuation. Plain TCP callback drain/error flags
cannot erase this independent receipt phase. Close invalidates it through the
actual captured owner, not a later public numeric fd. The TLS output BIO owner
exposes that exact registration and the paired writer's real write guarantee.

The current input BIO is a retained real socket. Actual SSL WANT_READ records
POLLIN. On the retained-parent path, SSL WANT_WRITE means space in the output
memory BIO pair: it is not by itself socket POLLOUT. The pending ciphertext
receipt owns any physical POLLOUT, and real BIO ring space permits local SSL
continuation after acknowledgment. The existing transferred-lease/direct socket
BIO component path keeps its genuine WANT_WRITE/POLLOUT policy.

Initial admitted operations, terminal result publication, completed read data,
completed encrypted receipts and JS write-callback acknowledgment have separate
local continuation/lifetime policy. They do not manufacture fd interests. Actual
read stop/current ticket/generation/Open gates suppress app-read polling; pending
write/handshake WANT_READ remains independent and can still require POLLIN.
EOF/error/abort/close clear the read retry cause; completed/awaiting-callback
writes register no fd event. A queued later write cannot register SSL readiness
until its actual earlier-write/callback admission barrier has retired.

Concurrent SSL operations can consume input needed by an already-admitted
retry. Each attempted operation snapshots the actual input BIO identity and
BIO_number_read counter after SSL_get_error (positive returns need no error
lookup). A changed snapshot permits one local retry; it is refreshed only by a
real SSL call, not an invented wake/attempt counter. Equality comparison catches
ordinary unsigned wrap without assuming monotonic greater-than. Input binding is
once per preparing owner; live replacement has no public/current owner route.
Identity changes are nevertheless observed. The owning SSL/generation remains
valid for comparisons, and closed/stale owners never dereference old snapshots.
No BIO pointer, JS root or request crosses threads. Same-context stopping/detach
gates suppress actual queued TLS poll/dispatch, with shutdown owning cleanup.

Exact packaged OpenSSL3.5.9 bss_bio.c shows full paired buffers set retry-write,
write guarantee returns size minus occupied bytes, and bio_lib.c exposes the real
consumed counter. These selected bytes are retained as source evidence only; no
new library/backend/recipe is introduced. The actual native output pump and the
existing private graceful-shutdown pump both consume the new receipt interest.
The held query unions only matching current TLS causes and never replaces actual
poll consumers with an fd/root/ref/EncryptedPending proxy. The existing
EncryptedPending test remains only a truthful SSL dispatch barrier; it does not
produce a fabricated readiness mask.

Remaining implementation gaps are explicit: managed independent input BIO and
full pinned ClearIn/ClearOut/StreamBase listener flow, including handshake
full-duplex/backpressure while the existing non-read output barrier is active;
public ReadStop bridge/active-handle semantics; full native admission/fatal and
inline stopping publication; legacy raw close/OFD/reuse/publication-failure
authority; early end-before-secure/public graceful finalization; certificate,
session, provider, callback/error/GC/OOM/realm/Worker/fork and four-host behavior.
None is an accepted platform boundary or a passing unsupported case.

Source/identity/Git replay only: no new tests/probes/compilers/generation/package
or overall suites/guest execution. All old native dirty-error/early-end/fatal
nonpasses remain immutable. Source presence is not runtime conformance.
