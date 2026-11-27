// Private guest-library adapter. Node's original TypeScript loader and the
// complete Amaro wrapper/transformer remain the consumers and policy owners.
#include "env-inl.h"
#include "node_binding.h"
#include "util-inl.h"
#include "kandelo_amaro_values.h"
#include <dlfcn.h>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

namespace node::amaro {
using namespace v8;

struct ProcessLibrary {
  std::mutex lock;
  void* handle = nullptr;
  decltype(&kandelo_amaro_transform_values) transform = nullptr;
  decltype(&kandelo_amaro_result_bytes) bytes = nullptr;
  decltype(&kandelo_amaro_result_release) release = nullptr;
};
// Code and Rust TLS can outlive any individual Environment or Worker. Keep the
// ordinary dlopen reference through process retirement, including TLS teardown;
// never unload executable callbacks from an Environment cleanup hook. All JS
// roots/results below are strictly call-scoped and are retired before return.
static ProcessLibrary library;

static void Throw(Isolate* isolate, const char* message) {
  Local<String> text;
  if (String::NewFromUtf8(isolate, message).ToLocal(&text))
    isolate->ThrowException(Exception::Error(text));
}

static bool Load(Isolate* isolate) {
  std::lock_guard<std::mutex> guard(library.lock);
  if (library.transform != nullptr) return true;
  void* handle = dlopen("/usr/lib/libnode-amaro.so", RTLD_NOW | RTLD_LOCAL);
  if (handle == nullptr) { Throw(isolate, dlerror()); return false; }
  auto version = reinterpret_cast<decltype(&kandelo_amaro_abi_version)>(dlsym(handle, "kandelo_amaro_abi_version"));
  auto transform = reinterpret_cast<decltype(library.transform)>(dlsym(handle, "kandelo_amaro_transform_values"));
  auto bytes = reinterpret_cast<decltype(library.bytes)>(dlsym(handle, "kandelo_amaro_result_bytes"));
  auto release = reinterpret_cast<decltype(library.release)>(dlsym(handle, "kandelo_amaro_result_release"));
  if (version == nullptr || transform == nullptr || bytes == nullptr || release == nullptr || version() != 1) {
    // A loaded Rust module may already own TLS destructors. Retain its code on
    // this failure too; no callable provider is published from a partial load.
    Throw(isolate, "Incompatible native Amaro library");
    return false;
  }
  library.handle = handle;
  library.bytes = bytes;
  library.release = release;
  library.transform = transform;
  return true;
}

struct Frame {
  Isolate* isolate;
  Local<Context> context;
  Local<Array> helpers;
  std::vector<Local<Value>> roots;
  uint32_t Keep(Local<Value> value) {
    CHECK(!value.IsEmpty());
    CHECK_LT(roots.size(), UINT32_MAX);
    roots.push_back(value);
    return static_cast<uint32_t>(roots.size() - 1);
  }
  Local<Value> Get(uint32_t index) {
    CHECK_LT(index, roots.size());
    return roots[index];
  }
};

static int Invoke(void* owner, uint32_t operation, uint32_t a, uint32_t b,
                  uint32_t c, uint8_t* buffer, size_t capacity, double number,
                  kandelo_amaro_value_reply* reply) {
  auto& frame = *static_cast<Frame*>(owner);
  Isolate* isolate = frame.isolate;
  Local<Value> result;
  if (operation == KA_STRING_LENGTH || operation == KA_STRING_COPY) {
    Utf8Value string(isolate, frame.Get(a));
    if (*string == nullptr) return 1;
    reply->length = static_cast<size_t>(string.length());
    if (operation == KA_STRING_COPY) {
      CHECK_EQ(capacity, reply->length);
      if (capacity) std::memcpy(buffer, *string, capacity);
    }
    return 0;
  }
  if (operation == KA_NEW_NUMBER) {
    reply->value = frame.Keep(Number::New(isolate, number));
    return 0;
  }
  if (operation == KA_NEW_STRING || operation == KA_NEW_BIGINT || operation == KA_NEW_ERROR) {
    CHECK_LE(capacity, static_cast<size_t>(String::kMaxLength));
    Local<String> string;
    if (!String::NewFromUtf8(isolate, reinterpret_cast<const char*>(buffer),
                            NewStringType::kNormal, static_cast<int>(capacity)).ToLocal(&string)) return 1;
    if (operation == KA_NEW_STRING) { reply->value = frame.Keep(string); return 0; }
    a = frame.Keep(string);
  }
  if (operation == KA_NEW_BYTES) {
    Local<ArrayBuffer> storage = ArrayBuffer::New(isolate, capacity);
    if (capacity) std::memcpy(storage->Data(), buffer, capacity);
    a = frame.Keep(Uint8Array::New(storage, 0, capacity));
  }
  Local<Value> helper;
  if (!frame.helpers->Get(frame.context, operation).ToLocal(&helper)) return 1;
  CHECK(helper->IsFunction());
  Local<Value> second = (operation == KA_TYPE || operation == KA_ARRAY_GET || operation == KA_ARRAY_SET || operation == KA_CODE_POINT_AT)
      ? Local<Value>(Integer::NewFromUnsigned(isolate, b)) : frame.Get(b);
  if (operation == KA_COPY_BYTES) second = Number::New(isolate, static_cast<double>(capacity));
  Local<Value> argv[] = {frame.Get(a), second, frame.Get(c)};
  if (!helper.As<Function>()->Call(frame.context, Undefined(isolate), 3, argv).ToLocal(&result)) return 1;
  switch (operation) {
    case KA_TYPE:
    case KA_ARRAY_LENGTH:
    case KA_STRING_UTF16_LENGTH:
      if (!result->Uint32Value(frame.context).To(&reply->flag)) return 1;
      break;
    case KA_NUMBER:
      if (!result->NumberValue(frame.context).To(&reply->number)) return 1;
      reply->flag = result->BooleanValue(isolate);
      break;
    case KA_LOOSE_EQ:
    case KA_IN:
    case KA_IS_SAFE_INTEGER:
    case KA_FALSY:
      reply->flag = result->BooleanValue(isolate);
      break;
    case KA_TRY_ITER:
      reply->flag = !result->IsUndefined();
      reply->value = frame.Keep(result);
      break;
    case KA_ITER_NEXT: {
      CHECK(result->IsArray());
      Local<Array> pair = result.As<Array>();
      Local<Value> done, value;
      if (!pair->Get(frame.context, 0).ToLocal(&done) || !pair->Get(frame.context, 1).ToLocal(&value)) return 1;
      reply->flag = done->BooleanValue(isolate);
      reply->value = frame.Keep(value);
      break;
    }
    case KA_COPY_BYTES_LENGTH: {
      uint32_t length;
      if (!result->Uint32Value(frame.context).To(&length)) return 1;
      reply->length = length;
      break;
    }
    case KA_COPY_BYTES: {
      CHECK(result->IsUint8Array());
      auto view = result.As<Uint8Array>();
      reply->length = view->ByteLength();
      CHECK_EQ(reply->length, capacity);
      if (capacity) std::memcpy(buffer,
          static_cast<uint8_t*>(view->Buffer()->Data()) + view->ByteOffset(), capacity);
      break;
    }
    default: reply->value = frame.Keep(result); break;
  }
  return 0;
}

static void TransformSync(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate();
  CHECK_EQ(args.Length(), 3);
  CHECK(args[2]->IsArray());
  if (!Load(isolate)) return;
  HandleScope handles(isolate);
  TryCatch catcher(isolate);
  Frame frame{isolate, isolate->GetCurrentContext(), args[2].As<Array>(),
      {Undefined(isolate), Null(isolate), False(isolate), True(isolate)}};
  uint32_t input = frame.Keep(args[0]);
  uint32_t options = frame.Keep(args[1]);
  kandelo_amaro_value_operations operations{1, sizeof(operations), &frame, Invoke};
  uint32_t output = 0;
  kandelo_amaro_result* failure = nullptr;
  int status = library.transform(&operations, input, options, &output, &failure);
  if (failure != nullptr) {
    size_t length = 0;
    const auto* data = library.bytes(failure, &length);
    std::string message(reinterpret_cast<const char*>(data), length);
    int released = library.release(failure);
    CHECK_EQ(released, 0);
    if (!catcher.HasCaught()) Throw(isolate, message.c_str());
  }
  if (catcher.HasCaught()) { catcher.ReThrow(); return; }
  if (status == KA_VALUE_OK) { args.GetReturnValue().Set(frame.Get(output)); return; }
  if (status == KA_VALUE_THROW) { isolate->ThrowException(frame.Get(output)); catcher.ReThrow(); return; }
  if (status == KA_VALUE_ABRUPT && isolate->IsExecutionTerminating()) return;
  Throw(isolate, "Native Amaro value operation failed");
  catcher.ReThrow();
}

static void Initialize(Local<Object> target, Local<Value>, Local<Context> context, void*) {
  Environment* env = Environment::GetCurrent(context);
  CHECK_NOT_NULL(env);
  Isolate* isolate = env->isolate();
  SetMethod(context, target, "transformSync", TransformSync);
  target->Set(context, FIXED_ONE_BYTE_STRING(isolate, "hasNative"),
              True(isolate)).Check();
}
}  // namespace node::amaro
NODE_BINDING_CONTEXT_AWARE_INTERNAL(amaro, node::amaro::Initialize)
