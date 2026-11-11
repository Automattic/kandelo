#include "shell/node-upstream/constants.h"

#include "jsapi.h"
#include "shell/node-upstream/constants-builder.h"
#include "shell/node-upstream/constants-upstream/compression-constants.generated.h"
namespace v8 {
Local<Object> Object::New(Isolate* isolate, NullValue, void* keys, void* values, size_t length) {
    MOZ_RELEASE_ASSERT(!keys && !values && !length);
    JSContext* cx = isolate->GetCurrentContext()->cx;
    JS::RootedObject prototype(cx), object(cx, JS_NewObjectWithGivenProto(cx, nullptr, prototype));
    MOZ_RELEASE_ASSERT(object, "Original Node constant object allocation invariant");
    return isolate->Own(object);
  }
Result Object::SetPrototypeV2(Local<Context> context, NullValue) {
    JS::RootedObject object(context->cx, object_), prototype(context->cx);
    return Result(JS_SetPrototype(context->cx, object, prototype));
  }
Result Object::Set(Local<Context> context, const char* name, Local<Object> value) {
    JS::RootedObject object(context->cx, object_);
    JS::RootedValue entry(context->cx, JS::ObjectValue(*value->Get()));
    return Result(JS_SetProperty(context->cx, object, name, entry));
  }
void Object::DefineNumber(const char* name, double number) {
    JSContext* cx = Isolate::GetCurrent()->GetCurrentContext()->cx;
    JS::RootedObject object(cx, object_); JS::RootedValue value(cx, JS::DoubleValue(number));
    Result(JS_DefineProperty(cx, object, name, value, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT)).Check();
  }
void Object::DefineString(const char* name, const char* text) {
    JSContext* cx = Isolate::GetCurrent()->GetCurrentContext()->cx;
    JS::RootedObject object(cx, object_); JS::RootedString value(cx, JS_NewStringCopyZ(cx, text));
    MOZ_RELEASE_ASSERT(value, "Original Node constant string allocation invariant");
    Result(JS_DefineProperty(cx, object, name, value, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT)).Check();
  }
}
namespace node {
void DefineZlibConstants(v8::Local<v8::Object> target) {
  for (const auto& entry : kandelo::node::compressionconstants::kEntries)
    target->DefineNumber(entry.name, entry.value);
}
}
namespace kandelo::node {
JSObject* CreateConstantsBinding(JSContext* cx) {
  v8::Isolate builder(cx);
  JS::RootedObject binding(cx, JS_NewPlainObject(cx));
  if (!binding) return nullptr;
  MOZ_RELEASE_ASSERT(std::strcmp(constantbuilder::moduleName, "constants") == 0);
  constantbuilder::initializer(builder.Own(binding), {}, builder.GetCurrentContext(), nullptr);
  return binding;
}
}
