#ifndef KANDELO_OPTIONS_API_H
#define KANDELO_OPTIONS_API_H
// Declarations only for the full native options translation unit. Missing JS
// operations must fail to link if used, never return manufactured values.
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>
namespace kandelo_node_options_impl { class Environment; }
namespace kandelo_node_options_api {
class Isolate;
class Value;
class Object;
class Map;
class Name;
class String;
struct Context { Isolate* isolate; };
template<class T> class Local {
  T* pointer_ = nullptr;
 public:
  Local() = default;
  explicit Local(T* p) : pointer_(p) {}
  template<class U> Local(Local<U> p) : pointer_(p.get()) {}
  T* get() const { return pointer_; }
  T* operator->() const { return pointer_; }
  bool IsEmpty() const { return !pointer_; }
  template<class U> Local<U> As() const { return Local<U>(static_cast<U*>(pointer_)); }
};
template<class T> class MaybeLocal {
  Local<T> value_;
 public:
  MaybeLocal() = default;
  MaybeLocal(Local<T> value):value_(value) {}
  bool ToLocal(Local<T>* out) const { *out=value_; return !value_.IsEmpty(); }
  bool IsEmpty() const { return value_.IsEmpty(); }
};
template<class T> class Maybe {
 bool present_=false; T value_{};
 public:
 Maybe()=default;
 explicit Maybe(T value):present_(true),value_(value) {}
 bool IsNothing() const { return !present_; }
 void Check() const { if(!present_ || !value_) __builtin_trap(); }
};
struct Cell;
struct Frame;
class Value {
  std::unique_ptr<Cell> cell_;
 public:
  explicit Value(std::unique_ptr<Cell>);
  virtual ~Value();
  Cell& cell() const;
};
class Name : public Value { public: using Value::Value; };
enum class NewStringType { kNormal };
class String : public Name {
 public:
  using Name::Name;
  static MaybeLocal<String> NewFromUtf8(Isolate*, const char*, NewStringType, int);
  template<size_t N> static Local<String> NewFromUtf8Literal(Isolate* isolate,const char(&value)[N]) { Local<String> out; NewFromUtf8(isolate,value,NewStringType::kNormal,N-1).ToLocal(&out); return out; }
};
class Object : public Value {
 public:
  using Value::Value;
  static Local<Object> New(Isolate*);
  static Local<Object> New(Isolate*,Local<Value>,Local<Name>*,Local<Value>*,size_t);
  Maybe<bool> SetPrototypeV2(Local<Context>,Local<Value>);
  Maybe<bool> Set(Local<Context>,Local<Value>,Local<Value>);
};
class Map : public Object {
 public:
  using Object::Object;
  static Local<Map> New(Isolate*);
  MaybeLocal<Map> Set(Local<Context>,Local<Value>,Local<Value>);
};
class Boolean : public Value { public: using Value::Value; static Local<Boolean> New(Isolate*,bool); };
class Number : public Value { public: using Value::Value; static Local<Number> New(Isolate*,double); };
class Integer : public Number { public: using Number::Number; static Local<Integer> New(Isolate*,int); };
class Isolate {
 Frame* frame_; Context context_;
 public:
 explicit Isolate(Frame* frame):frame_(frame),context_{this} {}
 Frame& frame() const { return *frame_; }
 Local<Context> GetCurrentContext() { return Local<Context>(&context_); }
};
Local<Value> Null(Isolate*);
Local<Value> Undefined(Isolate*);
template<class T> class LocalVector : public std::vector<Local<T>> { Isolate* owner_; public: explicit LocalVector(Isolate* owner):owner_(owner) { if(!owner_) __builtin_trap(); } };
Local<Value> FrameArgument(Isolate*,int);
void SetFrameReturn(Isolate*,Local<Value>);
template<class T> class ReturnValue {
  Isolate* isolate_;
 public:
  explicit ReturnValue(Isolate* isolate):isolate_(isolate) {}
  void Set(Local<T> value) const { SetFrameReturn(isolate_,value); }
};
template<class T> class FunctionCallbackInfo {
  Isolate* isolate_;
 public:
  explicit FunctionCallbackInfo(Isolate* isolate):isolate_(isolate) {}
  Isolate* GetIsolate() const { return isolate_; }
  ReturnValue<T> GetReturnValue() const { return ReturnValue<T>(isolate_); }
  Local<Value> operator[](int index) const { return FrameArgument(isolate_,index); }
};
}
namespace kandelo_node_options_impl {
using StringVector=std::vector<std::string>;
class EnvironmentOptions;
class PerIsolateOptions;
class IsolateData {
 kandelo_node_options_api::Frame* frame_;
 public:
 explicit IsolateData(kandelo_node_options_api::Frame* frame):frame_(frame) {}
 std::shared_ptr<PerIsolateOptions> options() const;
};
using namespace kandelo_node_options_api;
class Environment {
 Frame* frame_; IsolateData isolate_data_;
 public:
 explicit Environment(Frame* frame):frame_(frame),isolate_data_(frame) {}
  static Environment* GetCurrent(Local<Context>);
  static Environment* GetCurrent(const FunctionCallbackInfo<Value>&);
  Isolate* isolate();
  bool has_run_bootstrapping_code() const;
  void set_has_serialized_options(bool);
  std::shared_ptr<EnvironmentOptions> options();
  IsolateData* isolate_data();
  Local<Value> primordials_safe_map_prototype_object();
  Local<Name> host_string(); Local<Name> port_string();
  Local<Name> help_text_string(); Local<Name> env_var_settings_string();
  Local<Name> type_string(); Local<Name> default_is_true_string();
  Local<Name> options_string(); Local<Name> aliases_string();
  bool should_not_register_esm_loader(); bool no_global_search_paths();
  bool no_browser_globals(); void* embedder_preload();
  void ThrowError(const char*);
};
class Utf8Value {
 std::string value_;
 public:
  Utf8Value(Isolate*,Local<Value>);
  const char* operator*() const;
  size_t length() const;
};
MaybeLocal<Value> ToV8Value(Local<Context>,const std::string&);
MaybeLocal<Value> ToV8Value(Local<Context>,const StringVector&);
MaybeLocal<Value> ToV8Value(Local<Context>,const std::unordered_map<std::string,StringVector>&);
void SetMethodNoSideEffect(Local<Context>,Local<Object>,const char*,void(*)(const FunctionCallbackInfo<Value>&));
class ExternalReferenceRegistry { public: template<class T> void Register(T); };
namespace credentials { bool SafeGetenv(const char*, std::string*); }
}
namespace kandelo_options_adapter {
using namespace kandelo_node_options_api;
void ThrowOptionsBeforeBootstrap(Isolate*,const char*);
void DefineConstant(Local<Object>,const char*,double);
uint64_t UnavailableMemoryQuery();
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern Initializer initializer;
}
#define NODE_WANT_INTERNALS 1
// This embedding links OpenSSL and Intl, includes the full Amaro JS builtin,
// and has no V8 platform, inspector, SQLite, FFI or single-executable backend.
#define HAVE_OPENSSL 1
#define HAVE_INSPECTOR 0
#define NODE_USE_V8_PLATFORM 0
#define HAVE_FFI 0
#define HAVE_SQLITE 0
#define HAVE_AMARO 1
#define NODE_HAVE_I18N_SUPPORT 1
#define DISABLE_SINGLE_EXECUTABLE_APPLICATION 1
#define NODE_EXTERN_PRIVATE
#define NODE_EXTERN
#define CHECK(x) do { if (!(x)) __builtin_trap(); } while (false)
#define CHECK_EQ(x,y) CHECK((x)==(y))
#define CHECK_NE(x,y) CHECK((x)!=(y))
#define UNREACHABLE() __builtin_trap()
#define FIXED_ONE_BYTE_STRING(isolate,text) kandelo_node_options_api::String::NewFromUtf8Literal(isolate,text)
#define NODE_DEFINE_CONSTANT(target,name) kandelo_options_adapter::DefineConstant(target,#name,double(name))
#define THROW_ERR_OPTIONS_BEFORE_BOOTSTRAPPING(isolate,message) do { kandelo_options_adapter::ThrowOptionsBeforeBootstrap(isolate,message); return; } while(false)
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name,callback) namespace kandelo_options_adapter { Initializer initializer=::callback; }
#define NODE_BINDING_EXTERNAL_REFERENCE(name,callback)
#endif
