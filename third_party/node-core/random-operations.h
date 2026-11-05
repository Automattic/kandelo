#ifndef KANDELO_NODE_RANDOM_OPERATIONS_H
#define KANDELO_NODE_RANDOM_OPERATIONS_H
#include <openssl/rand.h>
#include "kandelo-node-digest-operations.h"
#if !defined(OPENSSL_THREADS) || defined(OPENSSL_NO_THREADS)
#error "Node async crypto requires OpenSSL built with real thread support"
#endif
#include <utility>
namespace kandelo::crypto {
inline void FillRandom(unsigned char* output, size_t length) {
  if (!length) return;
  ERR_clear_error();
  if (RAND_bytes_ex(nullptr, output, length, 0) != 1) Fail("Random generation failed");
}
// Same actual provenance decision as pinned ncrypto::DataPointer::SecureAlloc.
// No secure-heap capability is inferred from allocating ordinary fallback bytes.
class SecureBytes {
  unsigned char* data_ = nullptr;
  size_t size_ = 0;
  bool secure_ = false;
 public:
  explicit SecureBytes(size_t length) : size_(length) {
    data_ = static_cast<unsigned char*>(OPENSSL_secure_zalloc(length));
    if (!data_) throw std::bad_alloc();
    secure_ = CRYPTO_secure_allocated(data_) == 1;
  }
  SecureBytes(const SecureBytes&) = delete;
  SecureBytes& operator=(const SecureBytes&) = delete;
  ~SecureBytes() {
    if (secure_) OPENSSL_secure_clear_free(data_, size_);
    else OPENSSL_clear_free(data_, size_);
  }
  unsigned char* data() { return data_; }
  size_t size() const { return size_; }
  bool secure() const { return secure_; }
};
}  // namespace kandelo::crypto
#endif
