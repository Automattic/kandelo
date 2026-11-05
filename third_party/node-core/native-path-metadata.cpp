/* Path metadata uses the actual guest POSIX state and shared native work queue. */
#include "kandelo-node-path-metadata-operations.h"
namespace {
using KandeloMetadataOperation = kandelo::nodefs::MetadataOperation;
static const char* KandeloMetadataSyscall(KandeloMetadataOperation operation) {
  switch (operation) {
    case KandeloMetadataOperation::Access: return "access";
    case KandeloMetadataOperation::Chmod: return "chmod";
    case KandeloMetadataOperation::Chown: return "chown";
    case KandeloMetadataOperation::Lchown: return "lchown";
    case KandeloMetadataOperation::Utimes: return "utime";
    case KandeloMetadataOperation::Lutimes: return "lutime";
    case KandeloMetadataOperation::Link: return "link";
  }
  MOZ_CRASH("Unknown metadata operation");
}
static bool KandeloMetadataArguments(JSContext* cx, const CallArgs& args,
                                      KandeloMetadataOperation* operation,
                                      kandelo::nodefs::MetadataOptions* options) {
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "Metadata operation name required"); return false; }
  RootedString text(cx, args[0].toString()); JS::UniqueChars name = JS_EncodeStringToUTF8(cx, text);
  if (!name) return false;
  if (strcmp(name.get(), "access") == 0) *operation = KandeloMetadataOperation::Access;
  else if (strcmp(name.get(), "chmod") == 0) *operation = KandeloMetadataOperation::Chmod;
  else if (strcmp(name.get(), "chown") == 0) *operation = KandeloMetadataOperation::Chown;
  else if (strcmp(name.get(), "lchown") == 0) *operation = KandeloMetadataOperation::Lchown;
  else if (strcmp(name.get(), "utimes") == 0) *operation = KandeloMetadataOperation::Utimes;
  else if (strcmp(name.get(), "lutimes") == 0) *operation = KandeloMetadataOperation::Lutimes;
  else if (strcmp(name.get(), "link") == 0) *operation = KandeloMetadataOperation::Link;
  else { JS_ReportErrorASCII(cx, "Unknown metadata operation"); return false; }
  int64_t first, second;
  switch (*operation) {
    case KandeloMetadataOperation::Access:
      if (!KandeloFsInteger(cx, args.get(2), 0, F_OK | R_OK | W_OK | X_OK, &first)) return false;
      options->mode = uint32_t(first); return true;
    case KandeloMetadataOperation::Chmod:
      if (!KandeloFsInteger(cx, args.get(2), 0, UINT32_MAX, &first)) return false;
      options->mode = uint32_t(first); return true;
    case KandeloMetadataOperation::Chown:
    case KandeloMetadataOperation::Lchown:
      if (!KandeloFsInteger(cx, args.get(2), -1, UINT32_MAX, &first) ||
          !KandeloFsInteger(cx, args.get(3), -1, UINT32_MAX, &second)) return false;
      options->uid = uid_t(first); options->gid = gid_t(second); return true;
    case KandeloMetadataOperation::Utimes:
    case KandeloMetadataOperation::Lutimes:
      return KandeloFsTime(cx, args.get(2), &options->times[0]) && KandeloFsTime(cx, args.get(3), &options->times[1]);
    case KandeloMetadataOperation::Link:
      return true;  // Both paths are copied by the dispatch owner below.
  }
  MOZ_CRASH("Unknown metadata operation");
}
struct KandeloMetadataWork final : KandeloFsWork {
  KandeloMetadataOperation metadataOperation;
  kandelo::nodefs::MetadataOptions options;
  JS::UniqueChars path, destination;
  size_t length, destinationLength, associated;
  KandeloMetadataWork(JSContext* cx, JSObject* request, KandeloMetadataOperation operation,
                      JS::UniqueChars path, size_t length, JS::UniqueChars destination,
                      size_t destinationLength, const kandelo::nodefs::MetadataOptions& options)
      : KandeloFsWork(cx, request, -1, 0, Operation::Directory), metadataOperation(operation),
        options(options), path(std::move(path)), destination(std::move(destination)),
        length(length), destinationLength(destinationLength),
        associated(sizeof(*this) - sizeof(KandeloFsWork) + length + 1 +
                   (this->destination ? destinationLength + 1 : 0)) {
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloMetadataWork() override { JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3); }
  const char* Syscall() const override { return KandeloMetadataSyscall(metadataOperation); }
  void Run() override {
    result = kandelo::nodefs::RunMetadata(metadataOperation, path.get(), options, destination.get());
    performed = true;
  }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    // Preserve raw pathname bytes until the shared UVException owner decodes
    // them. A strict engine UTF-8 constructor would lose the real I/O error.
    RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx, reinterpret_cast<const uint8_t*>(path.get()), length));
    if (!bytes) return false;
    value.setObject(*bytes); return true;
  }
  bool ErrorDestValue(JSContext* cx, MutableHandleValue value) override {
    if (!destination) { value.setUndefined(); return true; }
    RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx,
        reinterpret_cast<const uint8_t*>(destination.get()), destinationLength));
    if (!bytes) return false;
    value.setObject(*bytes); return true;
  }
};
static bool KandeloFsMetadataSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); KandeloMetadataOperation operation;
  kandelo::nodefs::MetadataOptions options;
  if (!KandeloMetadataArguments(cx, args, &operation, &options)) return false;
  JS::UniqueChars path, destination; size_t length, destinationLength;
  if (!KandeloFsPath(cx, args.get(1), &path, &length)) return false;
  if (operation == KandeloMetadataOperation::Link &&
      !KandeloFsPath(cx, args.get(2), &destination, &destinationLength)) return false;
  args.rval().setInt32(kandelo::nodefs::RunMetadata(operation, path.get(), options, destination.get())); return true;
}
static bool KandeloFsMetadataPromise(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); KandeloMetadataOperation operation;
  kandelo::nodefs::MetadataOptions options;
  if (!KandeloMetadataArguments(cx, args, &operation, &options)) return false;
  JS::UniqueChars path, destination; size_t length, destinationLength = 0;
  if (!KandeloFsPath(cx, args.get(1), &path, &length)) return false;
  if (length > SIZE_MAX - sizeof(KandeloMetadataWork) - 1) { JS_ReportOutOfMemory(cx); return false; }
  if (operation == KandeloMetadataOperation::Link) {
    if (!KandeloFsPath(cx, args.get(2), &destination, &destinationLength)) return false;
    if (length > SIZE_MAX - sizeof(KandeloMetadataWork) - 2 ||
        destinationLength > SIZE_MAX - sizeof(KandeloMetadataWork) - length - 2) {
      JS_ReportOutOfMemory(cx); return false;
    }
  }
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(4), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloMetadataWork>(cx, request.get(), operation, std::move(path), length,
      std::move(destination), destinationLength, options);
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  abandon.release();
  if (!KandeloFsDispatchPrepared(cx, request, work, queue)) return false;
  if (promise) args.rval().setObject(*promise); else args.rval().setUndefined(); return true;
}
}  // namespace
