
#include "mozilla/Assertions.h"
#include "mozilla/ScopeExit.h"

#include <atomic>
#include <cmath>
#include <cstdio>
#include <locale.h>
#include <malloc.h>
#include <map>
#include <set>
#include <strings.h>
#include <tuple>
#include <unistd.h>
#include <utility>
#include <vector>

#include "jsapi.h"
#include "jsfriendapi.h"

#include "gc/GC.h"
#include "gc/GCInternals.h"
#include "gc/GCLock.h"
#include "gc/GCRuntime.h"
#include "gc/Nursery.h"
#include "jit/AtomicOperations.h"
#include "js/Array.h"
#include "js/ArrayBuffer.h"
#include "js/BigInt.h"
#include "js/CallAndConstruct.h"
#include "js/Context.h"
#include "js/CallArgs.h"
#include "js/CharacterEncoding.h"
#include "js/CompilationAndEvaluation.h"
#include "js/Conversions.h"
#include "js/Date.h"
#include "js/EnvironmentChain.h"
#include "js/Equality.h"
#include "js/ErrorReport.h"
#include "js/Exception.h"
#include "js/experimental/TypedData.h"
#include "js/friend/WindowProxy.h"
#include "js/GCAPI.h"
#include "js/GlobalObject.h"
#include "js/Initialization.h"
#include "js/Interrupt.h"
#include "js/JSON.h"
#include "js/MemoryFunctions.h"
#include "js/MemoryMetrics.h"
#include "js/Modules.h"
#include "js/ScriptPrivate.h"
#include "js/experimental/JSStencil.h"
#include "builtin/ModuleObject.h"
#include "vm/BytecodeUtil.h"
#include "vm/GeneratorObject.h"
#include "frontend/CompilationStencil.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/Promise.h"
#include "js/Realm.h"
#include "js/RealmOptions.h"
#include "js/SavedFrameAPI.h"
#include "js/SharedArrayBuffer.h"
#include "js/SourceText.h"
#include "js/MapAndSet.h"
#include "js/Date.h"
#include "js/StableStringChars.h"
#include "js/Stack.h"
#include "js/String.h"
#include "js/Symbol.h"
#include "js/TracingAPI.h"
#include "js/WeakMap.h"
#include "js/Wrapper.h"
#include "vm/BigIntType.h"
#include "kandelo-node/error-stack.h"
#include "kandelo-node/buffer-memory.h"
#include "kandelo-node/engine-native-api.h"
#include "kandelo-node/engine-state.h"
#include "kandelo-node/trace-utf8-native.h"
#include <uv.h>
#include "kandelo-node/engine-checks.h"
#include "kandelo-node/engine-process.h"
#include "kandelo-node/engine-build-identity.h"
#include "kandelo-node/node-stencil-cache-format.h"
#include "util/StringBuilder.h"
#include "util/Unicode.h"
#pragma push_macro("NO_DATA")
#undef NO_DATA
#include "vm/ArrayBufferObject.h"
#include "vm/ArrayBufferViewObject.h"
#include "vm/ArrayObject.h"
#include "vm/ErrorObject.h"
#include "vm/JSAtomUtils.h"
#include "vm/JSContext.h"
#include "vm/JSFunction.h"
#include "vm/NativeObject.h"
#include "vm/PromiseObject.h"
#include "vm/Realm.h"
#include "vm/RegExpObject.h"
#include "vm/Runtime.h"
#include "vm/SavedFrame.h"
#include "vm/SharedArrayObject.h"
#include "vm/StringType.h"
#include "vm/SymbolType.h"

#include "vm/JSAtomUtils-inl.h"
#include "vm/Realm-inl.h"
#pragma pop_macro("NO_DATA")

