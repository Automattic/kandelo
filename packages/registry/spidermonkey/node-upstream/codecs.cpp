#include "shell/node-upstream/codecs.h"

#include "mozilla/Assertions.h"

#include <atomic>
#include <cstdio>
#include <tuple>
#include <utility>
#include <vector>

#include "jsapi.h"
#include "jsfriendapi.h"

#include "js/Array.h"
#include "js/CallArgs.h"
#include "js/CharacterEncoding.h"
#include "js/Conversions.h"
#include "js/ErrorReport.h"
#include "js/experimental/TypedData.h"
#include "js/GCAPI.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/Stack.h"
#include "js/String.h"
#include "js/Wrapper.h"
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
#include "vm/ArrayBufferObject.h"
#include "vm/JSAtomUtils.h"
#include "vm/JSFunction.h"
#include "vm/StringType.h"

namespace api = kandelo_node_codec_api;
namespace native = kandelo_node_codec_impl;
namespace kandelo_node_codec_api {
struct State {
  Isolate isolate;
  std::atomic<size_t> externalBytes{0}, created{0}, released{0}, spans{0}, collections{0};
  bool stressGc=false;
};
struct Cell {
  JS::PersistentRootedValue value;
  Cell(JSContext* cx, JS::HandleValue input) : value(cx, input) {}
};
struct Frame {
  JSContext* cx;
  JS::RootedObject realm;
  std::shared_ptr<State> state;
  JS::CallArgs* arguments;
  std::vector<std::unique_ptr<Value>> roots;
  std::vector<std::unique_ptr<native::SpanOwner>> spans;
  native::Environment environment;
  Frame* previous;
  inline static thread_local Frame* current = nullptr;
  Frame(JSContext* cx, JS::HandleObject realm, std::shared_ptr<State> state,
        JS::CallArgs* arguments = nullptr)
      : cx(cx), realm(cx, realm), state(std::move(state)), arguments(arguments),
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
Value::Value(std::unique_ptr<Cell> cell) : cell_(std::move(cell)) {}
Value::~Value() = default;
Cell& Value::cell() const { return *cell_; }
bool Value::IsString() const { return cell().value.isString(); }
bool Value::IsArrayBufferView() const {
  return UnwrapView(Frame::current->cx, cell().value) != nullptr;
}
Local<Value> Frame::OwnValue(JS::HandleValue value) {
  // Source Local::As must refer to the actual C++ wrapper type as well as the
  // actual engine value. A string-tagged base object is not a String object.
  if (value.isString()) return Own<String>(value);
  if (UnwrapView(cx, value)) return Own<ArrayBufferView>(value);
  if (value.isObject()) return Own<Object>(value);
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
    { JSAutoRealm home(frame.cx, input);
      bool shared=false;
      JS::RootedObject buffer(frame.cx,JS_GetArrayBufferViewBuffer(frame.cx,input,&shared)); CHECK_NOT_NULL(buffer);
      buffer=js::CheckedUnwrapDynamic(buffer,frame.cx,false); CHECK_NOT_NULL(buffer);
      // ensureNonInline rejects an already pinned buffer, including a second
      // view of our state allocation. Its existing out-of-line storage is
      // already stable: materialize only when the real backing remains inline.
      if (!shared && buffer->as<js::ArrayBufferObject>().isInlineData() &&
          !JS::EnsureNonInlineArrayBufferOrView(frame.cx,input))
        Crash("Native codec backing allocation stabilization failed");
      pinned=JS::PinArrayBufferOrViewLength(input, true);
    }
    size=JS_GetArrayBufferViewByteLength(object);
    bool shared=false; JS::AutoCheckCannotGC nogc;
    bytes=static_cast<uint8_t*>(JS_GetArrayBufferViewData(object, &shared, nogc));
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
  if (length<=capacity_) return;
  CHECK_LE(length,std::numeric_limits<size_t>::max()/sizeof(T));
  auto* data=static_cast<T*>(std::malloc(length*sizeof(T))); CHECK_NOT_NULL(data);
  std::memcpy(data,data_,length_*sizeof(T)); if (data_!=stack_) std::free(data_);
  data_=data; capacity_=length;
}
template<class T,size_t N> bool MaybeStackBuffer<T,N>::IsAllocated() const { return data_!=stack_; }
template<class T,size_t N> void MaybeStackBuffer<T,N>::Release() { CHECK(data_!=stack_); data_=stack_; length_=0; capacity_=N; }
template class MaybeStackBuffer<char,512>;
template class MaybeStackBuffer<char,4096>;
template class MaybeStackBuffer<char16_t,1024>;
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
Environment* Environment::GetCurrent(Local<Context> context) { return &Current(context->isolate).environment; }
Isolate* Environment::isolate() { return &Frame::current->state->isolate; }
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
Frame::~Frame() { current=previous; }
native::SpanOwner& Frame::Borrow(Local<Value> input) {
  JS::RootedObject object(cx, UnwrapView(cx, Input(input))); CHECK_NOT_NULL(object);
  for (auto& span:spans) if (span->object==object) return *span;
  spans.push_back(std::make_unique<native::SpanOwner>(*this, object)); return *spans.back();
}
namespace {
using Callback=void(*)(const FunctionCallbackInfo<Value>&);
struct CallbackOwner { Callback callback; };
void FinalizeCallback(JS::GCContext*,JSObject* object) {
  auto value=JS::GetReservedSlot(object,0); if (!value.isUndefined()) delete static_cast<CallbackOwner*>(value.toPrivate());
}
const JSClassOps callbackOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeCallback};
const JSClass callbackClass={"NodeCodecCallback",JSCLASS_HAS_RESERVED_SLOTS(1)|JSCLASS_FOREGROUND_FINALIZE,&callbackOps};
void Finalize(JS::GCContext*,JSObject* object) {
  auto value=JS::GetReservedSlot(object,0); if (!value.isUndefined()) delete static_cast<std::shared_ptr<State>*>(value.toPrivate());
}
const JSClassOps stateOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,Finalize};
const JSClass stateClass={"NodeCodecState",JSCLASS_HAS_RESERVED_SLOTS(1)|JSCLASS_FOREGROUND_FINALIZE,&stateOps};
std::shared_ptr<State> Data(JSContext* cx,JS::HandleObject runtime) {
  JS::RootedObject state(cx,kandelo::node::GetRuntimeCodecState(cx,runtime,true)); if (!state) return {};
  state=js::CheckedUnwrapDynamic(state,cx,false); if (!state) return {};
  MOZ_RELEASE_ASSERT(JS::GetClass(state)==&stateClass);
  return *static_cast<std::shared_ptr<State>*>(JS::GetReservedSlot(state,0).toPrivate());
}
bool Invoke(JSContext* cx,unsigned argc,JS::Value* vp) {
  auto args=JS::CallArgsFromVp(argc,vp); JS::RootedObject realm(cx,&js::GetFunctionNativeReserved(&args.callee(),0).toObject());
  if (!kandelo::node::CheckRealmLibraryActive(cx,realm)) return false;
  JS::RootedObject runtime(cx,kandelo::node::GetRealmRuntime(cx,realm)); if (!runtime) return false;
  auto state=Data(cx,runtime); if (!state) return false; Frame frame(cx,realm,state,&args);
  auto input=Argument(&state->isolate,0); CHECK(input->IsArrayBufferView());
  auto& span=frame.Borrow(input);
  // The private source assumes its complete native state allocation. Guard
  // that trust boundary before handing its real writable bytes to the source.
  CHECK(span.size>=sizeof(native::StringDecoder));
  CHECK(span.bytes[native::StringDecoder::kBufferedBytes]+span.bytes[native::StringDecoder::kMissingBytes]<=native::StringDecoder::kIncompleteCharactersEnd);
  JS::RootedObject closure(cx,&js::GetFunctionNativeReserved(&args.callee(),1).toObject()); CHECK(JS::GetClass(closure)==&callbackClass);
  auto* callback=static_cast<CallbackOwner*>(JS::GetReservedSlot(closure,0).toPrivate());
  FunctionCallbackInfo<Value> call(&state->isolate); callback->callback(call); return !JS_IsExceptionPending(cx);
}
}
}  // namespace kandelo_node_codec_api

