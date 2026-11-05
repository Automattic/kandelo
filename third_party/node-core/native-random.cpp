/* CSPRNG work and secure allocations over the real packaged OpenSSL provider.
 * Included after native-digests.cpp and shared native request/work owners. */
#include "kandelo-node-random-operations.h"
namespace {
static bool KandeloNativeRandomFill(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  kandelo::crypto::Bytes bytes;
  try {
    JS::AutoCheckCannotGC nogc; SharedMem<uint8_t*> output; size_t length;
    if (!KandeloCryptoSpan(cx, args.get(0), &output, &length)) {
      if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Random fill requires real bytes"); return false;
    }
    bytes.value.resize(length); kandelo::crypto::FillRandom(bytes.value.data(), length);
    for (size_t i = 0; i < length; ++i) __atomic_store_n(output.unwrap() + i, bytes.value[i], __ATOMIC_RELAXED);
    args.rval().setUndefined(); return true;
  } catch (const kandelo::crypto::Error& error) { return KandeloDigestError(cx, error, args.rval()); }
}
static void KandeloFreeSecureRandomBuffer(void*, void* owner) {
  delete static_cast<kandelo::crypto::SecureBytes*>(owner);
}
static bool KandeloNativeSecureRandomBuffer(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int64_t length;
  if (!KandeloFsInteger(cx, args.get(0), 0, UINT32_MAX, &length)) return false;
  std::unique_ptr<kandelo::crypto::SecureBytes> owner;
  try { owner = std::make_unique<kandelo::crypto::SecureBytes>(size_t(length)); }
  catch (const std::bad_alloc&) { args.rval().setUndefined(); return true; }
  auto* data = owner->data();
  mozilla::UniquePtr<void, JS::BufferContentsDeleter> contents(data,
      JS::BufferContentsDeleter(KandeloFreeSecureRandomBuffer, owner.release()));
  RootedObject buffer(cx, JS::NewExternalArrayBuffer(cx, size_t(length), std::move(contents)));
  if (!buffer) return false;
  RootedObject view(cx, JS_NewUint8ArrayWithBuffer(cx, buffer, 0, length));
  if (!view) return false;
  args.rval().setObject(*view); return true;
}
struct KandeloRandomWork final : KandeloFsWork {
  size_t offset, size, associated;
  kandelo::crypto::Bytes bytes;
  std::unique_ptr<kandelo::crypto::Error> cryptoError;
  KandeloRandomWork(JSContext* cx, JSObject* request, size_t offset, size_t size)
      : KandeloFsWork(cx, request, -1, 0, Operation::FileRead), offset(offset), size(size),
        associated(sizeof(*this) - sizeof(KandeloFsWork) + size) {
    workClass = WorkClass::Cpu;
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloRandomWork() override { JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3); }
  const char* Syscall() const override { return "randomFill"; }
  void Run() override {
    bytes.value.resize(size);
    try { kandelo::crypto::FillRandom(bytes.value.data(), size); }
    catch (const kandelo::crypto::Error& error) { cryptoError = std::make_unique<kandelo::crypto::Error>(error); }
    performed = true;
  }
  bool PrepareResult(JSContext* cx) override {
    RootedValue error(cx, NullValue());
    if (cryptoError) {
      if (!KandeloDigestError(cx, *cryptoError, &error)) return false;
    } else {
      bool valid = false;
      RootedValue target(cx, JS::GetReservedSlot(owner, FsRequestBuffers));
      RootedObject object(cx, &target.toObject()), backing(cx, object);
      const bool view = JS_IsArrayBufferViewObject(object);
      if (view) {
        bool shared;
        backing = JS_GetArrayBufferViewBuffer(cx, object, &shared);
        if (!backing) return false;
      }
      const bool detached = JS::IsArrayBufferObject(backing) && JS::IsDetachedArrayBufferObject(backing);
      // A detached or now-out-of-bounds view has no valid writable span. Do
      // not turn its expected state transition into an uncaught JSAPI error.
      const bool emptyView = view && JS_GetArrayBufferViewByteLength(object) == 0;
      if (!detached && !emptyView) {
        JS::AutoCheckCannotGC nogc; SharedMem<uint8_t*> output; size_t length;
        if (KandeloCryptoSpan(cx, target, &output, &length)) {
          valid = offset <= length && size <= length - offset;
          if (valid) for (size_t i = 0; i < size; ++i)
            __atomic_store_n(output.unwrap() + offset + i, bytes.value[i], __ATOMIC_RELAXED);
        } else if (JS_IsExceptionPending(cx)) return false;
      }
      if (!valid) {
        RootedObject object(cx, JS_NewPlainObject(cx));
        RootedString message(cx, JS_NewStringCopyZ(cx, "Random destination was detached or resized before completion"));
        RootedString code(cx, JS_NewStringCopyZ(cx, "ERR_INVALID_STATE"));
        if (!object || !message || !code || !JS_DefineProperty(cx, object, "message", message, JSPROP_ENUMERATE) ||
            !JS_DefineProperty(cx, object, "code", code, JSPROP_ENUMERATE)) return false;
        error.setObject(*object);
      }
    }
    JS::SetReservedSlot(owner, FsRequestResult, error); return true;
  }
  bool ResultValue(JSContext*, MutableHandleValue value) override {
    value.set(JS::GetReservedSlot(owner, FsRequestResult)); return true;
  }
};
static bool KandeloNativeCreateRandomBytesJob(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); int64_t offset, size;
  if (!args.get(0).isObject() || !args.get(1).isInt32() || args[1].toInt32() != 0 ||
      !args.get(5).isObject() || !JS::IsCallable(&args[5].toObject())) {
    JS_ReportErrorASCII(cx, "RandomBytesJob requires async mode/prototype/callback"); return false;
  }
  if (!KandeloFsInteger(cx, args.get(3), 0, INT32_MAX, &offset) ||
      !KandeloFsInteger(cx, args.get(4), 0, INT32_MAX, &size)) return false;
  {
    JS::AutoCheckCannotGC nogc; SharedMem<uint8_t*> data; size_t length;
    if (!KandeloCryptoSpan(cx, args.get(2), &data, &length)) {
      if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "RandomBytesJob requires buffer source"); return false;
    }
    if (uint64_t(offset) > length || uint64_t(size) > length - size_t(offset)) {
      JS_ReportErrorASCII(cx, "RandomBytesJob span out of bounds"); return false;
    }
  }
  RootedObject prototype(cx, &args[0].toObject()), request(cx);
  if (!KandeloCreateFsResource(cx, prototype, args[5], FsResourceKind::Random, &request)) return false;
  auto* state = KandeloFsRequestStateOf(cx, request); if (!state) return false;
  state->limit = size; state->flags = int(offset);
  JS::SetReservedSlot(request, FsRequestBuffers, args[2]);
  // The resource exists when constructed, before ondone is assigned/run called.
  if (!KandeloInitializeFsResource(cx, request)) return false;
  args.rval().setObject(*request); return true;
}
static bool KandeloNativeRunRandomBytesJob(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) { JS_ReportErrorASCII(cx, "RandomBytesJob receiver required"); return false; }
  RootedObject owner(cx, &args[0].toObject()); auto* state = KandeloFsRequestStateOf(cx, owner);
  if (!state || state->kind != FsResourceKind::Random || state->retired || state->dispatched) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "RandomBytesJob is not dispatchable"); return false;
  }
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(owner); });
  if (state->limit > SIZE_MAX - sizeof(KandeloRandomWork)) { JS_ReportOutOfMemory(cx); return false; }
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto* work = js_new<KandeloRandomWork>(cx, owner.get(), uint32_t(state->flags), size_t(state->limit));
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  // Already initialized by construction: dispatch must not emit a second init.
  state->dispatched = true;
  if (!queue->Submit(work)) { js_delete(work); JS_ReportErrorASCII(cx, "Crypto work queue closing"); return false; }
  abandon.release(); args.rval().setUndefined(); return true;
}
}  // namespace
