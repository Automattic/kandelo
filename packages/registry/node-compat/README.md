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

- Streams, Fetch networking and process lifecycle need broader upstream
  coverage. Shared natural exit now has a shell teardown hook for eval,
  including queued work and fatal status. File/eval/ESM regressions pass
  on the Node host and all three browser engines. beforeExit,
  uncaughtException and complete unhandled-rejection policy remain gaps.

- Assertion and deep-comparison source uses the pinned Node algorithms,
  including error matchers, strict aliases, Maps/Sets and cycle
  detection. Source differentials and rebuilt four-host brand/mismatch
  checks pass. Assertion diagnostics remain partial (diffs, stacks,
  inspection and source expressions). See
  `third_party/node-core/README.md`. The upstream harness continues to
  require its adversarial assertion readiness check before recording
  guest baseline counts.

- Several DNS, crypto/TLS, worker, performance and browser globals
  remain partial or placeholders. They must not be treated as supported
  solely because the names export. The historical DNS loopback response,
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
