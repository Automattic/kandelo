// Actual guest pathname/read/environment ownership, separate from parser policy.
#ifndef KANDELO_NODE_DOTENV_FILE_H
#define KANDELO_NODE_DOTENV_FILE_H
#include <cerrno>
#include <fcntl.h>
#include <unistd.h>
#include "kandelo-node-dotenv-parser.h"
namespace kandelo::dotenv {
enum class Failure { None, Open, Read, Close };
struct Result { Failure failure = Failure::None; int error = 0; };
inline Result Load(const char* path, Dotenv& parser) {
  int fd;
  do { fd = ::open(path, O_RDONLY | O_CLOEXEC); } while (fd < 0 && errno == EINTR);
  if (fd < 0) return {Failure::Open, errno};
  struct Owner {
    int fd;
    ~Owner() { if (fd >= 0) ::close(fd); }
  } owner{fd};
  std::string content;
  char buffer[8192];
  for (;;) {
    ssize_t count;
    do { count = ::read(fd, buffer, sizeof(buffer)); } while (count < 0 && errno == EINTR);
    if (count < 0) return {Failure::Read, errno};
    if (count == 0) break;
    content.append(buffer, size_t(count));
  }
  // Never retry a released descriptor number after an interrupted close.
  owner.fd = -1;
  if (::close(fd) < 0) return {Failure::Close, errno};
  parser.ParseContent(content);
  return {};
}
}  // namespace kandelo::dotenv
#endif
