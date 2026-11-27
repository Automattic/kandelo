// Temporary native version of Undici's bundled Wasm parser. Restore the
// original Wasm factory after guest Wasm qualification; see the maintenance
// inventory. Original llhttp algorithms and Undici callback bodies are intact.
#include "cppgc_helpers-inl.h"
#include "env-inl.h"
#include "node_binding.h"
#include "util-inl.h"
#include "kandelo_undici_llhttp.h"
#include <algorithm>
#include <array>
#include <cstring>
#include <dlfcn.h>
#include <limits>
#include <map>
#include <memory>
#include <mutex>

namespace node::undici_llhttp {
using namespace v8;

static void Throw(Isolate* isolate, const char* message) {
  Local<String> text;
  if (String::NewFromUtf8(isolate, message).ToLocal(&text))
    isolate->ThrowException(Exception::Error(text));
}

// Pin executable code for the process lifetime, including Worker/TLS teardown.
// Per-instance allocations and JS edges are retired independently below.
struct Library {
  std::mutex lock;
  void* handle = nullptr;
  const kandelo_undici_llhttp_api_v1* api = nullptr;
};
static Library library;

static const kandelo_undici_llhttp_api_v1* Load(Isolate* isolate) {
  std::lock_guard<std::mutex> guard(library.lock);
  if (library.api != nullptr) return library.api;
  if (library.handle != nullptr) {
    Throw(isolate, "Incompatible native Undici llhttp provider"); return nullptr;
  }
  void* handle = dlopen("/usr/lib/libnode-undici-llhttp.so", RTLD_NOW | RTLD_LOCAL);
  if (handle == nullptr) { Throw(isolate, dlerror()); return nullptr; }
  library.handle = handle;
  auto get = reinterpret_cast<decltype(&kandelo_undici_llhttp_get_api_v1)>(
      dlsym(handle, "kandelo_undici_llhttp_get_api_v1"));
  const auto* api = get == nullptr ? nullptr : get();
  if (api == nullptr || api->abi_version != 1 ||
      api->structure_size != sizeof(*api) || api->parser_version != 0x090301 ||
      api->pointer_size != sizeof(void*) || api->parser_allocation_size == 0 ||
      api->create == nullptr || api->destroy == nullptr || api->execute == nullptr ||
      api->finish == nullptr || api->resume == nullptr ||
      api->error_position == nullptr || api->error_reason == nullptr) {
    // No successful provider is published from a partially loaded library.
    // Keep code pinned even on failure rather than unloading live TLS/code.
    Throw(isolate, "Incompatible native Undici llhttp provider");
    return nullptr;
  }
  library.handle = handle;
  library.api = api;
  return api;
}

class Instance final : CPPGC_MIXIN(Instance), public cppgc::NameProvider {
 public:
  SET_CPPGC_NAME(Instance)
  SET_NO_MEMORY_INFO()

  struct Parser {
    Instance* owner;
    void* native = nullptr;
    uint32_t id = 0;
    uint32_t input_offset = 0;
    size_t input_length = 0;
    // llhttp's error/span pointers must survive GC and arena replacement.
    std::shared_ptr<BackingStore> input;
  };

  Instance(Environment* env, Local<Object> wrapper, Local<Context> context,
           const std::array<Local<Function>, 8>& callbacks,
           const kandelo_undici_llhttp_api_v1* api)
      : isolate_(env->isolate()), api_(api) {
    CppgcMixin::Wrap(this, env, wrapper);
    context_.Reset(isolate_, context);
    for (size_t i = 0; i < callbacks.size(); ++i)
      callbacks_[i].Reset(isolate_, callbacks[i]);
  }
  ~Instance() { CHECK_EQ(active_, 0); Finalize(); Release(); }

  void Trace(cppgc::Visitor* visitor) const override {
    CppgcMixin::Trace(visitor);
    visitor->Trace(context_);
    visitor->Trace(arena_);
    for (const auto& callback : callbacks_) visitor->Trace(callback);
  }
  void Clean(Realm*) override {
    closed_ = true;
    if (active_ == 0) Release();
  }

  static Instance* Get(const FunctionCallbackInfo<Value>& args) {
    CHECK(args.Data()->IsObject());
    auto* instance = CppgcMixin::Unwrap<Instance>(args.Data().As<Object>());
    if (instance == nullptr || instance->closed_) {
      Throw(args.GetIsolate(), "Native Undici parser owner is closed");
      return nullptr;
    }
    return instance;
  }

