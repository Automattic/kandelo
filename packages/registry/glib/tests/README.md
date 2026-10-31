# Interface initializer contract control

`G_IMPLEMENT_INTERFACE` and its dynamic counterpart retain the two-argument
`GInterfaceInitFunc` contract. A one-argument initializer uses the explicit
`G_IMPLEMENT_INTERFACE_UNARY` or `G_IMPLEMENT_INTERFACE_DYNAMIC_UNARY` adapter.
The extra macro prevents a valid two-argument callback, including one with a
typed first pointer, from being dispatched through a unary function pointer.

Prepare the manifest-pinned GLib source with the patches in `build-glib.sh`
in recipe order. Save a second source root immediately before applying
`wasm-interface-init-contract.patch`. These are source-only preparation steps,
not replacements for a normal package build. Then run from the repository:

```sh
scripts/dev-shell.sh bash packages/registry/glib/tests/check-interface-init-contract.sh \
  /path/to/patched-glib /path/to/before-contract-patch /path/to/private-work
```

The script extracts the actual old and repaired registration macros and the
actual repaired thunk. It compiles callbacks, registration and invocation in
separate translation units without LTO, using the declared unwrapped LLVM
compiler. C and C++ Wasm32 controls run at `-O0` and `-O2`. The old static and
dynamic unary dispatch must trap on a genuine binary callback. Ten repaired
cases check unary, binary, typed binary and NULL callbacks, including dynamic
registration and NULL through the unary adapters. Binary callbacks also check
that interface data is NULL. C++ coverage guards the upstream GLibmm test's
use of the explicit adapter.

When native GObject development files are present in the declared shell, an
additional control registers a real interface and constructs four actual
GObjects using unary, binary, typed binary and NULL static registrations.
Otherwise the script explicitly reports that control as unrun. The native
control does not exercise dynamic module lifecycle.

These focused controls prove callback dispatch and source compatibility.
They do not validate rebuilt Kandelo packages, the SDK, guest GObject
lifecycle, browser rendering, or compositor sessions. Those require normal
package and product builds followed by consumer tests.

## Direct signal class handlers

`g_signal_new_class_handler()` and `g_signal_override_class_handler()` accept
handlers with the signal's instance and parameters, without connected-userdata.
Ordinary `g_cclosure_new()` callbacks still include their trailing userdata.
`wasm-class-handler-contract.patch` uses a private GCClosure constructor for the
two class-handler APIs, retaining ordinary ownership while installing the same
exact-arity GValue/varargs libffi dispatch used by class/interface vtable slots.

After preparing the manifest-pinned source with all patches in recipe order,
retain a source copy before applying `wasm-class-handler-contract.patch`, then:

```sh
scripts/dev-shell.sh bash packages/registry/glib/tests/check-class-handler-contract.sh \
  /path/to/patched-glib /path/to/before-class-handler-patch /path/to/private-work
```

This focused control extracts the actual old/repaired API bodies, repaired meta
marshal/constructor bodies and upstream enum marshaler into separate Wasm TUs.
At both `-O0` and `-O2`, twelve old two-argument class-handler routes must trap;
three ordinary userdata routes and two NULL/precondition routes remain valid.
All seventeen repaired cases must pass. Enum, int64 and double returns cover
new/override and value/varargs routing. Registry, GValue and exact-arity call
engines in `model.c` are explicit test doubles: this is source-admission and
Wasm call-type evidence, **not** execution of the full GObject/libffi library.

When native GObject development files exist, a real GObject control separately
exercises both APIs with enum/int64/double signals, emit/emitv, chained overrides,
ordinary three-argument handlers, object weak notifications and exactly-once
connected-closure cleanup. It reports the actual native GLib version; a host
native run is not the patched Wasm library or normal guest acceptance.

The standard signal parameter/return representation is supported by this
candidate. As in the existing vtable path, class dispatch uses signal GTypes
rather than running the supplied C-marshaller body. Custom marshaller-specific
representation conversion, side effects or invocation-hint handling therefore
remain an ordinary GLib compatibility gap. The native reference deliberately
uses a standard enum-marshaler wrapper and reports its observed call count;
that does not prove arbitrary custom marshaller equivalence in the candidate.
Normal rebuilt GLib, upstream signal/closure tests and the original menu
consumer remain required. No GTK/SFWBar-specific bypass is provided.

The normal `gobject-callback-tests` package also builds this same
`native-gobject.c` source as `gobject-class-handler-contract.wasm`, linked
against its resolver-selected installed GLib/libffi dependencies. The host
case in `gobject-callback-contract.test.ts` executes that program through the
normal centralized Node runtime. Its package-source patch list and build
inputs include the direct class-handler patch. This real guest test must
pass separately; the source-isolated and native reference runs do not
substitute for it.
