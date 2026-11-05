// Actual POSIX directory scans and the pinned Node recursive walk policy.
// Entry names remain bytes; only the owning JS completion encodes results.
#ifndef KANDELO_NODE_READDIR_OPERATIONS_H
#define KANDELO_NODE_READDIR_OPERATIONS_H
#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <dirent.h>
#include <string>
#include <sys/stat.h>
#include <type_traits>
#include <utility>
#include <vector>

#include "kandelo-node-dirent-types.h"

namespace kandelo::nodefs {
struct ReadEntry { std::string name; uv_dirent_type_t type; };
struct ReadDirectory { std::string relative; std::vector<ReadEntry> entries; };
struct ReadDirectories {
  int status = 0;
  std::string errorPath;
  std::deque<ReadDirectory> directories;
};
inline void AppendDirectoryComponent(std::string* path, const std::string& name) {
  if (name.empty()) return;
  if (!path->empty() && path->back() != '/') *path += '/';
  path->append(name);
}
inline uv_dirent_type_t DirectoryTypeFromMode(mode_t mode) {
  switch (mode & S_IFMT) {
    case S_IFREG: return UV_DIRENT_FILE;
    case S_IFDIR: return UV_DIRENT_DIR;
    case S_IFLNK: return UV_DIRENT_LINK;
    case S_IFCHR: return UV_DIRENT_CHAR;
    case S_IFBLK: return UV_DIRENT_BLOCK;
    case S_IFIFO: return UV_DIRENT_FIFO;
    case S_IFSOCK: return UV_DIRENT_SOCKET;
    default: return UV_DIRENT_UNKNOWN;
  }
}
template <typename T, typename = void> struct DirectoryHasType : std::false_type {};
template <typename T>
struct DirectoryHasType<T, std::void_t<decltype(std::declval<T>().d_type)>> : std::true_type {};
template <typename T> uv_dirent_type_t DirectoryEntryType(const T& entry) {
#if defined(DT_UNKNOWN)
  if constexpr (DirectoryHasType<T>::value) {
    switch (entry.d_type) {
      case DT_REG: return UV_DIRENT_FILE;
      case DT_DIR: return UV_DIRENT_DIR;
      case DT_LNK: return UV_DIRENT_LINK;
      case DT_CHR: return UV_DIRENT_CHAR;
      case DT_BLK: return UV_DIRENT_BLOCK;
      case DT_FIFO: return UV_DIRENT_FIFO;
      case DT_SOCK: return UV_DIRENT_SOCKET;
      default: break;
    }
  }
#endif
  return UV_DIRENT_UNKNOWN;
}
struct PosixReadDirectory {
  static int Filter(const dirent* entry) {
    return std::strcmp(entry->d_name, ".") && std::strcmp(entry->d_name, "..");
  }
  static int Compare(const dirent** a, const dirent** b) {
    return std::strcmp((*a)->d_name, (*b)->d_name);
  }
  int Read(const std::string& path, std::vector<ReadEntry>* entries) {
    dirent** raw = nullptr;
    int count;
    do { count = ::scandir(path.c_str(), &raw, Filter, Compare); }
    while (count < 0 && errno == EINTR);
    if (count < 0) return -errno;
    struct Owner {
      dirent** list; int count;
      ~Owner() { for (int i = 0; i < count; ++i) std::free(list[i]); std::free(list); }
    } owner{raw, count};
    entries->reserve(size_t(count));
    for (int i = 0; i < count; ++i)
      entries->push_back({raw[i]->d_name, DirectoryEntryType(*raw[i])});
    return 0;
  }
  int Stat(const std::string& path, bool follow, struct stat* value) {
    int result;
    do { result = follow ? ::stat(path.c_str(), value) : ::lstat(path.c_str(), value); }
    while (result < 0 && errno == EINTR);
    return result == 0 ? 0 : -errno;
  }
};

// Native Node derives breadth-first order from its parallel walk. A queued
// guest work item visits that same order directly; it never enters JS. Like
// the target, directory symlinks are followed, not silently pruned by inode.
// Unknown-type lstat/stat failures are retained as unknown/non-descending;
// an actual directory scan failure rejects with that directory's byte path.
template <typename Backend>
ReadDirectories ReadDirectoryTree(Backend& backend, const std::string& root, bool recursive) {
  ReadDirectories result;
  result.directories.push_back({{}, {}});
  for (size_t index = 0; index < result.directories.size(); ++index) {
    auto& directory = result.directories[index];  // deque append keeps references valid.
    std::string path = root;
    AppendDirectoryComponent(&path, directory.relative);
    result.status = backend.Read(path, &directory.entries);
    if (result.status < 0) { result.errorPath = path; return result; }
    if (!recursive) break;
    for (auto& entry : directory.entries) {
      bool descend = entry.type == UV_DIRENT_DIR;
      if (entry.type == UV_DIRENT_UNKNOWN || entry.type == UV_DIRENT_LINK) {
        std::string child = path;
        AppendDirectoryComponent(&child, entry.name);
        struct stat metadata{};
        if (entry.type == UV_DIRENT_UNKNOWN && backend.Stat(child, false, &metadata) == 0)
          entry.type = DirectoryTypeFromMode(metadata.st_mode);
        if (entry.type == UV_DIRENT_LINK && backend.Stat(child, true, &metadata) == 0)
          descend = S_ISDIR(metadata.st_mode);
      }
      if (entry.type == UV_DIRENT_DIR) descend = true;
      if (descend) {
        std::string relative = directory.relative;
        AppendDirectoryComponent(&relative, entry.name);
        result.directories.push_back({std::move(relative), {}});
      }
    }
  }
  return result;
}
inline ReadDirectories ReadDirectoryTree(const std::string& root, bool recursive) {
  PosixReadDirectory backend;
  return ReadDirectoryTree(backend, root, recursive);
}
}  // namespace kandelo::nodefs
#endif
