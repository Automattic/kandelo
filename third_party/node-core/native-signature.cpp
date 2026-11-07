#include "kandelo-node-signature-operations.h"
namespace {
static void KandeloSignatureFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (slot.isUndefined()) return;
  JS::RemoveAssociatedMemory(object, sizeof(kandelo::crypto::SignatureState), JS::MemoryUse::Embedding3);
  delete static_cast<kandelo::crypto::SignatureState*>(slot.toPrivate());
}
static const JSClassOps KandeloSignatureOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloSignatureFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloSignClass = {"Sign",
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloSignatureOps};
static const JSClass KandeloVerifyClass = {"Verify",
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloSignatureOps};
static bool KandeloSignatureDispatch(JSContext* cx, const CallArgs& args, MutableHandleValue output) {
  using State = kandelo::crypto::SignatureState;
  using Material = kandelo::crypto::KeyMaterial;
  std::string operation;
  if (!KandeloKeyString(cx, args.get(0), &operation)) return false;
  if (operation == "new") {
    RootedObject prototype(cx, KandeloKeyUnwrap(cx, args.get(1)));
    if (!prototype || !args.get(2).isBoolean()) {
      if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Signature requires a prototype and direction");
      return false;
    }
    auto state = std::make_unique<State>();
    {
      JSAutoRealm realm(cx, prototype);
      RootedObject object(cx, JS_NewObjectWithGivenProto(cx,
          args[2].toBoolean() ? &KandeloVerifyClass : &KandeloSignClass, prototype));
      if (!object) return false;
      JS::AddAssociatedMemory(object, sizeof(State), JS::MemoryUse::Embedding3);
      JS::SetReservedSlot(object, 0, PrivateValue(state.release()));
      output.setObject(*object);
    }
    return JS_WrapValue(cx, output);
  }
  RootedObject object(cx, KandeloKeyUnwrap(cx, args.get(1)));
  if (!object || (JS::GetClass(object) != &KandeloSignClass && JS::GetClass(object) != &KandeloVerifyClass)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Invalid native signature owner");
    return false;
  }
  const auto slot = JS::GetReservedSlot(object, 0);
  if (slot.isUndefined()) { JS_ReportErrorASCII(cx, "Missing native signature state"); return false; }
  auto* state = static_cast<State*>(slot.toPrivate());
  if (operation == "init") {
    std::string algorithm;
    if (!KandeloKeyString(cx, args.get(2), &algorithm)) return false;
    state->Init(algorithm.c_str()); return true;
  }
  if (operation == "update") {
    kandelo::crypto::Bytes bytes;
    if (!args.get(2).isString()) {
      KandeloCryptoByteSource source(cx);
      if (!source.Init(args.get(2))) {
        if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Signature data requires buffer storage");
        return false;
      }
      if (source.Length() > INT_MAX) State::Code("ERR_OUT_OF_RANGE", "data is too long");
    }
    if (!KandeloCryptoEncodedInput(cx, args.get(2), args.get(3), &bytes)) return false;
    state->Update(bytes.value.data(), bytes.value.size()); return true;
  }
  const bool verify = operation == "verify";
  if ((!verify && operation != "sign") ||
      JS::GetClass(object) != (verify ? &KandeloVerifyClass : &KandeloSignClass)) {
    JS_ReportErrorASCII(cx, "Invalid signature finalization owner"); return false;
  }
  // Root both the handle and its independent material edge while key parsing
  // may enter caller JWK getters or allocate/collect. No raw byte borrow crosses
  // those callbacks; the digest owner itself is rooted throughout reentrancy.
  RootedObject handle(cx, KandeloKeyUnwrap(cx, args.get(2)));
  if (JS_IsExceptionPending(cx)) return false;
  RootedValue materialOwner(cx);
  std::unique_ptr<Material> parsed;
  const Material* material = nullptr;
  if (handle && JS::GetClass(handle) == &KandeloKeyHandleClass) {
    materialOwner = JS::GetReservedSlot(handle, 0); material = KandeloKeyMaterial(handle);
    if (!material || material->isSecret || (!verify && KandeloKeyRole(handle) != 2))
      State::Code("ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE", "Invalid key object type");
  } else {
    int64_t format = 1, encoding = 1;
    if (!args.get(3).isNullOrUndefined() && !KandeloFsInteger(cx, args.get(3), 0, 6, &format)) return false;
    if (Material::Format(format) == Material::Format::JWK) {
      if (!args.get(2).isObject()) { JS_ReportErrorASCII(cx, "JWK requires an object"); return false; }
      RootedObject jwk(cx, &args[2].toObject());
      handle = JS_NewObjectWithGivenProto(cx, &KandeloKeyHandleClass, nullptr);
      RootedValue ignored(cx);
      if (!handle || !KandeloKeyImportJwk(cx, handle, 1, jwk, &ignored)) return false;
      materialOwner = JS::GetReservedSlot(handle, 0); material = KandeloKeyMaterial(handle);
    } else if (Material::Format(format) == Material::Format::STORE) {
      if (verify) State::Code("ERR_INVALID_ARG_VALUE", "URLs for OpenSSL STORE loaders are only accepted for private keys");
      State::Code("ERR_METHOD_NOT_IMPLEMENTED", "OpenSSL STORE key loading is not implemented");
    } else {
      kandelo::crypto::Bytes bytes, passphrase;
      if (!KandeloKeyCopyRaw(cx, args.get(2), &bytes)) return false;
      if (Material::Format(format) == Material::Format::RAW_PUBLIC ||
          Material::Format(format) == Material::Format::RAW_PRIVATE || Material::Format(format) == Material::Format::RAW_SEED) {
        std::string type, curve;
        if (!KandeloKeyString(cx, args.get(4), &type)) return false;
        if (args.get(6).isString() && !KandeloKeyString(cx, args.get(6), &curve)) return false;
        parsed = Material::Raw(bytes, Material::Format(format), type, curve);
      } else {
        if (!args.get(4).isNullOrUndefined() && !KandeloFsInteger(cx, args.get(4), 0, 3, &encoding)) return false;
        const bool password = !args.get(5).isNullOrUndefined();
        if (password && !KandeloKeyCopy(cx, args.get(5), &passphrase)) return false;
        parsed = Material::Parse(!verify, bytes, Material::Configuration(int(format), int(encoding), password ? &passphrase : nullptr));
      }
      material = parsed.get();
    }
  }
  State::CheckKey(material->asymmetric);
  const unsigned offset = verify ? 8 : 7;
  int64_t padding = material->asymmetric.getDefaultSignPadding(), encoding;
  std::optional<int> salt;
  if (!args.get(offset).isUndefined() && !KandeloFsInteger(cx, args.get(offset), INT_MIN, INT_MAX, &padding)) return false;
  if (!args.get(offset + 1).isUndefined()) {
    int64_t number; if (!KandeloFsInteger(cx, args.get(offset + 1), INT_MIN, INT_MAX, &number)) return false;
    salt = int(number);
  }
  if (!KandeloFsInteger(cx, args.get(offset + 2), 0, 1, &encoding)) return false;
  if (verify) {
    KandeloCryptoByteSource source(cx);
    if (!source.Init(args.get(7))) {
      if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Signature requires buffer storage");
      return false;
    }
    if (source.Length() > INT_MAX) State::Code("ERR_OUT_OF_RANGE", "buffer is too big");
    kandelo::crypto::Bytes signature;
    if (!KandeloCryptoInput(cx, args.get(7), &signature)) return false;
    static const unsigned char empty = 0;
    output.setBoolean(state->Verify(material->asymmetric,
        signature.value.empty() ? &empty : signature.value.data(), signature.value.size(), int(padding), salt, encoding == 1));
    return true;
  }
  auto signature = state->Sign(material->asymmetric, int(padding), salt, encoding == 1);
  RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx, signature.data(), signature.size()));
  if (!bytes) return false;
  output.setObject(*bytes); return true;
}
static bool KandeloNativeSignatureOperation(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedValue value(cx), error(cx);
  ncrypto::ClearErrorOnReturn clear;
  try { if (!KandeloSignatureDispatch(cx, args, &value)) return false; }
  catch (const kandelo::crypto::Error& failure) { if (!KandeloDigestError(cx, failure, &error)) return false; }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  RootedObject packet(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  if (!packet || !JS_DefineProperty(cx, packet, "value", value, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, packet, "error", error, JSPROP_ENUMERATE)) return false;
  args.rval().setObject(*packet); return true;
}
}  // namespace
