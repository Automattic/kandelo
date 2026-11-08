# Legacy watch poll-interest foundation

This is a bounded shared prerequisite for network fd-admission review
SUPPLIED-FD-REVIEW-001, related network-contracts.md N-011/N-013 and N-015 stream
lifecycle. It does not activate supplied-fd listen or close a public finding.
The final plain TCP source90e870 and independent review52b9e2 are dependencies
for the later combined admission decision, not evidence for TLS or this engine
source. Listener270 ownership remains unchanged.

## Actual consumed ownership

The existing thread-local legacy watch list is actual queued I/O admission:
connect is linked after EINPROGRESS, read/accept after would-block, and write
after partial/would-block output. Ref bits, pending Promise roots, material
size and descriptor ownership do not establish read/write interest.
KandeloSocketWatchPollInterest now supplies the exact fd/events consumed by the
ordinary poll collector. It rejects a different JSContext and child watches
without descriptors; actual opaque listener readiness and retained terminal
reading/descriptor state gate those kinds. A negative descriptor gives no
poll interest. Existing per-request events select input versus output.

KandeloLegacySocketRegisteredEvents is an internal no-JS/no-allocation query of
the same actual linked poll records at a native admission boundary. It is
intentionally not exported to JS or connected to supplied-fd admission. It is
not a whole-TCP/TLS loop query and does not certify an fd/OFD. The per-watch
owner is already consumed by actual polling; the final union query remains
held pending the dependencies below. No bool is synthesized from roots/refs.
The ordinary watch liveness scan now also respects every watch's owning
context, rather than selecting a foreign context's roots as current work.

Generic connect/read/write terminal paths remove actual registration/list
membership before Promise conversion/settlement hooks. The detached watch's
PersistentRooted members and native buffer stay owned by local RAII until
publication returns; the Promise's real realm is entered explicitly. A failure
propagates instead of being ignored. Each such publication ends that dispatch
pass, so no cached raw list-next pointer crosses hooks/reentry/GC. Incomplete
partial output or would-block retains actual membership and native progress.
Read data, EOF/error, drained output/error and completed connect therefore end
this one-shot poll request before user hooks can query/reenter it. Failed
connect closes its fd before rejection; success-publication failure retains
its existing numeric cleanup policy, explicitly unvalidated below.

This is the legacy one-shot reactor's actual behavior, not a claim it has
pinned TCPWrap's persistent-read/provider/checkpoint semantics. No manual
callback scope, new provider, poll event, read result, fd validity or success
was fabricated. Child delivery, terminal and listener publication algorithms
are left unchanged; this is not their complete reentry review.

## TLS dependency retained, not guessed

Actual TLS has separate handshake/read/write watches and SSL_get_error
WANT_READ/WANT_WRITE events. The loop detaches them for execution/publication
and retains writes through real callback acknowledgment. A linked TLS watch,
activeWrite, request count or encryptedRoot cannot substitute for registration.
Waiting plaintext may consume a different readiness mask; complete data/results
and callback-only acknowledgments may need no fd polling at all.

The memory-BIO output pump separately polls POLLOUT before genuine captured
parent TransportWrite progress. Final plain-TCP90e870 QueueTransportWrite,
ProgressTransportWrite, CancelTransportWrite and AcknowledgeTransportWrite do
not yet update a distinct transport event-interest cause. Ready receipt and
awaiting acknowledgment are pending work, not active POLLOUT. These transitions
need a real transport registration owner consumed by both pump/poll collection
and future query, preserving exact parent generation/attachment/context.

TLS Owner BeginRead/StopRead/ProgressRead, handshake admission/SSL WANT, fatal
error/EOF, encrypted send remainder/error/drain, callback publication/ack and
Close must feed that actual owner. The current independent native watch/pump
phases cannot be faithfully represented by a single unconditional TLS boolean
or fd-owning predicate. This phase leaves TLS source unchanged and returns
those concrete next owning seams. No TLS registration support is claimed.

## Remaining legacy admission/close obligations

The legacy numeric route has no retained OFD/generation authority like modern
TCP/listener owners. Raw numeric close still publishes cancellation while
walking other linked watches and closes the fd afterward; hook reentry/fd
reuse and cross-context/process semantics require their own retained close /
canceled-request retirement owner. Successful legacy connect publication-failure
cleanup also closes a numeric fd after fallible publication. These are concrete
implementation gaps, not accepted boundaries, and block final supplied-fd
activation independently of this exact one-shot poll query. Child wait delivery
has separate raw-list reentry questions outside the changed I/O branches.
Existing legacy EINTR, zero-progress write, polling fairness, ready coalescing,
OOM and interrupted-publication policies are not established here.

All prior full options/Pipe/cluster/native async metadata and native close-init
SIGBUS nonpasses remain unchanged. No unsafe double-fd probe ran. The final
combined native query must use actual listener270 + plainTCP90e870 + completed
TLS/legacy ownership, never the old blanket owned-fd test, and only at a no-JS
admission boundary. This phase deliberately does not wire that query.

## Source and validation boundary

engine.patch is a contextual shell-only delta on the exact source270 canonical
named in source-identities.json. The raw source.patch adds only this document.
No new header, recipe revision/input, generated core, engine-patch allocation,
ABI/syscall/pin or executable-script change is supplied. Later parent composition
must preserve actual newer shell/native owners and use normal generator/staging.

Zero tests/probes/compilers/generation/root/index/Git mutations. Author source
inspection and exact patch identities do not compile or execute the new JSAPI,
roots, Promise hooks, poll/close/fatal/OOM/Worker or guest/four-host paths. The
portable TCP binary cannot validate these changes. Independent source review
and targeted actual composition validation remain required. No API closure or
conformance credit is asserted.