  static bool Uint(const FunctionCallbackInfo<Value>& args, int index,
                   uint32_t* result) {
    // Match Wasm's i32 argument conversion, including null for the initial
    // empty-input pointer. Validate the resulting handle/range before access.
    Local<Value> value = index < args.Length() ? args[index] : Undefined(args.GetIsolate());
    return value->Uint32Value(args.GetIsolate()->GetCurrentContext()).To(result);
  }

  static void Allocate(const FunctionCallbackInfo<Value>& args) {
    auto* self = Get(args); uint32_t length;
    if (self == nullptr || !Uint(args, 0, &length)) return;
    uint32_t offset;
    if (self->AllocateBytes(length, &offset)) args.GetReturnValue().Set(offset);
  }
  static void Free(const FunctionCallbackInfo<Value>& args) {
    auto* self = Get(args); uint32_t offset;
    if (self == nullptr || !Uint(args, 0, &offset)) return;
    if (offset == 0) return;
    auto block = self->blocks_.find(offset);
    if (block == self->blocks_.end() || block->second.free) {
      Throw(self->isolate_, "Invalid native Undici buffer release"); return;
    }
    block->second.free = true;
    auto next = std::next(block);
    if (next != self->blocks_.end() && next->second.free &&
        uint64_t(block->first) + block->second.length == next->first) {
      block->second.length += next->second.length;
      self->blocks_.erase(next);
    }
    if (block != self->blocks_.begin()) {
      auto previous = std::prev(block);
      if (previous->second.free &&
          uint64_t(previous->first) + previous->second.length == block->first) {
        previous->second.length += block->second.length;
        self->blocks_.erase(block);
      }
    }
  }
  static void GetBuffer(const FunctionCallbackInfo<Value>& args) {
    auto* self = Get(args);
    if (self == nullptr) return;
    if (!self->EnsureArena(65536)) return;
    args.GetReturnValue().Set(self->arena_.Get(self->isolate_));
  }
  static void CreateParser(const FunctionCallbackInfo<Value>& args) {
    auto* self = Get(args); uint32_t type;
    if (self == nullptr || !Uint(args, 0, &type)) return;
    if (type > 2) { Throw(self->isolate_, "Invalid llhttp parser type"); return; }
    auto parser = std::make_unique<Parser>(); parser->owner = self;
    parser->native = self->api_->create(type, Dispatch, parser.get());
    if (parser->native == nullptr) {
      Throw(self->isolate_, "Native llhttp allocation failed"); return;
    }
    static_assert(sizeof(void*) == sizeof(uint32_t));
    parser->id = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(parser->native));
    uint32_t id = parser->id;
    CHECK_NE(id, 0); CHECK(self->parsers_.find(id) == self->parsers_.end());
    self->parsers_.emplace(id, std::move(parser));
    self->isolate_->AdjustAmountOfExternalAllocatedMemory(self->api_->parser_allocation_size);
    args.GetReturnValue().Set(id);
  }
  static void DestroyParser(const FunctionCallbackInfo<Value>& args) {
    auto* self = Get(args); uint32_t id;
    if (self == nullptr || !Uint(args, 0, &id)) return;
    auto found = self->parsers_.find(id);
    if (found == self->parsers_.end() || self->active_ != 0) {
      Throw(self->isolate_, "Invalid or active native llhttp release"); return;
    }
    self->api_->destroy(found->second->native);
    self->parsers_.erase(found);
    self->isolate_->AdjustAmountOfExternalAllocatedMemory(
        -static_cast<int64_t>(self->api_->parser_allocation_size));
  }
  static void Execute(const FunctionCallbackInfo<Value>& args) {
    auto* self = Get(args); uint32_t id, offset, length;
    if (self == nullptr || !Uint(args, 0, &id) || !Uint(args, 1, &offset) ||
        !Uint(args, 2, &length)) return;
    auto* parser = self->Find(id); if (parser == nullptr) return;
    auto block = self->blocks_.find(offset);
    bool empty = offset == 0 && length == 0;
    if ((!empty && (block == self->blocks_.end() || block->second.free ||
        length > block->second.length)) || self->active_ != 0) {
      Throw(self->isolate_, "Invalid native llhttp input range or reentry"); return;
    }
    if (self->backing_ == nullptr && !self->EnsureArena(65536)) return;
    parser->input = self->backing_;
    parser->input_offset = offset; parser->input_length = length;
    self->Call(args, *parser, false);
  }
  static void Finish(const FunctionCallbackInfo<Value>& args) {
    auto* self = Get(args); uint32_t id;
    if (self == nullptr || !Uint(args, 0, &id)) return;
    auto* parser = self->Find(id); if (parser == nullptr) return;
    if (self->active_ != 0) { Throw(self->isolate_, "Native llhttp reentry"); return; }
    self->Call(args, *parser, true);
  }
  static void Resume(const FunctionCallbackInfo<Value>& args) {
    auto* self = Get(args); uint32_t id;
    if (self == nullptr || !Uint(args, 0, &id)) return;
    auto* parser = self->Find(id); if (parser != nullptr) self->api_->resume(parser->native);
  }
  static void ErrorPosition(const FunctionCallbackInfo<Value>& args) {
    auto* self = Get(args); uint32_t id;
    if (self == nullptr || !Uint(args, 0, &id)) return;
    auto* parser = self->Find(id); if (parser == nullptr) return;
    const auto* at = self->api_->error_position(parser->native);
    if (at == nullptr) { args.GetReturnValue().Set(0); return; }
    uint32_t offset;
    if (self->Span(*parser, at, 0, &offset)) args.GetReturnValue().Set(offset);
  }
  static void ErrorReason(const FunctionCallbackInfo<Value>& args) {
    auto* self = Get(args); uint32_t id;
    if (self == nullptr || !Uint(args, 0, &id)) return;
    auto* parser = self->Find(id); if (parser == nullptr) return;
    const char* reason = self->api_->error_reason(parser->native);
    if (reason == nullptr) { args.GetReturnValue().Set(0); return; }
    size_t length = std::strlen(reason) + 1;
    if (length > UINT32_MAX) { Throw(self->isolate_, "llhttp error text overflow"); return; }
    // One reusable owner allocation holds actual zero-terminated parser text.
    if (length > self->reason_capacity_) {
      uint32_t offset;
      if (!self->AllocateBytes(static_cast<uint32_t>(length), &offset)) return;
      if (self->reason_offset_ != 0) self->blocks_.at(self->reason_offset_).free = true;
      self->reason_offset_ = offset; self->reason_capacity_ = length;
    }
    std::memcpy(static_cast<uint8_t*>(self->backing_->Data()) + self->reason_offset_, reason, length);
    args.GetReturnValue().Set(self->reason_offset_);
  }

