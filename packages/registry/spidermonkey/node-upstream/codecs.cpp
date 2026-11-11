#include "shell/node-upstream/codecs.h"

#include "mozilla/Assertions.h"

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
#include "jsfriendapi.h"

#include "js/Array.h"
#include "js/ArrayBuffer.h"
#include "js/CallAndConstruct.h"
#include "js/CallArgs.h"
#include "js/CharacterEncoding.h"
#include "js/Conversions.h"
#include "js/ErrorReport.h"
#include "js/Exception.h"
#include "js/experimental/TypedData.h"
#include "js/GCAPI.h"
#include "js/JSON.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/SharedArrayBuffer.h"
#include "js/Stack.h"
#include "js/String.h"
#include "js/TracingAPI.h"
#include "js/Wrapper.h"
#include "shell/jsshell.h"
#include "shell/node-upstream/codec-agent-includes.h"
#include "shell/node-upstream/codec-native-api.h"
#include "shell/node-upstream/codecs-upstream/errors.generated.h"
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/node_buffer.h"
#include "shell/node-upstream/codecs-upstream/string_decoder.h"
#undef node
#undef v8

#include "shell/node-upstream/per-context.h"
#include "shell/node-upstream/realm.h"
#include "shell/node-upstream/trace-builtins-upstream/messages.generated.h"
#include "shell/node-upstream/trace-native.h"
#include "shell/node-upstream/trace-utf8-native.h"
#include "shell/node-upstream/tracing-upstream/tracing/agent.h"
#include "vm/ArrayBufferObject.h"
#include "vm/ArrayObject.h"
#include "vm/JSAtomUtils.h"
#include "vm/JSFunction.h"
#include "vm/StringType.h"