namespace api = v8;
namespace v8 {
bool InitializeNativeInternalFields(Frame&,JS::HandleObject,int);
bool AdmitNativeReceiver(Frame&,JS::HandleValue);
// Native ownership, realm and signature branding never alias API data fields.
enum NativeWrapperSlot {NativeOwnerPointer,NativeOwnerRealm,NativeTemplateBrand,
  NativeInternalFields,
  NativeCppgcAssociation,
  NativeWrapperSlotCount};
void FinalizeNativeWrapperGc(JSObject*);
void TraceNativeWrapperGc(JSTracer*,JSObject*);
void FinalizeNativeWrapper(JS::GCContext*,JSObject* object){
  FinalizeNativeWrapperGc(object);
  JS::SetReservedSlot(object,NativeOwnerPointer,JS::UndefinedValue());
}
const JSClassOps nativeWrapperOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeNativeWrapper,
  nullptr,nullptr,
  TraceNativeWrapperGc
};
const JSClass icuBindingClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(1)};
// Borrowed pointers have no JS edges or automatic deleter. Their original
// native Node owners retain resource lifetime; an External is a value carrier.
const JSClass nativeExternalClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(2)};
// The dispatcher belongs to the JSContext, before and after any Environment.
// Lookup is native and owner-thread-only; late notifications find no owner.
static thread_local std::map<JSContext*,std::shared_ptr<State>> nativeEngineOwners;
static void RetireNativeEngineState(JSContext*);
static void RestoreNativeModuleHooks(State&);
enum class Domain { Native, Decoder, Icu, Trace, Continuation, Environment, Buffer, Snapshot, Diagnostics, NativeProperty };
const JSClass traceBindingClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(3)};
const JSClass continuationBindingClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(1)};
struct Cell {
  JSContext* const context;
  JS::PersistentRootedValue value;
  std::vector<std::unique_ptr<Data>> typedViews;
  Cell(JSContext* cx, JS::HandleValue input) : context(cx),value(cx, input) {}
};
template<class T> std::unique_ptr<Data> CloneWrapper(Isolate* isolate,std::unique_ptr<Cell> cell) {
  auto owner=isolate->owner.lock();CHECK(owner&&owner->cx==cell->context);owner->AssertForeground();
  if constexpr(std::is_same_v<T,Context>)return std::make_unique<Context>(isolate,std::move(cell));
  else return std::make_unique<T>(std::move(cell),&CloneWrapper<T>);
}
struct Frame {
  JSContext* cx;
  JS::RootedObject realm;
  JS::RootedObject binding;
  JS::RootedValue receiver;
  JS::RootedObject propertyHolder;
  JS::RootedValue propertyData, propertyReturn, callbackData;
  std::optional<bool> propertyShouldThrow;
  std::shared_ptr<State> state;
  JS::CallArgs* arguments;
  Domain domain;
  std::vector<std::unique_ptr<Data>> roots;
  std::vector<std::unique_ptr<Context>> contexts;
  std::vector<std::unique_ptr<SpanOwner>> spans;
  std::vector<std::shared_ptr<void>> storage;
  Frame* previous;
  inline static thread_local Frame* current = nullptr;
  Frame(JSContext* cx, JS::HandleObject realm, std::shared_ptr<State> state,
        JS::CallArgs* arguments = nullptr, Domain domain =
        Domain::Native)
      : cx(cx), realm(cx, realm), binding(cx), receiver(cx), propertyHolder(cx), propertyData(cx), propertyReturn(cx), callbackData(cx), state(std::move(state)), arguments(arguments), domain(domain),
        previous(current) { current = this; }
  ~Frame();
  template<class T> Local<T> Own(JS::HandleValue value) {
    state->CheckLocalHandleAllocation();
    JS::RootedValue stored(cx,value);
    if constexpr(std::is_same_v<T,Private>){
      MOZ_RELEASE_ASSERT(stored.isSymbol());JS::RootedSymbol symbol(cx,stored.toSymbol());
      MOZ_RELEASE_ASSERT(JS::GetSymbolCode(symbol)==JS::SymbolCode::UniqueSymbol);
    }else if constexpr(!std::is_base_of_v<Value,T>){
      MOZ_RELEASE_ASSERT(stored.isObject());
      JS::RootedObject object(cx,js::CheckedUnwrapDynamic(&stored.toObject(),cx,false));MOZ_RELEASE_ASSERT(object);stored.setObject(*object);
    }
    auto item = CloneWrapper<T>(&state->isolate,std::make_unique<Cell>(cx, stored));
    auto* pointer = static_cast<T*>(item.get()); roots.push_back(std::move(item));
    return Local<T>(pointer);
  }
  Local<Value> OwnValue(JS::HandleValue value);
  template<class T> Local<T> OwnTypedView(const Data& source){
    static_assert(std::is_base_of_v<Value,T>);
    CHECK(source.IsValue()&&source.cell().context==cx);state->AssertForeground();
    // A cast changes only the C++ view, not the GC root or scope admission.
    // Cache it on that Cell so an escaped handle keeps its typed view, while
    // retiring the root also retires every view without a reference cycle.
    auto& cell=source.cell();
    for(const auto& view:cell.typedViews)
      if(view->RootFactoryForStorage()==&CloneWrapper<T>)return Local<T>(static_cast<T*>(view.get()));
    try {
      auto item=std::make_unique<T>(&cell,&CloneWrapper<T>);
      auto* result=item.get();cell.typedViews.push_back(std::move(item));return Local<T>(result);
    }catch(const std::bad_alloc&){
      bridge::FatalOutOfMemory(&state->isolate,"Native typed handle view allocation",false);
    }
  }
  Local<Data> OwnClone(const Data& source,JS::HandleValue value) {
    state->CheckLocalHandleAllocation();
    auto item=source.CloneRoot(&state->isolate,std::make_unique<Cell>(cx,value));
    auto* pointer=item.get();roots.push_back(std::move(item));return Local<Data>(pointer);
  }
  Local<Context> OwnContext(JS::HandleObject global) {
    state->CheckLocalHandleAllocation();
    MOZ_RELEASE_ASSERT(JS_IsGlobalObject(global));
    JS::RootedValue value(cx,JS::ObjectValue(*global));
    auto context=std::make_unique<Context>(&state->isolate,std::make_unique<Cell>(cx,value));
    auto* pointer=context.get();contexts.push_back(std::move(context));return Local<Context>(pointer);
  }
  SpanOwner& Borrow(Local<Value> value);
};
[[noreturn]] void Crash(const char* text) {
  bridge::CallFatalErrorHandler(text);
  kandelo_v8_graceful_fatal(text);
}
static Frame& Current(Isolate* isolate) {
  MOZ_RELEASE_ASSERT(Frame::current);
  MOZ_RELEASE_ASSERT(&Frame::current->state->isolate == isolate);
  return *Frame::current;
}
namespace {void CheckNativePrimitiveAccess(Frame&);JSObject* NativePrimitiveRealm(Frame&);}
static void CaptureNativeException(State&);
static void CompleteNativeApiException(State&,bool);
// A JavaScript call can reenter native code. Only the handler at the returning
// API depth may catch its failure; an outer native handler must let intervening
// JavaScript catch/finally blocks run first.
struct NativeEntry {
  State& state;
  JSContext* cx;
  bool pendingAtEntry=false;
  std::shared_ptr<NativeMicrotaskData> autoQueue;
  void CaptureAutoQueue(Local<Context> = {});
  explicit NativeEntry(Frame& frame,Local<Context> context={}):state(*frame.state),cx(frame.cx) {
    CHECK(!JS::RuntimeHeapIsCollecting());
    if(!cx->embedderExecutionRestrictions())CaptureNativeException(state);
    pendingAtEntry=JS_IsExceptionPending(cx);++state.nativeEntryDepth;
    CaptureAutoQueue(context);
  }
  bool Terminated()const { return cx->isNativeExecutionTerminating(); }
  ~NativeEntry() {
    --state.nativeEntryDepth;CompleteNativeApiException(state,pendingAtEntry);
    if(!state.nativeEntryDepth&&!JS_IsExceptionPending(cx)&&!cx->isNativeExecutionTerminating()){
      bridge::OnNativeCallCompleted(&state.isolate,autoQueue);CompleteNativeApiException(state,false);
    }
  }
};
// Equivalent native API failure bookkeeping without a JavaScript-return
// callback/checkpoint. Compiler and other no-script APIs use this boundary.
struct NativeNoScriptEntry {
  State& state;JSContext* cx;bool pendingAtEntry=false;
  explicit NativeNoScriptEntry(Frame& frame):state(*frame.state),cx(frame.cx){
    state.AssertForeground();CHECK(cx==js::TlsContext.get()&&!JS::RuntimeHeapIsCollecting());
    if(!cx->embedderExecutionRestrictions())CaptureNativeException(state);
    pendingAtEntry=JS_IsExceptionPending(cx);++state.nativeEntryDepth;
  }
  ~NativeNoScriptEntry(){--state.nativeEntryDepth;CompleteNativeApiException(state,pendingAtEntry);}
  bool Terminated()const{return cx->isNativeExecutionTerminating();}
};
// Engine-to-native delivery is not a returning API boundary. Preserve any
// pending exception/stop and prevent a nested native API from catching an
// enclosing handler before JavaScript catch/finally executes. Unlike NativeEntry
// this guard neither captures exceptions nor performs an automatic checkpoint.
struct NativeCallbackEntry {
  State& state;
  explicit NativeCallbackEntry(State& input):state(input){
    state.AssertForeground();CHECK(state.cx==js::TlsContext.get());
    ++state.nativeEntryDepth;
  }
  ~NativeCallbackEntry(){
    CHECK(state.cx==js::TlsContext.get()&&state.nativeEntryDepth);
    --state.nativeEntryDepth;
  }
  NativeCallbackEntry(const NativeCallbackEntry&)=delete;
  NativeCallbackEntry& operator=(const NativeCallbackEntry&)=delete;
};
static void StressCollection(Frame& frame) {
  if (!frame.state->stressGc) return;
  const uint32_t before=JS_GetGCParameter(frame.cx,JSGC_NUMBER);
  JS::PrepareForFullGC(frame.cx);
  JS::NonIncrementalGC(frame.cx,JS::GCOptions::Shrink,JS::GCReason::API);
  const uint32_t after=JS_GetGCParameter(frame.cx,JSGC_NUMBER);
  MOZ_RELEASE_ASSERT(after!=before);
  frame.state->collections.fetch_add(uint32_t(after-before));
}
static JS::HandleValue Input(Local<Data> value) {
  MOZ_RELEASE_ASSERT(!value.IsEmpty()); return value->cell().value;
}
static JSObject* UnwrapView(JSContext* cx, JS::HandleValue input) {
  if (!input.isObject()) return nullptr;
  JS::RootedObject object(cx, &input.toObject());
  object = js::CheckedUnwrapDynamic(object, cx, false);
  return object && JS_IsArrayBufferViewObject(object) ? object.get() : nullptr;
}
static JSObject* UnwrapObject(JSContext* cx, JS::HandleValue input) {
  if (!input.isObject()) return nullptr;
  JS::RootedObject object(cx,&input.toObject());
  return js::CheckedUnwrapDynamic(object,cx,false);
}
static JSObject* UnwrapBytes(JSContext* cx, JS::HandleValue input) {
  JSObject* object=UnwrapObject(cx,input);
  return object && (JS_IsArrayBufferViewObject(object) || JS::IsArrayBufferObject(object) ||
                    JS::IsSharedArrayBufferObject(object)) ? object : nullptr;
}
Data::Data(std::unique_ptr<Cell> cell,RootFactory factory):cell_(std::move(cell)),rootFactory_(factory){MOZ_RELEASE_ASSERT(factory);}
Data::Data(Cell* cell,RootFactory factory):typedViewCell_(cell),rootFactory_(factory){MOZ_RELEASE_ASSERT(cell&&factory);}
Data::~Data()=default;
Cell& Data::cell()const{return cell_?*cell_:*typedViewCell_;}
std::unique_ptr<Data> Data::CloneRoot(Isolate* isolate,std::unique_ptr<Cell> cell)const{CHECK(cell->context==this->cell().context);return rootFactory_(isolate,std::move(cell));}
Value::Value(std::unique_ptr<Cell> cell,RootFactory factory):Data(std::move(cell),factory?factory:&CloneWrapper<Value>){}
Value::Value(Cell* cell,RootFactory factory):Data(cell,factory){}
Value::~Value()=default;
template<class T> static Local<T> NativeConstant(Isolate* isolate,
    std::unique_ptr<T> State::*slot,const JS::Value& input){
  auto state=isolate->owner.lock();CHECK(state&&state->cx==js::TlsContext.get());
  state->AssertForeground();
  auto& root=(*state).*slot;
  if(!root){
    // The immediate values and SpiderMonkey's existing runtime empty string
    // need no allocation realm or new GC object.
    // Reading an Isolate root does not allocate a local handle, including
    // when the caller has sealed its current HandleScope.
    if constexpr(std::is_same_v<T,String>)CHECK(input.isString()&&input.toString()==JS_GetEmptyString(state->cx));
    else CHECK(input.isNullOrUndefined()||input.isBoolean());
    JS::RootedValue value(state->cx,input);
    root=std::make_unique<T>(std::make_unique<Cell>(state->cx,value),&CloneWrapper<T>);
  }
  return Local<T>(root.get());
}
Local<Primitive> Null(Isolate* isolate){return NativeConstant(isolate,&State::nullConstant,JS::NullValue());}
void Isolate::DateTimeConfigurationChangeNotification(TimeZoneDetection detection) {
  auto& f=Current(this);f.state->AssertForeground();
  CHECK(detection==TimeZoneDetection::kRedetect);JS::ResetTimeZone();
}
bool Value::IsValue()const{return true;}
bool Value::IsPrivate()const{return false;}
bool Value::IsBigInt()const{return cell().value.isBigInt();}
bool Value::IsNull()const{return cell().value.isNull();}
bool Value::IsString() const { return cell().value.isString(); }
bool Value::IsSymbol() const { return cell().value.isSymbol(); }
bool Value::IsArray() const { auto* object=UnwrapObject(Frame::current->cx,cell().value);return object && object->is<js::ArrayObject>(); }
bool Value::IsFunction() const { return cell().value.isObject() && JS::IsCallable(&cell().value.toObject()); }
bool Value::IsNumber() const { return cell().value.isNumber(); }
bool Value::IsUndefined() const { return cell().value.isUndefined(); }
bool Value::IsNullOrUndefined() const { return cell().value.isNullOrUndefined(); }
double Value::NumberValue(Value* value) { CHECK(value->IsNumber());return value->cell().value.toNumber(); }
bool Value::IsArrayBufferView() const {
  return UnwrapView(Frame::current->cx, cell().value) != nullptr;
}
bool Value::IsArrayBuffer() const { auto* o=UnwrapObject(Frame::current->cx,cell().value);return o && JS::IsArrayBufferObject(o); }
bool Value::IsSharedArrayBuffer() const { auto* o=UnwrapObject(Frame::current->cx,cell().value);return o && JS::IsSharedArrayBufferObject(o); }
bool Value::IsBoolean() const { return cell().value.isBoolean(); }
bool Value::IsFloat64Array() const {
  auto* view=UnwrapView(Frame::current->cx,cell().value);
  return view&&JS_GetArrayBufferViewType(view)==JS::Scalar::Float64;
}
bool Value::IsTrue() const { return cell().value.isBoolean() && cell().value.toBoolean(); }
bool Value::IsInt32() const {
  auto value=cell().value.get();if (!value.isNumber()) return false;
  double n=value.toNumber();return std::isfinite(n) && !(n==0 && std::signbit(n)) &&
      n>=INT32_MIN && n<=INT32_MAX && std::trunc(n)==n;
}
bool Value::IsUint32() const {
  auto value=cell().value.get();if (!value.isNumber()) return false;
  double n=value.toNumber();return std::isfinite(n) && !(n==0 && std::signbit(n)) &&
      n>=0 && n<=UINT32_MAX && std::trunc(n)==n;
}
Maybe<uint32_t> Value::Uint32Value(Local<Context> context) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f,context);if(nativeEntry.Terminated())return {};Context::Scope home(context);uint32_t value;
  JS::RootedValue input(f.cx,cell().value);
  if (!JS_WrapValue(f.cx,&input)||!JS::ToUint32(f.cx,input,&value)) return {};return Just(value);
}
Maybe<int32_t> Value::Int32Value(Local<Context> context) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f,context);if(nativeEntry.Terminated())return {};Context::Scope home(context);int32_t value;
  JS::RootedValue input(f.cx,cell().value);
  if (!JS_WrapValue(f.cx,&input)||!JS::ToInt32(f.cx,input,&value)) return {};
  return Just(value);
}
Maybe<double> Value::NumberValue(Local<Context> context) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f,context);if(nativeEntry.Terminated())return {};Context::Scope home(context);double value;
  JS::RootedValue input(f.cx,cell().value);
  if(!JS_WrapValue(f.cx,&input)||!JS::ToNumber(f.cx,input,&value))return {};
  return Just(value);
}
Local<Value> Frame::OwnValue(JS::HandleValue value) {
  // Source Local::As must refer to the actual C++ wrapper type as well as the
  // actual engine value. A string-tagged base object is not a String object.
  if (value.isString()) return Own<String>(value);
  if (value.isSymbol()) return Own<Symbol>(value);
  if (value.isBigInt()) return Own<BigInt>(value);
  if (value.isBoolean()) return Own<Boolean>(value);
  if(auto* object=UnwrapObject(cx,value);object&&object->is<js::RegExpObject>())return Own<RegExp>(value);
  if (auto* view=UnwrapView(cx,value)) {
    if(JS::DataView::fromObject(view))return Own<DataView>(value);
    if(JS_IsUint8Array(view))return Own<Uint8Array>(value);
    switch(JS_GetArrayBufferViewType(view)) {
#define KANDELO_OWN_TYPED_ARRAY(Name,Kind) case JS::Scalar::Kind:return Own<Name>(value);
      KANDELO_NATIVE_TYPED_ARRAYS(KANDELO_OWN_TYPED_ARRAY)
#undef KANDELO_OWN_TYPED_ARRAY
      default:break;
    }
    return Own<ArrayBufferView>(value);
  }
  if (value.isObject()) {
    auto* object=UnwrapObject(cx,value);
    if(object&&JS::GetClass(object)==&nativeExternalClass)return Own<External>(value);
    if (object && JS::IsSharedArrayBufferObject(object)) return Own<SharedArrayBuffer>(value);
    if (object && JS::IsArrayBufferObject(object)) return Own<ArrayBuffer>(value);
    if (object && object->is<js::ArrayObject>()) return Own<Array>(value);
    if (object && object->is<js::PromiseObject>()) return Own<Promise>(value);
    if (JS::IsCallable(&value.toObject())) return Own<Function>(value);
    return Own<Object>(value);
  }
  if (value.isNumber()) {
    const double number=value.toNumber();
    if(std::isfinite(number)&&number>=0&&number<=UINT32_MAX&&std::trunc(number)==number&&!(number==0&&std::signbit(number)))return Own<Uint32>(value);
    if(std::isfinite(number)&&number>=INT32_MIN&&number<=INT32_MAX&&std::trunc(number)==number&&!(number==0&&std::signbit(number)))return Own<Int32>(value);
    return Own<Number>(value);
  }
  CHECK(value.isNullOrUndefined());return Own<Primitive>(value);
}
Local<Value> Argument(Isolate* isolate, int index) {
  auto& f = Current(isolate); MOZ_RELEASE_ASSERT(f.arguments);
  JS::RootedValue value(f.cx, f.arguments->get(index)); return f.OwnValue(value);
}
void Return(Isolate* isolate, Local<Value> value) {
  auto& f = Current(isolate);
  if (!value.IsEmpty() && !JS_IsExceptionPending(f.cx)) {
    JS::RootedValue output(f.cx,Input(value));if(JS_WrapValue(f.cx,&output))ReturnRaw(isolate,output);
  }
}
void ReturnNumber(Isolate* isolate,double value) { ReturnRaw(isolate,JS::DoubleValue(value)); }
void ReturnBoolean(Isolate* isolate,bool value) { ReturnRaw(isolate,JS::BooleanValue(value)); }
int ArgumentCount(Isolate* isolate) { auto& f=Current(isolate);CHECK(f.arguments);return int(f.arguments->length()); }
bool CallbackIsConstructCall(Isolate* isolate){auto& frame=Current(isolate);CHECK(frame.arguments);return frame.arguments->isConstructing();}
Local<Boolean> Boolean::New(Isolate* isolate,bool input){return NativeConstant(isolate,input?&State::trueConstant:&State::falseConstant,JS::BooleanValue(input));}
bool Boolean::Value()const{CHECK(cell().value.isBoolean());return cell().value.toBoolean();}
struct CatchScope {
  State& state;
  JSContext* cx;
  CatchScope* previous;
  size_t depth;
  uint64_t cancellationEpoch;
  JS::PersistentRootedValue exception;
  JS::PersistentRootedObject stack;
  JS::ExceptionStatus status=JS::ExceptionStatus::None;
  bool terminated=false,rethrow=false,verbose=false;
  JS::AutoSaveExceptionState saved;
  explicit CatchScope(Frame& frame):state(*frame.state),cx(frame.cx),
      previous(state.catchScope),depth(state.nativeEntryDepth),
      cancellationEpoch(cx->nativeTerminationSnapshot().cancellationEpoch),exception(cx),
      stack(cx),saved(cx) { state.catchScope=this; }
  bool Caught()const { return terminated||JS::IsCatchableExceptionStatus(status); }
  void Capture() {
    if(state.catchScope!=this||state.nativeEntryDepth!=depth)return;
    auto stop = cx->nativeTerminationSnapshot();
    if(stop.cancellationEpoch != cancellationEpoch) {
      // Cross-thread cancellation updates only the engine record. Retire a
      // saved termination here, on the JS thread, without touching a pending
      // ordinary exception or an enclosing catch scope from another thread.
      cancellationEpoch = stop.cancellationEpoch;
      exception = JS::UndefinedValue();stack = nullptr;
      status = JS::ExceptionStatus::None;terminated = false;rethrow = false;
    }
    if(rethrow)return;
    terminated = stop.active;
    if(terminated) {
      exception = JS::UndefinedValue();stack = nullptr;
      status = JS::ExceptionStatus::None;
      return;
    }
    if(!JS_IsExceptionPending(cx))return;
    auto pendingStatus=cx->exceptionStatus();JS::ExceptionStack pending(cx);
    if(!JS::GetPendingExceptionStack(cx,&pending)) {
      // Retrieving/wrapping a cross-realm exception may itself fail. Preserve
      // that real engine failure rather than clearing it or reporting success.
      return;
    }
    bridge::MaybeAbortOnUncaught(&state.isolate,pending.exception(),pending.stack());
    exception=pending.exception();stack=pending.stack();status=pendingStatus;
    JS_ClearPendingException(cx);
    if(verbose&&status!=JS::ExceptionStatus::OutOfMemory){
      JS::RootedValue value(cx,exception);JS::RootedObject frames(cx,stack);
      (void)bridge::ReportNativeException(&state.isolate,value,frames);
    }
  }
  ~CatchScope() {
    Capture();CHECK(state.catchScope==this);state.catchScope=previous;
    if(JS_IsExceptionPending(cx)&&!rethrow) { saved.drop();return; }
    if(terminated||cx->isPropagatingForcedReturn()) { saved.drop();return; }
    if(rethrow&&Caught()) {
      saved.drop();JS::RootedValue value(cx,exception);JS::RootedObject frames(cx,stack);
      if(!JS_WrapValue(cx,&value)||!JS_WrapObject(cx,&frames))return;
      JS::Rooted<js::SavedFrame*> capturedStack(cx, frames
          ? &js::UncheckedUnwrap(frames)->as<js::SavedFrame>() : nullptr);
      // Restore the captured state directly, after fallible realm wrapping.
      // The ordinary setter may intercept a new throw; this is a rethrow of
      // an existing value/stack/status, including OOM and recursion failures.
      js::AssertHeapIsIdle();CHECK_THREAD(cx);
      cx->restorePendingExceptionState(status,value,capturedStack);return;
    }
    saved.restore();
  }
};
static void CaptureNativeException(State& state) {
  if(state.catchScope)state.catchScope->Capture();
}
static void CompleteNativeApiException(State& state,bool pendingAtEntry) {
  CaptureNativeException(state);
  auto* cx=state.cx;
  // Match the returning API boundary, not engine-to-native callbacks or a
  // still-running JavaScript caller's catch/finally. Existing errors, cleanup
  // restrictions and termination must not start a new reporting operation.
  if(pendingAtEntry||state.nativeEntryDepth||state.catchScope||cx->activation()||
      cx->embedderExecutionRestrictions()||cx->isNativeExecutionTerminating()||
      !JS_IsExceptionPending(cx)||cx->exceptionStatus()==JS::ExceptionStatus::OutOfMemory)return;
  JS::ExceptionStack pending(cx);
  if(!JS::GetPendingExceptionStack(cx,&pending))return;
  bridge::MaybeAbortOnUncaught(&state.isolate,pending.exception(),pending.stack());
  // V8 reports an uncaught API failure with a clean exception state, then
  // clears the internal exception on return. Original Node listeners own
  // process._fatalException, output and exit policy. Preserve a new failure
  // from reporting, or the original failure if no listener could handle it.
  JS::AutoSaveExceptionState saved(cx);
  const bool reported=bridge::ReportNativeException(&state.isolate,pending.exception(),pending.stack());
  if(!reported&&!JS_IsExceptionPending(cx)&&!cx->isNativeExecutionTerminating())saved.restore();
  else saved.drop();
}
TryCatch::TryCatch(Isolate* isolate) {
  auto& frame=Current(isolate);CaptureNativeException(*frame.state);
  scope_=std::make_unique<CatchScope>(frame);
}
TryCatch::~TryCatch()=default;
bool TryCatch::HasCaught()const { scope_->Capture();return scope_->Caught(); }
bool TryCatch::HasTerminated()const { scope_->Capture();return scope_->terminated; }
bool TryCatch::CanContinue()const {
  scope_->Capture();return !scope_->terminated&&scope_->status!=JS::ExceptionStatus::OutOfMemory;
}
Local<Value> TryCatch::Exception()const {
  if(!HasCaught())return {};
  auto& frame=Current(&scope_->state.isolate);
  if(scope_->terminated)return Null(&scope_->state.isolate);
  JS::RootedValue value(frame.cx,scope_->exception);
  if(!JS_WrapValue(frame.cx,&value))return {};return frame.OwnValue(value);
}
Local<Value> TryCatch::ReThrow() {
  if(!HasCaught())return {};scope_->rethrow=true;
  return Undefined(&scope_->state.isolate);
}
void TryCatch::Reset() {
  scope_->Capture();if(scope_->rethrow||scope_->terminated)return;
  scope_->status=JS::ExceptionStatus::None;scope_->exception=JS::UndefinedValue();scope_->stack=nullptr;
}
bool TryCatch::IsVerbose()const { return scope_->verbose; }
void TryCatch::SetVerbose(bool value) { scope_->verbose=value; }
Context::Context(Isolate* input,std::unique_ptr<Cell> root):Data(std::move(root),&CloneWrapper<Context>),isolate(input) {
  auto owner=isolate->owner.lock();CHECK(owner&&owner->cx==cell().context);owner->AssertForeground();
  CHECK(cell().value.isObject());
  JS::RootedObject global(cell().context,js::CheckedUnwrapDynamic(&cell().value.toObject(),cell().context,false));
  CHECK(global&&JS_IsGlobalObject(global));cell().value.setObject(*global);
}
Context::~Context()=default;
bool SameLocal(Context* left,Context* right) {
  if(!left||!right)return left==right;
  CHECK(left->isolate==right->isolate);
  return left->cell().value.get()==right->cell().value.get();
}
struct ContextScopeData {
  Frame& frame;
  // The scope outlives its constructor's stack roots and is heap allocated.
  // It must not join the strictly LIFO RootedObject stack.
  JS::PersistentRootedObject previous;
  JSAutoRealm realm;
  ContextScopeData(Frame& input,JSObject* global)
    :frame(input),previous(frame.cx,frame.realm),realm(frame.cx,global){frame.realm=global;}
  ~ContextScopeData(){frame.realm=previous;}
};
Context::Scope::Scope(Local<Context> context) {
  CHECK(!context.IsEmpty());auto& frame=Current(context->isolate);
  JS::RootedObject global(frame.cx,&context->cell().value.toObject());
  CHECK(JS_IsGlobalObject(global));data_=std::make_unique<ContextScopeData>(frame,global);
}
Context::Scope::~Scope()=default;
Local<Object> Context::Global() {
  auto& frame=Current(isolate);JS::RootedValue value(frame.cx,cell().value);
  if(!JS_WrapValue(frame.cx,&value))return {};return frame.Own<Object>(value);
}
Local<Context> Isolate::GetCurrentContext() {
  auto& frame=Current(this);JS::RootedObject global(frame.cx,JS::CurrentGlobalOrNull(frame.cx));
  if(!global)return {};return frame.OwnContext(global);
}
void Isolate::ThrowException(Local<Value> value) {
  auto& f = Current(this);
  if (!value.IsEmpty() && !JS_IsExceptionPending(f.cx)) JS_SetPendingException(f.cx, Input(value));
}
bool Isolate::HasPendingException(){
  auto state=owner.lock();CHECK(state&&state->cx==js::TlsContext.get());state->AssertForeground();
  // This query must not capture/clear the failure or perform a checkpoint.
  return JS_IsExceptionPending(state->cx);
}
static Local<Value> Error(Isolate* isolate, JSExnType type, const char* code, std::string_view text) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject stack(f.cx); if (!JS::CaptureCurrentStack(f.cx, &stack)) return {};
  CHECK_LE(text.size(),size_t(INT_MAX));Local<String> encoded;
  if(!String::NewFromUtf8(isolate,text.data(),NewStringType::kNormal,int(text.size())).ToLocal(&encoded))return {};
  JS::RootedString filename(f.cx, JS_NewStringCopyZ(f.cx, "")), message(f.cx, encoded->cell().value.toString());
  JS::Rooted<mozilla::Maybe<JS::Value>> cause(f.cx, mozilla::Nothing()); JS::RootedValue error(f.cx);
  if (!filename || !message || !JS::CreateError(f.cx, type, stack, filename, 0,
      JS::ColumnNumberOneOrigin(1), nullptr, message, cause, &error)) return {};
  if (!code) return f.OwnValue(error);
  JS::RootedObject object(f.cx, &error.toObject());
  JS::RootedString value(f.cx, JS_NewStringCopyZ(f.cx, code));
  if (!value) return {};
  JS::RootedValue codeValue(f.cx,JS::StringValue(value)); CHECK(JS_SetProperty(f.cx,object,"code",codeValue));
  return f.OwnValue(error);
}
static Local<Value> IntrinsicError(Local<String> input,Local<Value> options,JSExnType kind) {
  NativeNoScriptEntry nativeEntry(*Frame::current);if(nativeEntry.Terminated())return {};
  auto& f=*Frame::current;if(JS_IsExceptionPending(f.cx))return {};
  StressCollection(f);
  // Keep the original constructor factory's cause access and stack/location
  // ordering. No replaceable global Error binding or automatic checkpoint runs.
  JS::RootedValue messageValue(f.cx,Input(input));
  if(!JS_WrapValue(f.cx,&messageValue))return {};
  JS::RootedString message(f.cx,messageValue.toString());
  JS::RootedValue argument(f.cx,options.IsEmpty()?JS::UndefinedValue():Input(options));
  if(!JS_WrapValue(f.cx,&argument))return {};
  JS::RootedValue result(f.cx);
  if(!JS::CreateErrorFromOptions(f.cx,kind,message,argument,&result))return {};
  return f.OwnValue(result);
}
Local<Value> Exception::Error(Local<String> input,Local<Value> options) { return IntrinsicError(input,options,JSEXN_ERR); }
Local<Value> Exception::RangeError(Local<String> input,Local<Value> options) { return IntrinsicError(input,options,JSEXN_RANGEERR); }
Local<Value> Exception::ReferenceError(Local<String> input,Local<Value> options) { return IntrinsicError(input,options,JSEXN_REFERENCEERR); }
Local<Value> Exception::TypeError(Local<String> input,Local<Value> options) { return IntrinsicError(input,options,JSEXN_TYPEERR); }
Local<Value> Exception::SyntaxError(Local<String> input,Local<Value> options) { return IntrinsicError(input,options,JSEXN_SYNTAXERR); }
MaybeLocal<Object> Value::ToObject(Local<Context> context) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f,context);if(nativeEntry.Terminated())return {};if(JS_IsExceptionPending(f.cx))return {};
  Context::Scope home(context);JS::RootedValue value(f.cx,cell().value);
  if(!JS_WrapValue(f.cx,&value))return {};
  JS::RootedObject object(f.cx,JS::ToObject(f.cx,value));if(!object)return {};
  JS::RootedValue result(f.cx,JS::ObjectValue(*object));return f.Own<Object>(result);
}
MaybeLocal<String> Value::ToString(Local<Context> context) {
  auto& f = Current(context->isolate);NativeEntry nativeEntry(f,context);if(nativeEntry.Terminated())return {}; if (JS_IsExceptionPending(f.cx)) return {};
  Context::Scope home(context);JS::RootedValue input(f.cx,cell().value);
  if(!JS_WrapValue(f.cx,&input))return {};
  JS::RootedString string(f.cx, JS::ToString(f.cx, input)); if (!string) return {};
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
Local<String> Value::TypeOf(Isolate* isolate) {
  auto& frame=Current(isolate);NativeEntry entry(frame);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  JS::RootedValue value(frame.cx,cell().value);if(!JS_WrapValue(frame.cx,&value))return {};
  JS::RootedValue text(frame.cx,JS::StringValue(js::TypeName(JS_TypeOfValue(frame.cx,value),frame.cx->names())));return frame.Own<String>(text);
}
MaybeLocal<String> Value::ToDetailString(Local<Context> context) const {
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedValue input(frame.cx,cell().value);if(!JS_WrapValue(frame.cx,&input))return {};
  if(input.isObject()){
    frame.state->isolate.ThrowException(Error(&frame.state->isolate,JSEXN_ERR,"ERR_KANDELO_NOT_IMPLEMENTED","Native object detail formatting without JavaScript effects is not implemented"));return {};
  }
  JS::RootedString text(frame.cx);
  if(input.isSymbol()){
    JS::RootedValue output(frame.cx);if(!js::SymbolDescriptiveString(frame.cx,input.toSymbol(),&output))return {};text=output.toString();
  }else text=JS::ToString(frame.cx,input);
  if(!text)return {};JS::RootedValue result(frame.cx,JS::StringValue(text));return frame.Own<String>(result);
}
MaybeLocal<String> JSON::Stringify(Local<Context> context,Local<Value> input) {
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedValue value(frame.cx,Input(input));if(!JS_WrapValue(frame.cx,&value))return {};
  js::JSStringBuilder buffer(frame.cx);JS::RootedObject replacer(frame.cx,nullptr);
  auto append=[](const char16_t* chars,uint32_t count,void* state){return static_cast<js::StringBuilder*>(state)->append(chars,count);};
  if(!JS::ToJSON(frame.cx,value,replacer,JS::UndefinedHandleValue,append,&buffer))return {};
  JS::RootedString text(frame.cx,buffer.empty()?JS::ToString(frame.cx,JS::UndefinedHandleValue):buffer.finishString());
  if(!text)return {};JS::RootedValue result(frame.cx,JS::StringValue(text));return frame.Own<String>(result);
}
Maybe<bool> Object::Set(Local<Context> context, Local<Value> property, Local<Value> input) {
  auto& f = Current(context->isolate);NativeEntry nativeEntry(f,context);if(nativeEntry.Terminated())return {}; if (JS_IsExceptionPending(f.cx)) return {};
  Context::Scope home(context);
  JS::RootedObject object(f.cx, &cell().value.toObject()); JS::RootedId id(f.cx);
  JS::RootedValue name(f.cx, Input(property)), value(f.cx, Input(input));
  if (!JS_WrapObject(f.cx,&object)||!JS_WrapValue(f.cx,&name)||!JS_WrapValue(f.cx,&value)||
      !JS_ValueToId(f.cx, name, &id) || !JS_SetPropertyById(f.cx, object, id, value)) return {};
  return Just(true);
}
Maybe<bool> Object::Has(Local<Context> context,Local<Value> property) {
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedValue name(frame.cx,Input(property));JS::RootedId key(frame.cx);bool found;
  if(!JS_WrapObject(frame.cx,&object)||!JS_WrapValue(frame.cx,&name)||!JS_ValueToId(frame.cx,name,&key)||!JS_HasPropertyById(frame.cx,object,key,&found))return {};
  return Just(found);
}
Local<Array> Array::New(Isolate* isolate,int length) {
  auto& f = Current(isolate);JS::RootedObject object(f.cx,JS::NewArrayObject(f.cx,uint32_t(std::max(length,0))));if(!object)return {};
  JS::RootedValue value(f.cx, JS::ObjectValue(*object)); return f.Own<Array>(value);
}
Local<Array> Array::New(Isolate* isolate,const Local<Value>* entries,size_t count) {
  auto& f=Current(isolate);JS::RootedValueVector values(f.cx);
  for(size_t i=0;i<count;++i){
    JS::RootedValue value(f.cx,Input(entries[i]));
    if(!JS_WrapValue(f.cx,&value)||!values.append(value))return {};
  }
  JS::RootedObject object(f.cx,JS::NewArrayObject(f.cx,values));if(!object)return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));return f.Own<Array>(value);
}
Local<Object> Object::New(Isolate* isolate) {
  auto& f=Current(isolate);JS::RootedObject object(f.cx,JS_NewPlainObject(f.cx));if(!object)return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));return f.Own<Object>(value);
}
Local<String> Object::GetConstructorName() {
  auto& frame=*Frame::current;NativeEntry entry(frame);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));if(!object)return {};
  JS::RootedString name(frame.cx,js::GetConstructorName(frame.cx,object));if(!name)return {};
  JS::RootedValue value(frame.cx,JS::StringValue(name));if(!JS_WrapValue(frame.cx,&value))return {};
  return frame.Own<String>(value);
}
// The native typed-array allocation API has no JavaScript constructor call.
// Its prototype supplies the construction name, including after prototype
// installation by complete original native consumers such as Buffer::New.
static bool RecordApiViewConstruction(Frame& frame,JS::HandleObject object) {
  JS::RootedObject constructor(frame.cx,nullptr);
  return js::ObjectRealm::get(object).recordConstructorIdentity(frame.cx,object,constructor,false);
}
Local<Object> Object::New(Isolate* isolate,Local<Value> prototype,
                          Local<Name>* names,Local<Value>* entries,size_t count) {
  auto& f=Current(isolate);if(JS_IsExceptionPending(f.cx))return {};
  JS::RootedValue parent(f.cx,Input(prototype));if(!JS_WrapValue(f.cx,&parent))return {};
  CHECK(parent.isNull()||parent.isObject());
  JS::RootedObject proto(f.cx,parent.isObject()?&parent.toObject():nullptr);
  JS::RootedObject object(f.cx,JS_NewObjectWithGivenProto(f.cx,nullptr,proto));if(!object)return {};
  for(size_t i=0;i<count;++i){
    JS::RootedValue name(f.cx,Input(names[i])),value(f.cx,Input(entries[i]));JS::RootedId id(f.cx);
    if(!JS_WrapValue(f.cx,&name)||!JS_WrapValue(f.cx,&value)||!JS_ValueToId(f.cx,name,&id)||
        !JS_DefinePropertyById(f.cx,object,id,value,JSPROP_ENUMERATE))return {};
  }
  JS::RootedValue result(f.cx,JS::ObjectValue(*object));return f.Own<Object>(result);
}

