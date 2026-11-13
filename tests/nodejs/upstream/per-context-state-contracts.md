# Per-context state and symbol contracts

Source-only inventory for the proposed per-context.cpp/h owner. No runtime
probes/tests/builds, source modifications or Git mutations. Node source root:
`.context/nodejs-lts-cache-v2/node-v26.13.0/` (Node below). Mozilla source root:
`.context/node26-mozilla-style-source/tree/firefox-140.11.0/` (SM below).

## Exact original object/prototype/property contracts

| Object/state | Prototype and properties | Original source |
|---|---|---|
| Per-context exports | Ordinary fresh Object.prototype object, retained through a V8 API-private key on the context global; not a global named property or ordinary Symbol property | Node/src/api/environment.cc:808–831 |
| primordials | Fresh null-prototype object. exports.primordials is assigned before symbol-table creation/scripts. Public source finally reasserts null prototype and freezes primordials | Node/src/api/environment.cc:1040–1044; lib/internal/per_context/primordials.js:785–786 |
| privateSymbols table | Fresh object-template instance then prototype changed to null; each macro property name maps to the isolate's existing V8 Private identity | Node/src/api/environment.cc:975–996 |
| perIsolateSymbols table | Fresh object-template instance then prototype changed to null; each macro property name maps to the isolate's existing ordinary Symbol identity | Node/src/api/environment.cc:999–1022 |
| DOMException, QuotaExceededError, emitMessage | Written by original JS into exports. Do not generate alternate constructors/message-dispatch algorithms in native initializer | Node/lib/internal/per_context/domexception.js:208,296; messageport.js:19–39 |

The two symbol tables' named properties are plain **writable, enumerable,
configurable** data properties: ObjectTemplate::Set uses attributes=None by
default (`Node/deps/v8/include/v8-template.h:57–62`), and None omits ReadOnly,
DontEnum and DontDelete (`v8-object.h:154–162`). Likewise the fresh ordinary
exports receives primordials through ordinary Set. Do not freeze tables or
silently make fields readonly/nonconfigurable. Private backing-slot visibility
and public property descriptors are separate concerns.

SM equivalents: JS_NewPlainObject for exports. For null-prototype ordinary
tables use JS_NewObjectWithGivenProto(cx,nullptr,nullProto), where nullProto
is a rooted null object handle; nullptr class explicitly selects a plain
object in actual implementation (`SM/js/src/jsapi.cpp:1899–1918`; public
`jsapi.h:371–382`). Define W/E/C fields with JS_DefineProperty and
JSPROP_ENUMERATE only. Attributes=0 would make them **nonenumerable**, unlike
V8 None. Readonly/permanent are opt-in flags
(`SM/js/public/PropertyDescriptor.h:35–47`; PropertyAndElement.h:99–103).
Ordinary Set also creates W/E/C fields on pristine objects but has prototype
lookup/interceptor behavior; avoid arbitrary untrusted exports inputs.

## Identities: isolate creation is distinct from per-context tables

Node creates each private primitive with Private::New and each ordinary
symbol with Symbol::New in IsolateData::CreateProperties
(`Node/src/env.cc:489–539`). It does **not** use Symbol.for and does not
regenerate values in InitializePrivateSymbols/InitializePerIsolateSymbols.
The table objects can differ across contexts while contained primitive
identities must remain the same within one isolate. Per-runtime/guest-isolate
ownership must be defined explicitly on SpiderMonkey; do not infer one
isolate per outer browser tab or host process.

All later internalBinding('util').privateSymbols and internalBinding('symbols')
consumers must reuse the same primitives. For example Node/src/node_util.cc:
542–554 constructs another table from the same Environment/IsolateData
getters. DOMException marks clone mode using transfer_mode_private_symbol
(:82,217), then messaging looks up that same key. Generating per-context
symbols with identical descriptions would silently break identity.

Ordinary symbols: JS::NewSymbol(cx,rootedDescription) creates a fresh
non-registry symbol (`SM/js/public/Symbol.h:24–41`). Call once per isolate
identity, keep a traced owning edge, and copy SymbolValue handles into each
realm's table. JS::GetSymbolFor is the wrong registry/observable identity.
Do not share raw foreign-realm **table objects** without proper wrapping;
the shared primitives and per-context object wrappers are different layers.

### Private-symbol prerequisite is real, not ordinary Symbol substitution

