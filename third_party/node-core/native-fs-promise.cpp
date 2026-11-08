/* Promise filesystem operations over guest libc and the shared work pool.
 * Included after native-fs.cpp. No worker enters JS or touches collector roots.
 * Source candidate only: C++ compilation and conformance remain pending.
 */
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <unistd.h>
#include <vector>

namespace {
static_assert(sizeof(off_t) == sizeof(int64_t), "Node filesystem offsets require guest 64-bit off_t");
static_assert(std::numeric_limits<off_t>::is_signed && std::numeric_limits<time_t>::is_signed, "Node filesystem scalars require signed guest SDK types");
static_assert(sizeof(time_t) == sizeof(int64_t), "Node filesystem timestamps require guest 64-bit time_t");
static int KandeloFsDoOpen(const char* path, int flags, mode_t mode) {
  // libuv's POSIX open always owns a close-on-exec descriptor, including
  // when callers omit O_CLOEXEC. Use the real SDK flag atomically.
  int fd; do { fd = open(path, flags | O_CLOEXEC, mode); } while (fd < 0 && errno == EINTR);
  return fd < 0 ? -errno : fd;
}
static bool KandeloFsFd(JSContext* cx, HandleValue value, int* fd, bool allowNegative = false) {
  // Public descriptor wrappers enforce nonnegative fds. Whole-file UTF8
  // bindings pass signed int32 inputs to POSIX so invalid fds yield EBADF.
  if (!value.isNumber() || !std::isfinite(value.toNumber()) ||
      std::floor(value.toNumber()) != value.toNumber() ||
      value.toNumber() < (allowNegative ? INT32_MIN : 0) || value.toNumber() > INT32_MAX) {
    JS_ReportErrorASCII(cx, allowNegative ? "Filesystem descriptor must be an int32" :
        "Filesystem descriptor must be a nonnegative int32"); return false;
  }
  *fd = int(value.toNumber()); return true;
}
static bool KandeloFsInteger(JSContext* cx, HandleValue value, int64_t minimum,
                             int64_t maximum, int64_t* result) {
  if (!value.isNumber() || !std::isfinite(value.toNumber()) ||
      std::floor(value.toNumber()) != value.toNumber() ||
      value.toNumber() < double(minimum) || value.toNumber() > double(maximum)) {
    JS_ReportErrorASCII(cx, "Filesystem integer argument is out of range"); return false;
  }
  *result = int64_t(value.toNumber()); return true;
}
static bool KandeloFsPosition(JSContext* cx, HandleValue value, off_t* position) {
  int64_t result = -1;
  if (value.isBigInt()) {
    if (!JS::BigIntFits<int64_t>(value.toBigInt(), &result)) {
      JS_ReportErrorASCII(cx, "Filesystem position is outside int64 range"); return false;
    }
  } else if (value.isNumber()) {
    // Node's GetOffset treats a non-safe-integer number as current position.
    const double number = value.toNumber();
    if (std::isfinite(number) && std::floor(number) == number &&
        number >= -9007199254740991.0 && number <= 9007199254740991.0)
      result = int64_t(number);
  }
  *position = result < 0 ? off_t(-1) : off_t(result); return true;
}
static bool KandeloFsPromiseRequest(JSContext* cx, HandleValue makeError,
                                   MutableHandleObject request,
                                   MutableHandleObject promise) {
  // Callback mode uses the already initialized, actual FSReqCallback. It
  // allocates no Promise and must not emit a second init for the same owner.
  if (makeError.isObject() && JS::GetClass(&makeError.toObject()) == &KandeloFsRequestClass) {
    RootedObject owner(cx, &makeError.toObject());
    auto* state = KandeloFsRequestStateOf(cx, owner);
    if (!state || state->kind != FsResourceKind::Callback || state->dispatched || state->retired) {
      JS_ReportErrorASCII(cx, "Filesystem callback request cannot be dispatched"); return false;
    }
    request.set(owner); promise.set(nullptr); return true;
  }
  if (!makeError.isObject() || !JS::IsCallable(&makeError.toObject())) {
    JS_ReportErrorASCII(cx, "Filesystem promise requires an error factory"); return false;
  }
  RootedObject executor(cx), prototype(cx);
  promise.set(JS::NewPromiseObject(cx, executor));
  if (!promise || !KandeloCreateFsResource(cx, prototype, makeError,
                                         FsResourceKind::Promise, request)) return false;
  JS::SetReservedSlot(request, FsRequestPromise, ObjectValue(*promise));
  // This is the actual resolver's Promise, not a stand-in async resource.
  if (!JS_DefineProperty(cx, request, "promise", promise, JSPROP_ENUMERATE)) return false;
  return true;
}
static void KandeloFsAbandonRequest(JSObject* request) {
  auto* state = static_cast<KandeloFsRequestState*>(JS::GetReservedSlot(request, FsRequestState).toPrivate());
  state->Retire();
  if (state->pairJob) {
    JS::RemoveAssociatedMemory(request, state->pairBytes, JS::MemoryUse::Embedding3);
    state->pairBytes = 0; state->pairJob.reset();
  }
  for (uint32_t slot : {FsRequestFrame, FsRequestCallback, FsRequestParent,
                        FsRequestPromise, FsRequestBuffers, FsRequestResult})
    JS::SetReservedSlot(request, slot, UndefinedValue());
}
// A native factory can expose its actual resource to init hooks before its
// public return packet exists. Retain that exact preparing request until the
// outer dispatcher publishes; never cancel work admitted by reentrant JS.
class KandeloFsRequestPublication final {
  JSContext* cx_;
  JS::RootedObject owner_;
  KandeloFsRequestState* state_ = nullptr;
  bool published_ = false;
 public:
  explicit KandeloFsRequestPublication(JSContext* cx) : cx_(cx), owner_(cx) {}
  KandeloFsRequestPublication(const KandeloFsRequestPublication&) = delete;
  KandeloFsRequestPublication& operator=(const KandeloFsRequestPublication&) = delete;
  void Register(HandleObject owner) {
    MOZ_RELEASE_ASSERT(!owner_ && !published_);
    state_ = static_cast<KandeloFsRequestState*>(
        JS::GetReservedSlot(owner, FsRequestState).toPrivate());
    MOZ_RELEASE_ASSERT(state_ && !state_->retired && !state_->dispatched && !state_->work);
    owner_ = owner;
  }
  void Commit() { published_ = true; }
  ~KandeloFsRequestPublication() {
    if (published_ || !owner_) return;
    JSAutoRealm realm(cx_, owner_);
    const Value slot = JS::GetReservedSlot(owner_, FsRequestState);
    if (slot.isUndefined() || slot.toPrivate() != state_) return;
    // Init hooks may have submitted this very request. Its real work queue,
    // not a failed outer packet, then owns callback/frame/result retirement.
    if (state_->dispatched || state_->work || state_->retired) return;
    // This path neither invokes JS nor replaces the pending publication error.
    KandeloFsAbandonRequest(owner_);
  }
};
static bool KandeloFsDispatchPrepared(JSContext* cx, HandleObject request,
                                      KandeloFsWork* work,
                                      js::shell::KandeloNativeWorkQueue* queue) {
  // Init sees the actual, fully owned operation. Failure retains neither an
  // undispatched native frame nor a pin just because a hook kept its object.
  auto cleanup = mozilla::MakeScopeExit([&] {
    if (work) { work->ReleaseIo(); js_delete(work); }
    KandeloFsAbandonRequest(request);
  });
  auto* state = KandeloFsRequestStateOf(cx, request); if (!state) return false;
  if (state->kind != FsResourceKind::Callback && !KandeloInitializeFsResource(cx, request)) return false;
  state->dispatched = true;
  if (!queue->Submit(work)) { JS_ReportErrorASCII(cx, "Filesystem work queue is closing"); return false; }
  work = nullptr; cleanup.release(); return true;
}

// Same finite-time conversion as libuv's uv__fs_to_timespec, with an explicit
// guard against undefined C++ casts outside the guest's actual time_t range.
static bool KandeloFsTime(JSContext* cx, HandleValue value, timespec* time) {
  if (!value.isNumber()) { JS_ReportErrorASCII(cx, "Filesystem timestamp must be numeric"); return false; }
  const double number = value.toNumber();
  if (std::isinf(number)) { *time = timespec{UTIME_NOW, UTIME_NOW}; return true; }
  if (std::isnan(number)) { *time = timespec{UTIME_OMIT, UTIME_OMIT}; return true; }
  const double lower = double(std::numeric_limits<time_t>::min());
  // Use an exclusive upper endpoint: int64 max rounds up to 2**63 as double.
  const double upper = -lower;
  if (number < lower || number >= upper) {
    JS_ReportErrorASCII(cx, "Filesystem timestamp is outside time_t range"); return false;
  }
  time->tv_sec = time_t(number);
  time->tv_nsec = long((number - double(time->tv_sec)) * 1e9);
  if (time->tv_nsec < 0) { time->tv_nsec += 1000000000; --time->tv_sec; }
  return true;
}
struct KandeloFsControlWork final : KandeloFsWork {
  enum class Control { Truncate, Sync, Datasync, Chmod, Chown, Times };
  Control control;
  uint32_t first = 0, second = 0;
  timespec times[2]{};
  KandeloFsControlWork(JSContext* cx, JSObject* request, int fd, Control control)
      : KandeloFsWork(cx, request, fd, 0, Operation::Control), control(control) {
    JS::AddAssociatedMemory(owner, sizeof(*this) - sizeof(KandeloFsWork), JS::MemoryUse::Embedding3);
  }
  ~KandeloFsControlWork() override {
    JS::RemoveAssociatedMemory(owner, sizeof(*this) - sizeof(KandeloFsWork), JS::MemoryUse::Embedding3);
  }
  const char* Syscall() const override {
    switch (control) {
      case Control::Truncate: return "ftruncate";
      case Control::Sync: return "fsync";
      case Control::Datasync: return "fdatasync";
      case Control::Chmod: return "fchmod";
      case Control::Chown: return "fchown";
      case Control::Times: return "futime";
    }
    MOZ_CRASH("Unknown filesystem control");
  }
  void Run() override {
    int code = -1;
    do {
      switch (control) {
        case Control::Truncate: code = ftruncate(fd, length); break;
        case Control::Sync: code = fsync(fd); break;
        case Control::Datasync: code = fdatasync(fd); break;
        case Control::Chmod: code = fchmod(fd, mode_t(first)); break;
        case Control::Chown: code = fchown(fd, uid_t(first), gid_t(second)); break;
        case Control::Times: code = futimens(fd, times); break;
      }
    } while (code == -1 && errno == EINTR);
    result = code == 0 ? 0 : -errno; performed = true;
  }
};
static bool KandeloFsControlPromise(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  int fd; if (!KandeloFsFd(cx, args.get(1), &fd)) return false;
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "Unknown filesystem control name"); return false; }
  struct NamedControl { const char* name; KandeloFsControlWork::Control control; };
  static const NamedControl controls[] = {
    {"ftruncate", KandeloFsControlWork::Control::Truncate}, {"fsync", KandeloFsControlWork::Control::Sync},
    {"fdatasync", KandeloFsControlWork::Control::Datasync}, {"fchmod", KandeloFsControlWork::Control::Chmod},
    {"fchown", KandeloFsControlWork::Control::Chown}, {"futimes", KandeloFsControlWork::Control::Times},
  };
  const NamedControl* selected = nullptr;
  RootedString name(cx, args[0].toString());
  for (const auto& entry : controls) {
    bool match; if (!JS_StringEqualsAscii(cx, name, entry.name, &match)) return false;
    if (match) { selected = &entry; break; }
  }
  if (!selected) { JS_ReportErrorASCII(cx, "Unknown filesystem control name"); return false; }
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(4), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloFsControlWork>(cx, request.get(), fd, selected->control);
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  auto dispose = mozilla::MakeScopeExit([&] { if (work) js_delete(work); });
  int64_t first = 0, second = 0;
  switch (selected->control) {
    case KandeloFsControlWork::Control::Truncate:
      if (!KandeloFsInteger(cx, args.get(2), 0, 9007199254740991LL, &first)) return false;
      work->length = off_t(first); break;
    case KandeloFsControlWork::Control::Chmod:
      if (!KandeloFsInteger(cx, args.get(2), 0, UINT32_MAX, &first)) return false;
      work->first = uint32_t(first); break;
    case KandeloFsControlWork::Control::Chown:
      if (!KandeloFsInteger(cx, args.get(2), -1, UINT32_MAX, &first) ||
          !KandeloFsInteger(cx, args.get(3), -1, UINT32_MAX, &second)) return false;
      work->first = uint32_t(first); work->second = uint32_t(second); break;
    case KandeloFsControlWork::Control::Times:
      if (!KandeloFsTime(cx, args.get(2), &work->times[0]) ||
          !KandeloFsTime(cx, args.get(3), &work->times[1])) return false;
      break;
    default: break;
  }
  auto* submitted = work; work = nullptr; abandon.release();
  if (!KandeloFsDispatchPrepared(cx, request, submitted, queue)) return false;
  if (promise) args.rval().setObject(*promise); else args.rval().setUndefined(); return true;
}

