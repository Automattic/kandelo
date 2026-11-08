# Captured TLS encrypted-output prerequisite

This partial S-009 owning slice replaces direct socket output BIO on the actual
retained-parent production path. It does not implement public TLS shutdown or
TLSSocket/StreamBase compatibility. Node target26.13.0/source
18b32a3b1552e199a01f1a8d9fd64aa756d3b75b is unchanged.

The real TCP owner admits one native encrypted transport ticket only for its
current TransportAttachment. Its immutable generation and monotonic sequence
identify the actual captured lease/write. It sends original BIO bytes through
that owner, retaining its completed receipt until explicit acknowledgment.
Ordinary TCP plaintext write/shutdown still returns EBUSY while TLS is attached;
no raw public fd, second TCP transport or synthetic provider is substituted.

The output-only OpenSSL BIO pair retains BOTH writer and reader objects. Its
zero-copy view points at the writer's ring allocation. The reader head advances
only after the exact parent receipt is acknowledged, so later SSL output can
append without overwriting the retained region. Close cancels that actual
transport ticket, destroys SSL before retiring its output storage and leaves
request/callback teardown with the existing rooted TLS owner. Real native
sendmsg progress, EAGAIN and cancellation are not record-only acknowledgment.
The real fixed BIO-pair buffering creates WANT_WRITE cycles; it is not a fixed
completion count or unsupported-case boundary.

An actual native output producer roots the opaque TLS capability independently
of a read Promise, and consumes receipts on ordinary loop continuation. It is
referenced only while real output/retirement is pending. Connect and write count
publication wait for ciphertext acknowledgment. Reads may continue during
output backpressure so two peers need not wait for outgoing application data
before consuming incoming records. Active plaintext write ownership preserves
the same OpenSSL WANT retry arguments. Existing Promise callback acknowledgment,
write-index publication/close batches, native TLS identity and context shutdown
remain in control; no TCP WRITEWRAP or callback scope is fabricated.

The input BIO still uses the same real captured socket with BIO_NOCLOSE and
exclusive TCP read ownership. Complete NodeBIO input/onread/listener integration,
full underlying StreamBase request/provider/frame parity, sessions, handshake
reentry and graceful shutdown are still implementation gaps. The existing
copied plaintext write bridge remains copied; only ciphertext retains original
BIO storage. Destruction-time close remains one best-effort SSL attempt with
real possible native send followed by cancellation; it is never credited as
a successful close_notify or public _final. Raw attached-parent shutdown remains
refused. Full close_notify/earlier callback/deferred-library-call/parent shutdown
transactions must be implemented before activating _final.

Two tiny native addon compilations succeeded. A real TCP/BIO primitive subject
checks seven condition annotations, including retained head/tail, exact wire
order, foreign/stale receipt refusal, actual EAGAIN and captured-parent close.
Real TLS1.2 and1.3 native client/server subjects complete handshakes and compare
64KiB decoded payloads through this output owner. These use native OpenSSL and
actual loopback TCP, not a mock transport or guest JSAPI. The new native engine
root/watch dispatcher is still uncompiled. GC/CCW/OOM/fatal/Worker/fork/private-fd
reuse, fairness and complete callbacks/public API/four-host behavior remain
unvalidated or incomplete; no gap is accepted as a platform exclusion.

C++ holder allocations are tracked as actual holders. Opaque OpenSSL BIO/SSL
allocator physical memory accounting is not guessed. No additional memory or
capability metadata establishes support. Normal staging maps the raw portable
header to its real canonical shell name, preserving the TTY raw-header fix.

The private source baseline is the identified241snapshot. Current root has
advanced independently. Compose only narrow raw/engine/recipe hunks over the
actual parent, preserving FileHandle/SQLite/TTY, rather than copying this old
whole recipe or engine source. No target/ABI change, full product rebuild,
overall suite, merge or deployment is authorized by this slice.
