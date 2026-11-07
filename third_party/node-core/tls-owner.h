// Foreground TLS owns an actual transferred descriptor and real OpenSSL state.
#ifndef KANDELO_NODE_TLS_OWNER_H_
#define KANDELO_NODE_TLS_OWNER_H_
#include "socket-owner.h"
#include <openssl/ssl.h>
#include <cstdint>
#include <memory>
#include <utility>
namespace kandelo::tls {
struct OwnedContextDelete { void operator()(SSL_CTX* p) const noexcept { SSL_CTX_free(p); } };
struct OwnedSSLDelete { void operator()(SSL* p) const noexcept { SSL_free(p); } };
using OwnedContext = std::unique_ptr<SSL_CTX, OwnedContextDelete>;
using OwnedSSL = std::unique_ptr<SSL, OwnedSSLDelete>;
class Owner {
 public:
  enum class Phase { Preparing, Handshaking, Open, Closed };
 private:
  const uint64_t generation_;
  socket::Lease descriptor_;
  OwnedContext context_;
  OwnedSSL ssl_;
  Phase phase_ = Phase::Preparing;
 public:
  Owner(uint64_t generation, OwnedContext context, OwnedSSL ssl) noexcept
      : generation_(generation), context_(std::move(context)), ssl_(std::move(ssl)) {}
  Owner(const Owner&) = delete;
  Owner& operator=(const Owner&) = delete;
  ~Owner() { Close(); }
  uint64_t Generation() const noexcept { return generation_; }
  Phase State() const noexcept { return phase_; }
  int Fd() const noexcept { return descriptor_.Fd(); }
  SSL* Ssl() const noexcept { return ssl_.get(); }
  bool Matches(uint64_t generation) const noexcept {
    return generation == generation_ && phase_ != Phase::Closed;
  }
  bool Open() const noexcept { return phase_ == Phase::Open; }
  bool Adopt(socket::Lease& prior) noexcept {
    if (phase_ != Phase::Preparing || !context_ || !ssl_ || !descriptor_.Adopt(prior)) return false;
    phase_ = Phase::Handshaking; return true;
  }
  bool AdmitHandshake() noexcept {
    if (phase_ != Phase::Handshaking || Fd() < 0 || !ssl_) return false;
    phase_ = Phase::Open; return true;
  }
  void Close() noexcept {
    if (phase_ == Phase::Closed) return;
    const bool established = phase_ == Phase::Open;
    phase_ = Phase::Closed;
    // One nonblocking shutdown attempt, followed by actual deterministic release.
    // BIO_NOCLOSE from SSL_set_fd leaves descriptor retirement with this lease.
    if (established && ssl_) SSL_shutdown(ssl_.get());
    ssl_.reset(); context_.reset(); descriptor_.Close();
  }
};
}  // namespace kandelo::tls
#endif
