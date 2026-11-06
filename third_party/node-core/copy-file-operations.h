#ifndef KANDELO_NODE_COPY_FILE_OPERATIONS_H
#define KANDELO_NODE_COPY_FILE_OPERATIONS_H
#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <fcntl.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>
#if defined(__linux__)
#include <linux/fs.h>
#endif
namespace kandelo::nodefs {
enum CopyFileFlags { CopyExclusive = 1, CopyClone = 2, CopyCloneForce = 4 };
// The guest has no reflink syscall. A native platform that actually exposes
// FICLONE uses its real ioctl; unsupported force must never become byte-copy.
struct CopyFileSystem {
  static int Open(const char* path, int flags, mode_t mode) {
#ifdef O_CLOEXEC
    flags |= O_CLOEXEC;
#endif
    int fd; do { fd = open(path, flags, mode); } while (fd < 0 && errno == EINTR);
    return fd;
  }
  static int Stat(int fd, struct stat* record) { return fstat(fd, record); }
  static int Truncate(int fd) { return ftruncate(fd, 0); }
  static int Close(int fd) {
    const int r = close(fd);
    // A retry could close an unrelated reused fd; this is libuv's policy.
    return r == 0 || errno == EINTR || errno == EINPROGRESS ? 0 : -errno;
  }
  static int Clone(int dst, int src) {
#ifdef FICLONE
    return ioctl(dst, FICLONE, src) == 0 ? 0 : -errno;
#else
    (void) dst; (void) src; return -ENOSYS;
#endif
  }
  static ssize_t Read(int fd, char* bytes, size_t size, off_t offset, bool positional) {
    ssize_t n;
    do { n = positional ? pread(fd, bytes, size, offset) : read(fd, bytes, size); }
    while (n < 0 && errno == EINTR);
    return n;
  }
  static ssize_t Write(int fd, const char* bytes, size_t size) {
    ssize_t n; do { n = write(fd, bytes, size); } while (n < 0 && errno == EINTR); return n;
  }
  static int Writable(int fd) {
    pollfd item{fd, POLLOUT, 0}; int n;
    do { n = poll(&item, 1, -1); } while (n < 0 && errno == EINTR);
    return n < 0 || (item.revents & ~POLLOUT) ? -EIO : 0;
  }
  static int Permissions(int fd, mode_t mode) { return fchmod(fd, mode); }
  static void Metadata(int fd, const struct stat& source) {
    timespec times[2];
#ifdef __APPLE__
    times[0] = source.st_atimespec; times[1] = source.st_mtimespec;
#else
    times[0] = source.st_atim; times[1] = source.st_mtim;
#endif
    (void) futimens(fd, times);
    // Like pinned libuv, ownership/timestamp failures are ignored, while
    // fchmod below is checked. Apply before copying, including for empty files.
    const int ignored = fchown(fd, source.st_uid, source.st_gid); (void) ignored;
  }
  static void Unlink(const char* path) { (void) unlink(path); }
};
// Node v26.13.0 libuv uv__fs_copyfile policy with the bounded, portable
// uv__fs_sendfile_emul byte path. Paths and both fds stay owned throughout.
template<class System = CopyFileSystem>
inline int CopyPathFile(const char* source, const char* destination, int flags) {
  if (flags & ~(CopyExclusive | CopyClone | CopyCloneForce)) return -EINVAL;
  const int src = System::Open(source, O_RDONLY, 0);
  if (src < 0) return -errno;
  int dst = -1;
  const auto perform = [&]() -> int {
    struct stat from{}, to{};
    if (System::Stat(src, &from) < 0) return -errno;
    // Do not truncate until after the fd-based inode identity check. O_EXCL
    // belongs to this actual open, never a preceding pathname existence test.
    dst = System::Open(destination, O_WRONLY | O_CREAT | ((flags & CopyExclusive) ? O_EXCL : 0), from.st_mode);
    if (dst < 0) return -errno;
    if (!(flags & CopyExclusive)) {
      if (System::Stat(dst, &to) < 0) return -errno;
      if (from.st_dev == to.st_dev && from.st_ino == to.st_ino) return 0;
      if (System::Truncate(dst) < 0 && (errno != EACCES || to.st_size > 0)) return -errno;
    }
    System::Metadata(dst, from);
    if (System::Permissions(dst, from.st_mode) < 0) return -errno;
    if (flags & (CopyClone | CopyCloneForce)) {
      const int cloned = System::Clone(dst, src);
      if (cloned == 0) return 0;
      if (flags & CopyCloneForce) return cloned;
    }
    // Directory size is metadata about entries, not a byte-copy extent:
    // an empty guest directory legitimately has size zero. Preserve the
    // open/metadata/clone errors above, then reject its actual inode type
    // before a size-bound loop could misreport an empty file as a copy.
    if (S_ISDIR(from.st_mode)) return -EISDIR;
    off_t remaining = from.st_size, offset = 0;
    bool positional = true;
    char bytes[8192];
    while (remaining > 0) {
      const size_t count = size_t(std::min(remaining, off_t(sizeof(bytes))));
      const ssize_t n = System::Read(src, bytes, count, offset, positional);
      if (n < 0) {
        if (positional && offset == 0 && (errno == EIO || errno == ESPIPE)) { positional = false; continue; }
        return -errno;
      }
      // A concurrently shortened source can reach EOF before its old stat
      // size. There is no atomicity promise; never spin forever at that EOF.
      if (n == 0) break;
      size_t used = 0;
      while (used < size_t(n)) {
        const ssize_t written = System::Write(dst, bytes + used, size_t(n) - used);
        if (written > 0) { used += size_t(written); continue; }
        if (written == 0) return -EIO;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return -errno;
        const int ready = System::Writable(dst); if (ready < 0) return ready;
      }
      remaining -= n; offset += n;
    }
    return 0;
  };
  int result = perform();
  const int sourceClose = System::Close(src);
  if (result == 0) result = sourceClose;
  if (dst >= 0) {
    const int destinationClose = System::Close(dst);
    if (result == 0) result = destinationClose;
    // libuv removes even an existing destination after failure, but never
    // removes a destination whose open failed (notably an EXCL race loser).
    if (result != 0) System::Unlink(destination);
  }
  return result;
}
}  // namespace kandelo::nodefs
#endif
