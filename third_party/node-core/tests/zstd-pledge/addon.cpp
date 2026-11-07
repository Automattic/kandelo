// Actual portable admission policy over genuine native value/error semantics.
// Codec execution remains an explicit native Node dependency in platform.cjs.
#include "../../codec-pledge.h"
#include <node.h>
#include <v8.h>
using namespace v8;
static Local<String> Text(Isolate* isolate, const char* text) { return String::NewFromUtf8(isolate, text).ToLocalChecked(); }
static void Validate(const FunctionCallbackInfo<Value>& args) {
  auto* isolate = args.GetIsolate();
  if (args[0]->IsUndefined()) return;
  const auto input = args[0]->IsNumber() ? std::optional<double>(args[0].As<Number>()->Value()) : std::nullopt;
  uint64_t value;
  if (const auto failure = kandelo::codecs::CheckPledgedSize(input, &value)) {
    Local<Value> error = failure->kind == kandelo::codecs::PledgedSizeError::Kind::TypeError ?
        Exception::TypeError(Text(isolate, failure->message)) : Exception::RangeError(Text(isolate, failure->message));
    // Same checked Set contract as the pinned native error constructor. A
    // nonthrowing false remains a value; an actual setter exception terminates.
    error.As<Object>()->Set(isolate->GetCurrentContext(), Text(isolate, "code"), Text(isolate, failure->code)).Check();
    isolate->ThrowException(error); return;
  }
  args.GetReturnValue().Set(Number::New(isolate, double(value)));
}
static void Initialize(Local<Object> exports, Local<Value> module, Local<Context> context, void* priv) {
  (void)module; (void)context; (void)priv;
  NODE_SET_METHOD(exports, "validate", Validate);
}
NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, Initialize)
