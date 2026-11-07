// Actual process owner. Node/V8 wrappers are explicit native control dependencies.
#include "../../tracing-owner.h"
#include <node.h>
#include <v8.h>
#include <memory>
using namespace v8;
namespace {
std::string text(Isolate* isolate, Local<Value> value) {
  String::Utf8Value bytes(isolate, value); if (!*bytes) throw 0;
  return std::string(*bytes);
}
void run(const FunctionCallbackInfo<Value>& a) {
  Isolate* isolate = a.GetIsolate(); auto context = isolate->GetCurrentContext();
  try {
    const std::string op = text(isolate, a[0]);
    Local<Value> result = Undefined(isolate); int error = 0;
    if (op == "trace-has-agent") { (void)kandelo::tracing::Process(); result = True(isolate); }
    else if (op == "trace-create") {
      auto array = a[1].As<Array>(); kandelo::tracing::Owner<>::Categories names;
      for (uint32_t index = 0; index < array->Length(); ++index) {
        Local<Value> item; if (!array->Get(context, index).ToLocal(&item)) return;
        names.emplace(text(isolate, item));
      }
      auto shape = ObjectTemplate::New(isolate); shape->SetInternalFieldCount(1);
      auto object = shape->NewInstance(context).ToLocalChecked();
      auto owner = std::make_unique<kandelo::tracing::CategorySet>(std::move(names));
      object->SetAlignedPointerInInternalField(0, owner.release(), kEmbedderDataTypeTagDefault);
      // Public pinned enabledTracingObjects owns enabled objects. This native
      // reference keeps handles until environment cleanup, not fabricated GC.
      auto* retained = new Global<Object>(isolate, object);
      node::AddEnvironmentCleanupHook(isolate, [](void* input) {
        auto* handle = static_cast<Global<Object>*>(input);
        auto* isolate = Isolate::GetCurrent(); HandleScope scope(isolate);
        auto object = handle->Get(isolate);
        delete static_cast<kandelo::tracing::CategorySet*>(object->GetAlignedPointerFromInternalField(0, kEmbedderDataTypeTagDefault));
        handle->Reset(); delete handle;
      }, retained);
      result = object;
    } else if (op == "trace-enable" || op == "trace-disable") {
      auto* owner = static_cast<kandelo::tracing::CategorySet*>(a[1].As<Object>()->GetAlignedPointerFromInternalField(0, kEmbedderDataTypeTagDefault));
      if (op == "trace-enable") error = -owner->Enable(); else owner->Disable();
    } else if (op == "trace-categories") {
      const auto value = kandelo::tracing::Process().Enabled();
      if (!value.empty()) result = String::NewFromUtf8(isolate, value.data(), NewStringType::kNormal, int(value.size())).ToLocalChecked();
    } else if (op == "trace-enabled") result = Boolean::New(isolate, kandelo::tracing::Process().Enabled(text(isolate, a[1])));
    else if (op == "trace-event") error = -kandelo::tracing::Process().Append(text(isolate, a[1]), text(isolate, a[2]));
    else if (op == "trace-finish") error = -kandelo::tracing::Process().Finish();
    else { isolate->ThrowException(Exception::Error(String::NewFromUtf8Literal(isolate,"Unknown native control operation"))); return; }
    auto packet = Object::New(isolate);
    if (!packet->Set(context, String::NewFromUtf8Literal(isolate,"value"), result).FromMaybe(false) ||
        !packet->Set(context, String::NewFromUtf8Literal(isolate,"error"), Integer::New(isolate,error)).FromMaybe(false)) return;
    a.GetReturnValue().Set(packet);
  } catch (int) { return; }
  catch (const std::bad_alloc&) { isolate->ThrowException(Exception::Error(String::NewFromUtf8Literal(isolate,"native allocation failed"))); }
}
void init(Local<Object> exports, Local<Value>, Local<Context>, void*) {
  NODE_SET_METHOD(exports,"operatingSystem",run);
}
NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME,init)
}
