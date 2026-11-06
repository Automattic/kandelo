/* Shared native lazy DATA property bridge. The property model, GC cell,
 * publication and IC invalidation belong to the engine owner. This bridge does
 * not install an accessor, proxy, public sentinel or outer-host Node object.
 * Private attributes mask: configurable=1, enumerable=2, writable=4.
 */
#include "js/CallAndConstruct.h"
#include "js/Class.h"
#include "js/NativeLazyDataProperty.h"
#include "js/Object.h"

namespace {
static const JSClass kandeloLazyAdapterClass = {
    "KandeloLazyAdapter", JSCLASS_HAS_RESERVED_SLOTS(2)};

static bool KandeloCallLazyDataLoader(JSContext* cx, HandleObject holder,
                                      HandleId key, HandleValue data,
                                      MutableHandleValue result) {
  RootedObject record(cx, &data.toObject());
  RootedValue loader(cx, JS::GetReservedSlot(record, 0));
  RootedValue thisValue(cx, ObjectValue(*holder));
  JS::RootedValueArray<2> args(cx);
  args[0].set(JS::GetReservedSlot(record, 1));
  if (!JS_IdToValue(cx, key, args[1])) return false;
  return JS::Call(cx, thisValue, loader, args, result);
}

static bool KandeloNativeDefineLazyDataProperty(JSContext* cx, unsigned argc,
                                               Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (argc < 5 || !args[0].isObject() ||
      (!args[1].isString() && !args[1].isSymbol()) ||
      !args[2].isObject() || !args.get(4).isInt32() ||
      args[4].toInt32() < 0 || args[4].toInt32() > 7) {
    JS_ReportErrorASCII(cx, "Invalid private native lazy data property arguments");
    return false;
  }
  RootedObject holder(cx, &args[0].toObject());
  RootedObject loader(cx, &args[2].toObject());
  RootedId key(cx);
  if (!JS_ValueToId(cx, args[1], &key)) return false;
  const int32_t mask = args[4].toInt32();
  JS::PropertyAttributes attributes{};
  if (mask & 1) attributes += JS::PropertyAttribute::Configurable;
  if (mask & 2) attributes += JS::PropertyAttribute::Enumerable;
  if (mask & 4) attributes += JS::PropertyAttribute::Writable;
  if (!JS::IsCallable(loader)) {
    JS_ReportErrorASCII(cx, "Private native lazy loader must be callable");
    return false;
  }
  RootedObject record(cx, JS_NewObject(cx, &kandeloLazyAdapterClass));
  if (!record) return false;
  JS::SetReservedSlot(record, 0, args[2]);
  JS::SetReservedSlot(record, 1, args[3]);
  RootedValue payload(cx, ObjectValue(*record));
  if (!JS::DefineNativeLazyDataProperty(cx, holder, key,
                                        KandeloCallLazyDataLoader, payload,
                                        attributes)) return false;
  args.rval().setUndefined();
  return true;
}
}  // namespace
