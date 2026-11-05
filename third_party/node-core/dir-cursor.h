// Persistent POSIX directory ownership. No JS pointers enter native workers.
#ifndef KANDELO_NODE_DIR_CURSOR_H
#define KANDELO_NODE_DIR_CURSOR_H
#include <cerrno>
#include <cstdint>
#include <memory>
#include <mutex>
#include <utility>

#include "kandelo-node-readdir-operations.h"

namespace kandelo::nodefs {
struct DirectoryBatch { int status = 0; std::vector<ReadEntry> entries; };
class DirectoryCursor {
  DIR* directory_ = nullptr;
  bool pending_ = false;
  mutable std::mutex mutex_;
 public:
  DirectoryCursor() = default;
  DirectoryCursor(const DirectoryCursor&) = delete;
  DirectoryCursor& operator=(const DirectoryCursor&) = delete;
  ~DirectoryCursor() { if (directory_) ::closedir(directory_); }
  static std::shared_ptr<DirectoryCursor> Open(const std::string& path, int* status) {
    auto cursor = std::make_shared<DirectoryCursor>();
    do { cursor->directory_ = ::opendir(path.c_str()); }
    while (!cursor->directory_ && errno == EINTR);
    *status = cursor->directory_ ? 0 : -errno;
    return *status == 0 ? cursor : nullptr;
  }
  bool IsOpen() const { std::lock_guard<std::mutex> lock(mutex_); return directory_ != nullptr; }
  int Reserve() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!directory_) return -EBADF;
    if (pending_) return -EBUSY;
    pending_ = true; return 0;
  }
  void Release() { std::lock_guard<std::mutex> lock(mutex_); pending_ = false; }
  DirectoryBatch ReadReserved(uint32_t maximum) {
    DirectoryBatch batch;
    // The reservation is held through work completion, not just this syscall.
    // Each name is owned before the next readdir can reuse libc's buffer.
    // uv__fs_work retries READDIR on EINTR. uv__fs_readdir discards the
    // interrupted partial batch first; the persistent cursor stays advanced.
    do {
      batch.status = 0;
      batch.entries.clear();
      while (batch.entries.size() < maximum) {
        errno = 0;
        dirent* entry = ::readdir(directory_);
        if (!entry) { batch.status = -errno; break; }
        if (!std::strcmp(entry->d_name, ".") || !std::strcmp(entry->d_name, "..")) continue;
        batch.entries.push_back({entry->d_name, DirectoryEntryType(*entry)});
      }
      if (batch.status < 0) batch.entries.clear();
    } while (batch.status == -EINTR);
    return batch;
  }
  int CloseReserved() {
    DIR* directory;
    { std::lock_guard<std::mutex> lock(mutex_); directory = std::exchange(directory_, nullptr); }
    if (!directory) return -EBADF;
    // Pinned libuv uv__fs_closedir retires the cursor and discards closedir's
    // return value. Never retry a descriptor whose number may be reused.
    ::closedir(directory); return 0;
  }
  DirectoryBatch Read(uint32_t maximum) {
    const int status = Reserve(); if (status < 0) return {status, {}};
    struct Guard { DirectoryCursor* cursor; ~Guard() { cursor->Release(); } } guard{this};
    return ReadReserved(maximum);
  }
  int Close() {
    const int status = Reserve(); if (status < 0) return status;
    const int result = CloseReserved(); Release(); return result;
  }
};
}  // namespace kandelo::nodefs
#endif