Maybe<bool> Object::DefineOwnProperty(Local<Context> context,Local<Name> key,
                                     Local<Value> input,PropertyAttribute attrs) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f,context);if(nativeEntry.Terminated()||JS_IsExceptionPending(f.cx))return {};
  Context::Scope home(context);JS::RootedObject object(f.cx,&cell().value.toObject());
  JS::RootedValue name(f.cx,Input(key)),value(f.cx,Input(input));JS::RootedId id(f.cx);
  if(!JS_WrapObject(f.cx,&object)||!JS_WrapValue(f.cx,&name)||!JS_WrapValue(f.cx,&value)||!JS_ValueToId(f.cx,name,&id))return {};
  unsigned flags=(attrs&DontEnum)?0:JSPROP_ENUMERATE;
  if(attrs&ReadOnly)flags|=JSPROP_READONLY;
  if(attrs&DontDelete)flags|=JSPROP_PERMANENT;
  JS::Rooted<JS::PropertyDescriptor> descriptor(f.cx,JS::PropertyDescriptor::Data(value,flags));
  JS::ObjectOpResult result;
  if(!JS_DefinePropertyById(f.cx,object,id,descriptor,result))return {};
  return Just(result.ok());
}
static int64_t IntegerNumber(double);
Local<Integer> Integer::New(Isolate* isolate, int input) {
  auto& f = Current(isolate); JS::RootedValue value(f.cx, JS::Int32Value(input)); return f.OwnValue(value).As<Integer>();
}
int64_t Integer::Value() const { CHECK(IsNumber());return IntegerNumber(cell().value.toNumber()); }
static_assert(JS::MaxStringLength<=INT_MAX);
const size_t Uint8Array::kMaxLength = js::ArrayBufferObject::ByteLengthLimit;
Local<String> String::Empty(Isolate* isolate) {
  auto state=isolate->owner.lock();CHECK(state&&state->cx==js::TlsContext.get());state->AssertForeground();
  return NativeConstant(isolate,&State::emptyStringConstant,JS::StringValue(JS_GetEmptyString(state->cx)));
}
Local<String> String::Concat(Isolate* isolate, Local<String> left, Local<String> right) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject global(f.cx,NativePrimitiveRealm(f));if(!global)return {};
  JSAutoRealm home(f.cx,global);
  StressCollection(f);
  JS::RootedValue av(f.cx,Input(left)),bv(f.cx,Input(right));
  if(!JS_WrapValue(f.cx,&av)||!JS_WrapValue(f.cx,&bv))return {};
  JS::RootedString a(f.cx,av.toString()),b(f.cx,bv.toString());
  JS::RootedString string(f.cx, JS_ConcatStrings(f.cx, a, b)); if (!string) return {};
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
MaybeLocal<String> String::NewFromOneByte(Isolate* isolate, const uint8_t* bytes, NewStringType type, int length) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject global(f.cx,NativePrimitiveRealm(f));if(!global)return {};
  JSAutoRealm home(f.cx,global);
  StressCollection(f);
  CHECK_GE(length,-1);if(length==-1)length=int(std::strlen(reinterpret_cast<const char*>(bytes)));
  JS::RootedString string(f.cx,type==NewStringType::kInternalized?JS_AtomizeStringN(f.cx,reinterpret_cast<const char*>(bytes),size_t(length)):JS_NewStringCopyN(f.cx,reinterpret_cast<const char*>(bytes),size_t(length))); if (!string) return {};
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
MaybeLocal<String> String::NewFromTwoByte(Isolate* isolate, const uint16_t* bytes, NewStringType type, int length) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject global(f.cx,NativePrimitiveRealm(f));if(!global)return {};
  JSAutoRealm home(f.cx,global);
  StressCollection(f);
  CHECK_GE(length,-1);if(length==-1){length=0;while(bytes[length])++length;}
  JS::RootedString string(f.cx,type==NewStringType::kInternalized?JS_AtomizeUCStringN(f.cx,reinterpret_cast<const char16_t*>(bytes),size_t(length)):JS_NewUCStringCopyN(f.cx,reinterpret_cast<const char16_t*>(bytes),size_t(length))); if (!string) return {};
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
MaybeLocal<String> String::NewFromUtf8(Isolate* isolate, const char* bytes, NewStringType type, int length) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  CHECK_GE(length,-1);
  if(length==-1){const size_t count=std::strlen(bytes);CHECK_LE(count,size_t(INT_MAX));length=int(count);}
  JS::RootedObject global(f.cx,NativePrimitiveRealm(f));if(!global)return {};
  JSAutoRealm home(f.cx,global);
  StressCollection(f);
  size_t count = 0;
  auto chars = JS::LossyUTF8CharsToNewTwoByteCharsZ(f.cx, JS::UTF8Chars(bytes, size_t(length)), &count, js::StringBufferArena);
  if (!chars) return {};
  auto result = NewFromTwoByte(isolate, reinterpret_cast<const uint16_t*>(chars.get()), type, int(count));
  js_free(chars.get()); return result;
}
size_t String::Length() const { return JS_GetStringLength(cell().value.toString()); }
struct View { std::vector<uint8_t> one; std::vector<uint16_t> two; bool latin1; size_t length; };
String::ValueView::ValueView(Isolate* isolate, Local<String> input) : view_(std::make_unique<View>()) {
  auto& f = Current(isolate); JS::RootedString string(f.cx, input->cell().value.toString());
  JSLinearString* linear = string->ensureLinear(f.cx); if (!linear) Crash("Native codec string linearization failed");
  view_->length = linear->length(); view_->latin1 = linear->hasLatin1Chars();
  if (view_->latin1) view_->one.resize(view_->length); else view_->two.resize(view_->length);
  JS::AutoCheckCannotGC nogc;
  if (view_->latin1) std::memcpy(view_->one.data(), linear->latin1Chars(nogc), view_->length);
  else std::memcpy(view_->two.data(), linear->twoByteChars(nogc), view_->length * sizeof(uint16_t));
}
String::ValueView::~ValueView() = default;
bool String::ValueView::is_one_byte() const { return view_->latin1; }
size_t String::ValueView::length() const { return view_->length; }
const uint8_t* String::ValueView::data8() const { MOZ_RELEASE_ASSERT(view_->latin1); return view_->one.data(); }
const uint16_t* String::ValueView::data16() const { MOZ_RELEASE_ASSERT(!view_->latin1); return view_->two.data(); }
void String::WriteV2(Isolate* isolate, size_t start, size_t length, uint16_t* output,int flags)const {
  ValueView view(isolate, Local<String>(const_cast<String*>(this))); MOZ_RELEASE_ASSERT(start <= view.length() && length <= view.length() - start);
  if (view.is_one_byte()) for (size_t i=0; i<length; ++i) output[i]=view.data8()[start+i];
  else if(length)std::memcpy(output, view.data16()+start, length*sizeof(uint16_t));
  if(flags&WriteFlags::kNullTerminate)output[length]=0;
}
size_t String::WriteUtf8V2(Isolate* isolate,char* output,size_t length,int flags,size_t* processed)const{
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);
  CHECK((output||!length)&&(!(flags&WriteFlags::kNullTerminate)||length));
  JS::RootedString string(frame.cx,cell().value.toString());
  auto result=kandelo::node::EncodeNativeStringUtf8(frame.cx,string,{output,length},
      flags&WriteFlags::kNullTerminate,flags&WriteFlags::kReplaceInvalidUtf8);
  if(!result){if(processed)*processed=0;return 0;}
  if(processed)*processed=result->characters;return result->bytes;
}

