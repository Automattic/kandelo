// Focused real POSIX race control. Only the reopen call is intercepted to
// perform the concurrent-close interleaving documented in pinned uv_tty_init.
// It still invokes real close/open/fcntl/dup2/ioctl/write/close operations.
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
#if defined(__APPLE__)
#include <util.h>
#else
#include <pty.h>
#endif
#include <cstdio>
static int supplied = -1;
static bool armClose = false, sawSameNumber = false;
static int ReopenAfterConcurrentClose(const char* path, int flags) {
  if (armClose) {
    armClose = false;
    assert(close(supplied) == 0);
    const int result = open(path, flags);
    sawSameNumber = result == supplied;
    return result;
  }
  return open(path, flags);
}
#define open ReopenAfterConcurrentClose
#include "terminal-operations.h"
#undef open
int main() {
  int master;
  assert(openpty(&master, &supplied, nullptr, nullptr, nullptr) == 0);
  assert(master > 2 && supplied > 2);
  winsize dimensions{};dimensions.ws_col = 104;dimensions.ws_row = 49;
  assert(ioctl(master, TIOCSWINSZ, &dimensions) == 0);
  kandelo::terminal::OutputHandle owner;
  armClose = true;
  const int error = owner.Open(supplied);
  assert(sawSameNumber);
  // Closing the last slave during the interleaving can reset PTY geometry;
  // apply the query dimensions to the real terminal after initialization.
  assert(ioctl(master, TIOCSWINSZ, &dimensions) == 0);
  const int descriptor = owner.Descriptor();
  std::array<unsigned, 2> size{};
  const bool separate = error == 0 && descriptor > 2 && descriptor != supplied;
  const bool query = error == 0 && kandelo::terminal::WindowSize(owner.Descriptor(), &size) == 0 && size[0] == 104 && size[1] == 49;
  const uint8_t byte = 'R';
  const auto write = owner.Write(&byte, 1);
  char readByte = 0;
  const bool written = write.error == 0 && write.transferred == 1 && read(master, &readByte, 1) == 1 && readByte == 'R';
  owner.Close();
  const bool publicOpen = fcntl(supplied, F_GETFD) >= 0;
  std::printf("{\"actualSameNumberReopen\":true,\"error\":%d,\"separateOwner\":%s,\"actualWindowQuery\":%s,\"actualWrite\":%s,\"publicFdSurvivesOwnerClose\":%s,\"sourceScope\":\"native production header with real close/reopen interleaving; not guest or public constructor parity\"}\n", error, separate?"true":"false", query?"true":"false", written?"true":"false", publicOpen?"true":"false");
  if (publicOpen) close(supplied);
  close(master);
  return separate && query && written && publicOpen ? 0 : 1;
}
