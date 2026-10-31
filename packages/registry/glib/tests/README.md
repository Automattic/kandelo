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