static bool KandeloFsControlSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int fd;
  if (!KandeloFsFd(cx, args.get(1), &fd)) return false;
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "Unknown filesystem control name"); return false; }
  RootedString name(cx, args[0].toString());
  const char* names[] = {"fchmod", "fchown", "futimes", "fsync", "fdatasync"};
  size_t selected = 5;
  for (size_t i = 0; i < 5; ++i) {
    bool matches; if (!JS_StringEqualsAscii(cx, name, names[i], &matches)) return false;
    if (matches) { selected = i; break; }
  }
  if (selected == 5) { JS_ReportErrorASCII(cx, "Unknown filesystem control name"); return false; }
  int64_t first = 0, second = 0; timespec times[2]{};
  if (selected == 0 && !KandeloFsInteger(cx, args.get(2), 0, UINT32_MAX, &first)) return false;
  if (selected == 1 && (!KandeloFsInteger(cx, args.get(2), -1, UINT32_MAX, &first) ||
      !KandeloFsInteger(cx, args.get(3), -1, UINT32_MAX, &second))) return false;
  if (selected == 2 && (!KandeloFsTime(cx, args.get(2), &times[0]) ||
      !KandeloFsTime(cx, args.get(3), &times[1]))) return false;
  int code;
  do {
    switch (selected) {
      case 0: code = fchmod(fd, mode_t(first)); break;
      case 1: code = fchown(fd, uid_t(first), gid_t(second)); break;
      case 2: code = futimens(fd, times); break;
      case 3: code = fsync(fd); break;
      default: code = fdatasync(fd); break;
    }
  } while (code == -1 && errno == EINTR);
  args.rval().setInt32(code == 0 ? 0 : -errno); return true;
}

