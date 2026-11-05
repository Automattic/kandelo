/* A native virtual object over a live store. No public JS Proxy or cached keys. */
#include "js/Class.h"
#include "js/Conversions.h"
#include "js/PropertyDescriptor.h"
#include "vm/NativeObject.h"
#include "vm/ObjectOperations-inl.h"
#include "vm/PropertyResult.h"
namespace {
static bool KandeloEnvCall(JSContext* cx, HandleObject object, const char* operation,
                            const JS::HandleValueArray& args, MutableHandleValue result) {
  RootedValue record(cx, JS::GetReservedSlot(object, 0));
  if (!record.isObject()) { JS_ReportErrorASCII(cx, "Environment owner is not initialized"); return false; }
  RootedObject callbacks(cx, &record.toObject()); RootedValue function(cx);
  if (!JS_GetProperty(cx, callbacks, operation, &function)) return false;
  return JS::Call(cx, UndefinedHandleValue, function, args, result);
}
static bool KandeloEnvKey(JSContext* cx, HandleId id, MutableHandleValue key) {
  if (!JS_IdToValue(cx, id, key)) return false;
  if (key.isNumber()) {
    RootedString string(cx, JS::ToString(cx, key)); if (!string) return false;
    key.setString(string);
  }
  return true;
}
static bool KandeloEnvOwn(JSContext* cx, HandleObject object, HandleId id,
                           MutableHandle<mozilla::Maybe<JS::PropertyDescriptor>> out) {
  RootedValue key(cx), result(cx);
  if (!KandeloEnvKey(cx, id, &key) ||
      !KandeloEnvCall(cx, object, "descriptor", JS::HandleValueArray(key), &result)) return false;
  if (result.isUndefined()) { out.set(mozilla::Nothing()); return true; }
  Rooted<JS::PropertyDescriptor> descriptor(cx);
  if (!JS::ToCompletePropertyDescriptor(cx, result, &descriptor)) return false;
  out.set(mozilla::Some(descriptor.get())); return true;
}
static bool KandeloEnvLookup(JSContext* cx, HandleObject object, HandleId id,
                              MutableHandleObject holder, js::PropertyResult* property) {
  Rooted<mozilla::Maybe<JS::PropertyDescriptor>> own(cx);
  if (!KandeloEnvOwn(cx, object, id, &own)) return false;
  if (own.isSome()) { holder.set(object); property->setProxyProperty(); return true; }
  RootedObject prototype(cx);
  if (!js::GetPrototype(cx, object, &prototype)) return false;
  if (prototype) return js::LookupProperty(cx, prototype, id, holder, property);
  holder.set(nullptr); property->setNotFound(); return true;
}
static bool KandeloEnvHas(JSContext* cx, HandleObject object, HandleId id, bool* found) {
  RootedObject holder(cx); js::PropertyResult property;
  if (!KandeloEnvLookup(cx, object, id, &holder, &property)) return false;
  *found = property.isFound(); return true;
}
static bool KandeloEnvGet(JSContext* cx, HandleObject object, HandleValue receiver,
                           HandleId id, MutableHandleValue value) {
  RootedValue key(cx);
  if (!KandeloEnvKey(cx, id, &key) ||
      !KandeloEnvCall(cx, object, "get", JS::HandleValueArray(key), value)) return false;
  // The target's getter intercepts symbols even when a prototype has that key.
  if (!value.isUndefined() || id.isSymbol()) return true;
  RootedObject prototype(cx);
  if (!js::GetPrototype(cx, object, &prototype)) return false;
  return !prototype || js::GetProperty(cx, prototype, receiver, id, value);
}
static bool KandeloEnvSet(JSContext* cx, HandleObject object, HandleId id,
                           HandleValue value, HandleValue receiver, JS::ObjectOpResult& result) {
  if (!receiver.isObject() || &receiver.toObject() != object) {
    // Ordinary inherited writes define on their real receiver; they do not
    // mutate the external store. Reuse the engine's existing set algorithm.
    Rooted<mozilla::Maybe<JS::PropertyDescriptor>> own(cx);
    if (!KandeloEnvOwn(cx, object, id, &own)) return false;
    if (own.isNothing()) {
      RootedObject prototype(cx);
      if (!js::GetPrototype(cx, object, &prototype)) return false;
      if (prototype) return js::SetProperty(cx, prototype, id, value, receiver, result);
    }
    return js::SetPropertyByDefining(cx, id, value, receiver, result);
  }
  JS::RootedValueArray<2> args(cx); RootedValue output(cx);
  if (!KandeloEnvKey(cx, id, args[0])) return false;
  args[1].set(value);
  if (!KandeloEnvCall(cx, object, "set", args, &output)) return false;
  return result.succeed();
}
static bool KandeloEnvDefine(JSContext* cx, HandleObject object, HandleId id,
                              Handle<JS::PropertyDescriptor> descriptor, JS::ObjectOpResult& result) {
  JS::RootedValueArray<2> args(cx); RootedValue output(cx);
  Rooted<mozilla::Maybe<JS::PropertyDescriptor>> maybe(cx, mozilla::Some(descriptor.get()));
  if (!KandeloEnvKey(cx, id, args[0]) || !JS::FromPropertyDescriptor(cx, maybe, args[1]) ||
      !KandeloEnvCall(cx, object, "define", args, &output)) return false;
  return result.succeed();
}
static bool KandeloEnvDelete(JSContext* cx, HandleObject object, HandleId id, JS::ObjectOpResult& result) {
  RootedValue key(cx), output(cx);
  if (!KandeloEnvKey(cx, id, &key) ||
      !KandeloEnvCall(cx, object, "remove", JS::HandleValueArray(key), &output)) return false;
  return result.succeed();
}
static bool KandeloEnvEnumerate(JSContext* cx, HandleObject object, MutableHandleIdVector properties, bool) {
  RootedValue keys(cx);
  if (!KandeloEnvCall(cx, object, "keys", JS::HandleValueArray::empty(), &keys) || !keys.isObject()) return false;
  RootedObject array(cx, &keys.toObject()); uint32_t length;
  if (!JS::GetArrayLength(cx, array, &length)) return false;
  for (uint32_t i = 0; i < length; ++i) {
    RootedValue key(cx); RootedId id(cx);
    if (!JS_GetElement(cx, array, i, &key) || !JS_ValueToId(cx, key, &id) || !properties.append(id)) return false;
  }
  return true;
}
static const js::ObjectOps KandeloEnvObjectOps = {
  KandeloEnvLookup, KandeloEnvDefine, KandeloEnvHas, KandeloEnvGet, KandeloEnvSet,
  KandeloEnvOwn, KandeloEnvDelete, nullptr, nullptr };
static const JSClassOps KandeloEnvClassOps = {
  nullptr, nullptr, nullptr, KandeloEnvEnumerate, nullptr, nullptr, nullptr, nullptr, nullptr, nullptr };
// Live externally-backed properties are Object-valued but cannot commit a
// fixed own-key set: the process store can change independently at any time.
static const js::ClassExtension KandeloEnvExtension = { nullptr, true, false };
static const JSClass KandeloEnvClass = { "Object", JSCLASS_HAS_RESERVED_SLOTS(1),
  &KandeloEnvClassOps, nullptr, &KandeloEnvExtension, &KandeloEnvObjectOps };
static bool KandeloNativeCreateEnvironmentObject(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject() || !args.get(1).isObject()) {
    JS_ReportErrorASCII(cx, "Environment requires its live-store callbacks and prototype"); return false;
  }
  RootedObject record(cx, &args[0].toObject()), prototype(cx, &args[1].toObject());
  RootedObject object(cx, JS_NewObjectWithGivenProto(cx, &KandeloEnvClass, prototype)); if (!object) return false;
  JS::SetReservedSlot(object, 0, ObjectValue(*record));
  args.rval().setObject(*object); return true;
}
}  // namespace
