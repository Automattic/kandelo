#include "kandelo-node-signature-job-operations.h"
namespace {
static bool KandeloSignInput(JSContext* cx, HandleValue value, size_t maximum,
                              const char* message, bool copy, kandelo::crypto::Bytes* bytes,
                              JS::KandeloBacking::SpanRef* retained) {
  KandeloCryptoByteSource source(cx);
  if (!source.Init(value)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "SignJob requires actual buffer storage");
    return false;
  }
  if (source.Length() > maximum) kandelo::crypto::SignatureState::Code("ERR_OUT_OF_RANGE", message);
  if (!copy) { *retained = source.Capture(); return bool(*retained); }
  const bool accepted = source.WithBytes([&](SharedMem<uint8_t*> data, size_t length) {
    KandeloCryptoCopy(data, length, bytes); return true;
  });
  if (!accepted && !JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "SignJob input has no backing allocation");
  return accepted;
}
static void KandeloSignCopy(const JS::KandeloBacking::SpanRef& source, kandelo::crypto::Bytes* bytes) {
  if (!source) return;
  KandeloCryptoCopy(source->Shared() ? SharedMem<uint8_t*>::shared(source->Data()) :
      SharedMem<uint8_t*>::unshared(source->Data()), source->Length(), bytes);
}
static bool KandeloSignResult(JSContext* cx, bool verify, bool verified,
                               const kandelo::crypto::Bytes& bytes,
                               const kandelo::crypto::Error* error, MutableHandleValue output) {
  JS::RootedValueArray<2> entries(cx);
  if (error) { if (!KandeloDigestError(cx, *error, entries[0])) return false; }
  else if (verify) entries[1].setBoolean(verified);
  else {
    RootedObject view(cx, KandeloNewUint8ArrayCopy(cx, bytes.value.data(), bytes.value.size()));
    if (!view) return false;
    bool shared; RootedObject buffer(cx, JS_GetArrayBufferViewBuffer(cx, view, &shared));
    if (!buffer) return false;
    entries[1].setObject(*buffer);
  }
  RootedObject result(cx, JS::NewArrayObject(cx, entries));
  if (!result) return false;
  output.setObject(*result); return true;
}
struct KandeloSignWork final : KandeloFsWork {
  std::unique_ptr<kandelo::crypto::SignatureJobOperation> config;
  kandelo::crypto::Bytes bytes;
  std::unique_ptr<kandelo::crypto::Error> error;
  size_t associated, outputBytes = 0;
  bool verified = false;
  KandeloSignWork(JSContext* cx, JSObject* request,
                   std::unique_ptr<kandelo::crypto::SignatureJobOperation> config)
      : KandeloFsWork(cx, request, -1, 0, Operation::FileRead), config(std::move(config)),
        associated(sizeof(*this) - sizeof(KandeloFsWork) + this->config->AccountedBytes()) {
    workClass = WorkClass::Cpu;
    JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloSignWork() override {
    JS::RemoveAssociatedMemory(owner, associated + outputBytes, JS::MemoryUse::Embedding3);
  }
  const char* Syscall() const override { return config->verify ? "verify" : "sign"; }
  void Run() override { error = config->Run(&bytes, &verified); performed = true; }
  bool PrepareResult(JSContext* cx) override {
    // Worker-native storage is charged on the owning JS thread before result
    // conversion/callback, by actual capacity rather than signature length.
    outputBytes = bytes.value.capacity();
    JS::AddAssociatedMemory(owner, outputBytes, JS::MemoryUse::Embedding3);
    RootedValue packet(cx);
    if (!KandeloSignResult(cx, config->verify, verified, bytes, error.get(), &packet)) {
      // CryptoJob catches a catchable ToResult conversion/decorator exception
      // and supplies that exact exception to ondone on the actual job owner.
      // Uncatchable termination/OOM remains an actual completion failure.
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
  bool ResultValue(JSContext*, MutableHandleValue result) override {
    result.set(JS::GetReservedSlot(owner, FsRequestResult)); return true;
  }
  bool Complete(JSContext* cx) override {
    if (failure == Failure::Cancelled) { Cancel(cx); return true; }
    return KandeloFsWork::Complete(cx);
  }
};
static bool KandeloCreateSignatureJob(JSContext* cx, const CallArgs& args, MutableHandleValue output) {
  using State = kandelo::crypto::SignatureState;
  using Config = kandelo::crypto::SignatureJobOperation;
  int64_t mode, operation;
  if (!args.get(1).isObject() || !args.get(2).isObject() || !JS::IsCallable(&args[2].toObject()) ||
      !KandeloFsInteger(cx, args.get(3), 0, 1, &mode) || !KandeloFsInteger(cx, args.get(4), 0, 1, &operation)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "SignJob requires prototype, completion and modes");
    return false;
  }
  auto config = std::make_unique<Config>(); config->verify = operation == 1;
  RootedObject keyHandle(cx);
  RootedValue materialOwner(cx);
  std::unique_ptr<kandelo::crypto::KeyMaterial> parsed;
  const kandelo::crypto::KeyMaterial* material = nullptr;
  if (!KandeloSignatureKey(cx, args, 5, config->verify, &keyHandle, &materialOwner, parsed, material)) return false;
  config->RetainKey(material->asymmetric);
  JS::KandeloBacking::SpanRef data, context, signature;
  const bool copy = mode == 0;
  if (!KandeloSignInput(cx, args.get(10), INT_MAX, "data is too big", copy, &config->data, &data)) return false;
  if (args.get(11).isString()) {
    std::string name; if (!KandeloKeyString(cx, args.get(11), &name)) return false;
    config->SetDigest(name);
  }
  int64_t number;
  if (!args.get(12).isUndefined()) {
    if (!KandeloFsInteger(cx, args.get(12), INT_MIN, INT_MAX, &number)) return false;
    config->salt = int(number);
  }
  // AdditionalConfig admits uint32 padding only; negative public int options
  // do not set its padding flag and therefore retain the actual key default.
  if (args.get(13).isNumber() && args[13].toNumber() >= 0) {
    if (!KandeloFsInteger(cx, args.get(13), 0, INT_MAX, &number)) return false;
    config->padding = int(number);
  }
  if (!KandeloFsInteger(cx, args.get(14), 0, 1, &number)) return false;
  config->p1363 = number == 1;
  if (!args.get(15).isUndefined() &&
      !KandeloSignInput(cx, args.get(15), 255, "context string must be at most 255 bytes", copy, &config->context, &context)) return false;
  if (config->verify) {
    kandelo::crypto::Bytes converted;
    if (!KandeloSignInput(cx, args.get(16), INT_MAX, "signature is too big", copy || config->UseP1363(),
        config->UseP1363() ? &converted : &config->signature, &signature)) return false;
    if (config->UseP1363()) {
      static const unsigned char empty = 0;
      config->signature.value = Config::ConvertSignature(config->key,
          converted.value.empty() ? &empty : converted.value.data(), converted.value.size());
    }
  }
  if (uint64_t(config->AccountedBytes()) + sizeof(KandeloSignWork) > SIZE_MAX) { JS_ReportOutOfMemory(cx); return false; }
  RootedObject prototype(cx, KandeloKeyUnwrap(cx, args.get(1)));
  if (!prototype) return false;
  RootedValue completion(cx, args.get(2));
  {
  JSAutoRealm realm(cx, prototype);
  if (!JS_WrapValue(cx, &completion)) return false;
  RootedObject request(cx);
  if (!KandeloCreateFsResource(cx, prototype, completion, FsResourceKind::Sign, &request)) return false;
  auto* state = KandeloFsRequestStateOf(cx, request); if (!state) return false;
  state->flags = int(mode); state->signBytes = config->AccountedBytes(); state->signJob = std::move(config);
  state->signData = std::move(data); state->signSignature = std::move(signature); state->signContext = std::move(context);
  JS::AddAssociatedMemory(request, state->signBytes, JS::MemoryUse::Embedding3);
  auto failed = mozilla::MakeScopeExit([&] {
    JS::RemoveAssociatedMemory(request, state->signBytes, JS::MemoryUse::Embedding3); state->signBytes = 0;
    state->signJob.reset(); KandeloFsAbandonRequest(request);
  });
  // Key ownership, input snapshots/retained original allocations and option
  // checks are complete before the genuine SIGNREQUEST async init hook.
  if (!KandeloInitializeFsResource(cx, request)) return false;
  output.setObject(*request); failed.release();
  }
  return JS_WrapValue(cx, output);
}
static bool KandeloRunSignatureJob(JSContext* cx, const CallArgs& args, MutableHandleValue output) {
  RootedObject owner(cx, KandeloKeyUnwrap(cx, args.get(1)));
  if (!owner) { if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "SignJob receiver required"); return false; }
  const bool accepted = [&] {
  JSAutoRealm realm(cx, owner);
  auto* state = KandeloFsRequestStateOf(cx, owner);
  if (!state || state->kind != FsResourceKind::Sign || !state->signJob || state->retired || state->dispatched) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "SignJob is not dispatchable"); return false;
  }
  if (state->flags == 1) {
    auto* config = state->signJob.get();
    KandeloSignCopy(state->signData, &config->data); KandeloSignCopy(state->signSignature, &config->signature);
    KandeloSignCopy(state->signContext, &config->context);
    const auto actual = config->AccountedBytes();
    if (uint64_t(actual) > SIZE_MAX) { JS_ReportOutOfMemory(cx); return false; }
    JS::RemoveAssociatedMemory(owner, state->signBytes, JS::MemoryUse::Embedding3);
    state->signBytes = actual; JS::AddAssociatedMemory(owner, state->signBytes, JS::MemoryUse::Embedding3);
    kandelo::crypto::Bytes bytes; bool verified = false;
    auto error = config->Run(&bytes, &verified);
    return KandeloSignResult(cx, config->verify, verified, bytes, error.get(), output);
  }
  auto abandon = mozilla::MakeScopeExit([&] {
    if (state->signJob) {
      JS::RemoveAssociatedMemory(owner, state->signBytes, JS::MemoryUse::Embedding3); state->signBytes = 0;
      state->signJob.reset();
    }
    KandeloFsAbandonRequest(owner);
  });
  auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  auto config = std::move(state->signJob);
  JS::RemoveAssociatedMemory(owner, state->signBytes, JS::MemoryUse::Embedding3); state->signBytes = 0;
  auto* work = js_new<KandeloSignWork>(cx, owner.get(), std::move(config));
  if (!work) { JS_ReportOutOfMemory(cx); return false; }
  state->dispatched = true;
  if (!queue->Submit(work)) { js_delete(work); JS_ReportErrorASCII(cx, "Signature work queue closing"); return false; }
  output.setUndefined(); abandon.release(); return true;
  }();
  return accepted && JS_WrapValue(cx, output);
}
}  // namespace