namespace kandelo_node_codec_impl { extern const JSClass categoryClass; }
namespace api = kandelo_node_codec_api;
namespace native = kandelo_node_codec_impl;
namespace kandelo_node_codec_api {
const JSClass icuBindingClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(1)};
struct State {
  Isolate isolate;
  std::atomic<size_t> externalBytes{0}, created{0}, released{0}, spans{0}, collections{0};
  bool stressGc=false;
  std::atomic<size_t> traceCreated{0},traceReleased{0};
  std::atomic<size_t> icuCreated{0},icuReleased{0};
};
enum class Domain { Decoder, Icu, Trace };
const JSClass traceBindingClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(3)};
struct Cell {
  JS::PersistentRootedValue value;
  Cell(JSContext* cx, JS::HandleValue input) : value(cx, input) {}
};
struct Frame {
  JSContext* cx;
  JS::RootedObject realm;
  JS::RootedObject binding;
  JS::RootedValue receiver;
  std::shared_ptr<kandelo::node::TraceProcess> tracing;
  std::shared_ptr<State> state;
  JS::CallArgs* arguments;
  Domain domain;
  std::vector<std::unique_ptr<Value>> roots;
  std::vector<std::unique_ptr<native::SpanOwner>> spans;
  native::Environment environment;
  Frame* previous;
  inline static thread_local Frame* current = nullptr;
  Frame(JSContext* cx, JS::HandleObject realm, std::shared_ptr<State> state,
        JS::CallArgs* arguments = nullptr, Domain domain = Domain::Decoder)
      : cx(cx), realm(cx, realm), binding(cx), receiver(cx), state(std::move(state)), arguments(arguments), domain(domain),
        previous(current) { current = this; }
  ~Frame();
  template<class T> Local<T> Own(JS::HandleValue value) {
    auto item = std::make_unique<T>(std::make_unique<Cell>(cx, value));
    auto* pointer = item.get(); roots.push_back(std::move(item));
    return Local<T>(pointer);
  }
  Local<Value> OwnValue(JS::HandleValue value);
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
static void StressCollection(Frame& frame) {
  if (!frame.state->stressGc) return;
  const uint32_t before=JS_GetGCParameter(frame.cx,JSGC_NUMBER);
  JS::PrepareForFullGC(frame.cx);
  JS::NonIncrementalGC(frame.cx,JS::GCOptions::Shrink,JS::GCReason::API);
  const uint32_t after=JS_GetGCParameter(frame.cx,JSGC_NUMBER);
  MOZ_RELEASE_ASSERT(after!=before);
  frame.state->collections.fetch_add(uint32_t(after-before));
}
static JS::HandleValue Input(Local<Value> value) {
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
Value::Value(std::unique_ptr<Cell> cell) : cell_(std::move(cell)) {}
Value::~Value() = default;
Cell& Value::cell() const { return *cell_; }
bool Value::IsString() const { return cell().value.isString(); }
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
  auto& f=Current(context->isolate);uint32_t value;
  if (!JS::ToUint32(f.cx,cell().value,&value)) return {};return Just(value);
}
Local<Value> Frame::OwnValue(JS::HandleValue value) {
  // Source Local::As must refer to the actual C++ wrapper type as well as the
  // actual engine value. A string-tagged base object is not a String object.
  if (value.isString()) return Own<String>(value);
  if (UnwrapView(cx, value)) return Own<ArrayBufferView>(value);
  if (value.isObject()) {
    auto* object=UnwrapObject(cx,value);
    if (object && object->is<js::ArrayObject>()) return Own<Array>(value);
    if (JS::IsCallable(&value.toObject())) return Own<Function>(value);
    return Own<Object>(value);
  }
  if (value.isNumber()) {
    double n=value.toNumber();
    if (std::isfinite(n) && !(n==0 && std::signbit(n)) && n>=INT32_MIN && n<=UINT32_MAX && std::trunc(n)==n)
      return Own<Integer>(value);
    return Own<Number>(value);
  }
  return Own<Value>(value);
}
Local<Value> Argument(Isolate* isolate, int index) {
  auto& f = Current(isolate); MOZ_RELEASE_ASSERT(f.arguments);
  JS::RootedValue value(f.cx, f.arguments->get(index)); return f.OwnValue(value);
}
void Return(Isolate* isolate, Local<Value> value) {
  auto& f = Current(isolate); MOZ_RELEASE_ASSERT(f.arguments);
  if (!value.IsEmpty() && !JS_IsExceptionPending(f.cx)) f.arguments->rval().set(Input(value));
}
void ReturnNumber(Isolate* isolate,double value) { auto& f=Current(isolate);if (!JS_IsExceptionPending(f.cx))f.arguments->rval().setNumber(value); }
void ReturnBoolean(Isolate* isolate,bool value) { auto& f=Current(isolate);if (!JS_IsExceptionPending(f.cx))f.arguments->rval().setBoolean(value); }
int ArgumentCount(Isolate* isolate) { auto& f=Current(isolate);CHECK(f.arguments);return int(f.arguments->length()); }
struct CatchScope {
  JS::AutoSaveExceptionState saved;
  explicit CatchScope(JSContext* cx):saved(cx) {}
  ~CatchScope() { saved.restore(); }
};
TryCatch::TryCatch(Isolate* isolate):scope_(std::make_unique<CatchScope>(Current(isolate).cx)) {}
TryCatch::~TryCatch()=default;
Local<Context> Isolate::GetCurrentContext() { Current(this); return Local<Context>(&context); }
void Isolate::ThrowException(Local<Value> value) {
  auto& f = Current(this);
  if (!value.IsEmpty() && !JS_IsExceptionPending(f.cx)) JS_SetPendingException(f.cx, Input(value));
}
HandleScope::HandleScope(Isolate* isolate) : frame_(&Current(isolate)), previous_(frame_->roots.size()) {}
HandleScope::~HandleScope() { frame_->roots.resize(previous_); }
static Local<Value> Error(Isolate* isolate, JSExnType type, const char* code, const char* text) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject stack(f.cx); if (!JS::CaptureCurrentStack(f.cx, &stack)) return {};
  JS::RootedString filename(f.cx, JS_NewStringCopyZ(f.cx, "")), message(f.cx, JS_NewStringCopyZ(f.cx, text));
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
MaybeLocal<String> Value::ToString(Local<Context> context) {
  auto& f = Current(context->isolate); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedString string(f.cx, JS::ToString(f.cx, cell().value)); if (!string) return {};
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
Maybe<bool> Object::Set(Local<Context> context, Local<Value> property, Local<Value> input) {
  auto& f = Current(context->isolate); if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject object(f.cx, &cell().value.toObject()); JS::RootedId id(f.cx);
  JS::RootedValue name(f.cx, Input(property)), value(f.cx, Input(input));
  if (!JS_ValueToId(f.cx, name, &id) || !JS_SetPropertyById(f.cx, object, id, value)) return {};
  return Just(true);
}
Local<Array> Array::New(Isolate* isolate) {
  auto& f = Current(isolate); JS::RootedObject object(f.cx, JS::NewArrayObject(f.cx, 0)); if (!object) return {};
  JS::RootedValue value(f.cx, JS::ObjectValue(*object)); return f.Own<Array>(value);
}
Maybe<bool> Array::Set(Local<Context> context, int32_t index, Local<Value> input) {
  auto& f = Current(context->isolate); JS::RootedObject object(f.cx, &cell().value.toObject());
  JS::RootedValue value(f.cx, Input(input));
  if (!JS_SetElement(f.cx, object, index, value)) return {}; return Just(true);
}
Local<Integer> Integer::New(Isolate* isolate, int input) {
  auto& f = Current(isolate); JS::RootedValue value(f.cx, JS::Int32Value(input)); return f.Own<Integer>(value);
}
int64_t Integer::Value() const { CHECK(IsInt32() || IsUint32());return int64_t(cell().value.toNumber()); }
const size_t String::kMaxLength = JS::MaxStringLength;
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
MaybeLocal<String> String::NewFromOneByte(Isolate* isolate, const uint8_t* bytes, NewStringType, int length) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  StressCollection(f);
  JS::RootedString string(f.cx, JS_NewStringCopyN(f.cx, reinterpret_cast<const char*>(bytes), size_t(length))); if (!string) return {};
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
MaybeLocal<String> String::NewFromTwoByte(Isolate* isolate, const uint16_t* bytes, NewStringType, int length) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
  StressCollection(f);
  JS::RootedString string(f.cx, JS_NewUCStringCopyN(f.cx, reinterpret_cast<const char16_t*>(bytes), size_t(length))); if (!string) return {};
  JS::RootedValue value(f.cx, JS::StringValue(string)); return f.Own<String>(value);
}
MaybeLocal<String> String::NewFromUtf8(Isolate* isolate, const char* bytes, NewStringType type, int length) {
  auto& f = Current(isolate); if (JS_IsExceptionPending(f.cx)) return {};
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
struct MemoryAccount { std::shared_ptr<State> state; size_t bytes=0; };
ExternalMemoryAccounter::ExternalMemoryAccounter() : account_(std::make_unique<MemoryAccount>()) {}
ExternalMemoryAccounter::~ExternalMemoryAccounter() { MOZ_RELEASE_ASSERT(account_->bytes==0); }
void ExternalMemoryAccounter::Increase(Isolate* isolate, size_t bytes) {
  MOZ_RELEASE_ASSERT(!account_->state); account_->state=isolate->owner.lock(); MOZ_RELEASE_ASSERT(account_->state);
  account_->bytes=bytes; account_->state->externalBytes.fetch_add(bytes); account_->state->created.fetch_add(1);
}
void ExternalMemoryAccounter::Decrease(Isolate* isolate, size_t bytes) {
  MOZ_RELEASE_ASSERT(account_->state && &account_->state->isolate==isolate && account_->bytes==bytes);
  account_->state->externalBytes.fetch_sub(bytes); account_->state->released.fetch_add(1); account_->bytes=0;
  // Keep the actual native owner until this accounter is destroyed. The source
  // resource's destructor still holds its Isolate pointer after this call.
}
template<class Resource, class Character> class External final : public JSExternalStringCallbacks {
  Resource* resource_;
 public:
  explicit External(Resource* resource) : resource_(resource) {}
  void Release(const void* chars) const {
    MOZ_RELEASE_ASSERT(chars==resource_->data()); delete resource_; delete this;
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
      pinned=JS::PinArrayBufferOrViewLength(input, true);
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
template<class T,size_t N> ArrayBufferViewContents<T,N>::ArrayBufferViewContents(Local<ArrayBufferView> input) {
  auto& frame=*Frame::current; JS::RootedObject object(frame.cx, UnwrapView(frame.cx, Input(input)));
  CHECK_NOT_NULL(object); owner_=std::make_unique<SpanOwner>(frame, object);
}
template<class T,size_t N> ArrayBufferViewContents<T,N>::ArrayBufferViewContents(Local<Value> input) {
  auto& frame=*Frame::current;JS::RootedObject object(frame.cx,api::UnwrapBytes(frame.cx,Input(input)));
  CHECK_NOT_NULL(object);owner_=std::make_unique<SpanOwner>(frame,object);
}
template<class T,size_t N> ArrayBufferViewContents<T,N>::~ArrayBufferViewContents()=default;
template<class T,size_t N> T* ArrayBufferViewContents<T,N>::data() const { return reinterpret_cast<T*>(owner_->bytes); }
template<class T,size_t N> size_t ArrayBufferViewContents<T,N>::length() const { return owner_->size; }
template class ArrayBufferViewContents<char,64>;
template<class T,size_t N> MaybeStackBuffer<T,N>::MaybeStackBuffer() { stack_[0]=T{}; }
template<class T,size_t N> MaybeStackBuffer<T,N>::MaybeStackBuffer(size_t length) : MaybeStackBuffer() { AllocateSufficientStorage(length); }
template<class T,size_t N> MaybeStackBuffer<T,N>::~MaybeStackBuffer() { if (data_!=stack_) std::free(data_); }
template<class T,size_t N> T* MaybeStackBuffer<T,N>::out() { return data_; }
template<class T,size_t N> const T* MaybeStackBuffer<T,N>::out() const { return data_; }
template<class T,size_t N> T* MaybeStackBuffer<T,N>::operator*() { return data_; }
template<class T,size_t N> size_t MaybeStackBuffer<T,N>::length() const { return length_; }
template<class T,size_t N> void MaybeStackBuffer<T,N>::SetLength(size_t length) { CHECK_LE(length,capacity_); length_=length; }
template<class T,size_t N> void MaybeStackBuffer<T,N>::AllocateSufficientStorage(size_t length) {
  if (length>capacity_) {
    CHECK_LE(length,std::numeric_limits<size_t>::max()/sizeof(T));
    auto* data=static_cast<T*>(std::malloc(length*sizeof(T))); CHECK_NOT_NULL(data);
    std::memcpy(data,data_,length_*sizeof(T)); if (data_!=stack_) std::free(data_);
    data_=data; capacity_=length;
  }
  // The original utility sets logical length even when existing storage fits.
  length_=length;
}
template<class T,size_t N> bool MaybeStackBuffer<T,N>::IsAllocated() const { return data_!=stack_; }
template<class T,size_t N> void MaybeStackBuffer<T,N>::Release() { CHECK(data_!=stack_); data_=stack_; length_=0; capacity_=N; }
template class MaybeStackBuffer<char,512>;
template class MaybeStackBuffer<char,1024>;
template class MaybeStackBuffer<char,4096>;
template class MaybeStackBuffer<char16_t,1024>;
template class MaybeStackBuffer<char16_t,256>;
template class MaybeStackBuffer<uint16_t,256>;
template class MaybeStackBuffer<uint16_t,1024>;
template<class T> T* UncheckedMalloc(size_t length) {
  if (length>std::numeric_limits<size_t>::max()/sizeof(T)) return nullptr;
  return static_cast<T*>(std::malloc(length*sizeof(T)));
}
template char* UncheckedMalloc<char>(size_t);
template uint16_t* UncheckedMalloc<uint16_t>(size_t);
TwoByteValue::TwoByteValue(Isolate* isolate, Local<Value> input) {
  auto& f=Current(isolate); Local<String> string;
  if (!input->ToString(isolate->GetCurrentContext()).ToLocal(&string)) return;
  AllocateSufficientStorage(string->Length()); string->WriteV2(isolate,0,string->Length(),out());
  if (!JS_IsExceptionPending(f.cx)) SetLength(string->Length());
}
Utf8Value::Utf8Value(Isolate* isolate,Local<Value> input) {
  auto& f=Current(isolate);Local<String> string;
  if (!input->ToString(isolate->GetCurrentContext()).ToLocal(&string)) { Invalidate();return; }
  JS::RootedString value(f.cx,string->cell().value.toString());
  auto bytes=JS_EncodeStringToUTF8(f.cx,value);if (!bytes) { Invalidate();return; }
  JSLinearString* linear=value->ensureLinear(f.cx);if (!linear) { Invalidate();return; }
  size_t length=JS::GetDeflatedUTF8StringLength(linear);
  AllocateSufficientStorage(length+1);std::memcpy(out(),bytes.get(),length+1);SetLength(length);
}
Environment* Environment::GetCurrent(Local<Context> context) { return &Current(context->isolate).environment; }
Environment* Environment::GetCurrent(const FunctionCallbackInfo<Value>& args) { return GetCurrent(args.GetIsolate()->GetCurrentContext()); }
Isolate* Environment::isolate() { return &Frame::current->state->isolate; }
Local<Context> Environment::context() { return isolate()->GetCurrentContext(); }
Isolate* IsolateData::isolate() { return &Frame::current->state->isolate; }
void IsolateData::set_i18n_converter_template(Local<ObjectTemplate> value) {
  auto& f=*Frame::current;CHECK(f.binding && JS::GetClass(f.binding)==&api::icuBindingClass);
  JS::SetReservedSlot(f.binding,0,Input(value));
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
  NativeObjectOwner(Frame& frame,JS::HandleObject object):state(frame.state),
      root(std::make_unique<JS::PersistentRootedObject>(frame.cx,object)) { category=frame.domain==api::Domain::Trace; }
};
void FinalizeConverter(JS::GCContext*,JSObject* object) {
  auto value=JS::GetReservedSlot(object,0);
  if (!value.isUndefined()) {
    // Retire the pointer before the native resource's destructor runs.
    JS::SetReservedSlot(object,0,JS::UndefinedValue());
    delete static_cast<BaseObject*>(value.toPrivate());
  }
}
const JSClassOps converterOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeConverter};
const JSClass converterClass={"Converter",JSCLASS_HAS_RESERVED_SLOTS(BaseObject::kInternalFieldCount)|JSCLASS_FOREGROUND_FINALIZE,&converterOps};
BaseObject::BaseObject(Environment*,Local<Object> input) {
  auto& f=*Frame::current;JS::RootedObject object(f.cx,UnwrapObject(f.cx,Input(input)));
  CHECK(object && JS::GetClass(object)==(f.domain==api::Domain::Trace?&categoryClass:&converterClass) && JS::GetReservedSlot(object,0).isUndefined());
  owner_=std::make_unique<NativeObjectOwner>(f,object);
  // Keep ownership in the traced graph after MakeWeak drops the native root.
  JS::SetReservedSlot(object,1,JS::ObjectValue(*f.realm));
  JS::SetReservedSlot(object,0,JS::PrivateValue(this));
  (owner_->category?owner_->state->traceCreated:owner_->state->icuCreated).fetch_add(1);
}
BaseObject::~BaseObject() { (owner_->category?owner_->state->traceReleased:owner_->state->icuReleased).fetch_add(1); }
Environment* BaseObject::env() { CHECK(owner_->state==Frame::current->state);return &Frame::current->environment; }
void BaseObject::MakeWeak() { CHECK(owner_->root);owner_->root.reset(); }
BaseObject* BaseObject::Unwrap(Local<Object> input) {
  auto& f=*Frame::current;JS::RootedObject object(f.cx,UnwrapObject(f.cx,Input(input)));
  if (!object || JS::GetClass(object)!=(f.domain==api::Domain::Trace?&categoryClass:&converterClass)) return nullptr;
  auto value=JS::GetReservedSlot(object,0);if (value.isUndefined()) return nullptr;
  JS::RootedObject realm(f.cx,&JS::GetReservedSlot(object,1).toObject());
  if (!kandelo::node::CheckRealmLibraryActive(f.cx,realm)) return nullptr;
  return static_cast<BaseObject*>(value.toPrivate());
}
Local<String> OneByteString(Isolate* isolate,const char* text) {
  return String::NewFromOneByte(isolate,reinterpret_cast<const uint8_t*>(text),NewStringType::kNormal,int(std::strlen(text))).ToLocalChecked();
}
bool StringEqualNoCase(const char* a,const char* b) {
  // The encoding parser requires ASCII folding independent of guest locale.
  locale_t ascii=newlocale(LC_CTYPE_MASK,"C",nullptr);CHECK_NOT_NULL(ascii);
  bool same=strcasecmp_l(a,b,ascii)==0;freelocale(ascii);return same;
}
void THROW_ERR_INVALID_ARG_TYPE(Isolate* isolate,const char* text) {
  auto error=api::Error(isolate,JSEXN_TYPEERR,"ERR_INVALID_ARG_TYPE",text);
  if (!error.IsEmpty()) isolate->ThrowException(error);
}
void THROW_ERR_ENCODING_INVALID_ENCODED_DATA(Isolate* isolate,const char* format,const char* encoding) {
  int length=std::snprintf(nullptr,0,format,encoding);CHECK_GE(length,0);
  std::vector<char> text(size_t(length)+1);std::snprintf(text.data(),text.size(),format,encoding);
  auto error=api::Error(isolate,JSEXN_TYPEERR,"ERR_ENCODING_INVALID_ENCODED_DATA",text.data());
  if (!error.IsEmpty()) isolate->ThrowException(error);
}
Local<Value> ERR_STRING_TOO_LONG(Isolate* isolate) {
  const auto& metadata=kandelo_codec_metadata::StringTooLong;
  char text[128]; std::snprintf(text,sizeof(text),metadata.text,unsigned(String::kMaxLength));
  return Error(isolate,metadata.range?JSEXN_RANGEERR:JSEXN_ERR,metadata.code,text);
}
Local<Value> ERR_BUFFER_TOO_LARGE(Isolate* isolate) {
  const auto& metadata=kandelo_codec_metadata::BufferTooLarge;
  char text[128]; std::snprintf(text,sizeof(text),metadata.text,Buffer::kMaxLength);
  return Error(isolate,metadata.range?JSEXN_RANGEERR:JSEXN_ERR,metadata.code,text);
}
Local<Value> ERR_MEMORY_ALLOCATION_FAILED(Isolate* isolate) {
  const auto& metadata=kandelo_codec_metadata::AllocationFailed;
  return Error(isolate,metadata.range?JSEXN_RANGEERR:JSEXN_ERR,metadata.code,metadata.text);
}
namespace Buffer {
MaybeLocal<Object> MissingAllocation(Environment* env) {
  auto error=api::Error(env->isolate(),JSEXN_ERR,"ERR_KANDELO_NOT_IMPLEMENTED","Original Buffer allocation/prototype backend is not implemented");
  if (!error.IsEmpty()) env->isolate()->ThrowException(error);return {};
}
bool HasInstance(Local<Value> input) { return input->IsArrayBufferView(); }
bool HasInstance(Local<Object> input) { return HasInstance(Local<Value>(input)); }
char* Data(Local<Value> input) { CHECK(input->IsArrayBufferView()); return reinterpret_cast<char*>(Frame::current->Borrow(input).bytes); }
char* Data(Local<Object> input) { return Data(Local<Value>(input)); }
size_t Length(Local<Value> input) { CHECK(input->IsArrayBufferView()); return Frame::current->Borrow(input).size; }
size_t Length(Local<Object> input) { return Length(Local<Value>(input)); }
MaybeLocal<Object> Copy(Isolate*, const char*, size_t) { Crash("Original Buffer allocation/prototype backend is not implemented"); }
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
namespace {
bool ConverterConstructor(JSContext* cx,unsigned argc,JS::Value* vp) {
  auto args=JS::CallArgsFromVp(argc,vp);
  if (!args.isConstructing()) {
    JS::RootedObject receiver(cx,args.thisv().isNullOrUndefined()?JS::CurrentGlobalOrNull(cx):JS::ToObject(cx,args.thisv()));
    if (!receiver) return false;args.rval().setObject(*receiver);return true;
  }
  JS::RootedObject object(cx,JS_NewObjectForConstructor(cx,&native::converterClass,args));
  if (!object) return false;args.rval().setObject(*object);return true;
}
}
Local<FunctionTemplate> CreateConverterTemplate(Isolate* isolate,std::nullptr_t) {
  auto& f=Current(isolate);
  JS::RootedFunction function(f.cx,js::NewFunctionWithReserved(f.cx,ConverterConstructor,0,JSFUN_CONSTRUCTOR,""));if (!function) return {};
  JS::RootedObject object(f.cx,JS_GetFunctionObject(function));js::SetFunctionNativeReserved(object,0,JS::Int32Value(0));
  JS::RootedObject prototype(f.cx,JS_NewPlainObject(f.cx));
  if (!prototype || !JS_DefineProperty(f.cx,prototype,"constructor",object,0) ||
      !JS_DefineProperty(f.cx,object,"prototype",prototype,JSPROP_PERMANENT)) return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));return f.Own<FunctionTemplate>(value);
}
Local<ObjectTemplate> FunctionTemplate::InstanceTemplate() {
  auto& f=*Frame::current;JS::RootedValue value(f.cx,cell().value);return f.Own<ObjectTemplate>(value);
}
void FunctionTemplate::SetClassName(Local<String> name) {
  auto& f=*Frame::current;JS::RootedFunction function(f.cx,&cell().value.toObject().as<JSFunction>());
  JS::RootedString string(f.cx,name->cell().value.toString());
  JS::Rooted<JSAtom*> atom(f.cx,js::AtomizeString(f.cx,string));CHECK_NOT_NULL(atom);function->setAtom(atom);
}
void ObjectTemplate::SetInternalFieldCount(int count) {
  CHECK(count==native::BaseObject::kInternalFieldCount);
  if (Frame::current->domain==Domain::Trace) {
    SetTraceFieldCount(&cell().value.toObject(),count);
  } else js::SetFunctionNativeReserved(&cell().value.toObject(),0,JS::Int32Value(count));
}
MaybeLocal<Object> ObjectTemplate::NewInstance(Local<Context> context) {
  auto& f=Current(context->isolate);if (JS_IsExceptionPending(f.cx)) return {};
  JS::RootedObject constructor(f.cx,&cell().value.toObject());
  CHECK(js::GetFunctionNativeReserved(constructor,0).toInt32()==native::BaseObject::kInternalFieldCount);
  JS::RootedValue callable(f.cx,JS::ObjectValue(*constructor));JS::RootedObject object(f.cx);
  if (!JS::Construct(f.cx,callable,JS::HandleValueArray::empty(),&object)) return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));return f.Own<Object>(value);
}
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
std::shared_ptr<State> Data(JSContext* cx,JS::HandleObject runtime) {
  JS::RootedObject state(cx,kandelo::node::GetRuntimeCodecState(cx,runtime,true)); if (!state) return {};
  state=js::CheckedUnwrapDynamic(state,cx,false); if (!state) return {};
  MOZ_RELEASE_ASSERT(JS::GetClass(state)==&stateClass);
  return *static_cast<std::shared_ptr<State>*>(JS::GetReservedSlot(state,0).toPrivate());
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
  auto state=Data(cx,runtime); if (!state) return false; Frame frame(cx,realm,state,&args,callback->domain);
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
  FunctionCallbackInfo<Value> call(&state->isolate); callback->callback(call); return !JS_IsExceptionPending(cx);
}
}
}  // namespace kandelo_node_codec_api

