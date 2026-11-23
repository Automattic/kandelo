#ifndef KANDELO_ENGINE_CONSTRUCTOR_NAMES_INL_H
#define KANDELO_ENGINE_CONSTRUCTOR_NAMES_INL_H

// Adapter naming policy lives here. Private SpiderMonkey Realm/JSFunction/
// NativeObject operations stay behind the bridge. Construction events stay
// in the engine; bridge metadata owns the weak history table.
namespace constructor_names {
using namespace JS;
using namespace js;
namespace {
// Read an existing native data slot only: no resolving, getters or proxy traps.
void ConstructorData(JSObject* obj, jsid id, MutableHandleValue value) {
  value.setUndefined();
  if (!obj->is<js::NativeObject>()) {
    return;
  }
  auto& native = obj->as<js::NativeObject>();
  auto property = native.lookupPure(id);
  if (property && property->isDataProperty()) {
    value.set(native.getSlot(property->slot()));
  }
}

bool ConstructorFunctionName(JSContext* cx, HandleObject object,
                              bool ownName, MutableHandleString name) {
  name.set(nullptr);
  if (!object->is<JSFunction>()) {
    return true;
  }
  AutoRealm home(cx, object);
  if (ownName) {
    RootedValue value(cx);
    ConstructorData(object, NameToId(cx->names().name), &value);
    if (value.isString()) {
      name.set(value.toString());
      return true;
    }
  }
  auto& function = object->as<JSFunction>();
  if (function.hasGuessedAtom()) {
    return true;
  }
  Rooted<JSAtom*> atom(cx);
  if (!function.getDisplayAtom(cx, &atom)) {
    return false;
  }
  name.set(atom);
  return true;
}

bool ConstructorNameUsable(JSContext* cx, HandleString name, bool* usable) {
  *usable = false;
  if (!name || !name->length()) {
    return true;
  }
  bool objectName;
  if (!JS_StringEqualsAscii(cx, name, "Object", &objectName)) {
    return false;
  }
  *usable = !objectName;
  return true;
}

JSProtoKey ConstructorIntrinsicKey(JSObject* object) {
  JSProtoKey key = JSCLASS_CACHED_PROTO_KEY(object->getClass());
  if (object->is<JSFunction>()) {
    auto& function = object->as<JSFunction>();
    if (function.isGenerator()) {
      return function.isAsync() ? JSProto_AsyncGeneratorFunction
                                : JSProto_GeneratorFunction;
    }
    if (function.isAsync()) {
      return JSProto_AsyncFunction;
    }
    return JSProto_Function;
  }
  // This is an engine classification key without a constructor of its own.
  return key == JSProto_BoundFunction ? JSProto_Null : key;
}
}  // namespace

static JSString* GetNativeConstructorName(JSContext* cx, HandleObject receiver) {
  if (receiver->is<ProxyObject>()) {
    return cx->names().Object;
  }
  AutoRealm home(cx, receiver);
  RootedObject constructor(cx);
  RootedString name(cx);
  bool usable;
  if (!receiver->isUsedAsPrototype() &&
      !bridge::WasPrototypeConstruction(receiver)) {
    constructor = bridge::OriginalConstructor(receiver);
    if (!constructor) {
      JSProtoKey key = ConstructorIntrinsicKey(receiver);
      if (key != JSProto_Null) {
        constructor = receiver->nonCCWRealm()->maybeGlobal()->maybeGetConstructor(key);
      }
    }
    if (constructor) {
      if (!ConstructorFunctionName(cx, constructor, true, &name) ||
          !ConstructorNameUsable(cx, name, &usable)) {
        return nullptr;
      }
      if (usable) {
        return name;
      }
    }
  }

  RootedId tag(cx, PropertyKey::Symbol(
                       JS::GetWellKnownSymbol(cx, JS::SymbolCode::toStringTag)));
  RootedId constructorKey(cx, NameToId(cx->names().constructor));
  RootedObject current(cx, receiver);
  RootedValue value(cx);
  while (current) {
    if (IsWrapper(current)) {
      current = CheckedUnwrapDynamic(current, cx, false);
      if (!current) {
        if (!cx->isExceptionPending()) {
          ReportAccessDenied(cx);
        }
        return nullptr;
      }
    }
    if (current->is<ProxyObject>()) {
      break;
    }
    ConstructorData(current, tag, &value);
    if (value.isString()) {
      return value.toString();
    }
    if (current != receiver) {
      ConstructorData(current, constructorKey, &value);
      if (value.isObject() && value.toObject().is<JSFunction>()) {
        constructor = &value.toObject();
        if (!ConstructorFunctionName(cx, constructor, false, &name) ||
            !ConstructorNameUsable(cx, name, &usable)) {
          return nullptr;
        }
        if (usable) {
          return name;
        }
      }
    }
    current = current->staticPrototype();
  }
  if (JSCLASS_CACHED_PROTO_KEY(receiver->getClass()) == JSProto_BoundFunction) {
    return cx->names().Function;
  }
  return JS_NewStringCopyZ(cx, receiver->getClass()->name);
}

}  // namespace constructor_names

#endif
