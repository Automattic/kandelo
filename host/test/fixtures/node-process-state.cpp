#include "process-state.h"
#include <algorithm>
#include <cassert>
#include <fcntl.h>
#include <iostream>
#include <thread>

using namespace kandelo::process_state;

int main() {
  const std::string key = "KANDELO_NATIVE_STATE_" + std::to_string(getpid());
  assert(!GetEnvironment(key.c_str()));
  assert(SetEnvironment(key.c_str(), "before") == 0);
  assert(SafeGetEnvironment(key.c_str()) == GetEnvironment(key.c_str()));
  const auto retained = GetEnvironment(key.c_str());
  assert(retained && *retained == "before");
  assert(SetEnvironment(key.c_str(), "after") == 0);
  assert(*retained == "before");
  assert(*GetEnvironment(key.c_str()) == "after");
  const auto names = EnvironmentNames();
  assert(std::find(names.begin(), names.end(), key) != names.end());
  assert(SetEnvironment("invalid=name", "x") == -EINVAL);
  std::thread writer([&]() {
    for (int i = 0; i < 100; i++) {
      assert(SetEnvironment(key.c_str(), "concurrent") == 0);
      assert(UnsetEnvironment(key.c_str()) == 0);
    }
  });
  for (int i = 0; i < 100; i++) {
    const auto snapshot = EnvironmentNames();
    const auto value = GetEnvironment(key.c_str());
    assert(!value || *value == "after" || *value == "concurrent");
  }
  writer.join();
  assert(UnsetEnvironment(key.c_str()) == 0);
  assert(!GetEnvironment(key.c_str()));
  assert(!SafeGetEnvironment(key.c_str()));

  const mode_t initial = Umask(std::nullopt);
  assert(Umask(uint32_t(0027)) == initial);
  assert(Umask(std::nullopt) == 0027);
  assert(Umask(std::nullopt) == 0027);
  char directory[] = "/tmp/kandelo-process-state-XXXXXX";
  assert(mkdtemp(directory));
  const std::string file = std::string(directory) + "/masked";
  const int fd = open(file.c_str(), O_CREAT | O_EXCL | O_WRONLY, 0666);
  assert(fd >= 0);
  struct stat st;
  assert(fstat(fd, &st) == 0);
  assert((st.st_mode & 0777) == 0640);
  assert(close(fd) == 0);
  assert(unlink(file.c_str()) == 0);
  assert(rmdir(directory) == 0);
  assert(Umask(uint32_t(initial)) == 0027);
  assert(Umask(std::nullopt) == initial);
  std::cout << "{\"passed\":true,\"parentPid\":" << ParentPid()
            << ",\"scope\":\"Native POSIX process-state helper only; not guest bridge\"}\n";
}
