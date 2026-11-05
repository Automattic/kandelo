/* Native pathname file jobs. Included after native-fs-promise.cpp. The read
 * worker owns its path and allocation without any JS memory/data pointers.
 * Source candidate only: native/four-host conformance remains pending.
 */
#include "kandelo-node-write-file-operations.h"
namespace {
struct KandeloReadFileWork final : KandeloFsWork {
  const char* path;
  uint64_t limit;
  int flags;
  int handoffFd = -1, closeError = 0;
  uint64_t regularSize = 0;
  char* data = nullptr;
  size_t used = 0, capacity = 0, associated;
  const char* failedSyscall = "read";
  KandeloReadFileWork(JSContext* cx, JSObject* request)
      : KandeloFsWork(cx, request, -1, 0, Operation::FileRead),
        path(State()->name.get()), limit(State()->limit), flags(State()->flags),
        associated(sizeof(*this) - sizeof(KandeloFsWork)) {
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloReadFileWork() override {
    js_free(data);
    if (handoffFd >= 0) KandeloFsDoClose(handoffFd);
    JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  void Fail(const char* syscall, int code) { failedSyscall = syscall; result = code; }
  const char* Syscall() const override { return failedSyscall; }
  void Run() override {
    int opened = KandeloFsDoOpen(path, flags, 0666);
    if (opened < 0) { Fail("open", opened); return; }
    // Every exit owns this fd until a completed read deliberately hands it
    // to the JS continuation. No descriptor duplication or path reopening.
    auto closeFd = mozilla::MakeScopeExit([&] {
      if (opened >= 0) closeError = KandeloFsDoClose(opened);
    });
    struct stat metadata{};
    int status; do { status = fstat(opened, &metadata); } while (status < 0 && errno == EINTR);
    if (status < 0) { Fail("fstat", -errno); return; }
    regularSize = (metadata.st_mode & S_IFMT) == S_IFREG ? uint64_t(metadata.st_size) : 0;
    if (regularSize > limit) { handoffFd = opened; opened = -1; return; }
    capacity = regularSize ? size_t(regularSize) : 64u * 1024;
    // This SDK must represent the actual allocation, independent of the
    // larger integer metadata a stat record may report.
    if (uint64_t(capacity) != (regularSize ? regularSize : uint64_t(64u * 1024))) {
      Fail("read", -ENOMEM); return;
    }
    data = static_cast<char*>(js_malloc(capacity));
    if (!data) { Fail("read", -ENOMEM); return; }
    while (true) {
      if (used == capacity) {
        if (regularSize) break;
        if (capacity > SIZE_MAX / 2) { Fail("read", -ENOMEM); break; }
        const size_t grownSize = capacity * 2;
        char* grown = static_cast<char*>(js_realloc(data, grownSize));
        if (!grown) { Fail("read", -ENOMEM); break; }
        data = grown; capacity = grownSize;
      }
      const size_t count = std::min(capacity - used, size_t(256u * 1024 * 1024));
      ssize_t bytes; do { bytes = read(opened, data + used, count); } while (bytes < 0 && errno == EINTR);
      if (bytes < 0) { Fail("read", -errno); break; }
      if (bytes == 0) break;
      used += size_t(bytes);
    }
    if (result < 0) { js_free(data); data = nullptr; used = capacity = 0; }
    else if (capacity - used >= 4096) {
      const size_t smaller = used ? used : 1;
      char* shrunk = static_cast<char*>(js_realloc(data, smaller));
      if (shrunk) { data = shrunk; capacity = smaller; }
    }
    performed = true;
  }
  bool PrepareResult(JSContext* cx) override {
    // Result views, like Node Buffer::New, exist before MakeCallback's
    // before hook. They are real typed arrays over the owned backing store.
    if (capacity) JS::AddAssociatedMemory(owner, capacity, JS::MemoryUse::Embedding3);
    associated += capacity;
    JS::RootedValueArray<4> fields(cx);
    fields[1].setInt32(handoffFd);
    if (handoffFd >= 0) fields[2].setNumber(double(regularSize));
    else {
      mozilla::UniquePtr<void, JS::FreePolicy> owned(data); data = nullptr;
      RootedObject buffer(cx, JS::NewArrayBufferWithContents(cx, used, std::move(owned)));
      if (!buffer) return false;
      // The engine now owns/accounted the allocation. Retire the native
      // charge at that actual transfer, before any callback can observe it.
      if (capacity) JS::RemoveAssociatedMemory(owner, capacity, JS::MemoryUse::Embedding3);
      associated -= capacity;
      RootedObject view(cx, JS_NewUint8ArrayWithBuffer(cx, buffer, 0, int64_t(used)));
      if (!view) return false;
      RootedObject prototype(cx, &JS::GetReservedSlot(owner, FsRequestBuffers).toObject());
      if (!JS_SetPrototype(cx, view, prototype)) return false;
      fields[0].setObject(*view);
    }
    if (closeError < 0) fields[3].setInt32(closeError);
    RootedObject packet(cx, JS::NewArrayObject(cx, fields));
    if (!packet) return false;
    JS::SetReservedSlot(owner, FsRequestResult, ObjectValue(*packet));
    handoffFd = -1; // Packet/callback continuation now owns the descriptor.
    return true;
  }
  bool ResultValue(JSContext*, MutableHandleValue value) override {
    value.set(JS::GetReservedSlot(owner, FsRequestResult)); return true;
  }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    return KandeloFsPathString(cx, path, State()->nameLength, value);
  }
};
static bool KandeloNativeCreateReadFileJob(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int64_t flags, limit;
  if ((!args.get(0).isObject() && !args.get(0).isNull()) ||
      !args.get(5).isObject() || !JS::IsCallable(&args[5].toObject()) || !args.get(6).isObject()) {
    JS_ReportErrorASCII(cx, "ReadFileJob requires prototype and completion callback"); return false;
  }
  if (!KandeloFsInteger(cx, args.get(2), INT32_MIN, INT32_MAX, &flags) ||
      !KandeloFsInteger(cx, args.get(3), 0, 9007199254740991LL, &limit)) return false;
  JS::UniqueChars name; size_t length;
  if (!KandeloFsPath(cx, args.get(1), &name, &length)) return false;
  RootedObject prototype(cx, args[0].toObjectOrNull()), owner(cx);
  if (!KandeloCreateFsResource(cx, prototype, args[5], FsResourceKind::FileRead, &owner)) return false;
  auto* state = KandeloFsRequestStateOf(cx, owner); if (!state) return false;
  state->name = std::move(name); state->nameLength = length; state->nameBytes = length + 1;
  state->flags = int(flags); state->limit = uint64_t(limit);
  JS::SetReservedSlot(owner, FsRequestBuffers, args[6]);
  JS::AddAssociatedMemory(owner, state->nameBytes, JS::MemoryUse::Embedding3);
  if (!KandeloInitializeFsResource(cx, owner)) return false;
  args.rval().setObject(*owner); return true;
}
static bool KandeloNativeRunReadFileJob(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) { JS_ReportErrorASCII(cx, "Invalid ReadFileJob"); return false; }
  RootedObject owner(cx, &args[0].toObject());
  auto* state = KandeloFsRequestStateOf(cx, owner);
  if (!state || state->kind != FsResourceKind::FileRead || state->dispatched || state->retired) {
    if (state) JS_ReportErrorASCII(cx, "ReadFileJob already dispatched or retired"); return false;
  }
  auto failed = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(owner); });
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloReadFileWork>(cx, owner.get());
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  state->dispatched = true;
  if (!queue->Submit(work)) { js_delete(work); JS_ReportErrorASCII(cx, "ReadFileJob work queue is closing"); return false; }
  failed.release(); args.rval().setUndefined(); return true;
}
struct KandeloWriteFileWork final : KandeloFsWork {
  js::shell::KandeloNativeWorkQueue* ownerQueue;
  const char* path;
  int flags;
  mode_t mode;
  js::shell::KandeloNativePin* pin = nullptr;
  const char* data = nullptr;
  size_t size = 0;
  const char* failedSyscall = "write";
  KandeloWriteFileWork(JSContext* cx, JSObject* request, js::shell::KandeloNativeWorkQueue* queue)
      : KandeloFsWork(cx, request, -1, 0, Operation::FileRead), ownerQueue(queue),
        path(State()->name.get()), flags(State()->flags), mode(mode_t(State()->fileMode)) {
    JS::AddAssociatedMemory(owner, sizeof(*this) - sizeof(KandeloFsWork), JS::MemoryUse::Embedding3);
  }
  ~KandeloWriteFileWork() override {
    ReleaseIo();
    JS::RemoveAssociatedMemory(owner, sizeof(*this) - sizeof(KandeloFsWork), JS::MemoryUse::Embedding3);
  }
  void ReleaseIo() override { ownerQueue->Unpin(pin); pin = nullptr; data = nullptr; }
  const char* Syscall() const override { return failedSyscall; }
  void Run() override {
    const auto outcome = kandelo::nodefs::WritePathFile(path, flags, mode, data, size);
    result = outcome.status; failedSyscall = outcome.syscall; performed = true;
  }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    if (strcmp(failedSyscall, "open") != 0) { value.setUndefined(); return true; }
    RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx,
        reinterpret_cast<const uint8_t*>(State()->name.get()), State()->nameLength));
    if (!bytes) return false;
    value.setObject(*bytes); return true;
  }
  bool Complete(JSContext* cx) override {
    if (failure == Failure::Cancelled) { Cancel(cx); return true; }
    return KandeloFsWork::Complete(cx);
  }
};
static bool KandeloNativeCreateWriteFileJob(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int64_t flags, mode;
  if ((!args.get(0).isObject() && !args.get(0).isNull()) || !args.get(4).isObject() ||
      !JS_IsArrayBufferViewObject(&args[4].toObject()) || !args.get(5).isObject() || !JS::IsCallable(&args[5].toObject())) {
    JS_ReportErrorASCII(cx, "WriteFileJob requires prototype, byte view and callback"); return false;
  }
  if (!KandeloFsInteger(cx, args.get(2), INT32_MIN, INT32_MAX, &flags) ||
      !KandeloFsInteger(cx, args.get(3), 0, UINT32_MAX, &mode)) return false;
  JS::UniqueChars path; size_t length;
  if (!KandeloFsPath(cx, args.get(1), &path, &length)) return false;
  RootedObject prototype(cx, args[0].toObjectOrNull()), owner(cx), view(cx, &args[4].toObject());
  if (!KandeloCreateFsResource(cx, prototype, args[5], FsResourceKind::FileWrite, &owner)) return false;
  auto* state = KandeloFsRequestStateOf(cx, owner); if (!state) return false;
  state->name = std::move(path); state->nameLength = length; state->nameBytes = length + 1;
  state->flags = int(flags); state->fileMode = uint32_t(mode);
  JS::AddAssociatedMemory(owner, state->nameBytes, JS::MemoryUse::Embedding3);
  JS::SetReservedSlot(owner, FsRequestBuffers, ObjectValue(*view));
  if (!KandeloInitializeFsResource(cx, owner)) return false;
  // AsyncWrap init precedes Node's view capture. A resizable view must become
  // owned bytes now, before later shrink/detach can invalidate worker storage.
  if (JS::IsResizableArrayBufferView(view)) {
    const size_t size = JS_GetArrayBufferViewByteLength(view);
    std::vector<uint8_t> copy(size);
    {
      JS::AutoCheckCannotGC nogc; bool shared;
      auto* bytes = static_cast<const uint8_t*>(JS_GetArrayBufferViewData(view, &shared, nogc));
      for (size_t i = 0; i < size; ++i) copy[i] = __atomic_load_n(bytes + i, __ATOMIC_RELAXED);
    }
    RootedObject snapshot(cx, KandeloNewUint8ArrayCopy(cx, copy.data(), copy.size()));
    if (!snapshot) return false;
    JS::SetReservedSlot(owner, FsRequestBuffers, ObjectValue(*snapshot));
  }
  args.rval().setObject(*owner); return true;
}
static bool KandeloNativeRunWriteFileJob(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) { JS_ReportErrorASCII(cx, "Invalid WriteFileJob"); return false; }
  RootedObject owner(cx, &args[0].toObject());
  auto* state = KandeloFsRequestStateOf(cx, owner);
  if (!state || state->kind != FsResourceKind::FileWrite || state->dispatched || state->retired) {
    if (state) JS_ReportErrorASCII(cx, "WriteFileJob already dispatched or retired"); return false;
  }
  auto failed = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(owner); });
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloWriteFileWork>(cx, owner.get(), queue);
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  auto dispose = mozilla::MakeScopeExit([&] { if (work) js_delete(work); });
  RootedObject view(cx, &JS::GetReservedSlot(owner, FsRequestBuffers).toObject());
  work->pin = queue->Pin(cx, view); if (!work->pin) return false;
  work->size = JS_GetArrayBufferViewByteLength(view);
  {
    JS::AutoCheckCannotGC nogc; bool shared;
    work->data = static_cast<char*>(JS_GetArrayBufferViewData(view, &shared, nogc));
  }
  if (work->size && !work->data) { JS_ReportErrorASCII(cx, "WriteFileJob has no live backing data"); return false; }
  state->dispatched = true;
  if (!queue->Submit(work)) { JS_ReportErrorASCII(cx, "WriteFileJob work queue closing"); return false; }
  work = nullptr; failed.release(); args.rval().setUndefined(); return true;
}
}  // namespace
