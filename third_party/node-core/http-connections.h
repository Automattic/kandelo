// Native HTTP parser connection ownership and monotonic timeout tracking.
#ifndef KANDELO_NODE_HTTP_CONNECTIONS_H
#define KANDELO_NODE_HTTP_CONNECTIONS_H
#include <cassert>
#include <cerrno>
#include <cstdint>
#include <memory>
#include <system_error>
#include <utility>
#include <vector>
#include "monotonic-clock.h"
namespace kandelo::http {
// Exact pinned Node list primitive and append algorithm (see source manifest).
struct ParserListNode {
  ParserListNode* prev = this;
  ParserListNode* next = this;

  ParserListNode() = default;
  ~ParserListNode() { Remove(); }

  ParserListNode(const ParserListNode&) = delete;
  ParserListNode& operator=(const ParserListNode&) = delete;

  void Remove() {
    prev->next = next;
    next->prev = prev;
    prev = this;
    next = this;
  }
};
inline void ListPushBack(ParserListNode* head, ParserListNode* node) {
  node->Remove();
  node->prev = head->prev;
  node->next = head;
  head->prev->next = node;
  head->prev = node;
}
class ConnectionsList;
class ConnectionRecord;
struct ConnectionNode : ParserListNode {
  ConnectionRecord* record;
  explicit ConnectionNode(ConnectionRecord* record) : record(record) {}
};
inline uint64_t ConnectionNow() {
  uint64_t now;
  if (kandelo::clock::Nanoseconds(&now) != 0)
    throw std::system_error(errno, std::generic_category(), "clock_gettime");
  return now;
}
class ConnectionRecord final {
  friend class ConnectionsList;
  std::shared_ptr<ConnectionsList> list_;
  ConnectionNode all_{this}, active_{this};
  uint64_t lastMessageStart_ = 0;
  bool receivedData_ = false, headersCompleted_ = false;
  void* owner_ = nullptr;
 public:
  ConnectionRecord() = default;
  ConnectionRecord(const ConnectionRecord&) = delete;
  ConnectionRecord& operator=(const ConnectionRecord&) = delete;
  ~ConnectionRecord() { Detach(); }
  void Attach(std::shared_ptr<ConnectionsList> list, void* owner);
  void Detach();
  void Begin();
  void Headers() { headersCompleted_ = true; }
  void Complete();
  void* Owner() const { return owner_; }
};
class ConnectionsList final {
  friend class ConnectionRecord;
  ParserListNode all_, active_;
 public:
  ConnectionsList() = default;
  ConnectionsList(const ConnectionsList&) = delete;
  ConnectionsList& operator=(const ConnectionsList&) = delete;
  ~ConnectionsList() { assert(all_.next == &all_ && active_.next == &active_); }
  size_t Count() const {
    size_t count = 0;
    for (auto* n = all_.next; n != &all_; n = n->next) ++count;
    return count;
  }
  std::vector<ConnectionRecord*> All() const {
    std::vector<ConnectionRecord*> result;
    for (auto* n = all_.next; n != &all_; n = n->next)
      result.push_back(static_cast<ConnectionNode*>(n)->record);
    return result;
  }
  std::vector<ConnectionRecord*> Idle() const {
    std::vector<ConnectionRecord*> result;
    for (auto* n = all_.next; n != &all_; n = n->next) {
      auto* parser = static_cast<ConnectionNode*>(n)->record;
      if (parser->lastMessageStart_ == 0 || !parser->receivedData_)
        result.push_back(parser);
    }
    return result;
  }
  std::vector<ConnectionRecord*> Active() const {
    std::vector<ConnectionRecord*> result;
    for (auto* n = active_.next; n != &active_; n = n->next)
      result.push_back(static_cast<ConnectionNode*>(n)->record);
    return result;
  }
  std::vector<ConnectionRecord*> Expired(uint32_t headers, uint32_t request) {
    // Exact pinned unsigned millisecond-to-nanosecond and deadline policy.
    uint64_t headers_timeout = static_cast<uint64_t>(headers) * 1000000;
    uint64_t request_timeout = static_cast<uint64_t>(request) * 1000000;
    std::vector<ConnectionRecord*> result;
    if (headers_timeout == 0 && request_timeout == 0) return result;
    else if (request_timeout > 0 && headers_timeout > request_timeout)
      std::swap(headers_timeout, request_timeout);
    const uint64_t now = ConnectionNow();
    const uint64_t headers_deadline =
        (headers_timeout > 0 && now > headers_timeout) ? now - headers_timeout : 0;
    const uint64_t request_deadline =
        (request_timeout > 0 && now > request_timeout) ? now - request_timeout : 0;
    if (headers_deadline == 0 && request_deadline == 0) return result;
    ParserListNode* node = active_.next;
    while (node != &active_) {
      auto* parser = static_cast<ConnectionNode*>(node)->record;
      node = node->next;
      if ((!parser->headersCompleted_ && headers_deadline > 0 &&
            parser->lastMessageStart_ < headers_deadline) ||
          (request_deadline > 0 && parser->lastMessageStart_ < request_deadline)) {
        result.push_back(parser);
        parser->active_.Remove();
      }
    }
    return result;
  }
};
inline void ConnectionRecord::Detach() {
  all_.Remove(); active_.Remove(); list_.reset();
}
inline void ConnectionRecord::Attach(std::shared_ptr<ConnectionsList> list, void* owner) {
  Detach();
  // Idle and active intentionally overlap before first received byte; Node
  // tracks this to reject a connection that never starts sending headers.
  lastMessageStart_ = ConnectionNow();
  headersCompleted_ = receivedData_ = false;
  owner_ = owner; list_ = std::move(list);
  if (list_) {
    ListPushBack(&list_->all_, &all_);
    ListPushBack(&list_->active_, &active_);
  }
}
inline void ConnectionRecord::Begin() {
  headersCompleted_ = false; receivedData_ = true;
  lastMessageStart_ = ConnectionNow();
  if (list_) ListPushBack(&list_->active_, &active_);
}
inline void ConnectionRecord::Complete() {
  active_.Remove(); lastMessageStart_ = 0;
}
}  // namespace kandelo::http
#endif
