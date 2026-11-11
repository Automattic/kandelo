#include "shell/node-upstream/buffer-memory.h"

#include "jsapi.h"

#include "js/ArrayBuffer.h"
#include "js/CallArgs.h"
#include "js/Equality.h"
#include "js/friend/ErrorMessages.h"
#include "js/PropertyAndElement.h"
#include "js/PropertySpec.h"
#include "js/Realm.h"
#include "js/RootingAPI.h"
#include "js/Wrapper.h"
#include "vm/ArrayBufferObject.h"

#include "vm/NativeObject-inl.h"

namespace kandelo::node {
namespace {
js::ArrayBufferObject* Buffer(JSContext* cx, JS::HandleObject input) {
  JSObject* object = js::CheckedUnwrapDynamic(input, cx, false);
  if (!object || !object->is<js::ArrayBufferObject>()) {
    JS_ReportErrorASCII(cx, "Native buffer memory control requires an ArrayBuffer");
    return nullptr;
  }
  return &object->as<js::ArrayBufferObject>();
}

bool KeyControl(JSContext* cx, unsigned argc, JS::Value* vp, bool detach) {
  auto args = JS::CallArgsFromVp(argc, vp);
  if (argc != 2 || !args[0].isObject()) {
    JS_ReportErrorASCII(cx, "Native buffer memory control requires a buffer and key");
    return false;
  }
  JS::RootedObject buffer(cx, &args[0].toObject());
  JS::RootedValue key(cx, args[1]);
  if (!(detach ? DetachBufferWithKey(cx, buffer, key)
               : SetBufferDetachKey(cx, buffer, key))) return false;
  args.rval().setUndefined();
  return true;
}
bool SetKeyControl(JSContext* cx, unsigned argc, JS::Value* vp) {
  return KeyControl(cx, argc, vp, false);
}
bool DetachControl(JSContext* cx, unsigned argc, JS::Value* vp) {
  return KeyControl(cx, argc, vp, true);
}
}

bool SetBufferDetachKey(JSContext* cx, JS::HandleObject input,
                        JS::HandleValue key) {
  JS::Rooted<js::ArrayBufferObject*> buffer(cx, Buffer(cx, input));
  if (!buffer) return false;
  JSAutoRealm home(cx, buffer);
  JS::RootedValue wrapped(cx, key);
  if (!JS_WrapValue(cx, &wrapped)) return false;
  // Native reserved storage is traced and cannot be shadowed by a JavaScript
  // property, a proxy trap, or a frozen object's ordinary property policy.
  buffer->setKandeloDetachKey(wrapped);
  return true;
}

bool DetachBufferWithKey(JSContext* cx, JS::HandleObject input,
                         JS::HandleValue key) {
  JS::Rooted<js::ArrayBufferObject*> buffer(cx, Buffer(cx, input));
  if (!buffer) return false;
  JSAutoRealm home(cx, buffer);
  JS::RootedValue wrapped(cx, key), stored(cx, buffer->kandeloDetachKey());
  if (!JS_WrapValue(cx, &wrapped)) return false;
  bool same;
  if (!JS::SameValue(cx, stored, wrapped, &same)) return false;
  if (!same) {
    JS_ReportErrorNumberASCII(cx, js::GetErrorMessage, nullptr,
                              JSMSG_ARRAYBUFFER_DETACH_KEY);
    return false;
  }
  if (buffer->isWasm() || buffer->isPreparedForAsmJS()) {
    JS_ReportErrorNumberASCII(cx, js::GetErrorMessage, nullptr,
                              JSMSG_WASM_NO_TRANSFER);
    return false;
  }
  if (buffer->isLengthPinned()) {
    JS_ReportErrorNumberASCII(cx, js::GetErrorMessage, nullptr,
                              JSMSG_ARRAYBUFFER_LENGTH_PINNED);
    return false;
  }
  // The ordinary JSAPI intentionally rejects every defined key. Only this
  // embedding entry, after the actual SameValue check, may authorize detach.
  js::ArrayBufferObject::detach(cx, buffer);
  return true;
}

bool DefineBufferMemoryTestAPI(JSContext* cx, JS::HandleObject api) {
  static const JSFunctionSpec controls[] = {
      JS_FN("setBufferDetachKey", SetKeyControl, 2, 0),
      JS_FN("detachBufferWithKey", DetachControl, 2, 0),
      JS_FS_END,
  };
  return JS_DefineFunctions(cx, api, controls);
}
}
