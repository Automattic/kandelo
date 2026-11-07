// Owned OpenSSL queues and exact Node decoration order. No JS values, contexts
// or provider-owned text pointers survive this capture/worker handoff boundary.
#ifndef KANDELO_NODE_CRYPTO_ERRORS_H
#define KANDELO_NODE_CRYPTO_ERRORS_H
#include <algorithm>
#include <cstdint>
#include <locale>
#include <optional>
#include <openssl/err.h>
#include <openssl/opensslv.h>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
namespace kandelo::crypto {
inline char ToUpper(char c) {
  return std::toupper(c, std::locale::classic());
}
template<class Set> inline bool DescribeError(unsigned long err,Set set) {  // NOLINT(runtime/int)
  if (err == 0) return true;         // No decoration necessary.

  const char* ls = ERR_lib_error_string(err);
#if !defined(OPENSSL_IS_BORINGSSL) && OPENSSL_VERSION_MAJOR >= 3
  const char* fs = nullptr;
#else
  const char* fs = ERR_func_error_string(err);
#endif
  const char* rs = ERR_reason_error_string(err);


  if (ls != nullptr) {
    if (!set("library", ls)) {
      return false;
    }
  }
  if (fs != nullptr) {
    if (!set("function", fs)) {
      return false;
    }
  }
  if (rs != nullptr) {
    if (!set("reason", rs)) {
      return false;
    }

    // SSL has no API to recover the error name from the number, so we
    // transform reason strings like "this error" to "ERR_SSL_THIS_ERROR",
    // which ends up being close to the original error macro name.
    std::string reason(rs);

    for (auto& c : reason) {
      if (c == ' ')
        c = '_';
      else
        c = ToUpper(c);
    }

#ifdef OPENSSL_IS_BORINGSSL
#define OSSL_ERROR_CODES_MAP_OPENSSL_ONLY(V)
#else
#define OSSL_ERROR_CODES_MAP_OPENSSL_ONLY(V)                                   \
  V(PKCS12)                                                                    \
  V(DSO)                                                                       \
  V(OSSL_STORE)                                                                \
  V(FIPS)                                                                      \
  V(TS)                                                                        \
  V(CT)                                                                        \
  V(ASYNC)                                                                     \
  V(KDF)                                                                       \
  V(SM2)
#endif

#define OSSL_ERROR_CODES_MAP(V)                                                \
  V(SYS)                                                                       \
  V(BN)                                                                        \
  V(RSA)                                                                       \
  V(DH)                                                                        \
  V(EVP)                                                                       \
  V(BUF)                                                                       \
  V(OBJ)                                                                       \
  V(PEM)                                                                       \
  V(DSA)                                                                       \
  V(X509)                                                                      \
  V(ASN1)                                                                      \
  V(CONF)                                                                      \
  V(CRYPTO)                                                                    \
  V(EC)                                                                        \
  V(SSL)                                                                       \
  V(BIO)                                                                       \
  V(PKCS7)                                                                     \
  V(X509V3)                                                                    \
  V(RAND)                                                                      \
  V(ENGINE)                                                                    \
  V(OCSP)                                                                      \
  V(UI)                                                                        \
  V(COMP)                                                                      \
  V(ECDSA)                                                                     \
  V(ECDH)                                                                      \
  V(CMS)                                                                       \
  V(HMAC)                                                                      \
  V(USER)                                                                      \
  OSSL_ERROR_CODES_MAP_OPENSSL_ONLY(V)

#define V(name) case ERR_LIB_##name: lib = #name "_"; break;
    const char* lib = "";
    const char* prefix = "OSSL_";
    switch (ERR_GET_LIB(err)) { /* NOLINT(whitespace/newline) */
      OSSL_ERROR_CODES_MAP(V)
    }
#undef V
#undef OSSL_ERROR_CODES_MAP
#undef OSSL_ERROR_CODES_MAP_OPENSSL_ONLY
    // Don't generate codes like "ERR_OSSL_SSL_".
    if (lib && strcmp(lib, "SSL_") == 0)
      prefix = "";

    // All OpenSSL reason strings fit in a single 80-column macro definition,
    // all prefix lengths are <= 10, and ERR_OSSL_ is 9, so 128 is more than
    // sufficient.
    char code[128];
    snprintf(code, sizeof(code), "ERR_%s%s%s", prefix, lib, reason.c_str());

    if (!set("code", code))
      return false;
  }

  return true;
}
struct Decoration {
  std::vector<std::pair<std::string,std::string>> fields;
  static Decoration Capture(unsigned long number) {
    Decoration result;
    DescribeError(number,[&](const char* name,const char* value){
      result.fields.emplace_back(name,value);return true;
    });
    return result;
  }
};
class CryptoErrorStore {
 public:
  std::vector<std::string> errors_;
  unsigned long primary_openssl_error_=0;
  std::optional<std::string> node_error_code_;
  void Insert(std::string value){errors_.push_back(std::move(value));}
  void SetNodeErrorCode(const char* value){node_error_code_=value;}
  void Capture() {
  errors_.clear();
  primary_openssl_error_ = 0;
  while (const uint32_t err = ERR_get_error()) {
    if (primary_openssl_error_ == 0) primary_openssl_error_ = err;
    char buf[256];
    ERR_error_string_n(err, buf, sizeof(buf));
    errors_.emplace_back(buf);
  }
  std::reverse(errors_.begin(),errors_.end());
}
};
enum class ErrorKind { Error, TypeError, RangeError, SyntaxError, URIError };
inline std::optional<ErrorKind> NativeNodeKind(std::string_view code) {
  if(code=="ERR_ACCESS_DENIED")return ErrorKind::Error;
  if(code=="ERR_BUFFER_CONTEXT_NOT_AVAILABLE")return ErrorKind::Error;
  if(code=="ERR_BUFFER_OUT_OF_BOUNDS")return ErrorKind::RangeError;
  if(code=="ERR_BUFFER_TOO_LARGE")return ErrorKind::Error;
  if(code=="ERR_CLOSED_MESSAGE_PORT")return ErrorKind::Error;
  if(code=="ERR_CONSTRUCT_CALL_REQUIRED")return ErrorKind::TypeError;
  if(code=="ERR_CONSTRUCT_CALL_INVALID")return ErrorKind::TypeError;
  if(code=="ERR_CPU_PROFILE_NOT_STARTED")return ErrorKind::Error;
  if(code=="ERR_CPU_PROFILE_TOO_MANY")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_CUSTOM_ENGINE_NOT_SUPPORTED")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_INITIALIZATION_FAILED")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_INVALID_AUTH_TAG")return ErrorKind::TypeError;
  if(code=="ERR_CRYPTO_INVALID_COUNTER")return ErrorKind::TypeError;
  if(code=="ERR_CRYPTO_INVALID_CURVE")return ErrorKind::TypeError;
  if(code=="ERR_CRYPTO_INVALID_DIGEST")return ErrorKind::TypeError;
  if(code=="ERR_CRYPTO_INVALID_IV")return ErrorKind::TypeError;
  if(code=="ERR_CRYPTO_INVALID_JWK")return ErrorKind::TypeError;
  if(code=="ERR_CRYPTO_INVALID_KEYLEN")return ErrorKind::RangeError;
  if(code=="ERR_CRYPTO_INVALID_KEYPAIR")return ErrorKind::RangeError;
  if(code=="ERR_CRYPTO_INVALID_KEYTYPE")return ErrorKind::RangeError;
  if(code=="ERR_CRYPTO_INVALID_MAC")return ErrorKind::TypeError;
  if(code=="ERR_CRYPTO_INVALID_MESSAGELEN")return ErrorKind::RangeError;
  if(code=="ERR_CRYPTO_INVALID_SCRYPT_PARAMS")return ErrorKind::RangeError;
  if(code=="ERR_CRYPTO_INVALID_STATE")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_INVALID_TAG_LENGTH")return ErrorKind::RangeError;
  if(code=="ERR_CRYPTO_JWK_UNSUPPORTED_CURVE")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_MAC_NOT_SUPPORTED")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_MAC_UPDATE_FAILED")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_OPERATION_FAILED")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH")return ErrorKind::RangeError;
  if(code=="ERR_CRYPTO_UNKNOWN_CIPHER")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_UNKNOWN_DH_GROUP")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_UNSUPPORTED_OPERATION")return ErrorKind::Error;
  if(code=="ERR_CRYPTO_JOB_INIT_FAILED")return ErrorKind::Error;
  if(code=="ERR_DLOPEN_DISABLED")return ErrorKind::Error;
  if(code=="ERR_DLOPEN_FAILED")return ErrorKind::Error;
  if(code=="ERR_ENCODING_INVALID_ENCODED_DATA")return ErrorKind::TypeError;
  if(code=="ERR_EXECUTION_ENVIRONMENT_NOT_AVAILABLE")return ErrorKind::Error;
  if(code=="ERR_FFI_CALL_FAILED")return ErrorKind::Error;
  if(code=="ERR_FFI_INVALID_POINTER")return ErrorKind::Error;
  if(code=="ERR_FFI_LIBRARY_CLOSED")return ErrorKind::Error;
  if(code=="ERR_FS_CP_EINVAL")return ErrorKind::Error;
  if(code=="ERR_FS_CP_DIR_TO_NON_DIR")return ErrorKind::Error;
  if(code=="ERR_FS_CP_NON_DIR_TO_DIR")return ErrorKind::Error;
  if(code=="ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY")return ErrorKind::Error;
  if(code=="ERR_FS_EISDIR")return ErrorKind::Error;
  if(code=="ERR_FS_CP_EEXIST")return ErrorKind::Error;
  if(code=="ERR_FS_CP_SOCKET")return ErrorKind::Error;
  if(code=="ERR_FS_CP_FIFO_PIPE")return ErrorKind::Error;
  if(code=="ERR_FS_CP_UNKNOWN")return ErrorKind::Error;
  if(code=="ERR_HEAP_PROFILE_HAVE_BEEN_STARTED")return ErrorKind::Error;
  if(code=="ERR_HEAP_PROFILE_NOT_STARTED")return ErrorKind::Error;
  if(code=="ERR_ILLEGAL_CONSTRUCTOR")return ErrorKind::Error;
  if(code=="ERR_INSPECTOR_NOT_AVAILABLE")return ErrorKind::Error;
  if(code=="ERR_INVALID_ADDRESS")return ErrorKind::Error;
  if(code=="ERR_INVALID_ARG_VALUE")return ErrorKind::TypeError;
  if(code=="ERR_OSSL_EVP_INVALID_DIGEST")return ErrorKind::Error;
  if(code=="ERR_INVALID_ARG_TYPE")return ErrorKind::TypeError;
  if(code=="ERR_INVALID_FILE_URL_HOST")return ErrorKind::TypeError;
  if(code=="ERR_INVALID_FILE_URL_PATH")return ErrorKind::TypeError;
  if(code=="ERR_INVALID_INVOCATION")return ErrorKind::TypeError;
  if(code=="ERR_INVALID_PACKAGE_CONFIG")return ErrorKind::Error;
  if(code=="ERR_INVALID_OBJECT_DEFINE_PROPERTY")return ErrorKind::TypeError;
  if(code=="ERR_INVALID_MODULE")return ErrorKind::Error;
  if(code=="ERR_INVALID_STATE")return ErrorKind::Error;
  if(code=="ERR_INVALID_THIS")return ErrorKind::TypeError;
  if(code=="ERR_INVALID_URL")return ErrorKind::TypeError;
  if(code=="ERR_INVALID_URL_PATTERN")return ErrorKind::TypeError;
  if(code=="ERR_INVALID_URL_SCHEME")return ErrorKind::TypeError;
  if(code=="ERR_LOAD_SQLITE_EXTENSION")return ErrorKind::Error;
  if(code=="ERR_MEMORY_ALLOCATION_FAILED")return ErrorKind::RangeError;
  if(code=="ERR_MESSAGE_TARGET_CONTEXT_UNAVAILABLE")return ErrorKind::Error;
  if(code=="ERR_MISSING_ARGS")return ErrorKind::TypeError;
  if(code=="ERR_MISSING_PASSPHRASE")return ErrorKind::TypeError;
  if(code=="ERR_MISSING_PLATFORM_FOR_WORKER")return ErrorKind::Error;
  if(code=="ERR_MODULE_NOT_FOUND")return ErrorKind::Error;
  if(code=="ERR_MODULE_NOT_INSTANTIATED")return ErrorKind::Error;
  if(code=="ERR_MODULE_LINK_MISMATCH")return ErrorKind::TypeError;
  if(code=="ERR_NON_CONTEXT_AWARE_DISABLED")return ErrorKind::Error;
  if(code=="ERR_OPERATION_FAILED")return ErrorKind::TypeError;
  if(code=="ERR_OPTIONS_BEFORE_BOOTSTRAPPING")return ErrorKind::Error;
  if(code=="ERR_OUT_OF_RANGE")return ErrorKind::RangeError;
  if(code=="ERR_RX_MEMORY_NOT_SUPPORTED")return ErrorKind::Error;
  if(code=="ERR_SCRIPT_EXECUTION_INTERRUPTED")return ErrorKind::Error;
  if(code=="ERR_SCRIPT_EXECUTION_TIMEOUT")return ErrorKind::Error;
  if(code=="ERR_SOURCE_PHASE_NOT_DEFINED")return ErrorKind::SyntaxError;
  if(code=="ERR_STRING_TOO_LONG")return ErrorKind::Error;
  if(code=="ERR_TLS_INVALID_PROTOCOL_METHOD")return ErrorKind::TypeError;
  if(code=="ERR_TLS_PSK_SET_IDENTITY_HINT_FAILED")return ErrorKind::Error;
  if(code=="ERR_VM_MODULE_CACHED_DATA_REJECTED")return ErrorKind::Error;
  if(code=="ERR_VM_MODULE_LINK_FAILURE")return ErrorKind::Error;
  if(code=="ERR_WASI_NOT_STARTED")return ErrorKind::Error;
  if(code=="ERR_ZLIB_INITIALIZATION_FAILED")return ErrorKind::Error;
  if(code=="ERR_WORKER_INIT_FAILED")return ErrorKind::Error;
  if(code=="ERR_PROTO_ACCESS")return ErrorKind::Error;
  return std::nullopt;
}
inline bool IsNativeNodeCode(std::string_view code){return NativeNodeKind(code).has_value();}