 private:
  struct Block { uint32_t length; bool free; };
  Isolate* isolate_;
  const kandelo_undici_llhttp_api_v1* api_;
  TracedReference<Context> context_;
  TracedReference<ArrayBuffer> arena_;
  std::array<TracedReference<Function>, 8> callbacks_;
  std::shared_ptr<BackingStore> backing_;
  std::map<uint32_t, Block> blocks_;
  std::map<uint32_t, std::unique_ptr<Parser>> parsers_;
  uint32_t high_water_ = 8;
  uint32_t reason_offset_ = 0;
  size_t reason_capacity_ = 0;
  unsigned active_ = 0;
  bool closed_ = false;
  bool callback_failed_ = false;

  Parser* Find(uint32_t id) {
    auto it = parsers_.find(id);
    if (it == parsers_.end()) { Throw(isolate_, "Unknown native llhttp parser"); return nullptr; }
    return it->second.get();
  }
  bool EnsureArena(size_t need) {
    if (backing_ != nullptr && backing_->ByteLength() >= need) return true;
    if (need > ArrayBuffer::kMaxByteLength) { Throw(isolate_, "Native llhttp buffer limit"); return false; }
    size_t capacity = backing_ == nullptr ? 65536 : backing_->ByteLength();
    while (capacity < need) capacity = std::min<size_t>(capacity * 2, ArrayBuffer::kMaxByteLength);
    auto next = ArrayBuffer::NewBackingStore(isolate_, capacity,
        BackingStoreInitializationMode::kZeroInitialized, BackingStoreOnFailureMode::kReturnNull);
    if (next == nullptr) { Throw(isolate_, "Native llhttp buffer allocation failed"); return false; }
    if (backing_ != nullptr) std::memcpy(next->Data(), backing_->Data(), backing_->ByteLength());
    std::shared_ptr<BackingStore> shared(std::move(next));
    auto buffer = ArrayBuffer::New(isolate_, shared);
    if (buffer.IsEmpty()) return false;
    backing_ = std::move(shared); arena_.Reset(isolate_, buffer);
    return true;
  }
  bool AllocateBytes(uint32_t length, uint32_t* output) {
    uint64_t rounded = (uint64_t(std::max<uint32_t>(length, 1)) + 7) & ~uint64_t(7);
    if (rounded > UINT32_MAX) { Throw(isolate_, "Native llhttp allocation overflow"); return false; }
    for (auto& [offset, block] : blocks_) {
      if (!block.free || block.length < rounded) continue;
      uint32_t old = block.length; block = {static_cast<uint32_t>(rounded), false};
      if (old > rounded) blocks_.emplace(offset + rounded, Block{static_cast<uint32_t>(old - rounded), true});
      *output = offset; return true;
    }
    uint64_t end = uint64_t(high_water_) + rounded;
    if (end > UINT32_MAX || !EnsureArena(end)) return false;
    *output = high_water_; blocks_.emplace(high_water_, Block{static_cast<uint32_t>(rounded), false});
    high_water_ = static_cast<uint32_t>(end); return true;
  }
  bool Span(const Parser& parser, const uint8_t* at, size_t length, uint32_t* result) {
    if (parser.input == nullptr) { Throw(isolate_, "llhttp span has no input owner"); return false; }
    uintptr_t begin = reinterpret_cast<uintptr_t>(parser.input->Data()) + parser.input_offset;
    uintptr_t pointer = reinterpret_cast<uintptr_t>(at);
    if (pointer < begin || pointer - begin > parser.input_length ||
        length > parser.input_length - (pointer - begin)) {
      Throw(isolate_, "llhttp span outside its owned input"); return false;
    }
    *result = parser.input_offset + static_cast<uint32_t>(pointer - begin); return true;
  }
  static int32_t Dispatch(void* raw, uint32_t operation, const uint8_t* span,
                          size_t length, uint32_t status, uint32_t upgrade,
                          uint32_t keep_alive) {
    auto& parser = *static_cast<Parser*>(raw); auto& self = *parser.owner;
    if (self.closed_ || self.callback_failed_) return -1;
    CHECK_LT(operation, self.callbacks_.size()); CHECK_EQ(self.active_, 1);
    HandleScope handles(self.isolate_);
    Local<Context> context = self.context_.Get(self.isolate_);
    Context::Scope scope(context);
    Local<Value> values[4] = {Integer::NewFromUnsigned(self.isolate_, parser.id)};
    int count = 1;
    if (operation == KUL_HEADERS_COMPLETE) {
      values[1] = Integer::NewFromUnsigned(self.isolate_, status);
      values[2] = Integer::NewFromUnsigned(self.isolate_, upgrade);
      values[3] = Integer::NewFromUnsigned(self.isolate_, keep_alive); count = 4;
    } else if (span != nullptr) {
      uint32_t offset;
      if (!self.Span(parser, span, length, &offset)) { self.callback_failed_ = true; return -1; }
      values[1] = Integer::NewFromUnsigned(self.isolate_, offset);
      values[2] = Integer::NewFromUnsigned(self.isolate_, length); count = 3;
    }
    Local<Value> result; int32_t number;
    if (!self.callbacks_[operation].Get(self.isolate_)->Call(
            context, Undefined(self.isolate_), count, values).ToLocal(&result) ||
        !result->Int32Value(context).To(&number)) {
      self.callback_failed_ = true; return -1;
    }
    return number;
  }
  void Call(const FunctionCallbackInfo<Value>& args, Parser& parser, bool finish) {
    CHECK_EQ(active_, 0); ++active_; callback_failed_ = false;
    TryCatch caught(isolate_);
    int32_t result = finish ? api_->finish(parser.native) : api_->execute(parser.native,
        static_cast<const uint8_t*>(parser.input->Data()) + parser.input_offset, parser.input_length);
    --active_;
    if (closed_) Release();
    if (caught.HasCaught()) { if (!caught.HasTerminated()) caught.ReThrow(); return; }
    if (callback_failed_) return; // Preserve engine termination/pending failure.
    args.GetReturnValue().Set(result);
  }
  void Release() {
    CHECK_EQ(active_, 0);
    for (auto& [id, parser] : parsers_) {
      api_->destroy(parser->native);
      isolate_->AdjustAmountOfExternalAllocatedMemory(-static_cast<int64_t>(api_->parser_allocation_size));
    }
    parsers_.clear(); blocks_.clear(); backing_.reset(); arena_.Reset(); context_.Reset();
    for (auto& callback : callbacks_) callback.Reset();
  }
};

