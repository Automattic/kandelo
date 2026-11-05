#ifndef KANDELO_NODE_WRITE_FILE_OPERATIONS_H
#define KANDELO_NODE_WRITE_FILE_OPERATIONS_H
#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <fcntl.h>
#include <unistd.h>
namespace kandelo::nodefs {
struct WriteFileResult {
  int status = 0;
  const char* syscall = "write";
};
// Pinned WriteFileJob policy: actual open/write-all/close, with a write error
// taking precedence over a later close error. No pathname is reopened.
inline WriteFileResult WritePathFile(const char* path, int flags, mode_t mode,
                                     const char* data, size_t length) {
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
  int fd;
  do { fd = open(path, flags, mode); } while (fd < 0 && errno == EINTR);
  if (fd < 0) return {-errno, "open"};
  WriteFileResult result;
  size_t written = 0;
  while (written < length) {
    const size_t chunk = std::min(length - written, size_t(256u * 1024 * 1024));
    ssize_t count;
    do { count = write(fd, data + written, chunk); } while (count < 0 && errno == EINTR);
    if (count < 0) { result = {-errno, "write"}; break; }
    written += size_t(count);
  }
  const int closed = close(fd);
  if (closed < 0 && errno != EINTR && errno != EINPROGRESS && result.status == 0)
    result = {-errno, "close"};
  return result;
}
}  // namespace kandelo::nodefs
#endif
