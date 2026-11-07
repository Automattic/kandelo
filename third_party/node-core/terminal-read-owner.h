#ifndef KANDELO_NODE_TERMINAL_READ_OWNER_H_
#define KANDELO_NODE_TERMINAL_READ_OWNER_H_
#include "native-retained-memory.h"
#include <cerrno>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <vector>
#include <unistd.h>
namespace kandelo::terminal {
// Actual consumed material survives stopped readiness or failed pre-callback
// publication. The native request owns it through callback/checkpoint retirement.
struct ReadTicket {
  enum class Phase { Waiting, Ready, Delivering, Admitted, Retired };
  const uint64_t generation, sequence;
  std::vector<uint8_t> bytes;
  ssize_t status = 0;
  Phase phase = Phase::Waiting;
  memory::Allocation allocation;
  ReadTicket(uint64_t generation, uint64_t sequence, size_t length)
      : generation(generation), sequence(sequence), bytes(length),
        allocation(sizeof(ReadTicket) + bytes.capacity()) {}
};
class ReadOwner {
  const uint64_t generation_;
  uint64_t sequence_ = 0;
  bool reading_ = false, closed_ = false;
  std::shared_ptr<ReadTicket> current_;
 public:
  explicit ReadOwner(uint64_t generation) noexcept : generation_(generation) {}
  uint64_t Generation() const noexcept { return generation_; }
  bool Reading() const noexcept { return reading_; }
  bool Closed() const noexcept { return closed_; }
  std::shared_ptr<ReadTicket> Current() const noexcept { return current_; }
  std::shared_ptr<ReadTicket> Start(size_t length) {
    if (closed_ || !length) return {};
    if (!current_) {
      if (sequence_ == UINT64_MAX) throw std::length_error("TTY read sequence exhausted");
      auto ticket = std::make_shared<ReadTicket>(generation_, sequence_ + 1, length);
      current_ = std::move(ticket); ++sequence_;
    }
    reading_ = true; return current_;
  }
  void Stop() noexcept {
    reading_ = false;
    if (current_ && current_->phase == ReadTicket::Phase::Waiting) {
      current_->phase = ReadTicket::Phase::Retired; current_.reset();
    }
  }
  // fd is fetched from the real captured InputHandle immediately before this
  // no-JS operation. No future public fd or copied readiness flag is authority.
  bool Progress(int fd, const std::shared_ptr<ReadTicket>& ticket) noexcept {
    if (closed_ || !reading_ || current_ != ticket || !ticket ||
        ticket->phase != ReadTicket::Phase::Waiting) return false;
    ssize_t result;
    do { result = ::read(fd, ticket->bytes.data(), ticket->bytes.size()); }
    while (result < 0 && errno == EINTR);
    if (result < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return false;
    ticket->status = result < 0 ? -errno : result;
    ticket->phase = ReadTicket::Phase::Ready; return true;
  }
  bool Ready() const noexcept {
    return reading_ && current_ && current_->phase == ReadTicket::Phase::Ready;
  }
  bool BeginDelivery(const std::shared_ptr<ReadTicket>& ticket) noexcept {
    if (!Ready() || current_ != ticket) return false;
    ticket->phase = ReadTicket::Phase::Delivering; return true;
  }
  void AbortDelivery(const std::shared_ptr<ReadTicket>& ticket) noexcept {
    if (current_ == ticket && ticket->phase == ReadTicket::Phase::Delivering)
      ticket->phase = ReadTicket::Phase::Ready;
  }
  bool Admit(const std::shared_ptr<ReadTicket>& ticket) noexcept {
    if (current_ != ticket || !ticket || ticket->generation != generation_ ||
        ticket->phase != ReadTicket::Phase::Delivering) return false;
    ticket->phase = ReadTicket::Phase::Admitted;current_.reset();
    if (ticket->status <= 0) reading_ = false;
    return true;
  }
  void Close() noexcept {
    reading_ = false;closed_ = true;
    if (current_) current_->phase = ReadTicket::Phase::Retired;
    current_.reset();
  }
};
}  // namespace kandelo::terminal
#endif
