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
#include <sys/uio.h>
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
    // stdio slot was closed before open(). Also isolate a same-number reopen
    // after a concurrent close, avoiding dup3(fd, fd) and owned teardown of
    // the supplied number. Only our separate extra descriptor is retired.
    if (owned <= STDERR_FILENO || owned == supplied) {
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
  int SetBlocking(bool blocking) {
    if (fd_ < 0) return -EBADF;
    int flags;do { flags = fcntl(fd_, F_GETFL); } while (flags < 0 && errno == EINTR);
    if (flags < 0) return -errno;
    int status;do { status = fcntl(fd_, F_SETFL, blocking ? flags & ~O_NONBLOCK : flags | O_NONBLOCK); } while (status < 0 && errno == EINTR);
    return status < 0 ? -errno : 0;
  }
  int GetWindowSize(std::array<unsigned, 2>* result) const {
    if (fd_ < 0) return -EBADF;
    return WindowSize(fd_, result);
  }
  // One true writev attempt precedes WRITEWRAP initialization. Only the
  // submitted blocking remainder loops, matching uv__write's blocking path.
  // The material keeps exact original allocation capabilities and vector
  // progress; no syscall or retry consults the future borrowed fd number.
  template<class Material>
  bool ProgressWrite(Material& material, bool blockingRemainder = false) {
    if (material.complete) return true;
    if (fd_ < 0) { material.error = EBADF;material.complete = true;return true; }
    if (!material.Remaining()) { material.complete = true;return true; }
    do {
      const size_t count = material.vectors.size() - material.vectorIndex;
      const long limit = sysconf(_SC_IOV_MAX);
      const size_t maximum = limit > 0 ? size_t(limit) : 1;
      const int nbufs = int(std::min(count, maximum));
      ssize_t size;
      do { size = writev(fd_, material.vectors.data() + material.vectorIndex, nbufs); }
      while (size < 0 && errno == EINTR);
      if (size >= 0) material.Consume(size_t(size));
      else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != ENOBUFS) {
        material.error = errno;material.complete = true;
      }
      if (material.complete || !blockingRemainder) return material.complete;
    } while (true);
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
  bool ownsDescriptor_ = true;
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
    fd_ = owned;ownsDescriptor_ = true;return 0;
  }
  // IOHandle owns this descriptor and outlives its nested mode state. Binding
  // that actual retained capability avoids allocating another fd at setMode.
  int BindRetainedDescriptor(int fd) {
    if (fd_ >= 0) return -EBUSY;
    termios probe{};int status;
    do { status = tcgetattr(fd, &probe); } while (status < 0 && errno == EINTR);
    if (status < 0) return -errno;
    fd_ = fd;ownsDescriptor_ = false;return 0;
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
    if (ownsDescriptor_) close(fd);  // Never retry against a reused number.
    ownsDescriptor_ = true;
  }
};
// A captured TTY has one actual descriptor/OFD for reads, writes, window
// queries and mode changes. Generic streams preserve actual access mode and
// start nonblocking; captured output explicitly selects blocking afterwards.
// The original standalone policy-specific Open contract is retained as well.
class IOHandle {
  OutputHandle descriptor_;
  BorrowedInputMode mode_;
  int access_ = -1;
  // Like uv_tty_t::mode, successful mode state belongs to the retained
  // native handle, not the descriptor's lifetime. Close restores the device
  // but a live closing wrap still recognizes an unchanged requested mode.
  int currentMode_ = -1;
  bool modeOpen_ = false;
 public:
  IOHandle() = default;
  IOHandle(const IOHandle&) = delete;
  IOHandle& operator=(const IOHandle&) = delete;
  ~IOHandle() { Close(); }
  int Descriptor() const noexcept { return descriptor_.Descriptor(); }
  bool Readable() const noexcept { return Descriptor() >= 0 && access_ != O_WRONLY; }
  bool Writable() const noexcept { return Descriptor() >= 0 && access_ != O_RDONLY; }
  int Open(int supplied, bool input) {
    int saved;do { saved = fcntl(supplied, F_GETFL); } while (saved < 0 && errno == EINTR);
    if (saved < 0) return -errno;
    int status = descriptor_.Open(supplied);
    if (status) return status;
    currentMode_ = 0;
    int flags;do { flags = fcntl(Descriptor(), F_GETFL); } while (flags < 0 && errno == EINTR);
    if (flags < 0) status = -errno;
    else access_ = flags & O_ACCMODE;
    if (!status && input) {
      status = mode_.BindRetainedDescriptor(Descriptor());
      if (!status) { modeOpen_ = true;status = descriptor_.SetBlocking(false); }
    }
    if (status) {
      Close();currentMode_ = -1;
      // Reopen already preserved the supplied descriptor. Restore its original
      // status on post-publication failure; never close that borrowed number.
      int restored;do { restored = fcntl(supplied, F_SETFL, saved); } while (restored < 0 && errno == EINTR);
    }
    return status;
  }
  // Generic uv_tty_init-style admission: preserve the actual access mode,
  // start a successfully reopened stream nonblocking, and acquire termios
  // restoration only when a real mode transition requests it.
  int OpenStream(int supplied) {
    int saved;do { saved = fcntl(supplied, F_GETFL); } while (saved < 0 && errno == EINTR);
    if (saved < 0) return -errno;
    int status = descriptor_.Open(supplied);
    if (status) return status;
    currentMode_ = 0;
    int flags;do { flags = fcntl(Descriptor(), F_GETFL); } while (flags < 0 && errno == EINTR);
    if (flags < 0) status = -errno;
    else { access_ = flags & O_ACCMODE;status = descriptor_.SetBlocking(false); }
    if (status) {
      Close();currentMode_ = -1;
      int restored;do { restored = fcntl(supplied, F_SETFL, saved); } while (restored < 0 && errno == EINTR);
    }
    return status;
  }
  int SetMode(int mode) {
    if (mode == 3) mode = 1; // UNIX maps the two raw variants before equality.
    if (currentMode_ >= 0 && mode == currentMode_) return 0;
    if (Descriptor() < 0) return -EBADF;
    if (mode < 0 || mode > 2) return -EINVAL;
    if (!modeOpen_) {
      const int status = mode_.BindRetainedDescriptor(Descriptor());
      if (status) return status;
      modeOpen_ = true;
    }
    const int status = mode_.SetMode(mode);
    if (!status) currentMode_ = mode;
    return status;
  }
  int SetBlocking(bool blocking) { return descriptor_.SetBlocking(blocking); }
  int GetWindowSize(std::array<unsigned, 2>* result) const {
    return descriptor_.GetWindowSize(result);
  }
  template<class Material>
  bool ProgressWrite(Material& material, bool blockingRemainder = false) {
    if (material.complete) return true;
    if (!Writable()) { material.error = Descriptor() < 0 ? EBADF : EPIPE;material.complete = true;return true; }
    // Input captures share this same owner but remain nonblocking. Never
    // apply the blocking-output retry loop to a nonblocking descriptor.
    int flags;do { flags = fcntl(Descriptor(), F_GETFL); } while (flags < 0 && errno == EINTR);
    if (flags < 0) { material.error = errno;material.complete = true;return true; }
    return descriptor_.ProgressWrite(material, blockingRemainder && !(flags & O_NONBLOCK));
  }
  OutputHandle::WriteResult Write(const uint8_t* bytes, size_t length) {
    if (!Writable()) return {Descriptor() < 0 ? -EBADF : -EPIPE, 0};
    return descriptor_.Write(bytes, length);
  }
  void Close() {
    mode_.Close();modeOpen_ = false;descriptor_.Close();access_ = -1;
  }
};
// Preserve the existing standalone captured-input helper contract. Production
// native TTY leases below now consume IOHandle directly for both policies.
class InputHandle : public IOHandle {
 public:
  int Open(int supplied) { return IOHandle::Open(supplied, true); }
};
}  // namespace kandelo::terminal
#endif
