# HTTP/1 response parser implementation and remaining owners

Source104 addresses portions of H-003/H-004 and removes the unconditional
replay in H-010. It also changes leftover-byte ownership in H-011/H-013.
The frozen audit, exact target/source/native reference and original nonpasses
remain unchanged. Neither an HTTP finding nor the family is marked complete.

## Source owners

- `packages/registry/node-llhttp/` builds the three unchanged C translation
  units from Node26.13.0's vendored llhttp9.4.3. Its source manifest verifies
  all six selected inputs, including the header, upstream gyp build list and
  actual llhttp license. Resolver-owned work/output roots, normal SDK target
  compilers and exact archive/target pins apply to wasm32 and wasm64.
- `third_party/node-core/http-parser.h` owns the streaming response parser,
  settings and callback data at a stable address. It cannot be moved/copied.
  Fragmented status/field/value bytes, body events and trailers are owned;
  no borrowed input survives a feed. C callbacks catch allocation/other C++
  exceptions before they unwind through C. Fatal error metadata is retained
  independently of llhttp's temporary error-position pointer.
- The owner applies the pinned Node header/status byte budget, independent
  chunk-extension budget, exact strict/insecure/relaxed llhttp modes, known
  request-method HEAD policy, informational-message continuation and CONNECT/
  upgrade boundaries. It pauses at a final ordinary response and retains the
  actual unconsumed input for socket retirement or upgrade handoff.
- `native-http-parser.cpp` supplies an opaque JSAPI class with private native
  state, real class/unwrap checks, a foreground finalizer and associated-memory
  updates for persistent owner allocations, including failure paths. HTTP text
  uses Latin1 and output body/head bytes are independent copies. Array items
  are own definitions rather than prototype setter calls.
- `http-parser-platform-adapter.js` embeds unchanged `_http_common.js`
  header/body/trailer/completion and error-preparation sections. Their full
  source and selection hashes are checked before bundling. The source feeds
  actual pinned IncomingMessage instances rather than a replacement Readable.
- The production HTTP/HTTPS client now uses that parser. Public parser-option
  validation is an unchanged `_http_client.js` section. Information/continue
  events precede the final response; upgrade/connect handlers receive their
  actual socket and head bytes. Unconditional pooled-request replay is removed.
  Same-feed leftover bytes cannot become a future response when no next
  request has been sent: that connection is retired instead of replaying them.
  Detection of later unsolicited/idle socket input remains incomplete. Keep-alive uses the parser's actual framing decision.
- SpiderMonkey recipe104 declares the direct node-llhttp dependency, private
  sysroot projection, link archive, staged owner header, generated native
  fragment and patch98 binding. No ABI, host import, kernel wire protocol,
  platform-identity spoof or memory-ceiling change is introduced.

## Identified evidence

`.context/node26-engine-r104-accepted/report.json` records the normal resolver
engine build and selected prebuild source identities rechecked afterwards.
The accepted `js.wasm` is 49,667,780 bytes with SHA256
`2bf73a6943394d8e20803e90029818a9f40bfe13b3c170007065b54722264f2b`.
This proves compilation of the current parser/client binding, not guest
execution. The prior kernel-policy preparation failure was not rerun or
bypassed. No current guest case, four-host run, overall suite or full product
rebuild is credited to this artifact.

`.context/node26-http-parser-controls-r4.json` has 25 passing portable native
owner/native Node HTTPParser differential cases. These cover fragmented and
Latin1/duplicate/empty headers, body/trailer framing, information/HEAD/upgrade/
CONNECT, EOF, malformed lengths/chunks/tokens/values, strict/insecure/relaxed
modes, header/trailer/chunk-extension budgets and sticky finish failures. The
native owner control poisons and retires input storage after each feed. Native
Node's JS completion callback cannot return llhttp's C pause result; the
reference control supplies bytes incrementally and stops at the actual final
message callback. This is an explicit native dependency, not guest code or a
model of parsing. Native input-granularity/chunk counts are not conformance.

