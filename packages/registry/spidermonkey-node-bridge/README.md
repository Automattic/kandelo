# Node engine bridge

This library implements the C++ engine interfaces consumed by upstream Node on
real SpiderMonkey values, realms, rooted handles and callbacks. It does not own
Node startup, loaders, timers, options, permissions or shutdown policy.

`src/` contains the production source list in `build-bridge.py`. There is no
alternate shell frontend or private owner-probe implementation. `tools/` prepares
portable metadata and source interfaces from the resolver's pinned Node archive;
per-file identity receipts are generated in the recipe work directory.
`native-source-patches/` adapts complete portable upstream C++ source files.
The build's private `kandelo-node/` include tree is not an installed JS shell.

The engine provider's private headers and libraries must match. Required GC,
external-memory accounting, callback retirement and native-resource lifetimes
remain production behavior. The bridge uses SpiderMonkey's collector and native
libuv wakeups, with callbacks confined to their owning JavaScript thread.

`contracts.json` records source roles and protecting consumer contracts.
`tools/inventory-node-upstream-adaptations.py` records the actual production
patches, bridge files and dependency manifests. Neither inventory nor successful
compilation establishes complete API behavior.

The simplification and develop reconciliation are submitted for source review
without builds or tests. See [maintenance](../spidermonkey-node/MAINTENANCE.md) for
upgrade procedure, native Wasm helpers and qualification requirements.
