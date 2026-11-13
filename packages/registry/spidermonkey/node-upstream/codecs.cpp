#include "shell/node-upstream/codecs.h"

#include "mozilla/Assertions.h"
#include "mozilla/ScopeExit.h"

#include <atomic>
#include <cmath>
#include <cstdio>
#include <locale.h>
#include <set>
#include <strings.h>
#include <tuple>
#include <unistd.h>
#include <utility>
#include <vector>

#include "jsapi.h"
#include "jsexn.h"
#include "jsfriendapi.h"

#include "jit/AtomicOperations.h"
#include "js/Array.h"
#include "js/ArrayBuffer.h"
#include "js/CallAndConstruct.h"
#include "js/CallArgs.h"
#include "js/CharacterEncoding.h"
#include "js/Conversions.h"
#include "js/Date.h"
#include "js/Equality.h"
#include "js/ErrorReport.h"
#include "js/Exception.h"
#include "js/experimental/TypedData.h"
#include "js/friend/WindowProxy.h"
#include "js/GCAPI.h"
#include "js/GlobalObject.h"
#include "js/Initialization.h"
#include "js/JSON.h"
#include "js/MemoryFunctions.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/Realm.h"
#include "js/RealmOptions.h"
#include "js/SavedFrameAPI.h"
#include "js/SharedArrayBuffer.h"
#include "js/StableStringChars.h"
#include "js/Stack.h"
#include "js/String.h"
#include "js/Symbol.h"
#include "js/TracingAPI.h"
#include "js/WeakMap.h"
#include "js/Wrapper.h"
#include "shell/jsshell.h"
#include "shell/node-upstream/buffer-memory.h"
#include "shell/node-upstream/builtin-compiler.h"
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/node_buffer.h"
#include "shell/node-upstream/codecs-upstream/string_decoder.h"
#undef node
#undef v8

#include "shell/node-upstream/error-policy-native-api.h"
#include "shell/node-upstream/error-stack.h"
#include "shell/node-upstream/fatal-errors-native-api.h"
#include "shell/node-upstream/options.h"
#include "shell/node-upstream/per-context.h"
#include "shell/node-upstream/process-errors-native-api.h"
#include "shell/node-upstream/realm.h"
#include "shell/node-upstream/trace-builtins-upstream/messages.generated.h"
#include "shell/node-upstream/trace-native.h"
#include "shell/node-upstream/trace-utf8-native.h"
#include "shell/node-upstream/tracing-upstream/tracing/agent.h"
#include "vm/ArrayBufferObject.h"
#include "vm/ArrayBufferViewObject.h"
#include "vm/ArrayObject.h"
#include "vm/ErrorObject.h"
#include "vm/JSAtomUtils.h"
#include "vm/JSFunction.h"
#include "vm/NativeObject.h"
#include "vm/Realm.h"
#include "vm/SavedFrame.h"
#include "vm/StringType.h"

#include "vm/Realm-inl.h"

