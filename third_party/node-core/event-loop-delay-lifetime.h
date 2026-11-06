// ELD-owned native storage and allocation-free deferred close ownership.
// All claims/account handles are contextless metadata; no JS roots live here.
#ifndef KANDELO_NODE_EVENT_LOOP_DELAY_LIFETIME_H_
#define KANDELO_NODE_EVENT_LOOP_DELAY_LIFETIME_H_
#include "native-retained-memory.h"
#include <algorithm>
#include <memory>
#include <utility>
#include <vector>
namespace kandelo::histogram {
// The actual complete allocated type supplies its size, including embedded
// claims/records. Shared_ptr control blocks and ledger metadata retain the
// same explicitly excluded infrastructure scope as the process ledger.
template <class Complete> class ELDRetained {
  memory::Allocation allocation_{sizeof(Complete)};
  memory::Claim claim_;
 public:
  explicit ELDRetained(const memory::AccountHandle& account = nullptr)
      : claim_(allocation_.Handle(), account) {}
  const memory::RecordHandle& RetainedAllocation() const noexcept {
    return allocation_.Handle();
  }
  void ResizeExtra(size_t bytes) noexcept {
    allocation_.Resize(sizeof(Complete) + bytes);
  }
};
// Pinned libuv links each closing handle at the head and detaches the whole
// list before retiring it. Transfer requires no allocation in a GC finalizer.
// State owns a shared_ptr<State> nextClosing and an idempotent Retire().
template <class State> class ELDCloses final : public ELDRetained<ELDCloses<State>> {
  std::shared_ptr<State> head_;
  bool detached_ = false;
 public:
  explicit ELDCloses(const memory::AccountHandle& account)
      : ELDRetained<ELDCloses<State>>(account) {}
  ~ELDCloses() { Shutdown(); }
  bool Pending() const noexcept { return !!head_; }
  void Enqueue(std::shared_ptr<State> owner) noexcept {
    if (detached_) { owner->Retire(); return; }
    owner->nextClosing = std::move(head_); head_ = std::move(owner);
  }
  void Drain() noexcept {
    auto pending = std::move(head_);
    while (pending) {
      auto next = std::move(pending->nextClosing);
      pending->Retire(); pending = std::move(next);
    }
  }
  void Shutdown() noexcept { detached_ = true; Drain(); }
};
// A vector makes every requested registry allocation explicit. Contexts have
// stable heap addresses; vector growth never moves their actual native state.
template <class Key, class Context> class ELDRegistry final {
  struct Entry { Key key; std::shared_ptr<Context> context; };
  memory::Allocation retained_;
  std::vector<Entry> entries_;
 public:
  const memory::RecordHandle& RetainedAllocation() const noexcept {
    return retained_.Handle();
  }
  std::shared_ptr<Context> Find(Key key) const noexcept {
    for (const auto& item : entries_) if (item.key == key) return item.context;
    return {};
  }
  void Add(Key key, std::shared_ptr<Context> context) {
    entries_.push_back({key, std::move(context)});
    retained_.Resize(entries_.capacity() * sizeof(Entry));
  }
  void Erase(Key key) noexcept {
    entries_.erase(std::remove_if(entries_.begin(), entries_.end(),
        [&](const auto& item) { return item.key == key; }), entries_.end());
    if (entries_.empty()) std::vector<Entry>{}.swap(entries_);
    retained_.Resize(entries_.capacity() * sizeof(Entry));
  }
  size_t StorageBytes() const noexcept { return entries_.capacity() * sizeof(Entry); }
};
}  // namespace kandelo::histogram
#endif
