/* A real SSL_CTX captures trust before TCP startup; each handshake claims its
 * own OpenSSL reference, independent of this foreground GC-owned wrapper. */
#include "kandelo-node-tls-context-trust.h"
#include "kandelo-node-tls-credential-operations.h"
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
  ncrypto::X509Pointer certificate, issuer;
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
// Admission remains the exact string/ArrayBufferView LoadBIO contract. The
// common checked byte source owns real cross-realm roots and no-GC borrows.
// A genuine oversized source is not copied: pinned LoadBIO returns empty.
static bool KandeloTlsMaterialBytes(JSContext* cx, HandleValue value,
    kandelo::crypto::Bytes* bytes, size_t* length, bool* admitted, bool bioLimit = true, bool terminate = false) {
  *admitted = false; *length = 0;
  if (value.isString()) {
    if (!KandeloCryptoInput(cx,value,bytes)) return false;
    *admitted = true; *length = bytes->value.size(); return true;
  }
  RootedObject view(cx, value.isObject() ? js::CheckedUnwrapDynamic(&value.toObject(),cx) : nullptr);
  if (value.isObject() && !view) {
    if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);
    return false;
  }
  if (!view || !JS_IsArrayBufferViewObject(view)) return true;
  KandeloCryptoByteSource source(cx);
  if (!source.Init(value)) return false;
  *admitted = true;
  return source.WithBytes([&](SharedMem<uint8_t*> data,size_t size) {
    *length = size;
    if (!bioLimit || size <= INT_MAX) {
      if (!terminate) KandeloCryptoCopy(data,size,bytes);
      else {
        if (size == SIZE_MAX) throw std::bad_alloc();
        // Allocate the terminator before copying secrets: push_back after a
        // full copy could reallocate and free an uncleansed old password.
        bytes->value.resize(size+1);
        for (size_t i=0;i<size;++i) bytes->value[i]=__atomic_load_n(data.unwrap()+i,__ATOMIC_RELAXED);
        bytes->value[size]=0;
      }
    }
    return true;
  });
}
static bool KandeloTlsTrustBytes(JSContext* cx, HandleValue value,
    kandelo::crypto::Bytes* bytes, size_t* length) {
  bool admitted;
  if (!KandeloTlsMaterialBytes(cx,value,bytes,length,&admitted)) return false;
  if (admitted) return true;
  JS_ReportErrorASCII(cx,"TLS CA must be a string or actual array buffer view");return false;
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
    if (argc != 1 && argc != 3) { JS_ReportErrorASCII(cx, "Invalid TLS context creation arguments"); return false; }
    int minVersion=TLS1_2_VERSION,maxVersion=TLS1_3_VERSION;
    if (argc == 3) {
      if (!args[1].isInt32() || !args[2].isInt32()) { JS_ReportErrorASCII(cx,"TLS protocol bounds require checked int32 values");return false; }
      minVersion=args[1].toInt32();maxVersion=args[2].toInt32();
    }
    ERR_clear_error();
    auto context = kandelo::tls::NewTrustContext(minVersion,maxVersion);
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
  if ((operation == "ciphers" || operation == "cipherSuites") && argc == 3) {
    if (!args[2].isString()) { JS_ReportErrorASCII(cx,"TLS cipher policy requires a checked string");return false; }
    kandelo::tls::CipherErrorClear clear;
    std::string ciphers;
    if (!KandeloKeyString(cx,args[2],&ciphers))return false;
    if (operation == "ciphers") kandelo::tls::SetContextCiphers(owner->context.get(),ciphers.c_str());
    else kandelo::tls::SetContextCipherSuites(owner->context.get(),ciphers.c_str());
    args.rval().setUndefined();return true;
  }
  if ((operation == "getMinProto" || operation == "getMaxProto") && argc == 2) {
    const long version = operation == "getMinProto" ? SSL_CTX_get_min_proto_version(owner->context.get()) : SSL_CTX_get_max_proto_version(owner->context.get());
    args.rval().setNumber(double(version));return true;
  }
  if (operation == "setMinProto" && argc == 3) {
    if (!args[2].isInt32()) { JS_ReportErrorASCII(cx,"TLS protocol requires a checked int32");return false; }
    if (!SSL_CTX_set_min_proto_version(owner->context.get(),args[2].toInt32()))
      return KandeloTlsContextError(cx,"OpenSSL rejected TLS protocol minimum");
    args.rval().setUndefined();return true;
  }
  if (operation == "addCA" && argc == 3) {
    kandelo::crypto::Bytes bytes;size_t length;
    if (!KandeloTlsTrustBytes(cx, args[2], &bytes, &length)) return false;
    unsigned long error = 0;
    if (!kandelo::tls::AddTrustCertificates(owner->context.get(), bytes.value.data(), length, &error))
      return KandeloTlsContextError(cx, "OpenSSL rejected a CA certificate", error);
    return true;
  }
  if ((operation == "setCert" && argc == 3) ||
      (operation == "setKey" && argc == 4) ||
      (operation == "loadPFX" && (argc == 3 || argc == 4))) {
    kandelo::crypto::Bytes bytes,password;size_t length;bool admitted;
    if (!KandeloTlsMaterialBytes(cx,args[2],&bytes,&length,&admitted)) return false;
    if (operation == "setCert") {
      if (admitted) kandelo::tls::credentials::SetCertificate(owner->context.get(),owner->certificate,owner->issuer,bytes.value.data(),length);
    } else if (operation == "setKey") {
      if (admitted) {
        if (args[3].isString() && !KandeloCryptoInput(cx,args[3],&password)) return false;
        kandelo::tls::credentials::SetPrivateKey(owner->context.get(),bytes.value.data(),length,password.value.data(),password.value.size());
      }
    } else {
      ncrypto::ClearErrorOnReturn clear;
      // LoadBIO failure precedes password validation, exactly as the pin.
      auto bio=kandelo::tls::credentials::LoadPFXBIO(bytes.value.data(),length,admitted);
      const char* pass=nullptr;
      if (argc == 4) {
        bool passAdmitted;size_t passLength;
        if (!KandeloTlsMaterialBytes(cx,args[3],&password,&passLength,&passAdmitted,false,true)) return false;
        // The unchanged public toBuf converts strings; the private PFX binding
        // accepts actual views only for its supplied password argument.
        if (!passAdmitted || args[3].isString()) {
          const kandelo::crypto::X509Error error("Pass phrase must be a buffer","ERR_INVALID_ARG_TYPE");
          return KandeloThrowCryptoError(cx,error,JSEXN_TYPEERR);
        }
        pass=reinterpret_cast<const char*>(password.value.data());
      }
      kandelo::tls::credentials::LoadPFX(owner->context.get(),owner->certificate,owner->issuer,bio,pass);
    }
    args.rval().setUndefined();return true;
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
  catch (const kandelo::crypto::Error& error) { return KandeloThrowCryptoError(cx,error); }
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
