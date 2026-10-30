# Shared GObject callback ABI gate

Build through the declared resolver in the dev shell:

```sh
cargo xtask build-deps --source-only --arch wasm32 \
  --binaries-dir "$PWD/local-binaries" resolve gobject-callback-tests
```

This publishes a claimed local generation through the normal resolver.
`./run.sh local-build --all` also includes this test-support package in
the complete SourceOnly projection; it is not a `run.sh build` target.
Run `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/gobject-callback-contract.test.ts'`.
Missing normal artifacts fail; no skip-if-missing or private header/library
replacement. This is a wasm32 CPU gate, not browser/compositor acceptance.

The contract fixture links the actual declared GLib/GObject/libffi libraries.
Callbacks and callers are separate translation units. It runs seven result
types (wide signed positive/negative, unsigned64, double, pointer, enum, flags)
through raw ffi, normal/swapped generic GValue/va, and real class signal
emitv/emit-va, plus GSource closure reference/dispatch/destruction:50 cases.
Raw ffi separates the return buffer contract from GLib value conversion.
Class signal emit-va exercises the normal optimized dispatch when eligible;
this is not instrumentation-based coverage of every internal branch.

Ten pinned upstream GObject targets use original assertions/test selection:
type, basic-signals, signals, closure, defaultiface, dynamictype, accumulator,
object, references, signal-handler. Same current normal GLib source patches
are applied; upstream glib-genmarshal generates their marshallers with the
original Meson options. The recipe rebuilds no private GLib library and
uses resolver-owned work/output roots, direct static dependencies, normal
SDK/fork instrumentation/ABI stamping/publication. Child/self-exec tests use
the normal guest VFS and syscall path. Upstream skipped/debug branches remain
visible limitations; passing this selection is not a whole-GLib claim.

Known unclosed obligations: arbitrary ffi signature families/closure pool
admission, raw unary registrations in upstream testcommon.h, interface signal
paths, complete notifications/GTest fixture lifecycle, GIO async/cancellation,
module/listener dispatch and actual compositor lifecycle. Failures are ordinary
gaps to resolve; do not remove targets or weaken upstream assertions for green.
The standalone callback matrix before/after evidence is private diagnostic
proof; this new normal package's build/run remains pending until review.

Provenance: GLib2.84.4 official archive pinned by manifest SHA256; existing
shared port patches are explicit build inputs. New fixture code is Apache2.0;
upstream tests are LGPL2.1-or-later. build.toml records full reviewed base b43;
normal publication should record the final integration commit via repository
metadata tooling. No ABI/public ffi_arg layout change.
