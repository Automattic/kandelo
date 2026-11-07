#ifndef KANDELO_NODE_RSA_OPERATIONS_H
#define KANDELO_NODE_RSA_OPERATIONS_H
#include "kandelo-node-key-operations.h"
#include <openssl/rsa.h>
#include <cstdlib>
namespace kandelo::crypto {
enum class RsaOperation { Encrypt, Decrypt, Sign, Recover };
[[noreturn]] inline void ThrowRsaError() {
  const auto number=ERR_get_error();char message[128]={0};
  ERR_error_string_n(number,message,sizeof(message));throw Error(message,number);
}
inline void RsaImplicitRejection(const ncrypto::EVPKeyPointer& key,RsaOperation operation,uint32_t padding) {
  if(operation!=RsaOperation::Decrypt||padding!=RSA_PKCS1_PADDING)return;
  auto context=key.newCtx();
  // The pinned native owner requires a real key context, not a fabricated
  // backend feature flag or an unsafe fallback for unsupported providers.
  if(!context)std::abort(); // exact pinned CHECK(ctx)
  if(!context.initForDecrypt())ThrowRsaError();
  if(!context.setRsaImplicitRejection())throw KeyError(
      "RSA_PKCS1_PADDING is no longer supported for private decryption","ERR_INVALID_ARG_VALUE");
}
inline ncrypto::Digest RsaDigest(const char* name) {
  if(!name)return {};
  const auto digest=ncrypto::Digest::FromName(name);
  if(!digest)throw KeyError("Invalid digest used","ERR_OSSL_EVP_INVALID_DIGEST");
  return digest;
}
inline ncrypto::DataPointer RsaTransform(const ncrypto::EVPKeyPointer& key,RsaOperation operation,
    uint32_t padding,const ncrypto::Digest& digest,const ncrypto::Digest& mgf1,
    ncrypto::Buffer<const void> label,ncrypto::Buffer<const void> input) {
  const ncrypto::Cipher::CipherParams params{int(padding),digest,mgf1,label};
  ncrypto::DataPointer output;
  switch(operation) {
    case RsaOperation::Encrypt: output=ncrypto::Cipher::encrypt(key,params,input);break;
    case RsaOperation::Decrypt: output=ncrypto::Cipher::decrypt(key,params,input);break;
    case RsaOperation::Sign: output=ncrypto::Cipher::sign(key,params,input);break;
    case RsaOperation::Recover: output=ncrypto::Cipher::recover(key,params,input);break;
  }
  if(!output)ThrowRsaError();return output;
}
} // namespace kandelo::crypto
#endif
