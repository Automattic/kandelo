#ifndef KANDELO_NODE_PROPERTY_CODECS_INL_H
#define KANDELO_NODE_PROPERTY_CODECS_INL_H

// Native embedding marshalling only. Upstream process callback algorithms stay
// in their complete original translation units.
namespace kandelo_node_codec_api {
namespace {
struct NativePropertyCallbacks {
  AccessorNameGetterCallback getter;
  AccessorNameSetterCallback setter;
  Domain domain;
  SideEffectType getterEffect, setterEffect;
};
void FinalizeNativePropertyCallbacks(JS::GCContext*, JSObject* object) {
  auto value=JS::GetReservedSlot(object,0);
  if(!value.isUndefined())delete static_cast<NativePropertyCallbacks*>(value.toPrivate());
}
const JSClassOps nativePropertyOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeNativePropertyCallbacks};
// Callback pointers are native-only. Realm and payload are actual traced slots;
// no hidden persistent JS roots or captured native frame are retained.
const JSClass nativePropertyClass={"NodeNativeProperty",JSCLASS_HAS_RESERVED_SLOTS(3)|JSCLASS_FOREGROUND_FINALIZE,&nativePropertyOps};
Local<Name> NativePropertyName(Frame& frame,JS::HandleId id) {
  JS::RootedValue key(frame.cx);
  if(!JS_IdToValue(frame.cx,id,&key))return {};
  if(key.isInt32()) {
    JS::RootedString string(frame.cx,JS::ToString(frame.cx,key));if(!string)return {};
    key.setString(string);
  }
  CHECK(key.isString()||key.isSymbol());return frame.OwnValue(key).As<Name>();
}
bool InvokeNativeProperty(JSContext* cx,JS::HandleObject holder,
                          JS::HandleValue receiver,JS::HandleId id,
                          JS::HandleValue data,JS::HandleValue input,
                          bool setter,JS::MutableHandleValue output) {
  JS::RootedObject metadata(cx,&data.toObject());
  CHECK(JS::GetClass(metadata)==&nativePropertyClass);
  auto* callbacks=static_cast<NativePropertyCallbacks*>(JS::GetReservedSlot(metadata,0).toPrivate());
  JS::RootedObject realm(cx,&JS::GetReservedSlot(metadata,1).toObject());
  if(!kandelo::node::CheckRealmLibraryActive(cx,realm))return false;
  JS::RootedObject runtime(cx,kandelo::node::GetRealmRuntime(cx,realm));if(!runtime)return false;
  auto state=Data(cx,runtime);if(!state)return false;
  Frame frame(cx,realm,state,nullptr,callbacks->domain);
  frame.binding=holder;frame.receiver=receiver;frame.propertyHolder=holder;
  frame.propertyData=JS::GetReservedSlot(metadata,2);
  frame.propertyReturn=setter?JS::TrueValue():JS::UndefinedValue();
  auto name=NativePropertyName(frame,id);if(name.IsEmpty())return false;
  if(setter) {
    CHECK(callbacks->setter);
    PropertyCallbackInfo<void> info(&state->isolate);
    callbacks->setter(name,frame.OwnValue(input),info);
  }else {
    PropertyCallbackInfo<Value> info(&state->isolate);
    callbacks->getter(name,info);
  }
  if(JS_IsExceptionPending(cx)||js::shell::GetShellContext(cx)->upstreamNodeExecutionTerminated)return false;
  output.set(frame.propertyReturn);return JS_WrapValue(cx,output);
}
bool ReadNativeProperty(JSContext* cx,JS::HandleObject holder,
                        JS::HandleValue receiver,JS::HandleId id,
                        JS::HandleValue data,JS::MutableHandleValue output) {
  return InvokeNativeProperty(cx,holder,receiver,id,data,JS::UndefinedHandleValue,false,output);
}
bool WriteNativeProperty(JSContext* cx,JS::HandleObject holder,JS::HandleId id,
                         JS::HandleValue data,JS::HandleValue input,
                         JS::ObjectOpResult& result) {
  JS::RootedValue receiver(cx,JS::ObjectValue(*holder)),output(cx);
  if(!InvokeNativeProperty(cx,holder,receiver,id,data,input,true,&output))return false;
  // The setter return slot defaults true. A deliberate false rejects the write;
  // callers retain responsibility for strict versus Reflect failure reporting.
  if(output.isBoolean()&&!output.toBoolean())return result.fail(JSMSG_READ_ONLY);
  return result.succeed();
}
}
Local<Object> PropertyHolder(Isolate* isolate) {
  auto& frame=Current(isolate);CHECK(frame.propertyHolder);
  JS::RootedValue value(frame.cx,JS::ObjectValue(*frame.propertyHolder));
  return frame.Own<Object>(value);
}
Local<Value> PropertyData(Isolate* isolate) {
  auto& frame=Current(isolate);CHECK(frame.propertyHolder);
  return frame.OwnValue(frame.propertyData);
}
Maybe<bool> Object::SetNativeDataProperty(
    Local<Context> context,Local<Name> name,AccessorNameGetterCallback getter,
    AccessorNameSetterCallback setter,Local<Value> data,PropertyAttribute attrs,
    SideEffectType getterEffect,SideEffectType setterEffect) {
  auto& frame=Current(context->isolate);NativeEntry nativeEntry(frame);if(nativeEntry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  if(!getter||(unsigned(attrs)&~7u)) {
    JS_ReportErrorASCII(frame.cx,"Native data property requires a getter and valid attributes");return {};
  }
  JS::RootedObject runtime(frame.cx,kandelo::node::GetRealmRuntime(frame.cx,frame.realm));if(!runtime)return {};
  Context::Scope home(context);
  JS::RootedObject target(frame.cx,UnwrapObject(frame.cx,cell().value));if(!target)return {};
  if(JS::GetNonCCWObjectGlobal(target)!=JS::CurrentGlobalOrNull(frame.cx)) {
    JS_ReportErrorASCII(frame.cx,"Native property context must match target creation realm");return {};
  }
  JS::RootedObject owner(frame.cx,kandelo::node::GetCurrentRealmOwner(frame.cx,runtime));if(!owner)return {};
  JS::RootedValue key(frame.cx,Input(name)),payload(frame.cx,data.IsEmpty()?JS::UndefinedValue():Input(data).get());
  JS::RootedId id(frame.cx);
  if(!JS_WrapValue(frame.cx,&key)||!JS_WrapValue(frame.cx,&payload)||!JS_ValueToId(frame.cx,key,&id))return {};
  auto callbacks=std::make_unique<NativePropertyCallbacks>(NativePropertyCallbacks{getter,setter,frame.domain,getterEffect,setterEffect});
  JS::RootedObject metadata(frame.cx,JS_NewObject(frame.cx,&nativePropertyClass));if(!metadata)return {};
  JS::SetReservedSlot(metadata,0,JS::PrivateValue(callbacks.release()));
  JS::SetReservedSlot(metadata,1,JS::ObjectValue(*owner));JS::SetReservedSlot(metadata,2,payload);
  unsigned flags=0;
  if(!(attrs&DontEnum))flags|=JSPROP_ENUMERATE;
  if(attrs&ReadOnly)flags|=JSPROP_READONLY;
  if(attrs&DontDelete)flags|=JSPROP_PERMANENT;
  JS::RootedValue record(frame.cx,JS::ObjectValue(*metadata));JS::ObjectOpResult result;
  if(!js::DefineKandeloNativeDataProperty(frame.cx,target,id,ReadNativeProperty,setter?WriteNativeProperty:nullptr,record,flags,result)||!result.checkStrict(frame.cx,target,id))return {};
  return Just(true);
}
}  // namespace kandelo_node_codec_api

