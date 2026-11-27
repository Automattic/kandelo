#ifndef KANDELO_NODE_TEMPLATE_CODECS_INL_H
#define KANDELO_NODE_TEMPLATE_CODECS_INL_H

// Engine template records are opaque Data, never JavaScript Value handles.
// Every JS edge lives in a traced slot; native configuration owns no JS roots.
namespace v8 {
namespace {
JSObject* UnwrapTemplateObject(JSContext* cx,const JS::Value& input){
  JS::RootedValue value(cx,input);return UnwrapObject(cx,value);
}
enum NativeTemplateSlot {TemplateConfig,TemplatePayload,TemplateReceiver,
  TemplatePrototype,TemplateInstance,TemplateProperties,TemplateCache,TemplateName,TemplateConstructor,TemplateParent,TemplateNamedHandlerData,TemplateIndexedHandlerData,TemplatePrivateProperties,TemplateSlotCount};
enum class NativeTemplateKind {Function,Object,Dictionary};
enum class NativeObjectRole {Standalone,Prototype,Instance};
struct NativeTemplateInfo {
  NativeTemplateKind kind;Domain domain;NativeObjectRole role=NativeObjectRole::Standalone;
  FunctionCallback callback=nullptr;int length=0,fieldCount=0;
  ConstructorBehavior behavior=ConstructorBehavior::kAllow;
  SideEffectType sideEffects=SideEffectType::kHasSideEffect;
  // Original portable metadata, not a V8 machine-code call implementation.
  std::vector<CFunction> fast;
  uint32_t dictionarySize=0;
  // Owned native records have no borrowed Local handles. Their payload edges
  // are the corresponding traced slots on this same template object.
  std::optional<NamedPropertyHandlerConfiguration> namedHandler;
  std::optional<IndexedPropertyHandlerConfiguration> indexedHandler;
  bool used=false,creating=false,readOnlyPrototype=false;
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
const JSClass templateAccessorClass={"NodeTemplateAccessor",JSCLASS_HAS_RESERVED_SLOTS(2)};
const JSClass templateInstanceClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(NativeWrapperSlotCount)|JSCLASS_FOREGROUND_FINALIZE,&nativeWrapperOps};
extern const js::NativePropertyInterceptorOps nativeTemplateInterceptorOps;
bool EnumerateNativeTemplate(JSContext*,JS::HandleObject,JS::MutableHandleIdVector,bool);
const JSClassOps interceptedTemplateOps=[] {
  auto ops=nativeWrapperOps;ops.newEnumerate=EnumerateNativeTemplate;return ops;
}();
const js::ClassExtension interceptedTemplateExtension={nullptr,&nativeTemplateInterceptorOps};
// Same native object family, wrapper slots, tracing and finalization. Only
// configured instances enter optional property hooks; other templates retain
// the engine's ordinary shape/integrity operations.
const JSClass templateInterceptedInstanceClass={"Object",
  JSCLASS_HAS_RESERVED_SLOTS(NativeWrapperSlotCount)|JSCLASS_FOREGROUND_FINALIZE,
  &interceptedTemplateOps,nullptr,&interceptedTemplateExtension};
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
  // Map keys are traced values, not enumerable object properties. Native
  // enumeration must not expose embedding-private keys, even inside templates.
  JS::RootedObject privateProperties(frame.cx,JS::NewMapObject(frame.cx));
  if(!properties||!cache||!privateProperties)return nullptr;
  JS::SetReservedSlot(object,TemplatePrivateProperties,JS::ObjectValue(*privateProperties));
  JS::SetReservedSlot(object,TemplateProperties,JS::ObjectValue(*properties));
  JS::SetReservedSlot(object,TemplateCache,JS::ObjectValue(*cache));return object;
}
// Like the upstream template owner, callbacks belong to the constructor,
// including a lazily created constructor for a standalone object template.
JSObject* EnsureNativeTemplateConstructor(Frame& frame,JS::HandleObject object){
  auto existing=JS::GetReservedSlot(object,TemplateConstructor);
  if(existing.isObject())return UnwrapTemplateObject(frame.cx,existing);
  auto function=FunctionTemplate::New(&frame.state->isolate);if(function.IsEmpty())return nullptr;
  JS::RootedObject constructor(frame.cx,TemplateRecord(frame,function));
  JSAutoRealm home(frame.cx,object);
  CHECK(JS::GetNonCCWObjectGlobal(object)==JS::GetNonCCWObjectGlobal(constructor));
  JS::SetReservedSlot(object,TemplateConstructor,JS::ObjectValue(*constructor));
  JS::SetReservedSlot(constructor,TemplateInstance,JS::ObjectValue(*object));
  return constructor;
}
bool NativeTemplateHasInterceptors(Frame& frame,JS::HandleObject constructor){
  // Handler inheritance follows private native template ancestry, never the
  // mutable public prototype chain. Each iteration retains a real traced root.
  JS::RootedObject current(frame.cx,constructor);
  while(current){
    const auto& info=TemplateInfo(current);
    if(info.namedHandler||info.indexedHandler)return true;
    current=UnwrapTemplateObject(frame.cx,JS::GetReservedSlot(current,TemplateParent));
  }
  return false;
}
bool IsNativeInterceptedGlobal(JSObject*);
JSObject* NativeGlobalInterceptorConstructor(JSContext*,JS::HandleObject);
#include "kandelo-node/property-interceptor-codecs-inl.h"
// Ordinary native instances use the real property vtable. Globals and other
// layouts must keep their truthful boundary until their name/declaration paths
// are connected; ordinary instance support cannot authorize those paths.
bool AdmitNativeTemplateInstantiation(Frame& frame,JS::HandleObject object,JSObject* target=nullptr){
  JS::RootedObject constructor(frame.cx,UnwrapTemplateObject(frame.cx,JS::GetReservedSlot(object,TemplateConstructor)));
  if(constructor&&NativeTemplateHasInterceptors(frame,constructor)){
    if(target&&JS::GetClass(target)==&templateInterceptedInstanceClass)return true;
    if(target&&IsNativeInterceptedGlobal(target))return true;
    JS_ReportErrorASCII(frame.cx,"Native property interceptor engine dispatch is not connected");
    return false;
  }
  return true;
}
bool ApplyTemplateProperties(Frame&,JS::HandleObject,JS::HandleObject,Local<Context>);
bool InvokeNativeTemplate(JSContext*,unsigned,JS::Value*);
const JSClass* InstanceClass(NativeTemplateInfo& info,bool intercepted=false){
  CHECK_GE(info.fieldCount,0);
  if(intercepted)return &templateInterceptedInstanceClass;
  if(!info.fieldCount)return &templateInstanceClass;
  return &templateInstanceClass;
}
bool ReceiverMatches(Frame& frame,JS::HandleValue value,JS::HandleObject expected){
  JS::RootedObject object(frame.cx,UnwrapTemplateObject(frame.cx,value));if(!object)return false;
  const JSClass* clasp=JS::GetClass(object);
  if(!HasNativeFieldStorage(object))return false;
  JS::RootedObject brand(frame.cx,UnwrapTemplateObject(frame.cx,JS::GetReservedSlot(object,NativeTemplateBrand)));
  // Native ancestry is independent of mutable public prototype properties.
  while(brand){
    CHECK(JS::GetClass(brand)==&templateClass);
    if(brand==expected)return true;
    brand=UnwrapTemplateObject(frame.cx,JS::GetReservedSlot(brand,TemplateParent));
  }
  return false;
}
bool InvokeNativeTemplate(JSContext* cx,unsigned argc,JS::Value* vp){
  auto args=JS::CallArgsFromVp(argc,vp);JS::RootedObject callee(cx,&args.callee());
  JS::RootedObject record(cx,UnwrapTemplateObject(cx,js::GetFunctionNativeReserved(callee,1)));CHECK(record);
  auto& info=TemplateInfo(record);CHECK(info.kind==NativeTemplateKind::Function);
  JS::RootedObject invocation(cx,UnwrapTemplateObject(cx,js::GetFunctionNativeReserved(callee,0)));CHECK(invocation&&JS::GetClass(invocation)==&invocationClass);
  JS::RootedObject realm(cx,UnwrapTemplateObject(cx,JS::GetReservedSlot(invocation,0)));CHECK(realm);
  args.rval().setUndefined();
  auto state=ReadNativeEngineState(cx);
  if(!state)return false;NativeCallbackEntry callbackEntry(*state);
  Frame frame(cx,realm,state,&args,info.domain);
  auto binding=JS::GetReservedSlot(invocation,1);if(binding.isObject())frame.binding=&binding.toObject();
  frame.callbackData=JS::GetReservedSlot(record,TemplatePayload);
  if(!JS_WrapValue(cx,&frame.callbackData))return false;
  JS::RootedObject signature(cx,UnwrapTemplateObject(cx,JS::GetReservedSlot(record,TemplateReceiver)));
  if(signature&&!ReceiverMatches(frame,args.thisv(),signature)){
    state->isolate.ThrowException(Error(&state->isolate,JSEXN_TYPEERR,nullptr,"Illegal invocation"));return false;
  }
  if(signature&&!AdmitNativeReceiver(frame,args.thisv()))return false;
  JS::RootedValue receiver(cx,args.thisv());
  if(args.isConstructing()){
    CHECK(info.behavior==ConstructorBehavior::kAllow);
    const bool intercepted=NativeTemplateHasInterceptors(frame,record);
    JS::RootedObject instanceTemplate(cx,UnwrapTemplateObject(cx,JS::GetReservedSlot(record,TemplateInstance)));
    NativeTemplateInfo* instanceInfo=instanceTemplate?&TemplateInfo(instanceTemplate):nullptr;
    auto allocation=info;if(instanceInfo)allocation.fieldCount=instanceInfo->fieldCount;
    JS::RootedObject object(cx,JS_NewObjectForConstructor(cx,InstanceClass(allocation,intercepted),args));if(!object)return false;
    if(callee==&args.newTarget().toObject()&&!js::ObjectRealm::get(object).recordConstructorIdentity(cx,object,callee))return false;
    JS::RootedObject brand(cx,record);if(!JS_WrapObject(cx,&brand))return false;
    JS::SetReservedSlot(object,NativeTemplateBrand,JS::ObjectValue(*brand));
    if(!InitializeNativeInternalFields(frame,object,allocation.fieldCount))return false;
    receiver.setObject(*object);
    if(instanceTemplate&&!ApplyTemplateProperties(frame,instanceTemplate,object,state->isolate.GetCurrentContext()))return false;
  }else{
    JS::RootedObject object(cx,receiver.isNullOrUndefined()?JS::CurrentGlobalOrNull(cx):JS::ToObject(cx,receiver));
    if(!object)return false;receiver.setObject(*object);
  }
  frame.receiver=receiver;
  if(info.callback){
    FunctionCallbackInfo<Value> call(&state->isolate);info.callback(call);
  }
  if (!frame.FinishCallback(args.rval())) return false;
  if (args.isConstructing() && !args.rval().isObject()) args.rval().set(receiver);
  return true;
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
  // Also covers materialized prototype templates and nested template values.
  if(TemplateInfo(record).kind==NativeTemplateKind::Object&&
     !AdmitNativeTemplateInstantiation(frame,record,target))return false;
  TemplateInfo(record).used=true;JS::RootedObject properties(frame.cx,&JS::GetReservedSlot(record,TemplateProperties).toObject());
  JS::RootedIdVector keys(frame.cx);
  {JSAutoRealm home(frame.cx,properties);if(!js::GetPropertyKeys(frame.cx,properties,JSITER_OWNONLY|JSITER_HIDDEN|JSITER_SYMBOLS,&keys))return false;}
  for(size_t i=0;i<keys.length();++i){
    JS::RootedId key(frame.cx,keys[i]);JS::RootedValue source(frame.cx),value(frame.cx),name(frame.cx);
    JS::Rooted<mozilla::Maybe<JS::PropertyDescriptor>> stored(frame.cx);
    {JSAutoRealm home(frame.cx,properties);if(!JS_GetOwnPropertyDescriptorById(frame.cx,properties,key,&stored)||!JS_IdToValue(frame.cx,key,&name))return false;}
    CHECK(stored.isSome()&&stored.get().ref().isDataDescriptor());
    source=stored.get().ref().value();
    const auto& descriptor=stored.get().ref();unsigned flags=descriptor.enumerable()?JSPROP_ENUMERATE:0;
    if(!descriptor.writable())flags|=JSPROP_READONLY;if(!descriptor.configurable())flags|=JSPROP_PERMANENT;
    JS::RootedObject accessor(frame.cx,UnwrapTemplateObject(frame.cx,source));
    if(accessor&&JS::GetClass(accessor)==&nativePropertyClass){
      // Each instance owns its native callback record in its creation realm.
      // Only the template payload is shared, through the normal traced slots.
      auto callbacks=*static_cast<NativePropertyCallbacks*>(JS::GetReservedSlot(accessor,NativePropertyCallbackData).toPrivate());
      JS::RootedValue payload(frame.cx,JS::GetReservedSlot(accessor,NativePropertyPayload));
      JSAutoRealm home(frame.cx,target);JS::RootedObject owner(frame.cx,JS::CurrentGlobalOrNull(frame.cx));
      if(!JS_WrapValue(frame.cx,&payload)||!JS_WrapValue(frame.cx,&name)||!JS_ValueToId(frame.cx,name,&key))return false;
      JS::RootedObject metadata(frame.cx,NewNativePropertyRecord(frame,callbacks,owner,payload));if(!metadata)return false;
      JS::ObjectOpResult result;
      if(!DefineNativePropertyRecord(frame,target,key,metadata,flags,result)||!result.checkStrict(frame.cx,target,key))return false;
      continue;
    }
    const bool isAccessor=accessor&&JS::GetClass(accessor)==&templateAccessorClass;
    JS::RootedObject getter(frame.cx),setter(frame.cx);
    if(isAccessor){
      for(unsigned part=0;part<2;++part){
        JS::RootedValue templ(frame.cx,JS::GetReservedSlot(accessor,part));
        if(templ.isUndefined())continue;
        if(!MaterializeTemplateValue(frame,templ,context,&value))return false;
        CHECK(value.isObject()&&JS::IsCallable(&value.toObject()));
        if(part==0)getter=&value.toObject();else setter=&value.toObject();
      }
    }else if(!MaterializeTemplateValue(frame,source,context,&value))return false;
    JSAutoRealm home(frame.cx,target);
    if(!JS_WrapValue(frame.cx,&name)||!JS_ValueToId(frame.cx,name,&key))return false;
    if(isAccessor){
      if((getter&&!JS_WrapObject(frame.cx,&getter))||(setter&&!JS_WrapObject(frame.cx,&setter)))return false;
      JS::Rooted<JS::PropertyDescriptor> descriptor(frame.cx,JS::PropertyDescriptor::Accessor(getter,setter,flags&~JSPROP_READONLY));
      if(!JS_DefinePropertyById(frame.cx,target,key,descriptor))return false;
    }else if(!JS_WrapValue(frame.cx,&value)||!JS_DefinePropertyById(frame.cx,target,key,value,flags))return false;
  }
  // Keep template private keys in bridge metadata. Materialize actual hidden
  // properties on each recipient; never enumerate them from an object.
  properties=&JS::GetReservedSlot(record,TemplatePrivateProperties).toObject();
  JS::Rooted<JS::GCVector<JS::Value>> entries(
      frame.cx,JS::GCVector<JS::Value>(js::TempAllocPolicy(frame.cx)));
  {JSAutoRealm home(frame.cx,properties);
    if(!properties->as<js::MapObject>().getKeysAndValuesInterleaved(&entries))return false;}
  for(size_t i=0;i<entries.length();i+=2){
    JS::RootedValue name(frame.cx,entries[i]),source(frame.cx),attributes(frame.cx),value(frame.cx);
    {JSAutoRealm home(frame.cx,properties);
      JS::RootedObject descriptor(frame.cx,&entries[i+1].toObject());
      if(!JS_GetElement(frame.cx,descriptor,0,&source)||
         !JS_GetElement(frame.cx,descriptor,1,&attributes))return false;}
    CHECK(attributes.isInt32());JS::RootedId key(frame.cx);
    if(!MaterializeTemplateValue(frame,source,context,&value)||
       !JS_WrapValue(frame.cx,&name)||!JS_ValueToId(frame.cx,name,&key)||
       !DefinePrivateEntry(frame,target,key,value,unsigned(attributes.toInt32())))return false;
  }
  return true;
}
}
Local<Value> CallbackData(Isolate* isolate){auto& frame=Current(isolate);return frame.OwnValue(frame.callbackData);}
Local<FunctionTemplate> FunctionTemplate::New(Isolate* isolate,FunctionCallback callback,Local<Value> data,Local<Signature> signature,int length,ConstructorBehavior behavior,SideEffectType sideEffects,const CFunction* fast){
  auto& frame=Current(isolate);if(JS_IsExceptionPending(frame.cx))return {};CHECK_GE(length,0);CHECK_LE(length,int(UINT16_MAX));
  JS::RootedObject record(frame.cx,NewTemplateRecord(frame,NativeTemplateKind::Function));if(!record)return {};
  JSAutoRealm home(frame.cx,record);auto& info=TemplateInfo(record);info.callback=callback;info.length=length;info.behavior=behavior;info.sideEffects=sideEffects;
  if(fast)info.fast.push_back(*fast);
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
  auto& frame=Current(isolate);auto& info=TemplateInfo(TemplateRecord(frame,output));for(auto& function:fast)info.fast.push_back(function);return output;
}
Local<Signature> Signature::New(Isolate* isolate,Local<FunctionTemplate> receiver){
  auto& frame=Current(isolate);JS::RootedObject record(frame.cx,TemplateRecord(frame,receiver));CHECK(TemplateInfo(record).kind==NativeTemplateKind::Function);
  JS::RootedObject global(frame.cx,NativeTemplateRealm(frame));if(!global)return {};JSAutoRealm home(frame.cx,global);
  JS::RootedObject signature(frame.cx,JS_NewObject(frame.cx,&signatureClass));if(!signature||!JS_WrapObject(frame.cx,&record))return {};
  JS::SetReservedSlot(signature,0,JS::ObjectValue(*record));JS::RootedValue value(frame.cx,JS::ObjectValue(*signature));return frame.Own<Signature>(value);
}
Local<ObjectTemplate> ObjectTemplate::New(Isolate* isolate,Local<FunctionTemplate> constructor){
  auto& frame=Current(isolate);if(JS_IsExceptionPending(frame.cx))return {};
  JS::RootedObject function(frame.cx);
  if(!constructor.IsEmpty()){
    function=TemplateRecord(frame,constructor);CHECK(TemplateInfo(function).kind==NativeTemplateKind::Function);
  }
  JS::RootedObject object(frame.cx,NewTemplateRecord(frame,NativeTemplateKind::Object));if(!object)return {};
  // ObjectTemplate::New stores the supplied constructor; it does not replace
  // that constructor's independently owned InstanceTemplate.
  if(function)JS::SetReservedSlot(object,TemplateConstructor,JS::ObjectValue(*function));
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
void FunctionTemplate::Inherit(Local<FunctionTemplate> parent){
  auto& frame=*Frame::current;
  JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<FunctionTemplate>(this))),ancestor(frame.cx,TemplateRecord(frame,parent));
  CHECK(TemplateInfo(record).kind==NativeTemplateKind::Function&&!TemplateInfo(record).used);
  CHECK(TemplateInfo(ancestor).kind==NativeTemplateKind::Function);
  for(JS::RootedObject current(frame.cx,ancestor);current;current=UnwrapTemplateObject(frame.cx,JS::GetReservedSlot(current,TemplateParent)))CHECK(current!=record);
  JSAutoRealm home(frame.cx,record);CHECK(JS_WrapObject(frame.cx,&ancestor));
  JS::SetReservedSlot(record,TemplateParent,JS::ObjectValue(*ancestor));
}
void ObjectTemplate::SetHandler(const NamedPropertyHandlerConfiguration& config){
  auto& frame=*Frame::current;if(JS_IsExceptionPending(frame.cx))return;
  JS::RootedObject object(frame.cx,TemplateRecord(frame,Local<ObjectTemplate>(this)));
  CHECK(TemplateInfo(object).kind==NativeTemplateKind::Object&&!TemplateInfo(object).used);
  JS::RootedObject constructor(frame.cx,EnsureNativeTemplateConstructor(frame,object));if(!constructor)return;
  auto& info=TemplateInfo(constructor);CHECK(!info.used);
  JSAutoRealm home(frame.cx,constructor);
  JS::RootedValue payload(frame.cx,config.data.IsEmpty()?JS::UndefinedValue():Input(config.data).get());
  if(!JS_WrapValue(frame.cx,&payload))return;
  auto native=config;native.data={};
  JS::SetReservedSlot(constructor,TemplateNamedHandlerData,payload);info.namedHandler=native;
}
void ObjectTemplate::SetHandler(const IndexedPropertyHandlerConfiguration& config){
  auto& frame=*Frame::current;if(JS_IsExceptionPending(frame.cx))return;
  JS::RootedObject object(frame.cx,TemplateRecord(frame,Local<ObjectTemplate>(this)));
  CHECK(TemplateInfo(object).kind==NativeTemplateKind::Object&&!TemplateInfo(object).used);
  JS::RootedObject constructor(frame.cx,EnsureNativeTemplateConstructor(frame,object));if(!constructor)return;
  auto& info=TemplateInfo(constructor);CHECK(!info.used);
  JSAutoRealm home(frame.cx,constructor);
  JS::RootedValue payload(frame.cx,config.data.IsEmpty()?JS::UndefinedValue():Input(config.data).get());
  if(!JS_WrapValue(frame.cx,&payload))return;
  auto native=config;native.data={};
  JS::SetReservedSlot(constructor,TemplateIndexedHandlerData,payload);info.indexedHandler=native;
}
void ObjectTemplate::SetInternalFieldCount(int count){
  CHECK_GE(count,0);auto& frame=*Frame::current;
  JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<ObjectTemplate>(this)));auto& info=TemplateInfo(record);CHECK(!info.used);
  if(count&&!EnsureNativeTemplateConstructor(frame,record))return;
  info.fieldCount=count;
}
int ObjectTemplate::InternalFieldCount()const{
  auto& frame=*Frame::current;
  JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<ObjectTemplate>(const_cast<ObjectTemplate*>(this))));
  return TemplateInfo(record).fieldCount;
}
Local<DictionaryTemplate> DictionaryTemplate::New(Isolate* isolate,MemorySpan<const std::string_view> names){
  auto& frame=Current(isolate);NativeEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  CHECK_LE(names.size(),size_t(UINT32_MAX));
  JS::RootedObject record(frame.cx,NewTemplateRecord(frame,NativeTemplateKind::Dictionary));if(!record)return {};
  {
    JSAutoRealm home(frame.cx,record);
    JS::RootedObject keys(frame.cx,JS::NewArrayObject(frame.cx,uint32_t(names.size())));
    if(!keys||!JS_SetPrototype(frame.cx,keys,nullptr))return {};
    for(size_t index=0;index<names.size();++index){
      const auto name=names[index];
      JS::RootedString key(frame.cx,JS_NewStringCopyUTF8N(frame.cx,JS::UTF8Chars(name.data(),name.size())));if(!key)return {};
      JS::RootedValue value(frame.cx,JS::StringValue(key));
      if(!JS_SetElement(frame.cx,keys,uint32_t(index),value))return {};
    }
    JS::SetReservedSlot(record,TemplateProperties,JS::ObjectValue(*keys));
    auto& info=TemplateInfo(record);info.dictionarySize=uint32_t(names.size());info.used=true;
  }
  JS::RootedValue value(frame.cx,JS::ObjectValue(*record));return frame.Own<DictionaryTemplate>(value);
}
Local<Object> DictionaryTemplate::NewInstance(Local<Context> context,MemorySpan<MaybeLocal<Value>> values){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<DictionaryTemplate>(this)));
  const auto& info=TemplateInfo(record);CHECK(info.kind==NativeTemplateKind::Dictionary);
  CHECK_EQ(values.size(),size_t(info.dictionarySize));Context::Scope home(context);
  JS::RootedObject object(frame.cx,JS_NewPlainObject(frame.cx));if(!object)return {};
  JS::RootedObject keys(frame.cx,&JS::GetReservedSlot(record,TemplateProperties).toObject());
  for(uint32_t index=0;index<info.dictionarySize;++index){
    if(values[index].IsEmpty())continue;
    JS::RootedValue key(frame.cx);
    {JSAutoRealm metadata(frame.cx,keys);if(!JS_GetElement(frame.cx,keys,index,&key))return {};}
    JS::RootedValue value(frame.cx,Input(values[index].ToLocalChecked()));JS::RootedId id(frame.cx);
    // Define own data properties even for __proto__ or inherited setters.
    // A missing MaybeLocal omits the property; explicit undefined is a value.
    if(!JS_WrapValue(frame.cx,&key)||!JS_WrapValue(frame.cx,&value)||!JS_ValueToId(frame.cx,key,&id)||
       !JS_DefinePropertyById(frame.cx,object,id,value,JSPROP_ENUMERATE))return {};
  }
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<Object>(value);
}
namespace {
void StoreTemplateProperty(Template* receiver,JS::HandleValue name,Local<Data> data,
                           PropertyAttribute attrs,NativeTemplateSlot slot){
  auto& frame=*Frame::current;JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<Template>(receiver)));CHECK(!TemplateInfo(record).used);
  JSAutoRealm home(frame.cx,record);JS::RootedObject properties(frame.cx,&JS::GetReservedSlot(record,slot).toObject());
  JS::RootedValue key(frame.cx,name),value(frame.cx,Input(data));JS::RootedId id(frame.cx);
  if(!data->IsValue()&&!data->IsPrivate())CHECK(JS::GetClass(UnwrapTemplateObject(frame.cx,value))==&templateClass);
  CHECK(JS_WrapValue(frame.cx,&key)&&JS_WrapValue(frame.cx,&value)&&JS_ValueToId(frame.cx,key,&id));
  if(!data->IsValue()&&!data->IsPrivate()){
    JS::RootedObject child(frame.cx,UnwrapTemplateObject(frame.cx,value));auto& info=TemplateInfo(child);
    if(info.kind==NativeTemplateKind::Function&&!info.used&&JS::GetReservedSlot(child,TemplateName).isUndefined()){
      JS::Rooted<JSAtom*> atom(frame.cx,js::IdToFunctionName(frame.cx,id));CHECK(atom);
      JSAutoRealm childRealm(frame.cx,child);JS::RootedValue inferred(frame.cx,JS::StringValue(atom));CHECK(JS_WrapValue(frame.cx,&inferred));JS::SetReservedSlot(child,TemplateName,inferred);
    }
  }
  CHECK(!(unsigned(attrs)&~7u));unsigned flags=(attrs&DontEnum)?0:JSPROP_ENUMERATE;
  if(attrs&ReadOnly)flags|=JSPROP_READONLY;if(attrs&DontDelete)flags|=JSPROP_PERMANENT;
  if(slot==TemplatePrivateProperties){
    // Attributes describe the future instance, not the template's metadata.
    JS::RootedValueArray<2> fields(frame.cx);fields[0].set(value);fields[1].setInt32(int32_t(flags));
    JS::RootedObject descriptor(frame.cx,JS::NewArrayObject(frame.cx,fields));CHECK(descriptor);
    JS::RootedValue stored(frame.cx,JS::ObjectValue(*descriptor));
    CHECK(JS::MapSet(frame.cx,properties,key,stored));return;
  }
  CHECK(JS_DefinePropertyById(frame.cx,properties,id,value,flags));
}
}
void Template::Set(Local<Name> name,Local<Data> data,PropertyAttribute attrs){
  auto& frame=*Frame::current;JS::RootedValue key(frame.cx,Input(name));
  StoreTemplateProperty(this,key,data,attrs,TemplateProperties);
}
void Template::Set(Isolate* isolate,const char* name,Local<Data> data,PropertyAttribute attrs){
  auto key=String::NewFromUtf8(isolate,name).ToLocalChecked();Set(key,data,attrs);
}
void Template::SetPrivate(Local<Private> name,Local<Data> data,PropertyAttribute attrs){
  auto& frame=*Frame::current;JS::RootedValue key(frame.cx,Input(name));CHECK(key.isSymbol());
  StoreTemplateProperty(this,key,data,attrs,TemplatePrivateProperties);
}
namespace {
void SetTemplateNativeProperty(Template* templ,Local<Name> name,
    AccessorNameGetterCallback getter,AccessorNameSetterCallback setter,Local<Value> data,
    PropertyAttribute attrs,SideEffectType getterEffect,SideEffectType setterEffect,bool lazy){
  CHECK(Frame::current&&getter&&!(unsigned(attrs)&~7u));auto& frame=*Frame::current;
  NativeNoScriptEntry entry(frame);
  JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<Template>(templ)));CHECK(!TemplateInfo(record).used);
  JSAutoRealm home(frame.cx,record);
  JS::RootedObject properties(frame.cx,&JS::GetReservedSlot(record,TemplateProperties).toObject());
  JS::RootedObject owner(frame.cx,JS::CurrentGlobalOrNull(frame.cx));
  JS::RootedValue key(frame.cx,Input(name)),payload(frame.cx,data.IsEmpty()?JS::UndefinedValue():Input(data).get());
  JS::RootedId id(frame.cx);
  CHECK(JS_WrapValue(frame.cx,&key)&&JS_WrapValue(frame.cx,&payload)&&JS_ValueToId(frame.cx,key,&id));
  NativePropertyCallbacks callbacks{getter,setter,frame.domain,getterEffect,setterEffect,lazy};
  JS::RootedObject metadata(frame.cx,NewNativePropertyRecord(frame,callbacks,owner,payload));CHECK(metadata);
  JS::RootedValue value(frame.cx,JS::ObjectValue(*metadata));
  unsigned flags=(attrs&DontEnum)?0:JSPROP_ENUMERATE;
  if(attrs&ReadOnly)flags|=JSPROP_READONLY;if(attrs&DontDelete)flags|=JSPROP_PERMANENT;
  CHECK(JS_DefinePropertyById(frame.cx,properties,id,value,flags));
}
}
void Template::SetNativeDataProperty(Local<Name> name,AccessorNameGetterCallback getter,
    AccessorNameSetterCallback setter,Local<Value> data,PropertyAttribute attrs,
    SideEffectType getterEffect,SideEffectType setterEffect){
  SetTemplateNativeProperty(this,name,getter,setter,data,attrs,getterEffect,setterEffect,false);
}
void Template::SetLazyDataProperty(Local<Name> name,AccessorNameGetterCallback getter,
    Local<Value> data,PropertyAttribute attrs,SideEffectType getterEffect,SideEffectType setterEffect){
  SetTemplateNativeProperty(this,name,getter,nullptr,data,attrs,getterEffect,setterEffect,true);
}
void Template::SetAccessorProperty(Local<Name> name,Local<FunctionTemplate> getter,Local<FunctionTemplate> setter,PropertyAttribute attrs){
  auto& frame=*Frame::current;JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<Template>(this)));
  CHECK(!TemplateInfo(record).used&&(!getter.IsEmpty()||!setter.IsEmpty())&&!(unsigned(attrs)&~7u));
  JSAutoRealm home(frame.cx,record);JS::RootedObject accessor(frame.cx,JS_NewObject(frame.cx,&templateAccessorClass));CHECK(accessor);
  for(unsigned part=0;part<2;++part){
    auto input=part==0?getter:setter;if(input.IsEmpty())continue;
    JS::RootedObject callable(frame.cx,TemplateRecord(frame,input));CHECK(TemplateInfo(callable).callback);
    CHECK(JS_WrapObject(frame.cx,&callable));JS::SetReservedSlot(accessor,part,JS::ObjectValue(*callable));
  }
  JS::RootedObject properties(frame.cx,&JS::GetReservedSlot(record,TemplateProperties).toObject());
  JS::RootedValue key(frame.cx,Input(name)),value(frame.cx,JS::ObjectValue(*accessor));JS::RootedId id(frame.cx);
  CHECK(JS_WrapValue(frame.cx,&key)&&JS_ValueToId(frame.cx,key,&id));
  unsigned flags=(attrs&DontEnum)?0:JSPROP_ENUMERATE;if(attrs&DontDelete)flags|=JSPROP_PERMANENT;
  CHECK(JS_DefinePropertyById(frame.cx,properties,id,value,flags));
}
bool FunctionTemplate::HasInstance(Local<Value> value){
  auto& frame=*Frame::current;NativeNoScriptEntry entry(frame);
  JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<FunctionTemplate>(this)));
  return ReceiverMatches(frame,Input(value),record);
}
void FunctionTemplate::ReadOnlyPrototype(){
  auto& frame=*Frame::current;auto& info=TemplateInfo(TemplateRecord(frame,Local<FunctionTemplate>(this)));
  CHECK(!info.used);info.readOnlyPrototype=true;
}
void FunctionTemplate::SetLength(int length){
  auto& frame=*Frame::current;auto& info=TemplateInfo(TemplateRecord(frame,Local<FunctionTemplate>(this)));
  CHECK(!info.used&&length>=0&&length<=int(UINT16_MAX));info.length=length;
}
MaybeLocal<Function> Function::New(Local<Context> context,FunctionCallback callback,Local<Data> data,int length,ConstructorBehavior behavior,SideEffectType effects){
  auto& frame=Current(context->isolate);NativeNoScriptEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  auto templ=FunctionTemplate::New(context->isolate,callback,{}, {},length,behavior,effects);
  if(templ.IsEmpty())return {};
  JS::RootedObject record(frame.cx,TemplateRecord(frame,templ));
  {JSAutoRealm home(frame.cx,record);JS::RootedValue payload(frame.cx,data.IsEmpty()?JS::UndefinedValue():Input(data).get());
    if(!JS_WrapValue(frame.cx,&payload))return {};JS::SetReservedSlot(record,TemplatePayload,payload);}
  return templ->GetFunction(context);
}
MaybeLocal<Function> FunctionTemplate::GetFunction(Local<Context> context){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<FunctionTemplate>(this))),global(frame.cx,&context->cell().value.toObject());
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
    unsigned flags=JSPROP_PERMANENT|(info.readOnlyPrototype?JSPROP_READONLY:0);
    if(!JS_DefineProperty(frame.cx,prototype,"constructor",object,0)||!JS_DefineProperty(frame.cx,object,"prototype",prototype,flags))return {};
    JS::RootedObject prototypeTemplate(frame.cx,UnwrapTemplateObject(frame.cx,JS::GetReservedSlot(record,TemplatePrototype)));
    if(prototypeTemplate&&!ApplyTemplateProperties(frame,prototypeTemplate,prototype,context))return {};
    JS::RootedObject parent(frame.cx,UnwrapTemplateObject(frame.cx,JS::GetReservedSlot(record,TemplateParent)));
    if(parent){
      JS::RootedValue parentRecord(frame.cx,JS::ObjectValue(*parent));Local<Function> constructor;
      if(!frame.Own<FunctionTemplate>(parentRecord)->GetFunction(context).ToLocal(&constructor))return {};
      JS::RootedObject parentFunction(frame.cx,&Input(constructor).toObject());JS::RootedValue parentPrototype(frame.cx);
      if(!JS_GetProperty(frame.cx,parentFunction,"prototype",&parentPrototype))return {};
      CHECK(parentPrototype.isObjectOrNull());JS::RootedObject inherited(frame.cx,parentPrototype.toObjectOrNull());
      if(!JS_SetPrototype(frame.cx,prototype,inherited))return {};
    }
  }
  if(!ApplyTemplateProperties(frame,record,object,context))return {};
  {JSAutoRealm cacheRealm(frame.cx,cache);JS::RootedValue key(frame.cx,JS::ObjectValue(*global)),stored(frame.cx,value);if(!JS_WrapValue(frame.cx,&key)||!JS_WrapValue(frame.cx,&stored)||!JS::SetWeakMapEntry(frame.cx,cache,key,stored))return {};}
  return frame.Own<Function>(value);
}
MaybeLocal<Object> ObjectTemplate::NewInstance(Local<Context> context){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  JS::RootedObject record(frame.cx,TemplateRecord(frame,Local<ObjectTemplate>(this)));auto& info=TemplateInfo(record);CHECK(info.kind==NativeTemplateKind::Object);
  JS::RootedObject constructor(frame.cx,UnwrapTemplateObject(frame.cx,JS::GetReservedSlot(record,TemplateConstructor)));
  Context::Scope home(context);JS::RootedObject prototype(frame.cx),callable(frame.cx);
  if(constructor){
    JS::RootedValue value(frame.cx,JS::ObjectValue(*constructor));Local<Function> function;
    if(!frame.Own<FunctionTemplate>(value)->GetFunction(context).ToLocal(&function))return {};
    callable=&Input(function).toObject();JS::RootedValue candidate(frame.cx);
    if(!JS_GetProperty(frame.cx,callable,"prototype",&candidate))return {};
    prototype=candidate.isObject()?&candidate.toObject():JS::GetRealmObjectPrototype(frame.cx);
  }else prototype=JS::GetRealmObjectPrototype(frame.cx);
  if(!prototype)return {};
  // Instantiate the requested object template without calling the constructor's
  // native callback. Its own fields/properties may differ from InstanceTemplate.
  const bool intercepted=constructor&&NativeTemplateHasInterceptors(frame,constructor);
  JS::RootedObject object(frame.cx,JS_NewObjectWithGivenProto(frame.cx,InstanceClass(info,intercepted),prototype));if(!object)return {};
  if(constructor){
    if(!js::ObjectRealm::get(object).recordConstructorIdentity(frame.cx,object,callable))return {};
    JS::RootedObject brand(frame.cx,constructor);if(!JS_WrapObject(frame.cx,&brand))return {};
    JS::SetReservedSlot(object,NativeTemplateBrand,JS::ObjectValue(*brand));
    TemplateInfo(constructor).used=true;
  }
  if(info.fieldCount&&!InitializeNativeInternalFields(frame,object,info.fieldCount))return {};
  if(!ApplyTemplateProperties(frame,record,object,context))return {};JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<Object>(value);
}
bool ApplyNativeTemplate(Frame& frame,Local<ObjectTemplate> input,JS::HandleObject target){
  if(input.IsEmpty()||JS_IsExceptionPending(frame.cx))return false;JS::RootedObject record(frame.cx,TemplateRecord(frame,input));
  CHECK(TemplateInfo(record).kind==NativeTemplateKind::Object);
  if(!AdmitNativeTemplateInstantiation(frame,record))return false;
  if(TemplateInfo(record).fieldCount&&!InitializeNativeInternalFields(frame,target,TemplateInfo(record).fieldCount))return false;
  return ApplyTemplateProperties(frame,record,target,frame.state->isolate.GetCurrentContext());
}
Local<FunctionTemplate> CreateNativeWrapperTemplate(Isolate* isolate,int count){
  auto output=FunctionTemplate::New(isolate);if(!output.IsEmpty())output->InstanceTemplate()->SetInternalFieldCount(count);return output;
}
}
#endif
