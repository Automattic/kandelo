#ifndef KANDELO_NODE_KEY_OPERATIONS_H
#define KANDELO_NODE_KEY_OPERATIONS_H
#include <climits>
#include <cstring>
#include <ncrypto.h>
#include <mutex>
#include <openssl/buffer.h>
#include <openssl/core_names.h>
#include <string>
#include "kandelo-node-digest-operations.h"
#include "kandelo-node-string-bytes.h"
namespace kandelo::crypto {
struct KeyError : Error {
  explicit KeyError(const char* message, const char* code) : Error(message) { this->code = code; }
};
// JWK bytes use the exact pinned nbytes lenient decoder, not a JavaScript
// Buffer callback. UTF-16 code units reach the same low-byte fallback as Node.
namespace jwk_codec {
template <typename Char>
inline Bytes Decode(const Char* input, size_t length) {
  Bytes output;
  const size_t capacity = kandelo::encoding::bytes::Base64DecodedSize(input, length);
  output.value.resize(capacity);
  if (capacity) output.value.resize(kandelo::encoding::bytes::Base64Decode(
      reinterpret_cast<char*>(output.value.data()), capacity, input, length));
  return output;
}
inline std::string Encode(const void* input, size_t length) {
  constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const auto* bytes = static_cast<const unsigned char*>(input);
  std::string output;
  const size_t groups = length / 3, remainder = length % 3;
  if (groups > output.max_size() / 4) throw std::bad_alloc();
  const size_t prefix = groups * 4, suffix = remainder ? remainder + 1 : 0;
  if (suffix > output.max_size() - prefix) throw std::bad_alloc();
  output.reserve(prefix + suffix);
  for (size_t i = 0; i < length;) {
    const unsigned a = bytes[i++];
    const bool haveB = i < length; const unsigned b = haveB ? bytes[i++] : 0;
    const bool haveC = i < length; const unsigned c = haveC ? bytes[i++] : 0;
    output.push_back(alphabet[a >> 2]);
    output.push_back(alphabet[((a & 3) << 4) | (b >> 4)]);
    if (haveB) output.push_back(alphabet[((b & 15) << 2) | (c >> 6)]);
    if (haveC) output.push_back(alphabet[c & 63]);
  }
  return output;
}
}  // namespace jwk_codec

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
  // Match the pinned crypto_keys.cc raw importer. Decoding and EC public-key
  // derivation operate on actual ncrypto/OpenSSL material, never metadata.
  static std::unique_ptr<KeyMaterial> Raw(const Bytes& bytes, Format format,
                                          const std::string& type,
                                          const std::string& curve) {
    if (bytes.value.size() > INT_MAX)
      throw KeyError("keyData is too big", "ERR_OUT_OF_RANGE");
    const auto* algorithm = ncrypto::KeyAlgorithm::FromName(type.c_str());
    if (!algorithm || !algorithm->keyTypeName() || type != algorithm->keyTypeName()) {
      const auto message = "Invalid asymmetricKeyType: " + type;
      throw KeyError(message.c_str(), "ERR_INVALID_ARG_VALUE");
    }
    if (algorithm->isPqc() && !algorithm->isAvailable())
      throw KeyError("Unsupported key type", "ERR_INVALID_ARG_VALUE");
    const auto privateFormat = algorithm->seedSize() != 0 ? Format::RAW_SEED : Format::RAW_PRIVATE;
    if (!(algorithm == &ncrypto::KeyAlgorithm::EC || algorithm->supportsRawPublic()) ||
        (format != Format::RAW_PUBLIC && format != privateFormat))
      throw KeyError("The selected key encoding is incompatible with the key type",
                     "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    auto invalid = []() -> void {
      throw KeyError("Invalid key data", "ERR_INVALID_ARG_VALUE");
    };
    auto result = std::make_unique<KeyMaterial>();
    ncrypto::Buffer<const unsigned char> input{bytes.value.data(), bytes.value.size()};
    if (algorithm == &ncrypto::KeyAlgorithm::EC) {
      const int nid = ncrypto::Ec::GetCurveIdFromName(curve.c_str());
      if (nid == NID_undef)
        throw KeyError("Invalid EC curve name", "ERR_CRYPTO_INVALID_CURVE");
      auto ec = ncrypto::ECKeyPointer::NewByCurveName(nid);
      if (!ec) invalid();
      const auto group = ec.getGroup();
      auto point = ncrypto::ECPointPointer::New(group);
      if (!point) invalid();
      if (format == Format::RAW_PUBLIC) {
        if (!point.setFromBuffer(input, group) || !ec.setPublicKey(point)) invalid();
      } else {
        auto order = ncrypto::BignumPointer::New();
        if (!order || !EC_GROUP_get_order(group, order.get(), nullptr)) invalid();
        if (bytes.value.size() != order.byteLength()) invalid();
        ncrypto::BignumPointer scalar(input.data, input.len);
        if (!scalar || !ec.setPrivateKey(scalar) || !point.mul(group, scalar.get()) ||
            !ec.setPublicKey(point)) invalid();
      }
      result->asymmetric = Key::New();
      if (!result->asymmetric || !result->asymmetric.assign(ec)) invalid();
#if NCRYPTO_USE_LEGACY_KEY_TYPES
      ec.release();
#endif
    } else if (format == Format::RAW_PUBLIC) {
      result->asymmetric = Key::NewRawPublic(*algorithm, input);
    } else if (algorithm->seedSize() != 0) {
      result->asymmetric = Key::NewRawSeed(*algorithm, input);
    } else {
      result->asymmetric = Key::NewRawPrivate(*algorithm, input);
    }
    if (!result->asymmetric) invalid();
    return result;
  }
  // JWK material is constructed by the same pinned ncrypto primitives as
  // crypto_{rsa,ec,keys}.cc. JavaScript getters and codecs stay at the engine
  // boundary; no imported JSON survives as key state.
  static ncrypto::BignumPointer JwkBN(const Bytes& bytes) {
    return ncrypto::BignumPointer(bytes.value.data(), bytes.value.size());
  }
  [[noreturn]] static void InvalidJwk(const char* kind) {
    const auto message = std::string("Invalid JWK ") + kind + " key";
    throw KeyError(message.c_str(), "ERR_CRYPTO_INVALID_JWK");
  }
  static const ncrypto::KeyAlgorithm* JwkAlgorithm(const std::string& name, bool akp) {
    const auto* algorithm = ncrypto::KeyAlgorithm::FromName(name.c_str());
    if (!algorithm || (akp ? !algorithm->isPqc() || !algorithm->isAvailable() : !algorithm->isOkp()) ||
        std::strcmp(name.c_str(), algorithm->name()) != 0) {
      if (akp) throw KeyError("Unsupported JWK AKP \"alg\"", "ERR_CRYPTO_INVALID_JWK");
      InvalidJwk("OKP");
    }
    return algorithm;
  }
  static int JwkCurve(const std::string& curve) {
    const int nid = ncrypto::Ec::GetCurveIdFromName(curve.c_str());
    if (nid == NID_undef) throw KeyError("Invalid EC curve name", "ERR_CRYPTO_INVALID_CURVE");
    return nid;
  }
  static std::unique_ptr<KeyMaterial> JwkEc(int nid, const Bytes& x, const Bytes& y, const Bytes* d) {
    auto ec = ncrypto::ECKeyPointer::NewByCurveName(nid);
    if (!ec || !ec.setPublicKeyRaw(JwkBN(x), JwkBN(y))) InvalidJwk("EC");
    if (d && (!ec.setPrivateKey(JwkBN(*d)) || !ec.checkPrivateKey())) InvalidJwk("EC");
    auto result = std::make_unique<KeyMaterial>();
    result->asymmetric = Key::New();
    if (!result->asymmetric || !result->asymmetric.set(ec)) InvalidJwk("EC");
    return result;
  }
  static std::unique_ptr<KeyMaterial> JwkRaw(const ncrypto::KeyAlgorithm& algorithm,
                                           const Bytes& publicBytes, const Bytes* privateBytes) {
    std::optional<ncrypto::Buffer<const unsigned char>> privateKey;
    if (privateBytes) privateKey = {privateBytes->value.data(), privateBytes->value.size()};
    auto result = std::make_unique<KeyMaterial>();
    result->asymmetric = Key::NewRawJwk(algorithm, {publicBytes.value.data(), publicBytes.value.size()}, privateKey);
    if (!result->asymmetric) InvalidJwk(algorithm.isPqc() ? "AKP" : "OKP");
    return result;
  }
  static std::unique_ptr<KeyMaterial> JwkRsa(ncrypto::Rsa& rsa) {
    auto result = std::make_unique<KeyMaterial>();
#if NCRYPTO_USE_OPENSSL3_PROVIDER
    result->asymmetric = Key::NewRSA(rsa);
#else
    // The owner is built with the pinned OpenSSL 3 provider API. Other backends
    // must retain their RSA pointer until NewRSA takes ownership.
    throw KeyError("RSA JWK requires the OpenSSL provider owner", "ERR_METHOD_NOT_IMPLEMENTED");
#endif
    if (!result->asymmetric) throw KeyError("Unable to create key pointer", "ERR_CRYPTO_OPERATION_FAILED");
    return result;
  }
  Key::RawJwkData ExportJwkRaw(bool privateKey) const {
    auto result = asymmetric.exportRawJwk(privateKey);
    if (!result) throw KeyError(result.error == Key::RawExportError::MISSING_SEED ?
        "key does not have an available seed" : "Failed to export JWK", "ERR_CRYPTO_OPERATION_FAILED");
    return std::move(result.value);
  }
  static ncrypto::DataPointer JwkEncodeBN(const BIGNUM* value, size_t size = 0) {
    if (!size) size = ncrypto::BignumPointer::GetByteCount(value);
    auto bytes = ncrypto::DataPointer::Alloc(size);
    if (!bytes && size) throw std::bad_alloc();
    if (ncrypto::BignumPointer::EncodePaddedInto(value, bytes.get<unsigned char>(), size) != size)
      throw KeyError("Failed to export JWK", "ERR_CRYPTO_OPERATION_FAILED");
    return bytes;
  }
  ncrypto::DataPointer Export(Config config, bool privateKey) const {
    // Import has loaded the actual provider. Node configures its PQC encoding
    // policy once during crypto initialization; do the same before this owner's
    // first serialization. Concurrent exports must not mutate provider options.
    static std::once_flag encodingPolicy;
    std::call_once(encodingPolicy, ncrypto::ConfigurePqcEncoding);
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
