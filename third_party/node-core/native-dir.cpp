/* Persistent DIRHANDLE owners and actual native filesystem work. Included
 * after native-readdir.cpp; only completion enters the owning JS realm. */
#include "kandelo-node-dir-cursor.h"
namespace {
using KandeloDirectoryCursor = kandelo::nodefs::DirectoryCursor;
static bool KandeloAdoptDirectory(JSContext* cx, HandleObject prototype,
    const std::shared_ptr<KandeloDirectoryCursor>& cursor, MutableHandleObject output) {
  RootedValue callback(cx);
  RootedObject owner(cx);
  if (!KandeloCreateFsResource(cx, prototype, callback, FsResourceKind::Directory, &owner)) return false;
  auto* state = KandeloFsRequestStateOf(cx, owner); if (!state) return false;
  state->directory = cursor; state->directoryBytes = sizeof(KandeloDirectoryCursor);
  JS::AddAssociatedMemory(owner, state->directoryBytes, JS::MemoryUse::Embedding3);
  if (!KandeloInitializeFsResource(cx, owner)) return false;
  output.set(owner); return true;
}
static bool KandeloDirBatchValue(JSContext* cx, const kandelo::nodefs::DirectoryBatch& batch,
                                 MutableHandleValue value) {
  if (batch.status < 0) { value.setInt32(batch.status); return true; }
  if (batch.entries.empty()) { value.setNull(); return true; }
  if (batch.entries.size() > UINT32_MAX / 2) { JS_ReportOutOfMemory(cx); return false; }
  RootedObject entries(cx, JS::NewArrayObject(cx, batch.entries.size() * 2));
  if (!entries) return false;
  uint32_t index = 0;
  for (const auto& entry : batch.entries) {
    RootedValue name(cx), type(cx, Int32Value(int(entry.type)));
    if (!KandeloReaddirBytes(cx, entry.name, &name) ||
        !JS_DefineElement(cx, entries, index++, name, JSPROP_ENUMERATE) ||
        !JS_DefineElement(cx, entries, index++, type, JSPROP_ENUMERATE)) return false;
  }
  value.setObject(*entries); return true;
}
struct KandeloDirWork final : KandeloFsWork {
  enum class Action { Open, Read, Close };
  Action action;
  std::shared_ptr<KandeloDirectoryCursor> cursor;
  std::string path;
  kandelo::nodefs::DirectoryBatch batch;
  uint32_t maximum;
  bool reserved = false, exception = false, rejected = false;
  size_t associated;
  KandeloDirWork(JSContext* cx, JSObject* request, Action action,
      std::shared_ptr<KandeloDirectoryCursor> cursor, std::string path, uint32_t maximum)
      : KandeloFsWork(cx, request, -1, 0, Operation::Directory), action(action),
        cursor(std::move(cursor)), path(std::move(path)), maximum(maximum),
        associated(sizeof(*this) - sizeof(KandeloFsWork) + this->path.capacity() + 1) {
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloDirWork() override {
    ReleaseIo();
    JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  const char* Syscall() const override {
    return action == Action::Open ? "opendir" : action == Action::Read ? "readdir" : "closedir";
  }
  void Run() override {
    if (rejected) return;  // Reservation failure completes without touching DIR*.
    if (action == Action::Open) { int status; cursor = KandeloDirectoryCursor::Open(path, &status); result = status; }
    else if (action == Action::Read) { batch = cursor->ReadReserved(maximum); result = batch.status; }
    else result = cursor->CloseReserved();
    performed = true;
  }
  void ReleaseIo() override { if (reserved) { cursor->Release(); reserved = false; } }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    if (action != Action::Open) { value.setUndefined(); return true; }
    return KandeloFsPathString(cx, path.data(), path.size(), value);
  }
  bool PrepareResult(JSContext* cx) override {
    if (action == Action::Open) {
      RootedObject prototype(cx, &JS::GetReservedSlot(owner, FsRequestParent).toObject()), directory(cx);
      if (!KandeloAdoptDirectory(cx, prototype, cursor, &directory)) return false;
      JS::SetReservedSlot(owner, FsRequestResult, ObjectValue(*directory)); return true;
    }
    if (action == Action::Close) return true;
    if (batch.entries.capacity() > SIZE_MAX / sizeof(kandelo::nodefs::ReadEntry)) {
      JS_ReportOutOfMemory(cx); return false;
    }
    size_t bytes = batch.entries.capacity() * sizeof(kandelo::nodefs::ReadEntry);
    for (const auto& entry : batch.entries) {
      if (entry.name.capacity() >= SIZE_MAX - bytes) { JS_ReportOutOfMemory(cx); return false; }
      bytes += entry.name.capacity() + 1;
    }
    if (bytes > SIZE_MAX - associated) { JS_ReportOutOfMemory(cx); return false; }
    JS::AddAssociatedMemory(owner, bytes, JS::MemoryUse::Embedding3); associated += bytes;
    RootedValue packet(cx), value(cx), convert(cx, JS::GetReservedSlot(owner, FsRequestBuffers));
    if (!KandeloDirBatchValue(cx, batch, &packet)) return false;
    if (!KandeloReaddirConvert(cx, convert, packet, &value)) {
      if (!JS_IsExceptionPending(cx) || !JS_GetPendingException(cx, &value)) return false;
      JS_ClearPendingException(cx); exception = true;
    }
    JS::SetReservedSlot(owner, FsRequestResult, value); return true;
  }
  bool ResultIsException() const override { return exception; }
  bool ResultValue(JSContext*, MutableHandleValue value) override {
    value.set(JS::GetReservedSlot(owner, FsRequestResult)); return true;
  }
};
static bool KandeloDirOwner(JSContext* cx, HandleValue value, MutableHandleObject object,
                            std::shared_ptr<KandeloDirectoryCursor>* cursor) {
  if (!value.isObject()) { JS_ReportErrorASCII(cx, "Invalid directory handle"); return false; }
  object.set(js::CheckedUnwrapDynamic(&value.toObject(), cx));
  if (!object) return false;
  auto* state = KandeloFsRequestStateOf(cx, object);
  if (!state) return false;
  if (state->kind != FsResourceKind::Directory || !state->directory) {
    JS_ReportErrorASCII(cx, "Resource is not a directory handle"); return false;
  }
  *cursor = state->directory; return true;
}
static bool KandeloDirDispatch(JSContext* cx, const CallArgs& args) {
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "Directory operation requires a name"); return false; }
  RootedString operationName(cx, args[0].toString());
  JS::UniqueChars operation = JS_EncodeStringToUTF8(cx, operationName); if (!operation) return false;
  const bool opening = !strcmp(operation.get(), "open"), reading = !strcmp(operation.get(), "read");
  if (!opening && !reading && strcmp(operation.get(), "close")) {
    JS_ReportErrorASCII(cx, "Unknown directory operation"); return false;
  }
  RootedObject parent(cx);
  std::shared_ptr<KandeloDirectoryCursor> cursor;
  std::string path;
  uint32_t maximum = 0;
  if (opening) {
    if (!args.get(2).isObject()) { JS_ReportErrorASCII(cx, "Directory prototype must be an object"); return false; }
    parent = &args[2].toObject();
    JS::UniqueChars name; size_t length;
    if (!KandeloFsPath(cx, args.get(1), &name, &length)) return false;
    path.assign(name.get(), length);
  } else {
    if (!KandeloDirOwner(cx, args.get(1), &parent, &cursor)) return false;
    if (reading) {
      int64_t length;
      if (!KandeloFsInteger(cx, args.get(2), 1, UINT32_MAX, &length)) return false;
      maximum = uint32_t(length);
      if (!args.get(4).isObject() || !JS::IsCallable(&args[4].toObject())) {
        JS_ReportErrorASCII(cx, "Directory read requires a private encoder"); return false;
      }
    }
  }
  const unsigned requestIndex = opening || reading ? 3 : 2;
  if (args.get(requestIndex).isUndefined()) {
    if (opening) {
      int status; cursor = KandeloDirectoryCursor::Open(path, &status);
      if (status < 0) { args.rval().setInt32(status); return true; }
      RootedObject directory(cx);
      if (!KandeloAdoptDirectory(cx, parent, cursor, &directory)) return false;
      args.rval().setObject(*directory); return true;
    }
    if (!reading) {
      const int status = cursor->Close();
      if (status < 0) args.rval().setInt32(status); else args.rval().setUndefined();
      return true;
    }
    const auto batch = cursor->Read(maximum);
    RootedValue packet(cx);
    return KandeloDirBatchValue(cx, batch, &packet) &&
        KandeloReaddirConvert(cx, args.get(4), packet, args.rval());
  }
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(requestIndex), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  JS::SetReservedSlot(request, FsRequestParent, ObjectValue(*parent));
  if (reading) JS::SetReservedSlot(request, FsRequestBuffers, args[4]);
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloDirWork>(cx, request.get(), opening ? KandeloDirWork::Action::Open :
      reading ? KandeloDirWork::Action::Read : KandeloDirWork::Action::Close, cursor, std::move(path), maximum);
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  auto dispose = mozilla::MakeScopeExit([&] { if (work) js_delete(work); });
  if (!opening) {
    const int status = cursor->Reserve();
    if (status < 0) {
      // Keep the real failed request lifecycle and asynchronous completion.
      work->result = status;
      work->rejected = true;
    } else work->reserved = true;
  }
  // The normal shared dispatcher owns retirement, cancellation and ref state.
  auto* submitted = work; work = nullptr; abandon.release(); dispose.release();
  if (!KandeloFsDispatchPrepared(cx, request, submitted, queue)) return false;
  if (promise) args.rval().setObject(*promise); else args.rval().setUndefined();
  return true;
}
static bool KandeloNativeDirOperation(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  try { return KandeloDirDispatch(cx, args); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
}  // namespace
