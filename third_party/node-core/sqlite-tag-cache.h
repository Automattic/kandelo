// Native LRU ownership used by SQLTagStore. Node's MIT-licensed
// src/lru_cache-inl.h supplies ordering; insertion rolls back allocation failure.
#ifndef KANDELO_NODE_SQLITE_TAG_CACHE_H_
#define KANDELO_NODE_SQLITE_TAG_CACHE_H_
#include <cstddef>
#include <iterator>
#include <list>
#include <string>
#include <unordered_map>
#include <utility>
namespace kandelo::sqlite {
template <typename Value> class TagCache {
  using Entry = std::pair<std::string, Value>;
  using List = std::list<Entry>;
  List entries_;
  std::unordered_map<std::string, typename List::iterator> index_;
  const std::size_t capacity_;
 public:
  explicit TagCache(std::size_t capacity) : capacity_(capacity) {}
  std::size_t Capacity() const noexcept { return capacity_; }
  std::size_t Size() const noexcept { return index_.size(); }
  Value* Get(const std::string& key) {
    auto found=index_.find(key);if (found==index_.end()) return nullptr;
    entries_.splice(entries_.begin(),entries_,found->second);
    return &found->second->second;
  }
  void Erase(const std::string& key) {
    auto found=index_.find(key);if (found==index_.end()) return;
    entries_.erase(found->second);index_.erase(found);
  }
  void Put(const std::string& key, Value value) {
    auto found=index_.find(key);
    if (found!=index_.end()) {
      found->second->second=std::move(value);
      entries_.splice(entries_.begin(),entries_,found->second);return;
    }
    entries_.emplace_front(key,std::move(value));
    try { index_.emplace(entries_.front().first,entries_.begin()); }
    catch (...) { entries_.pop_front();throw; }
    if (index_.size()>capacity_) {
      auto last=std::prev(entries_.end());index_.erase(last->first);entries_.erase(last);
    }
  }
  void Clear() { entries_.clear();index_.clear(); }
  template <typename Visitor> void ForEach(Visitor&& visitor) {
    for (auto& item:entries_) visitor(item.second);
  }
};
} // namespace kandelo::sqlite
#endif
