#ifndef KANDELO_NODE_TRACE_CODECS_INL_H
#define KANDELO_NODE_TRACE_CODECS_INL_H
// Native engine primitives shared by the complete original tracing sources.
// This file is included after the rooted codec marshalling implementation.
#include "shell/node-upstream/trace-builtin-native-api.h"

namespace kandelo_node_codec_api {
Local<Value> True(Isolate* isolate) { auto& f=Current(isolate);JS::RootedValue v(f.cx,JS::BooleanValue(true));return f.OwnValue(v); }
Local<Value> False(Isolate* isolate) { auto& f=Current(isolate);JS::RootedValue v(f.cx,JS::BooleanValue(false));return f.OwnValue(v); }
Local<Value> Factory::undefined_value() { auto& f=Current(isolate);JS::RootedValue v(f.cx,JS::UndefinedValue());return f.OwnValue(v); }
Local<Object> Receiver(Isolate* isolate) { auto& f=Current(isolate);CHECK(f.receiver.isObject());return f.Own<Object>(f.receiver); }
void ReturnRaw(Isolate* isolate,const JS::Value& value) { auto& f=Current(isolate);if(!JS_IsExceptionPending(f.cx))f.arguments->rval().set(value); }
MaybeLocal<Value> Object::Get(Local<Context> context,Local<Value> property) {
  auto& f=Current(context->isolate);JS::RootedObject object(f.cx,&cell().value.toObject());JS::RootedId key(f.cx);JS::RootedValue name(f.cx,Input(property)),result(f.cx);
  if(!JS_ValueToId(f.cx,name,&key)||!JS_GetPropertyById(f.cx,object,key,&result))return {};
  return f.OwnValue(result);
}
uint32_t Array::Length() const { auto& f=*Frame::current;JS::RootedObject object(f.cx,&cell().value.toObject());uint32_t length;CHECK(JS::GetArrayLength(f.cx,object,&length));return length; }
MaybeLocal<Value> Array::Get(Local<Context> context,uint32_t index) {
  auto& f=Current(context->isolate);JS::RootedObject object(f.cx,&cell().value.toObject());JS::RootedValue value(f.cx);
  if(!JS_GetElement(f.cx,object,index,&value))return {};return f.OwnValue(value);
}
size_t String::Utf8Length(Isolate* isolate,Local<String> input) {
  auto& f=Current(isolate);JS::RootedString string(f.cx,input->cell().value.toString());std::vector<char> encoded;
  CHECK(kandelo::node::EncodeTraceString(f.cx,string,&encoded));return encoded.size()-1;
}
size_t String::WriteUtf8(Isolate* isolate,Local<String> input,char* target,size_t capacity,Utf8EncodingFlag flag) {
  auto& f=Current(isolate);CHECK(flag==Utf8EncodingFlag::kNullTerminate);JS::RootedString string(f.cx,input->cell().value.toString());std::vector<char> encoded;
  CHECK(kandelo::node::EncodeTraceString(f.cx,string,&encoded));CHECK(encoded.size()<=capacity);std::memcpy(target,encoded.data(),encoded.size());return encoded.size();
}
BackingStore::BackingStore(void* data,size_t size,void(*deleter)(void*,size_t,void*),void* userData,std::shared_ptr<kandelo::node::TraceProcess> process):data(data),size(size),deleter(deleter),userData(userData),process(std::move(process)) {}
BackingStore::~BackingStore() { deleter(data,size,userData); }
std::unique_ptr<BackingStore> ArrayBuffer::NewBackingStore(void* data,size_t size,void(*deleter)(void*,size_t,void*),void* userData) {
  auto& f=*Frame::current;CHECK(f.domain==Domain::Trace && f.tracing);
  return std::make_unique<BackingStore>(data,size,deleter,userData,f.tracing);
}
Local<ArrayBuffer> ArrayBuffer::New(Isolate* isolate,std::unique_ptr<BackingStore> store) {
  auto& f=Current(isolate);if(JS_IsExceptionPending(f.cx))return {};
  size_t size=store->size;void* data=store->data;auto* owner=store.release();
  // Releasing this owner may run on a GC thread; it never destroys the agent.
  // The explicit main-thread process hook owns shutdown, and bytes are static.
  mozilla::UniquePtr<void,JS::BufferContentsDeleter> contents(data,JS::BufferContentsDeleter([](void*,void* context){delete static_cast<BackingStore*>(context);},owner));
  JS::RootedObject object(f.cx,JS::NewExternalArrayBuffer(f.cx,size,std::move(contents)));if(!object)return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));return f.Own<ArrayBuffer>(value);
}
Local<Uint8Array> Uint8Array::New(Local<ArrayBuffer> buffer,size_t offset,size_t length) {
  auto& f=*Frame::current;if(JS_IsExceptionPending(f.cx))return {};
  JS::RootedObject raw(f.cx,&buffer->cell().value.toObject());JS::RootedObject object(f.cx,JS_NewUint8ArrayWithBuffer(f.cx,raw,offset,length));if(!object)return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));return f.Own<Uint8Array>(value);
}
namespace {
JSFunction* TraceFunction(Frame& frame,const char* name,Callback callback,unsigned length,bool constructor,bool receiver) {
  JS::RootedFunction fn(frame.cx,js::NewFunctionWithReserved(frame.cx,Invoke,length,constructor?JSFUN_CONSTRUCTOR:0,name));if(!fn)return nullptr;
  JS::RootedObject object(frame.cx,JS_GetFunctionObject(fn)),closure(frame.cx,JS_NewObject(frame.cx,&callbackClass));if(!closure)return nullptr;
  JS::SetReservedSlot(closure,0,JS::PrivateValue(new CallbackOwner{callback,Domain::Trace,constructor,receiver,0}));
  JS::SetReservedSlot(closure,1,JS::ObjectValue(*frame.binding));
  js::SetFunctionNativeReserved(object,0,JS::ObjectValue(*frame.realm));js::SetFunctionNativeReserved(object,1,JS::ObjectValue(*closure));
  if(constructor){
    JS::RootedObject prototype(frame.cx,JS_NewPlainObject(frame.cx));
    if(!prototype||!JS_DefineProperty(frame.cx,prototype,"constructor",object,0)||!JS_DefineProperty(frame.cx,object,"prototype",prototype,JSPROP_PERMANENT))return nullptr;
  }
  return fn;
}
}
void SetTraceFieldCount(JSObject* object,int count) {
  auto value=js::GetFunctionNativeReserved(object,1);auto* callback=static_cast<CallbackOwner*>(JS::GetReservedSlot(&value.toObject(),0).toPrivate());callback->fieldCount=count;
}
Local<Object> Context::GetExtrasBindingObject() {
  auto& f=Current(isolate);CHECK(JS::GetClass(f.binding)==&traceBindingClass);
  auto cached=JS::GetReservedSlot(f.binding,0);
  if(cached.isObject()){JS::RootedValue value(f.cx,cached);return f.Own<Object>(value);}
  JS::RootedObject extras(f.cx,JS_NewObjectWithGivenProto(f.cx,nullptr,nullptr));if(!extras)return {};
  for(auto entry:{std::tuple{"isTraceCategoryEnabled",kandelo_trace_adapter::IsTraceCategoryEnabled,1u},std::tuple{"trace",kandelo_trace_adapter::Trace,5u}}){
    JS::RootedFunction fn(f.cx,TraceFunction(f,std::get<0>(entry),std::get<1>(entry),std::get<2>(entry),false,false));if(!fn)return {};
    JS::RootedObject object(f.cx,JS_GetFunctionObject(fn));if(!JS_DefineProperty(f.cx,extras,std::get<0>(entry),object,JSPROP_ENUMERATE))return {};
  }
  JS::SetReservedSlot(f.binding,0,JS::ObjectValue(*extras));JS::RootedValue value(f.cx,JS::ObjectValue(*extras));return f.Own<Object>(value);
}
}
namespace kandelo_node_codec_impl {
const JSClass categoryClass={"CategorySet",JSCLASS_HAS_RESERVED_SLOTS(BaseObject::kInternalFieldCount)|JSCLASS_FOREGROUND_FINALIZE,&converterOps};
Local<FunctionTemplate> NewFunctionTemplate(Isolate* isolate,void(*callback)(const FunctionCallbackInfo<Value>&)) {
  auto& f=api::Current(isolate);CHECK(f.domain==api::Domain::Trace);
  JS::RootedFunction fn(f.cx,api::TraceFunction(f,"",callback,0,true,false));if(!fn)return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*JS_GetFunctionObject(fn)));return f.Own<FunctionTemplate>(value);
}
void SetProtoMethod(Isolate* isolate,Local<FunctionTemplate> constructor,const char* name,void(*callback)(const FunctionCallbackInfo<Value>&)) {
  auto& f=api::Current(isolate);JS::RootedObject ctor(f.cx,&constructor->cell().value.toObject());JS::RootedValue prototype(f.cx);
  CHECK(JS_GetProperty(f.cx,ctor,"prototype",&prototype));JS::RootedObject object(f.cx,&prototype.toObject());
  JS::RootedFunction fn(f.cx,api::TraceFunction(f,name,callback,0,false,true));CHECK(fn);
  JS::RootedObject function(f.cx,JS_GetFunctionObject(fn));CHECK(JS_DefineProperty(f.cx,object,name,function,JSPROP_ENUMERATE));
}
void SetConstructorFunction(Local<Context> context,Local<Object> target,const char* name,Local<FunctionTemplate> constructor) {
  auto& f=api::Current(context->isolate);auto string=OneByteString(context->isolate,name);constructor->SetClassName(string);
  JS::RootedObject object(f.cx,&target->cell().value.toObject());JS::RootedValue value(f.cx,api::Input(constructor));CHECK(JS_SetProperty(f.cx,object,name,value));
  JS::SetReservedSlot(f.binding,2,value);
}
MaybeLocal<Value> ToV8Value(Local<Context> context,const std::string& text,Isolate* isolate) { return String::NewFromUtf8(isolate,text.data(),NewStringType::kNormal,int(text.size())); }
namespace {
struct TraceObserver final : public v8::TracingController::TraceStateObserver {
  bool armed=false;
  JSContext* cx;JS::Heap<JSObject*> self;std::shared_ptr<kandelo::node::TraceProcess> process;
  TraceObserver(JSContext* cx,JSObject* self,std::shared_ptr<kandelo::node::TraceProcess> process):cx(cx),self(self),process(std::move(process)){}
  ~TraceObserver(){kandelo::node::RemoveTraceObserver(process,this);}
  void OnTraceEnabled() override { Notify(); }
  void OnTraceDisabled() override { Notify(); }
  void Notify(){
    if(!armed)return;
    JS::RootedObject object(cx,self);JS::RootedObject realm(cx,js::UncheckedUnwrap(&JS::GetReservedSlot(object,1).toObject()));
    if(kandelo::node::RealmLibraryIsFailed(realm)||js::shell::GetShellContext(cx)->quitting)return;
    JS::RootedObject runtime(cx,&JS::GetReservedSlot(object,3).toObject());
    JS::RootedObject principal(cx,kandelo::node::GetRuntimePrincipalRealm(cx,runtime));if(!principal)return;
    principal=js::CheckedUnwrapDynamic(principal,cx,false);if(!principal||kandelo::node::RealmLibraryIsFailed(principal))return;
    JSAutoRealm enter(cx,principal);JS::RootedValue handler(cx,JS::GetReservedSlot(object,0)),result(cx);
    auto* controller=kandelo::node::GetTraceAgent(process)->GetTracingController();
    JS::RootedValue argument(cx,JS::BooleanValue(*controller->GetCategoryGroupEnabled("node.async_hooks")!=0));
    // This is the engine callback seam. A real pending exception remains a
    // failure; fatal-process routing beyond the existing runtime seam is open.
    if(!JS_WrapValue(cx,&handler))return;
    (void)JS::Call(cx,JS::UndefinedHandleValue,handler,JS::HandleValueArray(argument),&result);
  }
};
void FinalizeObserver(JS::GCContext*,JSObject* object){auto value=JS::GetReservedSlot(object,2);if(!value.isUndefined()){JS::SetReservedSlot(object,2,JS::UndefinedValue());delete static_cast<TraceObserver*>(value.toPrivate());}}
void TraceObserverEdges(JSTracer* tracer,JSObject* object){auto value=JS::GetReservedSlot(object,2);if(!value.isUndefined())JS::TraceEdge(tracer,&static_cast<TraceObserver*>(value.toPrivate())->self,"native trace observer owner");}
const JSClassOps observerOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeObserver,nullptr,nullptr,TraceObserverEdges};
const JSClass observerClass={"NodeTraceObserver",JSCLASS_HAS_RESERVED_SLOTS(4)|JSCLASS_FOREGROUND_FINALIZE,&observerOps};
}
void Environment::set_trace_category_state_function(Local<Function> handler) {
  auto& f=*Frame::current;CHECK(f.domain==api::Domain::Trace && f.tracing);
  JS::RootedObject runtime(f.cx,kandelo::node::GetRealmRuntime(f.cx,f.realm));CHECK(runtime);
  JS::RootedObject stateObject(f.cx,kandelo::node::GetRuntimeCodecState(f.cx,runtime,true));CHECK(stateObject);
  stateObject=js::CheckedUnwrapDynamic(stateObject,f.cx,false);CHECK(stateObject);
  JS::RootedValue callback(f.cx,api::Input(handler));JS::RootedObject ownerRealm(f.cx,f.realm);
  JSAutoRealm home(f.cx,stateObject);CHECK(JS_WrapValue(f.cx,&callback)&&JS_WrapObject(f.cx,&ownerRealm)&&JS_WrapObject(f.cx,&runtime));
  auto cached=JS::GetReservedSlot(stateObject,1);JS::RootedObject object(f.cx);
  if(cached.isObject())object=&cached.toObject();
  else {
    object=JS_NewObject(f.cx,&observerClass);CHECK(object);
    JS::SetReservedSlot(object,0,callback);JS::SetReservedSlot(object,1,JS::ObjectValue(*ownerRealm));JS::SetReservedSlot(object,3,JS::ObjectValue(*runtime));
    auto* observer=new TraceObserver(f.cx,object,f.tracing);JS::SetReservedSlot(object,2,JS::PrivateValue(observer));
    JS::SetReservedSlot(stateObject,1,JS::ObjectValue(*object));// Node's environment observer predates this setter. Suppress the immediate
    // notification from our late registration until the handler is installed.
    kandelo::node::RegisterTraceObserver(f.tracing,observer);observer->armed=true;return;
  }
  JS::SetReservedSlot(object,0,callback);JS::SetReservedSlot(object,1,JS::ObjectValue(*ownerRealm));
}
}
namespace kandelo_trace_builtin_api::internal {
Local<Value> NewTraceTypeError(Isolate* isolate,MessageTemplate message) {const char* text=TraceMessage(message);CHECK(text);return kandelo_node_codec_api::Error(isolate,JSEXN_TYPEERR,nullptr,text);}
MaybeLocal<Value> JsonStringify(Isolate* isolate,Local<Value> input,Local<Value> replacer,Local<Value> space) {
  auto& f=kandelo_node_codec_api::Current(isolate);CHECK(replacer->IsUndefined() && space->IsUndefined());
  struct Output {std::vector<char16_t> text;bool called=false;} output;
  auto writer=[](const char16_t* text,uint32_t length,void* raw)->bool{auto& output=*static_cast<Output*>(raw);output.called=true;output.text.insert(output.text.end(),text,text+length);return true;};
  JS::RootedObject noReplacer(f.cx);JS::RootedValue undefined(f.cx,JS::UndefinedValue());
  if(!JS::ToJSON(f.cx,input->cell().value,noReplacer,undefined,writer,&output))return {};
  if(!output.called)return isolate->factory()->undefined_value();
  return String::NewFromTwoByte(isolate,reinterpret_cast<const uint16_t*>(output.text.data()),NewStringType::kNormal,int(output.text.size()));
}
}
namespace node {
bool AdmitTraceWrite(kandelo_node_codec_impl::Environment*,const std::string&) {
  auto& frame=*kandelo_node_codec_api::Frame::current;
  // Admission reads actual process options, rejects unsupported policy mode,
  // and leaves ordinary descriptor permissions to the guest OS.
  return bool(kandelo::node::GetTraceProcess(frame.cx,frame.realm));
}
}
namespace kandelo::node {
JSObject* CreateTraceBinding(JSContext* cx,JS::HandleObject realm) {
  auto process=GetTraceProcess(cx,realm);if(!process)return nullptr;
  JS::RootedObject runtime(cx,GetRealmRuntime(cx,realm));if(!runtime)return nullptr;
  auto state=api::Data(cx,runtime);if(!state)return nullptr;api::Frame frame(cx,realm,state,nullptr,api::Domain::Trace);frame.tracing=process;
  JS::RootedObject object(cx,JS_NewObject(cx,&api::traceBindingClass));if(!object)return nullptr;frame.binding=object;
  JS::RootedValue value(cx,JS::ObjectValue(*object)),unused(cx,JS::UndefinedValue());
  kandelo_trace_adapter::initializer(frame.Own<api::Object>(value),frame.OwnValue(unused),state->isolate.GetCurrentContext(),nullptr);
  if(JS_IsExceptionPending(cx))return nullptr;return object;
}
}

#endif
