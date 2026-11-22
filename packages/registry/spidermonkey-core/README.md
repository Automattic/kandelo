# SpiderMonkey engine library

Builds the pinned SpiderMonkey 153.7 ESR archive through Mozilla's build system,
without its JavaScript shell. Outputs are the static C++/Rust libraries, public
and generated headers, private headers matching those libraries, and pkg-config
metadata. The engine owns execution, parsing and GC; upstream Node owns startup,
loaders, options, scheduling and resource policy.

Apply every complete patch in `base-patches/`, then every patch in `patches/`,
in filename order. These directories contain only production engine changes.
The build rejects patch failures, fuzz and offsets and generates its provenance
receipt in the private build directory. There is no historical patch-selection
manifest and no dependency on the standalone shell package's patch chain.

The separate `spidermonkey-node-bridge` library supplies Node's V8-shaped source
interfaces over this engine. This library alone is not a Node-compatible SDK.

The simplified source tree and develop reconciliation have not been built or
tested. Earlier receipts describe earlier artifacts, not this review update.