V8 Private::New returns factory NewPrivateSymbol, exposed by the template as
a private-symbol primitive (`Node/deps/v8/src/api/api.cc:9517–9524`). Normal
key accumulation filters any private symbol
(`deps/v8/src/objects/keys.cc:134–142`). An ordinary JS::NewSymbol would leak
DOMException's transfer-mode own key through Reflect.ownKeys and other
symbol reflection; a nonenumerable ordinary Symbol still leaks there.
Unchanged JS assigns this field with bracket syntax, so a native-only side
map cannot magically intercept it.

SM public Symbol.h has NewSymbol/GetSymbolFor/WellKnown primitives and no
public constructor for these V8 private semantics. Internally SM has
SymbolCode::PrivateNameSymbol and Symbol::new_(cx,code,description)
(`SM/js/src/vm/SymbolType.h:63–65,88–89`). Its normal enumeration excludes
private names (`SM/js/src/vm/Iteration.cpp:207–216`) and private property
writes are exempted from ordinary extensibility check
(`vm/NativeObject.cpp:1630`). This suggests an owning engine primitive to
investigate, **not proof of full V8 Private equivalence**: proxies, private
write/read, frozen objects and public reflection need precise verification.
Do not pass a public ordinary symbol under a name that says private and
claim the contract satisfied. An injected genuine native private-symbol
factory with explicit unavailable/error behavior is honest until that engine
owner exists. Failure must stay visible rather than pretending initialization
is complete.

## Exact symbol inventory

Authoritative macro lists are `Node/src/env_properties.h:20–42` and :46–74.
Use the pinned lists as metadata inputs; do not derive identity from stripped
descriptions or maintain another untracked subset. Table keys are the macro
PropertyName; primitive descriptions are the second macro argument and may
differ (for example handle_onclose_symbol describes `handle_onclose`).

The minimal **direct** consumers in these three initializer scripts require
transfer_mode_private_symbol, messaging_clone_symbol and
messaging_deserialize_symbol (`domexception.js:18–24`). messageport.js uses
public Symbol.for('nodejs.internal.kHybridDispatch') and
Symbol.for('nodejs.internal.kCurrentlyReceivingPorts') itself (:15–17),
which are distinct from the nonregistry native isolate symbols. The full
native tables should contain the original full inventory, because later
bindings depend on the remaining entries.

### private_symbol properties (22)

| Table property | Primitive description |
|---|---|
| `arrow_message_private_symbol` | `node:arrowMessage` |
| `contextify_context_private_symbol` | `node:contextify:context` |
| `decorated_private_symbol` | `node:decorated` |
| `empty_context_frame_sentinel_symbol` | `node:empty_context_frame_sentinel` |
| `ffi_pointer_address_private_symbol` | `node:ffi:pointer_address` |
| `transfer_mode_private_symbol` | `node:transfer_mode` |
| `host_defined_option_symbol` | `node:host_defined_option_symbol` |
| `js_transferable_wrapper_private_symbol` | `node:js_transferable_wrapper` |
| `entry_point_module_private_symbol` | `node:entry_point_module` |
| `entry_point_promise_private_symbol` | `node:entry_point_promise` |
| `module_source_private_symbol` | `node:module_source` |
| `module_export_names_private_symbol` | `node:module_export_names` |
| `module_circular_visited_private_symbol` | `node:module_circular_visited` |
| `module_export_private_symbol` | `node:module_export` |
| `module_first_parent_private_symbol` | `node:module_first_parent` |
| `module_last_parent_private_symbol` | `node:module_last_parent` |
| `napi_type_tag` | `node:napi:type_tag` |
| `napi_wrapper` | `node:napi:wrapper` |
| `untransferable_object_private_symbol` | `node:untransferableObject` |
| `exit_info_private_symbol` | `node:exit_info_private_symbol` |
| `promise_trace_id` | `node:promise_trace_id` |
| `source_map_data_private_symbol` | `node:source_map_data_private_symbol` |

### symbol properties (27)

