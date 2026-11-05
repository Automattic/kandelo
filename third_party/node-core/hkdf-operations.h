// HKDF uses the exact Node-vendored ncrypto implementation and owned bytes.
#ifndef KANDELO_NODE_HKDF_OPERATIONS_H
#define KANDELO_NODE_HKDF_OPERATIONS_H
#include <ncrypto.h>
#include "kandelo-node-kdf-operations.h"
namespace kandelo::crypto {
struct HkdfOperation final : KdfOperation {
  ncrypto::Digest digest;
  Bytes key, salt, info;
  uint32_t length = 0;
  bool keyFromHandle = false;
  void SetDigest(const char* name) {
    digest = ncrypto::Digest::FromName(name);
    if (!digest) throw KdfError(std::string("Invalid digest: ") + name,
        "ERR_CRYPTO_INVALID_DIGEST", KdfError::Type::TypeError);
  }
  void CheckLength() const {
    if (!ncrypto::checkHkdfLength(digest, length)) throw KdfError(
        "Invalid key length", "ERR_CRYPTO_INVALID_KEYLEN", KdfError::Type::RangeError);
  }
  const char* Name() const override { return "hkdf"; }
  uint64_t OutputBytes() const override { return length; }
  uint64_t InputBytes() const override {
    return uint64_t(key.value.size()) + salt.value.size() + info.value.size();
  }
  size_t ConfigBytes() const override { return sizeof(*this); }
  Bytes Derive() const override {
    ERR_clear_error();
    auto derived = ncrypto::hkdf(digest, {key.value.data(), key.value.size()},
        {info.value.data(), info.value.size()}, {salt.value.data(), salt.value.size()}, length);
    if (!derived) ThrowKdfFailure("HKDF derivation failed");
    Bytes result;
    result.value.assign(derived.get<const unsigned char>(), derived.get<const unsigned char>() + derived.size());
    return result;
  }
};
}  // namespace kandelo::crypto
#endif
