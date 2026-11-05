# Codecs from the Node reference release

This library recipe selects unchanged zlib, Brotli and Zstd sources from
the exact Node source archive used by the Node compatibility target. The
current source pin is Node 26.13.0; its bundled codec versions are
`1.3.2.1-motley`, `1.2.0` and `1.5.7`, respectively. These are source
versions, not observed runtime versions or conformance results.

`sources.json` records 77 translation units, private/public header hashes,
source-selection inputs and licenses. The selection follows Node's GN/GYP
lists: generic zlib CPU code, combined Brotli encoder/decoder, and Zstd
compression/decompression with upstream multithread support. No host-built
target-layout helper is executed. Target types and feature macros come
from the actual wasm32/wasm64 SDK. Zstd dictionary training is not part of
Node's selected library sources; this recipe does not export `zdict.h`.

The recipe builds `libz.a`, `libbrotli.a` and `libzstd.a` through the target
SDK and installs public headers, original license texts and deterministic
source/archive provenance. It uses separate work/output roots, including
for direct invocations. The resolver authenticates the source archive;
the driver also checks every selected C/header/metadata/license input.
Neither source nor reviewed recipe directories receive build products.

SpiderMonkey declares this package as a direct dependency. Its recipe
checks the producer's Node source/version/commit against the API target
and overlays the dependency into a private sysroot. The native candidate
queries actual linked-library versions and evaluates pinned Node constant
definitions against these headers. Library linkage and metadata do not
implement Node's handle, stream, asynchronous work or ZIP APIs.

This recipe and engine revision 45 remain **unbuilt and unverified** during
the broad source pass. Native handles, real asynchronous codec operations,
ownership, cancellation, error/option parity and public algorithms remain
implementation work. Compilation, archive symbols/linkage, resource budgets
and all four guest hosts still require validation.

Static source checking without compiling:

```sh
scripts/dev-shell.sh python3 packages/registry/node-codecs/build-node-codecs.py \
  --source /absolute/path/to/verified/node-source \
  --work /absolute/path/to/private/work \
  --output /absolute/path/to/separate/output \
  --arch wasm32 --plan-only --plan-output /absolute/path/to/plan.json
```

The plan is explicitly uncompiled and does not create product output.
Regenerate the source inventory after a reviewed target update with
`generate-source-inventory.py --source <verified-tree> --target
packages/registry/node-compat/target.json`. Recipe, inventory, consumer
version and compatibility target must move together.
