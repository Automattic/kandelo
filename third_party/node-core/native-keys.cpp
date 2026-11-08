/* Real immutable key material owns ncrypto/OpenSSL objects. Engine-only
 * reserved-slot edges share that material across independent public wrappers. */
#include "kandelo-node-key-operations.h"
#include "js/Exception.h"
#include "js/Realm.h"
#include "js/String.h"
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
  // The dispatcher accepts checked-unwrapped foreign handles. Allocate and
  // account the owner in the destination realm, never store a raw cross-zone
  // object in the foreign handle's reserved slot.
  JSAutoRealm realm(cx, handle);
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
  JSLinearString* linear = JS_EnsureLinearString(cx, text); if (!linear) return false;
  const size_t length = JS::GetDeflatedUTF8StringLength(linear);
  if (length == SIZE_MAX) { JS_ReportOutOfMemory(cx); return false; }
  JS::UniqueChars bytes = JS_EncodeStringToUTF8(cx, text); if (!bytes) return false;
  result->assign(bytes.get(), length); return true;
}
static bool KandeloKeyCopy(JSContext* cx, HandleValue value, kandelo::crypto::Bytes* bytes) {
  return KandeloCryptoInput(cx, value, bytes);
}
// Raw key sources are already validated as buffers by the pinned public
// wrapper. Reject the target's size bound before allocating/copying storage.
static bool KandeloKeyCopyRaw(JSContext* cx, HandleValue value, kandelo::crypto::Bytes* bytes) {
  KandeloCryptoByteSource source(cx);
  if (!source.Init(value)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Raw key requires a real buffer source");return false;
  }
  bool tooBig = false;
  const bool copied = source.WithBytes([&](SharedMem<uint8_t*> data, size_t length) {
    if (length > INT_MAX) { tooBig = true;return false; }
    KandeloCryptoCopy(data, length, bytes);return true;
  });
  if (tooBig) throw kandelo::crypto::KeyError("keyData is too big", "ERR_OUT_OF_RANGE");
  if (!copied && !JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Raw key has no backing data");
  return copied;
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
// JWK string decoding never enters JavaScript or public Buffer allocation.
// Borrow immutable rooted string characters only within the no-GC scope.
static bool KandeloJwkDecode(JSContext* cx, HandleValue value,
                              kandelo::crypto::Bytes* bytes) {
  if (!value.isString()) { JS_ReportErrorASCII(cx, "JWK component requires a string"); return false; }
  RootedString text(cx, value.toString());
  JSLinearString* linear = JS_EnsureLinearString(cx, text);
  if (!linear) return false;
  JS::AutoCheckCannotGC nogc;
  const size_t length = JS::GetLinearStringLength(linear);
  if (JS::LinearStringHasLatin1Chars(linear)) {
    const auto* chars = JS::GetLatin1LinearStringChars(nogc, linear);
    auto decoded = kandelo::crypto::jwk_codec::Decode(chars, length);
    bytes->value.swap(decoded.value);
  } else {
    const auto* chars = JS::GetTwoByteLinearStringChars(nogc, linear);
    auto decoded = kandelo::crypto::jwk_codec::Decode(chars, length);
    bytes->value.swap(decoded.value);
  }
  return true;
}
[[noreturn]] static void KandeloJwkInvalid(const char* kind) {
  kandelo::crypto::KeyMaterial::InvalidJwk(kind);
}
static bool KandeloJwkMaskGetterFailure(JSContext* cx, const char* message) {
  // Preserve OOM and exception-free interrupt/forced-return failures. Only
  // ordinary getter exceptions get the pinned invalid-JWK replacement.
  if (JS_IsThrowingOutOfMemory(cx) || !JS_IsExceptionPending(cx)) return false;
  JS_ClearPendingException(cx);
  throw kandelo::crypto::KeyError(message, "ERR_CRYPTO_INVALID_JWK");
}
static bool KandeloJwkGetMasked(JSContext* cx, HandleObject object, const char* name,
                                MutableHandleValue value, const char* message) {
  return JS_GetProperty(cx, object, name, value) || KandeloJwkMaskGetterFailure(cx, message);
}
static bool KandeloKeyImportJwk(JSContext* cx, HandleObject handle, int requestedRole,
                                HandleObject jwk, MutableHandleValue output) {
  using Material = kandelo::crypto::KeyMaterial;
  using Bytes = kandelo::crypto::Bytes;
  if (requestedRole == 0) {
    RootedValue k(cx);
    if (!KandeloJwkGetMasked(cx, jwk, "k", &k, "Invalid JWK secret key format")) return false;
    if (!k.isString()) throw kandelo::crypto::KeyError("Invalid JWK secret key format", "ERR_CRYPTO_INVALID_JWK");
    Bytes bytes; if (!KandeloJwkDecode(cx, k, &bytes)) return false;
    return KandeloKeyOwn(cx, handle, 0, Material::Secret(bytes));
  }
  RootedValue kty(cx);
  if (!KandeloJwkGetMasked(cx, jwk, "kty", &kty, "Invalid JWK format")) return false;
  if (!kty.isString()) throw kandelo::crypto::KeyError("Invalid JWK format", "ERR_CRYPTO_INVALID_JWK");
  std::string kind; if (!KandeloKeyString(cx, kty, &kind)) return false;
  std::unique_ptr<Material> material;
  int importedRole = 1;
  // Utf8Value dispatch in the pinned owner compares its C string to the
  // expected names, so preserve its embedded-NUL behavior here as well.
  kind = std::string(kind.c_str());
  if (kind == "RSA") {
    RootedValue n(cx), e(cx), d(cx), oth(cx);
    if (!KandeloJwkGetMasked(cx, jwk, "n", &n, "Invalid JWK RSA key") || !KandeloJwkGetMasked(cx, jwk, "e", &e, "Invalid JWK RSA key") ||
        !KandeloJwkGetMasked(cx, jwk, "d", &d, "Invalid JWK RSA key") || !KandeloJwkGetMasked(cx, jwk, "oth", &oth, "Invalid JWK RSA key")) return false;
    if (!n.isString() || !e.isString() || (!d.isUndefined() && !d.isString()) ||
        (d.isUndefined() && !oth.isUndefined())) KandeloJwkInvalid("RSA");
    importedRole = d.isString() ? 2 : 1;
    ncrypto::Rsa rsa;
    Bytes nb, eb;
    if (!KandeloJwkDecode(cx, n, &nb) || !KandeloJwkDecode(cx, e, &eb)) return false;
    if (!rsa.setPublicKey(Material::JwkBN(nb), Material::JwkBN(eb))) KandeloJwkInvalid("RSA");
    if (importedRole == 2) {
      RootedValue p(cx), q(cx), dp(cx), dq(cx), qi(cx);
      if (!KandeloJwkGetMasked(cx, jwk, "p", &p, "Invalid JWK RSA key") || !KandeloJwkGetMasked(cx, jwk, "q", &q, "Invalid JWK RSA key") ||
          !KandeloJwkGetMasked(cx, jwk, "dp", &dp, "Invalid JWK RSA key") || !KandeloJwkGetMasked(cx, jwk, "dq", &dq, "Invalid JWK RSA key") ||
          !KandeloJwkGetMasked(cx, jwk, "qi", &qi, "Invalid JWK RSA key")) return false;
      if (!p.isString() || !q.isString() ||
          !dp.isString() || !dq.isString() || !qi.isString()) KandeloJwkInvalid("RSA");
      Bytes db, qb, pb, dpb, dqb, qib;
      if (!KandeloJwkDecode(cx, d, &db) || !KandeloJwkDecode(cx, q, &qb) ||
          !KandeloJwkDecode(cx, p, &pb) || !KandeloJwkDecode(cx, dp, &dpb) ||
          !KandeloJwkDecode(cx, dq, &dqb) || !KandeloJwkDecode(cx, qi, &qib)) return false;
      ncrypto::Rsa::OtherPrimeInfoPointers other;
      if (!oth.isUndefined()) {
        bool array = false;
        if (!oth.isObject()) KandeloJwkInvalid("RSA");
        if (!JS::IsArrayObject(cx, oth, &array)) return KandeloJwkMaskGetterFailure(cx, "Invalid JWK RSA key");
        if (!array) KandeloJwkInvalid("RSA");
        RootedObject list(cx, &oth.toObject()); uint32_t length;
        if (!JS::GetArrayLength(cx, list, &length)) return KandeloJwkMaskGetterFailure(cx, "Invalid JWK RSA key");
        if (length == 0 || length > 8) KandeloJwkInvalid("RSA");
        other.reserve(length);
        for (uint32_t i = 0; i < length; i++) {
          RootedValue item(cx), r(cx), od(cx), t(cx);
          if (!JS_GetElement(cx, list, i, &item)) return KandeloJwkMaskGetterFailure(cx, "Invalid JWK RSA key");
          if (!item.isObject()) KandeloJwkInvalid("RSA");
          RootedObject entry(cx, &item.toObject());
          if (!KandeloJwkGetMasked(cx, entry, "r", &r, "Invalid JWK RSA key") || !KandeloJwkGetMasked(cx, entry, "d", &od, "Invalid JWK RSA key") ||
              !KandeloJwkGetMasked(cx, entry, "t", &t, "Invalid JWK RSA key")) return false;
          if (!r.isString() || !od.isString() || !t.isString())
            KandeloJwkInvalid("RSA");
          Bytes rb, odb, tb;
          if (!KandeloJwkDecode(cx, r, &rb) || !KandeloJwkDecode(cx, od, &odb) ||
              !KandeloJwkDecode(cx, t, &tb)) return false;
          other.emplace_back(Material::JwkBN(rb), Material::JwkBN(odb), Material::JwkBN(tb));
        }
      }
      if (!rsa.setPrivateKey(Material::JwkBN(db), Material::JwkBN(qb), Material::JwkBN(pb),
            Material::JwkBN(dpb), Material::JwkBN(dqb), Material::JwkBN(qib), std::move(other)) ||
          !rsa.checkPrimeProduct()) KandeloJwkInvalid("RSA");
    }
    material = Material::JwkRsa(rsa);
  } else if (kind == "EC") {
    RootedValue crv(cx), x(cx), y(cx), d(cx);
    if (!KandeloJwkGetMasked(cx, jwk, "crv", &crv, "Invalid JWK EC key")) return false;
    if (!crv.isString()) KandeloJwkInvalid("EC");
    std::string curve; if (!KandeloKeyString(cx, crv, &curve)) return false;
    const int nid = Material::JwkCurve(curve);
    if (!JS_GetProperty(cx, jwk, "x", &x) || !JS_GetProperty(cx, jwk, "y", &y) ||
        !JS_GetProperty(cx, jwk, "d", &d)) return false;
    if (!x.isString() || !y.isString() || (!d.isUndefined() && !d.isString())) KandeloJwkInvalid("EC");
    importedRole = d.isString() ? 2 : 1;
    Bytes xb, yb, db;
    if (!KandeloJwkDecode(cx, x, &xb) || !KandeloJwkDecode(cx, y, &yb) ||
        (importedRole == 2 && !KandeloJwkDecode(cx, d, &db))) return false;
    material = Material::JwkEc(nid, xb, yb, importedRole == 2 ? &db : nullptr);
  } else if (kind == "OKP" || kind == "AKP") {
    const bool akp = kind == "AKP";
    RootedValue name(cx), pub(cx), priv(cx);
    if (!JS_GetProperty(cx, jwk, akp ? "alg" : "crv", &name) ||
        !JS_GetProperty(cx, jwk, akp ? "pub" : "x", &pub) ||
        !JS_GetProperty(cx, jwk, akp ? "priv" : "d", &priv)) return false;
    const bool valid = pub.isString() && (priv.isUndefined() || priv.isString());
    if (!akp && (!name.isString() || !valid)) KandeloJwkInvalid("OKP");
    std::string algorithmName;
    if (name.isString() && !KandeloKeyString(cx, name, &algorithmName)) return false;
    const auto* algorithm = Material::JwkAlgorithm(algorithmName, akp);
    if (!valid) KandeloJwkInvalid("AKP");
    importedRole = priv.isString() ? 2 : 1;
    Bytes publicBytes, privateBytes;
    if ((importedRole == 2 && !KandeloJwkDecode(cx, priv, &privateBytes)) ||
        !KandeloJwkDecode(cx, pub, &publicBytes)) return false;
    material = Material::JwkRaw(*algorithm, publicBytes, importedRole == 2 ? &privateBytes : nullptr);
  } else {
    const auto message = std::string(kind.c_str()) + " is not a supported JWK key type";
    throw kandelo::crypto::KeyError(message.c_str(), "ERR_CRYPTO_INVALID_JWK");
  }
  if (requestedRole == 2 && importedRole == 1)
    throw kandelo::crypto::KeyError("JWK does not contain private key material", "ERR_CRYPTO_INVALID_JWK");
  const int role = requestedRole == 1 ? 1 : importedRole;
  if (!KandeloKeyOwn(cx, handle, role, std::move(material))) return false;
  output.setInt32(role); return true;
}
static bool KandeloJwkDefine(JSContext* cx, HandleObject target, const char* name, HandleValue value) {
  RootedString string(cx, JS_NewStringCopyZ(cx, name));
  RootedId id(cx);
  if (!string || !JS_StringToId(cx, string, &id)) return false;
  Rooted<JS::PropertyDescriptor> descriptor(cx, JS::PropertyDescriptor::Data(value, JSPROP_ENUMERATE));
  JS::ObjectOpResult result;
  // V8 DefineOwnProperty reports an ordinary refusal without throwing. Keep
  // that distinction so ExportJWK supplies its own operation-failed error,
  // while exceptions thrown by a target proxy keep their original identity.
  if (!JS_DefinePropertyById(cx, target, id, descriptor, result)) return false;
  if (!result.ok()) throw kandelo::crypto::KeyError("Failed to export JWK", "ERR_CRYPTO_OPERATION_FAILED");
  return true;
}
static bool KandeloKeyExportJwk(JSContext* cx, const kandelo::crypto::KeyMaterial& material, int role,
                                HandleObject target, bool rsaPss) {
  using Material = kandelo::crypto::KeyMaterial;
  auto text = [&](const char* name, const char* value) {
    RootedString string(cx, JS_NewStringCopyZ(cx, value));
    if (!string) return false;
    RootedValue propertyValue(cx, StringValue(string));
    return KandeloJwkDefine(cx, target, name, propertyValue);
  };
  auto encode = [&](const ncrypto::DataPointer& data, MutableHandleValue encoded) {
    const auto text = kandelo::crypto::jwk_codec::Encode(data.get(), data.size());
    RootedString string(cx, JS_NewStringCopyN(cx, text.data(), text.size()));
    if (!string) return false;
    encoded.setString(string); return true;
  };
  auto bytes = [&](HandleObject object, const char* name, const ncrypto::DataPointer& data) {
    RootedValue encoded(cx);
    return encode(data, &encoded) && KandeloJwkDefine(cx, object, name, encoded);
  };
  auto bn = [&](HandleObject object, const char* name, const BIGNUM* value, size_t size = 0) {
    auto data = Material::JwkEncodeBN(value, size); return bytes(object, name, data);
  };
  if (role == 0) {
    RootedValue encoded(cx);
    return encode(material.secret, &encoded) && text("kty", "oct") && KandeloJwkDefine(cx, target, "k", encoded);
  }
  const auto& key = material.asymmetric;
  const auto* algorithm = key.getAlgorithm();
  if (algorithm == &ncrypto::KeyAlgorithm::RSA || (rsaPss && algorithm == &ncrypto::KeyAlgorithm::RSA_PSS)) {
    ncrypto::Rsa rsa(key.get());
    if (!rsa) throw kandelo::crypto::KeyError("Failed to export JWK", "ERR_CRYPTO_OPERATION_FAILED");
    if (!text("kty", "RSA")) return false;
    const auto pub = rsa.getPublicKey();
    if (!bn(target, "n", pub.n) || !bn(target, "e", pub.e)) return false;
    if (role == 2) {
      const auto priv = rsa.getPrivateKey();
      if (!pub.d || !priv.p || !priv.q || !priv.dp || !priv.dq || !priv.qi)
        throw kandelo::crypto::KeyError("Failed to export RSA private key", "ERR_CRYPTO_OPERATION_FAILED");
      if (!bn(target, "d", pub.d) || !bn(target, "p", priv.p) || !bn(target, "q", priv.q) ||
          !bn(target, "dp", priv.dp) || !bn(target, "dq", priv.dq) || !bn(target, "qi", priv.qi)) return false;
      const auto other = rsa.getOtherPrimeInfos();
      if (!other.empty()) {
        RootedObject list(cx, JS::NewArrayObject(cx, other.size())); if (!list) return false;
        for (uint32_t i = 0; i < other.size(); i++) {
          RootedObject item(cx, JS_NewPlainObject(cx));
          if (!item || !bn(item, "r", other[i].r) || !bn(item, "d", other[i].d) ||
              !bn(item, "t", other[i].t)) return false;
          RootedValue value(cx, ObjectValue(*item));
          if (!JS_SetElement(cx, list, i, value)) return false;
        }
        RootedValue value(cx, ObjectValue(*list));
        if (!KandeloJwkDefine(cx, target, "oth", value)) return false;
      }
    }
    return true;
  }
  if (algorithm == &ncrypto::KeyAlgorithm::EC) {
    ncrypto::BignumPointer x, y, d; int bits;
    if (!ncrypto::Ec::GetKeyComponents(key, &x, &y, role == 2 ? &d : nullptr, &bits))
      throw kandelo::crypto::KeyError("Failed to export JWK", "ERR_CRYPTO_OPERATION_FAILED");
    const size_t size = (bits + 7) / CHAR_BIT;
    if (!text("kty", "EC") || !bn(target, "x", x.get(), size) || !bn(target, "y", y.get(), size)) return false;
    const int nid = ncrypto::Ec::GetCurveId(key); const char* curve;
    switch (nid) {
      case NID_X9_62_prime256v1: curve = "P-256"; break;
      case NID_secp256k1: curve = "secp256k1"; break;
      case NID_secp384r1: curve = "P-384"; break;
      case NID_secp521r1: curve = "P-521"; break;
      default: {
        const auto message = std::string("Unsupported JWK EC curve: ") + OBJ_nid2sn(nid) + ".";
        throw kandelo::crypto::KeyError(message.c_str(), "ERR_CRYPTO_JWK_UNSUPPORTED_CURVE");
      }
    }
    return text("crv", curve) && (role != 2 || bn(target, "d", d.get(), size));
  }
  if (algorithm && (algorithm->isOkp() || algorithm->isPqc())) {
    auto data = material.ExportJwkRaw(role == 2);
    const bool akp = data.algorithm->isPqc();
    return text("kty", akp ? "AKP" : "OKP") && text(akp ? "alg" : "crv", data.algorithm->name()) &&
        bytes(target, akp ? "pub" : "x", data.public_key) &&
        (!data.private_key || bytes(target, akp ? "priv" : "d", data.private_key));
  }
  throw kandelo::crypto::KeyError("Unsupported JWK Key Type.", "ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE");
}
static bool KandeloKeyParsePKCS12(JSContext* cx, const CallArgs& args, MutableHandleValue output);
static bool KandeloCreateSecretKeyGen(JSContext*, const CallArgs&, MutableHandleValue,
                                      KandeloFsRequestPublication&);
static bool KandeloRunSecretKeyGen(JSContext*, const CallArgs&, MutableHandleValue);
static bool KandeloCreatePairGen(JSContext*, const CallArgs&, MutableHandleValue, KandeloFsRequestPublication&);
static bool KandeloRunPairGen(JSContext*, const CallArgs&, MutableHandleValue);
static bool KandeloPairConstants(JSContext*, MutableHandleValue);
static bool KandeloKeyDispatch(JSContext* cx, const CallArgs& args, MutableHandleValue output,
                               KandeloFsRequestPublication& publication) {
  std::string name; if (!KandeloKeyString(cx, args.get(0), &name)) return false;
  if (name == "parsePKCS12") return KandeloKeyParsePKCS12(cx, args, output);
  if (name == "createSecretGen") return KandeloCreateSecretKeyGen(cx, args, output, publication);
  if (name == "runSecretGen") return KandeloRunSecretKeyGen(cx, args, output);
  if (name == "createPairGen") return KandeloCreatePairGen(cx, args, output, publication);
  if (name == "runPairGen") return KandeloRunPairGen(cx, args, output);
  if (name == "pairConstants") return KandeloPairConstants(cx, output);
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
    RootedObject handlePrototype(cx);
    {
      JSAutoRealm realm(cx, handle);
      if (!JS_GetPrototype(cx, handle, &handlePrototype)) return false;
    }
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
  if (name == "initJwk") {
    int64_t role; if (!KandeloFsInteger(cx, args.get(2), 0, 2, &role)) return false;
    if (!args.get(3).isObject()) { JS_ReportErrorASCII(cx, "JWK import requires an object"); return false; }
    RootedObject jwk(cx, &args[3].toObject());
    return KandeloKeyImportJwk(cx, handle, int(role), jwk, output);
  }
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
      JSAutoRealm realm(cx, handle);
      if (!JS_WrapValue(cx, &material)) return false;
      JS::SetReservedSlot(handle, 0, material); JS::SetReservedSlot(handle, 1, Int32Value(int(role))); return true;
    }
    int64_t format = 1, encoding = 1;
    if (!args.get(4).isNullOrUndefined() && !KandeloFsInteger(cx, args[4], 0, 6, &format)) return false;
    using Key = kandelo::crypto::KeyMaterial;
    const auto rawFormat = Key::Format(format);
    if (rawFormat == Key::Format::RAW_PUBLIC || rawFormat == Key::Format::RAW_PRIVATE ||
        rawFormat == Key::Format::RAW_SEED) {
      kandelo::crypto::Bytes bytes; if (!KandeloKeyCopyRaw(cx, args.get(3), &bytes)) return false;
      std::string type, curve;
      if (!KandeloKeyString(cx, args.get(5), &type)) return false;
      if (args.get(7).isString() && !KandeloKeyString(cx, args[7], &curve)) return false;
      const int importedRole = rawFormat == Key::Format::RAW_PUBLIC ? 1 : 2;
      return KandeloKeyOwn(cx, handle, role == 1 ? 1 : importedRole,
          Key::Raw(bytes, rawFormat, type, curve));
    }
    if (!args.get(5).isNullOrUndefined() && !KandeloFsInteger(cx, args[5], 0, 3, &encoding)) return false;
    if (format != 0 && format != 1) throw kandelo::crypto::KeyError("Key format native owner is not implemented", "ERR_METHOD_NOT_IMPLEMENTED");
    kandelo::crypto::Bytes bytes, passphrase; if (!KandeloKeyCopy(cx, args.get(3), &bytes)) return false;
    const bool hasPassphrase = !args.get(6).isNullOrUndefined();
    if (hasPassphrase && !KandeloKeyCopy(cx, args[6], &passphrase)) return false;
    auto config = kandelo::crypto::KeyMaterial::Configuration(int(format), int(encoding), hasPassphrase ? &passphrase : nullptr);
    return KandeloKeyOwn(cx, handle, int(role), kandelo::crypto::KeyMaterial::Parse(role == 2, bytes, std::move(config)));
  }
  // A proxy target can reinitialize this handle during export/detail. Pin
  // the material edge independently so replacing slot0 and GC cannot retire
  // the snapshot still borrowed by native code after that callback returns.
  RootedValue materialOwner(cx, JS::GetReservedSlot(handle, 0));
  auto* material = KandeloKeyMaterial(handle); if (!material) { JS_ReportErrorASCII(cx, "Key handle is not initialized"); return false; }
  const int role = KandeloKeyRole(handle);
  // Private export methods are reflectable/borrowable from the public
  // PrivateKeyObject prototype. A public role can share an actual private
  // EVP owner; only the native immutable role grants private serialization.
  // Preserve the pinned KeyObjectHandle CHECK policy before backend access.
  if (name == "rawPrivate" || name == "rawSeed" || name == "ecPrivate" || name == "ecPkcs8") {
    MOZ_RELEASE_ASSERT(role == 2);
  }
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
  if (name == "exportJwk") {
    if (!args.get(2).isObject()) { JS_ReportErrorASCII(cx, "JWK export requires an object"); return false; }
    RootedObject target(cx, &args[2].toObject());
    if (!KandeloKeyExportJwk(cx, *material, role, target, args.get(3).isTrue())) return false;
    output.setObject(*target); return true;
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
  if (name == "ecPkcs8") {
    // Immutable role==private was admitted above before any backend access.
    // Both the rooted material edge and owned BIO survive allocation/GC;
    // no native borrowed pointer escapes and no public Buffer hook runs.
    auto encoded = material->ExportEcPrivatePkcs8();
    BUF_MEM* memory = encoded;
    if (!memory) throw kandelo::crypto::KeyError(
        "Unable to create BUF_MEM pointer", "ERR_CRYPTO_OPERATION_FAILED");
    RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx,
        reinterpret_cast<const uint8_t*>(memory->data), memory->length));
    if (!bytes) return false;
    output.setObject(*bytes); return true;
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
  KandeloFsRequestPublication publication(cx);
  bool succeeded = false;
  try {
    if (!KandeloKeyDispatch(cx, args, &value, publication)) return false;
    succeeded = true;
  }
  catch (const kandelo::crypto::Error& failure) { if (!KandeloDigestError(cx, failure, &error)) return false; }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  RootedObject packet(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  if (!packet || !JS_DefineProperty(cx, packet, "value", value, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, packet, "error", error, JSPROP_ENUMERATE)) return false;
  args.rval().setObject(*packet);
  if (succeeded) publication.Commit();
  return true;
}
}  // namespace
