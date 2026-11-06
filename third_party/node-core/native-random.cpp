/* CSPRNG work and secure allocations over the real packaged OpenSSL provider.
 * Included after native-digests.cpp and shared native request/work owners. */
#include "kandelo-node-random-operations.h"
#include <new>
namespace {
static bool KandeloNativeRandomFill(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  kandelo::crypto::Bytes bytes;
  KandeloCryptoByteSource source(cx);
  if (!source.Init(args.get(0))) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Random fill requires real bytes");return false;
  }
  try {
    const bool filled = source.WithBytes([&](SharedMem<uint8_t*> output, size_t length) {
      bytes.value.resize(length);kandelo::crypto::FillRandom(bytes.value.data(), length);
      for (size_t i = 0; i < length; ++i) __atomic_store_n(output.unwrap() + i, bytes.value[i], __ATOMIC_RELAXED);
      return true;
    });
    if (!filled) {
      if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Random destination has no backing data");return false;
    }
    args.rval().setUndefined();return true;
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
  size_t offset, size, associated = 0;
  JS::KandeloBacking::SpanRef backing;
  kandelo::crypto::Bytes bytes;
  std::unique_ptr<kandelo::crypto::Error> cryptoError;
  KandeloRandomWork(JSContext* cx, JSObject* request, size_t offset, size_t size,
                    JS::KandeloBacking::SpanRef backing)
      : KandeloFsWork(cx, request, -1, 0, Operation::FileRead), offset(offset), size(size), backing(std::move(backing)) {
    workClass = WorkClass::Cpu;
    // Allocate real native scratch before publishing work. The charge follows
    // actual capacity, not a predicted allocation on another thread.
    bytes.value.resize(size);
    if (bytes.value.capacity() > SIZE_MAX - (sizeof(*this) - sizeof(KandeloFsWork))) throw std::length_error("Random scratch capacity overflow");
    associated = sizeof(*this) - sizeof(KandeloFsWork) + bytes.value.capacity();
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloRandomWork() override { JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3); }
  void ReleaseIo() override { backing.reset(); }
  const char* Syscall() const override { return "randomFill"; }
  void Run() override {
    try {
      kandelo::crypto::FillRandom(bytes.value.data(), size);
      // The capability owns the original admitted allocation and range, even
      // if JS detached/resized/transferred the view after init. Worker code
      // never touches JS objects; preserve relaxed atomic shared stores.
      uint8_t* destination = backing->Data();
      for (size_t i = 0; i < size; ++i)
        __atomic_store_n(destination + offset + i, bytes.value[i], __ATOMIC_RELAXED);
    } catch (const kandelo::crypto::Error& error) { cryptoError = std::make_unique<kandelo::crypto::Error>(error); }
    performed = true;
  }
  bool PrepareResult(JSContext* cx) override {
    RootedValue error(cx, NullValue());
    if (cryptoError && !KandeloDigestError(cx, *cryptoError, &error)) return false;
    // Never re-borrow the current JS view or redirect writes during completion.
    // The completed native work has already consumed its owned original span.
    JS::SetReservedSlot(owner, FsRequestResult, error);return true;
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
  KandeloCryptoByteSource source(cx);
  if (!source.Init(args.get(2))) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "RandomBytesJob requires buffer source");return false;
  }
  const size_t length = source.Length();
  if (uint64_t(offset) > length || uint64_t(size) > length - size_t(offset)) {
    JS_ReportErrorASCII(cx, "RandomBytesJob span out of bounds");return false;
  }
  auto backing = source.Capture();if (!backing) return false;
  if (uint64_t(offset) > backing->Length() || uint64_t(size) > backing->Length() - size_t(offset)) {
    JS_ReportErrorASCII(cx, "RandomBytesJob captured span out of bounds");return false;
  }
  RootedObject prototype(cx, &args[0].toObject()), request(cx);
  if (!KandeloCreateFsResource(cx, prototype, args[5], FsResourceKind::Random, &request)) return false;
  auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(request); });
  auto* state = KandeloFsRequestStateOf(cx, request); if (!state) return false;
  state->limit = size; state->flags = int(offset);state->ioBacking = std::move(backing);
  JS::SetReservedSlot(request, FsRequestBuffers, args[2]);
  // The resource exists when constructed, before ondone is assigned/run called.
  if (!KandeloInitializeFsResource(cx, request)) return false;
  abandon.release();args.rval().setObject(*request);return true;
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
  if (!state->ioBacking) { JS_ReportErrorASCII(cx, "RandomBytesJob has no original allocation capability");return false; }
  void* body = js_malloc(sizeof(KandeloRandomWork));if (!body) { JS_ReportOutOfMemory(cx);return false; }
  KandeloRandomWork* work;
  try {
    work = new(body) KandeloRandomWork(cx, owner.get(), uint32_t(state->flags), size_t(state->limit), std::move(state->ioBacking));
  } catch (...) { js_free(body);throw; }
  auto dispose = mozilla::MakeScopeExit([&] { if (work) js_delete(work); });
  // Already initialized by construction: dispatch must not emit a second init.
  state->dispatched = true;
  if (!queue->Submit(work)) { JS_ReportErrorASCII(cx, "Crypto work queue closing"); return false; }
  work = nullptr;abandon.release();args.rval().setUndefined();return true;
}
}  // namespace
