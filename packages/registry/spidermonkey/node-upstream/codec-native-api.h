#ifndef KANDELO_CODEC_API_H
#define KANDELO_CODEC_API_H
// Private marshalling API for complete original native decoder/StringBytes.
// Definitions operate on actual rooted SpiderMonkey values and owned bytes.
#include <algorithm>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <utility>

namespace kandelo_node_codec_api {
class Value; class Object; class String; class Isolate; class ObjectTemplate; class FunctionTemplate;
struct Cell; struct Frame; struct View; struct MemoryAccount; struct State;
[[noreturn]] void Crash(const char*);
template<class T> class Local {
  T* pointer_ = nullptr;
 public:
  Local() = default;
  explicit Local(T* pointer):pointer_(pointer) {}
  template<class U> Local(Local<U> input):pointer_(input.get()) {}
  T* get() const { return pointer_; }
  T* operator->() const { return pointer_; }
  bool IsEmpty() const { return !pointer_; }
  template<class U> Local<U> As() const { return Local<U>(static_cast<U*>(pointer_)); }
};
template<class T> class MaybeLocal {
  Local<T> value_;
 public:
  MaybeLocal() = default;
  template<class U> MaybeLocal(Local<U> value):value_(value) {}
  template<class U> MaybeLocal(MaybeLocal<U> value):value_(value.FromMaybe(Local<U>())) {}
  bool IsEmpty() const { return value_.IsEmpty(); }
  bool ToLocal(Local<T>* out) const { *out=value_; return !IsEmpty(); }
  Local<T> ToLocalChecked() const { if(IsEmpty()) Crash("Empty native codec local"); return value_; }
  template<class U> Local<U> FromMaybe(Local<U> fallback) const { return IsEmpty()?fallback:Local<U>(value_); }
};
template<class T> class Maybe {
  bool present_=false;T value_{};
 public:
  Maybe()=default;
  explicit Maybe(T value):present_(true),value_(value) {}
  bool To(T* out) const { if(present_) *out=value_;return present_; }
  T FromJust() const { if(!present_) Crash("Empty native codec result");return value_; }
  T FromMaybe(T fallback) const { return present_?value_:fallback; }
  void Check() const { if(!present_ || !value_) Crash("Failed native codec result"); }
};
template<> class Maybe<void> {
  bool present_=false;
 public:
  Maybe()=default;
  explicit Maybe(bool present):present_(present) {}
  bool IsNothing() const { return !present_; }
};
template<class T> Maybe<T> Just(T value) { return Maybe<T>(value); }
template<class T> Maybe<T> Nothing() { return {}; }
inline Maybe<void> JustVoid() { return Maybe<void>(true); }
struct Context { Isolate* isolate; };
class Value {
  std::unique_ptr<Cell> cell_;
 public:
  explicit Value(std::unique_ptr<Cell>);
  virtual ~Value();
  Cell& cell() const;
  bool IsString() const;
  bool IsArrayBufferView() const;
  bool IsArrayBuffer() const;
  bool IsSharedArrayBuffer() const;
  bool IsInt32() const;
  bool IsUint32() const;
  bool IsBoolean() const;
  bool IsTrue() const;
  Maybe<uint32_t> Uint32Value(Local<Context>);
  MaybeLocal<String> ToString(Local<Context>);
};
class Object : public Value {
 public:
  using Value::Value;
  Maybe<bool> Set(Local<Context>,Local<Value>,Local<Value>);
};
class Array : public Object {
 public:
  using Object::Object;
  static Local<Array> New(Isolate*);
  Maybe<bool> Set(Local<Context>,int32_t,Local<Value>);
};
class ArrayBufferView : public Object { public: using Object::Object; };
class ArrayBuffer : public Object { public: using Object::Object; };
class Uint8Array : public ArrayBufferView {
 public:
  using ArrayBufferView::ArrayBufferView;
  static const size_t kMaxLength;
};
class Integer : public Value { public: using Value::Value;static Local<Integer> New(Isolate*,int);int64_t Value() const; };
using Int32=Integer;
using Uint32=Integer;
class ObjectTemplate : public Object {
 public: using Object::Object;
  void SetInternalFieldCount(int);
  MaybeLocal<Object> NewInstance(Local<Context>);
};
class FunctionTemplate : public Object {
 public: using Object::Object;
  Local<ObjectTemplate> InstanceTemplate();
  void SetClassName(Local<String>);
};
enum class NewStringType { kNormal };
class String : public Value {
 public:
  using Value::Value;
  static const size_t kMaxLength;
  class ExternalOneByteStringResource {
   public: virtual ~ExternalOneByteStringResource()=default;
    virtual const char* data() const=0;virtual size_t length() const=0;
  };
  class ExternalStringResource {
   public: virtual ~ExternalStringResource()=default;
    virtual const uint16_t* data() const=0;virtual size_t length() const=0;
  };
  class ValueView {
    std::unique_ptr<View> view_;
   public:
    ValueView(Isolate*,Local<String>);~ValueView();
    bool is_one_byte() const;size_t length() const;
    const uint8_t* data8() const;const uint16_t* data16() const;
  };
  enum class WriteFlags { kReplaceInvalidUtf8 };
  static Local<String> Empty(Isolate*);
  static Local<String> Concat(Isolate*,Local<String>,Local<String>);
  static MaybeLocal<String> NewFromUtf8(Isolate*,const char*,NewStringType,int);
  static MaybeLocal<String> NewFromOneByte(Isolate*,const uint8_t*,NewStringType,int);
  static MaybeLocal<String> NewFromTwoByte(Isolate*,const uint16_t*,NewStringType,int);
  static MaybeLocal<String> NewExternalOneByte(Isolate*,ExternalOneByteStringResource*);
  static MaybeLocal<String> NewExternalTwoByte(Isolate*,ExternalStringResource*);
  size_t Length() const;
  void WriteV2(Isolate*,size_t,size_t,uint16_t*);
  size_t WriteUtf8V2(Isolate*,char*,size_t,WriteFlags);
};
class Isolate {
 public:
  std::weak_ptr<State> owner;
  Context context{this};
  Local<Context> GetCurrentContext();
  void ThrowException(Local<Value>);
};
class HandleScope {
  Frame* frame_;size_t previous_;
 public: explicit HandleScope(Isolate*);~HandleScope();
};
class ExternalMemoryAccounter {
  std::unique_ptr<MemoryAccount> account_;
 public:
  ExternalMemoryAccounter();~ExternalMemoryAccounter();
  void Increase(Isolate*,size_t);void Decrease(Isolate*,size_t);
};
Local<Value> Argument(Isolate*,int);
void Return(Isolate*,Local<Value>);
void ReturnNumber(Isolate*,double);
void ReturnBoolean(Isolate*,bool);
int ArgumentCount(Isolate*);
template<class T> class ReturnValue {
  Isolate* isolate_;
 public: explicit ReturnValue(Isolate* isolate):isolate_(isolate) {}
  void Set(Local<T> value) const { Return(isolate_,value); }
  void Set(bool value) const { ReturnBoolean(isolate_,value); }
  void Set(int32_t value) const { ReturnNumber(isolate_,value); }
  void Set(uint32_t value) const { ReturnNumber(isolate_,value); }
};
template<class T> class FunctionCallbackInfo {
  Isolate* isolate_;
 public:
  explicit FunctionCallbackInfo(Isolate* isolate):isolate_(isolate) {}
  Isolate* GetIsolate() const { return isolate_; }
  int Length() const { return ArgumentCount(isolate_); }
  Local<Value> operator[](int index) const { return Argument(isolate_,index); }
  ReturnValue<T> GetReturnValue() const { return ReturnValue<T>(isolate_); }
};
struct CatchScope;
class TryCatch {
  std::unique_ptr<CatchScope> scope_;
 public: explicit TryCatch(Isolate*);~TryCatch();
};
}
namespace kandelo_node_codec_impl {
using namespace kandelo_node_codec_api;
template<class T,size_t N=1024> class MaybeStackBuffer {
  T stack_[N];T* data_=stack_;size_t length_=0,capacity_=N;
 public:
  MaybeStackBuffer();explicit MaybeStackBuffer(size_t);~MaybeStackBuffer();
  MaybeStackBuffer(const MaybeStackBuffer&)=delete;
  T* out();const T* out() const;T* operator*();
  T& operator[](size_t index) { CHECK_INDEX(index);return data_[index]; }
  const T& operator[](size_t index) const { CHECK_INDEX(index);return data_[index]; }
  const T* operator*() const { return data_; }
  size_t length() const;void SetLength(size_t);void AllocateSufficientStorage(size_t);
  bool IsAllocated() const;void Release();
  bool IsInvalidated() const { return data_==nullptr; }
  void Invalidate() { if(IsAllocated()) Crash("Invalidate allocated native storage");data_=nullptr;length_=0;capacity_=0; }
 private: void CHECK_INDEX(size_t index) const { if(index>=length_) Crash("Native stack buffer index"); }
};
template<class T> T* UncheckedMalloc(size_t);
inline constexpr bool IsBigEndian() { return std::endian::native==std::endian::big; }
class TwoByteValue : public MaybeStackBuffer<uint16_t> {
 public: explicit TwoByteValue(Isolate*,Local<Value>);
};
class Utf8Value : public MaybeStackBuffer<char> {
 public: explicit Utf8Value(Isolate*,Local<Value>);
};
struct SpanOwner;
template<class T,size_t N=64> class ArrayBufferViewContents {
  std::unique_ptr<SpanOwner> owner_;
 public:
  explicit ArrayBufferViewContents(Local<ArrayBufferView>);~ArrayBufferViewContents();
  explicit ArrayBufferViewContents(Local<Value>);
  T* data() const;size_t length() const;
};
class Environment {
 public: static Environment* GetCurrent(Local<Context>);
  static Environment* GetCurrent(const FunctionCallbackInfo<Value>&);
  Isolate* isolate();Local<Context> context();Local<ObjectTemplate> i18n_converter_template();
};
class IsolateData {
 public: Isolate* isolate();void set_i18n_converter_template(Local<ObjectTemplate>);
};
struct NativeObjectOwner;
class BaseObject {
  std::unique_ptr<NativeObjectOwner> owner_;
 public:
  static constexpr int kInternalFieldCount=2;
  BaseObject(Environment*,Local<Object>);virtual ~BaseObject();
  void MakeWeak();static BaseObject* Unwrap(Local<Object>);
};
template<class T> bool Unwrap(T** output,Local<Object> object) {
  *output=static_cast<T*>(BaseObject::Unwrap(object));return *output!=nullptr;
}
template<class T> class ScopeLeave {
  T callback_;
 public: explicit ScopeLeave(T callback):callback_(std::move(callback)){}~ScopeLeave(){callback_();}
  ScopeLeave(const ScopeLeave&)=delete;
};
template<class T> auto OnScopeLeave(T callback) { return ScopeLeave<T>(std::move(callback)); }
Local<String> OneByteString(Isolate*,const char*);
Local<FunctionTemplate> NewFunctionTemplate(Isolate*,std::nullptr_t);
bool StringEqualNoCase(const char*,const char*);
void THROW_ERR_INVALID_ARG_TYPE(Isolate*,const char*);
void THROW_ERR_ENCODING_INVALID_ENCODED_DATA(Isolate*,const char*,const char*);
namespace Buffer {
MaybeLocal<Object> MissingAllocation(Environment*);
template<class T,size_t N> MaybeLocal<Object> New(Environment* env,MaybeStackBuffer<T,N>*) { return MissingAllocation(env); }
}
Local<Value> ERR_STRING_TOO_LONG(Isolate*);
Local<Value> ERR_BUFFER_TOO_LARGE(Isolate*);
Local<Value> ERR_MEMORY_ALLOCATION_FAILED(Isolate*);
void SetMethod(Local<Context>,Local<Object>,const char*,void(*)(const FunctionCallbackInfo<Value>&));
void SetMethod(Isolate*,Local<ObjectTemplate>,const char*,void(*)(const FunctionCallbackInfo<Value>&));
class ExternalReferenceRegistry {
 public:
  void Register(void(*)(const FunctionCallbackInfo<Value>&)) { Crash("Native snapshot external-reference registry is not implemented"); }
  template<class T> void Register(T);
};
}
namespace kandelo_icu_adapter {
using namespace kandelo_node_codec_api;
using PerIsolateInitializer=void(*)(kandelo_node_codec_impl::IsolateData*,Local<ObjectTemplate>);
using ContextInitializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern PerIsolateInitializer initializer;
extern ContextInitializer context_initializer;
}
namespace kandelo_codec_adapter {
using namespace kandelo_node_codec_api;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern Initializer initializer;
}
#define NODE_WANT_INTERNALS 1
#define NODE_EXTERN
#define CHECK(x) do { if(!(x)) kandelo_node_codec_api::Crash(#x); } while(false)
#define CHECK_EQ(x,y) CHECK((x)==(y))
#define CHECK_NE(x,y) CHECK((x)!=(y))
#define CHECK_LE(x,y) CHECK((x)<=(y))
#define CHECK_LT(x,y) CHECK((x)<(y))
#define CHECK_GE(x,y) CHECK((x)>=(y))
#define CHECK_NOT_NULL(x) CHECK((x)!=nullptr)
#ifdef DEBUG
#define DCHECK(x) CHECK(x)
#define DCHECK_EQ(x,y) CHECK_EQ(x,y)
#define DCHECK_LT(x,y) CHECK_LT(x,y)
#else
#define DCHECK(x) ((void)0)
#define DCHECK_EQ(x,y) ((void)0)
#define DCHECK_LT(x,y) ((void)0)
#endif
#define UNREACHABLE(...) kandelo_node_codec_api::Crash("Unreachable original codec operation")
#define FIXED_ONE_BYTE_STRING(isolate,text) kandelo_node_codec_api::String::NewFromOneByte(isolate,reinterpret_cast<const uint8_t*>(text),kandelo_node_codec_api::NewStringType::kNormal,sizeof(text)-1).ToLocalChecked()
#define NODE_BINDING_CONTEXT_AWARE_INTERNAL(name,callback) namespace kandelo_codec_adapter { Initializer initializer=::callback; }
#define NODE_BINDING_EXTERNAL_REFERENCE(name,callback)
#define ABORT() kandelo_node_codec_api::Crash("Original native abort")
#define ASSIGN_OR_RETURN_UNWRAP(output,object) do { if(!kandelo_node_codec_impl::Unwrap(output,object)) return; } while(false)
#define SET_NO_MEMORY_INFO()
#define SET_MEMORY_INFO_NAME(name)
#define SET_SELF_SIZE(name)
#define SPREAD_BUFFER_ARG(value,name) \
  char* name##_data=kandelo_node_codec_impl::Buffer::Data(value); \
  size_t name##_length=kandelo_node_codec_impl::Buffer::Length(value)
#endif
