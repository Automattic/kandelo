// Standalone native Node API control. No Kandelo code or dependency.
#include <node.h>
#include <v8.h>
#include <uv.h>
#include <memory>
// Exact pinned src/node_internals.h declaration, no Environment layout access.
namespace node {
v8::MaybeLocal<v8::Value> InternalMakeCallback(
    v8::Isolate* isolate,
    v8::Local<v8::Object> recv,
    const v8::Local<v8::Function> callback,
    int argc,
    v8::Local<v8::Value> argv[],
    async_context asyncContext,
    v8::Local<v8::Value> context_frame);
}
struct Call {
  v8::Isolate* isolate;
  v8::Global<v8::Context> context;
  v8::Global<v8::Object> owner;
  v8::Global<v8::Function> callback;
  v8::Global<v8::Value> frame;
  std::unique_ptr<node::AsyncResource> async;
  uv_work_t work{};
  bool explicitFrame;
  Call(v8::Isolate* isolate, bool explicitFrame):isolate(isolate),explicitFrame(explicitFrame){work.data=this;}
};
static void Work(uv_work_t*){}
static void Complete(uv_work_t* request,int){
  auto* pointer=static_cast<Call*>(request->data);auto* isolate=pointer->isolate;
  v8::HandleScope handles(isolate);std::unique_ptr<Call> call(pointer);
  v8::Context::Scope context(call->context.Get(isolate));
  v8::MaybeLocal<v8::Value> result;
  if(call->explicitFrame)result=node::InternalMakeCallback(isolate,call->owner.Get(isolate),call->callback.Get(isolate),0,nullptr,
    {call->async->get_async_id(),call->async->get_trigger_async_id()},call->frame.Get(isolate));
  else result=call->async->MakeCallback(call->callback.Get(isolate),0,nullptr);
  (void)result;
}
static void Schedule(const v8::FunctionCallbackInfo<v8::Value>& args){
  auto* isolate=args.GetIsolate();auto call=std::make_unique<Call>(isolate,args[0]->IsTrue());
  auto context=isolate->GetCurrentContext();auto owner=v8::Object::New(isolate);
  call->context.Reset(isolate,context);call->owner.Reset(isolate,owner);call->callback.Reset(isolate,args[1].As<v8::Function>());
  call->frame.Reset(isolate,isolate->GetContinuationPreservedEmbedderDataV2().As<v8::Value>());
  call->async=std::make_unique<node::AsyncResource>(isolate,owner,"NATIVE_FRAME_CONTROL");
  const int status=uv_queue_work(node::GetCurrentEventLoop(isolate),&call->work,Work,Complete);
  if(status){isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8Literal(isolate,"queue failed")));return;}
  args.GetReturnValue().Set(owner);call.release();
}
static void Initialize(v8::Local<v8::Object> exports,v8::Local<v8::Value> module,v8::Local<v8::Context> context,void* priv){
  (void)module;(void)context;(void)priv;NODE_SET_METHOD(exports,"schedule",Schedule);
}
NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME,Initialize)
