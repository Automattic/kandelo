# Unmodified upstream Node.js library

This directory preserves Node.js 26.13.0 JavaScript library sources for
Kandelo's upstream-first SpiderMonkey runtime. Selected original context and
realm/bootstrap bodies now execute through the native embedding. Successful
Node startup and module conformance remain unproven; source import identity
is recorded separately from that runtime evidence.

`upstream/` retains original archive-relative paths and bytes. `sources.json`
records every imported file, SHA-256, role and builtin ID. `target.json` is
an unchanged copy of the audited source/native-reference pin. Upstream
licenses remain at their original paths, including the top-level LICENSE.

The selection contains the entire `lib/` tree and the dependency files
registered by upstream `node.gyp`/`configure.py`: Acorn, acorn-walk,
minimatch, Undici, Amaro and eleven V8 profiling-tool modules. Optional
sources are retained without advertising their features as supported.
Original build/embedding files are retained as provenance references.
The native embedding consumes the original symbol inventory and complete
exit-code enum headers with their recorded hashes. Adding a native header
does not change the registered JavaScript library or its bytes.

Reproduce the import into a new destination with:

```sh
python3 scripts/import-nodejs-library.py \
  --archive /path/to/node-v26.13.0.tar.gz \
  --target third_party/nodejs/target.json \
  --output /path/to/new-nodejs-import
```

The importer verifies the archive hash, reads the upstream build lists as
data, copies source without rewriting it and verifies each output hash.
It refuses an existing destination. It does not configure, compile or
execute Node. Source import identity is separate from runtime support.

The builtin IDs follow upstream `tools/js2c.cc:GetFileId`: strip `lib/`
and the source extension, or map `deps/` to `internal/deps/`. This mapping
does not create an independent module loader. The runtime must execute
upstream's realm/builtin loader against its real native binding contracts.
Generated configuration must describe the actual Kandelo runtime; copying
native Node's V8/build/platform configuration would misrepresent it.

Undici and Amaro use embedded WebAssembly. Their presence does not establish
that nested guest Wasm execution exists. See
`docs/nodejs-upstream-runtime.md` for the startup milestone and open work.
