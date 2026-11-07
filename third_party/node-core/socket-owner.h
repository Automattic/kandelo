// Actual descriptor and undelivered material ownership for the Node TCP seam.
// The embedding drives these nonblocking operations on their owning JS thread.
#ifndef KANDELO_NODE_SOCKET_OWNER_H_
#define KANDELO_NODE_SOCKET_OWNER_H_
#include "native-retained-memory.h"
#include <cerrno>
#include <cstdint>
#include <memory>
#include <limits>
#include <stdexcept>
#include <utility>
#include <vector>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>

namespace kandelo::socket {
// A descriptor remains in its old lease until the recipient has completed all
// fallible allocation/publication work. Commit never allocates or invokes JS.
class Lease {
  friend class Owner;
  int fd_ = -1;
 public:
  explicit Lease(int fd = -1) noexcept : fd_(fd) {}
  ~Lease() { Close(); }
  Lease(const Lease&) = delete;
  Lease& operator=(const Lease&) = delete;
  int Fd() const noexcept { return fd_; }
  int Release() noexcept { return std::exchange(fd_, -1); }
  bool Adopt(Lease& prior) noexcept {
    if (fd_ >= 0 || prior.fd_ < 0) return false;
    fd_ = prior.Release(); return true;
  }
  void Close() noexcept { const int fd = Release(); if (fd >= 0) ::close(fd); }
};
struct Read {
  enum class Phase { Waiting, Complete, Delivering, Admitted, Retired };
  const uint64_t generation;
  const uint64_t sequence;
  Phase phase = Phase::Waiting;
  std::vector<uint8_t> bytes;
  // Positive byte count, zero EOF, negative actual errno. No fabricated error.
  ssize_t status = 0;
  memory::Allocation allocation;
  Read(uint64_t generation, uint64_t sequence, size_t size)
      : generation(generation), sequence(sequence), bytes(size),
        allocation(sizeof(Read) + bytes.capacity()) {}
};
// Each immutable span owns the actual allocation. The syscall vectors are
// mutable progress over those original addresses, never copies of payloads.
// The portable owner accepts either real engine or retained-store capabilities.
template<class SpanRef>
struct Write {
  const std::vector<SpanRef> backing;
  std::vector<iovec> vectors;
  const uint64_t totalBytes;
  uint64_t offset = 0;
  size_t vectorIndex = 0;
  int error = 0;
  bool complete = false;
  memory::Allocation allocation{sizeof(Write)};
  static uint64_t Count(const std::vector<SpanRef>& spans) {
    uint64_t total = 0;
    for (const auto& span : spans) {
      if (!span) throw std::invalid_argument("TCP write has no original backing");
      if (span->Length() > UINT64_MAX - total) throw std::length_error("TCP write byte count overflow");
      total += span->Length();
    }
    return total;
  }
  explicit Write(SpanRef span) : Write(std::vector<SpanRef>{std::move(span)}) {}
  explicit Write(std::vector<SpanRef> spans)
      : backing(std::move(spans)), totalBytes(Count(backing)) {
    vectors.reserve(backing.size());
    for (const auto& span : backing) vectors.push_back({span->Data(), span->Length()});
    allocation.Resize(sizeof(Write) + backing.capacity() * sizeof(SpanRef) +
                      vectors.capacity() * sizeof(iovec));
  }
  Write(const Write&) = delete;
  Write& operator=(const Write&) = delete;
  uint64_t Remaining() const noexcept { return totalBytes - offset; }
  void Consume(size_t count) noexcept {
    assert(count <= Remaining()); offset += count;
    while (vectorIndex < vectors.size()) {
      auto& vector = vectors[vectorIndex];
      if (vector.iov_len > count) {
        if (count) vector.iov_base = static_cast<uint8_t*>(vector.iov_base) + count;
        vector.iov_len -= count; break;
      }
      count -= vector.iov_len; vector.iov_len = 0; ++vectorIndex;
    }
    if (!Remaining()) complete = true;
  }
};

struct Shutdown {
  const uint64_t generation;
  uint64_t writeSequence = 0;
  bool queued = false, complete = false;
  int error = 0;
  memory::Allocation allocation{sizeof(Shutdown)};
  explicit Shutdown(uint64_t value) : generation(value) {}
};

// A transport layer consumes this actual stream exclusively. Its outstanding
// native requests keep the parent's queued close from completing prematurely.
class TransportAttachment {
 public:
  virtual ~TransportAttachment() = default;
  virtual void ParentClosed() noexcept = 0;
  virtual bool HasRequests() const noexcept = 0;
};

class Owner {
  Lease descriptor_;
  TransportAttachment* transport_ = nullptr;
  const uint64_t generation_;
  uint64_t nextRead_ = 0;
  bool reading_ = false;
  bool closed_ = false;
  bool referenced_ = true;
  bool writeShutdown_ = false;
  std::shared_ptr<Read> read_;
 public:
  memory::Allocation allocation{sizeof(Owner)};
  explicit Owner(uint64_t generation) : generation_(generation) {}
  Owner(const Owner&) = delete;
  Owner& operator=(const Owner&) = delete;
  ~Owner() { Close(); }
  int Fd() const noexcept { return descriptor_.Fd(); }
  uint64_t Generation() const noexcept { return generation_; }
  bool Referenced() const noexcept { return referenced_; }
  bool AttachTransport(TransportAttachment* transport) noexcept {
    if (!transport || transport_ || closed_ || reading_ || read_) return false;
    transport_ = transport; return true;
  }
  void DetachTransport(TransportAttachment* transport) noexcept {
    if (transport_ == transport) transport_ = nullptr;
  }
  bool HasTransport() const noexcept { return transport_ != nullptr; }
  bool HasTransportRequests() const noexcept { return transport_ && transport_->HasRequests(); }
  void Ref(bool value) noexcept { referenced_ = value; }
  // All caller coercions must finish before entering this owner operation.
  // No borrowed numeric fd may cross arbitrary JavaScript execution.
  int SetKeepAlive(bool enable, uint32_t idle, uint32_t interval = 1, uint32_t count = 10) noexcept {
    const int fd = Fd(), enabled = enable ? 1 : 0;
    int error = 0;
    if (setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &enabled, sizeof(enabled)) < 0) error = errno;
    else if (enabled) {
      if (idle < 1 || interval < 1 || count < 1) error = EINVAL;
#ifdef TCP_KEEPIDLE
      else if (setsockopt(fd, IPPROTO_TCP, TCP_KEEPIDLE, &idle, sizeof(idle)) < 0) error = errno;
#elif defined(TCP_KEEPALIVE)
      else if (setsockopt(fd, IPPROTO_TCP, TCP_KEEPALIVE, &idle, sizeof(idle)) < 0) error = errno;
#endif
#ifdef TCP_KEEPINTVL
      if (!error && setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &interval, sizeof(interval)) < 0) error = errno;
#endif
#ifdef TCP_KEEPCNT
      if (!error && setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &count, sizeof(count)) < 0) error = errno;
#endif
    }
    return error;
  }
  int QueueShutdown(Shutdown& request) noexcept {
    if (request.generation != generation_ || request.queued || request.complete)
      return EINVAL;
    if (closed_ || Fd() < 0 || writeShutdown_) return ENOTCONN;
    if (transport_) return EBUSY; // TLS owns its own close_notify/stream layer.
    writeShutdown_ = true; request.queued = true; return 0;
  }
  bool ProgressShutdown(Shutdown& request, bool earlierWrites) noexcept {
    if (request.complete) return true;
    if (!request.queued || request.generation != generation_) return false;
    // The caller also waits for earlier callbacks, not just consumed bytes.
    if (earlierWrites) return false;
    if (closed_ || Fd() < 0) request.error = ECANCELED;
    else if (::shutdown(Fd(), SHUT_WR) < 0) request.error = errno;
    request.complete = true; return true;
  }
  bool Reading() const noexcept { return reading_; }
  bool Closed() const noexcept { return closed_; }
  bool Adopt(Lease& prior) noexcept {
    if (closed_ || Fd() >= 0 || prior.Fd() < 0) return false;
#ifdef SO_NOSIGPIPE
    const int suppressSigpipe = 1;
    if (setsockopt(prior.Fd(), SOL_SOCKET, SO_NOSIGPIPE, &suppressSigpipe, sizeof(suppressSigpipe)) < 0)
      return false;
#endif
    // No allocation or callback is permitted after this ownership commit.
    descriptor_.fd_ = prior.Release(); return true;
  }
  // A native transport recipient is fully allocated before this no-JS commit.
  // In-flight reads may already own consumed bytes and cannot be transferred.
  bool TransferTo(Lease& recipient) noexcept {
    if (closed_ || transport_ || Fd() < 0 || reading_ || read_ || recipient.Fd() >= 0) return false;
    if (!recipient.Adopt(descriptor_)) return false;
    closed_ = true; return true;
  }
  void Close() noexcept {
    closed_ = true; reading_ = false;
    descriptor_.Close();
    // This is a no-JS invalidation. SSL must never use a later reuse of the fd.
    if (transport_) transport_->ParentClosed();
    // A dispatcher's local ticket still owns material through callback reentry.
    read_.reset();
  }
  std::shared_ptr<Read> CurrentRead() const noexcept { return read_; }
  bool StartRead(size_t size = 64 * 1024) {
    if (transport_ || Fd() < 0 || !size) return false;
    if (!read_) {
      auto replacement = std::make_shared<Read>(generation_, nextRead_ + 1, size);
      read_ = std::move(replacement); ++nextRead_;
    }
    reading_ = true; return true;
  }
  void StopRead() noexcept {
    reading_ = false;
    // Stopping readiness cannot discard bytes/error/EOF already consumed.
    if (read_ && read_->phase == Read::Phase::Waiting) read_.reset();
  }
  // One bounded read attempt. EINTR and EAGAIN retain actual pending readiness.
  bool ProgressRead() noexcept {
    if (Fd() < 0 || !reading_ || !read_ || read_->phase != Read::Phase::Waiting) return false;
    const ssize_t count = ::read(Fd(), read_->bytes.data(), read_->bytes.size());
    if (count < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) return false;
    read_->status = count < 0 ? -errno : count;
    read_->phase = Read::Phase::Complete; return true;
  }
  std::shared_ptr<Read> BeginDelivery() noexcept {
    if (!reading_ || !read_ || read_->phase != Read::Phase::Complete) return {};
    read_->phase = Read::Phase::Delivering; return read_;
  }
  void AbortDelivery(const std::shared_ptr<Read>& ticket) noexcept {
    if (read_ == ticket && ticket->phase == Read::Phase::Delivering)
      ticket->phase = Read::Phase::Complete;
  }
  // The embedding calls this only after callback bytes/status and captured
  // callback are owned by rooted JS arguments. Ownership leaves the queued
  // read slot before before-hooks; retained physical bytes are now in flight.
  bool AdmitDelivery(const std::shared_ptr<Read>& ticket) noexcept {
    if (read_ != ticket || ticket->generation != generation_ ||
        ticket->phase != Read::Phase::Delivering) return false;
    ticket->phase = Read::Phase::Admitted; read_.reset(); return true;
  }
  // Result: 1 pending bytes/error/EOF, 0 genuinely idle, negative actual errno.
  // A completed/adopting read is checked BEFORE looking at the kernel buffer.
  int PendingRead() const noexcept {
    if (Fd() < 0) return 0;
    if (read_ && read_->phase != Read::Phase::Waiting) return 1;
    uint8_t byte;
    int flags = MSG_PEEK;
#ifdef MSG_DONTWAIT
    flags |= MSG_DONTWAIT;
#endif
    ssize_t count;
    do { count = ::recv(Fd(), &byte, 1, flags); } while (count < 0 && errno == EINTR);
    if (count >= 0) return 1; // Includes real peer EOF.
    const int error = errno;
    if (error == EAGAIN || error == EWOULDBLOCK) return 0;
    return -error;
  }
  template<class SpanRef>
  int ValidateWrite(const Write<SpanRef>& write, bool submitted = false) const noexcept {
    // Pinned uv__check_before_write count guard, before descriptor validation.
    if (write.vectors.empty() || write.vectors.size() > 1024 * 1024) return EINVAL;
    return Fd() < 0 ? EBADF : (writeShutdown_ && !submitted) ? EPIPE : transport_ ? EBUSY : 0;
  }
  // Callers serialize writes in stream order. One actual sendmsg consumes a
  // bounded prefix of the retained vectors; EINTR never changes that prefix.
  template<class SpanRef>
  bool ProgressWrite(Write<SpanRef>& write, bool submitted = false) noexcept {
    if (write.complete) return true;
    if (const int error = ValidateWrite(write, submitted)) { write.error = error; write.complete = true; return true; }
    if (!write.Remaining()) { write.complete = true; return true; }
    msghdr message = {};
    message.msg_iov = write.vectors.data() + write.vectorIndex;
    const size_t count = write.vectors.size() - write.vectorIndex;
    const long limit = ::sysconf(_SC_IOV_MAX);
    const size_t maximum = limit > 0 ? size_t(limit) : 1;
    message.msg_iovlen = count < maximum ? count : maximum;
    ssize_t sent;
    do { sent = ::sendmsg(Fd(), &message, SendFlags()); }
    while (sent < 0 && errno == EINTR);
    if (sent >= 0) write.Consume(size_t(sent));
    else if (errno != EAGAIN && errno != EWOULDBLOCK) {
      write.error = errno; write.complete = true;
    }
    return write.complete;
  }

 private:
  static int SendFlags() noexcept {
#ifdef MSG_NOSIGNAL
    return MSG_NOSIGNAL;
#else
    return 0;
#endif
  }
};
} // namespace kandelo::socket
#endif
