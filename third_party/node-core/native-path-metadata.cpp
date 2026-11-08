/* Path metadata uses the actual guest POSIX state and shared native work queue. */
#include "kandelo-node-path-metadata-operations.h"
#include "js/WeakMap.h"
#include <cstring>
#include <sys/statfs.h>
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
    case KandeloMetadataOperation::Readlink: return "readlink";
    case KandeloMetadataOperation::Realpath: return "realpath";
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
  else if (strcmp(name.get(), "readlink") == 0) *operation = KandeloMetadataOperation::Readlink;
  else if (strcmp(name.get(), "realpath") == 0) *operation = KandeloMetadataOperation::Realpath;
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
    case KandeloMetadataOperation::Readlink:
    case KandeloMetadataOperation::Realpath:
    case KandeloMetadataOperation::Link:
      return true;  // Both paths are copied by the dispatch owner below.
  }
  MOZ_CRASH("Unknown metadata operation");
}
static bool KandeloMetadataConvert(JSContext* cx, const std::string& path,
                                   HandleValue convert, MutableHandleValue value) {
  if (!convert.isObject() || !JS::IsCallable(&convert.toObject())) {
    JS_ReportErrorASCII(cx, "Path byte result requires its private encoder"); return false;
  }
  RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx,
      reinterpret_cast<const uint8_t*>(path.data()), path.size()));
  if (!bytes) return false;
  JS::RootedValueArray<1> arguments(cx); arguments[0].setObject(*bytes);
  return JS_CallFunctionValue(cx, nullptr, convert, arguments, value);
}
struct KandeloMetadataWork final : KandeloFsWork {
  KandeloMetadataOperation metadataOperation;
  kandelo::nodefs::MetadataOptions options;
  JS::UniqueChars path, destination;
  size_t length, destinationLength, associated;
  kandelo::nodefs::MetadataPathResult pathResult;
  bool resultIsException = false;
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
    if (kandelo::nodefs::MetadataReadsPath(metadataOperation)) {
      pathResult = kandelo::nodefs::ReadMetadataPath(metadataOperation, path.get());
      result = pathResult.status;
    } else result = kandelo::nodefs::RunMetadata(metadataOperation, path.get(), options, destination.get());
    performed = true;
  }
  bool PrepareResult(JSContext* cx) override {
    if (!kandelo::nodefs::MetadataReadsPath(metadataOperation)) return true;
    const size_t bytes = pathResult.bytes.capacity() + 1;
    if (bytes > SIZE_MAX - associated) { JS_ReportOutOfMemory(cx); return false; }
    JS::AddAssociatedMemory(owner, bytes, JS::MemoryUse::Embedding3); associated += bytes;
    RootedValue value(cx), convert(cx, JS::GetReservedSlot(owner, FsRequestBuffers));
    if (!KandeloMetadataConvert(cx, pathResult.bytes, convert, &value)) {
      // Match the shared AfterStringPath policy: conversion failures reject
      // this request, rather than escaping the completion loop as fatal.
      if (!JS_IsExceptionPending(cx) || !JS_GetPendingException(cx, &value)) return false;
      JS_ClearPendingException(cx); resultIsException = true;
    }
    JS::SetReservedSlot(owner, FsRequestResult, value); return true;
  }
  bool ResultIsException() const override { return resultIsException; }
  bool ResultValue(JSContext*, MutableHandleValue value) override {
    if (kandelo::nodefs::MetadataReadsPath(metadataOperation)) value.set(JS::GetReservedSlot(owner, FsRequestResult));
    else value.setUndefined();
    return true;
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
  if (kandelo::nodefs::MetadataReadsPath(operation)) {
    const auto result = kandelo::nodefs::ReadMetadataPath(operation, path.get());
    if (result.status < 0) { args.rval().setInt32(result.status); return true; }
    return KandeloMetadataConvert(cx, result.bytes, args.get(4), args.rval());
  }
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
  const bool readsPath = kandelo::nodefs::MetadataReadsPath(operation);
  if (readsPath && (!args.get(5).isObject() || !JS::IsCallable(&args[5].toObject()))) {
    JS_ReportErrorASCII(cx, "Path byte result requires its private encoder"); return false;
  }
  RootedObject request(cx), promise(cx);
  if (!KandeloFsPromiseRequest(cx, args.get(4), &request, &promise)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  if (readsPath) JS::SetReservedSlot(request, FsRequestBuffers, args[5]);
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloMetadataWork>(cx, request.get(), operation, std::move(path), length,
      std::move(destination), destinationLength, options);
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  abandon.release();
  if (!KandeloFsDispatchPrepared(cx, request, work, queue)) return false;
  if (promise) args.rval().setObject(*promise); else args.rval().setUndefined(); return true;
}
// Actual statfs results use the guest SDK's existing ABI55 libc layout. The
// kernel owns mount lookup and measurements; no default/capability is added.
template <typename T> static void KandeloFillStatfs(const struct statfs& metadata, T* fields) {
  fields[0] = static_cast<T>(metadata.f_type);
  fields[1] = static_cast<T>(metadata.f_bsize);
  // Exact pinned libuv non-Linux branch. Kandelo does not impersonate Linux;
  // this source does not claim that f_frsize is absent from the guest SDK.
  fields[2] = static_cast<T>(metadata.f_bsize);
  fields[3] = static_cast<T>(metadata.f_blocks);
  fields[4] = static_cast<T>(metadata.f_bfree);
  fields[5] = static_cast<T>(metadata.f_bavail);
  fields[6] = static_cast<T>(metadata.f_files);
  fields[7] = static_cast<T>(metadata.f_ffree);
}
// BindingData's cached sync/callback views have realm lifetime, not request
// lifetime. Promise requests deliberately use their own fresh view below.
struct KandeloStatfsBindingState {
  JS::KandeloBacking::SpanRef numbers, bigints;
};
enum KandeloStatfsBindingSlot {
  StatfsBindingState, StatfsBindingNumbers, StatfsBindingBigints, StatfsBindingSlots
};
static void KandeloStatfsBindingFinalize(JS::GCContext*, JSObject* object) {
  const Value slot = JS::GetReservedSlot(object, StatfsBindingState);
  if (!slot.isUndefined()) {
    JS::RemoveAssociatedMemory(object, sizeof(KandeloStatfsBindingState), JS::MemoryUse::Embedding3);
    js_delete(static_cast<KandeloStatfsBindingState*>(slot.toPrivate()));
  }
}
static const JSClassOps KandeloStatfsBindingClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
  KandeloStatfsBindingFinalize, nullptr, nullptr, nullptr};
