#ifndef KANDELO_CODEC_API_H
#define KANDELO_CODEC_API_H
// Private marshalling API for complete original native decoder/StringBytes.
// Definitions operate on actual rooted SpiderMonkey values and owned bytes.
#include <uv.h>
#include "shell/node-upstream/engine-native-api.h"
#ifndef NODE_WANT_INTERNALS
#define NODE_WANT_INTERNALS 1
#endif
#include "node-env-properties.h"
#include "shell/node-upstream/tracing-upstream/node_mutex.h"
#pragma push_macro("node")
#undef node
#include "shell/node-upstream/resource-upstream/node_v8_embedder.h"
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/permission/permission_base.h"
#pragma pop_macro("node")
namespace kandelo_node_codec_impl { using EmbedderDataTag=::node::EmbedderDataTag; }

namespace kandelo::node { struct TraceProcess; }
namespace kandelo_node_options_impl {class EnvironmentOptions;class PerIsolateOptions;class PerProcessOptions;}
namespace node {
struct LibuvMutexTraits;
template<class Traits> class MutexBase;
template<class T,class MutexT> class ExclusiveAccess;
}

#ifndef KANDELO_NODE_UTILITY_NATIVE_API_H
#include "shell/node-upstream/utility-native-api.h"
#endif
namespace kandelo_node_codec_impl {
using namespace v8;
using SpanOwner=v8::SpanOwner;
class Environment;class IsolateData;class BaseObject;struct NativeRealmData;class KVStore;
using NativeEnvOptions=kandelo_node_options_impl::EnvironmentOptions;
using NativeEnvIsolateOptions=kandelo_node_options_impl::PerIsolateOptions;
using FatalIsolateOptions=kandelo_node_options_impl::PerIsolateOptions;
class EnabledDebugList;
namespace permission {class Permission;}
class AsyncWrap;class ReqWrapBase;class HandleWrap;class NodeArrayBufferAllocator;class ArrayBufferAllocator;
class ProcessImmediateInfo;
using Mutex=::node::MutexBase<::node::LibuvMutexTraits>;
using RwLock=::node::RwLock;
template<class T> using ExclusiveAccess=::node::ExclusiveAccess<T,Mutex>;
// A view of the original native options owner's inspector address. The port
// lives in that owner and is shared with option parsing, not copied here.
class HostPort {
 public:
  int port() const;void set_port(int);
};
enum class ExitCode : int;
class Realm {
  std::unique_ptr<NativeRealmData> data_;
 public:
  Realm(Isolate*,Local<Object>);~Realm();
  enum class Kind { kPrincipal, kShadow };
  static Realm* GetCurrent(const FunctionCallbackInfo<Value>&);
  static Realm* GetCurrent(Local<Context>);
  Isolate* isolate();Environment* env();IsolateData* isolate_data();Local<Context> context();
  Local<Object> owner();
  BaseObject* GetBindingRaw(size_t);void InstallBindingRaw(size_t,BaseObject*);
  template<class T> T* GetBindingData() { return static_cast<T*>(GetBindingRaw(size_t(T::binding_type_int))); }
  template<class T,class... Args> T* AddBindingData(Local<Object>,Args&&...);
  void TrackBaseObject(BaseObject*);void UntrackBaseObject(BaseObject*);void RunCleanup();
  Kind kind() const;void set_buffer_prototype_object(Local<Object>);
  void set_prepare_stack_trace_callback(Local<Function>);
  void set_enhance_fatal_stack_before_inspector(Local<Function>);
  void set_enhance_fatal_stack_after_inspector(Local<Function>);
#define KANDELO_REALM_ASYNC_HOOK(name) void set_async_hooks_##name##_function(Local<Function>);
  KANDELO_REALM_ASYNC_HOOK(init) KANDELO_REALM_ASYNC_HOOK(before)
  KANDELO_REALM_ASYNC_HOOK(after) KANDELO_REALM_ASYNC_HOOK(destroy)
  KANDELO_REALM_ASYNC_HOOK(promise_resolve)
#undef KANDELO_REALM_ASYNC_HOOK
  void set_async_hooks_callback_trampoline(Local<Function>);
  void set_async_hooks_binding(Local<Object>);
};
class Cleanable;
class CleanableQueue;
class CleanableLink {
  friend class CleanableQueue;
  Cleanable* item_;
  CleanableQueue* queue_=nullptr;
  CleanableLink* previous_=nullptr;
  CleanableLink* next_=nullptr;
 public:
  explicit CleanableLink(Cleanable* item):item_(item) {}
  ~CleanableLink();
  void Remove();
};
class Cleanable {
  friend class CleanableQueue;
 protected:
  CleanableLink cleanable_queue_{this};
 private:
  virtual void Clean()=0;
 public:
  virtual ~Cleanable()=default;
};
class CleanableQueue {
  friend class CleanableLink;
  Environment* environment_;
  CleanableLink* first_=nullptr;
  size_t size_=0;
  void Remove(CleanableLink*);
 public:
  explicit CleanableQueue(Environment* environment):environment_(environment) {}
  void PushFront(Cleanable*);
  bool IsEmpty() const { return first_==nullptr; }
  size_t size() const { return size_; }
  void CleanAll();
};
struct AliasedControl {
  virtual ~AliasedControl()=default;
  virtual Local<Value> Array(Isolate*) const=0;
  virtual double Read(size_t)const=0;virtual void Write(size_t,double)=0;
  virtual void Reserve(size_t)=0;virtual void Release()=0;virtual void Weaken()=0;
  virtual std::unique_ptr<AliasedControl> Copy()const=0;
  virtual const void* Uint8Backing()const { return nullptr; }
};
struct EnvironmentData;
class AsyncHooks;
namespace CallbackFlags {enum Flags {kUnrefed=0,kRefed=1};}
struct NativeImmediate {
  virtual ~NativeImmediate()=default;
  virtual void Run(Environment*)=0;
};
template<class Callback> struct NativeImmediateCallback final : NativeImmediate {
  Callback callback;
  explicit NativeImmediateCallback(Callback input):callback(std::move(input)) {}
  void Run(Environment* environment) override { callback(environment); }
};
class Environment {
  Isolate* isolate_;
  std::unique_ptr<EnvironmentData> data_;
 public:
  explicit Environment(Isolate*);~Environment();
  Environment(const Environment&)=delete;
  static Environment* GetCurrent(Local<Context>);
  static Environment* GetCurrent(Isolate*);
  static Environment* GetCurrent(const FunctionCallbackInfo<Value>&);
  template<class T> static Environment* GetCurrent(const PropertyCallbackInfo<T>& info) {
    return GetCurrent(info.GetIsolate());
  }
  Isolate* isolate()const;Local<Context> context();Local<ObjectTemplate> i18n_converter_template();
  Realm* principal_realm();bool can_call_into_js() const;
  bool owns_process_state() const;bool has_run_bootstrapping_code() const;
  bool PrepareProcessInvocation();
  std::shared_ptr<KVStore> env_vars();std::shared_ptr<NativeEnvOptions> options();
  void AddCleanupHook(void(*)(void*),void*);void RemoveCleanupHook(void(*)(void*),void*);
  std::string GetCwd(const std::string&);
  bool EmitProcessEnvWarning();
  bool source_maps_enabled();void set_source_maps_enabled(bool);
  Local<Function> get_source_map_error_source();void set_get_source_map_error_source(Local<Function>);
  Local<Function> maybe_cache_generated_source_map();void set_maybe_cache_generated_source_map(Local<Function>);
  Local<Function> enhance_fatal_stack_before_inspector();Local<Function> enhance_fatal_stack_after_inspector();
  Local<Private> decorated_private_symbol();Local<Private> arrow_message_private_symbol();
  bool printed_error();void set_printed_error(bool);bool abort_on_uncaught_exception();
  Local<Object> process_object();ExitCode exit_code(ExitCode);
  EnabledDebugList* enabled_debug_list();
  void ThrowUVException(int,const char*,const char* = nullptr,const char* = nullptr,const char* = nullptr);
  void ThrowErrnoException(int,const char*,const char* = nullptr,const char* = nullptr);
  uv_loop_t* event_loop();
  struct RequestQueue;
  RequestQueue* req_wrap_queue();
  void IncreaseWaitingRequestCounter();void DecreaseWaitingRequestCounter();
  struct HandleQueue;
  HandleQueue* handle_wrap_queue();
  const int32_t* timeout_info();ProcessImmediateInfo* immediate_info();
  void Exit(ExitCode);void set_process_emit_warning_sync(Local<Function>);
  const std::vector<std::string>& argv();const std::vector<std::string>& exec_argv();
  const std::string& exec_path();ExclusiveAccess<HostPort>* inspector_host_port();
#define KANDELO_ENV_STRING_ACCESSOR(name, text) Local<String> name();
  PER_ISOLATE_STRING_PROPERTIES(KANDELO_ENV_STRING_ACCESSOR)
#undef KANDELO_ENV_STRING_ACCESSOR
  Local<Private> exit_info_private_symbol();
  struct ExitInfo {Local<Int32Array> GetJSArray();};
  ExitInfo exit_info();
  using EmbedderPreload=void(*)(Environment*,Local<Object>,Local<Function>);
  EmbedderPreload embedder_preload();void set_embedder_preload(EmbedderPreload);
  Local<Object> buffer_prototype_object();Local<Private> untransferable_object_private_symbol();
  IsolateData* isolate_data();void ThrowRangeError(const char*);
  Local<DictionaryTemplate> permission_diagnostic_channel_message()const;
  void set_permission_diagnostic_channel_message(Local<DictionaryTemplate>);
  permission::Permission* permission()const;
#define KANDELO_PERMISSION_STRING(Name,label,Parent,Flag) Local<String> Name##_permission_string()const;
  PERMISSIONS(KANDELO_PERMISSION_STRING)
#undef KANDELO_PERMISSION_STRING
  void set_trace_category_state_function(Local<Function>);
  bool async_context_frame_enabled() const;
  AsyncHooks* async_hooks();double new_async_id();double get_default_trigger_async_id();
  double execution_async_id()const;uint64_t thread_id()const;
  Local<Symbol> owner_symbol();Local<Symbol> resource_symbol();Local<Symbol> handle_onclose_symbol();
  Local<Private> empty_context_frame_sentinel_symbol();
#define KANDELO_ENV_ASYNC_HOOK(name) Local<Function> async_hooks_##name##_function();void set_async_hooks_##name##_function(Local<Function>);
  KANDELO_ENV_ASYNC_HOOK(init) KANDELO_ENV_ASYNC_HOOK(before)
  KANDELO_ENV_ASYNC_HOOK(after) KANDELO_ENV_ASYNC_HOOK(destroy)
  KANDELO_ENV_ASYNC_HOOK(promise_resolve)
#undef KANDELO_ENV_ASYNC_HOOK
  void set_async_hooks_callback_trampoline(Local<Function>);
  void ResetPromiseHooks(Local<Function>,Local<Function>,Local<Function>,Local<Function>);
  std::vector<double>* destroy_async_id_list();
  void RequestInterrupt(std::function<void(Environment*)>);
  CleanableQueue* cleanable_queue();
  ExternalMemoryAccounter* external_memory_accounter();
  JSObject* memory_owner(JSContext*);
  void AssertForeground() const;
  bool Initialize(JSContext*,JS::HandleObject);
  bool IsClosed() const;
  bool HasPending() const;
  bool Drain(JSContext*);
  void Shutdown(JSContext*);
  EnvironmentData& data() { return *data_; }
  void Post(std::unique_ptr<NativeImmediate>);
  void SetImmediateNative(std::function<void(Environment*)>);
  template<class Callback> void SetImmediate(Callback&& callback) {
    SetImmediateNative(std::function<void(Environment*)>(std::forward<Callback>(callback)));
  }
  void SetImmediate(std::function<void(Environment*)>,CallbackFlags::Flags);
  template<class Callback> void SetImmediateThreadsafe(Callback&& callback) {
    using Stored=std::decay_t<Callback>;
    Post(std::make_unique<NativeImmediateCallback<Stored>>(std::forward<Callback>(callback)));
  }
};
class IsolateData {
  Isolate* isolate_;
  NodeArrayBufferAllocator* nodeAllocator_=nullptr;
 public:
  IsolateData();explicit IsolateData(Isolate*,ArrayBufferAllocator* = nullptr);
  IsolateData(const IsolateData&)=delete;IsolateData& operator=(const IsolateData&)=delete;
  Isolate* isolate()const;void set_i18n_converter_template(Local<ObjectTemplate>);
  bool is_building_snapshot() const;
  NodeArrayBufferAllocator* node_allocator() const;
  uint16_t* embedder_id_for_non_cppgc() const;
  Local<DictionaryTemplate> permission_diagnostic_channel_message()const;
  void set_permission_diagnostic_channel_message(Local<DictionaryTemplate>);
  std::shared_ptr<FatalIsolateOptions> options();
  Local<ObjectTemplate> env_proxy_template();void set_env_proxy_template(Local<ObjectTemplate>);
  void set_env_proxy_ctor_template(Local<FunctionTemplate>);
  Local<FunctionTemplate> async_wrap_ctor_template();
  void set_async_wrap_ctor_template(Local<FunctionTemplate>);
  Local<FunctionTemplate> handle_wrap_ctor_template();
  void set_handle_wrap_ctor_template(Local<FunctionTemplate>);
};
class MemoryTracker;class MemoryRetainer;
BaseObject* UnwrapCodecObject(Local<Object>);
BaseObject* UnwrapNativeBinding(Local<Object>);
bool BaseObjectHasNativeReference(const BaseObject*);
bool BaseObjectIsDetached(const BaseObject*);
void RetireBaseObjectWrapper(BaseObject*);
template<class T> bool Unwrap(T**,Local<Object>);
namespace Buffer {
MaybeLocal<Object> New(Environment*,size_t);
MaybeLocal<Object> Copy(Environment*,const char*,size_t);
MaybeLocal<Object> New(Environment*,char*,size_t);
MaybeLocal<Object> New(Environment*,char*,size_t,void(*)(char*,void*),void*);
}

namespace per_process {
extern std::shared_ptr<kandelo_node_options_impl::PerProcessOptions>& cli_options;
}
class ExternalReferenceRegistry {
 public:
  void Register(void(*)(const FunctionCallbackInfo<Value>&)) { Crash("Native snapshot external-reference registry is not implemented"); }
  template<class T> void Register(T) { Crash("Native snapshot external-reference registry is not implemented"); }
};
}
namespace kandelo_trace_adapter {
using namespace v8;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern Initializer initializer;
void IsTraceCategoryEnabled(const FunctionCallbackInfo<Value>&);
void Trace(const FunctionCallbackInfo<Value>&);
}
namespace kandelo_continuation_adapter {
using namespace v8;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern Initializer initializer;
void Get(const FunctionCallbackInfo<Value>&);
void Set(const FunctionCallbackInfo<Value>&);
bool WithFrame(Isolate*,Local<Value>,const std::function<bool()>&);
}
namespace kandelo_icu_adapter {
using namespace v8;
using PerIsolateInitializer=void(*)(kandelo_node_codec_impl::IsolateData*,Local<ObjectTemplate>);
using ContextInitializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern PerIsolateInitializer initializer;
extern ContextInitializer context_initializer;
}
namespace kandelo_codec_adapter {
using namespace v8;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern Initializer initializer;
}
namespace kandelo_buffer_adapter {
using namespace v8;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern Initializer initializer;
}
#define NODE_WANT_INTERNALS 1
#define NODE_EXTERN
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name,callback) namespace kandelo_codec_adapter { Initializer initializer=::callback; }
#define NODE_BINDING_EXTERNAL_REFERENCE(name,callback)
#define TRACK_V8_FAST_API_CALL(name) v8::Crash("V8 fast JIT entry is unavailable in SpiderMonkey")
#include "shell/node-upstream/native-object-api.h"
#endif
