# Owned engine message packets and actual adapter integration

This partial R-001/003/005 worker/clone prerequisite follows the completed
source audit. The exact Node26.13.0/SpiderMonkey/source/native pins remain
unchanged. No individual API or family is closed.

## Actual owners

native-ports.cpp now owns JSAutoStructuredCloneBuffer packets directly,
using the pinned engine's SameProcess scope and real clone data policy.
js/public/StructuredClone.h lines120–141 explicitly define this data as
thread-movable (Send) and not bitwise-copyable. This is not a shell
CloneBufferObject or a rooted source-realm JS value. Endpoint queues own
shared native packets, and the receiving realm creates its own opaque owner
before calling the engine reader. Pending data contains actual engine-held
transfer/shared-buffer/string references, not arbitrary borrowed JS pointers.

Opaque packet owners allocate before writing can detach transferred stores.
Failed writes clear partial data; refused or failed publication retires
storage. Atomic publication/consumption guards reject repeated use without
holding a mutex over reentrant deserializer hooks. Reads consume once and
clear data on completion/failure. The default callback/closure is null; the
engine's actual Kandelo host-clone table/protocol still owns registered host
object data and deserializer hooks. Testing-only serialization callbacks
are not installed. Native close acknowledgement now consumes the endpoint's
actual pending notification so a delivered close need not keep the loop live.

The production SpiderMonkey JS adapter now forwards actual message packet
serialization/deserialization. It also forwards all eight new DNS channel/
query/configuration/version bindings. The previous engine72 registered and
compiled the C++ DNS owners but omitted these JS forwarders; full guest startup
would call a missing dnsVersion function. That integration gap is fixed in
source, and retained independently from the earlier native-boundary passes.

## Evidence and exact boundaries

The DNS control now executes the complete production adapter prefix before
using the public candidate factories. Its initial run fails with the actual
missing adapter.dnsVersion; input/log are preserved in
.context/node26-adapter-dns-r1. After forwarding, the same 26 Resolver
scenarios pass in .context/node26-adapter-dns-r2. Native Node still owns the
channel/request/OS/VM boundary; this is not guest JSAPI behavior.

Three existing port graph/event/ref/close/byte-transfer scenarios and four
lookup/observer controls also execute the actual adapter now. Their assertions
are unchanged; seven pass in .context/node26-port-packets-controls/output.log.
The port control supplies actual Node queues/structuredClone/V8 bytes and
manual dispatch, not Kandelo's engine buffer. It does not validate native
packet storage, scheduler phases or cross-worker delivery. Source checks
verify actual unchanged reference modules/pins/audit, generated bootstrap
syntax, patch83 exact forward/reverse and unchanged Mozilla include checks.

Targeted engine compilation and any identified guest checks are recorded
separately when terminal. No overall suite or full product rebuild is run.

## Remaining implementation and validation

* Actual cross-worker Node bootstrap/loader, workerData/environment, private/
  public port transport, ready/error/exit handshake and independent stop/join.
* Endpoint transfer/adoption, broadcast groups and context movement; native
  packet ownership alone does not implement them. Transfer-mode host objects
  and ports still explicitly reject; no false successful transfer is added.
* Full MESSAGEPORT native provider identity, callback/phase/ref/fairness and
  wakeup ownership; GC, realm/wrapper, error/close and shutdown race behavior.
* Exact associated native byte/GC-pressure accounting, allocation-failure
  atomicity, shared/resizable/Wasm/module resources, clone marks, public
  descriptors/errors and host-object/stream transfer lifecycle.
* Execute identified guest packet/port/adapter artifacts and later unchanged
  worker/message/clone tests on all four hosts after breadth prerequisites.
  Preserve all failures/timeouts/harness errors and original audit identities.

DNS configuration-refresh, permission/name-source/egress and lifecycle gaps
remain recorded in dns-channel-implementation-dependencies.md. No new platform
exclusion is accepted. Move to independent owners after this source slice.

The normal targeted wasm32 engine75 build subsequently succeeded in
195.2 seconds with all 621 frozen selected source identities unchanged.
The previously compiled exact c-ares dependency was reused through the
normal resolver. Unchanged Mozilla
checks, optimization and fork instrumentation passed. Reports, executable
copies, dependency provenance/archive are retained in
.context/node26-engine-r75-accepted. Targeted Node-host guest outcomes, if attempted, are recorded separately below;
no overall suite or full product rebuild occurred. Four-host conformance is
unestablished. Compilation does not close
configuration, permission, identity, ordering or resource-lifecycle gaps.

Targeted Node-host guest report: .context/node26-port-packets-guest-r3/report.json;
counts {"pass": 2, "fail": 0, "timeout": 0, "harness-error": 0}. Preparation error: None.
These identified artifact checks do not close any family or four-host conformance.

Guest engine73 checks retained two failures: a raw-shell fixture attempted
to access Node-private bindings (unavailable by design), and real Node startup
read util's abort helper before event initialization. The latter source order
is corrected in engine75. Revised guest cases use public MessageChannel APIs
without exposing private bindings. The host warns that Default build-deps
artifacts lack the ABI-contract stamp; SourceOnly publication supplies those
stamps. These checks are not ABI-complete or stamped product conformance.

Engine74 reached the next startup failure: internal ZIP constants received
public Buffer where internal FastBuffer was required. Engine75 supplies the
actual separate allocator to streams, and three unchanged fd/stream controls
pass with public/private constructors supplied separately. Both engine74
failures and exact prior inputs remain in guest-r2; the revised guest-r3
outcomes are recorded separately. No failed observation is replaced with a pass.


The subsequent worker-owner slice reached engine83 acceptance and six identical
native/Node-host guest cases pass. Public endpoint/host/stream movement and
complete Worker/lifecycle/ordinary stamped-consumer/four-host obligations remain
open. See worker-owner-implementation-dependencies.md for exact artifacts.
