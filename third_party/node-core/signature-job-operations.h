#ifndef KANDELO_NODE_SIGNATURE_JOB_OPERATIONS_H
#define KANDELO_NODE_SIGNATURE_JOB_OPERATIONS_H
#include "kandelo-node-signature-operations.h"
namespace kandelo::crypto {
// Actual owned one-shot provider configuration. No JS value or pointer to a
// current JS view crosses the CPU work queue. Sync original allocations are
// retained separately by the engine request until run materializes the inputs.
struct SignatureJobOperation {
  ncrypto::EVPKeyPointer key;
  ncrypto::Digest digest;
  Bytes data, signature, context;
  bool verify = false, p1363 = false;
  std::optional<int> padding, salt;
  uint64_t AccountedBytes() const {
    return uint64_t(sizeof(*this)) + data.value.capacity() + signature.value.capacity() + context.value.capacity();
  }
  void SetDigest(const std::string& name) {
    digest = ncrypto::Digest::FromName(name.c_str());
    if (!digest) {
      const auto message = "Invalid digest: " + std::string(name.c_str());
      SignatureState::Code("ERR_CRYPTO_INVALID_DIGEST", message.c_str());
    }
  }
  void RetainKey(const ncrypto::EVPKeyPointer& source) {
    if (!EVP_PKEY_up_ref(source.get())) SignatureState::ProviderFailure("Failed to retain signing key");
    key.reset(source.get());
  }
  bool UseP1363() const { return p1363 && key.isSigVariant(); }
  static std::vector<unsigned char> ConvertSignature(const ncrypto::EVPKeyPointer& key,
                                                     const unsigned char* bytes, size_t length) {
    const auto width = key.getBytesOfRS();
    if (!width) return length ? std::vector<unsigned char>(bytes, bytes + length) : std::vector<unsigned char>{};
    // Unlike the streaming verifier, AdditionalConfig retains an empty
    // conversion result for malformed P1363; derive then returns false.
    if (length != size_t(*width) * 2) return {};
    return SignatureState::ToDER(key, bytes, length);
  }
  bool CanPrehash() const {
    if (!digest || !context.value.empty()) return false;
    return key.isRsaVariant() || (key.isSigVariant() && !key.mayBeSM2());
  }
  ncrypto::DataPointer PrehashedSign(int pad) const {
    auto ctx = ncrypto::EVPMDCtxPointer::New();
    if (!ctx || !ctx.digestInit(digest) || !ctx.digestUpdate({data.value.data(), data.value.size()})) return {};
    auto hashed = ctx.digestFinal(ctx.getExpectedSize());
    auto keyContext = key.newCtx();
    if (!hashed || !keyContext || keyContext.initForSign() <= 0 ||
        !SignatureState::RSAOptions(key, keyContext.get(), pad, salt) || !keyContext.setSignatureMd(ctx)) return {};
    return keyContext.sign(hashed);
  }
  bool PrehashedVerify(int pad) const {
    auto ctx = ncrypto::EVPMDCtxPointer::New();
    if (!ctx || !ctx.digestInit(digest) || !ctx.digestUpdate({data.value.data(), data.value.size()})) return false;
    auto hashed = ctx.digestFinal(ctx.getExpectedSize());
    auto keyContext = key.newCtx();
    return hashed && keyContext && keyContext.initForVerify() > 0 &&
        SignatureState::RSAOptions(key, keyContext.get(), pad, salt) && keyContext.setSignatureMd(ctx) &&
        keyContext.verify({signature.value.data(), signature.value.size()}, hashed);
  }
  bool Derive(Bytes* output, bool* verified, CryptoErrorStore* errors) const {
    const bool hasContext = !context.value.empty();
    if (hasContext && !key.supportsContextString()) {
      errors->Insert("Context parameter is unsupported"); errors->SetNodeErrorCode("ERR_CRYPTO_OPERATION_FAILED"); return false;
    }
    const int pad = padding.value_or(key.getDefaultSignPadding());
    auto ctx = ncrypto::EVPMDCtxPointer::New();
    if (!ctx) return false;
    const ncrypto::Buffer<const unsigned char> contextBuffer{context.value.data(), context.value.size()};
    auto keyContext = hasContext ? (verify ? ctx.verifyInitWithContext(key, digest, contextBuffer) :
                                             ctx.signInitWithContext(key, digest, contextBuffer)) :
                                  (verify ? ctx.verifyInit(key, digest) : ctx.signInit(key, digest));
    if (!keyContext || !SignatureState::RSAOptions(key, *keyContext, pad, salt)) return false;
    static const unsigned char empty = 0;
    const ncrypto::Buffer<const unsigned char> input{data.value.empty() ? &empty : data.value.data(), data.value.size()};
    const ncrypto::Buffer<const unsigned char> sig{signature.value.empty() ? &empty : signature.value.data(), signature.value.size()};
    if (verify) {
      const int result = ctx.verifyOneShot(input, sig);
      *verified = (result == 1 && !key.hasSmallOrderEdDsaPoint(sig)) ||
          (result < 0 && CanPrehash() && PrehashedVerify(pad));
      return true;
    }
    const auto* algorithm = key.getAlgorithm();
    ncrypto::DataPointer signedData;
    if (algorithm && algorithm->isOneShot()) signedData = ctx.signOneShot(input);
    else {
      signedData = ctx.sign(input);
      if (!signedData && CanPrehash()) signedData = PrehashedSign(pad);
    }
    if (!signedData) return false;
    const auto* start = signedData.get<unsigned char>();
    if (signedData.size()) output->value.assign(start, start + signedData.size());
    if (!(algorithm && algorithm->isOneShot()) && UseP1363()) {
      const auto width = key.getBytesOfRS();
      if (!width) return false;
      std::vector<unsigned char> converted(size_t(*width) * 2, 0);
      if (!ncrypto::extractP1363({output->value.data(), output->value.size()}, converted.data(), *width)) return false;
      output->value.swap(converted);
    }
    return true;
  }
  std::unique_ptr<Error> Run(Bytes* output, bool* verified) const {
    ncrypto::ClearErrorOnReturn clear;
    CryptoErrorStore errors;
    if (Derive(output, verified, &errors)) return {};
    if (errors.errors_.empty()) errors.Capture();
    if (errors.errors_.empty()) {
      errors.Insert("Deriving bits failed"); errors.SetNodeErrorCode("ERR_CRYPTO_OPERATION_FAILED");
    }
    return std::make_unique<Error>(Error::FromCaptured(std::move(errors)));
  }
};
}  // namespace kandelo::crypto
#endif