void SyncNativeExternalPressure(State&);
void RetireNativeMemoryMeasurements(State&);
void OnNativeMemoryGC(State&);
int64_t AdjustNativeExternalCredit(State&,int64_t);
struct MemoryAccount {
  std::weak_ptr<State> state;
  std::shared_ptr<State> retained;
  size_t bytes=0;
};
// External string resources must retain their Isolate through their destructor.
ExternalMemoryAccounter::ExternalMemoryAccounter() : account_(std::make_unique<MemoryAccount>()) {}
ExternalMemoryAccounter::~ExternalMemoryAccounter() { MOZ_RELEASE_ASSERT(account_->bytes==0); }
void ExternalMemoryAccounter::Increase(Isolate* isolate, size_t bytes) {
  bridge::CheckExternalMemoryDelta(bytes);
  auto state=isolate->owner.lock();MOZ_RELEASE_ASSERT(state);
  auto previous=account_->state.lock();MOZ_RELEASE_ASSERT(!previous||previous==state);
  account_->state=state;account_->retained=state;
  MOZ_RELEASE_ASSERT(bytes<=SIZE_MAX-account_->bytes);account_->bytes+=bytes;
  state->externalBytes.fetch_add(bytes);state->created.fetch_add(1);
  state->AssertForeground();AdjustNativeExternalCredit(*state,int64_t(bytes));
}
void ExternalMemoryAccounter::Decrease(Isolate* isolate, size_t bytes) {
  bridge::CheckExternalMemoryDelta(-int64_t(bytes));
  auto state=account_->state.lock();
  MOZ_RELEASE_ASSERT(state && &state->isolate==isolate && account_->bytes>=bytes);
  state->externalBytes.fetch_sub(bytes);state->released.fetch_add(1);account_->bytes-=bytes;
  AdjustNativeExternalCredit(*state,-int64_t(bytes));
  // Keep the actual native owner until this accounter is destroyed. The source
  // resource's destructor still holds its Isolate pointer after this call.
}
void ExternalMemoryAccounter::Update(Isolate* isolate,int64_t delta){
  if(!delta)return;
  const uint64_t bytes=delta>0?uint64_t(delta):uint64_t(-(delta+1))+1;
  CHECK_LE(bytes,uint64_t(SIZE_MAX));
  if(delta>0)Increase(isolate,size_t(bytes));else Decrease(isolate,size_t(bytes));
}
template<class Resource, class Character> class ExternalStringCallbacks final : public JSExternalStringCallbacks {
  Resource* resource_;
  std::weak_ptr<State> state_;
 public:
  ExternalStringCallbacks(const std::shared_ptr<State>& state,Resource* resource):resource_(resource),state_(state){
    State::ExternalStringResourceRecord record;
    if constexpr(std::is_same_v<Resource,String::ExternalOneByteStringResource>)record.one=resource;
    else record.two=resource;
    std::lock_guard lock(state->externalStringMutex);CHECK(state->externalStringResources.emplace(this,record).second);
  }
  ~ExternalStringCallbacks(){
    if(auto state=state_.lock()){std::lock_guard lock(state->externalStringMutex);state->externalStringResources.erase(this);}
  }
  void Release(const void* chars) const {
    MOZ_RELEASE_ASSERT(chars==resource_->data()); resource_->Dispose(); delete this;
  }
  void finalize(JS::Latin1Char* chars) const override { Release(chars); }
  void finalize(char16_t* chars) const override { Release(chars); }
  size_t sizeOfBuffer(const JS::Latin1Char*, mozilla::MallocSizeOf) const override { return resource_->length()*sizeof(Character); }
  size_t sizeOfBuffer(const char16_t*, mozilla::MallocSizeOf) const override { return resource_->length()*sizeof(Character); }
};
MaybeLocal<String> String::NewExternalOneByte(Isolate* isolate, ExternalOneByteStringResource* resource) {
  auto& f=Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject global(f.cx,NativePrimitiveRealm(f));if(!global)return {};
  JSAutoRealm home(f.cx,global);
  StressCollection(f);
  auto* callbacks=new ExternalStringCallbacks<ExternalOneByteStringResource,char>(f.state,resource);
  JS::RootedString string(f.cx, JS_NewExternalStringLatin1(f.cx,
      reinterpret_cast<const JS::Latin1Char*>(resource->data()), resource->length(), callbacks));
  if (!string) { delete callbacks; return {}; }
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
MaybeLocal<String> String::NewExternalTwoByte(Isolate* isolate, ExternalStringResource* resource) {
  auto& f=Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject global(f.cx,NativePrimitiveRealm(f));if(!global)return {};
  JSAutoRealm home(f.cx,global);
  StressCollection(f);
  auto* callbacks=new ExternalStringCallbacks<ExternalStringResource,uint16_t>(f.state,resource);
  JS::RootedString string(f.cx, JS_NewExternalUCString(f.cx,
      reinterpret_cast<const char16_t*>(resource->data()), resource->length(), callbacks));
  if (!string) { delete callbacks; return {}; }
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
}  // namespace v8

namespace v8 {
struct SpanOwner {
  JS::PersistentRootedObject object;
  std::shared_ptr<State> state;
  std::shared_ptr<void> storage;
  bool pinned=false; size_t size=0; uint8_t* bytes=nullptr; uint8_t empty=0;
  SpanOwner(Frame& frame, JS::HandleObject input) : object(frame.cx, input), state(frame.state) {
    bool view=JS_IsArrayBufferViewObject(input);
    bool shared=JS::IsSharedArrayBufferObject(input);
    { JSAutoRealm home(frame.cx, input);
      JS::RootedObject buffer(frame.cx,view?JS_GetArrayBufferViewBuffer(frame.cx,input,&shared):input.get()); CHECK_NOT_NULL(buffer);
      buffer=js::CheckedUnwrapDynamic(buffer,frame.cx,false); CHECK_NOT_NULL(buffer);
      // ensureNonInline rejects an already pinned buffer, including a second
      // view of our state allocation. Its existing out-of-line storage is
      // already stable: materialize only when the real backing remains inline.
      if (!shared && buffer->as<js::ArrayBufferObject>().isInlineData() &&
          !JS::EnsureNonInlineArrayBufferOrView(frame.cx,input))
        Crash("Native codec backing allocation stabilization failed");
      if((frame.domain==Domain::Native||frame.domain==Domain::Buffer) && !shared && !buffer->as<js::ArrayBufferObject>().isDetached()) {
        storage=js::ArrayBufferObject::retainKandeloContents(frame.cx,buffer.as<js::ArrayBufferObject>());CHECK(storage);
      } else if(frame.domain!=Domain::Native&&frame.domain!=Domain::Buffer) pinned=JS::PinArrayBufferOrViewLength(input, true);
    }
    size=view?JS_GetArrayBufferViewByteLength(object):shared?JS::GetSharedArrayBufferByteLength(object):JS::GetArrayBufferByteLength(object);
    JS::AutoCheckCannotGC nogc;
    bytes=view?static_cast<uint8_t*>(JS_GetArrayBufferViewData(object, &shared, nogc)):
        shared?JS::GetSharedArrayBufferData(object,&shared,nogc):JS::GetArrayBufferData(object,&shared,nogc);
    if (!bytes) { MOZ_RELEASE_ASSERT(size==0); bytes=&empty; }
    state->spans.fetch_add(1);
  }
  ~SpanOwner() {
    if (pinned) JS::PinArrayBufferOrViewLength(object, false);
    state->spans.fetch_sub(1);
  }
};
}

namespace v8 {
void SetTraceFieldCount(JSObject*,int);
Frame::~Frame() {
  if(state->cppHeap&&!JS::RuntimeHeapIsCollecting())state->cppHeap->DrainRetired();
  current=previous;
}
SpanOwner& Frame::Borrow(Local<Value> input) {
  JS::RootedObject object(cx, UnwrapView(cx, Input(input))); CHECK_NOT_NULL(object);
  for (auto& span:spans) if (span->object==object) return *span;
  spans.push_back(std::make_unique<SpanOwner>(*this, object)); return *spans.back();
}
bool ApplyNativeTemplate(Frame&,Local<ObjectTemplate>,JS::HandleObject);
Local<FunctionTemplate> CreateNativeWrapperTemplate(Isolate*,int);
namespace {
using Callback=void(*)(const FunctionCallbackInfo<Value>&);
struct CallbackOwner { Callback callback;Domain domain;bool constructor=false,categoryReceiver=false;int fieldCount=0; };
JSFunction* TraceFunction(Frame&,const char*,Callback,unsigned,bool,bool);
void FinalizeCallback(JS::GCContext*,JSObject* object) {
  auto value=JS::GetReservedSlot(object,0); if (!value.isUndefined()) delete static_cast<CallbackOwner*>(value.toPrivate());
}
const JSClassOps callbackOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeCallback};
const JSClass callbackClass={"NodeCodecCallback",JSCLASS_HAS_RESERVED_SLOTS(2)|JSCLASS_FOREGROUND_FINALIZE,&callbackOps};
void Finalize(JS::GCContext*,JSObject* object) {
  auto value=JS::GetReservedSlot(object,0); if (!value.isUndefined()) delete static_cast<std::shared_ptr<State>*>(value.toPrivate());
}
const JSClassOps stateOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,Finalize};
const JSClass stateClass={"NodeCodecState",JSCLASS_HAS_RESERVED_SLOTS(2)|JSCLASS_FOREGROUND_FINALIZE,&stateOps};
std::shared_ptr<State> ReadNativeEngineState(JSContext* cx){
  CHECK(cx==js::TlsContext.get());auto it=nativeEngineOwners.find(cx);
  if(it==nativeEngineOwners.end()){
    JS_ReportErrorASCII(cx,"Native engine context has no live owner");return {};
  }
  auto state=it->second;state->AssertForeground();return state;
}
bool Invoke(JSContext* cx,unsigned argc,JS::Value* vp) {
  auto args=JS::CallArgsFromVp(argc,vp);JS::RootedObject callee(cx,&args.callee());
  JS::RootedObject realm(cx,&js::GetFunctionNativeReserved(callee,0).toObject());
  JS::RootedObject closure(cx,&js::GetFunctionNativeReserved(callee,1).toObject());
  // The engine return slot aliases the callee. V8 callbacks start undefined,
  // including source paths that return without setting a result.
  args.rval().setUndefined();
  CHECK(JS::GetClass(closure)==&callbackClass);
  auto* callback=static_cast<CallbackOwner*>(JS::GetReservedSlot(closure,0).toPrivate());
  auto state=ReadNativeEngineState(cx);
  if(!state)return false;NativeCallbackEntry callbackEntry(*state);
  Frame frame(cx,realm,state,&args,callback->domain);
  frame.binding=&JS::GetReservedSlot(closure,1).toObject();
  frame.receiver=args.thisv();
  FunctionCallbackInfo<Value> call(&state->isolate); callback->callback(call);
  return !JS_IsExceptionPending(cx)&&!cx->isNativeExecutionTerminating();
}
}
}  // namespace v8

