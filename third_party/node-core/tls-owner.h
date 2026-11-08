// Foreground SSL state layers over one actual retained TCP transport owner.
#ifndef KANDELO_NODE_TLS_OWNER_H_
#define KANDELO_NODE_TLS_OWNER_H_
#include "socket-owner.h"
#include "tls-encrypted-output.h"
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <poll.h>
#include <vector>
#include <climits>
#include <cstdint>
#include <memory>
#include <utility>
namespace kandelo::tls {
struct OwnedContextDelete { void operator()(SSL_CTX* p) const noexcept { SSL_CTX_free(p); } };
struct OwnedSSLDelete { void operator()(SSL* p) const noexcept { SSL_free(p); } };
using OwnedContext = std::unique_ptr<SSL_CTX, OwnedContextDelete>;
using OwnedSSL = std::unique_ptr<SSL, OwnedSSLDelete>;
// Actual consumed plaintext/EOF/error stays owned through JS publication and
// caller acknowledgement. No encrypted socket readiness is a plaintext result.
struct PlaintextRead {
  enum class Outcome { Waiting, Data, Eof, Error };
  enum class Delivery { Queued, Delivering, Published, Retired };
  const uint64_t generation, sequence;
  std::vector<uint8_t> bytes;
  Outcome outcome = Outcome::Waiting;
  Delivery delivery = Delivery::Queued;
  size_t count = 0;
  int sslError = 0, systemError = 0;
  unsigned long opensslError = 0;
  short events = POLLIN;
  memory::Allocation allocation;
  PlaintextRead(uint64_t generation, uint64_t sequence, size_t length)
      : generation(generation), sequence(sequence), bytes(length),
        allocation(sizeof(PlaintextRead) + bytes.capacity()) {}
  bool Complete() const noexcept { return outcome != Outcome::Waiting; }
  bool BeginDelivery() noexcept {
    if (!Complete() || delivery != Delivery::Queued) return false;
    delivery = Delivery::Delivering; return true;
  }
  void AbortDelivery() noexcept {
    if (delivery == Delivery::Delivering) delivery = Delivery::Queued;
  }
  void Published() noexcept {
    if (delivery == Delivery::Delivering) delivery = Delivery::Published;
  }
};

class Owner : public socket::TransportAttachment {
 public:
  enum class Phase { Preparing, Handshaking, Open, Closed };
 private:
  const uint64_t generation_;
  socket::Lease descriptor_; // Legacy transferred-lease component path only.
  socket::Owner* parent_ = nullptr;
  uint64_t parentGeneration_ = 0;
  size_t requests_ = 0;
  OwnedContext context_;
  OwnedSSL ssl_;
  std::unique_ptr<EncryptedOutput> encrypted_;
  Phase phase_ = Phase::Preparing;
  uint64_t nextRead_ = 0;
  bool reading_ = false, eof_ = false;
  std::shared_ptr<PlaintextRead> read_;
 public:
  Owner(uint64_t generation, OwnedContext context, OwnedSSL ssl) noexcept
      : generation_(generation), context_(std::move(context)), ssl_(std::move(ssl)) {}
  Owner(const Owner&) = delete;
  Owner& operator=(const Owner&) = delete;
  ~Owner() { Close(); DetachParent(); }
  // AsyncWrap publication precedes native SSL allocation in TLSWrap's real
  // constructor. Only the still-preparing, unattached owner may finish it.
  bool InitializeSsl() noexcept {
    if (phase_ != Phase::Preparing || ssl_ || parent_ || !context_) return false;
    OwnedSSL prepared(SSL_new(context_.get()));
    if (!prepared) return false;
    ssl_ = std::move(prepared); return true;
  }
  uint64_t Generation() const noexcept { return generation_; }
  Phase State() const noexcept { return phase_; }
  int Fd() const noexcept {
    if (phase_ == Phase::Closed) return -1;
    return parent_ ? (ParentLive() ? parent_->Fd() : -1) : descriptor_.Fd();
  }
  bool ParentLive() const noexcept {
    return parent_ && parent_->Generation() == parentGeneration_ && !parent_->Closed();
  }
  bool AttachParent(socket::Owner& parent) noexcept {
    if (phase_ != Phase::Preparing || parent_ || descriptor_.Fd() >= 0 ||
        !context_ || !ssl_ || !parent.AttachTransport(this)) return false;
    parent_ = &parent; parentGeneration_ = parent.Generation(); return true;
  }
  // TCP keeps the captured lease and exclusive socket input BIO. Output is a
  // memory BIO with a real registered parent write/acknowledgment transaction.
  bool BindParent() {
    if (phase_ != Phase::Preparing || !ParentLive() || parent_->Fd() < 0 || !ssl_)
      return false;
    auto encrypted = std::make_unique<EncryptedOutput>(*parent_, *this);
    if (!encrypted->Initialize(ssl_.get())) return false;
    encrypted_ = std::move(encrypted);
    phase_ = Phase::Handshaking; return true;
  }
  void DetachParent() noexcept {
    if (!parent_) return;
    // The embedding releases its root only after every real request retires.
    assert(requests_ == 0 && !EncryptedPending());
    parent_->DetachTransport(this); parent_ = nullptr;
  }
  bool HasParent() const noexcept { return parent_ != nullptr; }
  bool Referenced() const noexcept { return parent_ && parent_->Referenced(); }
  void Ref(bool value) noexcept { if (parent_) parent_->Ref(value); }
  bool HasRequests() const noexcept override { return requests_ != 0 || EncryptedPending(); }
  class Request {
    Owner* owner_;
   public:
    explicit Request(Owner& owner) noexcept : owner_(&owner) { ++owner_->requests_; }
    Request(const Request&) = delete;
    Request& operator=(const Request&) = delete;
    ~Request() { Complete(); }
    void Complete() noexcept {
      if (owner_) { assert(owner_->requests_); --owner_->requests_; owner_ = nullptr; }
    }
  };
  void ParentClosed() noexcept override { Close(false); }
  SSL* Ssl() const noexcept { return ssl_.get(); }
  bool EncryptedPending() const noexcept { return encrypted_ && encrypted_->Pending(); }
  bool EncryptedNeedsAcknowledgment() const noexcept { return encrypted_ && encrypted_->NeedsAcknowledgment(); }
  int EncryptedError() const noexcept { return encrypted_ ? encrypted_->Error() : 0; }
  size_t EncryptedPendingBytes() const noexcept { return encrypted_ ? encrypted_->PendingBytes() : 0; }
  bool ProgressEncrypted(bool acknowledge = false) noexcept {
    return !encrypted_ || encrypted_->Progress(acknowledge);
  }
  std::shared_ptr<memory::Record> EncryptedRecord() const noexcept {
    return encrypted_ ? encrypted_->allocation.Handle() : std::shared_ptr<memory::Record>{};
  }

