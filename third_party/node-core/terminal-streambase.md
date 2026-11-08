# Native terminal stream admission prerequisite

`tty-stream-open` creates the actual native terminal resource and emits its
TTYWRAP init before admitting its descriptor. Supported slave admission
preserves the real access mode, reopens a distinct open-file description,
retains one owned extra descriptor and starts nonblocking. Captured output
explicitly selects blocking afterwards. Mode restoration is acquired lazily
by actual transitions. Closing retires only that captured owner, never a
subsequently reused public descriptor.

The Socket handle branch recognizes the checked native terminal class and
context. It consumes the real read dispatcher, stream-state binding,
buffer/vector write requests, async ID, ref/unref and queued close. TCP
adoption and numeric address queries are not terminal routes. Terminal
shutdown uses its own retained request/fd owner, described in
[terminal-shutdown-owner.md](terminal-shutdown-owner.md).
Captured stdio streams publish the actual owner as `_handle`; failed
publication rolls back through its close method. A live read-only terminal
rejects writes with EPIPE; a closed descriptor rejects with EBADF.

Public `tty.ReadStream` and `WriteStream` now consume the complete pinned tty.js
module over the genuine native TTY constructor and callable Socket owner; see
[tty-public-streams-owner.md](tty-public-streams-owner.md). Native mixed-vector
admission, unreopenable/master/file/pipe behavior and exact native
prototype/descriptor/close-phase parity remain gaps. The terminal Socket final branch consumes
the queued terminal shutdown owner; it does not use a numeric TCP route.
Init-hook close parity is unresolved: current
admission immediately retires any descriptor acquired under a closed owner.

Candidate JSAPI/context/realm/GC/OOM, partial-EAGAIN fairness, Worker and
four-host conformance remain unvalidated. Earlier OutputHandle-only
component fixtures still using `tty-output-open` need genuine native-TTY
protocol dependencies before they cover this generic admission; they are
not passing coverage for this source slice.
