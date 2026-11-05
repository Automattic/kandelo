// Actual OpenSSL incremental contexts and the pinned Node digest/cache policy.
#ifndef KANDELO_NODE_INCREMENTAL_HASH_H
#define KANDELO_NODE_INCREMENTAL_HASH_H
#include <climits>
#include <cstring>
#include <openssl/evperr.h>
#include <openssl/hmac.h>

#include "kandelo-node-digest-operations.h"

namespace kandelo::crypto {
inline void CheckIncrementalInput(size_t length) {
  if (length > INT_MAX) { Error error("data is too long"); error.code = "ERR_OUT_OF_RANGE"; throw error; }
}
class IncrementalHash {
  ContextOwner context_{nullptr, EVP_MD_CTX_free};
  uint32_t length_ = 0;
  Bytes digest_;
  bool cached_ = false;

  void Init(const EVP_MD* md, std::optional<uint32_t> requested) {
    context_.reset(EVP_MD_CTX_new());
    if (!md || !context_ || EVP_DigestInit_ex(context_.get(), md, nullptr) != 1)
      Fail("Digest method not supported");
    const int size = EVP_MD_CTX_get_size(context_.get());
    length_ = size > 0 ? uint32_t(size) : 0;
    const bool xof = (EVP_MD_get_flags(md) & EVP_MD_FLAG_XOF) != 0;
    if (xof && !requested && !length_) {
      if (EVP_MD_is_a(md, "SHAKE128")) length_ = 16;
      else if (EVP_MD_is_a(md, "SHAKE256")) length_ = 32;
    }
    if (requested && *requested != length_) {
      if (!xof) {
        ERR_raise(ERR_LIB_EVP, EVP_R_NOT_XOF_OR_INVALID_LENGTH);
        Fail("Digest method not supported");
      }
      length_ = *requested;
    }
  }

 public:
  IncrementalHash(const std::string& algorithm, std::optional<uint32_t> requested,
                  bool digestOptions = false) {
    ERR_clear_error();
    if (digestOptions) throw Error("Digest options are not supported");
    auto md = Fetch(algorithm.c_str());
    // Node retains the legacy descriptor if provider fetching fails, then
    // exposes the actual DigestInit error (for example a disabled provider).
    const EVP_MD* implementation = md ? md.get() : EVP_get_digestbyname(algorithm.c_str());
    if (implementation == EVP_md_null()) implementation = nullptr;
    Init(implementation, requested);
  }
  IncrementalHash(const IncrementalHash& source, std::optional<uint32_t> requested) {
    ERR_clear_error();
    Init(EVP_MD_CTX_get0_md(source.context_.get()), requested);
    if (EVP_MD_CTX_copy_ex(context_.get(), source.context_.get()) != 1) Fail("Digest copy error");
    // Node initializes the copy's requested/default length afresh. A cached
    // digest is not copied; actual native context state is copied instead.
  }
  bool Update(const Bytes& input) {
    CheckIncrementalInput(input.value.size());
    return EVP_DigestUpdate(context_.get(), input.value.data(), input.value.size()) == 1;
  }
  const Bytes& Digest() {
    ERR_clear_error();
    if (!cached_ && length_ > 0) {
      digest_.value.resize(length_);
      const int expected = EVP_MD_CTX_get_size(context_.get());
      const int result = expected >= 0 && length_ == uint32_t(expected) ?
          EVP_DigestFinal_ex(context_.get(), digest_.value.data(), nullptr) :
          EVP_DigestFinalXOF(context_.get(), digest_.value.data(), length_);
      if (result != 1) {
        OPENSSL_cleanse(digest_.value.data(), digest_.value.size());
        std::vector<unsigned char>().swap(digest_.value); Fail("Digest final failed");
      }
      cached_ = true;
    }
    // A zero-length XOF deliberately does not finalize its context. This is
    // the pinned native policy, including Hash._flush/digest interaction.
    return digest_;
  }
  size_t AccountedBytes() const { return sizeof(*this) + digest_.value.capacity(); }
};

using HmacContextOwner = std::unique_ptr<HMAC_CTX, decltype(&HMAC_CTX_free)>;
class IncrementalHmac {
  HmacContextOwner context_{nullptr, HMAC_CTX_free};
 public:
  IncrementalHmac(const std::string& algorithm, const Bytes& key) {
    ERR_clear_error();
    const EVP_MD* md = EVP_get_digestbyname(algorithm.c_str());
    if (!md) { Error error("Invalid digest: " + std::string(algorithm.c_str()));
      error.code = "ERR_CRYPTO_INVALID_DIGEST"; throw error; }
    CheckIncrementalInput(key.value.size());
    context_.reset(HMAC_CTX_new());
    const void* data = key.value.empty() ? static_cast<const void*>("") : key.value.data();
    if (!context_ || HMAC_Init_ex(context_.get(), data, int(key.value.size()), md, nullptr) != 1)
      Fail("HMAC initialization failed");
  }
  bool Update(const Bytes& input) {
    CheckIncrementalInput(input.value.size());
    return context_ && HMAC_Update(context_.get(), input.value.data(), input.value.size()) == 1;
  }
  Bytes Digest() {
    ERR_clear_error();
    Bytes output;
    if (!context_) return output;
    output.value.resize(EVP_MAX_MD_SIZE);
    unsigned int length = 0;
    const int result = HMAC_Final(context_.get(), output.value.data(), &length);
    context_.reset();
    if (result != 1) Fail("Failed to finalize HMAC");
    output.value.resize(length); return output;
  }
  size_t AccountedBytes() const { return sizeof(*this); }
};
}  // namespace kandelo::crypto
#endif
