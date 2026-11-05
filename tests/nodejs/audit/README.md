# Public Node core source audit

This is the active **audit-only** workstream. The earlier
[implementation outline](../outline/README.md) and its source-change
ledger describe prior work; they do not authorize further implementation.
Only audit documentation and audit metadata may change in this phase.
No new runtime tests, probes, compilations or builds are authorized.

All **19 broad family source reviews** now identify missing, inert or partial
implementations. The complete family-by-family deliverable is [audit-report.md](audit-report.md).
Static integrity results and the mandatory stopping point are recorded in state.json. Neither a source-review flag nor a list of
defects establishes implementation completeness or runtime conformance.

All 19 families have broad source-review reports. The current matrix contains
13,292 observations, including documentation/returned/inherited/cross-cutting
contracts; this is not a unique-API denominator. All 11,199 original discovery
obligations have source/applicability dispositions and observation links,
including two private/incidental exclusions. Linkage alone does not prove
implementation or runtime conformance. All 74 scoped modules have source
reviews with gaps; exact identities and detailed reports are recorded in
module-reviews.json and state.json. Event/Abort
globals, inherited NodeEventTarget contracts and
util cancellation helpers also have scoped source reviews. CompressionStream
and DecompressionStream owners have a scoped review, with stream/port
dependencies remaining open. The process family now has a complete source review with gaps, retaining
the earlier separate report review. Web Crypto, CryptoKey and
SubtleCrypto have a scoped negative/source review, with all 178 original
webcrypto documentation obligations retained; the complete web-family
source review now reconciles globals, Fetch, Web Streams and enabled features.
Classic/promise/consumer/iterable streams have a completed source review,
with seven consumer sections scoped from webstreams.md. Full stream/web
class source coverage is now complete with gaps in the web-family review;
eight earlier misplaced summary IDs remain preserved, without conformance claims.
The completed [values contracts](values-contracts.md) cover assertions,
Buffer, util/types, path, URL, errors and Intl, retaining the earlier scoped
reviews. Native addon/embedding headers and SEA packaging
narratives now have complete negative source reviews, with concrete
binary/engine boundaries separated from missing portable bridges.
The completed loading review includes public node:module, CommonJS/ESM,
packages, TypeScript and all CLI/environment discovery obligations, with
missing owners and an explicit package-map documentation/source conflict.

## Deliverables and stopping point

1. Verify the exact official target, source and native-reference pins.
2. Resolve the existing discovery obligations into a public-API matrix
   across every family, with source references and explicit open questions.
3. Trace each implementation through its owning layers and record host
   differences, prerequisites and justified boundaries.
4. Attach existing evidence without upgrading its scope or artifact identity.
5. Produce a dependency-based implementation roadmap and a later validation
   plan using unchanged upstream tests and native differential controls.
6. Stop for user review. Execution of the roadmap and runtime validation
   both require subsequent explicit authorization.

The stopping point does not permit implementation after the report is
written. A decision that prevents further independent audit work must also
be presented to the user before dependent work continues.

## Independent status dimensions

| Dimension | Meaning | Current state |
|---|---|---|
| Inventory | Discovery of docs, native descriptors and exposure policies | Existing index available, with documented discovery limits |
| Source audit | Requirements reconciled with actual implementations and owning layers | All 19 broad family reviews and original-obligation reconciliation complete with gaps |
| Implementation | Required behavior implemented rather than stubbed or approximated | Known gaps; prior source candidate unbuilt |
| Runtime conformance | Behavior established for identified artifacts and hosts | Historical, selected evidence only; current candidate pending on all four hosts |

The [inventory](../outline/review-rows.jsonl) contains review obligations,
not a count of unique APIs. Rows require resolution, including narrative
requirements, inherited APIs, getters, symbols and flag-gated surfaces.
Groups in the findings report are not a substitute for that reconciliation.

## Audit records

- [Values, assertions, Buffer, util/types, path, URL, errors and Intl](values-contracts.md),
  `values-requirements.json`, stored-source correspondence, error-code provenance
  and future unchanged-source catalog.
- [Filesystem, FileHandle, streams and public VFS contracts](filesystem-contracts.md),
  `filesystem-requirements.json`, exact stored-source/selected-range correspondence
  and future unchanged-source catalog.
