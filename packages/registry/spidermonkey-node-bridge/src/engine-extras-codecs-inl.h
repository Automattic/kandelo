#ifndef KANDELO_ENGINE_EXTRAS_CODECS_INL_H
#define KANDELO_ENGINE_EXTRAS_CODECS_INL_H
namespace v8 {
namespace {
void NativeExtrasCollectGarbage(const FunctionCallbackInfo<Value>& args){
  // Match the upstream no-argument GC extension with a real full collection.
  // Option-bag/async/snapshot requests still need engine-service adaptation;
  // reject them explicitly instead of silently collecting with different rules.
  if(args.Length()!=0){
    JS_ReportErrorASCII(Current(args.GetIsolate()).cx,
        "gc options are not implemented by the SpiderMonkey bridge");return;
  }
  NativeMemoryServices::CollectForTesting(args.GetIsolate());
}
void NativeExtrasGetContinuation(const FunctionCallbackInfo<Value>& args){
  args.GetReturnValue().Set(args.GetIsolate()->GetContinuationPreservedEmbedderDataV2());
}
void NativeExtrasSetContinuation(const FunctionCallbackInfo<Value>& args){
  args.GetIsolate()->SetContinuationPreservedEmbedderDataV2(args[0]);
}
void NativeExtrasTraceEnabled(const FunctionCallbackInfo<Value>& args){
  auto result=bridge::extras::NativeBuiltinIsTraceCategoryEnabled(args.GetIsolate(),bridge::extras::NativeBuiltinArguments(args));
  if(!result.IsEmpty())args.GetReturnValue().Set(result);
}
void NativeExtrasTrace(const FunctionCallbackInfo<Value>& args){
  auto result=bridge::extras::NativeBuiltinTrace(args.GetIsolate(),bridge::extras::NativeBuiltinArguments(args));
  if(!result.IsEmpty())args.GetReturnValue().Set(result);
}
}
bool InitializeNativeExtras(Frame& frame,Local<Context> context){
  JS::RootedObject storage(frame.cx,ExistingContextEmbedderStorage(frame,*context.get()));CHECK(storage);
  CHECK(JS::GetReservedSlot(storage,5).isUndefined());
  JS::RootedObject object(frame.cx,JS_NewObjectWithGivenProto(frame.cx,nullptr,nullptr));if(!object)return false;
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));auto binding=frame.Own<Object>(value);
  struct Method{const char* name;FunctionCallback callback;int length;};
  for(const auto& method:{Method{"getContinuationPreservedEmbedderData",NativeExtrasGetContinuation,0},
      Method{"setContinuationPreservedEmbedderData",NativeExtrasSetContinuation,1},
      Method{"isTraceCategoryEnabled",NativeExtrasTraceEnabled,1},Method{"trace",NativeExtrasTrace,5}}){
    Local<Function> function;if(!Function::New(context,method.callback,{},method.length,ConstructorBehavior::kThrow).ToLocal(&function))return false;
    auto name=String::NewFromUtf8(context->isolate,method.name).ToLocalChecked();function->SetName(name);
    if(!binding->CreateDataProperty(context,name,function).FromMaybe(false))return false;
  }
  JS::SetReservedSlot(storage,5,JS::ObjectValue(*object));
  if(bridge::ExposedGcEnabled()){
    Local<Function> collect;
    if(!Function::New(context,NativeExtrasCollectGarbage,{},0,ConstructorBehavior::kThrow).ToLocal(&collect))return false;
    auto name=String::NewFromUtf8(context->isolate,"gc").ToLocalChecked();collect->SetName(name);
    if(!context->Global()->CreateDataProperty(context,name,collect).FromMaybe(false))return false;
  }
  return true;
}
Local<Object> Context::GetExtrasBindingObject(){
  auto& frame=Current(isolate);frame.state->AssertForeground();
  auto* storage=ExistingContextEmbedderStorage(frame,*this);CHECK(storage);
  JS::RootedValue value(frame.cx,JS::GetReservedSlot(storage,5));CHECK(value.isObject());
  // Constructed with the realm. This getter runs no script and does not clear
  // an already pending error/stop or allocate a replacement binding.
  return frame.Own<Object>(value);
}
}
#endif
