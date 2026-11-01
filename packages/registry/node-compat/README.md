# Node core compatibility target

`target.json` pins **Node.js 26.13.0 (Lithium LTS)** as the API target,
its upstream source tag/commit/archive and native oracle archives. It is
independent of the host/build toolchain (currently Node 24). The normal
SpiderMonkey package generator embeds this same pin in the shared
bootstrap and C CLI version string, preventing separate version
constants from drifting.

The compatibility goal is public Node 26 LTS APIs on the Node host,
Chromium, Firefox and WebKit, with explicit engine and platform limits.
The implementation remains partial; that goal does not turn missing
behavior into supported behavior.

The guest engine remains SpiderMonkey 140.11.0 ESR. It reports `wasm32`
and `kandelo`, including through `os.platform()`. It provides no native
Node addon ABI, V8 or libuv implementation, so `process.versions` does
not advertise versions for them. Changing the API target does not enable
their flags or promise their behavior. Products built before these
changes must be rebuilt before the new identity or source fixes are
observable. The validation below uses the normal shell product; other
application images are outside this audit.

## Coverage audit

The implementation is partial. Its builtins and globals include working
operations mixed with incomplete behavior and, in older APIs,
placeholders. Export presence is not implementation coverage. In
particular:

- Filesystem, process, Buffer and URL regressions have targeted source
  and guest fixtures. Windows file URL options, legacy URL helpers and
  complete filesystem argument/error validation remain incomplete.

- Positioned reads/writes now use libc pread/pwrite without changing the
  shared descriptor cursor. Read positions retain exact signed-64-bit
  bigint values, and read/write options follow the pinned Node target.
  Source differentials and the shared Node/Chromium/Firefox/WebKit
  regressions pass. Shared-buffer filesystem I/O, full async I/O
  scheduling and exact argument messages remain gaps.

- The shared source has streaming UTF-8/UTF-16 decoding, Windows-1252,
  BOM/fatal handling, complete UTF-8 encodeInto writes, and
  Node-specific StringDecoder buffering/flush behavior. Source/native
  comparisons and the shared four-host regressions pass. Other legacy
  TextDecoder charsets and custom inspection remain gaps. Buffer's
  non-UTF8 encoding APIs are still partial.

- Response bodies now use actual stream disturbance/lock state, reject
  repeated consumption, clone streams with independent bytes and forward
  cancellation/errors. Blob byte storage, slices and byte/text streams
  are implemented. Source differential/FileAPI checks and rebuilt guest
  regressions pass on the Node host and all three browser engines.
  Complete MIME parsing, formData, Request bodies, Headers guards and
  Web-object cloning/transfer remain gaps.

- TCP servers now bind/listen/accept through real nonblocking POSIX
  sockets. Server closure waits for accepted descriptors; Socket.end uses
  actual write-half shutdown. Native watch reference state drives listener
  and socket lifetime. Eight focused cases pass on each host, including an
  independent C client over IPv4 and IPv6. The accept path compares live
  connection counts with maxConnections before constructing a Socket. It
  drops excess descriptors, including at zero capacity, with real endpoint
  records. Three unchanged upstream limit/drop files pass on all four
  hosts. Cluster distribution and dropMaxConnection are not supplied.
  Callable constructors, complete listen overloads/descriptors, IPC/fd
  listeners, BlockList, socket controls and full stream behavior remain gaps.

- Streams, Fetch networking and process lifecycle need broader upstream
  coverage. Shared natural exit now has a shell teardown hook for files and eval,
  including queued work and fatal status. File/eval/ESM regressions pass
  on the Node host and all three browser engines. Default fatal exceptions
  now stop live timer/I/O work, unhandled rejections are checked after the
  microtask checkpoint, and timer/ESM failures retain their thrown values.
  Ten-program rebuilt regressions pass on all four hosts, including live
  child I/O and nonfatal controls. Throwing exit listeners now preserve
  the actual validated status, including zero and explicit exits, and
  already-fatal exits retain the original diagnostic. Seventeen additional
  programs pass on all four hosts against exact native controls.
  beforeExit, custom uncaughtException/unhandledRejection policy and
  complete timer ordering remain gaps.

