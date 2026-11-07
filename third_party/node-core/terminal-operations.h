#ifndef KANDELO_NODE_TERMINAL_OPERATIONS_H
#define KANDELO_NODE_TERMINAL_OPERATIONS_H
#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <cerrno>
#include <fcntl.h>
#include <pthread.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <termios.h>
#include <unistd.h>
namespace kandelo::terminal {
class BorrowedInputMode;
struct ResetState {
  pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
  BorrowedInputMode* owner = nullptr;
  termios original{};
};
inline ResetState resetState;
inline int SetAttributes(int fd, int action, const termios& value) {
  int status;do { status = tcsetattr(fd, action, &value); } while (status < 0 && errno == EINTR);
  return status == 0 ? 0 : -errno;
}
inline int WindowSize(int fd, std::array<unsigned, 2>* result) {
  winsize value{};int status;
  do { status = ioctl(fd, TIOCGWINSZ, &value); } while (status < 0 && errno == EINTR);
  if (status < 0) return -errno;
  *result = {value.ws_col, value.ws_row};return 0;
}
// Reopened TTY output owns a distinct open-file description. The supplied
// stdio number is preserved by the same dup2 initialization contract as uv;
// teardown closes only our extra descriptor, never the borrowed stdio number.
// Unsupported reopen paths remain explicit; this is not a general uv_tty_t.
class OutputHandle {
  int fd_ = -1;
 public:
  struct WriteResult { int error; size_t transferred; };
  OutputHandle() = default;
  OutputHandle(const OutputHandle&) = delete;
  OutputHandle& operator=(const OutputHandle&) = delete;
  ~OutputHandle() { Close(); }
  int Descriptor() const noexcept { return fd_; }
  static bool SameTerminal(const struct stat& a, const struct stat& b) noexcept {
    return S_ISCHR(a.st_mode) && S_ISCHR(b.st_mode) && a.st_dev == b.st_dev && a.st_ino == b.st_ino;
  }
  int Open(int supplied) {
    if (fd_ >= 0) return -EBUSY;
    int saved;do { saved = fcntl(supplied, F_GETFL); } while (saved < 0 && errno == EINTR);
    if (saved < 0) return -errno;
    if (!isatty(supplied)) return -ENOTTY;
    // Generic pinned libuv slave test: opening a master path could allocate
    // a different PTY pair. Never use that path to claim OFD isolation.
    if (ptsname(supplied) != nullptr) return -ENOTSUP;
    char path[256];
    if (ttyname_r(supplied, path, sizeof(path)) != 0) return -ENOTSUP;
    struct stat original{};if (fstat(supplied, &original) < 0) return -errno;
    int owned = open(path, (saved & O_ACCMODE) | O_NOCTTY | O_CLOEXEC);
    if (owned < 0) return -ENOTSUP;
    struct stat reopened{};
    if (fstat(owned, &reopened) < 0 || !SameTerminal(original, reopened)) {
      close(owned);return -ENOTSUP;
    }
    // /dev/tty can be a dup of stdin in the current guest. Equal device
    // identity alone does not prove an independent OFD; avoid that fallback.
    if (!strcmp(path, "/dev/tty") || !strncmp(path, "/dev/fd/", 8) ||
        !strcmp(path, "/dev/stdin") || !strcmp(path, "/dev/stdout") || !strcmp(path, "/dev/stderr")) {
      close(owned);return -ENOTSUP;
    }
    // Keep our owned descriptor outside borrowed stdio even when another
    // stdio slot was closed before open(). Only this extra fd is retired.
    if (owned <= STDERR_FILENO) {
      int extra;do { extra = fcntl(owned, F_DUPFD_CLOEXEC, STDERR_FILENO + 1); } while (extra < 0 && errno == EINTR);
      if (extra < 0) { const int error = -errno;if (owned != supplied) close(owned);return error; }
      if (owned != supplied) close(owned);owned = extra;
    }
    int status;
#if defined(__wasm__) || defined(__linux__) || defined(__FreeBSD__) || defined(__NetBSD__)
    // These actual targets expose dup3; the guest libc/kernel implementation
    // atomically installs the descriptor-local CLOEXEC flag with replacement.
    status = dup3(owned, supplied, O_CLOEXEC);
#else
    // Same portable fallback as pinned uv__dup2_cloexec. No close retry.
    status = dup2(owned, supplied);
    if (status >= 0 && fcntl(supplied, F_SETFD, FD_CLOEXEC) < 0) {
      const int error = -errno;close(supplied);close(owned);return error;
    }
#endif
    if (status < 0) { const int error = -errno;close(owned);return error; }
    int flags;do { flags = fcntl(owned, F_GETFL); } while (flags < 0 && errno == EINTR);
    if (flags >= 0) {
      do { status = fcntl(owned, F_SETFL, flags & ~O_NONBLOCK); } while (status < 0 && errno == EINTR);
    } else status = -1;
    if (status < 0) {
      const int error = -errno;
      // Initialization published the same terminal at the supplied fd. Keep
      // that public number open and restore its original status on failure.
      (void)fcntl(supplied, F_SETFL, saved);close(owned);return error;
    }
    fd_ = owned;return 0;
  }
  WriteResult Write(const uint8_t* bytes, size_t length) {
    if (fd_ < 0) return {-EBADF, 0};
    size_t transferred = 0;
    while (transferred < length) {
      const size_t count = std::min(length - transferred, size_t(std::numeric_limits<ssize_t>::max()));
      ssize_t size;do { size = write(fd_, bytes + transferred, count); } while (size < 0 && errno == EINTR);
      if (size < 0) return {-errno, transferred};
      if (size == 0) return {-EIO, transferred};
      transferred += size_t(size);
    }
    return {0, transferred};
  }
  void Close() noexcept { if (fd_ < 0) return;const int fd = fd_;fd_ = -1;close(fd); }
};

// A real dup lease for the borrowed stdin mode owner, not uv_tty_t or a full
// Socket/TTY I/O handle. No O_NONBLOCK flags or caller descriptors are changed.
class BorrowedInputMode {
  int fd_ = -1, mode_ = 0;
  termios original_{};
 public:
  BorrowedInputMode() = default;
  BorrowedInputMode(const BorrowedInputMode&) = delete;
  BorrowedInputMode& operator=(const BorrowedInputMode&) = delete;
  ~BorrowedInputMode() { Close(); }
  int Open(int fd) {
    if (fd_ >= 0) return -EBUSY;
    int owned;do { owned = fcntl(fd, F_DUPFD_CLOEXEC, 0); } while (owned < 0 && errno == EINTR);
    if (owned < 0) return -errno;
    termios probe{};int status;
    do { status = tcgetattr(owned, &probe); } while (status < 0 && errno == EINTR);
    if (status < 0) { const int error = -errno;close(owned);return error; }
    fd_ = owned;return 0;
  }
  int SetMode(int mode) {
    if (fd_ < 0) return -EBADF;
    // Exact pinned libuv values: NORMAL=0, RAW=1, IO=2, RAW_VT=3.
    // The RAW variants share one actual UNIX mode.
    if (mode == 3) mode = 1;
    if (mode < 0 || mode > 2) return -EINVAL;
    if (mode_ == mode) return 0;
    if (mode_ == 0 && mode != 0) {
      int status;do { status = tcgetattr(fd_, &original_); } while (status < 0 && errno == EINTR);
      if (status < 0) return -errno;
      pthread_mutex_lock(&resetState.mutex);
      if (!resetState.owner) { resetState.owner = this;resetState.original = original_; }
      pthread_mutex_unlock(&resetState.mutex);
    }
    termios value = original_;
    if (mode == 1) {
      value.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON);
      value.c_oflag |= ONLCR;value.c_cflag |= CS8;
      value.c_lflag &= ~(ECHO | ICANON | IEXTEN | ISIG);
      value.c_cc[VMIN] = 1;value.c_cc[VTIME] = 0;
    } else if (mode == 2) cfmakeraw(&value);
    const int status = SetAttributes(fd_, TCSADRAIN, value);
    if (!status) mode_ = mode;
    return status;
  }
  void Close() {
    if (fd_ < 0) return;
    pthread_mutex_lock(&resetState.mutex);
    // The pinned owner resets only the first registered TTY on close, even
    // when another handle refers to the same device. Preserve that policy.
    if (resetState.owner == this) {
      SetAttributes(fd_, TCSANOW, resetState.original);resetState.owner = nullptr;
    }
    pthread_mutex_unlock(&resetState.mutex);
    const int fd = fd_;fd_ = -1;mode_ = 0;
    close(fd);  // Never retry a close against a potentially reused number.
  }
};
}  // namespace kandelo::terminal
#endif
