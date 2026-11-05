/* Real pathname work over guest libc, included after fs-promise.cpp. */
#include "shell/kandelo-node-directory-operations.h"
namespace {
using KandeloPathOperation = kandelo::nodefs::PathOperation;
static const char* KandeloPathSyscall(KandeloPathOperation op) {
  return op == KandeloPathOperation::Mkdtemp ? "mkdtemp" :
      op == KandeloPathOperation::Mkdir ? "mkdir" : op == KandeloPathOperation::Unlink ? "unlink" : "rmdir";
}
static bool KandeloPathArguments(JSContext* cx, const CallArgs& args,
                                KandeloPathOperation* operation, mode_t* mode,
                                bool* recursive) {
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "Path operation requires a name"); return false; }
  RootedString operationName(cx, args[0].toString());
  JS::UniqueChars name = JS_EncodeStringToUTF8(cx, operationName);
  if (!name) return false;
  if (strcmp(name.get(), "mkdir") == 0) *operation = KandeloPathOperation::Mkdir;
  else if (strcmp(name.get(), "unlink") == 0) *operation = KandeloPathOperation::Unlink;
  else if (strcmp(name.get(), "rmdir") == 0) *operation = KandeloPathOperation::Rmdir;
  else if (strcmp(name.get(), "mkdtemp") == 0) *operation = KandeloPathOperation::Mkdtemp;
  else { JS_ReportErrorASCII(cx, "Unknown filesystem path operation"); return false; }
  int64_t number;
  if (!KandeloFsInteger(cx, args.get(2), 0, UINT32_MAX, &number) || !args.get(3).isBoolean()) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Invalid filesystem path options");
    return false;
  }
  *mode = mode_t(number); *recursive = args[3].toBoolean(); return true;
}
struct KandeloDirectoryWork final : KandeloFsWork {
  KandeloPathOperation pathOperation;
  mode_t mode; bool recursive;
  JS::UniqueChars name; size_t nameLength, associated;
  kandelo::nodefs::DirectoryResult outcome;
  bool resultIsException = false;
  KandeloDirectoryWork(JSContext* cx, JSObject* request, KandeloPathOperation op,
                       JS::UniqueChars name, size_t length, mode_t mode, bool recursive)
      : KandeloFsWork(cx, request, -1, 0, Operation::Directory), pathOperation(op),
        mode(mode), recursive(recursive), name(std::move(name)), nameLength(length),
        associated(sizeof(*this) - sizeof(KandeloFsWork) + 2 * (length + 1) +
                   (op == KandeloPathOperation::Mkdtemp ? 12 : 0)) {
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloDirectoryWork() override {
    JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  const char* Syscall() const override { return KandeloPathSyscall(pathOperation); }
  void Run() override {
    outcome = kandelo::nodefs::RunPath(pathOperation, std::string(name.get(), nameLength), mode, recursive, true);
    result = outcome.status; performed = true;
  }
  bool PrepareResult(JSContext* cx) override {
    if (pathOperation != KandeloPathOperation::Mkdtemp) return true;
    // Like AfterStringPath, encode completed native bytes before publishing
    // callback/promise completion. Encoding exceptions reject this request,
    // rather than escaping as a fatal completion-loop error.
    RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx,
        reinterpret_cast<const uint8_t*>(outcome.firstPath.data()), outcome.firstPath.size()));
    RootedValue value(cx), convert(cx, JS::GetReservedSlot(owner, FsRequestBuffers));
    JS::RootedValueArray<1> arguments(cx);
    if (bytes) arguments[0].setObject(*bytes);
    if (!bytes || !JS_CallFunctionValue(cx, nullptr, convert, arguments, &value)) {
      if (!JS_IsExceptionPending(cx) || !JS_GetPendingException(cx, &value)) return false;
      JS_ClearPendingException(cx);
      resultIsException = true;
    }
    JS::SetReservedSlot(owner, FsRequestResult, value);
    return true;
  }
  bool ResultIsException() const override { return resultIsException; }
  bool ResultValue(JSContext* cx, MutableHandleValue value) override {
    if (pathOperation == KandeloPathOperation::Mkdtemp) {
      value.set(JS::GetReservedSlot(owner, FsRequestResult)); return true;
    }
    if (outcome.firstPath.empty()) { value.setUndefined(); return true; }
    return KandeloFsPathString(cx, outcome.firstPath.data(), outcome.firstPath.size(), value);
  }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    if (pathOperation == KandeloPathOperation::Mkdtemp) {
      // Async FSReq errors use libuv's operated-on template, which libc may
      // mutate even on failure. Sync Node instead reports its original input.
      const std::string original = std::string(name.get(), nameLength) + "XXXXXX";
      const auto& path = outcome.firstPath.empty() ? original : outcome.firstPath;
      return KandeloFsPathString(cx, path.data(), path.size(), value);
    }
    return KandeloFsPathString(cx, name.get(), nameLength, value);
  }
};
static bool KandeloFsPathPromise(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); KandeloPathOperation op; mode_t mode; bool recursive;
  if (!KandeloPathArguments(cx, args, &op, &mode, &recursive)) return false;
  JS::UniqueChars name; size_t length;
  if (!KandeloFsPath(cx, args.get(1), &name, &length)) return false;
  if (length >= (SIZE_MAX - sizeof(KandeloDirectoryWork) - 16) / 2) {
    JS_ReportOutOfMemory(cx); return false;
  }
  if (op == KandeloPathOperation::Mkdtemp &&
      (!args.get(5).isObject() || !JS::IsCallable(&args[5].toObject()))) {
    JS_ReportErrorASCII(cx, "Temporary directory requires a path encoder"); return false;
  }
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(4), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  if (op == KandeloPathOperation::Mkdtemp)
    JS::SetReservedSlot(request, FsRequestBuffers, args[5]);
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloDirectoryWork>(cx, request.get(), op, std::move(name), length, mode, recursive);
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  abandon.release();
  if (!KandeloFsDispatchPrepared(cx, request, work, queue)) return false;
  if (promise) args.rval().setObject(*promise); else args.rval().setUndefined(); return true;
}
static bool KandeloFsPathSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); KandeloPathOperation op; mode_t mode; bool recursive;
  if (!KandeloPathArguments(cx, args, &op, &mode, &recursive)) return false;
  JS::UniqueChars name; size_t length;
  if (!KandeloFsPath(cx, args.get(1), &name, &length)) return false;
  const auto outcome = kandelo::nodefs::RunPath(op, std::string(name.get(), length), mode, recursive, false);
  if (outcome.status < 0) { args.rval().setInt32(outcome.status); return true; }
  if (op == KandeloPathOperation::Mkdtemp) {
    RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx,
        reinterpret_cast<const uint8_t*>(outcome.firstPath.data()), outcome.firstPath.size()));
    if (!bytes) return false;
    args.rval().setObject(*bytes); return true;
  }
  if (outcome.firstPath.empty()) { args.rval().setUndefined(); return true; }
  return KandeloFsPathString(cx, outcome.firstPath.data(), outcome.firstPath.size(), args.rval());
}
}  // namespace
