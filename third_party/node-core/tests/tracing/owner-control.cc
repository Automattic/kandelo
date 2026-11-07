#include "../../tracing-owner.h"
#include <cassert>
#include <thread>
#include <sys/stat.h>
#include <vector>
namespace {
struct PartialIO : kandelo::tracing::System {
  static inline unsigned writes = 0, closes = 0;
  static ssize_t Write(int fd, const char* bytes, size_t size) {
    if (!writes++) { errno = EINTR; return -1; }
    return System::Write(fd, bytes, size > 3 ? 3 : size);
  }
  static int Close(int fd) { ++closes; return System::Close(fd); }
};
struct FailingIO : kandelo::tracing::System {
  static inline unsigned writes = 0, closes = 0;
  static inline int closed = -1;
  static ssize_t Write(int, const char*, size_t) { ++writes; errno = EIO; return -1; }
  static int Close(int fd) { closed = fd; ++closes; return System::Close(fd); }
};
}
int main(int argc, char** argv) {
  assert(argc == 2);
  const std::string mode = argv[1];
  using kandelo::tracing::Owner;
  if (mode == "partial") {
    Owner<PartialIO> owner;
    assert(owner.Enable({"case"}) == 0);
    assert(owner.Append("other,case", "{\"name\":\"partial\",\"args\":{}}") == 0);
    assert(owner.Finish() == 0); assert(owner.Finish() == 0);
    assert(PartialIO::writes > 10 && PartialIO::closes == 1);
  } else if (mode == "error") {
    Owner<FailingIO> owner;
    assert(owner.Enable({"case"}) == 0);
    assert(owner.Append("case", "{\"name\":\"failure\",\"args\":{}}") == EIO);
    assert(owner.Append("case", "{\"name\":\"failure\",\"args\":{}}") == EIO);
    assert(owner.Finish() == EIO); assert(FailingIO::writes == 1 && FailingIO::closes == 1);
    const int fresh = open("reused-slot", O_CREAT | O_RDWR, 0600); assert(fresh >= 0);
    if (fresh != FailingIO::closed) assert(dup2(fresh, FailingIO::closed) == FailingIO::closed);
    assert(owner.Finish() == EIO); assert(fcntl(FailingIO::closed, F_GETFD) >= 0);
    if (fresh != FailingIO::closed) close(fresh);
    close(FailingIO::closed);
  } else if (mode == "threads") {
    auto& owner = kandelo::tracing::Process();
    assert(owner.Enable({"same", "shared"}) == 0);
    assert(owner.Enable({"shared"}) == 0);
    assert(owner.Enabled() == "same,shared");
    owner.Disable({"same", "shared"}); assert(owner.Enabled() == "shared");
    assert(!owner.Enabled("same")); assert(owner.Enabled("miss,shared"));
    std::vector<std::thread> threads;
    for (unsigned index = 0; index < 4; ++index) threads.emplace_back([&owner,index] {
      for (unsigned item = 0; item < 10; ++item)
        assert(owner.Append("shared", "{\"name\":\"thread" + std::to_string(index) + "\",\"args\":{}}") == 0);
    });
    assert(owner.Append("shared", "{\"name\":\"main\",\"args\":{}}") == 0);
    for (auto& thread : threads) thread.join();
    owner.Disable({"shared"}); assert(owner.Enabled().empty());
    assert(owner.Finish() == 0);
  } else if (mode == "idle") {
    Owner<> owner; assert(owner.Enable({"case"}) == 0); assert(owner.Finish() == 0);
    assert(access("node_trace.1.log", F_OK) == -1 && errno == ENOENT);
  } else if (mode == "cloexec") {
    Owner<> owner; assert(owner.Enable({"case"}) == 0);
    assert(owner.Append("case", "{\"name\":\"cloexec\",\"args\":{}}") == 0);
    // Find only this test's actual trace file descriptor, then observe its flag.
    struct stat target{}; assert(stat("node_trace.1.log", &target) == 0);
    bool found = false;
    for (int fd = 3; fd < 128; ++fd) {
      struct stat value{};
      if (fstat(fd, &value) == 0 && value.st_ino == target.st_ino && value.st_dev == target.st_dev) {
        assert(fcntl(fd, F_GETFD) & FD_CLOEXEC); found = true;
      }
    }
    assert(found); assert(owner.Finish() == 0);
  } else return 2;
}
