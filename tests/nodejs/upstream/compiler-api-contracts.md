# Native builtin compiler API review

Source-only review. No runtime probes, tests, builds, tracked edits or Git
mutations. Mozilla source root is exactly
`.context/node26-mozilla-style-source/tree/firefox-140.11.0/` (abbreviated
`SM/` below). Node source root is
`.context/nodejs-lts-cache-v2/node-v26.13.0/` (`Node/` below). These are local
pinned inputs, not claims about newly built artifacts.

## Recommended ownership and interfaces

Provide separate nullable-return helpers for function bodies and source-text
modules. Require a caller-entered active guest realm; do not silently compile
against the shell root global. Return the newly compiled object without
executing it, and have the caller root it immediately:

```cpp
JS::RootedFunction fn(cx, CompileBuiltinFunction(cx, record));
if (!fn) return false;
// No intervening GC-capable operation before rooting.
```

The helper may use a local RootedFunction internally if it performs any
GC-capable work after compilation; return `fn.get()`. A raw returned pointer
is not a persistent root. JS realm/module registries need traced or persistent
rooted storage, not bare C++ object pointers. Caller entering a realm with
`JSAutoRealm` must pass a genuine target object, not a cross-compartment
wrapper (`SM/js/public/Realm.h:157–200`). A helper taking only `JSContext*`
should document its active-realm precondition. Compilation itself asserts
owning thread, idle heap and non-atoms realm
(`SM/js/src/vm/CompilationAndEvaluation.cpp:345–350`).

Do not move the upstream JavaScript builtin module cache, cycle handling,
exposure policy or ordinary module execution into this compilation helper.
`Node/lib/internal/bootstrap/realm.js:425–450` owns those behaviors.

## Function compilation: exact API and parameters

The applicable SpiderMonkey140 public overload is:

```cpp
JSFunction* JS::CompileFunction(
    JSContext* cx, const JS::EnvironmentChain& envChain,
    const JS::ReadOnlyCompileOptions& options, const char* name,
    unsigned nargs, const char* const* argnames,
    JS::SourceText<mozilla::Utf8Unit>& srcBuf);
```

See `SM/js/public/CompilationAndEvaluation.h:182–201`. UTF16 has the same
signature with `SourceText<char16_t>`. `CompileFunctionUtf8` is a convenience
entry taking `const char* bytes,size_t length`; implementation simply creates
a borrowed SourceText and calls the above overload
(`SM/js/src/vm/CompilationAndEvaluation.cpp:521–530`). Either is appropriate;
the explicit SourceText form makes length/ownership checks visible.

Use an **empty** `JS::EnvironmentChain(cx, JS::SupportUnscopables::No)`.
The current realm global lexical environment is automatically selected;
putting the global into the chain would instead construct a non-syntactic
`with` environment. This matches upstream V8 CompileFunction's zero context
extensions. Sources:

- `SM/js/public/CompilationAndEvaluation.h:170–187` forbids including global.
- `SM/js/public/EnvironmentChain.h:25–52` describes with wrappers.
- `SM/js/src/vm/CompilationAndEvaluation.cpp:428–442` chooses current
  global lexical environment when the list is empty.
- `Node/src/node_builtins.cc:387–403` passes zero context extensions.

Pass `name=nullptr`. Node's builtin CompileFunction has no explicit function
name. More importantly SpiderMonkey's `name` is processed as **Latin1** by
Atomize/IsIdentifier, not decoded as UTF8
(`SM/js/src/vm/CompilationAndEvaluation.cpp:361–375`). Do not pass the
UTF8 module ID or diagnostic filename as the function name. A nonidentifier
name gets assigned as a function atom afterward (:475–478), which also does
not solve the encoding mismatch.

Take classification and argument order from the original
`Node/src/builtin_info.cc:7–27` and `builtin_info.h:29–47`, not from a new
independently maintained classifier:

| Type | Exact parameter names/order |
|---|---|
| kBootstrapRealm | process, getLinkedBinding, getInternalBinding, primordials |
| kBootstrapScript / kMainScript | process, require, internalBinding, primordials |
| kPerContextScript | exports, primordials, privateSymbols, perIsolateSymbols |
| kFunction | exports, require, module, process, internalBinding, primordials |
| kSourceTextModule | No function wrapper; separate module compiler |

The exact upstream classification checks `.mjs` **first**, then ID prefixes
(including `starts_with("internal/bootstrap/realm")`), and also classifies
`internal/deps/v8/tools/` as source-text modules. Real archive filename and
module ID are distinct inputs to this classification. Compilation diagnostic
filename is a third value: upstream uses **`node:` + builtin ID**, regardless
of archive filename (`Node/src/node_builtins.cc:344–345`). Preserve all three
roles rather than confusing source path with diagnostic origin.

