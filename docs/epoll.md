# epoll contract and audit

Kandelo exposes `epoll_create`, `epoll_create1`, `epoll_ctl`, `epoll_wait`,
and `epoll_pwait`. Both musl targets use a 16-byte, unpacked
`struct epoll_event`: `events` at offset 0, four bytes of padding, and the
unaltered 64-bit `data` union at offset 8. Output padding is zero.

The compatibility references are Linux's [epoll overview](https://man7.org/linux/man-pages/man7/epoll.7.html),
[control operations](https://man7.org/linux/man-pages/man2/epoll_ctl.2.html),
[wait operations](https://man7.org/linux/man-pages/man2/epoll_wait.2.html), and
[creation operations](https://man7.org/linux/man-pages/man2/epoll_create.2.html).
The Linux [pipe implementation](https://github.com/torvalds/linux/blob/master/fs/pipe.c)
clarifies per-write edge notifications, normal-event aliases, and simultaneous
pipe write readiness and error. The Linux [eventpoll implementation](https://github.com/torvalds/linux/blob/master/fs/eventpoll.c)
clarifies exclusive callback selection and the four-edge nesting limit.

## Interface inventory

| Interface | SDK and libc | Channel and kernel | Host responsibility |
|---|---|---|---|
| `epoll_create1` | musl wrapper; syscall 239 | ordinary scalar dispatch to `sys_epoll_create1` | ordinary dispatch and result |
| `epoll_create` | musl validates positive size; raw syscall 378 also validates it | same instance creation as create1 with flags zero | ordinary dispatch and result |
| `epoll_ctl` | syscall 240; one opaque input record for ADD/MOD; DEL normalizes its unused pointer to null | reads the shared event layout, then changes the OFD-owned instance | bounds-checked opaque transfer; no interest-list mirror |
| `epoll_pwait` | cancellation point, syscall 241; eight-byte kernel signal mask | signal context plus one nonblocking delivery attempt; internal EAGAIN means park | shared Node/browser `handleEpollPwait`: mask scope, exact wait token, monotonic deadline, event copyout and yielding retry |
| `epoll_wait` | musl delegates to pwait with no mask; raw alias 379 | same delivery engine | same parking path without a mask swap |
| `epoll_pwait2` | no C wrapper in pinned musl or either Kandelo syscall-number header; the Rust libc fork retains the unsupported Linux raw constant `SYS_epoll_pwait2 = 441` | no Kandelo syscall assignment, descriptor, glue, dispatcher or export | not implemented; the Rust constant does not establish runtime support |
| obsolete `epoll_ctl_old` / `epoll_wait_old` | not exposed by either SDK target | absent | absent |

The host intercepts only waits. It dispatches one kernel attempt without
sleeping the dedicated worker. Pipe and listener tokens provide targeted
wakeups; bounded timer retries cover asynchronous devices, network engines,
new registrations, and targets reachable only in another process. The retry
uses the same absolute monotonic deadline. An empty set can sleep and later
observe a concurrent registration.

## Behavior matrix

“Before” describes the implementation audited at the start of this change.
“Implemented” describes the code contract; test results are recorded separately
and must not be inferred from that label.

| Behavior | Before | Current contract |
|---|---|---|
| Level triggering | implemented, with a fixed-order scan | implemented; successive bounded batches rotate through ready interests |
| Register an already-ready object | implemented | implemented; ADD and MOD enqueue an initial candidate |
| `EPOLLET` | missing; ignored | implemented from backing mutation notifications and transport/signal/audio notification history; delivery rechecks current state |
| Arrival while still readable; drain/refill between waits | incorrect for an edge consumer | notifications survive between waits; no previous-ready-bit approximation |
| `EPOLLONESHOT` | missing; ignored | delivered interest disables until MOD; MOD replaces data and rearms even if still ready |
| Requested event mask | only IN/OUT mapped | pollable object determines supported bits; output is intersected with the interest mask plus unconditional ERR/HUP |
| `EPOLLRDHUP` | missing | requested stream receive shutdown/EOF and local datagram receive shutdown; a peer FIN alone preserves the write half and does not fabricate HUP |
| `EPOLLERR`, `EPOLLHUP` | unconditional but stream FIN misclassified | unconditional; orderly full shutdown is HUP rather than a fabricated transport error; socket OUT can accompany HUP |
| Local shutdown and unconnected sockets | inherited poll suppression could strand an epoll writer | immediate socket write failures remain writable; unconnected streams report HUP and requested writable bits; datagram write shutdown alone is not HUP |
| `EPOLLPRI` | ignored | pending supported socket urgent data; unsupported socket OOB transport remains a socket limitation |
| RDNORM / WRNORM / WRBAND | ignored | protocol-specific aliases: Unix sockets and datagrams expose WRBAND; TCP streams, pipes, eventfd, timerfd and signalfd do not invent it; eventfd/timerfd/signalfd do not gain normal aliases |
| Datagram write-capacity edges | absent | dequeue, receive shutdown and final receiver closure notify write-band subscribers; a surviving receiver alias keeps the queue alive |
| RDBAND, MSG, NVAL and unknown mask bits | ignored | accepted as on Linux's ctl path; no synthetic producer or NVAL events; an invalid monitored fd is a ctl error |
| `EPOLLEXCLUSIVE` | ignored | ADD only; invalid masks, one-shot combinations, MOD, and epoll targets rejected; callback selects a sleeping exclusive instance and also notifies ordinary interests |
| `EPOLLWAKEUP` | ignored without explanation | no suspend or CAP_BLOCK_SUSPEND facility exists; behaves as Linux's unprivileged no-effect case, including its acceptance and exclusive-mask validation |
| `O_NONBLOCK` on create1 | rejected | rejected with EINVAL; only EPOLL_CLOEXEC is an accepted creation flag |
| Regular files, directories, memfd, devices without poll | incorrectly attachable | EPERM; poll's always-ready file rule does not make an object epoll-capable |
| Duplicate descriptor registrations | implemented `(fd, OFD)` key | retained; duplicates can carry distinct masks and data |
| Original target fd closes, alias survives | implemented within caller | retained; the registered number is not the lifetime identity |
| Only a sibling process retains the target | incorrect; interest skipped | delivery resolves the original OFD in disjoint live process records; a reused number cannot substitute for it |
| Forked datagram and KMS mutable readiness state | process-local object state | still incomplete: datagram queues and KMS sidecars are not shared like Linux open descriptions; resolving an OFD identity alone does not repair these underlying object gaps |
| Last target description closes | stale entries pruned opportunistically | shared OFD lifetime removes registrations, without an epoll-owned reference keeping the target alive |
| Epoll fd duplicated, forked, or retained over exec | implemented shared backing | retained; non-CLOEXEC keeps interests and delivery state |
| Epoll fd closed/reused during a parked wait | retry could follow the new fd | a kernel wait lease pins the exact description and backing |
| Old worker retirement after exec | no epoll-specific generation | exact wait token prevents old retirement from canceling a later call on the same task |
| Nested epoll | readiness recursion only | non-consuming readiness, cycle/self-alias checks and at most four nesting edges, including ancestor paths |
| Multiple waiters | no delivery state to serialize | the single kernel worker serializes control and consumption; ET/one-shot state is consumed once |
| Timeout / interruption | host deadline and mask context existed | empty-set waits and atomic mask restoration; ready/timeout/error results restore the mask before signal delivery, while an interrupted wait retains it for its catcher |
| DEL event pointer | nullable but a non-null pointer was still copied | wholly ignored, including an invalid non-null address |
| `maxevents` | positivity only | positive and at most `INT_MAX / sizeof(struct epoll_event)` |
| Data / wasm32 and wasm64 layout | shared layout existed | preserved 64-bit payload, 16-byte stride, zero output padding |
| Allocation and fd exhaustion | partial cleanup existed | fd allocation failures release the instance; registration allocation returns ENOMEM; no Linux per-user watch quota is exposed |

## State and notification ownership

`descriptor_backing::with_epolls` owns instances. Interests carry the original
fd/OFD key, event/data values, notification sources, pending state and one-shot
disablement. `epoll::notify` records candidates at a mutation, independently
of the host's drainable wake buffer. Nested callbacks propagate candidates to
parents. A candidate is neither an event log nor permission to return stale
readiness: delivery checks the backing again and coalesces notifications.

The shared OFD state retires its registrations when its last owner disappears.
An interest itself does not retain the target. A parked wait separately owns
the epoll description and a backing reference. Its unique token is returned by
`kernel_epoll_wait_token`; `kernel_epoll_wait_finish` accepts that token, so
late cleanup cannot act on a different execution's wait. Exec, exit, thread
exit and task cancellation also retire the kernel lease.

The kernel restores explicit and host-preinstalled temporary masks before
processing pending signals on ready, zero-timeout and error returns. A
signal blocked by the original mask stays pending when an already-ready
batch wins. Internal EAGAIN retains the context while parked; EINTR retains
it for handler delivery. Host output-range validation precedes mask setup.

Pipe-backed stream shutdown marks the connection half in the shared pipe
backing before dropping the calling process's reference. Inherited stream
read/write operations and readiness therefore observe the same shutdown.
This does not turn the existing process-local datagram and socket-option
state into shared socket state.

Epoll's Linux socket mask is applied after the common object readiness
decision. It retains writable events for shutdown/error returns that cannot
block, including OUT with HUP, and distinguishes Unix/datagram write-band
aliases from TCP. This does not change the separate POSIX poll policy.
Datagram capacity subscriptions use the receiver's OFD identity; its final
owner notifies waiting writers before retiring registrations.

Host-backed engines expose optional `NetworkIO.readinessGeneration(handle,
direction)`: receive direction 0, send direction 1. These monotonically
increasing counters record actual transport notifications independently of
current ready bits. Weakly owned host bookkeeping dies with the transport.
The required kernel import `host_net_readiness_generation` returns a negative
sentinel when an adapter cannot provide this history. Level-triggered waits
remain available; edge/exclusive waits fail with EOPNOTSUPP rather than
silently claiming faithful delivery on such an adapter. The built-in Node
TCP, fetch/TLS and local/remote virtual transports supply the history.

Signal queues similarly retain notification generations; the waiting task's
actual shared and directed queues determine signalfd readiness. The independent
PCM consumer cursor, configuration generation and fatal-error flag provide
audio notification history without lending any guest memory to persistent
host realms.

## Boundaries and validation

Remaining completeness work and its acceptance criteria are tracked in
[future improvements](future-improvements.md#close-the-remaining-epoll-completeness-gaps).

This is not a claim of complete Linux compatibility. Kandelo has no system
suspend controller, Linux capability service, `/proc/sys/fs/epoll` quota
controls, or epoll busy-poll ioctl API. `epoll_pwait2` is not exposed. Those
interfaces must not be inferred from the existence of epoll.

Existing socket limitations still apply: datagram queues and several mutable
socket properties are process-local across fork, cross-process AF_UNIX
socket transfer is unsupported, and raw external networking depends on the
host backend. KMS sidecars, including the card event ring, also remain
process-local on fork (`fork::read_kms_fd_state` reconstructs an empty ring).
These fork-state issues are applicable platform gaps, not inherent browser
boundaries or completed Linux epoll semantics. `/dev/random` aliases `/dev/urandom`; it does not expose Linux's
entropy-pool polling behavior. Custom network adapters without notification
history cannot use edge/exclusive epoll. These are visible limitations,
not evidence of Linux equivalence.

The regression sources are `crates/runtime-core/src/epoll_tests.rs`,
`examples/epoll_semantics_test.c`, `host/test/epoll-semantics.test.ts`, and
`apps/browser-demos/test/epoll-semantics.spec.ts`. The guest source is compiled
for both pointer widths through the normal SDK. Kernel tests also cover the
sibling-only registration and exact wait generation, which cannot be proven
by an output-only browser assertion. See the [validation record](plans/2026-10-20-epoll-validation.md)
for exact executed commands, outcomes and deferred suites.

The guest mask combinations include mio 0.7.6's EPOLLET and EPOLLRDHUP needs,
plus one-shot, control, lifetime and device cases. Passing those probes is
evidence for the exercised syscalls. A subsequent attempt to compile
unmodified mio 0.7.6 with the normal `wasm32posix-cargo` target failed before
runtime: its selector, waker, pipe and TCP platform gates do not include
`target_os = "kandelo"`. No mio dependency or target identity was changed.
A direct wasm32 Rust libc probe passed on Node, checking the 16-byte event
record, data offset eight, full 64-bit payload, eventfd edges, one-shot rearm
and stream RDHUP. Its inherited raw `SYS_epoll_pwait2` constant returned
ENOSYS. The tested syscall and Rust ABI behavior therefore does not establish
working mio integration; enabling Kandelo in that dependency is a separate
porting task.

The [libevent port](libevent.md) supplies a reusable C event library and
unchanged upstream edge-triggering and peer-close regression tests. Its
Node and browser fixtures exercise both pointer widths and both libevent
epoll modes, with an explicit backend check and zero skipped cases required.
