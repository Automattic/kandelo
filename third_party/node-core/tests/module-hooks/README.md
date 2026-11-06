# Synchronous customization hooks: bounded source/component slice

`module.registerHooks` uses the unchanged Node 26.13.0
`lib/internal/modules/customization_hooks.js`. Registration, frozen returned
objects, deregistration/disposal, chain ordering, context merging, result
validation and binary-to-text conversion come from that pinned module.
Pinned CJS resolver/default-load/builtin/source algorithms are selected by
hash in `sources.json`; private URL/format/source fields use actual Module
WeakMap owners.

The ordinary `require` and `require.resolve` routes now invoke those chains.
Hook source reaches the existing CJS compiler or JSON parser. Real Module
cache/children/circular/failure transactions are retained. The per-directory
resolution cache bypasses hooks on genuine cache hits and is evicted on failed
loads or absent Module cache records. Builtin format replacements go through
that same record transaction; ordinary builtin source is ignored only as the
target explicitly requires. Existing separate Bun asset handling is preserved.

The native ESM entry accepts filenames rather than supplied source. A load
hook's ESM source therefore fails explicitly instead of being discarded and
reread from disk. This is an implementation gap, not an accepted platform
boundary. This slice does not activate hooks in static/dynamic ESM imports,
implement arbitrary ESM hook-source execution, asynchronous `module.register`
workers, TypeScript stripping, native addon loading, source-map/compile-cache
activation, preload/CLI hooks, or full module namespace/descriptor parity.
Existing async graph/cycle diagnostics, native builtin discovery/load-list
coverage and other audited loader gaps remain open.

Focused checks (explicit pinned native binary, no product/global setup):

```sh
scripts/dev-shell.sh bash -c 'export PATH="$KANDELO_DEV_SHELL_TOOL_PATH"; python3 third_party/node-core/build.py'
scripts/dev-shell.sh /absolute/path/node-v26.13.0/bin/node \
  third_party/node-core/tests/module-hooks/control.cjs /absolute/output/directory
scripts/dev-shell.sh /absolute/path/node-v26.13.0/bin/node \
  third_party/node-core/tests/module-hooks/upstream.cjs \
  /absolute/path/node-v26.13.0-source /absolute/output/directory
```

`control.cjs` runs identical case bodies in isolated native/candidate children,
with bounded timeouts and full stdout/stderr plus per-case exit accounting.
`upstream.cjs` executes byte-identical selected upstream tests through both
loaders, retaining unchanged assertions and native common's actual mustCall
exit accounting. Candidate checks use actual generated hooks/records/package
policy and actual extracted bootstrap loader/compiler source. Pinned native
VM compilation, filesystem, URL, Buffer, TextEncoder/TextDecoder, native
builtins and native process moduleLoadList are explicit fixture dependencies;
upstream common/fixtures are native dependencies admitted as real cached
Module records. These component dependencies do not establish Kandelo guest
implementations or four-host conformance. No SpiderMonkey compilation, guest
build, product setup or overall suite is performed by these drivers.
