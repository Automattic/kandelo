#ifndef KANDELO_NODE_REMOVAL_OPERATIONS_H
#define KANDELO_NODE_REMOVAL_OPERATIONS_H
#include <algorithm>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <dirent.h>
#include <filesystem>
#include <memory>
#include <string>
#include <system_error>
#include <unistd.h>
#include <vector>

namespace kandelo::nodefs {
struct ScanResult { int status = 0; std::vector<std::string> names; };
inline ScanResult ScanDirectory(const char* path) {
  DIR* raw;
  do { raw = ::opendir(path); } while (!raw && errno == EINTR);
  if (!raw) return {-errno, {}};
  struct Close { void operator()(DIR* p) const { ::closedir(p); } };
  std::unique_ptr<DIR, Close> directory(raw);
  ScanResult result;
  for (;;) {
    errno = 0;
    const auto* entry = ::readdir(directory.get());
    if (!entry) {
      if (errno == EINTR) continue;
      if (errno) return {-errno, {}};
      break;
    }
    if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, ".."))
      result.names.emplace_back(entry->d_name);
  }
  // libuv's scandir sorts raw names before exposing them to Node.
  std::sort(result.names.begin(), result.names.end());
  return result;
}
struct RemoveResult {
  int error = 0;
  bool directory = false;
  bool unknown = false;
  std::string message;
};
struct PosixRemovalBackend {
  std::filesystem::file_status Status(const std::string& path, std::error_code& error) {
    return std::filesystem::symlink_status(path, error);
  }
  void Remove(const std::string& path, bool recursive, std::error_code& error) {
    if (recursive) std::filesystem::remove_all(path, error);
    else std::filesystem::remove(path, error);
  }
  void Sleep(unsigned seconds) { ::sleep(seconds); }
};
// Follows the exact target's POSIX RmSync policy, including whole-second sleep
// truncation, an attempt at retries==0 and a delay after the last retryable
// error. It does not invent a JS blocking traversal or use C remove().
template<class Backend>
RemoveResult RemoveSync(Backend& backend, const std::string& path,
                        int32_t maxRetries, bool recursive, int32_t retryDelay) {
  std::error_code error;
  const auto status = backend.Status(path, error);
  if (status.type() == std::filesystem::file_type::not_found) return {};
  if (status.type() == std::filesystem::file_type::directory && !recursive)
    return {EISDIR, true, false, "Path is a directory: " + path};
  uint32_t attempt = 1;
  for (int64_t remaining = maxRetries; remaining >= 0; --remaining, ++attempt) {
    backend.Remove(path, recursive, error);
    if (!error || error == std::errc::no_such_file_or_directory) return {};
    if (error != std::errc::device_or_resource_busy &&
        error != std::errc::too_many_files_open &&
        error != std::errc::too_many_files_open_in_system &&
        error != std::errc::directory_not_empty &&
        error != std::errc::operation_not_permitted) break;
    if (retryDelay > 0) {
      // Explicit two's-complement arithmetic avoids C++ signed-overflow UB
      // while retaining the target's int32 multiplication/conversion policy.
      const uint32_t bits = attempt * static_cast<uint32_t>(retryDelay);
      const int64_t signedDelay = bits <= INT32_MAX ? bits : int64_t(bits) - 0x100000000LL;
      backend.Sleep(static_cast<unsigned>(signedDelay / 1000));
    }
  }
  if (error == std::errc::operation_not_permitted) return {EPERM, false, false, "Operation not permitted:"};
  if (error == std::errc::directory_not_empty) return {ENOTEMPTY, false, false, "Directory not empty:"};
  if (error == std::errc::not_a_directory) return {ENOTDIR, false, false, "Not a directory:"};
  if (error == std::errc::permission_denied) return {EACCES, false, false, "Permission denied:"};
  return {0, false, true, "Unknown error: " + error.message()};
}
inline RemoveResult RemoveSync(const std::string& path, int32_t retries,
                               bool recursive, int32_t delay) {
  PosixRemovalBackend backend;
  return RemoveSync(backend, path, retries, recursive, delay);
}
}  // namespace kandelo::nodefs
#endif