struct KandeloFsIoWork final : KandeloFsWork {
  JS::KandeloBacking::SpanRef backing;
  char* data = nullptr;
  size_t size = 0;
  KandeloFsIoWork(JSContext* cx, JSObject* request, int fd, off_t position,
                  bool writing)
      : KandeloFsWork(cx, request, fd, position, writing ? Operation::Write : Operation::Read) {
    JS::AddAssociatedMemory(owner, sizeof(*this) - sizeof(KandeloFsWork), JS::MemoryUse::Embedding3);
  }
  ~KandeloFsIoWork() override {
    ReleaseIo();
    JS::RemoveAssociatedMemory(owner, sizeof(*this) - sizeof(KandeloFsWork), JS::MemoryUse::Embedding3);
  }
  void ReleaseIo() override { backing.reset(); data = nullptr; }
  const char* Syscall() const override { return operation == Operation::Write ? "write" : "read"; }
  void Run() override {
    ssize_t count;
    do {
      if (operation == Operation::Write)
        count = length < 0 ? write(fd, data, size) : pwrite(fd, data, size, length);
      else
        count = length < 0 ? read(fd, data, size) : pread(fd, data, size, length);
    } while (count == -1 && errno == EINTR);
    result = count < 0 ? -errno : int64_t(count); performed = true;
  }
};
static bool KandeloFsIoPromise(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isBoolean()) { JS_ReportErrorASCII(cx, "Filesystem I/O requires direction"); return false; }
  int fd; int64_t offset, count; off_t position;
  if (!KandeloFsFd(cx, args.get(1), &fd) ||
      !KandeloFsInteger(cx, args.get(3), 0, 9007199254740991LL, &offset) ||
      !KandeloFsInteger(cx, args.get(4), 0, INT32_MAX, &count) ||
      !KandeloFsPosition(cx, args.get(5), &position)) return false;
  if (!args.get(2).isObject() || !JS_IsArrayBufferViewObject(&args[2].toObject())) {
    JS_ReportErrorASCII(cx, "Filesystem I/O requires an ArrayBufferView"); return false;
  }
  RootedObject view(cx, &args[2].toObject());
  const size_t bytes = JS_GetArrayBufferViewByteLength(view);
  if (size_t(offset) > bytes || size_t(count) > bytes - size_t(offset)) {
    JS_ReportErrorASCII(cx, "Filesystem buffer span is out of bounds"); return false;
  }
  if (position >= 0 && uint64_t(position) > uint64_t(INT64_MAX) - uint64_t(count)) {
    JS_ReportErrorASCII(cx, "Filesystem position plus length exceeds int64"); return false;
  }
  // Node derives the uv span before GetReqWrap can create a Promise or emit
  // async init. Retain that same real allocation now; later JS view metadata
  // must neither redirect the operation nor impose a stricter length pin.
  auto backing = JS::KandeloBacking::Acquire(cx, view);
  if (!backing) return false;
  auto* initial = backing->Data();
  if (count && !initial) { JS_ReportErrorASCII(cx, "Filesystem buffer has no backing data"); return false; }
  char* data = initial ? reinterpret_cast<char*>(initial) + size_t(offset) : nullptr;
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(6), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloFsIoWork>(cx, request.get(), fd, position, args[0].toBoolean());
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  auto dispose = mozilla::MakeScopeExit([&] { if (work) js_delete(work); });
  work->backing = std::move(backing);
  work->data = data;
  work->size = size_t(count);
  // Preserve original JS identity separately from native allocation ownership.
  JS::SetReservedSlot(request, FsRequestBuffers, args[2]);
  auto* submitted = work; work = nullptr; abandon.release();
  if (!KandeloFsDispatchPrepared(cx, request, submitted, queue)) return false;
  if (promise) args.rval().setObject(*promise); else args.rval().setUndefined(); return true;
}
static bool KandeloFsPath(JSContext* cx, HandleValue value, JS::UniqueChars* name,
                            size_t* length) {
  if (value.isString()) {
    RootedString path(cx, value.toString());
    JSLinearString* linear = JS_EnsureLinearString(cx, path); if (!linear) return false;
    *length = JS::GetDeflatedUTF8StringLength(linear);
    if (*length == SIZE_MAX) { JS_ReportOutOfMemory(cx); return false; }
    name->reset(static_cast<char*>(js_malloc(*length + 1)));
    if (!*name) { JS_ReportOutOfMemory(cx); return false; }
    JS::DeflateStringToUTF8Buffer(linear, mozilla::Span<char>(name->get(), *length));
  } else if (value.isObject() && JS_IsUint8Array(&value.toObject())) {
    RootedObject view(cx, &value.toObject());
    *length = JS_GetArrayBufferViewByteLength(view);
    if (*length == SIZE_MAX) { JS_ReportOutOfMemory(cx); return false; }
    name->reset(static_cast<char*>(js_malloc(*length + 1)));
    if (!*name) { JS_ReportOutOfMemory(cx); return false; }
    {
      JS::AutoCheckCannotGC nogc; bool shared;
      const auto* bytes = static_cast<const uint8_t*>(JS_GetArrayBufferViewData(view, &shared, nogc));
      // Pathnames may use shared Uint8Array storage. Snapshot actual bytes
      // atomically before queuing; memcpy would race another guest thread.
      for (size_t i = 0; i < *length; ++i) name->get()[i] = char(__atomic_load_n(bytes + i, __ATOMIC_RELAXED));
    }
  } else { JS_ReportErrorASCII(cx, "Filesystem pathname must be string or Uint8Array"); return false; }
  if (memchr(name->get(), 0, *length)) {
    JS_ReportErrorASCII(cx, "Filesystem pathname contains NUL"); return false;
  }
  name->get()[*length] = 0; return true;
}
template <typename T> static void KandeloFsFillStat(const struct stat& metadata, T* fields) {
    // Pinned FsStatsOffset ordering. Values come from the guest's actual libc
    // struct stat, never a host layout or hardcoded permission/identity map.
    fields[0] = T(metadata.st_dev); fields[1] = T(metadata.st_mode);
    fields[2] = T(metadata.st_nlink); fields[3] = T(metadata.st_uid);
    fields[4] = T(metadata.st_gid); fields[5] = T(metadata.st_rdev);
    fields[6] = T(metadata.st_blksize); fields[7] = T(metadata.st_ino);
    fields[8] = T(metadata.st_size); fields[9] = T(metadata.st_blocks);
    fields[10] = T(metadata.st_atim.tv_sec); fields[11] = T(metadata.st_atim.tv_nsec);
    fields[12] = T(metadata.st_mtim.tv_sec); fields[13] = T(metadata.st_mtim.tv_nsec);
    fields[14] = T(metadata.st_ctim.tv_sec); fields[15] = T(metadata.st_ctim.tv_nsec);
    // This guest fstat interface has no creation-time field. Use libuv's POSIX
    // no-birthtime fallback, not a fabricated creation timestamp. Statx/btime
    // capability coverage still needs its owning-kernel audit.
    fields[16] = T(metadata.st_ctim.tv_sec); fields[17] = T(metadata.st_ctim.tv_nsec);
  }
