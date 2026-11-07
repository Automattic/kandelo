#ifndef KANDELO_NODE_SIGNATURE_OPERATIONS_H
#define KANDELO_NODE_SIGNATURE_OPERATIONS_H
#include "kandelo-node-key-operations.h"
#include <cstdlib>
#include <openssl/rsa.h>
namespace kandelo::crypto {
// Port of the pinned crypto_sig.cc streaming state and finalization policy.
// The complete public wrapper remains unchanged. Contexts own provider state;
// no accumulated JS payload or native-host signature delegation is used.
struct SignatureState {
  ncrypto::EVPMDCtxPointer context;
  [[noreturn]] static void Code(const char* code, const char* message) {
    KeyError failure(message, code); failure.stack.clear(); throw failure;
  }
  [[noreturn]] static void ProviderFailure(const char* fallback) {
    const auto number = ERR_get_error();
    if (number) {
      char message[256]; ERR_error_string_n(number, message, sizeof(message));
      throw Error(message, number);
    }
    Code("ERR_CRYPTO_OPERATION_FAILED", fallback);
  }
  void Init(const char* algorithm) {
    if (context) std::abort(); // pinned CHECK_NULL(mdctx_)
    const auto digest = ncrypto::Digest::FromName(algorithm);
    if (!digest) Code("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest");
    context = ncrypto::EVPMDCtxPointer::New();
    if (!context.digestInit(digest)) {
      context.reset(); ProviderFailure("EVP_SignInit_ex failed");
    }
  }
  void Update(const unsigned char* data, size_t length) {
    if (length > INT_MAX) Code("ERR_OUT_OF_RANGE", "data is too long");
    if (!context) Code("ERR_CRYPTO_INVALID_STATE", "Not initialised");
    if (!context.digestUpdate({data, length})) ProviderFailure("EVP_SignUpdate failed");
  }
  static void CheckKey(const ncrypto::EVPKeyPointer& key) {
    const auto* algorithm = key.getAlgorithm();
    if (algorithm && algorithm->isOneShot())
      Code("ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation");
  }
  static bool RSAOptions(const ncrypto::EVPKeyPointer& key, EVP_PKEY_CTX* context,
                          int padding, std::optional<int> salt) {
    return !key.isRsaVariant() || ncrypto::EVPKeyCtxPointer::setRsaPadding(context, padding, salt);
  }
  static std::vector<unsigned char> ToP1363(const ncrypto::EVPKeyPointer& key,
                                           std::vector<unsigned char>&& signature) {
    const auto width = key.getBytesOfRS();
    if (!width) return std::move(signature);
    std::vector<unsigned char> output(size_t(*width) * 2);
    if (!ncrypto::extractP1363({signature.data(), signature.size()}, output.data(), *width))
      return std::move(signature);
    return output;
  }
  static std::vector<unsigned char> ToDER(const ncrypto::EVPKeyPointer& key,
                                         const unsigned char* bytes, size_t length) {
    const auto width = key.getBytesOfRS();
    if (!width) return length ? std::vector<unsigned char>(bytes, bytes + length) : std::vector<unsigned char>{};
    if (length != size_t(*width) * 2)
      Code("ERR_CRYPTO_OPERATION_FAILED", "Malformed signature");
    auto signature = ncrypto::ECDSASigPointer::New();
    ncrypto::BignumPointer r(bytes, *width), s(bytes + *width, *width);
    // These are the pinned native CHECK allocations/ownership transfers.
    if (!signature || !r || !s || !signature.setParams(std::move(r), std::move(s))) std::abort();
    auto encoded = signature.encode();
    if (encoded.len <= 0 || !encoded.data)
      Code("ERR_CRYPTO_OPERATION_FAILED", "Malformed signature");
    ncrypto::DataPointer owner(encoded.data, encoded.len);
    const auto* start = owner.get<unsigned char>();
    return std::vector<unsigned char>(start, start + owner.size());
  }
  std::vector<unsigned char> Sign(const ncrypto::EVPKeyPointer& key, int padding,
                                  std::optional<int> salt, bool p1363) {
    if (!context) Code("ERR_CRYPTO_INVALID_STATE", "Not initialised");
    auto digestContext = std::move(context);
    if (!key.validateDsaParameters()) ProviderFailure("PEM_read_bio_PrivateKey failed");
    auto digest = digestContext.digestFinal(digestContext.getExpectedSize());
    if (!digest) ProviderFailure("PEM_read_bio_PrivateKey failed");
    std::vector<unsigned char> signature(key.size());
    ncrypto::Buffer<unsigned char> output{signature.data(), signature.size()};
    auto keyContext = key.newCtx();
    if (!(keyContext.initForSign() > 0 && RSAOptions(key, keyContext.get(), padding, salt) &&
          keyContext.setSignatureMd(digestContext) && keyContext.signInto(digest, &output)))
      ProviderFailure("PEM_read_bio_PrivateKey failed");
    if (output.len > signature.size()) std::abort(); // pinned CHECK_LE
    signature.resize(output.len);
    return p1363 ? ToP1363(key, std::move(signature)) : std::move(signature);
  }
  bool Verify(const ncrypto::EVPKeyPointer& key, const unsigned char* signature,
               size_t length, int padding, std::optional<int> salt, bool p1363) {
    // The pinned caller converts P1363 before consuming the digest context.
    std::vector<unsigned char> der;
    if (p1363) { der = ToDER(key, signature, length); signature = der.data(); length = der.size(); }
    if (!context) Code("ERR_CRYPTO_INVALID_STATE", "Not initialised");
    auto digestContext = std::move(context);
    auto digest = digestContext.digestFinal(digestContext.getExpectedSize());
    if (!digest) ProviderFailure("PEM_read_bio_PUBKEY failed");
    auto keyContext = key.newCtx();
    if (keyContext) {
      const int initialized = keyContext.initForVerify();
      if (initialized == -2) ProviderFailure("PEM_read_bio_PUBKEY failed");
      if (initialized > 0 && RSAOptions(key, keyContext.get(), padding, salt) &&
          keyContext.setSignatureMd(digestContext))
        return keyContext.verify({signature, length}, digest);
    }
    return false;
  }
};
}  // namespace kandelo::crypto
#endif
