#include "shell/node-upstream/types.h"

#include "mozilla/Assertions.h"

#include "jsapi.h"
#include "jsfriendapi.h"
#include "node-types.generated.h"

#include "builtin/BigInt.h"
#include "builtin/MapObject.h"
#include "builtin/ModuleObject.h"
#include "builtin/Symbol.h"
#include "builtin/WeakMapObject.h"
#include "builtin/WeakSetObject.h"
#include "js/CallArgs.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/Proxy.h"
#include "js/Wrapper.h"
#include "shell/node-upstream/realm.h"
#include "vm/ArgumentsObject.h"
#include "vm/ArrayBufferObject.h"
#include "vm/BooleanObject.h"
#include "vm/DateObject.h"
#include "vm/ErrorObject.h"
#include "vm/GeneratorObject.h"
#include "vm/JSFunction.h"
#include "vm/NumberObject.h"
#include "vm/PromiseObject.h"
#include "vm/RegExpObject.h"
#include "vm/SharedArrayObject.h"
#include "vm/StringObject.h"

namespace kandelo::node {
namespace {
const JSClass kExternal = {"NodeExternal", JSCLASS_HAS_RESERVED_SLOTS(1)};
#define ENUM(name, property) name,
enum Predicate { KANDELO_NODE_TYPE_METHODS(ENUM) };
#undef ENUM
JSObject* Raw(JSContext* cx, JS::HandleObject value) {
  // Only engine/security wrappers are transparent. Scripted/revoked proxies
  // remain proxies and must never invoke traps or classify as their targets.
  JSObject* object = js::CheckedUnwrapDynamic(value, cx, false);
  if (!object && !JS_IsExceptionPending(cx))
    JS_ReportErrorASCII(cx, "Native type inspection access denied");
  return object;
}
bool Matches(JSObject* object, Predicate type) {
  switch (type) {
    case ArgumentsObject: return object->is<js::ArgumentsObject>();
    case ArrayBuffer: return object->is<js::ArrayBufferObject>();
    case AsyncFunction: return object->is<JSFunction>() && object->as<JSFunction>().isAsync();
    case BigIntObject: return object->is<js::BigIntObject>();
    case BooleanObject: return object->is<js::BooleanObject>();
    case Date: return object->is<js::DateObject>();
    case External: return JS::GetClass(object) == &kExternal;
    case GeneratorFunction: return object->is<JSFunction>() && object->as<JSFunction>().isGenerator();
    case GeneratorObject: return object->is<js::AbstractGeneratorObject>();
    case Map: return object->is<js::MapObject>();
    case MapIterator: return object->is<js::MapIteratorObject>();
    case ModuleNamespaceObject: return object->is<js::ModuleNamespaceObject>();
    case NativeError: return object->is<js::ErrorObject>();
    case NumberObject: return object->is<js::NumberObject>();
    case Promise: return object->is<js::PromiseObject>();
    case Proxy: return js::IsScriptedProxy(object);
    case RegExp: return object->is<js::RegExpObject>();
    case Set: return object->is<js::SetObject>();
    case SetIterator: return object->is<js::SetIteratorObject>();
    case SharedArrayBuffer: return object->is<js::SharedArrayBufferObject>();
    case StringObject: return object->is<js::StringObject>();
    case SymbolObject: return object->is<js::SymbolObject>();
    case WeakMap: return object->is<js::WeakMapObject>();
    case WeakSet: return object->is<js::WeakSetObject>();
    case AnyArrayBuffer: return object->is<js::ArrayBufferObject>() || object->is<js::SharedArrayBufferObject>();
    case BoxedPrimitive: return object->is<js::NumberObject>() || object->is<js::StringObject>() ||
        object->is<js::BooleanObject>() || object->is<js::BigIntObject>() || object->is<js::SymbolObject>();
  }
  MOZ_CRASH("Unreviewed Node native predicate");
}
bool Inspect(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject owner(cx, &js::GetFunctionNativeReserved(&args.callee(), 0).toObject());
  if (!CheckRealmLibraryActive(cx, owner)) return false;
  auto type = Predicate(js::GetFunctionNativeReserved(&args.callee(), 1).toInt32());
  bool result = false;
  if (args.get(0).isObject()) {
    JS::RootedObject input(cx, &args[0].toObject()), object(cx, Raw(cx, input));
    if (!object) return false;
    result = Matches(object, type);
  }
  args.rval().setBoolean(result); return true;
}
}
JSObject* CreateTypesBinding(JSContext* cx, JS::HandleObject realm) {
  JS::RootedObject binding(cx, JS_NewPlainObject(cx)); if (!binding) return nullptr;
  struct Method { Predicate type; const char* name; };
#define METHOD(name, property) {name, property},
  static constexpr Method methods[] = {KANDELO_NODE_TYPE_METHODS(METHOD)};
#undef METHOD
  for (const auto& method : methods) {
    // Pinned SetFastMethodNoSideEffect publishes anonymous functions, length0.
    JS::RootedFunction function(cx, js::NewFunctionWithReserved(cx, Inspect, 0, 0, ""));
    if (!function) return nullptr;
    JS::RootedObject object(cx, JS_GetFunctionObject(function));
    js::SetFunctionNativeReserved(object, 0, JS::ObjectValue(*realm));
    js::SetFunctionNativeReserved(object, 1, JS::Int32Value(method.type));
    if (!JS_DefineProperty(cx, binding, method.name, object, JSPROP_ENUMERATE)) return nullptr;
  }
  return binding;
}
JSObject* CreateExternalPointer(JSContext* cx, void* payload) {
  JS::RootedObject prototype(cx), object(cx, JS_NewObjectWithGivenProto(cx, &kExternal, prototype));
  if (!object) return nullptr;
  JS::SetReservedSlot(object, 0, JS::PrivateValue(payload));
  JS::ObjectOpResult result;
  if (!JS_PreventExtensions(cx, object, result) ||
      !result.checkStrict(cx, object)) return nullptr;
  return object;
}
bool GetExternalPointer(JSContext* cx, JS::HandleObject value, void** payload) {
  JS::RootedObject object(cx, Raw(cx, value)); if (!object) return false;
  if (JS::GetClass(object) != &kExternal) {
    JS_ReportErrorASCII(cx, "Expected an actual native External value"); return false;
  }
  *payload = JS::GetReservedSlot(object, 0).toPrivate(); return true;
}
}
