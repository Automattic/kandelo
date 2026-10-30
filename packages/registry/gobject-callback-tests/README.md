# Shared GObject callback ABI gate

Prepare the normal SourceOnly test-support projection in the dev shell:

```sh
scripts/dev-shell.sh ./run.sh local-build --all
scripts/dev-shell.sh bash -c '
  export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
  export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
  cd host
  npx vitest run test/gobject-callback-contract.test.ts
'
```

Build and run with the same resolution policy. A standalone
`build-deps --source-only resolve` compiles the package, but does not publish
the complete SourceOnly projection used by this host gate. Combining that
build with default-policy artifact metadata selects different cache keys.
This package is not a `run.sh build` target.
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
The normal SourceOnly run at 8a9c9cdb3e passes all fifty contract cases and
four upstream targets. Six upstream targets still fail: basic-signals,
signals, closure, defaultiface, dynamictype and accumulator. They remain
required ordinary gaps; the combined gate is red, with no skipped cases.
This run used a bounded normal engine set containing the fixture, kernel
and complete declared library closure, published as one SourceOnly
projection. No archive or header substitutions were used.

Provenance: GLib2.84.4 official archive pinned by manifest SHA256; existing
shared port patches are explicit build inputs. New fixture code is Apache2.0;
upstream tests are LGPL2.1-or-later. build.toml records full reviewed base b43;
normal publication should record the final integration commit via repository
metadata tooling. No ABI/public ffi_arg layout change.
