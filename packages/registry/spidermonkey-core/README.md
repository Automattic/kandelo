# Reusable SpiderMonkey core

The current VM/helper candidate corrects our stack-base adaptation to capture
the actual creating thread, carries native property error modes across engine
operations without leaking them into reentrant JavaScript, and preserves
property-presence results through the original proxy/native get algorithms.
Producer patches0023–0025 retain complete source functions and ordinary
property/trap ordering. The changed whole units pass syntax checks; complete
normal builds and actual runtime qualification of these changes are pending.

The native length-aware CompileFunction API now accepts a hashbang only at the
first UTF-16 body offset, matching Node's underlying source interface. The
existing function builder keeps the complete source; its private nontransitive
option identifies that offset, and the existing scanner comment consumer
handles the line. Ordinary Function constructors and misplaced/nested headers
retain their original syntax rules. This fixes an embedding API mismatch; it
is not an upstream SpiderMonkey language defect. Producer patch0020 records the
change. Actual npm/header/cache/location qualification remains required.

This library recipe builds the authenticated 153.7 ESR engine and its Rust
runtime through Mozilla's normal configure/build/install path, without a shell
program or Kandelo's legacy Node frontend. The original engine algorithms stay
in their original files. A source manifest classifies every existing patch file
section; the build rejects unreviewed input identities and collects all source
application errors before stopping. Complete selected file diffs are applied;
functions are not extracted.

The static embedding build retains mozglue and the Rust runtime independently
of the shell. Mozilla's static engine archive and the actual target Rust archive
are installed separately, with public/generated headers and relocatable
pkg-config metadata. The native fatal logger is an explicit dependency, reusing
the selected original failure policy. The core does not own a Node Environment,
Node's event-loop policy, startup or module loaders.

Structured parser failure facts now compile through the original ErrorMetadata,
CompileError and JSErrorReport owners in both normal Node profiles. Canonical
UTF-8 words/names are owned before parser storage retires; copied reports keep
them in the existing report allocation. A scoped parser report callback covers
token mismatches without a global or JSContext last-error flag. It preserves
the original checks, reports and notes. Complete report-copy/GC/OOM lifetime
qualification remains unfinished; the Node bridge owns diagnostic correspondence.
The identifier patch preserves actual plain-versus-escaped token facts for
INVALID_ID without changing the original rejection or source position. The ID
alone covers both cases and cannot select the native retry policy correctly.

Decoded stencil origin rebasing resets the decoded introduction offset before
the original initializer applies the current options. Decoding already sets
that optional field; initializing it twice aborts when Node recompiles a failed
builtin from its code cache. The reset affects the independently decoded,
unpublished origin, preserving source data and function parameter boundaries.
The correction still needs normal-build and installed-runtime qualification.

The engine C++ and Rust archives have been compiled through the normal resolver,
with Mozilla's source, macroassembler and opcode checks passing. Runtime
behavior and the Node bridge remain unqualified. This is not the Node engine
bridge SDK: it supplies no v8.h, v8.pc or Node-SDK
identity. The Node build must continue rejecting this core alone. A genuine
bridge and original native Node owners remain required; the old shell must not
be relabeled to satisfy them.

The preserved shell patches and frontend remain under spidermonkey. Shell-only
registration/startup/scheduling code and process-version reconstruction do not
enter this library. Original Node owners and its isolated full ICU provider must
supply that behavior in the complete native integration. Neither this source
split nor a successful core archive build qualifies Node startup or any module.

The native Promise adapter has a separate engine-owned silence bit for Node's
internal promises. Silent rejected promises skip the debugger settlement hook;
fulfillment hooks, native lifecycle hooks, the handled bit and unhandled
rejection tracking are unaffected. This preserves the distinction between
`MarkAsSilent` and `MarkAsHandled`. The new producer patch is source-verified but
has not yet been built or runtime-qualified. Inspector remains a separate
approved follow-up.

The next producer batch adds owner-thread native allocation observers after the
existing five mutator GC-cell allocation routes. Notifications borrow the new
cell's address, kind and size before caller initialization completes; consumers
must not inspect that cell, allocate GC things, run JS or throw. A separate weak
nursery epilogue runs after strong tracing and existing tenured callbacks, before
forwarding information is cleared. The bridge owns registration and retirement.
This is source work for real heap profiling, not a completed profiling or startup
qualification. The shared guest/kernel ABI is unchanged by these private,
coordinated engine/bridge source interfaces.

Static import attributes retain their parser UTF-16 source offsets in the
existing module stencil records. XDR transports those records unchanged in
meaning; attribute offsets do not participate in module-request identity.
The native bridge's compiled-cache identity binds the actual engine inputs.

Native function-body source locations use a transient ScriptSource classification. The bridge sets it on each compiled or decoded native function publication; original Function-constructor parsing and cache serialization remain unchanged.