static const JSClass KandeloStatfsBindingClass = {
  "KandeloFsStatfsBinding", JSCLASS_HAS_RESERVED_SLOTS(StatfsBindingSlots) |
  JSCLASS_FOREGROUND_FINALIZE, &KandeloStatfsBindingClassOps};
static bool KandeloStatfsBinding(JSContext* cx, MutableHandleObject result) {
  auto* environment = js::shell::KandeloGetNativeAsyncState(cx);
  if (!environment) return false;
  RootedObject global(cx, JS::CurrentGlobalOrNull(cx));
  if (!global || environment->detached || !environment->process.initialized() || !environment->process) {
    JS_ReportErrorASCII(cx, "Filesystem binding requires its live process environment");return false;
  }
  RootedObject process(cx, js::CheckedUnwrapStatic(environment->process)), map(cx);
  if (!process) { if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);return false; }
  RootedValue key(cx, ObjectValue(*global)), value(cx);
  {
    JSAutoRealm realm(cx, process);
    if (!environment->statfsBindings.initialized()) {
      map = JS::NewWeakMapObject(cx);if (!map) return false;
      environment->statfsBindings.init(cx);environment->statfsBindings = map;
    } else map = environment->statfsBindings;
    if (!JS_WrapValue(cx, &key) || !JS::GetWeakMapEntry(cx, map, key, &value)) return false;
  }
  if (value.isUndefined()) {
    RootedObject binding(cx, JS_NewObjectWithGivenProto(cx, &KandeloStatfsBindingClass, nullptr));
    if (!binding) return false;
    auto* state = js_new<KandeloStatfsBindingState>();
    if (!state) { JS_ReportOutOfMemory(cx);return false; }
    JS::SetReservedSlot(binding, StatfsBindingState, PrivateValue(state));
    JS::AddAssociatedMemory(binding, sizeof(KandeloStatfsBindingState), JS::MemoryUse::Embedding3);
    value.setObject(*binding);
    {
      JSAutoRealm realm(cx, process);
      if (!JS_WrapValue(cx, &value) || !JS::SetWeakMapEntry(cx, map, key, value)) return false;
    }
  }
  if (!JS_WrapValue(cx, &value)) return false;
  MOZ_RELEASE_ASSERT(value.isObject() && JS::GetClass(&value.toObject()) == &KandeloStatfsBindingClass);
  result.set(&value.toObject());return true;
}
static bool KandeloStatfsValue(JSContext* cx, const struct statfs& metadata,
                                bool bigint, bool cached, MutableHandleValue result) {
  RootedObject values(cx), binding(cx);
  JS::KandeloBacking::SpanRef backing;
  if (cached) {
    if (!KandeloStatfsBinding(cx, &binding)) return false;
    auto* state = static_cast<KandeloStatfsBindingState*>(
        JS::GetReservedSlot(binding, StatfsBindingState).toPrivate());
    const uint32_t slot = bigint ? StatfsBindingBigints : StatfsBindingNumbers;
    const Value prior = JS::GetReservedSlot(binding, slot);
    if (prior.isObject()) {
      values = &prior.toObject();backing = bigint ? state->bigints : state->numbers;
    } else {
      values = bigint ? JS_NewBigInt64Array(cx, 8) : JS_NewFloat64Array(cx, 8);
      if (!values) return false;
      // Acquire externalizes movable inline storage before this native cache
      // retains it. The actual allocation survives a publicly detached view;
      // never retain a naked JS_Get*ArrayData pointer between calls/GC.
      backing = JS::KandeloBacking::Acquire(cx, values);
      if (!backing) return false;
      if (bigint) state->bigints = backing;else state->numbers = backing;
      JS::SetReservedSlot(binding, slot, ObjectValue(*values));
    }
    MOZ_RELEASE_ASSERT(backing && backing->Length() == 8 * sizeof(int64_t));
    // Native material is separate from JS view state. No JS conversion or
    // allocation runs between forming these fields and copying all 8 values.
    if (bigint) {
      int64_t fields[8];KandeloFillStatfs(metadata, fields);
      std::memcpy(backing->Data(), fields, sizeof(fields));
    } else {
      double fields[8];KandeloFillStatfs(metadata, fields);
      std::memcpy(backing->Data(), fields, sizeof(fields));
    }
  } else {
    // FSReqPromise has per-request storage, not the realm's callback cache.
    values = bigint ? JS_NewBigInt64Array(cx, 8) : JS_NewFloat64Array(cx, 8);
    if (!values) return false;
    JS::AutoCheckCannotGC nogc;bool shared;
    if (bigint) KandeloFillStatfs(metadata, JS_GetBigInt64ArrayData(values, &shared, nogc));
    else KandeloFillStatfs(metadata, JS_GetFloat64ArrayData(values, &shared, nogc));
  }
  result.setObject(*values);return true;
}
static int KandeloDoStatfs(const char* path, struct statfs* metadata) {
  int status;do { status=statfs(path,metadata); } while (status<0 && errno==EINTR);
  return status==0?0:-errno;
}
struct KandeloStatfsWork final : KandeloFsWork {
  struct statfs metadata{};
  JS::UniqueChars path;
  const size_t pathLength, associated;
  const bool bigint;
  KandeloStatfsWork(JSContext* cx, JSObject* request, JS::UniqueChars path,
                     size_t length, bool bigint)
      : KandeloFsWork(cx,request,-1,0,Operation::Stat),path(std::move(path)),
        pathLength(length),associated(sizeof(*this)-sizeof(KandeloFsWork)+length+1),bigint(bigint) {
    JS::AddAssociatedMemory(owner,associated,JS::MemoryUse::Embedding3);
  }
  ~KandeloStatfsWork() override {
    JS::RemoveAssociatedMemory(owner,associated,JS::MemoryUse::Embedding3);
  }
  const char* Syscall() const override { return "statfs"; }
  void Run() override { result=KandeloDoStatfs(path.get(),&metadata);performed=true; }
  bool PrepareResult(JSContext* cx) override {
    // Node fills ResolveStatFs storage before MakeCallback enters its async
    // scope. A real before-hook may call statfsSync and overwrite this shared
    // callback view; do not refill it after that hook returns.
    RootedValue value(cx);
    if (!KandeloStatfsValue(cx,metadata,bigint,State()->kind == FsResourceKind::Callback,&value)) return false;
    JS::SetReservedSlot(owner, FsRequestResult, value);return true;
  }
  bool ResultValue(JSContext*, MutableHandleValue value) override {
    value.set(JS::GetReservedSlot(owner, FsRequestResult));return true;
  }
  bool ErrorPathValue(JSContext* cx, MutableHandleValue value) override {
    // The shared error converter receives copied raw bytes, preserving actual
    // invalid-UTF8 pathname error identity instead of strict-decoding failure.
    RootedObject bytes(cx,KandeloNewUint8ArrayCopy(cx,
        reinterpret_cast<const uint8_t*>(path.get()),pathLength));
    if (!bytes) return false;
    value.setObject(*bytes);return true;
  }
};
static bool KandeloFsStatfsSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp);JS::UniqueChars path;size_t length;
  if (!KandeloFsPath(cx,args.get(0),&path,&length)) return false;
  struct statfs metadata{};const int status=KandeloDoStatfs(path.get(),&metadata);
  if (status<0) { args.rval().setInt32(status);return true; }
  return KandeloStatfsValue(cx,metadata,args.get(1).isTrue(),true,args.rval());
}
static bool KandeloFsStatfsPromise(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp);JS::UniqueChars path;size_t length;
  if (!KandeloFsPath(cx,args.get(0),&path,&length)) return false;
  if (length>SIZE_MAX-sizeof(KandeloStatfsWork)-1) { JS_ReportOutOfMemory(cx);return false; }
  RootedObject request(cx),promise(cx);
  if (!KandeloFsPromiseRequest(cx,args.get(2),&request,&promise)) return false;
  auto abandon=mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  auto* state=KandeloFsRequestStateOf(cx,request);if (!state) return false;
  // An existing callback request owns the first options.bigint value; the
  // second getter evaluation remains observable but cannot replace that state.
  const bool bigint=state->kind==FsResourceKind::Callback?state->useBigInt:args.get(1).isTrue();
  auto* queue=js::shell::KandeloGetNativeWorkQueue(cx);if (!queue) return false;
  auto* work=js_new<KandeloStatfsWork>(cx,request.get(),std::move(path),length,bigint);
  if (!work) { JS_ReportOutOfMemory(cx);return false; }
  abandon.release();
  if (!KandeloFsDispatchPrepared(cx,request,work,queue)) return false;
  if (promise) args.rval().setObject(*promise);else args.rval().setUndefined();return true;
}
}  // namespace
