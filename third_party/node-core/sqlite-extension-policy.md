# SQLite extension admission and real library ownership

This source contribution addresses native-integration.md NI-002 (partial),
specifically Database options.allowExtension, enableLoadExtension and
loadExtension. It does not close the SQLite module or establish guest/four-host
conformance. The unchanged public module exposes the same Database/DatabaseSync
constructor; these methods consume its existing real Connection/native handle.

The constructor reads and validates allowExtension in the existing pinned
option order, then passes a captured Boolean to the native owner instead of
rejecting it as unavailable. Connection stores an immutable creation permission
and a separate mutable enable flag. Both start at the creation value. Open
configures the actual SQLite handle; close/open preserves the flag. An initially
disallowed connection cannot enable loading later. enableLoadExtension performs
open/authorizer admission before strict Boolean validation, stores the requested
flag before db_config exactly as pinned Node, and reports the real result.

loadExtension performs actual open, immutable/current enable, authorizer and
path checks in pinned order. The path must be a primitive string. Optional entry
uses native BufferValue-style admission: primitive UTF8 string or intrinsic
ArrayBufferView bytes, other values mean absent, without ToString or public
metadata hooks. Omitted args use arguments.length guards, not inherited array
indices. Embedded NULs reach C-string truncation just as pinned native BufferValue;
there is no added path validator. Checked backing acquisition/atomic byte copy
owns the snapshot before entering any loader or extension initializer. No JS
pointer or no-GC borrow crosses library loading. POSIX ToNamespacedPath is a no-op;
this does not claim Windows path semantics.

The existing shared connection stays retained across sqlite3_load_extension,
its real VFS/loader and initializer callbacks. Existing scalar/aggregate and
authorizer callback guards protect close/reentry and preserve original callback
errors. SQLite owns successful loaded handles on that connection and closes them
when the real database closes; no second handle table is invented. Failed loads
own/free SQLite's diagnostic even when copying or authorizer unwind throws. A
pending original JS exception remains primary in the existing native error
owner. Missing diagnostic on SQLITE_NOMEM is a real allocation failure; exact
pinned Node null-diagnostic/OOM fatal behavior is not established. The fallback
for other unexpected null diagnostics is the target's predefined extension-error
message, not invented backend success.

## Actual backend and guest loader

The engine depends on node-sqlite@26.13.0, SQLite3.54.0 from the pinned Node
archive and verified sources.json. It does not use the independent sqlite3.49.1
recipe with SQLITE_OMIT_LOAD_EXTENSION. The exact Node recipe defines no omit
flag. The amalgamation does omit extensions under __wasi__, but this SDK's actual
compile owner selects wasm32/64-unknown-unknown plus truthful __unix__ macros,
not WASI. Unix VFS xDlOpen/xDlSym/xDlClose call real dlfcn operations. SpiderMonkey
already links -ldl; libc/glue/dlopen.c uses normal guest filesystem reads and
prepare/next transaction imports, guest-side initialization and symbol lookup.
host/src/dylink.ts compiles/instantiates side modules in the embedding host,
not the disabled nested guest WebAssembly backend. That backend stays in scope
for its own later phase and is not a prerequisite inferred here.

These are source traces, not successful Wasm extension execution. Actual
side-module format/ABI, exported initialization symbol, table/memory relocation,
initializers, sqlite3_api_routines function-pointer signatures, fork/thread
replay, failed init and dlclose with live statements all need real composed guest
validation. Native host Mach-O/ELF extension files are not guest Wasm libraries.
No host Node loader or SQLite implementation is delegated to in production.

Only SQLite's C-API loader is enabled via SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION;
SQL load_extension() stays disabled. No sqlite3_enable_load_extension call
broadens that security gate. Guest kernel credentials/path permissions govern
actual VFS reads. The guest CLI currently has no activated Node Permission Model;
this slice adds neither activation nor a fabricated disabled-state callback.
Pinned Node rejects extension-enabled open when that model is active and also
checks filesystem-read permission before load. Those APIs must connect to the
real future permission owner before activation; no security equivalence is
claimed for that missing mode. Public Error ordinary-property/realm policies,
uncatchable callback abrupt completion, GC/OOM and four hosts remain shared
unvalidated obligations, not exclusions.

## Evidence scope and integration

This capsule contains three existing runtime leaves plus this document, with
exact pre/postimages and a narrow raw patch. No recipe revision, generated core,
engine patch, ABI/pin or executable build-script change is supplied. Existing
runtime input declarations already cover the three runtime leaves; the parent
owns actual then-current composition, normal staging/source checks and any
necessary later targeted validation. No source generation, compiler, native
probe, guest execution or routine test ran in this phase. Read-only source
inspection and patch/identity checks establish source content only. Independent
review is required before integration. All prior SQLite findings and historical
failure evidence remain unchanged.
