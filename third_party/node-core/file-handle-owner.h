// Actual single-owner descriptor lifetime for Node FileHandle and its work.
#ifndef KANDELO_NODE_FILE_HANDLE_OWNER_H_
#define KANDELO_NODE_FILE_HANDLE_OWNER_H_
#include <cerrno>
#include <utility>
#include <unistd.h>

namespace kandelo::nodefs {
// This owner contains no JS pointer, realm, pathname or duplicated descriptor.
// A move preserves the actual descriptor and its kernel open-file description.
class FileHandleLease final {
  int fd_ = -1;
 public:
  explicit FileHandleLease(int fd = -1) noexcept : fd_(fd) {}
  FileHandleLease(FileHandleLease&& prior) noexcept : fd_(prior.Release()) {}
  FileHandleLease(const FileHandleLease&) = delete;
  FileHandleLease& operator=(const FileHandleLease&) = delete;
  FileHandleLease& operator=(FileHandleLease&&) = delete;
  ~FileHandleLease() { Close(); }
  int Fd() const noexcept { return fd_; }
  int Release() noexcept { return std::exchange(fd_, -1); }
  bool Adopt(FileHandleLease& prior) noexcept {
    if (fd_ >= 0 || prior.fd_ < 0) return false;
    fd_ = prior.Release(); return true;
  }
  static int CloseDescriptor(int fd) noexcept {
    const int result = ::close(fd);
    // libuv does not retry a descriptor number after EINTR/EINPROGRESS:
    // the old number may already name another open-file description.
    return result == 0 || errno == EINTR || errno == EINPROGRESS ? 0 : -errno;
  }
  int Close() noexcept {
    const int fd = Release();
    return fd < 0 ? 0 : CloseDescriptor(fd);
  }
};
}  // namespace kandelo::nodefs
#endif
