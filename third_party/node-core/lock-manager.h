// Guest-process Web Locks ownership. Only copied metadata crosses environments;
// callbacks, promises and engine roots belong to the receiving JSContext.
#ifndef KANDELO_NODE_LOCK_MANAGER_H
#define KANDELO_NODE_LOCK_MANAGER_H
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <list>
#include <map>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace kandelo::locks {
using Identity = uint64_t;
enum class Mode { Shared, Exclusive };
enum class State { Pending, Held, Miss, Stolen, StolenDelivered };
enum class Completion { Absent, Completed, Stolen };
struct Info {
  Identity id = 0, environment = 0;
  std::u16string name;
  std::string clientId;
  Mode mode = Mode::Exclusive;
};
struct Event {
  enum class Kind { Empty, Grant, Miss, Stolen };
  Kind kind = Kind::Empty;
  Info info;
  std::vector<Identity> localStolen;
};
struct Snapshot { std::vector<Info> held, pending; };

class Manager {
  struct Record { Info info; State state; bool steal, ifAvailable; };
  mutable std::mutex mutex_;
  std::condition_variable changed_;
  Identity next_ = 1;
  std::set<Identity> environments_;
  std::map<Identity, Record> records_;
  std::list<Identity> pending_;

  Identity Allocate() {
    // JS bridge identities are exact Numbers, never lossy pointer values.
    if (next_ >= 9007199254740991ULL) throw std::overflow_error("Web Locks identity exhausted");
    return next_++;
  }
  bool Eligible(std::list<Identity>::const_iterator current) const {
    const auto& request = records_.at(*current);
    // Preserve pinned ProcessQueue's earliest-request compatibility rule.
    for (auto it = pending_.begin(); it != current; ++it) {
      const auto& earlier = records_.at(*it);
      if (earlier.info.name == request.info.name) {
        if (earlier.info.mode == Mode::Exclusive || request.info.mode == Mode::Exclusive) return false;
        break;
      }
    }
    if (request.steal) return true;
    for (const auto& entry : records_) {
      const auto& held = entry.second;
      if (held.state == State::Held && held.info.name == request.info.name &&
          (held.info.mode == Mode::Exclusive || request.info.mode == Mode::Exclusive)) return false;
    }
    return true;
  }
  bool ReadyUnlocked(Identity environment) const {
    if (!environments_.count(environment)) return false;
    for (const auto& entry : records_)
      if (entry.second.info.environment == environment && entry.second.state == State::Stolen) return true;
    for (auto it = pending_.begin(); it != pending_.end(); ++it) {
      const auto& request = records_.at(*it);
      if (request.info.environment == environment && (request.ifAvailable || Eligible(it))) return true;
    }
    return false;
  }
  struct Candidate { Event::Kind kind; Identity id; };
  Candidate SelectUnlocked(Identity environment) const {
    if (!environments_.count(environment)) return {Event::Kind::Empty, 0};
    for (const auto& entry : records_)
      if (entry.second.info.environment == environment && entry.second.state == State::Stolen)
        return {Event::Kind::Stolen, entry.first};
    for (auto it = pending_.begin(); it != pending_.end(); ++it) {
      const auto& request = records_.at(*it);
      if (request.info.environment != environment) continue;
      const bool eligible = Eligible(it);
      if (eligible || request.ifAvailable)
        return {eligible ? Event::Kind::Grant : Event::Kind::Miss, *it};
    }
    return {Event::Kind::Empty, 0};
  }
  Event PreviewUnlocked(Identity environment) const {
    const auto candidate = SelectUnlocked(environment);
    if (candidate.kind == Event::Kind::Empty) return {};
    const auto& request = records_.at(candidate.id);
    Event event{candidate.kind, request.info, {}};
    if (candidate.kind == Event::Kind::Grant && request.steal)
      for (const auto& entry : records_)
        if (entry.second.state == State::Held && entry.second.info.name == request.info.name &&
            entry.second.info.environment == environment) event.localStolen.push_back(entry.first);
    return event;
  }
  bool CommitUnlocked(const Event& event) {
    // No allocation or JS operation occurs after validation begins. Another
    // environment may progress while the receiver allocates its packet/errors;
    // a stale preview simply retries without consuming any ownership or wake.
    const auto selected = SelectUnlocked(event.info.environment);
    if (selected.kind == Event::Kind::Empty || selected.kind != event.kind || selected.id != event.info.id) return false;
    auto& request = records_.at(selected.id);
    if (event.kind == Event::Kind::Stolen) { request.state = State::StolenDelivered; return true; }
    if (event.kind == Event::Kind::Grant && request.steal) {
      size_t index = 0;
      for (const auto& entry : records_) {
        const auto& held = entry.second;
        if (held.state == State::Held && held.info.name == request.info.name &&
            held.info.environment == event.info.environment) {
          if (index == event.localStolen.size() || event.localStolen[index++] != entry.first) return false;
        }
      }
      if (index != event.localStolen.size()) return false;
      for (auto& entry : records_) {
        auto& held = entry.second;
        if (held.state == State::Held && held.info.name == request.info.name)
          held.state = held.info.environment == event.info.environment ? State::StolenDelivered : State::Stolen;
      }
    }
    request.state = event.kind == Event::Kind::Grant ? State::Held : State::Miss;
    pending_.remove(event.info.id); changed_.notify_all(); return true;
  }
 public:
  Manager() = default;
  Manager(const Manager&) = delete;
  Manager& operator=(const Manager&) = delete;
  Identity Register() {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto id = Allocate(); environments_.insert(id); return id;
  }
  Identity Request(Identity environment, std::u16string name, std::string clientId,
                   Mode mode, bool steal = false, bool ifAvailable = false) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!environments_.count(environment)) throw std::logic_error("Retired Web Locks environment");
    const auto id = Allocate();
    records_.emplace(id, Record{Info{id, environment, std::move(name), std::move(clientId), mode}, State::Pending, steal, ifAvailable});
    try {
      if (steal) pending_.push_front(id); else pending_.push_back(id);
    } catch (...) { records_.erase(id); throw; }
    changed_.notify_all(); return id;
  }
  Event Preview(Identity environment) const {
    std::lock_guard<std::mutex> lock(mutex_); return PreviewUnlocked(environment);
  }
  bool Commit(const Event& event) {
    std::lock_guard<std::mutex> lock(mutex_); return CommitUnlocked(event);
  }
  // Portable consumers without JS packet construction can perform the same
  // prepare/commit under one lock. The engine deliberately splits those phases.
  Event Next(Identity environment) {
    std::lock_guard<std::mutex> lock(mutex_);
    Event event = PreviewUnlocked(environment);
    if (event.kind != Event::Kind::Empty) CommitUnlocked(event);
    return event;
  }
  Completion Complete(Identity environment, Identity request) {
    std::lock_guard<std::mutex> lock(mutex_);
    auto it = records_.find(request);
    if (it == records_.end() || it->second.info.environment != environment) return Completion::Absent;
    const bool stolen = it->second.state == State::Stolen || it->second.state == State::StolenDelivered;
    if (it->second.state == State::Pending) pending_.remove(request);
    records_.erase(it); changed_.notify_all(); return stolen ? Completion::Stolen : Completion::Completed;
  }
  Snapshot Query(Identity environment) const {
    std::lock_guard<std::mutex> lock(mutex_);
    Snapshot result;
    // Pinned native Query filters to the calling Environment, including its
    // unobserved stolen holder until that environment processes the wakeup.
    for (const auto& entry : records_) {
      const auto& record = entry.second;
      if (record.info.environment == environment &&
          (record.state == State::Held || record.state == State::Stolen)) result.held.push_back(record.info);
    }
    for (const auto id : pending_) {
      const auto& record = records_.at(id);
      if (record.info.environment == environment) result.pending.push_back(record.info);
    }
    return result;
  }
  bool Ready(Identity environment) const {
    std::lock_guard<std::mutex> lock(mutex_); return ReadyUnlocked(environment);
  }
  template<class Rep, class Period>
  bool WaitForReady(Identity environment, std::chrono::duration<Rep, Period> maximum) {
    std::unique_lock<std::mutex> lock(mutex_);
    changed_.wait_for(lock, maximum, [&] { return !environments_.count(environment) || ReadyUnlocked(environment); });
    return ReadyUnlocked(environment);
  }
  void Retire(Identity environment) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto it = pending_.begin(); it != pending_.end();) {
      if (records_.at(*it).info.environment == environment) it = pending_.erase(it); else ++it;
    }
    for (auto it = records_.begin(); it != records_.end();) {
      if (it->second.info.environment == environment) it = records_.erase(it); else ++it;
    }
    environments_.erase(environment); changed_.notify_all();
  }
};
}  // namespace kandelo::locks
#endif
