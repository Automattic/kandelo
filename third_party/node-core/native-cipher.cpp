#include "kandelo-node-cipher-operations.h"
#include "kandelo-node-rsa-operations.h"
#include "kandelo-node-native-encoding.h"
#include <openssl/rsa.h>
namespace {
static void KandeloCipherFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (slot.isUndefined()) return;
  JS::RemoveAssociatedMemory(object, sizeof(kandelo::crypto::CipherState), JS::MemoryUse::Embedding3);
  delete static_cast<kandelo::crypto::CipherState*>(slot.toPrivate());
}
static const JSClassOps KandeloCipherOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloCipherFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloCipherClass = {"CipherBase",
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloCipherOps};
static bool KandeloCipherBytes(JSContext* cx, const std::vector<unsigned char>& bytes, MutableHandleValue result) {
  RootedObject output(cx, KandeloNewUint8ArrayCopy(cx, bytes.data(), bytes.size()));
  if (!output) return false;
  result.setObject(*output); return true;
}
static bool KandeloCipherInfo(JSContext* cx, const CallArgs& args, MutableHandleValue result) {
  ncrypto::Cipher cipher;
  if (args.get(1).isString()) {
    std::string name; if (!KandeloKeyString(cx, args[1], &name)) return false;
    cipher = ncrypto::Cipher::FromName(name.c_str());
  } else {
    int64_t nid; if (!KandeloFsInteger(cx, args.get(1), 1, INT32_MAX, &nid)) return false;
    cipher = ncrypto::Cipher::FromNid(int(nid));
  }
  if (!cipher) { result.setUndefined(); return true; }
  size_t key = cipher.getKeyLength(), iv = cipher.getIvLength();
  if (!args.get(2).isUndefined() || !args.get(3).isUndefined()) {
    auto ctx = ncrypto::CipherCtxPointer::New();
    if (!ctx) kandelo::crypto::CipherState::Code("ERR_CRYPTO_OPERATION_FAILED", "Failed to allocate cipher context");
    if (!ctx.init(cipher, true)) { result.setUndefined(); return true; }
    if (!args.get(2).isUndefined()) {
      int64_t value; if (!KandeloFsInteger(cx, args[2], 0, UINT32_MAX, &value)) return false;
      if (!ctx.setKeyLength(size_t(value))) { result.setUndefined(); return true; }
      key = size_t(value);
    }
    if (!args.get(3).isUndefined()) {
      int64_t value; if (!KandeloFsInteger(cx, args[3], 0, UINT32_MAX, &value)) return false;
      const size_t check = size_t(value);
      if (cipher.isCcmMode() ? check < 7 || check > 13 :
          cipher.isGcmMode() ? false : cipher.isOcbMode() ? !ctx.setIvLength(check) : check != iv) {
        result.setUndefined(); return true;
      }
      iv = check;
    }
  }
  RootedObject object(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  if (!object) return false;
  auto text = [&](const char* name, std::string_view value) {
    RootedValue string(cx);
    return KandeloFsPathString(cx, value.data(), value.size(), &string) &&
        JS_DefineProperty(cx, object, name, string, JSPROP_ENUMERATE);
  };
  auto number = [&](const char* name, size_t value) {
    return JS_DefineProperty(cx, object, name, double(value), JSPROP_ENUMERATE);
  };
  std::string name(cipher.getName());
  for (char& c : name) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
  if (!text("mode", cipher.getModeLabel()) || !text("name", name) ||
      (cipher.getNid() != NID_undef && !number("nid", cipher.getNid())) ||
      !number("keyLength", key) || (!cipher.isStreamMode() && !number("blockSize", cipher.getBlockSize())) ||
      (iv && !number("ivLength", iv))) return false;
  result.setObject(*object); return true;
}
// Public RSA transforms reuse actual immutable key material and original byte
// allocations. No JS pointer remains live across conversion/getter callbacks.
static bool KandeloRsaTransform(JSContext* cx,const CallArgs& args,MutableHandleValue result) {
  using Material=kandelo::crypto::KeyMaterial;
  using Operation=kandelo::crypto::RsaOperation;
  int64_t operationNumber;if(!KandeloFsInteger(cx,args.get(1),0,3,&operationNumber))return false;
  const auto operation=Operation(operationNumber);
  RootedObject handle(cx,KandeloKeyUnwrap(cx,args.get(2)));if(JS_IsExceptionPending(cx))return false;
  RootedValue materialOwner(cx);std::unique_ptr<Material> parsed;
  const Material* material=nullptr;
  if(handle&&JS::GetClass(handle)==&KandeloKeyHandleClass) {
    materialOwner=JS::GetReservedSlot(handle,0);material=KandeloKeyMaterial(handle);
    if(!material||material->isSecret)throw kandelo::crypto::KeyError("Invalid key object type","ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE");
  } else {
    int64_t format=1,encoding=1;
    if(!args.get(3).isNullOrUndefined()&&!KandeloFsInteger(cx,args.get(3),0,6,&format))return false;
    if(Material::Format(format)==Material::Format::JWK) {
      if(!args.get(2).isObject()){JS_ReportErrorASCII(cx,"RSA JWK requires an object");return false;}
      RootedObject jwk(cx,&args[2].toObject());
      handle=JS_NewObjectWithGivenProto(cx,&KandeloKeyHandleClass,nullptr);RootedValue ignored(cx);
      // Public-or-private consumption imports either kind. The actual EVP key,
      // not this temporary handle's projected role, determines the operation.
      if(!handle||!KandeloKeyImportJwk(cx,handle,1,jwk,&ignored))return false;
      materialOwner=JS::GetReservedSlot(handle,0);material=KandeloKeyMaterial(handle);
    } else if(Material::Format(format)==Material::Format::STORE) {
      if(operation==Operation::Encrypt||operation==Operation::Recover)
        throw kandelo::crypto::KeyError("URLs for OpenSSL STORE loaders are only accepted for private keys","ERR_INVALID_ARG_VALUE");
      throw kandelo::crypto::KeyError("OpenSSL STORE key loading is not implemented","ERR_METHOD_NOT_IMPLEMENTED");
    } else {
      kandelo::crypto::Bytes bytes,passphrase;
      if(!KandeloKeyCopyRaw(cx,args.get(2),&bytes))return false;
      if(Material::Format(format)==Material::Format::RAW_PUBLIC||Material::Format(format)==Material::Format::RAW_PRIVATE||Material::Format(format)==Material::Format::RAW_SEED) {
        std::string type,curve;if(!KandeloKeyString(cx,args.get(4),&type))return false;
        if(args.get(6).isString()&&!KandeloKeyString(cx,args.get(6),&curve))return false;
        parsed=Material::Raw(bytes,Material::Format(format),type,curve);
      } else {
        if(!args.get(4).isNullOrUndefined()&&!KandeloFsInteger(cx,args.get(4),0,3,&encoding))return false;
        const bool hasPassphrase=!args.get(5).isNullOrUndefined();
        if(hasPassphrase&&!KandeloKeyCopy(cx,args.get(5),&passphrase))return false;
        parsed=Material::Parse(false,bytes,Material::Configuration(int(format),int(encoding),hasPassphrase?&passphrase:nullptr));
      }
      material=parsed.get();
    }
  }
  KandeloCryptoByteSource input(cx);
  if(!input.Init(args.get(7))) {
    if(!JS_IsExceptionPending(cx))JS_ReportErrorASCII(cx,"RSA input requires actual buffer storage");return false;
  }
  if(input.Length()>INT_MAX)throw kandelo::crypto::KeyError("buffer is too long","ERR_OUT_OF_RANGE");
  auto original=input.Capture();if(!original)return false;
  uint32_t padding;if(!JS::ToUint32(cx,args.get(8),&padding))return false;
  kandelo::crypto::RsaImplicitRejection(material->asymmetric,operation,padding);
  std::string hashName,mgfName;
  if(args.get(9).isString()&&!KandeloKeyString(cx,args.get(9),&hashName))return false;
  auto digest=kandelo::crypto::RsaDigest(args.get(9).isString()?hashName.c_str():nullptr);
  JS::KandeloBacking::SpanRef label;
  if(!args.get(10).isUndefined()) {
    KandeloCryptoByteSource source(cx);
    if(!source.Init(args.get(10))){if(!JS_IsExceptionPending(cx))JS_ReportErrorASCII(cx,"RSA label requires actual buffer storage");return false;}
    if(source.Length()>INT_MAX)throw kandelo::crypto::KeyError("oaepLabel is too big","ERR_OUT_OF_RANGE");
    label=source.Capture();if(!label)return false;
  }
  if(args.get(11).isString()&&!KandeloKeyString(cx,args.get(11),&mgfName))return false;
  auto mgf=kandelo::crypto::RsaDigest(args.get(11).isString()?mgfName.c_str():nullptr);
  kandelo::crypto::Bytes bytes,labelBytes;
  KandeloCryptoCopy(original->Shared()?SharedMem<uint8_t*>::shared(original->Data()):SharedMem<uint8_t*>::unshared(original->Data()),original->Length(),&bytes);
  if(label)KandeloCryptoCopy(label->Shared()?SharedMem<uint8_t*>::shared(label->Data()):SharedMem<uint8_t*>::unshared(label->Data()),label->Length(),&labelBytes);
  // Use stable real storage for zero-length spans too, as the pinned foreign
  // ByteSource does. No payload copy precedes reentrant padding conversion.
  const unsigned char empty=0;
  auto output=kandelo::crypto::RsaTransform(material->asymmetric,operation,padding,digest,mgf,
      {labelBytes.value.empty()?&empty:labelBytes.value.data(),labelBytes.value.size()},
      {bytes.value.empty()?&empty:bytes.value.data(),bytes.value.size()});
  RootedObject data(cx,KandeloNewUint8ArrayCopy(cx,output.get<unsigned char>(),output.size()));
  if(!data)return false;result.setObject(*data);return true;
}

static bool KandeloCipherDispatch(JSContext* cx, const CallArgs& args, MutableHandleValue result) {
  std::string op; if (!KandeloKeyString(cx, args.get(0), &op)) return false;
  if (op == "constants") {
    RootedObject object(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
    if (!object || !JS_DefineProperty(cx, object, "RSA_PKCS1_OAEP_PADDING", RSA_PKCS1_OAEP_PADDING, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, object, "RSA_PKCS1_PADDING", RSA_PKCS1_PADDING, JSPROP_ENUMERATE)) return false;
    result.setObject(*object); return true;
  }
  if (op == "rsa") return KandeloRsaTransform(cx,args,result);
  if (op == "info") return KandeloCipherInfo(cx, args, result);
  if (op == "list") {
    std::vector<std::string> names;
    ncrypto::Cipher::ForEach([&](const char* name) { names.emplace_back(name); });
    std::sort(names.begin(), names.end()); names.erase(std::unique(names.begin(), names.end()), names.end());
    if (names.size() > UINT32_MAX) { JS_ReportOutOfMemory(cx); return false; }
    RootedObject array(cx, JS::NewArrayObject(cx, uint32_t(names.size())));
    if (!array) return false;
    for (uint32_t i = 0; i < names.size(); i++) {
      RootedValue name(cx);
      if (!KandeloFsPathString(cx, names[i].data(), names[i].size(), &name) ||
          !JS_DefineElement(cx, array, i, name, JSPROP_ENUMERATE)) return false;
    }
    result.setObject(*array); return true;
  }
  if (op == "encoding") {
    auto mode = kandelo::encoding::UTF8;
    if (args.get(1).isString()) {
      std::string value; if (!KandeloKeyString(cx, args[1], &value)) return false;
      mode = kandelo::encoding::ParseEncoding(value.c_str(), mode);
    }
    RootedString text(cx, JS_NewStringCopyZ(cx, kandelo::encoding::EncodingName(mode)));
    if (!text) return false;
    result.setString(text); return true;
  }
  if (op == "new") {
    if (!args.get(1).isObject() || !args.get(2).isBoolean()) {
      JS_ReportErrorASCII(cx, "Cipher requires a prototype and direction"); return false;
    }
    auto owner = std::make_unique<kandelo::crypto::CipherState>(args[2].toBoolean());
    std::string name, cts, xts;
    if (!KandeloKeyString(cx, args.get(3), &name)) return false;
    kandelo::crypto::Bytes copiedKey, iv;
    const unsigned char* key; size_t keyLength;
    JSObject* handle = KandeloKeyUnwrap(cx, args.get(4));
    if (handle && JS::GetClass(handle) == &KandeloKeyHandleClass) {
      auto* material = KandeloKeyMaterial(handle);
      if (!material || !material->isSecret) {
        JS_ReportErrorASCII(cx, "Cipher requires actual secret key material"); return false;
      }
      key = material->secret.get<unsigned char>(); keyLength = material->secret.size();
    } else {
      if (!KandeloCryptoInput(cx, args.get(4), &copiedKey)) return false;
      key = copiedKey.value.data(); keyLength = copiedKey.value.size();
    }
    if (!args.get(5).isNull() && !KandeloCryptoInput(cx, args.get(5), &iv)) return false;
    int64_t tag; if (!KandeloFsInteger(cx, args.get(6), -1, UINT32_MAX, &tag)) return false;
    if ((!args.get(7).isUndefined() && !KandeloKeyString(cx, args[7], &cts)) ||
        (!args.get(8).isUndefined() && !KandeloKeyString(cx, args[8], &xts))) return false;
    owner->Init(name, key, keyLength, iv.value.data(), iv.value.size(), unsigned(tag),
        args.get(7).isUndefined() ? nullptr : cts.c_str(), args.get(8).isUndefined() ? nullptr : xts.c_str());
    RootedObject prototype(cx, &args[1].toObject());
    RootedObject object(cx, JS_NewObjectWithGivenProto(cx, &KandeloCipherClass, prototype));
    if (!object) return false;
    JS::AddAssociatedMemory(object, sizeof(*owner), JS::MemoryUse::Embedding3);
    JS::SetReservedSlot(object, 0, PrivateValue(owner.release())); result.setObject(*object); return true;
  }
  JSObject* object = KandeloKeyUnwrap(cx, args.get(1));
  if (!object || JS::GetClass(object) != &KandeloCipherClass || JS::GetReservedSlot(object, 0).isUndefined()) {
    JS_ReportErrorASCII(cx, "Invalid native cipher receiver"); return false;
  }
  auto* state = static_cast<kandelo::crypto::CipherState*>(JS::GetReservedSlot(object, 0).toPrivate());
  if (op == "padding") { result.setBoolean(state->Padding(args.get(2).isTrue())); return true; }
  if (op == "final") return KandeloCipherBytes(cx, state->Final(), result);
  if (op == "getTag") {
    if (state->context || !state->encrypt || state->tagState != kandelo::crypto::CipherState::TagState::Computed) {
      result.setUndefined(); return true;
    }
    return KandeloCipherBytes(cx, {state->tag.begin(), state->tag.begin() + state->tagLength}, result);
  }
  kandelo::crypto::Bytes bytes;
  if (op == "update") {
    if (!KandeloCryptoEncodedInput(cx, args.get(2), args.get(3), &bytes)) return false;
  } else if (!KandeloCryptoInput(cx, args.get(2), &bytes)) return false;
  if (op == "update") return KandeloCipherBytes(cx, state->Update(bytes.value.data(), bytes.value.size()), result);
  if (op == "setTag") { result.setBoolean(state->SetTag(bytes.value.data(), bytes.value.size())); return true; }
  if (op == "aad") {
    int64_t length; if (!KandeloFsInteger(cx, args.get(3), INT32_MIN, INT32_MAX, &length)) return false;
    result.setBoolean(state->AAD(bytes.value.data(), bytes.value.size(), int(length))); return true;
  }
  JS_ReportErrorASCII(cx, "Unknown native cipher operation"); return false;
}
static bool KandeloNativeCipherOperation(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); RootedValue value(cx), error(cx);
  ncrypto::MarkPopErrorOnReturn mark;
  try { if (!KandeloCipherDispatch(cx, args, &value)) return false; }
  catch (const kandelo::crypto::Error& failure) { if (!KandeloDigestError(cx, failure, &error)) return false; }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  RootedObject packet(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  if (!packet || !JS_DefineProperty(cx, packet, "value", value, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, packet, "error", error, JSPROP_ENUMERATE)) return false;
  args.rval().setObject(*packet); return true;
}
}  // namespace
