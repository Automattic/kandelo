# Explicit call-site mapping owner

`util.getCallSites(..., { sourceMap: true })` now feeds actual captured
SavedFrame rows to Node 26.13's unchanged `reconstructCallSite` and
`mapCallSite` algorithms. The normal generator selects both sections by
full-source and section hashes from the existing pinned `lib/util.js`.
The public wrapper keeps direct capture and its existing validation order.

The private SourceMap platform supplies its actual cache module. That
cache uses CommonJS metadata from the real compiled script and the actual
Module weak identity, under its existing `NODE_V8_COVERAGE` admission.
It does not search arbitrary files when no cache entry exists. Public
`Module.findSourceMap` reassignment does not replace this private lookup.
The returned SourceMap's ordinary `findEntry` method retains target property
lookup/error behavior; no new catch suppresses it.

Mapped rows retain the exact target shape: null prototype, original source,
1-based original line/column, optional mapped name with raw function-name
fallback, and no scriptId. Missing map/entry/original source preserves the
original raw row identity. The native capture implementation, engine source
IDs, UTF-8 positions and VM source offsets are unchanged.

This is partial source work for values-contracts.md V-034. It has not been
generated, compiled, or executed in the guest. Source identity observations
are not mapping conformance. Existing raw/UTF-8/VM-offset negatives remain.
`--enable-source-maps` default option ownership, global source-map enable/
setSourceMapsSupport, mapped Error stacks/prepareStackTrace, coverage
collection/output, ESM/VM/generated-source capture, node_modules policies,
and GC/realm/Worker/four-host validation remain implementation gaps.
No public getCallSite singular alias exists in the exact pinned util.js.
