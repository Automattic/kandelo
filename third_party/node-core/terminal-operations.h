#ifndef KANDELO_NODE_TERMINAL_OPERATIONS_H
#define KANDELO_NODE_TERMINAL_OPERATIONS_H
#include <array>
#include <cerrno>
#include <fcntl.h>
#include <pthread.h>
#include <sys/ioctl.h>
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
