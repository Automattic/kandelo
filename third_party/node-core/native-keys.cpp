/* Real immutable key material owns ncrypto/OpenSSL objects. Engine-only
 * reserved-slot edges share that material across independent public wrappers. */
#include "kandelo-node-key-operations.h"
namespace {
static void KandeloKeyMaterialFinalize(JS::GCContext*, JSObject* object) {
  const auto value = JS::GetReservedSlot(object, 0);
  if (value.isUndefined()) return;
  auto* material = static_cast<kandelo::crypto::KeyMaterial*>(value.toPrivate());
  JS::RemoveAssociatedMemory(object, material->AccountedBytes(), JS::MemoryUse::Embedding3);
  delete material;
}
static const JSClassOps KandeloKeyMaterialOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloKeyMaterialFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloKeyMaterialClass = {"KandeloKeyMaterial",
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloKeyMaterialOps};
static const JSClass KandeloKeyHandleClass = {"KeyObjectHandle", JSCLASS_HAS_RESERVED_SLOTS(2)};
static const JSClass KandeloKeyObjectClass = {"NativeKeyObject", JSCLASS_HAS_RESERVED_SLOTS(3)};
static const JSClass KandeloCryptoKeyClass = {"NativeCryptoKey", JSCLASS_HAS_RESERVED_SLOTS(8)};
static JSObject* KandeloKeyUnwrap(JSContext* cx, HandleValue value) {
  return value.isObject() ? js::CheckedUnwrapDynamic(&value.toObject(), cx) : nullptr;
}
static bool KandeloKeyIs(JSContext* cx, HandleValue value, const JSClass* kind) {
  JSObject* object = KandeloKeyUnwrap(cx, value);
  return object && JS::GetClass(object) == kind;
}
static kandelo::crypto::KeyMaterial* KandeloKeyMaterial(JSObject* wrapper) {
  const auto material = JS::GetReservedSlot(wrapper, 0);
  if (!material.isObject()) return nullptr;
  JSObject* owner = js::UncheckedUnwrap(&material.toObject());
  if (JS::GetClass(owner) != &KandeloKeyMaterialClass) return nullptr;
  const auto pointer = JS::GetReservedSlot(owner, 0);
  return pointer.isUndefined() ? nullptr : static_cast<kandelo::crypto::KeyMaterial*>(pointer.toPrivate());
}
static int KandeloKeyRole(JSObject* wrapper) {
  const auto role = JS::GetReservedSlot(wrapper, 1);
  return role.isInt32() ? role.toInt32() : -1;
}
static bool KandeloKeyBytes(JSContext* cx, const ncrypto::DataPointer& data, MutableHandleValue result) {
  RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx, data.get<unsigned char>(), data.size()));
  if (!bytes) return false;
  result.setObject(*bytes); return true;
}
static bool KandeloKeyOwn(JSContext* cx, HandleObject handle, int role,
                          std::unique_ptr<kandelo::crypto::KeyMaterial> material) {
  RootedObject owner(cx, JS_NewObject(cx, &KandeloKeyMaterialClass));
  if (!owner) return false;
  JS::AddAssociatedMemory(owner, material->AccountedBytes(), JS::MemoryUse::Embedding3);
  JS::SetReservedSlot(owner, 0, PrivateValue(material.release()));
  JS::SetReservedSlot(handle, 0, ObjectValue(*owner));
  JS::SetReservedSlot(handle, 1, Int32Value(role)); return true;
}
static bool KandeloKeyString(JSContext* cx, HandleValue value, std::string* result) {
  if (!value.isString()) { JS_ReportErrorASCII(cx, "Key option requires a string"); return false; }
  RootedString text(cx, value.toString());
  JS::UniqueChars bytes = JS_EncodeStringToUTF8(cx, text); if (!bytes) return false;
  result->assign(bytes.get()); return true;
}
static bool KandeloKeyCopy(JSContext* cx, HandleValue value, kandelo::crypto::Bytes* bytes) {
  return KandeloCryptoInput(cx, value, bytes);
}
static bool KandeloKeyDetails(JSContext* cx, kandelo::crypto::KeyMaterial& material,
                              HandleObject object, MutableHandleValue result) {
  const auto& key = material.asymmetric;
  auto number = [&](const char* name, uint64_t value) {
    return JS_DefineProperty(cx, object, name, double(value), JSPROP_ENUMERATE);
  };
  auto text = [&](const char* name, std::string_view value) {
    RootedValue string(cx);
    return KandeloFsPathString(cx, value.data(), value.size(), &string) &&
        JS_DefineProperty(cx, object, name, string, JSPROP_ENUMERATE);
  };
  if (material.isSecret) {
    if (!number("length", material.secret.size() * CHAR_BIT)) return false;
  } else if (key.isRsaVariant()) {
    ncrypto::Rsa rsa(key.get());
    if (!number("modulusLength", uint64_t(key.bits()))) return false;
    const auto publicKey = rsa.getPublicKey();
    const auto length = ncrypto::BignumPointer::GetByteCount(publicKey.e);
    auto exponent = ncrypto::DataPointer::Alloc(length);
    if (!exponent && length) { JS_ReportOutOfMemory(cx); return false; }
    if (ncrypto::BignumPointer::EncodePaddedInto(publicKey.e, exponent.get<unsigned char>(), size_t(length)) != size_t(length))
      kandelo::crypto::Fail("Failed to encode RSA public exponent");
    RootedValue bytes(cx);
    if (!KandeloKeyBytes(cx, exponent, &bytes)) return false;
    RootedObject view(cx, &bytes.toObject()); bool shared;
    RootedObject buffer(cx, JS_GetArrayBufferViewBuffer(cx, view, &shared));
    if (!buffer || !JS_DefineProperty(cx, object, "publicExponent", buffer, JSPROP_ENUMERATE)) return false;
    if (auto params = rsa.getPssParams()) {
      if (!text("hashAlgorithm", params->digest) ||
          (params->mgf1_digest && !text("mgf1HashAlgorithm", *params->mgf1_digest)) ||
          !number("saltLength", uint64_t(params->salt_length))) return false;
    }
  } else if (key.isA("EC")) {
    if (auto name = ncrypto::Ec::GetCurveName(key)) { if (!text("namedCurve", *name)) return false; }
  } else if (key.isA("DSA")) {
    ncrypto::Dsa dsa(key.get());
    if (!number("modulusLength", dsa.getModulusLength()) || !number("divisorLength", dsa.getDivisorLength())) return false;
  } else if (!key.isA("DH")) {
    // The exact target returns an empty detail object for DH and rejects
    // algorithms without a documented detail provider.
    throw kandelo::crypto::KeyError("Invalid key type", "ERR_CRYPTO_INVALID_KEYTYPE");
  }
  result.setObject(*object); return true;
}
static bool KandeloKeyDispatch(JSContext* cx, const CallArgs& args, MutableHandleValue output) {
  std::string name; if (!KandeloKeyString(cx, args.get(0), &name)) return false;
  if (name == "constants") {
    using Key = kandelo::crypto::KeyMaterial::Key;
    RootedObject object(cx, JS_NewPlainObject(cx)); if (!object) return false;
    const std::pair<const char*, int> fields[] = {
      {"kKeyTypeSecret", 0}, {"kKeyTypePublic", 1}, {"kKeyTypePrivate", 2},
      {"kKeyFormatPEM", int(Key::PKFormatType::PEM)}, {"kKeyFormatDER", int(Key::PKFormatType::DER)},
      {"kKeyFormatJWK", int(Key::PKFormatType::JWK)}, {"kKeyFormatRawPublic", int(Key::PKFormatType::RAW_PUBLIC)},
      {"kKeyFormatRawPrivate", int(Key::PKFormatType::RAW_PRIVATE)}, {"kKeyFormatRawSeed", int(Key::PKFormatType::RAW_SEED)},
      {"kKeyFormatStore", int(Key::PKFormatType::STORE)},
      {"kKeyEncodingPKCS1", int(Key::PKEncodingType::PKCS1)}, {"kKeyEncodingPKCS8", int(Key::PKEncodingType::PKCS8)},
      {"kKeyEncodingSPKI", int(Key::PKEncodingType::SPKI)}, {"kKeyEncodingSEC1", int(Key::PKEncodingType::SEC1)},
      {"POINT_CONVERSION_COMPRESSED", int(POINT_CONVERSION_COMPRESSED)},
      {"POINT_CONVERSION_UNCOMPRESSED", int(POINT_CONVERSION_UNCOMPRESSED)},
    };
    for (const auto& field : fields) if (!JS_DefineProperty(cx, object, field.first, field.second, JSPROP_ENUMERATE)) return false;
    output.setObject(*object); return true;
  }
  if (name == "isHandle" || name == "isKeyObject" || name == "isCryptoKey") {
    const auto* kind = name == "isHandle" ? &KandeloKeyHandleClass :
        name == "isKeyObject" ? &KandeloKeyObjectClass : &KandeloCryptoKeyClass;
    output.setBoolean(KandeloKeyIs(cx, args.get(1), kind)); return !JS_IsExceptionPending(cx);
  }
  if (name == "newHandle") {
    if (!args.get(1).isObject()) { JS_ReportErrorASCII(cx, "Key handle requires a prototype"); return false; }
    RootedObject prototype(cx, &args[1].toObject());
    RootedObject handle(cx, JS_NewObjectWithGivenProto(cx, &KandeloKeyHandleClass, prototype));
    if (!handle) return false;
    output.setObject(*handle); return true;
  }
  if (name == "newObject" || name == "newCryptoKey") {
    RootedObject handle(cx, KandeloKeyUnwrap(cx, args.get(2)));
    if (!handle || JS::GetClass(handle) != &KandeloKeyHandleClass || !KandeloKeyMaterial(handle) || !args.get(1).isObject()) {
      JS_ReportErrorASCII(cx, "Key constructor requires an initialized native handle"); return false;
    }
    RootedObject prototype(cx, &args[1].toObject());
    RootedObject object(cx, JS_NewObjectWithGivenProto(cx,
        name == "newObject" ? &KandeloKeyObjectClass : &KandeloCryptoKeyClass, prototype));
    if (!object) return false;
    RootedValue material(cx, JS::GetReservedSlot(handle, 0));
    if (!JS_WrapValue(cx, &material)) return false;
    JS::SetReservedSlot(object, 0, material);
    JS::SetReservedSlot(object, 1, JS::GetReservedSlot(handle, 1));
    RootedObject handlePrototype(cx); if (!JS_GetPrototype(cx, handle, &handlePrototype)) return false;
    if (!JS_WrapObject(cx, &handlePrototype)) return false;
    JS::SetReservedSlot(object, 2, ObjectValue(*handlePrototype));
    if (name == "newCryptoKey") {
      // These are real algorithm/usage/seed values supplied by pinned private
      // import code, never inferred from public properties or outer-host keys.
      for (unsigned i = 3; i < 8; i++) JS::SetReservedSlot(object, i, args.get(i));
    }
    output.setObject(*object); return true;
  }
  if (name == "slots" || name == "cryptoSlots") {
    RootedObject object(cx, KandeloKeyUnwrap(cx, args.get(1)));
    if (!object || JS::GetClass(object) != (name == "slots" ? &KandeloKeyObjectClass : &KandeloCryptoKeyClass)) {
      output.setUndefined(); return !JS_IsExceptionPending(cx);
    }
    RootedValue material(cx, JS::GetReservedSlot(object, 0)), prototypeValue(cx, JS::GetReservedSlot(object, 2));
    if (!JS_WrapValue(cx, &material) || !JS_WrapValue(cx, &prototypeValue)) return false;
    RootedObject prototype(cx, &prototypeValue.toObject());
    RootedObject handle(cx, JS_NewObjectWithGivenProto(cx, &KandeloKeyHandleClass, prototype));
    if (!handle) return false;
    JS::SetReservedSlot(handle, 0, material); JS::SetReservedSlot(handle, 1, JS::GetReservedSlot(object, 1));
    RootedObject slots(cx, JS::NewArrayObject(cx, 0)); if (!slots) return false;
    RootedValue type(cx, JS::GetReservedSlot(object, 1)), handleValue(cx, ObjectValue(*handle));
    if (!JS_DefineElement(cx, slots, 0, type, JSPROP_ENUMERATE)) return false;
    if (name == "slots") { if (!JS_DefineElement(cx, slots, 1, handleValue, JSPROP_ENUMERATE)) return false; }
    else {
      const unsigned sourceSlots[] = {5, 3, 4};
      for (unsigned i = 0; i < 3; i++) {
        RootedValue value(cx, JS::GetReservedSlot(object, sourceSlots[i]));
        if (!JS_WrapValue(cx, &value) || !JS_DefineElement(cx, slots, i + 1, value, JSPROP_ENUMERATE)) return false;
      }
      if (!JS_DefineElement(cx, slots, 4, handleValue, JSPROP_ENUMERATE)) return false;
      for (unsigned i = 5; i < 7; i++) {
        RootedValue value(cx, JS::GetReservedSlot(object, i + 1));
        if (!JS_WrapValue(cx, &value) || !JS_DefineElement(cx, slots, i, value, JSPROP_ENUMERATE)) return false;
      }
    }
    output.setObject(*slots); return true;
  }
  RootedObject handle(cx, KandeloKeyUnwrap(cx, args.get(1)));
  if (!handle || JS::GetClass(handle) != &KandeloKeyHandleClass) { JS_ReportErrorASCII(cx, "Invalid native key handle"); return false; }
  if (name == "init") {
    int64_t role; if (!KandeloFsInteger(cx, args.get(2), 0, 2, &role)) return false;
    if (role == 0) {
      kandelo::crypto::Bytes bytes; if (!KandeloKeyCopy(cx, args.get(3), &bytes)) return false;
      return KandeloKeyOwn(cx, handle, 0, kandelo::crypto::KeyMaterial::Secret(bytes));
    }
    if (KandeloKeyIs(cx, args.get(3), &KandeloKeyHandleClass)) {
      RootedObject original(cx, KandeloKeyUnwrap(cx, args.get(3)));
      if (!KandeloKeyMaterial(original) || KandeloKeyRole(original) == 0 ||
          (role == 2 && KandeloKeyRole(original) != 2)) {
        throw kandelo::crypto::KeyError("Invalid key object type", "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE");
      }
      RootedValue material(cx, JS::GetReservedSlot(original, 0));
      if (!JS_WrapValue(cx, &material)) return false;
      JS::SetReservedSlot(handle, 0, material); JS::SetReservedSlot(handle, 1, Int32Value(int(role))); return true;
    }
    int64_t format = 1, encoding = 1;
    if (!args.get(4).isNullOrUndefined() && !KandeloFsInteger(cx, args[4], 0, 6, &format)) return false;
    if (!args.get(5).isNullOrUndefined() && !KandeloFsInteger(cx, args[5], 0, 3, &encoding)) return false;
    if (format != 0 && format != 1) throw kandelo::crypto::KeyError("Key format native owner is not implemented", "ERR_METHOD_NOT_IMPLEMENTED");
    kandelo::crypto::Bytes bytes, passphrase; if (!KandeloKeyCopy(cx, args.get(3), &bytes)) return false;
    const bool hasPassphrase = !args.get(6).isNullOrUndefined();
    if (hasPassphrase && !KandeloKeyCopy(cx, args[6], &passphrase)) return false;
    auto config = kandelo::crypto::KeyMaterial::Configuration(int(format), int(encoding), hasPassphrase ? &passphrase : nullptr);
    return KandeloKeyOwn(cx, handle, int(role), kandelo::crypto::KeyMaterial::Parse(role == 2, bytes, std::move(config)));
  }
  auto* material = KandeloKeyMaterial(handle); if (!material) { JS_ReportErrorASCII(cx, "Key handle is not initialized"); return false; }
  const int role = KandeloKeyRole(handle);
  if (name == "type") { output.setInt32(role); return true; }
  if (name == "size") { output.setNumber(double(material->secret.size())); return true; }
  if (name == "asymmetricType") {
    const char* type = material->asymmetric.getKeyTypeName();
    if (!type) { output.setUndefined(); return true; }
    RootedString value(cx, JS_NewStringCopyZ(cx, type)); if (!value) return false;
    output.setString(value); return true;
  }
  if (name == "detail") {
    if (!args.get(2).isObject()) { JS_ReportErrorASCII(cx, "Key details require a target object"); return false; }
    RootedObject target(cx, &args[2].toObject());
    return KandeloKeyDetails(cx, *material, target, output);
  }
  if (name == "equals") {
    RootedObject other(cx, KandeloKeyUnwrap(cx, args.get(2)));
    if (!other || JS::GetClass(other) != &KandeloKeyHandleClass || !KandeloKeyMaterial(other)) { JS_ReportErrorASCII(cx, "Key equality requires a native handle"); return false; }
    output.setBoolean(role == KandeloKeyRole(other) && material->Equals(*KandeloKeyMaterial(other))); return true;
  }
  if (name == "export") {
    if (role == 0) return KandeloKeyBytes(cx, material->secret, output);
    int64_t format, encoding;
    if (!KandeloFsInteger(cx, args.get(2), 0, 1, &format) || !KandeloFsInteger(cx, args.get(3), 0, 3, &encoding)) return false;
    std::string cipher; const bool encrypted = !args.get(4).isNullOrUndefined();
    if (encrypted && !KandeloKeyString(cx, args[4], &cipher)) return false;
    kandelo::crypto::Bytes passphrase; const bool hasPassphrase = !args.get(5).isNullOrUndefined();
    if (hasPassphrase && !KandeloKeyCopy(cx, args[5], &passphrase)) return false;
    auto config = kandelo::crypto::KeyMaterial::Configuration(int(format), int(encoding), hasPassphrase ? &passphrase : nullptr, encrypted ? cipher.c_str() : nullptr);
    auto result = material->Export(std::move(config), role == 2);
    return format == 1 ? KandeloFsPathString(cx, result.get<const char>(), result.size(), output) : KandeloKeyBytes(cx, result, output);
  }
  if (name == "rawPublic" || name == "rawPrivate") {
    if (!(name == "rawPublic" ? material->asymmetric.supportsRawPublic() : material->asymmetric.supportsRawPrivate()))
      throw kandelo::crypto::KeyError("The selected key encoding is incompatible with the key type", "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    auto bytes = name == "rawPublic" ? material->asymmetric.rawPublicKey() : material->asymmetric.rawPrivateKey();
    if (!bytes) throw kandelo::crypto::KeyError(name == "rawPublic" ? "Failed to get raw public key" : "Failed to get raw private key", "ERR_CRYPTO_OPERATION_FAILED");
    return KandeloKeyBytes(cx, bytes, output);
  }
  if (name == "rawSeed") {
    auto bytes = material->asymmetric.rawSeed();
    if (!bytes) throw kandelo::crypto::KeyError(
        bytes.error == kandelo::crypto::KeyMaterial::Key::RawExportError::UNSUPPORTED_KEY_TYPE ?
          "The selected key encoding is incompatible with the key type" : "Failed to get raw seed",
        bytes.error == kandelo::crypto::KeyMaterial::Key::RawExportError::UNSUPPORTED_KEY_TYPE ?
          "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS" : "ERR_CRYPTO_OPERATION_FAILED");
    return KandeloKeyBytes(cx, bytes.value, output);
  }
  if (name == "ecPublic" || name == "ecPrivate") {
    if (!material->asymmetric.isA("EC")) throw kandelo::crypto::KeyError(
        "The selected key encoding is incompatible with the key type", "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
    int64_t form = POINT_CONVERSION_UNCOMPRESSED;
    if (name == "ecPublic" && !KandeloFsInteger(cx, args.get(2), POINT_CONVERSION_COMPRESSED, POINT_CONVERSION_UNCOMPRESSED, &form)) return false;
    auto bytes = name == "ecPublic" ? ncrypto::Ec::TryExportPublic(material->asymmetric, point_conversion_form_t(form)) :
        ncrypto::Ec::ExportPrivate(material->asymmetric);
    if (!bytes) throw kandelo::crypto::KeyError("Failed to export EC key", "ERR_CRYPTO_OPERATION_FAILED");
    return KandeloKeyBytes(cx, bytes, output);
  }
  if (name == "checkEc") {
    auto context = material->asymmetric.newCtx();
    if (!context) kandelo::crypto::Fail("Failed to create key check context");
    output.setBoolean(role == 2 ? context.privateCheck() : context.publicCheck()); return true;
  }
  throw kandelo::crypto::KeyError("Key operation native owner is not implemented", "ERR_METHOD_NOT_IMPLEMENTED");
}
static bool KandeloNativeKeyOperation(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); RootedValue value(cx), error(cx);
  ncrypto::MarkPopErrorOnReturn mark;
  try { if (!KandeloKeyDispatch(cx, args, &value)) return false; }
  catch (const kandelo::crypto::Error& failure) { if (!KandeloDigestError(cx, failure, &error)) return false; }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  RootedObject packet(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  if (!packet || !JS_DefineProperty(cx, packet, "value", value, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, packet, "error", error, JSPROP_ENUMERATE)) return false;
  args.rval().setObject(*packet); return true;
}
}  // namespace