- Timers use a private monotonic deadline scheduler with independent
  reference counts, cancellable handles, interval self-cancellation and
  refresh after firing. Unreferenced callbacks remain eligible during live
  work. Immediate batches defer newly queued callbacks and permit
  microtask checkpoints between callbacks. Promise timers implement
  signal/ref options, interval iterators and scheduler wait/yield; custom
  promisification selects these APIs. Duration normalization emits real
  asynchronous process warnings. Fourteen named programs pass on all four
  hosts; the unchanged 64-file follow-up is still partial (39 pass, nine
  fail, 15 unsupported, one timeout on each host). The broader WebKit
  spawn/PATH fixture had an ENOMEM failure; a fresh unchanged replay passed
  but its cause remains open. Complete nextTick/phase ordering, async
  hooks/context propagation, warning stack/CLI policy and abort-listener
  resistance to stopImmediatePropagation still need conformance work.

- CommonJS entries publish their module identity before children execute.
  Explicit ESM entries use the native parser/linker and module graph, with
  cycles and top-level await. Wrapped CommonJS scripts register their
  reference path for relative import(). File mains return to the owning
  job/timer/I/O loop. A stalled module graph exits 13 when no nonzero status
  was assigned. Its native diagnostic text remains incomplete. Ambiguous
  `.js` format detection, static CommonJS named-export discovery, complete
  URL/query identities and package exports/conditions remain partial.

- `util.getCallSites()` reads the engine's saved-frame records, retaining
  actual source identities, function names and source coordinates. It
  validates the 1-to-200 frame limit and options, returns mutable records
  with null prototypes, and ignores Error stack formatting hooks and
  stackTraceLimit. CommonJS wrapper origins preserve original user lines;
  ESM source names use module URLs. scriptId contains a SpiderMonkey source
  ID; Inspector/CDP integration remains unavailable. Source-map remapping
  reports an explicit unimplemented error. Complete validation error text
  and source-map support remain gaps.

- Assertion and deep-comparison source uses the pinned Node algorithms,
  including error matchers, strict aliases, Maps/Sets and cycle
  detection. Source differentials and rebuilt four-host brand/mismatch
  checks pass. Assertion diagnostics remain partial (diffs, stacks,
  inspection and source expressions). See
  `third_party/node-core/README.md`. The upstream harness continues to
  require its adversarial assertion readiness check before recording
  guest baseline counts.

- TCP client dialing validates and snapshots the family-selection defaults
  (enabled, 500 ms; setters clamp positive values below 10 ms). It resolves
  actual addresses, alternates deduplicated families, applies deadlines to
  intermediate attempts, and cancels the native connect by operation
  identity. Failed and cancelled attempts close their descriptors; late
  successes are closed. TLS uses this same TCP dialing policy. Endpoint
  properties come from getsockname/getpeername, including local binding.
  Socket timeout/keepalive controls, complete stream semantics, BlockList
  and TLS handshake cancellation remain incomplete.

- `dns.lookup` and its promise form use libc getaddrinfo, with literal IP,
  family/all/order options and asynchronous delivery. The current libc
  hostname resolver supplies one IPv4 answer, does not provide full
  hosts-file or IPv6 hostname resolution, and performs a blocking lookup.
  These are fixable resolver gaps, separate from the transport's current
  IPv6 loopback-only boundary. Custom lookup records are supported without
  supplying invented DNS answers in the harness. Other DNS record APIs
  remain incomplete or placeholders.

- Node-mode initialization removes the embedding's shell utilities after
  capturing the private functions used for I/O, workers and shutdown.
  Public globals use the pinned Node bootstrap's enumerability and
  replacement descriptors. File-module bindings stay in their wrappers;
  eval retains its global bindings. Module-loader and event-loop bridges
  remain non-enumerable embedding properties. This does not establish
  identical own-property inventories or complete Web API behavior.

- Several DNS, crypto/TLS, worker, performance and browser globals
  remain partial or placeholders. They must not be treated as supported
  solely because the names export. The DNS record-resolution placeholders,
  crypto stubs and JSON-only structuredClone are compatibility gaps to
  replace.

- Native addons, V8 internals, inspector flags and nested guest Wasm
  compilation are not supplied by this embedding. Tests requiring them
  need explicit results, not fake flags or an emulated platform
  identity.

The vendored WHATWG URL, IDNA and Web Streams packages retain
independent integrity pins. They are not versions of Node core and are
not upgraded just to make their numbers match the API target.

See [the upstream suite](../../../tests/nodejs/README.md) for exact
inputs, commands, outcome accounting and current validation limits. ABI
and memory budgets are unchanged by the target pin and JavaScript core
fixes.
