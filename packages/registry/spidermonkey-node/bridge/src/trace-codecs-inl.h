#ifndef KANDELO_NODE_TRACE_CODECS_INL_H
#define KANDELO_NODE_TRACE_CODECS_INL_H
// Native engine primitives shared by the complete original tracing sources.
// This file is included after the rooted codec marshalling implementation.

namespace v8 {
Local<Value> True(Isolate* isolate) { return Boolean::New(isolate,true); }
Local<Value> False(Isolate* isolate) { return Boolean::New(isolate,false); }
Local<Value> Factory::undefined_value() { return Undefined(isolate); }
Local<Object> Receiver(Isolate* isolate) { auto& f=Current(isolate);CHECK(f.receiver.isObject());return f.Own<Object>(f.receiver); }
void ReturnRaw(Isolate* isolate,const JS::Value& value) {
  auto& f=Current(isolate);if(JS_IsExceptionPending(f.cx))return;
  if(f.arguments)f.arguments->rval().set(value);
  else {CHECK(f.propertyHolder);f.propertyReturn.set(value);}
}
MaybeLocal<Value> Object::Get(Local<Context> context,Local<Value> property) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f,context);if(nativeEntry.Terminated())return {};Context::Scope home(context);JS::RootedObject object(f.cx,&cell().value.toObject());JS::RootedId key(f.cx);JS::RootedValue name(f.cx,Input(property)),result(f.cx);
  if(!JS_WrapObject(f.cx,&object)||!JS_WrapValue(f.cx,&name)||!JS_ValueToId(f.cx,name,&key)||!JS_GetPropertyById(f.cx,object,key,&result))return {};
  return f.OwnValue(result);
}
uint32_t Array::Length() const { auto& f=*Frame::current;JS::RootedObject object(f.cx,&cell().value.toObject());uint32_t length;CHECK(JS::GetArrayLength(f.cx,object,&length));return length; }
MaybeLocal<Value> Array::Get(Local<Context> context,uint32_t index) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f,context);if(nativeEntry.Terminated())return {};Context::Scope home(context);JS::RootedObject object(f.cx,&cell().value.toObject());JS::RootedValue value(f.cx);
  if(!JS_WrapObject(f.cx,&object)||!JS_GetElement(f.cx,object,index,&value))return {};return f.OwnValue(value);
}
size_t String::Utf8Length(Isolate* isolate,Local<String> input) {
  auto& f=Current(isolate);JS::RootedString string(f.cx,input->cell().value.toString());std::vector<char> encoded;
  CHECK(kandelo::node::EncodeTraceString(f.cx,string,&encoded));return encoded.size()-1;
}
size_t String::WriteUtf8(Isolate* isolate,Local<String> input,char* target,size_t capacity,Utf8EncodingFlag flag) {
  auto& f=Current(isolate);CHECK(flag==Utf8EncodingFlag::kNullTerminate);JS::RootedString string(f.cx,input->cell().value.toString());std::vector<char> encoded;
  CHECK(kandelo::node::EncodeTraceString(f.cx,string,&encoded));CHECK(encoded.size()<=capacity);std::memcpy(target,encoded.data(),encoded.size());return encoded.size();
}
namespace {
struct NativeBackingRegistry {
  std::mutex mutex;
  std::map<const void*,std::weak_ptr<BackingStore>> stores;
};
NativeBackingRegistry& BackingRegistry(){
  // Native-only weak metadata, valid when a store outlives every JS context.
  static auto* registry=new NativeBackingRegistry;return *registry;
}
std::shared_ptr<BackingStore> RegisteredBacking(const void* key){
  auto& registry=BackingRegistry();std::lock_guard lock(registry.mutex);
  auto found=registry.stores.find(key);return found==registry.stores.end()?nullptr:found->second.lock();
}
std::shared_ptr<BackingStore> RegisterBacking(const void* key,std::shared_ptr<BackingStore> store){
  CHECK(key);auto& registry=BackingRegistry();std::lock_guard lock(registry.mutex);
  auto found=registry.stores.find(key);
  if(found!=registry.stores.end())if(auto existing=found->second.lock())return existing;
  // One store can be attached through several actual engine allocation owners.
  // Record each alias before publishing it; allocation failure leaves no empty
  // map entry. The caller still owns the store until the mutex is released.
  auto& keys=store->retainedOwnerKeys;
  if(std::find(keys.begin(),keys.end(),key)==keys.end())keys.push_back(key);
  registry.stores.insert_or_assign(key,store);return store;
}
void ForgetBacking(const BackingStore& store){
  if(store.retainedOwnerKeys.empty())return;auto& registry=BackingRegistry();std::lock_guard lock(registry.mutex);
  for(const void* key:store.retainedOwnerKeys){
    auto entry=registry.stores.find(key);
    if(entry!=registry.stores.end()&&entry->second.expired())registry.stores.erase(entry);
  }
}
void ReleaseExternalStore(void*,void* context){delete static_cast<std::shared_ptr<BackingStore>*>(context);}
}
BackingStore::BackingStore(void* data,size_t size,void(*deleter)(void*,size_t,void*),void* userData,std::shared_ptr<void> lifetime)
    :data(data),size(size),deleter(deleter),userData(userData),lifetime(std::move(lifetime)),maximum(size){
  CHECK(deleter&&(data||!size));
}
size_t BackingStore::ByteLength()const{
  // Native jobs may read these lengths without entering a JavaScript context.
  if(nativeOwner)return nativeOwner->byteLength.load(std::memory_order_relaxed);
  if(sharedOwner&&resizable)return sharedOwner->volatileByteLength();
  return size;
}
BackingStore::~BackingStore() {
  ForgetBacking(*this);
  if(data)deleter(data,size,userData);
  // Release the retained allocation owner after the real deleter.
}
std::unique_ptr<BackingStore> ArrayBuffer::NewBackingStore(void* data,size_t size,void(*deleter)(void*,size_t,void*),void* userData) {
  CHECK(deleter);return std::make_unique<BackingStore>(data,size,deleter,userData);
}
Local<ArrayBuffer> ArrayBuffer::New(Isolate* isolate,std::unique_ptr<BackingStore> store){
  return New(isolate,std::shared_ptr<BackingStore>(std::move(store)));
}
Local<ArrayBuffer> ArrayBuffer::New(Isolate* isolate,std::shared_ptr<BackingStore> store){
  auto& f=Current(isolate);if(JS_IsExceptionPending(f.cx))return {};CHECK(store&&!store->IsShared());
  try {
    JS::RootedObject object(f.cx);
    if(store->IsResizableByUserJavaScript()){
      CHECK(store->nativeOwner&&store->nativeOwner->resizable);
      object=js::ResizableArrayBufferObject::createWithKandeloContents(f.cx,store->nativeOwner);
    }else if(!store->data){CHECK(store->size==0);object=JS::NewArrayBuffer(f.cx,0);}
    else {
      auto context=std::make_unique<std::shared_ptr<BackingStore>>(store);
      mozilla::UniquePtr<void,JS::BufferContentsDeleter> contents(store->data,JS::BufferContentsDeleter(ReleaseExternalStore,context.release()));
      object=JS::NewExternalArrayBuffer(f.cx,store->size,std::move(contents));
    }
    if(!object)return {};
    auto raw=object.as<js::ArrayBufferObject>();
    if(raw->isExternal())raw->accountKandeloExternalBytes();
    auto owner=js::ArrayBufferObject::retainKandeloContents(f.cx,raw);if(!owner)return {};
    RegisterBacking(owner.get(),std::move(store));
    JS::RootedValue value(f.cx,JS::ObjectValue(*object));return f.Own<ArrayBuffer>(value);
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(f.cx);return {};}
}
std::shared_ptr<BackingStore> ArrayBuffer::GetBackingStore(){
  auto& frame=*Frame::current;NativeNoScriptEntry entry(frame);
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(object);
  // ArrayBufferView::Buffer has the upstream ArrayBuffer-shaped return type
  // even when the actual backing object is shared.
  if(object->is<js::SharedArrayBufferObject>()){
    JS::RootedValue value(frame.cx,JS::ObjectValue(*object));
    return frame.Own<SharedArrayBuffer>(value)->GetBackingStore();
  }
  CHECK(object->is<js::ArrayBufferObject>());
  JSAutoRealm home(frame.cx,object);auto raw=object.as<js::ArrayBufferObject>();
  try {
    if(raw->isDetached())return std::make_shared<BackingStore>(nullptr,0,[](void*,size_t,void*){},nullptr);
    auto owner=js::ArrayBufferObject::retainKandeloContents(frame.cx,raw);
    if(!owner){CHECK(JS_IsExceptionPending(frame.cx));return {};}
    if(auto found=RegisteredBacking(owner.get()))return found;
    auto store=std::make_shared<BackingStore>(raw->dataPointer(),raw->byteLength(),[](void*,size_t,void*){},nullptr,owner);
    store->nativeOwner=owner;store->maximum=owner->maxByteLength;store->resizable=owner->resizable;
    return RegisterBacking(owner.get(),std::move(store));
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(frame.cx);return {};}
}

