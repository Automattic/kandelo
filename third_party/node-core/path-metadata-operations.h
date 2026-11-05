#ifndef KANDELO_NODE_PATH_METADATA_OPERATIONS_H
#define KANDELO_NODE_PATH_METADATA_OPERATIONS_H
#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <memory>
#include <string>
#include <vector>
#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
namespace kandelo::nodefs {
enum class MetadataOperation { Access, Chmod, Chown, Lchown, Utimes, Lutimes, Link, Readlink, Realpath };
struct MetadataOptions {
  uint32_t mode = 0;
  uid_t uid = uid_t(-1);
  gid_t gid = gid_t(-1);
  timespec times[2]{};
};
inline bool MetadataReadsPath(MetadataOperation operation) {
  return operation == MetadataOperation::Readlink || operation == MetadataOperation::Realpath;
}
struct MetadataPathResult {
  int status = 0;
  std::string bytes;
};
inline MetadataPathResult ReadMetadataPath(MetadataOperation operation, const char* path) {
  if (operation == MetadataOperation::Realpath) {
    char* raw;
    do { raw = ::realpath(path, nullptr); } while (!raw && errno == EINTR);
    if (!raw) return {-errno, {}};
    std::unique_ptr<char, decltype(&std::free)> owned(raw, std::free);
    return {0, std::string(owned.get())};
  }
  if (operation != MetadataOperation::Readlink) return {-EINVAL, {}};
  // readlink does not terminate or report the required length. Grow on an
  // exact fill, retaining every byte; a stat-then-read size can race changes.
  std::vector<char> buffer(256);
  for (;;) {
    ssize_t count;
    do { count = ::readlink(path, buffer.data(), buffer.size()); } while (count < 0 && errno == EINTR);
    if (count < 0) return {-errno, {}};
    if (size_t(count) < buffer.size()) return {0, std::string(buffer.data(), size_t(count))};
    if (buffer.size() > size_t(std::numeric_limits<ssize_t>::max()) / 2) return {-ENAMETOOLONG, {}};
    buffer.resize(buffer.size() * 2);
  }
}
inline int RunMetadata(MetadataOperation operation, const char* path, const MetadataOptions& options,
                       const char* destination = nullptr) {
  int result;
  do {
    switch (operation) {
      case MetadataOperation::Access: result = access(path, int(options.mode)); break;
      case MetadataOperation::Chmod: result = chmod(path, mode_t(options.mode)); break;
      case MetadataOperation::Chown: result = chown(path, options.uid, options.gid); break;
      case MetadataOperation::Lchown: result = lchown(path, options.uid, options.gid); break;
      case MetadataOperation::Utimes: result = utimensat(AT_FDCWD, path, options.times, 0); break;
      case MetadataOperation::Lutimes: result = utimensat(AT_FDCWD, path, options.times, AT_SYMLINK_NOFOLLOW); break;
      case MetadataOperation::Link:
        if (!destination) return -EINVAL;
        result = ::link(path, destination); break;
      default: return -EINVAL;
    }
  } while (result == -1 && errno == EINTR);
  return result == 0 ? 0 : -errno;
}
}  // namespace kandelo::nodefs
#endif
