#ifndef KANDELO_NODE_PROPERTY_DESCRIPTOR_CODECS_INL_H
#define KANDELO_NODE_PROPERTY_DESCRIPTOR_CODECS_INL_H
#include "vm/ObjectOperations.h"
#include "vm/PropertyResult.h"

// Engine property records and operations only. Descriptor policy for env,
// Storage, SQLite and contextify stays in the complete original Node owners.
namespace v8 {
struct PropertyDescriptor::PrivateData {
  JS::PropertyDescriptor empty;
  std::unique_ptr<JS::PersistentRooted<JS::PropertyDescriptor>> root;
  std::weak_ptr<State> owner;
  void CheckOwner()const{
    if(!root)return;
    auto state=owner.lock();CHECK(state&&state->cx==js::TlsContext.get());
    state->AssertForeground();
  }
  ~PrivateData(){CheckOwner();}
  JS::PropertyDescriptor& Descriptor(){CheckOwner();return root?root->get():empty;}
  const JS::PropertyDescriptor& Descriptor()const{CheckOwner();return root?root->get():empty;}
  void Root(Frame& frame){
    if(root){CheckOwner();CHECK(owner.lock()==frame.state);return;}
    root=std::make_unique<JS::PersistentRooted<JS::PropertyDescriptor>>(frame.cx,empty);
    owner=frame.state;
  }
};
namespace {
void SetDescriptorValue(PropertyDescriptor::PrivateData& data,Local<Value> input){
  if(input.IsEmpty())return;
  CHECK(Frame::current);auto& frame=*Frame::current;data.Root(frame);
  data.Descriptor().setValue(Input(input));
}
void SetDescriptorAccessor(PropertyDescriptor::PrivateData& data,Local<Value> input,bool setter){
  if(input.IsEmpty())return;
  CHECK(Frame::current);auto& frame=*Frame::current;data.Root(frame);
  auto value=Input(input);
  CHECK(value.isUndefined()||(value.isObject()&&JS::IsCallable(&value.toObject())));
  auto* object=value.isUndefined()?nullptr:&value.toObject();
  if(setter)data.Descriptor().setSetter(object);else data.Descriptor().setGetter(object);
}
Local<Value> ReadDescriptorValue(const PropertyDescriptor::PrivateData& data,int field){
  CHECK(Frame::current);auto& frame=*Frame::current;
  const auto& descriptor=data.Descriptor();
  JS::RootedValue value(frame.cx);
  if(field==0){CHECK(descriptor.hasValue());value=descriptor.value();}
  else {
    CHECK(field==1?descriptor.hasGetter():descriptor.hasSetter());
    auto* callable=field==1?descriptor.getter():descriptor.setter();
    if(callable)value.setObject(*callable);
  }
  if(JS::CurrentGlobalOrNull(frame.cx)&&!JS_WrapValue(frame.cx,&value))return {};
  return frame.OwnValue(value);
}
bool PropertyKeyForApi(Frame& frame,Local<Value> name,JS::MutableHandleId key){
  CHECK(!name.IsEmpty());JS::RootedValue value(frame.cx,Input(name));
  return JS_WrapValue(frame.cx,&value)&&JS_ValueToId(frame.cx,value,key);
}
PropertyAttribute DescriptorAttributes(const JS::PropertyDescriptor& descriptor){
  descriptor.assertComplete();unsigned attributes=None;
  if(descriptor.isDataDescriptor()&&!descriptor.writable())attributes|=ReadOnly;
  if(!descriptor.enumerable())attributes|=DontEnum;
  if(!descriptor.configurable())attributes|=DontDelete;
  return PropertyAttribute(attributes);
}
bool ReadApiPropertyAttributes(Frame& frame,JS::HandleObject object,JS::HandleId key,
    PropertyAttribute* attributes,bool* found){
  JS::RootedObject cursor(frame.cx,object);
  *found=false;
  while(cursor){
    JS::RootedValue wrapped(frame.cx,JS::ObjectValue(*cursor));
    JS::RootedObject actual(frame.cx,UnwrapObject(frame.cx,wrapped));if(!actual)return false;
    JSAutoRealm home(frame.cx,actual);JS::RootedId localKey(frame.cx,key);
    if(!JS_WrapId(frame.cx,&localKey))return false;
    if(actual->is<js::NativeObject>()){
      JS::Rooted<js::NativeObject*> native(frame.cx,&actual->as<js::NativeObject>());
      js::PropertyResult property;
      if(!js::NativeLookupOwnProperty<js::CanGC>(frame.cx,native,localKey,&property))return false;
      if(property.isFound()){
        unsigned result=None;
        if(property.isNativeProperty()){
          auto info=property.propertyInfo();
          if(info.isDataDescriptor()&&!info.writable())result|=ReadOnly;
          if(!info.enumerable())result|=DontEnum;
          if(!info.configurable())result|=DontDelete;
        }else if(property.isDenseElement()){
          if(native->denseElementsAreFrozen())result|=ReadOnly;
          if(native->denseElementsAreSealed())result|=DontDelete;
        }else CHECK(property.isTypedArrayElement());
        // Read real flags, not the property's value. In particular, querying
        // native live/lazy data attributes must not invoke its getter.
        *attributes=PropertyAttribute(result);*found=true;return true;
      }
      // Original SM lookup identifies canonical numeric TypedArray misses,
      // recursive resolution and embedding-private keys that stop inheritance.
      if(property.shouldIgnoreProtoChain())return true;
      cursor=native->staticPrototype();
    }else {
      JS::Rooted<mozilla::Maybe<JS::PropertyDescriptor>> descriptor(frame.cx);
      if(!JS_GetOwnPropertyDescriptorById(frame.cx,actual,localKey,&descriptor))return false;
      if(descriptor.isSome()){
        *attributes=DescriptorAttributes(descriptor.get().ref());*found=true;return true;
      }
      // Pinned V8 attribute lookup asks a JSProxy for its own descriptor and
      // stops if absent. It must not invoke that proxy's getPrototypeOf trap.
      if(js::IsProxy(actual)&&js::GetProxyHandler(actual)->isScripted())return true;
      if(localKey.isEmbeddingPrivateName())return true;
      if(!JS_GetPrototype(frame.cx,actual,&cursor))return false;
    }
  }
  return true;
}
}
PropertyDescriptor::PropertyDescriptor():private_(std::make_unique<PrivateData>()){}
PropertyDescriptor::PropertyDescriptor(Local<Value> input):PropertyDescriptor(){SetDescriptorValue(*private_,input);}
PropertyDescriptor::PropertyDescriptor(Local<Value> input,bool writable):PropertyDescriptor(input){private_->Descriptor().setWritable(writable);}
PropertyDescriptor::PropertyDescriptor(Local<Value> getter,Local<Value> setter):PropertyDescriptor(){
  SetDescriptorAccessor(*private_,getter,false);SetDescriptorAccessor(*private_,setter,true);
}
PropertyDescriptor::~PropertyDescriptor()=default;
Local<Value> PropertyDescriptor::value()const{return ReadDescriptorValue(*private_,0);}
Local<Value> PropertyDescriptor::get()const{return ReadDescriptorValue(*private_,1);}
Local<Value> PropertyDescriptor::set()const{return ReadDescriptorValue(*private_,2);}
bool PropertyDescriptor::has_value()const{return private_->Descriptor().hasValue();}
bool PropertyDescriptor::has_get()const{return private_->Descriptor().hasGetter();}
bool PropertyDescriptor::has_set()const{return private_->Descriptor().hasSetter();}
bool PropertyDescriptor::has_writable()const{return private_->Descriptor().hasWritable();}
bool PropertyDescriptor::writable()const{CHECK(has_writable());return private_->Descriptor().writable();}
bool PropertyDescriptor::has_enumerable()const{return private_->Descriptor().hasEnumerable();}
bool PropertyDescriptor::enumerable()const{CHECK(has_enumerable());return private_->Descriptor().enumerable();}
void PropertyDescriptor::set_enumerable(bool value){private_->Descriptor().setEnumerable(value);}
bool PropertyDescriptor::has_configurable()const{return private_->Descriptor().hasConfigurable();}
bool PropertyDescriptor::configurable()const{CHECK(has_configurable());return private_->Descriptor().configurable();}
void PropertyDescriptor::set_configurable(bool value){private_->Descriptor().setConfigurable(value);}

Maybe<bool> Object::DefineProperty(Local<Context> context,Local<Name> name,PropertyDescriptor& descriptor){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  auto& source=*descriptor.get_private();source.CheckOwner();
  if(source.root)CHECK(source.owner.lock()==frame.state);
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedId key(frame.cx);JS::Rooted<JS::PropertyDescriptor> native(frame.cx,source.Descriptor());
  if(!JS_WrapObject(frame.cx,&object)||!PropertyKeyForApi(frame,name,&key)||!JS_WrapPropertyDescriptor(frame.cx,&native))return {};
  // Like upstream V8's kDontThrow: ordinary rejection is Just(false), while
  // a real exception from a Proxy or engine operation remains Nothing.
  JS::ObjectOpResult result;
  if(!JS_DefinePropertyById(frame.cx,object,key,native,result))return {};
  return Just(result.ok());
}
MaybeLocal<Value> Object::GetOwnPropertyDescriptor(Local<Context> context,Local<Name> name){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedId key(frame.cx);JS::Rooted<mozilla::Maybe<JS::PropertyDescriptor>> descriptor(frame.cx);
  JS::RootedValue output(frame.cx);
  if(!JS_WrapObject(frame.cx,&object)||!PropertyKeyForApi(frame,name,&key)||
      !JS_GetOwnPropertyDescriptorById(frame.cx,object,key,&descriptor)||
      !JS::FromPropertyDescriptor(frame.cx,descriptor,&output))return {};
  // Original FromPropertyDescriptor builds a real ordinary result object;
  // an absent property returns a present undefined handle, not Nothing.
  return frame.OwnValue(output);
}
Maybe<bool> Object::HasOwnProperty(Local<Context> context,Local<Name> name){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedId key(frame.cx);bool present;
  if(!JS_WrapObject(frame.cx,&object)||!PropertyKeyForApi(frame,name,&key)||
      !JS_HasOwnPropertyById(frame.cx,object,key,&present))return {};
  return Just(present);
}
Maybe<bool> Object::HasOwnProperty(Local<Context> context,uint32_t index){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedId key(frame.cx);bool present;
  if(!JS_WrapObject(frame.cx,&object)||!JS_IndexToId(frame.cx,index,&key)||
      !JS_HasOwnPropertyById(frame.cx,object,key,&present))return {};
  return Just(present);
}
Maybe<PropertyAttribute> Object::GetPropertyAttributes(Local<Context> context,Local<Value> name){
  PropertyAttribute attributes=None;auto result=GetPropertyAttributes(context,name,&attributes);
  if(result.IsNothing())return {};return Just(attributes);
}
Maybe<bool> Object::GetPropertyAttributes(Local<Context> context,Local<Value> name,PropertyAttribute* attributes){
  CHECK(attributes);auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedId key(frame.cx);bool found;
  if(!JS_WrapObject(frame.cx,&object)||!PropertyKeyForApi(frame,name,&key)||
      !ReadApiPropertyAttributes(frame,object,key,attributes,&found))return {};
  return Just(found);
}
Maybe<bool> Object::CreateDataProperty(Local<Context> context,Local<Name> name,Local<Value> value){
  return DefineOwnProperty(context,name,value,None);
}
Maybe<bool> Object::CreateDataProperty(Local<Context> context,uint32_t index,Local<Value> input){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedId key(frame.cx);JS::RootedValue value(frame.cx,Input(input));
  if(!JS_WrapObject(frame.cx,&object)||!JS_IndexToId(frame.cx,index,&key)||!JS_WrapValue(frame.cx,&value))return {};
  JS::Rooted<JS::PropertyDescriptor> descriptor(frame.cx,JS::PropertyDescriptor::Data(value,unsigned(JSPROP_ENUMERATE)));
  JS::ObjectOpResult result;
  if(!JS_DefinePropertyById(frame.cx,object,key,descriptor,result))return {};
  return Just(result.ok());
}
Maybe<bool> Object::Delete(Local<Context> context,Local<Value> name){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());
  JS::RootedId key(frame.cx);JS::ObjectOpResult result;
  if(!JS_WrapObject(frame.cx,&object)||!PropertyKeyForApi(frame,name,&key)||
      !JS_DeletePropertyById(frame.cx,object,key,result))return {};
  return Just(result.ok());
}
Maybe<bool> Object::Delete(Local<Context> context,uint32_t index){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());JS::ObjectOpResult result;
  if(!JS_WrapObject(frame.cx,&object)||!JS_DeleteElement(frame.cx,object,index,result))return {};
  return Just(result.ok());
}
Maybe<bool> Object::SetIntegrityLevel(Local<Context> context,IntegrityLevel level){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  CHECK(level==IntegrityLevel::kFrozen||level==IntegrityLevel::kSealed);
  Context::Scope home(context);JS::RootedObject object(frame.cx,&cell().value.toObject());
  if(!JS_WrapObject(frame.cx,&object)||!js::SetIntegrityLevel(frame.cx,object,
      level==IntegrityLevel::kFrozen?js::IntegrityLevel::Frozen:js::IntegrityLevel::Sealed))return {};
  return Just(true);
}
Maybe<bool> Object::SetPrototypeV2(Local<Context> context,Local<Value> input){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  Context::Scope home(context);
  JS::RootedObject object(frame.cx,&cell().value.toObject()),prototype(frame.cx);
  JS::RootedValue value(frame.cx,Input(input));
  if(!JS_WrapObject(frame.cx,&object)||!JS_WrapValue(frame.cx,&value))return {};
  JS::RootedValue objectValue(frame.cx,JS::ObjectValue(*object));
  JS::RootedObject actual(frame.cx,UnwrapObject(frame.cx,objectValue));if(!actual)return {};
  const bool scripted=js::IsProxy(actual)&&js::GetProxyHandler(actual)->isScripted();
  if(!value.isObjectOrNull()){
    CHECK(!scripted);return Just(true);
  }
  prototype=value.toObjectOrNull();JS::ObjectOpResult result;
  if(!js::SetPrototype(frame.cx,object,prototype,result)){
    // Pinned V8 SetPrototypeImpl installs an inner TryCatch for a JSProxy
    // and deliberately consumes its ordinary trap exception. Preserve that
    // native API contract without swallowing OOM or a stop request.
    if(scripted&&!entry.Terminated()&&JS_IsExceptionPending(frame.cx)){
      if(frame.cx->exceptionStatus()==JS::ExceptionStatus::OutOfMemory){
#ifdef KANDELO_NATIVE_NODE_ENGINE
        bridge::FatalOutOfMemory(context->isolate,"Prototype trap",true);
#else
        Crash("Prototype trap allocation failed");
#endif
      }
      JS_ClearPendingException(frame.cx);
    }
    return {};
  }
  if(!result.ok())return {};return Just(true);
}
Local<Value> Object::GetPrototypeV2(){
  CHECK(Frame::current);auto& frame=*Frame::current;NativeEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value)),prototype(frame.cx);if(!object)return {};
  {
    JSAutoRealm home(frame.cx,object);
    // Original V8 PrototypeIterator stops at a user JSProxy without invoking
    // its trap. Cross-compartment wrappers are engine transport, not JSProxy.
    if(!js::IsProxy(object)||!js::GetProxyHandler(object)->isScripted()){
      if(!JS_GetPrototype(frame.cx,object,&prototype))return {};
    }
  }
  JS::RootedValue value(frame.cx,JS::ObjectOrNullValue(prototype));
  if(JS::CurrentGlobalOrNull(frame.cx)&&!JS_WrapValue(frame.cx,&value))return {};
  return frame.OwnValue(value);
}
}
#endif