static bool KandeloFsStatValue(JSContext* cx, const struct stat& metadata, bool useBigInt,
                                MutableHandleValue value) {
    RootedObject array(cx, useBigInt ? JS_NewBigInt64Array(cx, 18) : JS_NewFloat64Array(cx, 18));
    if (!array) return false;
    {
      JS::AutoCheckCannotGC nogc; bool shared;
      if (useBigInt) KandeloFsFillStat(metadata, JS_GetBigInt64ArrayData(array, &shared, nogc));
      else KandeloFsFillStat(metadata, JS_GetFloat64ArrayData(array, &shared, nogc));
    }
    value.setObject(*array); return true;
  }
struct KandeloFsStatWork final : KandeloFsWork {
  struct stat metadata{};
  bool useBigInt, follow, throwIfNoEntry;
  JS::UniqueChars name;
  size_t nameLength, associated;
  KandeloFsStatWork(JSContext* cx, JSObject* request, int fd, bool useBigInt,
                    JS::UniqueChars name, size_t length, bool follow, bool throwIfNoEntry)
      : KandeloFsWork(cx, request, fd, 0, Operation::Stat), useBigInt(useBigInt),
        follow(follow), throwIfNoEntry(throwIfNoEntry), name(std::move(name)), nameLength(length) {
    associated = sizeof(*this) - sizeof(KandeloFsWork) + (this->name ? length + 1 : 0);
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloFsStatWork() override {
    JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  const char* Syscall() const override { return fd >= 0 ? "fstat" : follow ? "stat" : "lstat"; }
  void Run() override {
    int code;
    do { code = fd >= 0 ? fstat(fd, &metadata) : follow ? stat(name.get(), &metadata) : lstat(name.get(), &metadata); }
    while (code == -1 && errno == EINTR);
    result = code == 0 ? 0 : -errno; performed = true;
  }
  bool Succeeded() const override {
    return result >= 0 || (fd < 0 && !throwIfNoEntry && (result == -ENOENT || result == -ENOTDIR));
  }
  bool ResultValue(JSContext* cx, MutableHandleValue value) override {
    if (result < 0) { value.setUndefined(); return true; }
    return KandeloFsStatValue(cx, metadata, useBigInt, value);
  }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    return name ? KandeloFsPathString(cx, name.get(), nameLength, value) :
                  KandeloFsWork::ErrorPathValue(cx, value);
  }
};
static bool KandeloFsStatPromise(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int fd = -1; JS::UniqueChars name; size_t length = 0;
  if (args.get(0).isNumber()) { if (!KandeloFsFd(cx, args[0], &fd)) return false; }
  else if (!KandeloFsPath(cx, args.get(0), &name, &length)) return false;
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(2), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloFsStatWork>(cx, request.get(), fd,
      args.get(1).isBoolean() && args[1].toBoolean(), std::move(name), length,
      !args.get(3).isBoolean() || args[3].toBoolean(), !args.get(4).isBoolean() || args[4].toBoolean());
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  abandon.release();
  if (!KandeloFsDispatchPrepared(cx, request, work, queue)) return false;
  if (promise) args.rval().setObject(*promise); else args.rval().setUndefined(); return true;
}
static bool KandeloFsStatSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); struct stat metadata{}; int code;
  if (args.get(0).isNumber()) {
    int fd; if (!KandeloFsFd(cx, args[0], &fd)) return false;
    do { code = fstat(fd, &metadata); } while (code == -1 && errno == EINTR);
  } else if (args.get(1).isBoolean()) {
    JS::UniqueChars name; size_t length;
    if (!KandeloFsPath(cx, args[0], &name, &length)) return false;
    do { code = args[1].toBoolean() ? stat(name.get(), &metadata) : lstat(name.get(), &metadata); }
    while (code == -1 && errno == EINTR);
  } else { JS_ReportErrorASCII(cx, "stat requires a pathname or descriptor"); return false; }
  if (code < 0) { args.rval().setInt32(-errno); return true; }
  return KandeloFsStatValue(cx, metadata, args.get(2).isBoolean() && args[2].toBoolean(), args.rval());
}
static int64_t KandeloFsVectorIo(bool writing, int fd, off_t position, std::vector<iovec>& spans) {
    if (spans.empty()) return -EINVAL;
    const long actualMax = sysconf(_SC_IOV_MAX);
    if (actualMax <= 0) return -EINVAL;
    const size_t maxCount = std::min(size_t(actualMax), size_t(INT_MAX));
    size_t first = 0;
    int64_t total = 0;
    do {
      const size_t count = std::min(maxCount, spans.size() - first);
      ssize_t bytes;
      do {
        if (writing)
          bytes = position < 0 ? writev(fd, spans.data() + first, int(count)) :
                                pwritev(fd, spans.data() + first, int(count), position);
        else
          bytes = position < 0 ? readv(fd, spans.data() + first, int(count)) :
                                preadv(fd, spans.data() + first, int(count), position);
      } while (bytes == -1 && errno == EINTR);
      if (bytes <= 0) {
        return total == 0 && bytes < 0 ? -errno : total;
      }
      if (int64_t(bytes) > INT64_MAX - total) { return -EOVERFLOW; }
      total += int64_t(bytes);
      if (!writing) break;  // libuv reads at most one IOV_MAX batch.
      if (position >= 0) {
        if (uint64_t(bytes) > uint64_t(INT64_MAX) - uint64_t(position)) {
          return -EOVERFLOW;
        }
        position += off_t(bytes);
      }
      size_t consumed = size_t(bytes);
      // As in libuv's write_all: finish partial buffers before subsequent
      // batches, but return real progress if a later write fails or stalls.
      while (first < spans.size() && consumed >= spans[first].iov_len) {
        consumed -= spans[first].iov_len; ++first;
      }
      if (first < spans.size() && consumed) {
        spans[first].iov_base = static_cast<char*>(spans[first].iov_base) + consumed;
        spans[first].iov_len -= consumed;
      }
    } while (first < spans.size());
    return total;
}
struct KandeloFsVectorWork final : KandeloFsWork {
  // Keep the capacity claim until both actual vectors are destroyed.
  JS::KandeloBacking::MetadataRef storage;
  std::vector<iovec> spans;
  std::vector<JS::KandeloBacking::SpanRef> backings;
  size_t associated = 0;
  KandeloFsVectorWork(JSContext* cx, JSObject* request, int fd, off_t position,
                      bool writing, std::vector<iovec>&& captured,
                      std::vector<JS::KandeloBacking::SpanRef>&& owners,
                      JS::KandeloBacking::MetadataRef&& metadata)
      : KandeloFsWork(cx, request, fd, position, writing ? Operation::Write : Operation::Read),
        storage(std::move(metadata)), spans(std::move(captured)), backings(std::move(owners)) {
    associated = sizeof(*this) - sizeof(KandeloFsWork);
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloFsVectorWork() override {
    ReleaseIo(); JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  void ReleaseIo() override {
    backings.clear();
    for (auto& span : spans) span.iov_base = nullptr;
  }
  const char* Syscall() const override { return operation == Operation::Write ? "write" : "read"; }
  void Run() override {
    result = KandeloFsVectorIo(operation == Operation::Write, fd, length, spans);
    performed = true;
  }
};
static bool KandeloFsVectorPromise(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int fd; off_t position;
  if (!args.get(0).isBoolean()) { JS_ReportErrorASCII(cx, "Filesystem vector I/O requires direction"); return false; }
  if (!KandeloFsFd(cx, args.get(1), &fd) || !KandeloFsPosition(cx, args.get(3), &position)) return false;
  if (!args.get(2).isObject()) { JS_ReportErrorASCII(cx, "Filesystem vectors require an array"); return false; }
  RootedObject buffers(cx, &args[2].toObject()); bool array; uint32_t count;
  if (!JS::IsArrayObject(cx, buffers, &array)) return false;
  if (!array) { JS_ReportErrorASCII(cx, "Filesystem vectors require an array"); return false; }
  if (!JS::GetArrayLength(cx, buffers, &count)) return false;
  JS::KandeloBacking::MetadataRef storage;
  std::vector<iovec> spans(count);
  std::vector<JS::KandeloBacking::SpanRef> backings(count);
  if (count) {
    if (spans.capacity() > SIZE_MAX / sizeof(iovec) ||
        backings.capacity() > (SIZE_MAX - spans.capacity() * sizeof(iovec)) / sizeof(backings[0])) {
      JS_ReportOutOfMemory(cx); return false;
    }
    storage = JS::KandeloBacking::TrackMetadata(
        spans.capacity() * sizeof(iovec) + backings.capacity() * sizeof(backings[0]),
        JS::KandeloBacking::ResolveAccount(cx));
    if (!storage) { JS_ReportErrorASCII(cx, "Native vector ownership is unavailable"); return false; }
  }
  // Exactly one native list Get per entry, in order, before request init. A
  // later getter can detach/resize/replace an earlier entry without redirecting
  // its already owned span. No temporary JS list or send snapshot is created.
  for (uint32_t i = 0; i < count; ++i) {
    RootedValue entry(cx);
    if (!JS_GetElement(cx, buffers, i, &entry)) return false;
    if (!entry.isObject() || !JS_IsArrayBufferViewObject(&entry.toObject())) {
      JS_ReportErrorASCII(cx, "Filesystem vector entry is not an ArrayBufferView"); return false;
    }
    RootedObject view(cx, &entry.toObject());
    backings[i] = JS::KandeloBacking::Acquire(cx, view);
    if (!backings[i]) return false;
    spans[i].iov_base = backings[i]->Data();
    spans[i].iov_len = backings[i]->Length();
  }
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(4), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  auto* queue = count == 0 ? nullptr : js::shell::KandeloGetNativeWorkQueue(cx);
  if (count && !queue) return false;
  auto* work = js_new<KandeloFsVectorWork>(cx, request.get(), fd, position,
      args[0].toBoolean(), std::move(spans), std::move(backings), std::move(storage));
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  auto dispose = mozilla::MakeScopeExit([&] { if (work) js_delete(work); });
  JS::SetReservedSlot(request, FsRequestBuffers, args[2]);
  if (count == 0) {
    // Preserve uv_fs_read's actual empty-iovec error and request lifecycle.
    if (work->State()->kind != FsResourceKind::Callback && !KandeloInitializeFsResource(cx, request)) return false;
    work->result = -EINVAL;
    if (!work->Complete(cx)) return false;
  } else {
    auto* submitted = work; work = nullptr; abandon.release();
    if (!KandeloFsDispatchPrepared(cx, request, submitted, queue)) return false;
  }
  abandon.release(); if (promise) args.rval().setObject(*promise); else args.rval().setUndefined(); return true;
}
struct KandeloFsOpenWork final : KandeloFsWork {
  JS::UniqueChars name;
  size_t nameLength, nameBytes;
  int flags;
  mode_t mode;
  int opened = -1;
  KandeloFsOpenWork(JSContext* cx, JSObject* request, JS::UniqueChars name,
                    size_t length, int flags, mode_t mode)
      : KandeloFsWork(cx, request, -1, 0, Operation::Open), name(std::move(name)),
        nameLength(length), nameBytes(length + 1), flags(flags), mode(mode) {
    JS::AddAssociatedMemory(owner, sizeof(*this) - sizeof(KandeloFsWork) + nameBytes,
                             JS::MemoryUse::Embedding3);
  }
  ~KandeloFsOpenWork() override {
    if (opened >= 0) KandeloFsDoClose(opened);
    JS::RemoveAssociatedMemory(owner, sizeof(*this) - sizeof(KandeloFsWork) + nameBytes,
                                JS::MemoryUse::Embedding3);
  }
  const char* Syscall() const override { return "open"; }
  void Run() override {
    const int status = KandeloFsDoOpen(name.get(), flags, mode);
    opened = status < 0 ? -1 : status;
    result = status; performed = true;
  }
  bool PrepareResult(JSContext* cx) override {
    if (State()->kind == FsResourceKind::Callback) return true;
    JS::UniqueChars copied(static_cast<char*>(js_malloc(nameLength + 1)));
    if (!copied) { JS_ReportOutOfMemory(cx); return false; }
    memcpy(copied.get(), name.get(), nameLength + 1);
    RootedValue makeError(cx, JS::GetReservedSlot(owner, FsRequestCallback));
    RootedObject handle(cx);
    const int fd = opened; opened = -1;  // Native adoption consumes fd on entry.
    if (!KandeloAdoptNamedFileHandle(cx, fd, std::move(copied), nameLength, makeError, &handle)) return false;
    JS::SetReservedSlot(owner, FsRequestResult, ObjectValue(*handle)); return true;
  }
  bool ResultValue(JSContext*, MutableHandleValue value) override {
    if (State()->kind == FsResourceKind::Callback) {
      value.setInt32(opened); opened = -1; // The guest caller now owns the fd.
    } else value.set(JS::GetReservedSlot(owner, FsRequestResult));
    return true;
  }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    return KandeloFsPathString(cx, name.get(), nameLength, value);
  }
};
static bool KandeloFsOpenPromise(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int64_t flags, mode;
  if (!KandeloFsInteger(cx, args.get(1), INT32_MIN, INT32_MAX, &flags) ||
      !KandeloFsInteger(cx, args.get(2), 0, UINT32_MAX, &mode)) return false;
  JS::UniqueChars name; size_t length;
  if (!KandeloFsPath(cx, args[0], &name, &length)) return false;
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(3), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloFsOpenWork>(cx, request.get(), std::move(name), length, int(flags), mode_t(mode));
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  abandon.release();
  if (!KandeloFsDispatchPrepared(cx, request, work, queue)) return false;
  if (promise) args.rval().setObject(*promise); else args.rval().setUndefined(); return true;
}
static bool KandeloFsOpenSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int64_t flags, mode;
  if (!KandeloFsInteger(cx, args.get(1), INT32_MIN, INT32_MAX, &flags) ||
      !KandeloFsInteger(cx, args.get(2), 0, UINT32_MAX, &mode)) return false;
  JS::UniqueChars name; size_t length;
  if (!KandeloFsPath(cx, args.get(0), &name, &length)) return false;
  args.rval().setInt32(KandeloFsDoOpen(name.get(), int(flags), mode_t(mode))); return true;
}
static bool KandeloFsIoSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int fd; int64_t offset, count; off_t position;
  if (!args.get(0).isBoolean() || !args.get(2).isObject() ||
      !JS_IsArrayBufferViewObject(&args[2].toObject())) {
    JS_ReportErrorASCII(cx, "Filesystem I/O requires direction and ArrayBufferView"); return false;
  }
  if (!KandeloFsFd(cx, args.get(1), &fd, true) ||
      !KandeloFsInteger(cx, args.get(3), 0, 9007199254740991LL, &offset) ||
      !KandeloFsInteger(cx, args.get(4), 0, INT32_MAX, &count) ||
      !KandeloFsPosition(cx, args.get(5), &position)) return false;
  RootedObject view(cx, &args[2].toObject());
  const size_t bytes = JS_GetArrayBufferViewByteLength(view);
  if (uint64_t(offset) > uint64_t(bytes) || uint64_t(count) > uint64_t(bytes) - uint64_t(offset) ||
      (position >= 0 && uint64_t(position) > uint64_t(INT64_MAX) - uint64_t(count))) {
    JS_ReportErrorASCII(cx, "Filesystem buffer or offset span is out of bounds"); return false;
  }
  ssize_t transferred = -1; int error = 0; bool live;
  {
    // No JS can run or collect while this synchronous libc operation holds
    // an engine view pointer. Async jobs own native allocation spans instead.
    JS::AutoCheckCannotGC nogc; bool shared;
    char* data = static_cast<char*>(JS_GetArrayBufferViewData(view, &shared, nogc));
    live = count == 0 || data;
    if (live) {
      char* start = data ? data + size_t(offset) : nullptr;
      do {
        if (args[0].toBoolean())
          transferred = position < 0 ? write(fd, start, size_t(count)) : pwrite(fd, start, size_t(count), position);
        else
          transferred = position < 0 ? read(fd, start, size_t(count)) : pread(fd, start, size_t(count), position);
      } while (transferred < 0 && errno == EINTR);
      if (transferred < 0) error = errno;
    }
  }
  if (!live) { JS_ReportErrorASCII(cx, "Filesystem view has no backing data"); return false; }
  args.rval().setNumber(transferred < 0 ? -double(error) : double(transferred)); return true;
}
static bool KandeloFsVectorSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int fd; off_t position;
  if (!args.get(0).isBoolean() || !args.get(2).isObject()) {
    JS_ReportErrorASCII(cx, "Filesystem vector I/O requires direction and array"); return false;
  }
  if (!KandeloFsFd(cx, args.get(1), &fd) || !KandeloFsPosition(cx, args.get(3), &position)) return false;
  RootedObject array(cx, &args[2].toObject()); bool isArray; uint32_t count;
  if (!JS::IsArrayObject(cx, array, &isArray)) return false;
  if (!isArray) { JS_ReportErrorASCII(cx, "Filesystem vectors require an array"); return false; }
  if (!JS::GetArrayLength(cx, array, &count)) return false;
  // A later JS entry getter can invalidate or replace an earlier view.
  // Capture each original span immediately, as the native uv vector does.
  // Metadata outlives both actual vector allocations, including failure paths.
  JS::KandeloBacking::MetadataRef storage;
  std::vector<iovec> spans(count);
  std::vector<JS::KandeloBacking::SpanRef> backings(count);
  if (count) {
    if (spans.capacity() > SIZE_MAX / sizeof(iovec) ||
        backings.capacity() > (SIZE_MAX - spans.capacity() * sizeof(iovec)) / sizeof(backings[0])) {
      JS_ReportOutOfMemory(cx); return false;
    }
    storage = JS::KandeloBacking::TrackMetadata(
        spans.capacity() * sizeof(iovec) + backings.capacity() * sizeof(backings[0]),
        JS::KandeloBacking::ResolveAccount(cx));
    if (!storage) { JS_ReportErrorASCII(cx, "Native vector ownership is unavailable"); return false; }
  }
  for (uint32_t i = 0; i < count; ++i) {
    RootedValue value(cx); if (!JS_GetElement(cx, array, i, &value)) return false;
    if (!value.isObject() || !JS_IsArrayBufferViewObject(&value.toObject())) {
      JS_ReportErrorASCII(cx, "Filesystem vector entry is not an ArrayBufferView"); return false;
    }
    RootedObject view(cx, &value.toObject());
    backings[i] = JS::KandeloBacking::Acquire(cx, view);
    if (!backings[i]) return false;
    spans[i].iov_base = backings[i]->Data();
    spans[i].iov_len = backings[i]->Length();
  }
  const int64_t result = KandeloFsVectorIo(args[0].toBoolean(), fd, position, spans);
  args.rval().setNumber(double(result)); return true;
}
template <bool (*Callback)(JSContext*, unsigned, Value*)>
static bool KandeloFsPromiseGuard(JSContext* cx, unsigned argc, Value* vp) {
  try { return Callback(cx, argc, vp); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  catch (const std::length_error&) { JS_ReportOutOfMemory(cx); return false; }
  catch (...) { JS_ReportErrorASCII(cx, "Unexpected native filesystem request failure"); return false; }
}
}  // namespace
