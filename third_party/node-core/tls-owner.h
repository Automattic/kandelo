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
// Passive identity plus cumulative actual socket-BIO consumption. This is a
// local retry observation, never an allocated ID, fd event or owned BIO ref.
struct InputProgress {
  const BIO* identity = nullptr;
  uint64_t consumed = 0;
  bool operator!=(const InputProgress& prior) const noexcept {
    return identity != prior.identity || consumed != prior.consumed;
  }
};
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
  enum class Retry { Initial, Input, Output, None };
  Retry retry = Retry::Initial;
  InputProgress inputAtAttempt;
  bool attempted = false;
  short events = POLLIN; // Historical SSL direction; fd admission uses Retry.
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

// Local graceful-shutdown flight, owned by the actual native ShutdownWrap.
// Sent is OpenSSL state, not proof of transport flush; only actual BIO receipt
// acknowledgment permits localComplete and the parent's SHUT_WR operation.
struct WriteShutdown {
  const uint64_t generation;
  bool attempted = false, sent = false, localComplete = false, failed = false;
  int firstResult = 0, secondResult = 0;
  int sslError = 0, systemError = 0;
  explicit WriteShutdown(uint64_t value) : generation(value) {}
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
  int fatalSslError_ = 0, fatalSystemError_ = 0;
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
  short EncryptedRegisteredEvents() const noexcept {
    return phase_ != Phase::Closed && encrypted_ ? encrypted_->RegisteredEvents() : 0;
  }
  bool MemoryOutputBound() const noexcept { return encrypted_ != nullptr; }
  InputProgress CurrentInputProgress() const noexcept {
    BIO* input = ssl_ ? SSL_get_rbio(ssl_.get()) : nullptr;
    return {input, input ? uint64_t(BIO_number_read(input)) : 0};
  }
  bool EncryptedCanWrite() const noexcept {
    return phase_ != Phase::Closed && encrypted_ && encrypted_->CanWrite();
  }
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
  // Only actual owning SSL I/O supplies this error, never a JS capability flag.
  void NoteSslError(int error, int systemError) noexcept {
    if (error == SSL_ERROR_SSL || error == SSL_ERROR_SYSCALL) {
      fatalSslError_ = error;
      fatalSystemError_ = error == SSL_ERROR_SYSCALL ? systemError : 0;
    }
  }
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
    if (eof_) {
      read->outcome = PlaintextRead::Outcome::Eof;
      read->retry = PlaintextRead::Retry::None; read->events = 0;
    }
    read_ = read; ++nextRead_; reading_ = true; return read;
  }
  bool AbortRead(const std::shared_ptr<PlaintextRead>& read) noexcept {
    if (read_ != read || read->Complete()) return false;
    read->retry = PlaintextRead::Retry::None; read->events = 0;
    reading_ = false; read_.reset(); return true;
  }
  bool AcknowledgeRead(const std::shared_ptr<PlaintextRead>& read) noexcept {
    if (read_ != read || read->generation != generation_ || !read->Complete()) return false;
    read->delivery = PlaintextRead::Delivery::Retired;
    reading_ = false; read_.reset(); return true;
  }
  void StopRead() noexcept { reading_ = false; } // Queued plaintext is retained.
  short ReadRegisteredEvents(const std::shared_ptr<PlaintextRead>& read) const noexcept {
    if (!read || read_ != read || read->generation != generation_ ||
        read->Complete() || !reading_ || !Open()) return 0;
    // The input BIO consumes the retained real socket. Output WANT instead
    // waits for paired BIO space owned by actual encrypted-write receipts.
    if (read->retry == PlaintextRead::Retry::Input) return POLLIN;
    // A legacy transferred lease can use direct socket BIO output. Its real
    // WANT_WRITE is fd readiness, not the retained pair's free ring space.
    return read->retry == PlaintextRead::Retry::Output && !MemoryOutputBound() ? POLLOUT : 0;
  }
  bool ReadMayProgress(const std::shared_ptr<PlaintextRead>& read) const noexcept {
    if (!read || read->generation != generation_) return false;
    if (read->Complete()) return true;
    if (read_ != read || !Open() || !reading_) return false;
    if (read->retry == PlaintextRead::Retry::Output) return EncryptedCanWrite();
    return read->retry == PlaintextRead::Retry::Initial ||
        (read->attempted && CurrentInputProgress() != read->inputAtAttempt) ||
        SSL_pending(ssl_.get()) > 0 || (SSL_get_shutdown(ssl_.get()) & SSL_RECEIVED_SHUTDOWN);
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
    // Another real SSL operation can consume the input that satisfied this
    // pending retry. Observe actual BIO progress once, not a synthetic wake.
    read->inputAtAttempt = CurrentInputProgress(); read->attempted = true;
    if (count > 0) { read->outcome = Outcome::Data; read->count = size_t(count); }
    else if (error == SSL_ERROR_WANT_READ) {
      read->retry = PlaintextRead::Retry::Input; read->events = POLLIN;
    } else if (error == SSL_ERROR_WANT_WRITE) {
      read->retry = PlaintextRead::Retry::Output; read->events = POLLOUT;
    } else if (error == SSL_ERROR_ZERO_RETURN) { eof_ = true; read->outcome = Outcome::Eof; }
    else {
      read->outcome = Outcome::Error; read->sslError = error;
      read->systemError = error == SSL_ERROR_SYSCALL ? systemError : 0;
      NoteSslError(error, systemError);
      read->opensslError = ERR_peek_error();
    }
    if (read->Complete()) { read->retry = PlaintextRead::Retry::None; read->events = 0; }
    ERR_pop_to_mark();
    return read->Complete();
  }
  bool ProgressWriteShutdown(WriteShutdown& shutdown, bool earlierWrites) noexcept {
    if (shutdown.localComplete || shutdown.failed) return true;
    if (!Matches(shutdown.generation) || !ssl_) {
      shutdown.failed = true;shutdown.systemError = ECANCELED;return true;
    }
    // OpenSSL forbids shutdown after a fatal SSL/SYSCALL result. The owning
    // read/retry path records it; do not repeat the old invalid abrupt fixture.
    if (fatalSslError_) {
      shutdown.failed = true;shutdown.sslError = fatalSslError_;
      shutdown.systemError = fatalSystemError_;return true;
    }
    if (earlierWrites || !Open()) return false;
    if (EncryptedPending()) {
      const bool acknowledge = EncryptedNeedsAcknowledgment();
      if (!acknowledge) {
        const short events = EncryptedRegisteredEvents();
        if (events) {
          pollfd descriptor{Fd(), events, 0};
          const int ready = poll(&descriptor, 1, 0);
          if (ready == 0 || (ready < 0 && errno == EINTR)) return false;
          if (ready < 0) { shutdown.failed = true;shutdown.systemError = errno;return true; }
        }
      }
      (void)ProgressEncrypted(acknowledge);
      if (const int error = EncryptedError()) {
        shutdown.failed = true;shutdown.systemError = error;return true;
      }
      // A new real send completion must be acknowledged on continuation;
      // producing or writing bytes alone is not an acknowledged BIO flush.
      if (EncryptedPending()) return false;
    }
    if (!shutdown.attempted) {
      ERR_set_mark();
      shutdown.firstResult = SSL_shutdown(ssl_.get());
      if (shutdown.firstResult == 0) shutdown.secondResult = SSL_shutdown(ssl_.get());
      shutdown.sent = (SSL_get_shutdown(ssl_.get()) & SSL_SENT_SHUTDOWN) != 0;
      ERR_pop_to_mark();
      shutdown.attempted = true;
      // Target DoShutdown does not wait for peer close_notify or turn its
      // return into peer EOF. Preserve its two-call policy and actual output.
      if (EncryptedPending()) {
        (void)ProgressEncrypted(false);
        if (const int error = EncryptedError()) {
          shutdown.failed = true;shutdown.systemError = error;return true;
        }
        return false;
      }
    }
    shutdown.localComplete = true;return true;
  }
  void Close(bool shutdown = true) noexcept {
    if (phase_ == Phase::Closed) return;
    const bool established = phase_ == Phase::Open;
    phase_ = Phase::Closed;
    reading_ = false;
    if (read_ && !read_->Complete()) {
      read_->outcome = PlaintextRead::Outcome::Error;
      read_->retry = PlaintextRead::Retry::None; read_->events = 0;
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

// The real native ShutdownWrap owns this operation; its JS private roots own
// the actual TLS capability/parent. The caller supplies its real write-ticket
// index, including callback-retiring entries, rather than a byte-count proxy.
class ShutdownOperation : public socket::TransportShutdown {
  Owner& owner_;
  Owner::Request request_;
  WriteShutdown flight_;
 protected:
  virtual bool HasEarlierWrites() const noexcept = 0;
  void Complete() noexcept { request_.Complete(); }
 public:
  explicit ShutdownOperation(Owner& owner) noexcept
      : owner_(owner), request_(owner), flight_(owner.Generation()) {
    allocation.Resize(sizeof(ShutdownOperation));
  }
  ~ShutdownOperation() override = default;
  const WriteShutdown& Flight() const noexcept { return flight_; }
  bool Progress(socket::Shutdown& shutdown, bool parentEarlierWrites) noexcept final {
    if (parentEarlierWrites || HasEarlierWrites()) return false;
    if (!owner_.ProgressWriteShutdown(flight_, false)) return false;
    if (flight_.failed) {
      shutdown.error = flight_.systemError ? flight_.systemError : EPROTO;
      shutdown.complete = true;
    }
    return true;
  }
};
}  // namespace kandelo::tls
#endif
