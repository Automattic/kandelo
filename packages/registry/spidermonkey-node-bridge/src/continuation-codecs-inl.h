#ifndef KANDELO_NODE_CONTINUATION_CODECS_INL_H
#define KANDELO_NODE_CONTINUATION_CODECS_INL_H

namespace v8 {
template<class T> std::unique_ptr<T> RetainTypedRoot(Isolate* isolate,Local<T> input) {
  auto& frame=Current(isolate);if(input.IsEmpty())return nullptr;
  JS::RootedValue value(frame.cx,Input(input));
  if constexpr(std::is_same_v<T,Name>)CHECK(value.isString()||value.isSymbol());
  auto root=input->CloneRoot(isolate,std::make_unique<Cell>(frame.cx,value));
  return std::unique_ptr<T>(static_cast<T*>(root.release()));
}
template std::unique_ptr<Value> RetainTypedRoot(Isolate*,Local<Value>);
template std::unique_ptr<Name> RetainTypedRoot(Isolate*,Local<Name>);
std::unique_ptr<Data> RetainRoot(Isolate* isolate,Local<Data> input) {
  auto& frame=Current(isolate);CHECK(!input.IsEmpty());
  JS::RootedValue value(frame.cx,Input(input));
  return input->CloneRoot(isolate,std::make_unique<Cell>(frame.cx,value));
}
Local<Value> Isolate::GetContinuationPreservedEmbedderDataV2() {
  auto& frame=Current(this);JS::RootedValue value(frame.cx,frame.cx->kandeloContinuationData());
  if(!JS_WrapValue(frame.cx,&value))return {};
  return frame.OwnValue(value);
}
void Isolate::SetContinuationPreservedEmbedderDataV2(Local<Value> value) {
  auto& frame=Current(this);
  // V8 explicitly treats an empty handle as clearing continuation data. Node's
  // ordinary InternalCallbackScope uses that case for its default frame.
  frame.cx->kandeloContinuationData()=value.IsEmpty()?JS::UndefinedValue():Input(value).get();
}
}
#endif
