The datagram source candidate retains the actual initial allocation spans of
send-list entries. The production adapter forwards the count captured by the
pinned caller; native code reads each entry once and captures its backing
before later getters or async init can mutate earlier entries. The request
owns real iovec/SpanRef metadata capacity and the actual original allocations;
message bytes are copied only by the real sendmsg syscall when it dispatches.

SendWrap initialization precedes queue publication. An init hook sees the
actual earlier queue and can send a nested datagram first. A successful real
submission is retained until deferred completion and is not canceled by a
later close; an unsubmitted request is canceled with its original message
size. Request roots and record credit survive callback/checkpoint and retire
on the context thread. The last retained span may free storage on a worker
without JSAPI. Public dgram view validation is unchanged. Private bare-buffer
capture uses the actual buffer allocation without constructing a view.

This supersedes the historical copied-byte queue description in the first
foundation/review evidence. It does not close N-014 or N-021. The current
source has not been compiled with SpiderMonkey or executed on any guest host.
Portable controls exercise actual storage/endpoint/queued-record code with
explicit root/accounting/syscall-fault dependencies. Production adapter controls
exercise actual conversion and forwarding. Native Node controls establish
reference behavior only; the close-in-send-init abort remains a nonpass.

The binding no longer uses an arbitrary copied-byte size cap. The existing
kernel accepts oversized local messages, so enforcing ordinary UDP transport
limits remains a separately reviewed kernel/ABI prerequisite. That proposal
has native Rust owner checks but no current kernel Wasm or four-host evidence.
No stale artifact is claimed to validate either slice. Native API/GC/realm/
shutdown behavior, shared-buffer races, registry/deque allocator accounting,
callback-throw recovery, exact native descriptors, worker/cluster transfer,
multicast/dual-stack and raw external UDP all retain their separate obligations.