- [Process, OS, child-process, cluster and permission contracts](process-contracts.md),
  `process-requirements.json` and future unchanged-source catalog.
- [Documentation and deprecation contracts](documentation-contracts.md),
  `documentation-requirements.json` with all 207 identifiers and future source catalog.
- [Web globals, Web Streams, Fetch and gated features](web-contracts.md),
  `web-requirements.json` and future unchanged-source catalog.
- [Target and reference pins](target-pins.md).
- [Family survey and initial cross-family findings](family-survey.md).
- [Values-family source review](values.md).
- [Querystring/Punycode and decoding/path reconciliation](values-query-codecs.md).
- [Legacy constants/sys review](values-legacy-modules.md) with
  `legacy-module-requirements.json` preserving conditional definitions beyond
  the saved native capture.
- [StringDecoder public/legacy contracts](string-decoder-contracts.md) and
  `string-decoder-validation-candidates.json`.
- [Network-family layer trace](network.md) and [complete contracts](network-contracts.md),
  `network-requirements.json` and future unchanged-source catalog.
- [Terminal-family layer trace and source findings](terminal.md).
- [TTY constructor, handle and inherited-owner contracts](tty-contracts.md),
  `tty-requirements.json` and `tty-validation-candidates.json`.
- [Readline, promise transactions and REPL contracts](readline-repl-contracts.md),
  `readline-repl-requirements.json` and future source/PTY companion catalog.
- [Async/events/timers source findings](async.md).
- [EventEmitter and static/returned contracts](event-emitter-contracts.md),
  `event-emitter-requirements.json` and its future validation catalog.
- [Async hooks, resources and storage](async-context-contracts.md),
  `async-context-requirements.json` and its future validation catalog.
- [EventTarget, Event and cancellation](event-target-abort-contracts.md),
  `event-target-abort-requirements.json` and its future validation catalog.
- [Timer ownership, phases and returned contracts](timer-contracts.md),
  `timer-requirements.json` and `timer-validation-candidates.json`.
- [Domain and diagnostics contracts](domain-diagnostics-contracts.md),
  `domain-diagnostics-requirements.json` and its validation catalog.
- [Worker-family summary](workers.md) and [complete source contracts](worker-contracts.md),
  `worker-requirements.json` and future unchanged-source catalog.
- [Observability source findings](observability.md).
- [Console module/global and stream contracts](console-contracts.md),
  `console-requirements.json` and `console-validation-candidates.json`.
- [Performance, observers and histograms](performance-contracts.md),
  `performance-requirements.json` and its validation catalog.
- [Tracing ownership, backend and target questions](trace-events-contracts.md),
  `trace-events-requirements.json` and its validation catalog.
- [Diagnostic reports and actual resource schema](diagnostic-report-contracts.md),
  `diagnostic-report-requirements.json` and its validation catalog.
- [Module loading and CLI source findings](loading.md).
- [Public Module/loading-contract reconciliation](loading-public-contracts.md).
- [Complete loading/language/CLI contract review](loading-contracts.md),
  [requirements and CLI consumer crosswalk](loading-requirements.json),
  [native base/patch source evidence](loading-native-source-evidence.json)
  and [future unchanged source candidates](loading-validation-candidates.json).
- [VM/engine/inspector source findings](engine.md).
- [VM/gated-module/V8/inspector/debugger contract review](engine-contracts.md),
  [requirements and source identities](engine-requirements.json) and
  [future unchanged sources](engine-validation-candidates.json).
- [Testing and benchmark tooling source findings](testing.md).
- [Process, child-process and OS source findings](processes.md).
- [Native integration source findings](native-integration.md).
- [Node-API/addon/embedding review](native-addon-contracts.md) and exact
  declarations/gates in `native-addon-requirements.json`.
- [Public C++ headers and SEA packaging](native-packaging-embedding-contracts.md),
  `native-packaging-embedding-requirements.json` and the future embedding/SEA
  catalog (which separately identifies native fixture sources).
- [Test/benchmark public-contract review](testing-public-contracts.md),
  `testing-requirements.json` and `testing-validation-candidates.json`.
