// Actual OpenSSL password derivation and validation over owned, cleansed bytes.
#ifndef KANDELO_NODE_KDF_OPERATIONS_H
#define KANDELO_NODE_KDF_OPERATIONS_H
#include <climits>
#include <cstdint>
#include <memory>
#include <openssl/core_names.h>
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/params.h>
#include <openssl/thread.h>
#include <string>
#include "kandelo-node-digest-operations.h"
namespace kandelo::crypto {
struct KdfError : Error {
  enum class Type { Error, TypeError, RangeError } type;
  KdfError(const std::string& message, const char* code, Type type)
      : Error(message), type(type) { this->code = code; stack.clear(); }
};
struct KdfOperation {
  virtual ~KdfOperation() = default;
  virtual Bytes Derive() const = 0;
  virtual const char* Name() const = 0;
  virtual uint64_t InputBytes() const = 0;
  virtual uint64_t OutputBytes() const = 0;
  virtual size_t ConfigBytes() const = 0;
};
struct KdfConfig;
inline Bytes DeriveKdf(const KdfConfig& config);
struct KdfConfig final : KdfOperation {
  enum class Algorithm { Pbkdf2, Scrypt, Argon2 } algorithm;
  Bytes password, salt, secret, associatedData;
  const EVP_MD* digest = nullptr;
  uint32_t iterations = 0, length = 0, N = 0, r = 0, p = 0;
  uint64_t maxmem = 0;
  uint32_t lanes = 0, memory = 0, passes = 0, type = 0;
  explicit KdfConfig(Algorithm algorithm) : algorithm(algorithm) {}
  void SetDigest(const std::string& name) {
    // Node's constructor resolves the legacy name first. Fetch/provider
    // rejection belongs to derivation, not eager availability filtering.
    digest = EVP_get_digestbyname(name.c_str());
    if (!digest) throw KdfError("Invalid digest: " + name,
        "ERR_CRYPTO_INVALID_DIGEST", KdfError::Type::TypeError);
  }
  void CheckScrypt() const {
    ERR_clear_error();
    if (EVP_PBE_scrypt(nullptr, 0, nullptr, 0, N, r, p, maxmem, nullptr, 0) == 1) return;
    // Preserve the actual provider's last validation error, like the target's
    // AdditionalConfig. No fixed approximation of its memory-cost formula.
    const auto error = ERR_peek_last_error();
    std::string message = "Invalid scrypt params";
    if (error) { char text[256]; ERR_error_string_n(error, text, sizeof(text)); message += ": "; message += text; }
    throw KdfError(message, "ERR_CRYPTO_INVALID_SCRYPT_PARAMS", KdfError::Type::RangeError);
  }
  Bytes Derive() const override { return DeriveKdf(*this); }
  const char* Name() const override {
    return algorithm == Algorithm::Pbkdf2 ? "pbkdf2" : algorithm == Algorithm::Scrypt ? "scrypt" : "argon2";
  }
  uint64_t OutputBytes() const override { return length; }
  size_t ConfigBytes() const override { return sizeof(*this); }
  uint64_t InputBytes() const override {
    return uint64_t(password.value.size()) + salt.value.size() + secret.value.size() + associatedData.value.size();
  }
};
inline bool Argon2Supported() {
#if !defined(OPENSSL_NO_ARGON2) && OPENSSL_VERSION_NUMBER >= 0x30200000L
  return true;
#else
  return false;
#endif
}
[[noreturn]] inline void ThrowKdfFailure(const char* message) {
  const auto number = ERR_get_error();
  Error error(message, number);
  if (number) { char text[256]; ERR_error_string_n(number, text, sizeof(text)); error.stack.insert(error.stack.begin(), text); }
  std::reverse(error.stack.begin(), error.stack.end());
  throw error;
}
inline Bytes DeriveArgon2(const KdfConfig& config) {
  ERR_clear_error();
  Bytes result;
  if (!config.length) return result;
#if !defined(OPENSSL_NO_ARGON2) && OPENSSL_VERSION_NUMBER >= 0x30200000L
  const char* algorithm;
  switch (config.type) {
    case 0: algorithm = "ARGON2D"; break;
    case 1: algorithm = "ARGON2I"; break;
    case 2: algorithm = "ARGON2ID"; break;
    default: ThrowKdfFailure("Argon2 derivation failed");
  }
  using Context = std::unique_ptr<OSSL_LIB_CTX, decltype(&OSSL_LIB_CTX_free)>;
  using Kdf = std::unique_ptr<EVP_KDF, decltype(&EVP_KDF_free)>;
  using Job = std::unique_ptr<EVP_KDF_CTX, decltype(&EVP_KDF_CTX_free)>;
  Context context(nullptr, OSSL_LIB_CTX_free);
  uint32_t lanes = config.lanes, threads = lanes == 0 ? 0 : 1;
  // A private thread-pool context must not bypass the default context's
  // provider/FIPS policy. Lanes are algorithm inputs, independent of threads.
  if (lanes > 1 && (OSSL_get_thread_support_flags() & OSSL_THREAD_SUPPORT_FLAG_DEFAULT_SPAWN)) {
    Kdf available(EVP_KDF_fetch(nullptr, algorithm, nullptr), EVP_KDF_free);
    if (!available) ThrowKdfFailure("Argon2 derivation failed");
    context.reset(OSSL_LIB_CTX_new());
    if (!context) ThrowKdfFailure("Argon2 derivation failed");
    const bool marked = ERR_set_mark() == 1;
    if (OSSL_set_max_threads(context.get(), lanes) == 1) threads = lanes;
    else context.reset();
    if (marked) ERR_pop_to_mark(); else ERR_clear_error();
  }
  Kdf kdf(EVP_KDF_fetch(context.get(), algorithm, nullptr), EVP_KDF_free);
  Job job(kdf ? EVP_KDF_CTX_new(kdf.get()) : nullptr, EVP_KDF_CTX_free);
  if (!job) ThrowKdfFailure("Argon2 derivation failed");
  auto bytes = [](const Bytes& value) -> void* {
    if (value.value.empty()) return const_cast<char*>("");
    return const_cast<unsigned char*>(value.value.data());
  };
  uint32_t memory = config.memory, passes = config.passes;
  std::vector<OSSL_PARAM> params = {
    OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_PASSWORD, bytes(config.password), config.password.value.size()),
    OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, bytes(config.salt), config.salt.value.size()),
    OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_THREADS, &threads),
    OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ARGON2_LANES, &lanes),
    OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ARGON2_MEMCOST, &memory),
    OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ITER, &passes),
  };
  if (!config.associatedData.value.empty()) params.push_back(OSSL_PARAM_construct_octet_string(
      OSSL_KDF_PARAM_ARGON2_AD, bytes(config.associatedData), config.associatedData.value.size()));
  if (!config.secret.value.empty()) params.push_back(OSSL_PARAM_construct_octet_string(
      OSSL_KDF_PARAM_SECRET, bytes(config.secret), config.secret.value.size()));
  params.push_back(OSSL_PARAM_construct_end());
  struct ClearOutput {
    size_t size;
    void operator()(unsigned char* data) const { OPENSSL_clear_free(data, size); }
  };
  std::unique_ptr<unsigned char, ClearOutput> output(
      static_cast<unsigned char*>(OPENSSL_zalloc(config.length)), ClearOutput{config.length});
  if (!output || EVP_KDF_derive(job.get(), output.get(), config.length, params.data()) != 1)
    ThrowKdfFailure("Argon2 derivation failed");
  result.value.assign(output.get(), output.get() + config.length);
  return result;
