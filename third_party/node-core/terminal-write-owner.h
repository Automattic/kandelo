#ifndef KANDELO_NODE_TERMINAL_WRITE_OWNER_H_
#define KANDELO_NODE_TERMINAL_WRITE_OWNER_H_
#include "stream-write-material.h"
#include <cerrno>
#include <cstdint>
#include <utility>
namespace kandelo::terminal {
template<class SpanRef> struct WriteTicket {
  enum class Phase { Preparing, Queued, Delivering, Admitted, Retired };
  const uint64_t generation;
  uint64_t sequence = 0;
  stream::Write<SpanRef> material;
  Phase phase = Phase::Preparing;
  WriteTicket* previous = nullptr;
  WriteTicket* next = nullptr;
  WriteTicket(uint64_t generation, std::vector<SpanRef> backing)
      : generation(generation), material(std::move(backing)) {
    material.allocation.Resize(sizeof(WriteTicket) +
        material.backing.capacity() * sizeof(SpanRef) +
        material.vectors.capacity() * sizeof(iovec));
  }
};
// A queue owns membership, never the allocation or a JS root. The actual
// native request retains the ticket and original allocation capabilities.
// Publication follows WRITEWRAP init; nested init-hook writes may precede it.
template<class SpanRef> class WriteOwner {
 public:
  using Ticket = WriteTicket<SpanRef>;
 private:
  const uint64_t generation_;
  uint64_t sequence_ = 0;
  bool closed_ = false;
  Ticket* head_ = nullptr;
  Ticket* tail_ = nullptr;
 public:
  explicit WriteOwner(uint64_t generation) noexcept : generation_(generation) {}
  uint64_t Generation() const noexcept { return generation_; }
  bool Closed() const noexcept { return closed_; }
  Ticket* Head() const noexcept { return head_; }
  bool HasRemaining() const noexcept { return QueueSize() != 0; }
  uint64_t QueueSize() const noexcept {
    uint64_t bytes = 0;
    for (auto* ticket = head_; ticket; ticket = ticket->next)
      // libuv retains failed/canceled remainder bytes until immediately
      // before completion, signaling backpressure even after native failure.
      if (ticket->phase != Ticket::Phase::Delivering) bytes += ticket->material.Remaining();
    return bytes;
  }
  int Publish(Ticket* ticket) noexcept {
    if (!ticket || ticket->generation != generation_ || ticket->phase != Ticket::Phase::Preparing)
      return EINVAL;
    if (closed_) return EBADF;
    if (sequence_ == UINT64_MAX) return EOVERFLOW;
    ticket->sequence = ++sequence_;ticket->phase = Ticket::Phase::Queued;
    ticket->previous = tail_;
    if (tail_) tail_->next = ticket;else head_ = ticket;
    tail_ = ticket;return 0;
  }
  template<class Output> bool Progress(Output& output, Ticket* ticket) {
    if (!ticket || ticket->generation != generation_ || ticket->phase != Ticket::Phase::Queued)
      return false;
    for (auto* prior = head_; prior && prior != ticket; prior = prior->next)
      if (!prior->material.complete) return false;
    if (!ticket->material.complete) output.ProgressWrite(ticket->material, true);
    return ticket->material.complete;
  }
  void Retire(Ticket* ticket) noexcept {
    if (!ticket || ticket->generation != generation_) return;
    if (ticket->phase == Ticket::Phase::Queued || ticket->phase == Ticket::Phase::Delivering) {
      if (ticket->previous) ticket->previous->next = ticket->next;else head_ = ticket->next;
      if (ticket->next) ticket->next->previous = ticket->previous;else tail_ = ticket->previous;
    }
    ticket->previous = ticket->next = nullptr;ticket->phase = Ticket::Phase::Retired;
  }
  void Close() noexcept {
    closed_ = true;
    // Completed physical writes keep their success. Only unfinished requests
    // are canceled, and their callbacks still precede the parent close.
    for (auto* ticket = head_; ticket; ticket = ticket->next) {
      if (!ticket->material.complete) {
        ticket->material.error = ECANCELED;ticket->material.complete = true;
      }
    }
  }
};
}  // namespace kandelo::terminal
#endif
