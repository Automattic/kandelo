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
