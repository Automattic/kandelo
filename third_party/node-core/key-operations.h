#ifndef KANDELO_NODE_KEY_OPERATIONS_H
#define KANDELO_NODE_KEY_OPERATIONS_H
#include <climits>
#include <cstring>
#include <ncrypto.h>
#include <openssl/buffer.h>
#include <openssl/core_names.h>
#include <string>
#include "kandelo-node-digest-operations.h"
namespace kandelo::crypto {
struct KeyError : Error {
  explicit KeyError(const char* message, const char* code) : Error(message) { this->code = code; }
};
// One immutable material owner, shared by real engine GC edges. Public/private
// roles belong to handle wrappers, not to forged JavaScript metadata.
struct KeyMaterial {
  ncrypto::DataPointer secret;
  ncrypto::EVPKeyPointer asymmetric;
  bool isSecret = false;
  size_t AccountedBytes() const { return sizeof(*this) + secret.size(); }
  static std::unique_ptr<KeyMaterial> Secret(const Bytes& bytes) {
    auto result = std::make_unique<KeyMaterial>(); result->isSecret = true;
    result->secret = ncrypto::DataPointer::Copy({bytes.value.data(), bytes.value.size()});
    if (!result->secret && !bytes.value.empty()) throw std::bad_alloc();
    return result;
  }
  using Key = ncrypto::EVPKeyPointer;
  using Format = Key::PKFormatType;
  using Encoding = Key::PKEncodingType;
  using Config = Key::PrivateKeyEncodingConfig;
  static Config Configuration(int format, int encoding, const Bytes* passphrase, const char* cipher = nullptr) {
    Config config; config.format = Format(format); config.type = Encoding(encoding);
    if (passphrase) config.passphrase = ncrypto::DataPointer::Copy({passphrase->value.data(), passphrase->value.size()});
    if (passphrase && !config.passphrase.value() && !passphrase->value.empty()) throw std::bad_alloc();
    if (cipher) {
      config.cipher = ncrypto::Cipher::FromNameForKeyEncoding(cipher);
      if (!config.cipher) throw KeyError("Unknown cipher", "ERR_CRYPTO_UNKNOWN_CIPHER");
    }
    return config;
  }
  [[noreturn]] static void ParseFailure(const Key::ParseKeyResult& result, bool privateKey) {
    if (result.error == Key::PKParseError::NEED_PASSPHRASE)
      throw KeyError("Passphrase required for encrypted key", "ERR_MISSING_PASSPHRASE");
    const auto number = result.openssl_error.value_or(0);
    if (number) { char message[256]; ERR_error_string_n(number, message, sizeof(message)); throw Error(message, number); }
    throw Error(privateKey ? "Failed to read private key" : "Failed to read asymmetric key");
  }
  static std::unique_ptr<KeyMaterial> Parse(bool privateKey, const Bytes& bytes, Config config) {
    if (bytes.value.size() > INT_MAX) throw KeyError("keyData is too big", "ERR_OUT_OF_RANGE");
    auto result = std::make_unique<KeyMaterial>();
    ncrypto::Buffer<const unsigned char> input{bytes.value.data(), bytes.value.size()};
    if (!privateKey && config.format == Format::PEM) {
      auto parsed = Key::TryParsePublicKeyPEM(input);
      if (parsed) { result->asymmetric = std::move(parsed.value); return result; }
      if (parsed.error != Key::PKParseError::NOT_RECOGNIZED) ParseFailure(parsed, false);
    } else if (!privateKey && (config.type == Encoding::SPKI ||
        (config.type == Encoding::PKCS1 && !Key::IsRSAPrivateKey(input)))) {
      auto parsed = Key::TryParsePublicKey(config, input);
      if (!parsed) ParseFailure(parsed, false);
      result->asymmetric = std::move(parsed.value); return result;
    }
    auto parsed = Key::TryParsePrivateKey(config, input);
    if (!parsed) ParseFailure(parsed, true);
    result->asymmetric = std::move(parsed.value); return result;
  }
  ncrypto::DataPointer Export(Config config, bool privateKey) const {
    auto result = privateKey ? asymmetric.writePrivateKey(config) : asymmetric.writePublicKey(config);
    if (!result) Fail(privateKey ? "Failed to encode private key" : "Failed to encode public key");
    BUF_MEM* memory = result.value;
    if (!memory) throw std::bad_alloc();
    auto copy = ncrypto::DataPointer::Copy({memory->data, memory->length});
    if (!copy && memory->length) throw std::bad_alloc();
    return copy;
  }
  bool Equals(const KeyMaterial& other) const {
    if (isSecret != other.isSecret) return false;
    if (isSecret) return secret.size() == other.secret.size() &&
        (!secret.size() || CRYPTO_memcmp(secret.get(), other.secret.get(), secret.size()) == 0);
    const int equal = EVP_PKEY_eq(asymmetric.get(), other.asymmetric.get());
    if (equal == -2) throw KeyError("Unsupported operation", "ERR_CRYPTO_UNSUPPORTED_OPERATION");
    return equal == 1;
  }
};
}  // namespace kandelo::crypto
#endif
