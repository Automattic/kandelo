# Internal Node engine bridge

This is part of the `spidermonkey-node` recipe, not a separately versioned package
or public engine SDK. It compiles once into that recipe's private work directory
and is linked by its default and experimental Node configurations.

`src/` implements the engine interfaces consumed by upstream Node on real
SpiderMonkey values, realms, rooted handles and callbacks. Node retains startup,
loaders, timers, options, permissions and shutdown policy. `tools/` prepares
metadata from the authenticated Node archive; `native-source-patches/` adapts
complete portable upstream C++ files. No alternate shell frontend is included.

Engine headers must match their libraries. Required GC, external-memory
accounting, callback retirement and native-resource lifetimes remain production
behavior. `contracts.json` records source roles and consumer contracts; the
inventory helper records actual inputs without certifying their behavior.

The package consolidation is unbuilt and untested for source review. See
[maintenance](../MAINTENANCE.md) for qualification and native-helper migration.
