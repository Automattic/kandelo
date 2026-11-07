`check-application-default-vfuncs.sh` checks the full-signature base application
virtual methods. Run in the declared dev shell with the pinned GTK 3.24.34 source
after the normal recipe patches, a pristine pinned source root before this repair,
and a private output directory:

```sh
scripts/dev-shell.sh bash packages/registry/gtk3/tests/check-application-default-vfuncs.sh \
  /private/patched/gtk+-3.24.34 /private/pristine/gtk+-3.24.34 .context/gtk-default-control
```

It extracts the actual `GtkApplicationImplClass` declaration and default callback
bodies/class initializer from those sources. Separate Wasm translation units at
O0/O2 prevent caller optimization from hiding indirect signature errors. All 14
original defaults must trap with a signature mismatch. Every repaired default
must return its original zero/false result or perform no action, and preserve
caller sentinels. Incompatible function pointer assignments fail compilation.

Only unrelated GObject parent storage and opaque dependencies are stubbed; this
control does not test actual GObject layout, type registration, GTK signals,
backend overrides, window realization or lifecycle. Normal rebuilt application
and browser acceptance must test those consumers.

# GTK connected-signal ABI control

`extract-signal-contract.py SOURCE OUTPUT.c` extracts complete actual
`gtkdragdest.c` helper/adapter definitions and selects connected callbacks from
its actual registrations. Compile that TU separately from
`signal-contract-caller.c` with normal SDK, installed GTK headers and the full
normal static GTK/GObject dependency closure. Repeat for the pinned source
before/after `wasm-widget-signal-contracts.patch`.

The caller takes `object|realize class|normal|swapped value|va`. Each combination
runs through real GObject class dispatch or connected normal/swapped emission.
The deliberately invalid-widget GObject argument must produce exactly two GTK
precondition diagnostics after successful callback entry. No GTK implementation
is mocked. This proves call-entry signature compatibility, not valid-widget
behavior, a display connection, or desktop rendering/lifecycle acceptance.

Before the repair, the eight connected combinations must trap at the indirect
call, while four exact-signature class combinations enter the GTK helper.
After the repair, all twelve combinations must enter it with the expected
precondition diagnostics. Preserve actual trap/error output; a timeout or a
different error is not the expected negative control.

Non-NULL object/argument/userdata delivery and disconnect identities are tested
separately by the small `gobject-callback-tests` normal fixture. Those tests add
no GTK dependency. Normal GTK/SFWBar builds and actual browser compositor
sessions remain required after these focused CPU controls.

The exact reviewed scope, typed parameters, registration flags and cleanup
identities are recorded in [signal-contract-audit.md](signal-contract-audit.md).

# GTK accessibility signal-handler control

GTK creates accessible objects lazily, for example when a menu item is
selected and focus is reported at idle. Their `initialize` methods connect
handlers to ordinary widget signals. GLib's C marshallers call a connected
handler as `handler (instance, params..., user_data)` with the signal's return
type. Nine pinned a11y handlers omitted `user_data`. Two of them also returned
`gint` from void signals. Native ABIs ignore that mismatch, but Wasm's typed
`call_indirect` traps. In SFWBar, clicking a leaf menu item trapped in
`deselect` during menu popdown. `wasm-a11y-signal-contracts.patch` gives
each handler its exact connected-handler signature.

```sh
scripts/dev-shell.sh bash packages/registry/gtk3/tests/check-a11y-signal-contracts.sh \
  /private/patched/gtk+-3.24.34 /private/before-a11y-patch/gtk+-3.24.34 /private/work
```

`a11y-signal-contracts.py` requires every literal `gtk/a11y` registration to
match its reviewed inventory. It reads each signal's parameter count and return
type from the actual `g_signal_new`/`g_signal_newv` in the declaring file, or
from the listed GObject `notify` and ATK `children-changed` definitions. The
repaired tree must have no mismatch. The original tree must mismatch for exactly
the nine repaired handlers. Separate Wasm translation units then call the actual
extracted definition headers through the marshaller's machine type at `-O0` and
`-O2`. All nine originals must trap with a signature mismatch. All nine repaired
handlers must receive every argument, including closure data, unchanged.

The handler bodies are argument recorders, so this proves the call-type
contract only. It does not run GTK, ATK or GObject. Rebuilt GTK, rebuilt
consumers and real menu, toggle, combo-box and entry sessions remain required.

