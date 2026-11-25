#ifndef KANDELO_NODE_COLLECTION_CODECS_INL_H
#define KANDELO_NODE_COLLECTION_CODECS_INL_H
// Ordinary source-interface objects are the actual realm's SpiderMonkey
// collections/dates. No copied JS facade, constructor lookup or Node policy.
namespace v8 {
Local<Map> Map::New(Isolate* isolate){
  auto& frame=Current(isolate);NativeEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  JS::RootedObject object(frame.cx,JS::NewMapObject(frame.cx));if(!object)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<Map>(value);
}
MaybeLocal<Map> Map::Set(Local<Context> context,Local<Value> key,Local<Value> input){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);
  JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedValue name(frame.cx,Input(key)),value(frame.cx,Input(input));
  if(!JS_WrapObject(frame.cx,&object)||!JS_WrapValue(frame.cx,&name)||
      !JS_WrapValue(frame.cx,&value)||!JS::MapSet(frame.cx,object,name,value))return {};
  JS::RootedValue result(frame.cx,JS::ObjectValue(*object));return frame.Own<Map>(result);
}
Local<Set> Set::New(Isolate* isolate){
  auto& frame=Current(isolate);NativeEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  JS::RootedObject object(frame.cx,JS::NewSetObject(frame.cx));if(!object)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<Set>(value);
}
MaybeLocal<Set> Set::Add(Local<Context> context,Local<Value> input){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);
  JS::RootedObject object(frame.cx,&cell().value.toObject());JS::RootedValue value(frame.cx,Input(input));
  if(!JS_WrapObject(frame.cx,&object)||!JS_WrapValue(frame.cx,&value)||!JS::SetAdd(frame.cx,object,value))return {};
  JS::RootedValue result(frame.cx,JS::ObjectValue(*object));return frame.Own<Set>(result);
}
MaybeLocal<Value> Date::New(Local<Context> context,double milliseconds){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);
  JS::RootedObject object(frame.cx,JS::NewDateObject(frame.cx,JS::TimeClip(milliseconds)));
  if(!object)return {};JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.OwnValue(value);
}
double Date::ValueOf()const{
  auto& frame=*Frame::current;frame.state->AssertForeground();
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));
  CHECK(object&&object->is<js::DateObject>());
  // V8 reads the internal date value without invoking user JavaScript. Use
  // the same pinned engine slot as serialization, preserving invalid-date NaN
  // and existing exceptions without consulting a replaceable valueOf method.
  return object->as<js::DateObject>().UTCTime().toNumber();
}
}
#endif
