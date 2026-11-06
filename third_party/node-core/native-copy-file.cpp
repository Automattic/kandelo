/* Actual descriptor copying on the shared FSReq/native work owners.
 * Included after native-fs-promise.cpp; worker code never enters JS.
 */
#include "kandelo-node-copy-file-operations.h"
namespace {
struct KandeloCopyFileWork final : KandeloFsWork {
  JS::UniqueChars source, destination;
  size_t sourceLength, destinationLength, associated;
  int flags;
  KandeloCopyFileWork(JSContext* cx, JSObject* request, JS::UniqueChars source,
                      size_t sourceLength, JS::UniqueChars destination,
                      size_t destinationLength, int flags)
      : KandeloFsWork(cx, request, -1, 0, Operation::FileRead),
        source(std::move(source)), destination(std::move(destination)),
        sourceLength(sourceLength), destinationLength(destinationLength),
        associated(sizeof(*this) - sizeof(KandeloFsWork) + sourceLength + destinationLength + 2), flags(flags) {
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloCopyFileWork() override { JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3); }
  const char* Syscall() const override { return "copyfile"; }
  void Run() override {
    result = kandelo::nodefs::CopyPathFile(source.get(), destination.get(), flags);
    performed = true;
  }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx,
        reinterpret_cast<const uint8_t*>(source.get()), sourceLength));
    if (!bytes) return false;
    value.setObject(*bytes); return true;
  }
  bool ErrorDestValue(JSContext* cx, MutableHandleValue value) override {
    RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx,
        reinterpret_cast<const uint8_t*>(destination.get()), destinationLength));
    if (!bytes) return false;
    value.setObject(*bytes); return true;
  }
};
static bool KandeloCopyFileArguments(JSContext* cx, const CallArgs& args,
                                    JS::UniqueChars* source, size_t* sourceLength,
                                    JS::UniqueChars* destination, size_t* destinationLength,
                                    int* flags) {
  int64_t mode;
  if (!KandeloFsInteger(cx, args.get(2), 0, 7, &mode) ||
      !KandeloFsPath(cx, args.get(0), source, sourceLength) ||
      !KandeloFsPath(cx, args.get(1), destination, destinationLength)) return false;
  if (*sourceLength > SIZE_MAX - sizeof(KandeloCopyFileWork) - 2 ||
      *destinationLength > SIZE_MAX - sizeof(KandeloCopyFileWork) - *sourceLength - 2) {
    JS_ReportOutOfMemory(cx); return false;
  }
  *flags = int(mode); return true;
}
static bool KandeloFsCopyFileSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  JS::UniqueChars source, destination; size_t sourceLength, destinationLength; int flags;
  if (!KandeloCopyFileArguments(cx, args, &source, &sourceLength, &destination, &destinationLength, &flags)) return false;
  args.rval().setInt32(kandelo::nodefs::CopyPathFile(source.get(), destination.get(), flags)); return true;
}
static bool KandeloFsCopyFile(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  JS::UniqueChars source, destination; size_t sourceLength, destinationLength; int flags;
  // Callback init has already run. Promise init happens only after both
  // pathname byte snapshots belong to the real native operation below.
  if (!KandeloCopyFileArguments(cx, args, &source, &sourceLength, &destination, &destinationLength, &flags)) return false;
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(3), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloCopyFileWork>(cx, request.get(), std::move(source), sourceLength,
      std::move(destination), destinationLength, flags);
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  abandon.release();
  if (!KandeloFsDispatchPrepared(cx, request, work, queue)) return false;
  if (promise) args.rval().setObject(*promise); else args.rval().setUndefined(); return true;
}
}  // namespace
