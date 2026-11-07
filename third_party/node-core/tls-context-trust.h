// Actual per-context OpenSSL trust material, following pinned Node CA loading.
#ifndef KANDELO_NODE_TLS_CONTEXT_TRUST_H
#define KANDELO_NODE_TLS_CONTEXT_TRUST_H
#include <climits>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include "crypto-errors.h"
#include <memory>
#include <string>
#include <openssl/err.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
namespace kandelo::tls {
struct ContextDeleter { void operator()(SSL_CTX* value) const { SSL_CTX_free(value); } };
using ContextPointer = std::unique_ptr<SSL_CTX, ContextDeleter>;
inline ContextPointer NewTrustContext(int minVersion = TLS1_2_VERSION,
                                     int maxVersion = TLS1_3_VERSION) {
  ContextPointer context(SSL_CTX_new(TLS_client_method()));
  if (!context || !SSL_CTX_set_min_proto_version(context.get(), minVersion) ||
      !SSL_CTX_set_max_proto_version(context.get(), maxVersion)) return {};
  return context;
}
// These operations own actual SSL_CTX policy and its real thread-local error
// queue. The option frontend keeps TLS1.2 lists and TLS1.3 suites separate.
struct CipherErrorClear {
  CipherErrorClear() { ERR_clear_error(); }
  ~CipherErrorClear() { ERR_clear_error(); }
};
[[noreturn]] inline void CipherFailure(unsigned long number, const char* fallback) {
  char message[128];
  if (number) { ERR_error_string_n(number, message, sizeof(message)); fallback = message; }
  throw kandelo::crypto::Error(fallback, number);
}
inline void SetContextCipherSuites(SSL_CTX* context, const char* ciphers) {
  CipherErrorClear clear;
  if (!SSL_CTX_set_ciphersuites(context, ciphers))
    CipherFailure(ERR_get_error(), "Failed to set ciphers");
}
inline void SetContextCiphers(SSL_CTX* context, const char* ciphers) {
  CipherErrorClear clear;
  if (!SSL_CTX_set_cipher_list(context, ciphers)) {
    const unsigned long number = ERR_get_error();
    // Exact Node policy: deliberately clearing the pre-TLS1.3 list is valid;
    // a nonempty invalid list still throws the actual OpenSSL error.
    if (ciphers[0] == '\0' && ERR_GET_REASON(number) == SSL_R_NO_CIPHER_MATCH) return;
    CipherFailure(number, "Failed to set ciphers");
  }
}
// A CA is public material. The selected Node LoadBIO nevertheless uses a
// secure-memory BIO; preserve its explicit length and read-only input policy.
inline int TrustNoPassword(char*, int, int, void*) { return 0; }
struct BioDeleter { void operator()(BIO* value) const { BIO_free_all(value); } };
struct CertDeleter { void operator()(X509* value) const { X509_free(value); } };
inline bool AddTrustCertificates(SSL_CTX* context, const unsigned char* bytes,
                                  size_t length, unsigned long* failure = nullptr) {
  // SecureContext::SetCACert has ClearErrorOnReturn. Empty/unparseable PEM is
  // allowed: actual handshake verification determines whether trust exists.
  struct ClearErrors { ~ClearErrors() { ERR_clear_error(); } } clear;
  if (length > INT_MAX) return true;  // LoadBIO returns an empty BIOPointer.
  std::unique_ptr<BIO, BioDeleter> bio(BIO_new(BIO_s_secmem()));
  if (!bio) return true;  // Pinned AddCACert accepts an empty LoadBIO result.
  const int written = length ? BIO_write(bio.get(), bytes, int(length)) : 0;
  if (written < 0 || size_t(written) != length) return true;
  for (;;) {
    std::unique_ptr<X509, CertDeleter> cert(
        PEM_read_bio_X509_AUX(bio.get(), nullptr, TrustNoPassword, nullptr));
    if (!cert) return true;
    // This context owns its fresh X509_STORE; unlike Node's shared root
    // store there is no global store to detach or mutate at this boundary.
    if (X509_STORE_add_cert(SSL_CTX_get_cert_store(context), cert.get()) != 1 ||
        SSL_CTX_add_client_CA(context, cert.get()) != 1) {
      if (failure) *failure = ERR_peek_last_error();
      return false;
    }
  }
}
inline bool AddDefaultTrust(SSL_CTX* context) {
  // Existing selected backend: configured guest OpenSSL file/directory paths.
  // This does not claim Node's bundled/system/extra/default store APIs.
  ERR_clear_error();
  SSL_CTX_set_default_verify_paths(context);
  ERR_clear_error();
  return true;  // Preserve the existing selected default-path policy.
}
inline bool AllowPartialTrustChain(SSL_CTX* context) {
  return X509_STORE_set_flags(SSL_CTX_get_cert_store(context), X509_V_FLAG_PARTIAL_CHAIN) == 1;
}
// NODE_TLS_VERIFICATION_REASON
}  // namespace kandelo::tls
#endif
