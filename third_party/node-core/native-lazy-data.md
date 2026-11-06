# Native lazy data property source proposal

This is an uncompiled engine prerequisite proposal for R-015. It does not
establish guest or four-host support, and it installs no Worker, Navigator,
util, Buffer, fs or import.meta public property.

The proposed JS::DefineNativeLazyDataProperty API accepts a real native
callback and traced data value. A distinct slotful shape flag identifies a
pending data property. Its slot owns a hidden native cell. It is neither an
ES accessor nor a public placeholder value. Data descriptor classification
and writable/enumerable/configurable attributes remain distinct from raw-slot
eligibility. All pure/raw-slot/getter cache paths must reject pending cells.

The native callback runs directly in the actual holder's realm. The owner
wraps returned values and exceptions to the caller compartment, preserving
OOM and uncatchable completion status. A callback has native-code lifetime;
all JS references must be reachable from its traced data value. The private
bridge deliberately stores a JS callback and its data in a separate traced
record and performs an ordinary checked JS call. Foreign JS functions retain
their normal realm semantics.

Reads, own descriptors and defineProperty load the holder. Successful loading
is retained across a subsequent shape-allocation OOM. Own assignment retires
the loader without calling it; inherited assignment follows OrdinarySet and
shadows the receiver. Delete, has and keys use ordinary native shape state.
PreventExtensions, seal and freeze preserve pending state. Materialization
preserves even nonconfigurable/nonwritable attributes and uses existing shape
and Watchtower invalidation. Descriptor/definition paths restart their lookup
after user code. No C++ PropertyInfo survives a callback for later use.

The integrity-test delta separately records pinned Node's non-loading
observation: a sealed pending holder reports frozen until a writable value
materializes. It changes no data-descriptor/writable metadata and introduces
no accessor flag. Freeze still clears writable in the real property flags.

The cell and private adapter record use ordinary traced slots and barriers.
Active calls root the cell, holder, data and result across callbacks and GC.
Deletion/replacement removes the persistent cell edge; active calls cannot
resurrect a retired cell or overwrite a newer property. A successful callback
clears callback/data storage after retaining its result. No global root map,
external native allocation, manual finalizer or context-retirement registry is
introduced. Reentrant loading returns an error; mutation/retirement policies
are separate from compatibility claims. Four exact pinned Node mutation
controls terminate their isolated process and remain preserved as observations.

Initial admission is limited to absent own non-index/non-private keys on
extensible PlainObject holders. This is an implementation slice, not an
accepted engine/platform boundary or the complete native lazy contract.
Globals, other export holders/native classes, reinstalling an existing own
key, private/index keys and full public routing remain open. Native callbacks
must not throw C++ exceptions and must obey normal JSAPI compartment rules.

Integration requires the engine owner/header/shape/slow-path/cache/integrity
patches, proposed jsapi-tests, the new bridge fragment, one generator FRAGMENTS
entry and one privileged shell binding registration. Root owns recipe revision,
patch numbering and current shell reconciliation. Add the bridge to declared
recipe inputs; rebuild the actual engine before claiming runtime support.
No kernel/libc/SDK source or ABI snapshot changes are proposed. Engine cache
freshness must change; existing engine artifacts do not gain this behavior.

Unvalidated: C++ compilation and JSAPI ABI, moving/incremental GC and cycle
retirement, allocation-failure injection at every phase, interrupt/reentry
errors, interpreter/JIT/megamorphic/proxy paths, realm/context retirement,
object transplant/debugger interactions, wasm32/wasm64 and all four hosts.
Source wiring/generation and exact native reference controls cannot prove them.
