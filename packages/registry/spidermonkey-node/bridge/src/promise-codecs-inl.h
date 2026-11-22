#ifndef KANDELO_NODE_PROMISE_CODECS_INL_H
#define KANDELO_NODE_PROMISE_CODECS_INL_H
#include "builtin/Promise.h"

// The actual engine owns Promise resolution, assimilation, reactions and jobs.
// Node retains its original rejection policy and asynchronous resource owners.
namespace v8 {
namespace {
js::PromiseObject* NativePromise(Frame& frame,JS::HandleValue input){
  auto* object=UnwrapObject(frame.cx,input);
  CHECK(object&&object->is<js::PromiseObject>());
  return &object->as<js::PromiseObject>();
}
Maybe<bool> SettleNativePromise(Local<Context> context,JS::HandleValue input,
    Local<Value> value,bool reject){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  // Like the pinned V8 API, only a settled Promise makes this call a no-op.
  // JS::ResolvePromise/RejectPromise use resolving functions with an additional
  // AlreadyResolved latch, which changes repeated native calls while thenable
  // assimilation is still pending. Use the complete original SM internals.
  JS::Rooted<js::PromiseObject*> promise(frame.cx,NativePromise(frame,input));
  if(promise->state()!=JS::PromiseState::Pending)return Just(true);
  CHECK(!value.IsEmpty());
  Context::Scope home(context);
  JS::RootedValue argument(frame.cx,Input(value));
  if(!JS_WrapValue(frame.cx,&argument))return {};
  bool success;
  if(reject){
    // RejectPromiseInternal consumes an unwrapped native object in its realm.
    JSAutoRealm target(frame.cx,promise);
    if(!JS_WrapValue(frame.cx,&argument))return {};
    success=js::RejectPromiseInternal(frame.cx,promise,argument);
  }else{
    // ResolvePromiseInternal accepts a cross-realm Promise and performs the
    // then lookup in the supplied API context through the normal engine path.
    JS::RootedObject target(frame.cx,promise);
    if(!JS_WrapObject(frame.cx,&target))return {};
    success=js::ResolvePromiseInternal(frame.cx,target,argument);
  }
  if(!success||JS_IsExceptionPending(frame.cx)||entry.Terminated())return {};
  return Just(true);
}
MaybeLocal<Promise> ReactToNativePromise(Local<Context> context,JS::HandleValue input,
    Local<Function> onFulfilled,Local<Function> onRejected){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);
  CHECK(input.isObject());JS::RootedObject promise(frame.cx,&input.toObject());
  JS::RootedObject fulfilled(frame.cx,onFulfilled.IsEmpty()?nullptr:&Input(onFulfilled).toObject());
  JS::RootedObject rejected(frame.cx,onRejected.IsEmpty()?nullptr:&Input(onRejected).toObject());
  if(!JS_WrapObject(frame.cx,&promise)||
     (fulfilled&&!JS_WrapObject(frame.cx,&fulfilled))||
     (rejected&&!JS_WrapObject(frame.cx,&rejected)))return {};
  // This API uses the full intrinsic PerformPromiseThen implementation with
  // a fresh native Promise; it ignores mutable public then/constructor/species.
  JS::RootedObject result(frame.cx,JS::CallOriginalPromiseThen(frame.cx,promise,fulfilled,rejected));
  if(!result||JS_IsExceptionPending(frame.cx)||entry.Terminated())return {};
  JS::RootedValue output(frame.cx,JS::ObjectValue(*result));return frame.Own<Promise>(output);
}
void NativePromiseRejectionTracker(JSContext* cx,bool,JS::HandleObject promise,
    JS::PromiseRejectionHandlingState event,void* raw){
  auto* registered=static_cast<v8::State*>(raw);CHECK(registered&&registered->cx==cx);
  registered->AssertForeground();
  auto callback=registered->promiseRejectCallback;if(!callback)return;
  if(cx->isNativeExecutionTerminating())return;
  try {
    auto state=ReadNativeEngineState(cx);CHECK(state&&state.get()==registered);
    CHECK(promise->is<js::PromiseObject>());
    JS::RootedObject global(cx,JS::CurrentGlobalOrNull(cx));CHECK(global);
    JSAutoRealm home(cx,global);PreserveNativeFailure preserve(cx);
    // A tracker is an engine-to-native callback. Do not catch an enclosing
    // native TryCatch or drain microtasks while returning through JS frames.
    NativeCallbackEntry callbackEntry(*state);
    Frame frame(cx,global,state);
    JS::RootedValue promiseValue(cx,JS::ObjectValue(*promise));
    auto nativePromise=frame.Own<Promise>(promiseValue);
    const bool unhandled=event==JS::PromiseRejectionHandlingState::Unhandled;
    JS::RootedValue result(cx,unhandled?JS::GetPromiseResult(promise):JS::UndefinedValue());
    // Handled notifications have an empty value, matching V8's native API.
    // Original Node supplies undefined to its JS callback in this case.
    callback(PromiseRejectMessage(nativePromise,
        unhandled?kPromiseRejectWithNoHandler:kPromiseHandlerAddedAfterReject,
        unhandled?frame.OwnValue(result):Local<Value>()));
  }catch(const std::bad_alloc&){
    bridge::FatalOutOfMemory(&registered->isolate,"Promise rejection callback metadata",false);
  }
}
void NativePromiseLifecycleHook(JSContext* cx,JSContext::EmbedderPromiseHookKind kind,
    JS::HandleObject promise,JS::HandleObject parent,void* raw){
  if(!promise)return;
  auto* registered=static_cast<v8::State*>(raw);CHECK(registered&&registered->cx==cx);
  registered->AssertForeground();
  if(cx->isNativeExecutionTerminating()||JS_IsExceptionPending(cx))return;
  try {
    auto state=ReadNativeEngineState(cx);CHECK(state&&state.get()==registered);
    JS::RootedObject actual(cx,js::CheckedUnwrapDynamic(promise,cx,false));
    if(!actual||!actual->is<js::PromiseObject>())return;
    JS::RootedObject global(cx,JS::CurrentGlobalOrNull(cx));CHECK(global);
    PreserveNativeFailure preserve(cx);NativeCallbackEntry callbackEntry(*state);
    Frame frame(cx,global,state);
    JS::RootedValue promiseValue(cx,JS::ObjectValue(*actual)),parentValue(cx);
    if(parent){
      JS::RootedObject actualParent(cx,js::CheckedUnwrapDynamic(parent,cx,false));
      if(!actualParent)return;
      if(actualParent->is<js::PromiseObject>())parentValue.setObject(*actualParent);
    }
    if(!JS_WrapValue(cx,&promiseValue)||!JS_WrapValue(cx,&parentValue))return;
    PromiseHookType type;uint32_t index;
    switch(kind){
      case JSContext::EmbedderPromiseHookKind::Init:type=PromiseHookType::kInit;index=0;break;
      case JSContext::EmbedderPromiseHookKind::Before:type=PromiseHookType::kBefore;index=1;break;
      case JSContext::EmbedderPromiseHookKind::After:type=PromiseHookType::kAfter;index=2;break;
      case JSContext::EmbedderPromiseHookKind::Resolve:type=PromiseHookType::kResolve;index=3;break;
    }
    JS::RootedObject record(cx,ExistingContextEmbedderStorage(*state,global));
    if(record){
      JS::RootedValue stored(cx,JS::GetReservedSlot(record,2));
      if(stored.isObject()){
        JS::RootedObject hooks(cx,&stored.toObject());JS::RootedValue hook(cx);
        if(!JS_GetElement(cx,hooks,index,&hook))return;
        if(!hook.isUndefined()){
          JS::RootedValueVector arguments(cx);JS::RootedValue result(cx);
          if(!arguments.append(promiseValue)||
             (type==PromiseHookType::kInit&&!arguments.append(parentValue)))return;
          if(!JS::Call(cx,JS::UndefinedHandleValue,hook,arguments,&result)){
            // Pinned V8 reports context-hook exceptions through its message
            // listeners instead of changing Promise resolution/reaction policy.
            // A missing/failing reporter remains a visible pending failure.
            if(!bridge::ReportMicrotaskException(&state->isolate))return;
          }
        }
      }
    }
    // Context hooks run before the isolate callback. A JS hook can replace it;
    // read its current native registration after that JS returns, as V8 does.
    if(auto callback=state->promiseHook){
      callback(type,frame.Own<Promise>(promiseValue),frame.OwnValue(parentValue));
    }
  }catch(const std::bad_alloc&){
    bridge::FatalOutOfMemory(&registered->isolate,"Promise lifecycle callback metadata",false);
  }
}
}
void UpdateNativePromiseHookRegistration(v8::State& state){
  state.AssertForeground();CHECK(state.cx==js::TlsContext.get());
  bool enabled=state.promiseHook||state.contextPromiseHookOwners;
  state.cx->embedderPromiseLifecycleHook=enabled?NativePromiseLifecycleHook:nullptr;
  state.cx->embedderPromiseLifecycleData=enabled?&state:nullptr;
}
void Isolate::SetPromiseHook(PromiseHook callback){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  auto state=owner.lock();CHECK(state);state->promiseHook=callback;
  UpdateNativePromiseHookRegistration(*state);
}
void Context::SetPromiseHooks(Local<Function> init,Local<Function> before,
    Local<Function> after,Local<Function> resolve){
  auto& frame=Current(isolate);Context::Scope home(Local<Context>(this));
  JS::RootedObject record(frame.cx,EnsureContextEmbedderStorage(frame,*this));CHECK(record);
  const Local<Function> inputs[]={init,before,after,resolve};
  bool enabled=!init.IsEmpty()||!before.IsEmpty()||!after.IsEmpty()||!resolve.IsEmpty();
  JS::RootedValue stored(frame.cx);
  if(enabled){
    JS::RootedObject hooks(frame.cx,JS::NewArrayObject(frame.cx,4));CHECK(hooks);
    CHECK(JS_SetPrototype(frame.cx,hooks,nullptr));
    for(uint32_t index=0;index<4;++index){
      JS::RootedValue value(frame.cx,inputs[index].IsEmpty()?JS::UndefinedValue():Input(inputs[index]).get());
      CHECK(JS_WrapValue(frame.cx,&value));
      CHECK(value.isUndefined()||(value.isObject()&&JS::IsCallable(&value.toObject())));
      CHECK(JS_SetElement(frame.cx,hooks,index,value));
    }
    stored.setObject(*hooks);
  }
  auto& data=ContextFields(record);auto state=frame.state;
  if(data.promiseHooksEnabled!=enabled){
    if(enabled){
      CHECK_LT(state->contextPromiseHookOwners,std::numeric_limits<size_t>::max());
      ++state->contextPromiseHookOwners;data.promiseHooksOwner=state;
    }else{
      CHECK(state->contextPromiseHookOwners);--state->contextPromiseHookOwners;
    }
    data.promiseHooksEnabled=enabled;
  }
  JS::SetReservedSlot(record,2,stored);UpdateNativePromiseHookRegistration(*state);
}
bool Value::IsPromise()const{
  auto& frame=*Frame::current;auto* object=UnwrapObject(frame.cx,cell().value);
  return object&&object->is<js::PromiseObject>();
}
Data* RebindPromiseHandle(Data* input,bool resolver){
  if(!input)return nullptr;
  CHECK(Frame::current&&input->IsValue());auto& frame=*Frame::current;CheckNativePrimitiveAccess(frame);
  CHECK(input->cell().context==frame.cx);CHECK(NativePromise(frame,input->cell().value));
  const auto factory=resolver?&CloneWrapper<Promise::Resolver>:&CloneWrapper<Promise>;
  if(input->RootFactoryForStorage()==factory)return input;
  try{
    if(resolver)return frame.OwnTypedView<Promise::Resolver>(*input).get();
    return frame.OwnTypedView<Promise>(*input).get();
  }catch(const std::bad_alloc&){
    bridge::FatalOutOfMemory(&frame.state->isolate,"Native promise handle allocation",false);
  }
}
MaybeLocal<Promise::Resolver> Promise::Resolver::New(Local<Context> context){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);
  JS::RootedObject executor(frame.cx);
  JS::RootedObject promise(frame.cx,JS::NewPromiseObject(frame.cx,executor));
  if(!promise||JS_IsExceptionPending(frame.cx)||entry.Terminated())return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*promise));return frame.Own<Resolver>(value);
}
Local<Promise> Promise::Resolver::GetPromise(){
  auto& frame=*Frame::current;CHECK(NativePromise(frame,cell().value));
  return frame.Own<Promise>(cell().value);
}
Maybe<bool> Promise::Resolver::Resolve(Local<Context> context,Local<Value> value){
  return SettleNativePromise(context,cell().value,value,false);
}
Maybe<bool> Promise::Resolver::Reject(Local<Context> context,Local<Value> value){
  return SettleNativePromise(context,cell().value,value,true);
}
MaybeLocal<Promise> Promise::Then(Local<Context> context,Local<Function> fulfilled){
  return ReactToNativePromise(context,cell().value,fulfilled,{});
}
MaybeLocal<Promise> Promise::Then(Local<Context> context,Local<Function> fulfilled,Local<Function> rejected){
  return ReactToNativePromise(context,cell().value,fulfilled,rejected);
}
MaybeLocal<Promise> Promise::Catch(Local<Context> context,Local<Function> rejected){
  return ReactToNativePromise(context,cell().value,{},rejected);
}
bool Promise::HasHandler()const{
  auto& frame=*Frame::current;JS::Rooted<js::PromiseObject*> promise(frame.cx,NativePromise(frame,cell().value));
  return !promise->isUnhandled();
}
Local<Value> Promise::Result(){
  auto& frame=*Frame::current;JS::Rooted<js::PromiseObject*> promise(frame.cx,NativePromise(frame,cell().value));
  CHECK(promise->state()!=JS::PromiseState::Pending);
  JS::RootedValue result(frame.cx,JS::GetPromiseResult(promise));
  if(JS::CurrentGlobalOrNull(frame.cx)&&!JS_WrapValue(frame.cx,&result))return {};
  return frame.OwnValue(result);
}
Promise::PromiseState Promise::State(){
  auto& frame=*Frame::current;JS::Rooted<js::PromiseObject*> promise(frame.cx,NativePromise(frame,cell().value));
  switch(promise->state()){
    case JS::PromiseState::Pending:return kPending;
    case JS::PromiseState::Fulfilled:return kFulfilled;
    case JS::PromiseState::Rejected:return kRejected;
  }
  Crash("Invalid engine Promise state");
}
void Promise::MarkAsHandled(){
  auto& frame=*Frame::current;JS::Rooted<js::PromiseObject*> promise(frame.cx,NativePromise(frame,cell().value));
  // Pinned V8 sets only its handled bit. JS::SetAnyPromiseIsHandled would also
  // notify the tracker. Node's node_util.cc deliberately sends that notification
  // itself for an already rejected Promise, so doing both would double-report.
  promise->setHandled();
}
void Promise::MarkAsSilent(){
  auto& frame=*Frame::current;frame.state->AssertForeground();
  CHECK(NativePromise(frame,cell().value));
  // Both supported profiles disable Inspector and never expose a Debugger.
  // Silence only affects debugger delivery, so it has no observable action in
  // this profile. The Inspector follow-up must implement it before activation.
  // Never change the handled bit or Node's unhandled-rejection tracker here.
}
PromiseRejectMessage::PromiseRejectMessage(Local<Promise> promise,PromiseRejectEvent event,Local<Value> value)
    :promise_(promise),event_(event),value_(value){}
Local<Promise> PromiseRejectMessage::GetPromise()const{return promise_;}
PromiseRejectEvent PromiseRejectMessage::GetEvent()const{return event_;}
Local<Value> PromiseRejectMessage::GetValue()const{return value_;}
void Isolate::SetPromiseRejectCallback(PromiseRejectCallback callback){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  auto state=owner.lock();CHECK(state&&state->cx==js::TlsContext.get());
  state->promiseRejectCallback=callback;
  JS::SetPromiseRejectionTrackerCallback(state->cx,callback?NativePromiseRejectionTracker:nullptr,
      callback?state.get():nullptr);
}
}
#endif
