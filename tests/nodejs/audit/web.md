# Web APIs and globals source review

State: **source review complete with gaps**; see [complete contracts](web-contracts.md)
and `web-requirements.json`. The initial survey below covers final global ownership, rather than
mistaking earlier placeholder definitions for the final implementation.
No new WPT/upstream test, network probe or build ran.

Bootstrap installs pinned EventTarget/Abort/DOMException, clone and Node
Web Stream algorithms (see async/streams/workers reports). URL and
URLSearchParams come from whatwg-url 14.2.0 through the checked-in
node-web-platform bundle. Its original web-streams-polyfill is retained
but superseded in production by Node stream factories. Blob is a custom
owned-byte implementation at bootstrap:6701–6836; Fetch classes and
transport are custom at 6991–7367.

The [Event/Abort contract review](event-target-abort-contracts.md) now
records the complete scoped globals, inherited NodeEventTarget and util
cancellation requirements. A-027–A-030 distinguish real algorithms from
clock/fatal/transfer/consumer gaps and target prose/source questions. This
does not complete the other web surfaces or their dependency audits.

| ID | Requirement | Source finding |
|---|---|---|
| W-001 | File, FormData and WebCrypto | File/FormData remain empty fallback classes; no multipart encoding/parser; subtle/CryptoKey missing. Temporary Headers/Request/Response placeholders are replaced later and must not be reported as the final implementation |
| WEB-002 | Headers WebIDL validation/normalization, ordering and cookies | FetchHeaders exposes a public _map, accepts arbitrary names/values without token/CRLF validation, preserves insertion order and merges all values including set-cookie. getSetCookie and full target descriptors/brands are absent |
| WEB-003 | Request constructor, Body mixin, clone, URL normalization and options | FetchRequest copies public fields with little validation and no complete Body methods/clone/bodyUsed/stream ownership. URL objects can fail because only string or .url is read. Method/body/signal, duplex, redirect and other options are incomplete |
| WEB-004 | Response complete Body/static API and WebIDL behavior | Real byte copying, streams, disturbance checks, body consumption and clone exist; formData/static error/redirect/json and full descriptor/status/header rules remain absent or unreviewed. Presence of real bodies does not establish full Fetch behavior |
| WEB-005 | fetch request body transport, redirects, scheme and error policy | Transport at 7223–7288 stringifies unsupported body types rather than consuming Blob/FormData/ReadableStream; uses custom HTTP client without complete Fetch redirect/response/filter/decompression policy. Scheme/URL/method/headers/options validation differs |
| WEB-006 | Shared/transferable structured clone and messaging ownership | Real clone hooks exist, but MessageChannel/BroadcastChannel globals throw transport-not-implemented and worker ports are separate incomplete facades. Stream transfer also depends on this missing transport |
| WEB-007 | Complete target globals and platform-gated APIs | Navigator, storage, WebSocket/EventSource and other globals need exact target/source/activation crosswalk. They are not established by their availability in the embedding browser. Guest globals execute inside SpiderMonkey |
| WEB-008 | Encoding, URL, Blob and internationalization semantics | Custom encoder/decoder/Blob plus independent URL/Unicode tables require exact-target validation. Intl fallback uses per-codepoint segmentation and simplistic formatting; fallback source cannot establish grapheme/locale correctness. Review actual engine ECMA-402 capability before deciding which fallback is active |

All four hosts run these guest objects. Host fetch used by browser egress
does not replace guest Fetch/WebIDL/body semantics; actual transport may
introduce host-origin/CORS/service limits for particular destinations.
Local/session and Node raw-network routes differ. No generalized browser
boundary excuses missing constructors, parsers or body lifecycle.

Existing older body/clone/URL controls are scoped to their identified
artifacts and sometimes the retained ponyfill rather than this candidate.
Later unchanged Node/WPT coverage requires its real WPT harness, flags
and resources. Native controls need brands/receiver descriptors,
Unicode/encodings, repeated/locked/disturbed bodies, cloned byte isolation,
BYOB/detachment, abort races, multipart/blob/stream bodies, redirect modes,
header validation/cookies, compression, global/module identity and exact
error classes. Preserve every unsupported launcher/resource separately.

The complete review now records global/flag activation, WebIDL/descriptor
requirements, Body/transfer graphs, target storage/navigator/Worker/
WebSocket/EventSource owners, encoding/ICU branch selection and Fetch
redirect/header/connection lifecycle gaps. Exact native conversion/order,
clone cleanup, data/byte/GC/ref and runtime questions remain explicit in
the report; they do not turn implementation gaps into accepted boundaries.