namespace kandelo::node {
namespace {
const JSClass nativePropertyTestClass={"NodeNativePropertyTest",JSCLASS_HAS_RESERVED_SLOTS(3)};
// Test callbacks consume the real native PropertyCallbackInfo marshalling.
void PropertyTestGetter(api::Local<api::Name> key,const api::PropertyCallbackInfo<api::Value>& info) {
  auto* isolate=info.GetIsolate();auto& frame=api::Current(isolate);
  CHECK(native::Environment::GetCurrent(info)==&frame.state->environment);
  JS::RootedObject metadata(frame.cx,&api::Input(info.Data()).toObject());
  CHECK(JS::GetClass(metadata)==&nativePropertyTestClass);
  JS::RootedValue getter(frame.cx,JS::GetReservedSlot(metadata,0)),result(frame.cx);
  JS::RootedValueArray<4> arguments(frame.cx);
  arguments[0].set(api::Input(info.HolderV2()));arguments[1].set(api::Input(key));
  arguments[2].set(JS::GetReservedSlot(metadata,2));
  arguments[3].set(api::Input(isolate->GetCurrentContext()->Global()));
  if(!JS::Call(frame.cx,frame.receiver,getter,arguments,&result))return;
  if(result.isUndefined())return;
  if(result.isNumber())info.GetReturnValue().Set(result.toNumber());
  else if(result.isBoolean())info.GetReturnValue().Set(result.toBoolean());
  else if(result.isString()&&JS_GetStringLength(result.toString())==0)info.GetReturnValue().SetEmptyString();
  else info.GetReturnValue().Set(frame.OwnValue(result));
}
void PropertyTestSetter(api::Local<api::Name> key,api::Local<api::Value> input,
                        const api::PropertyCallbackInfo<void>& info) {
  auto* isolate=info.GetIsolate();auto& frame=api::Current(isolate);
  CHECK(native::Environment::GetCurrent(info)==&frame.state->environment);
  JS::RootedObject metadata(frame.cx,&api::Input(info.Data()).toObject());
  CHECK(JS::GetClass(metadata)==&nativePropertyTestClass);
  JS::RootedValue setter(frame.cx,JS::GetReservedSlot(metadata,1)),result(frame.cx);
  JS::RootedValueArray<5> arguments(frame.cx);
  arguments[0].set(api::Input(info.HolderV2()));arguments[1].set(api::Input(key));arguments[2].set(api::Input(input));
  arguments[3].set(JS::GetReservedSlot(metadata,2));
  arguments[4].set(api::Input(isolate->GetCurrentContext()->Global()));
  if(!JS::Call(frame.cx,frame.receiver,setter,arguments,&result))return;
  if(result.isBoolean()&&!result.toBoolean())info.GetReturnValue().Set(false);
}
bool DefineNativePropertyForTesting(JSContext* cx,unsigned argc,JS::Value* vp) {
  auto args=JS::CallArgsFromVp(argc,vp);
  if(argc<4||argc>6||!args[0].isObject()||(!args[1].isString()&&!args[1].isSymbol())||
     !args[2].isObject()||!JS::IsCallable(&args[2].toObject())||
     (!args[3].isUndefined()&&(!args[3].isObject()||!JS::IsCallable(&args[3].toObject())))||
     (argc==6&&(!args[5].isInt32()||args[5].toInt32()<0||args[5].toInt32()>7))) {
    JS_ReportErrorASCII(cx,"Native property control requires target, key, getter, optional setter/data/attributes");return false;
  }
  JS::RootedObject target(cx,js::CheckedUnwrapDynamic(&args[0].toObject(),cx,false));if(!target)return false;
  JS::RootedObject runtime(cx,js::shell::GetShellContext(cx)->upstreamNodeRuntime);
  auto state=api::Data(cx,runtime);if(!state)return false;
  JSAutoRealm home(cx,target);
  JS::RootedObject realm(cx,GetCurrentRealmOwner(cx,runtime));if(!realm)return false;
  api::Frame frame(cx,realm,state,nullptr,api::Domain::NativeProperty);
  JS::RootedValue getter(cx,args[2]),setter(cx,args[3]),payload(cx,args.get(4)),key(cx,args[1]);
  if(!JS_WrapValue(cx,&getter)||!JS_WrapValue(cx,&setter)||!JS_WrapValue(cx,&payload)||!JS_WrapValue(cx,&key))return false;
  JS::RootedObject metadata(cx,JS_NewObject(cx,&nativePropertyTestClass));if(!metadata)return false;
  JS::SetReservedSlot(metadata,0,getter);JS::SetReservedSlot(metadata,1,setter);JS::SetReservedSlot(metadata,2,payload);
  JS::RootedValue object(cx,JS::ObjectValue(*target)),data(cx,JS::ObjectValue(*metadata));
  auto installed=frame.Own<api::Object>(object)->SetNativeDataProperty(
      state->isolate.GetCurrentContext(),frame.OwnValue(key).As<api::Name>(),PropertyTestGetter,
      setter.isUndefined()?nullptr:PropertyTestSetter,frame.OwnValue(data),
      api::PropertyAttribute(argc==6?args[5].toInt32():0),api::SideEffectType::kHasNoSideEffect);
  if(installed.IsNothing())return false;args.rval().setBoolean(installed.FromJust());return true;
}
}
bool DefineNativePropertyTestAPI(JSContext* cx,JS::HandleObject target) {
  return JS_DefineFunction(cx,target,"defineNativeProperty",DefineNativePropertyForTesting,4,0);
}
}
#endif
