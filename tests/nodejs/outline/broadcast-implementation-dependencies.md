# Named broadcast groups and owned engine messages

Revision 115 implements another worker-family slice from the audited
ports/broadcast requirements. The completed audit and exact Node 26.13.0
source/native pins remain unchanged. No family or individual audited API
is declared complete by this slice.

## Actual source owners

The unchanged pinned BroadcastChannel class now obtains a real named native
endpoint. Its constructor/coercion, name, event handlers, validation,
closed-post errors, close and ref/unref retain the upstream algorithms.
The MessagePort bridge preserves native false separately from undefined:
a group without recipients returns false internally and successful void
BroadcastChannel.postMessage publicly, rather than a fabricated failure.

`port-queue.h` owns process-wide group membership under a native mutex,
publication order and endpoint delivery. Each member has a private ingress
and a real receiving endpoint using the existing queue/start/ref/close
owners. Closing a named member preserves other members. Membership removal
and publication share a lock; finalization removes the native pointer before
destroying its fields. The registry owns no JS objects or member lifetimes.
Context shutdown explicitly disconnects its group members and drops queued
data. A closed member cannot join a later group just because its name is
reused. No timer or listener-only facade keeps a channel alive.

The native engine packet separates serialized storage from per-delivery
consume-once envelopes. Broadcast serializes the user graph once, rejects
transferred data before sharing and gives each recipient its own envelope.
The actual SameProcess clone buffer remains owned until all envelopes retire.
It is neither bitwise-copied nor cleared by the first recipient. The pinned
JS_ReadStructuredClone contract permits repeated reads without transferables;
no group mutex is held over engine deserialization or reentrant JS hooks.
Worker bootstrap/error packets retain their independent single-consumer
ownership through this shared storage type.

The target native source uses a UTF8 C-string group key and an empty-key
close rule. The bridge preserves that source policy, including embedded-NUL
group-key truncation while public .name retains the complete coerced string.
A separate exact-native observation confirms that closing an empty-name
channel closes its surviving peer handle, after which public posting throws
the target default DOMException. This records observed pin behavior, not a
new platform exclusion or an allegation about an outside runtime.

## Identified evidence

* `.context/node26-broadcast-frontend-r1.json`: four new BroadcastChannel
  controls and seven unchanged affected port controls pass. Candidate IO,
  port and message-event source uses explicit native Node queue/engine
  boundaries, including a real native worker. It does not test guest C++.
* `.context/node26-broadcast-native/result-r2.json`: the actual portable
  registry/endpoint owner passes ordered fanout, self/group exclusion,
  shared-storage retirement, per-recipient envelopes, close/name reuse,
  the empty-key rule, 6,000 deliveries from four native threads and 1,000
  publications racing member destruction. These are operations in one
  native control program, not 7,000 public API compatibility cases.
* `.context/node26-broadcast-empty-reference.log`: exact native pin
  observation with the actual returned handle's close event. The private
  handle is an explicit observation boundary; public posting is observed
  after that event, without a fixed event-loop-turn wait.
* `.context/node26-broadcast-source-r2/report.json`: four source checks,
  twelve selected identities, two full Node source references verified
  against the pinned archive, and identified held Mozilla API/implementation
  references. The held Mozilla files are not represented as a newly
  verified complete archive closure. Target, audit, bootstrap and build
  script remain unchanged. The first checker incorrectly required the
  manifest to list itself as an input; its failed log remains recorded.

The canonical targeted engine build succeeds once, reusing all eight
library nodes and building only SpiderMonkey. Normal resolver admission
accepts js.wasm, 49,766,428 bytes, SHA-256
`4f720e13746e9ef21240d20db5dde41d73d183edd0c1deebf2fb577936ca5d93`.
Its ABI 55 contract matches the retained kernel. Build/checker logs,
projection, receipt, unchanged selected inputs and actual artifact bytes
are retained in `.context/node26-engine-r115-accepted`. This also compiles
the earlier revision-114 temporary-directory owner. It is not a complete
immutable SDK/kernel/host/product closure.

`.context/node26-broadcast-guest-candidate/report.json` records four matching
same-source exact-native/Node-host guest controls, all exit 0, with no skips,
unsupported cases, timeouts or harness errors:

1. Real group fanout, synchronous consumption, cycles, independent object
   clones, one getter evaluation and genuinely shared SharedArrayBuffer data.
2. Asynchronous message delivery and event fields, then closed-post failure.
3. A real guest Worker exchanging a named-group message and acknowledgement.
4. The affected sync/promise temporary-directory disposal owner, real file
   contents, removal and repeated cleanup.

These controls are `tests/nodejs/controls/broadcast.cjs`, run unchanged
against the exact native reference and the admitted guest artifact. The
report identifies the native binary, outer Node host, engine, kernel and
retained image. This is selected Node-host guest evidence, not overall,
whole-worker or four-host conformance. No new unchanged upstream broadcast
test file, overall suite, kernel/host/image build or product rebuild ran.

## Remaining dependencies and limits

Complete concurrent engine reads across multiple guest workers, custom host
clones, reentrant/GC/OOM/teardown and allocation-failure publication behavior,
native payload memory accounting, exact port close/transfer/context/descriptor
semantics, full worker options/lifecycle/stdio/metadata, nested routing,
postMessageToThread and locks. Native helper lifetimes and one real worker
exchange do not establish these contracts. No API-specific engine/platform
exclusion is accepted here.

Chromium, Firefox and WebKit have no new identified-artifact validation for
this slice. All 19 families remain incomplete. Historical SQLite
constructor/error/session failures and earlier nonpasses are retained;
these four passing controls neither rerun nor explain them. Continue
independent audited work before overall suites and retain the full product
rebuild deferral.
