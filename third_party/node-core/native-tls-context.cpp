/* A real SSL_CTX captures trust before TCP startup; each handshake claims its
 * own OpenSSL reference, independent of this foreground GC-owned wrapper. */
#include "kandelo-node-tls-context-trust.h"
#include "kandelo-node-tls-state.h"
#include "js/ErrorReport.h"
#include "js/Exception.h"
#include "js/Stack.h"
#include "js/PropertyAndElement.h"
#include "js/GCAPI.h"
#include "js/experimental/TypedData.h"
#include <cstring>
#include <new>
#include <utility>
namespace {
struct KandeloTlsContextOwner {
  kandelo::tls::ContextPointer context;
  explicit KandeloTlsContextOwner(kandelo::tls::ContextPointer value)
      : context(std::move(value)) {}
};
static void KandeloTlsContextFinalize(JS::GCContext*, JSObject* object) {
  const auto value = JS::GetReservedSlot(object, 0);
  if (value.isUndefined()) return;
  auto* owner = static_cast<KandeloTlsContextOwner*>(value.toPrivate());
  // This is only the known C++ holder allocation, not an invented estimate
  // of opaque OpenSSL context/store/certificate physical allocations.
  JS::RemoveAssociatedMemory(object, sizeof(*owner), JS::MemoryUse::Embedding3);
  delete owner;
}
static const JSClassOps KandeloTlsContextOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
  KandeloTlsContextFinalize, nullptr, nullptr, nullptr};
