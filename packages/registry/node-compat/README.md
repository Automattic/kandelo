# Node core compatibility target

`target.json` pins **Node.js 26.13.0 (Lithium LTS)** as the API target, its
upstream source tag/commit/archive and native oracle archives. It is
independent of the host/build toolchain (currently Node 24). The normal
SpiderMonkey package generator embeds this same pin in the shared
bootstrap and C CLI version string, preventing separate version constants
from drifting.

The guest engine remains SpiderMonkey 140.11.0 ESR. It reports `wasm32` and
`kandelo`, including through `os.platform()`. It provides no native Node
addon ABI, V8 or libuv implementation, so `process.versions` does not
advertise versions for them. Changing the API target does not enable their
flags or promise their behavior. Existing products must be rebuilt before
the new identity or source fixes are observable.

## Coverage audit

The implementation is partial. Its builtins and globals include working
operations mixed with incomplete behavior and, in older APIs, placeholders.
Export presence is not implementation coverage. In particular:

- Filesystem, process, Buffer and URL regressions have targeted source and
  guest fixtures. Windows file URL options, legacy URL helpers and complete
  filesystem argument/error validation remain incomplete.
- The shared source has streaming UTF-8/UTF-16 decoding, Windows-1252,
  BOM/fatal handling, complete UTF-8 encodeInto writes, and Node-specific
  StringDecoder buffering/flush behavior. Source/native comparisons pass;
  rebuilt guest integration is still deferred. Other legacy TextDecoder
  charsets and custom inspection remain gaps. Buffer's non-UTF8 encoding
  APIs are still partial.
- Streams, Fetch body behavior and process lifecycle need broader upstream
  coverage. Eval shutdown differs from file entry points.
- `assert`/`assert/strict` and `util.isDeepStrictEqual` have known false
  positives; the upstream harness refuses baseline counts until its
  adversarial assertion readiness check succeeds.
- Several DNS, crypto/TLS, worker, performance and browser globals remain
  partial or placeholders. They must not be treated as supported solely
  because the names export. The historical DNS loopback response, crypto
  stubs and JSON-only structuredClone are compatibility gaps to replace.
- Native addons, V8 internals, inspector flags and nested guest Wasm
  compilation are not supplied by this embedding. Tests requiring them
  need explicit results, not fake flags or an emulated platform identity.

The vendored WHATWG URL, IDNA and Web Streams packages retain independent
integrity pins. They are not versions of Node core and are not upgraded
just to make their numbers match the API target.

See [the upstream suite](../../../tests/nodejs/README.md) for exact inputs,
commands, outcome accounting and current validation limits. ABI and memory
budgets are unchanged by the target pin and JavaScript core fixes.