inline constexpr const char* EmptyStoreMessage(){return "Ok";}
struct Error : std::runtime_error {
  std::string message;
  unsigned long number=0;
  std::string library,function,reason,code;
  std::vector<std::string> stack;
  std::vector<Decoration> decorations;
  bool checkedNodeCode=false;
 private:
  struct Captured {};
  Error(const std::string& text,CryptoErrorStore&& store,unsigned long explicitNumber,Captured)
      : std::runtime_error(text),message(text) {
    stack=std::move(store.errors_);
    if(store.primary_openssl_error_) decorations.push_back(Decoration::Capture(store.primary_openssl_error_));
    if(explicitNumber) decorations.push_back(Decoration::Capture(explicitNumber));
    number=explicitNumber?explicitNumber:store.primary_openssl_error_;
    if(!decorations.empty()) {
      for(const auto& field:decorations.back().fields) {
        if(field.first=="library")library=field.second;
        else if(field.first=="function")function=field.second;
        else if(field.first=="reason")reason=field.second;
        else if(field.first=="code")code=field.second;
      }
    }
  }
 public:
  static CryptoErrorStore Capture() { CryptoErrorStore store;store.Capture();return store; }
  explicit Error(const std::string& text,unsigned long explicitNumber=0)
      : Error(text,Capture(),explicitNumber,Captured{}) {}
  static Error FromCaptured(CryptoErrorStore&& store,std::optional<std::string> text=std::nullopt) {
    if(!text) {
      if(store.errors_.empty())text=EmptyStoreMessage();
      else {text=std::move(store.errors_.back());store.errors_.pop_back();}
    }
    auto nodeCode=std::move(store.node_error_code_);
    Error result(*text,std::move(store),0,Captured{});
    if(result.decorations.empty()&&nodeCode)result.code=std::move(*nodeCode);
    return result;
  }
  void SetNodeCode(const char* value) {
    // Explicit Node argument/state errors own their code, not a provider queue.
    number=0;library.clear();function.clear();reason.clear();stack.clear();decorations.clear();
    code=value;checkedNodeCode=IsNativeNodeCode(value);
  }
};
// Node's ordinary [[Set]] may return false without throwing. The adapter's
// setter returns false only for an actual exception/allocation failure.
// Native Node-code macros additionally Check() that exception result.
template<class SetStack,class SetString>
bool ApplyErrorProperties(const Error& error,SetStack&& setStack,SetString&& setString) {
  if(!error.stack.empty()&&!setStack(error.stack))return false;
  for(const auto& decoration:error.decorations)
    for(const auto& field:decoration.fields)
      if(!setString(field.first,field.second))return false;
  if(error.decorations.empty()&&!error.code.empty()&&!setString("code",error.code))return false;
  return true;
}
} // namespace kandelo::crypto
#endif
