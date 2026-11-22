#ifndef KANDELO_NODE_INSPECTION_CODECS_INL_H
#define KANDELO_NODE_INSPECTION_CODECS_INL_H

#include "proxy/ScriptedProxyHandler.h"
#include "js/LocaleSensitive.h"

namespace v8 {
Data* RebindProxyHandle(Data* input){
  if(!input)return nullptr;
  CHECK(Frame::current&&input->IsValue());auto& frame=*Frame::current;CheckNativePrimitiveAccess(frame);
  CHECK(input->cell().context==frame.cx);JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,input->cell().value));
  CHECK(object&&js::IsScriptedProxy(object));
  if(input->RootFactoryForStorage()==&CloneWrapper<Proxy>)return input;
  return frame.OwnTypedView<Proxy>(*input).get();
}
Local<Value> Proxy::GetTarget(){
  auto& frame=*Frame::current;CheckNativePrimitiveAccess(frame);
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(object&&js::IsScriptedProxy(object));
  JS::RootedObject target(frame.cx,js::GetProxyTargetObject(object));
  JS::RootedValue value(frame.cx,target?JS::ObjectValue(*target):JS::NullValue());
  CHECK(JS_WrapValue(frame.cx,&value));return frame.OwnValue(value);
}
Local<Value> Proxy::GetHandler(){
  auto& frame=*Frame::current;CheckNativePrimitiveAccess(frame);
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(object&&js::IsScriptedProxy(object));
  JS::RootedObject handler(frame.cx,js::ScriptedProxyHandler::handlerObject(object));
  JS::RootedValue value(frame.cx,handler?JS::ObjectValue(*handler):JS::NullValue());
  CHECK(JS_WrapValue(frame.cx,&value));return frame.OwnValue(value);
}
std::string Isolate::GetDefaultLocale(){
  auto state=owner.lock();CHECK(state&&state->cx==js::TlsContext.get());state->AssertForeground();
  JS::UniqueChars locale=JS_GetDefaultLocale(state->cx);
  if(!locale)Crash("Cannot obtain the engine default locale");
  return std::string(locale.get());
}
namespace {
bool PreviewNativeIterator(Frame& frame,JS::HandleObject input,bool map,
                           bool originalIterator,JS::RootedValueVector& values,bool* keyValue){
  using Iterator=js::TableIteratorObject;using Kind=Iterator::Kind;
  auto* cx=frame.cx;JS::RootedObject target(cx,input),iterator(cx);
  Kind kind=map?Kind::Entries:Kind::Values;
  if(originalIterator){
    kind=Kind(input->as<Iterator>().getReservedSlot(Iterator::KindSlot).toPrivateUint32());
    auto stored=input->as<Iterator>().getReservedSlot(Iterator::TargetSlot);
    *keyValue=kind==Kind::Entries;
    if(!stored.isObject())return true;
    target=&stored.toObject();
  }else *keyValue=map;
  if(map){
    JS::Rooted<js::MapObject*> table(cx,&target->as<js::MapObject>());
    iterator=js::MapIteratorObject::create(cx,table,kind);
  }else{
    JS::Rooted<js::SetObject*> table(cx,&target->as<js::SetObject>());
    iterator=js::SetIteratorObject::create(cx,table,kind);
  }
  if(!iterator)return false;
  if(originalIterator){
    // Clone the engine cursor after allocation: GC can update the original's
    // index/count during table compaction. Never advance the inspected iterator.
    for(unsigned slot:{Iterator::IndexSlot,Iterator::CountSlot})
      iterator->as<Iterator>().setReservedSlot(slot,input->as<Iterator>().getReservedSlot(slot));
  }
  JS::RootedObject result(cx,map?js::MapIteratorObject::createResultPair(cx):js::SetIteratorObject::createResult(cx));
  if(!result)return false;
  for(;;){
    bool done=map?js::MapIteratorObject::next(&iterator->as<js::MapIteratorObject>(),&result->as<js::ArrayObject>()):
                  js::SetIteratorObject::next(&iterator->as<js::SetIteratorObject>(),&result->as<js::ArrayObject>());
    if(done){
      // V8's HasMore also exhausts the original when there are no entries.
      // Use the real engine transition; otherwise a later insertion would
      // incorrectly revive a previewed empty iterator.
      if(originalIterator&&values.empty()){
        bool originalDone=map?js::MapIteratorObject::next(&input->as<js::MapIteratorObject>(),&result->as<js::ArrayObject>()):
                              js::SetIteratorObject::next(&input->as<js::SetIteratorObject>(),&result->as<js::ArrayObject>());
        CHECK(originalDone);
      }
      return true;
    }
    if(map){
      if(kind!=Kind::Values&&!values.append(result->as<js::ArrayObject>().getDenseElement(0)))return false;
      if(kind!=Kind::Keys&&!values.append(result->as<js::ArrayObject>().getDenseElement(1)))return false;
    }else{
      auto value=result->as<js::ArrayObject>().getDenseElement(0);
      if(!values.append(value)||(*keyValue&&!values.append(value)))return false;
    }
  }
}
}
MaybeLocal<Array> Object::PreviewEntries(bool* keyValue){
  CHECK(Frame::current&&keyValue);auto& frame=*Frame::current;NativeNoScriptEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  JS::RootedValueVector values(frame.cx);JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));if(!object)return {};
  {
    JSAutoRealm home(frame.cx,object);
    if(object->is<js::MapObject>()||object->is<js::MapIteratorObject>()){
      if(!PreviewNativeIterator(frame,object,true,object->is<js::MapIteratorObject>(),values,keyValue))return {};
    }else if(object->is<js::SetObject>()||object->is<js::SetIteratorObject>()){
      if(!PreviewNativeIterator(frame,object,false,object->is<js::SetIteratorObject>(),values,keyValue))return {};
    }else if(object->is<js::WeakMapObject>()||object->is<js::WeakSetObject>()){
      bool map=object->is<js::WeakMapObject>();JS::RootedObject keys(frame.cx);
      if(!(map?JS_NondeterministicGetWeakMapKeys(frame.cx,object,&keys):JS_NondeterministicGetWeakSetKeys(frame.cx,object,&keys)))return {};
      uint32_t count;if(!JS::GetArrayLength(frame.cx,keys,&count))return {};*keyValue=map;
      for(uint32_t i=0;i<count;++i){
        JS::RootedValue key(frame.cx),value(frame.cx);
        if(!JS_GetElement(frame.cx,keys,i,&key)||!values.append(key))return {};
        if(map&&(!JS::GetWeakMapEntry(frame.cx,object,key,&value)||!values.append(value)))return {};
      }
    }else return {};
  }
  for(size_t i=0;i<values.length();++i)if(!JS_WrapValue(frame.cx,values[i]))return {};
  JS::RootedObject array(frame.cx,JS::NewArrayObject(frame.cx,JS::HandleValueArray(values)));if(!array)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*array));return frame.Own<Array>(value);
}
}
#endif
