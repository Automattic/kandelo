/* Owned synchronous libcrypto consumers; included after existing byte helpers. */
#include "kandelo-node-digest-operations.h"
#include "kandelo-node-string-bytes.h"
#include "js/ArrayBuffer.h"
#include "js/BigInt.h"
#include "js/Conversions.h"
#include "js/Realm.h"
#include "js/Exception.h"
#include "js/Stack.h"
#include "js/PropertyAndElement.h"
#include "js/SharedArrayBuffer.h"
#include "js/String.h"
#include "js/Wrapper.h"
#include "js/experimental/TypedData.h"
#include "js/experimental/KandeloBackingStore.h"
#include <ncrypto.h>
#include <mutex>
#include <utility>
namespace {
// Actual linked default-property state; not a provider/certification claim.
// Public mutation and provider-list enumeration share this process owner.
// Forced startup/configuration admission is not yet implemented by the CLI.
static std::mutex gKandeloFipsStateMutex;
static bool KandeloNativeGetFipsCrypto(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  std::lock_guard<std::mutex> lock(gKandeloFipsStateMutex);
  args.rval().setInt32(ncrypto::isFipsEnabled() ? 1 : 0);return true;
}
static bool KandeloNativeGetFipsCryptoGeneration(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  // ncrypto owns this atomic uint64 generation. Keep all bits; the pinned JS
  // cache uses BigInt equality and must not receive a rounded Number/counter.
  JS::BigInt* generation = JS::NumberToBigInt(cx, ncrypto::getFipsStateGeneration());
  if (!generation) return false;
  args.rval().setBigInt(generation);return true;
}
static bool KandeloNativeOwnsCryptoProcessState(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  args.rval().setBoolean(!GetShellContext(cx)->isWorker);return true;
}
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
// All consumers create an actual engine Error on the owning JS thread. C++
// queue data may have arrived from a worker; no JS root crossed that boundary.
static bool KandeloDigestError(JSContext* cx,const kandelo::crypto::Error& failure,
    MutableHandleValue value,std::optional<JSExnType> requested = std::nullopt,bool checkNodeCode = true) {
  if (JS_IsExceptionPending(cx)) return false;
  JSExnType type=requested.value_or(JSEXN_ERR);
  if (!requested && failure.checkedNodeCode) {
    const auto kind=kandelo::crypto::NativeNodeKind(failure.code);
    if (kind) {
      switch(*kind) {
        case kandelo::crypto::ErrorKind::TypeError: type=JSEXN_TYPEERR;break;
        case kandelo::crypto::ErrorKind::RangeError: type=JSEXN_RANGEERR;break;
        case kandelo::crypto::ErrorKind::SyntaxError: type=JSEXN_SYNTAXERR;break;
        case kandelo::crypto::ErrorKind::URIError: type=JSEXN_URIERR;break;
        default: break;
      }
    }
  }
  RootedString message(cx,JS_NewStringCopyUTF8N(cx,JS::UTF8Chars(failure.message.data(),failure.message.size())));
  RootedString file(cx,JS_GetEmptyString(cx));RootedObject stack(cx);RootedValue error(cx);
  if (!message || !JS::CaptureCurrentStack(cx,&stack) ||
      !JS::CreateError(cx,type,stack,file,0,JS::ColumnNumberOneOrigin(1),nullptr,
                       message,JS::NothingHandleValue,&error)) return false;
  RootedObject object(cx,&error.toObject());
  auto set = [&](const std::string& name,HandleValue field) {
    RootedString key(cx,JS_NewStringCopyUTF8N(cx,JS::UTF8Chars(name.data(),name.size())));RootedId id(cx);
    if (!key || !JS_StringToId(cx,key,&id)) return false;
    RootedValue receiver(cx,ObjectValue(*object));JS::ObjectOpResult result;
    // Like V8 Set(...).IsNothing(), ignore a nonthrowing false result while
    // preserving an inherited setter's actual thrown exception.
    return JS_ForwardSetPropertyTo(cx,object,id,field,receiver,result);
  };
  const bool applied=kandelo::crypto::ApplyErrorProperties(failure,
    [&](const std::vector<std::string>& entries) {
      RootedObject array(cx,JS::NewArrayObject(cx,entries.size()));if (!array) return false;
      for (uint32_t i=0;i<entries.size();++i) {
        RootedString string(cx,JS_NewStringCopyUTF8N(cx,JS::UTF8Chars(entries[i].data(),entries[i].size())));
        if (!string) return false;RootedValue entry(cx,StringValue(string));
        // V8 Array::New initializes own elements; inherited Array setters must
        // not run while the private OpenSSL error stack is materialized.
        if (!JS_DefineElement(cx,array,i,entry,JSPROP_ENUMERATE)) return false;
      }
      RootedValue field(cx,ObjectValue(*array));return set("opensslErrorStack",field);
    },
    [&](const std::string& name,const std::string& text) {
      RootedString string(cx,JS_NewStringCopyN(cx,text.data(),text.size())); // pinned OneByteString
      if (!string) return false;RootedValue field(cx,StringValue(string));return set(name,field);
    });
  if (failure.checkedNodeCode && checkNodeCode) {
    // Exact native ERR_* macros use Set(...).Check(). False is a valid result;
    // an exception is a fatal invariant in that distinct coded-error path.
    MOZ_RELEASE_ASSERT(applied);
  }
  if (!applied) return false;
  value.set(error);return true;
}
static bool KandeloThrowCryptoError(JSContext* cx,const kandelo::crypto::Error& failure,
    std::optional<JSExnType> type = std::nullopt) {
  RootedValue error(cx);
  if (!KandeloDigestError(cx,failure,&error,type)) return false;
  JS_SetPendingException(cx,error);return false;
}
static bool KandeloNativeSetFipsCrypto(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  // The public wrapper throws the pinned Worker error. Raw internal entry has
  // the target's fatal owns_process_state admission, before touching libcrypto.
  MOZ_RELEASE_ASSERT(!GetShellContext(cx)->isWorker);
  kandelo::crypto::CryptoErrorStore store;
  bool success;
  {
    std::lock_guard<std::mutex> lock(gKandeloFipsStateMutex);
    ncrypto::CryptoErrorList errors;
    // BooleanValue/ToBoolean never invokes a user coercion hook. ncrypto owns
    // transition detection, the atomic generation and the actual error queue.
    success = ncrypto::setFipsEnabled(JS::ToBoolean(args.get(0)), &errors);
    if (!success) for (const auto& error : errors) store.Insert(error);
  }
  if (!success) {
    // All queue strings are owned before unlock. Do not hold the process-state
    // mutex while an inherited Error.prototype setter can reenter this owner.
    // cryptoErrorListToException uses last-message/preceding-stack only, not
    // numeric ERR decoration. Its empty-list fallback is env->ok_string ("ok"),
    // distinct from CryptoErrorStore::ToException's fallback.
    std::optional<std::string> message;
    if (store.errors_.empty()) message = "ok";
    return KandeloThrowCryptoError(cx,
        kandelo::crypto::Error::FromCaptured(std::move(store), std::move(message)));
  }
  args.rval().setUndefined();return true;
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
static bool KandeloNativeMacNames(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  std::vector<std::string> names;
  {
    // Same real default-property owner as internal getFipsCrypto. Do not
    // retain the lock while allocating JS strings/arrays or entering JS.
    std::lock_guard<std::mutex> lock(gKandeloFipsStateMutex);
    names = kandelo::crypto::MacNames();
  }
  if (names.size() > UINT32_MAX) { JS_ReportOutOfMemory(cx);return false; }
  RootedObject result(cx, JS::NewArrayObject(cx, 0));
  if (!result) return false;
  for (size_t index = 0; index < names.size(); ++index) {
    RootedString name(cx, JS_NewStringCopyUTF8N(cx,
        JS::UTF8Chars(names[index].data(), names[index].size())));
    if (!name) return false;
    RootedValue value(cx, StringValue(name));
    // Target vector publication creates own elements. A user-installed
    // Array.prototype numeric setter must not intercept provider names.
    if (!JS_DefineElement(cx, result, uint32_t(index), value, JSPROP_ENUMERATE)) return false;
  }
  args.rval().setObject(*result);return true;
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
