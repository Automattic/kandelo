#ifndef KANDELO_NODE_TEMPLATE_CODECS_INL_H
#define KANDELO_NODE_TEMPLATE_CODECS_INL_H

// Engine template records are opaque Data, never JavaScript Value handles.
// Every JS edge lives in a traced slot; native configuration owns no JS roots.
namespace kandelo_node_codec_api {
namespace {
JSObject* UnwrapTemplateObject(JSContext* cx,const JS::Value& input){
  JS::RootedValue value(cx,input);return UnwrapObject(cx,value);
}
enum NativeTemplateSlot {TemplateConfig,TemplatePayload,TemplateReceiver,
  TemplatePrototype,TemplateInstance,TemplateProperties,TemplateCache,TemplateName,TemplateConstructor,TemplateSlotCount};
enum class NativeTemplateKind {Function,Object};
enum class NativeObjectRole {Standalone,Prototype,Instance};
struct NativeTemplateInfo {
  NativeTemplateKind kind;Domain domain;NativeObjectRole role=NativeObjectRole::Standalone;
  FunctionCallback callback=nullptr;int length=0,fieldCount=0;
  ConstructorBehavior behavior=ConstructorBehavior::kAllow;
  SideEffectType sideEffects=SideEffectType::kHasSideEffect;
  std::vector<std::shared_ptr<const CFunction::Signature>> fast;
  bool used=false,creating=false;
};
void FinalizeNativeTemplate(JS::GCContext*,JSObject* object){
  auto value=JS::GetReservedSlot(object,TemplateConfig);
  if(!value.isUndefined())delete static_cast<NativeTemplateInfo*>(value.toPrivate());
}
const JSClassOps templateOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeNativeTemplate};
const JSClass templateClass={"NodeEngineTemplate",JSCLASS_HAS_RESERVED_SLOTS(TemplateSlotCount)|JSCLASS_FOREGROUND_FINALIZE,&templateOps};
const JSClass invocationClass={"NodeTemplateInvocation",JSCLASS_HAS_RESERVED_SLOTS(2)};
const JSClass templateRealmClass={"NodeTemplateRealm",JSCLASS_GLOBAL_FLAGS,&JS::DefaultGlobalClassOps};
const JSClass signatureClass={"NodeEngineSignature",JSCLASS_HAS_RESERVED_SLOTS(1)};
const JSClass templateInstanceClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(native::BaseObject::kInternalFieldCount+1)|JSCLASS_FOREGROUND_FINALIZE,&native::converterOps};
NativeTemplateInfo& TemplateInfo(JSObject* object){
  CHECK(JS::GetClass(object)==&templateClass);
  return *static_cast<NativeTemplateInfo*>(JS::GetReservedSlot(object,TemplateConfig).toPrivate());
}
JSObject* TemplateRecord(Frame& frame,Local<Data> data){
  CHECK(!data.IsEmpty()&&!data->IsValue());auto* object=UnwrapTemplateObject(frame.cx,Input(data));CHECK(object&&JS::GetClass(object)==&templateClass);return object;
}
JSObject* NativeTemplateRealm(Frame& frame){
  if(frame.state->templateRealm)return frame.state->templateRealm->get();
  JS::RealmOptions options;options.creationOptions().setInvisibleToDebugger(true);
  JS::RootedObject global(frame.cx,JS_NewGlobalObject(frame.cx,&templateRealmClass,nullptr,JS::FireOnNewGlobalHook,options));if(!global)return nullptr;
  {JSAutoRealm home(frame.cx,global);if(!JS::InitRealmStandardClasses(frame.cx))return nullptr;}
  frame.state->templateRealm=std::make_unique<JS::PersistentRootedObject>(frame.cx,global);return global;
}
JSObject* NewTemplateRecord(Frame& frame,NativeTemplateKind kind,NativeObjectRole role=NativeObjectRole::Standalone){
  JS::RootedObject global(frame.cx,NativeTemplateRealm(frame));if(!global)return nullptr;JSAutoRealm home(frame.cx,global);
  JS::RootedObject object(frame.cx,JS_NewObject(frame.cx,&templateClass));if(!object)return nullptr;
  auto info=std::make_unique<NativeTemplateInfo>();info->kind=kind;info->domain=frame.domain;info->role=role;
  JS::SetReservedSlot(object,TemplateConfig,JS::PrivateValue(info.release()));
  JS::RootedObject properties(frame.cx,JS_NewObjectWithGivenProto(frame.cx,nullptr,nullptr));
  JS::RootedObject cache(frame.cx,JS::NewWeakMapObject(frame.cx));
  if(!properties||!cache)return nullptr;
  JS::SetReservedSlot(object,TemplateProperties,JS::ObjectValue(*properties));
  JS::SetReservedSlot(object,TemplateCache,JS::ObjectValue(*cache));return object;
}
bool ApplyTemplateProperties(Frame&,JS::HandleObject,JS::HandleObject,Local<Context>);
bool InvokeNativeTemplate(JSContext*,unsigned,JS::Value*);
const JSClass* InstanceClass(NativeTemplateInfo& info){
  CHECK(info.fieldCount==0||info.fieldCount==native::BaseObject::kInternalFieldCount);
  if(!info.fieldCount)return &templateInstanceClass;
  if(info.domain==Domain::Trace)return &native::categoryClass;
  if(info.domain==Domain::Icu)return &native::converterClass;
  if(info.domain==Domain::Diagnostics)return &native::nativeChannelClass;
  return &templateInstanceClass;
}
bool ReceiverMatches(Frame& frame,JS::HandleValue value,JS::HandleObject expected){
  JS::RootedObject object(frame.cx,UnwrapTemplateObject(frame.cx,value));if(!object)return false;
  const JSClass* clasp=JS::GetClass(object);
  if(clasp!=&templateInstanceClass&&clasp!=&native::categoryClass&&clasp!=&native::converterClass&&clasp!=&native::nativeChannelClass)return false;
  auto brand=JS::GetReservedSlot(object,native::BaseObject::kInternalFieldCount);
  return brand.isObject()&&UnwrapTemplateObject(frame.cx,brand)==expected;
}
bool InvokeNativeTemplate(JSContext* cx,unsigned argc,JS::Value* vp){
  auto args=JS::CallArgsFromVp(argc,vp);JS::RootedObject callee(cx,&args.callee());
  JS::RootedObject record(cx,UnwrapTemplateObject(cx,js::GetFunctionNativeReserved(callee,1)));CHECK(record);
  auto& info=TemplateInfo(record);CHECK(info.kind==NativeTemplateKind::Function);
  JS::RootedObject invocation(cx,UnwrapTemplateObject(cx,js::GetFunctionNativeReserved(callee,0)));CHECK(invocation&&JS::GetClass(invocation)==&invocationClass);
  JS::RootedObject realm(cx,UnwrapTemplateObject(cx,JS::GetReservedSlot(invocation,0)));CHECK(realm);
  args.rval().setUndefined();if(!kandelo::node::CheckRealmLibraryActive(cx,realm))return false;
  JS::RootedObject runtime(cx,kandelo::node::GetRealmRuntime(cx,realm));if(!runtime)return false;
  auto state=ReadCodecState(cx,runtime);if(!state)return false;Frame frame(cx,realm,state,&args,info.domain);
  auto binding=JS::GetReservedSlot(invocation,1);if(binding.isObject())frame.binding=&binding.toObject();
  frame.callbackData=JS::GetReservedSlot(record,TemplatePayload);
  if(!JS_WrapValue(cx,&frame.callbackData))return false;
  if(info.domain==Domain::Trace){frame.tracing=kandelo::node::GetTraceProcess(cx,realm);if(!frame.tracing)return false;}
  JS::RootedObject signature(cx,UnwrapTemplateObject(cx,JS::GetReservedSlot(record,TemplateReceiver)));
  if(signature&&!ReceiverMatches(frame,args.thisv(),signature)){
    state->isolate.ThrowException(Error(&state->isolate,JSEXN_TYPEERR,nullptr,"Illegal invocation"));return false;
  }
  JS::RootedValue receiver(cx,args.thisv());
  if(args.isConstructing()){
    CHECK(info.behavior==ConstructorBehavior::kAllow);
    JS::RootedObject instanceTemplate(cx,UnwrapTemplateObject(cx,JS::GetReservedSlot(record,TemplateInstance)));
    NativeTemplateInfo* instanceInfo=instanceTemplate?&TemplateInfo(instanceTemplate):nullptr;
    auto allocation=info;if(instanceInfo)allocation.fieldCount=instanceInfo->fieldCount;
    JS::RootedObject object(cx,JS_NewObjectForConstructor(cx,InstanceClass(allocation),args));if(!object)return false;
    JS::RootedObject brand(cx,record);if(!JS_WrapObject(cx,&brand))return false;
    JS::SetReservedSlot(object,native::BaseObject::kInternalFieldCount,JS::ObjectValue(*brand));
    receiver.setObject(*object);
    if(instanceTemplate&&!ApplyTemplateProperties(frame,instanceTemplate,object,state->isolate.GetCurrentContext()))return false;
  }else{
    JS::RootedObject object(cx,receiver.isNullOrUndefined()?JS::CurrentGlobalOrNull(cx):JS::ToObject(cx,receiver));
    if(!object)return false;receiver.setObject(*object);
  }
  frame.receiver=receiver;
  if(info.callback){
    if(info.domain==Domain::Decoder){
      auto input=Argument(&state->isolate,0);CHECK(input->IsArrayBufferView());auto& span=frame.Borrow(input);
      CHECK(span.size>=sizeof(native::StringDecoder));
      CHECK(span.bytes[native::StringDecoder::kBufferedBytes]+span.bytes[native::StringDecoder::kMissingBytes]<=native::StringDecoder::kIncompleteCharactersEnd);
    }
    FunctionCallbackInfo<Value> call(&state->isolate);info.callback(call);
  }
  if(JS_IsExceptionPending(cx)||js::shell::GetShellContext(cx)->upstreamNodeExecutionTerminated)return false;
  if(args.isConstructing()&&!args.rval().isObject())args.rval().set(receiver);return true;
}
bool MaterializeTemplateValue(Frame& frame,JS::HandleValue source,Local<Context> context,JS::MutableHandleValue result){
  JS::RootedObject record(frame.cx,UnwrapTemplateObject(frame.cx,source));
  if(!record||JS::GetClass(record)!=&templateClass){result.set(source);return true;}
  JS::RootedValue data(frame.cx,JS::ObjectValue(*record));
  if(TemplateInfo(record).kind==NativeTemplateKind::Function){
    Local<Function> function;if(!frame.Own<FunctionTemplate>(data)->GetFunction(context).ToLocal(&function))return false;result.set(Input(function));
  }else{
    Local<Object> object;if(!frame.Own<ObjectTemplate>(data)->NewInstance(context).ToLocal(&object))return false;result.set(Input(object));
  }
  return true;
}
bool ApplyTemplateProperties(Frame& frame,JS::HandleObject record,JS::HandleObject target,Local<Context> context){
  TemplateInfo(record).used=true;JS::RootedObject properties(frame.cx,&JS::GetReservedSlot(record,TemplateProperties).toObject());
  JS::RootedIdVector keys(frame.cx);
  {JSAutoRealm home(frame.cx,properties);if(!js::GetPropertyKeys(frame.cx,properties,JSITER_OWNONLY|JSITER_HIDDEN|JSITER_SYMBOLS,&keys))return false;}
  for(size_t i=0;i<keys.length();++i){
    JS::RootedId key(frame.cx,keys[i]);JS::RootedValue source(frame.cx),value(frame.cx),name(frame.cx);
    {JSAutoRealm home(frame.cx,properties);if(!JS_GetPropertyById(frame.cx,properties,key,&source)||!JS_IdToValue(frame.cx,key,&name))return false;}
    if(!MaterializeTemplateValue(frame,source,context,&value))return false;
    JSAutoRealm home(frame.cx,target);
    if(!JS_WrapValue(frame.cx,&name)||!JS_ValueToId(frame.cx,name,&key)||!JS_WrapValue(frame.cx,&value)||!JS_DefinePropertyById(frame.cx,target,key,value,JSPROP_ENUMERATE))return false;
  }
  return true;
}
}
Local<Value> CallbackData(Isolate* isolate){auto& frame=Current(isolate);return frame.OwnValue(frame.callbackData);}
Local<FunctionTemplate> FunctionTemplate::New(Isolate* isolate,FunctionCallback callback,Local<Value> data,Local<Signature> signature,int length,ConstructorBehavior behavior,SideEffectType sideEffects,const CFunction* fast){
  auto& frame=Current(isolate);if(JS_IsExceptionPending(frame.cx))return {};CHECK_GE(length,0);CHECK_LE(length,int(UINT16_MAX));
  JS::RootedObject record(frame.cx,NewTemplateRecord(frame,NativeTemplateKind::Function));if(!record)return {};
  JSAutoRealm home(frame.cx,record);auto& info=TemplateInfo(record);info.callback=callback;info.length=length;info.behavior=behavior;info.sideEffects=sideEffects;
  if(fast)info.fast.push_back(fast->signature);
  JS::RootedValue payload(frame.cx,data.IsEmpty()?JS::UndefinedValue():Input(data).get());
  if(!JS_WrapValue(frame.cx,&payload))return {};JS::SetReservedSlot(record,TemplatePayload,payload);
  if(!signature.IsEmpty()){
    JS::RootedObject object(frame.cx,UnwrapTemplateObject(frame.cx,Input(signature)));CHECK(object&&JS::GetClass(object)==&signatureClass);
    JS::RootedValue receiver(frame.cx,JS::GetReservedSlot(object,0));if(!JS_WrapValue(frame.cx,&receiver))return {};
    JS::SetReservedSlot(record,TemplateReceiver,receiver);
  }
  JS::RootedValue value(frame.cx,JS::ObjectValue(*record));return frame.Own<FunctionTemplate>(value);
}
Local<FunctionTemplate> FunctionTemplate::NewWithCFunctionOverloads(Isolate* isolate,FunctionCallback callback,Local<Value> data,Local<Signature> signature,int length,ConstructorBehavior behavior,SideEffectType effects,MemorySpan<const CFunction> fast){
  auto output=New(isolate,callback,data,signature,length,behavior,effects,nullptr);if(output.IsEmpty())return {};
  auto& frame=Current(isolate);auto& info=TemplateInfo(TemplateRecord(frame,output));for(auto& function:fast)info.fast.push_back(function.signature);return output;
}
Local<Signature> Signature::New(Isolate* isolate,Local<FunctionTemplate> receiver){
  auto& frame=Current(isolate);JS::RootedObject record(frame.cx,TemplateRecord(frame,receiver));CHECK(TemplateInfo(record).kind==NativeTemplateKind::Function);
  JS::RootedObject global(frame.cx,NativeTemplateRealm(frame));if(!global)return {};JSAutoRealm home(frame.cx,global);
  JS::RootedObject signature(frame.cx,JS_NewObject(frame.cx,&signatureClass));if(!signature||!JS_WrapObject(frame.cx,&record))return {};
  JS::SetReservedSlot(signature,0,JS::ObjectValue(*record));JS::RootedValue value(frame.cx,JS::ObjectValue(*signature));return frame.Own<Signature>(value);
}
Local<ObjectTemplate> ObjectTemplate::New(Isolate* isolate,Local<FunctionTemplate> constructor){
  if(!constructor.IsEmpty())Crash("ObjectTemplate constructor association is not implemented");
  auto& frame=Current(isolate);JS::RootedObject object(frame.cx,NewTemplateRecord(frame,NativeTemplateKind::Object));if(!object)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<ObjectTemplate>(value);
}
Local<ObjectTemplate> FunctionTemplate::PrototypeTemplate(){
  auto& frame=*Frame::current;JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<FunctionTemplate>(this)));
  JSAutoRealm home(frame.cx,record);auto cached=JS::GetReservedSlot(record,TemplatePrototype);
  if(cached.isObject()){JS::RootedValue value(frame.cx,cached);return frame.Own<ObjectTemplate>(value);}
  CHECK(!TemplateInfo(record).used);JS::RootedObject object(frame.cx,NewTemplateRecord(frame,NativeTemplateKind::Object,NativeObjectRole::Prototype));if(!object)return {};
  JS::SetReservedSlot(record,TemplatePrototype,JS::ObjectValue(*object));JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<ObjectTemplate>(value);
}
Local<ObjectTemplate> FunctionTemplate::InstanceTemplate(){
  auto& frame=*Frame::current;JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<FunctionTemplate>(this)));
  JSAutoRealm home(frame.cx,record);auto cached=JS::GetReservedSlot(record,TemplateInstance);
  if(cached.isObject()){JS::RootedValue value(frame.cx,cached);return frame.Own<ObjectTemplate>(value);}
  CHECK(!TemplateInfo(record).used);JS::RootedObject object(frame.cx,NewTemplateRecord(frame,NativeTemplateKind::Object,NativeObjectRole::Instance));if(!object)return {};
  TemplateInfo(object).domain=TemplateInfo(record).domain;
  JS::SetReservedSlot(object,TemplateConstructor,JS::ObjectValue(*record));JS::SetReservedSlot(record,TemplateInstance,JS::ObjectValue(*object));
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<ObjectTemplate>(value);
}
void FunctionTemplate::SetClassName(Local<String> name){
  auto& frame=*Frame::current;JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<FunctionTemplate>(this)));CHECK(!TemplateInfo(record).used);
  JSAutoRealm home(frame.cx,record);JS::RootedValue value(frame.cx,Input(name));CHECK(JS_WrapValue(frame.cx,&value));JS::SetReservedSlot(record,TemplateName,value);
}
void ObjectTemplate::SetInternalFieldCount(int count){
  CHECK(count==0||count==native::BaseObject::kInternalFieldCount);auto& frame=*Frame::current;
  JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<ObjectTemplate>(this)));auto& info=TemplateInfo(record);CHECK(!info.used);info.fieldCount=count;
}
void Template::Set(Local<Name> name,Local<Data> data){
  auto& frame=*Frame::current;JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<Template>(this)));CHECK(!TemplateInfo(record).used);
  JSAutoRealm home(frame.cx,record);JS::RootedObject properties(frame.cx,&JS::GetReservedSlot(record,TemplateProperties).toObject());
  JS::RootedValue key(frame.cx,Input(name)),value(frame.cx,Input(data));JS::RootedId id(frame.cx);
  if(!data->IsValue())CHECK(JS::GetClass(UnwrapTemplateObject(frame.cx,value))==&templateClass);
  CHECK(JS_WrapValue(frame.cx,&key)&&JS_WrapValue(frame.cx,&value)&&JS_ValueToId(frame.cx,key,&id));
  if(!data->IsValue()){
    JS::RootedObject child(frame.cx,UnwrapTemplateObject(frame.cx,value));auto& info=TemplateInfo(child);
    if(info.kind==NativeTemplateKind::Function&&!info.used&&JS::GetReservedSlot(child,TemplateName).isUndefined()){
      JS::Rooted<JSAtom*> atom(frame.cx,js::IdToFunctionName(frame.cx,id));CHECK(atom);
      JSAutoRealm childRealm(frame.cx,child);JS::RootedValue inferred(frame.cx,JS::StringValue(atom));CHECK(JS_WrapValue(frame.cx,&inferred));JS::SetReservedSlot(child,TemplateName,inferred);
    }
  }
  CHECK(JS_DefinePropertyById(frame.cx,properties,id,value,JSPROP_ENUMERATE));
}
MaybeLocal<Function> FunctionTemplate::GetFunction(Local<Context> context){
  auto& frame=Current(context->isolate);NativeEntry entry(frame);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<FunctionTemplate>(this))),global(frame.cx,&context->global->value.toObject());
  auto& info=TemplateInfo(record);CHECK(info.kind==NativeTemplateKind::Function);
  JS::RootedObject cache(frame.cx,&JS::GetReservedSlot(record,TemplateCache).toObject());JS::RootedValue cached(frame.cx);
  {JSAutoRealm home(frame.cx,cache);JS::RootedValue key(frame.cx,JS::ObjectValue(*global));if(!JS_WrapValue(frame.cx,&key)||!JS::GetWeakMapEntry(frame.cx,cache,key,&cached))return {};}
  Context::Scope home(context);
  if(!cached.isUndefined()){if(!JS_WrapValue(frame.cx,&cached))return {};return frame.Own<Function>(cached);}
  if(info.creating){JS_ReportErrorASCII(frame.cx,"Recursive native template instantiation is not implemented");return {};}
  info.creating=true;auto leave=mozilla::MakeScopeExit([&]{info.creating=false;});
  JS::RootedFunction function(frame.cx,js::NewFunctionWithReserved(frame.cx,InvokeNativeTemplate,unsigned(info.length),info.behavior==ConstructorBehavior::kAllow?JSFUN_CONSTRUCTOR:0,nullptr));if(!function)return {};
  JS::RootedObject object(frame.cx,JS_GetFunctionObject(function)),metadata(frame.cx,record);if(!JS_WrapObject(frame.cx,&metadata))return {};
  JS::RootedObject invocation(frame.cx,JS_NewObject(frame.cx,&invocationClass)),owner(frame.cx,frame.realm),binding(frame.cx,frame.binding);
  if(!invocation||!JS_WrapObject(frame.cx,&owner)||(binding&&!JS_WrapObject(frame.cx,&binding)))return {};
  JS::SetReservedSlot(invocation,0,JS::ObjectValue(*owner));if(binding)JS::SetReservedSlot(invocation,1,JS::ObjectValue(*binding));
  js::SetFunctionNativeReserved(object,0,JS::ObjectValue(*invocation));js::SetFunctionNativeReserved(object,1,JS::ObjectValue(*metadata));
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));
  info.used=true;
  auto name=JS::GetReservedSlot(record,TemplateName);if(name.isString()){JS::RootedValue text(frame.cx,name);frame.Own<Function>(value)->SetName(frame.Own<String>(text));}
  if(info.behavior==ConstructorBehavior::kAllow){
    JS::RootedObject prototype(frame.cx,JS_NewPlainObject(frame.cx));if(!prototype)return {};
    if(!JS_DefineProperty(frame.cx,prototype,"constructor",object,0)||!JS_DefineProperty(frame.cx,object,"prototype",prototype,JSPROP_PERMANENT))return {};
    JS::RootedObject prototypeTemplate(frame.cx,UnwrapTemplateObject(frame.cx,JS::GetReservedSlot(record,TemplatePrototype)));
    if(prototypeTemplate&&!ApplyTemplateProperties(frame,prototypeTemplate,prototype,context))return {};
  }
  if(!ApplyTemplateProperties(frame,record,object,context))return {};
  {JSAutoRealm cacheRealm(frame.cx,cache);JS::RootedValue key(frame.cx,JS::ObjectValue(*global)),stored(frame.cx,value);if(!JS_WrapValue(frame.cx,&key)||!JS_WrapValue(frame.cx,&stored)||!JS::SetWeakMapEntry(frame.cx,cache,key,stored))return {};}
  return frame.Own<Function>(value);
}
MaybeLocal<Object> ObjectTemplate::NewInstance(Local<Context> context){
  auto& frame=Current(context->isolate);NativeEntry entry(frame);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<ObjectTemplate>(this)));auto& info=TemplateInfo(record);CHECK(info.kind==NativeTemplateKind::Object);
  JS::RootedObject constructor(frame.cx,UnwrapTemplateObject(frame.cx,JS::GetReservedSlot(record,TemplateConstructor)));
  if(constructor){
    JS::RootedValue value(frame.cx,JS::ObjectValue(*constructor));Local<Function> function;
    if(!frame.Own<FunctionTemplate>(value)->GetFunction(context).ToLocal(&function))return {};return function->NewInstance(context);
  }
  Context::Scope home(context);JS::RootedObject object(frame.cx,info.fieldCount?JS_NewObject(frame.cx,InstanceClass(info)):JS_NewPlainObject(frame.cx));if(!object)return {};
  if(!ApplyTemplateProperties(frame,record,object,context))return {};JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<Object>(value);
}
bool ApplyNativeTemplate(Frame& frame,Local<ObjectTemplate> input,JS::HandleObject target){
  if(input.IsEmpty()||JS_IsExceptionPending(frame.cx))return false;JS::RootedObject record(frame.cx,TemplateRecord(frame,input));
  CHECK(TemplateInfo(record).kind==NativeTemplateKind::Object);return ApplyTemplateProperties(frame,record,target,frame.state->isolate.GetCurrentContext());
}
Local<FunctionTemplate> CreateNativeWrapperTemplate(Isolate* isolate,int count){
  auto output=FunctionTemplate::New(isolate);if(!output.IsEmpty())output->InstanceTemplate()->SetInternalFieldCount(count);return output;
}
}
#endif
