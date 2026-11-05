# StringDecoder implementation and validation dependencies

V-018/022/027/028 remain scoped findings, not completed values-family or
four-host conformance claims. The frozen audit and exact Node 26.13.0
source/native pins remain unchanged.

## Owning implementation

The full unchanged public lib/string_decoder.js now supplies construction,
write/end/text and legacy state accessors. It consumes the existing exact
normalizeEncoding helper and shared errors. Constructor assignment and
subsequent encoding reads retain accessor receiver behavior; strings bypass
write receiver checks as required by the target. Proxy receivers see the
actual symbol-owned state, and lastChar returns fresh views over that state.

string-decoder-adapter.js implements the pinned native incremental/flush
algorithm over real seven-byte Buffer storage. Encoding tags and field
offsets are generated from retained full native references, not preset
capability metadata. Actual incomplete bytes and missing/buffered counters
share this storage; no WeakMap hides different receiver semantics. UTF-8
continuation interruption, UTF-16 odd tails/surrogates and base64/base64url
remainders use the same state transitions as the pinned native owner.

Private Buffer byte codecs supply character conversion over intrinsic view
spans, avoiding mutable global TextDecoder or public Buffer.from/toString.
Public end/text and lastChar retain the target's own observable dispatch.
Detached/out-of-bounds views become empty at the intrinsic contents boundary.
UTF-8 span limits use the actual embedding string ceiling with the intended
ERR_STRING_TOO_LONG code; no V8 limit is advertised for SpiderMonkey.

Full public/native/header/inline/encoding/conversion/normalization references
are retained in upstream/string-decoder and checked against the source
archive. Recipe 59 consumes the changed shared bootstrap/bundle; no new
native engine patch, syscall, ABI change or guest build is introduced.

## Evidence and its limits

Five focused differential scenarios pass using the actual candidate
Buffer/codecs/state/public module and exact native reference. They cover
normalization/accessor order, proxy/string/error receivers, method/accessor
metadata, incremental byte output/state/flush, detached/resizable/shared and
cross-realm views, mutable conversion hooks and legacy dispatch. A small
injected ceiling exercises error branching without claiming either engine's
actual maximum allocation. This is not a large-allocation runtime test.

Two unchanged upstream files (end and fuzz) pass in candidate and native
modes. The harness replaces only StringDecoder; native engine/brands,
allocation, oracle Buffer conversion, assertions/common helpers and
transitive native stream constructors remain explicit control boundaries.
The base file's memory-gated large allocation and the separate large-input
file remain unrun. Two affected existing StringDecoder controls pass; nine
unselected tests in their file are skipped, not compatibility passes.

The first generated bundle failed to parse because the public module and
adapter shared a lexical scope. Its five harness errors, raw logs and exact
input copies are retained. The public module now has its normal isolated
factory scope; assertions and upstream source are unchanged.

## Remaining work

Guest engine initialization and actual Buffer allocation/brand behavior,
real engine ceilings/allocation failures, GC/realm and mutable/private state
edges remain unvalidated. Shared/resizable concurrent mutations require the
actual guest/storage controls. Invalid private state corruption and exact
native fatal behavior are not covered. Complete Buffer ownership and shared
error/stack fidelity remain prerequisites. TextDecoder's broader encoding
surface is independent and is not completed by this slice.

Later validation must use identified artifacts on Node, Chromium, Firefox
and WebKit, retaining unchanged upstream cases and their original skips and
memory conditions. No public API/family is marked complete. Continue the
breadth pass; overall suites and the full product rebuild remain deferred.