| Table property | Primitive description |
|---|---|
| `fs_use_promises_symbol` | `fs_use_promises_symbol` |
| `async_id_symbol` | `async_id_symbol` |
| `ffi_sb_shared_buffer_symbol` | `ffi_sb_shared_buffer_symbol` |
| `ffi_sb_invoke_slow_symbol` | `ffi_sb_invoke_slow_symbol` |
| `ffi_sb_arguments_symbol` | `ffi_sb_arguments_symbol` |
| `ffi_sb_return_symbol` | `ffi_sb_return_symbol` |
| `constructor_key_symbol` | `constructor_key_symbol` |
| `handle_onclose_symbol` | `handle_onclose` |
| `no_message_symbol` | `no_message_symbol` |
| `messaging_deserialize_symbol` | `messaging_deserialize_symbol` |
| `imported_cjs_symbol` | `imported_cjs_symbol` |
| `messaging_transfer_symbol` | `messaging_transfer_symbol` |
| `messaging_clone_symbol` | `messaging_clone_symbol` |
| `messaging_transfer_list_symbol` | `messaging_transfer_list_symbol` |
| `oninit_symbol` | `oninit` |
| `owner_symbol` | `owner_symbol` |
| `onpskexchange_symbol` | `onpskexchange` |
| `resource_symbol` | `resource_symbol` |
| `trigger_async_id_symbol` | `trigger_async_id_symbol` |
| `builtin_source_text_module_hdo` | `builtin_source_text_module_hdo` |
| `embedder_module_hdo` | `embedder_module_hdo` |
| `source_text_module_default_hdo` | `source_text_module_default_hdo` |
| `vm_context_no_contextify` | `vm_context_no_contextify` |
| `vm_dynamic_import_default_internal` | `vm_dynamic_import_default_internal` |
| `vm_dynamic_import_main_context_default` | `vm_dynamic_import_main_context_default` |
| `vm_dynamic_import_missing_flag` | `vm_dynamic_import_missing_flag` |
| `vm_dynamic_import_no_callback` | `vm_dynamic_import_no_callback` |

## Initializer ordering, publication and failure

Original sequence, `Node/src/api/environment.cc:1025–1087`:

1. GetPerContextExports ensures the hidden exports object exists before
   InitializePrimordials is called. Its call back into GetPerContextExports
   therefore returns the same already-created object, rather than recursing.
2. Check exports does not already have a primordials property. This is a
   CHECK on Has, not a harmless idempotent reinitialization branch.
3. Create null-prototype primordials and install exports.primordials.
4. Build the null-prototype privateSymbols and perIsolateSymbols tables.
5. Compile/call, in this exact order, internal/per_context/primordials,
   internal/per_context/domexception, internal/per_context/messageport.
6. Every call receives the same four object identities in order:
   `(exports, primordials, privateSymbols, perIsolateSymbols)`.
7. Stop immediately on any compilation/call failure. No later source executes.

There is no rollback in Node: private exports and primordials are already
published on failure. A later bare GetPerContextExports call returns that
existing object without checking successful initialization
(`environment.cc:817–821`). Node context creation is being abandoned; this is
not evidence that retrying initialization or using partial exports is valid.

Kandelo owner should make lifecycle explicit: New → Initializing → Ready,
with a terminal Failed state for any allocated/compiled/called initializer
failure. Set Initializing before any source call/reentrant work; refuse
reentrant initialize, refuse retry after Failed, and expose exports for normal
consumption only after Ready. Repeated Get on Ready may return the same
object without reexecuting source; a second explicit initialize should have a
documented reject/idempotent-success policy and must never execute twice.
Keep initial pending engine exception intact when setting Failed (integer
reserved-slot update is infallible). If a later operation visits Failed with
no pending exception, report a real prior-initialization failure rather than
returning false as success or silently rebuilding. Do not clear an existing
parser/JS/OOM exception in a generic cleanup path.

If pre-allocation failure occurs before the canonical carrier is published,
the owner must decide whether the whole context is terminally failed, or a
clean retry is possible before any observable mutation. Do not conflate that
case with retry after exports/source has partially initialized. Conservatively
terminal failure is easiest to keep truthful.

## Private native carrier: GC, authority and owner lifecycle

Use a nonexposed dedicated JSClass with JSCLASS_HAS_RESERVED_SLOTS(n), where
slots hold actual JS::Value edges for owning global, exports, primordials,
per-context symbol tables, isolate-symbol owner and scalar lifecycle status.
Exact slot layout belongs to this native owner. Initialize slots before
publishing/using the carrier, and check exact JSClass pointer before reading
slots. Bounds are asserted, not a runtime validation substitute
(`SM/js/public/Class.h:525–538`; Object.h:45–48,63–95).

