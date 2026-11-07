# Accepted TCP resource integration

Source170 composes accepted-owner changes with current169snapshot CLI,
166root/backing corrections and earlier Signal/UDP dispatch. A null-prototype
capability now roots the real TCP owner constructed/initialized before Promise
publication and before Socket/drop/blocklist getters. Later adoption returns
that same owner once, with wrap-before-transfer. Real descriptor Lease rollback
and queued owner close handle failures/drop/unclaimed capabilities. No numeric
fd capability, second owner or fabricated resource/trigger metadata is used.

Accept completion unlinks/owns its current watch before any init/rejection
can enter JS and returns afterward, instead of resuming a saved raw next
pointer. Other legacy-watch branches still require their own reentry review.
The actual creation Promise supplies the owner/token realm; real moving-GC,
CCW/OOM/context retirement behavior remains unvalidated.

Four fresh native-boundary scenarios exercise twelve real accepts with
current extracted publication/adoption code: five concurrent identities, two
poisoned-then cases, three drops and two constructor-getter failures. Actual
native TCPWrap owners/IDs/descriptors are the explicit boundary; the limited
Socket wrapper does not execute candidate SpiderMonkey init/watch behavior.
The unchanged native getter reference also passes.14package checks, normal
source/bootstrap/unity and exact zero-fuzz engine patch replay checks pass.
No native helper/engine/kernel/product compilation or overall suite ran.

Initial native exit138 from reading a private fd during init and the source-
check harness failure remain preserved. The corrected control captures
identity at init and reads the descriptor only after acceptance; it makes no
native fd-at-init or runtime-vendor defect claim. No upstream assertion was
weakened or native reference converted into passing guest coverage.

A real listener TCPWRAP/default-trigger/frame/native onconnection owner is
still missing. Promise-delivered constructor/listener failures do not establish
native callback/fatal parity. Complete Socket/Server controls/lifecycle,
ref/fd/generation/close/relisten/transfer/disposal and actual four-host JSAPI/
GC/resource conformance remain open. See [ledger](accepted-tcp-owner-finding-progress.json)
and [broader TCP scope](tcp-agent-integration.md).