namespace kandelo_node_codec_impl {
void SetMethod(Local<Context> context,Local<Object> target,const char* name,void(*callback)(const FunctionCallbackInfo<Value>&)) {
  auto& f=Current(context->isolate);
  JS::RootedFunction function(f.cx,js::NewFunctionWithReserved(f.cx,api::Invoke,0,0,"")); CHECK_NOT_NULL(function);
  JS::RootedObject object(f.cx,JS_GetFunctionObject(function)),binding(f.cx,&target->cell().value.toObject());
  // Each actual function owns its typed callback metadata. No process-global
  // mutable callback table can race between independently created runtimes.
  JS::RootedObject closure(f.cx,JS_NewObject(f.cx,&api::callbackClass)); CHECK_NOT_NULL(closure);
  JS::SetReservedSlot(closure,0,JS::PrivateValue(new api::CallbackOwner{callback}));
  js::SetFunctionNativeReserved(object,0,JS::ObjectValue(*f.realm));
  js::SetFunctionNativeReserved(object,1,JS::ObjectValue(*closure));
  JS::RootedValue value(f.cx,JS::ObjectValue(*object)); CHECK(JS_SetProperty(f.cx,binding,name,value));
  CHECK(!function->hasResolvedName());
  JS::Rooted<JSAtom*> atom(f.cx,js::Atomize(f.cx,name,std::strlen(name))); CHECK_NOT_NULL(atom); function->setAtom(atom);
}
}
namespace kandelo::node {
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
JSObject* InspectCodecState(JSContext* cx,JS::HandleObject runtime) {
  auto state=api::Data(cx,runtime); if (!state) return nullptr;
  JS::RootedObject object(cx,JS_NewPlainObject(cx)); if (!object) return nullptr;
  for (const auto& item:std::initializer_list<std::pair<const char*,size_t>>{
      {"externalBytes",state->externalBytes.load()},{"created",state->created.load()},
      {"released",state->released.load()},{"spans",state->spans.load()},{"collections",state->collections.load()}}) {
    JS::RootedValue value(cx,JS::DoubleValue(double(item.second)));
    if (!JS_DefineProperty(cx,object,item.first,value,JSPROP_ENUMERATE)) return nullptr;
  }
  return object;
}
bool SetCodecGcStress(JSContext* cx,JS::HandleObject runtime,bool enabled) {
  auto state=api::Data(cx,runtime); if (!state) return false; state->stressGc=enabled; return true;
}
}
