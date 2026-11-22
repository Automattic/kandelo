#ifndef KANDELO_NODE_PROPERTY_INTERCEPTOR_CODECS_INL_H
#define KANDELO_NODE_PROPERTY_INTERCEPTOR_CODECS_INL_H

// Included inside v8's template implementation namespace. Callback policy stays
// in the original Node owners; these operations marshal real engine objects.
enum class NativeInterceptorOperation {Get,Query,Descriptor,Set,Define,Delete,Enumerate};

bool NativeInterceptorIndex(JS::HandleId id,uint32_t* index){
  if(id.isInt()){*index=uint32_t(id.toInt());return true;}
  return id.isString()&&id.toString()->asAtom().isIndex(index)&&*index!=UINT32_MAX;
}
JSObject* NativeInterceptorRecord(JSContext* cx,JS::HandleObject holder,bool indexed){
  JS::RootedObject record(cx);
  if(IsNativeInterceptedGlobal(holder)){
    record=NativeGlobalInterceptorConstructor(cx,holder);
  }else{
    if(!HasNativeFieldStorage(holder))return nullptr;
    record=UnwrapTemplateObject(cx,JS::GetReservedSlot(holder,NativeTemplateBrand));
  }
  while(record){
    const auto& info=TemplateInfo(record);
    if(indexed?info.indexedHandler.has_value():info.namedHandler.has_value())return record;
    record=UnwrapTemplateObject(cx,JS::GetReservedSlot(record,TemplateParent));
  }
  return nullptr;
}
bool NativeInterceptorFlag(PropertyHandlerFlags flags,PropertyHandlerFlags flag){
  return (unsigned(flags)&unsigned(flag))!=0;
}

