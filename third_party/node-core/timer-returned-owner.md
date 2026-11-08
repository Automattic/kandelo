# Returned timer method and inspection ownership

Timeout close, dispose and primitive methods, and Immediate dispose, are ordinary
functions assigned to the real existing prototypes, as in pinned lib/timers.js.
They keep writable/configurable/enumerable descriptors and real Function
prototype/constructibility/name semantics; close/dispose consume the existing
actual cleanup owner. Explicit per-function strict directives preserve the Node
module receiver semantics in classic-script/extracted bootstrap consumers.

Timeout has the pinned custom inspection method. It calls the genuine private
inspection function captured from _nodeInspection, with ordinary option spread,
depth0 and customInspectfalse. It inspects actual receiver fields rather than
rendering a fabricated Timeout string, and does not consult a mutable replacement
of public util.inspect. Getter exceptions preserve their original identity.

The existing native-dependent timer fixture receives the real native inspection
owner and can select a private bootstrap path. Its scheduler/AsyncResource/ALS/
inspection dependencies are explicit. The existing eighteen-case promises
regression assertions are unchanged. Twelve focused returned-method/cleanup/
inspection observations compare to pinned Node26.13.0. These controls validate
neither Kandelo's private inspection metadata backend nor guest scheduling,
GC/realm/fatal/Worker or four-host conformance.

This is A-012 partial implementation. The accompanying additive A-015 source
implements selected actual async-ID-backed primitive and known-ID-map behavior;
see timer-primitive-owner.md for scope and preserved nonpasses. Cancellation
inside an actual init hook still has unresolved native timeouts, and mutation
of the public async-ID symbol versus the private runTask record ID remains an
open source question. Native Promise hook mode (A-022) and broader native phase,
cleanup/coercion/fatal/GC/realm/Worker/four-host behavior remain implementation or
validation obligations. The combined source is not complete Timer conformance.
Control counts above describe historical native-dependent evidence; fresh batch
observations and source identities are recorded separately.
