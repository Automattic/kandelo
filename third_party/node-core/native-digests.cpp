/* Owned synchronous libcrypto consumers; included after existing byte helpers. */
#include "kandelo-node-digest-operations.h"
namespace {
static bool KandeloNativeOpenSSLVersion(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedString version(cx, JS_NewStringCopyZ(cx, kandelo::crypto::OpenSSLVersion()));
  if (!version) return false;
  args.rval().setString(version); return true;
}
static bool KandeloCryptoSpan(JSContext* cx, HandleValue input, SharedMem<uint8_t*>* data, size_t* length) {
  if (!input.isObject()) return false;
  RootedObject object(cx, &input.toObject());
  return IsBufferSource(cx, object, /*allowShared*/ true, /*allowResizable*/ true, data, length);
}
static void KandeloCryptoCopy(SharedMem<uint8_t*> source, size_t length, kandelo::crypto::Bytes* bytes) {
  bytes->value.resize(length);
  // Shared JS bytes may change concurrently. Capture with real relaxed atomic
  // byte loads rather than racing native memcpy; no guest pointer survives.
  for (size_t i = 0; i < length; i++) bytes->value[i] = __atomic_load_n(source.unwrap() + i, __ATOMIC_RELAXED);
}
static bool KandeloCryptoInput(JSContext* cx, HandleValue input, kandelo::crypto::Bytes* bytes) {
  if (input.isString()) {
    RootedString text(cx, input.toString());
    JSLinearString* linear = JS_EnsureLinearString(cx, text); if (!linear) return false;
    const size_t length = JS::GetDeflatedUTF8StringLength(linear);
    if (length == SIZE_MAX) { JS_ReportOutOfMemory(cx); return false; }
    bytes->value.resize(length);
    JS::AutoCheckCannotGC nogc;
    if (length) JS::DeflateStringToUTF8Buffer(linear,
        mozilla::Span<char>(reinterpret_cast<char*>(bytes->value.data()), length));
    return true;
  }
  SharedMem<uint8_t*> data; size_t length;
  JS::AutoCheckCannotGC nogc;
  if (!KandeloCryptoSpan(cx, input, &data, &length)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Crypto input requires a real buffer source");
    return false;
  }
  KandeloCryptoCopy(data, length, bytes); return true;
}
static bool KandeloDigestError(JSContext* cx, const kandelo::crypto::Error& failure, MutableHandleValue value) {
  RootedObject object(cx, JS_NewPlainObject(cx));
  if (!object) return false;
  auto property = [&](const char* name, const char* bytes) {
    RootedValue text(cx);
    return KandeloFsPathString(cx, bytes, strlen(bytes), &text) &&
        JS_DefineProperty(cx, object, name, text, JSPROP_ENUMERATE);
  };
  if (!property("message", failure.what())) return false;
  if (!failure.library.empty() && !property("library", failure.library.c_str())) return false;
  if (!failure.reason.empty() && !property("reason", failure.reason.c_str())) return false;
  if (!failure.code.empty() && !property("code", failure.code.c_str())) return false;
  if (!failure.stack.empty()) {
    RootedObject stack(cx, JS::NewArrayObject(cx, 0));
    if (!stack) return false;
    for (size_t i = 0; i < failure.stack.size(); i++) {
      RootedValue text(cx);
      if (!KandeloFsPathString(cx, failure.stack[i].data(), failure.stack[i].size(), &text) ||
          !JS_SetElement(cx, stack, i, text)) return false;
    }
    RootedValue stackValue(cx, ObjectValue(*stack));
    if (!JS_DefineProperty(cx, object, "opensslErrorStack", stackValue, JSPROP_ENUMERATE)) return false;
  }
  value.setObject(*object); return true;
}
static bool KandeloNativeOneShotDigest(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isString() || !args.get(3).isBoolean()) {
    JS_ReportErrorASCII(cx, "Digest requires an algorithm and options flag"); return false;
  }
  RootedString name(cx, args[0].toString());
  JS::UniqueChars algorithm = JS_EncodeStringToUTF8(cx, name); if (!algorithm) return false;
  std::optional<uint32_t> length;
  if (!args.get(2).isUndefined()) {
    if (!args[2].isNumber() || !std::isfinite(args[2].toNumber()) ||
        args[2].toNumber() < 0 || args[2].toNumber() > UINT32_MAX || std::floor(args[2].toNumber()) != args[2].toNumber()) {
      JS_ReportErrorASCII(cx, "Invalid digest length"); return false;
    }
    length = uint32_t(args[2].toNumber());
  }
  kandelo::crypto::Bytes input;
  if (!KandeloCryptoInput(cx, args.get(1), &input)) return false;
  try {
    auto bytes = kandelo::crypto::Digest(algorithm.get(), input, length, args[3].toBoolean());
    RootedObject output(cx, KandeloNewUint8ArrayCopy(cx, bytes.value.data(), bytes.value.size()));
    if (!output) return false;
    args.rval().setObject(*output); return true;
  } catch (const kandelo::crypto::Error& error) { return KandeloDigestError(cx, error, args.rval()); }
}
static bool KandeloNativeDigestNames(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto names = kandelo::crypto::DigestNames();
  RootedObject result(cx, JS::NewArrayObject(cx, 0)); if (!result) return false;
  for (size_t i = 0; i < names.size(); i++) {
    RootedString name(cx, JS_NewStringCopyZ(cx, names[i].c_str())); if (!name) return false;
    RootedValue value(cx, StringValue(name)); if (!JS_SetElement(cx, result, i, value)) return false;
  }
  args.rval().setObject(*result); return true;
}
static bool KandeloNativeTimingSafeEqual(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); kandelo::crypto::Bytes a, b;
  SharedMem<uint8_t*> first, second; size_t aSize, bSize;
  {
    JS::AutoCheckCannotGC nogc;
    if (!KandeloCryptoSpan(cx, args.get(0), &first, &aSize)) {
      if (JS_IsExceptionPending(cx)) return false;
      args.rval().setInt32(1); return true;
    }
    if (!KandeloCryptoSpan(cx, args.get(1), &second, &bSize)) {
      if (JS_IsExceptionPending(cx)) return false;
      args.rval().setInt32(2); return true;
    }
    if (aSize != bSize) { args.rval().setInt32(3); return true; }
    KandeloCryptoCopy(first, aSize, &a); KandeloCryptoCopy(second, bSize, &b);
  }
  args.rval().setBoolean(kandelo::crypto::Equal(a, b)); return true;
}
template <bool (*Callback)(JSContext*, unsigned, Value*)>
static bool KandeloCryptoGuard(JSContext* cx, unsigned argc, Value* vp) {
  try { return Callback(cx, argc, vp); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  catch (const std::length_error&) { JS_ReportOutOfMemory(cx); return false; }
  catch (...) { JS_ReportErrorASCII(cx, "Unexpected native crypto failure"); return false; }
}
}  // namespace