static const JSClass KandeloTlsContextClass = {"KandeloTlsTrustContext",
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloTlsContextOps};
static KandeloTlsContextOwner* KandeloTlsContextUnwrap(JSContext* cx, HandleValue value) {
  RootedObject object(cx, value.isObject() ? js::CheckedUnwrapDynamic(&value.toObject(), cx) : nullptr);
  if (!object || JS::GetClass(object) != &KandeloTlsContextClass) return nullptr;
  const auto pointer = JS::GetReservedSlot(object, 0);
  return pointer.isUndefined() ? nullptr : static_cast<KandeloTlsContextOwner*>(pointer.toPrivate());
}
static bool KandeloTlsContextError(JSContext* cx, const char* fallback,
                                    unsigned long error = 0) {
  if (JS_IsExceptionPending(cx)) return false;
  if (!error) error = ERR_get_error();
  if (error && ERR_GET_REASON(error) == ERR_R_MALLOC_FAILURE) {
    JS_ReportOutOfMemory(cx); return false;
  }
  char message[256];
  if (error) { ERR_error_string_n(error, message, sizeof(message)); fallback = message; }
  ERR_clear_error();
  JS_ReportErrorASCII(cx, "%s", fallback); return false;
}
static bool KandeloTlsTrustBytes(JSContext* cx, HandleValue value,
                                   kandelo::crypto::Bytes* bytes) {
  if (value.isString()) return KandeloCryptoInput(cx, value, bytes);
  RootedObject view(cx, value.isObject() ? js::CheckedUnwrapDynamic(&value.toObject(), cx) : nullptr);
  if (!view || !JS_IsArrayBufferViewObject(view)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "TLS CA must be a string or actual array buffer view");
    return false;
  }
  // JSAPI returns the complete view range, including DataView offsets and
  // zero-length detached/out-of-bounds views. No public JS getters are read.
  JS::AutoCheckCannotGC nogc;
  const size_t length = JS_GetArrayBufferViewByteLength(view);
  bool shared;
  auto* data = static_cast<const uint8_t*>(JS_GetArrayBufferViewData(view, &shared, nogc));
  bytes->value.resize(length);
  for (size_t i = 0; i < length; i++) bytes->value[i] = __atomic_load_n(data + i, __ATOMIC_RELAXED);
  return true;
}
// Called by the existing fd/SSL handshake owner. Claim an independent native
// reference before any JS wrapper may be collected; no JS root crosses threads.
static SSL_CTX* KandeloTlsClaimContext(JSContext* cx, HandleValue options) {
  if (!options.isObject()) { JS_ReportErrorASCII(cx, "TLS handshake requires its prepared context"); return nullptr; }
  RootedObject object(cx, &options.toObject()); RootedValue context(cx);
  if (!JS_GetProperty(cx, object, "context", &context)) return nullptr;
  auto* owner = KandeloTlsContextUnwrap(cx, context);
  if (!owner || !owner->context) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Invalid TLS trust context");
    return nullptr;
  }
  if (SSL_CTX_up_ref(owner->context.get()) != 1) {
    KandeloTlsContextError(cx, "TLS context reference failed"); return nullptr;
  }
  return owner->context.get();
}
static bool KandeloNativeTlsContextOperationImpl(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "TLS context operation requires a name"); return false; }
  std::string operation;
  if (!KandeloKeyString(cx, args[0], &operation)) return false;
  if (operation == "create") {
    if (argc != 1) { JS_ReportErrorASCII(cx, "Invalid TLS context creation arguments"); return false; }
    ERR_clear_error();
    auto context = kandelo::tls::NewTrustContext();
    if (!context) return KandeloTlsContextError(cx, "TLS context allocation failed");
    auto owner = std::make_unique<KandeloTlsContextOwner>(std::move(context));
    RootedObject object(cx, JS_NewObject(cx, &KandeloTlsContextClass));
    if (!object) return false;
    JS::AddAssociatedMemory(object, sizeof(*owner), JS::MemoryUse::Embedding3);
    JS::SetReservedSlot(object, 0, PrivateValue(owner.release()));
    args.rval().setObject(*object); return true;
  }
  auto* owner = KandeloTlsContextUnwrap(cx, args.get(1));
  if (!owner || !owner->context) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Invalid TLS trust context receiver");
    return false;
  }
  if (operation == "addCA" && argc == 3) {
    kandelo::crypto::Bytes bytes;
    if (!KandeloTlsTrustBytes(cx, args[2], &bytes)) return false;
    unsigned long error = 0;
    if (!kandelo::tls::AddTrustCertificates(owner->context.get(), bytes.value.data(), bytes.value.size(), &error))
      return KandeloTlsContextError(cx, "OpenSSL rejected a CA certificate", error);
    return true;
  }
  if (operation == "addDefault" && argc == 2) {
    kandelo::tls::AddDefaultTrust(owner->context.get()); return true;
  }
  if (operation == "partial" && argc == 2) {
    if (!kandelo::tls::AllowPartialTrustChain(owner->context.get()))
      return KandeloTlsContextError(cx, "OpenSSL rejected partial-chain trust");
    return true;
  }
  JS_ReportErrorASCII(cx, "Unknown TLS context operation or argument count"); return false;
}
static bool KandeloNativeTlsContextOperation(JSContext* cx, unsigned argc, Value* vp) {
  try { return KandeloNativeTlsContextOperationImpl(cx, argc, vp); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
}  // namespace

namespace {
// Only a real completed handshake calls this error owner. It does not turn
// absent peer state into success; VerifyPeer retains the pinned PSK exceptions.
static bool KandeloTlsVerificationError(JSContext* cx, long verify,
                                          MutableHandleValue result) {
  try {
    const std::string reason = kandelo::tls::TrustVerificationReason(int(verify));
    RootedString message(cx, JS_NewStringCopyN(cx, reason.data(), reason.size()));
    RootedString filename(cx, JS_GetEmptyString(cx));
    RootedObject stack(cx);
    if (!message || !JS::CaptureCurrentStack(cx, &stack) ||
        !JS::CreateError(cx, JSEXN_ERR, stack, filename, 0, JS::ColumnNumberOneOrigin(1),
                         nullptr, message, JS::NothingHandleValue, result)) return false;
    RootedObject error(cx, &result.toObject());
    const char* name = kandelo::tls::VerificationErrorCode(int32_t(verify));
    if (!name) return true;
    RootedString code(cx, JS_NewStringCopyZ(cx, name));
    RootedString key(cx, JS_NewStringCopyZ(cx, "code"));
    RootedId id(cx);
    if (!code || !key || !JS_StringToId(cx, key, &id)) return false;
    RootedValue value(cx, StringValue(code)), receiver(cx, ObjectValue(*error));
    JS::ObjectOpResult setResult;
    // Pinned TLSWrap::Set uses ordinary [[Set]] and ignores a false result,
    // while preserving a thrown setter exception. Do not replace that with
    // define-own semantics or invent a code when the source supplies none.
    return JS_ForwardSetPropertyTo(cx, error, id, value, receiver, setResult);
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
static bool KandeloTlsRejectVerification(JSContext* cx, HandleObject promise, long verify) {
  RootedValue error(cx);
  return KandeloTlsVerificationError(cx, verify, &error) && JS::RejectPromise(cx, promise, error);
}
}  // namespace
