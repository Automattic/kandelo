// Guest-owned WASI preview1 state. POSIX calls address the current process's
// descriptors; this is not the embedding host's node:wasi implementation.
#ifndef KANDELO_NODE_WASI_CONTEXT_H
#define KANDELO_NODE_WASI_CONTEXT_H
#include "native-retained-memory.h"
#include "wasi-policy.h"
#include "wasi-wire.h"
#include <algorithm>
#include <atomic>
#include <climits>
#include <cstring>
#include <dirent.h>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <sched.h>
#include <sys/socket.h>
#include <sys/random.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <time.h>

namespace kandelo::wasi {
struct Error : std::exception {
  uvwasi_errno_t code;
  explicit Error(uvwasi_errno_t value) : code(value) {}
  const char* what() const noexcept override { return ErrorName(code); }
};
// The engine refreshes this synchronous borrow from the actual WasmMemoryObject
// for every call. Never cache a SharedArrayBuffer wrapper's old byte length.
struct Memory {
  uint8_t* bytes;
  size_t length;
  bool shared;
  bool Bounds(uint64_t offset, uint64_t size) const noexcept {
    return offset <= length && size <= length - offset;
  }
  uint8_t Load(size_t at) const noexcept {
    if (shared) return __atomic_load_n(bytes + at, __ATOMIC_RELAXED);
    return bytes[at];
  }
  void Store(size_t at, uint8_t value) const noexcept {
    if (shared) __atomic_store_n(bytes + at, value, __ATOMIC_RELAXED);
    else bytes[at] = value;
  }
  uint32_t Read32(size_t at) const noexcept {
    uint8_t data[4];
    for (size_t i = 0; i < 4; ++i) data[i] = Load(at + i);
    return uvwasi_serdes_read_uint32_t(data, 0);
  }
  void Write(size_t at, const void* source, size_t size) const noexcept {
    const auto* data = static_cast<const uint8_t*>(source);
    for (size_t i = 0; i < size; ++i) Store(at + i, data[i]);
  }
  void Write32(size_t at, uint32_t value) const noexcept {
    uint8_t data[4]; uvwasi_serdes_write_uint32_t(data, 0, value);
    Write(at, data, sizeof(data));
  }
  void Write64(size_t at, uint64_t value) const noexcept {
    uint8_t data[8]; uvwasi_serdes_write_uint64_t(data, 0, value);
    Write(at, data, sizeof(data));
  }
};
inline size_t StringBytes(const std::string& value) noexcept {
  const uintptr_t data = reinterpret_cast<uintptr_t>(value.data());
  const uintptr_t object = reinterpret_cast<uintptr_t>(&value);
  return data >= object && data < object + sizeof(value) ? 0 : value.capacity() + 1;
}
struct Fd {
  int fd = -1;
  bool owns = false;
  bool preopen = false;
  uvwasi_filetype_t type = UVWASI_FILETYPE_UNKNOWN;
  uvwasi_rights_t base = 0, inheriting = 0;
  std::string path, normalized, realPath;
  ~Fd() { if (owns && fd >= 0) ::close(fd); }
};
class UniqueFd {
  int fd_;
 public:
  explicit UniqueFd(int value) : fd_(value) {}
  ~UniqueFd() { if (fd_ >= 0) ::close(fd_); }
  int Release() noexcept { int result = fd_; fd_ = -1; return result; }
};
inline uvwasi_filetype_t Type(int fd, const struct stat& st) {
  if (S_ISREG(st.st_mode)) return UVWASI_FILETYPE_REGULAR_FILE;
  if (S_ISDIR(st.st_mode)) return UVWASI_FILETYPE_DIRECTORY;
  if (S_ISCHR(st.st_mode)) return UVWASI_FILETYPE_CHARACTER_DEVICE;
  if (S_ISBLK(st.st_mode)) return UVWASI_FILETYPE_BLOCK_DEVICE;
  if (S_ISLNK(st.st_mode)) return UVWASI_FILETYPE_SYMBOLIC_LINK;
  if (S_ISFIFO(st.st_mode)) return UVWASI_FILETYPE_SOCKET_STREAM;
  if (S_ISSOCK(st.st_mode)) {
    int type = 0; socklen_t size = sizeof(type);
    if (::getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) < 0) throw Error(FromErrno(errno));
    return type == SOCK_DGRAM ? UVWASI_FILETYPE_SOCKET_DGRAM : UVWASI_FILETYPE_SOCKET_STREAM;
  }
  return UVWASI_FILETYPE_UNKNOWN;
}
class Context {
  // Before material: this record retires after all accounted containers/fds.
  memory::Allocation allocation_;
  memory::Claim claim_;
  std::vector<std::string> args_, env_;
  std::vector<std::unique_ptr<Fd>> fds_;
  static void Truncate(std::vector<std::string>& strings) {
    for (auto& text : strings) text.resize(std::strlen(text.c_str()));
  }
  static size_t StringVectorBytes(const std::vector<std::string>& values) {
    size_t bytes = values.capacity() * sizeof(std::string);
    for (const auto& text : values) bytes += StringBytes(text);
    return bytes;
  }
  static uint32_t BufferSize(const std::vector<std::string>& values) {
    uint64_t size = 0;
    for (const auto& text : values) size += text.size() + 1;
    if (size > UINT32_MAX || values.size() > UINT32_MAX) throw Error(UVWASI_EOVERFLOW);
    return static_cast<uint32_t>(size);
  }
  Fd* Get(uint32_t fd, uvwasi_rights_t rights, uvwasi_errno_t& error) {
    if (fd >= fds_.size() || !fds_[fd]) { error = UVWASI_EBADF; return nullptr; }
    auto* result = fds_[fd].get();
    if ((result->base & rights) != rights) { error = UVWASI_ENOTCAPABLE; return nullptr; }
    return result;
  }
  void Admit(int fd, bool preopen, const std::string& mapped = {},
             const std::string& realPath = {}) {
    struct stat st;
    if (::fstat(fd, &st) < 0) throw Error(FromErrno(errno));
    auto row = std::make_unique<Fd>();
    row->type = Type(fd, st); row->preopen = preopen; row->path = mapped;
    row->realPath = realPath;
    if (preopen) {
      if (row->type != UVWASI_FILETYPE_DIRECTORY) throw Error(UVWASI_ENOTDIR);
      row->normalized.resize(row->path.size() + 2);
      auto error = uvwasi__normalize_path(row->path.c_str(), row->path.size(), row->normalized.data(), row->path.size() + 1);
      if (error) throw Error(error);
      row->normalized.resize(std::strlen(row->normalized.c_str()));
      row->base = UVWASI__RIGHTS_DIRECTORY_BASE;
      row->inheriting = UVWASI__RIGHTS_DIRECTORY_INHERITING;
    } else {
      auto error = Rights(fd, O_RDWR, row->type, &row->base, &row->inheriting);
      if (error) throw Error(error);
    }
    // Do not steal an owned descriptor until insertion can no longer throw.
    fds_.push_back(std::move(row)); fds_.back()->fd = fd;
  }
 public:
  Context(std::vector<std::string> args, std::vector<std::string> env,
          const std::vector<std::string>& preopens, const int stdio[3],
          const memory::AccountHandle& account = {})
      : allocation_(), claim_(allocation_.Handle(), account),
        args_(std::move(args)), env_(std::move(env)) {
    Truncate(args_); Truncate(env_); BufferSize(args_); BufferSize(env_);
    try {
      const char* names[] = {"<stdin>", "<stdout>", "<stderr>"};
      for (int i = 0; i < 3; ++i) Admit(stdio[i], false, names[i], names[i]);
      for (size_t i = 0; i < preopens.size(); i += 2) {
        const char* actual = preopens.at(i + 1).c_str();
        std::unique_ptr<char, decltype(&std::free)> resolved(::realpath(actual, nullptr), &std::free);
        if (!resolved) throw Error(FromErrno(errno));
        int fd = ::open(resolved.get(), O_RDONLY);
        if (fd < 0) throw Error(FromErrno(errno));
        UniqueFd pending(fd);
        Admit(fd, true, preopens[i].substr(0, std::strlen(preopens[i].c_str())), resolved.get());
        fds_.back()->owns = true; pending.Release();
      }
      RefreshAccounting();
    } catch (...) { RefreshAccounting(); throw; }
  }
  Context(const Context&) = delete;
  void RefreshAccounting() noexcept {
    size_t bytes = sizeof(*this) + StringVectorBytes(args_) + StringVectorBytes(env_) +
                   fds_.capacity() * sizeof(fds_[0]);
    for (const auto& fd : fds_) if (fd) bytes += sizeof(Fd) + StringBytes(fd->path) + StringBytes(fd->normalized) + StringBytes(fd->realPath);
    allocation_.Resize(bytes);
  }
  uvwasi_errno_t Strings(Memory m, bool environment, bool sizes, uint32_t a, uint32_t b) {
    const auto& strings = environment ? env_ : args_;
    const uint32_t count = static_cast<uint32_t>(strings.size()), size = BufferSize(strings);
    if (sizes) {
      if (!m.Bounds(a, 4) || !m.Bounds(b, 4)) return UVWASI_EOVERFLOW;
      m.Write32(a, count); m.Write32(b, size); return 0;
    }
    if (!m.Bounds(b, size) || !m.Bounds(a, uint64_t(count) * 4)) return UVWASI_EOVERFLOW;
    // Match node_wasi: copy bytes first, then publish pointer offsets, including
    // observable aliasing when callers overlap the two result ranges.
    size_t offset = b;
    for (const auto& text : strings) { m.Write(offset, text.c_str(), text.size() + 1); offset += text.size() + 1; }
    offset = b;
    for (uint32_t i = 0; i < count; ++i) { m.Write32(size_t(a) + size_t(i) * 4, static_cast<uint32_t>(offset)); offset += strings[i].size() + 1; }
    return 0;
  }
  uvwasi_errno_t Close(uint32_t fd) {
    uvwasi_errno_t error = 0; auto* row = Get(fd, 0, error); if (!row) return error;
    const int actual = row->fd;
    // Pinned uvwasi removes the table entry only on a successful close.
    if (::close(actual) < 0 && errno != EINTR && errno != EINPROGRESS) return FromErrno(errno);
    row->fd = -1; fds_[fd].reset(); RefreshAccounting(); return 0;
  }
  uvwasi_errno_t Fdstat(Memory m, uint32_t fd, uint32_t out) {
    if (!m.Bounds(out, 24)) return UVWASI_EOVERFLOW;
    uvwasi_errno_t error = 0; auto* row = Get(fd, 0, error); if (!row) return error;
    int flags = ::fcntl(row->fd, F_GETFL); if (flags < 0) return FromErrno(errno);
    uvwasi_fdstat_t value{row->type, static_cast<uvwasi_fdflags_t>(flags), row->base, row->inheriting};
    uint8_t bytes[24]; uvwasi_serdes_write_fdstat_t(bytes, 0, &value);
    m.Write(out, bytes, 1); m.Write(size_t(out) + 2, bytes + 2, 2); m.Write(size_t(out) + 8, bytes + 8, 16);
    return 0;
  }
  uvwasi_errno_t SetRights(uint32_t fd, uint64_t base, uint64_t inheriting) {
    uvwasi_errno_t error = 0; auto* row = Get(fd, 0, error); if (!row) return error;
    if ((base | row->base) != row->base || (inheriting | row->inheriting) != row->inheriting) return UVWASI_ENOTCAPABLE;
    row->base = base; row->inheriting = inheriting; return 0;
  }
  uvwasi_errno_t SetFlags(uint32_t fd, uint32_t flags) {
    uvwasi_errno_t error = 0; auto* row = Get(fd, UVWASI_RIGHT_FD_FDSTAT_SET_FLAGS, error); if (!row) return error;
    int mapped = 0;
    if (flags & UVWASI_FDFLAG_APPEND) mapped |= O_APPEND;
    if (flags & UVWASI_FDFLAG_NONBLOCK) mapped |= O_NONBLOCK;
    if (flags & UVWASI_FDFLAG_SYNC) mapped |= O_SYNC;
    if (flags & UVWASI_FDFLAG_DSYNC) {
#ifdef O_DSYNC
      mapped |= O_DSYNC;
#else
      mapped |= O_SYNC;
#endif
    }
    if (flags & UVWASI_FDFLAG_RSYNC) {
#ifdef O_RSYNC
      mapped |= O_RSYNC;
#else
      mapped |= O_SYNC;
#endif
    }
    return ::fcntl(row->fd, F_SETFL, mapped) < 0 ? FromErrno(errno) : 0;
  }
  uvwasi_errno_t Prestat(Memory m, uint32_t fd, uint32_t out) {
    if (!m.Bounds(out, 8)) return UVWASI_EOVERFLOW;
    uvwasi_errno_t error = 0; auto* row = Get(fd, 0, error); if (!row) return error;
    if (!row->preopen) return UVWASI_EINVAL;
    m.Store(out, UVWASI_PREOPENTYPE_DIR); m.Write32(size_t(out) + 4, row->path.size()); return 0;
  }
  uvwasi_errno_t PrestatName(Memory m, uint32_t fd, uint32_t out, uint32_t length) {
    if (!m.Bounds(out, length)) return UVWASI_EOVERFLOW;
    uvwasi_errno_t error = 0; auto* row = Get(fd, 0, error); if (!row) return error;
    if (!row->preopen) return UVWASI_EBADF;
    if (row->path.size() > length) return UVWASI_ENOBUFS;
    m.Write(out, row->path.data(), row->path.size()); return 0;
  }
  uvwasi_errno_t Filestat(Memory m, uint32_t fd, uint32_t out) {
    if (!m.Bounds(out, 64)) return UVWASI_EOVERFLOW;
    uvwasi_errno_t error = 0; auto* row = Get(fd, UVWASI_RIGHT_FD_FILESTAT_GET, error); if (!row) return error;
    struct stat st; if (::fstat(row->fd, &st) < 0) return FromErrno(errno);
    uvwasi_filestat_t value{};
    value.st_dev = st.st_dev; value.st_ino = st.st_ino; value.st_filetype = Type(row->fd, st);
    value.st_nlink = st.st_nlink; value.st_size = st.st_size;
#if defined(__APPLE__)
    value.st_atim = uint64_t(st.st_atimespec.tv_sec) * 1000000000 + st.st_atimespec.tv_nsec;
    value.st_mtim = uint64_t(st.st_mtimespec.tv_sec) * 1000000000 + st.st_mtimespec.tv_nsec;
    value.st_ctim = uint64_t(st.st_ctimespec.tv_sec) * 1000000000 + st.st_ctimespec.tv_nsec;
#else
    value.st_atim = uint64_t(st.st_atim.tv_sec) * 1000000000 + st.st_atim.tv_nsec;
    value.st_mtim = uint64_t(st.st_mtim.tv_sec) * 1000000000 + st.st_mtim.tv_nsec;
    value.st_ctim = uint64_t(st.st_ctim.tv_sec) * 1000000000 + st.st_ctim.tv_nsec;
#endif
    uint8_t bytes[64]; uvwasi_serdes_write_filestat_t(bytes, 0, &value);
    m.Write(out, bytes, 17); m.Write(size_t(out) + 24, bytes + 24, 40); return 0;
  }
  uvwasi_errno_t SetSize(uint32_t fd, uint64_t length) {
    uvwasi_errno_t error = 0; auto* row = Get(fd, UVWASI_RIGHT_FD_FILESTAT_SET_SIZE, error); if (!row) return error;
    return ::ftruncate(row->fd, static_cast<int64_t>(length)) < 0 ? FromErrno(errno) : 0;
  }
  // Pinned uvwasi's current build uses its actual fstat/ftruncate fallback
  // unless __POSIX__ selects posix_fallocate. Do not invent allocation success.
  uvwasi_errno_t Allocate(uint32_t fd, uint64_t offset, uint64_t length) {
    uvwasi_errno_t error = 0; auto* row = Get(fd, UVWASI_RIGHT_FD_ALLOCATE, error); if (!row) return error;
#if defined(__POSIX__)
    const int result = ::posix_fallocate(row->fd, offset, length);
    return result ? FromErrno(result) : 0;
#else
    struct stat st; if (::fstat(row->fd, &st) < 0) return FromErrno(errno);
    const uint64_t end = offset + length;
    if (static_cast<uint64_t>(st.st_size) < end &&
        ::ftruncate(row->fd, static_cast<int64_t>(end)) < 0) return FromErrno(errno);
    return 0;
#endif
  }
  uvwasi_errno_t SetTimes(uint32_t fd, uint64_t atime, uint64_t mtime, uint32_t rawFlags) {
    // The C preview1 API narrows the binding's u32 to its actual u16 flags.
    const uvwasi_fstflags_t flags = static_cast<uvwasi_fstflags_t>(rawFlags);
    constexpr auto at = UVWASI_FILESTAT_SET_ATIM | UVWASI_FILESTAT_SET_ATIM_NOW;
    constexpr auto mt = UVWASI_FILESTAT_SET_MTIM | UVWASI_FILESTAT_SET_MTIM_NOW;
    if ((flags & ~(at | mt)) || (flags & at) == at || (flags & mt) == mt) return UVWASI_EINVAL;
    uvwasi_errno_t error = 0; auto* row = Get(fd, UVWASI_RIGHT_FD_FILESTAT_SET_TIMES, error); if (!row) return error;
    uint64_t now = 0;
    if (flags & (UVWASI_FILESTAT_SET_ATIM_NOW | UVWASI_FILESTAT_SET_MTIM_NOW)) {
      struct timespec current;
      if (::clock_gettime(CLOCK_REALTIME, &current) < 0) return FromErrno(errno);
      now = uint64_t(current.tv_sec) * 1000000000 + current.tv_nsec;
    }
    uint64_t previousAt = 0, previousMt = 0;
    if (!(flags & at) || !(flags & mt)) {
      struct stat st; if (::fstat(row->fd, &st) < 0) return FromErrno(errno);
#if defined(__APPLE__)
      previousAt = uint64_t(st.st_atimespec.tv_sec) * 1000000000 + st.st_atimespec.tv_nsec;
      previousMt = uint64_t(st.st_mtimespec.tv_sec) * 1000000000 + st.st_mtimespec.tv_nsec;
#else
      previousAt = uint64_t(st.st_atim.tv_sec) * 1000000000 + st.st_atim.tv_nsec;
      previousMt = uint64_t(st.st_mtim.tv_sec) * 1000000000 + st.st_mtim.tv_nsec;
#endif
    }
    // Exact uvwasi helper chooses a value then divides to whole seconds,
    // including omitted values; it does not preserve their fractional part.
    struct timespec times[2] = {
      {static_cast<time_t>(((flags & UVWASI_FILESTAT_SET_ATIM_NOW) ? now :
          (flags & UVWASI_FILESTAT_SET_ATIM) ? atime : previousAt) / 1000000000), 0},
      {static_cast<time_t>(((flags & UVWASI_FILESTAT_SET_MTIM_NOW) ? now :
          (flags & UVWASI_FILESTAT_SET_MTIM) ? mtime : previousMt) / 1000000000), 0}
    };
    return ::futimens(row->fd, times) < 0 ? FromErrno(errno) : 0;
  }
  uvwasi_errno_t Renumber(uint32_t from, uint32_t to) {
    // Pinned fd_table_renumber tests equality before either table lookup.
    if (from == to) return 0;
    uvwasi_errno_t error = 0; auto* destination = Get(to, 0, error); if (!destination) return error;
    auto* source = Get(from, 0, error); if (!source) return error;
    (void)source;
    if (::close(destination->fd) < 0 && errno != EINTR && errno != EINPROGRESS) return FromErrno(errno);
    // Only after the real close succeeds can its owner be disarmed and the
    // source's fd/rights/preopen/path ownership move once. No POSIX dup occurs.
    destination->fd = -1;
    fds_[to] = std::move(fds_[from]);
    RefreshAccounting(); return 0;
  }
  uvwasi_errno_t Readdir(Memory m, uint32_t fd, uint32_t buffer, uint32_t length,
                        uint64_t cookie, uint32_t out) {
    if (!m.Bounds(buffer, length) || !m.Bounds(out, 4)) return UVWASI_EOVERFLOW;
    uvwasi_errno_t error = 0; auto* row = Get(fd, UVWASI_RIGHT_FD_READDIR, error); if (!row) return error;
    // Like pinned uvwasi, each call opens the stored real_path afresh rather
    // than moving the admitted descriptor's OFD offset or caching enumeration.
    using Directory = std::unique_ptr<DIR, decltype(&::closedir)>;
    Directory dir(::opendir(row->realPath.c_str()), &::closedir);
    if (!dir) return FromErrno(errno);
    auto finish = [&](uvwasi_errno_t status) {
      const int result = ::closedir(dir.release());
      return result < 0 ? FromErrno(errno) : status;
    };
    uvwasi_errno_t readError = 0;
    auto next = [&]() -> struct dirent* {
      struct dirent* entry;
      do { errno = 0; entry = ::readdir(dir.get()); }
      while (entry && (!std::strcmp(entry->d_name, ".") || !std::strcmp(entry->d_name, "..")));
      if (!entry && errno) readError = FromErrno(errno);
      return entry;
    };
    uint64_t current = 0;
    while (current < cookie) {
      if (!next()) {
        if (readError) return finish(readError);
        break;
      }
      ++current;
    }
    uint32_t used = 0;
    while (auto* entry = next()) {
      ++current;
      uvwasi_dirent_t value{}; value.d_next = current;
      // Exact uvwasi/libuv contract reports no inode; never claim real d_ino.
      value.d_ino = 0; value.d_namlen = std::strlen(entry->d_name);
      switch (entry->d_type) {
        case DT_REG: value.d_type = UVWASI_FILETYPE_REGULAR_FILE; break;
        case DT_DIR: value.d_type = UVWASI_FILETYPE_DIRECTORY; break;
        case DT_SOCK: value.d_type = UVWASI_FILETYPE_SOCKET_STREAM; break;
        case DT_LNK: value.d_type = UVWASI_FILETYPE_SYMBOLIC_LINK; break;
        case DT_CHR: value.d_type = UVWASI_FILETYPE_CHARACTER_DEVICE; break;
        case DT_BLK: value.d_type = UVWASI_FILETYPE_BLOCK_DEVICE; break;
        default: value.d_type = UVWASI_FILETYPE_UNKNOWN; break;
      }
      if (uint64_t(used) + UVWASI_SERDES_SIZE_dirent_t > length) { used = length; break; }
      uint8_t bytes[UVWASI_SERDES_SIZE_dirent_t]; uvwasi_serdes_write_dirent_t(bytes, 0, &value);
      // Serializer leaves bytes21..23 unchanged. Preserve those original bytes
      // even for shared memory, rather than publishing uninitialized padding.
      m.Write(size_t(buffer) + used, bytes, 21); used += UVWASI_SERDES_SIZE_dirent_t;
      const size_t part = std::min<size_t>(value.d_namlen, length - used);
      m.Write(size_t(buffer) + used, entry->d_name, part); used += part;
      if (used == length) break;
    }
    if (readError) return finish(readError);
    error = finish(0); if (!error) m.Write32(out, used); return error;
  }
  uvwasi_errno_t Sync(uint32_t fd, bool data) {
    uvwasi_errno_t error = 0; auto* row = Get(fd, data ? UVWASI_RIGHT_FD_DATASYNC : UVWASI_RIGHT_FD_SYNC, error); if (!row) return error;
    int result;
    do {
#if defined(__APPLE__)
      // Preserve libuv's actual Darwin full-sync/barrier/fsync fallback policy.
      result = ::fcntl(row->fd, F_FULLFSYNC);
      if (result != 0) result = ::fcntl(row->fd, 85 /* F_BARRIERFSYNC */);
      if (result != 0) result = ::fsync(row->fd);
#elif defined(__linux__) || defined(__sun) || defined(__NetBSD__)
      result = data ? ::fdatasync(row->fd) : ::fsync(row->fd);
#else
      // The pinned libuv policy uses fsync on other real platform identities.
      result = ::fsync(row->fd);
#endif
    } while (result < 0 && errno == EINTR);
    return result < 0 ? FromErrno(errno) : 0;
  }
  uvwasi_errno_t Seek(Memory m, uint32_t fd, int64_t offset, uint32_t whence, uint32_t out, bool tell = false) {
    if (!m.Bounds(out, 8)) return UVWASI_EOVERFLOW;
    uvwasi_errno_t error = 0; auto* row = Get(fd, tell ? UVWASI_RIGHT_FD_TELL : UVWASI_RIGHT_FD_SEEK, error); if (!row) return error;
    int mapped;
    switch (static_cast<uvwasi_whence_t>(whence)) {
      case UVWASI_WHENCE_SET: mapped = SEEK_SET; break;
      case UVWASI_WHENCE_CUR: mapped = SEEK_CUR; break;
      case UVWASI_WHENCE_END: mapped = SEEK_END; break;
      default: return UVWASI_EINVAL;
    }
    off_t result = ::lseek(row->fd, offset, mapped);
    if (result < 0) return FromErrno(errno);
    m.Write64(out, result); return 0;
  }
  uvwasi_errno_t Io(Memory m, uint32_t fd, uint32_t iovs, uint32_t count, uint64_t offset, uint32_t out, bool write, bool positioned) {
    if (!m.Bounds(iovs, uint64_t(count) * 8) || !m.Bounds(out, 4)) return UVWASI_EOVERFLOW;
    // Translate descriptors only; every payload points into the original actual
    // current WebAssembly.Memory backing for the duration of this borrow.
    memory::Allocation scratch;
    std::vector<struct iovec> vectors(count);
    scratch.Resize(vectors.capacity() * sizeof(struct iovec));
    for (uint32_t i = 0; i < count; ++i) {
      uint32_t start = m.Read32(size_t(iovs) + size_t(i) * 8), length = m.Read32(size_t(iovs) + size_t(i) * 8 + 4);
      if (!m.Bounds(start, length)) return UVWASI_EOVERFLOW;
      vectors[i] = {m.bytes + start, length};
    }
    if (positioned && offset > INT64_MAX) return UVWASI_EINVAL;
    uvwasi_errno_t error = 0;
    const uint64_t rights = (write ? UVWASI_RIGHT_FD_WRITE : UVWASI_RIGHT_FD_READ) |
                            (positioned ? UVWASI_RIGHT_FD_SEEK : 0);
    auto* row = Get(fd, rights, error); if (!row) return error;
    if (count == 0) { m.Write32(out, 0); return 0; }
    const long configured = ::sysconf(_SC_IOV_MAX);
    const size_t max = configured > 0 ? configured : 1;
    size_t first = 0; ssize_t total = 0;
    do {
      int batch = static_cast<int>(std::min<size_t>(count - first, max));
      ssize_t result;
      do {
        auto* entries = vectors.data() + first;
        if (batch == 1) {
          if (write) result = positioned ? ::pwrite(row->fd, entries->iov_base, entries->iov_len, offset) : ::write(row->fd, entries->iov_base, entries->iov_len);
          else result = positioned ? ::pread(row->fd, entries->iov_base, entries->iov_len, offset) : ::read(row->fd, entries->iov_base, entries->iov_len);
        } else if (write) result = positioned ? ::pwritev(row->fd, entries, batch, offset) : ::writev(row->fd, entries, batch);
        else result = positioned ? ::preadv(row->fd, entries, batch, offset) : ::readv(row->fd, entries, batch);
      } while (write && result < 0 && errno == EINTR);
      if (result <= 0) {
        if (total == 0 && result < 0) return FromErrno(errno);
        break;
      }
      total += result;
      if (!write) break; // libuv performs one capped synchronous read.
      if (positioned) offset += result;
      size_t consumed = static_cast<size_t>(result);
      while (first < count && consumed >= vectors[first].iov_len) { consumed -= vectors[first].iov_len; ++first; }
      if (first < count && consumed) {
        vectors[first].iov_base = static_cast<uint8_t*>(vectors[first].iov_base) + consumed;
        vectors[first].iov_len -= consumed;
      }
    } while (first < count);
    m.Write32(out, static_cast<uint32_t>(total)); return 0;
  }
  uvwasi_errno_t Clock(Memory m, uint32_t id, uint32_t out, bool resolution) {
    if (!m.Bounds(out, 8)) return UVWASI_EOVERFLOW;
    clockid_t actual;
    switch (id) {
      case UVWASI_CLOCK_REALTIME: actual = CLOCK_REALTIME; break;
      case UVWASI_CLOCK_MONOTONIC: actual = CLOCK_MONOTONIC; break;
      case UVWASI_CLOCK_PROCESS_CPUTIME_ID: actual = CLOCK_PROCESS_CPUTIME_ID; break;
      case UVWASI_CLOCK_THREAD_CPUTIME_ID: actual = CLOCK_THREAD_CPUTIME_ID; break;
      default: return UVWASI_EINVAL;
    }
    if (resolution && (id == UVWASI_CLOCK_MONOTONIC || id == UVWASI_CLOCK_REALTIME)) {
      m.Write64(out, 1); return 0; // Exact uvwasi API nanosecond-precision policy.
    }
    struct timespec ts;
    if ((resolution ? ::clock_getres(actual, &ts) : ::clock_gettime(actual, &ts)) < 0) return FromErrno(errno);
    m.Write64(out, uint64_t(ts.tv_sec) * 1000000000 + ts.tv_nsec); return 0;
  }
  uvwasi_errno_t Random(Memory m, uint32_t out, uint32_t length) {
    if (!m.Bounds(out, length)) return UVWASI_EOVERFLOW;
    // getentropy writes the actual current backing, with its documented256-byte
    // per-call limit; no host import or deterministic substitute is involved.
    size_t done = 0;
    while (done < length) {
      size_t part = std::min<size_t>(256, length - done);
      if (::getentropy(m.bytes + out + done, part) < 0) return FromErrno(errno);
      done += part;
    }
    return 0;
  }
  uvwasi_errno_t Yield() { return ::sched_yield() < 0 ? FromErrno(errno) : 0; }
  [[noreturn]] void Exit(uint32_t code) { std::exit(code); }
};
} // namespace kandelo::wasi
#endif
