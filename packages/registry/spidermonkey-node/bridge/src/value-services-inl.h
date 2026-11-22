#ifndef KANDELO_NODE_VALUE_SERVICES_INL_H
#define KANDELO_NODE_VALUE_SERVICES_INL_H

#include "builtin/BigInt.h"
#include "builtin/MapObject.h"
#include "builtin/ModuleObject.h"
#include "builtin/Symbol.h"
#include "builtin/WeakMapObject.h"
#include "builtin/WeakSetObject.h"
#include "js/Proxy.h"
#include "vm/ArgumentsObject.h"
#include "vm/BooleanObject.h"
#include "vm/DateObject.h"
#include "vm/GeneratorObject.h"
#include "vm/NumberObject.h"
#include "vm/RegExpObject.h"
#include "vm/StringObject.h"
#ifdef ENABLE_WASM
#include "wasm/WasmJS.h"
#endif

// These interfaces inspect actual engine tags/records or use its conversion
// operations. They never infer a type from replaceable JS properties.
namespace v8 {
bool Value::IsName()const{return IsString()||IsSymbol();}
#define KANDELO_VALUE_CLASS(Name,Class) \
bool Value::Is##Name()const{auto* object=UnwrapObject(Frame::current->cx,cell().value);return object&&object->is<js::Class>();}
KANDELO_VALUE_CLASS(Map,MapObject)
KANDELO_VALUE_CLASS(Set,SetObject)
KANDELO_VALUE_CLASS(WeakMap,WeakMapObject)
KANDELO_VALUE_CLASS(WeakSet,WeakSetObject)
KANDELO_VALUE_CLASS(MapIterator,MapIteratorObject)
KANDELO_VALUE_CLASS(SetIterator,SetIteratorObject)
KANDELO_VALUE_CLASS(NumberObject,NumberObject)
KANDELO_VALUE_CLASS(BooleanObject,BooleanObject)
KANDELO_VALUE_CLASS(StringObject,StringObject)
KANDELO_VALUE_CLASS(SymbolObject,SymbolObject)
KANDELO_VALUE_CLASS(BigIntObject,BigIntObject)
KANDELO_VALUE_CLASS(Date,DateObject)
KANDELO_VALUE_CLASS(RegExp,RegExpObject)
KANDELO_VALUE_CLASS(ArgumentsObject,ArgumentsObject)
KANDELO_VALUE_CLASS(GeneratorObject,AbstractGeneratorObject)
KANDELO_VALUE_CLASS(ModuleNamespaceObject,ModuleNamespaceObject)
#undef KANDELO_VALUE_CLASS
bool Value::IsAsyncFunction()const{
  auto* object=UnwrapObject(Frame::current->cx,cell().value);
  return object&&object->is<JSFunction>()&&object->as<JSFunction>().isAsync();
}
bool Value::IsGeneratorFunction()const{
  auto* object=UnwrapObject(Frame::current->cx,cell().value);
  return object&&object->is<JSFunction>()&&object->as<JSFunction>().isGenerator();
}
bool Value::IsProxy()const{
  auto* object=UnwrapObject(Frame::current->cx,cell().value);
  return object&&js::IsScriptedProxy(object);
}
bool Value::IsWasmMemoryObject()const{
#ifdef ENABLE_WASM
  auto* object=UnwrapObject(Frame::current->cx,cell().value);return object&&object->is<js::WasmMemoryObject>();
#else
  // The engine build has no Wasm memory-object class in this configuration.
  return false;
#endif
}
#define KANDELO_VALUE_TYPED(Name,Kind) \
bool Value::Is##Name()const{auto* object=UnwrapView(Frame::current->cx,cell().value);return object&&JS_IsTypedArrayObject(object)&&JS_GetArrayBufferViewType(object)==JS::Scalar::Kind;}
KANDELO_VALUE_TYPED(Uint8Array,Uint8)
KANDELO_VALUE_TYPED(Uint8ClampedArray,Uint8Clamped)
KANDELO_VALUE_TYPED(Int8Array,Int8)
KANDELO_VALUE_TYPED(Int16Array,Int16)
KANDELO_VALUE_TYPED(Uint16Array,Uint16)
KANDELO_VALUE_TYPED(Int32Array,Int32)
KANDELO_VALUE_TYPED(Uint32Array,Uint32)
KANDELO_VALUE_TYPED(Float16Array,Float16)
KANDELO_VALUE_TYPED(Float32Array,Float32)
KANDELO_VALUE_TYPED(BigInt64Array,BigInt64)
KANDELO_VALUE_TYPED(BigUint64Array,BigUint64)
#undef KANDELO_VALUE_TYPED
MaybeLocal<Number> Value::ToNumber(Local<Context> context)const{
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};Context::Scope home(context);
  JS::RootedValue value(frame.cx,cell().value);double number;
  if(!JS_WrapValue(frame.cx,&value)||!JS::ToNumber(frame.cx,value,&number))return {};
  return Number::New(context->isolate,number);
}
MaybeLocal<Integer> Value::ToInteger(Local<Context> context)const{
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};Context::Scope home(context);
  JS::RootedValue value(frame.cx,cell().value);double number;
  if(!JS_WrapValue(frame.cx,&value)||!JS::ToNumber(frame.cx,value,&number))return {};
  value.setNumber(JS::ToInteger(number));return frame.Own<Integer>(value);
}
MaybeLocal<Int32> Value::ToInt32(Local<Context> context)const{
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};Context::Scope home(context);
  JS::RootedValue value(frame.cx,cell().value);int32_t number;
  if(!JS_WrapValue(frame.cx,&value)||!JS::ToInt32(frame.cx,value,&number))return {};
  value.setInt32(number);return frame.Own<Int32>(value);
}
MaybeLocal<Uint32> Value::ToUint32(Local<Context> context)const{
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};Context::Scope home(context);
  JS::RootedValue value(frame.cx,cell().value);uint32_t number;
  if(!JS_WrapValue(frame.cx,&value)||!JS::ToUint32(frame.cx,value,&number))return {};
  return Uint32::New(context->isolate,number);
}
Local<Boolean> Value::ToBoolean(Isolate* isolate)const{return Boolean::New(isolate,BooleanValue(isolate));}
Maybe<bool> Value::InstanceOf(Local<Context> context,Local<Object> constructor)const{
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};Context::Scope home(context);
  JS::RootedValue value(frame.cx,cell().value);JS::RootedObject object(frame.cx,&Input(constructor).toObject());bool result;
  if(!JS_WrapValue(frame.cx,&value)||!JS_WrapObject(frame.cx,&object)||!JS_HasInstance(frame.cx,object,value,&result))return {};
  return Just(result);
}
size_t TypedArray::Length()const{
  auto* view=UnwrapView(Frame::current->cx,cell().value);CHECK(view&&JS_IsTypedArrayObject(view));return JS_GetTypedArrayLength(view);
}
#define KANDELO_DEFINE_TYPED_ARRAY(Name,Kind) \
Local<Name> Name::New(Local<ArrayBuffer> buffer,size_t offset,size_t length){ \
  auto& frame=*Frame::current;if(JS_IsExceptionPending(frame.cx))return {}; \
  JS::RootedObject backing(frame.cx,UnwrapObject(frame.cx,Input(buffer))); \
  JS::RootedObject object(frame.cx,JS_New##Name##WithBuffer(frame.cx,backing,offset,length));if(!object)return {}; \
  if(!RecordApiViewConstruction(frame,object))return {}; \
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<Name>(value); \
}
KANDELO_NATIVE_TYPED_ARRAYS(KANDELO_DEFINE_TYPED_ARRAY)
#undef KANDELO_DEFINE_TYPED_ARRAY
}
#endif
