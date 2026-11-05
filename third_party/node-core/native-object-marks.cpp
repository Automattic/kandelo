/* Public object marks use a traced weak engine registry, never JS properties. */
#include <cstring>
#include "js/ErrorReport.h"
#include "js/Proxy.h"
namespace {
static const JSErrorFormatString* KandeloProxyMarkError(void*, unsigned) {
  static const JSErrorFormatString error = { "KandeloProxyPrivate",
      "Cannot pass private property name to proxy trap", 0, JSEXN_TYPEERR };
  return &error;
}
static bool KandeloNativeObjectMark(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "Object mark requires an operation"); return false; }
  RootedString name(cx, args[0].toString());
  JS::UniqueChars operation = JS_EncodeStringToUTF8(cx, name); if (!operation) return false;
  const bool check = std::strcmp(operation.get(), "markedTransfer") == 0;
  const bool clone = std::strcmp(operation.get(), "clone") == 0;
  if (!check && !clone && std::strcmp(operation.get(), "transfer") != 0) {
    JS_ReportErrorASCII(cx, "Unknown object mark operation"); return false;
  }
  if (!args.get(1).isObject()) {
    if (check) args.rval().setBoolean(false); else args.rval().setUndefined();
    return true;
  }
  RootedObject object(cx, js::CheckedUnwrapDynamic(&args[1].toObject(), cx));
  if (!object) return false;
  if (js::IsScriptedProxy(object)) {
    if (check) { args.rval().setBoolean(false); return true; }
    // The target's JS assignment of an internal private key is rejected by
    // V8 before invoking any proxy trap, including on a revoked proxy.
    JS_ReportErrorNumberASCII(cx, KandeloProxyMarkError, nullptr, 0);
    return false;
  }
  uint32_t marks;
  if (!cx->getKandeloObjectMarks(object, &marks)) return false;
  if (check) { args.rval().setBoolean(marks & JSContext::KandeloUntransferable); return true; }
  marks |= clone ? JSContext::KandeloUncloneable : JSContext::KandeloUntransferable;
  if (!cx->setKandeloObjectMarks(object, marks)) return false;
  args.rval().setUndefined(); return true;
}
}  // namespace
