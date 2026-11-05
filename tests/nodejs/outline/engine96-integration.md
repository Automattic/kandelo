# Targeted engine integration and dependency metadata

Current source99 adds queued promise write/append to97/98. Its new public
algorithms are native-boundary checked, not guest-compiled; engine96 receipts
remain historical. See [promise ownership](file-promises-implementation-dependencies.md).

Subsequent current source98 includes metadata97 and pinned sync whole-file
owners. Both remain guest-uncompiled; the build and runtime receipts below
remain specific to engine96. See [sync ownership](file-sync-implementation-dependencies.md).

The normal targeted wasm32 SpiderMonkey build succeeded at recipe96. It
compiled the source changes through recipe95 and built its declared guest
OpenSSL3.5.9 dependency at recipe6. This is package-build integration and
four focused Node-host differential controls, not complete public API or
four-host conformance. The current source recipe97 adds the dependency
metadata correction described below; that correction is not guest-compiled.
The audited Node26.13.0 source/native pins and frozen audit are unchanged.

## Dependency graph correction

The first attempt, recipe95, failed before compilation: the engine declared
openssl@3.3.2 while the registry source had already advanced to3.5.9 for
KDF/Argon2 parity. All eight current direct consumers now declare3.5.9:
curl, elinks, freeciv, git, libcurl, php, spidermonkey and wget. Each recipe
revision was advanced. Historical index entries and published artifacts
were not rewritten. The normal resolver computed all eight transitive cache
keys successfully. The other seven consumers were not built or run, and
current OpenSSL3.5.9 wasm64 has not been built here.

The failed recipe95 preflight is retained in
`.context/node26-engine-r95-failed/`. An earlier graph checker incorrectly
passed --binaries-dir to the sha subcommand; its eight CLI errors are
preserved in `.context/node26-openssl-dependency-check/` as harness errors.
The corrected graph report is
`.context/node26-openssl-dependency-check-r2/report.json`.

## Identified build and focused guest evidence

Job `node26-core-engine-r96-1105-003350-bf2d` exited0 after250.9seconds.
All765 selected inputs matched after the build, before the metadata97
changes. The retained metadata97 preimages account for subsequent changes.
The normal cache key is
`b18f7d3cadb90342e29465524ff45686bf618bde7bd6242fbe2c9284a96a45bc`.
The retained js.wasm/node.wasm are each49,430,488bytes, SHA256
`d140e855614b1978c2c69d3abdb788fb2ec6a8cee5e8450b887c8197c000d17e`.
Full logs, exact source identities, engine outputs and actual guest static
OpenSSL libraries are retained under `.context/node26-engine-r96-accepted/`.
Its `integration.json` binds all reports and dependency-output identities.

Four authored controls ran unchanged on the exact native reference and
retained engine96 on the Node host. All four passed in the corrected run:

| Control | Observed behavior | Limits |
|---|---|---|
| Sync KDFs | Exact PBKDF2/scrypt and all three Argon2 variant bytes | Small parameters and finite input vectors |
| Async KDFs | Exact bytes, asynchronous callbacks, ALS and native resource receiver identity | Two requests; no stress, cancellation, GC or failure campaign |
| Callback file writes | Actual write/append bytes, flush path, async completion, ALS and active request registration | Existing tmpfs/kernel; not full byte leases, permissions or lifecycle |
| SourceMap and performance | Real mapping query, shared global performance identity and mark/measure buffers | No loader cache/stacks, native milestones, histogram or producer coverage |

Report: `.context/node26-engine-r96-controls-r2/report.json`.
The fixture used the existing kernel SHA256
`0e6e314268222186f1efe0833ff97eea50faaee026cc9e78db68779b7bacd4b5`
and image SHA256
`83293c21fa6c4d290420aa8a30dca93266eafe90a5e05aa911477e305012e362`.
Changed kernel/host source was not rebuilt. The normal host emitted the
missing kandelo.abi.contract stamp warning for the raw package output;
no stamp was changed and no admission policy was bypassed. These local
fixtures are not packaged-product or current combined ABI acceptance.

The first four-control run remains recorded separately:2pass/2fail. The
sync control exposed genuinely missing process.versions.openssl after
successful derivations. The write control contained a callback-receiver
assumption that fails in native Node as well. The corrected write control
checks actual resource registration and ALS without that invalid receiver
comparison. Removing the separate metadata assertion from the corrected
sync vector control does not close the metadata defect.

## Source97 dependency metadata correction

The crypto native owner now queries OpenSSL_version(OPENSSL_VERSION_STRING)
from the actual linked library. A private binding forwards it through the
production prefix to the shared process owner. The owner installs
process.version, process.versions and individual version entries with the
target's read-only, enumerable, configurable descriptors. The versions
object remains extensible and entries can be explicitly redefined. Existing
actual compression, SQLite and c-ares owners provide their values. No V8,
libuv, native addon ABI or other unavailable backend is advertised.
The Node version remains the explicit API target, not a conformance claim.

Two new metadata controls and nine existing process controls pass over
explicit native26 dependencies. A compiled portable owner reports3.5.9
from the development-host OpenSSL3.5.9 library, matching the pinned native
reference. These are not guest-library or JSAPI execution evidence for97.
The exact patch applies/reverses, generated bundle/bootstrap syntax and
Mozilla's unchanged source-style checker pass. Reports are under
`.context/node26-version-metadata-{frontend,native,source}-r1*`.

## Remaining gates

All19 audited families remain partial. Key/cipher/WebCrypto, full
filesystem/stream/byte ownership, loader/worker/IPC, networking/protocols,
measurements/observability and other recorded gaps remain implementation
work. Existing Performance milestone failures, SQLite public-load trap and
host typecheck diagnostics are preserved. The source97 binding, changed
kernel/host candidate, current dependency consumers/wasm64 and complete
identified-artifact four-host validation remain outstanding. Overall suites
and full product rebuilds remain deferred; neither ran in this checkpoint.
