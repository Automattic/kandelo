#ifndef KANDELO_CODEC_API_H
#define KANDELO_CODEC_API_H
// Private marshalling API for complete original native decoder/StringBytes.
// Definitions operate on actual rooted SpiderMonkey values and owned bytes.
#include <algorithm>
#include <bit>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <limits>
#include <list>
#include <memory>
#include <set>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <uv.h>
#include <vector>
#include "js/TypeDecls.h"
#ifndef NODE_WANT_INTERNALS
#define NODE_WANT_INTERNALS 1
#endif
#include "node-env-properties.h"

namespace kandelo::node { struct TraceProcess; }
namespace node {
struct LibuvMutexTraits;
template<class Traits> class MutexBase;
template<class T,class MutexT> class ExclusiveAccess;
}
namespace kandelo_node_codec_api {
class ArrayBuffer; class SharedArrayBuffer; class Value; class Name; class Object; class String; class Function; class Isolate; class ObjectTemplate; class FunctionTemplate;class Array;
struct NamedPropertyHandlerConfiguration;struct IndexedPropertyHandlerConfiguration;
class Message;class StackTrace;class Symbol;class Private;class MicrotaskQueue;
enum class WeakCallbackType {kParameter};
template<class T> class WeakCallbackInfo {
 public: Isolate* GetIsolate() const;T* GetParameter() const;
};
template<class T> class PropertyCallbackInfo;
struct Cell; struct Frame; struct View; struct MemoryAccount; struct State; struct Context; struct ContextScopeData; struct StartupData;
struct HeapStatisticsData;
class HeapStatistics {
  std::unique_ptr<HeapStatisticsData> data_;
 public:
  HeapStatistics();~HeapStatistics();
  size_t total_heap_size() const;size_t used_heap_size() const;size_t external_memory() const;
};
enum class EmbedderDataTag { kDefault };
[[noreturn]] void Crash(const char*);
bool SameLocal(Value*,Value*);
bool SameLocal(Context*,Context*);
template<class T> class Local {
  T* pointer_ = nullptr;
 public:
  Local() = default;
  explicit Local(T* pointer):pointer_(pointer) {}
  template<class U> Local(Local<U> input):pointer_(input.get()) {}
  T* get() const { return pointer_; }
  T* operator->() const { return pointer_; }
  T* operator*() const { return pointer_; }
  bool IsEmpty() const { return !pointer_; }
  template<class U> bool operator==(Local<U> other) const { return SameLocal(pointer_,other.get()); }
  template<class U> Local<U> As() const { return Local<U>(static_cast<U*>(pointer_)); }
};
template<class T> class MaybeLocal {
  Local<T> value_;
 public:
  MaybeLocal() = default;
  template<class U> MaybeLocal(Local<U> value):value_(value) {}
  template<class U> MaybeLocal(MaybeLocal<U> value):value_(value.FromMaybe(Local<U>())) {}
  bool IsEmpty() const { return value_.IsEmpty(); }
  template<class U> bool ToLocal(Local<U>* out) const { *out=value_; return !IsEmpty(); }
  Local<T> ToLocalChecked() const { if(IsEmpty()) Crash("Empty native codec local"); return value_; }
  template<class U> Local<U> FromMaybe(Local<U> fallback) const { return IsEmpty()?fallback:Local<U>(value_); }
};
template<class T> class Maybe {
  bool present_=false;T value_{};
 public:
  Maybe()=default;
  explicit Maybe(T value):present_(true),value_(value) {}
  bool To(T* out) const { if(present_) *out=value_;return present_; }
  bool IsNothing() const { return !present_; }
  bool IsJust() const { return present_; }
  T FromJust() const { if(!present_) Crash("Empty native codec result");return value_; }
  T ToChecked() const { return FromJust(); }
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
struct Context {
  Isolate* isolate;
  std::unique_ptr<Cell> global;
  Context(Isolate*,std::unique_ptr<Cell>);
  ~Context();
  class Scope {
    std::unique_ptr<ContextScopeData> data_;
   public:
    explicit Scope(Local<Context>);~Scope();
  };
  Local<Object> Global();
  Local<Object> GetExtrasBindingObject();
  MicrotaskQueue* GetMicrotaskQueue();
  int GetNumberOfEmbedderDataFields();Local<Value> GetEmbedderData(int);
  template<class T> MaybeLocal<T> GetDataFromSnapshotOnce(size_t) {
    Crash("Native heap snapshot deserialization is not implemented");
  }
};
class SnapshotCreator {
 public:
  SnapshotCreator()=delete;
  template<class T> size_t AddData(Local<Context>,Local<T>) {
    Crash("Native heap snapshot serialization is not implemented");
  }
};
class Value {
  std::unique_ptr<Cell> cell_;
 public:
  explicit Value(std::unique_ptr<Cell>);
  virtual ~Value();
  Cell& cell() const;
  bool IsObject() const;
  bool IsValue()const;bool IsPrivate()const;bool SameValue(Local<Value>)const;
  bool IsTypedArray() const;
  bool IsString() const;
  bool IsSymbol() const;
  bool IsArray() const;
  bool IsFunction() const;
  bool IsNumber() const;
  bool IsUndefined() const;
  bool IsNullOrUndefined() const;
  static double NumberValue(Value*);
  Maybe<double> NumberValue(Local<Context>);
  bool IsArrayBufferView() const;
  bool IsArrayBuffer() const;
  bool IsSharedArrayBuffer() const;
  bool IsInt32() const;
  bool IsUint32() const;
  bool IsBoolean() const;
  bool IsFloat64Array() const;
  bool IsTrue() const;
  bool IsFalse() const;bool IsNativeError() const;
  Maybe<int64_t> IntegerValue(Local<Context>);
  Maybe<int32_t> Int32Value(Local<Context>);
  Maybe<uint32_t> Uint32Value(Local<Context>);
  MaybeLocal<String> ToString(Local<Context>);
  MaybeLocal<Object> ToObject(Local<Context>);
  MaybeLocal<String> ToDetailString(Local<Context>);
};
class Name : public Value { public: using Value::Value; };
class Symbol : public Name {public:using Name::Name;};
class Private : public Value {public:using Value::Value;Local<Value> Name();};
class MicrotaskQueue {public:void EnqueueMicrotask(Isolate*,void(*)(void*),void*);};
enum PropertyAttribute { None=0, ReadOnly=1, DontEnum=2, DontDelete=4 };
enum class SideEffectType { kHasSideEffect, kHasNoSideEffect, kHasSideEffectToReceiver };
using AccessorNameGetterCallback=void(*)(Local<Name>,const PropertyCallbackInfo<Value>&);
using AccessorNameSetterCallback=void(*)(Local<Name>,Local<Value>,const PropertyCallbackInfo<void>&);
std::unique_ptr<Value> RetainRoot(Isolate*,Local<Value>);
template<class T> std::unique_ptr<T> RetainTypedRoot(Isolate*,Local<T>);
// Typed independent roots survive temporary caller HandleScopes. Assignment
// replaces the actual retained cell instead of retaining an obsolete handle.
template<class T> class LocalVector {
  static_assert(std::is_same_v<T,Value>||std::is_same_v<T,Name>);
  Isolate* isolate_;
  std::vector<std::unique_ptr<T>> roots_;
  std::vector<Local<T>> values_;
  void Assign(size_t index,Local<T> value) {
    auto root=RetainTypedRoot<T>(isolate_,value);values_[index]=Local<T>(root.get());roots_[index]=std::move(root);
  }
 public:
  class Reference {
    LocalVector* owner_;size_t index_;
   public:
    Reference(LocalVector* owner,size_t index):owner_(owner),index_(index) {}
    Reference& operator=(Local<T> value){owner_->Assign(index_,value);return *this;}
    Reference& operator=(const Reference& value){return *this=Local<T>(value);}
    operator Local<T>()const{return owner_->values_[index_];}
    T* operator->()const{return owner_->values_[index_].get();}
  };
  explicit LocalVector(Isolate* isolate,size_t size=0):isolate_(isolate),roots_(size),values_(size) {}
  Reference operator[](size_t index){return Reference(this,index);}
  Local<T> operator[](size_t index)const{return values_[index];}
  void push_back(Local<T> value) {
    auto root=RetainTypedRoot<T>(isolate_,value);
    values_.emplace_back(root.get());roots_.push_back(std::move(root));
  }
  void emplace_back(Local<T> value) { push_back(value); }
  Local<T>* data() { return values_.data(); }
  const Local<T>* data()const{return values_.data();}
  void reserve(size_t size){roots_.reserve(size);values_.reserve(size);}
  size_t size() const { return values_.size(); }
};
struct GlobalRoot;
std::shared_ptr<GlobalRoot> NewGlobalRoot(Isolate*,Local<Value>);
Local<Value> ReadGlobalRoot(Isolate*,const std::shared_ptr<GlobalRoot>&);
void MakeGlobalWeak(Isolate*,const std::shared_ptr<GlobalRoot>&);
void MakeGlobalStrong(Isolate*,const std::shared_ptr<GlobalRoot>&);
void MakeGlobalWeakTenured(Isolate*,const std::shared_ptr<GlobalRoot>&);
bool GlobalRootIsWeak(const std::shared_ptr<GlobalRoot>&);
bool GlobalRootIsEmpty(const std::shared_ptr<GlobalRoot>&);
JSObject* BorrowGlobalObject(const std::shared_ptr<GlobalRoot>&);
template<class T> class Global {
  Isolate* isolate_=nullptr;
  std::shared_ptr<GlobalRoot> value_;
 public:
  Global()=default;
  Global(Isolate* isolate,Local<T> value) { Reset(isolate,value); }
  Global(const Global&)=delete;Global& operator=(const Global&)=delete;
  Global(Global&&)=default;Global& operator=(Global&&)=default;
  bool IsEmpty() const { return GlobalRootIsEmpty(value_); }
  void Reset(Isolate* isolate,Local<T> value) { if(value.IsEmpty()){Reset();return;}isolate_=isolate;value_=NewGlobalRoot(isolate,value); }
  void Reset() { value_.reset();isolate_=nullptr; }
  void SetWeak() { MakeGlobalWeak(isolate_,value_); }
  template<class P> void SetWeak(P*,void(*)(const WeakCallbackInfo<P>&),WeakCallbackType);
  void ClearWeak() { MakeGlobalStrong(isolate_,value_); }
  void SetWeakTenured() { MakeGlobalWeakTenured(isolate_,value_); }
  bool IsWeak()const{return GlobalRootIsWeak(value_);}
  Local<T> Get(Isolate* isolate) const { return ReadGlobalRoot(isolate,value_).template As<T>(); }
  JSObject* BorrowObject() const { return BorrowGlobalObject(value_); }
};
class Object : public Value {
 public:
  using Value::Value;
  static Local<Object> New(Isolate*);
  static Local<Object> New(Isolate*,Local<Value>,Local<Name>*,Local<Value>*,size_t);
  MaybeLocal<Array> GetOwnPropertyNames(Local<Context>);
  MaybeLocal<Value> GetPrivate(Local<Context>,Local<Value>);
  Local<String> GetConstructorName();
  Maybe<bool> DefineOwnProperty(Local<Context>,Local<Name>,Local<Value>,PropertyAttribute=None);
  void* GetAlignedPointerFromInternalField(int,EmbedderDataTag);
  Local<Value> GetInternalField(int);void SetInternalField(int,Local<Value>);
  Maybe<bool> Set(Local<Context>,Local<Value>,Local<Value>);
  Maybe<bool> SetPrivate(Local<Context>,Local<Value>,Local<Value>);
  Maybe<bool> SetPrototypeV2(Local<Context>,Local<Object>);
  MaybeLocal<Value> Get(Local<Context>,Local<Value>);
  Maybe<bool> SetNativeDataProperty(
      Local<Context>,Local<Name>,AccessorNameGetterCallback,
      AccessorNameSetterCallback=nullptr,Local<Value> = {},
      PropertyAttribute=None,
      SideEffectType=SideEffectType::kHasSideEffect,
      SideEffectType=SideEffectType::kHasSideEffect);
};
class Function : public Object {
 public: using Object::Object;
  MaybeLocal<Value> Call(Local<Context>,Local<Value>,int,Local<Value>*);
  MaybeLocal<Object> NewInstance(Local<Context>);
};
class Array : public Object {
 public:
  using Object::Object;
  static Local<Array> New(Isolate*);
  static Local<Array> New(Isolate*,const Local<Value>*,size_t);
  Maybe<bool> Set(Local<Context>,int32_t,Local<Value>);
  uint32_t Length() const;
  MaybeLocal<Value> Get(Local<Context>,uint32_t);
};
class ArrayBufferView : public Object {
 public: using Object::Object;
  Local<ArrayBuffer> Buffer();size_t ByteOffset() const;size_t ByteLength() const;
};
enum class BackingStoreInitializationMode { kZeroInitialized, kUninitialized };
enum class BackingStoreOnFailureMode { kReturnNull };
struct BackingStore {
  using DeleterCallback=void(*)(void*,size_t,void*);
  void* Data() const { return data; }
  size_t ByteLength() const { return size; }
  void* data; size_t size; void(*deleter)(void*,size_t,void*); void* userData;
  std::shared_ptr<kandelo::node::TraceProcess> process;
  BackingStore(void*,size_t,void(*)(void*,size_t,void*),void*,std::shared_ptr<kandelo::node::TraceProcess>);
  BackingStore(const BackingStore&)=delete;
  ~BackingStore();
};
class ArrayBuffer : public Object {
 public: using Object::Object;
  static std::unique_ptr<BackingStore> NewBackingStore(void*,size_t,void(*)(void*,size_t,void*),void*);
  static std::unique_ptr<BackingStore> NewBackingStore(Isolate*,size_t,BackingStoreInitializationMode,BackingStoreOnFailureMode);
  static Local<ArrayBuffer> New(Isolate*,std::unique_ptr<BackingStore>);
  static Local<ArrayBuffer> New(Isolate*,size_t);
  void* Data();size_t ByteLength() const;bool WasDetached() const;
  bool IsDetachable() const;bool IsImmutable() const;
  Maybe<bool> Detach(Local<Value>);void SetDetachKey(Local<Value>);
  size_t CopyArrayBufferBytes(size_t,size_t,Local<ArrayBuffer>,size_t);
};
class SharedArrayBuffer : public ArrayBuffer {
 public:using ArrayBuffer::ArrayBuffer;
  size_t CopyArrayBufferBytes(size_t,size_t,Local<SharedArrayBuffer>,size_t);
};
class TypedArray : public ArrayBufferView {
 public:using ArrayBufferView::ArrayBufferView;size_t Length() const;
};
class Uint8Array : public TypedArray {
 public:
  using TypedArray::TypedArray;
  static const size_t kMaxLength;
  static Local<Uint8Array> New(Local<ArrayBuffer>,size_t,size_t);
};
#define KANDELO_NATIVE_TYPED_ARRAYS(V) \
 V(Int8Array,Int8) V(Int16Array,Int16) V(Uint16Array,Uint16) \
 V(Int32Array,Int32) V(Uint32Array,Uint32) V(Float32Array,Float32) \
 V(Float64Array,Float64) V(BigInt64Array,BigInt64) V(BigUint64Array,BigUint64)
#define KANDELO_DECLARE_TYPED_ARRAY(Name,Scalar) \
 class Name : public TypedArray { public:using TypedArray::TypedArray; \
 static Local<Name> New(Local<ArrayBuffer>,size_t,size_t); };
KANDELO_NATIVE_TYPED_ARRAYS(KANDELO_DECLARE_TYPED_ARRAY)
#undef KANDELO_DECLARE_TYPED_ARRAY
class Number : public Value { public: using Value::Value;static Local<Number> New(Isolate*,double);double Value() const; };
class Integer : public Number { public: using Number::Number;static Local<Integer> New(Isolate*,int);static Local<Integer> NewFromUnsigned(Isolate*,uint32_t);int64_t Value() const; };
using Int32=Integer;
using Uint32=Integer;
class ObjectTemplate : public Object {
 public: using Object::Object;
  static Local<ObjectTemplate> New(Isolate*,Local<FunctionTemplate>);
  void SetHandler(const NamedPropertyHandlerConfiguration&);
  void SetHandler(const IndexedPropertyHandlerConfiguration&);
  void SetInternalFieldCount(int);
  MaybeLocal<Object> NewInstance(Local<Context>);
};
class FunctionTemplate : public Object {
 public: using Object::Object;
  static Local<FunctionTemplate> New(Isolate*);
  Local<ObjectTemplate> InstanceTemplate();
  MaybeLocal<Function> GetFunction(Local<Context>);
  void SetClassName(Local<String>);
  void Inherit(Local<FunctionTemplate>);
};
enum class NewStringType { kNormal };
class String : public Name {
 public:
  using Name::Name;
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
  static Local<String> NewFromUtf8Literal(Isolate*,const char*);
  static Local<String> Concat(Isolate*,Local<String>,Local<String>);
  static MaybeLocal<String> NewFromUtf8(Isolate*,const char*,NewStringType=NewStringType::kNormal,int=-1);
  static MaybeLocal<String> NewFromOneByte(Isolate*,const uint8_t*,NewStringType,int);
  static MaybeLocal<String> NewFromTwoByte(Isolate*,const uint16_t*,NewStringType,int);
  static MaybeLocal<String> NewExternalOneByte(Isolate*,ExternalOneByteStringResource*);
  static MaybeLocal<String> NewExternalTwoByte(Isolate*,ExternalStringResource*);
  bool IsOneByte() const;bool ContainsOnlyOneByte() const;
  bool IsExternalOneByte() const;
  const ExternalOneByteStringResource* GetExternalOneByteStringResource() const;
  size_t Utf8LengthV2(Isolate*);
  void WriteOneByteV2(Isolate*,size_t,size_t,uint8_t*);
 private:
  mutable std::unique_ptr<ExternalOneByteStringResource> externalView_;
 public:
  size_t Length() const;
  size_t length() const { return Length(); }
  enum class Utf8EncodingFlag { kNullTerminate };
  static size_t Utf8Length(Isolate*,Local<String>);
  static size_t WriteUtf8(Isolate*,Local<String>,char*,size_t,Utf8EncodingFlag);
  void WriteV2(Isolate*,size_t,size_t,uint16_t*);
  size_t WriteUtf8V2(Isolate*,char*,size_t,WriteFlags);
};
struct Factory { Isolate* isolate; Local<Value> undefined_value(); };
class Isolate {
 public:
  static Isolate* GetCurrent();
  std::weak_ptr<State> owner;
  Factory factory_{this};
  Factory* factory() { return &factory_; }
  Local<Context> GetCurrentContext();
  Local<Value> GetContinuationPreservedEmbedderDataV2();
  void SetContinuationPreservedEmbedderDataV2(Local<Value>);
  void ThrowException(Local<Value>);
  void GetHeapStatistics(HeapStatistics*);
  static Isolate* TryGetCurrent();bool InContext();
  enum MessageErrorLevel{kMessageError=1,kMessageWarning=2};
  enum class TimeZoneDetection{kRedetect,kSkip};
  void DateTimeConfigurationChangeNotification(TimeZoneDetection);
};
Local<Value> Undefined(Isolate*);
Local<Value> Null(Isolate*);
class HandleScope {
 protected:
  Frame* frame_;size_t previous_,previousContexts_;
 public:
  Local<Value> EscapeRoot(Local<Value>);
  Local<Context> EscapeRoot(Local<Context>);
 public: explicit HandleScope(Isolate*);~HandleScope();
};
class EscapableHandleScope : public HandleScope {
  bool escaped_=false;
 public:
  using HandleScope::HandleScope;
  template<class T> Local<T> Escape(Local<T> value) {
    if(escaped_) Crash("Native handle scope escaped twice");escaped_=true;
    if constexpr(std::is_same_v<T,Context>)return EscapeRoot(Local<Context>(value));
    else return EscapeRoot(Local<Value>(value)).template As<T>();
  }
  template<class T> MaybeLocal<T> EscapeMaybe(MaybeLocal<T> value) {
    if(value.IsEmpty())return {};return Escape(value.ToLocalChecked());
  }
};
struct FastApiCallbackOptions { Isolate* isolate; };
struct FastOneByteString { const char* data; uint32_t length; };
// Retain the real native function and its C++ signature. SpiderMonkey invokes
// the original slow callback; these descriptors do not claim V8 JIT support.
class CFunction {
 public:
  struct Signature { virtual ~Signature()=default; };
  template<class F> struct TypedSignature final : Signature { F pointer;explicit TypedSignature(F f):pointer(f){} };
  std::shared_ptr<const Signature> signature;
  template<class F> static CFunction Make(F f) { return {std::make_shared<TypedSignature<F>>(f)}; }
};
class ExternalMemoryAccounter {
  std::unique_ptr<MemoryAccount> account_;
 public:
  explicit ExternalMemoryAccounter(bool keepOwner=true);~ExternalMemoryAccounter();
  void Increase(Isolate*,size_t);void Decrease(Isolate*,size_t);
};
Local<Value> Argument(Isolate*,int);
Local<Value> True(Isolate*);
Local<Value> False(Isolate*);
void Return(Isolate*,Local<Value>);
void ReturnNumber(Isolate*,double);
void ReturnBoolean(Isolate*,bool);
int ArgumentCount(Isolate*);
Local<Object> Receiver(Isolate*);
Local<Object> PropertyHolder(Isolate*);
Local<Value> PropertyData(Isolate*);
void ReturnRaw(Isolate*, const JS::Value&);
template<class T> class ReturnValue {
  Isolate* isolate_;
 public: explicit ReturnValue(Isolate* isolate):isolate_(isolate) {}
  void Set(Local<T> value) const { Return(isolate_,value); }
  void Set(bool value) const { ReturnBoolean(isolate_,value); }
  void Set(int32_t value) const { ReturnNumber(isolate_,value); }
  void Set(uint32_t value) const { ReturnNumber(isolate_,value); }
  void Set(double value) const { ReturnNumber(isolate_,value); }
  void Set(int64_t value) const { ReturnNumber(isolate_,double(value)); }
  void Set(uint64_t value) const { ReturnNumber(isolate_,double(value)); }
  void SetEmptyString() const { Return(isolate_,String::Empty(isolate_)); }
  void SetUndefined()const{Return(isolate_,Undefined(isolate_));}
};
template<class T> class FunctionCallbackInfo {
  Isolate* isolate_;
 public:
  explicit FunctionCallbackInfo(Isolate* isolate):isolate_(isolate) {}
  Isolate* GetIsolate() const { return isolate_; }
  int Length() const { return ArgumentCount(isolate_); }
  Local<Value> operator[](int index) const { return Argument(isolate_,index); }
  Local<Object> This() const { return Receiver(isolate_); }
  ReturnValue<T> GetReturnValue() const { return ReturnValue<T>(isolate_); }
};
// Consumed property callback interface. Interceptor-only operation/strictness
// information is not yet supplied by the engine primitive.
template<class T> class PropertyCallbackInfo {
  Isolate* isolate_;
 public:
  explicit PropertyCallbackInfo(Isolate* isolate):isolate_(isolate) {}
  Isolate* GetIsolate() const { return isolate_; }
  Local<Value> Data() const { return PropertyData(isolate_); }
  Local<Object> HolderV2() const { return PropertyHolder(isolate_); }
  ReturnValue<T> GetReturnValue() const { return ReturnValue<T>(isolate_); }
};
struct CatchScope;
class TryCatch {
  std::unique_ptr<CatchScope> scope_;
 public: explicit TryCatch(Isolate*);~TryCatch();
 bool HasCaught()const;bool HasTerminated()const;bool IsVerbose()const;bool CanContinue()const;
 Local<Value> Exception()const;Local<kandelo_node_codec_api::Message> Message()const;
 Local<Value> ReThrow();void Reset();void SetVerbose(bool);
};
class Exception {
 public: static Local<Value> Error(Local<String>);
 static Local<Message> CreateMessage(Isolate*,Local<Value>);
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
  void SetLengthAndZeroTerminate(size_t n) { if(n>=capacity_) Crash("Native terminator capacity");data_[n]=T{};length_=n; }
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
template<class A,class B> size_t MultiplyWithOverflowCheck(A a,B b) {
  size_t out;if(__builtin_mul_overflow(size_t(a),size_t(b),&out))Crash("Native allocation multiplication overflow");return out;
}
inline constexpr bool IsBigEndian() { return std::endian::native==std::endian::big; }
class TwoByteValue : public MaybeStackBuffer<uint16_t> {
 public: explicit TwoByteValue(Isolate*,Local<Value>);
};
class Utf8Value : public MaybeStackBuffer<char> {
 public: explicit Utf8Value(Isolate*,Local<Value>);
  std::string_view ToStringView() const { return {out(),length()}; }
  std::string ToString() const { return {out(),length()}; }
};
class BufferValue : public MaybeStackBuffer<char> {
 public:
  BufferValue(Isolate*,Local<Value>);
  std::string ToString() const { return {out(),length()}; }
};
struct SpanOwner;
template<class T,size_t N=64> class ArrayBufferViewContents {
  std::unique_ptr<SpanOwner> owner_;
 public:
  explicit ArrayBufferViewContents(Local<ArrayBufferView>);~ArrayBufferViewContents();
  explicit ArrayBufferViewContents(Local<Value>);
  T* data() const;size_t length() const;
};
class Environment;class IsolateData;class BaseObject;struct NativeRealmData;class KVStore;struct NativeEnvOptions;struct NativeEnvIsolateOptions;struct FatalIsolateOptions;
class EnabledDebugList;
class AsyncWrap;class ReqWrapBase;class HandleWrap;class NodeArrayBufferAllocator;
class ProcessImmediateInfo;
using Mutex=::node::MutexBase<::node::LibuvMutexTraits>;
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
  Isolate* isolate();Environment* env();Local<Context> context();
  Local<Object> owner();
  BaseObject* GetBindingRaw(size_t);void InstallBindingRaw(size_t,BaseObject*);
  template<class T> T* GetBindingData() { return static_cast<T*>(GetBindingRaw(size_t(T::binding_type_int))); }
  template<class T,class... Args> T* AddBindingData(Local<Object>,Args&&...);
  void RegisterObject(BaseObject*);void ForgetObject(BaseObject*);void RunCleanup();
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
  Isolate* isolate();Local<Context> context();Local<ObjectTemplate> i18n_converter_template();
  Realm* principal_realm();bool can_call_into_js() const;
  bool owns_process_state() const;bool has_run_bootstrapping_code() const;
  bool PrepareProcessInvocation();
  std::shared_ptr<KVStore> env_vars();std::shared_ptr<NativeEnvOptions> options();
  std::string GetCwd(const std::string&);
  bool EmitProcessEnvWarning();
  bool source_maps_enabled();void set_source_maps_enabled(bool);
  Local<Function> get_source_map_error_source();void set_get_source_map_error_source(Local<Function>);
  Local<Function> maybe_cache_generated_source_map();void set_maybe_cache_generated_source_map(Local<Function>);
  Local<Function> enhance_fatal_stack_before_inspector();Local<Function> enhance_fatal_stack_after_inspector();
  Local<Value> decorated_private_symbol();Local<Value> arrow_message_private_symbol();
  bool printed_error();void set_printed_error(bool);bool abort_on_uncaught_exception();
  Local<Object> process_object();ExitCode exit_code(ExitCode);
  EnabledDebugList* enabled_debug_list();
  void ThrowUVException(int,const char*,const char* = nullptr,const char* = nullptr,const char* = nullptr);
  void ThrowErrnoException(int,const char*,const char* = nullptr,const char* = nullptr);
  uv_loop_t* event_loop();
  std::list<ReqWrapBase*>* req_wrap_queue();
  std::list<HandleWrap*>* handle_wrap_queue();
  const int32_t* timeout_info();ProcessImmediateInfo* immediate_info();
  void Exit(ExitCode);void set_process_emit_warning_sync(Local<Function>);
  const std::vector<std::string>& argv();const std::vector<std::string>& exec_argv();
  const std::string& exec_path();ExclusiveAccess<HostPort>* inspector_host_port();
#define KANDELO_ENV_STRING_ACCESSOR(name, text) Local<String> name();
  PER_ISOLATE_STRING_PROPERTIES(KANDELO_ENV_STRING_ACCESSOR)
#undef KANDELO_ENV_STRING_ACCESSOR
  Local<Value> exit_info_private_symbol();
  struct ExitInfo {Local<Int32Array> GetJSArray();};
  ExitInfo exit_info();
  using EmbedderPreload=void(*)(Environment*,Local<Object>,Local<Function>);
  EmbedderPreload embedder_preload();void set_embedder_preload(EmbedderPreload);
  Local<Object> buffer_prototype_object();Local<Value> untransferable_object_private_symbol();
  IsolateData* isolate_data();void ThrowRangeError(const char*);
  void set_trace_category_state_function(Local<Function>);
  bool async_context_frame_enabled() const;
  AsyncHooks* async_hooks();double new_async_id();double get_default_trigger_async_id();
  double execution_async_id()const;uint64_t thread_id()const;
  Local<Symbol> owner_symbol();Local<Symbol> resource_symbol();
  Local<Private> empty_context_frame_sentinel_symbol();
#define KANDELO_ENV_ASYNC_HOOK(name) Local<Function> async_hooks_##name##_function();void set_async_hooks_##name##_function(Local<Function>);
  KANDELO_ENV_ASYNC_HOOK(init) KANDELO_ENV_ASYNC_HOOK(before)
  KANDELO_ENV_ASYNC_HOOK(after) KANDELO_ENV_ASYNC_HOOK(destroy)
  KANDELO_ENV_ASYNC_HOOK(promise_resolve)
#undef KANDELO_ENV_ASYNC_HOOK
  void set_async_hooks_callback_trampoline(Local<Function>);
  void ResetPromiseHooks(Local<Function>,Local<Function>,Local<Function>,Local<Function>);
  std::vector<double>* destroy_async_id_list();
  void AddCleanupHook(void(*)(void*),void*);void RemoveCleanupHook(void(*)(void*),void*);
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
 public: Isolate* isolate();void set_i18n_converter_template(Local<ObjectTemplate>);
  bool is_building_snapshot() const;
  NodeArrayBufferAllocator* node_allocator();
  std::shared_ptr<FatalIsolateOptions> options();
  Local<ObjectTemplate> env_proxy_template();void set_env_proxy_template(Local<ObjectTemplate>);
  void set_env_proxy_ctor_template(Local<FunctionTemplate>);
  Local<FunctionTemplate> async_wrap_ctor_template();
  void set_async_wrap_ctor_template(Local<FunctionTemplate>);
};
struct NativeObjectOwner;
class MemoryTracker;
class MemoryRetainer {
 public:
  virtual ~MemoryRetainer()=default;
  virtual size_t SelfSize() const=0;
  virtual const char* MemoryInfoName() const=0;
  virtual void MemoryInfo(MemoryTracker*) const=0;
};
class MemoryTracker {
 public: virtual ~MemoryTracker()=default;
  virtual void TrackField(const char*,const std::set<std::string>&)=0;
  template<class T> void TrackField(const char*,const T&) {
    Crash("Native heap snapshot traversal is not implemented");
  }
};
class BaseObject {
  std::unique_ptr<NativeObjectOwner> owner_;
 public:
  static constexpr int kInternalFieldCount=2;
  static constexpr int kSlot=0;
  BaseObject(Environment*,Local<Object>);virtual ~BaseObject();
  BaseObject(Realm*,Local<Object>);
  void MakeWeak();static BaseObject* Unwrap(Local<Object>);
  static BaseObject* UnwrapNativeBinding(Local<Object>);
  void ClearWeak();Local<Object> object() const;Realm* realm() const;
  Global<Object>& persistent();
  std::shared_ptr<BaseObject> AcquireNativeReference();
  bool HasNativeReference()const;bool IsWeakOrDetached()const;
  void RetireWrapper();virtual void OnGCCollect();
 private:
  void ReleaseNativeReference();
 public:
  void Detach();bool IsDetached() const;
  static Local<FunctionTemplate> MakeLazilyInitializedJSTemplate(Environment*,int=kInternalFieldCount);
  virtual bool is_snapshotable() const { return false; }
  Environment* env()const;
  // General native inspection remains unavailable. AsyncWrap supplies the
  // original provider-name and partial-construction implementations.
  virtual const char* MemoryInfoName()const {Crash("Native general type inspection is unavailable");}
  virtual bool IsDoneInitializing()const {Crash("Native general initialization inspection is unavailable");}
  virtual void MemoryInfo(MemoryTracker*) const { Crash("Native heap snapshot traversal is not implemented"); }
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
Local<FunctionTemplate> NewFunctionTemplate(Isolate*,void(*)(const FunctionCallbackInfo<Value>&));
void SetProtoMethod(Isolate*,Local<FunctionTemplate>,const char*,void(*)(const FunctionCallbackInfo<Value>&));
void SetConstructorFunction(Local<Context>,Local<Object>,const char*,Local<FunctionTemplate>);
MaybeLocal<Value> ToV8Value(Local<Context>,const std::string&,Isolate*);
MaybeLocal<Value> ToV8Value(Local<Context>,std::string_view);
bool StringEqualNoCase(const char*,const char*);
void THROW_ERR_INVALID_ARG_TYPE(Isolate*,const char*);
void THROW_ERR_ENCODING_INVALID_ENCODED_DATA(Isolate*,const char*,const char*);
namespace Buffer {
MaybeLocal<Object> New(Environment*,size_t);
MaybeLocal<Object> Copy(Environment*,const char*,size_t);
MaybeLocal<Object> New(Environment*,char*,size_t);
MaybeLocal<Object> New(Environment*,char*,size_t,void(*)(char*,void*),void*);
template<class T,size_t N> MaybeLocal<Object> New(Environment* env,MaybeStackBuffer<T,N>* value) {
  size_t bytes=value->length()*sizeof(T);auto* data=reinterpret_cast<char*>(value->out());
  if(!value->IsAllocated())return Copy(env,data,bytes);
  value->Release();return New(env,data,bytes);
}
}

Local<Value> ERR_STRING_TOO_LONG(Isolate*);
Local<Value> ERR_BUFFER_TOO_LARGE(Isolate*);
Local<Value> ERR_MEMORY_ALLOCATION_FAILED(Isolate*);
std::unique_ptr<BackingStore> AdoptIntoBackingStore(Isolate*,void*,size_t,BackingStore::DeleterCallback,void*);
Local<String> OneByteString(Isolate*,const uint8_t*,size_t);
void THROW_ERR_OUT_OF_RANGE(Environment*,const char*);
void THROW_ERR_BUFFER_OUT_OF_BOUNDS(Environment*,const char*);
void THROW_ERR_MEMORY_ALLOCATION_FAILED(Environment*);
void THROW_ERR_MEMORY_ALLOCATION_FAILED(Isolate*);
void THROW_ERR_BUFFER_CONTEXT_NOT_AVAILABLE(Isolate*);
void SetMethodNoSideEffect(Local<Context>,Local<Object>,const char*,void(*)(const FunctionCallbackInfo<Value>&));
void SetFastMethod(Local<Context>,Local<Object>,const char*,void(*)(const FunctionCallbackInfo<Value>&),const CFunction*);
void SetFastMethodNoSideEffect(Local<Context>,Local<Object>,const char*,void(*)(const FunctionCallbackInfo<Value>&),const CFunction*);
namespace per_process {
struct BufferOptions { bool zero_fill_all_buffers;bool report_on_fatalerror;std::shared_ptr<NativeEnvIsolateOptions> per_isolate; };
struct BufferOptionsAccess { const BufferOptions* operator->() const; };
inline const BufferOptionsAccess cli_options;
}
void SetMethod(Local<Context>,Local<Object>,const char*,void(*)(const FunctionCallbackInfo<Value>&));
void SetMethod(Isolate*,Local<ObjectTemplate>,const char*,void(*)(const FunctionCallbackInfo<Value>&));
class ExternalReferenceRegistry {
 public:
  void Register(void(*)(const FunctionCallbackInfo<Value>&)) { Crash("Native snapshot external-reference registry is not implemented"); }
  template<class T> void Register(T) { Crash("Native snapshot external-reference registry is not implemented"); }
};
}
namespace kandelo_trace_adapter {
using namespace kandelo_node_codec_api;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern Initializer initializer;
void IsTraceCategoryEnabled(const FunctionCallbackInfo<Value>&);
void Trace(const FunctionCallbackInfo<Value>&);
}
namespace kandelo_continuation_adapter {
using namespace kandelo_node_codec_api;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern Initializer initializer;
void Get(const FunctionCallbackInfo<Value>&);
void Set(const FunctionCallbackInfo<Value>&);
bool WithFrame(Isolate*,Local<Value>,const std::function<bool()>&);
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
namespace kandelo_buffer_adapter {
using namespace kandelo_node_codec_api;
using Initializer=void(*)(Local<Object>,Local<Value>,Local<Context>,void*);
extern Initializer initializer;
}
#define NODE_WANT_INTERNALS 1
#define NODE_EXTERN
#ifdef CHECK
#undef CHECK
#undef CHECK_EQ
#undef CHECK_NE
#undef CHECK_LE
#undef CHECK_LT
#undef CHECK_GE
#undef CHECK_GT
#undef CHECK_IMPLIES
#undef CHECK_NULL
#undef CHECK_NOT_NULL
#undef UNREACHABLE
#endif
#define CHECK(x) do { if(!(x)) kandelo_node_codec_api::Crash(#x); } while(false)
#define CHECK_EQ(x,y) CHECK((x)==(y))
#define CHECK_NE(x,y) CHECK((x)!=(y))
#define CHECK_LE(x,y) CHECK((x)<=(y))
#define CHECK_LT(x,y) CHECK((x)<(y))
#define CHECK_GE(x,y) CHECK((x)>=(y))
#define CHECK_GT(x,y) CHECK((x)>(y))
#define CHECK_IMPLIES(x,y) CHECK(!(x)||(y))
#define MUST_USE_RESULT __attribute__((warn_unused_result))
#define CHECK_NOT_NULL(x) CHECK((x)!=nullptr)
#ifdef DEBUG
#define DCHECK(x) CHECK(x)
#define DCHECK_EQ(x,y) CHECK_EQ(x,y)
#define DCHECK_LT(x,y) CHECK_LT(x,y)
#define DCHECK_GE(x,y) CHECK_GE(x,y)
#define DCHECK_LE(x,y) CHECK_LE(x,y)
#define DCHECK_NULL(x) CHECK((x)==nullptr)
#define DCHECK_NOT_NULL(x) CHECK_NOT_NULL(x)
#define DCHECK_IMPLIES(x,y) CHECK_IMPLIES(x,y)
#else
#define DCHECK(x) ((void)0)
#define DCHECK_EQ(x,y) ((void)0)
#define DCHECK_LT(x,y) ((void)0)
#define DCHECK_GE(x,y) ((void)0)
#define DCHECK_LE(x,y) ((void)0)
#define DCHECK_NULL(x) ((void)0)
#define DCHECK_NOT_NULL(x) ((void)0)
#define DCHECK_IMPLIES(x,y) ((void)0)
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
#define THROW_AND_RETURN_IF_NOT_BUFFER(env,value,name) \
  do { if(!(value)->IsArrayBufferView()) return kandelo_node_codec_impl::THROW_ERR_INVALID_ARG_TYPE((env)->isolate(), name " must be a buffer"); } while(false)
#define THROW_AND_RETURN_IF_NOT_STRING(env,value,name) \
  do { if(!(value)->IsString()) return kandelo_node_codec_impl::THROW_ERR_INVALID_ARG_TYPE((env)->isolate(), name " must be a string"); } while(false)
#define TRACK_V8_FAST_API_CALL(name) kandelo_node_codec_api::Crash("V8 fast JIT entry is unavailable in SpiderMonkey")
#define SPREAD_BUFFER_ARG(value,name) \
  char* name##_data=kandelo_node_codec_impl::Buffer::Data(value); \
  size_t name##_length=kandelo_node_codec_impl::Buffer::Length(value)
#include "shell/node-upstream/native-object-api.h"
#endif
