// Public DynamicLibrary's real guest dlopen/dlsym/dlclose owner. No CPU-host
// FFI, function-call substitution or address-shaped event-loop placeholder.
#include "kandelo-node-ffi-library-owner.h"
#include "js/BigInt.h"
#include "js/Stack.h"
#include "js/Symbol.h"
#include "js/Wrapper.h"
#include <new>

namespace js::shell {
struct KandeloFfiRegistry {
  kandelo::ffi::Environment environment;
};
}  // namespace js::shell
namespace {
using FfiLibrary = std::shared_ptr<kandelo::ffi::Library>;
static bool KandeloFfiRaise(JSContext* cx, const kandelo::ffi::Error& error) {
  if (JS_IsExceptionPending(cx)) return false;
  const JSExnType type = !strcmp(error.code, "ERR_INVALID_ARG_TYPE") ||
      !strcmp(error.code, "ERR_CONSTRUCT_CALL_REQUIRED") ||
      !strcmp(error.code, "ERR_INVALID_ARG_VALUE") ? JSEXN_TYPEERR : JSEXN_ERR;
  RootedString message(cx, JS_NewStringCopyUTF8Z(cx,
      JS::ConstUTF8CharsZ(error.what(), strlen(error.what()))));
  RootedString file(cx, JS_GetEmptyString(cx));
  RootedObject stack(cx);
  RootedValue value(cx);
  if (!message || !JS::CaptureCurrentStack(cx, &stack) ||
      !JS::CreateError(cx, type, stack, file, 0, JS::ColumnNumberOneOrigin(1), nullptr,
                      message, JS::NothingHandleValue, &value)) return false;
  RootedObject object(cx, &value.toObject());
  RootedString code(cx, JS_NewStringCopyZ(cx, error.code));
  if (!code || !JS_DefineProperty(cx, object, "code", code, JSPROP_ENUMERATE)) return false;
  JS_SetPendingException(cx, value);
  return false;
}
template<class Function>
static bool KandeloFfiTry(JSContext* cx, Function&& function) {
  try { return function(); }
  catch (const kandelo::ffi::Error& error) { return KandeloFfiRaise(cx, error); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
static void KandeloFfiFinalize(JS::GCContext*, JSObject* object) {
  auto slot = JS::GetReservedSlot(object, 0);
  if (slot.isUndefined()) return;
  auto* owner = static_cast<FfiLibrary*>(slot.toPrivate());
  (*owner)->Finalized();
  delete owner;
}
static const JSClassOps KandeloFfiClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
  KandeloFfiFinalize, nullptr, nullptr, nullptr
};
static const JSClass KandeloFfiClass = {
  "DynamicLibrary", JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE,
  &KandeloFfiClassOps
};
static FfiLibrary* KandeloFfiThis(JSContext* cx, const CallArgs& args) {
  if (args.thisv().isObject()) {
    RootedObject object(cx, &args.thisv().toObject());
    JSObject* unwrapped = js::CheckedUnwrapDynamic(object, cx);
    if (!unwrapped) {
      // A denied security wrapper is not an incompatible public receiver.
      // Preserve an existing exception or report the actual access denial.
      if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);
      return nullptr;
    }
    if (unwrapped && JS::GetClass(unwrapped) == &KandeloFfiClass) {
      auto slot = JS::GetReservedSlot(unwrapped, 0);
      if (!slot.isUndefined()) return static_cast<FfiLibrary*>(slot.toPrivate());
    }
  }
  JS_ReportErrorNumberASCII(cx, GetErrorMessage, nullptr, JSMSG_INCOMPATIBLE_PROTO,
                            "DynamicLibrary", "method", "receiver");
  return nullptr;
}
static bool KandeloFfiString(JSContext* cx, HandleValue value, const char* label,
                             std::string* output) {
  if (!value.isString())
    throw kandelo::ffi::Error("ERR_INVALID_ARG_TYPE", std::string(label) + " must be a string");
  RootedString string(cx, value.toString());
  JS::UniqueChars utf8 = JS_EncodeStringToUTF8(cx, string);
  if (!utf8) return false;
  // strlen cannot detect an embedded NUL. Inspect original UTF-16 units first.
  for (size_t i = 0; i < JS_GetStringLength(string); ++i) {
    char16_t unit;
    if (!JS_GetStringCharAt(cx, string, i, &unit)) return false;
    if (unit == 0) throw kandelo::ffi::Error("ERR_INVALID_ARG_VALUE",
        std::string(label) + " must not contain null bytes");
  }
  *output = utf8.get();
  return true;
}
static bool KandeloFfiPath(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    auto* owner = KandeloFfiThis(cx, args); if (!owner) return false;
    const auto& path = (*owner)->Path();
    RootedString value(cx, JS_NewStringCopyUTF8N(cx, JS::UTF8Chars(path.data(), path.size())));
    if (!value) return false;
    args.rval().setString(value); return true;
  });
}
static bool KandeloFfiSymbols(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    auto* owner = KandeloFfiThis(cx, args); if (!owner) return false;
    const auto& symbols = (*owner)->Symbols();
    RootedObject result(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
    if (!result) return false;
    for (const auto& entry : symbols) {
      RootedString key(cx, JS_NewStringCopyUTF8N(cx, JS::UTF8Chars(entry.first.data(), entry.first.size())));
      RootedId id(cx);
      JS::BigInt* integer = JS::NumberToBigInt(cx, uint64_t(entry.second));
      if (!key || !integer) return false;
      RootedValue value(cx, JS::BigIntValue(integer));
      if (!JS_StringToId(cx, key, &id)) return false;
      if (!JS_DefinePropertyById(cx, result, id, value, JSPROP_ENUMERATE)) return false;
    }
    args.rval().setObject(*result); return true;
  });
}
static bool KandeloFfiSymbol(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    auto* owner = KandeloFfiThis(cx, args); if (!owner) return false;
    std::string name;
    if (!KandeloFfiString(cx, args.get(0), "Symbol name", &name)) return false;
    auto address = (*owner)->Symbol(name);
    JS::BigInt* value = JS::NumberToBigInt(cx, uint64_t(address));
    if (!value) return false;
    args.rval().setBigInt(value); return true;
  });
}
static bool KandeloFfiClose(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    auto* owner = KandeloFfiThis(cx, args); if (!owner) return false;
    (*owner)->Close(); args.rval().setUndefined(); return true;
  });
}
static bool KandeloFfiNew(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  return KandeloFfiTry(cx, [&] {
    if (!args.isConstructing()) throw kandelo::ffi::Error("ERR_CONSTRUCT_CALL_REQUIRED",
        "Class constructor DynamicLibrary cannot be invoked without 'new'");
    std::string path;
    if (!args.get(0).isNull()) {
      if (!args.get(0).isString()) throw kandelo::ffi::Error("ERR_INVALID_ARG_TYPE",
          "Library path must be a string or null");
      if (!KandeloFfiString(cx, args.get(0), "Library path", &path)) return false;
    }
    // Prototype getters, descriptor allocation and holder allocation precede
    // library admission. No throwing JS operation can orphan an opened image.
    RootedObject object(cx, JS_NewObjectForConstructor(cx, &KandeloFfiClass, args));
    if (!object || !JS_DefineProperty(cx, object, "path", KandeloFfiPath, nullptr,
          JSPROP_ENUMERATE | JSPROP_PERMANENT) ||
        !JS_DefineProperty(cx, object, "symbols", KandeloFfiSymbols, nullptr,
          JSPROP_ENUMERATE | JSPROP_PERMANENT)) return false;
    auto holder = std::make_unique<FfiLibrary>();
    auto* sc = GetShellContext(cx);
    if (!sc->kandeloFfi) sc->kandeloFfi = new KandeloFfiRegistry();
    *holder = sc->kandeloFfi->environment.Open(args.get(0).isNull() ? nullptr : path.c_str());
    JS::SetReservedSlot(object, 0, PrivateValue(holder.release()));
    args.rval().setObject(*object); return true;
  });
}
static bool KandeloDefineFfi(JSContext* cx, HandleObject native) {
  const JSFunctionSpec methods[] = {
    JS_FN("getSymbol", KandeloFfiSymbol, 0, JSPROP_ENUMERATE),
    JS_FN("getSymbols", KandeloFfiSymbols, 0, JSPROP_ENUMERATE),
    JS_FN("close", KandeloFfiClose, 0, JSPROP_ENUMERATE), JS_FS_END
  };
  RootedObject prototype(cx, JS_InitClass(cx, native, nullptr, &KandeloFfiClass,
      KandeloFfiNew, 0, nullptr, methods, nullptr, nullptr));
  if (!prototype) return false;
  RootedValue close(cx);
  RootedId dispose(cx, SYMBOL_TO_JSID(JS::GetWellKnownSymbol(cx, JS::SymbolCode::dispose)));
  return JS_GetProperty(cx, prototype, "close", &close) &&
      JS_DefinePropertyById(cx, prototype, dispose, close, JSPROP_ENUMERATE);
}
static bool KandeloDrainFfi(JSContext* cx) {
  auto* registry = GetShellContext(cx)->kandeloFfi;
  return !registry || KandeloFfiTry(cx, [&] { registry->environment.Drain(); return true; });
}
static bool KandeloShutdownFfi(ShellContext* sc) {
  auto* registry = std::exchange(sc->kandeloFfi, nullptr);
  if (!registry) return true;
  bool ok = true;
  try { registry->environment.Drain(true); }
  catch (const std::exception& error) {
    fprintf(stderr, "FFI environment shutdown: %s\n", error.what());
    if (!sc->exitCode) sc->exitCode = EXIT_FAILURE;
    ok = false;
  }
  delete registry;
  return ok;
}
}  // namespace
