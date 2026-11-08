// Actual consumed KeyMaterial EC PKCS8 helper over exact native ncrypto/OpenSSL.
// V8 is a fixture boundary; guest dispatcher/allocation/GC are not executed.
#include "kandelo-node-key-operations.h"
#include <node.h>
#include <node_buffer.h>
using namespace v8;
using namespace kandelo::crypto;
struct Pending {};
static Local<String> Text(Isolate* i,const char* text){return String::NewFromUtf8(i,text).ToLocalChecked();}
static Bytes Input(Local<Value> value){auto view=value.As<ArrayBufferView>();auto store=view->Buffer()->GetBackingStore();Bytes bytes;const auto* p=static_cast<const unsigned char*>(store->Data())+view->ByteOffset();bytes.value.assign(p,p+view->ByteLength());return bytes;}
static void Export(const FunctionCallbackInfo<Value>& args){
 auto* i=args.GetIsolate();try{
  auto input=Input(args[0]);auto config=KeyMaterial::Configuration(int(KeyMaterial::Format::DER),args[2]->IsInt32()?args[2].As<Int32>()->Value():int(KeyMaterial::Encoding::SEC1),nullptr);
  // SEC1 here is only the explicit fixture input hint. Actual parser detects
  // valid RSA/OKP DER too, allowing genuine wrong-type operation controls.
  auto material=KeyMaterial::Parse(true,input,std::move(config));
  const bool capture=args.Length()>3&&args[3]->IsTrue();
  ncrypto::DataPointer beforePrivate,afterPrivate,beforePublic,afterPublic;
  auto serialize=[&](bool privateKey){
    auto config=KeyMaterial::Configuration(int(KeyMaterial::Format::DER),
      int(privateKey?KeyMaterial::Encoding::SEC1:KeyMaterial::Encoding::SPKI),nullptr);
    return material->Export(std::move(config),privateKey);
  };
  if(capture){beforePrivate=serialize(true);beforePublic=serialize(false);}
  auto encoded=material->ExportEcPrivatePkcs8();
  if(capture){afterPrivate=serialize(true);afterPublic=serialize(false);}
  BUF_MEM* memory=encoded;
  if(!memory)throw KeyError("Unable to create BUF_MEM pointer","ERR_CRYPTO_OPERATION_FAILED");
  // Allow actual GC/input mutation while real native material and BIO remain
  // owned. No pointer references the input view after native parsing.
  if(args.Length()>1&&args[1]->IsFunction()){
   if(args[1].As<Function>()->Call(i->GetCurrentContext(),Undefined(i),0,nullptr).IsEmpty())return;
  }
  Local<Object> bytes;
  if(!node::Buffer::Copy(i,memory->data,memory->length).ToLocal(&bytes))return;
  if(!capture){args.GetReturnValue().Set(bytes);return;}
  auto packet=Object::New(i);
  if(packet->CreateDataProperty(i->GetCurrentContext(),Text(i,"value"),bytes).IsNothing())return;
  auto field=[&](const char* name,const ncrypto::DataPointer& data){
    Local<Object> value;if(!node::Buffer::Copy(i,data.get<const char>(),data.size()).ToLocal(&value))return false;
    return !packet->CreateDataProperty(i->GetCurrentContext(),Text(i,name),value).IsNothing();
  };
  if(!field("beforePrivate",beforePrivate)||!field("afterPrivate",afterPrivate)||
     !field("beforePublic",beforePublic)||!field("afterPublic",afterPublic))return;
  args.GetReturnValue().Set(packet);
 }catch(const Error& error){
  auto value=Exception::Error(Text(i,error.message.c_str()));
  if(!ApplyErrorProperties(error,[&](const std::vector<std::string>& stack){
    auto array=Array::New(i,int(stack.size()));for(uint32_t n=0;n<stack.size();n++)if(array->CreateDataProperty(i->GetCurrentContext(),n,Text(i,stack[n].c_str())).IsNothing())return false;
    return value.As<Object>()->Set(i->GetCurrentContext(),Text(i,"opensslErrorStack"),array).FromMaybe(false);
   },[&](const std::string& name,const std::string& text){return value.As<Object>()->Set(i->GetCurrentContext(),Text(i,name.c_str()),Text(i,text.c_str())).FromMaybe(false);}))return;
  i->ThrowException(value);
 }catch(const std::bad_alloc&){std::abort();}
}
static void Initialize(Local<Object> exports,Local<Value> module,Local<Context> context,void* data){(void)module;(void)context;(void)data;NODE_SET_METHOD(exports,"exportPkcs8",Export);}
NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME,Initialize)
