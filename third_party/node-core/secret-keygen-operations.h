#ifndef KANDELO_NODE_SECRET_KEYGEN_OPERATIONS_H
#define KANDELO_NODE_SECRET_KEYGEN_OPERATIONS_H
#include "kandelo-node-key-operations.h"
namespace kandelo::crypto {
// Public HMAC/AES jobs use whole bytes, exactly SecretKeyGenTraits' non-WebCrypto
// branch. DataPointer owns the original allocation and clears it on destruction.
inline std::unique_ptr<KeyMaterial> GenerateSecretKey(uint32_t bits) {
  const size_t length = bits / CHAR_BIT;
  auto output = ncrypto::DataPointer::Alloc(length);
  if (!output && length) throw std::bad_alloc();
  if (!ncrypto::CSPRNG(output.get(), length)) {
    auto errors = Error::Capture();
    if (errors.errors_.empty()) errors.Insert("Key generation job failed");
    throw Error::FromCaptured(std::move(errors));
  }
  auto material = std::make_unique<KeyMaterial>();
  material->isSecret = true;
  material->secret = std::move(output);
  return material;
}
}  // namespace kandelo::crypto
#endif
