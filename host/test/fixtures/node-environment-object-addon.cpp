// Explicit native V8 interceptor boundary for candidate environment policies.
// This exercises live callbacks without a JS Proxy; it is not the guest owner.
#include <node.h>
#include <memory>
#include <string>
namespace {
using namespace v8;
class Environment final {
  Global<Object> callbacks_;
  Global<Object> weak_;
  explicit Environment(Isolate* isolate, Local<Object> callbacks) : callbacks_(isolate, callbacks) {}
  bool Call(Isolate* isolate, const char* name, int argc, Local<Value>* argv, Local<Value>* result) {
    auto context = isolate->GetCurrentContext(); Local<Value> function;
    auto key = String::NewFromUtf8(isolate, name).ToLocalChecked();
    if (!callbacks_.Get(isolate)->Get(context, key).ToLocal(&function)) return false;
    if (!function->IsFunction()) { isolate->ThrowException(Exception::TypeError(key)); return false; }
    return function.As<Function>()->Call(context, Undefined(isolate), argc, argv).ToLocal(result);
  }
  template <typename T> static Environment* Owner(const PropertyCallbackInfo<T>& info) {
    return static_cast<Environment*>(info.Data().template As<External>()->Value());
  }
  static Intercepted Get(Local<Name> key, const PropertyCallbackInfo<Value>& info) {
    Local<Value> args[] = { key }, result;
    if (!Owner(info)->Call(info.GetIsolate(), "get", 1, args, &result)) return Intercepted::kYes;
    if (result->IsUndefined() && !key->IsSymbol()) return Intercepted::kNo;
    info.GetReturnValue().Set(result); return Intercepted::kYes;
  }
  static Intercepted Set(Local<Name> key, Local<Value> value, const PropertyCallbackInfo<void>& info) {
    Local<Value> args[] = { key, value }, result;
    Owner(info)->Call(info.GetIsolate(), "set", 2, args, &result);
    return Intercepted::kYes;
  }
  static Intercepted Query(Local<Name> key, const PropertyCallbackInfo<Integer>& info) {
    Local<Value> args[] = { key }, result;
    if (!Owner(info)->Call(info.GetIsolate(), "descriptor", 1, args, &result)) return Intercepted::kYes;
    if (result->IsUndefined()) return Intercepted::kNo;
    info.GetReturnValue().Set(None); return Intercepted::kYes;
  }
  static Intercepted Delete(Local<Name> key, const PropertyCallbackInfo<Boolean>& info) {
    Local<Value> args[] = { key }, result;
    if (Owner(info)->Call(info.GetIsolate(), "remove", 1, args, &result)) info.GetReturnValue().Set(true);
    return Intercepted::kYes;
  }
  static void Enumerate(const PropertyCallbackInfo<Array>& info) {
    Local<Value> result;
    if (Owner(info)->Call(info.GetIsolate(), "keys", 0, nullptr, &result)) info.GetReturnValue().Set(result.As<Array>());
  }
  static Intercepted Define(Local<Name> key, const PropertyDescriptor& desc, const PropertyCallbackInfo<void>& info) {
    auto isolate = info.GetIsolate(); auto context = isolate->GetCurrentContext(); auto object = Object::New(isolate);
    auto put = [&](const char* name, Local<Value> value) {
      return object->CreateDataProperty(context, String::NewFromUtf8(isolate, name).ToLocalChecked(), value).FromMaybe(false);
    };
    if (desc.has_value() && !put("value", desc.value())) return Intercepted::kYes;
    if (desc.has_writable() && !put("writable", Boolean::New(isolate, desc.writable()))) return Intercepted::kYes;
    if (desc.has_enumerable() && !put("enumerable", Boolean::New(isolate, desc.enumerable()))) return Intercepted::kYes;
    if (desc.has_configurable() && !put("configurable", Boolean::New(isolate, desc.configurable()))) return Intercepted::kYes;
    if (desc.has_get() && !put("get", desc.get())) return Intercepted::kYes;
    if (desc.has_set() && !put("set", desc.set())) return Intercepted::kYes;
    Local<Value> args[] = { key, object }, result;
    Owner(info)->Call(isolate, "define", 2, args, &result); return Intercepted::kYes;
  }
  static Local<Name> Index(uint32_t index, Isolate* isolate) {
    const auto text = std::to_string(index); return String::NewFromUtf8(isolate, text.c_str()).ToLocalChecked();
  }
  static Intercepted GetIndex(uint32_t i, const PropertyCallbackInfo<Value>& info) { return Get(Index(i, info.GetIsolate()), info); }
  static Intercepted SetIndex(uint32_t i, Local<Value> value, const PropertyCallbackInfo<void>& info) { return Set(Index(i, info.GetIsolate()), value, info); }
  static Intercepted QueryIndex(uint32_t i, const PropertyCallbackInfo<Integer>& info) { return Query(Index(i, info.GetIsolate()), info); }
  static Intercepted DeleteIndex(uint32_t i, const PropertyCallbackInfo<Boolean>& info) { return Delete(Index(i, info.GetIsolate()), info); }
  static Intercepted DefineIndex(uint32_t i, const PropertyDescriptor& desc, const PropertyCallbackInfo<void>& info) { return Define(Index(i, info.GetIsolate()), desc, info); }
 public:
  static void Create(const FunctionCallbackInfo<Value>& args) {
    auto isolate = args.GetIsolate(); auto context = isolate->GetCurrentContext();
    if (!args[0]->IsObject() || !args[1]->IsObject()) {
      isolate->ThrowException(Exception::TypeError(String::NewFromUtf8Literal(isolate, "Environment requires callbacks/prototype"))); return;
    }
    auto owner = std::unique_ptr<Environment>(new Environment(isolate, args[0].As<Object>()));
    auto data = External::New(isolate, owner.get());
    auto objectTemplate = ObjectTemplate::New(isolate);
    // Like Node's environment, this object has no BaseObject internal fields.
    // A Node ObjectWrap would correctly be rejected as an unsupported host
    // object by the native serializer, instead of exercising ordinary cloning.
    objectTemplate->SetHandler(NamedPropertyHandlerConfiguration(Get, Set, Query, Delete, Enumerate, Define, nullptr, data));
    objectTemplate->SetHandler(IndexedPropertyHandlerConfiguration(GetIndex, SetIndex, QueryIndex, DeleteIndex, nullptr, DefineIndex, nullptr, data));
    Local<Object> object;
    if (!objectTemplate->NewInstance(context).ToLocal(&object) || !object->SetPrototypeV2(context, args[1]).FromMaybe(false)) return;
    owner->weak_.Reset(isolate, object);
    owner->weak_.SetWeak(owner.get(), [](const WeakCallbackInfo<Environment>& info) {
      delete info.GetParameter();
    }, WeakCallbackType::kParameter);
    owner.release();
    args.GetReturnValue().Set(object);
  }
};
NODE_MODULE_INIT() {
  NODE_SET_METHOD(exports, "createEnvironmentObject", Environment::Create);
}
}  // namespace
