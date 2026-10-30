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