std::shared_ptr<BackingStore> SharedArrayBuffer::GetBackingStore(){
  auto& frame=*Frame::current;NativeNoScriptEntry entry(frame);
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(object&&object->is<js::SharedArrayBufferObject>());
  auto& buffer=object->as<js::SharedArrayBufferObject>();auto* raw=buffer.rawBufferObject();
  if(auto found=RegisteredBacking(raw))return found;
  if(!raw->addReference()){JS_ReportOutOfMemory(frame.cx);return {};}
  // Native references use the engine's actual atomic SAB reference count.
  // shared_ptr invokes its supplied deleter if control-block allocation fails.
  auto rollback=mozilla::MakeScopeExit([&]{raw->dropReference();});
  try {
    rollback.release();
    auto owner=std::shared_ptr<void>(raw,[](void* pointer){static_cast<js::SharedArrayRawBuffer*>(pointer)->dropReference();});
    auto store=std::make_shared<BackingStore>(buffer.dataPointerShared().unwrap(),buffer.byteLength(),[](void*,size_t,void*){},nullptr,std::move(owner));
    store->shared=true;store->sharedOwner=raw;store->resizable=buffer.isGrowable();
    store->maximum=buffer.byteLengthOrMaxByteLength();return RegisterBacking(raw,std::move(store));
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(frame.cx);return {};}
}
MaybeLocal<SharedArrayBuffer> SharedArrayBuffer::MaybeNew(Isolate* isolate,size_t size,BackingStoreInitializationMode mode){
  auto& frame=Current(isolate);NativeNoScriptEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  CHECK(mode==BackingStoreInitializationMode::kZeroInitialized||mode==BackingStoreInitializationMode::kUninitialized);
  if(size>ArrayBuffer::kMaxByteLength){JS_ReportOutOfMemory(frame.cx);return {};}
  // SpiderMonkey zeroes new shared memory; uninitialized mode permits this.
  JS::RootedObject object(frame.cx,JS::NewSharedArrayBuffer(frame.cx,size));if(!object)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<SharedArrayBuffer>(value);
}
Local<SharedArrayBuffer> SharedArrayBuffer::New(Isolate* isolate,size_t size,BackingStoreInitializationMode mode){
  auto result=MaybeNew(isolate,size,mode);if(!result.IsEmpty())return result.ToLocalChecked();
  bridge::FatalOutOfMemory(isolate,"SharedArrayBuffer allocation failed",false);
}
Local<SharedArrayBuffer> SharedArrayBuffer::New(Isolate* isolate,std::shared_ptr<BackingStore> store){
  auto& frame=Current(isolate);NativeNoScriptEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  CHECK(store&&store->IsShared()&&store->sharedOwner);
  auto* raw=store->sharedOwner;
  if(!raw->addReference()){JS_ReportOutOfMemory(frame.cx);return {};}
  auto rollback=mozilla::MakeScopeExit([&]{raw->dropReference();});
  JS::RootedObject object(frame.cx,store->IsResizableByUserJavaScript()?
      static_cast<JSObject*>(js::SharedArrayBufferObject::NewGrowable(frame.cx,raw,store->MaxByteLength())):
      static_cast<JSObject*>(js::SharedArrayBufferObject::New(frame.cx,raw,store->ByteLength())));if(!object)return {};
  rollback.release();JS::RootedValue value(frame.cx,JS::ObjectValue(*object));return frame.Own<SharedArrayBuffer>(value);
}

