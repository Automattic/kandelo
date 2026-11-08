// Actual portable pair generation and serialization owner. V8/uv/AsyncWrap,
// native handle DER-copy adoption and JWK are explicit fixture dependencies.
#include "kandelo-node-keypair-operations.h"
#include "node-frame-reference.h"
#include <node_buffer.h>
#include <uv.h>
using namespace v8;
using namespace kandelo::crypto;
namespace pair = kandelo::crypto::keypair;
struct Pending {};
static Local<String> Text(Isolate* i,const char* text) { return String::NewFromUtf8(i,text).ToLocalChecked(); }
static bool Put(Isolate* i,Local<Object> object,const char* key,Local<Value> value) {
 return object->Set(i->GetCurrentContext(),Text(i,key),value).FromMaybe(false);
}
static Local<Value> Failure(Isolate* i,const Error& error) {
 Local<Value> value;
 const auto kind=NativeNodeKind(error.code);
 if(kind==ErrorKind::TypeError)value=Exception::TypeError(Text(i,error.message.c_str()));
 else if(kind==ErrorKind::RangeError)value=Exception::RangeError(Text(i,error.message.c_str()));
 else value=Exception::Error(Text(i,error.message.c_str()));
 if(!ApplyErrorProperties(error,[&](const std::vector<std::string>& stack){
   auto a=Array::New(i,int(stack.size()));for(uint32_t n=0;n<stack.size();n++)
    if(a->CreateDataProperty(i->GetCurrentContext(),n,Text(i,stack[n].c_str())).IsNothing())return false;
   return Put(i,value.As<Object>(),"opensslErrorStack",a);
  },[&](const std::string& name,const std::string& text){return Put(i,value.As<Object>(),name.c_str(),Text(i,text.c_str()));}))throw Pending{};
 return value;
}
static void Packet(Isolate* i,const FunctionCallbackInfo<Value>& args,Local<Value> value,Local<Value> error) {
 auto p=Object::New(i);if(!Put(i,p,"value",value)||!Put(i,p,"error",error))throw Pending{};args.GetReturnValue().Set(p);
}
static std::string StringInput(Isolate* i,Local<Value> value) {
 String::Utf8Value text(i,value);if(!*text)throw Pending{};return std::string(*text,text.length());
}
static ncrypto::DataPointer CopyInput(Local<Value> value) {
 auto view=value.As<ArrayBufferView>();auto backing=view->Buffer()->GetBackingStore();
 return ncrypto::DataPointer::Copy({static_cast<const unsigned char*>(backing->Data())+view->ByteOffset(),view->ByteLength()});
}
static unsigned Configure(Isolate* i,const FunctionCallbackInfo<Value>& a,pair::Operation& config) {
 unsigned n=5;
 auto intValue=[&](){return a[n++]->Int32Value(i->GetCurrentContext()).FromJust();};
 auto uintValue=[&](){return a[n++]->Uint32Value(i->GetCurrentContext()).FromJust();};
 switch(config.kind) {
 case pair::Kind::Rsa: {
  auto& p=std::get<pair::RsaKeyPairGenConfig>(config.parameters).params;
  p.variant=pair::RSAKeyVariant(uintValue());p.modulus_bits=uintValue();p.exponent=uintValue();
  if(p.variant==pair::kKeyVariantRSA_PSS){for(bool mgf:{false,true}){if(!a[n]->IsUndefined())config.SetRsaDigest(StringInput(i,a[n]),mgf);++n;}if(!a[n]->IsUndefined())p.saltlen=intValue();else ++n;}
  break;
 }
 case pair::Kind::Dsa: {auto& p=std::get<pair::DsaKeyPairGenConfig>(config.parameters).params;p.modulus_bits=uintValue();p.divisor_bits=intValue();break;}
 case pair::Kind::Ec: {auto name=StringInput(i,a[n++]);const int encoding=a[n]->IsNullOrUndefined()?OPENSSL_EC_NAMED_CURVE:a[n]->Int32Value(i->GetCurrentContext()).FromJust();++n;config.SetCurve(name,encoding);break;}
 case pair::Kind::Dh: {
  auto& p=std::get<pair::DhKeyPairGenConfig>(config.parameters).params;
  if(a[n]->IsString())config.SetGroup(StringInput(i,a[n++]));
  else {if(a[n]->IsInt32())p.prime=intValue();else {auto bytes=CopyInput(a[n++]);p.prime=ncrypto::BignumPointer(bytes.get<unsigned char>(),bytes.size());}p.generator=unsigned(intValue());}break;
 }
 case pair::Kind::Named:config.SetNamed(StringInput(i,a[n++]));break;
 }
 auto encoding=[&](ncrypto::EVPKeyPointer::AsymmetricKeyEncodingConfig& e){
  e.output_key_object=a[n]->IsUndefined();
  if(!e.output_key_object){e.format=ncrypto::EVPKeyPointer::PKFormatType(a[n]->Int32Value(i->GetCurrentContext()).FromJust());
   if(!a[n+1]->IsNullOrUndefined()){
    const auto t=a[n+1]->Int32Value(i->GetCurrentContext()).FromJust();
    if(e.format==ncrypto::EVPKeyPointer::PKFormatType::RAW_PUBLIC||e.format==ncrypto::EVPKeyPointer::PKFormatType::RAW_PRIVATE||e.format==ncrypto::EVPKeyPointer::PKFormatType::RAW_SEED)e.ec_point_form=t;
    else e.type=ncrypto::EVPKeyPointer::PKEncodingType(t);
   }}n+=2;
 };
 encoding(config.publicEncoding);encoding(config.privateEncoding);
 if(!config.privateEncoding.output_key_object){
  if(a[n]->IsString()){const auto name=StringInput(i,a[n]);config.privateEncoding.cipher=ncrypto::Cipher::FromNameForKeyEncoding(name.c_str());if(!config.privateEncoding.cipher)throw KeyError("Unknown cipher","ERR_CRYPTO_UNKNOWN_CIPHER");}
  if(a[n+1]->IsArrayBufferView())config.privateEncoding.passphrase=CopyInput(a[n+1]);
 }
 return n+2;
}
struct Job {
 Isolate* isolate;bool sync,dispatched=false;uv_work_t work{};
 std::unique_ptr<pair::Operation> config;std::unique_ptr<KeyMaterial> material;std::unique_ptr<Error> error;
 Global<Object> owner;Global<Context> context;Global<Value> frame,keyPrototype;
 Global<Function> copy,adopt;node::async_context identity{};
 Job(Isolate* i,bool sync,pair::Kind kind):isolate(i),sync(sync),config(std::make_unique<pair::Operation>(kind)){work.data=this;context.Reset(i,i->GetCurrentContext());}
 ~Job(){if(!owner.IsEmpty())owner.Get(isolate)->SetAlignedPointerInInternalField(0,nullptr,kEmbedderDataTypeTagDefault);copy.Reset();adopt.Reset();keyPrototype.Reset();owner.Reset();frame.Reset();if(identity.async_id)node::EmitAsyncDestroy(isolate,identity);context.Reset();}
 static void WeakSecond(const WeakCallbackInfo<Job>& info){auto* p=info.GetParameter();HandleScope handles(p->isolate);Context::Scope scope(p->context.Get(p->isolate));delete p;}
 static void Weak(const WeakCallbackInfo<Job>& info){info.GetParameter()->owner.Reset();info.SetSecondPassCallback(WeakSecond);}
 void Invoke(){material.reset();error.reset();try{material=config->Generate();}catch(const Error& e){error=std::make_unique<Error>(e);}}
 Local<Value> Copy(const ncrypto::DataPointer& data){
  auto store=ArrayBuffer::New(isolate,data.size());if(data.size())std::memcpy(store->GetBackingStore()->Data(),data.get(),data.size());
  Local<Value> arg[]{Uint8Array::New(store,0,data.size())};Local<Value> result;
  if(!copy.Get(isolate)->Call(isolate->GetCurrentContext(),Undefined(isolate),1,arg).ToLocal(&result))throw Pending{};return result;
 }
 Local<Value> Encode(bool privateKey){
  const auto& encoding=privateKey?static_cast<const ncrypto::EVPKeyPointer::AsymmetricKeyEncodingConfig&>(config->privateEncoding):config->publicEncoding;
  if(encoding.output_key_object || encoding.format==ncrypto::EVPKeyPointer::PKFormatType::JWK){
   ncrypto::EVPKeyPointer::PrivateKeyEncodingConfig transfer;
   transfer.format=ncrypto::EVPKeyPointer::PKFormatType::DER;
   transfer.type=privateKey?ncrypto::EVPKeyPointer::PKEncodingType::PKCS8:ncrypto::EVPKeyPointer::PKEncodingType::SPKI;
   auto bytes=material->Export(std::move(transfer),privateKey);
   auto data=Copy(bytes);Local<Value> args[]{data,Integer::New(isolate,privateKey?2:1),keyPrototype.Get(isolate),Boolean::New(isolate,!encoding.output_key_object)};Local<Value> result;
   if(!adopt.Get(isolate)->Call(isolate->GetCurrentContext(),Undefined(isolate),4,args).ToLocal(&result))throw Pending{};return result;
  }
  auto bytes=config->Serialize(*material,privateKey);
  if(encoding.format==ncrypto::EVPKeyPointer::PKFormatType::PEM)return String::NewFromUtf8(isolate,bytes.get<const char>(),NewStringType::kNormal,int(bytes.size())).ToLocalChecked();
  return Copy(bytes);
 }
 Local<Array> Result(){
  auto result=Array::New(isolate,2);Local<Value> e=Undefined(isolate),value=Undefined(isolate);
  if(error)e=Failure(isolate,*error);
  else {Local<Value> pair[]{Encode(false),Encode(true)};value=Array::New(isolate,pair,2);}
  if(result->CreateDataProperty(isolate->GetCurrentContext(),0,e).IsNothing()||result->CreateDataProperty(isolate->GetCurrentContext(),1,value).IsNothing())throw Pending{};return result;
 }
 static void RunWorker(uv_work_t* work){auto* p=static_cast<Job*>(work->data);try{p->Invoke();}catch(...){std::abort();}}
 static void Complete(uv_work_t* work,int status){
  auto* raw=static_cast<Job*>(work->data);auto* i=raw->isolate;HandleScope handles(i);Context::Scope context(raw->context.Get(i));std::unique_ptr<Job> p(raw);auto owner=p->owner.Get(i);
  if(status==UV_ECANCELED)return;
  Local<Value> result;{TryCatch caught(i);try{result=p->Result();}catch(const Error& e){result=Array::New(i,2);const auto ok=result.As<Array>()->CreateDataProperty(i->GetCurrentContext(),0,Failure(i,e));if(ok.IsNothing())return;}catch(const Pending&){}
   if(caught.HasCaught()){auto error=caught.Exception();caught.Reset();auto packet=Array::New(i,2);if(packet->CreateDataProperty(i->GetCurrentContext(),0,error).IsNothing())return;result=packet;}}
  if(result.IsEmpty())return;
  Local<Value> callback;
  if(!owner->Get(i->GetCurrentContext(),Text(i,"ondone")).ToLocal(&callback))return;
  if(!callback->IsFunction())return;
  Local<Value> args[]{result.As<Array>()->Get(i->GetCurrentContext(),0).ToLocalChecked(),result.As<Array>()->Get(i->GetCurrentContext(),1).ToLocalChecked()};
  const auto done=node::InternalMakeCallback(i,owner,callback.As<Function>(),2,args,p->identity,p->frame.Get(i));(void)done;
 }
};
static void Create(const FunctionCallbackInfo<Value>& a){
 auto* i=a.GetIsolate();try{
  auto job=std::make_unique<Job>(i,a[4].As<Int32>()->Value()==1,pair::Kind(a[3].As<Int32>()->Value()));
  const unsigned end=Configure(i,a,*job->config);job->copy.Reset(i,a[2].As<Function>());job->adopt.Reset(i,a[end].As<Function>());job->keyPrototype.Reset(i,a[1]);
  auto shape=ObjectTemplate::New(i);shape->SetInternalFieldCount(1);auto owner=shape->NewInstance(i->GetCurrentContext()).ToLocalChecked();
  if(owner->SetPrototypeV2(i->GetCurrentContext(),a[0]).IsNothing())throw Pending{};
  owner->SetAlignedPointerInInternalField(0,job.get(),kEmbedderDataTypeTagDefault);job->owner.Reset(i,owner);
  job->frame.Reset(i,i->GetContinuationPreservedEmbedderDataV2().As<Value>());
  job->identity=node::EmitAsyncInit(i,owner,"KEYPAIRGENREQUEST");
  if(job->sync)job->owner.SetWeak(job.get(),Job::Weak,WeakCallbackType::kParameter);
  job.release();Packet(i,a,owner,Undefined(i));
 }catch(const Error& e){Packet(i,a,Undefined(i),Failure(i,e));}catch(const Pending&){}catch(const std::bad_alloc&){std::abort();}
}
static void Run(const FunctionCallbackInfo<Value>& a){
 auto* i=a.GetIsolate();auto owner=a[0].As<Object>();auto* job=owner->InternalFieldCount()?static_cast<Job*>(owner->GetAlignedPointerFromInternalField(0,kEmbedderDataTypeTagDefault)):nullptr;
 if(!job||job->dispatched){i->ThrowException(Exception::Error(Text(i,"Job not dispatchable")));return;}
 try{Local<Value> result=Undefined(i);if(job->sync){job->Invoke();result=job->Result();}else{job->dispatched=true;const int status=uv_queue_work(node::GetCurrentEventLoop(i),&job->work,Job::RunWorker,Job::Complete);if(status)throw std::runtime_error(uv_strerror(status));}Packet(i,a,result,Undefined(i));}
 catch(const Error& e){auto result=Array::New(i,2);if(result->CreateDataProperty(i->GetCurrentContext(),0,Failure(i,e)).IsNothing())return;Packet(i,a,result,Undefined(i));}catch(const Pending&){}catch(const std::bad_alloc&){std::abort();}
}
static void Initialize(Local<Object> exports,Local<Value> module,Local<Context> context,void* data){(void)module;(void)context;(void)data;NODE_SET_METHOD(exports,"create",Create);NODE_SET_METHOD(exports,"run",Run);}
NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME,Initialize)
