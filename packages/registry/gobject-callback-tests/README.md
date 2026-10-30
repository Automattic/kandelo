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

Twelve further signal cases exercise VOID__OBJECT and VOID__VOID through both
emitv and emit-va: class-only, normal connected, and swapped connected routes.
Class callbacks have no trailing data; connected callbacks check non-NULL
instance/argument/userdata identity. Disconnect-by-function/data must remove
exactly the connected handler while subsequent class dispatch still runs.
These62 callback cases are separate from the binding cases and ten upstream
targets. They require a fresh normal fixture build; prior50-case evidence
does not validate the twelve additional signal cases.

Revision3 adds `gobject-binding-lifecycle.wasm`, linked to the same real
installed GObject library, with twelve property-binding lifecycle cases.
One-way, bidirectional, full-transform and closure-transform bindings each
exercise explicit unbind, source finalization and target finalization. Real
integer properties prove initial synchronization policy and propagation in
the applicable directions. Full and closure transforms check exact invocation
counts; endpoint values remain independently writable after binding removal.

Caller-owned binding references survive teardown until explicitly released.
The explicit closure-unbind case retains caller closure references and proves
caller-data cleanup waits for their release; automatic endpoint cases drop
caller closure references early and prove binding-owned retention and cleanup.
Weak/finalization counters and owned heap-data notifiers must each run exactly
once. All new callback signatures are statically checked, with callback and
caller code in separate translation units. The public GObject APIs supply all
binding behavior; this is not a private binding implementation or widget mock.

The focused gate now contains74 cases, plus the ten unchanged upstream targets.
The new twelve require a normal revision3 build and run; previous62-case
evidence does not validate them. Native host controls are not Kandelo Wasm
acceptance. The shared closure-notifier patch is a declared source input and
is applied alongside the other normal GLib patches to upstream test sources.

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
