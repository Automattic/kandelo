#ifndef KANDELO_ENGINE_NATIVE_API_H
#define KANDELO_ENGINE_NATIVE_API_H
// Shared C++ source interface backed by SpiderMonkey. No Node policy owners,
// binding registration, permission state or tracing-process implementation.
#include <algorithm>
#include <array>
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
#include <mutex>
#include <optional>
#include <queue>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>
#include "engine-maybe-api.h"
#include "js/TypeDecls.h"
#include "js/String.h"
#include "v8-source-api/v8-microtask.h"
#include "engine-gc-api.h"
#include "engine-fast-call-config.h"
#include "engine-gc-callback-api.h"
#include "engine-property-enum-api.h"
#include "engine-string-flags.h"
namespace js { class NativeArrayBufferOwner; class SharedArrayRawBuffer; }

namespace v8 {
class ArrayBuffer; class SharedArrayBuffer; class Value; class Name; class Object; class String; class Function; class Isolate; class ObjectTemplate; class FunctionTemplate;class Array;class Promise;
struct NamedPropertyHandlerConfiguration;struct IndexedPropertyHandlerConfiguration;
class Primitive;class Number;class Integer;class Int32;class Uint32;class Boolean;class RegExp;class Proxy;class FixedArray;class PrimitiveArray;class Module;class ModuleRequest;class Script;class UnboundScript;class UnboundModuleScript;class ScriptOrigin;
class Message;class StackTrace;class StackFrame;class Symbol;class Private;class MicrotaskQueue;class ExtensionConfiguration;class HeapProfiler;
enum class WeakCallbackType {kParameter};
template<class T> class WeakCallbackInfo {
  Isolate* isolate_;
  T* parameter_;
 public:
  using Callback=void(*)(const WeakCallbackInfo<T>&);
  WeakCallbackInfo(Isolate* isolate,T* parameter):isolate_(isolate),parameter_(parameter) {}
  Isolate* GetIsolate() const { return isolate_; }
  T* GetParameter() const { return parameter_; }
};
template<class T> class PropertyCallbackInfo;
template<class T> class FunctionCallbackInfo;
using FunctionCallback=void(*)(const FunctionCallbackInfo<Value>&);
enum class ConstructorBehavior{kAllow,kThrow};
struct SpanOwner;struct Cell; struct Frame; struct View; struct MemoryAccount; struct State; struct Context; struct ContextScopeData; struct StartupData;
struct HeapStatisticsData;
class HeapStatistics {
  std::unique_ptr<HeapStatisticsData> data_;
  friend class Isolate;
 public:
  HeapStatistics();~HeapStatistics();
  size_t total_heap_size() const;size_t used_heap_size() const;size_t external_memory() const;
  size_t heap_size_limit()const;size_t total_heap_size_executable()const;
  size_t total_physical_size()const;size_t malloced_memory()const;
  size_t total_global_handles_size()const;size_t used_global_handles_size()const;
  size_t number_of_native_contexts()const;size_t number_of_detached_contexts()const;
  size_t does_zap_garbage()const;
  size_t total_available_size()const;size_t peak_malloced_memory()const;
  uint64_t total_allocated_bytes()const;

};
class HeapSpaceStatistics {
  const char* name_=nullptr;
  size_t size_=0,used_=0,available_=0,physical_=0;
  friend class Isolate;
 public:
  const char* space_name()const{return name_;}
  size_t space_size()const{return size_;}
  size_t space_used_size()const{return used_;}
  size_t space_available_size()const{return available_;}
  size_t physical_space_size()const{return physical_;}
};
class HeapCodeStatistics {
  size_t code_=0,bytecode_=0,source_=0,profiler_=0;
  friend class Isolate;
 public:
  size_t code_and_metadata_size()const{return code_;}
  size_t bytecode_and_metadata_size()const{return bytecode_;}
  size_t external_script_source_size()const{return source_;}
  size_t cpu_profiler_metadata_size()const{return profiler_;}
};
using EmbedderDataTypeTag=uint16_t;
inline constexpr EmbedderDataTypeTag kEmbedderDataTypeTagDefault=0;
using ExternalPointerTypeTag=uint16_t;
inline constexpr ExternalPointerTypeTag kExternalPointerTypeTagDefault=0;
[[noreturn]] void Crash(const char*);
class Data;
bool SameLocal(Data*,Data*);
bool SameLocal(Context*,Context*);
template<class T> class PersistentBase;
template<class T> class Local {
  T* pointer_ = nullptr;
 public:
  Local() = default;
  explicit Local(T* pointer):pointer_(pointer) {}
  template<class U> requires std::is_base_of_v<T,U>
  Local(Local<U> input):pointer_(input.get()) {}
  T* get() const { return pointer_; }
  T* operator->() const { return pointer_; }
  T* operator*() const { return pointer_; }
  bool IsEmpty() const { return !pointer_; }
  void Clear(){pointer_=nullptr;}
  template<class U> bool operator==(Local<U> other) const { return SameLocal(pointer_,other.get()); }
  template<class U> bool operator==(const PersistentBase<U>& other)const{return other==*this;}
  template<class U> Local<U> As() const;
  static Local<T> New(Isolate*,const PersistentBase<T>&);
};
template<class T> class MaybeLocal {
  Local<T> value_;
 public:
  MaybeLocal() = default;
  template<class U> requires std::is_base_of_v<T,U>
  MaybeLocal(Local<U> value):value_(value) {}
  template<class U> requires std::is_base_of_v<T,U>
  MaybeLocal(MaybeLocal<U> value):value_(value.FromMaybe(Local<U>())) {}
  bool IsEmpty() const { return value_.IsEmpty(); }
  template<class U> bool ToLocal(Local<U>* out) const { *out=value_; return !IsEmpty(); }
  Local<T> ToLocalChecked() const { if(IsEmpty()) Crash("Empty native codec local"); return value_; }
  template<class U> Local<U> FromMaybe(Local<U> fallback) const { return IsEmpty()?fallback:Local<U>(value_); }
  template<class U> MaybeLocal<U> As()const{return value_.template As<U>();}
};
class JSON {public:static MaybeLocal<String> Stringify(Local<Context>,Local<Value>);};
// Borrowed startup-blob transport only. V8 heap operations are explicitly
// unavailable in the approved fresh-start profile, never a successful no-op.
struct StartupData {
  const char* data;
  int raw_size;
  bool CanBeRehashed()const{Crash("V8 startup snapshot rehashing is unavailable");}
  bool IsValid()const{Crash("V8 startup snapshot validation is unavailable");}
};
struct DeserializeInternalFieldsCallback {
  using Callback=void(*)(Local<Object>,int,StartupData,void*);
  Callback callback=nullptr;void* data=nullptr;
  explicit DeserializeInternalFieldsCallback(Callback fn=nullptr,void* input=nullptr):callback(fn),data(input){}
};
struct DeserializeContextDataCallback {
  using CallbackFunction=void(*)(Local<Context>,int,StartupData,void*);
  CallbackFunction callback=nullptr;void* data=nullptr;
  DeserializeContextDataCallback(CallbackFunction fn=nullptr,void* input=nullptr):callback(fn),data(input){}
};
class Data {
  std::unique_ptr<Cell> cell_;
  Cell* typedViewCell_=nullptr;
 public:
  using RootFactory=std::unique_ptr<Data>(*)(Isolate*,std::unique_ptr<Cell>);
 private:
  RootFactory rootFactory_;
 public:
  explicit Data(std::unique_ptr<Cell>,RootFactory);
  explicit Data(Cell*,RootFactory);
  virtual ~Data();
  Cell& cell() const;
  std::unique_ptr<Data> CloneRoot(Isolate*,std::unique_ptr<Cell>) const;
  RootFactory RootFactoryForStorage()const{return rootFactory_;}
  virtual bool IsValue()const=0;virtual bool IsPrivate()const=0;
  virtual bool IsContext()const{return false;}
  bool IsFixedArray()const;bool IsModule()const;bool IsModuleRequest()const;
};
struct Context:public Data {
  Isolate* isolate;
  Context(Isolate*,std::unique_ptr<Cell>);
  ~Context()override;
  bool IsValue()const override{return false;}
  bool IsPrivate()const override{return false;}
  bool IsContext()const override{return true;}
  static Local<Context> New(Isolate*,ExtensionConfiguration* = nullptr,Local<ObjectTemplate> = {},
      Local<Value> = {},DeserializeInternalFieldsCallback = DeserializeInternalFieldsCallback(),MicrotaskQueue* = nullptr);
  static MaybeLocal<Context> FromSnapshot(Isolate*,size_t,
      DeserializeInternalFieldsCallback = DeserializeInternalFieldsCallback(),
      ExtensionConfiguration* = nullptr,MaybeLocal<Value> = {},MicrotaskQueue* = nullptr,
      DeserializeContextDataCallback = {}) {
    Crash("V8 startup snapshot deserialization is unavailable");
  }
  class Scope {
    std::unique_ptr<ContextScopeData> data_;
   public:
    explicit Scope(Local<Context>);~Scope();
  };
  Local<Object> Global();
  void SetSecurityToken(Local<Value>);
  Local<Value> GetSecurityToken();
  Local<Object> GetExtrasBindingObject();
  MicrotaskQueue* GetMicrotaskQueue();
  void SetPromiseHooks(Local<Function>,Local<Function>,Local<Function>,Local<Function>);
  void AllowCodeGenerationFromStrings(bool);
  bool IsCodeGenerationFromStringsAllowed() const;
  uint32_t GetNumberOfEmbedderDataFields();Local<Value> GetEmbedderData(int);
  void SetEmbedderData(int,Local<Value>);
  void* GetAlignedPointerFromEmbedderData(int,EmbedderDataTypeTag = kEmbedderDataTypeTagDefault);
  void SetAlignedPointerInEmbedderData(int,void*,EmbedderDataTypeTag = kEmbedderDataTypeTagDefault);
  template<class T> MaybeLocal<T> GetDataFromSnapshotOnce(size_t) {
    Crash("Native heap snapshot deserialization is not implemented");
  }
};
class SnapshotCreator;
class Value:public Data {
 public:
  explicit Value(std::unique_ptr<Cell>,RootFactory=nullptr);
  explicit Value(Cell*,RootFactory);
  ~Value()override;
  bool IsObject() const;
  bool IsExternal()const;
  bool IsValue()const override;bool IsPrivate()const override;bool SameValue(Local<Value>)const;
  bool StrictEquals(Local<Value>)const;
  Maybe<bool> Equals(Local<Context>,Local<Value>)const;
  bool BooleanValue(Isolate*)const;
  bool IsTypedArray() const;
  bool IsName()const;bool IsMap()const;bool IsSet()const;
  bool IsWeakMap()const;bool IsWeakSet()const;bool IsMapIterator()const;bool IsSetIterator()const;
  bool IsNumberObject()const;bool IsBooleanObject()const;bool IsStringObject()const;
  bool IsSymbolObject()const;bool IsBigIntObject()const;bool IsDate()const;bool IsRegExp()const;
  bool IsArgumentsObject()const;bool IsAsyncFunction()const;bool IsGeneratorFunction()const;
  bool IsGeneratorObject()const;bool IsModuleNamespaceObject()const;bool IsProxy()const;bool IsWasmMemoryObject()const;
  bool IsUint8Array()const;bool IsUint8ClampedArray()const;bool IsInt8Array()const;
  bool IsInt16Array()const;bool IsUint16Array()const;bool IsInt32Array()const;bool IsUint32Array()const;
  bool IsFloat16Array()const;bool IsFloat32Array()const;bool IsBigInt64Array()const;bool IsBigUint64Array()const;
  bool IsString() const;
  bool IsSymbol() const;
  bool IsArray() const;
  bool IsFunction() const;
  bool IsNumber() const;bool IsBigInt()const;bool IsNull()const;Local<String> TypeOf(Isolate*);
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
  bool IsPromise() const;
  bool IsFloat64Array() const;
  bool IsDataView()const;
  bool IsTrue() const;
  bool IsFalse() const;bool IsNativeError() const;
  Maybe<int64_t> IntegerValue(Local<Context>);
  Maybe<int32_t> Int32Value(Local<Context>);
  Maybe<uint32_t> Uint32Value(Local<Context>);
  MaybeLocal<String> ToString(Local<Context>);
  MaybeLocal<Object> ToObject(Local<Context>);
  MaybeLocal<String> ToDetailString(Local<Context>)const;
  MaybeLocal<Number> ToNumber(Local<Context>)const;
  MaybeLocal<Integer> ToInteger(Local<Context>)const;
  MaybeLocal<Int32> ToInt32(Local<Context>)const;
  MaybeLocal<Uint32> ToUint32(Local<Context>)const;
  Local<Boolean> ToBoolean(Isolate*)const;
  Maybe<bool> InstanceOf(Local<Context>,Local<Object>)const;
};
class Primitive : public Value {public:using Value::Value;};
class Name : public Primitive { public: using Primitive::Primitive;int GetIdentityHash(); };
class FixedArray : public Data {
 public:using Data::Data;
  bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
  int Length()const;Local<Data> Get(int)const;
};
class PrimitiveArray : public FixedArray {
 public:using FixedArray::FixedArray;
  bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
  static Local<PrimitiveArray> New(Isolate*,int);
  int Length()const;void Set(Isolate*,int,Local<Primitive>);Local<Primitive> Get(Isolate*,int);
};
class Symbol : public Name {
 public:
  using Name::Name;
  Local<Value> Description(Isolate*)const;
  static Local<Symbol> New(Isolate*,Local<String> = {});
  static Local<Symbol> For(Isolate*,Local<String>);
  static Local<Symbol> ForApi(Isolate*,Local<String>);
  static Local<Symbol> GetAsyncIterator(Isolate*);
  static Local<Symbol> GetHasInstance(Isolate*);
  static Local<Symbol> GetIsConcatSpreadable(Isolate*);
  static Local<Symbol> GetIterator(Isolate*);
  static Local<Symbol> GetMatch(Isolate*);
  static Local<Symbol> GetReplace(Isolate*);
  static Local<Symbol> GetSearch(Isolate*);
  static Local<Symbol> GetSplit(Isolate*);
  static Local<Symbol> GetToPrimitive(Isolate*);
  static Local<Symbol> GetToStringTag(Isolate*);
  static Local<Symbol> GetUnscopables(Isolate*);
  static Local<Symbol> GetDispose(Isolate*);
  static Local<Symbol> GetAsyncDispose(Isolate*);
};
class Private : public Data {
 public:using Data::Data;bool IsValue()const override{return false;}bool IsPrivate()const override{return true;}
 Local<Value> Name()const;
 static Local<Private> New(Isolate*,Local<String> = {});
 static Local<Private> ForApi(Isolate*,Local<String>);
};
struct NativeMicrotaskData;
struct MicrotaskSuppressionData;
class MicrotaskQueue {
  std::shared_ptr<NativeMicrotaskData> data_;
  explicit MicrotaskQueue(Isolate*,bool isDefault=true);
  friend class Isolate;
  friend struct Context;
  friend struct NativeEntry;
  friend class MicrotasksScope;
  friend struct MicrotaskSuppressionData;
 public:
  static std::unique_ptr<MicrotaskQueue> New(Isolate*,MicrotasksPolicy = MicrotasksPolicy::kAuto);
  ~MicrotaskQueue();
  void EnqueueMicrotask(Isolate*,Local<Function>);
  void EnqueueMicrotask(Isolate*,MicrotaskCallback,void* = nullptr);
  void PerformCheckpoint(Isolate*);
  bool IsRunningMicrotasks()const;
  int GetMicrotasksScopeDepth()const;
  void RetireNativeMicrotasks();
};
class MicrotasksScope {
  Isolate* isolate_;
  std::shared_ptr<NativeMicrotaskData> queue_;
  bool run_;
 public:
  enum Type {kRunMicrotasks,kDoNotRunMicrotasks};
  MicrotasksScope(Local<Context>,Type);
  MicrotasksScope(Isolate*,MicrotaskQueue*,Type);
  ~MicrotasksScope();
  static void PerformCheckpoint(Isolate*);
  static int GetCurrentDepth(Isolate*);
  static bool IsRunningMicrotasks(Isolate*);
  MicrotasksScope(const MicrotasksScope&)=delete;
  MicrotasksScope& operator=(const MicrotasksScope&)=delete;
};
enum PropertyAttribute { None=0, ReadOnly=1, DontEnum=2, DontDelete=4 };
enum class IntegrityLevel {kFrozen,kSealed};
class PropertyDescriptor {
 public:
  struct PrivateData;
 private:
  std::unique_ptr<PrivateData> private_;
 public:
  PropertyDescriptor();
  explicit PropertyDescriptor(Local<Value>);
  PropertyDescriptor(Local<Value>,bool);
  PropertyDescriptor(Local<Value>,Local<Value>);
  ~PropertyDescriptor();
  PropertyDescriptor(const PropertyDescriptor&)=delete;
  void operator=(const PropertyDescriptor&)=delete;
  Local<Value> value()const;bool has_value()const;
  Local<Value> get()const;bool has_get()const;
  Local<Value> set()const;bool has_set()const;
  void set_enumerable(bool);bool enumerable()const;bool has_enumerable()const;
  void set_configurable(bool);bool configurable()const;bool has_configurable()const;
  bool writable()const;bool has_writable()const;
  PrivateData* get_private()const{return private_.get();}
};
enum class SideEffectType { kHasSideEffect, kHasNoSideEffect, kHasSideEffectToReceiver };
using AccessorNameGetterCallback=void(*)(Local<Name>,const PropertyCallbackInfo<Value>&);
using AccessorNameSetterCallback=void(*)(Local<Name>,Local<Value>,const PropertyCallbackInfo<void>&);
std::unique_ptr<Data> RetainRoot(Isolate*,Local<Data>);
template<class T> std::unique_ptr<T> RetainTypedRoot(Isolate*,Local<T>);
// Indirect locals reference actual cells owned by the active HandleScope.
// This container owns its contiguous slots, not those cells: copying a Local
// out survives vector relocation/retirement but cannot extend its handle scope.
// Cross-scope ownership belongs to Global, not an off-stack Local copy.
template<class T> class LocalVector {
  static_assert(std::is_base_of_v<Data,T>);
  std::vector<Local<T>> values_;
 public:
  explicit LocalVector(Isolate*){}
  LocalVector(Isolate*,size_t size):values_(size){}
  LocalVector(Isolate*,std::initializer_list<Local<T>> values):values_(values){}
  Local<T>& operator[](size_t index){return values_[index];}
  const Local<T>& operator[](size_t index)const{return values_[index];}
  Local<T>& at(size_t index){return values_.at(index);}
  const Local<T>& at(size_t index)const{return values_.at(index);}
  Local<T>& front(){return values_.front();}
  const Local<T>& front()const{return values_.front();}
  Local<T>& back(){return values_.back();}
  const Local<T>& back()const{return values_.back();}
  Local<T>* data()noexcept{return values_.data();}
  const Local<T>* data()const noexcept{return values_.data();}
  auto begin()noexcept{return values_.begin();}auto end()noexcept{return values_.end();}
  auto begin()const noexcept{return values_.begin();}auto end()const noexcept{return values_.end();}
  void push_back(Local<T> value){values_.push_back(value);}
  void pop_back(){values_.pop_back();}
  template<class... Args> void emplace_back(Args&&... args){values_.emplace_back(std::forward<Args>(args)...);}
  void reserve(size_t size){values_.reserve(size);}
  void resize(size_t size){values_.resize(size);}
  void shrink_to_fit(){values_.shrink_to_fit();}
  void clear()noexcept{values_.clear();}
  void swap(LocalVector& other)noexcept{values_.swap(other.values_);}
  size_t size()const noexcept{return values_.size();}
  bool empty()const noexcept{return values_.empty();}
};
static_assert(std::is_trivially_copyable_v<Local<Value>>);
static_assert(std::is_standard_layout_v<Local<Value>>);

struct GlobalRoot;
std::shared_ptr<GlobalRoot> NewGlobalRoot(Isolate*,Local<Data>);
Local<Data> ReadGlobalRoot(Isolate*,const std::shared_ptr<GlobalRoot>&);
void MakeGlobalWeak(Isolate*,const std::shared_ptr<GlobalRoot>&);
void MakeGlobalStrong(Isolate*,const std::shared_ptr<GlobalRoot>&);
void MakeGlobalWeakTenured(Isolate*,const std::shared_ptr<GlobalRoot>&);
bool GlobalRootIsWeak(const std::shared_ptr<GlobalRoot>&);
bool GlobalRootIsEmpty(const std::shared_ptr<GlobalRoot>&);
JSObject* BorrowGlobalObject(const std::shared_ptr<GlobalRoot>&);
struct PersistentCell;
PersistentCell* NewPersistentCell(Isolate*,Local<Data>);
void DeletePersistentCell(PersistentCell*);
Data* BorrowPersistentLocal(const PersistentCell*);
Local<Data> ReadPersistentCell(Isolate*,const PersistentCell*);
bool PersistentCellIsEmpty(const PersistentCell*);
bool PersistentCellIsWeak(const PersistentCell*);
bool SamePersistentCellData(const PersistentCell*,Data*);
bool SamePersistentCells(const PersistentCell*,const PersistentCell*);
void WeakenPersistentCell(PersistentCell*,bool);
void WeakenPersistentCell(PersistentCell*,std::function<void(Isolate*)>);
void StrengthenPersistentCell(PersistentCell*);
JSObject* BorrowPersistentObject(const PersistentCell*);
// The first member is an actual Local, pointer-interconvertible with this
// standard-layout object. Node's unchanged PersistentToLocal::Strong borrows
// this member; its pointee is a stable native wrapper, never a JS heap address.
template<class T> class PersistentBase {
  Local<T> local_;
  PersistentCell* cell_=nullptr;
 public:
  PersistentBase()=default;
  PersistentBase(Isolate* isolate,Local<T> value) { Reset(isolate,value); }
  ~PersistentBase(){Reset();}
  PersistentBase(const PersistentBase&)=delete;
  PersistentBase& operator=(const PersistentBase&)=delete;
  PersistentBase(PersistentBase&& other) noexcept
    :local_(std::exchange(other.local_,{})),cell_(std::exchange(other.cell_,nullptr)){}
  PersistentBase& operator=(PersistentBase&& other) noexcept {
    if(this!=&other){Reset();local_=std::exchange(other.local_,{});cell_=std::exchange(other.cell_,nullptr);}return *this;
  }
  static constexpr bool HasCompatibleLayout(){
    return std::is_standard_layout_v<PersistentBase<T>>&&offsetof(PersistentBase<T>,local_)==0&&
      std::is_standard_layout_v<Local<T>>&&sizeof(Local<T>)==sizeof(T*);
  }
  bool IsEmpty() const { return PersistentCellIsEmpty(cell_); }
  template<class U> bool operator==(Local<U> other)const{return SamePersistentCellData(cell_,other.get());}
  template<class U> bool operator==(const PersistentBase<U>& other)const{return SamePersistentCells(cell_,other.cell_);}
  template<class>friend class PersistentBase;
  void Reset(Isolate* isolate,Local<T> value) {
    if(value.IsEmpty()){Reset();return;}
    auto* next=NewPersistentCell(isolate,value);Reset();cell_=next;
    local_=Local<T>(static_cast<T*>(BorrowPersistentLocal(cell_)));
  }
  void Reset(){local_={};DeletePersistentCell(std::exchange(cell_,nullptr));}
  void SetWeak(){WeakenPersistentCell(cell_,false);}
  template<class P> void SetWeak(P* parameter,typename WeakCallbackInfo<P>::Callback callback,WeakCallbackType type) {
    if(type!=WeakCallbackType::kParameter||!callback)Crash("Invalid native weak callback");
    WeakenPersistentCell(cell_,[parameter,callback](Isolate* isolate){
      const WeakCallbackInfo<P> info(isolate,parameter);callback(info);
    });
  }
  void ClearWeak(){StrengthenPersistentCell(cell_);local_=Local<T>(static_cast<T*>(BorrowPersistentLocal(cell_)));}
  void SetWeakTenured(){WeakenPersistentCell(cell_,true);}
  bool IsWeak()const{return PersistentCellIsWeak(cell_);}
  Local<T> Get(Isolate* isolate)const{return ReadPersistentCell(isolate,cell_).template As<T>();}
  JSObject* BorrowObject()const{return BorrowPersistentObject(cell_);}
};
static_assert(PersistentBase<Value>::HasCompatibleLayout());
template<class T> class Global:public PersistentBase<T> {
 public:using PersistentBase<T>::PersistentBase;
};
template<class T> Local<T> Local<T>::New(Isolate* isolate,const PersistentBase<T>& value){return value.Get(isolate);}
struct TracedRoot;
struct TracedRootDeleter {void operator()(TracedRoot*)const;};
using TracedRootOwner=std::unique_ptr<TracedRoot,TracedRootDeleter>;
TracedRootOwner NewTracedRoot(Isolate*,Local<Data>,std::shared_ptr<cppgc::internal::NativeAllocation>);
TracedRootOwner NewTracedRoot(Isolate*,Local<Context>,std::shared_ptr<cppgc::internal::NativeAllocation>);
Local<Data> ReadTracedRoot(Isolate*,const TracedRoot&);
Local<Context> ReadTracedContextRoot(Isolate*,const TracedRoot&);
void TraceTracedRoot(JSTracer*,const TracedRoot&);
template<class T> class TracedReference:private cppgc::internal::AllocationMember {
  TracedRootOwner root_;
 public:
  TracedReference()=default;
  TracedReference(Isolate* isolate,Local<T> value){Reset(isolate,value);}
  TracedReference(const TracedReference&)=delete;
  TracedReference& operator=(const TracedReference&)=delete;
  TracedReference(TracedReference&&)=default;
  TracedReference& operator=(TracedReference&&)=default;
  void Reset(){root_.reset();}
  void Reset(Isolate* isolate,Local<T> value){
    if(value.IsEmpty()){Reset();return;}
    if constexpr(std::is_same_v<T,Context>)
      root_=NewTracedRoot(isolate,value,NativeAllocationControl());
    else root_=NewTracedRoot(isolate,Local<Data>(value),NativeAllocationControl());
  }
  bool IsEmpty()const{return !root_;}
  Local<T> Get(Isolate* isolate)const{
    if(!root_)return {};
    if constexpr(std::is_same_v<T,Context>)return ReadTracedContextRoot(isolate,*root_);
    else return ReadTracedRoot(isolate,*root_).template As<T>();
  }
  void Trace(JSTracer* tracer)const{if(root_)TraceTracedRoot(tracer,*root_);}
};
class Object : public Value {
 public:
  struct WrapperTypeInfo {const int16_t type_id;};
  class Wrappable:public cppgc::GarbageCollected<Wrappable>,public cppgc::NameProvider {
   public:
    virtual const WrapperTypeInfo* GetWrapperTypeInfo()const{return nullptr;}
    const char* GetHumanReadableName()const override{return "internal";}
    virtual void Trace(cppgc::Visitor*)const{}
  };
  using Value::Value;
  static Local<Object> New(Isolate*);
  static Local<Object> New(Isolate*,Local<Value>,Local<Name>*,Local<Value>*,size_t);
  MaybeLocal<Context> GetCreationContext(Isolate*);
  MaybeLocal<Context> GetCreationContext();
  Local<Context> GetCreationContextChecked(Isolate*);
  Local<Context> GetCreationContextChecked();
  MaybeLocal<Array> GetOwnPropertyNames(Local<Context>);
  MaybeLocal<Array> GetOwnPropertyNames(Local<Context>,PropertyFilter,KeyConversionMode=KeyConversionMode::kKeepNumbers);
  MaybeLocal<Array> GetPropertyNames(Local<Context>);
  MaybeLocal<Array> GetPropertyNames(Local<Context>,KeyCollectionMode,PropertyFilter,IndexFilter,KeyConversionMode=KeyConversionMode::kKeepNumbers);
  MaybeLocal<Array> PreviewEntries(bool*);
  MaybeLocal<Value> GetPrivate(Local<Context>,Local<Private>);
  Maybe<bool> HasPrivate(Local<Context>,Local<Private>);
  Maybe<bool> DeletePrivate(Local<Context>,Local<Private>);
  Maybe<bool> HasRealNamedProperty(Local<Context>,Local<Name>);
  MaybeLocal<Value> GetRealNamedProperty(Local<Context>,Local<Name>);
  Maybe<PropertyAttribute> GetRealNamedPropertyAttributes(Local<Context>,Local<Name>);
  Local<String> GetConstructorName();
  Maybe<bool> DefineOwnProperty(Local<Context>,Local<Name>,Local<Value>,PropertyAttribute=None);
  Maybe<bool> DefineProperty(Local<Context>,Local<Name>,PropertyDescriptor&);
  MaybeLocal<Value> GetOwnPropertyDescriptor(Local<Context>,Local<Name>);
  Maybe<bool> HasOwnProperty(Local<Context>,Local<Name>);
  Maybe<bool> HasOwnProperty(Local<Context>,uint32_t);
  Maybe<PropertyAttribute> GetPropertyAttributes(Local<Context>,Local<Value>);
  Maybe<bool> GetPropertyAttributes(Local<Context>,Local<Value>,PropertyAttribute*);
  Maybe<bool> CreateDataProperty(Local<Context>,Local<Name>,Local<Value>);
  Maybe<bool> CreateDataProperty(Local<Context>,uint32_t,Local<Value>);
  Maybe<bool> Delete(Local<Context>,Local<Value>);
  Maybe<bool> Delete(Local<Context>,uint32_t);
  Local<Value> GetPrototypeV2();
  Maybe<bool> SetIntegrityLevel(Local<Context>,IntegrityLevel);
  int InternalFieldCount()const;
  void* GetAlignedPointerFromInternalField(int,EmbedderDataTypeTag);
  void SetAlignedPointerInInternalField(int,void*,EmbedderDataTypeTag);
  template<auto Tag> static void Wrap(Isolate* isolate,Local<Object> wrapper,Wrappable* native){
    WrapNativeAllocation(isolate,wrapper,native,uint16_t(Tag));
  }
  Local<Data> GetInternalField(int);void SetInternalField(int,Local<Data>);
  Maybe<bool> Set(Local<Context>,Local<Value>,Local<Value>);
  Maybe<bool> Set(Local<Context>,uint32_t,Local<Value>);
  Maybe<bool> Has(Local<Context>,Local<Value>);
  Maybe<bool> Has(Local<Context>,uint32_t);
  Maybe<bool> SetPrivate(Local<Context>,Local<Private>,Local<Value>);
  Maybe<bool> SetPrototypeV2(Local<Context>,Local<Value>);
  MaybeLocal<Value> Get(Local<Context>,Local<Value>);
  MaybeLocal<Value> Get(Local<Context>,uint32_t);
  Maybe<bool> SetNativeDataProperty(
      Local<Context>,Local<Name>,AccessorNameGetterCallback,
      AccessorNameSetterCallback=nullptr,Local<Value> = {},
      PropertyAttribute=None,
      SideEffectType=SideEffectType::kHasSideEffect,
      SideEffectType=SideEffectType::kHasSideEffect);
  Maybe<bool> SetLazyDataProperty(
      Local<Context>,Local<Name>,AccessorNameGetterCallback,Local<Value> = {},
      PropertyAttribute=None,
      SideEffectType=SideEffectType::kHasSideEffect,
      SideEffectType=SideEffectType::kHasSideEffect);
 private:
  static void WrapNativeAllocation(Isolate*,Local<Object>,Wrappable*,uint16_t);
};
class Function : public Object {
 public: using Object::Object;
  static MaybeLocal<Function> New(Local<Context>,FunctionCallback,Local<Data> = {},int=0,
      ConstructorBehavior=ConstructorBehavior::kAllow,SideEffectType=SideEffectType::kHasSideEffect);
  MaybeLocal<Value> Call(Local<Context>,Local<Value>,int,Local<Value>*);
  MaybeLocal<Object> NewInstance(Local<Context>);
  MaybeLocal<Object> NewInstance(Local<Context>,int,Local<Value>[])const;
  bool IsConstructor()const;
  void SetName(Local<String>);
  ScriptOrigin GetScriptOrigin()const;
};
class Proxy:public Object {
 public:using Object::Object;
  Local<Value> GetTarget();Local<Value> GetHandler();
};
class Array : public Object {
 public:
  using Object::Object;
  using Object::Set;
  static Local<Array> New(Isolate*,int=0);
  static Local<Array> New(Isolate*,const Local<Value>*,size_t);
  static MaybeLocal<Array> New(Local<Context>,size_t,std::function<MaybeLocal<Value>()>);
  enum class CallbackResult{kException,kBreak,kContinue};
  using IterationCallback=CallbackResult(*)(uint32_t,Local<Value>,void*);
  Maybe<void> Iterate(Local<Context>,CallbackResult(*)(uint32_t,Local<Value>,void*),void*);
  uint32_t Length() const;
  MaybeLocal<Value> Get(Local<Context>,uint32_t);
};
class Promise : public Object {
 public:
  using Object::Object;
  enum PromiseState {kPending,kFulfilled,kRejected};
  class Resolver : public Object {
   public:
    using Object::Object;
    static MaybeLocal<Resolver> New(Local<Context>);
    Local<Promise> GetPromise();
    Maybe<bool> Resolve(Local<Context>,Local<Value>);
    Maybe<bool> Reject(Local<Context>,Local<Value>);
  };
  MaybeLocal<Promise> Catch(Local<Context>,Local<Function>);
  MaybeLocal<Promise> Then(Local<Context>,Local<Function>);
  MaybeLocal<Promise> Then(Local<Context>,Local<Function>,Local<Function>);
  bool HasHandler()const;
  Local<Value> Result();
  PromiseState State();
  void MarkAsHandled();
  // Debugger pause suppression requires the retained Inspector adaptation.
  // No successful no-op is supplied by the incomplete native bridge.
  void MarkAsSilent();
};
Data* RebindPromiseHandle(Data*,bool);
Data* RebindProxyHandle(Data*);
Data* RebindIntegerHandle(Data*,bool);
template<class T> template<class U> Local<U> Local<T>::As()const{
  if constexpr(std::is_same_v<U,Promise>||std::is_same_v<U,Promise::Resolver>)
    return Local<U>(static_cast<U*>(RebindPromiseHandle(static_cast<Data*>(pointer_),std::is_same_v<U,Promise::Resolver>)));
  else if constexpr(std::is_same_v<U,Proxy>)return Local<U>(static_cast<U*>(RebindProxyHandle(static_cast<Data*>(pointer_))));
  else if constexpr(std::is_same_v<U,Int32>||std::is_same_v<U,Uint32>)
    return Local<U>(static_cast<U*>(RebindIntegerHandle(static_cast<Data*>(pointer_),std::is_same_v<U,Uint32>)));
  else return Local<U>(static_cast<U*>(pointer_));
}

class ArrayBufferView : public Object {
 public: using Object::Object;
  Local<ArrayBuffer> Buffer();size_t ByteOffset() const;size_t ByteLength() const;
  bool HasBuffer()const;size_t CopyContents(void*,size_t);
};
class External : public Value {
 public:
  using Value::Value;
  static Local<External> New(Isolate*,void*,ExternalPointerTypeTag=kExternalPointerTypeTagDefault);
  void* Value(ExternalPointerTypeTag=kExternalPointerTypeTagDefault)const;
};
class DataView : public ArrayBufferView {
 public:
  using ArrayBufferView::ArrayBufferView;
  static Local<DataView> New(Local<ArrayBuffer>,size_t,size_t);
  static Local<DataView> New(Local<SharedArrayBuffer>,size_t,size_t);
};
enum class BackingStoreInitializationMode { kZeroInitialized, kUninitialized };
enum class BackingStoreOnFailureMode { kOutOfMemory, kReturnNull };
struct BackingStore {
  using DeleterCallback=void(*)(void*,size_t,void*);
  void* Data() const { return data; }
  size_t ByteLength() const;
  size_t MaxByteLength() const { return maximum; }
  bool IsResizableByUserJavaScript() const { return resizable; }
  void* const data; const size_t size; void(*deleter)(void*,size_t,void*); void* userData;
  // Retain an actual allocator/deleter lifetime independently of a JS object.
  std::shared_ptr<void> lifetime;
  bool shared=false,resizable=false;
  size_t maximum;
  std::shared_ptr<js::NativeArrayBufferOwner> nativeOwner;
  js::SharedArrayRawBuffer* sharedOwner=nullptr;
  std::vector<const void*> retainedOwnerKeys;
  bool IsShared()const{return shared;}
  BackingStore(void*,size_t,void(*)(void*,size_t,void*),void*,std::shared_ptr<void> = {});
  BackingStore(const BackingStore&)=delete;
  ~BackingStore();
};
class ArrayBuffer : public Object {
 public:
  static constexpr size_t kMaxByteLength=std::numeric_limits<int>::max();
  class Allocator {
   public:virtual ~Allocator()=default;static Allocator* NewDefaultAllocator();
    virtual void* Allocate(size_t)=0;virtual void* AllocateUninitialized(size_t)=0;virtual void Free(void*,size_t)=0;
  }; using Object::Object;
  static std::unique_ptr<BackingStore> NewBackingStore(void*,size_t,void(*)(void*,size_t,void*),void*);
  static std::unique_ptr<BackingStore> NewBackingStore(Isolate*,size_t,
      BackingStoreInitializationMode=BackingStoreInitializationMode::kZeroInitialized,
      BackingStoreOnFailureMode=BackingStoreOnFailureMode::kOutOfMemory);
  static Local<ArrayBuffer> New(Isolate*,std::unique_ptr<BackingStore>);
  static Local<ArrayBuffer> New(Isolate*,std::shared_ptr<BackingStore>);
  static Local<ArrayBuffer> New(Isolate*,size_t);
  std::shared_ptr<BackingStore> GetBackingStore();
  void* Data();size_t ByteLength() const;bool WasDetached() const;
  bool IsDetachable() const;bool IsImmutable() const;
  Maybe<bool> Detach(Local<Value>);void SetDetachKey(Local<Value>);
  size_t CopyArrayBufferBytes(size_t,size_t,Local<ArrayBuffer>,size_t);
};
class SharedArrayBuffer : public ArrayBuffer {
 public:using ArrayBuffer::ArrayBuffer;
  static Local<SharedArrayBuffer> New(Isolate*,size_t,BackingStoreInitializationMode=BackingStoreInitializationMode::kZeroInitialized);
  static MaybeLocal<SharedArrayBuffer> MaybeNew(Isolate*,size_t,BackingStoreInitializationMode=BackingStoreInitializationMode::kZeroInitialized);
  static Local<SharedArrayBuffer> New(Isolate*,std::shared_ptr<BackingStore>);
  std::shared_ptr<BackingStore> GetBackingStore();
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
 V(Float16Array,Float16) V(Float64Array,Float64) V(BigInt64Array,BigInt64) V(BigUint64Array,BigUint64) V(Uint8ClampedArray,Uint8Clamped)
#define KANDELO_DECLARE_TYPED_ARRAY(Name,Scalar) \
 class Name : public TypedArray { public:using TypedArray::TypedArray; \
 static Local<Name> New(Local<ArrayBuffer>,size_t,size_t); };
KANDELO_NATIVE_TYPED_ARRAYS(KANDELO_DECLARE_TYPED_ARRAY)
#undef KANDELO_DECLARE_TYPED_ARRAY
class Number : public Primitive { public: using Primitive::Primitive;static Local<Number> New(Isolate*,double);double Value() const; };
class BigInt : public Primitive {
 public:
  using Primitive::Primitive;
  static Local<BigInt> New(Isolate*,int64_t);
  static Local<BigInt> NewFromUnsigned(Isolate*,uint64_t);
  static MaybeLocal<BigInt> NewFromWords(Local<Context>,int,int,const uint64_t*);
  uint64_t Uint64Value(bool* = nullptr)const;
  int64_t Int64Value(bool* = nullptr)const;
  int WordCount()const;
  void ToWordsArray(int*,int*,uint64_t*)const;
};
class Integer : public Number { public: using Number::Number;static Local<Integer> New(Isolate*,int);static Local<Integer> NewFromUnsigned(Isolate*,uint32_t);int64_t Value() const; };
class Int32:public Integer {public:using Integer::Integer;int32_t Value()const;};
class Uint32:public Integer {public:using Integer::Integer;static Local<Uint32> New(Isolate*,uint32_t);uint32_t Value()const;};
class Signature;class CFunction;
template<class T> using MemorySpan=std::span<T>;
enum class MeasureMemoryMode{kSummary,kDetailed};
enum class MeasureMemoryExecution{kDefault,kEager,kLazy};
class MeasureMemoryDelegate {
 public:
  virtual ~MeasureMemoryDelegate()=default;
  virtual bool ShouldMeasure(Local<Context>)=0;
  struct Result {
    const MemorySpan<const Local<Context>>& contexts;
    const MemorySpan<const size_t>& sizes_in_bytes;
    size_t unattributed_size_in_bytes,wasm_code_size_in_bytes,wasm_metadata_size_in_bytes;
  };
  virtual void MeasurementComplete(Result){}
  static std::unique_ptr<MeasureMemoryDelegate> Default(Isolate*,Local<Context>,Local<Promise::Resolver>,MeasureMemoryMode);
};
class Template:public Data {
 public:using Data::Data;bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
  void Set(Local<Name>,Local<Data>,PropertyAttribute=None);
  void Set(Isolate*,const char*,Local<Data>,PropertyAttribute=None);
  void SetPrivate(Local<Private>,Local<Data>,PropertyAttribute=None);
  void SetAccessorProperty(Local<Name>,Local<FunctionTemplate> = {},Local<FunctionTemplate> = {},PropertyAttribute=None);
  void SetNativeDataProperty(Local<Name>,AccessorNameGetterCallback,
      AccessorNameSetterCallback=nullptr,Local<Value> = {},PropertyAttribute=None,
      SideEffectType=SideEffectType::kHasSideEffect,
      SideEffectType=SideEffectType::kHasSideEffect);
  void SetLazyDataProperty(Local<Name>,AccessorNameGetterCallback,Local<Value> = {},
      PropertyAttribute=None,SideEffectType=SideEffectType::kHasSideEffect,
      SideEffectType=SideEffectType::kHasSideEffect);
};
class ObjectTemplate : public Template {
 public: using Template::Template;
  static Local<ObjectTemplate> New(Isolate*,Local<FunctionTemplate> = {});
  void SetHandler(const NamedPropertyHandlerConfiguration&);
  void SetHandler(const IndexedPropertyHandlerConfiguration&);
  void SetInternalFieldCount(int);
  int InternalFieldCount()const;
  MaybeLocal<Object> NewInstance(Local<Context>);
};
class DictionaryTemplate final : public Data {
 public:
  using Data::Data;
  bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
  static Local<DictionaryTemplate> New(Isolate*,MemorySpan<const std::string_view>);
  Local<Object> NewInstance(Local<Context>,MemorySpan<MaybeLocal<Value>>);
};
class FunctionTemplate : public Template {
 public: using Template::Template;
  static Local<FunctionTemplate> New(Isolate*,FunctionCallback=nullptr,Local<Value> = {},Local<Signature> = {},int=0,ConstructorBehavior=ConstructorBehavior::kAllow,SideEffectType=SideEffectType::kHasSideEffect,const CFunction* = nullptr);
  static Local<FunctionTemplate> NewWithCFunctionOverloads(Isolate*,FunctionCallback,Local<Value>,Local<Signature>,int,ConstructorBehavior,SideEffectType,MemorySpan<const CFunction>);
  Local<ObjectTemplate> PrototypeTemplate();
  Local<ObjectTemplate> InstanceTemplate();
  MaybeLocal<Function> GetFunction(Local<Context>);
  void SetClassName(Local<String>);
  void Inherit(Local<FunctionTemplate>);
  bool HasInstance(Local<Value>);
  void ReadOnlyPrototype();void SetLength(int);
};
enum class NewStringType { kNormal, kInternalized };
class Signature:public Data {
 public:using Data::Data;bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
  static Local<Signature> New(Isolate*,Local<FunctionTemplate>);
};
class Set:public Object {public:using Object::Object;static Local<Set> New(Isolate*);MaybeLocal<Set> Add(Local<Context>,Local<Value>);};
class Map:public Object {public:using Object::Object;static Local<Map> New(Isolate*);MaybeLocal<Map> Set(Local<Context>,Local<Value>,Local<Value>);};
class Boolean:public Primitive {public:using Primitive::Primitive;static Local<Boolean> New(Isolate*,bool);bool Value()const;};
class String : public Name {
 public:
  using Name::Name;
  static constexpr int kMaxLength=int(JS::MaxStringLength);
  class ExternalStringResourceBase {
   public:
    virtual ~ExternalStringResourceBase()=default;
    virtual void Dispose(){delete this;}
  };
  class ExternalOneByteStringResource : public ExternalStringResourceBase {
   public: ~ExternalOneByteStringResource()override=default;
    virtual const char* data() const=0;virtual size_t length() const=0;
  };
  class ExternalStringResource : public ExternalStringResourceBase {
   public: ~ExternalStringResource()override=default;
    virtual const uint16_t* data() const=0;virtual size_t length() const=0;
  };
  class ValueView {
    std::unique_ptr<View> view_;
   public:
    ValueView(Isolate*,Local<String>);~ValueView();
    bool is_one_byte() const;size_t length() const;
    const uint8_t* data8() const;const uint16_t* data16() const;
  };
  using WriteFlags=kandelo::node::stringapi::WriteFlags;
  static Local<String> Empty(Isolate*);
  template<size_t N> static Local<String> NewFromUtf8Literal(Isolate* isolate,const char(&text)[N],NewStringType type=NewStringType::kNormal) {
    static_assert(N>0&&N-1<=size_t(std::numeric_limits<int>::max()));
    return NewFromUtf8(isolate,text,type,int(N-1)).ToLocalChecked();
  }
  static Local<String> Concat(Isolate*,Local<String>,Local<String>);
  static MaybeLocal<String> NewFromUtf8(Isolate*,const char*,NewStringType=NewStringType::kNormal,int=-1);
  static MaybeLocal<String> NewFromOneByte(Isolate*,const uint8_t*,NewStringType=NewStringType::kNormal,int=-1);
  static MaybeLocal<String> NewFromTwoByte(Isolate*,const uint16_t*,NewStringType=NewStringType::kNormal,int=-1);
  static MaybeLocal<String> NewExternalOneByte(Isolate*,ExternalOneByteStringResource*);
  static MaybeLocal<String> NewExternalTwoByte(Isolate*,ExternalStringResource*);
  bool IsOneByte() const;bool ContainsOnlyOneByte() const;
  bool IsExternalOneByte() const;bool IsExternalTwoByte()const;
  bool StringEquals(Local<String>)const;
  ExternalStringResource* GetExternalStringResource()const;
  ExternalOneByteStringResource* GetExternalOneByteStringResource() const;
  size_t Utf8LengthV2(Isolate*)const;
  void WriteOneByteV2(Isolate*,size_t,size_t,uint8_t*,int=WriteFlags::kNone)const;
 private:
  mutable std::unique_ptr<ExternalOneByteStringResource> externalView_;
  mutable std::unique_ptr<ExternalStringResource> externalTwoByteView_;
 public:
  size_t Length() const;
  size_t length() const { return Length(); }
  enum class Utf8EncodingFlag { kNullTerminate };
  static size_t Utf8Length(Isolate*,Local<String>);
  static size_t WriteUtf8(Isolate*,Local<String>,char*,size_t,Utf8EncodingFlag);
  void WriteV2(Isolate*,size_t,size_t,uint16_t*,int=WriteFlags::kNone)const;
  size_t WriteUtf8V2(Isolate*,char*,size_t,int=WriteFlags::kNone,size_t* = nullptr)const;
};
struct Factory { Isolate* isolate; Local<Value> undefined_value(); };
class Platform;
using EntropySource=bool(*)(unsigned char*,size_t);
class V8 {
 public:
  static const char* GetVersion();
  static void SetFlagsFromCommandLine(int*,char**,bool);
  static void SetFlagsFromString(const char*);
  static void SetFlagsFromString(const char*,size_t);
  static void SetEntropySource(EntropySource);
  static void InitializePlatform(Platform*);
  static bool Initialize();
  static bool Dispose();
  static void DisposePlatform();
  static Platform* GetCurrentPlatform();
};
enum class CppHeapPointerTag:uint16_t{kDefaultTag=0x7000};
struct CppHeapCreateParams {std::vector<void*> custom_spaces;};
struct NativeCppHeap;
class CppHeap {
  std::unique_ptr<NativeCppHeap> data_;
  explicit CppHeap(Platform*);
  friend class cppgc::internal::Construction;
  friend class Object;
 public:
  static std::unique_ptr<CppHeap> Create(Platform*,const CppHeapCreateParams&);
  ~CppHeap();
  cppgc::AllocationHandle& GetAllocationHandle();
  cppgc::HeapStatistics CollectStatistics(cppgc::HeapStatistics::DetailLevel);
  // Engine integration, separate from original Node's Realm cleanup policy.
  bool AttachToIsolate(Isolate*);
  void UpdateWeakEdges(JSTracer*);
  void DrainRetired();
  void Terminate();
  size_t NativeObjectBytes()const;
};
struct IsolateScopeData;
struct NativeIsolateData;
struct NativeMemoryServices;
void CheckNativeIsolateReleased(Isolate*);
class IsolateGroup {
  const void* space_;
  explicit IsolateGroup(const void* space):space_(space){}
 public:
  static IsolateGroup GetDefault();
  // All guest pthreads share the actual Kandelo process address space. V8
  // pointer-compression cage groups are not an extra guest VM facility.
  static constexpr bool CanCreateNewGroups(){return false;}
  static IsolateGroup Create();
  bool operator==(const IsolateGroup& other)const{return space_==other.space_;}
};
class StackTrace:public Data {
 public:
 using Data::Data;bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
 // Private bridge flags; no V8 data/layout or stack metadata is synthesized.
 enum StackTraceOptions{kOverview=0,kDetailed=1,kExposeFramesAcrossSecurityOrigins=2};
 static Local<StackTrace> CurrentStackTrace(Isolate*,int,StackTraceOptions=kDetailed);
 int GetFrameCount();Local<StackFrame> GetFrame(Isolate*,int);
};
using InterruptCallback=void(*)(Isolate*,void*);
using FatalErrorCallback=void(*)(const char*,const char*);
struct OOMDetails {bool is_heap_oom=false;const char* detail=nullptr;};
using OOMErrorCallback=void(*)(const char*,const OOMDetails&);
using MessageCallback=void(*)(Local<Message>,Local<Value>);
using PrepareStackTraceCallback=MaybeLocal<Value>(*)(Local<Context>,Local<Value>,Local<Array>);
class PromiseRejectMessage;
using PromiseRejectCallback=void(*)(PromiseRejectMessage);
enum class PromiseHookType {kInit,kResolve,kBefore,kAfter};
using PromiseHook=void(*)(PromiseHookType,Local<Promise>,Local<Value>);
using HostCreateShadowRealmContextCallback=MaybeLocal<Context>(*)(Local<Context>);
struct ModifyCodeGenerationFromStringsResult {bool codegen_allowed=false;MaybeLocal<String> modified_source;};
using AllowWasmCodeGenerationCallback=bool(*)(Local<Context>,Local<String>);
using ModifyCodeGenerationFromStringsCallback2=ModifyCodeGenerationFromStringsResult(*)(Local<Context>,Local<Value>,bool);
namespace bridge {
bool SourcePhaseImportsEnabled();
bool AbortOnUncaughtEnabled();
void CheckExternalMemoryDelta(int64_t);
[[noreturn]] void FatalOutOfMemory(Isolate*,const char*,bool);
void CallFatalErrorHandler(const char*);
void OnNativeCallCompleted(Isolate*,const std::shared_ptr<NativeMicrotaskData>&);
bool ReportMicrotaskException(Isolate*);
bool ReportNativeException(Isolate*,JS::HandleValue,JS::HandleObject);
void MaybeAbortOnUncaught(Isolate*,JS::HandleValue,JS::HandleObject);
void ApplyUncaughtStackCapture(Isolate*,JS::Realm*);
int UncaughtStackFrameLimit(Isolate*);
bool PrepareNativeStack(JSContext*,JS::HandleValue,JS::HandleObject,bool*,JS::MutableHandleValue);
}
class ResourceConstraints {
  size_t maxOld_=0,maxYoung_=0,codeRange_=0;
  uint32_t* stack_=nullptr;
 public:
  // Default sizing is a separate engine integration, still required before
  // this incomplete bridge can become a Node SDK. No placeholder is supplied.
  void ConfigureDefaults(uint64_t,uint64_t);
  size_t max_old_generation_size_in_bytes()const{return maxOld_;}
  void set_max_old_generation_size_in_bytes(size_t value){maxOld_=value;}
  size_t max_young_generation_size_in_bytes()const{return maxYoung_;}
  void set_max_young_generation_size_in_bytes(size_t value){maxYoung_=value;}
  size_t code_range_size_in_bytes()const{return codeRange_;}
  void set_code_range_size_in_bytes(size_t value){codeRange_=value;}
  uint32_t* stack_limit()const{return stack_;}
  void set_stack_limit(uint32_t* value){stack_=value;}
};
enum class ModuleImportPhase;
using HostInitializeImportMetaObjectCallback=void(*)(Local<Context>,Local<Module>,Local<Object>);
using HostImportModuleDynamicallyCallback=MaybeLocal<Promise>(*)(Local<Context>,Local<Data>,Local<Value>,Local<String>,Local<FixedArray>);
using HostImportModuleWithPhaseDynamicallyCallback=MaybeLocal<Promise>(*)(Local<Context>,Local<Data>,Local<Value>,Local<String>,ModuleImportPhase,Local<FixedArray>);
class Isolate {
  std::shared_ptr<NativeIsolateData> native_;
  friend struct NativeMemoryServices;
  friend void CheckNativeIsolateReleased(Isolate*);
  friend void bridge::FatalOutOfMemory(Isolate*,const char*,bool);
  friend void bridge::CallFatalErrorHandler(const char*);
  friend void bridge::OnNativeCallCompleted(Isolate*,const std::shared_ptr<NativeMicrotaskData>&);
  friend bool bridge::ReportMicrotaskException(Isolate*);
  friend bool bridge::ReportNativeException(Isolate*,JS::HandleValue,JS::HandleObject);
  friend void bridge::MaybeAbortOnUncaught(Isolate*,JS::HandleValue,JS::HandleObject);
  friend void bridge::ApplyUncaughtStackCapture(Isolate*,JS::Realm*);
  friend int bridge::UncaughtStackFrameLimit(Isolate*);
  friend bool bridge::PrepareNativeStack(JSContext*,JS::HandleValue,JS::HandleObject,bool*,JS::MutableHandleValue);
  using InterruptEntry=std::pair<InterruptCallback,void*>;
  std::mutex native_interrupt_mutex_;
  std::queue<InterruptEntry> api_interrupts_queue_;
  JSContext* native_interrupt_context_=nullptr;
  bool native_interrupts_accepting_=false;
  size_t native_interrupt_delivery_depth_=0;
 public:
  using GCCallback=void(*)(Isolate*,GCType,GCCallbackFlags);
  using GCCallbackWithData=void(*)(Isolate*,GCType,GCCallbackFlags,void*);
  void AddGCPrologueCallback(GCCallback,GCType=kGCTypeAll);
  void AddGCPrologueCallback(GCCallbackWithData,void* = nullptr,GCType=kGCTypeAll);
  void RemoveGCPrologueCallback(GCCallback);
  void RemoveGCPrologueCallback(GCCallbackWithData,void* = nullptr);
  void AddGCEpilogueCallback(GCCallback,GCType=kGCTypeAll);
  void AddGCEpilogueCallback(GCCallbackWithData,void* = nullptr,GCType=kGCTypeAll);
  void RemoveGCEpilogueCallback(GCCallback);
  void RemoveGCEpilogueCallback(GCCallbackWithData,void* = nullptr);
  void AddNearHeapLimitCallback(NearHeapLimitCallback,void*);
  void RemoveNearHeapLimitCallback(NearHeapLimitCallback,size_t);
  void AutomaticallyRestoreInitialHeapLimit(double);
  using AbortOnUncaughtExceptionCallback=bool(*)(Isolate*);
  ~Isolate();
  void InitializeNativeInterrupts(JSContext*);
  void RequestInterrupt(InterruptCallback,void*);
  void InvokeApiInterruptCallbacks();
  void DrainNativeInterruptsForCleanup();
  // Final engine disposal only, after all callback producers have stopped.
  void CloseNativeInterrupts();
  class DisallowJavascriptExecutionScope {
    std::shared_ptr<v8::State> owner_;
    uint8_t mask_,previous_;
   public:
    enum OnFailure { CRASH_ON_FAILURE, THROW_ON_FAILURE };
    DisallowJavascriptExecutionScope(Isolate*,OnFailure);
    ~DisallowJavascriptExecutionScope();
    DisallowJavascriptExecutionScope(const DisallowJavascriptExecutionScope&)=delete;
    DisallowJavascriptExecutionScope& operator=(const DisallowJavascriptExecutionScope&)=delete;
  };
  class AllowJavascriptExecutionScope {
    std::shared_ptr<v8::State> owner_;
    uint8_t previous_;
   public:explicit AllowJavascriptExecutionScope(Isolate*);~AllowJavascriptExecutionScope();
    AllowJavascriptExecutionScope(const AllowJavascriptExecutionScope&)=delete;
    AllowJavascriptExecutionScope& operator=(const AllowJavascriptExecutionScope&)=delete;
  };
  class SuppressMicrotaskExecutionScope {
    std::unique_ptr<MicrotaskSuppressionData> data_;
   public:
    explicit SuppressMicrotaskExecutionScope(Isolate*,MicrotaskQueue* = nullptr);
    ~SuppressMicrotaskExecutionScope();
    SuppressMicrotaskExecutionScope(const SuppressMicrotaskExecutionScope&)=delete;
    SuppressMicrotaskExecutionScope& operator=(const SuppressMicrotaskExecutionScope&)=delete;
  };
  class Scope {std::unique_ptr<IsolateScopeData> data_;public:explicit Scope(Isolate*);~Scope();};
  struct CreateParams {
    StartupData* snapshot_blob=nullptr;
    const intptr_t* external_references=nullptr;
    ArrayBuffer::Allocator* array_buffer_allocator=nullptr;
    std::shared_ptr<ArrayBuffer::Allocator> array_buffer_allocator_shared;
    CppHeap* cpp_heap=nullptr;
    ResourceConstraints constraints;
    FatalErrorCallback fatal_error_callback=nullptr;
    OOMErrorCallback oom_error_callback=nullptr;
    bool allow_atomics_wait = true;
  };
  template<class T> MaybeLocal<T> GetDataFromSnapshotOnce(size_t) {
    Crash("V8 startup snapshot deserialization is unavailable");
  }
  static Isolate* Allocate();static Isolate* Allocate(const IsolateGroup&);
  static void Initialize(Isolate*,const CreateParams&);
  void Deinitialize();static void Free(Isolate*);
  ArrayBuffer::Allocator* GetArrayBufferAllocator();
  std::shared_ptr<ArrayBuffer::Allocator> GetArrayBufferAllocatorShared();
  void SetStackLimit(uintptr_t);void LowMemoryNotification();
  void SetCaptureStackTraceForUncaughtExceptions(bool,int=10,StackTrace::StackTraceOptions=StackTrace::kOverview);
  void SetPrepareStackTraceCallback(PrepareStackTraceCallback);
  void SetAbortOnUncaughtExceptionCallback(AbortOnUncaughtExceptionCallback);
  void SetWasmStreamingCallback(FunctionCallback);
  void SetHostCreateShadowRealmContextCallback(HostCreateShadowRealmContextCallback);
  void SetIdle(bool);
  void SetFatalErrorHandler(FatalErrorCallback);
  void SetOOMErrorHandler(OOMErrorCallback);
  bool AddMessageListenerWithErrorLevel(MessageCallback,int);
  void SetPromiseRejectCallback(PromiseRejectCallback);
  void SetHostInitializeImportMetaObjectCallback(HostInitializeImportMetaObjectCallback);
  void SetHostImportModuleDynamicallyCallback(HostImportModuleDynamicallyCallback);
  void SetHostImportModuleWithPhaseDynamicallyCallback(HostImportModuleWithPhaseDynamicallyCallback);
  void SetModifyCodeGenerationFromStringsCallback(ModifyCodeGenerationFromStringsCallback2);
  void SetAllowWasmCodeGenerationCallback(AllowWasmCodeGenerationCallback);
  void SetPromiseHook(PromiseHook);
  void SetMicrotasksPolicy(MicrotasksPolicy);
  MicrotasksPolicy GetMicrotasksPolicy()const;
  void PerformMicrotaskCheckpoint();
  void ClearKeptObjects();
  static Isolate* GetCurrent();
  std::string GetDefaultLocale();
  std::weak_ptr<State> owner;
  Factory factory_{this};
  Factory* factory() { return &factory_; }
  Local<Context> GetCurrentContext();
  Local<Value> GetContinuationPreservedEmbedderDataV2();
  void SetContinuationPreservedEmbedderDataV2(Local<Value>);
  void ThrowException(Local<Value>);
  bool HasPendingException();
  void TerminateExecution();
  bool IsExecutionTerminating();
  void CancelTerminateExecution();
  void GetHeapStatistics(HeapStatistics*);
  uint64_t GetHashSeed();
  bool MeasureMemory(std::unique_ptr<MeasureMemoryDelegate>,MeasureMemoryExecution = MeasureMemoryExecution::kDefault);
  int64_t AdjustAmountOfExternalAllocatedMemory(int64_t);
  size_t NumberOfHeapSpaces();
  bool GetHeapSpaceStatistics(HeapSpaceStatistics*,size_t);
  bool GetHeapCodeAndMetadataStatistics(HeapCodeStatistics*);
  HeapProfiler* GetHeapProfiler();
  uint16_t* RegisterEmbedderDataType(const char*,size_t);
  static Isolate* TryGetCurrent();bool InContext();
  CppHeap* GetCppHeap();
  enum MessageErrorLevel{kMessageError=1,kMessageWarning=2};
  enum class TimeZoneDetection{kRedetect,kSkip};
  void DateTimeConfigurationChangeNotification(TimeZoneDetection);
};
// Callback records retain the upstream borrowed-data signatures. No callback
// is executed and no graph is created by the unavailable snapshot operations.
struct SerializeInternalFieldsCallback {
  using CallbackFunction=StartupData(*)(Local<Object>,int,void*);
  CallbackFunction callback;void* data;
  SerializeInternalFieldsCallback(CallbackFunction fn=nullptr,void* arg=nullptr):callback(fn),data(arg){}
};
struct SerializeContextDataCallback {
  using CallbackFunction=StartupData(*)(Local<Context>,int,void*);
  CallbackFunction callback;void* data;
  SerializeContextDataCallback(CallbackFunction fn=nullptr,void* arg=nullptr):callback(fn),data(arg){}
};
struct SerializeAPIWrapperCallback {
  using CallbackFunction=StartupData(*)(Local<Object>,void*,void*);
  CallbackFunction callback;void* data;
  explicit SerializeAPIWrapperCallback(CallbackFunction fn=nullptr,void* arg=nullptr):callback(fn),data(arg){}
};
class SnapshotCreator {
 public:
  enum class FunctionCodeHandling{kClear,kKeep};
  explicit SnapshotCreator(const intptr_t* = nullptr,const StartupData* = nullptr){
    Crash("V8 startup snapshot creation is unavailable");
  }
  explicit SnapshotCreator(Isolate*,const intptr_t* = nullptr,const StartupData* = nullptr,bool = true){
    Crash("V8 startup snapshot creation is unavailable");
  }
  explicit SnapshotCreator(const Isolate::CreateParams&){
    Crash("V8 startup snapshot creation is unavailable");
  }
  SnapshotCreator(Isolate*,const Isolate::CreateParams&){
    Crash("V8 startup snapshot creation is unavailable");
  }
  SnapshotCreator(const SnapshotCreator&)=delete;
  void operator=(const SnapshotCreator&)=delete;
  Isolate* GetIsolate(){Crash("V8 startup snapshot ownership is unavailable");}
  void SetDefaultContext(Local<Context>,SerializeInternalFieldsCallback = {},
      SerializeContextDataCallback = {},SerializeAPIWrapperCallback = SerializeAPIWrapperCallback()){
    Crash("V8 startup snapshot serialization is unavailable");
  }
  size_t AddContext(Local<Context>,SerializeInternalFieldsCallback = {},
      SerializeContextDataCallback = {},SerializeAPIWrapperCallback = SerializeAPIWrapperCallback()){
    Crash("V8 startup snapshot serialization is unavailable");
  }
  template<class T> size_t AddData(Local<Context>,Local<T>){
    Crash("V8 startup snapshot serialization is unavailable");
  }
  template<class T> size_t AddData(Local<T>){
    Crash("V8 startup snapshot serialization is unavailable");
  }
  StartupData CreateBlob(FunctionCodeHandling){
    Crash("V8 startup snapshot serialization is unavailable");
  }
};
Local<Primitive> Undefined(Isolate*);
Local<Primitive> Null(Isolate*);
struct HandleScopeEntry;
struct LockerData;struct SealHandleScopeData;
class Locker {
  std::unique_ptr<LockerData> data_;
 public:
  explicit Locker(Isolate*);~Locker();
  static bool IsLocked(Isolate*);
  Locker(const Locker&)=delete;Locker& operator=(const Locker&)=delete;
};
class SealHandleScope {
  std::unique_ptr<SealHandleScopeData> data_;
 public:
  explicit SealHandleScope(Isolate*);~SealHandleScope();
  SealHandleScope(const SealHandleScope&)=delete;
  SealHandleScope& operator=(const SealHandleScope&)=delete;
};
class HandleScope {
  std::unique_ptr<HandleScopeEntry> entry_;
 protected:
  Frame* frame_;size_t previous_,previousContexts_,previousLevel_;
  HandleScope* previousScope_;
  void CheckEscape()const;
 public:
  Local<Value> EscapeRoot(Local<Value>);
  Local<Data> EscapeRoot(Local<Data>);
  Local<Context> EscapeRoot(Local<Context>);
 public: explicit HandleScope(Isolate*);~HandleScope();
};
class EscapableHandleScope : public HandleScope {
  bool escaped_=false;
 public:
  explicit EscapableHandleScope(Isolate*);
  template<class T> Local<T> Escape(Local<T> value) {
    // Upstream v8-local-handle.h returns an empty handle without using the
    // escape slot. Node HTTPParser uses this for EOF and pending exceptions.
    if(value.IsEmpty())return value;
    if(escaped_) Crash("Native handle scope escaped twice");escaped_=true;
    if constexpr(std::is_same_v<T,Context>)return EscapeRoot(Local<Context>(value));
    else return EscapeRoot(Local<Data>(value)).template As<T>();
  }
  template<class T> MaybeLocal<T> EscapeMaybe(MaybeLocal<T> value) {
    if(value.IsEmpty())return {};return Escape(value.ToLocalChecked());
  }
};
class ExternalMemoryAccounter {
  std::unique_ptr<MemoryAccount> account_;
 public:
  ExternalMemoryAccounter();~ExternalMemoryAccounter();
  void Increase(Isolate*,size_t);void Decrease(Isolate*,size_t);
  void Update(Isolate*,int64_t);
};
Local<Value> Argument(Isolate*,int);
Local<Value> True(Isolate*);
Local<Value> False(Isolate*);
void Return(Isolate*,Local<Value>);
void ReturnNumber(Isolate*,double);
void ReturnBoolean(Isolate*,bool);
int ArgumentCount(Isolate*);
bool CallbackIsConstructCall(Isolate*);
Local<Object> Receiver(Isolate*);
Local<Object> PropertyHolder(Isolate*);
bool PropertyShouldThrowOnError(Isolate*);
Local<Value> PropertyData(Isolate*);
Local<Value> CallbackData(Isolate*);
Local<Value> CallbackNewTarget(Isolate*);
void ReturnRaw(Isolate*, const JS::Value&);
void ReturnNull(Isolate*);
template<class T> class ReturnValue {
  Isolate* isolate_;
 public: explicit ReturnValue(Isolate* isolate):isolate_(isolate) {}
  void Set(Local<T> value) const { Return(isolate_,value); }
  void Set(bool value) const { ReturnBoolean(isolate_,value); }
  void SetTrue()const{ReturnBoolean(isolate_,true);}
  void SetFalse()const{ReturnBoolean(isolate_,false);}
  void Set(int32_t value) const { ReturnNumber(isolate_,value); }
  void Set(uint32_t value) const { ReturnNumber(isolate_,value); }
  void Set(double value) const { ReturnNumber(isolate_,value); }
  void Set(int64_t value) const { ReturnNumber(isolate_,double(value)); }
  void Set(uint64_t value) const { ReturnNumber(isolate_,double(value)); }
  void SetEmptyString() const { Return(isolate_,String::Empty(isolate_)); }
  void SetUndefined()const{Return(isolate_,Undefined(isolate_));}
  void SetNull()const{ReturnNull(isolate_);}
};
template<class T> class FunctionCallbackInfo {
  Isolate* isolate_;
 public:
  explicit FunctionCallbackInfo(Isolate* isolate):isolate_(isolate) {}
  Isolate* GetIsolate() const { return isolate_; }
  int Length() const { return ArgumentCount(isolate_); }
  bool IsConstructCall()const{return CallbackIsConstructCall(isolate_);}
  Local<Value> NewTarget()const{return CallbackNewTarget(isolate_);}
  Local<Value> operator[](int index) const { return Argument(isolate_,index); }
  Local<Object> This() const { return Receiver(isolate_); }
  Local<Value> Data() const { return CallbackData(isolate_); }
  ReturnValue<T> GetReturnValue() const { return ReturnValue<T>(isolate_); }
};
// Consumed property callback interface. Explicit operation modes are retained;
// otherwise infer the nearest real script language mode, as upstream does.
template<class T> class PropertyCallbackInfo {
  Isolate* isolate_;
 public:
  explicit PropertyCallbackInfo(Isolate* isolate):isolate_(isolate) {}
  Isolate* GetIsolate() const { return isolate_; }
  Local<Value> Data() const { return PropertyData(isolate_); }
  Local<Object> HolderV2() const { return PropertyHolder(isolate_); }
  bool ShouldThrowOnError()const{
    if constexpr(std::is_same_v<T,Boolean>||std::is_void_v<T>)
      return PropertyShouldThrowOnError(isolate_);
    return false;
  }
  ReturnValue<T> GetReturnValue() const { return ReturnValue<T>(isolate_); }
};
struct CatchScope;
class TryCatch {
  std::unique_ptr<CatchScope> scope_;
 public: explicit TryCatch(Isolate*);~TryCatch();
 TryCatch(const TryCatch&)=delete;TryCatch& operator=(const TryCatch&)=delete;
 bool HasCaught()const;bool HasTerminated()const;bool IsVerbose()const;bool CanContinue()const;
 Local<Value> Exception()const;Local<v8::Message> Message()const;
 Local<Value> ReThrow();void Reset();void SetVerbose(bool);
};
class Exception {
 public: static Local<Value> Error(Local<String>,Local<Value> = {});
 static Local<Value> RangeError(Local<String>,Local<Value> = {});
 static Local<Value> ReferenceError(Local<String>,Local<Value> = {});
 static Local<Value> TypeError(Local<String>,Local<Value> = {});
 static Local<Value> SyntaxError(Local<String>,Local<Value> = {});
 static Local<Message> CreateMessage(Isolate*,Local<Value>);
 static Local<StackTrace> GetStackTrace(Local<Value>);
};
// Consumed graph/transfer interfaces. No graph or transfer value can be
// constructed through these declarations without its owning engine backend.
size_t NewEternalRoot(Isolate*,Local<Data>);
Local<Data> ReadEternalRoot(Isolate*,size_t);
// These roots belong to the engine, rather than to the C++ handle's lifetime.
// Copying or destroying an Eternal must not release an IsolateData string,
// private key or template that another copied handle still names.
template<class T> class Eternal {
  static_assert(std::is_base_of_v<Data,T>);
  Isolate* owner_=nullptr;
  size_t index_=std::numeric_limits<size_t>::max();
 public:
  Eternal()=default;
  template<class S> requires(std::is_base_of_v<T,S>)
  Eternal(Isolate* isolate,Local<S> handle){Set(isolate,handle);}
  bool IsEmpty()const{return index_==std::numeric_limits<size_t>::max();}
  Local<T> Get(Isolate* isolate)const {
    // Upstream Local::FromSlot preserves null as an empty Local. Node uses
    // this when checking its lazily initialized per-isolate templates.
    if(IsEmpty())return {};
    if(owner_!=isolate)Crash("Invalid native Eternal owner");
    return ReadEternalRoot(isolate,index_).template As<T>();
  }
  template<class S> requires(std::is_base_of_v<T,S>)
  void Set(Isolate* isolate,Local<S> handle){
    index_=NewEternalRoot(isolate,handle);owner_=isolate;
  }
};
class ValueSerializer;class ValueDeserializer;
class CompiledWasmModule {
  struct Data;std::unique_ptr<Data> data_;
  CompiledWasmModule()=delete;
 public:~CompiledWasmModule();CompiledWasmModule(CompiledWasmModule&&)noexcept;
};
// General guest Wasm is an approved later iteration. These source interfaces
// let the complete original Node owners compile; no operation constructs a
// fake module, memory, streaming job or successful transfer in this runtime.
class WasmModuleObject:public Object {
 public:
  using Object::Object;
  CompiledWasmModule GetCompiledModule(){Crash("General guest WebAssembly is deferred");}
  static MaybeLocal<WasmModuleObject> FromCompiledModule(Isolate*,const CompiledWasmModule&){
    Crash("General guest WebAssembly is deferred");
  }
};
class WasmMemoryObject:public Object {
 public:
  using Object::Object;
  Local<ArrayBuffer> Buffer(){Crash("General guest WebAssembly is deferred");}
};
class WasmStreaming {
  WasmStreaming()=delete;
 public:
  class ModuleCachingInterface;
  using ModuleCachingCallback=std::function<void(ModuleCachingInterface&)>;
  static std::shared_ptr<WasmStreaming> Unpack(Isolate*,Local<Value>){
    Crash("General guest WebAssembly streaming is deferred");
  }
  void SetUrl(const char*,size_t){Crash("General guest WebAssembly streaming is deferred");}
  void OnBytesReceived(const uint8_t*,size_t){Crash("General guest WebAssembly streaming is deferred");}
  void Finish(const ModuleCachingCallback&){Crash("General guest WebAssembly streaming is deferred");}
  void Abort(Local<Value>){Crash("General guest WebAssembly streaming is deferred");}
};
// Native script caches have real engine-owned data and an explicit verdict.
// Definitions remain required from the backend; no default-success check.

class Date : public Object {
 public:
  using Object::Object;
  static MaybeLocal<Value> New(Local<Context>,double);
  double ValueOf()const;
};
enum PromiseRejectEvent {
  kPromiseRejectWithNoHandler=0,kPromiseHandlerAddedAfterReject=1,
  kDeprecatedPromiseRejectAfterResolved=2,kDeprecatedPromiseResolveAfterResolved=3
};
class PromiseRejectMessage {
  Local<Promise> promise_;PromiseRejectEvent event_;Local<Value> value_;
 public:
  PromiseRejectMessage(Local<Promise>,PromiseRejectEvent,Local<Value>);
  Local<Promise> GetPromise()const;
  PromiseRejectEvent GetEvent()const;
  Local<Value> GetValue()const;
};
}
namespace v8 {

// Private native compilation facts, never properties on user Error objects.
// Node retains the final immediate/conditional/no-retry policy and wrapper names.
enum class NativeCompileDiagnosticKind {
  Unclassified, DefiniteModuleSyntax, Redeclaration, ConditionalModule,
  UnrelatedSyntax
};
struct NativeCompileDiagnostic {
  NativeCompileDiagnosticKind kind=NativeCompileDiagnosticKind::Unclassified;
  uint32_t engineCode=0;
  Local<String> engineName,word,identifier;
  uint16_t actualToken=UINT16_MAX,expectedToken=UINT16_MAX;
  uint8_t origin=0;
  bool escaped=false,inModule=false;
};
class Message:public Data {
 public:
 using Data::Data;bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
 static constexpr int kNoScriptIdInfo=0,kNoColumnInfo=0,kNoLineNumberInfo=0;
 Local<Value> GetScriptResourceName();Maybe<int> GetLineNumber(Local<Context>);
 int GetStartColumn();int GetEndColumn();ScriptOrigin GetScriptOrigin();
 MaybeLocal<String> GetSourceLine(Local<Context>);Local<StackTrace> GetStackTrace();
 int ErrorLevel();Local<String> Get();
 NativeCompileDiagnostic GetNativeCompileDiagnostic();
};
class StackFrame:public Data {
 public:
 using Data::Data;bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
 Local<String> GetFunctionName();Local<String> GetScriptName();Local<String> GetScriptNameOrSourceURL();
 int GetLineNumber();int GetColumn();bool IsEval();int GetScriptId();
};

}
namespace v8 {

}
#include "property-interceptor-native-api.h"
#include "v8-source-api/v8-fast-api-calls.h"
#include "engine-script-api.h"
#include "v8-source-api/v8-profiler.h"
#include "v8-source-api/v8-regexp.h"
#include "v8-source-api/v8-value-serializer.h"
#endif
