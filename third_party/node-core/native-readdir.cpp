/* Actual byte/type directory scans, synchronous or on the shared guest work
 * pool. Worker code owns POSIX bytes and never enters a JS realm. */
#include "kandelo-node-readdir-operations.h"
namespace {
static bool KandeloReaddirBytes(JSContext* cx, const std::string& bytes,
                                MutableHandleValue output) {
  RootedObject view(cx, KandeloNewUint8ArrayCopy(cx,
      reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size()));
  if (!view) return false;
  output.setObject(*view); return true;
}
static bool KandeloReaddirPacket(JSContext* cx, const kandelo::nodefs::ReadDirectories& scan,
                                 bool withTypes, MutableHandleValue output) {
  if (scan.status < 0) {
    JS::RootedValueArray<2> fields(cx); fields[0].setInt32(scan.status);
    if (!KandeloReaddirBytes(cx, scan.errorPath, fields[1])) return false;
    RootedObject error(cx, JS::NewArrayObject(cx, fields));
    if (!error) return false;
    output.setObject(*error); return true;
  }
  size_t total = 0;
  for (const auto& directory : scan.directories) {
    if (directory.entries.size() > UINT32_MAX - total) { JS_ReportOutOfMemory(cx); return false; }
    total += directory.entries.size();
  }
  if (scan.directories.size() > UINT32_MAX) { JS_ReportOutOfMemory(cx); return false; }
  RootedObject names(cx, JS::NewArrayObject(cx, uint32_t(total)));
  RootedObject types(cx, JS::NewArrayObject(cx, withTypes ? uint32_t(total) : 0));
  RootedObject counts(cx, JS::NewArrayObject(cx, withTypes ? uint32_t(scan.directories.size()) : 0));
  RootedObject directories(cx, JS::NewArrayObject(cx, withTypes ? uint32_t(scan.directories.size()) : 0));
  if (!names || !types || !counts || !directories) return false;
  uint32_t index = 0, directoryIndex = 0;
  for (const auto& directory : scan.directories) {
    for (const auto& entry : directory.entries) {
      std::string relative;
      const std::string* bytes = &entry.name;
      if (!withTypes && !directory.relative.empty()) {
        relative = directory.relative;
        kandelo::nodefs::AppendDirectoryComponent(&relative, entry.name); bytes = &relative;
      }
      RootedValue value(cx);
      if (!KandeloReaddirBytes(cx, *bytes, &value) ||
          !JS_DefineElement(cx, names, index, value, JSPROP_ENUMERATE)) return false;
      value.setInt32(int(entry.type));
      if (withTypes && !JS_DefineElement(cx, types, index, value, JSPROP_ENUMERATE)) return false;
      ++index;
    }
    if (withTypes) {
      RootedValue value(cx, NumberValue(double(directory.entries.size())));
      if (!JS_DefineElement(cx, counts, directoryIndex, value, JSPROP_ENUMERATE) ||
          !KandeloReaddirBytes(cx, directory.relative, &value) ||
          !JS_DefineElement(cx, directories, directoryIndex, value, JSPROP_ENUMERATE)) return false;
      ++directoryIndex;
    }
  }
  JS::RootedValueArray<4> fields(cx);
  fields[0].setObject(*names); fields[1].setObject(*types);
  fields[2].setObject(*counts); fields[3].setObject(*directories);
  RootedObject result(cx, JS::NewArrayObject(cx, fields));
  if (!result) return false;
  output.setObject(*result); return true;
}
static bool KandeloReaddirOptions(JSContext* cx, const CallArgs& args) {
  if (!args.get(1).isBoolean() || !args.get(2).isBoolean()) {
    JS_ReportErrorASCII(cx, "Directory scan flags must be boolean"); return false;
  }
  return true;
}
static bool KandeloReaddirConvert(JSContext* cx, HandleValue convert,
                                  HandleValue packet, MutableHandleValue result) {
  if (!convert.isObject() || !JS::IsCallable(&convert.toObject())) {
    JS_ReportErrorASCII(cx, "Directory scan requires its private byte encoder"); return false;
  }
  JS::RootedValueArray<1> arguments(cx); arguments[0].set(packet);
  RootedObject receiver(cx, JS::CurrentGlobalOrNull(cx));
  return JS_CallFunctionValue(cx, receiver, convert, arguments, result);
}
static bool KandeloNativeReaddirSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  JS::UniqueChars name; size_t length;
  if (!KandeloFsPath(cx, args.get(0), &name, &length) || !KandeloReaddirOptions(cx, args)) return false;
  const auto scan = kandelo::nodefs::ReadDirectoryTree(std::string(name.get(), length), args[1].toBoolean());
  RootedValue packet(cx);
  return KandeloReaddirPacket(cx, scan, args[2].toBoolean(), &packet) &&
      KandeloReaddirConvert(cx, args.get(3), packet, args.rval());
}
struct KandeloReaddirWork final : KandeloFsWork {
  std::string name;
  bool recursive, withTypes;
  size_t associated;
  kandelo::nodefs::ReadDirectories scan;
  KandeloReaddirWork(JSContext* cx, JSObject* request, std::string path,
                      bool recursive, bool withTypes)
      : KandeloFsWork(cx, request, -1, 0, Operation::Directory),
        name(std::move(path)), recursive(recursive), withTypes(withTypes),
        associated(sizeof(*this) - sizeof(KandeloFsWork) + name.capacity() + 1) {
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloReaddirWork() override {
    JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  void Run() override {
    scan = kandelo::nodefs::ReadDirectoryTree(name, recursive);
    result = scan.status; performed = true;
  }
  const char* Syscall() const override { return "scandir"; }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    const auto& path = scan.status < 0 ? scan.errorPath : name;
    return KandeloFsPathString(cx, path.data(), path.size(), value);
  }
  bool PrepareResult(JSContext* cx) override {
    // Bound the completed native allocations before entering the encoder.
    // Worker execution never calls collector APIs or holds JS data pointers.
    size_t bytes = 0;
    auto add = [&](size_t amount) {
      if (amount > SIZE_MAX - bytes) return false;
      bytes += amount; return true;
    };
    for (const auto& directory : scan.directories) {
      if (directory.entries.capacity() > SIZE_MAX / sizeof(kandelo::nodefs::ReadEntry) ||
          !add(sizeof(directory)) || !add(directory.relative.capacity() + 1) ||
          !add(directory.entries.capacity() * sizeof(kandelo::nodefs::ReadEntry))) {
        JS_ReportOutOfMemory(cx); return false;
      }
      for (const auto& entry : directory.entries)
        if (!add(entry.name.capacity() + 1)) { JS_ReportOutOfMemory(cx); return false; }
    }
    if (bytes > SIZE_MAX - associated) { JS_ReportOutOfMemory(cx); return false; }
    JS::AddAssociatedMemory(owner, bytes, JS::MemoryUse::Embedding3); associated += bytes;
    RootedValue packet(cx), value(cx);
    RootedValue convert(cx, JS::GetReservedSlot(owner, FsRequestBuffers));
    if (!KandeloReaddirPacket(cx, scan, withTypes, &packet) ||
        !KandeloReaddirConvert(cx, convert, packet, &value)) return false;
    JS::SetReservedSlot(owner, FsRequestResult, value); return true;
  }
  bool ResultValue(JSContext*, MutableHandleValue value) override {
    value.set(JS::GetReservedSlot(owner, FsRequestResult)); return true;
  }
};
static bool KandeloNativeReaddirPromise(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  JS::UniqueChars name; size_t length;
  if (!KandeloFsPath(cx, args.get(0), &name, &length) || !KandeloReaddirOptions(cx, args)) return false;
  if (!args.get(4).isObject() || !JS::IsCallable(&args[4].toObject())) {
    JS_ReportErrorASCII(cx, "Directory scan requires its private byte encoder"); return false;
  }
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(3), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  JS::SetReservedSlot(request, FsRequestBuffers, args[4]);
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloReaddirWork>(cx, request.get(), std::string(name.get(), length),
      args[1].toBoolean(), args[2].toBoolean());
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  abandon.release();
  if (!KandeloFsDispatchPrepared(cx, request, work, queue)) return false;
  if (promise) args.rval().setObject(*promise); else args.rval().setUndefined();
  return true;
}
}  // namespace
