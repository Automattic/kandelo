/* Native KEYPAIRGENREQUEST owner; included after native-keys.cpp.
 * Worker code owns only immutable native configuration/material. The existing
 * per-context CPU queue, publication transaction and callback scope own JS. */
#include "kandelo-node-keypair-operations.h"
namespace {
using KandeloPairOperation = kandelo::crypto::keypair::Operation;
using KandeloPairKind = kandelo::crypto::keypair::Kind;
static bool KandeloPairEncoding(JSContext* cx, const CallArgs& args, unsigned index,
                                ncrypto::EVPKeyPointer::AsymmetricKeyEncodingConfig* config) {
  using Key = ncrypto::EVPKeyPointer;
  int64_t number;
  config->output_key_object = args.get(index).isUndefined();
  if (config->output_key_object) {
    if (!args.get(index + 1).isUndefined()) {
      JS_ReportErrorASCII(cx, "Unencoded pair result requires undefined encoding"); return false;
    }
    return true;
  }
  if (!KandeloFsInteger(cx, args.get(index), int(Key::PKFormatType::DER),
                        int(Key::PKFormatType::RAW_SEED), &number)) return false;
  config->format = Key::PKFormatType(number);
  if (config->format == Key::PKFormatType::RAW_PUBLIC ||
      config->format == Key::PKFormatType::RAW_PRIVATE || config->format == Key::PKFormatType::RAW_SEED) {
    if (!args.get(index + 1).isNullOrUndefined()) {
      if (!KandeloFsInteger(cx, args.get(index + 1), INT_MIN, INT_MAX, &number)) return false;
      config->ec_point_form = int(number);
    }
  } else if (!args.get(index + 1).isNullOrUndefined()) {
    if (!KandeloFsInteger(cx, args.get(index + 1), 0, 3, &number)) return false;
    config->type = Key::PKEncodingType(number);
  } else if (config->format != Key::PKFormatType::JWK) {
    JS_ReportErrorASCII(cx, "Encoded pair result requires actual key encoding"); return false;
  }
  return true;
}
static bool KandeloPairCopy(JSContext* cx, HandleValue input, const char* tooBig,
                              kandelo::crypto::Bytes* bytes) {
  KandeloCryptoByteSource source(cx);
  if (!source.Init(input)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Pair configuration requires actual buffer storage");
    return false;
  }
  if (source.Length() > INT_MAX) throw kandelo::crypto::KeyError(tooBig, "ERR_OUT_OF_RANGE");
  const bool copied = source.WithBytes([&](SharedMem<uint8_t*> data, size_t length) {
    KandeloCryptoCopy(data, length, bytes); return true;
  });
  if (!copied && !JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Pair input has no backing allocation");
  return copied;
}
static bool KandeloPairConfig(JSContext* cx, const CallArgs& args, KandeloPairOperation* config) {
  using namespace kandelo::crypto::keypair;
  unsigned index = 6; int64_t number;
  auto integer = [&](int64_t minimum, int64_t maximum) {
    return KandeloFsInteger(cx, args.get(index++), minimum, maximum, &number);
  };
  auto string = [&](std::string* text) { return KandeloKeyString(cx, args.get(index++), text); };
  switch (config->kind) {
    case Kind::Rsa: {
      auto& params = std::get<RsaKeyPairGenConfig>(config->parameters).params;
      if (!integer(0, 2)) return false; params.variant = RSAKeyVariant(number);
      if (!integer(0, UINT32_MAX)) return false; params.modulus_bits = unsigned(number);
      if (!integer(0, UINT32_MAX)) return false; params.exponent = unsigned(number);
      if (params.variant == kKeyVariantRSA_PSS) {
        for (bool mgf1 : {false, true}) {
          if (!args.get(index).isUndefined()) {
            std::string name; if (!string(&name)) return false; config->SetRsaDigest(name, mgf1);
          } else ++index;
        }
        if (!args.get(index).isUndefined()) {
          if (!integer(INT_MIN, INT_MAX)) return false;
          if (number < 0) throw kandelo::crypto::KeyError("salt length is out of range", "ERR_OUT_OF_RANGE");
          params.saltlen = int(number);
        } else ++index;
      }
      break;
    }
    case Kind::Dsa: {
      auto& params = std::get<DsaKeyPairGenConfig>(config->parameters).params;
      if (!integer(0, UINT32_MAX)) return false; params.modulus_bits = unsigned(number);
      if (!integer(INT_MIN, INT_MAX)) return false; params.divisor_bits = int(number);
      break;
    }
    case Kind::Ec: {
      std::string name; if (!string(&name)) return false;
      if (args.get(index).isNullOrUndefined()) { number = OPENSSL_EC_NAMED_CURVE; ++index; }
      else if (!integer(INT_MIN, INT_MAX)) return false;
      config->SetCurve(name, int(number)); break;
    }
    case Kind::Dh: {
      auto& params = std::get<DhKeyPairGenConfig>(config->parameters).params;
      if (args.get(index).isString()) {
        std::string name; if (!string(&name)) return false; config->SetGroup(name);
      } else {
        if (args.get(index).isInt32()) {
          if (!integer(INT_MIN, INT_MAX)) return false;
          if (number < 0) throw kandelo::crypto::KeyError("Invalid prime size", "ERR_OUT_OF_RANGE");
          params.prime = int(number);
        } else {
          kandelo::crypto::Bytes bytes;
          if (!KandeloPairCopy(cx, args.get(index++), "prime is too big", &bytes)) return false;
          params.prime = ncrypto::BignumPointer(bytes.value.data(), bytes.value.size());
        }
        if (!integer(INT_MIN, INT_MAX)) return false; params.generator = unsigned(number);
      }
      break;
    }
    case Kind::Named: {
      std::string name; if (!string(&name)) return false; config->SetNamed(name); break;
    }
  }
  // Native trait configuration precedes encoding resolution and async init.
  if (!KandeloPairEncoding(cx, args, index, &config->publicEncoding) ||
      !KandeloPairEncoding(cx, args, index + 2, &config->privateEncoding)) return false;
  const unsigned cipherIndex = index + 4, passphraseIndex = index + 5;
  const auto format = config->privateEncoding.format;
  if (!config->privateEncoding.output_key_object &&
      format != ncrypto::EVPKeyPointer::PKFormatType::RAW_PRIVATE &&
      format != ncrypto::EVPKeyPointer::PKFormatType::RAW_SEED) {
    if (args.get(cipherIndex).isString()) {
      std::string name; if (!KandeloKeyString(cx, args.get(cipherIndex), &name)) return false;
      config->privateEncoding.cipher = ncrypto::Cipher::FromNameForKeyEncoding(name.c_str());
      if (!config->privateEncoding.cipher)
        throw kandelo::crypto::KeyError("Unknown cipher", "ERR_CRYPTO_UNKNOWN_CIPHER");
    }
    if (!args.get(passphraseIndex).isNullOrUndefined()) {
      kandelo::crypto::Bytes bytes;
      if (!KandeloPairCopy(cx, args.get(passphraseIndex), "passphrase is too big", &bytes)) return false;
      config->privateEncoding.passphrase = ncrypto::DataPointer::Copy({bytes.value.data(), bytes.value.size()});
      if (!*config->privateEncoding.passphrase && !bytes.value.empty()) throw std::bad_alloc();
    }
  }
  return true;
}
static bool KandeloPairBuffer(JSContext* cx, HandleObject request, const ncrypto::DataPointer& data,
                               MutableHandleValue output) {
  JS::RootedValueArray<1> bytes(cx);
  if (!KandeloKeyBytes(cx, data, bytes[0])) return false;
  RootedValue copy(cx, JS::GetReservedSlot(request, FsRequestCallback));
  // This is the captured private FastBuffer byte owner, not public Buffer.from.
  return JS_CallFunctionValue(cx, nullptr, copy, bytes, output);
}
static bool KandeloPairEncode(JSContext* cx, HandleObject request, HandleObject materialOwner,
                               KandeloPairOperation& config, bool privateKey,
                               MutableHandleValue output) {
  using Key = ncrypto::EVPKeyPointer;
  const int role = privateKey ? 2 : 1;
  const Key::AsymmetricKeyEncodingConfig& encoding = privateKey ?
      static_cast<const Key::AsymmetricKeyEncodingConfig&>(config.privateEncoding) : config.publicEncoding;
  auto* material = static_cast<kandelo::crypto::KeyMaterial*>(JS::GetReservedSlot(materialOwner, 0).toPrivate());
  if (encoding.output_key_object) {
    RootedValue prototypeValue(cx, JS::GetReservedSlot(request, FsRequestParent));
    RootedObject prototype(cx, KandeloKeyUnwrap(cx, prototypeValue)); if (!prototype) return false;
    RootedValue retained(cx, ObjectValue(*materialOwner));
    {
      JSAutoRealm realm(cx, prototype);
      if (!JS_WrapValue(cx, &retained)) return false;
      RootedObject handle(cx, JS_NewObjectWithGivenProto(cx, &KandeloKeyHandleClass, prototype));
      if (!handle) return false;
      JS::SetReservedSlot(handle, 0, retained); JS::SetReservedSlot(handle, 1, Int32Value(role));
      output.setObject(*handle);
    }
    return JS_WrapValue(cx, output);
  }
  if (encoding.format == Key::PKFormatType::JWK) {
    RootedObject object(cx, JS_NewPlainObject(cx));
    if (!object || !KandeloKeyExportJwk(cx, *material, role, object, false)) return false;
    output.setObject(*object); return true;
  }
  auto bytes = config.Serialize(*material, privateKey);
  if (encoding.format == Key::PKFormatType::PEM)
    return KandeloFsPathString(cx, bytes.get<const char>(), bytes.size(), output);
  return KandeloPairBuffer(cx, request, bytes, output);
}
static bool KandeloPairResult(JSContext* cx, HandleObject request, KandeloPairOperation& config,
                               std::unique_ptr<kandelo::crypto::KeyMaterial>& material,
                               const kandelo::crypto::Error* error, MutableHandleValue output) {
  JS::RootedValueArray<2> packet(cx);
  if (error) { if (!KandeloDigestError(cx, *error, packet[0])) return false; }
  else {
    MOZ_RELEASE_ASSERT(material);
    RootedObject retained(cx, JS_NewObject(cx, &KandeloKeyMaterialClass));
    if (!retained) return false;
    JS::AddAssociatedMemory(retained, material->AccountedBytes(), JS::MemoryUse::Embedding3);
    JS::SetReservedSlot(retained, 0, PrivateValue(material.release()));
    JS::RootedValueArray<2> keys(cx);
    if (!KandeloPairEncode(cx, request, retained, config, false, keys[0]) ||
        !KandeloPairEncode(cx, request, retained, config, true, keys[1])) return false;
    RootedObject result(cx, JS::NewArrayObject(cx, keys)); if (!result) return false;
    packet[1].setObject(*result);
  }
  RootedObject result(cx, JS::NewArrayObject(cx, packet)); if (!result) return false;
  output.setObject(*result); return true;
}
// Pinned KeyGenJob::ToResult catches ordinary encoding/decorator exceptions,
// before AsyncWrap reads ondone or enters its callback scope. OOM stays fatal.
static bool KandeloPairToResult(JSContext* cx, HandleObject request, KandeloPairOperation& config,
                                 std::unique_ptr<kandelo::crypto::KeyMaterial>& material,
                                 const kandelo::crypto::Error* failure, MutableHandleValue output) {
  // A failed-generation error's ToException is outside KeyGenJob's encoding
  // TryCatch. Preserve that failure as a direct throw (sync) or the generic
  // CryptoJob completion's one-argument exception path (async).
  if (failure) return KandeloPairResult(cx, request, config, material, failure, output);
  bool success;
  try { success = KandeloPairResult(cx, request, config, material, nullptr, output); }
  catch (const kandelo::crypto::Error& error) {
    success = KandeloPairResult(cx, request, config, material, &error, output);
  }
  if (success) return true;
  if (!JS_IsExceptionPending(cx) || JS_IsThrowingOutOfMemory(cx)) return false;
  JS::RootedValueArray<2> packet(cx);
  if (!JS_GetPendingException(cx, packet[0])) return false;
  JS_ClearPendingException(cx);
  RootedObject result(cx, JS::NewArrayObject(cx, packet)); if (!result) return false;
  output.setObject(*result); return true;
}
struct KandeloPairWork final : js::shell::KandeloNativeWork {
  JS::PersistentRootedObject owner;
  std::unique_ptr<KandeloPairOperation> config;
  std::unique_ptr<kandelo::crypto::KeyMaterial> material;
  std::unique_ptr<kandelo::crypto::Error> error;
  size_t associated;
  KandeloPairWork(JSContext* cx, JSObject* request, std::unique_ptr<KandeloPairOperation> config)
      : owner(cx, request), config(std::move(config)), associated(sizeof(*this) + this->config->AccountedBytes()) {
    workClass = WorkClass::Cpu;
    State()->work = this; JS::AddAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  KandeloFsRequestState* State() {
    return static_cast<KandeloFsRequestState*>(JS::GetReservedSlot(owner, FsRequestState).toPrivate());
  }
  ~KandeloPairWork() override {
    if (State()->work == this) State()->work = nullptr;
    JS::RemoveAssociatedMemory(owner, associated, JS::MemoryUse::Embedding3);
  }
  void Run() override {
    try { material = config->Generate(); }
    catch (const kandelo::crypto::Error& failure) { error = std::make_unique<kandelo::crypto::Error>(failure); }
  }
  void Cancel(JSContext*) override { KandeloFsAbandonRequest(owner); }
  bool CompleteImpl(JSContext* cx) {
    JSAutoRealm realm(cx, owner);
    auto retire = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(owner); });
    if (failure == Failure::Cancelled) return true;
    if (failure == Failure::OutOfMemory) { JS_ReportOutOfMemory(cx); return false; }
    if (failure == Failure::NativeException)
      error = std::make_unique<kandelo::crypto::Error>("Key generation job failed");
    RootedValue result(cx), callback(cx), frame(cx, JS::GetReservedSlot(owner, FsRequestFrame)), ignored(cx);
    bool singleException = false;
    if (!KandeloPairToResult(cx, owner, *config, material, error.get(), &result)) {
      if (!JS_IsExceptionPending(cx) || JS_IsThrowingOutOfMemory(cx) ||
          !JS_GetPendingException(cx, &result)) return false;
      JS_ClearPendingException(cx); singleException = true;
    }
    // Get exactly once before native:before, including the throwing getter and
    // non-function cases; this is AsyncWrap::MakeCallback(symbol) admission.
    if (!JS_GetProperty(cx, owner, "ondone", &callback)) return false;
    if (!callback.isObject() || !JS::IsCallable(&callback.toObject())) return true;
    JS::RootedValueArray<2> arguments(cx);
    if (singleException) arguments[0].set(result);
    else {
      RootedObject packet(cx, &result.toObject());
      if (!JS_GetElement(cx, packet, 0, arguments[0]) || !JS_GetElement(cx, packet, 1, arguments[1])) return false;
    }
    KandeloNativeCallbackScope scope(cx, owner, frame);
    if (!scope.Enter()) return scope.Stopped();
    const auto admitted = JS::HandleValueArray::subarray(arguments, 0, singleException ? 1 : 2);
    if (!scope.Call(callback, admitted, &ignored)) return scope.Fail();
    return scope.Close();
  }
  bool Complete(JSContext* cx) override {
    try { return CompleteImpl(cx); }
    catch (const std::bad_alloc&) {
      KandeloFsAbandonRequest(owner); JS_ReportOutOfMemory(cx); return false;
    }
  }
};
static bool KandeloCreatePairGen(JSContext* cx, const CallArgs& args, MutableHandleValue output,
                                 KandeloFsRequestPublication& publication) {
  int64_t kind, mode;
  if (!args.get(1).isObject() || !args.get(2).isObject() || !args.get(3).isObject() ||
      !JS::IsCallable(&args[3].toObject()) ||
      !KandeloFsInteger(cx, args.get(4), 0, 4, &kind) || !KandeloFsInteger(cx, args.get(5), 0, 1, &mode)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Pair generation requires genuine prototypes, byte owner and modes");
    return false;
  }
  auto config = std::make_unique<KandeloPairOperation>(KandeloPairKind(kind));
  if (!KandeloPairConfig(cx, args, config.get())) return false;
  RootedObject prototype(cx, KandeloKeyUnwrap(cx, args.get(1)));
  RootedObject keyPrototype(cx, KandeloKeyUnwrap(cx, args.get(2)));
  if (!prototype || !keyPrototype) return false;
  RootedValue copy(cx, args.get(3)), retainedPrototype(cx, ObjectValue(*keyPrototype));
  const JSClass* classes[] = {&KandeloRsaKeyPairGenRequestClass, &KandeloDsaKeyPairGenRequestClass,
      &KandeloEcKeyPairGenRequestClass, &KandeloDhKeyPairGenRequestClass, &KandeloNamedKeyPairGenRequestClass};
  {
    JSAutoRealm realm(cx, prototype);
    if (!JS_WrapValue(cx, &copy) || !JS_WrapValue(cx, &retainedPrototype)) return false;
    RootedObject request(cx);
    if (!KandeloCreateFsResource(cx, prototype, copy, FsResourceKind::KeyPairgen, &request, classes[kind])) return false;
    publication.Register(request);
    auto* state = KandeloFsRequestStateOf(cx, request); if (!state) return false;
    state->flags = int(mode); state->pairBytes = config->AccountedBytes(); state->pairJob = std::move(config);
    JS::AddAssociatedMemory(request, state->pairBytes, JS::MemoryUse::Embedding3);
    JS::SetReservedSlot(request, FsRequestParent, retainedPrototype);
    if (!KandeloInitializeFsResource(cx, request)) return false;
    output.setObject(*request);
  }
  return JS_WrapValue(cx, output);
}
static bool KandeloRunPairGen(JSContext* cx, const CallArgs& args, MutableHandleValue output) {
  RootedObject owner(cx, KandeloKeyUnwrap(cx, args.get(1)));
  if (!owner) { if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Pair generation receiver required"); return false; }
  const bool success = [&] {
    JSAutoRealm realm(cx, owner);
    auto* state = KandeloFsRequestStateOf(cx, owner);
    if (!state || state->kind != FsResourceKind::KeyPairgen || !state->pairJob || state->dispatched || state->retired) {
      if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Pair generation job is not dispatchable"); return false;
    }
    if (state->flags == 1) {
      std::unique_ptr<kandelo::crypto::KeyMaterial> material;
      std::unique_ptr<kandelo::crypto::Error> error;
      try { material = state->pairJob->Generate(); }
      catch (const kandelo::crypto::Error& failure) { error = std::make_unique<kandelo::crypto::Error>(failure); }
      return KandeloPairToResult(cx, owner, *state->pairJob, material, error.get(), output);
    }
    auto abandon = mozilla::MakeScopeExit([&] { KandeloFsAbandonRequest(owner); });
    auto* queue = js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
    auto config = std::move(state->pairJob);
    JS::RemoveAssociatedMemory(owner, state->pairBytes, JS::MemoryUse::Embedding3); state->pairBytes = 0;
    auto* work = js_new<KandeloPairWork>(cx, owner.get(), std::move(config));
    if (!work) { JS_ReportOutOfMemory(cx); return false; }
    state->dispatched = true;
    if (!queue->Submit(work)) { js_delete(work); JS_ReportErrorASCII(cx, "Pair generation queue closing"); return false; }
    output.setUndefined(); abandon.release(); return true;
  }();
  return success && JS_WrapValue(cx, output);
}
static bool KandeloPairConstants(JSContext* cx, MutableHandleValue output) {
  using namespace kandelo::crypto::keypair;
  RootedObject object(cx, JS_NewPlainObject(cx)); if (!object) return false;
  const std::pair<const char*, int> fields[] = {
    {"kCryptoJobAsync", 0}, {"kCryptoJobSync", 1},
    {"kKeyVariantRSA_PSS", kKeyVariantRSA_PSS}, {"kKeyVariantRSA_SSA_PKCS1_v1_5", kKeyVariantRSA_SSA_PKCS1_v1_5},
    {"OPENSSL_EC_NAMED_CURVE", OPENSSL_EC_NAMED_CURVE}, {"OPENSSL_EC_EXPLICIT_CURVE", OPENSSL_EC_EXPLICIT_CURVE},
    {"pairRsa", int(Kind::Rsa)}, {"pairDsa", int(Kind::Dsa)}, {"pairEc", int(Kind::Ec)},
    {"pairDh", int(Kind::Dh)}, {"pairNamed", int(Kind::Named)},
  };
  for (const auto& field : fields) if (!JS_DefineProperty(cx, object, field.first, field.second, JSPROP_ENUMERATE)) return false;
  output.setObject(*object); return true;
}
}  // namespace