- [Native public-member reconciliation](native-public-contracts.md), with
  `native-validation-candidates.json` preserving unchanged future test
  identities and activation requirements.
- `pin-file-correspondence.json`: local source/archive/native-executable
  identity checks, without executing the reference.
- [Documentation and narrative requirements](documentation.md).
- [Classic, Web and iterable stream source findings](streams.md).
- [Classic/promise/consumer/iterable contracts and owner gaps](streams-contracts.md),
  [requirements, returned members and family corrections](streams-requirements.json),
  [unchanged-source/factory correspondence](streams-source-correspondence.json)
  and [future unchanged source candidates](streams-validation-candidates.json).
- [Filesystem and Node VFS source findings](filesystem.md).
- [HTTP/HTTPS/HTTP2 source findings](http.md).
- [HTTP public/legacy/returned-owner contracts](http-contracts.md),
  [exact requirement/capture/source matrix](http-requirements.json) and
  [future unchanged-source candidates](http-validation-candidates.json).
- [TLS/DTLS/QUIC findings](secure-network.md) and [full contracts](secure-network-contracts.md),
  `secure-network-requirements.json` and its future unchanged-source catalog.
- [Crypto source findings](crypto.md) and [complete contracts](crypto-contracts.md),
  `crypto-requirements.json` and future unchanged-source catalog.
- [Web APIs and globals source findings](web.md).
- [Compression/ZIP summary](compression.md) and [full contracts](compression-contracts.md),
  `compression-requirements.json` and future unchanged-source catalog.
- [Provisional dependency-based implementation roadmap](roadmap.md)
  and [subsequent validation plan](validation-plan.md); neither authorizes
  implementation or execution.
- `module-exposure.json`: source-backed public entry-point review,
  independent of semantic implementation or conformance.
- `api-matrix.json`: individual API observations; currently partial.
- `module-reviews.json`: scoped module/member source reviews, separate
  from family completion, implementation completeness and conformance.
- `obligation-crosswalk.jsonl` and `obligation-crosswalk-summary.json`:
  every original discovery identity retained, with explicit unresolved
  applicability/semantic status and exact-path observation links.
- [Existing evidence review](existing-evidence.md), with artifact identities
  and original outcome counts in `existing-evidence.json`.
- `historical-evidence.tar.gz` and `historical-evidence-index.json` preserve
  156 pre-existing reports, their available manifests/case ledgers and
  referenced logs. Accounting reconciliation is separate from semantic
  review or current-candidate conformance.
- `baseline-failure-analysis.json`: original case-level diagnostic groups;
  3,687 of 3,721 failures per host stop at a shared helper's missing net
  accessor, limiting what can be inferred about later API assertions.
- `state.json`: exact audit input identities and family progress.

All source references are relative to the repository unless explicitly
prefixed `Node source:`. That prefix refers to the unchanged source tree
at `.context/nodejs-lts-cache-v2/node-v26.13.0`, pinned by
`packages/registry/node-compat/target.json`. Durable upstream links use
the exact source commit. Line references identify the source snapshot in
`state.json`; later implementation edits must invalidate affected reviews.

## Review rules

For each public API, record its requirements, source owner, observed source
behavior, missing or uncertain semantics, dependencies, applicable hosts,
existing evidence, proposed later tests and unresolved questions. Review:

- Exposure through CommonJS, ES modules, globals, aliases and CLI gates.
- Inherited behavior, property descriptors, symbols and callable constructors.
- Inputs, overloads, receiver brands, validation and error details.
- Ordering, cancellation, context propagation, ownership and shutdown.
- Actual underlying engine, host, libc and kernel capability.

Use `missing`, `stub`, `partial`, `source-backed/pending-conformance`, or
`unreviewed` for implementation observations. A completed source audit may
find implementation missing. A source-backed path has not thereby passed
runtime validation. A missing binding or backend is an implementation gap
until a concrete capability analysis establishes a real boundary.

The guest compatibility implementation runs inside the packaged
SpiderMonkey runtime on all four hosts. The embedding Node.js version is
not the guest implementation or its native Node 26 reference. Shared
JavaScript gaps therefore apply to all four hosts unless a separately
traced host path overrides them. This is a source inference, not a new
four-host runtime observation.