namespace kandelo_node_codec_impl { extern const JSClass categoryClass,nativeBindingClass,nativeChannelClass; }
namespace api = kandelo_node_codec_api;
namespace native = kandelo_node_codec_impl;
namespace kandelo_node_codec_api {
const JSClass icuBindingClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(1)};
struct NativeOwnerProbeState;
struct State {
  Isolate isolate;
  native::IsolateData isolateData{&isolate};
  CatchScope* catchScope=nullptr;
  size_t nativeEntryDepth=0;
  native::Environment environment{&isolate};
  std::vector<std::unique_ptr<native::AliasedControl>> aliasedControls;
  std::vector<std::shared_ptr<GlobalRoot>> weakGlobals;
  std::unique_ptr<JS::PersistentRootedObject> templateRealm;
  std::vector<std::unique_ptr<native::Realm>> realms;
  std::atomic<size_t> externalBytes{0}, created{0}, released{0}, spans{0}, collections{0};
  std::atomic<size_t> bufferCreated{0},bufferFreed{0},bufferBytes{0};
  bool stressGc=false;
#ifdef KANDELO_NATIVE_OWNER_PROBE
  std::shared_ptr<NativeOwnerProbeState> ownerProbe;
#endif
  std::atomic<size_t> traceCreated{0},traceReleased{0};
  std::atomic<size_t> icuCreated{0},icuReleased{0};
};
enum class Domain { Decoder, Icu, Trace, Continuation, Environment, Buffer, Snapshot, Diagnostics, NativeProperty };
const JSClass traceBindingClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(3)};
const JSClass continuationBindingClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(1)};
struct Cell {
  JS::PersistentRootedValue value;
  Cell(JSContext* cx, JS::HandleValue input) : value(cx, input) {}
};
template<class T> std::unique_ptr<Data> CloneWrapper(std::unique_ptr<Cell> cell) {
  return std::make_unique<T>(std::move(cell),&CloneWrapper<T>);
}
struct Frame {
  JSContext* cx;
  JS::RootedObject realm;
  JS::RootedObject binding;
  JS::RootedValue receiver;
  JS::RootedObject propertyHolder;
  JS::RootedValue propertyData, propertyReturn, callbackData;
  std::shared_ptr<kandelo::node::TraceProcess> tracing;
  std::shared_ptr<State> state;
  JS::CallArgs* arguments;
  Domain domain;
  std::vector<std::unique_ptr<Data>> roots;
  std::vector<std::unique_ptr<Context>> contexts;
  std::vector<std::unique_ptr<native::SpanOwner>> spans;
  std::vector<std::shared_ptr<void>> storage;
  Frame* previous;
  inline static thread_local Frame* current = nullptr;
  Frame(JSContext* cx, JS::HandleObject realm, std::shared_ptr<State> state,
        JS::CallArgs* arguments = nullptr, Domain domain = Domain::Decoder)
      : cx(cx), realm(cx, realm), binding(cx), receiver(cx), propertyHolder(cx), propertyData(cx), propertyReturn(cx), callbackData(cx), state(std::move(state)), arguments(arguments), domain(domain),
        previous(current) { current = this; }
  ~Frame();
  template<class T> Local<T> Own(JS::HandleValue value) {
    JS::RootedValue stored(cx,value);
    if constexpr(std::is_same_v<T,Private>){
      MOZ_RELEASE_ASSERT(stored.isSymbol());JS::RootedSymbol symbol(cx,stored.toSymbol());
      MOZ_RELEASE_ASSERT(JS::GetSymbolCode(symbol)==JS::SymbolCode::EmbeddingPrivateSymbol);
    }else if constexpr(!std::is_base_of_v<Value,T>){
      MOZ_RELEASE_ASSERT(stored.isObject());
      JS::RootedObject object(cx,js::CheckedUnwrapDynamic(&stored.toObject(),cx,false));MOZ_RELEASE_ASSERT(object);stored.setObject(*object);
    }
    auto item = CloneWrapper<T>(std::make_unique<Cell>(cx, stored));
    auto* pointer = static_cast<T*>(item.get()); roots.push_back(std::move(item));
    return Local<T>(pointer);
  }
  Local<Value> OwnValue(JS::HandleValue value);
  Local<Data> OwnClone(const Data& source,JS::HandleValue value) {
    auto item=source.CloneRoot(std::make_unique<Cell>(cx,value));
    auto* pointer=item.get();roots.push_back(std::move(item));return Local<Data>(pointer);
  }
  Local<Context> OwnContext(JS::HandleObject global) {
    MOZ_RELEASE_ASSERT(JS_IsGlobalObject(global));
    JS::RootedValue value(cx,JS::ObjectValue(*global));
    auto context=std::make_unique<Context>(&state->isolate,std::make_unique<Cell>(cx,value));
    auto* pointer=context.get();contexts.push_back(std::move(context));return Local<Context>(pointer);
  }
  native::SpanOwner& Borrow(Local<Value> value);
};
[[noreturn]] void Crash(const char* text) {
  std::fprintf(stderr, "Native codec invariant: %s\n", text);
  MOZ_CRASH("Original native codec invariant");
}
static Frame& Current(Isolate* isolate) {
  MOZ_RELEASE_ASSERT(Frame::current);
  MOZ_RELEASE_ASSERT(&Frame::current->state->isolate == isolate);
  return *Frame::current;
}
static void CaptureNativeException(State&);
// A JavaScript call can reenter native code. Only the handler at the returning
// API depth may catch its failure; an outer native handler must let intervening
// JavaScript catch/finally blocks run first.
struct NativeEntry {
  State& state;
  JSContext* cx;
  explicit NativeEntry(Frame& frame):state(*frame.state),cx(frame.cx) {
    CaptureNativeException(state);++state.nativeEntryDepth;
  }
  bool Terminated()const { return js::shell::GetShellContext(cx)->upstreamNodeExecutionTerminated; }
  ~NativeEntry() { --state.nativeEntryDepth;CaptureNativeException(state); }
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
Data::~Data()=default;
Cell& Data::cell()const{return *cell_;}
std::unique_ptr<Data> Data::CloneRoot(std::unique_ptr<Cell> cell)const{return rootFactory_(std::move(cell));}
Value::Value(std::unique_ptr<Cell> cell,RootFactory factory):Data(std::move(cell),factory?factory:&CloneWrapper<Value>){}
Value::~Value()=default;
Local<Value> Null(Isolate* isolate){auto& f=Current(isolate);JS::RootedValue value(f.cx,JS::NullValue());return f.OwnValue(value);}
void Isolate::DateTimeConfigurationChangeNotification(TimeZoneDetection detection) {
  auto& f=Current(this);f.state->environment.AssertForeground();
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
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f);if(nativeEntry.Terminated())return {};Context::Scope home(context);uint32_t value;
  JS::RootedValue input(f.cx,cell().value);
  if (!JS_WrapValue(f.cx,&input)||!JS::ToUint32(f.cx,input,&value)) return {};return Just(value);
}
Maybe<int32_t> Value::Int32Value(Local<Context> context) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f);if(nativeEntry.Terminated())return {};Context::Scope home(context);int32_t value;
  JS::RootedValue input(f.cx,cell().value);
  if (!JS_WrapValue(f.cx,&input)||!JS::ToInt32(f.cx,input,&value)) return {};
  return Just(value);
}
Maybe<double> Value::NumberValue(Local<Context> context) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f);if(nativeEntry.Terminated())return {};Context::Scope home(context);double value;
  JS::RootedValue input(f.cx,cell().value);
  if(!JS_WrapValue(f.cx,&input)||!JS::ToNumber(f.cx,input,&value))return {};
  return Just(value);
}
Local<Value> Frame::OwnValue(JS::HandleValue value) {
  // Source Local::As must refer to the actual C++ wrapper type as well as the
  // actual engine value. A string-tagged base object is not a String object.
  if (value.isString()) return Own<String>(value);
  if (value.isSymbol()) return Own<Symbol>(value);
  if (auto* view=UnwrapView(cx,value)) {
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
    if (object && JS::IsSharedArrayBufferObject(object)) return Own<SharedArrayBuffer>(value);
    if (object && JS::IsArrayBufferObject(object)) return Own<ArrayBuffer>(value);
    if (object && object->is<js::ArrayObject>()) return Own<Array>(value);
    if (JS::IsCallable(&value.toObject())) return Own<Function>(value);
    return Own<Object>(value);
  }
  if (value.isNumber()) {
    const double number=value.toNumber();
    if(std::isfinite(number)&&number>=0&&number<=UINT32_MAX&&std::trunc(number)==number&&!(number==0&&std::signbit(number)))return Own<Uint32>(value);
    return Own<Integer>(value);
  }
  return Own<Value>(value);
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
struct CatchScope {
  State& state;
  JSContext* cx;
  CatchScope* previous;
  size_t depth;
  JS::PersistentRootedValue exception;
  JS::PersistentRootedObject stack;
  JS::ExceptionStatus status=JS::ExceptionStatus::None;
  bool terminated=false,rethrow=false;
  JS::AutoSaveExceptionState saved;
  explicit CatchScope(Frame& frame):state(*frame.state),cx(frame.cx),
      previous(state.catchScope),depth(state.nativeEntryDepth),exception(cx),
      stack(cx),saved(cx) { state.catchScope=this; }
  bool Caught()const { return terminated||JS::IsCatchableExceptionStatus(status); }
  void Capture() {
    if(state.catchScope!=this||state.nativeEntryDepth!=depth||rethrow)return;
    terminated=js::shell::GetShellContext(cx)->upstreamNodeExecutionTerminated;
    if(!JS_IsExceptionPending(cx))return;
    auto pendingStatus=cx->kandeloExceptionStatus();JS::ExceptionStack pending(cx);
    if(!JS::GetPendingExceptionStack(cx,&pending)) {
      // Retrieving/wrapping a cross-realm exception may itself fail. Preserve
      // that real engine failure rather than clearing it or reporting success.
      return;
    }
    exception=pending.exception();stack=pending.stack();status=pendingStatus;
    JS_ClearPendingException(cx);
  }
  ~CatchScope() {
    Capture();CHECK(state.catchScope==this);state.catchScope=previous;
    if(JS_IsExceptionPending(cx)&&!rethrow) { saved.drop();return; }
    if(terminated||cx->isPropagatingForcedReturn()) { saved.drop();return; }
    if(rethrow&&Caught()) {
      saved.drop();JS::RootedValue value(cx,exception);JS::RootedObject frames(cx,stack);
      if(!JS_WrapValue(cx,&value)||!JS_WrapObject(cx,&frames))return;
      JS::ExceptionStack pending(cx,value,frames);JS::SetPendingExceptionStack(cx,pending);
      cx->restoreKandeloExceptionStatus(status);return;
    }
    saved.restore();
  }
};
static void CaptureNativeException(State& state) {
  if(state.catchScope)state.catchScope->Capture();
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
bool TryCatch::IsVerbose()const { return false; }
void TryCatch::SetVerbose(bool value) {
  if(value)Crash("Native catch message listener/verbose reporting is not implemented");
}
Context::Context(Isolate* input,std::unique_ptr<Cell> root):isolate(input),global(std::move(root)) {}
Context::~Context()=default;
bool SameLocal(Context* left,Context* right) {
  if(!left||!right)return left==right;
  CHECK(left->isolate==right->isolate);
  return left->global->value.get()==right->global->value.get();
}
struct ContextScopeData {
  JSAutoRealm realm;
  ContextScopeData(JSContext* cx,JSObject* global):realm(cx,global) {}
};
Context::Scope::Scope(Local<Context> context) {
  CHECK(!context.IsEmpty());auto& frame=Current(context->isolate);
  JS::RootedObject global(frame.cx,&context->global->value.toObject());
  CHECK(JS_IsGlobalObject(global));data_=std::make_unique<ContextScopeData>(frame.cx,global);
}
Context::Scope::~Scope()=default;
Local<Object> Context::Global() {
  auto& frame=Current(isolate);JS::RootedValue value(frame.cx,global->value);
  if(!JS_WrapValue(frame.cx,&value))return {};return frame.Own<Object>(value);
}
Local<Context> Isolate::GetCurrentContext() {
  auto& frame=Current(this);JS::RootedObject global(frame.cx,JS::CurrentGlobalOrNull(frame.cx));
  CHECK(global);return frame.OwnContext(global);
}
void Isolate::ThrowException(Local<Value> value) {
  auto& f = Current(this);
  if (!value.IsEmpty() && !JS_IsExceptionPending(f.cx)) JS_SetPendingException(f.cx, Input(value));
}
HandleScope::HandleScope(Isolate* isolate) : frame_(&Current(isolate)), previous_(frame_->roots.size()), previousContexts_(frame_->contexts.size()) {}
HandleScope::~HandleScope() { frame_->contexts.resize(previousContexts_);frame_->roots.resize(previous_); }
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
static Local<Value> IntrinsicError(Local<String> input,JSExnType kind) {
  NativeEntry nativeEntry(*Frame::current);if(nativeEntry.Terminated())return {};
  auto& f=*Frame::current;if(JS_IsExceptionPending(f.cx))return {};
  StressCollection(f);
  JS::RootedObject stack(f.cx);if(!js::CaptureStack(f.cx,&stack))return {};
  // Preserve original UTF16 message units and the real realm's Error intrinsic.
  JS::RootedString message(f.cx,input->cell().value.toString());
  JS::RootedString filename(f.cx,JS_GetEmptyString(f.cx));
  JS::Rooted<mozilla::Maybe<JS::Value>> cause(f.cx,mozilla::Nothing());
  JS::RootedValue result(f.cx);
  if(!JS::CreateError(f.cx,kind,stack,filename,0,JS::ColumnNumberOneOrigin(1),nullptr,message,cause,&result))return {};
  return f.OwnValue(result);
}
Local<Value> Exception::Error(Local<String> input) { return IntrinsicError(input,JSEXN_ERR); }
Local<Value> Exception::RangeError(Local<String> input) { return IntrinsicError(input,JSEXN_RANGEERR); }
Local<Value> Exception::TypeError(Local<String> input) { return IntrinsicError(input,JSEXN_TYPEERR); }
Local<Value> Exception::SyntaxError(Local<String> input) { return IntrinsicError(input,JSEXN_SYNTAXERR); }
MaybeLocal<Object> Value::ToObject(Local<Context> context) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f);if(nativeEntry.Terminated())return {};if(JS_IsExceptionPending(f.cx))return {};
  Context::Scope home(context);JS::RootedValue value(f.cx,cell().value);
  if(!JS_WrapValue(f.cx,&value))return {};
  JS::RootedObject object(f.cx,JS::ToObject(f.cx,value));if(!object)return {};
  JS::RootedValue result(f.cx,JS::ObjectValue(*object));return f.Own<Object>(result);
}
MaybeLocal<String> Value::ToString(Local<Context> context) {
  auto& f = Current(context->isolate);NativeEntry nativeEntry(f);if(nativeEntry.Terminated())return {}; if (JS_IsExceptionPending(f.cx)) return {};
  Context::Scope home(context);JS::RootedValue input(f.cx,cell().value);
  if(!JS_WrapValue(f.cx,&input))return {};
  JS::RootedString string(f.cx, JS::ToString(f.cx, input)); if (!string) return {};
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
Maybe<bool> Object::Set(Local<Context> context, Local<Value> property, Local<Value> input) {
  auto& f = Current(context->isolate);NativeEntry nativeEntry(f);if(nativeEntry.Terminated())return {}; if (JS_IsExceptionPending(f.cx)) return {};
  Context::Scope home(context);
  JS::RootedObject object(f.cx, &cell().value.toObject()); JS::RootedId id(f.cx);
  JS::RootedValue name(f.cx, Input(property)), value(f.cx, Input(input));
  if (!JS_WrapObject(f.cx,&object)||!JS_WrapValue(f.cx,&name)||!JS_WrapValue(f.cx,&value)||
      !JS_ValueToId(f.cx, name, &id) || !JS_SetPropertyById(f.cx, object, id, value)) return {};
  return Just(true);
}
Local<Array> Array::New(Isolate* isolate) {
  auto& f = Current(isolate); JS::RootedObject object(f.cx, JS::NewArrayObject(f.cx, 0)); if (!object) return {};
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
MaybeLocal<Array> Object::GetOwnPropertyNames(Local<Context> context) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f);if(nativeEntry.Terminated())return {};Context::Scope home(context);if(JS_IsExceptionPending(f.cx))return {};
  JS::RootedObject object(f.cx,&cell().value.toObject());if(!JS_WrapObject(f.cx,&object))return {};
  JS::RootedIdVector keys(f.cx);if(!js::GetPropertyKeys(f.cx,object,JSITER_OWNONLY,&keys))return {};
  JS::RootedValueVector values(f.cx);
  for(size_t i=0;i<keys.length();++i){
    JS::RootedValue value(f.cx);uint32_t index;
    // The consumed default interface keeps array indices numeric, including
    // indices too large for SpiderMonkey's compact integer property-key tag.
    if(keys[i].isString()&&keys[i].toString()->asAtom().isIndex(&index)&&index!=UINT32_MAX)
      value.setNumber(double(index));
    else if(!JS_IdToValue(f.cx,keys[i],&value))return {};
    if(!values.append(value))return {};
  }
  JS::RootedObject array(f.cx,JS::NewArrayObject(f.cx,values));if(!array)return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*array));return f.Own<Array>(value);
}
Maybe<bool> Object::DefineOwnProperty(Local<Context> context,Local<Name> key,
                                     Local<Value> input,PropertyAttribute attrs) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f);if(nativeEntry.Terminated())return {};if(nativeEntry.Terminated()||JS_IsExceptionPending(f.cx))return {};
  Context::Scope home(context);JS::RootedObject object(f.cx,&cell().value.toObject());
  JS::RootedValue name(f.cx,Input(key)),value(f.cx,Input(input));JS::RootedId id(f.cx);
  if(!JS_WrapObject(f.cx,&object)||!JS_WrapValue(f.cx,&name)||!JS_WrapValue(f.cx,&value)||!JS_ValueToId(f.cx,name,&id))return {};
  unsigned flags=(attrs&DontEnum)?0:JSPROP_ENUMERATE;
  if(attrs&ReadOnly)flags|=JSPROP_READONLY;
  if(attrs&DontDelete)flags|=JSPROP_PERMANENT;
  if(!JS_DefinePropertyById(f.cx,object,id,value,flags))return {};
  return Just(true);
}
Maybe<bool> Array::Set(Local<Context> context, int32_t index, Local<Value> input) {
  auto& f = Current(context->isolate);NativeEntry nativeEntry(f);if(nativeEntry.Terminated())return {};Context::Scope home(context);JS::RootedObject object(f.cx, &cell().value.toObject());
  JS::RootedValue value(f.cx, Input(input));
  if (!JS_WrapObject(f.cx,&object)||!JS_WrapValue(f.cx,&value)||!JS_SetElement(f.cx, object, index, value)) return {}; return Just(true);
}
static int64_t IntegerNumber(double);
Local<Integer> Integer::New(Isolate* isolate, int input) {
  auto& f = Current(isolate); JS::RootedValue value(f.cx, JS::Int32Value(input)); return f.OwnValue(value).As<Integer>();
}
int64_t Integer::Value() const { CHECK(IsNumber());return IntegerNumber(cell().value.toNumber()); }
static_assert(JS::MaxStringLength<=INT_MAX);
const int String::kMaxLength = int(JS::MaxStringLength);
const size_t Uint8Array::kMaxLength = js::ArrayBufferObject::ByteLengthLimit;
Local<String> String::Empty(Isolate* isolate) {
  auto& f = Current(isolate); JS::RootedValue value(f.cx, JS::StringValue(JS_GetEmptyString(f.cx))); return f.Own<String>(value);
}
Local<String> String::Concat(Isolate* isolate, Local<String> left, Local<String> right) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  StressCollection(f);
  JS::RootedString a(f.cx, left->cell().value.toString()), b(f.cx, right->cell().value.toString());
  JS::RootedString string(f.cx, JS_ConcatStrings(f.cx, a, b)); if (!string) return {};
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
MaybeLocal<String> String::NewFromOneByte(Isolate* isolate, const uint8_t* bytes, NewStringType type, int length) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  StressCollection(f);
  CHECK_GE(length,-1);if(length==-1)length=int(std::strlen(reinterpret_cast<const char*>(bytes)));
  JS::RootedString string(f.cx,type==NewStringType::kInternalized?JS_AtomizeStringN(f.cx,reinterpret_cast<const char*>(bytes),size_t(length)):JS_NewStringCopyN(f.cx,reinterpret_cast<const char*>(bytes),size_t(length))); if (!string) return {};
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
MaybeLocal<String> String::NewFromTwoByte(Isolate* isolate, const uint16_t* bytes, NewStringType type, int length) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  StressCollection(f);
  CHECK_GE(length,-1);if(length==-1){length=0;while(bytes[length])++length;}
  JS::RootedString string(f.cx,type==NewStringType::kInternalized?JS_AtomizeUCStringN(f.cx,reinterpret_cast<const char16_t*>(bytes),size_t(length)):JS_NewUCStringCopyN(f.cx,reinterpret_cast<const char16_t*>(bytes),size_t(length))); if (!string) return {};
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
MaybeLocal<String> String::NewFromUtf8(Isolate* isolate, const char* bytes, NewStringType type, int length) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  CHECK_GE(length,-1);
  if(length==-1){const size_t count=std::strlen(bytes);CHECK_LE(count,size_t(INT_MAX));length=int(count);}
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
void String::WriteV2(Isolate* isolate, size_t start, size_t length, uint16_t* output) {
  ValueView view(isolate, Local<String>(this)); MOZ_RELEASE_ASSERT(start <= view.length() && length <= view.length() - start);
  if (view.is_one_byte()) for (size_t i=0; i<length; ++i) output[i]=view.data8()[start+i];
  else std::memcpy(output, view.data16()+start, length*sizeof(uint16_t));
}
size_t String::WriteUtf8V2(Isolate* isolate, char* output, size_t length, WriteFlags) {
  auto& f = Current(isolate); JS::RootedString string(f.cx, cell().value.toString());
  auto written = JS_EncodeStringToUTF8BufferPartial(f.cx, string, mozilla::Span<char>(output, length));
  if (!written) { JS_ReportOutOfMemory(f.cx); return 0; } return std::get<1>(*written);
}
struct MemoryAccount {
  std::weak_ptr<State> state;
  std::shared_ptr<State> retained;
  bool keepOwner;
  size_t bytes=0;
  explicit MemoryAccount(bool keep):keepOwner(keep) {}
};
// External string resources must retain their Isolate through their destructor.
// The Environment's own cumulative account uses weak ownership to avoid a cycle.
ExternalMemoryAccounter::ExternalMemoryAccounter(bool keepOwner) : account_(std::make_unique<MemoryAccount>(keepOwner)) {}
ExternalMemoryAccounter::~ExternalMemoryAccounter() { MOZ_RELEASE_ASSERT(account_->bytes==0); }
void ExternalMemoryAccounter::Increase(Isolate* isolate, size_t bytes) {
  auto state=isolate->owner.lock();MOZ_RELEASE_ASSERT(state);
  auto previous=account_->state.lock();MOZ_RELEASE_ASSERT(!previous||previous==state);
  account_->state=state;if(account_->keepOwner)account_->retained=state;
  MOZ_RELEASE_ASSERT(bytes<=SIZE_MAX-account_->bytes);account_->bytes+=bytes;
  state->externalBytes.fetch_add(bytes);state->created.fetch_add(1);
  if(!account_->keepOwner){
    auto& frame=Current(isolate);state->environment.AssertForeground();
    JS::RootedObject owner(frame.cx,state->environment.memory_owner(frame.cx));CHECK(owner);
    JS::AddAssociatedMemory(owner,bytes,JS::MemoryUse::Embedding1);
  }
}
void ExternalMemoryAccounter::Decrease(Isolate* isolate, size_t bytes) {
  auto state=account_->state.lock();
  MOZ_RELEASE_ASSERT(state && &state->isolate==isolate && account_->bytes>=bytes);
  state->externalBytes.fetch_sub(bytes);state->released.fetch_add(1);account_->bytes-=bytes;
  if(!account_->keepOwner){
    auto& frame=Current(isolate);state->environment.AssertForeground();
    JS::RootedObject owner(frame.cx,state->environment.memory_owner(frame.cx));CHECK(owner);
    JS::RemoveAssociatedMemory(owner,bytes,JS::MemoryUse::Embedding1);
  }
  // Keep the actual native owner until this accounter is destroyed. The source
  // resource's destructor still holds its Isolate pointer after this call.
}
template<class Resource, class Character> class External final : public JSExternalStringCallbacks {
  Resource* resource_;
 public:
  explicit External(Resource* resource) : resource_(resource) {}
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
  StressCollection(f);
  auto* callbacks=new External<ExternalOneByteStringResource,char>(resource);
  JS::RootedString string(f.cx, JS_NewExternalStringLatin1(f.cx,
      reinterpret_cast<const JS::Latin1Char*>(resource->data()), resource->length(), callbacks));
  if (!string) { delete callbacks; return {}; }
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
MaybeLocal<String> String::NewExternalTwoByte(Isolate* isolate, ExternalStringResource* resource) {
  auto& f=Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  StressCollection(f);
  auto* callbacks=new External<ExternalStringResource,uint16_t>(resource);
  JS::RootedString string(f.cx, JS_NewExternalUCString(f.cx,
      reinterpret_cast<const char16_t*>(resource->data()), resource->length(), callbacks));
  if (!string) { delete callbacks; return {}; }
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
}  // namespace kandelo_node_codec_api

namespace kandelo_node_codec_impl {
using namespace api;
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
      if(frame.domain==Domain::Buffer && !shared && !buffer->as<js::ArrayBufferObject>().isDetached()) {
        storage=js::ArrayBufferObject::retainKandeloContents(frame.cx,buffer.as<js::ArrayBufferObject>());CHECK(storage);
      } else if(frame.domain!=Domain::Buffer) pinned=JS::PinArrayBufferOrViewLength(input, true);
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
Environment* Environment::GetCurrent(Local<Context> context) { return &Current(context->isolate).state->environment; }
Environment* Environment::GetCurrent(const FunctionCallbackInfo<Value>& args) { return GetCurrent(args.GetIsolate()->GetCurrentContext()); }
Isolate* Environment::isolate() { return isolate_; }
#define KANDELO_ENV_STRING_ACCESSOR(name, text) \
Local<String> Environment::name() { \
  auto& f=Current(isolate());AssertForeground(); \
  JS::RootedString string(f.cx,JS_AtomizeString(f.cx,text));if(!string)return {}; \
  JS::RootedValue value(f.cx,JS::StringValue(string));return f.Own<String>(value); \
}
PER_ISOLATE_STRING_PROPERTIES(KANDELO_ENV_STRING_ACCESSOR)
#undef KANDELO_ENV_STRING_ACCESSOR
void Environment::ThrowUVException(int error,const char* syscall,const char* message,const char* path,const char* dest) {
  AssertForeground();isolate()->ThrowException(UVException(isolate(),error,syscall,message,path,dest));
}
void Environment::ThrowErrnoException(int error,const char* syscall,const char* message,const char* path) {
  AssertForeground();isolate()->ThrowException(ErrnoException(isolate(),error,syscall,message,path));
}
std::shared_ptr<KVStore> Environment::env_vars(){AssertForeground();return per_process::system_environment;}
static JSObject* PrincipalOptionsRealm(Frame& f){
  JS::RootedObject runtime(f.cx,kandelo::node::GetRealmRuntime(f.cx,f.realm));if(!runtime)return nullptr;
  JS::RootedObject realm(f.cx,kandelo::node::GetRuntimePrincipalRealm(f.cx,runtime));if(!realm)return nullptr;
  return js::CheckedUnwrapDynamic(realm,f.cx,false);
}
std::shared_ptr<NativeEnvOptions> Environment::options(){
  auto& f=Current(isolate());AssertForeground();auto owner=context();CHECK(!owner.IsEmpty());
  Context::Scope home(owner);JS::RootedObject realm(f.cx,PrincipalOptionsRealm(f));if(!realm)return {};
  return kandelo::node::BorrowNativeEnvironmentOptions(f.cx,realm);
}
IsolateData::IsolateData():IsolateData(Isolate::GetCurrent()){}
IsolateData::IsolateData(Isolate* isolate):isolate_(isolate){CHECK(isolate_);}
Isolate* IsolateData::isolate() {auto& frame=Current(isolate_);frame.state->environment.AssertForeground();return isolate_;}
std::shared_ptr<FatalIsolateOptions> IsolateData::options(){
  auto& f=Current(isolate());auto owner=f.state->environment.context();CHECK(!owner.IsEmpty());
  Context::Scope home(owner);JS::RootedObject realm(f.cx,PrincipalOptionsRealm(f));if(!realm)return {};
  return kandelo::node::BorrowNativeIsolateOptions(f.cx,realm);
}
void IsolateData::set_i18n_converter_template(Local<ObjectTemplate> value) {
  auto& f=Current(isolate());CHECK(f.binding && JS::GetClass(f.binding)==&api::icuBindingClass);
  JS::RootedValue metadata(f.cx,Input(value));CHECK(JS_WrapValue(f.cx,&metadata));JS::SetReservedSlot(f.binding,0,metadata);
}
Local<ObjectTemplate> Environment::i18n_converter_template() {
  auto& f=*Frame::current;CHECK(f.binding && JS::GetClass(f.binding)==&api::icuBindingClass);
  JS::RootedValue value(f.cx,JS::GetReservedSlot(f.binding,0));CHECK(value.isObject());
  return f.Own<ObjectTemplate>(value);
}
struct NativeObjectOwner {
  std::shared_ptr<State> state;
  bool category=false;
  std::unique_ptr<JS::PersistentRootedObject> root;
  Global<Object> handle;
  Realm* realm=nullptr;
  bool detached=false,wantsWeak=false;
  std::weak_ptr<BaseObject> nativeReference;
  NativeObjectOwner(Frame& frame,JS::HandleObject object):state(frame.state),
      root(std::make_unique<JS::PersistentRootedObject>(frame.cx,object)) { category=frame.domain==api::Domain::Trace; }
};
void FinalizeConverter(JS::GCContext*,JSObject* object) {
  auto value=JS::GetReservedSlot(object,0);
  if (!value.isUndefined()) {
    // Retire the pointer before the native resource's destructor runs.
    JS::SetReservedSlot(object,0,JS::UndefinedValue());
    auto* native=static_cast<BaseObject*>(value.toPrivate());
    CHECK(!native->HasNativeReference());native->OnGCCollect();
  }
}
const JSClassOps converterOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeConverter};
const JSClass converterClass={"Converter",JSCLASS_HAS_RESERVED_SLOTS(BaseObject::kInternalFieldCount+1)|JSCLASS_FOREGROUND_FINALIZE,&converterOps};
BaseObject::BaseObject(Environment* environment,Local<Object> input) {
  auto& f=*Frame::current;JS::RootedObject object(f.cx,UnwrapObject(f.cx,Input(input)));
  CHECK(environment==&f.state->environment);
  CHECK(object && JS::GetClass(object)==(f.domain==api::Domain::Diagnostics?&nativeChannelClass:f.domain==api::Domain::Trace?&categoryClass:&converterClass) && JS::GetReservedSlot(object,0).isUndefined());
  owner_=std::make_unique<NativeObjectOwner>(f,object);
  // Keep ownership in the traced graph after MakeWeak drops the native root.
  {JSAutoRealm home(f.cx,object);JS::RootedObject realm(f.cx,f.realm);CHECK(JS_WrapObject(f.cx,&realm));JS::SetReservedSlot(object,1,JS::ObjectValue(*realm));}
  JS::SetReservedSlot(object,0,JS::PrivateValue(this));
  if(f.domain==api::Domain::Diagnostics){
    owner_->realm=environment->principal_realm();CHECK(owner_->realm);
    JS::RootedValue actual(f.cx,JS::ObjectValue(*object));owner_->handle.Reset(&f.state->isolate,f.Own<Object>(actual));owner_->root.reset();owner_->realm->RegisterObject(this);
  }else (owner_->category?owner_->state->traceCreated:owner_->state->icuCreated).fetch_add(1);
}
Environment* BaseObject::env()const { owner_->state->environment.AssertForeground();if(Frame::current)CHECK(owner_->state==Frame::current->state);return &owner_->state->environment; }
void BaseObject::MakeWeak() {
  if(owner_->realm){
    owner_->wantsWeak=true;
    if(!owner_->handle.IsEmpty()&&!owner_->handle.IsWeak())owner_->handle.SetWeak();
    // Promotion occurs while a live callback Frame is available. The last
    // native reference can subsequently restore this tenured weak edge even
    // from a native callback with no JavaScript frame.
    if(HasNativeReference())owner_->handle.ClearWeak();return;
  }
  CHECK(owner_->root);owner_->root.reset();
}
BaseObject* BaseObject::Unwrap(Local<Object> input) {
  auto& f=*Frame::current;JS::RootedObject object(f.cx,UnwrapObject(f.cx,Input(input)));
  if (!object || JS::GetClass(object)!=(f.domain==api::Domain::Trace?&categoryClass:&converterClass)) return nullptr;
  auto value=JS::GetReservedSlot(object,0);if (value.isUndefined()) return nullptr;
  JS::RootedObject realm(f.cx,js::CheckedUnwrapDynamic(&JS::GetReservedSlot(object,1).toObject(),f.cx,false));
  if (!realm||!kandelo::node::CheckRealmLibraryActive(f.cx,realm)) return nullptr;
  return static_cast<BaseObject*>(value.toPrivate());
}

}  // namespace kandelo_node_codec_impl

