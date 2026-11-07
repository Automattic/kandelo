/* Actual password-KDF jobs over the common guest work/resource owners.
 * Native worker threads touch owned native bytes only, never JS or GC roots. */
#include "kandelo-node-kdf-operations.h"
#include "kandelo-node-hkdf-operations.h"
namespace {
static bool KandeloNativeArgon2Supported(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  args.rval().setBoolean(kandelo::crypto::Argon2Supported()); return true;
}
static bool KandeloKdfPacket(JSContext* cx, bool failed, HandleValue value, MutableHandleValue result) {
  RootedObject packet(cx, JS_NewPlainObject(cx));
  if (!packet || !JS_DefineProperty(cx, packet, failed ? "error" : "value", value, JSPROP_ENUMERATE)) return false;
  result.setObject(*packet); return true;
}
static bool KandeloKdfError(JSContext* cx, const kandelo::crypto::Error& error,
                            MutableHandleValue result, const char* name = "Error", bool constructor = false) {
  const JSExnType type=strcmp(name,"TypeError")==0?JSEXN_TYPEERR:
      strcmp(name,"RangeError")==0?JSEXN_RANGEERR:JSEXN_ERR;
  return KandeloDigestError(cx,error,result,type,constructor);
}
static bool KandeloKdfConstructorError(JSContext* cx, const kandelo::crypto::KdfError& error,
                                       MutableHandleValue result) {
  RootedValue record(cx);
  const char* name = error.type == kandelo::crypto::KdfError::Type::TypeError ? "TypeError" :
      error.type == kandelo::crypto::KdfError::Type::RangeError ? "RangeError" : "Error";
  return KandeloKdfError(cx, error, &record, name, true) && KandeloKdfPacket(cx, true, record, result);
}
static bool KandeloKdfInput(JSContext* cx, HandleValue input, kandelo::crypto::Bytes* result, bool copy,
                             const char* sizeMessage = "KDF input is too large") {
  KandeloCryptoByteSource source(cx);
  if (!source.Init(input)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "KDF requires real byte storage");return false;
  }
  bool tooBig = false;
  const bool accepted = source.WithBytes([&](SharedMem<uint8_t*> data, size_t length) {
    if (length > INT_MAX) { tooBig = true;return false; }
    if (copy) KandeloCryptoCopy(data, length, result);
    return true;
  });
  if (tooBig) throw kandelo::crypto::KdfError(sizeMessage, "ERR_OUT_OF_RANGE", kandelo::crypto::KdfError::Type::RangeError);
  if (!accepted && !JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "KDF buffer has no backing data");
  return accepted;
}
static bool KandeloKdfResult(JSContext* cx, const kandelo::crypto::Bytes& bytes,
                             const kandelo::crypto::Error* error, MutableHandleValue result) {
  JS::RootedValueArray<2> entries(cx);
  if (error) {
    if (!KandeloKdfError(cx, *error, entries[0])) return false;
  } else {
    RootedObject view(cx, KandeloNewUint8ArrayCopy(cx, bytes.value.data(), bytes.value.size()));
    if (!view) return false;
    bool shared;
    RootedObject buffer(cx, JS_GetArrayBufferViewBuffer(cx, view, &shared));
    if (!buffer) return false;
    entries[1].setObject(*buffer);
  }
  RootedObject array(cx, JS::NewArrayObject(cx, entries));
  if (!array) return false;
  result.setObject(*array); return true;
}
struct KandeloKdfWork final : KandeloFsWork {
  std::unique_ptr<kandelo::crypto::KdfOperation> config;
  kandelo::crypto::Bytes bytes;
  std::unique_ptr<kandelo::crypto::Error> error;
  size_t associated;
  KandeloKdfWork(JSContext* cx, JSObject* owner, std::unique_ptr<kandelo::crypto::KdfOperation> config)
      : KandeloFsWork(cx, owner, -1, 0, Operation::FileRead), config(std::move(config)),
        associated(sizeof(*this) - sizeof(KandeloFsWork) + this->config->ConfigBytes() +
            this->config->InputBytes() + this->config->OutputBytes()) {
    workClass = WorkClass::Cpu;
    JS::AddAssociatedMemory(this->owner, associated, JS::MemoryUse::Embedding3);
  }
  ~KandeloKdfWork() override { JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3); }
  const char* Syscall() const override {
    return config->Name();
  }
  void Run() override {
    try { auto output = config->Derive(); bytes.value.swap(output.value); }
    catch (const kandelo::crypto::Error& failure) { error = std::make_unique<kandelo::crypto::Error>(failure); }
    performed = true;
  }
  bool PrepareResult(JSContext* cx) override {
    RootedValue result(cx);
    if (!KandeloKdfResult(cx, bytes, error.get(), &result)) return false;
    JS::SetReservedSlot(owner, FsRequestResult, result); return true;
  }
  bool ResultValue(JSContext*, MutableHandleValue value) override {
    value.set(JS::GetReservedSlot(owner, FsRequestResult)); return true;
  }
  bool Complete(JSContext* cx) override {
    // The target suppresses callbacks for canceled crypto jobs.
    if (failure == Failure::Cancelled) { Cancel(cx); return true; }
    return KandeloFsWork::Complete(cx);
  }
};
static bool KandeloHkdfSyncInputs(JSContext* cx, HandleObject owner, KandeloFsRequestState* state) {
  auto* config = static_cast<kandelo::crypto::HkdfOperation*>(state->kdf.get());
  RootedObject inputs(cx, &JS::GetReservedSlot(owner, FsRequestBuffers).toObject());
  RootedValue key(cx), salt(cx), info(cx);
  kandelo::crypto::Bytes keyBytes, saltBytes, infoBytes;
  if (!JS_GetElement(cx, inputs, 0, &key) || !JS_GetElement(cx, inputs, 1, &salt) ||
      !JS_GetElement(cx, inputs, 2, &info) ||
      (!config->keyFromHandle && !KandeloKdfInput(cx, key, &keyBytes, true, "key is too big")) ||
      !KandeloKdfInput(cx, salt, &saltBytes, true, "salt is too big") ||
      !KandeloKdfInput(cx, info, &infoBytes, true, "info is too big")) return false;
  const uint64_t size = uint64_t(config->keyFromHandle ? config->key.value.size() : keyBytes.value.size()) +
      saltBytes.value.size() + infoBytes.value.size() + config->ConfigBytes();
  if (size > SIZE_MAX) { JS_ReportOutOfMemory(cx); return false; }
  JS::RemoveAssociatedMemory(owner, state->kdfBytes, JS::MemoryUse::Embedding3);
  if (!config->keyFromHandle) config->key.value.swap(keyBytes.value);
  config->salt.value.swap(saltBytes.value); config->info.value.swap(infoBytes.value);
  state->kdfBytes = size;
  JS::AddAssociatedMemory(owner, state->kdfBytes, JS::MemoryUse::Embedding3);
  return true;
}
static bool KandeloCreateHkdfJob(JSContext* cx, const CallArgs& args, int64_t mode) {
  auto config = std::make_unique<kandelo::crypto::HkdfOperation>();
  RootedObject parameters(cx, &args[6].toObject());
  RootedValue digest(cx), info(cx), length(cx);
  if (!JS_GetElement(cx, parameters, 0, &digest) || !digest.isString() ||
      !JS_GetElement(cx, parameters, 1, &info) || !JS_GetElement(cx, parameters, 2, &length)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Invalid HKDF parameters"); return false;
  }
  RootedString digestName(cx, digest.toString());
  JS::UniqueChars name = JS_EncodeStringToUTF8(cx, digestName); if (!name) return false;
  config->SetDigest(name.get());
  if (KandeloKeyIs(cx, args.get(4), &KandeloKeyHandleClass)) {
    RootedObject handle(cx, KandeloKeyUnwrap(cx, args.get(4)));
    const auto* material = KandeloKeyMaterial(handle);
    if (!material || !material->isSecret || KandeloKeyRole(handle) != 0)
      throw kandelo::crypto::KdfError("Invalid key object type, expected secret",
          "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", kandelo::crypto::KdfError::Type::TypeError);
    config->keyFromHandle = true;
    const auto* bytes = material->secret.get<const unsigned char>();
    if (material->secret.size()) config->key.value.assign(bytes, bytes + material->secret.size());
  } else if (!KandeloKdfInput(cx, args.get(4), &config->key, mode == 0, "key is too big")) return false;
  if (!KandeloKdfInput(cx, args.get(5), &config->salt, mode == 0, "salt is too big") ||
      !KandeloKdfInput(cx, info, &config->info, mode == 0, "info is too big")) return false;
  int64_t size;
  if (!KandeloFsInteger(cx, length, 0, UINT32_MAX, &size)) return false;
  config->length = uint32_t(size); config->CheckLength();
  if (config->InputBytes() + config->OutputBytes() + sizeof(KandeloKdfWork) + config->ConfigBytes() > SIZE_MAX) {
    JS_ReportOutOfMemory(cx); return false;
  }
  RootedObject prototype(cx, &args[0].toObject()), request(cx);
  if (!KandeloCreateFsResource(cx, prototype, args[1], FsResourceKind::Hkdf, &request)) return false;
  auto* state = KandeloFsRequestStateOf(cx, request); if (!state) return false;
  state->flags = int(mode); state->kdfBytes = config->ConfigBytes() + config->InputBytes();
  state->kdf = std::move(config);
  JS::AddAssociatedMemory(request, state->kdfBytes, JS::MemoryUse::Embedding3);
  if (mode == 1) {
    JS::RootedValueArray<3> inputs(cx); inputs[0].set(args[4]); inputs[1].set(args[5]); inputs[2].set(info);
    RootedObject array(cx, JS::NewArrayObject(cx, inputs)); if (!array) return false;
    JS::SetReservedSlot(request, FsRequestBuffers, ObjectValue(*array));
  }
  // Input snapshots, digest/length checks and real native key material precede
  // async init. Workers only receive this owned native configuration.
  if (!KandeloInitializeFsResource(cx, request)) return false;
  RootedValue result(cx, ObjectValue(*request));
  return KandeloKdfPacket(cx, false, result, args.rval());
}
static bool KandeloNativeCreateKdfJob(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  int64_t mode;
  if (!args.get(0).isObject() || !args.get(1).isObject() || !JS::IsCallable(&args[1].toObject()) ||
      !KandeloFsInteger(cx, args.get(2), 0, 1, &mode) || !args.get(3).isString() || !args.get(6).isObject()) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "KDF requires prototype/callback/mode/options");
    return false;
  }
  RootedString text(cx, args[3].toString());
  JS::UniqueChars algorithm = JS_EncodeStringToUTF8(cx, text); if (!algorithm) return false;
  if (strcmp(algorithm.get(), "hkdf") == 0) {
    try { return KandeloCreateHkdfJob(cx, args, mode); }
    catch (const kandelo::crypto::KdfError& error) { return KandeloKdfConstructorError(cx, error, args.rval()); }
  }
  const bool pbkdf2 = strcmp(algorithm.get(), "pbkdf2") == 0;
  const bool argon2 = strcmp(algorithm.get(), "argon2") == 0;
  if (!pbkdf2 && !argon2 && strcmp(algorithm.get(), "scrypt") != 0) { JS_ReportErrorASCII(cx, "Unknown KDF algorithm"); return false; }
  try {
    using Config = kandelo::crypto::KdfConfig;
    auto config = std::make_unique<Config>(pbkdf2 ? Config::Algorithm::Pbkdf2 :
        argon2 ? Config::Algorithm::Argon2 : Config::Algorithm::Scrypt);
    if (!KandeloKdfInput(cx, args[4], &config->password, mode == 0, argon2 ? "pass is too large" : "KDF input is too large") ||
        !KandeloKdfInput(cx, args[5], &config->salt, mode == 0, argon2 ? "salt is too large" : "KDF input is too large")) return false;
    RootedObject parameters(cx, &args[6].toObject()); RootedValue value(cx);
    auto number = [&](uint32_t index, int64_t maximum, int64_t* result) {
      return JS_GetElement(cx, parameters, index, &value) && KandeloFsInteger(cx, value, 0, maximum, result);
    };
    int64_t length, first, second, third, memory;
    RootedValue secret(cx), associatedData(cx);
    if (pbkdf2) {
      if (!number(0, INT_MAX, &first) || first == 0 || !number(1, INT_MAX, &length) ||
          !JS_GetElement(cx, parameters, 2, &value) || !value.isString()) {
        if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Invalid PBKDF2 parameters"); return false;
      }
      text = value.toString(); JS::UniqueChars digest = JS_EncodeStringToUTF8(cx, text); if (!digest) return false;
      config->iterations = uint32_t(first); config->SetDigest(digest.get());
    } else if (argon2) {
      if (!number(0, UINT32_MAX, &first) || !number(1, UINT32_MAX, &length) ||
          !number(2, UINT32_MAX, &memory) || !number(3, UINT32_MAX, &second) ||
          !JS_GetElement(cx, parameters, 4, &secret) || !JS_GetElement(cx, parameters, 5, &associatedData) ||
          !number(6, UINT32_MAX, &third)) return false;
      config->lanes = uint32_t(first); config->memory = uint32_t(memory);
      config->passes = uint32_t(second); config->type = uint32_t(third);
      if (!KandeloKdfInput(cx, secret, &config->secret, mode == 0, "secret is too large") ||
          !KandeloKdfInput(cx, associatedData, &config->associatedData, mode == 0, "ad is too large")) return false;
    } else {
      if (!number(0, UINT32_MAX, &first) || !number(1, UINT32_MAX, &second) ||
          !number(2, UINT32_MAX, &third) || !number(3, 9007199254740991LL, &memory) ||
          !number(4, INT_MAX, &length)) return false;
      config->N = uint32_t(first); config->r = uint32_t(second); config->p = uint32_t(third);
      config->maxmem = uint64_t(memory); config->CheckScrypt();
    }
    config->length = uint32_t(length);
    if (uint64_t(config->InputBytes()) + config->length + sizeof(KandeloKdfWork) + sizeof(Config) > SIZE_MAX) {
      JS_ReportOutOfMemory(cx); return false;
    }
    RootedObject prototype(cx, &args[0].toObject()), request(cx);
    if (!KandeloCreateFsResource(cx, prototype, args[1], pbkdf2 ? FsResourceKind::Pbkdf2 :
        argon2 ? FsResourceKind::Argon2 : FsResourceKind::Scrypt, &request)) return false;
    auto* state = KandeloFsRequestStateOf(cx, request); if (!state) return false;
    state->flags = int(mode); state->kdfBytes = sizeof(Config) + config->InputBytes();
    state->kdf = std::move(config);
    JS::AddAssociatedMemory(request, state->kdfBytes, JS::MemoryUse::Embedding3);
    if (mode == 1) {
      JS::RootedValueArray<4> inputs(cx); inputs[0].set(args[4]); inputs[1].set(args[5]);
      inputs[2].set(secret); inputs[3].set(associatedData);
      RootedObject array(cx, JS::NewArrayObject(cx, inputs)); if (!array) return false;
      JS::SetReservedSlot(request, FsRequestBuffers, ObjectValue(*array));
    }
    // Config validation and async snapshots precede init, as in CryptoJob::New.
    if (!KandeloInitializeFsResource(cx, request)) return false;
    RootedValue result(cx, ObjectValue(*request));
    return KandeloKdfPacket(cx, false, result, args.rval());
  } catch (const kandelo::crypto::KdfError& error) { return KandeloKdfConstructorError(cx, error, args.rval()); }
}
static bool KandeloNativeRunKdfJob(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) { JS_ReportErrorASCII(cx, "KDF job receiver required"); return false; }
  RootedObject owner(cx, &args[0].toObject());
  auto* state = KandeloFsRequestStateOf(cx, owner);
  if (!state || (state->kind != FsResourceKind::Pbkdf2 && state->kind != FsResourceKind::Scrypt && state->kind != FsResourceKind::Argon2 && state->kind != FsResourceKind::Hkdf) ||
      !state->kdf || state->retired || state->dispatched) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "KDF job is not dispatchable"); return false;
  }
  try {
    RootedValue result(cx);
    if (state->flags == 1) {
      if (state->kind == FsResourceKind::Hkdf) {
        if (!KandeloHkdfSyncInputs(cx, owner, state)) return false;
      } else {
        auto* config = static_cast<kandelo::crypto::KdfConfig*>(state->kdf.get());
        // Sync inputs remain live through init hooks. Read their actual storage
        // at run(), before entering OpenSSL; no pointer survives JS reentry.
        RootedObject inputs(cx, &JS::GetReservedSlot(owner, FsRequestBuffers).toObject());
        RootedValue password(cx), salt(cx);
        kandelo::crypto::Bytes passBytes, saltBytes, secretBytes, adBytes;
        if (!JS_GetElement(cx, inputs, 0, &password) || !JS_GetElement(cx, inputs, 1, &salt) ||
            !KandeloKdfInput(cx, password, &passBytes, true, state->kind == FsResourceKind::Argon2 ? "pass is too large" : "KDF input is too large") ||
            !KandeloKdfInput(cx, salt, &saltBytes, true, state->kind == FsResourceKind::Argon2 ? "salt is too large" : "KDF input is too large")) return false;
        if (state->kind == FsResourceKind::Argon2) {
          RootedValue secret(cx), ad(cx);
          if (!JS_GetElement(cx, inputs, 2, &secret) || !JS_GetElement(cx, inputs, 3, &ad) ||
              !KandeloKdfInput(cx, secret, &secretBytes, true, "secret is too large") || !KandeloKdfInput(cx, ad, &adBytes, true, "ad is too large")) return false;
        }
        if (uint64_t(passBytes.value.size()) + saltBytes.value.size() + secretBytes.value.size() + adBytes.value.size() +
            sizeof(kandelo::crypto::KdfConfig) > SIZE_MAX) { JS_ReportOutOfMemory(cx); return false; }
        JS::RemoveAssociatedMemory(owner, state->kdfBytes, JS::MemoryUse::Embedding3);
        config->password.value.swap(passBytes.value); config->salt.value.swap(saltBytes.value);
        config->secret.value.swap(secretBytes.value); config->associatedData.value.swap(adBytes.value);
        state->kdfBytes = sizeof(kandelo::crypto::KdfConfig) + state->kdf->InputBytes();
        JS::AddAssociatedMemory(owner, state->kdfBytes, JS::MemoryUse::Embedding3);
      }
      kandelo::crypto::Bytes bytes; std::unique_ptr<kandelo::crypto::Error> error;
      try { auto derived = state->kdf->Derive(); bytes.value.swap(derived.value); }
      catch (const kandelo::crypto::Error& failure) { error = std::make_unique<kandelo::crypto::Error>(failure); }
      if (!KandeloKdfResult(cx, bytes, error.get(), &result)) return false;
    } else {
      auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(owner); });
      auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
      auto config = std::move(state->kdf);
      JS::RemoveAssociatedMemory(owner, state->kdfBytes, JS::MemoryUse::Embedding3); state->kdfBytes = 0;
      auto* work = js_new<KandeloKdfWork>(cx, owner.get(), std::move(config));
      if (!work) { JS_ReportOutOfMemory(cx); return false; }
      state->dispatched = true;
      if (!queue->Submit(work)) { js_delete(work); JS_ReportErrorASCII(cx, "KDF work queue closing"); return false; }
      abandon.release();
    }
    return KandeloKdfPacket(cx, false, result, args.rval());
  } catch (const kandelo::crypto::KdfError& error) { return KandeloKdfConstructorError(cx, error, args.rval()); }
}
}  // namespace
