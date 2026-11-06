// Exact-native public C++ callback API control, not the Kandelo engine owner.
#include <node.h>
#include <v8.h>
namespace {
void Call(const v8::FunctionCallbackInfo<v8::Value>& args) {
  auto* isolate=args.GetIsolate();
  v8::HandleScope handles(isolate);
  if(args.Length()!=1||!args[0]->IsFunction()) {
    isolate->ThrowException(v8::Exception::TypeError(v8::String::NewFromUtf8Literal(isolate,"Callback required")));
    return;
  }
  auto object=v8::Object::New(isolate);
  node::AsyncResource resource(isolate,object,"RecoveryNestedNative");
  v8::Local<v8::Value> value;
  if(resource.MakeCallback(args[0].As<v8::Function>(),0,nullptr).ToLocal(&value))args.GetReturnValue().Set(value);
}
void Init(v8::Local<v8::Object> exports, v8::Local<v8::Value> module,
          v8::Local<v8::Context> context, void* priv) {
  (void)module;(void)context;(void)priv;
  NODE_SET_METHOD(exports,"call",Call);
}
NODE_MODULE_CONTEXT_AWARE(kandelo_callback_nested, Init)
} //namespace
