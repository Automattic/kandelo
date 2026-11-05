# Headers, WebIDL and Fetch header ownership

WEB-002 has a source implementation over real shared owners. WEB-003/004/005
have related partial header-consumer changes. No web-family finding or
four-host conformance closes; the exact target and frozen audit remain intact.

## Actual implementation

The webData manifest now retains the complete unchanged pinned Undici
headers.js and core util reference. Existing full WebIDL, runtime features,
core symbols and live-iterator source remain shared with FormData. Six exact
hash-checked sections supply header name/value validators, the token table/
regexp and prototype-safe setHeader primitive. Source generation checks
whole-file and selected-section identities. These are actual algorithms,
not export aliases or a replacement map facade.

The existing shared factory cache owns both constructors and WebIDL brands,
converters and iterator symbols. It uses null-prototype factories, claims
modules before evaluation and retires failed evaluations. Headers state and
guards are private class fields. Full retained source supplies constructor
conversion, required argument/receiver checks, ByteString/token/value
validation and normalization, sorted live iteration, Cookie delimiters,
independent set-cookie arrays, descriptors and custom inspection. Creating
Headers registers actual noncloneable mode with the guest serializer.

Global Headers and the Fetch implementation use the same class. The old
public _map class is removed, and consumers no longer depend on it. Request
and Response own the actual request/response header guards. Response clones
preserve their source guard; actual transport responses have immutable
guards rather than exposing a mutable list. This does not supply the still
missing full Request/Response WebIDL/body state machines.

The HTTP transport adapter consumes the private header list into a
null-prototype dictionary, preserves legal __proto__ names added by public
append and retains separate set-cookie values as an array for the existing
outgoing-header owner. init.headers replaces input Request headers when
provided, following the pinned Request source and native control; the old
merge behavior is removed. Full Fetch redirect/filter/error/body/framing,
Request lifecycle and transport semantics remain separate implementation.

The pinned Headers constructor's record path omits __proto__ supplied as an
own property, while append retains it. A native Node 26.13.0 control records
both exact outcomes. This is target behavior preserved for comparison, not
an accepted platform exclusion or a claim about generic WebIDL conformance.
The first authored transport test incorrectly assumed that record survived
constructor conversion. Its failed assertion is retained; the corrected test
compares constructor entries against native Node and separately appends the
legal name before checking actual transport preservation. Upstream assertions
remain unchanged. No external runtime defect or workaround is claimed.

Recipe revision 53 binds the changed bootstrap/bundle bytes. No engine patch,
new syscall/import, ABI/wire change or package/engine/product build is added.
All four hosts select common guest source; none has current guest validation.

## Evidence and boundaries

Six new focused controls plus 13 affected File/FormData and 13 Response body
controls pass: 32 total. They load actual candidate source; native Node
supplies engine/brands/inspection/clone refusal and byte/text/stream inputs.
Header name/value controls enumerate all 256 byte values and high-Unicode
cases, rather than sampling the broader suite. Prototype/descriptor/receiver,
getter/iterator failure identity, live sorted iteration, cookie copy ownership
and immutable guards are checked against the exact native reference.

The transport control evaluates the real Fetch consumer source over a named
in-memory HTTP request boundary (control.invalid is never contacted). It
checks final request options, replacement semantics, private header-list
reduction, immutable response/clone guards and values. It does not validate
HTTP/kernel/host transport or Fetch network semantics. Body regressions
retain their explicit web-streams-polyfill boundary, now with the actual
candidate clone-registration source supplied through a native mode control.
Those checks are not evidence for the guest stream engine/serializer bridge.

One unchanged upstream file, test-whatwg-headers.js, passes in candidate and
native modes. Only global Headers is selected by the preload. The candidate
CJS fixture loads actual shared constructors/WebIDL; native Node supplies
unused File/Blob/stream inputs, brands, uncloneability, inspection and
assert/common. No WPT assertions, platform identity or skip list changes.

The original 31-pass/one-failure run remains evidence of an authored native
expectation mismatch. The subsequent 32-pass stage before Request replacement
is historical; its exact inputs and upstream report/log copies are retained.
Final source/checksum evidence is recorded separately, never retroactively
attributed to the earlier candidate.

## Remaining work

Complete Request/Response and Body mixins, full WebIDL/conversion/activation,
multipart extraction/parsing, Blob/encoding/URL algorithms, transfer and
WebCrypto. Complete the network/HTTP/TLS prerequisites, stream backpressure,
abort/redirect/connection/filter/header-guard and shutdown policies. Full
Request init dictionaries, body ownership, methods, signals and metadata
remain partial despite correct header replacement in this source slice.

Validate guest brands/proxy/realm/intrinsics, clone rejection/GC, inspection,
header guards/copies and actual HTTP header bytes, ordering, duplicate fields
and errors over identified artifacts on Node/Chromium/Firefox/WebKit. Expand
applicable unchanged upstream/WPT coverage with its actual harness/resources
after the breadth pass and within the existing build authorization. An export
or copied algorithm does not close those integration/conformance requirements.
