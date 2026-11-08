// Immutable certificate ownership over the declared ncrypto/OpenSSL library.
// Included after native-keys.cpp; public-key getters reuse its actual owner.
#include "kandelo-node-x509-operations.h"
#include "js/Date.h"
#include "js/Realm.h"
namespace {
struct KandeloX509Box {
  std::shared_ptr<kandelo::crypto::X509Material> material;
  kandelo::memory::Claim claim;
  KandeloX509Box(std::shared_ptr<kandelo::crypto::X509Material> material,
                 const kandelo::memory::AccountHandle& account)
      : material(std::move(material)), claim(this->material->Record(), account) {}
};
static void KandeloX509Finalize(JS::GCContext*, JSObject* object) {
  const auto slot=JS::GetReservedSlot(object,0);if(slot.isUndefined())return;
  JS::RemoveAssociatedMemory(object,sizeof(KandeloX509Box),JS::MemoryUse::Embedding3);
  delete static_cast<KandeloX509Box*>(slot.toPrivate());
}
static const JSClassOps KandeloX509ClassOps = {
  nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,KandeloX509Finalize,nullptr,nullptr,nullptr};
// An ordinary object brand; native identity is this actual private class.
static const JSClass KandeloX509Class = {"Object",
  JSCLASS_HAS_RESERVED_SLOTS(1)|JSCLASS_FOREGROUND_FINALIZE,&KandeloX509ClassOps};
static JSObject* KandeloX509Unwrap(JSContext* cx, HandleValue value) {
  return value.isObject()?js::CheckedUnwrapDynamic(&value.toObject(),cx):nullptr;
}
static KandeloX509Box* KandeloX509BoxOf(JSObject* object) {
  if(!object||JS::GetClass(object)!=&KandeloX509Class)return nullptr;
  const auto slot=JS::GetReservedSlot(object,0);return slot.isUndefined()?nullptr:static_cast<KandeloX509Box*>(slot.toPrivate());
}
static bool KandeloX509OwnMaterial(JSContext* cx,
    std::shared_ptr<kandelo::crypto::X509Material> material,
    HandleObject prototype, MutableHandleValue result) {
  RootedObject object(cx, JS_NewObjectWithGivenProto(cx, &KandeloX509Class, prototype));
  if (!object) return false;
  auto box = std::make_unique<KandeloX509Box>(std::move(material), KandeloNativeMemoryOwner(cx));
  JS::AddAssociatedMemory(object, sizeof(KandeloX509Box), JS::MemoryUse::Embedding3);
  JS::SetReservedSlot(object, 0, PrivateValue(box.release())); result.setObject(*object); return true;
}
// This branch of the existing keyOperation bridge is defined after the real
// key and X509 classes. It transfers native objects, never PEM/DER stand-ins.
static bool KandeloKeyParsePKCS12(JSContext* cx, const CallArgs& args, MutableHandleValue output) {
  if (!args.get(1).isObject() || !args.get(2).isObject()) {
    JS_ReportErrorASCII(cx,"PKCS12 requires actual key and certificate prototypes");return false;
  }
  RootedObject keyPrototype(cx,&args[1].toObject()),certPrototype(cx,&args[2].toObject());
  KandeloCryptoByteSource bundle(cx);
  if (!bundle.Init(args.get(3))) {
    if(!JS_IsExceptionPending(cx))throw kandelo::crypto::KeyError("Unable to read PKCS#12 data","ERR_CRYPTO_OPERATION_FAILED");
    return false;
  }
  ncrypto::BIOPointer bio;
  if (!bundle.WithBytes([&](SharedMem<uint8_t*> data,size_t length) {
    // SharedMem intentionally has no release-build sharedness predicate.
    // A cleansing-owned atomic byte snapshot is valid for both storage kinds.
    if(length>INT_MAX){bio=kandelo::crypto::LoadPKCS12BIO(data.unwrap(),length);return true;}
    auto copy=ncrypto::DataPointer::Alloc(length);
    if(length&&!copy)throw std::bad_alloc();
    for(size_t i=0;i<length;i++)copy.get<unsigned char>()[i]=__atomic_load_n(data.unwrap()+i,__ATOMIC_RELAXED);
    bio=kandelo::crypto::LoadPKCS12BIO(copy.get<unsigned char>(),length);return true;
  })) {
    if(!JS_IsExceptionPending(cx))throw kandelo::crypto::KeyError("Unable to read PKCS#12 data","ERR_CRYPTO_OPERATION_FAILED");
    return false;
  }
  if (!bio) throw kandelo::crypto::KeyError("Unable to read PKCS#12 data","ERR_CRYPTO_OPERATION_FAILED");
  // The BIO owns its copy before any later source/realm/security operation.
  // The password copy is NUL-terminated and cleansing-owned through parsing.
  ncrypto::DataPointer password;const char* pass=nullptr;bool containsNull=false;
  if (!args.get(4).isUndefined()) {
    KandeloCryptoByteSource source(cx);if(!source.Init(args.get(4))) {
      if(!JS_IsExceptionPending(cx))JS_ReportErrorASCII(cx,"PKCS12 passphrase requires actual buffer storage");return false;
    }
    if(!source.WithBytes([&](SharedMem<uint8_t*> data,size_t length) {
      if(length==SIZE_MAX)throw std::bad_alloc();password=ncrypto::DataPointer::Alloc(length+1);
      if(!password)throw std::bad_alloc();auto* bytes=password.get<unsigned char>();
      for(size_t i=0;i<length;i++){bytes[i]=__atomic_load_n(data.unwrap()+i,__ATOMIC_RELAXED);containsNull|=bytes[i]==0;}
      bytes[length]=0;return true;
    })) {
      if(!JS_IsExceptionPending(cx))JS_ReportErrorASCII(cx,"PKCS12 passphrase has no actual backing storage");return false;
    }
    if(containsNull)throw kandelo::crypto::KeyError("passphrase must not contain null bytes","ERR_INVALID_ARG_VALUE");
    pass=password.get<char>();
  }
  auto parsed=kandelo::crypto::ParseCryptoPKCS12(bio,pass);
  RootedValue key(cx,NullValue()),cert(cx,NullValue());
  if(parsed.key) {
    auto material=std::make_unique<kandelo::crypto::KeyMaterial>();material->asymmetric=std::move(parsed.key);
    RootedObject handle(cx,JS_NewObjectWithGivenProto(cx,&KandeloKeyHandleClass,keyPrototype));
    if(!handle||!KandeloKeyOwn(cx,handle,2,std::move(material)))return false;key.setObject(*handle);
  }
  auto certificate=[&](ncrypto::X509Pointer owned,MutableHandleValue value) {
    auto material=std::shared_ptr<kandelo::crypto::X509Material>(new kandelo::crypto::X509Material(std::move(owned),KandeloNativeMemoryOwner(cx)));
    RootedObject object(cx,JS_NewObjectWithGivenProto(cx,&KandeloX509Class,certPrototype));if(!object)return false;
    auto box=std::make_unique<KandeloX509Box>(std::move(material),KandeloNativeMemoryOwner(cx));
    JS::AddAssociatedMemory(object,sizeof(KandeloX509Box),JS::MemoryUse::Embedding3);
    JS::SetReservedSlot(object,0,PrivateValue(box.release()));value.setObject(*object);return true;
  };
  if(parsed.cert&&!certificate(std::move(parsed.cert),&cert))return false;
  RootedObject others(cx,JS::NewArrayObject(cx,0));if(!others)return false;
  const int count=parsed.ca?sk_X509_num(parsed.ca.get()):0;uint32_t written=0;
  for(int i=0;i<count;i++) {
    X509* ca=sk_X509_value(parsed.ca.get(),i);if(!ca)continue;
    if(X509_up_ref(ca)!=1)kandelo::crypto::Fail("Failed to retain PKCS#12 certificate");
    ncrypto::X509Pointer owned(ca);
    RootedValue value(cx);if(!certificate(std::move(owned),&value)||!JS_DefineElement(cx,others,written++,value,JSPROP_ENUMERATE))return false;
  }
  JS::RootedValueArray<3> fields(cx);fields[0].set(key);fields[1].set(cert);fields[2].setObject(*others);
  RootedObject result(cx,JS::NewArrayObject(cx,fields));if(!result)return false;output.setObject(*result);return true;
}
// Convert the actual retained immutable certificate snapshot, preserving
// pinned legacy key order, undefined own fields and null-prototype DN objects.
static bool KandeloX509LegacyName(JSContext* cx,const kandelo::crypto::X509Legacy::Name& name,
                                   MutableHandleValue output) {
  RootedObject object(cx,JS_NewObjectWithGivenProto(cx,nullptr,nullptr));if(!object)return false;
  for(const auto& entry:name) {
    RootedValue key(cx),value(cx),prior(cx);RootedId id(cx);
    if(!KandeloFsPathString(cx,entry.first.data(),entry.first.size(),&key))return false;
    RootedString keyString(cx,key.toString());
    if(!JS_StringToId(cx,keyString,&id)||
        !KandeloFsPathString(cx,entry.second.data(),entry.second.size(),&value))return false;
    bool present;if(!JS_HasPropertyById(cx,object,id,&present))return false;
    if(present) {
      if(!JS_GetPropertyById(cx,object,id,&prior))return false;
      bool array=false;
      if(prior.isObject()&&!JS::IsArrayObject(cx,prior,&array))return false;
      if(array) {
        RootedObject values(cx,&prior.toObject());uint32_t length;
        if(!JS::GetArrayLength(cx,values,&length)||!JS_SetElement(cx,values,length,value))return false;
        continue;
      }
      JS::RootedValueArray<2> pair(cx);pair[0].set(prior);pair[1].set(value);
      RootedObject values(cx,JS::NewArrayObject(cx,pair));if(!values)return false;
      value.setObject(*values);
    }
    if(!JS_SetPropertyById(cx,object,id,value))return false;
  }
  output.setObject(*object);return true;
}
static bool KandeloX509LegacyObject(JSContext* cx,const kandelo::crypto::X509Material& certificate,
                                     MutableHandleValue output) {
  // The caller roots/owns the immutable X509Material independently of SSL.
  // Preserve name-array setter reentry before reading later certificate/key
  // fields; no borrowed SSL or temporary BIO survives any JS operation.
  JS::RootedValueArray<19> values(cx);
  for(size_t i=0;i<19;++i)values[i].setUndefined();
  if(!KandeloX509LegacyName(cx,certificate.LegacyName(false),values[0])||
      !KandeloX509LegacyName(cx,certificate.LegacyName(true),values[1]))return false;
  const auto data=certificate.Legacy();
  auto text=[&](size_t index,const std::optional<std::string>& value) {
    return !value||KandeloFsPathString(cx,value->data(),value->size(),values[index]);
  };
  auto bytes=[&](size_t index,const std::optional<std::vector<unsigned char>>& value) {
    if(!value)return true;RootedObject array(cx,KandeloNewUint8ArrayCopy(cx,value->data(),value->size()));
    if(!array)return false;values[index].setObject(*array);return true;
  };
  values[4].setBoolean(data.ca);if(data.bits)values[8].setInt32(*data.bits);
  if(data.exponentNull)values[6].setNull();
  if(!text(2,data.subjectAltName)||!text(3,data.infoAccess)||!text(5,data.modulus)||
      !text(6,data.exponent)||!bytes(7,data.pubkey)||!text(9,data.validFrom)||
      !text(10,data.validTo)||!text(11,data.fingerprint)||!text(12,data.fingerprint256)||
      !text(13,data.fingerprint512)||!text(15,data.serialNumber)||!bytes(16,data.raw)||
      !text(17,data.asn1Curve)||!text(18,data.nistCurve))return false;
  if(data.usages) {
    RootedObject array(cx,JS::NewArrayObject(cx,data.usages->size()));if(!array)return false;
    for(size_t i=0;i<data.usages->size();++i) {
      const auto& usage=(*data.usages)[i];RootedValue value(cx);
      if(!KandeloFsPathString(cx,usage.data(),usage.size(),&value)||!JS_DefineElement(cx,array,i,value,JSPROP_ENUMERATE))return false;
    }
    values[14].setObject(*array);
  }
  static const char* names[]={"subject","issuer","subjectaltname","infoAccess","ca",
      "modulus","exponent","pubkey","bits","valid_from","valid_to","fingerprint",
      "fingerprint256","fingerprint512","ext_key_usage","serialNumber","raw","asn1Curve","nistCurve"};
  RootedObject object(cx,JS_NewPlainObject(cx));if(!object)return false;
  for(size_t i=0;i<19;++i)if(!JS_DefineProperty(cx,object,names[i],values[i],JSPROP_ENUMERATE))return false;
  output.setObject(*object);return true;
}
static bool KandeloX509Dispatch(JSContext* cx,const CallArgs& args,MutableHandleValue result) {
  UniqueChars operation;if(!KandeloGetString(cx,args.get(0),&operation))return false;
  const std::string_view name(operation.get());
  if(name=="constants") {
    RootedObject object(cx,JS_NewPlainObject(cx));if(!object)return false;
    const struct{const char*name;unsigned value;} constants[]={
      {"X509_CHECK_FLAG_ALWAYS_CHECK_SUBJECT",X509_CHECK_FLAG_ALWAYS_CHECK_SUBJECT},
      {"X509_CHECK_FLAG_NEVER_CHECK_SUBJECT",X509_CHECK_FLAG_NEVER_CHECK_SUBJECT},
      {"X509_CHECK_FLAG_NO_WILDCARDS",X509_CHECK_FLAG_NO_WILDCARDS},
      {"X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS",X509_CHECK_FLAG_NO_PARTIAL_WILDCARDS},
      {"X509_CHECK_FLAG_MULTI_LABEL_WILDCARDS",X509_CHECK_FLAG_MULTI_LABEL_WILDCARDS},
      {"X509_CHECK_FLAG_SINGLE_LABEL_SUBDOMAINS",X509_CHECK_FLAG_SINGLE_LABEL_SUBDOMAINS}};
    for(const auto&entry:constants)if(!JS_DefineProperty(cx,object,entry.name,entry.value,JSPROP_ENUMERATE))return false;
    result.setObject(*object);return true;
  }
  if(name=="create") {
    if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"X509 constructor requires a prototype");return false;}
    RootedObject prototype(cx,&args[1].toObject());
    std::shared_ptr<kandelo::crypto::X509Material> material;
    RootedObject source(cx,KandeloX509Unwrap(cx,args.get(2)));
    if(cx->isExceptionPending())return false;
    if(auto*box=KandeloX509BoxOf(source))material=box->material;
    else {
      if(!source||!JS_IsArrayBufferViewObject(source))
        throw kandelo::crypto::X509Error("value must be an X509CertificateHandle or BufferSource","ERR_INVALID_ARG_TYPE");
      // JS_IsArrayBufferViewObject accepts transparent cross-realm wrappers,
      // while the internal IsBufferSource helper does not unwrap them. Use
      // the actual checked-unwrapped view and its realm for this synchronous
      // borrow; returned objects are allocated after this scope restores the
      // caller realm. No non-inline conversion/length pin is needed under GC
      // suppression, and no borrowed JS pointer survives the parse.
      RootedObject input(cx,source);JSAutoRealm sourceRealm(cx,input);
      const size_t length=JS_GetArrayBufferViewByteLength(input);bool shared;
      JS::AutoCheckCannotGC nogc;
      auto* data=static_cast<uint8_t*>(JS_GetArrayBufferViewData(input,&shared,nogc));
      if(shared) {
        kandelo::crypto::Bytes copy;
        KandeloCryptoCopy(SharedMem<uint8_t*>::shared(data),length,&copy);
        material=kandelo::crypto::X509Material::Parse(copy.value.data(),copy.value.size(),KandeloNativeMemoryOwner(cx));
      } else material=kandelo::crypto::X509Material::Parse(data,length,KandeloNativeMemoryOwner(cx));
    }
    RootedObject object(cx,JS_NewObjectWithGivenProto(cx,&KandeloX509Class,prototype));if(!object)return false;
    auto box=std::make_unique<KandeloX509Box>(std::move(material),KandeloNativeMemoryOwner(cx));
    JS::AddAssociatedMemory(object,sizeof(KandeloX509Box),JS::MemoryUse::Embedding3);
    JS::SetReservedSlot(object,0,PrivateValue(box.release()));result.setObject(*object);return true;
  }
  RootedObject wrapper(cx,KandeloX509Unwrap(cx,args.get(1)));
  if(cx->isExceptionPending())return false;
  if(name=="is"){result.setBoolean(KandeloX509BoxOf(wrapper)!=nullptr);return true;}
  auto* box=KandeloX509BoxOf(wrapper);
  if(!box)throw kandelo::crypto::X509Error("Value of this must be of type X509Certificate","ERR_INVALID_THIS");
  const auto&cert=*box->material;
  if(name=="toLegacy") {
    ncrypto::ClearErrorOnReturn clear;
    return KandeloX509LegacyObject(cx,cert,result);
  }
  if(name=="getIssuerCert") {
    auto issuer=cert.Issuer();if(!issuer){result.setUndefined();return true;}
    RootedObject prototype(cx);
    { JSAutoRealm realm(cx,wrapper);if(!JS_GetPrototype(cx,wrapper,&prototype))return false; }
    if(!JS_WrapObject(cx,&prototype))return false;
    return KandeloX509OwnMaterial(cx,std::move(issuer),prototype,result);
  }
  if(name=="checkCA"){result.setBoolean(cert.CA());return true;}
  if(name=="checkIssued") {
    RootedObject other(cx,KandeloX509Unwrap(cx,args.get(2)));if(cx->isExceptionPending())return false;
    auto* issuer=KandeloX509BoxOf(other);if(!issuer)throw kandelo::crypto::X509Error("otherCert must be an X509Certificate","ERR_INVALID_ARG_TYPE");
    result.setBoolean(cert.View().isIssuedBy(issuer->material->View()));return true;
  }
  if(name=="checkPrivateKey"||name=="verify") {
    RootedObject key(cx,KandeloKeyUnwrap(cx,args.get(2)));if(cx->isExceptionPending())return false;
    auto* material=key&&JS::GetClass(key)==&KandeloKeyHandleClass?KandeloKeyMaterial(key):nullptr;
    if(!material||material->isSecret||KandeloKeyRole(key)!=(name=="checkPrivateKey"?2:1))
      throw kandelo::crypto::X509Error("Invalid native certificate key handle","ERR_INVALID_ARG_TYPE");
    result.setBoolean(name=="checkPrivateKey"?cert.View().checkPrivateKey(material->asymmetric):cert.View().checkPublicKey(material->asymmetric));return true;
  }
  if(name=="validFromDate"||name=="validToDate"){
    RootedObject date(cx,JS::NewDateObject(cx,JS::TimeClip(cert.Date(name=="validFromDate"))));if(!date)return false;result.setObject(*date);return true;
  }
  if(name=="keyUsage") {
    auto usages=cert.KeyUsage();if(!usages){result.setUndefined();return true;}
    RootedObject array(cx,JS::NewArrayObject(cx,0));if(!array)return false;
    for(size_t i=0;i<usages->size();++i){RootedValue value(cx);if(!KandeloFsPathString(cx,(*usages)[i].data(),(*usages)[i].size(),&value)||!JS_SetElement(cx,array,i,value))return false;}
    result.setObject(*array);return true;
  }
  if(name=="raw") {
    auto bytes=cert.Raw();if(!bytes){result.setUndefined();return true;}
    RootedObject data(cx,KandeloNewUint8ArrayCopy(cx,bytes->data(),bytes->size()));if(!data)return false;result.setObject(*data);return true;
  }
  if(name=="publicKey") {
    if(!args.get(2).isObject()){JS_ReportErrorASCII(cx,"X509 public key requires the actual key-handle prototype");return false;}
    auto material=std::make_unique<kandelo::crypto::KeyMaterial>();material->asymmetric=cert.PublicKey();
    RootedObject prototype(cx,&args[2].toObject());RootedObject key(cx,JS_NewObjectWithGivenProto(cx,&KandeloKeyHandleClass,prototype));
    if(!key||!KandeloKeyOwn(cx,key,1,std::move(material)))return false;result.setObject(*key);return true;
  }
  auto text=cert.String(name);if(!text){result.setUndefined();return true;}
  return KandeloFsPathString(cx,text->data(),text->size(),result);
}
static bool KandeloNativeX509Operation(JSContext* cx,unsigned argc,Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp);RootedValue value(cx),error(cx);ncrypto::MarkPopErrorOnReturn mark;
  try{if(!KandeloX509Dispatch(cx,args,&value))return false;}
  catch(const kandelo::crypto::Error&failure){if(!KandeloDigestError(cx,failure,&error))return false;}
  catch(const std::bad_alloc&){JS_ReportOutOfMemory(cx);return false;}
  RootedObject packet(cx,JS_NewObjectWithGivenProto(cx,nullptr,nullptr));
  if(!packet||!JS_DefineProperty(cx,packet,"value",value,JSPROP_ENUMERATE)||!JS_DefineProperty(cx,packet,"error",error,JSPROP_ENUMERATE))return false;
  args.rval().setObject(*packet);return true;
}
} // namespace
