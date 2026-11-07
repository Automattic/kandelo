// Real prepared SSL_CTX credentials. Exact pinned certificate-chain algorithms
// below retain OpenSSL references; there is no fabricated certificate state.
#ifndef KANDELO_NODE_TLS_CREDENTIAL_OPERATIONS_H
#define KANDELO_NODE_TLS_CREDENTIAL_OPERATIONS_H
#include "kandelo-node-x509-operations.h"
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <openssl/ssl.h>
namespace kandelo::tls::credentials {
using ncrypto::BIOPointer;
using ncrypto::EVPKeyPointer;
using ncrypto::StackOfX509;
using ncrypto::X509Pointer;
inline void CredentialCheck(bool condition) { if (!condition) std::abort(); }
inline int NoPasswordCallback(char*, int, int, void*) { return 0; }
struct Password { const unsigned char* data; size_t size; };
// Exact callback length policy, including embedded NUL bytes and refusing
// OpenSSL's interactive terminal prompt when a password was not supplied.
inline int PasswordCallback(char* bytes, int capacity, int, void* data) {
  const auto* pass = *static_cast<const Password**>(data);
  if (!pass || static_cast<size_t>(capacity) < pass->size) return -1;
  if (pass->size) std::memcpy(bytes, pass->data, pass->size);
  return static_cast<int>(pass->size);
}
[[noreturn]] inline void CryptoFailure(const char* fallback) {
  const unsigned long primary = ERR_get_error();
  char message[128];
  if (primary) ERR_error_string_n(primary,message,sizeof(message));
  kandelo::crypto::Error error(primary ? message : fallback, primary);
  throw error;
}
[[noreturn]] inline void PFXFailure(unsigned long error) {
  // Historical TLS PFX errors are plain reason errors, without crypto-stack
  // decoration. Clear the remaining queue before constructing that error.
  ERR_clear_error();
#if OPENSSL_VERSION_MAJOR >= 3
  if (ERR_GET_REASON(error) == ERR_R_UNSUPPORTED)
    throw kandelo::crypto::X509Error("Unsupported PKCS12 PFX data","ERR_CRYPTO_UNSUPPORTED_OPERATION");
#endif
  const char* reason=ERR_reason_error_string(error);
  throw kandelo::crypto::Error(reason ? reason : "Unknown error");
}
enum class PrivateKeyResult { kSuccess, kParseError, kApplyError };
// NODE_TLS_CHAIN_MATERIAL
// NODE_TLS_CHAIN_PEM
// NODE_TLS_PRIVATE_KEY
inline void SetCertificate(SSL_CTX* context, X509Pointer& certificate,
    X509Pointer& issuer, const unsigned char* bytes, size_t size) {
  ncrypto::ClearErrorOnReturn clear;
  auto bio=kandelo::crypto::LoadPKCS12BIO(bytes,size); // Same exact LoadBIO policy.
  if (!bio) return; // Pinned AddCert accepts an empty LoadBIO result.
  certificate.reset();issuer.reset();
  if (!SSL_CTX_use_certificate_chain(context,std::move(bio),&certificate,&issuer))
    CryptoFailure("SSL_CTX_use_certificate_chain");
}
inline void SetPrivateKey(SSL_CTX* context, const unsigned char* bytes,
    size_t size, const unsigned char* pass, size_t passSize) {
  auto bio=kandelo::crypto::LoadPKCS12BIO(bytes,size);
  if (!bio) return; // Pinned SetKey returns when LoadBIO fails.
  Password password{pass,passSize};
  switch (UsePrivateKey(context,bio,&password)) {
    case PrivateKeyResult::kSuccess: return;
    case PrivateKeyResult::kParseError: CryptoFailure("PEM_read_bio_PrivateKey");
    case PrivateKeyResult::kApplyError: CryptoFailure("SSL_CTX_use_PrivateKey");
  }
}
inline BIOPointer LoadPFXBIO(const unsigned char* bytes, size_t size, bool admitted = true) {
  auto bio=admitted ? kandelo::crypto::LoadPKCS12BIO(bytes,size) : BIOPointer{};
  if (!bio) throw kandelo::crypto::X509Error("Unable to load PFX certificate","ERR_CRYPTO_OPERATION_FAILED");
  return bio;
}
inline void LoadPFX(SSL_CTX* context, X509Pointer& certificate,
    X509Pointer& issuer, const BIOPointer& bio, const char* pass) {
  ncrypto::ClearErrorOnReturn clear;
  issuer.reset();certificate.reset();
  auto parsed=kandelo::crypto::ParsePKCS12Bundle(bio,pass);
  if (!parsed) PFXFailure(parsed.openssl_error.value_or(0));
  if (!parsed.value.key) throw kandelo::crypto::X509Error("Unable to load private key from PFX data","ERR_CRYPTO_OPERATION_FAILED");
  if (!parsed.value.cert) throw kandelo::crypto::X509Error("Unable to load certificate from PFX data","ERR_CRYPTO_OPERATION_FAILED");
  const StackOfX509& extra=parsed.value.ca;
  if (!SSL_CTX_use_certificate_chain(context,std::move(parsed.value.cert),extra.get(),&certificate,&issuer))
    PFXFailure(ERR_get_error());
  if (!SSL_CTX_use_PrivateKey(context,parsed.value.key.get())) PFXFailure(ERR_get_error());
  for (int i=0;i<sk_X509_num(extra.get());++i) {
    X509* ca=sk_X509_value(extra.get(),i);
    X509_STORE_add_cert(SSL_CTX_get_cert_store(context),ca);
    CredentialCheck(SSL_CTX_add_client_CA(context,ca)==1);
  }
}
} // namespace kandelo::tls::credentials
#endif