When adapting parameter_map's string vector to `const char* const*`, retain
the vector/string lifetime through CompileFunction. Four/six fixed names fit
a six-entry fixed array; check count before filling/casting if code supports
arbitrary metadata. No user-supplied argument-name interpretation is needed.

## Preserve original body line numbers

**Functions: setFileAndLine(utf8Filename, 0). Modules: line1.** This is a
source-derived conclusion, not a runtime observation.

The exact function path synthesizes `function `, optional name, `(` and
parameter names, then `FunctionConstructorMedialSigils = ") {\n"`, appends
original body, then `"\n}"`:

1. `SM/js/src/vm/CompilationAndEvaluation.cpp:352–405` builds the prefix and
   appends the body unchanged; :408–426 appends suffix/creates new source.
2. `SM/js/src/vm/JSFunction.h:39–40` defines exactly one prefix newline.
3. The parser skips prelude by consuming ordinary tokens, then calls
   functionFormalParametersAndBody; it does not reset source coordinates at
   the body (`SM/js/src/frontend/Parser.cpp:2333–2401`).
4. TokenStream initializes its lineno and SourceCoords from options.lineno
   (`SM/js/src/frontend/TokenStream.cpp:360–370`). Each EOL increments lineno
   (`:484–496`). SourceCoords line number is index+initialLineNum
   (`SM/js/src/frontend/TokenStream.h:424–429`).
5. Standalone compilation resets the *overall script extent* to the provided
   origin but does not renumber parsed body instructions
   (`SM/js/src/frontend/BytecodeCompiler.cpp:1125–1137`).

Therefore line0 is the generated function header and the original body first
line is1. Starting options at1 would shift body diagnostics to2. Newline
resets body columns normally, so original first-body-column coordinates are
not offset by the synthesized parameter header. Original body remains
unchanged; do not prepend compensating source directives or strip lines.

The zero-origin is **not reusable for CompileModule**:
`SM/js/src/frontend/BytecodeCompiler.cpp:1155–1161` explicitly asserts that
module initial lineno is nonzero. Module source has no synthetic prefix and
must start at1. Source audit found this assertion only on the module path in
the relevant frontend code. Later targeted tests should verify both compile
errors and thrown stack locations, including a first-line and multiline body;
no such test ran here.

## UTF8 source and filename lifetimes

Initialize `SourceText<Utf8Unit>` with pointer + exact **byte length** and
`JS::SourceOwnership::Borrowed`; the bytes must remain stable until the
synchronous compile returns. `SourceText.h:16–27` states the lifetime rule;
`:142–173` checks the length against UINT32_MAX and reports too-long source;
`:201–217` permits `const char*` for Utf8Unit. Do not pass strlen(source) and
silently truncate embedded NULs. The parser owns syntax/invalid-UTF8 errors.

The engine stores its own immutable source representation as compilation
completes: `SM/js/src/vm/JSScript.cpp:1557–1588` duplicates borrowed source or
takes owned source into SharedImmutableStringsCache. Functions additionally
construct an internal UTF16 wrapper copy. Avoid options that discard source
or promise lazy/retrievable external source unless the corresponding source
retrieval owner is actually implemented.

`JS::CompileOptions` only borrows filename/source-map resources for its own
stack lifetime (`SM/js/public/CompileOptions.h:581–586`);
`setFileAndLine` stores a `ConstUTF8CharsZ` view (:623–626). Keep the UTF8
filename allocation alive **longer than the CompileOptions object**, not
merely through argument expression evaluation. ScriptSource separately copies
the filename during compilation (`SM/js/src/vm/JSScript.cpp:1941–1973,
2009–2024`), so it need not be leaked or retained forever afterward.

Filename is a real NUL-terminated UTF8 string, not Latin1. Preserve non-ASCII
ID bytes verbatim when forming `node:<id>`; do not widen each UTF8 byte as a
UTF16 code unit or use JS_EncodeStringToLatin1. `ConstUTF8CharsZ` validates
UTF8 only in DEBUG builds (`SM/js/public/CharacterEncoding.h:131–170`), so
that wrapper is not release-mode input validation. For caller-provided raw
metadata, validate UTF8 before passing it as filename; Mozilla's existing
UTF8 validity utility is available in `SM/mfbt/Utf8.h:246–278`. Pinned source
metadata validated at generation/admission need not be reinterpreted as
untrusted JS source text during every compile.

