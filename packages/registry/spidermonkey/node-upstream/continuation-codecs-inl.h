#ifndef KANDELO_NODE_CONTINUATION_CODECS_INL_H
#define KANDELO_NODE_CONTINUATION_CODECS_INL_H

namespace kandelo_node_codec_api {
std::unique_ptr<Value> RetainRoot(Isolate* isolate,Local<Value> input) {
  auto& frame=Current(isolate);CHECK(!input.IsEmpty());
  JS::RootedValue value(frame.cx,Input(input));
  return std::make_unique<Value>(std::make_unique<Cell>(frame.cx,value));
}
Local<Value> Isolate::GetContinuationPreservedEmbedderDataV2() {
  auto& frame=Current(this);JS::RootedValue value(frame.cx,frame.cx->kandeloContinuationData());
  if(!JS_WrapValue(frame.cx,&value))return {};
  return frame.OwnValue(value);
}
void Isolate::SetContinuationPreservedEmbedderDataV2(Local<Value> value) {
  auto& frame=Current(this);frame.cx->kandeloContinuationData()=Input(value);
}
}
namespace kandelo_node_codec_impl {
Environment* Environment::GetCurrent(Isolate* isolate) { return GetCurrent(isolate->GetCurrentContext()); }
bool Environment::async_context_frame_enabled() const { return kandelo::node::NativeAsyncContextFrameEnabled(); }
}
namespace kandelo_continuation_adapter {
void Get(const FunctionCallbackInfo<Value>& args) { Return(args.GetIsolate(),args.GetIsolate()->GetContinuationPreservedEmbedderDataV2()); }
void Set(const FunctionCallbackInfo<Value>& args) { args.GetIsolate()->SetContinuationPreservedEmbedderDataV2(args[0]); }
}
namespace kandelo::node {
JSObject* CreateContinuationBinding(JSContext* cx,JS::HandleObject realm) {
  JS::RootedObject runtime(cx,GetRealmRuntime(cx,realm));if(!runtime)return nullptr;
  auto state=api::Data(cx,runtime);if(!state)return nullptr;
  api::Frame frame(cx,realm,state,nullptr,api::Domain::Continuation);
  JS::RootedObject object(cx,JS_NewObject(cx,&api::continuationBindingClass));if(!object)return nullptr;frame.binding=object;
  JS::RootedValue value(cx,JS::ObjectValue(*object)),unused(cx,JS::UndefinedValue());
  kandelo_continuation_adapter::initializer(frame.Own<api::Object>(value),frame.OwnValue(unused),state->isolate.GetCurrentContext(),nullptr);
  if(JS_IsExceptionPending(cx))return nullptr;return object;
}
namespace {
bool WithContinuationScopeControl(JSContext* cx,unsigned argc,JS::Value* vp) {
  auto args=JS::CallArgsFromVp(argc,vp);
  if(argc!=2||!args[1].isObject()||!JS::IsCallable(&args[1].toObject())) {
    JS_ReportErrorASCII(cx,"Native continuation scope control requires a value and callable");return false;
  }
  JS::RootedObject runtime(cx,js::shell::GetShellContext(cx)->upstreamNodeRuntime);
  JS::RootedObject realm(cx,GetRuntimePrincipalRealm(cx,runtime));if(!realm)return false;
  realm=js::CheckedUnwrapDynamic(realm,cx,false);if(!realm||!CheckRealmLibraryActive(cx,realm))return false;
  auto state=api::Data(cx,runtime);if(!state)return false;
  api::Frame frame(cx,realm,state,&args,api::Domain::Continuation);
  JS::RootedValue value(cx,args[0]),callback(cx,args[1]);
  return kandelo_continuation_adapter::WithFrame(&state->isolate,frame.OwnValue(value),[&]{
    return JS::Call(cx,JS::UndefinedHandleValue,callback,JS::HandleValueArray::empty(),args.rval());
  });
}
}
bool DefineContinuationTestAPI(JSContext* cx,JS::HandleObject api) {
  return JS_DefineFunction(cx,api,"withContinuationFrame",WithContinuationScopeControl,2,0);
}
}
#endif
