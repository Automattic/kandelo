/* Native filesystem removal and raw directory scans. Included after the real
 * FS request/promise owners; worker code owns bytes and never enters JS. */
#include "shell/kandelo-node-removal-operations.h"
namespace {
static bool KandeloNativeRmSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  JS::UniqueChars name; size_t length; int64_t retries, delay;
  if (!KandeloFsPath(cx, args.get(0), &name, &length) ||
      !KandeloFsInteger(cx, args.get(1), 0, UINT32_MAX, &retries) ||
      !KandeloFsInteger(cx, args.get(3), 0, INT32_MAX, &delay)) return false;
  if (!args.get(2).isBoolean()) { JS_ReportErrorASCII(cx, "Removal recursive flag must be boolean"); return false; }
  const int32_t signedRetries = retries <= INT32_MAX ? int32_t(retries) : int32_t(retries - 0x100000000LL);
  const auto result = kandelo::nodefs::RemoveSync(std::string(name.get(), length),
      signedRetries, args[2].toBoolean(), int32_t(delay));
  if (!result.error && !result.unknown) { args.rval().setUndefined(); return true; }
  JS::RootedValueArray<5> packet(cx);
  packet[0].setInt32(result.error); packet[1].setBoolean(result.directory); packet[2].setBoolean(result.unknown);
  if (!KandeloFsPathString(cx, result.message.data(), result.message.size(), packet[3]) ||
      !KandeloFsPathString(cx, name.get(), length, packet[4])) return false;
  RootedObject output(cx, JS::NewArrayObject(cx, packet));
  if (!output) return false;
  args.rval().setObject(*output); return true;
}
struct KandeloScandirWork final : KandeloFsWork {
  JS::UniqueChars name; size_t nameLength, associated;
  kandelo::nodefs::ScanResult scan;
  KandeloScandirWork(JSContext* cx, JSObject* request, JS::UniqueChars name, size_t length)
      : KandeloFsWork(cx, request, -1, 0, Operation::Directory),
        name(std::move(name)), nameLength(length),
        associated(sizeof(*this) - sizeof(KandeloFsWork) + length + 1) {
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloScandirWork() override {
    JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  const char* Syscall() const override { return "scandir"; }
  void Run() override { scan = kandelo::nodefs::ScanDirectory(name.get()); result = scan.status; performed = true; }
  bool PrepareResult(JSContext* cx) override {
    if (scan.names.size() > UINT32_MAX) { JS_ReportOutOfMemory(cx); return false; }
    if (scan.names.capacity() > SIZE_MAX / sizeof(std::string)) { JS_ReportOutOfMemory(cx); return false; }
    size_t bytesOwned = scan.names.capacity() * sizeof(std::string);
    for (const auto& entry : scan.names) {
      if (entry.capacity() >= SIZE_MAX - bytesOwned) { JS_ReportOutOfMemory(cx); return false; }
      bytesOwned += entry.capacity() + 1;
    }
    if (bytesOwned > SIZE_MAX - associated) { JS_ReportOutOfMemory(cx); return false; }
    JS::AddAssociatedMemory(owner, bytesOwned, JS::MemoryUse::Embedding3);
    associated += bytesOwned;
    RootedObject output(cx, JS::NewArrayObject(cx, scan.names.size()));
    RootedObject prototype(cx, &JS::GetReservedSlot(owner, FsRequestBuffers).toObject());
    if (!output) return false;
    for (size_t i = 0; i < scan.names.size(); ++i) {
      const auto& bytes = scan.names[i];
      if (bytes.size() > INT64_MAX) { JS_ReportOutOfMemory(cx); return false; }
      RootedObject buffer(cx, JS::NewArrayBuffer(cx, bytes.size()));
      if (!buffer) return false;
      {
        JS::AutoCheckCannotGC nogc; bool shared;
        void* target = JS::GetArrayBufferData(buffer, &shared, nogc);
        if (!bytes.empty()) memcpy(target, bytes.data(), bytes.size());
      }
      RootedObject view(cx, JS_NewUint8ArrayWithBuffer(cx, buffer, 0, int64_t(bytes.size())));
      if (!view || !JS_SetPrototype(cx, view, prototype)) return false;
      RootedValue value(cx, ObjectValue(*view));
      if (!JS_SetElement(cx, output, uint32_t(i), value)) return false;
    }
    JS::SetReservedSlot(owner, FsRequestResult, ObjectValue(*output));
    return true;
  }
  bool ResultValue(JSContext*, MutableHandleValue value) override {
    value.set(JS::GetReservedSlot(owner, FsRequestResult)); return true;
  }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    return KandeloFsPathString(cx, name.get(), nameLength, value);
  }
};
static bool KandeloNativeScandir(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  JS::UniqueChars name; size_t length;
  if (!KandeloFsPath(cx, args.get(0), &name, &length)) return false;
  if (length > SIZE_MAX - sizeof(KandeloScandirWork) - 1) { JS_ReportOutOfMemory(cx); return false; }
  if (!args.get(2).isObject()) { JS_ReportErrorASCII(cx, "Scandir requires a Buffer prototype"); return false; }
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(1), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  JS::SetReservedSlot(request, FsRequestBuffers, args[2]);
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloScandirWork>(cx, request.get(), std::move(name), length);
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  abandon.release();
  if (!KandeloFsDispatchPrepared(cx, request, work, queue)) return false;
  args.rval().setUndefined(); return true;
}
}  // namespace
