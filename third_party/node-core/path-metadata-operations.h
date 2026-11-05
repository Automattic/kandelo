#ifndef KANDELO_NODE_PATH_METADATA_OPERATIONS_H
#define KANDELO_NODE_PATH_METADATA_OPERATIONS_H
#include <cerrno>
#include <cstdint>
#include <fcntl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
namespace kandelo::nodefs {
enum class MetadataOperation { Access, Chmod, Chown, Lchown, Utimes, Lutimes, Link };
struct MetadataOptions {
  uint32_t mode = 0;
  uid_t uid = uid_t(-1);
  gid_t gid = gid_t(-1);
  timespec times[2]{};
};
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
