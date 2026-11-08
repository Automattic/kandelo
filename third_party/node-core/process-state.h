#ifndef KANDELO_NODE_PROCESS_STATE_H
#define KANDELO_NODE_PROCESS_STATE_H

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <optional>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>
#include <utility>

extern "C" { extern char** environ; }
#if defined(__wasm__) || defined(__linux__)
#include <sys/auxv.h>
extern "C" char* secure_getenv(const char*);
#endif

namespace kandelo::process_state {

inline std::mutex environment_mutex;
inline std::mutex umask_mutex;

struct GroupsResult { int error = 0; std::vector<gid_t> groups; };
// Preserve pinned GetGroups' two real syscall snapshots and effective-gid
// inclusion. The native vector owns all data before JS publication; no
// borrowed group storage or credential cache crosses a JS allocation.
inline GroupsResult GetGroups() {
  int count = getgroups(0, nullptr);
  if (count == -1) return {errno, {}};
  std::vector<gid_t> groups(static_cast<size_t>(count));
  count = getgroups(count, groups.data());
  if (count == -1) return {errno, {}};
  groups.resize(static_cast<size_t>(count));
  const gid_t effective = getegid();
  bool present = false;
  for (gid_t group : groups) if (group == effective) { present = true; break; }
  if (!present) groups.push_back(effective);
  return {0, std::move(groups)};
}


// Abort is signal death, not a normal _exit(128 + SIGABRT). libc owns
// unblock/reset/re-raise behavior, so waiters receive the real signal status.
[[noreturn]] inline void Abort() { std::abort(); }

// Copy borrowed libc storage while this bridge's mutations are excluded.
// No borrowed environ pointer survives the lock or a JavaScript allocation.
inline std::optional<std::string> GetEnvironment(const char* key) {
  std::lock_guard<std::mutex> lock(environment_mutex);
  const char* value = getenv(key);
  if (!value) return std::nullopt;
  return std::string(value);
}

// Loader search paths must not consume privileged-process environment values.
// musl's secure bit comes from actual startup/auxiliary-vector state; uid/gid
// comparisons also cover credentials changed after startup. Non-Linux native
// controls use the same uid/gid admission as Node's POSIX credentials owner.
inline bool EnvironmentReadAllowed() {
  if (getuid() != geteuid() || getgid() != getegid()) return false;
#if defined(__wasm__) || defined(__linux__)
  // musl exposes its actual secure-execution state through AT_SECURE.
  return getauxval(AT_SECURE) == 0;
#else
  return true;
#endif
}

inline std::optional<std::string> SafeGetEnvironment(const char* key) {
  std::lock_guard<std::mutex> lock(environment_mutex);
  if (!EnvironmentReadAllowed()) return std::nullopt;
#if defined(__wasm__) || defined(__linux__)
  const char* value = secure_getenv(key);
#else
  const char* value = getenv(key);
#endif
  if (!value) return std::nullopt;
  return std::string(value);
}

inline int SetEnvironment(const char* key, const char* value) {
  std::lock_guard<std::mutex> lock(environment_mutex);
  return setenv(key, value, 1) == 0 ? 0 : -errno;
}

inline int UnsetEnvironment(const char* key) {
  std::lock_guard<std::mutex> lock(environment_mutex);
  return unsetenv(key) == 0 ? 0 : -errno;
}

inline std::vector<std::string> EnvironmentNames() {
  std::lock_guard<std::mutex> lock(environment_mutex);
  std::vector<std::string> names;
  if (environ) {
    for (char** entry = environ; *entry; ++entry) {
      const char* end = strchr(*entry, '=');
      if (end && end != *entry) names.emplace_back(*entry, size_t(end - *entry));
    }
  }
  return names;
}

// Match the target's serialized query-and-restore operation. This mutates
// the real guest process creation mask, not a JavaScript shadow variable.
inline mode_t Umask(std::optional<uint32_t> mask) {
  std::lock_guard<std::mutex> lock(umask_mutex);
  if (mask) return ::umask(mode_t(*mask));
  const mode_t previous = ::umask(0);
  ::umask(previous);
  return previous;
}

inline pid_t ParentPid() { return getppid(); }

}  // namespace kandelo::process_state
#endif
