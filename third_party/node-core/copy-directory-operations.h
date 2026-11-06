// Native fs.cp directory ownership. Guest POSIX calls only; no JS on workers.
#ifndef KANDELO_NODE_COPY_DIRECTORY_OPERATIONS_H
#define KANDELO_NODE_COPY_DIRECTORY_OPERATIONS_H
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <functional>
#include <optional>
#include <string>
#include <system_error>
#include <utility>
#include <vector>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#if __has_include("kandelo-node-copy-file-operations.h")
#include "kandelo-node-copy-file-operations.h"
#else
#include "copy-file-operations.h"
#endif

namespace kandelo::nodefs::cp {
struct CpError {
  // The first nine values and fields match pinned CpError. Further kinds are
  // the synchronous preflight's C++ coded errors, not JS SystemError objects.
  enum Kind { kNone, kErrno, kUv, kEinval, kSymlinkToSubdirectory, kEexist,
              kSocket, kFifo, kUnknown, kDirToNonDir, kNonDirToDir, kIsDir };
  Kind kind = kNone;
  int code = 0;
  const char* syscall = "cp";
  std::string message;
  std::string path;
  std::optional<std::string> dest;
  CpError() = default;
  CpError(Kind kind, int code, const char* syscall, std::string message = {},
          std::string path = {}, std::optional<std::string> dest = {})
      : kind(kind), code(code), syscall(syscall), message(std::move(message)),
        path(std::move(path)), dest(std::move(dest)) {}
  static CpError Std(const std::error_code& error, const std::string& path) {
    return {kErrno, error.value(), "cp", error.message(), path, {}};
  }
  static CpError Uv(int code, const char* syscall, const std::string& path) {
    return {kUv, code, syscall, {}, path, {}};
  }
};
inline std::string ConvertPathToUTF8(const std::filesystem::path& path) {
  // POSIX native path bytes. The guest does not use Windows wchar_t paths.
  return path.native();
}
inline const char* FormatArgument(const std::string& value) { return value.c_str(); }
inline const char* FormatArgument(const std::filesystem::path& value) { return value.c_str(); }
template<class... Args>
std::string SPrintF(const char* format, const Args&... args) {
  int size = std::snprintf(nullptr, 0, format, FormatArgument(args)...);
  if (size < 0) throw std::bad_alloc();
  std::string value(size_t(size), '\0');
  std::snprintf(value.data(), value.size() + 1, format, FormatArgument(args)...);
  return value;
}
template<class F> struct ScopeLeave {
  F callback;
  ~ScopeLeave() { callback(); }
};
template<class F> ScopeLeave<F> OnScopeLeave(F callback) { return {std::move(callback)}; }
// Private source-port shim, not a libuv ABI. Every operation acts on guest
// libc metadata/descriptors and the existing real copy-file owner.
struct uv_stat_t { timespec st_atim{}, st_mtim{}; };
struct uv_fs_t { uv_stat_t stat{}; void* ptr = nullptr; };
constexpr int UV_EINVAL = -EINVAL;
#ifndef UV_FS_COPYFILE_EXCL
constexpr int UV_FS_COPYFILE_EXCL = kandelo::nodefs::CopyExclusive;
#else
static_assert(UV_FS_COPYFILE_EXCL == kandelo::nodefs::CopyExclusive);
#endif
inline bool is_uv_error(int status) { return status < 0; }
inline void uv_fs_req_cleanup(uv_fs_t*) {}
inline int uv_fs_stat(void*, uv_fs_t* request, const char* path, void*) {
  struct stat record{}; int rc;
  do { rc = ::stat(path, &record); } while (rc < 0 && errno == EINTR);
  if (rc < 0) return -errno;
#ifdef __APPLE__
  request->stat = {record.st_atimespec, record.st_mtimespec};
#else
  request->stat = {record.st_atim, record.st_mtim};
#endif
  request->ptr = &request->stat; return 0;
}
inline int uv_fs_utime(void*, uv_fs_t*, const char* path, double atime, double mtime, void*) {
  // libuv's uv__fs_to_timespec truncation and negative-fraction correction.
  const auto toTimespec = [](double value) {
    timespec time{time_t(value), long((value - double(time_t(value))) * 1e9)};
    if (time.tv_nsec < 0) { time.tv_nsec += 1000000000; --time.tv_sec; }
    return time;
  };
  timespec times[2]{toTimespec(atime), toTimespec(mtime)};
  int rc; do { rc = ::utimensat(AT_FDCWD, path, times, 0); } while (rc < 0 && errno == EINTR);
  return rc == 0 ? 0 : -errno;
}
inline int uv_fs_copyfile(void*, uv_fs_t*, const char* source, const char* dest, int flags, void*) {
  return kandelo::nodefs::CopyPathFile(source, dest, flags);
}
inline int uv_fs_mkdir(void*, uv_fs_t*, const char* path, int mode, void*) {
  int rc; do { rc = ::mkdir(path, mode_t(mode)); } while (rc < 0 && errno == EINTR);
  return rc == 0 ? 0 : -errno;
}
#include "kandelo-node-copy-directory-types.inc"
CpError CopyDirRecursive(const std::filesystem::path& src_path,
                         const std::filesystem::path& dest_path,
                         const std::string& dest_display,
                         const CpDirOptions& options);

CpError CheckPaths(const std::filesystem::path& src_path,
                   const std::filesystem::path& dest_path,
                   bool dereference, bool recursive);
CpError OverrideFile(const std::filesystem::path& src_path,
                     const std::filesystem::path& dest_path,
                     int mode, bool preserve_timestamps);
}  // namespace kandelo::nodefs::cp
#endif
