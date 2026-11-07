/* Real secret-key generation over ncrypto/OpenSSL and the shared CPU queue.
 * Included after native-keys.cpp; worker code never touches JS values. */
#include "kandelo-node-secret-keygen-operations.h"
namespace {
static bool KandeloSecretKeyResult(JSContext* cx, HandleObject owner,
                                    std::unique_ptr<kandelo::crypto::KeyMaterial>& material,
                                    const kandelo::crypto::Error* error,
                                    MutableHandleValue output) {
  JS::RootedValueArray<2> entries(cx);
  if (error) {
    if (!KandeloDigestError(cx, *error, entries[0])) return false;
  } else {
    RootedValue prototypeValue(cx, JS::GetReservedSlot(owner, FsRequestBuffers));
    RootedObject prototype(cx, KandeloKeyUnwrap(cx, prototypeValue));
    if (!prototype || !material) {
      if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Secret key result has no actual owner/prototype");
      return false;
    }
    {
      JSAutoRealm realm(cx, prototype);
      RootedObject handle(cx, JS_NewObjectWithGivenProto(cx, &KandeloKeyHandleClass, prototype));
      if (!handle || !KandeloKeyOwn(cx, handle, 0, std::move(material))) return false;
      entries[1].setObject(*handle);
    }
    if (!JS_WrapValue(cx, entries[1])) return false;
  }
  RootedObject packet(cx, JS::NewArrayObject(cx, entries));
  if (!packet) return false;
  output.setObject(*packet); return true;
}
struct KandeloSecretKeyWork final : KandeloFsWork {
  uint32_t bits;
  std::unique_ptr<kandelo::crypto::KeyMaterial> material;
  std::unique_ptr<kandelo::crypto::Error> error;
  size_t associated;
  KandeloSecretKeyWork(JSContext* cx, JSObject* request, uint32_t bits)
      : KandeloFsWork(cx, request, -1, 0, Operation::FileRead), bits(bits),
        associated(sizeof(*this) - sizeof(KandeloFsWork)) {
    workClass = WorkClass::Cpu;
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloSecretKeyWork() override {
    JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  const char* Syscall() const override { return "generateKey"; }
  void Run() override {
    try { material = kandelo::crypto::GenerateSecretKey(bits); }
    catch (const kandelo::crypto::Error& failure) {
      error = std::make_unique<kandelo::crypto::Error>(failure);
    }
    performed = true;
  }
  bool PrepareResult(JSContext* cx) override {
    RootedValue packet(cx);
    // KeyOwn charges actual DataPointer requested storage on the JS thread as
    // ownership transfers into its GC owner. No JS allocator API runs on pool
    // threads; requested allocation length is not a claim about RSS.
    if (!KandeloSecretKeyResult(cx, owner, material, error.get(), &packet)) {
      if (!JS_IsExceptionPending(cx) || JS_IsThrowingOutOfMemory(cx)) return false;
      JS::RootedValueArray<2> entries(cx);
      if (!JS_GetPendingException(cx, entries[0])) return false;
      JS_ClearPendingException(cx);
      RootedObject array(cx, JS::NewArrayObject(cx, entries));
      if (!array) return false;
      packet.setObject(*array);
    }
    JS::SetReservedSlot(owner, FsRequestResult, packet); return true;
  }
  bool ResultValue(JSContext*, MutableHandleValue output) override {
    output.set(JS::GetReservedSlot(owner, FsRequestResult)); return true;
  }
  bool Complete(JSContext* cx) override {
    if (failure == Failure::Cancelled) { Cancel(cx); return true; }
    if (failure == Failure::OutOfMemory) {
      Cancel(cx); JS_ReportOutOfMemory(cx); return false;
    }
    return KandeloFsWork::Complete(cx);
  }
};
static bool KandeloCreateSecretKeyGen(JSContext* cx, const CallArgs& args,
                                      MutableHandleValue output,
                                      KandeloFsRequestPublication& publication) {
  int64_t mode, bits;
  if (!args.get(1).isObject() || !args.get(2).isObject() || !JS::IsCallable(&args[2].toObject()) ||
      !args.get(5).isObject() || !KandeloFsInteger(cx, args.get(3), 0, 1, &mode) ||
      !KandeloFsInteger(cx, args.get(4), 0, UINT32_MAX, &bits)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "SecretKeyGenJob requires real prototypes/completion/mode/length");
    return false;
  }
  RootedObject prototype(cx, KandeloKeyUnwrap(cx, args.get(1)));
  RootedObject keyPrototype(cx, KandeloKeyUnwrap(cx, args.get(5)));
  if (!prototype || !keyPrototype) return false;
  RootedValue completion(cx, args.get(2)), retainedPrototype(cx, ObjectValue(*keyPrototype));
  RootedObject request(cx);
  {
    JSAutoRealm realm(cx, prototype);
    if (!JS_WrapValue(cx, &completion) || !JS_WrapValue(cx, &retainedPrototype)) return false;
    if (!KandeloCreateFsResource(cx, prototype, completion, FsResourceKind::Keygen, &request)) return false;
    publication.Register(request);
    auto* state = KandeloFsRequestStateOf(cx, request); if (!state) return false;
    state->flags = int(mode); state->limit = uint32_t(bits);
    JS::SetReservedSlot(request, FsRequestBuffers, retainedPrototype);
    if (!KandeloInitializeFsResource(cx, request)) return false;
    output.setObject(*request);
  }
  return JS_WrapValue(cx, output);
}
static bool KandeloRunSecretKeyGen(JSContext* cx, const CallArgs& args,
                                   MutableHandleValue output) {
  RootedObject owner(cx, KandeloKeyUnwrap(cx, args.get(1)));
  if (!owner) { if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "SecretKeyGenJob receiver required"); return false; }
  const bool accepted = [&] {
    JSAutoRealm realm(cx, owner);
    auto* state = KandeloFsRequestStateOf(cx, owner);
    if (!state || state->kind != FsResourceKind::Keygen || state->retired || state->dispatched) {
      if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "SecretKeyGenJob is not dispatchable"); return false;
    }
    if (state->flags == 1) {
      std::unique_ptr<kandelo::crypto::KeyMaterial> material;
      std::unique_ptr<kandelo::crypto::Error> error;
      try { material = kandelo::crypto::GenerateSecretKey(uint32_t(state->limit)); }
      catch (const kandelo::crypto::Error& failure) { error = std::make_unique<kandelo::crypto::Error>(failure); }
      return KandeloSecretKeyResult(cx, owner, material, error.get(), output);
    }
    auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(owner); });
    auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
    auto* work = js_new<KandeloSecretKeyWork>(cx, owner.get(), uint32_t(state->limit));
    if (!work) { JS_ReportOutOfMemory(cx); return false; }
    state->dispatched = true;
    if (!queue->Submit(work)) {
      js_delete(work); JS_ReportErrorASCII(cx, "Secret key work queue closing"); return false;
    }
    output.setUndefined(); abandon.release(); return true;
  }();
  return accepted && JS_WrapValue(cx, output);
}
}  // namespace
