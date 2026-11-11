#ifndef KANDELO_NODE_BUFFER_CODECS_INL_H
#define KANDELO_NODE_BUFFER_CODECS_INL_H
// Native VM operations used by the complete original Buffer source. No Buffer
// encoding, search, fill, mask, swap or public module algorithms live here.
namespace kandelo_node_codec_api {
bool SameLocal(Value* left,Value* right) {
  if(!left||!right)return left==right;bool same;CHECK(JS::SameValue(Frame::current->cx,left->cell().value,right->cell().value,&same));return same;
}
bool Value::IsObject() const { return cell().value.isObject(); }
bool Value::IsTypedArray() const { auto* object=UnwrapObject(Frame::current->cx,cell().value);return object && JS_IsTypedArrayObject(object); }
static int64_t IntegerNumber(double number) {
  if(std::isnan(number))return 0;
  if(number>=double(INT64_MAX))return INT64_MAX;
  if(number<=double(INT64_MIN))return INT64_MIN;
  return int64_t(number);
}
Maybe<int64_t> Value::IntegerValue(Local<Context> context) {
  auto& frame=Current(context->isolate);double number;
  if(!JS::ToNumber(frame.cx,cell().value,&number))return {};
  return Just(IntegerNumber(number));
}
Local<Number> Number::New(Isolate* isolate,double number) {
  auto& frame=Current(isolate);JS::RootedValue value(frame.cx,JS::DoubleValue(number));return frame.Own<Integer>(value);
}
double Number::Value() const { CHECK(IsNumber());return cell().value.toNumber(); }
Local<Value> HandleScope::EscapeRoot(Local<Value> input) {
  CHECK(!input.IsEmpty());JS::RootedValue value(frame_->cx,Input(input));
  auto output=frame_->OwnValue(value);auto owned=std::move(frame_->roots.back());frame_->roots.pop_back();
  frame_->roots.insert(frame_->roots.begin()+previous_,std::move(owned));++previous_;
  return output;
}
Maybe<bool> Object::SetPrototypeV2(Local<Context> context,Local<Object> prototype) {
  auto& frame=Current(context->isolate);JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedObject proto(frame.cx,&prototype->cell().value.toObject());
  if(!JS_SetPrototype(frame.cx,object,proto))return {};return Just(true);
}
Maybe<bool> Object::SetPrivate(Local<Context> context,Local<Value> property,Local<Value> input) {
  auto& frame=Current(context->isolate);JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedValue key(frame.cx,Input(property)),value(frame.cx,Input(input));CHECK(key.isSymbol());
  JS::RootedSymbol symbol(frame.cx,key.toSymbol());
  CHECK(JS::GetSymbolCode(symbol)==JS::SymbolCode::EmbeddingPrivateSymbol);
  JS::RootedId id(frame.cx,JS::PropertyKey::Symbol(key.toSymbol()));
  if(!JS_DefinePropertyById(frame.cx,object,id,value,0))return {};return Just(true);
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
  // This engine has no immutable ArrayBuffer kind. Ordinary freeze does not
  // make ArrayBuffer bytes immutable; never infer it from object extensibility.
  return false;
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
std::unique_ptr<BackingStore> ArrayBuffer::NewBackingStore(Isolate* isolate,size_t size,BackingStoreInitializationMode mode,BackingStoreOnFailureMode) {
  Current(isolate);if(size>Uint8Array::kMaxLength)return {};
  void* data=mode==BackingStoreInitializationMode::kZeroInitialized?std::calloc(std::max(size,size_t(1)),1):std::malloc(std::max(size,size_t(1)));
  if(!data)return {};
  return NewBackingStore(data,size,[](void* bytes,size_t,void*){std::free(bytes);},nullptr);
}
Local<ArrayBuffer> ArrayBuffer::New(Isolate* isolate,size_t size) {
  auto store=NewBackingStore(isolate,size,BackingStoreInitializationMode::kZeroInitialized,BackingStoreOnFailureMode::kReturnNull);
  if(!store){native::THROW_ERR_MEMORY_ALLOCATION_FAILED(isolate);return {};}
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
namespace {
class EngineOneByteResource final:public String::ExternalOneByteStringResource {
  const char* bytes_;size_t length_;
 public:
  EngineOneByteResource(const char* bytes,size_t length):bytes_(bytes),length_(length){}
  const char* data()const override{return bytes_;}size_t length()const override{return length_;}
};
}
const String::ExternalOneByteStringResource* String::GetExternalOneByteStringResource() const {
  const JSExternalStringCallbacks* callbacks;const JS::Latin1Char* bytes;
  CHECK(JS::IsExternalStringLatin1(cell().value.toString(),&callbacks,&bytes));
  externalView_=std::make_unique<EngineOneByteResource>(reinterpret_cast<const char*>(bytes),Length());return externalView_.get();
}
size_t String::Utf8LengthV2(Isolate* isolate) {
  auto& frame=Current(isolate);JS::RootedString string(frame.cx,cell().value.toString());auto* linear=string->ensureLinear(frame.cx);
  CHECK(linear);return JS::GetDeflatedUTF8StringLength(linear);
}
void String::WriteOneByteV2(Isolate* isolate,size_t start,size_t length,uint8_t* output) {
  ValueView view(isolate,Local<String>(this));CHECK(start<=view.length() && length<=view.length()-start);
  if(view.is_one_byte())std::memcpy(output,view.data8()+start,length);
  else for(size_t i=0;i<length;++i)output[i]=uint8_t(view.data16()[start+i]);
}
}
namespace kandelo_node_codec_impl {
using namespace api;
Realm* Realm::GetCurrent(const FunctionCallbackInfo<Value>& args) { Current(args.GetIsolate());static thread_local Realm realm;return &realm; }
Realm::Kind Realm::kind() const {
  auto& frame=*Frame::current;JS::RootedObject runtime(frame.cx,kandelo::node::GetRealmRuntime(frame.cx,frame.realm));CHECK(runtime);
  JS::RootedObject principal(frame.cx,kandelo::node::GetRuntimePrincipalRealm(frame.cx,runtime));CHECK(principal);
  JS::RootedValue principalValue(frame.cx,JS::ObjectValue(*principal));
  return UnwrapObject(frame.cx,principalValue)==frame.realm?Kind::kPrincipal:Kind::kShadow;
}
void Realm::set_buffer_prototype_object(Local<Object> value) {
  auto& frame=*Frame::current;JS::RootedObject object(frame.cx,&value->cell().value.toObject());
  CHECK(kandelo::node::SetRealmBufferPrototype(frame.cx,frame.realm,object));
}
Local<Object> Environment::buffer_prototype_object() {
  auto& frame=Current(isolate());JS::RootedObject runtime(frame.cx,kandelo::node::GetRealmRuntime(frame.cx,frame.realm));CHECK(runtime);
  JS::RootedObject principal(frame.cx,kandelo::node::GetRuntimePrincipalRealm(frame.cx,runtime));CHECK(principal);
  JS::RootedObject object(frame.cx,kandelo::node::GetRealmBufferPrototype(frame.cx,principal));if(!object)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<Object>(value);
}
Local<Value> Environment::untransferable_object_private_symbol() {
  auto& frame=Current(isolate());JS::RootedObject runtime(frame.cx,kandelo::node::GetRealmRuntime(frame.cx,frame.realm));CHECK(runtime);
  JS::RootedSymbol key(frame.cx,kandelo::node::GetRuntimeSymbol(frame.cx,runtime,"untransferable_object_private_symbol"));CHECK(key);
  JS::RootedValue value(frame.cx,JS::SymbolValue(key));return frame.OwnValue(value);
}
IsolateData* Environment::isolate_data() { Current(isolate());static thread_local IsolateData data;return &data; }
bool IsolateData::is_building_snapshot() const { return false; } // This embedding creates live realms; it has no snapshot builder.
void Environment::ThrowRangeError(const char* text) { auto value=Error(isolate(),JSEXN_RANGEERR,nullptr,text);if(!value.IsEmpty())isolate()->ThrowException(value); }
const per_process::BufferOptions* per_process::BufferOptionsAccess::operator->() const {
  static thread_local BufferOptions value;value.zero_fill_all_buffers=kandelo::node::NativeZeroFillBuffersEnabled();return &value;
}
std::unique_ptr<BackingStore> AdoptIntoBackingStore(Isolate* isolate,void* data,size_t size,BackingStore::DeleterCallback deleter,void* hint) {
  Current(isolate);return ArrayBuffer::NewBackingStore(data,size,deleter,hint);
}
Local<String> OneByteString(Isolate* isolate,const uint8_t* data,size_t length) { CHECK_LE(length,String::kMaxLength);return String::NewFromOneByte(isolate,data,NewStringType::kNormal,int(length)).ToLocalChecked(); }
static void ThrowBufferError(Isolate* isolate,JSExnType kind,const char* code,const char* message) {
  auto value=Error(isolate,kind,code,message);if(!value.IsEmpty())isolate->ThrowException(value);
}
void THROW_ERR_OUT_OF_RANGE(Environment* env,const char* text) { ThrowBufferError(env->isolate(),JSEXN_RANGEERR,"ERR_OUT_OF_RANGE",text); }
void THROW_ERR_BUFFER_OUT_OF_BOUNDS(Environment* env,const char* text) { ThrowBufferError(env->isolate(),JSEXN_RANGEERR,"ERR_BUFFER_OUT_OF_BOUNDS",text); }
void THROW_ERR_MEMORY_ALLOCATION_FAILED(Environment* env) { THROW_ERR_MEMORY_ALLOCATION_FAILED(env->isolate()); }
void THROW_ERR_MEMORY_ALLOCATION_FAILED(Isolate* isolate) { isolate->ThrowException(ERR_MEMORY_ALLOCATION_FAILED(isolate)); }
void THROW_ERR_BUFFER_CONTEXT_NOT_AVAILABLE(Isolate* isolate) { ThrowBufferError(isolate,JSEXN_ERR,"ERR_BUFFER_CONTEXT_NOT_AVAILABLE","Buffer is not available for the current Context"); }
void SetMethodNoSideEffect(Local<Context> context,Local<Object> target,const char* name,Callback callback) {
  // The normal engine-native dispatcher is the execution path. V8 inspector
  // side-effect annotations are not represented as SpiderMonkey guarantees.
  SetMethod(context,target,name,callback);
}
void SetFastMethod(Local<Context> context,Local<Object> target,const char* name,Callback callback,const CFunction* fast) {
  CHECK(fast && fast->signature);SetMethod(context,target,name,callback);
  auto& frame=Current(context->isolate);JS::RootedObject targetObject(frame.cx,&target->cell().value.toObject());JS::RootedValue function(frame.cx);
  CHECK(JS_GetProperty(frame.cx,targetObject,name,&function));auto* closure=&js::GetFunctionNativeReserved(&function.toObject(),1).toObject();
  static_cast<api::CallbackOwner*>(JS::GetReservedSlot(closure,0).toPrivate())->fast=fast->signature;
  // Original SetFastMethod installs an unnamed FunctionTemplate; its property
  // key does not become the native function's own name (src/util.cc).
  auto& nativeFunction=function.toObject().as<JSFunction>();CHECK(!nativeFunction.hasResolvedName());
  JS::Rooted<JSAtom*> empty(frame.cx,js::Atomize(frame.cx,"",0));CHECK(empty);nativeFunction.setAtom(empty);
}
void SetFastMethodNoSideEffect(Local<Context> context,Local<Object> target,const char* name,Callback callback,const CFunction* fast) { SetFastMethod(context,target,name,callback,fast); }
}
namespace kandelo::node {
namespace {
struct BufferFreeProbe { std::shared_ptr<api::State> state;size_t bytes;bool marker; };
void ReleaseBufferProbe(char* data,void* hint) {
  std::unique_ptr<BufferFreeProbe> probe(static_cast<BufferFreeProbe*>(hint));
  probe->state->environment.AssertForeground();
  std::free(data);probe->state->bufferFreed.fetch_add(1);probe->state->bufferBytes.fetch_sub(probe->bytes);
  if(probe->marker){std::printf("ORIGINAL_BUFFER_CALLBACK_DONE\n");std::fflush(stdout);}
}
bool BufferNativeControl(JSContext* cx,unsigned argc,JS::Value* vp) {
  auto args=JS::CallArgsFromVp(argc,vp);if(!args.get(0).isString()){JS_ReportErrorASCII(cx,"Native Buffer control requires an operation");return false;}
  JS::RootedString operationString(cx,args[0].toString());auto operation=JS_EncodeStringToUTF8(cx,operationString);if(!operation)return false;
  JS::RootedObject runtime(cx,js::shell::GetShellContext(cx)->upstreamNodeRuntime);auto state=api::Data(cx,runtime);if(!state)return false;
  JS::RootedObject realm(cx,GetRuntimePrincipalRealm(cx,runtime));if(!realm)return false;realm=js::CheckedUnwrapDynamic(realm,cx,false);if(!realm||!CheckRealmLibraryActive(cx,realm))return false;
  api::Frame frame(cx,realm,state,&args,api::Domain::Buffer);args.rval().setUndefined();auto* isolate=&state->isolate;auto* environment=&state->environment;
  if(!std::strcmp(operation.get(),"inspect")){
    JS::RootedObject object(cx,JS_NewPlainObject(cx));if(!object)return false;
    for(const auto& item:std::initializer_list<std::pair<const char*,size_t>>{{"created",state->bufferCreated.load()},{"freed",state->bufferFreed.load()},{"bytes",state->bufferBytes.load()}}){
      JS::RootedValue value(cx,JS::DoubleValue(double(item.second)));if(!JS_DefineProperty(cx,object,item.first,value,JSPROP_ENUMERATE))return false;
    }
    args.rval().setObject(*object);return true;
  }
  if(!std::strcmp(operation.get(),"clean")){environment->cleanable_queue()->CleanAll();return !JS_IsExceptionPending(cx);}
  api::MaybeLocal<api::Object> result;
  if(!std::strcmp(operation.get(),"string")){
    auto value=frame.OwnValue(args.get(1));if(!value->IsString()||!args.get(2).isInt32()||args[2].toInt32()<0||args[2].toInt32()>7){JS_ReportErrorASCII(cx,"Native Buffer string control requires string and encoding");return false;}
    result=native::Buffer::New(isolate,value.As<api::String>(),static_cast<native::encoding>(args[2].toInt32()));
  }else if(!std::strcmp(operation.get(),"new")){
    uint32_t length;if(!JS::ToUint32(cx,args.get(1),&length)||length>1048576){JS_ReportErrorASCII(cx,"Native Buffer length control limit");return false;}
    result=native::Buffer::New(isolate,size_t(length));
  }else{
    bool nullData=!std::strcmp(operation.get(),"trackedNull");
    auto input=frame.OwnValue(args.get(1));if(!nullData&&!input->IsArrayBufferView()){JS_ReportErrorASCII(cx,"Native Buffer control requires bytes");return false;}
    size_t length=nullData?0:input.As<api::ArrayBufferView>()->ByteLength();
    if(!std::strcmp(operation.get(),"copy"))result=native::Buffer::Copy(isolate,native::Buffer::Data(input),length);
    else if(!std::strcmp(operation.get(),"adopt")||!std::strcmp(operation.get(),"tracked")||!std::strcmp(operation.get(),"armExit")||nullData){
      auto* data=nullData?nullptr:static_cast<char*>(std::malloc(std::max(size_t(1),length)));if(!nullData&&!data){JS_ReportOutOfMemory(cx);return false;}
      if(length)std::memcpy(data,native::Buffer::Data(input),length);
      if(!std::strcmp(operation.get(),"adopt"))result=native::Buffer::New(isolate,data,length);
      else{
        auto* probe=new BufferFreeProbe{state,length,!std::strcmp(operation.get(),"armExit")};
        state->bufferCreated.fetch_add(1);state->bufferBytes.fetch_add(length);
        result=native::Buffer::New(isolate,data,length,ReleaseBufferProbe,probe);
      }
    }else{JS_ReportErrorASCII(cx,"Unknown native Buffer control operation");return false;}
  }
  api::Local<api::Object> value;if(!result.ToLocal(&value))return false;
  args.rval().set(api::Input(value));return !JS_IsExceptionPending(cx);
}
}
bool DefineBufferNativeTestAPI(JSContext* cx,JS::HandleObject api) {
  return JS_DefineFunction(cx,api,"bufferNative",BufferNativeControl,2,0);
}

JSObject* CreateBufferBinding(JSContext* cx,JS::HandleObject realm) {
  JS::RootedObject runtime(cx,GetRealmRuntime(cx,realm));if(!runtime)return nullptr;
  auto state=api::Data(cx,runtime);if(!state)return nullptr;api::Frame frame(cx,realm,state,nullptr,api::Domain::Buffer);
  JS::RootedObject object(cx,JS_NewPlainObject(cx));if(!object)return nullptr;frame.binding=object;
  JS::RootedValue value(cx,JS::ObjectValue(*object)),unused(cx,JS::UndefinedValue());
  kandelo_buffer_adapter::initializer(frame.Own<api::Object>(value),frame.OwnValue(unused),state->isolate.GetCurrentContext(),nullptr);
  return JS_IsExceptionPending(cx)?nullptr:object.get();
}
}
#endif