namespace kandelo_node_codec_api {
void SetTraceFieldCount(JSObject*,int);
Frame::~Frame() { current=previous; }
native::SpanOwner& Frame::Borrow(Local<Value> input) {
  JS::RootedObject object(cx, UnwrapView(cx, Input(input))); CHECK_NOT_NULL(object);
  for (auto& span:spans) if (span->object==object) return *span;
  spans.push_back(std::make_unique<native::SpanOwner>(*this, object)); return *spans.back();
}
bool ApplyNativeTemplate(Frame&,Local<ObjectTemplate>,JS::HandleObject);
Local<FunctionTemplate> CreateNativeWrapperTemplate(Isolate*,int);
namespace {
using Callback=void(*)(const FunctionCallbackInfo<Value>&);
struct CallbackOwner { Callback callback;Domain domain;bool constructor=false,categoryReceiver=false;int fieldCount=0;std::shared_ptr<const CFunction::Signature> fast; };
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
std::shared_ptr<State> ReadCodecState(JSContext* cx,JS::HandleObject runtime) {
  JS::RootedObject state(cx,kandelo::node::GetRuntimeCodecState(cx,runtime,true)); if (!state) return {};
  state=js::CheckedUnwrapDynamic(state,cx,false); if (!state) return {};
  MOZ_RELEASE_ASSERT(JS::GetClass(state)==&stateClass);
  auto data=*static_cast<std::shared_ptr<State>*>(JS::GetReservedSlot(state,0).toPrivate());
  if (!data->environment.Initialize(cx,runtime)) return {};
  return data;
}
bool Invoke(JSContext* cx,unsigned argc,JS::Value* vp) {
  auto args=JS::CallArgsFromVp(argc,vp);JS::RootedObject callee(cx,&args.callee());
  JS::RootedObject realm(cx,&js::GetFunctionNativeReserved(callee,0).toObject());
  JS::RootedObject closure(cx,&js::GetFunctionNativeReserved(callee,1).toObject());
  // The engine return slot aliases the callee. V8 callbacks start undefined,
  // including source paths that return without setting a result.
  args.rval().setUndefined();
  if (!kandelo::node::CheckRealmLibraryActive(cx,realm)) return false;
  JS::RootedObject runtime(cx,kandelo::node::GetRealmRuntime(cx,realm)); if (!runtime) return false;
  CHECK(JS::GetClass(closure)==&callbackClass);
  auto* callback=static_cast<CallbackOwner*>(JS::GetReservedSlot(closure,0).toPrivate());
  auto state=ReadCodecState(cx,runtime); if (!state) return false; Frame frame(cx,realm,state,&args,callback->domain);
  frame.binding=&JS::GetReservedSlot(closure,1).toObject();
  frame.receiver=args.thisv();
  if (callback->domain==Domain::Trace) {
    frame.tracing=kandelo::node::GetTraceProcess(cx,realm);if (!frame.tracing) return false;
    if (callback->categoryReceiver) {
      JS::RootedObject receiver(cx,UnwrapObject(cx,args.thisv()));
      if (!receiver || JS::GetClass(receiver)!=&native::categoryClass) {
        if (!JS_IsExceptionPending(cx)) state->isolate.ThrowException(Error(&state->isolate,JSEXN_TYPEERR,nullptr,"Illegal invocation"));
        return false;
      }
    }
    if (callback->constructor) {
      if (args.isConstructing()) {
        CHECK(callback->fieldCount==native::BaseObject::kInternalFieldCount);
        JS::RootedObject instance(cx,JS_NewObjectForConstructor(cx,&native::categoryClass,args));
        if (!instance) return false;frame.receiver.setObject(*instance);args.rval().setObject(*instance);
      } else {
        JS::RootedObject receiver(cx,args.thisv().isNullOrUndefined()?JS::CurrentGlobalOrNull(cx):JS::ToObject(cx,args.thisv()));
        if (!receiver) return false;frame.receiver.setObject(*receiver);
      }
    }
  }
  if (callback->domain==Domain::Decoder) {
    auto input=Argument(&state->isolate,0); CHECK(input->IsArrayBufferView());
    auto& span=frame.Borrow(input);
  // The private source assumes its complete native state allocation. Guard
  // that trust boundary before handing its real writable bytes to the source.
  CHECK(span.size>=sizeof(native::StringDecoder));
  CHECK(span.bytes[native::StringDecoder::kBufferedBytes]+span.bytes[native::StringDecoder::kMissingBytes]<=native::StringDecoder::kIncompleteCharactersEnd);
  }
  FunctionCallbackInfo<Value> call(&state->isolate); callback->callback(call);
  return !JS_IsExceptionPending(cx)&&!js::shell::GetShellContext(cx)->upstreamNodeExecutionTerminated;
}
}
}  // namespace kandelo_node_codec_api

