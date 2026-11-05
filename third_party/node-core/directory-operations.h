// POSIX pathname operations and Node's recursive mkdir continuation policy.
// Guest libc owns traversal, credentials, umask, symlinks and errno. No host
// pathname or synthetic directory state is substituted at this boundary.
#ifndef KANDELO_NODE_DIRECTORY_OPERATIONS_H
#define KANDELO_NODE_DIRECTORY_OPERATIONS_H
#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <utility>
#include <vector>

namespace kandelo::nodefs {
enum class PathOperation { Mkdir, Unlink, Rmdir, Mkdtemp };
struct DirectoryResult { int status = 0; std::string firstPath; };
struct PosixDirectoryBackend {
  int Mkdir(const std::string& path, mode_t mode) {
    int result;
    do { result = ::mkdir(path.c_str(), mode); } while (result < 0 && errno == EINTR);
    return result == 0 ? 0 : -errno;
  }
  int StatDirectory(const std::string& path, bool* directory) {
    struct stat metadata{}; int result;
    do { result = ::stat(path.c_str(), &metadata); } while (result < 0 && errno == EINTR);
    if (result < 0) return -errno;
    *directory = S_ISDIR(metadata.st_mode); return 0;
  }
};

// Port of the pinned MKDirpSync/MKDirpAsync continuation decisions. Keep
// original byte paths (including dot components/trailing separators), attempt
// the leaf first, and retry a missing leaf only once after visiting its parent.
template <typename Backend>
DirectoryResult Mkdir(Backend& backend, const std::string& path, mode_t mode,
                      bool recursive, bool asynchronous = false) {
  if (!recursive) return {backend.Mkdir(path, mode), {}};
  DirectoryResult result;
  std::vector<std::string> paths{path}, missing;
  while (!paths.empty()) {
    std::string next = std::move(paths.back()); paths.pop_back();
    int status = backend.Mkdir(next, mode);
    for (;;) {
      if (status == 0) {
        if (result.firstPath.empty()) result.firstPath = next;
      } else if (status == -EACCES || status == -ENOSPC ||
                 status == -ENOTDIR || status == -EPERM) {
        result.status = status; return result;
      } else if (status == -ENOENT) {
        std::string parent = next.substr(0, next.find_last_of('/'));
        if (parent != next) {
          if (std::find(missing.begin(), missing.end(), next) != missing.end()) {
            result.status = status; return result;
          }
          missing.push_back(next);
          paths.push_back(std::move(next)); paths.push_back(std::move(parent));
        } else if (paths.empty()) {
          status = -EEXIST; continue;
        }
      } else {
        const int original = status;
        bool directory = false;
        status = backend.StatDirectory(next, &directory);
        // Async Node translates the failed parent check to ENOTDIR while
        // sync Node preserves its stat error. These are distinct policies.
        if (asynchronous && original == -EEXIST && !paths.empty() &&
            (status < 0 || !directory)) status = -ENOTDIR;
        else if (status == 0 && !directory)
          status = original == -EEXIST && !paths.empty() ? -ENOTDIR : -EEXIST;
        if (status < 0) { result.status = status; return result; }
        if (asynchronous && !(original == -EEXIST && !paths.empty())) return result;
      }
      break;
    }
  }
  return result;
}
inline DirectoryResult RunPath(PathOperation operation, const std::string& path,
                               mode_t mode, bool recursive, bool asynchronous) {
  if (operation == PathOperation::Mkdtemp) {
    // Node appends six template bytes before libuv's real mkdtemp call.
    // libc owns candidate generation, atomic mkdir(0700) and collision retry;
    // no existence precheck or JS random-number source selects a free name.
    std::string name = path + "XXXXXX";
    char* created;
    do { created = ::mkdtemp(name.data()); } while (!created && errno == EINTR);
    return {created ? 0 : -errno, std::move(name)};
  }
  if (operation == PathOperation::Mkdir) {
    PosixDirectoryBackend backend;
    return Mkdir(backend, path, mode, recursive, asynchronous);
  }
  int status;
  do { status = operation == PathOperation::Unlink ?
      ::unlink(path.c_str()) : ::rmdir(path.c_str()); }
  while (status < 0 && errno == EINTR);
  return {status == 0 ? 0 : -errno, {}};
}
}  // namespace kandelo::nodefs
#endif
