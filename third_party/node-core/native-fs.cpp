/* Native guest filesystem requests for the Node compatibility embedding.
 * Uses existing libc/kernel descriptors and the shared guest work pool.
 * Included after native-async.cpp and codec-handle.cpp. Source candidate only.
 */
#include "kandelo-node-dir-cursor.h"
#include "kandelo-node-kdf-operations.h"
namespace {
enum FsRequestSlot { FsRequestState, FsRequestFrame, FsRequestCallback,
                     FsRequestParent, FsRequestPromise, FsRequestBuffers, FsRequestResult, FsRequestSlots };
enum class FsResourceKind { Callback, Promise, FileHandle, FileHandleClose, FileRead, FileWrite, Random, Directory, Pbkdf2, Scrypt, Argon2, Hkdf };
static int KandeloFsDoClose(int fd) {
  int result = close(fd);
  // libuv treats EINTR/EINPROGRESS as an in-progress close and never retries
  // a descriptor number that the OS may already have released for reuse.
  return result == 0 || errno == EINTR || errno == EINPROGRESS ? 0 : -errno;
}
struct KandeloFsRequestState {
  js::shell::KandeloNativeAsyncState* lifetime = nullptr;
  double id = -1, trigger = -1;
  bool dispatched = false, retired = false, closing = false;
  FsResourceKind kind = FsResourceKind::Callback;
  int fd = -1;
  int flags = 0; uint32_t fileMode = 0; uint64_t limit = 0;
  js::shell::KandeloNativeWork* work = nullptr;
  JS::UniqueChars name;
  size_t nameLength = 0, nameBytes = 0;
  std::shared_ptr<kandelo::nodefs::DirectoryCursor> directory;
  size_t directoryBytes = 0;
  std::unique_ptr<kandelo::crypto::KdfOperation> kdf;
  size_t kdfBytes = 0;
  void Retire() {
    if (!retired && lifetime && id >= 0) { retired = true; lifetime->Finalized(id); }
  }
  ~KandeloFsRequestState() {
    if (kind == FsResourceKind::Directory && directory && directory->IsOpen()) {
      const int status = directory->Close();
      if (lifetime) lifetime->FsGcClosed(-1, status, nullptr, 0, true);
    }
    if (kind == FsResourceKind::FileHandle && fd >= 0) {
      // Node closes an abandoned handle synchronously during GC, then defers
      // its fatal diagnostic to an immediate; never call JS from a finalizer.
      const int oldFd = fd; fd = -1;
      const int status = KandeloFsDoClose(oldFd);
      if (lifetime) lifetime->FsGcClosed(oldFd, status, std::move(name), nameLength);
    }
    Retire(); if (lifetime) lifetime->Release();
  }
};
static void KandeloFsRequestFinalize(JS::GCContext*, JSObject* object) {
  Value slot = JS::GetReservedSlot(object, FsRequestState);
  if (!slot.isUndefined()) {
    auto* state = static_cast<KandeloFsRequestState*>(slot.toPrivate());
    JS::RemoveAssociatedMemory(object, sizeof(KandeloFsRequestState) + state->nameBytes + state->directoryBytes + state->kdfBytes,
                               JS::MemoryUse::Embedding3);
    js_delete(state);
  }
}
static const JSClassOps KandeloFsRequestClassOps = {
    nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
    KandeloFsRequestFinalize, nullptr, nullptr, nullptr};
static const JSClass KandeloFsRequestClass = {
    "KandeloNodeFSResource", JSCLASS_HAS_RESERVED_SLOTS(FsRequestSlots) |
    JSCLASS_FOREGROUND_FINALIZE, &KandeloFsRequestClassOps};
static const JSClass KandeloRandomRequestClass = {
    "RandomBytesJob", JSCLASS_HAS_RESERVED_SLOTS(FsRequestSlots) |
    JSCLASS_FOREGROUND_FINALIZE, &KandeloFsRequestClassOps};
static const JSClass KandeloPbkdf2RequestClass = {
    "PBKDF2Job", JSCLASS_HAS_RESERVED_SLOTS(FsRequestSlots) |
    JSCLASS_FOREGROUND_FINALIZE, &KandeloFsRequestClassOps};
static const JSClass KandeloScryptRequestClass = {
    "ScryptJob", JSCLASS_HAS_RESERVED_SLOTS(FsRequestSlots) |
    JSCLASS_FOREGROUND_FINALIZE, &KandeloFsRequestClassOps};
static const JSClass KandeloArgon2RequestClass = {
    "Argon2Job", JSCLASS_HAS_RESERVED_SLOTS(FsRequestSlots) |
    JSCLASS_FOREGROUND_FINALIZE, &KandeloFsRequestClassOps};
static const JSClass KandeloHkdfRequestClass = {
    "HKDFJob", JSCLASS_HAS_RESERVED_SLOTS(FsRequestSlots) |
    JSCLASS_FOREGROUND_FINALIZE, &KandeloFsRequestClassOps};
static KandeloFsRequestState* KandeloFsRequestStateOf(JSContext* cx, HandleObject owner) {
  if ((JS::GetClass(owner) != &KandeloFsRequestClass && JS::GetClass(owner) != &KandeloRandomRequestClass &&
       JS::GetClass(owner) != &KandeloPbkdf2RequestClass && JS::GetClass(owner) != &KandeloScryptRequestClass &&
       JS::GetClass(owner) != &KandeloArgon2RequestClass && JS::GetClass(owner) != &KandeloHkdfRequestClass) ||
      JS::GetReservedSlot(owner, FsRequestState).isUndefined()) {
    JS_ReportErrorASCII(cx, "Invalid native filesystem request"); return nullptr;
  }
  return static_cast<KandeloFsRequestState*>(JS::GetReservedSlot(owner, FsRequestState).toPrivate());
}
static bool KandeloFsRequestResourceInfo(JSContext* cx, HandleObject owner, MutableHandleValue result) {
  auto* state = KandeloFsRequestStateOf(cx, owner);
  if (!state || state->id < 0) { if (state) JS_ReportErrorASCII(cx, "Uninitialized filesystem request identity"); return false; }
  JS::RootedValueArray<4> entries(cx);
  entries[0].setNumber(state->id); entries[1].setNumber(state->trigger);
  entries[2].set(JS::GetReservedSlot(owner, FsRequestFrame));
  const char* provider = state->kind == FsResourceKind::Hkdf ? "DERIVEBITSREQUEST" : state->kind == FsResourceKind::Argon2 ? "ARGON2REQUEST" : state->kind == FsResourceKind::Pbkdf2 ? "PBKDF2REQUEST" :
      state->kind == FsResourceKind::Scrypt ? "SCRYPTREQUEST" : state->kind == FsResourceKind::Directory ? "DIRHANDLE" :
      state->kind == FsResourceKind::Random ? "RANDOMBYTESREQUEST" : (state->kind == FsResourceKind::Callback || state->kind == FsResourceKind::FileRead || state->kind == FsResourceKind::FileWrite) ? "FSREQCALLBACK" :
      state->kind == FsResourceKind::Promise ? "FSREQPROMISE" :
      state->kind == FsResourceKind::FileHandle ? "FILEHANDLE" : "FILEHANDLECLOSEREQ";
  RootedString type(cx, JS_NewStringCopyZ(cx, provider));
  if (!type) return false;
  entries[3].setString(type);
  for (size_t i = 0; i < 4; ++i) if (!JS_WrapValue(cx, entries[i])) return false;
  RootedObject array(cx, JS::NewArrayObject(cx, entries));
  if (!array) return false;
  result.setObject(*array); return true;
}
static bool KandeloCreateFsResource(JSContext* cx, HandleObject prototype,
                                    HandleValue callback, FsResourceKind kind,
                                    MutableHandleObject result) {
  const JSClass* klass = kind == FsResourceKind::Hkdf ? &KandeloHkdfRequestClass : kind == FsResourceKind::Argon2 ? &KandeloArgon2RequestClass : kind == FsResourceKind::Pbkdf2 ? &KandeloPbkdf2RequestClass :
      kind == FsResourceKind::Scrypt ? &KandeloScryptRequestClass :
      kind == FsResourceKind::Random ? &KandeloRandomRequestClass : &KandeloFsRequestClass;
  RootedObject owner(cx, JS_NewObjectWithGivenProto(cx, klass, prototype));
  if (!owner) return false;
  auto* state = js_new<KandeloFsRequestState>();
  if (!state) { JS_ReportOutOfMemory(cx); return false; }
  JS::SetReservedSlot(owner, FsRequestState, PrivateValue(state));
  JS::AddAssociatedMemory(owner, sizeof(KandeloFsRequestState), JS::MemoryUse::Embedding3);
  state->kind = kind;
  JS::SetReservedSlot(owner, FsRequestCallback, callback);
  result.set(owner); return true;
}
static bool KandeloInitializeFsResource(JSContext* cx, HandleObject owner) {
  RootedValue frame(cx), trigger(cx);
  if (!cx->kandeloAsyncProperty("frame", &frame) ||
      !cx->kandeloAsyncProperty("id", &trigger)) return false;
  auto* state = KandeloFsRequestStateOf(cx, owner);
  if (!state) return false;
  auto* lifetime = js::shell::KandeloGetNativeAsyncState(cx);
  if (!lifetime) return false;
  lifetime->Retain(); state->lifetime = lifetime;
  state->id = cx->allocateKandeloAsyncId(); state->trigger = trigger.isNumber() ? trigger.toNumber() : 0;
  JS::SetReservedSlot(owner, FsRequestFrame, frame);
  return cx->notifyKandeloAsyncLifecycle("native:init", owner, frame);
}
static bool KandeloNativeCreateFsRequest(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if ((!args.get(0).isObject() && !args.get(0).isNull()) ||
      !args.get(1).isObject() || !JS::IsCallable(&args[1].toObject())) {
    JS_ReportErrorASCII(cx, "Filesystem request requires prototype and completion callback"); return false;
  }
  RootedObject prototype(cx, args[0].toObjectOrNull()), owner(cx);
  if (!KandeloCreateFsResource(cx, prototype, args[1], FsResourceKind::Callback, &owner)) return false;
  if (!KandeloInitializeFsResource(cx, owner)) return false;
  args.rval().setObject(*owner); return true;
}
static int KandeloFsDoTruncate(int fd, off_t length) {
  // Match libuv's retry of ftruncate on EINTR; unlike close, retry cannot
  // accidentally act on a descriptor released by the interrupted operation.
  int result;
  do { result = ftruncate(fd, length); } while (result == -1 && errno == EINTR);
  return result == 0 ? 0 : -errno;
}
struct KandeloFsWork : js::shell::KandeloNativeWork {
  JS::PersistentRootedObject owner;
  enum class Operation { Truncate, Close, CloseHandle, Read, Write, Stat, Control, Open, FileRead, Directory };
  int fd; off_t length; int64_t result = 0;
  Operation operation;
  bool performed = false;
  KandeloFsWork(JSContext* cx, JSObject* request, int fd, off_t length,
                Operation operation = Operation::Truncate)
      : owner(cx, request), fd(fd), length(length), operation(operation) {
    workClass = WorkClass::FastIo;
    JS::AddAssociatedMemory(owner, sizeof(KandeloFsWork), JS::MemoryUse::Embedding3);
    State()->work = this;
  }
  ~KandeloFsWork() override {
    if (State()->work == this) State()->work = nullptr;
    JS::RemoveAssociatedMemory(owner, sizeof(KandeloFsWork), JS::MemoryUse::Embedding3);
  }
  KandeloFsRequestState* State() {
    return static_cast<KandeloFsRequestState*>(JS::GetReservedSlot(owner, FsRequestState).toPrivate());
  }
  void Run() override {
    result = operation == Operation::Truncate ? KandeloFsDoTruncate(fd, length) : KandeloFsDoClose(fd);
    performed = true;
  }
  virtual void ReleaseIo() {}
  virtual bool Succeeded() const { return result >= 0; }
  virtual bool ErrorPathValue(JSContext*, MutableHandleValue value) {
    value.setUndefined(); return true;
  }
  virtual bool ErrorDestValue(JSContext*, MutableHandleValue value) {
    value.setUndefined(); return true;
  }
  virtual bool PrepareResult(JSContext*) { return true; }
  virtual bool ResultIsException() const { return false; }
  virtual const char* Syscall() const {
    return operation == Operation::Truncate ? "ftruncate" : "close";
  }
  virtual bool ResultValue(JSContext*, MutableHandleValue value) {
    if (operation == Operation::Read || operation == Operation::Write) value.setNumber(double(result));
    else value.setUndefined();
    return true;
  }
  void FinishHandleClose() {
    if (operation != Operation::CloseHandle) return;
    JSObject* parent = &JS::GetReservedSlot(owner, FsRequestParent).toObject();
    auto* state = static_cast<KandeloFsRequestState*>(JS::GetReservedSlot(parent, FsRequestState).toPrivate());
    if (performed) state->fd = -1;
    state->closing = false;
    if (!performed) JS::SetReservedSlot(parent, FsRequestPromise, UndefinedValue());
  }
  bool Complete(JSContext* cx) override {
    RootedObject resource(cx, owner);
    JSAutoRealm realm(cx, resource);
    ReleaseIo();
    FinishHandleClose();
    auto* state = State();
    // The actual request retires after its completion even when an init hook
    // retains the JS object or the callback throws. GC is a fallback only for
    // a request that never submitted; no JS hooks run during finalization.
    auto retire = mozilla::MakeScopeExit([&] {
      state->Retire();
      JS::SetReservedSlot(resource, FsRequestCallback, UndefinedValue());
      JS::SetReservedSlot(resource, FsRequestFrame, UndefinedValue());
      JS::SetReservedSlot(resource, FsRequestParent, UndefinedValue());
      JS::SetReservedSlot(resource, FsRequestPromise, UndefinedValue());
      JS::SetReservedSlot(resource, FsRequestBuffers, UndefinedValue());
      JS::SetReservedSlot(resource, FsRequestResult, UndefinedValue());
    });
    if (failure != Failure::None) result = failure == Failure::OutOfMemory ? -ENOMEM :
        failure == Failure::Cancelled ? -ECANCELED : -EIO;
    // AfterOpenFileHandle constructs the real native owner before entering
    // FSReqPromise's callback scope. Preserve that init/trigger/frame order.
    const bool succeeded = Succeeded();
    if (succeeded && !PrepareResult(cx)) return false;
    RootedValue frame(cx, JS::GetReservedSlot(resource, FsRequestFrame));
    RootedValue callback(cx, JS::GetReservedSlot(resource, FsRequestCallback)), ignored(cx);
    JS::RootedValueArray<5> arguments(cx); arguments[0].setNumber(succeeded ? 0 : double(result));
    RootedString syscall(cx, JS_NewStringCopyZ(cx, Syscall()));
    if (!syscall) return false;
    arguments[1].setString(syscall);
    if (!succeeded && !ErrorPathValue(cx, arguments[3])) return false;
    if (!succeeded && !ErrorDestValue(cx, arguments[4])) return false;
    KandeloNativeCallbackScope scope(cx, resource, frame);
    if (!scope.Enter()) return scope.Stopped();
    if (ResultIsException()) {
      RootedValue exception(cx);
      if (!ResultValue(cx, &exception)) return false;
      if (state->kind == FsResourceKind::Promise) {
        RootedObject promise(cx, &JS::GetReservedSlot(resource, FsRequestPromise).toObject());
        if (!JS::RejectPromise(cx, promise, exception)) return false;
      } else {
        // FSReqCallback::Reject receives the actual conversion exception,
        // rather than an invented errno or a fatal completion-loop error.
        RootedValue oncomplete(cx);
        JS::RootedValueArray<1> rejected(cx); rejected[0].set(exception);
        if (!JS_GetProperty(cx, resource, "oncomplete", &oncomplete) ||
            !JS_CallFunctionValue(cx, resource, oncomplete, rejected, &ignored)) return false;
      }
    } else if (operation == Operation::CloseHandle || state->kind == FsResourceKind::Promise) {
      RootedObject promise(cx, &JS::GetReservedSlot(resource, FsRequestPromise).toObject());
      if (!succeeded) {
        RootedObject parent(cx, state->kind == FsResourceKind::Promise ? resource.get() :
                            &JS::GetReservedSlot(resource, FsRequestParent).toObject());
        RootedValue makeError(cx, JS::GetReservedSlot(parent, FsRequestCallback));
        RootedValue error(cx);
        JS::RootedValueArray<4> errorArguments(cx);
        errorArguments[0].set(arguments[0]); errorArguments[1].set(arguments[1]); errorArguments[2].set(arguments[3]);
        errorArguments[3].set(arguments[4]);
        if (!JS_CallFunctionValue(cx, parent, makeError, errorArguments, &error) ||
            !JS::RejectPromise(cx, promise, error)) return false;
      } else {
        RootedValue value(cx);
        if (!ResultValue(cx, &value) || !JS::ResolvePromise(cx, promise, value)) return false;
      }
    } else {
      if (succeeded && !ResultValue(cx, arguments[2])) return false;
      if (!JS_CallFunctionValue(cx, resource, callback, arguments, &ignored)) return false;
    }
    return scope.Close();
  }
  void Cancel(JSContext*) override {
    ReleaseIo();
    FinishHandleClose();
    State()->Retire();
    JS::SetReservedSlot(owner, FsRequestCallback, UndefinedValue());
    JS::SetReservedSlot(owner, FsRequestFrame, UndefinedValue());
    JS::SetReservedSlot(owner, FsRequestParent, UndefinedValue());
    JS::SetReservedSlot(owner, FsRequestPromise, UndefinedValue());
    JS::SetReservedSlot(owner, FsRequestBuffers, UndefinedValue());
    JS::SetReservedSlot(owner, FsRequestResult, UndefinedValue());
  }
};
static bool KandeloSubmitFsWork(JSContext* cx, HandleObject owner,
                                int fd, off_t length, KandeloFsWork::Operation operation) {
  auto* state = KandeloFsRequestStateOf(cx, owner);
  if (!state || (state->kind != FsResourceKind::Callback && state->kind != FsResourceKind::FileHandleClose) || state->dispatched || state->retired) {
    if (state) JS_ReportErrorASCII(cx, "Filesystem request cannot be dispatched");
    return false;
  }
  // An init hook can retain the object after queue/worker allocation fails.
  // Retire failed handoffs now instead of retaining their native context
  // indefinitely merely because that JS reference keeps the object alive.
  auto failedHandoff = mozilla::MakeScopeExit([&] {
    state->Retire();
    JS::SetReservedSlot(owner, FsRequestCallback, UndefinedValue());
    JS::SetReservedSlot(owner, FsRequestFrame, UndefinedValue());
    JS::SetReservedSlot(owner, FsRequestParent, UndefinedValue());
    JS::SetReservedSlot(owner, FsRequestPromise, UndefinedValue());
    JS::SetReservedSlot(owner, FsRequestBuffers, UndefinedValue());
    JS::SetReservedSlot(owner, FsRequestResult, UndefinedValue());
  });
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx);
  if (!queue) return false;
  auto* work = js_new<KandeloFsWork>(cx, owner.get(), fd, length, operation);
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  state->dispatched = true;
  if (!queue->Submit(work)) {
    js_delete(work);
    JS_ReportErrorASCII(cx, "Native filesystem work queue is closing"); return false;
  }
  failedHandoff.release();
  return true;
}
static bool KandeloNativeCancelFsRequest(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) { JS_ReportErrorASCII(cx, "Invalid filesystem request"); return false; }
  RootedObject request(cx, &args[0].toObject());
  auto* state = KandeloFsRequestStateOf(cx, request); if (!state) return false;
  if (state->kind != FsResourceKind::Callback) {
    JS_ReportErrorASCII(cx, "Cannot cancel this filesystem resource"); return false;
  }
  if (!state->retired && state->work && state->work->queue)
    state->work->queue->TryCancel(state->work);
  // The pinned CancelFSReq ignores uv_cancel's busy/idle result. A job
  // already running/completed retains ownership until actual completion.
  args.rval().setUndefined(); return true;
}
static bool KandeloNativeFtruncate(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isNumber() || !args.get(1).isNumber()) {
    JS_ReportErrorASCII(cx, "ftruncate requires numeric descriptor and length"); return false;
  }
  double fd = args[0].toNumber(), length = args[1].toNumber();
  if (!std::isfinite(fd) || std::floor(fd) != fd || fd < 0 || fd > INT32_MAX ||
      !std::isfinite(length) || std::floor(length) != length || length < 0 || length > 9007199254740991.0 ||
      length > double(std::numeric_limits<off_t>::max())) {
    JS_ReportErrorASCII(cx, "ftruncate arguments are out of range"); return false;
  }
  if (args.get(2).isUndefined()) {
    args.rval().setInt32(KandeloFsDoTruncate(int(fd), off_t(length))); return true;
  }
  if (!args[2].isObject()) { JS_ReportErrorASCII(cx, "Invalid filesystem request"); return false; }
  RootedObject owner(cx, &args[2].toObject());
  auto* state = KandeloFsRequestStateOf(cx, owner);
  if (!state) return false;
  if (state->kind != FsResourceKind::Callback || state->dispatched || state->retired || state->id < 0) {
    JS_ReportErrorASCII(cx, "Filesystem request is not idle"); return false;
  }
  if (!KandeloSubmitFsWork(cx, owner, int(fd), off_t(length), KandeloFsWork::Operation::Truncate)) return false;
  args.rval().setUndefined(); return true;
}
static bool KandeloNativeCloseDescriptor(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isNumber() || !std::isfinite(args[0].toNumber()) ||
      std::floor(args[0].toNumber()) != args[0].toNumber() ||
      args[0].toNumber() < 0 || args[0].toNumber() > INT32_MAX) {
    JS_ReportErrorASCII(cx, "close requires a nonnegative integer descriptor"); return false;
  }
  const int fd = int(args[0].toNumber());
  if (args.get(1).isUndefined()) { args.rval().setInt32(KandeloFsDoClose(fd)); return true; }
  if (!args[1].isObject()) { JS_ReportErrorASCII(cx, "Invalid filesystem close request"); return false; }
  RootedObject owner(cx, &args[1].toObject());
  auto* state = KandeloFsRequestStateOf(cx, owner);
  if (!state || state->kind != FsResourceKind::Callback) {
    if (state) JS_ReportErrorASCII(cx, "Descriptor close requires a callback request"); return false;
  }
  if (!KandeloSubmitFsWork(cx, owner, fd, 0, KandeloFsWork::Operation::Close)) return false;
  args.rval().setUndefined(); return true;
}
}  // namespace
