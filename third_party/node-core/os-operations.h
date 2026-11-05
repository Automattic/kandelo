#ifndef KANDELO_NODE_OS_OPERATIONS_H
#define KANDELO_NODE_OS_OPERATIONS_H
#include <array>
#include <cerrno>
#include <cstdint>
#include <limits>
#include <limits.h>
#include <optional>
#include <pwd.h>
#include <string>
#include <sys/resource.h>
#include <sys/utsname.h>
#include <unistd.h>
#include <utility>
#include <vector>
#include "kandelo-node-process-state.h"
namespace kandelo::node_os {
template<typename T> struct Result { int error = 0; T value{}; };
struct User { uint64_t uid = 0, gid = 0; std::string username, homedir, shell; };
inline Result<std::array<std::string,4>> Information() {
  struct utsname data{};
  if (uname(&data) != 0) return {-errno,{}};
  return {0,{data.sysname,data.version,data.release,data.machine}};
}
inline Result<std::string> Hostname() {
  // Same bounded POSIX hostname buffer/termination policy as pinned libuv.
  std::array<char,256> data{};
  if (gethostname(data.data(),data.size()) != 0) return {-errno,{}};
  data.back() = '\0'; return {0,std::string(data.data())};
}
inline Result<User> UserInfo() {
  size_t size = 2000;
  for (;;) {
    std::vector<char> storage(size); struct passwd record{}, *result = nullptr;
    int status;
    do { status = getpwuid_r(geteuid(),&record,storage.data(),storage.size(),&result); }
    while (status == EINTR);
    if (status == ERANGE) {
      if (size > std::numeric_limits<size_t>::max()/2) return {-ENOMEM,{}};
      size *= 2; continue;
    }
    if (status != 0) return {-status,{}};
    if (!result) return {-ENOENT,{}};
    // Copy all borrowed libc fields before releasing scratch storage. No
    // passwd pointer or storage lease crosses a JavaScript allocation.
    return {0,{uint64_t(record.pw_uid),uint64_t(record.pw_gid),
      std::string(record.pw_name),std::string(record.pw_dir),std::string(record.pw_shell)}};
  }
}
inline Result<std::string> HomeDirectory() {
  if (auto home = process_state::GetEnvironment("HOME")) {
    if (home->size() >= PATH_MAX) return {-ENOBUFS,{}};
    return {0,*home};
  }
  auto user = UserInfo(); if (user.error) return {user.error,{}};
  if (user.value.homedir.size() >= PATH_MAX) return {-ENOBUFS,{}};
  return {0,std::move(user.value.homedir)};
}
inline std::optional<std::string> TemporaryDirectory() {
  for (const char* name : {"TMPDIR","TMP","TEMP"}) {
    auto value = process_state::SafeGetEnvironment(name);
    if (!value || value->empty()) continue;
    if (value->size() > 1 && value->back() == '/') value->pop_back();
    return value;
  }
  return std::nullopt;
}
inline Result<int> GetPriority(int pid) {
  errno = 0; const int value = getpriority(PRIO_PROCESS,pid);
  if (value == -1 && errno != 0) return {-errno,0};
  return {0,value};
}
inline int SetPriority(int pid,int value) {
  if (value < -20 || value > 19) return -EINVAL;
  return setpriority(PRIO_PROCESS,pid,value) == 0 ? 0 : -errno;
}
inline bool IsBigEndian() {
  const uint16_t value = 1;
  return *reinterpret_cast<const uint8_t*>(&value) == 0;
}
}
#endif
