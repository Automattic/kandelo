#ifndef KANDELO_VALUE_PROPERTY_CODECS_INL_H
#define KANDELO_VALUE_PROPERTY_CODECS_INL_H
#include "vm/PropertyResult.h"
// Engine operations only; original Node consumers retain policy and algorithms.
namespace v8 {
Maybe<bool> Value::Equals(Local<Context> context,Local<Value> other)const{
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedValue left(frame.cx,cell().value),right(frame.cx,Input(other));bool equal;
  if(!JS_WrapValue(frame.cx,&left)||!JS_WrapValue(frame.cx,&right)||!JS::LooselyEqual(frame.cx,left,right,&equal))return {};
  return Just(equal);
}
bool String::StringEquals(Local<String> other)const{
  CHECK(Frame::current&&!other.IsEmpty());auto& frame=*Frame::current;CheckNativePrimitiveAccess(frame);
  CHECK(cell().context==frame.cx&&other->cell().context==frame.cx);
  JS::RootedString left(frame.cx,cell().value.toString()),right(frame.cx,Input(other).toString());int32_t order;
  if(!JS_CompareStrings(frame.cx,left,right,&order)){
    bridge::FatalOutOfMemory(&frame.state->isolate,"Native String equality",false);
  }
  return order==0;
}
int Name::GetIdentityHash(){
  CHECK(Frame::current);auto& frame=*Frame::current;CheckNativePrimitiveAccess(frame);
  JS::RootedValue name(frame.cx,cell().value);uint32_t hash;
  if(name.isSymbol())hash=name.toSymbol()->hash();
  else{
    CHECK(name.isString());JS::RootedString string(frame.cx,name.toString());
    JS::Rooted<JSAtom*> atom(frame.cx,js::AtomizeString(frame.cx,string));
    if(!atom){
      bridge::FatalOutOfMemory(&frame.state->isolate,"Native Name identity hash",false);
    }
    hash=atom->hash();
  }
  hash&=INT_MAX;return hash?int(hash):1;
}
Maybe<bool> Object::Set(Local<Context> context,uint32_t index,Local<Value> input){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());JS::RootedValue value(frame.cx,Input(input));
  if(!JS_WrapObject(frame.cx,&object)||!JS_WrapValue(frame.cx,&value)||!JS_SetElement(frame.cx,object,index,value))return {};
  return Just(true);
}
MaybeLocal<Value> Object::Get(Local<Context> context,uint32_t index){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());JS::RootedValue value(frame.cx);
  if(!JS_WrapObject(frame.cx,&object)||!JS_GetElement(frame.cx,object,index,&value))return {};
  return frame.OwnValue(value);
}
Maybe<bool> Object::Has(Local<Context> context,uint32_t index){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());bool found;
  if(!JS_WrapObject(frame.cx,&object)||!JS_HasElement(frame.cx,object,index,&found))return {};
  return Just(found);
}
Maybe<bool> Object::HasPrivate(Local<Context> context,Local<Private> key){
  auto& frame=Current(context->isolate);NativeNoScriptEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());JS::RootedValue name(frame.cx,Input(key));
  CHECK(name.isSymbol());JS::RootedSymbol symbol(frame.cx,name.toSymbol());
  CHECK(JS::GetSymbolCode(symbol)==JS::SymbolCode::EmbeddingPrivateSymbol);
  JS::RootedId id(frame.cx,JS::PropertyKey::Symbol(name.toSymbol()));bool found;
  if(!JS_WrapObject(frame.cx,&object)||!JS_HasOwnPropertyById(frame.cx,object,id,&found))return {};
  return Just(found);
}
Maybe<bool> Object::DeletePrivate(Local<Context> context,Local<Private> key){
  auto& frame=Current(context->isolate);NativeNoScriptEntry entry(frame);
  if (entry.Terminated()) return {};
  // Native destructors release their private wrapper while an exception is
  // unwinding. Restore that exception and its stack after the deletion.
  mozilla::Maybe<JS::AutoSaveExceptionState> pending;
  if (JS_IsExceptionPending(frame.cx)) {
    if (frame.cx->exceptionStatus() != JS::ExceptionStatus::Throwing) return {};
    pending.emplace(frame.cx);
  }
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());JS::RootedValue name(frame.cx,Input(key));
  CHECK(name.isSymbol());JS::RootedSymbol symbol(frame.cx,name.toSymbol());
  CHECK(JS::GetSymbolCode(symbol)==JS::SymbolCode::EmbeddingPrivateSymbol);
  JS::RootedId id(frame.cx,JS::PropertyKey::Symbol(name.toSymbol()));JS::ObjectOpResult result;
  if(!JS_WrapObject(frame.cx,&object)||!JS_DeletePropertyById(frame.cx,object,id,result))return {};
  return Just(result.ok());
}
namespace {
// Lookup native storage while bypassing the embedding's interception vtable.
// Standard engine lazy properties and exotic/proxy operations stay engine-owned.
bool FindRealNamed(Frame& frame,JS::HandleObject target,JS::HandleId id,
    JS::MutableHandleObject holder,js::PropertyResult* property,bool* exotic){
  JS::RootedObject current(frame.cx,target),next(frame.cx);*exotic=false;holder.set(nullptr);
  while(current){
    JS::RootedObject raw(frame.cx,js::CheckedUnwrapDynamic(current,frame.cx,false));if(!raw)return false;
    JSAutoRealm realm(frame.cx,raw);
    if(!raw->is<js::NativeObject>()){holder.set(raw);*exotic=true;return true;}
    JS::Rooted<js::NativeObject*> native(frame.cx,&raw->as<js::NativeObject>());
    if(!js::NativeLookupOwnProperty<js::CanGC>(frame.cx,native,id,property))return false;
    if(property->isFound()){holder.set(raw);return true;}
    if(property->shouldIgnoreProtoChain())return true;
    if(!JS_GetPrototype(frame.cx,raw,&next))return false;current=next;
  }
  return true;
}
PropertyAttribute NativeRealAttributes(JS::Handle<js::PropertyDescriptor> descriptor){
  unsigned attributes=0;
  if(descriptor.isDataDescriptor()&&!descriptor.writable())attributes|=ReadOnly;
  if(!descriptor.enumerable())attributes|=DontEnum;
  if(!descriptor.configurable())attributes|=DontDelete;
  return PropertyAttribute(attributes);
}
}
Maybe<bool> Object::HasRealNamedProperty(Local<Context> context,Local<Name> key){
  auto& frame=Current(context->isolate);NativeNoScriptEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));if(!object)return {};
  if(!object->is<js::NativeObject>())return Just(false);
  JSAutoRealm realm(frame.cx,object);JS::RootedValue name(frame.cx,Input(key));JS::RootedId id(frame.cx);
  if(!JS_WrapValue(frame.cx,&name)||!JS_ValueToId(frame.cx,name,&id))return {};
  JS::Rooted<js::NativeObject*> native(frame.cx,&object->as<js::NativeObject>());js::PropertyResult property;
  if(!js::NativeLookupOwnProperty<js::CanGC>(frame.cx,native,id,&property))return {};
  return Just(property.isFound());
}
MaybeLocal<Value> Object::GetRealNamedProperty(Local<Context> context,Local<Name> key){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject target(frame.cx,UnwrapObject(frame.cx,cell().value)),holder(frame.cx);
  if(!target)return {};JS::RootedValue name(frame.cx,Input(key)),value(frame.cx);JS::RootedId id(frame.cx);js::PropertyResult property;bool exotic;
  if(!JS_ValueToId(frame.cx,name,&id)||!FindRealNamed(frame,target,id,&holder,&property,&exotic)||!holder)return {};
  {
    JSAutoRealm realm(frame.cx,holder);JS::RootedValue receiver(frame.cx,JS::ObjectValue(*target));if(!JS_WrapValue(frame.cx,&receiver))return {};
    if(exotic){
      bool found=false;
      if(!js::GetPropertyWithFound(frame.cx,holder,receiver,id,&value,&found)||!found)return {};
    }
    else{
      JS::Rooted<js::NativeObject*> native(frame.cx,&holder->as<js::NativeObject>());
      if(property.isNativeProperty()){
        JS::RootedObject receiverObject(frame.cx,&receiver.toObject());
        if(!js::NativeGetExistingProperty(frame.cx,receiverObject,native,id,property.propertyInfo(),&value))return {};
      }else if(!js::NativeGetPropertyBypassingInterceptors(frame.cx,native,receiver,id,&value))return {};
    }
  }
  if(!JS_WrapValue(frame.cx,&value))return {};return frame.OwnValue(value);
}
Maybe<PropertyAttribute> Object::GetRealNamedPropertyAttributes(Local<Context> context,Local<Name> key){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject target(frame.cx,UnwrapObject(frame.cx,cell().value)),holder(frame.cx);
  if(!target)return {};JS::RootedValue name(frame.cx,Input(key));JS::RootedId id(frame.cx);js::PropertyResult property;bool exotic;
  if(!JS_ValueToId(frame.cx,name,&id)||!FindRealNamed(frame,target,id,&holder,&property,&exotic)||!holder)return {};
  JSAutoRealm realm(frame.cx,holder);
  if(!exotic&&property.isNativeProperty()){
    auto info=property.propertyInfo();unsigned flags=0;
    if(!info.isAccessorProperty()&&!info.writable())flags|=ReadOnly;
    if(!info.enumerable())flags|=DontEnum;if(!info.configurable())flags|=DontDelete;
    return Just(PropertyAttribute(flags));
  }
  JS::Rooted<mozilla::Maybe<JS::PropertyDescriptor>> descriptor(frame.cx);
  if(exotic){JS::RootedObject descriptorHolder(frame.cx);if(!JS_GetPropertyDescriptorById(frame.cx,holder,id,&descriptor,&descriptorHolder))return {};}
  else{
    JS::Rooted<js::NativeObject*> native(frame.cx,&holder->as<js::NativeObject>());
    if(!js::NativeGetOwnPropertyDescriptor(frame.cx,native,id,&descriptor,js::NativePropertyInterception::Bypass))return {};
  }
  if(descriptor.isNothing())return exotic?Just(None):Maybe<PropertyAttribute>();
  JS::Rooted<JS::PropertyDescriptor> complete(frame.cx,descriptor.get().ref());return Just(NativeRealAttributes(complete));
}
}
#endif
