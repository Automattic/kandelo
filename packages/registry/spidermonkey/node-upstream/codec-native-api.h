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

namespace kandelo_node_codec_api {
class Value; class Object; class String; class Isolate;
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
class Integer : public Value { public: using Value::Value;static Local<Integer> New(Isolate*,int); };
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
template<class T> class ReturnValue {
  Isolate* isolate_;
 public: explicit ReturnValue(Isolate* isolate):isolate_(isolate) {}
  void Set(Local<T> value) const { Return(isolate_,value); }
};
template<class T> class FunctionCallbackInfo {
  Isolate* isolate_;
 public:
  explicit FunctionCallbackInfo(Isolate* isolate):isolate_(isolate) {}
  Isolate* GetIsolate() const { return isolate_; }
  Local<Value> operator[](int index) const { return Argument(isolate_,index); }
  ReturnValue<T> GetReturnValue() const { return ReturnValue<T>(isolate_); }
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
  size_t length() const;void SetLength(size_t);void AllocateSufficientStorage(size_t);
  bool IsAllocated() const;void Release();
};
template<class T> T* UncheckedMalloc(size_t);
inline constexpr bool IsBigEndian() { return std::endian::native==std::endian::big; }
class TwoByteValue : public MaybeStackBuffer<uint16_t> {
 public: explicit TwoByteValue(Isolate*,Local<Value>);
};
struct SpanOwner;
template<class T,size_t N=64> class ArrayBufferViewContents {
  std::unique_ptr<SpanOwner> owner_;
 public:
  explicit ArrayBufferViewContents(Local<ArrayBufferView>);~ArrayBufferViewContents();
  T* data() const;size_t length() const;
};
class Environment {
 public: static Environment* GetCurrent(Local<Context>);Isolate* isolate();
};
Local<Value> ERR_STRING_TOO_LONG(Isolate*);
Local<Value> ERR_BUFFER_TOO_LARGE(Isolate*);
Local<Value> ERR_MEMORY_ALLOCATION_FAILED(Isolate*);
void SetMethod(Local<Context>,Local<Object>,const char*,void(*)(const FunctionCallbackInfo<Value>&));
class ExternalReferenceRegistry { public: template<class T> void Register(T); };
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
#endif