#include "kandelo-node/buffer-codecs-inl.h"
#include "kandelo-node/value-property-codecs-inl.h"
#include "kandelo-node/value-services-inl.h"
#include "kandelo-node/collection-codecs-inl.h"
#include "kandelo-node/metadata-values-codecs-inl.h"
#include "kandelo-node/data-array-codecs-inl.h"
#include "kandelo-node/continuation-codecs-inl.h"
#include "kandelo-node/engine-lifetime-codecs-inl.h"
#include "kandelo-node/internal-field-codecs-inl.h"
#include "kandelo-node/engine-gc-codecs-inl.h"
#include "kandelo-node/engine-isolate-codecs-inl.h"
#include "kandelo-node/message-codecs-inl.h"
#include "kandelo-node/native-object-codecs-inl.h"
#include "kandelo-node/heap-statistics-codecs-inl.h"
#include "kandelo-node/property-codecs-inl.h"
#include "kandelo-node/property-descriptor-codecs-inl.h"
#include "kandelo-node/regexp-property-codecs-inl.h"
#include "kandelo-node/engine-value-wire-codecs-inl.h"
#include "kandelo-node/engine-serialization-codecs-inl.h"
#include "kandelo-node/stack-codecs-inl.h"
#include "kandelo-node/inspection-codecs-inl.h"
#include "kandelo-node/template-codecs-inl.h"
#include "kandelo-node/context-codecs-inl.h"
#include "kandelo-node/engine-codegen-codecs-inl.h"
#include "kandelo-node/promise-codecs-inl.h"
#include "kandelo-node/engine-finalization-codecs-inl.h"
#include "kandelo-node/engine-script-codecs-inl.h"
#include "kandelo-node/trace-codecs-inl.h"


#include "kandelo-node/error-stack.cpp"

#include "kandelo-node/memory-measurement-upstream/deps/v8/src/heap/memory-measurement.cc"
#include "kandelo-node/engine-memory-measurement-inl.h"

#include "kandelo-node/extras-tracing-upstream/deps/v8/src/builtins/builtins-trace.cc"
#include "kandelo-node/engine-extras-codecs-inl.h"

#include "kandelo-node/engine-cpu-profiler-codecs-inl.h"
#include "kandelo-node/engine-heap-profiler-codecs-inl.h"
#include "kandelo-node/engine-heap-snapshot-codecs-inl.h"