## Module ID, filename lengths and allocation failures

- Use exact-length registry lookup and reject embedded NUL IDs explicitly;
  otherwise a JS string such as `"buffer\0other"` could accidentally select
  `buffer`. Never make `strlen(encodedId)` the sole authoritative lookup
  length.
- For JS input, root the original JSString throughout conversion. Converting
  with JS_EncodeStringToUTF8 can allocate and returns nullptr on failure; it
  faithfully copies NUL and replaces lone UTF16 surrogates
  (`SM/js/public/CharacterEncoding.h:389–407`). Check the pointer before use.
  Reject/diagnose unrepresentable ID forms or require exact canonical
  registry membership; do not claim this lossy conversion preserves every
  possible JSString identity.
- If accepting arbitrary Unicode IDs, use actual encoded-byte length:
  GetDeflatedUTF8StringLength on a rooted/linear JSString, or an explicit
  bounded conversion. UTF16 JS_GetStringLength is not UTF8 byte length
  (`SM/js/public/CharacterEncoding.h:273–295`). Avoid a premature byte-length
  limit derived from code-unit length. A bound based on the longest actual
  immutable registry ID is a valid lookup-admission optimization only if
  correctly expressed in the input encoding.
- Check `idByteLength + sizeof("node:")` (four prefix bytes plus terminator)
  against size_t overflow before allocation, and preserve exact valid UTF8
  bytes. A bounded generated diagnostic filename avoids per-call allocation.
  Otherwise use an existing fallible JS-aware buffer/allocator, check failure
  and report OOM. Do not add an unchecked std::string allocation to a
  SpiderMonkey no-exceptions path and assume JS will translate bad_alloc.
- SourceText accepts size_t but explicitly rejects >UINT32_MAX; do not narrow
  lengths first. FunctionCompiler also allocates its wrapper/decoded body;
  source length admission does not eliminate later OOM. Fixed argument counts
  avoid user-controlled unsigned truncation.
- Return nullptr/false with the existing exception intact on SourceText init
  or compile failure. Frontend compilation uses frontend error reporting
  (`SM/js/src/vm/CompilationAndEvaluation.cpp:489–530`; module equivalent
  `SM/js/src/vm/Modules.cpp:108–133`). Do not clear exceptions, replace every
  failure with OOM, or return a fabricated function. For allocations made by
  the helper itself, report OOM exactly when that allocation failed; do not
  overwrite an already meaningful compile error.

## Actual source-text modules

Use the separate UTF8 public overload:

```cpp
JSObject* JS::CompileModule(
    JSContext* cx, const JS::ReadOnlyCompileOptions& options,
    JS::SourceText<mozilla::Utf8Unit>& srcBuf);
```

This compiles unchanged ES module source in the **current global**, reports
UTF8 errors, and returns a source-text module record, not JSFunction
(`SM/js/public/Modules.h:165–180`). Root the return immediately. Set filename
to `node:<id>` and line1, without a parameter list/environment chain. Do not
compile a fake function wrapper, transpile import/export or evaluate at
compile time. If a function-only entry receives kSourceTextModule, return an
explicit wrong-kind error and leave the separate module path responsible.

Compilation is not module-loader support. Need actual same-module identity
cache, resolve hook, requests, linking, evaluation promises/namespaces,
import.meta/dynamic import hooks where used. SM ModuleResolveHook must return
the same module for identical arguments and throw on failure
(`SM/js/public/Modules.h:50–87`); ModuleLink precedes ModuleEvaluate
(:222–245). SetModulePrivate can associate correctly owned referrer identity
(:199–215). Unimplemented linkage remains a visible gap even if CompileModule
exists.

Upstream native path preloads dependencies through its cache, resolves V8
`./file.mjs` tool imports, instantiates/evaluates, and returns a null-prototype
`{promise, namespace}` object (`Node/src/node_builtins.cc:737–829`). A proper
backend must preserve those observable contracts and rooting/lifetime; a
successful module compile alone does not satisfy them. Do not force
synchronous evaluation-error unwrapping for modules with top-level await:
SpiderMonkey documents that synchronous throw mode excludes TLA
(`SM/js/public/Modules.h:247–269`).

## Later focused checks; none run now

Verify exact wrapper argument order and no injected lexical environment;
function first/multiline error positions versus module first line; UTF8 body
and non-ASCII diagnostic filename; missing/embedded-NUL/long ID; syntax and
invalid-UTF8 failure propagation; returned function after GC; module syntax,
identity/cycles/resolve/evaluation/TLA separately. Do not infer any of these
runtime results from this source review.
