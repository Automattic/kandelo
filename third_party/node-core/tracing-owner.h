#ifndef KANDELO_NODE_TRACING_OWNER_H
#define KANDELO_NODE_TRACING_OWNER_H
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <unistd.h>
#include <utility>
#include "kandelo-node-monotonic-clock.h"
#include "kandelo-node-uv-error-table.h"
#if defined(__APPLE__)
#include <pthread.h>
#endif
namespace kandelo::tracing {
// These are executing-process/thread identities, never an embedding host PID or
// a worker ordinal. Guest builds take the real musl/kernel gettid path.
inline int ThreadIdentity(uint64_t* output) {
#if defined(__APPLE__)
  const int error = pthread_threadid_np(nullptr, output);
  return error;
#else
  const auto id = gettid();
  if (id < 0) return errno;
  *output = static_cast<uint64_t>(id); return 0;
#endif
}
inline std::string ErrorMessage(int error) {
  for (const auto& entry : kandelo::errors::entries)
    if (entry.number == -error) return entry.message;
  return "Unknown system error " + std::to_string(-error);
}
struct System {
  static int Open(const char* path) {
    return open(path, O_CREAT | O_WRONLY | O_TRUNC | O_CLOEXEC, 0644);
  }
  static ssize_t Write(int fd, const char* data, size_t length) {
    return write(fd, data, length);
  }
  static int Close(int fd) { return close(fd); }
};
// Category aggregation and sink lifetime are process-owned, not a per-realm
// list. Every producer uses this same mutex, including Worker contexts.
// The public pinned wrapper independently enforces ownsProcessState admission.
template<class IO = System> class Owner {
 public:
  using Categories = std::set<std::string>;
  ~Owner() { (void)Finish(); }
  int Enable(const Categories& names) {
    std::lock_guard<std::mutex> guard(mutex_);
    if (finished_) return ECANCELED;
    // Build a replacement before publication: allocation failure must not
    // leave only a prefix of the requested category set enabled.
    auto next = categories_;
    for (const auto& name : names) ++next[name];
    categories_.swap(next); return 0;
  }
  void Disable(const Categories& names) {
    std::lock_guard<std::mutex> guard(mutex_);
    for (const auto& name : names) {
      auto found = categories_.find(name);
      if (found != categories_.end() && --found->second == 0) categories_.erase(found);
    }
  }
  std::string Enabled() const {
    std::lock_guard<std::mutex> guard(mutex_);
    std::string result;
    // Same sorted unique union and empty-string joining policy as the pinned
    // LegacyTracingAgent::GetEnabledCategories, over the actual refcounts.
    for (const auto& entry : categories_) {
      if (!result.empty()) result += ',';
      result += entry.first;
    }
    return result;
  }
  bool Enabled(const std::string& group) const {
    std::lock_guard<std::mutex> guard(mutex_); return Matches(group);
  }
  int Append(const std::string& group, const std::string& fields) {
    std::lock_guard<std::mutex> guard(mutex_);
    if (finished_) return ECANCELED;
    if (!Matches(group)) return 0;
    if (error_) return error_;
    uint64_t timestamp, thread;
    if (clock::Nanoseconds(&timestamp) != 0) return errno;
    if (const int error = ThreadIdentity(&thread)) return error;
    if (fields.empty() || fields.front() != '{' || fields.back() != '}') return EINVAL;
    std::string event = "{\"pid\":" + std::to_string(getpid()) +
        ",\"tid\":" + std::to_string(thread) + ",\"ts\":" +
        std::to_string(timestamp / 1000) + ',' + fields.substr(1);
    if (!opened_) {
      opened_ = true;
      fd_ = IO::Open("node_trace.1.log");
      if (fd_ < 0) {
        // Match the native writer's visible failed-open/drop policy. No file
        // or successful write is manufactured; its diagnostic stays visible.
        const int error = errno;
        std::fprintf(stderr, "Could not open trace file node_trace.1.log: %s\n", ErrorMessage(error).c_str());
        return 0;
      }
      if (const int error = Write("{\"traceEvents\":[")) return error_ = error;
    }
    if (fd_ < 0) return 0;
    if (hasEvent_) event.insert(0, ",");
    if (const int error = Write(event)) return error_ = error;
    hasEvent_ = true; return 0;
  }
  int Finish() {
    std::lock_guard<std::mutex> guard(mutex_);
    if (finished_) return error_;
    finished_ = true;
    if (fd_ >= 0) {
      if (!error_) error_ = Write("]}");
      const int fd = std::exchange(fd_, -1);
      // A failed close does not authorize closing that numeric slot again.
      if (IO::Close(fd) != 0 && !error_) error_ = errno;
    }
    return error_;
  }
 private:
  bool Matches(const std::string& group) const {
    // Exact classic TraceConfig comma-group membership, not wildcard matching.
    size_t start = 0;
    for (;;) {
      const size_t end = group.find(',', start);
      if (categories_.find(group.substr(start, end - start)) != categories_.end()) return true;
      if (end == std::string::npos) return false;
      start = end + 1;
    }
  }
  int Write(const std::string& data) {
    size_t offset = 0;
    while (offset < data.size()) {
      const ssize_t size = IO::Write(fd_, data.data() + offset, data.size() - offset);
      if (size < 0) { if (errno == EINTR) continue; return errno; }
      if (size == 0) return EIO;
      offset += static_cast<size_t>(size);
    }
    return 0;
  }
  mutable std::mutex mutex_;
  std::map<std::string, size_t> categories_;
  int fd_ = -1, error_ = 0;
  bool opened_ = false, hasEvent_ = false, finished_ = false;
};
inline Owner<>& Process() { static Owner<> owner; return owner; }
class CategorySet {
 public:
  explicit CategorySet(Owner<>::Categories names) : names_(std::move(names)) {}
  ~CategorySet() { Disable(); }
  int Enable() {
    if (enabled_ || names_.empty()) return 0;
    const int error = Process().Enable(names_);
    if (!error) enabled_ = true;
    return error;
  }
  void Disable() {
    if (enabled_) { Process().Disable(names_); enabled_ = false; }
  }
 private:
  const Owner<>::Categories names_;
  bool enabled_ = false;
};
}  // namespace kandelo::tracing
#endif