Local<Uint8Array> Uint8Array::New(Local<ArrayBuffer> buffer,size_t offset,size_t length) {
  auto& f=*Frame::current;if(JS_IsExceptionPending(f.cx))return {};
  JS::RootedObject raw(f.cx,&buffer->cell().value.toObject());JS::RootedObject object(f.cx,kandelo::node::NewNativeBufferView(f.cx,raw,offset,length));if(!object)return {};
  if(!RecordApiViewConstruction(f,object))return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));return f.Own<Uint8Array>(value);
}
namespace {
JSFunction* TraceFunction(Frame& frame,const char* name,Callback callback,unsigned length,bool constructor,bool receiver) {
  JS::RootedFunction fn(frame.cx,js::NewFunctionWithReserved(frame.cx,Invoke,length,constructor?JSFUN_CONSTRUCTOR:0,name));if(!fn)return nullptr;
  JS::RootedObject object(frame.cx,JS_GetFunctionObject(fn)),closure(frame.cx,JS_NewObject(frame.cx,&callbackClass));if(!closure)return nullptr;
  JS::SetReservedSlot(closure,0,JS::PrivateValue(new CallbackOwner{callback,frame.domain,constructor,receiver,0}));
  JS::SetReservedSlot(closure,1,JS::ObjectValue(*frame.binding));
  js::SetFunctionNativeReserved(object,0,JS::ObjectValue(*frame.realm));js::SetFunctionNativeReserved(object,1,JS::ObjectValue(*closure));
  if(constructor){
    JS::RootedObject prototype(frame.cx,JS_NewPlainObject(frame.cx));
    if(!prototype||!JS_DefineProperty(frame.cx,prototype,"constructor",object,0)||!JS_DefineProperty(frame.cx,object,"prototype",prototype,JSPROP_PERMANENT))return nullptr;
  }
  return fn;
}
}
void SetTraceFieldCount(JSObject* object,int count) {
  auto value=js::GetFunctionNativeReserved(object,1);auto* callback=static_cast<CallbackOwner*>(JS::GetReservedSlot(&value.toObject(),0).toPrivate());callback->fieldCount=count;
}
}
#endif
