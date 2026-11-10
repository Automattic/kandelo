# Upstream builtin compiler foundation

`builtin-compiler.cpp` supplies separate native compilation paths for complete
upstream function bodies and real source-text module records. It consumes the
immutable registry in `third_party/nodejs/native/`. It neither evaluates code
nor implements an alternative module cache, bootstrap policy or public API.

The caller must enter the correct realm and immediately root the returned
function/module. Function bodies use upstream's exact admitted parameter list,
an empty environment chain, an anonymous function and the original diagnostic
origin. SpiderMonkey140 inserts one newline before the function body; options
start its synthetic wrapper at zero so the original body starts at line one.
Source-text modules have no wrapper and start at line one. Both paths pass the
complete UTF8 buffer and explicit byte length to the actual engine compiler.
Errors propagate; no substitute function/module is returned on failure.

Origins, kind names and argument vectors are static admitted metadata. The
helper introduces no std::string/vector allocations into the engine entrypath.
The metadata build tool reuses original Node C++ classification instead of
replicating source-kind policy in Python or JavaScript.

This component is currently unintegrated and uncompiled against SpiderMonkey.
A host-native registry composition check does not validate these JSAPI calls,
source line offsets, error propagation, realm identity, GC or guest startup.
The source-derived API/ownership review is in
`tests/nodejs/upstream/compiler-api-contracts.md`.

Package integration still needs actual declared build inputs/tools, generated
include ownership, compilation/link wiring, real per-context/per-realm state,
private symbols, binding admission, structured stack hooks, job lifecycle and
the startup binding closure. The existing adapter/bootstrap remains active.
Do not wire placeholder bindings merely to advance bootstrap. Full product
and successor-ABI rebuilds remain deferred; focused engine build scope must
be reported before proceeding. No ABI version or fixture is changed here.
