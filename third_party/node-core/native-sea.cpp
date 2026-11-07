/* Genuine compiled-image resource fuse. No SEA asset provider exists yet. */
#include "kandelo-node-sea-image-profile.h"
namespace {
static bool KandeloNativeSeaIsSea(JSContext*, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  args.rval().setBoolean(kandelo::sea::IsSingleExecutable());
  return true;
}
static bool KandeloNativeSeaBinding(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedObject binding(cx, JS_NewPlainObject(cx));
  static const JSFunctionSpec methods[] = {
      JS_FN("isSea", KandeloNativeSeaIsSea, 0, 0), JS_FS_END};
  if (!binding || !JS_DefineFunctions(cx, binding, methods)) return false;
  // There are deliberately no asset callbacks/table. The ordinary public
  // algorithm raises its exact non-SEA error before those missing owners.
  args.rval().setObject(*binding);
  return true;
}
}  // namespace
