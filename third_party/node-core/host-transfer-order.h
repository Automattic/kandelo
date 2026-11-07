// Native wire metadata/receiver phase owner. No JS value, pointer or global
// registration token belongs here; descriptors live in their reader's roots.
#ifndef KANDELO_NODE_HOST_TRANSFER_ORDER_H
#define KANDELO_NODE_HOST_TRANSFER_ORDER_H
#include <cstddef>
#include <cstdint>
#include <vector>
namespace kandelo::clone {
class HostOrder {
 public:
  enum class Kind : uint32_t { Native = 0, JavaScript = 1 };
  struct Entry { Kind kind; uint32_t index; };
 private:
  std::vector<Entry> entries_;
  size_t cursor_ = 0;
  bool prepared_ = false, failed_ = false, nativePending_ = false;
 public:
  HostOrder() = default;
  HostOrder(const HostOrder&) = delete;
  HostOrder& operator=(const HostOrder&) = delete;
  HostOrder(HostOrder&&) = delete;
  HostOrder& operator=(HostOrder&&) = delete;
  bool Append(Kind kind, uint32_t index) {
    if (prepared_ || failed_) { failed_ = true;return false; }
    entries_.push_back({kind, index});return true;
  }
  const std::vector<Entry>& Entries() const noexcept { return entries_; }
  // Native transfer-map reads have fixed order. JS constructor indices may
  // interleave, but each must appear exactly once and every index is bounded.
  bool Prepare(uint64_t nativeCount, size_t javascriptCount) {
    if (prepared_ || failed_) return false;
    std::vector<bool> seen(javascriptCount, false);
    uint64_t previous = 0;bool haveNative = false;size_t seenCount = 0;
    for (const auto& entry : entries_) {
      if (entry.kind == Kind::Native) {
        if (entry.index >= nativeCount || (haveNative && entry.index <= previous)) return false;
        previous = entry.index;haveNative = true;
      } else if (entry.kind == Kind::JavaScript) {
        if (entry.index >= javascriptCount || seen[entry.index]) return false;
        seen[entry.index] = true;++seenCount;
      } else return false;
    }
    if (seenCount != javascriptCount) return false;
    prepared_ = true;return true;
  }
  bool MatchesNativeSlots(const uint32_t* actual, size_t length) noexcept {
    if (!prepared_ || failed_) return false;
    size_t used = 0;
    for (const auto& entry : entries_) if (entry.kind == Kind::Native) {
      if (used == length || actual[used++] != entry.index) { failed_ = true;return false; }
    }
    if (used != length) { failed_ = true;return false; }
    return true;
  }
  template<class Create>
  bool BeforeNative(uint32_t index, Create&& create) {
    if (!prepared_ || failed_ || nativePending_) { failed_ = true;return false; }
    while (cursor_ < entries_.size() && entries_[cursor_].kind == Kind::JavaScript) {
      if (!create(entries_[cursor_].index)) { failed_ = true;return false; }
      ++cursor_;
    }
    if (cursor_ == entries_.size() || entries_[cursor_].index != index) {
      failed_ = true;return false;
    }
    nativePending_ = true;return true;
  }
  bool CommitNative(uint32_t index) noexcept {
    if (!prepared_ || failed_ || !nativePending_ || cursor_ == entries_.size() ||
        entries_[cursor_].kind != Kind::Native || entries_[cursor_].index != index) {
      failed_ = true;return false;
    }
    nativePending_ = false;++cursor_;return true;
  }
  template<class Create>
  bool Finish(Create&& create) {
    if (!prepared_ || failed_ || nativePending_) { failed_ = true;return false; }
    while (cursor_ < entries_.size()) {
      if (entries_[cursor_].kind != Kind::JavaScript || !create(entries_[cursor_].index)) {
        failed_ = true;return false;
      }
      ++cursor_;
    }
    return true;
  }
};
} // namespace kandelo::clone
#endif
