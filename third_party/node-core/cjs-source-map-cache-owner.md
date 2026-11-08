# CJS compiled source-map cache owner

This source slice feeds actual CommonJS compilation metadata into the pinned
Node 26.13.0 source-map cache and public `module.findSourceMap`. It does not
implement mapped stacks, coverage collection/output, or enabling source-map
support. Cache admission stays in the unchanged target algorithm: the real
`process.env.NODE_V8_COVERAGE` value must admit capture while source-map support
is otherwise disabled. Setting that environment value does not create a
coverage collector in Kandelo.

`native-module-syntax.cpp` reads sourceURL/sourceMappingURL from the actual
rooted SpiderMonkey ScriptSource after successful compilation. It invokes a
private synchronous cache consumer before compiled code executes, including
before executing a patched Module.wrap script. Failed compilation publishes no
entry; a later body exception does not undo successful compilation metadata.
The cache is keyed by the actual CJS Module and physical/sourceURL aliases.

The complete pinned cache and cache-map inputs retain map parsing, map-file
reads through the actual guest fs owner, line lengths, lookup identity,
replacement and finalization algorithms. Three V8-private slot expressions
are adapted to a captured SafeWeakMap keyed by the real Module. The target
creates this slot with v8::Private::New (env_properties.h:42 and env.cc:504–514),
so adding ordinary reflected Symbol properties would expose internal state.
The complete original cache-map source and exact replacement sites remain
hash-pinned in sources.json. Its unused private token never stores Module data.
The already integrated full public SourceMap decoder is unchanged.

The normal compile route passes the actual compiled normalized CJS body;
patched wrappers use the original CJS body for target line-length metadata.
No guessed wrapper offsets or stack locations are installed. The curated
native adapter forwards the private fourth capture argument to its actual
native compiler owner. The existing native ScriptPrivate dynamic-import
association remains intact.

Known gaps remain: ESM, VM and generated-source capture; --enable-source-maps
and public source-map enabling APIs; SavedFrame/native stack mapping and
getCallSites reconstruction; coverage collection/file output; and exact
SpiderMonkey-versus-V8 parser metadata semantics. All new guest C++ and
weak/finalizer/realm behavior require identified-artifact validation. This is
partial L-033/L-009 implementation, not conformance or finding closure.
