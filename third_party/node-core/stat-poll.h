// Owned native port boundary for the unchanged pinned libuv fs-poll algorithm.
#ifndef KANDELO_NODE_STAT_POLL_H
#define KANDELO_NODE_STAT_POLL_H
#include <cstddef>
#include <cstdint>
#include <memory>
#include <sys/stat.h>
namespace kandelo::memory { class Account; using AccountHandle = std::shared_ptr<Account>; }
namespace kandelo::fs_poll {
struct poll_ctx;
struct uv_loop_t; struct uv_fs_t; struct uv_handle_t;
using uv_timer_t = uv_handle_t;
using uv_fs_poll_t = uv_handle_t;
// The audited native26 target has 64-bit time fields. Guest long may be 32
// bits even with time_t64; private port storage must not truncate real stat
// seconds at 2038. This is not the libuv binary ABI or an exported wire record.
struct uv_timespec_t { int64_t tv_sec; int64_t tv_nsec; };
struct uv_stat_t {
  uint64_t st_dev, st_mode, st_nlink, st_uid, st_gid, st_rdev, st_ino, st_size,
      st_blksize, st_blocks, st_flags, st_gen;
  uv_timespec_t st_atim, st_mtim, st_ctim, st_birthtim;
};
using uv_fs_cb = void (*)(uv_fs_t*);
using uv_timer_cb = void (*)(uv_timer_t*);
using uv_close_cb = void (*)(uv_handle_t*);
using uv_fs_poll_cb = void (*)(uv_fs_poll_t*, int, const uv_stat_t*, const uv_stat_t*);
// One actual portable storage type avoids aliasing a C common-prefix layout as
// unrelated C++ classes. These are private port types, never libuv ABI structs.
struct uv_handle_t {
  uv_loop_t* loop = nullptr; unsigned flags = 0; void* data = nullptr;
  struct poll_ctx* poll_ctx = nullptr;
  uv_timer_t* previous = nullptr; uv_timer_t* next = nullptr;
  uv_timer_t* closingNext = nullptr;
  uint64_t due = 0, order = 0;
  uv_timer_cb callback = nullptr;
  uv_close_cb closeCallback = nullptr;
};
struct uv_fs_t {
  uv_loop_t* loop = nullptr;
  int result = 0; uv_stat_t statbuf{};
  const char* path = nullptr; uv_fs_cb callback = nullptr;
};
#undef KANDELO_POLL_HANDLE_FIELDS
struct uv_loop_t {
  void* data = nullptr;
  // Submit must queue a real asynchronous stat. It must never call its callback
  // inline or enter JS from a worker. Request/path remain owned until callback.
  int (*submit)(uv_loop_t*, uv_fs_t*) = nullptr;
  // Called only after every native polling context/timer/request has retired.
  void (*closed)(uv_fs_poll_t*) = nullptr;
  uint64_t time = 0, order = 0;
  uv_timer_t* timers = nullptr;
  uv_timer_t* closing = nullptr;
  uv_timer_t* closingTail = nullptr;
};
int uv_fs_poll_init(uv_loop_t*, uv_fs_poll_t*);
int uv_fs_poll_start(uv_fs_poll_t*, uv_fs_poll_cb, const char*, unsigned);
int StartPoll(uv_fs_poll_t*, uv_fs_poll_cb, const char*, unsigned, const kandelo::memory::AccountHandle&);
int uv_fs_poll_stop(uv_fs_poll_t*);
int uv_fs_poll_getpath(uv_fs_poll_t*, char*, size_t*);
void uv__fs_poll_close(uv_fs_poll_t*);
void ClosePoll(uv_fs_poll_t*);
void Ref(uv_fs_poll_t*, bool) noexcept;
bool HasRef(const uv_fs_poll_t*) noexcept;
void UpdateTime(uv_loop_t*, uint64_t actualMonotonicMilliseconds) noexcept;
bool RunOneTimer(uv_loop_t*);
bool RunOneClose(uv_loop_t*);
int64_t NextDelay(const uv_loop_t*) noexcept;
bool Active(const uv_fs_poll_t*) noexcept;
bool OwnsRequest(const uv_fs_poll_t*, const uv_fs_t*) noexcept;
bool Closing(const uv_fs_poll_t*) noexcept;
int StatPath(const char*, struct stat*) noexcept;
void CompleteStat(uv_fs_t*, int error, const struct stat*);
}  // namespace kandelo::fs_poll
#endif