  bool Matches(uint64_t generation) const noexcept {
    return generation == generation_ && phase_ != Phase::Closed && (!parent_ || ParentLive());
  }
  bool Open() const noexcept { return phase_ == Phase::Open && (!parent_ || ParentLive()); }
  bool Adopt(socket::Lease& prior) noexcept {
    if (phase_ != Phase::Preparing || parent_ || !context_ || !ssl_ || !descriptor_.Adopt(prior)) return false;
    phase_ = Phase::Handshaking; return true;
  }
  bool AdmitHandshake() noexcept {
    if (phase_ != Phase::Handshaking || Fd() < 0 || !ssl_) return false;
    phase_ = Phase::Open; return true;
  }
  std::shared_ptr<PlaintextRead> CurrentRead() const noexcept { return read_; }
  bool Reading() const noexcept { return reading_; }
  std::shared_ptr<PlaintextRead> BeginRead(size_t length) {
    if (!Open() || !length || length > INT_MAX) return {};
    if (read_) { reading_ = true; return read_; } // Never replace unacknowledged material.
    if (nextRead_ == UINT64_MAX) throw std::length_error("TLS read sequence exhausted");
    auto read = std::make_shared<PlaintextRead>(generation_, nextRead_ + 1, length);
    if (eof_) read->outcome = PlaintextRead::Outcome::Eof;
    read_ = read; ++nextRead_; reading_ = true; return read;
  }
  bool AbortRead(const std::shared_ptr<PlaintextRead>& read) noexcept {
    if (read_ != read || read->Complete()) return false;
    reading_ = false; read_.reset(); return true;
  }
  bool AcknowledgeRead(const std::shared_ptr<PlaintextRead>& read) noexcept {
    if (read_ != read || read->generation != generation_ || !read->Complete()) return false;
    read->delivery = PlaintextRead::Delivery::Retired;
    reading_ = false; read_.reset(); return true;
  }
  void StopRead() noexcept { reading_ = false; } // Queued plaintext is retained.
  bool ReadMayProgress(const std::shared_ptr<PlaintextRead>& read) const noexcept {
    if (!read || read->generation != generation_) return false;
    if (read->Complete()) return true;
    return Open() && reading_ &&
        (SSL_pending(ssl_.get()) > 0 || (SSL_get_shutdown(ssl_.get()) & SSL_RECEIVED_SHUTDOWN));
  }
  bool ProgressRead(const std::shared_ptr<PlaintextRead>& read) noexcept {
    using Outcome = PlaintextRead::Outcome;
    if (!read || read->generation != generation_) return false;
    if (read->Complete()) return true;
    if (read_ != read || !reading_ || !Open()) return false;
    // Same marked error lifetime as pinned TLSWrap::ClearOut. Capture errno and
    // SSL_get_error immediately, before JS or any other OpenSSL operation.
    ERR_set_mark();
    errno = 0;
    const int count = SSL_read(ssl_.get(), read->bytes.data(), int(read->bytes.size()));
    const int systemError = errno;
    const int error = count > 0 ? SSL_ERROR_NONE : SSL_get_error(ssl_.get(), count);
    if (count > 0) { read->outcome = Outcome::Data; read->count = size_t(count); }
    else if (error == SSL_ERROR_WANT_READ) read->events = POLLIN;
    else if (error == SSL_ERROR_WANT_WRITE) read->events = POLLOUT;
    else if (error == SSL_ERROR_ZERO_RETURN) { eof_ = true; read->outcome = Outcome::Eof; }
    else {
      read->outcome = Outcome::Error; read->sslError = error;
      read->systemError = error == SSL_ERROR_SYSCALL ? systemError : 0;
      read->opensslError = ERR_peek_error();
    }
    ERR_pop_to_mark();
    return read->Complete();
  }
  void Close(bool shutdown = true) noexcept {
    if (phase_ == Phase::Closed) return;
    const bool established = phase_ == Phase::Open;
    phase_ = Phase::Closed;
    reading_ = false;
    if (read_ && !read_->Complete()) {
      read_->outcome = PlaintextRead::Outcome::Error;
      read_->systemError = ECANCELED;
    }
    // Actual dispatch tickets still retain consumed/canceled material while
    // closing the descriptor/context; old tickets cannot name a future read.
    read_.reset();
    // One nonblocking shutdown attempt, followed by actual deterministic release.
    // BIO_NOCLOSE leaves descriptor retirement with the retained TCP parent.
    // The embedding queues that parent close and clears roots after requests retire.
    if (shutdown && established && ssl_ && (!parent_ || ParentLive())) {
      SSL_shutdown(ssl_.get());
      // Destruction remains best effort, NOT graceful write shutdown. A real
      // native send may make progress; any remainder is canceled, not credited
      // as a flushed alert or a successful public _final operation.
      if (encrypted_) (void)encrypted_->Progress(false);
    }
    ssl_.reset(); // No OpenSSL retry may retain application bytes past this.
    if (encrypted_) encrypted_->Cancel();
    encrypted_.reset(); context_.reset(); descriptor_.Close();
  }
};
}  // namespace kandelo::tls
#endif