static void CreateInstance(const FunctionCallbackInfo<Value>& args) {
  Isolate* isolate = args.GetIsolate(); Local<Context> context = isolate->GetCurrentContext();
  if (args.Length() != 1 || !args[0]->IsObject()) {
    Throw(isolate, "Native Undici parser requires its original imports"); return;
  }
  const auto* api = Load(isolate); if (api == nullptr) return;
  Local<Value> imported;
  if (!args[0].As<Object>()->Get(context, FIXED_ONE_BYTE_STRING(isolate, "env")).ToLocal(&imported)) return;
  if (!imported->IsObject()) { Throw(isolate, "Missing Undici parser callbacks"); return; }
  constexpr const char* names[] = {"wasm_on_url", "wasm_on_status", "wasm_on_header_field",
      "wasm_on_header_value", "wasm_on_headers_complete", "wasm_on_message_begin",
      "wasm_on_body", "wasm_on_message_complete"};
  std::array<Local<Function>, 8> callbacks;
  for (size_t i = 0; i < callbacks.size(); ++i) {
    Local<String> name; Local<Value> value;
    if (!String::NewFromUtf8(isolate, names[i]).ToLocal(&name) ||
        !imported.As<Object>()->Get(context, name).ToLocal(&value)) return;
    if (!value->IsFunction()) { Throw(isolate, "Invalid Undici parser callback"); return; }
    callbacks[i] = value.As<Function>();
  }
  Local<ObjectTemplate> templ = ObjectTemplate::New(isolate); templ->SetInternalFieldCount(2);
  Local<Object> wrapper;
  if (!templ->NewInstance(context).ToLocal(&wrapper)) return;
  cppgc::MakeGarbageCollected<Instance>(Environment::GetCurrent(context)->cppgc_allocation_handle(),
      Environment::GetCurrent(context), wrapper, context, callbacks, api);
  Local<Object> exports = Object::New(isolate), memory = Object::New(isolate);
  struct Method { const char* name; FunctionCallback callback; };
  constexpr Method methods[] = {{"malloc", Instance::Allocate}, {"free", Instance::Free},
      {"llhttp_alloc", Instance::CreateParser}, {"llhttp_free", Instance::DestroyParser},
      {"llhttp_execute", Instance::Execute}, {"llhttp_finish", Instance::Finish},
      {"llhttp_resume", Instance::Resume}, {"llhttp_get_error_pos", Instance::ErrorPosition},
      {"llhttp_get_error_reason", Instance::ErrorReason}};
  for (const auto& method : methods) {
    Local<String> name; Local<Function> function;
    if (!String::NewFromUtf8(isolate, method.name).ToLocal(&name) ||
        !Function::New(context, method.callback, wrapper).ToLocal(&function) ||
        !exports->DefineOwnProperty(context, name, function,
            static_cast<PropertyAttribute>(ReadOnly | DontDelete)).FromMaybe(false)) return;
  }
  Local<Function> getter;
  if (!Function::New(context, Instance::GetBuffer, wrapper).ToLocal(&getter)) return;
  PropertyDescriptor descriptor(getter, Local<Value>());
  descriptor.set_enumerable(true); descriptor.set_configurable(false);
  if (!memory->DefineProperty(context, FIXED_ONE_BYTE_STRING(isolate, "buffer"), descriptor).FromMaybe(false) ||
      !exports->DefineOwnProperty(context, FIXED_ONE_BYTE_STRING(isolate, "memory"), memory,
          static_cast<PropertyAttribute>(ReadOnly | DontDelete)).FromMaybe(false)) return;
  Local<Object> instance = Object::New(isolate);
  if (!instance->DefineOwnProperty(context, FIXED_ONE_BYTE_STRING(isolate, "exports"), exports,
      static_cast<PropertyAttribute>(ReadOnly | DontDelete)).FromMaybe(false)) return;
  args.GetReturnValue().Set(instance);
}

static void Initialize(Local<Object> target, Local<Value>, Local<Context> context, void*) {
  SetMethod(context, target, "createInstance", CreateInstance);
}
}  // namespace node::undici_llhttp
NODE_BINDING_CONTEXT_AWARE_INTERNAL(undici_llhttp, node::undici_llhttp::Initialize)
