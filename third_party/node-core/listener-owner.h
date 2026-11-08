#ifndef KANDELO_NODE_LISTENER_OWNER_H_
#define KANDELO_NODE_LISTENER_OWNER_H_
#include <cerrno>
#include <cstdint>
#include <sys/socket.h>
#include <utility>
#include <unistd.h>
namespace kandelo::listener {
// The native listener capability owns this exact successfully admitted
// descriptor. No future JS property or caller-supplied fd is cleanup authority.
class Owner {
  int fd_ = -1;
  const uint64_t generation_;
  bool closed_ = false;
  bool referenced_ = true;
  bool listening_ = false;
 public:
  explicit Owner(uint64_t generation) noexcept : generation_(generation) {}
  Owner(const Owner&) = delete;
  Owner& operator=(const Owner&) = delete;
  ~Owner() { Close(); }
  int Fd() const noexcept { return fd_; }
  uint64_t Generation() const noexcept { return generation_; }
  bool Closed() const noexcept { return closed_; }
  bool Referenced() const noexcept { return referenced_; }
  // Registration is a result of this owner's actual successful listen, not
  // descriptor ownership or callback attachment. Keep it through callbacks.
  bool ReadRegistered() const noexcept { return listening_ && !closed_ && fd_ >= 0; }
  int Listen(int backlog) noexcept {
    if (closed_ || fd_ < 0) return EBADF;
    if (::listen(fd_, backlog) < 0) return errno;
    listening_ = true;return 0;
  }
  // The backing native HandleWrap can still be ref/unref'ed while closing.
  // Its consumer gates completed/detached phases; no descriptor is reopened.
  void Ref(bool value) noexcept { referenced_ = value; }
  // Caller retains its fd on unsuccessful admission. All fallible allocation
  // and validation precedes this sole, no-JS ownership transfer.
  bool Admit(int fd) noexcept {
    if (closed_ || fd_ >= 0 || fd < 0) return false;
    fd_ = fd;return true;
  }
  void Close() noexcept {
    listening_ = false;closed_ = true;const int fd = std::exchange(fd_, -1);
    if (fd >= 0) ::close(fd);
  }
};
} // namespace kandelo::listener
#endif
