# Compression and archives source audit

State: **complete source review with implementation gaps**. The full
report is [compression-contracts.md](compression-contracts.md), supported
by `compression-requirements.json` and the future unchanged-source catalog.
All 585 original discovery obligations are reconciled (167 document
sections and 418 saved descriptors), with returned/inherited contracts
added from source. This is not a count of unique APIs or passing behavior.

The final public path contains real pinned zlib/Brotli/Zstd, ZIP and
iterable algorithms, native contexts and a guest pthread work pool.
Finding those sources is insufficient: the review traces their actual
bindings, validators, byte storage, async callbacks, cleanup, filesystem,
stream and host ownership. The source candidate is unbuilt and has no
identified four-host codec conformance result.

ZIP-001–ZIP-006 retain the original codec/archive/iterator/Web requirements.
New findings ZIP-007–ZIP-010 document unsupported shared/resizable/leased
storage, narrower numeric conversion, wrong constructor initialization
errors and shared async/accounting/lifecycle dependencies. ZIP-011 and
ZIP-012 preserve exact target documentation/source questions about ZIP
post-close errors, inherited Brotli params and early archive-entry
cleanup. These questions require later native controls, not assertion or
implementation changes under this goal.

Node, Chromium, Firefox and WebKit share the guest codec implementation.
Actual thread/memory/descriptor ownership differs at the outer host
boundary; the completed worker report records termination versus guest
quiescence requirements. Wasm address-space or configured reservation
limits must be operation-specific; they do not exclude all codecs or
ZIP64 streaming. Missing public bindings/dependencies are implementation
gaps rather than accepted engine boundaries.

No runtime tests, probes, compilations, package builds or fixtures were
run. Historical evidence and every original nonpassing status remain
unchanged. The catalog records future source identities and flags/helper
roles, not executed cases. Implementation and new runtime validation
require separate explicit authorization after the overall audit review.