Store references with JS::ObjectValue/SymbolValue and
JS::SetReservedSlot. SetReservedSlot includes GC write barriers
(Object.h:87–94). Ordinary native-object fixed/dynamic slots are automatically
traced by JSObject::traceChildren (`SM/js/src/vm/JSObject.cpp:3309–3349`);
no custom trace hook is needed merely for those JS::Value slots. Never put a
JSObject* in PrivateValue and assume the GC sees it. A separate native
struct holding JS::Heap references needs a trace owner; Heap is not itself a
root (`SM/js/public/RootingAPI.h:269–290`).

Avoid the self-root cycle: carrier → native struct → PersistentRooted(carrier
or realm/global) → carrier, when the native struct is only deleted by the
carrier finalizer. That prevents finalization. A graph solely made of traced
object/slot edges can be collected even if carrier references its owner
global and global references carrier. A caller-owned Rooted carrier is
correct for an active call; runtime/environment roots need explicit release
at genuine lifecycle end.

A caller-owned handle alone does **not** enforce once per global: two carriers
can point to the same global and run initializers twice. The embedding owner
must supply a canonical global→carrier association. Options include its
actual global class reserved slot, or a rooted native WeakMap keyed by global
with proper realm/wrapping handling (public WeakMap API exists in
`SM/js/public/WeakMap.h:18–30`). Do not substitute a publicly discoverable
Symbol/string global property for Node's API-private storage. A documented
canonical-owner prerequisite is acceptable for a low-level helper, but do
not claim it independently enforces one initialization per realm.

Same-global admission before any script execution or slot output:

- Validate JS::GetClass(state)==the exact native carrier class.
- Require a nonnull JS::CurrentGlobalOrNull(cx)/current realm.
- Require JS::GetObjectRealmOrNull(state)==JS::GetCurrentRealmOrNull(cx);
  CCWs return null from GetObjectRealmOrNull.
- Require the stored owning-global object to equal CurrentGlobalOrNull(cx).
- Validate state and isolate-symbol owner lifecycle/role. Do not trust an
  arbitrary object's same-named fields or accept a foreign owner by silently
  entering its realm. Caller must already have entered the intended realm.

Sources: `SM/js/public/Realm.h:42–54`; GlobalObject.h:26–37. In particular
GetNonCCWObjectGlobal and JSAutoRealm require a non-CCW input; compare realm
or reject CCW before invoking APIs with that precondition. Cross-realm reuse
of an isolate's symbol primitives is a separate explicit supported path,
not permission to run a per-context carrier in another global.

## Rooted function call, exact argv and receiver

Use a rooted result and rooted function value plus RootedValueArray<4>.
CompileBuiltinFunction returns raw JSFunction*, which must be rooted
immediately. Obtain JS_GetFunctionObject into a rooted object/value using
actual `SM/js/src/jsapi.h:583` API; do not reinterpret-cast pointers or use an unrooted
stack Value array across a JS call.

Call the **Value receiver** overload:

```cpp
JS::RootedValue receiver(cx, JS::UndefinedValue());
JS::RootedValue functionValue(cx, JS::ObjectValue(*functionObject));
JS::RootedValueArray<4> argv(cx);
argv[0].setObject(*exports);
argv[1].setObject(*primordials);
argv[2].setObject(*privateSymbols);
argv[3].setObject(*perIsolateSymbols);
JS::RootedValue result(cx);
if (!JS::Call(cx, receiver, functionValue, argv, &result)) {
  // Preserve pending exception; mark owner Failed; stop.
  return false;
}
```

Actual overload is `JS::Call(cx,Handle<Value> thisv,Handle<Value> fun,
const HandleValueArray&,MutableHandle<Value>)`
(`SM/js/public/CallAndConstruct.h:101–110`). RootedValueArray is traced and
implicitly becomes HandleValueArray (`ValueArray.h:29–38,63–65`). Do not use
a null-object receiver overload as an assumed equivalent to explicit
undefined. Node's CompileAndCallWith explicitly supplies undefined
(`Node/src/node_builtins.cc:549–563`). Source bodies themselves determine
strictness; do not inject directives or rewrite them.

Both function compilation and Call can allocate/GC/throw. Keep the canonical
carrier, every object/table, source function and result rooted throughout;
read slot values into fresh Rooted handles instead of holding raw pointers
across compilation or property creation. On success mark Ready only after
all three calls succeed. This is source design guidance; no execution or
GC-lifecycle evidence has been collected by this worker.