#else
  throw KdfError("Argon2 is not supported", "ERR_CRYPTO_ARGON2_NOT_SUPPORTED", KdfError::Type::Error);
#endif
}
inline Bytes DeriveKdf(const KdfConfig& config) {
  if (config.algorithm == KdfConfig::Algorithm::Argon2) return DeriveArgon2(config);
  ERR_clear_error();
  Bytes result;
  // scrypt validates options even for zero output, but skips actual derivation.
  if (config.algorithm == KdfConfig::Algorithm::Scrypt && !config.length) return result;
  if (config.password.value.size() > INT_MAX || config.salt.value.size() > INT_MAX || config.length > INT_MAX)
    throw KdfError("KDF input is too large", "ERR_OUT_OF_RANGE", KdfError::Type::RangeError);
  struct ReleaseOutput {
    size_t length;
    void operator()(unsigned char* data) const { OPENSSL_clear_free(data, length); }
  };
  // Use the target DataPointer::Alloc primitive. OPENSSL_zalloc(0) may
  // return null; a fabricated one-byte allocation would turn its real
  // PBKDF2 failure into an empty successful result.
  std::unique_ptr<unsigned char, ReleaseOutput> output(
      static_cast<unsigned char*>(OPENSSL_zalloc(config.length)), ReleaseOutput{config.length});
  const char* password = config.password.value.empty() ? "" : reinterpret_cast<const char*>(config.password.value.data());
  const auto* salt = config.salt.value.empty() ? reinterpret_cast<const unsigned char*>("") : config.salt.value.data();
  int status = 0;
  if (output && config.algorithm == KdfConfig::Algorithm::Pbkdf2) {
    // Match the pinned provider-backed ncrypto path, including its real
    // zero-length rejection and XOF error. The legacy convenience function
    // changes both behaviors even when linked to the same OpenSSL build.
    using KdfOwner = std::unique_ptr<EVP_KDF, decltype(&EVP_KDF_free)>;
    using KdfContext = std::unique_ptr<EVP_KDF_CTX, decltype(&EVP_KDF_CTX_free)>;
    KdfOwner kdf(EVP_KDF_fetch(nullptr, OSSL_KDF_NAME_PBKDF2, nullptr), EVP_KDF_free);
    KdfContext context(kdf ? EVP_KDF_CTX_new(kdf.get()) : nullptr, EVP_KDF_CTX_free);
    int pkcs5 = 1, iterations = int(config.iterations);
    const char* digest = EVP_MD_get0_name(config.digest);
    OSSL_PARAM params[] = {
        OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_PASSWORD, const_cast<char*>(password), config.password.value.size()),
        OSSL_PARAM_construct_int(OSSL_KDF_PARAM_PKCS5, &pkcs5),
        OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT, const_cast<unsigned char*>(salt), config.salt.value.size()),
        OSSL_PARAM_construct_int(OSSL_KDF_PARAM_ITER, &iterations),
        OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST, const_cast<char*>(digest), 0),
        OSSL_PARAM_END,
    };
    status = output && context && digest ? EVP_KDF_derive(context.get(), output.get(), config.length, params) : 0;
  } else if (output) {
    status = EVP_PBE_scrypt(password, config.password.value.size(), salt, config.salt.value.size(),
        config.N, config.r, config.p, config.maxmem, output.get(), config.length);
  }
  if (status != 1) {
    ThrowKdfFailure(config.algorithm == KdfConfig::Algorithm::Pbkdf2 ? "PBKDF2 derivation failed" : "scrypt derivation failed");
  }
  result.value.assign(output.get(), output.get() + config.length);
  return result;
}
}  // namespace kandelo::crypto
#endif