namespace kandelo_node_codec_impl {
namespace per_process {bool v8_initialized=false;}
}
namespace kandelo::node {
void SetNativeEngineActive(bool active) {
  MOZ_RELEASE_ASSERT(!active||JS_IsInitialized());
  native::per_process::v8_initialized=active;
}
bool TraceNativeCallIsActive() {
  // A JSON getter or observer can enter another native binding before it
  // reaches the private teardown control. Inspect the entire native stack.
  for (auto* frame=api::Frame::current;frame;frame=frame->previous)
    if (frame->domain==api::Domain::Trace) return true;
  return false;
}
JSObject* CreateCodecState(JSContext* cx) {
  JS::RootedObject object(cx,JS_NewObject(cx,&api::stateClass)); if (!object) return nullptr;
  auto state=std::make_shared<api::State>(); state->isolate.owner=state;
  JS::SetReservedSlot(object,0,JS::PrivateValue(new std::shared_ptr<api::State>(state))); return object;
}
JSObject* CreateProcessMethodsBinding(JSContext* cx,JS::HandleObject realm) {
#ifdef KANDELO_NATIVE_OWNER_PROBE
  JS_ReportErrorASCII(cx,"process_methods is unavailable in the private native-owner diagnostic build");return nullptr;
#else
  JS::RootedObject runtime(cx,GetRealmRuntime(cx,realm));if(!runtime)return nullptr;
  auto state=api::ReadCodecState(cx,runtime);if(!state)return nullptr;
  api::Frame frame(cx,realm,state,nullptr,api::Domain::Diagnostics);
  if(!state->environment.PrepareProcessInvocation())return nullptr;
  JS::RootedObject object(cx,JS_NewObject(cx,&native::nativeBindingClass));if(!object)return nullptr;
  frame.binding=object;JS::RootedValue value(cx,JS::ObjectValue(*object)),unused(cx,JS::UndefinedValue());
  native::IsolateData isolateData;
  auto bindingTemplate=api::ObjectTemplate::New(&state->isolate,{});
  kandelo_process_methods_adapter::isolate_initializer(&isolateData,bindingTemplate);
  if(!api::ApplyNativeTemplate(frame,bindingTemplate,object))return nullptr;
  if(JS_IsExceptionPending(cx))return nullptr;
  kandelo_process_methods_adapter::initializer(frame.Own<api::Object>(value),frame.OwnValue(unused),state->isolate.GetCurrentContext(),nullptr);
  return JS_IsExceptionPending(cx)?nullptr:object.get();
#endif
}
JSObject* CreateStringDecoderBinding(JSContext* cx,JS::HandleObject realm) {
  JS::RootedObject runtime(cx,GetRealmRuntime(cx,realm)); if (!runtime) return nullptr;
  auto state=api::ReadCodecState(cx,runtime); if (!state) return nullptr; api::Frame frame(cx,realm,state);
  JS::RootedObject object(cx,JS_NewPlainObject(cx)); if (!object) return nullptr;
  JS::RootedValue value(cx,JS::ObjectValue(*object)),unused(cx,JS::UndefinedValue());
  kandelo_codec_adapter::initializer(frame.Own<api::Object>(value),frame.OwnValue(unused),state->isolate.GetCurrentContext(),nullptr);
  if (JS_IsExceptionPending(cx)) return nullptr; return object;
}
JSObject* CreateIcuBinding(JSContext* cx,JS::HandleObject realm) {
  JS::RootedObject runtime(cx,GetRealmRuntime(cx,realm));if (!runtime) return nullptr;
  auto state=api::ReadCodecState(cx,runtime);if (!state) return nullptr;api::Frame frame(cx,realm,state,nullptr,api::Domain::Icu);
  JS::RootedObject object(cx,JS_NewObject(cx,&api::icuBindingClass));if (!object) return nullptr;frame.binding=object;
  JS::RootedValue value(cx,JS::ObjectValue(*object)),unused(cx,JS::UndefinedValue());
  native::IsolateData data;
  auto bindingTemplate=api::ObjectTemplate::New(&state->isolate,{});
  kandelo_icu_adapter::initializer(&data,bindingTemplate);
  if(!api::ApplyNativeTemplate(frame,bindingTemplate,object))return nullptr;
  if (JS_IsExceptionPending(cx)) return nullptr;
  kandelo_icu_adapter::context_initializer(frame.Own<api::Object>(value),frame.OwnValue(unused),state->isolate.GetCurrentContext(),nullptr);
  if (JS_IsExceptionPending(cx)) return nullptr;return object;
}
JSObject* InspectCodecState(JSContext* cx,JS::HandleObject runtime) {
  auto state=api::ReadCodecState(cx,runtime); if (!state) return nullptr;
  JS::RootedObject object(cx,JS_NewPlainObject(cx)); if (!object) return nullptr;
  for (const auto& item:std::initializer_list<std::pair<const char*,size_t>>{
      {"externalBytes",state->externalBytes.load()},{"created",state->created.load()},
      {"released",state->released.load()},{"spans",state->spans.load()},{"collections",state->collections.load()},
      {"icuCreated",state->icuCreated.load()},{"icuReleased",state->icuReleased.load()},
      {"traceCreated",state->traceCreated.load()},{"traceReleased",state->traceReleased.load()}}) {
    JS::RootedValue value(cx,JS::DoubleValue(double(item.second)));
    if (!JS_DefineProperty(cx,object,item.first,value,JSPROP_ENUMERATE)) return nullptr;
  }
  return object;
}
bool SetCodecGcStress(JSContext* cx,JS::HandleObject runtime,bool enabled) {
  auto state=api::ReadCodecState(cx,runtime); if (!state) return false; state->stressGc=enabled; return true;
}
}

#include "shell/node-upstream/aliased-codecs-inl.h"
#include "shell/node-upstream/buffer-codecs-inl.h"
#include "shell/node-upstream/continuation-codecs-inl.h"
#include "shell/node-upstream/environment-codecs-inl.h"
#include "shell/node-upstream/message-codecs-inl.h"
#include "shell/node-upstream/native-object-codecs-inl.h"
#include "shell/node-upstream/native-owner-probe-inl.h"
#include "shell/node-upstream/property-codecs-inl.h"
#include "shell/node-upstream/snapshot-codecs-inl.h"
#include "shell/node-upstream/stack-codecs-inl.h"
#include "shell/node-upstream/template-codecs-inl.h"
#include "shell/node-upstream/trace-codecs-inl.h"