bool InvokeTemplateInterceptor(JSContext* cx,JS::HandleObject holder,
    JS::HandleValue receiver,JS::HandleId id,NativeInterceptorOperation operation,
    JS::HandleValue input,const JS::PropertyDescriptor* descriptor,
    JS::MutableHandleValue output,bool* handled,std::optional<bool> enumerationKind={}){
  *handled=false;
  auto state=ReadNativeEngineState(cx);if(!state)return false;
  state->AssertForeground();CHECK(state->cx==cx);
  if(cx->isNativeExecutionTerminating()||JS_IsExceptionPending(cx))return false;
  uint32_t index=0;const bool indexed=enumerationKind.value_or(NativeInterceptorIndex(id,&index));
  JS::RootedObject record(cx,NativeInterceptorRecord(cx,holder,indexed));
  if(!record)return true;
  const auto& config=TemplateInfo(record);
  const auto* named=indexed?nullptr:&*config.namedHandler;
  const auto* element=indexed?&*config.indexedHandler:nullptr;
  const auto flags=indexed?element->flags:named->flags;
  if(!indexed&&id.isSymbol()&&NativeInterceptorFlag(flags,PropertyHandlerFlags::kOnlyInterceptStrings))return true;

  NativeCallbackEntry callbackEntry(*state);
  JSAutoRealm home(cx,holder);JS::RootedObject global(cx,JS::GetNonCCWObjectGlobal(holder));
  Frame frame(cx,global,state,nullptr,config.domain);
  frame.binding=holder;frame.propertyHolder=holder;frame.receiver=receiver;
  auto mode=cx->nativePropertyFailureMode();
  if(mode)frame.propertyShouldThrow=mode.value();
  JSContext::AutoNativePropertyFailureMode propertyMode(cx,mozilla::Nothing());
  frame.propertyData=JS::GetReservedSlot(record,indexed?TemplateIndexedHandlerData:TemplateNamedHandlerData);
  if(!JS_WrapValue(cx,&frame.receiver)||!JS_WrapValue(cx,&frame.propertyData))return false;
  if(operation!=NativeInterceptorOperation::Enumerate&&
     NativeInterceptorFlag(flags,PropertyHandlerFlags::kNonMasking)){
    PropertyAttribute attributes;bool found;
    if(!ReadApiPropertyAttributes(frame,holder,id,&attributes,&found))return false;
    if(found)return true;
  }
  auto name=NativePropertyName(frame,id);if(name.IsEmpty())return false;
  JS::RootedValue value(cx,input);if(!JS_WrapValue(cx,&value))return false;
  auto local=frame.OwnValue(value);
  const bool write=operation==NativeInterceptorOperation::Set||
      operation==NativeInterceptorOperation::Define||operation==NativeInterceptorOperation::Delete;
  frame.propertyReturn=write?JS::TrueValue():operation==NativeInterceptorOperation::Query
      ?JS::Int32Value(None):JS::UndefinedValue();
  Intercepted intercepted=Intercepted::kNo;
  auto* isolate=&state->isolate;
  switch(operation){
    case NativeInterceptorOperation::Get:{
      PropertyCallbackInfo<Value> info(isolate);
      if(indexed){if(element->getter)intercepted=element->getter(index,info);}
      else if(named->getter)intercepted=named->getter(name,info);
      break;
    }
    case NativeInterceptorOperation::Query:{
      PropertyCallbackInfo<Integer> info(isolate);
      if(indexed){if(element->query)intercepted=element->query(index,info);}
      else if(named->query)intercepted=named->query(name,info);
      break;
    }
    case NativeInterceptorOperation::Descriptor:{
      PropertyCallbackInfo<Value> info(isolate);
      if(indexed){if(element->descriptor)intercepted=element->descriptor(index,info);}
      else if(named->descriptor)intercepted=named->descriptor(name,info);
      break;
    }
    case NativeInterceptorOperation::Set:{
      PropertyCallbackInfo<void> info(isolate);
      if(indexed){if(element->setter)intercepted=element->setter(index,local,info);}
      else if(named->setter)intercepted=named->setter(name,local,info);
      break;
    }
    case NativeInterceptorOperation::Define:{
      CHECK(descriptor);PropertyDescriptor native;
      JS::Rooted<JS::PropertyDescriptor> wrapped(cx,*descriptor);
      if(!JS_WrapPropertyDescriptor(cx,&wrapped))return false;
      auto* storage=native.get_private();storage->Root(frame);storage->Descriptor()=wrapped;
      PropertyCallbackInfo<void> info(isolate);
      if(indexed){if(element->definer)intercepted=element->definer(index,native,info);}
      else if(named->definer)intercepted=named->definer(name,native,info);
      break;
    }
    case NativeInterceptorOperation::Delete:{
      PropertyCallbackInfo<Boolean> info(isolate);
      if(indexed){if(element->deleter)intercepted=element->deleter(index,info);}
      else if(named->deleter)intercepted=named->deleter(name,info);
      break;
    }
    case NativeInterceptorOperation::Enumerate:{
      PropertyCallbackInfo<Array> info(isolate);
      if(indexed){if(element->enumerator){element->enumerator(info);intercepted=Intercepted::kYes;}}
      else if(named->enumerator){named->enumerator(info);intercepted=Intercepted::kYes;}
      break;
    }
  }
  if(JS_IsExceptionPending(cx)||cx->isNativeExecutionTerminating())return false;
  *handled=intercepted==Intercepted::kYes;output.set(frame.propertyReturn);
  return JS_WrapValue(cx,output);
}

