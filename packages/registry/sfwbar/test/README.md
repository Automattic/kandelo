# SFWBar popup ownership regression

Run with the exact source archive accepted by the package manifest:

```sh
scripts/dev-shell.sh bash packages/registry/sfwbar/test/run-window-lifecycle.sh /path/to/sfwbar-v1.0_beta17.tar.gz
```

The runner verifies its SHA-256 against `package.toml`, extracts privately,
applies the package's actual patches with zero fuzz, and compiles the real
upstream `src/window.c` using declared native GLib/GObject and UBSan. It
never reads or mutates the production SDK, target products or shared cache.
Pass a second argument naming a log directory to retain individual results.
Alternatively, set `KANDELO_SFWBAR_LIFECYCLE_LOG_DIR` inside the dev shell.
Without either, temporary source, binaries and logs are removed on exit.

The fixture supplies only a narrow Gtk widget surface. Signals, object-bound
closures, GObject dispose/finalize, weak receiver lifetime, data destructors
and lists use actual native GLib/GObject. A test-only `g_object_get_data`
boundary verifies that callback data names a live fixture GObject before
forwarding to native GLib; invalid upstream data fails deterministically.
This is ownership evidence, not GTK rendering or a Wayland session test.

Ten bounded controls cover duplicate and reopened references, owner-before-
popup destruction, destruction without unmap, explicit/idempotent release,
self association, legacy menu callback normalization, synchronous list
mutation, and sibling destruction during collapse. All original and
partial-datum-only controls must fail after entering the actual fixture;
timeouts are failures of the check. Every fully patched control must exit
successfully with its own pass assertion. The partial control establishes
that correcting the destructor datum alone does not fix signal ownership.

The original and datum-only collapse and reentrant-collapse controls can
fail before the invalid
read (a UBSan alignment diagnostic) or on that read (a UBSan SEGV report).
The latter counts only for those four exact negative cases, with a complete
diagnostic,
matching top frame and summary, and this run's exact source statement after
synchronous hide/unmap. Generic signals, missing symbols, wrong source,
truncated diagnostics and timeouts remain failures of the check. Repaired
cases still require exit0 plus their own pass assertion.

Classifier controls can be run separately with the verified archive:

```sh
scripts/dev-shell.sh python3 packages/registry/sfwbar/test/check-runner-diagnostics.py /path/to/sfwbar-v1.0_beta17.tar.gz
```
