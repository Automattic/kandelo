/* Incremental digest/HMAC state belongs to real native contexts. Public
 * encodings/streams live in the pinned JS classes and private byte owner. */
#include "kandelo-node-incremental-hash.h"
#include "kandelo-node-native-encoding.h"
namespace {
struct KandeloIncrementalState {
  std::unique_ptr<kandelo::crypto::IncrementalHash> hash;
  std::unique_ptr<kandelo::crypto::IncrementalHmac> hmac;
  size_t accounted = 0;
  size_t AccountedBytes() const {
    return sizeof(*this) + (hash ? hash->AccountedBytes() : hmac->AccountedBytes());
  }
};
static void KandeloIncrementalFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (!slot.isUndefined()) {
    auto* state = static_cast<KandeloIncrementalState*>(slot.toPrivate());
    JS::RemoveAssociatedMemory(object, state->accounted, JS::MemoryUse::Embedding3);
    delete state;
  }
}
static const JSClassOps KandeloIncrementalClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloIncrementalFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloIncrementalClass = {"KandeloIncrementalDigest",
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloIncrementalClassOps};
static KandeloIncrementalState* KandeloIncrementalOwner(JSContext* cx, HandleValue value,
                                                       MutableHandleObject unwrapped) {
  if (!value.isObject()) { JS_ReportErrorASCII(cx, "Invalid native digest owner"); return nullptr; }
  RootedObject object(cx, js::CheckedUnwrapDynamic(&value.toObject(), cx));
  if (!object || JS::GetClass(object) != &KandeloIncrementalClass) {
    JS_ReportErrorASCII(cx, "Invalid native digest owner"); return nullptr;
  }
  const auto slot = JS::GetReservedSlot(object, 0);
  if (slot.isUndefined()) { JS_ReportErrorASCII(cx, "Uninitialized native digest owner"); return nullptr; }
  unwrapped.set(object);
  return static_cast<KandeloIncrementalState*>(slot.toPrivate());
}
static bool KandeloIncrementalLength(JSContext* cx, HandleValue value,
                                     std::optional<uint32_t>* length) {
  if (value.isUndefined()) return true;
  int64_t number;
  if (!KandeloFsInteger(cx, value, 0, UINT32_MAX, &number)) return false;
  *length = uint32_t(number); return true;
}
static bool KandeloIncrementalDispatch(JSContext* cx, const CallArgs& args,
                                       MutableHandleValue output) {
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "Digest operation requires a name"); return false; }
  RootedString operationName(cx, args[0].toString());
  JS::UniqueChars operation = JS_EncodeStringToUTF8(cx, operationName);
  if (!operation) return false;
  if (!strcmp(operation.get(), "encoding")) {
    if (!args.get(2).isBoolean()) { JS_ReportErrorASCII(cx, "Encoding fallback flag must be boolean"); return false; }
    auto mode = args[2].toBoolean() ? kandelo::encoding::BUFFER : kandelo::encoding::UTF8;
    if (args.get(1).isString()) {
      RootedString name(cx, args[1].toString());
      JS::UniqueChars text = JS_EncodeStringToUTF8(cx, name);
      if (!text) return false;
      mode = kandelo::encoding::ParseEncoding(text.get(), mode);
    }
    const char* name = kandelo::encoding::EncodingName(mode);
    RootedString text(cx, JS_NewStringCopyZ(cx, name));
    if (!text) return false;
    output.setString(text); return true;
  }
  if (!strcmp(operation.get(), "create") || !strcmp(operation.get(), "copy") || !strcmp(operation.get(), "hmac")) {
    auto owner = std::make_unique<KandeloIncrementalState>();
    if (!strcmp(operation.get(), "copy")) {
      RootedObject sourceObject(cx);
      auto* source = KandeloIncrementalOwner(cx, args.get(1), &sourceObject);
      if (!source) return false;
      if (!source->hash) { JS_ReportErrorASCII(cx, "HMAC state cannot be copied as a hash"); return false; }
      std::optional<uint32_t> length;
      if (!KandeloIncrementalLength(cx, args.get(2), &length)) return false;
      owner->hash = std::make_unique<kandelo::crypto::IncrementalHash>(*source->hash, length);
    } else {
      if (!args.get(1).isString()) { JS_ReportErrorASCII(cx, "Digest algorithm must be a string"); return false; }
      RootedString algorithmName(cx, args[1].toString());
      JS::UniqueChars algorithm = JS_EncodeStringToUTF8(cx, algorithmName);
      if (!algorithm) return false;
      if (!strcmp(operation.get(), "create")) {
        std::optional<uint32_t> length;
        if (!KandeloIncrementalLength(cx, args.get(2), &length)) return false;
        if (!args.get(3).isBoolean()) { JS_ReportErrorASCII(cx, "Digest option flag must be boolean"); return false; }
        owner->hash = std::make_unique<kandelo::crypto::IncrementalHash>(algorithm.get(), length, args[3].toBoolean());
      } else {
        kandelo::crypto::Bytes key;
        RootedObject keyHandle(cx);
        if (KandeloKeyIs(cx, args.get(2), &KandeloKeyHandleClass)) {
          keyHandle = KandeloKeyUnwrap(cx, args.get(2));
          auto* material = KandeloKeyMaterial(keyHandle);
          if (!material || !material->isSecret || KandeloKeyRole(keyHandle) != 0)
            throw kandelo::crypto::KeyError("Invalid key object type, expected secret", "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE");
          const auto* bytes = material->secret.get<const unsigned char>();
          if (material->secret.size()) key.value.assign(bytes, bytes + material->secret.size());
        } else if (!KandeloCryptoInput(cx, args.get(2), &key)) return false;
        owner->hmac = std::make_unique<kandelo::crypto::IncrementalHmac>(algorithm.get(), key);
      }
    }
    RootedObject object(cx, JS_NewObject(cx, &KandeloIncrementalClass));
    if (!object) return false;
    owner->accounted = owner->AccountedBytes();
    JS::AddAssociatedMemory(object, owner->accounted, JS::MemoryUse::Embedding3);
    JS::SetReservedSlot(object, 0, PrivateValue(owner.release()));
    output.setObject(*object); return true;
  }
  RootedObject object(cx);
  auto* state = KandeloIncrementalOwner(cx, args.get(1), &object); if (!state) return false;
  if (!strcmp(operation.get(), "update")) {
    kandelo::crypto::Bytes input;
    if (!KandeloCryptoEncodedInput(cx, args.get(2), args.get(3), &input)) return false;
    output.setBoolean(state->hash ? state->hash->Update(input) : state->hmac->Update(input)); return true;
  }
  if (!strcmp(operation.get(), "digest")) {
    RootedObject bytes(cx);
    if (state->hash) {
      const auto& digest = state->hash->Digest();
      const size_t size = state->AccountedBytes();
      if (size > state->accounted) {
        JS::AddAssociatedMemory(object, size - state->accounted, JS::MemoryUse::Embedding3);
        state->accounted = size;
      }
      bytes = KandeloNewUint8ArrayCopy(cx, digest.value.data(), digest.value.size());
    } else {
      auto digest = state->hmac->Digest();
      bytes = KandeloNewUint8ArrayCopy(cx, digest.value.data(), digest.value.size());
    }
    if (!bytes) return false;
    output.setObject(*bytes); return true;
  }
  JS_ReportErrorASCII(cx, "Unknown native digest operation"); return false;
}
static bool KandeloNativeIncrementalHash(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedValue value(cx), error(cx);
  try {
    if (!KandeloIncrementalDispatch(cx, args, &value)) return false;
  } catch (const kandelo::crypto::Error& failure) {
    if (!KandeloDigestError(cx, failure, &error)) return false;
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  RootedObject packet(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  if (!packet || !JS_DefineProperty(cx, packet, "value", value, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, packet, "error", error, JSPROP_ENUMERATE)) return false;
  args.rval().setObject(*packet); return true;
}
}  // namespace