bool GetTemplateInterceptedProperty(JSContext* cx,JS::HandleObject holder,
    JS::HandleValue receiver,JS::HandleId id,JS::MutableHandleValue output,bool* handled){
  return InvokeTemplateInterceptor(cx,holder,receiver,id,NativeInterceptorOperation::Get,
      JS::UndefinedHandleValue,nullptr,output,handled);
}
bool TemplateInterceptorAttributes(JSContext* cx,JS::HandleObject holder,JS::HandleId id,
    int32_t* attributes,bool* handled){
  JS::RootedValue receiver(cx,JS::ObjectValue(*holder)),result(cx);
  if(!InvokeTemplateInterceptor(cx,holder,receiver,id,NativeInterceptorOperation::Query,
      JS::UndefinedHandleValue,nullptr,&result,handled))return false;
  if(*handled){
    // V8 Integer callbacks may return a JS number with either engine tag.
    // Require an exact int32 without coercion or JavaScript reentry.
    CHECK(result.isNumber()&&mozilla::NumberIsInt32(result.toNumber(),attributes));
    return true;
  }
  uint32_t index;const bool indexed=NativeInterceptorIndex(id,&index);
  JS::RootedObject record(cx,NativeInterceptorRecord(cx,holder,indexed));if(!record)return true;
  const auto& info=TemplateInfo(record);
  // A present query returning kNo does not fall back to the getter.
  if(indexed?bool(info.indexedHandler->query):bool(info.namedHandler->query))return true;
  if(!GetTemplateInterceptedProperty(cx,holder,receiver,id,&result,handled))return false;
  if(*handled)*attributes=DontEnum;return true;
}
bool HasOwnTemplateInterceptedProperty(JSContext* cx,JS::HandleObject holder,
    JS::HandleId id,bool* found,bool* handled){
  int32_t attributes=None;
  if(!TemplateInterceptorAttributes(cx,holder,id,&attributes,handled))return false;
  *found=*handled&&attributes!=-1;return true;
}
bool GetOwnTemplateInterceptedDescriptor(JSContext* cx,JS::HandleObject holder,JS::HandleId id,
    JS::MutableHandle<mozilla::Maybe<JS::PropertyDescriptor>> descriptor,bool* handled){
  JS::RootedValue receiver(cx,JS::ObjectValue(*holder)),value(cx);
  if(!InvokeTemplateInterceptor(cx,holder,receiver,id,NativeInterceptorOperation::Descriptor,
      JS::UndefinedHandleValue,nullptr,&value,handled))return false;
  if(*handled){
    JS::Rooted<JS::PropertyDescriptor> parsed(cx);
    if(!js::ToPropertyDescriptor(cx,value,true,&parsed))return false;
    js::CompletePropertyDescriptor(&parsed);descriptor.set(mozilla::Some(parsed.get()));return true;
  }
  uint32_t index;const bool indexed=NativeInterceptorIndex(id,&index);
  JS::RootedObject record(cx,NativeInterceptorRecord(cx,holder,indexed));
  if(record){
    const auto& info=TemplateInfo(record);
    if(indexed?bool(info.indexedHandler->descriptor):bool(info.namedHandler->descriptor))return true;
  }
  int32_t attributes=None;
  if(!TemplateInterceptorAttributes(cx,holder,id,&attributes,handled))return false;
  if(!*handled)return true;
  if(attributes==-1){descriptor.set(mozilla::Nothing());return true;}
  bool got=false;if(!GetTemplateInterceptedProperty(cx,holder,receiver,id,&value,&got))return false;
  if(!got){
    JS::Rooted<js::NativeObject*> native(cx,&holder->as<js::NativeObject>());
    if(!js::NativeGetPropertyBypassingInterceptors(cx,native,receiver,id,&value))return false;
  }
  unsigned flags=(attributes&DontEnum?0:JSPROP_ENUMERATE)|
      (attributes&ReadOnly?JSPROP_READONLY:0)|(attributes&DontDelete?JSPROP_PERMANENT:0);
  descriptor.set(mozilla::Some(JS::PropertyDescriptor::Data(value,flags)));return true;
}
bool SetTemplateInterceptedProperty(JSContext* cx,JS::HandleObject holder,
    JS::HandleValue receiver,JS::HandleId id,JS::HandleValue value,
    JS::ObjectOpResult& result,bool* handled){
  JS::RootedValue returned(cx);
  if(!InvokeTemplateInterceptor(cx,holder,receiver,id,NativeInterceptorOperation::Set,
      value,nullptr,&returned,handled))return false;
  if(!*handled)return true;
  return returned.isTrue()?result.succeed():result.fail(JSMSG_READ_ONLY);
}
bool DefineTemplateInterceptedProperty(JSContext* cx,JS::HandleObject holder,JS::HandleId id,
    JS::Handle<JS::PropertyDescriptor> descriptor,JS::ObjectOpResult& result,bool* handled){
  JS::RootedValue receiver(cx,JS::ObjectValue(*holder)),returned(cx);
  if(!InvokeTemplateInterceptor(cx,holder,receiver,id,NativeInterceptorOperation::Define,
      JS::UndefinedHandleValue,&descriptor.get(),&returned,handled))return false;
  if(!*handled)return true;
  return returned.isTrue()?result.succeed():result.fail(JSMSG_CANT_REDEFINE_PROP);
}
bool DeleteTemplateInterceptedProperty(JSContext* cx,JS::HandleObject holder,JS::HandleId id,
    JS::ObjectOpResult& result,bool* handled){
  JS::RootedValue receiver(cx,JS::ObjectValue(*holder)),returned(cx);
  if(!InvokeTemplateInterceptor(cx,holder,receiver,id,NativeInterceptorOperation::Delete,
      JS::UndefinedHandleValue,nullptr,&returned,handled))return false;
  if(!*handled)return true;
  return returned.isTrue()?result.succeed():result.fail(JSMSG_CANT_DELETE);
}
bool PreventTemplateInterceptorExtensions(JSContext* cx,JS::HandleObject object,JS::ObjectOpResult& result){
  // Like upstream objects with interceptors, virtual own properties cannot be
  // sealed/frozen by merely changing the actual native object's shape flags.
  if(NativeInterceptorRecord(cx,object,false)||NativeInterceptorRecord(cx,object,true))
    return result.fail(JSMSG_CANT_PREVENT_EXTENSIONS);
  return result.succeed();
}
bool EnumerateNativeTemplate(JSContext* cx,JS::HandleObject object,
    JS::MutableHandleIdVector properties,bool enumerableOnly){
  JS::RootedValue receiver(cx,JS::ObjectValue(*object)),keys(cx),value(cx);
  JS::RootedId dummy(cx,JS::PropertyKey::Int(0)),key(cx);
  for(bool indexed:{true,false}){
    bool handled=false;
    if(!InvokeTemplateInterceptor(cx,object,receiver,dummy,NativeInterceptorOperation::Enumerate,
        JS::UndefinedHandleValue,nullptr,&keys,&handled,indexed))return false;
    if(!handled||keys.isUndefined())continue;
    CHECK(keys.isObject());JS::RootedObject array(cx,&keys.toObject());uint32_t length;
    if(!JS::GetArrayLength(cx,array,&length))return false;
    for(uint32_t offset=0;offset<length;++offset){
      if(!JS_GetElement(cx,array,offset,&value)||!JS_ValueToId(cx,value,&key))return false;
      if(key.isEmbeddingPrivateName())continue;
      if(enumerableOnly){
        int32_t attributes=None;bool queried=false;
        if(!TemplateInterceptorAttributes(cx,object,key,&attributes,&queried))return false;
        if(queried&&(attributes==-1||(attributes&DontEnum)))continue;
      }
      // The original engine key collector merges these with actual own keys,
      // orders indices and removes duplicates. No separate property map lives here.
      if(!properties.append(key))return false;
    }
  }
  return true;
}
bool DefineNativeGlobalDeclaration(JSContext* cx,JS::HandleObject global,
    JS::HandleId id,JS::HandleValue value,unsigned attributes){
  JS::Rooted<js::NativeObject*> native(cx,&global->as<js::NativeObject>());
  JS::Rooted<JS::PropertyDescriptor> descriptor(cx,JS::PropertyDescriptor::Data(value,attributes));
  JS::ObjectOpResult result;
  if(!js::NativeDefineProperty(cx,native,id,descriptor,result,false,
      js::NativePropertyInterception::Bypass))return false;
  return result.checkStrict(cx,global,id);
}
bool DeclareNativeTemplateGlobal(JSContext* cx,JS::HandleObject global,
    JS::HandleId id,JS::HandleValue value,unsigned attributes,bool isVar,bool isEval){
  // The phase/order follows V8 runtime-scopes.cc DeclareGlobal: var uses own
  // real storage; functions query and invoke the existing interceptor setter.
  // Node's callbacks remain the owners of sandbox reads/writes and attributes.
  CHECK(IsNativeInterceptedGlobal(global)&&id.isString());
  auto state=ReadNativeEngineState(cx);if(!state)return false;
  state->AssertForeground();CHECK(state->cx==cx);
  if(cx->isNativeExecutionTerminating()||JS_IsExceptionPending(cx))return false;
  JS::Rooted<js::NativeObject*> native(cx,&global->as<js::NativeObject>());
  if(isVar){
    js::PropertyResult property;
    if(!js::NativeLookupOwnProperty<js::CanGC>(cx,native,id,&property))return false;
    if(property.isFound())return true;
    return DefineNativeGlobalDeclaration(cx,global,id,value,attributes);
  }

  int32_t oldAttributes=None;bool intercepted=false;
  if(!TemplateInterceptorAttributes(cx,global,id,&oldAttributes,&intercepted))return false;
  bool found=intercepted&&oldAttributes!=-1;
  bool accessor=false;
  if(!found){
    JS::Rooted<mozilla::Maybe<JS::PropertyDescriptor>> descriptor(cx);
    if(!js::NativeGetOwnPropertyDescriptor(cx,native,id,&descriptor,
        js::NativePropertyInterception::Bypass))return false;
    found=descriptor.isSome();
    if(found){
      accessor=descriptor->isAccessorDescriptor();
      oldAttributes=(descriptor->enumerable()?None:DontEnum)|
        (descriptor->configurable()?None:DontDelete)|
        (descriptor->isDataDescriptor()&&!descriptor->writable()?ReadOnly:None);
    }
  }
  if(found&&(oldAttributes&DontDelete)){
    if((oldAttributes&(ReadOnly|DontEnum))||accessor){
      JS::RootedString propertyName(cx,id.toString());
      JS::UniqueChars name=JS_EncodeStringToUTF8(cx,propertyName);if(!name)return false;
      if(isEval)JS_ReportErrorNumberUTF8(cx,js::GetErrorMessage,nullptr,
          JSMSG_CANT_REDEFINE_PROP,name.get());
      else JS_ReportErrorNumberUTF8(cx,js::GetErrorMessage,nullptr,
          JSMSG_REDECLARED_VAR,"variable",name.get());
      return false;
    }
    attributes=JSPROP_PERMANENT|JSPROP_ENUMERATE;
  }

  JS::RootedValue receiver(cx,JS::ObjectValue(*global));
  JS::ObjectOpResult result;bool handled=false;
  if(!SetTemplateInterceptedProperty(cx,global,receiver,id,value,result,&handled))return false;
  if(handled)return result.checkStrict(cx,global,id);
  return DefineNativeGlobalDeclaration(cx,global,id,value,attributes);
}
const js::NativePropertyInterceptorOps nativeTemplateInterceptorOps={
  GetTemplateInterceptedProperty,HasOwnTemplateInterceptedProperty,
  GetOwnTemplateInterceptedDescriptor,DefineTemplateInterceptedProperty,
  SetTemplateInterceptedProperty,DeleteTemplateInterceptedProperty,
  PreventTemplateInterceptorExtensions,DeclareNativeTemplateGlobal};
#endif
