// Actual OpenSSL digest/comparison ownership; no fixed advertised algorithm set.
#ifndef KANDELO_NODE_DIGEST_OPERATIONS_H
#define KANDELO_NODE_DIGEST_OPERATIONS_H
#include <algorithm>
#include <cstdint>
#include <exception>
#include <memory>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
namespace kandelo::crypto {
inline const char* OpenSSLVersion() {
  // Report the linked backend, independent of the advertised Node API target.
  return OpenSSL_version(OPENSSL_VERSION_STRING);
}
struct Bytes {
  std::vector<unsigned char> value;
  Bytes() = default;
  Bytes(Bytes&&) = default;
  Bytes(const Bytes&) = delete;
  ~Bytes() { if (!value.empty()) OPENSSL_cleanse(value.data(), value.size()); }
};
struct Error : std::runtime_error {
  unsigned long number;
  std::string library, reason, code;
  std::vector<std::string> stack;
  explicit Error(const std::string& message, unsigned long number = 0)
      : std::runtime_error(message), number(number) {
    if (number) {
      const char* l = ERR_lib_error_string(number); if (l) library = l;
      const char* r = ERR_reason_error_string(number); if (r) reason = r;
      if (r) {
        const char* lib = "";
        // Pinned Node OpenSSL error-library prefixes, selected for the actual
        // OpenSSL provider build. Unknown libraries keep the empty prefix.
        switch (ERR_GET_LIB(number)) {
          case ERR_LIB_SYS: lib = "SYS_"; break;
          case ERR_LIB_BN: lib = "BN_"; break;
          case ERR_LIB_RSA: lib = "RSA_"; break;
          case ERR_LIB_DH: lib = "DH_"; break;
          case ERR_LIB_EVP: lib = "EVP_"; break;
          case ERR_LIB_BUF: lib = "BUF_"; break;
          case ERR_LIB_OBJ: lib = "OBJ_"; break;
          case ERR_LIB_PEM: lib = "PEM_"; break;
          case ERR_LIB_DSA: lib = "DSA_"; break;
          case ERR_LIB_X509: lib = "X509_"; break;
          case ERR_LIB_ASN1: lib = "ASN1_"; break;
          case ERR_LIB_CONF: lib = "CONF_"; break;
          case ERR_LIB_CRYPTO: lib = "CRYPTO_"; break;
          case ERR_LIB_EC: lib = "EC_"; break;
          case ERR_LIB_SSL: lib = "SSL_"; break;
          case ERR_LIB_BIO: lib = "BIO_"; break;
          case ERR_LIB_PKCS7: lib = "PKCS7_"; break;
          case ERR_LIB_X509V3: lib = "X509V3_"; break;
          case ERR_LIB_RAND: lib = "RAND_"; break;
          case ERR_LIB_ENGINE: lib = "ENGINE_"; break;
          case ERR_LIB_OCSP: lib = "OCSP_"; break;
          case ERR_LIB_UI: lib = "UI_"; break;
          case ERR_LIB_COMP: lib = "COMP_"; break;
          case ERR_LIB_ECDSA: lib = "ECDSA_"; break;
          case ERR_LIB_ECDH: lib = "ECDH_"; break;
          case ERR_LIB_CMS: lib = "CMS_"; break;
          case ERR_LIB_HMAC: lib = "HMAC_"; break;
          case ERR_LIB_USER: lib = "USER_"; break;
          case ERR_LIB_PKCS12: lib = "PKCS12_"; break;
          case ERR_LIB_DSO: lib = "DSO_"; break;
          case ERR_LIB_OSSL_STORE: lib = "OSSL_STORE_"; break;
          case ERR_LIB_FIPS: lib = "FIPS_"; break;
          case ERR_LIB_TS: lib = "TS_"; break;
          case ERR_LIB_CT: lib = "CT_"; break;
          case ERR_LIB_ASYNC: lib = "ASYNC_"; break;
          case ERR_LIB_KDF: lib = "KDF_"; break;
          case ERR_LIB_SM2: lib = "SM2_"; break;
        }
        code = ERR_GET_LIB(number) == ERR_LIB_SSL ? "ERR_" : "ERR_OSSL_";
        code += lib;
        for (char c : reason) code += c == ' ' ? '_' : c >= 'a' && c <= 'z' ? char(c - ('a' - 'A')) : c;
      }
    }
    unsigned long next; char text[256];
    while ((next = ERR_get_error()) != 0) {
      ERR_error_string_n(next, text, sizeof(text)); stack.emplace_back(text);
    }
  }
};
[[noreturn]] inline void Fail(const char* fallback) {
  const unsigned long number = ERR_get_error();
  char message[128];
  if (number) { ERR_error_string_n(number, message, sizeof(message)); throw Error(message, number); }
  throw Error(fallback);
}
using DigestOwner = std::unique_ptr<EVP_MD, decltype(&EVP_MD_free)>;
using ContextOwner = std::unique_ptr<EVP_MD_CTX, decltype(&EVP_MD_CTX_free)>;
inline DigestOwner Fetch(const char* name) {
  // Legacy alias names (including RSA-SHA*) resolve through the canonical
  // provider name; NULL is not an advertised or usable digest.
  const EVP_MD* legacy = EVP_get_digestbyname(name);
  const char* canonical = legacy ? EVP_MD_get0_name(legacy) : name;
  if (legacy == EVP_md_null() || !canonical) return {nullptr, EVP_MD_free};
  DigestOwner md(EVP_MD_fetch(nullptr, canonical, nullptr), EVP_MD_free);
  if (md && EVP_MD_is_a(md.get(), "NULL")) md.reset();
  // Fetch is an availability query, like ncrypto::Digest::Fetch. Its failed
  // lookup must not contaminate the next operation's error queue.
  ERR_clear_error(); return md;
}
inline Bytes Digest(const std::string& algorithm, const Bytes& input,
                    std::optional<uint32_t> requested, bool digestOptions) {
  ERR_clear_error();
  auto md = Fetch(algorithm.c_str());
  if (!md) throw Error("Digest method " + algorithm + " is not supported");
  const int size = EVP_MD_get_size(md.get());
  const bool xof = (EVP_MD_get_flags(md.get()) & EVP_MD_FLAG_XOF) != 0;
  size_t length = size > 0 ? size_t(size) : 0;
  if (!xof && requested && *requested != length)
    throw Error("Output length " + std::to_string(*requested) + " is invalid for " + algorithm + ", which does not support XOF");
  if (xof && requested) length = *requested;
  else if (xof && !length) {
    if (EVP_MD_is_a(md.get(), "SHAKE128")) length = 16;
    else if (EVP_MD_is_a(md.get(), "SHAKE256")) length = 32;
  }
  // The selected OpenSSL 3.x has no cSHAKE customization interface.
  // Pinned Node rejects these options on pre-4 too.
  if (digestOptions) throw Error("Digest options are not supported");
  Bytes output;
  if (length == 0) return output;
  output.value.resize(length);
  ContextOwner ctx(EVP_MD_CTX_new(), EVP_MD_CTX_free);
  if (!ctx || EVP_DigestInit_ex(ctx.get(), md.get(), nullptr) != 1 ||
      EVP_DigestUpdate(ctx.get(), input.value.data(), input.value.size()) != 1)
    Fail("Digest update failed");
  if (xof) {
    if (EVP_DigestFinalXOF(ctx.get(), output.value.data(), length) != 1) Fail("Digest final failed");
  } else {
    unsigned int written = 0;
    if (EVP_DigestFinal_ex(ctx.get(), output.value.data(), &written) != 1) Fail("Digest final failed");
    if (written != length) throw Error("Digest backend returned an inconsistent length");
  }
  return output;
}
inline bool Equal(const Bytes& a, const Bytes& b) {
  if (a.value.size() != b.value.size()) throw std::length_error("Input buffers must have the same byte length");
  return CRYPTO_memcmp(a.value.data(), b.value.data(), a.value.size()) == 0;
}
struct Names {
  std::vector<std::string> values;
  std::exception_ptr failure;
  void Add(const char* name, bool normalize = false) noexcept {
    if (!name || failure) return;
    try {
      std::string value(name);
      if (normalize) {
        bool dotted = value.find('.') != std::string::npos &&
            std::all_of(value.begin(), value.end(), [](unsigned char c) { return (c >= '0' && c <= '9') || c == '.'; });
        if (dotted) return;
        for (char& c : value) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
      }
      if (Fetch(value.c_str())) values.push_back(std::move(value));
    } catch (...) { failure = std::current_exception(); }
  }
};
inline std::vector<std::string> DigestNames() {
  Names names;
  EVP_MD_do_all_sorted([](const EVP_MD*, const char* from, const char*, void* data) {
    static_cast<Names*>(data)->Add(from);
  }, &names);
  EVP_MD_do_all_provided(nullptr, [](EVP_MD* md, void* data) {
    EVP_MD_names_do_all(md, [](const char* name, void* data) { static_cast<Names*>(data)->Add(name, true); }, data);
  }, &names);
  if (names.failure) std::rethrow_exception(names.failure);
  return names.values;
}
}  // namespace kandelo::crypto
#endif
