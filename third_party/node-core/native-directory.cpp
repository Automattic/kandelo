/* Real pathname work over guest libc, included after fs-promise.cpp. */
#include "shell/kandelo-node-directory-operations.h"
namespace {
using KandeloPathOperation = kandelo::nodefs::PathOperation;
static const char* KandeloPathSyscall(KandeloPathOperation op) {
  return op == KandeloPathOperation::Mkdir ? "mkdir" : op == KandeloPathOperation::Unlink ? "unlink" : "rmdir";
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
  KandeloDirectoryWork(JSContext* cx, JSObject* request, KandeloPathOperation op,
                       JS::UniqueChars name, size_t length, mode_t mode, bool recursive)
      : KandeloFsWork(cx, request, -1, 0, Operation::Directory), pathOperation(op),
        mode(mode), recursive(recursive), name(std::move(name)), nameLength(length),
        associated(sizeof(*this) - sizeof(KandeloFsWork) + 2 * (length + 1)) {
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
  bool ResultValue(JSContext* cx, MutableHandleValue value) override {
    if (outcome.firstPath.empty()) { value.setUndefined(); return true; }
    return KandeloFsPathString(cx, outcome.firstPath.data(), outcome.firstPath.size(), value);
  }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    return KandeloFsPathString(cx, name.get(), nameLength, value);
  }
};
static bool KandeloFsPathPromise(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); KandeloPathOperation op; mode_t mode; bool recursive;
  if (!KandeloPathArguments(cx, args, &op, &mode, &recursive)) return false;
  JS::UniqueChars name; size_t length;
  if (!KandeloFsPath(cx, args.get(1), &name, &length)) return false;
  if (length >= SIZE_MAX / 2) { JS_ReportOutOfMemory(cx); return false; }
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(4), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
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
  if (outcome.firstPath.empty()) { args.rval().setUndefined(); return true; }
  return KandeloFsPathString(cx, outcome.firstPath.data(), outcome.firstPath.size(), args.rval());
}
}  // namespace