namespace kandelo_node_codec_impl {
Local<FunctionTemplate> NewFunctionTemplate(Isolate* isolate,std::nullptr_t empty) {
  return api::CreateConverterTemplate(isolate,empty);
}
void SetMethod(Local<Context> context,Local<Object> target,const char* name,void(*callback)(const FunctionCallbackInfo<Value>&)) {
  auto& f=Current(context->isolate);
  if (f.domain==Domain::Trace) {
    JS::RootedFunction function(f.cx,api::TraceFunction(f,"",callback,0,false,false));CHECK_NOT_NULL(function);
    JS::RootedObject targetObject(f.cx,&target->cell().value.toObject());
    JS::RootedValue value(f.cx,JS::ObjectValue(*JS_GetFunctionObject(function)));
    CHECK(JS_SetProperty(f.cx,targetObject,name,value));
    JS::Rooted<JSAtom*> atom(f.cx,js::Atomize(f.cx,name,std::strlen(name)));CHECK(atom);function->setAtom(atom);return;
  }
  bool ownProperties=f.domain==Domain::Icu;
  JS::RootedFunction function(f.cx,js::NewFunctionWithReserved(f.cx,api::Invoke,0,0,ownProperties?name:"")); CHECK_NOT_NULL(function);
  JS::RootedObject object(f.cx,JS_GetFunctionObject(function)),binding(f.cx,&target->cell().value.toObject());
  // Each actual function owns its typed callback metadata. No process-global
  // mutable callback table can race between independently created runtimes.
  JS::RootedObject closure(f.cx,JS_NewObject(f.cx,&api::callbackClass)); CHECK_NOT_NULL(closure);
  JS::SetReservedSlot(closure,0,JS::PrivateValue(new api::CallbackOwner{callback,f.domain}));
  JS::SetReservedSlot(closure,1,JS::ObjectValue(*binding));
  js::SetFunctionNativeReserved(object,0,JS::ObjectValue(*f.realm));
  js::SetFunctionNativeReserved(object,1,JS::ObjectValue(*closure));
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));
  if (ownProperties) { CHECK(JS_DefineProperty(f.cx,binding,name,value,JSPROP_ENUMERATE));return; }
  CHECK(JS_SetProperty(f.cx,binding,name,value));
  CHECK(!function->hasResolvedName());
  JS::Rooted<JSAtom*> atom(f.cx,js::Atomize(f.cx,name,std::strlen(name))); CHECK_NOT_NULL(atom); function->setAtom(atom);
}
void SetMethod(Isolate* isolate,Local<ObjectTemplate> target,const char* name,void(*callback)(const FunctionCallbackInfo<Value>&)) {
  SetMethod(isolate->GetCurrentContext(),Local<Object>(target),name,callback);
}
}
namespace kandelo::node {
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
JSObject* CreateStringDecoderBinding(JSContext* cx,JS::HandleObject realm) {
  JS::RootedObject runtime(cx,GetRealmRuntime(cx,realm)); if (!runtime) return nullptr;
  auto state=api::Data(cx,runtime); if (!state) return nullptr; api::Frame frame(cx,realm,state);
  JS::RootedObject object(cx,JS_NewPlainObject(cx)); if (!object) return nullptr;
  JS::RootedValue value(cx,JS::ObjectValue(*object)),unused(cx,JS::UndefinedValue());
  kandelo_codec_adapter::initializer(frame.Own<api::Object>(value),frame.OwnValue(unused),state->isolate.GetCurrentContext(),nullptr);
  if (JS_IsExceptionPending(cx)) return nullptr; return object;
}
JSObject* CreateIcuBinding(JSContext* cx,JS::HandleObject realm) {
  JS::RootedObject runtime(cx,GetRealmRuntime(cx,realm));if (!runtime) return nullptr;
  auto state=api::Data(cx,runtime);if (!state) return nullptr;api::Frame frame(cx,realm,state,nullptr,api::Domain::Icu);
  JS::RootedObject object(cx,JS_NewObject(cx,&api::icuBindingClass));if (!object) return nullptr;frame.binding=object;
  JS::RootedValue value(cx,JS::ObjectValue(*object)),unused(cx,JS::UndefinedValue());
  native::IsolateData data;
  kandelo_icu_adapter::initializer(&data,frame.Own<api::ObjectTemplate>(value));
  if (JS_IsExceptionPending(cx)) return nullptr;
  kandelo_icu_adapter::context_initializer(frame.Own<api::Object>(value),frame.OwnValue(unused),state->isolate.GetCurrentContext(),nullptr);
  if (JS_IsExceptionPending(cx)) return nullptr;return object;
}
JSObject* InspectCodecState(JSContext* cx,JS::HandleObject runtime) {
  auto state=api::Data(cx,runtime); if (!state) return nullptr;
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
  auto state=api::Data(cx,runtime); if (!state) return false; state->stressGc=enabled; return true;
}
}

#include "shell/node-upstream/trace-codecs-inl.h"
