# Native TLS async-resource ownership

Source235 assigns the actual TLSWRAP identity and default trigger at native
allocation. It retains the actual environment and async frame and emits init
before SSL creation and parent attachment. Reentrant init rollback cannot
resurrect an owner that was closed. Read/write/close use the same opaque
resource; resourceInfo reports its actual state. Close/DestroySSL preserve the
async identity. Actual foreground wrapper finalization queues destroy.
Promise settlement does not pretend to be native callback before/after.

The exact current portable header passes nine assertions through the sealed
OpenSSL addon; three separate pinned-native Node subjects establish reference
trigger/frame identity, retained id after close, and destroy after GC. They do
not execute the new Kandelo JSAPI, guest init/frame/realm/Worker paths or finalizer.
Six source/input/staging checks and fourteen package-input tests are separate.
One historical producer helper compilation is counted once,302 to303; root
verification reuses the exact addon and107compiled non-system headers.

The normal0171zero-context patch composes over actual234canonical96488ce7,
retaining the key-generation class guard and TLS callback tickets. The new
canonical shell1851e370 and current core identities are recorded explicitly.
The reviewed integration tool applies seven owned files and imports both real
command receipts under their frozen source binding before Node-specific state
changes. Private preparation syntax/path-guard failures remain in the packet.

No guest C++ build, full rebuild or overall suite ran. All nineteen families
remain partial. Actual SSL_shutdown/close_notify/_final encrypted-output
ownership remains an implementation gap; the blocked shutdown proposal is not
applied. Socket inheritance/adoption, full public provider/resource shape,
init failure, GC/realm/Worker teardown and four-host conformance remain open.