`.context/node26-http-parser-frontend-r4.json` has 20 passing controls: eight
new cases and twelve existing incoming/header cases. The production frontend/
client/header/IncomingMessage source runs over actual native parser, stream,
abort, URL, Buffer allocation and loopback dependencies. New cases compare
information/empty status text, HEAD, upgrade/CONNECT head transfer, framing/
limit/leniency errors, public option validation and header-count behavior with
native Node. Separate cases reject unsolicited response reuse and POST replay.
Backend/frontend case counts overlap in behavior; they are not a count of
unique passing APIs. No unchanged upstream test file was newly run this slice.
Historical upstream results retain their earlier source identities.

Source checks verify four pinned reference files against the unchanged source
archive, six llhttp inputs, three unchanged JS selections, bundle/bootstrap
syntax, exact patch forward/reverse application, unchanged Mozilla style
checks, shell syntax and the untouched Bun loader remainder. Both library
architectures built through the normal resolver. The wasm64 resolve refreshed
its stale musl core through normal SDK preparation; that targeted dependency
build is recorded separately from the engine and from a full product rebuild.

## Nonpasses retained

The first native-control launch used unavailable `process.binding('http_parser')`
and ran zero cases; the control now uses Node's own internal-test binding under
`--expose-internals`. The first frontend launch used the wrong working directory
and discovered zero cases. A source check rejected header include ordering;
the authored include order was corrected without changing the checker.
Frontend run3 passed19/20: the native dependency consumed both same-buffer
responses because its JS completion callback cannot stop parsing that buffer.
The control's initial version and diagnostic output are retained; byte-at-a-time
native feeding corrects that dependency boundary. Assertions were preserved.
An unresolved Promise is not a passing case, even if a subprocess exits0.
Reports, raw logs and these nonpasses remain in the snapshot chain.

## Remaining implementation and validation requirements

1. The private bridge collects native events before invoking JS. Equivalence
   for synchronous response/body callbacks, reentry, exceptions, abort/destruction,
   input mutation and pause/read ordering during execute is unresolved. These
   are implementation/validation obligations, not accepted platform exclusions.
2. Persistent native capacity is counted, but transient input/event/packet
   allocations, allocator overhead and GC-pressure/cross-realm/shared/resizable/
   detached-byte paths need a complete ownership/accounting review. Engine
   compilation alone proves none of the finalizer/OOM/GC behavior.
3. Parser error positions/rawPacket and callback ordering need broader unchanged
   upstream/native/guest comparisons, including EOF after partial headers/body,
   many empty fields, obsolete folding, all framing/limit boundaries and unusual
   versions/statuses. Current public EOF/abort/error policy is still partial.
4. There is no server/request parser owner, ServerResponse or full OutgoingMessage,
   and no HTTP/2 protocol owner. Automatic outgoing chunking/trailers, strict
   lengths, expect/continue sending policy, validation warnings/CLI semantics,
   methods/public parser configuration and legacy exports remain gaps.
5. The private pool is not Node Agent. Custom/disabled agents, queues, public
   limits/scheduling, TLS-sensitive pool keys, idle unsolicited data detection,
   socket reuse counters, timeout/ref policy and public lifecycle need real owners.
   Removing replay does not close all H-010 error/metadata obligations.
6. Upgrade/connect detach, post-handoff close/error/ref/timeout behavior, no-handler
   retirement, double responses, unread responses and unfinished writes require
   actual guest/network/stream integration and all four hosts. Existing source
   controls cannot replace that evidence.
7. URL/auth/options, request/response/HTTPS alias and descriptor identity, AbortSignal,
   TLS/server/permission capabilities, diagnostics and the rest of the frozen HTTP
   contract remain open. Complete shared socket/TLS/stream dependencies first,
   then replace the remaining handwritten public client/Agent/server algorithms
   with upstream owners where their dependencies are available.

Continue the breadth-first pass across independent audited owners; do not turn
these focused parser checks into an overall-suite campaign. Later validation
must use admitted, identified kernel/image/engine artifacts and preserve every
skip, unsupported case, timeout and harness error as a nonpass.
