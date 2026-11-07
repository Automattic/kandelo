// Actual compiled Node/postject image-byte detector, no synthetic SEA flag.
#include "../../sea-image-profile.h"
#include <node.h>
#include <v8.h>
static void IsSea(const v8::FunctionCallbackInfo<v8::Value>& args) {
  args.GetReturnValue().Set(kandelo::sea::IsSingleExecutable());
}
static void Initialize(v8::Local<v8::Object> exports, v8::Local<v8::Value> module,
                       v8::Local<v8::Context> context, void* priv) {
  (void)module; (void)priv;
  auto* isolate = v8::Isolate::GetCurrent();
  auto function = v8::Function::New(context, IsSea, {}, 0,
      v8::ConstructorBehavior::kThrow).ToLocalChecked();
  auto name = v8::String::NewFromUtf8Literal(isolate, "isSea");
  function->SetName(name);
  exports->Set(context, name, function).Check();
}
NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, Initialize)
