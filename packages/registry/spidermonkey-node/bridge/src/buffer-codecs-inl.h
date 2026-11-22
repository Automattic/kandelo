#ifndef KANDELO_NODE_BUFFER_CODECS_INL_H
#define KANDELO_NODE_BUFFER_CODECS_INL_H
// Native VM operations used by the complete original Buffer source. No Buffer
// encoding, search, fill, mask, swap or public module algorithms live here.
namespace v8 {
bool SameLocal(Data* left,Data* right) {
  if(!left||!right)return left==right;
  // A Context retains its global, but it is a distinct native Data kind from
  // the JavaScript object returned by Context::Global().
  if(left->IsContext()||right->IsContext())
    return left->IsContext()&&right->IsContext()&&SameLocal(static_cast<Context*>(left),static_cast<Context*>(right));
  CHECK(Frame::current);auto& frame=*Frame::current;
  CHECK(left->cell().context==frame.cx&&right->cell().context==frame.cx);
  JS::RootedValue a(frame.cx,left->cell().value),b(frame.cx,right->cell().value);
  // ESR153 unique symbols and objects may be wrapped across zones. Compare
  // their representations in one actual realm, as Value::SameValue does.
  JS::RootedObject global(frame.cx,NativePrimitiveRealm(frame));CHECK(global);
  JSAutoRealm home(frame.cx,global);bool same;
  CHECK(JS_WrapValue(frame.cx,&a)&&JS_WrapValue(frame.cx,&b)&&JS::SameValue(frame.cx,a,b,&same));return same;
}
bool Value::IsObject() const { return cell().value.isObject()&&!IsExternal(); }
bool Value::IsFalse()const{return cell().value.isBoolean()&&!cell().value.toBoolean();}
bool Value::BooleanValue(Isolate* isolate)const {
  auto& frame=Current(isolate);CHECK(cell().context==frame.cx);
  return JS::ToBoolean(cell().value);
}
namespace {
JSObject* NativeTemplateRealm(Frame&);
JSObject* NativePrimitiveRealm(Frame& frame){
  // Node creates primitive handles while building isolate templates, before
  // entering an application Context. ESR153 primitive cells need a real zone.
  // Reuse the traced private template realm only for the allocation operation;
  // do not introduce an application Context or change Node's call order.
  if(auto* global=JS::CurrentGlobalOrNull(frame.cx))return global;
  return NativeTemplateRealm(frame);
}
bool NativeSymbolDescription(Frame& frame,Local<String> description,JS::MutableHandleString text){
  if(description.IsEmpty()){text.set(nullptr);return true;}
  // A contextless V8 handle can carry a string from an application zone.
  // Copy/wrap that string into the allocation realm before the engine checks
  // its zone; the input handle and JavaScript value remain unchanged.
  JS::RootedValue value(frame.cx,Input(description));
  if(!JS_WrapValue(frame.cx,&value))return false;
  text.set(value.toString());return true;
}
void CheckNativePrimitiveAccess(Frame& frame){
  frame.state->AssertForeground();
  CHECK(frame.cx==js::TlsContext.get()&&!JS::RuntimeHeapIsCollecting());
}
bool NativeValueEquality(const Value& left,Local<Value> right,bool sameValue){
  CHECK(Frame::current&&!right.IsEmpty());auto& frame=*Frame::current;
  CHECK(left.cell().context==frame.cx&&right->cell().context==frame.cx);
  JS::RootedValue a(frame.cx,left.cell().value),b(frame.cx,Input(right));
  CHECK(JS_WrapValue(frame.cx,&a)&&JS_WrapValue(frame.cx,&b));bool result;
  CHECK(sameValue?JS::SameValue(frame.cx,a,b,&result):JS::StrictlyEqual(frame.cx,a,b,&result));
  return result;
}
}
bool Value::SameValue(Local<Value> other)const{return NativeValueEquality(*this,other,true);}
bool Value::StrictEquals(Local<Value> other)const{return NativeValueEquality(*this,other,false);}
bool Value::IsNativeError() const {
  auto* object=UnwrapObject(Frame::current->cx,cell().value);return object&&object->is<js::ErrorObject>();
}
Local<Value> Private::Name()const {
  auto& frame=*Frame::current;JS::RootedValue key(frame.cx,cell().value);CHECK(key.isSymbol());
  JS::RootedSymbol symbol(frame.cx,key.toSymbol());CHECK(JS::GetSymbolCode(symbol)==JS::SymbolCode::EmbeddingPrivateSymbol);
  JS::RootedString description(frame.cx,JS::GetSymbolDescription(frame.cx,symbol));
  JS::RootedValue value(frame.cx,description?JS::StringValue(description):JS::UndefinedValue());return frame.OwnValue(value);
}
Local<Value> Symbol::Description(Isolate* isolate)const {
  auto& frame=Current(isolate);CHECK(cell().context==frame.cx&&IsSymbol());
  JS::RootedSymbol symbol(frame.cx,cell().value.toSymbol());
  JS::RootedString description(frame.cx,JS::GetSymbolDescription(frame.cx,symbol));
  JS::RootedValue value(frame.cx,description?JS::StringValue(description):JS::UndefinedValue());
  return frame.OwnValue(value);
}
Local<Symbol> Symbol::New(Isolate* isolate,Local<String> description){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);
  JS::RootedObject global(frame.cx,NativePrimitiveRealm(frame));if(!global)return {};
  JSAutoRealm home(frame.cx,global);
  JS::RootedString text(frame.cx);if(!NativeSymbolDescription(frame,description,&text))return {};
  JS::RootedSymbol symbol(frame.cx,JS::NewSymbol(frame.cx,text));if(!symbol)return {};
  JS::RootedValue value(frame.cx,JS::SymbolValue(symbol));return frame.Own<Symbol>(value);
}
Local<Symbol> Symbol::For(Isolate* isolate,Local<String> description){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);
  JS::RootedObject global(frame.cx,NativePrimitiveRealm(frame));if(!global)return {};
  JSAutoRealm home(frame.cx,global);
  CHECK(!description.IsEmpty());JS::RootedString text(frame.cx);if(!NativeSymbolDescription(frame,description,&text))return {};
  JS::RootedSymbol symbol(frame.cx,JS::GetSymbolFor(frame.cx,text));if(!symbol)return {};
  JS::RootedValue value(frame.cx,JS::SymbolValue(symbol));return frame.Own<Symbol>(value);
}
Local<Private> Private::New(Isolate* isolate,Local<String> description){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);
  JS::RootedObject global(frame.cx,NativePrimitiveRealm(frame));if(!global)return {};
  JSAutoRealm home(frame.cx,global);
  JS::RootedString text(frame.cx);if(!NativeSymbolDescription(frame,description,&text))return {};
  JS::RootedSymbol symbol(frame.cx,JS::NewEmbeddingPrivateSymbol(frame.cx,text));if(!symbol)return {};
  JS::RootedValue value(frame.cx,JS::SymbolValue(symbol));return frame.Own<Private>(value);
}
namespace {
template<class T> Local<T> NativeApiSymbol(Isolate* isolate,Local<String> description,
    std::map<std::u16string,std::unique_ptr<Data>>& registry){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);
  CHECK(!description.IsEmpty());JS::RootedString text(frame.cx,Input(description).toString());
  try {
  std::u16string key(JS_GetStringLength(text),u'\0');
  if(!JS_CopyStringChars(frame.cx,mozilla::Range<char16_t>(key.data(),key.size()),text))return {};
  auto found=registry.find(key);
  if(found!=registry.end())return Local<T>(static_cast<T*>(found->second.get()));
  Local<T> value=T::New(isolate,description);if(value.IsEmpty())return {};
  auto root=RetainRoot(isolate,value);auto* result=static_cast<T*>(root.get());
  registry.emplace(std::move(key),std::move(root));return Local<T>(result);
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(frame.cx);return {};}
}
Local<Symbol> NativeWellKnownSymbol(Isolate* isolate,JS::SymbolCode code){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);
  JS::RootedSymbol symbol(frame.cx,JS::GetWellKnownSymbol(frame.cx,code));
  JS::RootedValue value(frame.cx,JS::SymbolValue(symbol));return frame.Own<Symbol>(value);
}
}
Local<Symbol> Symbol::ForApi(Isolate* isolate,Local<String> description){
  return NativeApiSymbol<Symbol>(isolate,description,Current(isolate).state->apiSymbols);
}
Local<Private> Private::ForApi(Isolate* isolate,Local<String> description){
  return NativeApiSymbol<Private>(isolate,description,Current(isolate).state->apiPrivateNames);
}
#define KANDELO_WELL_KNOWN_SYMBOL(Name,code) \
Local<Symbol> Symbol::Get##Name(Isolate* isolate){return NativeWellKnownSymbol(isolate,JS::SymbolCode::code);}
KANDELO_WELL_KNOWN_SYMBOL(AsyncIterator,asyncIterator)
KANDELO_WELL_KNOWN_SYMBOL(HasInstance,hasInstance)
KANDELO_WELL_KNOWN_SYMBOL(IsConcatSpreadable,isConcatSpreadable)
KANDELO_WELL_KNOWN_SYMBOL(Iterator,iterator)
KANDELO_WELL_KNOWN_SYMBOL(Match,match)
KANDELO_WELL_KNOWN_SYMBOL(Replace,replace)
KANDELO_WELL_KNOWN_SYMBOL(Search,search)
KANDELO_WELL_KNOWN_SYMBOL(Split,split)
KANDELO_WELL_KNOWN_SYMBOL(ToPrimitive,toPrimitive)
KANDELO_WELL_KNOWN_SYMBOL(ToStringTag,toStringTag)
KANDELO_WELL_KNOWN_SYMBOL(Unscopables,unscopables)
KANDELO_WELL_KNOWN_SYMBOL(Dispose,dispose)
KANDELO_WELL_KNOWN_SYMBOL(AsyncDispose,asyncDispose)
#undef KANDELO_WELL_KNOWN_SYMBOL
bool Value::IsTypedArray() const { auto* object=UnwrapObject(Frame::current->cx,cell().value);return object && JS_IsTypedArrayObject(object); }
static int64_t IntegerNumber(double number) {
  if(std::isnan(number))return 0;
  if(number>=double(INT64_MAX))return INT64_MAX;
  if(number<=double(INT64_MIN))return INT64_MIN;
  return int64_t(number);
}
Maybe<int64_t> Value::IntegerValue(Local<Context> context) {
  auto& frame=Current(context->isolate);NativeEntry nativeEntry(frame,context);if(nativeEntry.Terminated())return {};Context::Scope home(context);double number;
  JS::RootedValue input(frame.cx,cell().value);
  if(!JS_WrapValue(frame.cx,&input)||!JS::ToNumber(frame.cx,input,&number))return {};
  return Just(IntegerNumber(number));
}
Local<Number> Number::New(Isolate* isolate,double number) {
  auto& frame=Current(isolate);JS::RootedValue value(frame.cx,JS::DoubleValue(number));return frame.OwnValue(value).As<Number>();
}
double Number::Value() const { CHECK(IsNumber());return cell().value.toNumber(); }
Local<BigInt> BigInt::New(Isolate* isolate,int64_t input){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);
  JS::RootedObject global(frame.cx,NativePrimitiveRealm(frame));if(!global)return {};
  JSAutoRealm home(frame.cx,global);
  JS::Rooted<JS::BigInt*> number(frame.cx,JS::NumberToBigInt(frame.cx,input));if(!number)return {};
  JS::RootedValue value(frame.cx,JS::BigIntValue(number));return frame.Own<BigInt>(value);
}
Local<BigInt> BigInt::NewFromUnsigned(Isolate* isolate,uint64_t input){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);
  JS::RootedObject global(frame.cx,NativePrimitiveRealm(frame));if(!global)return {};
  JSAutoRealm home(frame.cx,global);
  JS::Rooted<JS::BigInt*> number(frame.cx,JS::NumberToBigInt(frame.cx,input));if(!number)return {};
  JS::RootedValue value(frame.cx,JS::BigIntValue(number));return frame.Own<BigInt>(value);
}
int64_t BigInt::Int64Value(bool* lossless)const {
  CHECK(IsBigInt());const auto* value=cell().value.toBigInt();
  int64_t exact;if(lossless)*lossless=JS::BigIntFits(value,&exact);
  return JS::ToBigInt64(value);
}
uint64_t BigInt::Uint64Value(bool* lossless)const {
  CHECK(IsBigInt());const auto* value=cell().value.toBigInt();
  uint64_t exact;if(lossless)*lossless=JS::BigIntFits(value,&exact);
  return JS::ToBigUint64(value);
}
int BigInt::WordCount()const {
  CHECK(IsBigInt());constexpr size_t perWord=sizeof(uint64_t)/sizeof(JS::BigInt::Digit);
  static_assert(perWord==1||perWord==2);
  return int((cell().value.toBigInt()->digitLength()+perWord-1)/perWord);
}
void BigInt::ToWordsArray(int* sign,int* count,uint64_t* words)const {
  CHECK(IsBigInt()&&sign&&count&&*count>=0);const auto* value=cell().value.toBigInt();
  const size_t available=std::min(size_t(*count),size_t(WordCount()));
  CHECK(words||!available);*sign=value->isNegative()?1:0;*count=WordCount();
  // Translate the engine's native-width magnitude digits. No arithmetic,
  // coercion or JavaScript call is needed, and no GC can move this span.
  const auto digits=value->digits();
  for(size_t i=0;i<available;++i){
    if constexpr(sizeof(JS::BigInt::Digit)==sizeof(uint64_t))words[i]=digits[i];
    else {const size_t lo=i*2;words[i]=uint64_t(digits[lo]);if(lo+1<digits.size())words[i]|=uint64_t(digits[lo+1])<<32;}
  }
}
MaybeLocal<BigInt> BigInt::NewFromWords(Local<Context> context,int sign,int count,const uint64_t* words){
  auto& frame=Current(context->isolate);CheckNativePrimitiveAccess(frame);
  Context::Scope home(context);
  if(count<0){JS_ReportErrorNumberASCII(frame.cx,js::GetErrorMessage,nullptr,JSMSG_BIGINT_TOO_LARGE);return {};}
  CHECK(words||!count);
  constexpr size_t perWord=sizeof(uint64_t)/sizeof(JS::BigInt::Digit);
  static_assert(perWord==1||perWord==2);
  while(count&&words[count-1]==0)--count;
  size_t length=size_t(count)*perWord;
  if constexpr(perWord==2){if(count&&!(words[count-1]>>32))--length;}
  // createUninitialized owns SpiderMonkey's size/admission check; do not
  // duplicate its private allocation limit in the shared source bridge.
  JS::Rooted<JS::BigInt*> number(frame.cx,JS::BigInt::createUninitialized(frame.cx,length,length&&sign!=0));
  if(!number)return {};
  {
    auto digits=number->digits();
    for(size_t i=0;i<length;++i){
      if constexpr(perWord==1)digits[i]=JS::BigInt::Digit(words[i]);
      else digits[i]=JS::BigInt::Digit(words[i/2]>>((i%2)*32));
    }
  }
  JS::RootedValue value(frame.cx,JS::BigIntValue(number));return frame.Own<BigInt>(value);
}
Local<Value> HandleScope::EscapeRoot(Local<Value> input) {
  CheckEscape();
  CHECK(!input.IsEmpty());JS::RootedValue value(frame_->cx,Input(input));
  auto output=frame_->OwnValue(value);auto owned=std::move(frame_->roots.back());frame_->roots.pop_back();
  frame_->roots.insert(frame_->roots.begin()+previous_,std::move(owned));++previous_;
  return output;
}
Local<Data> HandleScope::EscapeRoot(Local<Data> input) {
  CheckEscape();
  CHECK(!input.IsEmpty());JS::RootedValue value(frame_->cx,Input(input));
  auto output=frame_->OwnClone(*input.get(),value);auto owned=std::move(frame_->roots.back());frame_->roots.pop_back();
  frame_->roots.insert(frame_->roots.begin()+previous_,std::move(owned));++previous_;
  return output;
}
Local<Context> HandleScope::EscapeRoot(Local<Context> input) {
  CheckEscape();
  CHECK(!input.IsEmpty());JS::RootedObject global(frame_->cx,&input->cell().value.toObject());
  auto output=frame_->OwnContext(global);auto owned=std::move(frame_->contexts.back());frame_->contexts.pop_back();
  frame_->contexts.insert(frame_->contexts.begin()+previousContexts_,std::move(owned));++previousContexts_;
  return output;
}
Maybe<bool> Object::SetPrivate(Local<Context> context,Local<Private> property,Local<Value> input) {
  auto& frame=Current(context->isolate);NativeEntry nativeEntry(frame,context);if(nativeEntry.Terminated())return {};Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedValue key(frame.cx,Input(property)),value(frame.cx,Input(input));CHECK(key.isSymbol());
  JS::RootedSymbol symbol(frame.cx,key.toSymbol());
  CHECK(JS::GetSymbolCode(symbol)==JS::SymbolCode::EmbeddingPrivateSymbol);
  JS::RootedId id(frame.cx,JS::PropertyKey::Symbol(key.toSymbol()));
  if(!JS_WrapObject(frame.cx,&object)||!JS_WrapValue(frame.cx,&value)||!JS_DefinePropertyById(frame.cx,object,id,value,0))return {};return Just(true);
}
MaybeLocal<Value> Object::GetPrivate(Local<Context> context,Local<Private> property) {
  auto& frame=Current(context->isolate);NativeEntry nativeEntry(frame,context);if(nativeEntry.Terminated())return {};Context::Scope home(context);
  JS::RootedObject object(frame.cx,&cell().value.toObject());JS::RootedValue key(frame.cx,Input(property)),value(frame.cx);
  CHECK(key.isSymbol());JS::RootedSymbol symbol(frame.cx,key.toSymbol());CHECK(JS::GetSymbolCode(symbol)==JS::SymbolCode::EmbeddingPrivateSymbol);
  JS::RootedId id(frame.cx,JS::PropertyKey::Symbol(symbol));
  if(!JS_WrapObject(frame.cx,&object)||!JS_GetPropertyById(frame.cx,object,id,&value))return {};
  return frame.OwnValue(value);
}
size_t ArrayBuffer::ByteLength() const {
  auto& frame=*Frame::current;JS::RootedObject buffer(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(buffer);
  return JS::IsSharedArrayBufferObject(buffer)?JS::GetSharedArrayBufferByteLength(buffer):JS::GetArrayBufferByteLength(buffer);
}
void* ArrayBuffer::Data() {
  auto& frame=*Frame::current;JS::RootedObject buffer(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(buffer);
  JSAutoRealm home(frame.cx,buffer);
  if(!JS::IsSharedArrayBufferObject(buffer)) {
    auto& raw=buffer->as<js::ArrayBufferObject>();if(raw.isDetached())return nullptr;
    auto owner=js::ArrayBufferObject::retainKandeloContents(frame.cx,buffer.as<js::ArrayBufferObject>());
    if(!owner)Crash("Native backing owner acquisition failed");frame.storage.push_back(std::move(owner));
  }
  JS::AutoCheckCannotGC nogc;bool shared=false;
  return JS::IsSharedArrayBufferObject(buffer)?JS::GetSharedArrayBufferData(buffer,&shared,nogc):JS::GetArrayBufferData(buffer,&shared,nogc);
}
bool ArrayBuffer::WasDetached() const {
  auto& frame=*Frame::current;JS::RootedObject buffer(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(buffer);
  return !JS::IsSharedArrayBufferObject(buffer) && buffer->as<js::ArrayBufferObject>().isDetached();
}
bool ArrayBuffer::IsDetachable() const {
  auto& frame=*Frame::current;JS::RootedObject buffer(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(buffer);
  if(JS::IsSharedArrayBufferObject(buffer))return false;
  auto& raw=buffer->as<js::ArrayBufferObject>();return !raw.isWasm() && !raw.isPreparedForAsmJS();
}
bool ArrayBuffer::IsImmutable() const {
  auto& frame=*Frame::current;JS::RootedObject buffer(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(buffer);
  return !JS::IsSharedArrayBufferObject(buffer)&&buffer->as<js::ArrayBufferObject>().isImmutable();
}
Maybe<bool> ArrayBuffer::Detach(Local<Value> key) {
  auto& frame=*Frame::current;JS::RootedObject buffer(frame.cx,&cell().value.toObject());
  JS::RootedValue value(frame.cx,key.IsEmpty()?JS::UndefinedValue():Input(key).get());
  if(!kandelo::node::DetachBufferWithKey(frame.cx,buffer,value))return {};return Just(true);
}
void ArrayBuffer::SetDetachKey(Local<Value> key) {
  auto& frame=*Frame::current;JS::RootedObject buffer(frame.cx,&cell().value.toObject());JS::RootedValue value(frame.cx,Input(key));
  CHECK(kandelo::node::SetBufferDetachKey(frame.cx,buffer,value));
}
Local<ArrayBuffer> ArrayBufferView::Buffer() {
  auto& frame=*Frame::current;JS::RootedObject view(frame.cx,UnwrapView(frame.cx,cell().value));CHECK(view);
  JS::RootedObject buffer(frame.cx);bool shared;
  {JSAutoRealm home(frame.cx,view);buffer=JS_GetArrayBufferViewBuffer(frame.cx,view,&shared);}
  if(!buffer||!JS_WrapObject(frame.cx,&buffer))return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*buffer));return frame.OwnValue(value).As<ArrayBuffer>();
}
size_t ArrayBufferView::ByteOffset() const { return JS_GetArrayBufferViewByteOffset(UnwrapView(Frame::current->cx,cell().value)); }
size_t ArrayBufferView::ByteLength() const { return JS_GetArrayBufferViewByteLength(UnwrapView(Frame::current->cx,cell().value)); }
bool ArrayBufferView::HasBuffer() const {
  auto& frame=*Frame::current;JS::RootedObject view(frame.cx,UnwrapView(frame.cx,cell().value));CHECK(view);
  return view->as<js::ArrayBufferViewObject>().hasBuffer();
}
size_t ArrayBufferView::CopyContents(void* destination,size_t capacity) {
  auto& frame=*Frame::current;JS::RootedObject view(frame.cx,UnwrapView(frame.cx,cell().value));CHECK(view);
  // Copy under a no-GC guard so inline typed-array storage need not be
  // materialized or pinned. Shared bytes require the engine's racy copy.
  JS::AutoCheckCannotGC nogc;bool shared;
  size_t count=std::min(capacity,JS_GetArrayBufferViewByteLength(view));
  if(!count)return 0;CHECK(destination);
  auto* source=static_cast<uint8_t*>(JS_GetArrayBufferViewData(view,&shared,nogc));CHECK(source);
  if(shared)js::jit::AtomicOperations::memcpySafeWhenRacy(SharedMem<uint8_t*>::unshared(static_cast<uint8_t*>(destination)),SharedMem<uint8_t*>::shared(source),count);
  else std::memcpy(destination,source,count);
  return count;
}
size_t ArrayBuffer::CopyArrayBufferBytes(size_t start,size_t length,Local<ArrayBuffer> target,size_t destination) {
  if(target->WasDetached()||target->IsImmutable())return 0;
  size_t sourceLength=ByteLength(),targetLength=target->ByteLength();
  if(start>sourceLength||destination>targetLength)return 0;
  size_t count=std::min({length,sourceLength-start,targetLength-destination});
  if(count)std::memmove(static_cast<uint8_t*>(target->Data())+destination,static_cast<uint8_t*>(Data())+start,count);
  return count;
}
size_t SharedArrayBuffer::CopyArrayBufferBytes(size_t start,size_t length,Local<SharedArrayBuffer> target,size_t destination) {
  size_t sourceLength=ByteLength(),targetLength=target->ByteLength();
  if(start>sourceLength||destination>targetLength)return 0;
  size_t count=std::min({length,sourceLength-start,targetLength-destination});
  if(count)js::jit::AtomicOperations::memmoveSafeWhenRacy(SharedMem<uint8_t*>::shared(static_cast<uint8_t*>(target->Data())+destination),SharedMem<uint8_t*>::shared(static_cast<uint8_t*>(Data())+start),count);
  return count;
}
std::unique_ptr<BackingStore> ArrayBuffer::NewBackingStore(Isolate* isolate,size_t size,BackingStoreInitializationMode mode,BackingStoreOnFailureMode failure) {
  CHECK(failure==BackingStoreOnFailureMode::kReturnNull||failure==BackingStoreOnFailureMode::kOutOfMemory);
  if(size>Uint8Array::kMaxLength){
    if(failure==BackingStoreOnFailureMode::kOutOfMemory)bridge::FatalOutOfMemory(isolate,"ArrayBuffer allocation is too large",false);return {};
  }
  auto lifetime=isolate->GetArrayBufferAllocatorShared();
  auto* allocator=isolate->GetArrayBufferAllocator();CHECK(allocator);
  void* data=mode==BackingStoreInitializationMode::kZeroInitialized?
      allocator->Allocate(size):allocator->AllocateUninitialized(size);
  if(!data&&size){
    if(failure==BackingStoreOnFailureMode::kOutOfMemory)bridge::FatalOutOfMemory(isolate,"ArrayBuffer allocation failed",false);return {};
  }
  auto rollback=mozilla::MakeScopeExit([&]{if(data)allocator->Free(data,size);});
  try {
    auto store=std::make_unique<BackingStore>(data,size,
        [](void* bytes,size_t length,void* owner){static_cast<Allocator*>(owner)->Free(bytes,length);},
        allocator,std::move(lifetime));
    rollback.release();return store;
  }catch(const std::bad_alloc&){
    if(failure==BackingStoreOnFailureMode::kOutOfMemory)
      bridge::FatalOutOfMemory(isolate,"ArrayBuffer backing-store metadata allocation failed",false);
    return {};
  }
}
Local<ArrayBuffer> ArrayBuffer::New(Isolate* isolate,size_t size) {
  auto store=NewBackingStore(isolate,size,BackingStoreInitializationMode::kZeroInitialized,BackingStoreOnFailureMode::kReturnNull);
  if(!store){
    bridge::FatalOutOfMemory(isolate,"ArrayBuffer allocation failed",false);
  }
  return New(isolate,std::move(store));
}
bool String::IsOneByte() const { return cell().value.toString()->hasLatin1Chars(); }
bool String::ContainsOnlyOneByte() const {
  auto& frame=*Frame::current;ValueView view(&frame.state->isolate,Local<String>(const_cast<String*>(this)));
  if(view.is_one_byte())return true;
  for(size_t i=0;i<view.length();++i)if(view.data16()[i]>255)return false;
  return true;
}
bool String::IsExternalOneByte() const {
  const JSExternalStringCallbacks* callbacks;const JS::Latin1Char* bytes;
  return JS::IsExternalStringLatin1(cell().value.toString(),&callbacks,&bytes);
}
bool String::IsExternalTwoByte()const{
  const JSExternalStringCallbacks* callbacks;const char16_t* bytes;
  return JS::IsExternalUCString(cell().value.toString(),&callbacks,&bytes);
}
namespace {
class EngineOneByteResource final:public String::ExternalOneByteStringResource {
  const char* bytes_;size_t length_;
 public:
  EngineOneByteResource(const char* bytes,size_t length):bytes_(bytes),length_(length){}
  const char* data()const override{return bytes_;}size_t length()const override{return length_;}
};
class EngineTwoByteResource final:public String::ExternalStringResource {
  const uint16_t* bytes_;size_t length_;
 public:
  EngineTwoByteResource(const uint16_t* bytes,size_t length):bytes_(bytes),length_(length){}
  const uint16_t* data()const override{return bytes_;}size_t length()const override{return length_;}
};
}
String::ExternalOneByteStringResource* String::GetExternalOneByteStringResource()const{
  CHECK(Frame::current);auto& frame=*Frame::current;CheckNativePrimitiveAccess(frame);
  const JSExternalStringCallbacks* callbacks;const JS::Latin1Char* bytes;
  if(!JS::IsExternalStringLatin1(cell().value.toString(),&callbacks,&bytes))return nullptr;
  {
    std::lock_guard lock(frame.state->externalStringMutex);auto found=frame.state->externalStringResources.find(callbacks);
    if(found!=frame.state->externalStringResources.end()){CHECK(found->second.one);return found->second.one;}
  }
  // Foreign engine external strings expose a borrowed view. Known native
  // resources above retain their exact original C++ identity and ownership.
  if(!externalView_)externalView_=std::make_unique<EngineOneByteResource>(reinterpret_cast<const char*>(bytes),Length());
  return externalView_.get();
}
String::ExternalStringResource* String::GetExternalStringResource()const{
  CHECK(Frame::current);auto& frame=*Frame::current;CheckNativePrimitiveAccess(frame);
  const JSExternalStringCallbacks* callbacks;const char16_t* bytes;
  if(!JS::IsExternalUCString(cell().value.toString(),&callbacks,&bytes))return nullptr;
  {
    std::lock_guard lock(frame.state->externalStringMutex);auto found=frame.state->externalStringResources.find(callbacks);
    if(found!=frame.state->externalStringResources.end()){CHECK(found->second.two);return found->second.two;}
  }
  if(!externalTwoByteView_)externalTwoByteView_=std::make_unique<EngineTwoByteResource>(reinterpret_cast<const uint16_t*>(bytes),Length());
  return externalTwoByteView_.get();
}
size_t String::Utf8LengthV2(Isolate* isolate)const {
  auto& frame=Current(isolate);JS::RootedString string(frame.cx,cell().value.toString());auto* linear=string->ensureLinear(frame.cx);
  CHECK(linear);return JS::GetDeflatedUTF8StringLength(linear);
}
void String::WriteOneByteV2(Isolate* isolate,size_t start,size_t length,uint8_t* output,int flags)const {
  ValueView view(isolate,Local<String>(const_cast<String*>(this)));CHECK(start<=view.length() && length<=view.length()-start);
  if(view.is_one_byte()){if(length)std::memcpy(output,view.data8()+start,length);}
  else for(size_t i=0;i<length;++i)output[i]=uint8_t(view.data16()[start+i]);
  if(flags&WriteFlags::kNullTerminate)output[length]=0;
}
}
#endif
