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

Node builds its internal bridge in `spidermonkey-node/bridge` over this engine.
This library alone is not a Node-compatible SDK. Keeping it cached separately
avoids rebuilding Mozilla for Node adapter changes. The standalone SpiderMonkey
shell still uses its independent upstream build; it does not yet share this
library build.

The simplified source tree and develop reconciliation have not been built or
tested. Earlier receipts describe earlier artifacts, not this review update.

## Maintained embedding boundary

Node context fields use SpiderMonkey's global application slots. Ordinary
private entries use a bridge-owned weak map, not a new language property or
symbol kind. Async-context snapshots use the original job host-data APIs; the
small `preservesHostDefinedData` option retains that data for observable
optimized reactions. The engine owns its original queues and dispatch.

Corrections to buffer ownership, saved sources, parser metadata and compiler
locations are folded into their final capability patches. The direct Rust
target mapping describes Kandelo without a temporary Linux profile. The
standalone shell's independent patch selection is unchanged.

These source reductions are unbuilt and untested. Dynamic-import completion
still uses the previous extension. Node can supply cross-compartment namespaces
and controls whether to evaluate returned modules and how to validate import
attributes. A plain replacement with engine module completion changes those
contracts; a complete replacement needs further review.
