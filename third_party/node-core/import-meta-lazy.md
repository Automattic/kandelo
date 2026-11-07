# File import metadata native lazy data ownership

The native ModuleLoader metadata hook passes its actual newly created
import.meta object to the shared initializer. Returning that same object means
publication already happened; the native bridge does not read/copy path fields
and prematurely materialize their native lazy DATA cells. Legacy helper records
and shell fallback remain supported. Original exception and rooted metadata
ownership are retained; the new bridge is source-only/uncompiled so far.

For file URLs, dirname/filename are real configurable/enumerable/writable native
lazy DATA properties through existing DefineNativeLazyDataProperty. The loader
captures the actual canonical URL on a private genuine branded URL instance,
using captured real getters/conversion. Immutable own fields prevent later
public URL getter/legacy-admission pollution from changing that private input.
Path access uses the pinned C++ PathHelpersLazyGetter algorithm, including an
empty dirname for file:///entry.mjs and file:///. Public meta.url writes do not
change captured authority. Assignment/deletion/inherited access/integrity and
materialization belong to the actual native lazy-property owner, not an accessor
or copied lazy-looking field.

The existing non-Node require extension still eagerly constructs its genuine
CJS require owner, using its independent captured path conversion. That does not
materialize either path DATA cell; focused accounting distinguishes the one
extension conversion from subsequent first property loads. Native resolve
remains its existing separate hook. import.meta.main/isMain/default resolver
lazy identity/options/hooks and complete key-order policy remain explicit gaps.
Only dirname/filename/url relative order is covered; full metadata is incomplete.

Focused native controls use actual native ModuleWrap metadata through genuine
registerHooks resolve/load and an already-built native V8 lazy DATA owner. They
execute the actual production JS initializer installation, not the new guest
C++bridge; real URL/require/realm/property owners are dependencies, not four-host
proof.17groups match vs14/17original; extra first-materialization assertions pass.
No guest runtime/fullbuild/overall suite or new helper/compiler run occurred.
Source-map/cache/stack support remains an independent implementation prerequisite.
