/* Native pathname file jobs. Included after native-fs-promise.cpp. The read
 * worker owns its path and allocation without any JS memory/data pointers.
 * Source candidate only: native/four-host conformance remains pending.
 */
#include <cstring>
#include "kandelo-node-write-file-operations.h"
#include "kandelo-node-read-file-buffer.h"
namespace {
struct KandeloReadFileWork final : KandeloFsWork {
  const char* path;
  uint64_t limit;
  int flags;
  int handoffFd = -1, closeError = 0;
  uint64_t regularSize = 0;
  std::shared_ptr<kandelo::nodefs::ReadFileBuffer> allocation;
  size_t used = 0, associated;
  const char* failedSyscall = "read";
  KandeloReadFileWork(JSContext* cx, JSObject* request)
      : KandeloFsWork(cx, request, -1, 0, Operation::FileRead),
        path(State()->name.get()), limit(State()->limit), flags(State()->flags),
        allocation(std::make_shared<kandelo::nodefs::ReadFileBuffer>(
            kandelo::nodefs::ReadFileBuffer::Allocator{
                [](size_t size) { return js_malloc(size); },
                [](void* data, size_t size) { return js_realloc(data, size); },
                [](void* data) noexcept { js_free(data); }},
            KandeloNativeMemoryOwner(cx), KandeloBackingAccountOf)),
        associated(sizeof(*this) - sizeof(KandeloFsWork)) {
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloReadFileWork() override {
    allocation.reset();
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
    const size_t initialCapacity = regularSize ? size_t(regularSize) : 64u * 1024;
    // This SDK must represent the actual allocation, independent of the
    // larger integer metadata a stat record may report.
    if (uint64_t(initialCapacity) != (regularSize ? regularSize : uint64_t(64u * 1024))) {
      Fail("read", -ENOMEM); return;
    }
    if (!allocation->Resize(initialCapacity)) { Fail("read", -ENOMEM); return; }
    while (true) {
      if (used == allocation->Capacity()) {
        if (regularSize) break;
        if (allocation->Capacity() > SIZE_MAX / 2) { Fail("read", -ENOMEM); break; }
        if (!allocation->Resize(allocation->Capacity() * 2)) { Fail("read", -ENOMEM); break; }
      }
      const size_t count = std::min(allocation->Capacity() - used, size_t(256u * 1024 * 1024));
      ssize_t bytes; do { bytes = read(opened, allocation->Data() + used, count); } while (bytes < 0 && errno == EINTR);
      if (bytes < 0) { Fail("read", -errno); break; }
      if (bytes == 0) break;
      used += size_t(bytes);
    }
    if (result < 0) { allocation->Clear(); used = 0; }
    else if (allocation->Capacity() - used >= 4096) {
      const size_t smaller = used ? used : 1;
      // A failed optional shrink still succeeds with the actual old capacity.
      (void)allocation->Resize(smaller);
    }
    performed = true;
  }
  bool PrepareResult(JSContext* cx) override {
    // Result views, like Node Buffer::New, exist before MakeCallback's
    // before hook. They are real typed arrays over the owned backing store.
    JS::RootedValueArray<4> fields(cx);
    fields[1].setInt32(handoffFd);
    if (handoffFd >= 0) fields[2].setNumber(double(regularSize));
    else {
      // JS exposes the logical result length; the real allocation capability
      // retains successful malloc/realloc capacity and its exact deallocator.
      // USER_OWNED is native-accounted, so no logical-size engine credit hides
      // slack or duplicates this physical allocation's existing ledger record.
      RootedObject buffer(cx, JS::NewArrayBufferWithUserOwnedContents(cx, used, allocation->Data()));
      if (!buffer || !JS::KandeloBacking::InstallUserOwned(cx, buffer, allocation)) return false;
      allocation.reset(); // Actual engine owner now retains this same allocation.
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
  KandeloReadFileWork* work;
  try { work = js_new<KandeloReadFileWork>(cx, owner.get()); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  catch (const std::exception& error) { JS_ReportErrorUTF8(cx, "ReadFileJob ownership: %s", error.what()); return false; }
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  state->dispatched = true;
  if (!queue->Submit(work)) { js_delete(work); JS_ReportErrorASCII(cx, "ReadFileJob work queue is closing"); return false; }
  failed.release(); args.rval().setUndefined(); return true;
}
struct KandeloWriteFileWork final : KandeloFsWork {
  JS::KandeloBacking::SpanRef backing;
  const char* path;
  int flags;
  mode_t mode;
  const char* data = nullptr;
  size_t size = 0;
  const char* failedSyscall = "write";
  KandeloWriteFileWork(JSContext* cx, JSObject* request)
      : KandeloFsWork(cx, request, -1, 0, Operation::FileRead),
        path(State()->name.get()), flags(State()->flags), mode(mode_t(State()->fileMode)) {
    JS::AddAssociatedMemory(owner, sizeof(*this) - sizeof(KandeloFsWork), JS::MemoryUse::Embedding3);
  }
  ~KandeloWriteFileWork() override {
    ReleaseIo();
    JS::RemoveAssociatedMemory(owner, sizeof(*this) - sizeof(KandeloFsWork), JS::MemoryUse::Embedding3);
  }
  void ReleaseIo() override { backing.reset(); data = nullptr; }
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
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(owner); });
  state->name = std::move(path); state->nameLength = length; state->nameBytes = length + 1;
  state->flags = int(flags); state->fileMode = uint32_t(mode);
  JS::AddAssociatedMemory(owner, state->nameBytes, JS::MemoryUse::Embedding3);
  JS::SetReservedSlot(owner, FsRequestBuffers, ObjectValue(*view));
  if (!KandeloInitializeFsResource(cx, owner)) return false;
  // This API deliberately differs from scalar/vector fs: WriteFileJob's
  // AsyncWrap constructor/init precedes length/backing capture. Preserve it.
  auto backing = JS::KandeloBacking::Acquire(cx, view);
  if (!backing) return false;
  bool shared;
  RootedObject buffer(cx, JS_GetArrayBufferViewBuffer(cx, view, &shared));
  if (!buffer) return false;
  const bool detached = !shared && JS::IsDetachedArrayBufferObject(buffer);
  // V8's IsResizableByUserJavaScript includes RAB and growable SAB. Only
  // these stores are copied, after init, as in the pinned WriteFileJob.
  if (!detached && JS::IsResizableArrayBufferView(view)) {
    const size_t size = backing->Length();
    mozilla::UniquePtr<void, JS::FreePolicy> copy(size ? js_malloc(size) : nullptr);
    if (size && !copy) { JS_ReportOutOfMemory(cx); return false; }
    auto* target = static_cast<uint8_t*>(copy.get());
    if (backing->Shared()) {
      for (size_t i = 0; i < size; ++i)
        target[i] = __atomic_load_n(backing->Data() + i, __ATOMIC_RELAXED);
    } else if (size) std::memcpy(target, backing->Data(), size);
    auto allocation = JS::KandeloBacking::Prepare(target, size,
        [](void* data, size_t, void*) noexcept { js_free(data); }, nullptr);
    if (!allocation) { JS_ReportErrorASCII(cx, "Native write-file allocation ownership unavailable"); return false; }
    allocation->Commit(); copy.release();
    backing = allocation->Capture(0, size, JS::KandeloBacking::ResolveAccount(cx));
    // Node's resizable-copy branch owns native bytes, not a JS snapshot/view.
    JS::SetReservedSlot(owner, FsRequestBuffers, UndefinedValue());
  }
  state->ioBacking = std::move(backing);
  abandon.release();
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
  auto* work = js_new<KandeloWriteFileWork>(cx, owner.get());
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  auto dispose = mozilla::MakeScopeExit([&] { if (work) js_delete(work); });
  work->backing = std::move(state->ioBacking);
  if (!work->backing) { JS_ReportErrorASCII(cx, "WriteFileJob has no captured allocation"); return false; }
  work->size = work->backing->Length();
  work->data = reinterpret_cast<char*>(work->backing->Data());
  state->dispatched = true;
  if (!queue->Submit(work)) { JS_ReportErrorASCII(cx, "WriteFileJob work queue closing"); return false; }
  work = nullptr; failed.release(); args.rval().setUndefined(); return true;
}
}  // namespace
