// Actual portable one-shot owner. V8 backing leases, Node async resources and
// libuv CPU work are explicit native control dependencies, never production.
#include "../../signature-job-operations.h"
#include <node.h>
#include <v8.h>
#include <uv.h>
#include <cstring>
using namespace v8;
using namespace kandelo::crypto;
struct Pending {};
static Local<String> Text(Isolate* isolate, const char* value) { return String::NewFromUtf8(isolate, value).ToLocalChecked(); }
static std::string StringValue(Isolate* isolate, Local<Value> value) { String::Utf8Value text(isolate, value); if (!*text) throw Pending{}; return std::string(*text, text.length()); }
static bool SetField(Isolate* isolate, Local<Object> object, const char* name, Local<Value> value) {
  return !object->Set(isolate->GetCurrentContext(), Text(isolate, name), value).IsNothing();
}
static Local<Value> MakeError(Isolate* isolate, const Error& error) {
  const auto kind = error.checkedNodeCode ? NativeNodeKind(error.code).value_or(ErrorKind::Error) : ErrorKind::Error;
  Local<Value> value; const auto message = Text(isolate, error.message.c_str());
  if (kind == ErrorKind::TypeError) value = Exception::TypeError(message);
  else if (kind == ErrorKind::RangeError) value = Exception::RangeError(message);
  else value = Exception::Error(message);
  const auto object = value.As<Object>();
  const bool accepted = ApplyErrorProperties(error,
      [&](const std::vector<std::string>& values) {
        auto array = Array::New(isolate, int(values.size()));
        for (uint32_t i = 0; i < values.size(); i++)
          if (array->CreateDataProperty(isolate->GetCurrentContext(), i, Text(isolate, values[i].c_str())).IsNothing()) return false;
        return SetField(isolate, object, "opensslErrorStack", array);
      }, [&](const std::string& name, const std::string& text) { return SetField(isolate, object, name.c_str(), Text(isolate, text.c_str())); });
  if (!accepted) { if (error.checkedNodeCode) std::abort(); throw Pending{}; }
  return value;
}
struct Span {
  std::shared_ptr<BackingStore> store;
  size_t offset = 0, length = 0;
  const unsigned char* Data() const { return static_cast<unsigned char*>(store->Data()) + offset; }
};
static Span Acquire(Local<Value> value) {
  Span result;
  if (value->IsArrayBufferView()) {
    auto view = value.As<ArrayBufferView>(); auto buffer = view->Buffer();
    result.store = buffer->IsSharedArrayBuffer() ? buffer.As<SharedArrayBuffer>()->GetBackingStore() : buffer->GetBackingStore();
    result.offset = view->ByteOffset(); result.length = view->ByteLength();
  } else if (value->IsSharedArrayBuffer()) {
    auto buffer = value.As<SharedArrayBuffer>(); result.store = buffer->GetBackingStore(); result.length = buffer->ByteLength();
  } else if (value->IsArrayBuffer()) {
    auto buffer = value.As<ArrayBuffer>(); result.store = buffer->GetBackingStore(); result.length = buffer->ByteLength();
  } else throw std::runtime_error("Expected actual BufferSource");
  return result;
}
static Bytes Copy(const Span& span) { Bytes bytes; bytes.value.resize(span.length); for (size_t i = 0; i < span.length; i++) bytes.value[i] = __atomic_load_n(span.Data() + i, __ATOMIC_RELAXED); return bytes; }
static void ReadInput(Local<Value> value, size_t maximum, const char* message, bool copy, Bytes* bytes, Span* span) {
  auto source = Acquire(value); if (source.length > maximum) SignatureState::Code("ERR_OUT_OF_RANGE", message);
  if (copy) { auto result = Copy(source); bytes->value.swap(result.value); } else *span = std::move(source);
}
struct Job {
  Isolate* isolate;
  std::unique_ptr<SignatureJobOperation> operation;
  Span data, signature, context;
  Global<Object> owner;
  Global<Context> creationContext;
  Global<Function> completion;
  std::unique_ptr<node::AsyncResource> async;
  node::async_context identity{};
  uv_work_t request{};
  Bytes bytes;
  std::unique_ptr<Error> error;
  bool sync, dispatched = false, verified = false;
  Job(Isolate* isolate, bool sync) : isolate(isolate), sync(sync) { request.data = this; creationContext.Reset(isolate, isolate->GetCurrentContext()); }
  ~Job() { if (!owner.IsEmpty()) owner.Get(isolate)->SetAlignedPointerInInternalField(0, nullptr, kEmbedderDataTypeTagDefault); completion.Reset(); owner.Reset(); async.reset(); if (sync && identity.async_id) node::EmitAsyncDestroy(isolate, identity); creationContext.Reset(); }
  static void WeakSecond(const WeakCallbackInfo<Job>& info) { auto* job = info.GetParameter(); HandleScope handles(job->isolate); Context::Scope context(job->creationContext.Get(job->isolate)); delete job; }
  static void Weak(const WeakCallbackInfo<Job>& info) { info.GetParameter()->owner.Reset(); info.SetSecondPassCallback(WeakSecond); }
  void Invoke() {
    error = operation->Run(&bytes, &verified);
  }
  Local<Array> Result() {
    auto result = Array::New(isolate, 2); auto current = isolate->GetCurrentContext();
    Local<Value> err = Undefined(isolate), value = Undefined(isolate);
    if (error) err = MakeError(isolate, *error);
    else if (operation->verify) value = Boolean::New(isolate, verified);
    else { auto buffer = ArrayBuffer::New(isolate, bytes.value.size()); if (!bytes.value.empty()) std::memcpy(buffer->GetBackingStore()->Data(), bytes.value.data(), bytes.value.size()); value = buffer; }
    if (result->CreateDataProperty(current, 0, err).IsNothing() || result->CreateDataProperty(current, 1, value).IsNothing()) throw Pending{};
    return result;
  }
  static void RunWorker(uv_work_t* request) {
    auto* job = static_cast<Job*>(request->data);
    try { job->Invoke(); } catch (const std::exception& failure) { job->error = std::make_unique<Error>(failure.what()); }
  }
  static void Complete(uv_work_t* request, int status) {
    auto* pointer = static_cast<Job*>(request->data); auto* isolate = pointer->isolate;
    HandleScope scope(isolate); std::unique_ptr<Job> job(pointer);
    Context::Scope context(job->creationContext.Get(isolate));
    const auto owner = job->owner.Get(isolate);
    if (status != UV_ECANCELED) {
      Local<Value> packet;
      {
        TryCatch caught(isolate);
        try { packet = job->Result(); } catch (const Pending&) {}
        if (caught.HasCaught()) {
          auto error = caught.Exception(); caught.Reset(); auto result = Array::New(isolate, 2);
          if (result->CreateDataProperty(isolate->GetCurrentContext(), 0, error).IsNothing()) return;
          packet = result;
        }
      }
      if (packet.IsEmpty()) return;
      Local<Value> args[]{Integer::New(isolate, status), Text(isolate, job->operation->verify ? "verify" : "sign"), packet};
      const auto completed = job->async->MakeCallback(job->completion.Get(isolate), 3, args); (void)completed;
    }
    owner->SetAlignedPointerInInternalField(0, nullptr, kEmbedderDataTypeTagDefault);
  }
};
static void Create(const FunctionCallbackInfo<Value>& a) {
  auto* isolate = a.GetIsolate(); Local<Value> result = Undefined(isolate), error = Undefined(isolate);
  try {
    ncrypto::ClearErrorOnReturn clear;
    const bool sync = a[2].As<Int32>()->Value() == 1;
    auto job = std::make_unique<Job>(isolate, sync); job->operation = std::make_unique<SignatureJobOperation>();
    auto& op = *job->operation; op.verify = a[3].As<Int32>()->Value() == 1;
    const auto keyBytes = Copy(Acquire(a[4])); int format = 1, type = 1;
    if (!a[5]->IsNullOrUndefined()) format = a[5].As<Int32>()->Value();
    if (!a[6]->IsNullOrUndefined()) type = a[6].As<Int32>()->Value();
    const bool hasPassword = !a[7]->IsNullOrUndefined(); Bytes password = hasPassword ? Copy(Acquire(a[7])) : Bytes{};
    auto material = KeyMaterial::Parse(!op.verify, keyBytes, KeyMaterial::Configuration(format, type, hasPassword ? &password : nullptr)); op.RetainKey(material->asymmetric);
    ReadInput(a[9], INT_MAX, "data is too big", !sync, &op.data, &job->data);
    if (a[10]->IsString()) op.SetDigest(StringValue(isolate, a[10]));
    if (a[11]->IsInt32()) op.salt = a[11].As<Int32>()->Value();
    if (a[12]->IsUint32()) op.padding = int(a[12].As<Uint32>()->Value());
    op.p1363 = a[13].As<Int32>()->Value() == 1;
    if (!a[14]->IsUndefined()) ReadInput(a[14], 255, "context string must be at most 255 bytes", !sync, &op.context, &job->context);
    if (op.verify) {
      Bytes converted;
      ReadInput(a[15], INT_MAX, "signature is too big", !sync || op.UseP1363(), op.UseP1363() ? &converted : &op.signature, &job->signature);
      if (op.UseP1363()) { static const unsigned char empty = 0; op.signature.value = SignatureJobOperation::ConvertSignature(op.key, converted.value.empty() ? &empty : converted.value.data(), converted.value.size()); }
    }
    auto shape = ObjectTemplate::New(isolate); shape->SetInternalFieldCount(1);
    auto object = shape->NewInstance(isolate->GetCurrentContext()).ToLocalChecked();
    if (object->SetPrototypeV2(isolate->GetCurrentContext(), a[0]).IsNothing()) throw Pending{};
    object->SetAlignedPointerInInternalField(0, job.get(), kEmbedderDataTypeTagDefault); job->owner.Reset(isolate, object); job->completion.Reset(isolate, a[1].As<Function>());
    if (sync) { job->identity = node::EmitAsyncInit(isolate, object, "SIGNREQUEST"); job->owner.SetWeak(job.get(), Job::Weak, WeakCallbackType::kParameter); }
    else job->async = std::make_unique<node::AsyncResource>(isolate, object, "SIGNREQUEST");
    result = object; job.release();
  } catch (const Error& failure) { try { error = MakeError(isolate, failure); } catch (const Pending&) { return; } }
  catch (const Pending&) { return; }
  catch (const std::exception& failure) { isolate->ThrowException(Exception::Error(Text(isolate, failure.what()))); return; }
  auto packet = Object::New(isolate); if (!SetField(isolate, packet, "value", result) || !SetField(isolate, packet, "error", error)) return;
  a.GetReturnValue().Set(packet);
}
static void Run(const FunctionCallbackInfo<Value>& a) {
  auto* isolate = a.GetIsolate(); auto object = a[0].As<Object>();
  auto* job = object->InternalFieldCount() ? static_cast<Job*>(object->GetAlignedPointerFromInternalField(0, kEmbedderDataTypeTagDefault)) : nullptr;
  if (!job || job->dispatched) { isolate->ThrowException(Exception::Error(Text(isolate, "Job not dispatchable"))); return; }
  try {
    Local<Value> value = Undefined(isolate);
    if (job->sync) {
      if (job->data.store) { auto b = Copy(job->data); job->operation->data.value.swap(b.value); }
      if (job->signature.store) { auto b = Copy(job->signature); job->operation->signature.value.swap(b.value); }
      if (job->context.store) { auto b = Copy(job->context); job->operation->context.value.swap(b.value); }
      job->Invoke(); value = job->Result();
    } else {
      job->dispatched = true; const int status = uv_queue_work(node::GetCurrentEventLoop(isolate), &job->request, Job::RunWorker, Job::Complete);
      if (status) throw std::runtime_error(uv_strerror(status));
    }
    auto packet = Object::New(isolate); if (!SetField(isolate, packet, "value", value) || !SetField(isolate, packet, "error", Undefined(isolate))) return;
    a.GetReturnValue().Set(packet);
  } catch (const Pending&) {} catch (const std::exception& failure) { isolate->ThrowException(Exception::Error(Text(isolate, failure.what()))); }
}
static void Initialize(Local<Object> exports, Local<Value> module, Local<Context> context, void* priv) {
  (void)module; (void)context; (void)priv;
  NODE_SET_METHOD(exports, "create", Create); NODE_SET_METHOD(exports, "run", Run);
}
NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME, Initialize)
