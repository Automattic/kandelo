# SDK compiler-facts recovery ownership

This separate SDK slice retains engine recipe142. No recipe bump is needed:
the changed sdk/src input already participates in normal global package and
plugin/musl freshness keys. The engine source, audited Node pins, public core
algorithms, ABI and original compiler diagnostics remain unchanged. Existing
engine116 and all guest artifacts remain stale for the current candidate.

Clang's semantic initializer recovery list can contain a null Expr after a
source diagnostic. Kandelo's AST collector used it as a real expression and
crashed. The two owning consumers now distinguish that missing entry: it names
no referenced function and has an unknown function origin, following existing
sources(nullptr) policy. The collector still visits the diagnosed tree. It
neither skips whole units nor invents empty/known callback facts. This is a
Kandelo defect, with no external compiler/runtime defect attribution.

Root applies the exact sealed six source/comment lines and standalone regression.
A fresh native plugin component is built through sdk/src/plugin/build.sh in the
declared dev shell. Thirteen focused checks pass. All12syntax cases preserve
uninstrumented Clang stdout/stderr/status exactly;11invalid inputs remain errors.
The retained baseline plugin crashes on6of them. The valid host LLVM IR/facts
fixture is byte-identical between old/new plugins and retains its explicit
callback, address-taken and indirect-call facts. Before/after logs are preserved.
This proves the selected native component behavior,not every valid program,
Wasm object, SDK driver/cache, guest runtime or four-host conformance.

The normal SDK driver hashes changed plugin sources; musl freshness includes
the plugin sources/bytes and package global inputs include sdk/src. Current
source owner identities are recorded. The next normal selected engine build
must refresh those keys and prerequisites; no old receipt or artifact is
restamped or accepted as current. It may rebuild selected musl/static dependency
inputs. This authorizes no full product graph/image/kernel rebuild or overall
suite,which remain deferred. No normal SDK driver/plugin-cache population,
sysroot refresh,guest package/engine build or overall suite ran in this slice.

See [sdk-recovery-finding-progress.json](sdk-recovery-finding-progress.json).
