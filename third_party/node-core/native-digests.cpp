/* Owned synchronous libcrypto consumers; included after existing byte helpers. */
#include "kandelo-node-digest-operations.h"
#include "kandelo-node-string-bytes.h"
#include "js/ArrayBuffer.h"
#include "js/Realm.h"
#include "js/SharedArrayBuffer.h"
#include "js/String.h"
#include "js/Wrapper.h"
#include "js/experimental/TypedData.h"
#include "js/experimental/KandeloBackingStore.h"
#include <utility>
namespace {
static bool KandeloNativeOpenSSLVersion(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedString version(cx, JS_NewStringCopyZ(cx, kandelo::crypto::OpenSSLVersion()));
  if (!version) return false;
  args.rval().setString(version); return true;
}
// A synchronous borrow roots the checked-unwrapped original storage. It does
// not externalize inline data or impose a length pin. Security/type admission
// happens before no-GC; pointer consumers cannot enter JS or retain the span.
class KandeloCryptoByteSource {
  enum class Kind { None, View, Buffer, Shared };
  JSContext* cx_;
  RootedObject owner_;
  Kind kind_ = Kind::None;
  size_t LengthInRealm() const {
    if (kind_ == Kind::View) return JS_GetArrayBufferViewByteLength(owner_);
    if (kind_ == Kind::Buffer) return JS::GetArrayBufferByteLength(owner_);
    return JS::GetSharedArrayBufferByteLength(owner_);
  }
 public:
  explicit KandeloCryptoByteSource(JSContext* cx) : cx_(cx), owner_(cx) {}
  bool Init(HandleValue input) {
    kind_ = Kind::None;owner_ = nullptr;
    if (!input.isObject()) return false;
    // Check using the caller's current authority before entering the owner
    // realm. Never use UncheckedUnwrap or invoke public getters/proxy traps.
    owner_ = js::CheckedUnwrapDynamic(&input.toObject(), cx_);
    if (!owner_) {
      if (!JS_IsExceptionPending(cx_)) js::ReportAccessDenied(cx_);
      return false;
    }
    // Brand tests are nonallocating and need no realm entry. In particular,
    // reject unrelated proxies/window wrappers before JSAutoRealm's raw-owner
    // precondition; only admitted actual storage reaches pointer access.
    if (JS_IsArrayBufferViewObject(owner_)) kind_ = Kind::View;
    else if (JS::IsArrayBufferObject(owner_)) kind_ = Kind::Buffer;
    else if (JS::IsSharedArrayBufferObject(owner_)) kind_ = Kind::Shared;
    return kind_ != Kind::None;
  }
  size_t Length() const {
    MOZ_ASSERT(kind_ != Kind::None);
    JSAutoRealm realm(cx_, owner_);
    // Metadata only: no pointer exists while a later source is prepared or
    // its realm/security operations run.
    return LengthInRealm();
  }
  template<class Consume> bool WithBytes(Consume&& consume) {
    MOZ_ASSERT(kind_ != Kind::None);
    JSAutoRealm realm(cx_, owner_);
    JS::AutoCheckCannotGC nogc;
    const size_t length = LengthInRealm();
    bool shared = false;
    uint8_t* data;
    if (kind_ == Kind::View)
      data = static_cast<uint8_t*>(JS_GetArrayBufferViewData(owner_, &shared, nogc));
    else if (kind_ == Kind::Buffer)
      data = JS::GetArrayBufferData(owner_, &shared, nogc);
    else
      data = JS::GetSharedArrayBufferData(owner_, &shared, nogc);
    if (length && !data) return false;
    auto bytes = shared ? SharedMem<uint8_t*>::shared(data) : SharedMem<uint8_t*>::unshared(data);
    // Native allocation may throw; C++ unwinding closes both scopes before
    // any outer error guard can allocate/report a JavaScript exception.
    return std::forward<Consume>(consume)(bytes, length);
  }
  JS::KandeloBacking::SpanRef Capture() {
    MOZ_ASSERT(kind_ != Kind::None);
    JSAutoRealm realm(cx_, owner_);
    RootedObject view(cx_, owner_);
    if (kind_ != Kind::View) {
      const size_t length = LengthInRealm();
      if (!std::in_range<int64_t>(length)) { JS_ReportOutOfMemory(cx_);return {}; }
      // This is a real view of the same original allocation, not a copied
      // snapshot. Async acquisition may materialize storage and collect, so
      // it is intentionally separate from synchronous no-GC borrowing.
      view = JS_NewUint8ArrayWithBuffer(cx_, owner_, 0, int64_t(length));
      if (!view) return {};
    }
    return JS::KandeloBacking::Acquire(cx_, view);
  }
};
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
  KandeloCryptoByteSource source(cx);
  if (!source.Init(input)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Crypto input requires a real buffer source");
    return false;
  }
  const bool copied = source.WithBytes([&](SharedMem<uint8_t*> data, size_t length) {
    KandeloCryptoCopy(data, length, bytes);return true;
  });
  if (!copied && !JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Crypto buffer has no backing data");
  return copied;
}
// Native stream crypto decodes strings inside its owning byte boundary.
// ParseEncoding receives a primitive string only and preserves the pin's
// fallback/C-string rules; nonstrings retain the existing BufferSource path.
static bool KandeloCryptoEncodedInput(JSContext* cx, HandleValue input,
                                       HandleValue encoding,
                                       kandelo::crypto::Bytes* bytes) {
  if (!input.isString()) return KandeloCryptoInput(cx, input, bytes);
  auto mode = kandelo::encoding::UTF8;
  if (encoding.isString()) {
    RootedString name(cx, encoding.toString());
    JS::UniqueChars text = JS_EncodeStringToUTF8(cx, name);
    if (!text) return false;
    mode = kandelo::encoding::ParseEncoding(text.get(), mode);
  }
  if (mode == kandelo::encoding::UTF8 || mode == kandelo::encoding::BUFFER)
    return KandeloCryptoInput(cx, input, bytes);
  RootedString text(cx, input.toString());
  JSLinearString* linear = JS_EnsureLinearString(cx, text);
  if (!linear) return false;
  JS::AutoCheckCannotGC nogc;
  const size_t length = JS::GetLinearStringLength(linear);
  size_t capacity;
  if (!kandelo::encoding::bytes::Capacity(length, mode, &capacity)) throw std::bad_alloc();
  bytes->value.resize(capacity);
  if (JS::LinearStringHasLatin1Chars(linear)) {
    bytes->value.resize(kandelo::encoding::bytes::Write(bytes->value.data(), capacity,
        JS::GetLatin1LinearStringChars(nogc, linear), length, mode));
  } else {
    bytes->value.resize(kandelo::encoding::bytes::Write(bytes->value.data(), capacity,
        JS::GetTwoByteLinearStringChars(nogc, linear), length, mode));
  }
  return true;
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
  KandeloCryptoByteSource first(cx), second(cx);
  // Prepare both checked/rooted sources before obtaining either pointer.
  if (!first.Init(args.get(0))) {
    if (JS_IsExceptionPending(cx)) return false;
    args.rval().setInt32(1);return true;
  }
  if (!second.Init(args.get(1))) {
    if (JS_IsExceptionPending(cx)) return false;
    args.rval().setInt32(2);return true;
  }
  if (first.Length() != second.Length()) { args.rval().setInt32(3);return true; }
  const bool copiedFirst = first.WithBytes([&](SharedMem<uint8_t*> data, size_t length) {
    KandeloCryptoCopy(data, length, &a);return true;
  });
  const bool copiedSecond = copiedFirst && second.WithBytes([&](SharedMem<uint8_t*> data, size_t length) {
    KandeloCryptoCopy(data, length, &b);return true;
  });
  if (!copiedSecond) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Crypto buffer has no backing data");return false;
  }
  // Concurrent growable shared memory can change observed lengths. Compare
  // the actual captured native byte ranges, never hold a JS pointer across
  // another source's realm/security preparation.
  if (a.value.size() != b.value.size()) { args.rval().setInt32(3);return true; }
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
