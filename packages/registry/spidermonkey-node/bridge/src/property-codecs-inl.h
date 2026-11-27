#ifndef KANDELO_NODE_PROPERTY_CODECS_INL_H
#define KANDELO_NODE_PROPERTY_CODECS_INL_H

// Native embedding marshalling only. Upstream process callback algorithms stay
// in their complete original translation units.
namespace v8 {
namespace {
// Slot zero is the engine's generic dispatch table, not a Node callback.
// Share this layout with template copying so it cannot reinterpret that table
// as callback storage or copy the creation realm in place of the payload.
enum NativePropertySlot : uint32_t {
  NativePropertyOperations = 0,
  NativePropertyCallbackData,
  NativePropertyRealm,
  NativePropertyPayload,
  NativePropertySlotCount,
};
struct NativePropertyCallbacks {
  AccessorNameGetterCallback getter;
  AccessorNameSetterCallback setter;
  Domain domain;
  SideEffectType getterEffect, setterEffect;
  bool lazy=false;
};
void FinalizeNativePropertyCallbacks(JS::GCContext*, JSObject* object) {
  auto value=JS::GetReservedSlot(object,NativePropertyCallbackData);
  if(!value.isUndefined())delete static_cast<NativePropertyCallbacks*>(value.toPrivate());
}
const JSClassOps nativePropertyOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeNativePropertyCallbacks};
// Callback pointers are native-only. Realm and payload are actual traced slots;
// no hidden persistent JS roots or captured native frame are retained.
const JSClass nativePropertyClass={"NodeNativeProperty",JSCLASS_HAS_RESERVED_SLOTS(NativePropertySlotCount)|JSCLASS_FOREGROUND_FINALIZE,&nativePropertyOps};
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
  auto* callbacks=static_cast<NativePropertyCallbacks*>(JS::GetReservedSlot(metadata,NativePropertyCallbackData).toPrivate());
  JS::RootedObject realm(cx,&JS::GetReservedSlot(metadata,NativePropertyRealm).toObject());
  auto state=ReadNativeEngineState(cx);
  if(!state)return false;
  NativeCallbackEntry callbackEntry(*state);
  Frame frame(cx,realm,state,nullptr,callbacks->domain);
  frame.binding=holder;frame.receiver=receiver;frame.propertyHolder=holder;
  auto mode=cx->nativePropertyFailureMode();
  if(mode)frame.propertyShouldThrow=mode.value();
  JSContext::AutoNativePropertyFailureMode propertyMode(cx,mozilla::Nothing());
  frame.propertyData=JS::GetReservedSlot(metadata,NativePropertyPayload);
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
  if(JS_IsExceptionPending(cx)||cx->isNativeExecutionTerminating())return false;
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
bool ReadLazyNativeProperty(JSContext* cx,JS::HandleObject holder,JS::HandleId id,
                            JS::HandleValue data,JS::MutableHandleValue output){
  JS::RootedValue receiver(cx,JS::ObjectValue(*holder));
  return ReadNativeProperty(cx,holder,receiver,id,data,output);
}
// The engine only interprets this immutable dispatch table. Actual callback
// ownership, realm/payload tracing and retirement belong to this bridge record.
const js::NativeDataPropertyOperations lazyPropertyOperations{
    ReadLazyNativeProperty,nullptr,nullptr};
const js::NativeDataPropertyOperations livePropertyOperations{
    nullptr,ReadNativeProperty,nullptr};
const js::NativeDataPropertyOperations writablePropertyOperations{
    nullptr,ReadNativeProperty,WriteNativeProperty};
JSObject* NewNativePropertyRecord(Frame& frame,const NativePropertyCallbacks& callbacks,
                                 JS::HandleObject owner,JS::HandleValue payload){
  auto native=std::make_unique<NativePropertyCallbacks>(callbacks);
  JS::RootedObject record(frame.cx,JS_NewObject(frame.cx,&nativePropertyClass));if(!record)return nullptr;
  auto* operations=callbacks.lazy?&lazyPropertyOperations:
      callbacks.setter?&writablePropertyOperations:&livePropertyOperations;
  JS::SetReservedSlot(record,NativePropertyOperations,JS::PrivateValue(const_cast<js::NativeDataPropertyOperations*>(operations)));
  JS::SetReservedSlot(record,NativePropertyCallbackData,JS::PrivateValue(native.release()));
  JS::SetReservedSlot(record,NativePropertyRealm,JS::ObjectValue(*owner));JS::SetReservedSlot(record,NativePropertyPayload,payload);
  return record;
}
bool DefineNativePropertyRecord(Frame& frame,JS::HandleObject target,JS::HandleId id,
                                 JS::HandleObject metadata,unsigned flags,JS::ObjectOpResult& result){
  CHECK(JS::GetClass(metadata)==&nativePropertyClass);
  return js::DefineNativeDataPropertyWithRecord(frame.cx,target,id,metadata,flags,result);
}
Maybe<bool> SetObjectNativeProperty(Local<Object> object,Local<Context> context,
    Local<Name> name,AccessorNameGetterCallback getter,AccessorNameSetterCallback setter,
    Local<Value> data,PropertyAttribute attrs,SideEffectType getterEffect,
    SideEffectType setterEffect,bool lazy){
  auto& frame=Current(context->isolate);NativeEntry nativeEntry(frame,context);if(nativeEntry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  if(!getter||(unsigned(attrs)&~7u)){
    JS_ReportErrorASCII(frame.cx,"Native data property requires a getter and valid attributes");return {};
  }
  Context::Scope home(context);
  JS::RootedObject target(frame.cx,UnwrapObject(frame.cx,Input(object)));if(!target)return {};
  if(JS::GetNonCCWObjectGlobal(target)!=JS::CurrentGlobalOrNull(frame.cx)){
    JS_ReportErrorASCII(frame.cx,"Native property context must match target creation realm");return {};
  }
  JS::RootedObject owner(frame.cx,JS::CurrentGlobalOrNull(frame.cx));CHECK(owner);
  JS::RootedValue key(frame.cx,Input(name)),payload(frame.cx,data.IsEmpty()?JS::UndefinedValue():Input(data).get());
  JS::RootedId id(frame.cx);
  if(!JS_WrapValue(frame.cx,&key)||!JS_WrapValue(frame.cx,&payload)||!JS_ValueToId(frame.cx,key,&id))return {};
  NativePropertyCallbacks callbacks{getter,setter,frame.domain,getterEffect,setterEffect,lazy};
  JS::RootedObject metadata(frame.cx,NewNativePropertyRecord(frame,callbacks,owner,payload));if(!metadata)return {};
  unsigned flags=(attrs&DontEnum)?0:JSPROP_ENUMERATE;
  if(attrs&ReadOnly)flags|=JSPROP_READONLY;if(attrs&DontDelete)flags|=JSPROP_PERMANENT;
  JS::ObjectOpResult result;
  if(!DefineNativePropertyRecord(frame,target,id,metadata,flags,result))return {};
  return Just(result.ok());
}
}
bool PropertyShouldThrowOnError(Isolate* isolate){
  auto& frame=Current(isolate);
  if(frame.propertyShouldThrow.has_value())return *frame.propertyShouldThrow;
  // Pinned V8 GetShouldThrow infers the nearest JS closure language mode only
  // when its caller has not supplied an explicit Throw/DontThrow operation.
  jsbytecode* pc=nullptr;
  auto* script=frame.cx->currentScript(&pc,JSContext::AllowCrossRealm::Allow);
  return script&&script->strict();
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
  return SetObjectNativeProperty(Local<Object>(this),context,name,getter,setter,data,attrs,getterEffect,setterEffect,false);
}
Maybe<bool> Object::SetLazyDataProperty(Local<Context> context,Local<Name> name,
    AccessorNameGetterCallback getter,Local<Value> data,PropertyAttribute attrs,
    SideEffectType getterEffect,SideEffectType setterEffect){
  return SetObjectNativeProperty(Local<Object>(this),context,name,getter,nullptr,data,attrs,getterEffect,setterEffect,true);
}
}  // namespace v8

#endif
