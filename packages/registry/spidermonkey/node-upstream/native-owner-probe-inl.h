#ifndef KANDELO_NATIVE_OWNER_PROBE_INL_H
#define KANDELO_NATIVE_OWNER_PROBE_INL_H
#ifdef KANDELO_NATIVE_OWNER_PROBE
namespace kandelo_node_codec_api {
struct NativeOwnerProbeState {
  native::IsolateData* observedIsolateData=nullptr;
  std::shared_ptr<native::FatalIsolateOptions> retainedIsolateOptions;
  std::set<native::BaseObject*> objects;
  std::map<uint64_t,native::BaseObjectPtr<native::BaseObject>> references;
  std::map<uint64_t,Global<Value>> persistents;
  std::map<uint64_t,Global<FunctionTemplate>> templates;
  std::map<uint64_t,std::unique_ptr<uint64_t>> fieldPointers;
  uint64_t next=1,created=0,destroyed=0,closeRequests=0,closed=0,retired=0,callbacks=0;
};
}
namespace kandelo_node_codec_impl {
class NativeOwnerProbe final:public BaseObject {
  std::shared_ptr<api::NativeOwnerProbeState> counters_;
  uv_async_t handle_{};bool opened_=false,closing_=false;
  api::Global<api::Function> destroyCallback_;
  static void Closed(uv_handle_t* handle){
    auto* raw=static_cast<NativeOwnerProbe*>(handle->data);
    BaseObjectPtr<NativeOwnerProbe> owner(raw);
    CHECK(raw->opened_&&raw->closing_);raw->opened_=false;
    ++raw->counters_->closed;owner->Detach();
  }
 public:
  NativeOwnerProbe(Realm* realm,Local<Object> object,std::shared_ptr<api::NativeOwnerProbeState> counters)
    :BaseObject(realm,object),counters_(std::move(counters)){
    CHECK(counters_->objects.insert(this).second);++counters_->created;
  }
  ~NativeOwnerProbe()override{
    CHECK(!opened_);CHECK(counters_->objects.erase(this)==1);++counters_->destroyed;
    auto* wrapper=persistent().BorrowObject();
    if(!wrapper||JS::GetReservedSlot(wrapper,0).isUndefined())++counters_->retired;
    // Reentry probes run only during explicit foreground release with a live
    // callback frame, never during a GC finalizer or environment retirement.
    if(!destroyCallback_.IsEmpty()&&Frame::current&&!JS::RuntimeHeapIsCollecting()&&env()->can_call_into_js()){
      auto callback=destroyCallback_.Get(env()->isolate());++counters_->callbacks;
      USE(callback->Call(env()->context(),Undefined(env()->isolate()),0,nullptr));
    }
  }
  int Open(){
    int error=uv_async_init(env()->event_loop(),&handle_,[](uv_async_t*){});
    if(error)return error;handle_.data=this;opened_=true;
    // Test-owned UV resources do not keep a diagnostic process running.
    uv_unref(reinterpret_cast<uv_handle_t*>(&handle_));return 0;
  }
  void Close(){
    if(!opened_||closing_)return;closing_=true;++counters_->closeRequests;
    uv_close(reinterpret_cast<uv_handle_t*>(&handle_),Closed);
  }
  void OnGCCollect()override{if(opened_)Close();else BaseObject::OnGCCollect();}
  void SetDestroyCallback(Local<api::Function> callback){destroyCallback_.Reset(env()->isolate(),callback);}
};
}
namespace kandelo::node {
namespace {
bool NativeOwnerControl(JSContext* cx,unsigned argc,JS::Value* vp){
  auto args=JS::CallArgsFromVp(argc,vp);
  if(!args.get(0).isString()){JS_ReportErrorASCII(cx,"Native owner probe requires operation String");return false;}
  JS::RootedString operationString(cx,args[0].toString());
  auto operation=JS_EncodeStringToUTF8(cx,operationString);if(!operation)return false;
  JS::RootedObject runtime(cx,js::shell::GetShellContext(cx)->upstreamNodeRuntime);
  auto state=api::ReadCodecState(cx,runtime);if(!state)return false;
  JS::RootedObject realm(cx,GetRuntimePrincipalRealm(cx,runtime));if(!realm)return false;
  realm=js::CheckedUnwrapDynamic(realm,cx,false);if(!realm||!CheckRealmLibraryActive(cx,realm))return false;
  JSAutoRealm home(cx,realm);api::Frame frame(cx,realm,state,&args,api::Domain::Diagnostics);
  if(!state->ownerProbe)state->ownerProbe=std::make_shared<api::NativeOwnerProbeState>();
  auto counters=state->ownerProbe;args.rval().setUndefined();
  if(!std::strcmp(operation.get(),"templateInherit")||!std::strcmp(operation.get(),"templateSetData")||!std::strcmp(operation.get(),"templateFields")){
    const auto get=[&](const JS::Value& input)->api::Local<api::FunctionTemplate>{
      const double token=input.isNumber()?input.toNumber():0;
      if(!std::isfinite(token)||token<1||token>9007199254740991.0||std::floor(token)!=token){JS_ReportErrorASCII(cx,"Invalid inheritance template token");return {};}
      auto it=counters->templates.find(uint64_t(token));if(it==counters->templates.end()){JS_ReportErrorASCII(cx,"Unknown inheritance template token");return {};}return it->second.Get(&state->isolate);
    };
    auto child=get(args.get(1));if(child.IsEmpty())return false;
    if(!std::strcmp(operation.get(),"templateFields")){
      if(!args.get(2).isInt32()||args[2].toInt32()<0){JS_ReportErrorASCII(cx,"Field count must be a nonnegative int32");return false;}
      child->InstanceTemplate()->SetInternalFieldCount(args[2].toInt32());args.rval().setInt32(child->InstanceTemplate()->InternalFieldCount());return true;
    }
    if(!std::strcmp(operation.get(),"templateSetData")){
      if(!args.get(2).isString()&&!args.get(2).isSymbol()){JS_ReportErrorASCII(cx,"Template property control requires String or Symbol");return false;}
      api::Local<api::Template> target=child;
      if(!args.get(4).isUndefined()){
        if(!args[4].isString()){JS_ReportErrorASCII(cx,"Template property target requires String");return false;}
        JS::RootedString name(cx,args[4].toString());bool prototype,instance;
        if(!JS_StringEqualsAscii(cx,name,"prototype",&prototype)||!JS_StringEqualsAscii(cx,name,"instance",&instance))return false;
        if(prototype)target=child->PrototypeTemplate();else if(instance)target=child->InstanceTemplate();else{JS_ReportErrorASCII(cx,"Unknown template property target");return false;}
      }
      target->Set(frame.OwnValue(args[2]).As<api::Name>(),frame.OwnValue(args.get(3)));return true;
    }
    auto parent=get(args.get(2));if(parent.IsEmpty())return false;
    child->Inherit(parent);return true;
  }
  if(!std::strncmp(operation.get(),"field",5)){
    const char* name=operation.get();
    const auto token=[&](const JS::Value& value)->uint64_t{
      if(!value.isNumber()||!std::isfinite(value.toNumber())||value.toNumber()<1||value.toNumber()>9007199254740991.0||std::floor(value.toNumber())!=value.toNumber())return 0;
      return uint64_t(value.toNumber());
    };
    if(!std::strcmp(name,"fieldAllocatePointer")){
      if(!args.get(1).isInt32()||args[1].toInt32()<0){JS_ReportErrorASCII(cx,"Pointer control requires nonnegative int32 payload");return false;}
      const auto id=counters->next++;counters->fieldPointers.emplace(id,std::make_unique<uint64_t>(uint64_t(args[1].toInt32())));args.rval().setNumber(double(id));return true;
    }
    if(!std::strcmp(name,"fieldReleasePointer")){
      if(counters->fieldPointers.erase(token(args.get(1)))!=1){JS_ReportErrorASCII(cx,"Unknown pointer owner token");return false;}return true;
    }
    if(!std::strcmp(name,"fieldNewObject")){
      if(!args.get(1).isInt32()||args[1].toInt32()<0){JS_ReportErrorASCII(cx,"Object field count requires nonnegative int32");return false;}
      auto value=api::ObjectTemplate::New(&state->isolate,{});value->SetInternalFieldCount(args[1].toInt32());
      api::Local<api::Object> object;if(!value->NewInstance(state->isolate.GetCurrentContext()).ToLocal(&object))return false;args.rval().set(api::Input(object));return true;
    }
    if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"Internal field control requires Object");return false;}
    auto object=frame.Own<api::Object>(args[1]);
    if(!std::strcmp(name,"fieldCount")){args.rval().setInt32(object->InternalFieldCount());return true;}
    if(!args.get(2).isInt32()||args[2].toInt32()<0||args[2].toInt32()>=object->InternalFieldCount()){JS_ReportErrorASCII(cx,"Invalid internal field index");return false;}
    const int index=args[2].toInt32();
    if(!std::strcmp(name,"fieldSet")){object->SetInternalField(index,frame.OwnValue(args.get(3)));return true;}
    if(!std::strcmp(name,"fieldSetPrivate")){object->SetInternalField(index,state->environment.empty_context_frame_sentinel_symbol());return !JS_IsExceptionPending(cx);}
    if(!std::strcmp(name,"fieldSetObjectTemplate")){
      auto value=api::ObjectTemplate::New(&state->isolate,{});auto key=api::String::NewFromUtf8(&state->isolate,"stored",api::NewStringType::kNormal,-1).ToLocalChecked();
      value->Set(key,frame.OwnValue(args.get(3)));object->SetInternalField(index,value);return true;
    }
    if(!std::strcmp(name,"fieldSetTemplate")||!std::strcmp(name,"fieldSetSignature")){
      auto found=counters->templates.find(token(args.get(3)));if(found==counters->templates.end()){JS_ReportErrorASCII(cx,"Unknown field template token");return false;}
      auto value=found->second.Get(&state->isolate);
      if(!std::strcmp(name,"fieldSetSignature"))object->SetInternalField(index,api::Signature::New(&state->isolate,value));else object->SetInternalField(index,value);return true;
    }
    if(!std::strncmp(name,"fieldPointer",12)){
      if(!args.get(4).isInt32()||args[4].toInt32()<0||args[4].toInt32()>2){JS_ReportErrorASCII(cx,"Pointer tag control requires0,1or2");return false;}
      auto tag=static_cast<api::EmbedderDataTag>(args[4].toInt32());
      if(!std::strcmp(name,"fieldPointerSet")){
        void* pointer=nullptr;
        if(!args.get(3).isNull()){auto found=counters->fieldPointers.find(token(args.get(3)));if(found==counters->fieldPointers.end()){JS_ReportErrorASCII(cx,"Unknown field pointer token");return false;}pointer=found->second.get();}
        object->SetAlignedPointerInInternalField(index,pointer,tag);return true;
      }
      auto* pointer=static_cast<uint64_t*>(object->GetAlignedPointerFromInternalField(index,tag));
      if(!std::strcmp(name,"fieldPointerGet")){if(pointer)args.rval().setNumber(double(*pointer));else args.rval().setNull();return true;}
      if(!std::strcmp(name,"fieldPointerWrite")&&pointer&&args.get(3).isInt32()&&args[3].toInt32()>=0){*pointer=uint64_t(args[3].toInt32());return true;}
      JS_ReportErrorASCII(cx,"Unknown pointer field operation");return false;
    }
    auto data=object->GetInternalField(index);if(data.IsEmpty())return false;
    if(!std::strcmp(name,"fieldGet")){CHECK(data->IsValue());args.rval().set(api::Input(data));return true;}
    if(!std::strcmp(name,"fieldPrivateIdentity")){args.rval().setBoolean(data->IsPrivate()&&api::SameLocal(data.operator->(),state->environment.empty_context_frame_sentinel_symbol().operator->()));return !JS_IsExceptionPending(cx);}
    if(!std::strcmp(name,"fieldGetFunction")){
      CHECK(!data->IsValue()&&!data->IsPrivate());api::Local<api::Function> function;
      if(!data.As<api::FunctionTemplate>()->GetFunction(state->isolate.GetCurrentContext()).ToLocal(&function))return false;args.rval().set(api::Input(function));return true;
    }
    if(!std::strcmp(name,"fieldGetObject")){
      CHECK(!data->IsValue()&&!data->IsPrivate());api::Local<api::Object> value;
      if(!data.As<api::ObjectTemplate>()->NewInstance(state->isolate.GetCurrentContext()).ToLocal(&value))return false;args.rval().set(api::Input(value));return true;
    }
    if(!std::strcmp(name,"fieldGetSignedFunction")){
      CHECK(!data->IsValue()&&!data->IsPrivate());
      auto callback=[](const api::FunctionCallbackInfo<api::Value>& call){auto* isolate=call.GetIsolate();auto key=api::String::NewFromUtf8(isolate,"payload",api::NewStringType::kNormal,-1).ToLocalChecked();api::Local<api::Value> value;if(call.This()->Get(isolate->GetCurrentContext(),key).ToLocal(&value))call.GetReturnValue().Set(value);};
      auto value=api::FunctionTemplate::New(&state->isolate,callback,{},data.As<api::Signature>(),0,api::ConstructorBehavior::kThrow);api::Local<api::Function> function;
      if(!value->GetFunction(state->isolate.GetCurrentContext()).ToLocal(&function))return false;args.rval().set(api::Input(function));return true;
    }
    JS_ReportErrorASCII(cx,"Unknown internal field operation");return false;
  }
  if(!std::strcmp(operation.get(),"objectHas")){
    if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"Native property existence control requires Object");return false;}
    auto object=frame.Own<api::Object>(args[1]);bool found;
    if(!object->Has(state->isolate.GetCurrentContext(),frame.OwnValue(args.get(2))).To(&found))return false;
    args.rval().setBoolean(found);return true;
  }
  if(!std::strcmp(operation.get(),"handleNullRef")){
    args.rval().setBoolean(native::HandleWrap::HasRef(static_cast<const native::HandleWrap*>(nullptr)));return true;
  }
  if(!std::strcmp(operation.get(),"classCacheSet")||!std::strcmp(operation.get(),"classCacheGet")){
    if(!args.get(1).isString()){JS_ReportErrorASCII(cx,"Class cache control requires a cache name");return false;}
    JS::RootedString key(cx,args[1].toString());bool handle;
    if(!JS_StringEqualsAscii(cx,key,"handle",&handle))return false;
    if(!handle){bool async;if(!JS_StringEqualsAscii(cx,key,"async",&async))return false;if(!async){JS_ReportErrorASCII(cx,"Unknown class cache control");return false;}}
    auto* data=state->environment.isolate_data();api::Local<api::FunctionTemplate> value;
    if(!std::strcmp(operation.get(),"classCacheSet")){
      if(!args.get(2).isUndefined()){
        const double token=args[2].isNumber()?args[2].toNumber():0;
        if(!std::isfinite(token)||token<1||token>9007199254740991.0||std::floor(token)!=token){JS_ReportErrorASCII(cx,"Invalid cache template token");return false;}
        auto it=counters->templates.find(uint64_t(token));if(it==counters->templates.end()){JS_ReportErrorASCII(cx,"Unknown cache template token");return false;}
        value=it->second.Get(&state->isolate);
      }
      if(handle)data->set_handle_wrap_ctor_template(value);else data->set_async_wrap_ctor_template(value);return true;
    }
    value=handle?data->handle_wrap_ctor_template():data->async_wrap_ctor_template();if(value.IsEmpty())return true;
    auto context=state->isolate.GetCurrentContext();
    if(args.get(2).isObject()){
      JS::RootedObject global(cx,api::UnwrapObject(cx,args[2]));if(!global||!JS_IsGlobalObject(global)){JS_ReportErrorASCII(cx,"Cache context control requires a global");return false;}context=frame.OwnContext(global);
    }
    api::Local<api::Function> function;if(!value->GetFunction(context).ToLocal(&function))return false;
    args.rval().set(api::Input(function));return JS_WrapValue(cx,args.rval());
  }
  if(!std::strncmp(operation.get(),"value",5)){
    auto value=frame.OwnValue(args.get(1));api::Local<api::String> result;
    if(!std::strcmp(operation.get(),"valueType"))result=value->TypeOf(&state->isolate);
    else if(!std::strcmp(operation.get(),"valueDetail")){if(!value->ToDetailString(state->isolate.GetCurrentContext()).ToLocal(&result))return false;}
    else if(!std::strcmp(operation.get(),"valueJSON")){if(!api::JSON::Stringify(state->isolate.GetCurrentContext(),value).ToLocal(&result))return false;}
    else {JS_ReportErrorASCII(cx,"Unknown native value control");return false;}
    if(result.IsEmpty()||JS_IsExceptionPending(cx))return false;args.rval().set(api::Input(result));return true;
  }
  if(!std::strcmp(operation.get(),"constructorName")||!std::strcmp(operation.get(),"constructorDescription")){
    if(!std::strcmp(operation.get(),"constructorDescription")){
      auto text=native::DetermineSpecificErrorType(&state->environment,frame.OwnValue(args.get(1)));if(JS_IsExceptionPending(cx))return false;
      auto name=api::String::NewFromUtf8(&state->isolate,text.data(),api::NewStringType::kNormal,int(text.size()));
      api::Local<api::String> result;if(!name.ToLocal(&result))return false;args.rval().set(api::Input(result));return true;
    }
    if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"Native constructor-name control requires Object");return false;}
    auto object=frame.Own<api::Object>(args[1]);
    auto name=object->GetConstructorName();if(name.IsEmpty()||JS_IsExceptionPending(cx))return false;
    args.rval().set(api::Input(name));return true;
  }
  if(!std::strcmp(operation.get(),"constructionIdentity")){
    JS::RootedObject object(cx,api::UnwrapObject(cx,args.get(1)));if(!object)return false;
    JS::RootedObject constructor(cx,js::ObjectRealm::get(object).getConstructorIdentity(object));
    if(constructor){if(!JS_WrapObject(cx,&constructor))return false;args.rval().setObject(*constructor);}
    return true;
  }
  if(!std::strncmp(operation.get(),"isolate",7)){
    auto* data=state->environment.isolate_data();
    if(!counters->observedIsolateData)counters->observedIsolateData=data;
    auto options=data->options();if(!options)return false;
    if(!std::strcmp(operation.get(),"isolateHoldOptions")){counters->retainedIsolateOptions=options;return true;}
    if(!std::strcmp(operation.get(),"isolateClearOptions")){counters->retainedIsolateOptions.reset();return true;}
    JS::RootedValue callbackResult(cx);bool replaced=false,beforeReport=options->report_uncaught_exception,foreignRestored=true;
    if(!std::strcmp(operation.get(),"isolateCallOptions")){
      if(!args.get(1).isObject()||!JS::IsCallable(&args[1].toObject())){JS_ReportErrorASCII(cx,"Isolate options control requires Function");return false;}
      auto callback=frame.Own<api::Function>(args[1]);api::Local<api::Value> result;
      if(!callback->Call(state->environment.context(),api::Undefined(&state->isolate),0,nullptr).ToLocal(&result))return false;
      callbackResult.set(api::Input(result));auto next=data->options();if(!next)return false;
      replaced=next!=options;beforeReport=options->report_uncaught_exception;options=std::move(next);
    }else if(!std::strcmp(operation.get(),"isolateOptionsLocked")){
      native::Mutex::ScopedLock lock(native::per_process::cli_options_mutex);
      options=data->options();if(!options)return false;
      auto environmentOptions=state->environment.options();if(!environmentOptions)return false;
      CHECK(environmentOptions==options->per_env);
    }else if(!std::strcmp(operation.get(),"isolateOptionsForeign")){
      JS::RootedObject target(cx,api::UnwrapObject(cx,args.get(1)));if(!target||!JS_IsGlobalObject(target)){JS_ReportErrorASCII(cx,"Isolate options context control requires global");return false;}
      {JSAutoRealm active(cx,target);options=data->options();if(!options)return false;foreignRestored=JS::CurrentGlobalOrNull(cx)==target;}
    }else if(std::strcmp(operation.get(),"isolateOptions")){JS_ReportErrorASCII(cx,"Unknown isolate options control");return false;}
    auto environmentOptions=state->environment.options();if(!environmentOptions)return false;
    auto parsed=kandelo::node::BorrowNativeIsolateOptions(cx,realm);if(!parsed)return false;
    JS::RootedObject result(cx,JS_NewPlainObject(cx));if(!result)return false;
    auto flag=[&](const char* name,bool input){JS::RootedValue value(cx,JS::BooleanValue(input));return JS_DefineProperty(cx,result,name,value,JSPROP_ENUMERATE);};
    if(!flag("canonicalIsolateData",data==&state->isolateData)||!flag("stableIdentity",data==counters->observedIsolateData)||
       !flag("sameIsolate",data->isolate()==&state->isolate)||!flag("sameParsedOwner",options==parsed)||
       !flag("sameEnvironmentOwner",environmentOptions==options->per_env)||!flag("sameProcessStorage",&native::per_process::cli_options==&kandelo_node_options_impl::per_process::cli_options)||
       !flag("sameFatalProcessStorage",&native::per_process::fatal_cli_options==&kandelo_node_options_impl::per_process::cli_options)||
       !flag("sameOptionsMutex",&native::per_process::cli_options_mutex==&kandelo_node_options_impl::per_process::cli_options_mutex)||
       !flag("reportUncaught",options->report_uncaught_exception)||!flag("zeroFill",native::per_process::cli_options->zero_fill_all_buffers)||
       !flag("pendingDeprecation",environmentOptions->pending_deprecation)||!flag("reportOnFatal",native::per_process::fatal_cli_options->report_on_fatalerror)||
       !flag("hasRetained",bool(counters->retainedIsolateOptions))||!flag("retainedSame",counters->retainedIsolateOptions==options)||
       !flag("foreignRestored",foreignRestored)||!flag("replacedDuringCallback",replaced)||!flag("beforeReport",beforeReport))return false;
    JS::RootedValue retained(cx,counters->retainedIsolateOptions?JS::BooleanValue(counters->retainedIsolateOptions->report_uncaught_exception):JS::UndefinedValue());
    if(!JS_DefineProperty(cx,result,"retainedReport",retained,JSPROP_ENUMERATE)||!JS_DefineProperty(cx,result,"callbackResult",callbackResult,JSPROP_ENUMERATE))return false;
    args.rval().setObject(*result);return true;
  }
  if(!std::strcmp(operation.get(),"internalsBuffer")){
    if(!args.get(1).isInt32()||args[1].toInt32()<0||args[1].toInt32()>4){JS_ReportErrorASCII(cx,"Original internals buffer control requires mode 0..4");return false;}
    int mode=args[1].toInt32();
    auto check=[&]<class T>(){
      native::MaybeStackBuffer<T> source;
      size_t length=mode==1?4097:(mode==3?0:(mode==4?2:7));
      if(mode==2)source.Invalidate();
      else {
        source.AllocateSufficientStorage(length);source.SetLength(length);
        for(size_t i=0;i<length;++i)source.out()[i]=T((i*17+3)%256);
        if(mode==0){const unsigned char bytes[]={97,0,98,255,99,10,100};for(size_t i=0;i<length;++i)source.out()[i]=T(bytes[i]);}
        if(mode==4){source.out()[0]=T(0x3bb);source.out()[1]=T(0);}
      }
      const void* original=source.out();api::Local<api::Object> buffer;
      bool hasBuffer=native::Buffer::New(&state->environment,&source).ToLocal(&buffer);
      if(JS_IsExceptionPending(cx))return false;
      bool same=false;
      if(hasBuffer){
        JS::RootedObject view(cx,&api::Input(buffer).toObject());
        JS::AutoCheckCannotGC nogc;bool shared;
        same=JS_GetArrayBufferViewData(view,&shared,nogc)==original;
      }
      JS::RootedObject result(cx,JS_NewPlainObject(cx));if(!result)return false;
      JS::RootedValue value(cx,hasBuffer?api::Input(buffer).get():JS::UndefinedValue());
      if(!JS_DefineProperty(cx,result,"buffer",value,JSPROP_ENUMERATE))return false;
      value.setBoolean(same);if(!JS_DefineProperty(cx,result,"samePointer",value,JSPROP_ENUMERATE))return false;
      value.setBoolean(source.IsAllocated());if(!JS_DefineProperty(cx,result,"sourceAllocated",value,JSPROP_ENUMERATE))return false;
      value.setBoolean(source.IsInvalidated());if(!JS_DefineProperty(cx,result,"sourceInvalidated",value,JSPROP_ENUMERATE))return false;
      value.setNumber(double(source.length()));if(!JS_DefineProperty(cx,result,"sourceLength",value,JSPROP_ENUMERATE))return false;
      if(!source.IsInvalidated())source.out()[0]=T(0xee);
      args.rval().setObject(*result);return true;
    };
    return mode==4?check.template operator()<char16_t>():check.template operator()<char>();
  }
  if(!std::strcmp(operation.get(),"errorKind")){
    args.rval().setBoolean(frame.OwnValue(args.get(1))->IsNativeError());return true;
  }
  if(!std::strcmp(operation.get(),"nativeLiteral")){
    auto value=api::String::NewFromUtf8Literal(&state->isolate,"a\0λ");
    args.rval().set(api::Input(value));return true;
  }
  if(!std::strncmp(operation.get(),"private",7)){
    auto* isolate=&state->isolate;auto* environment=&state->environment;
    api::Local<api::Private> key=environment->arrow_message_private_symbol();
    CHECK(key->IsPrivate()&&!key->IsValue());
    if(!std::strcmp(operation.get(),"privateRoot")){
      api::Global<api::Private> retained;
      {api::HandleScope scope(isolate);retained.Reset(isolate,environment->decorated_private_symbol());}
      isolate->LowMemoryNotification();auto local=retained.Get(isolate);CHECK(local->IsPrivate()&&!local->IsValue());
      args.rval().set(api::Input(local->Name()));return true;
    }
    if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"Native private control requires Object");return false;}
    auto object=frame.Own<api::Object>(args[1]);auto context=isolate->GetCurrentContext();
    if(!std::strcmp(operation.get(),"privateSet")){
      auto result=object->SetPrivate(context,key,frame.OwnValue(args.get(2)));if(result.IsNothing())return false;args.rval().setBoolean(result.FromJust());return true;
    }
    if(!std::strcmp(operation.get(),"privateGet")){
      api::Local<api::Value> result;if(!object->GetPrivate(context,key).ToLocal(&result))return false;args.rval().set(api::Input(result));return true;
    }
    JS_ReportErrorASCII(cx,"Unknown native private operation");return false;
  }
  if(!std::strcmp(operation.get(),"fatalSet")){
    auto* realm=state->environment.principal_realm();CHECK(realm);
    api::Local<api::Function> before,after;
    for(size_t index=1;index<=2;++index)if(!args.get(index).isUndefined()&&(!args[index].isObject()||!JS::IsCallable(&args[index].toObject()))){JS_ReportErrorASCII(cx,"Fatal callback control requires functions or undefined");return false;}
    if(!args.get(1).isUndefined())before=frame.Own<api::Function>(args[1]);
    if(!args.get(2).isUndefined())after=frame.Own<api::Function>(args[2]);
    realm->set_enhance_fatal_stack_before_inspector(before);realm->set_enhance_fatal_stack_after_inspector(after);return true;
  }
  if(!std::strcmp(operation.get(),"fatalBefore")||!std::strcmp(operation.get(),"fatalAfter")){
    JS::RootedObject target(cx,JS::CurrentGlobalOrNull(cx));
    if(args.get(1).isObject()){target=api::UnwrapObject(cx,args[1]);if(!target||!JS_IsGlobalObject(target)){JS_ReportErrorASCII(cx,"Fatal callback context control requires global");return false;}}
    JS::RootedValue result(cx);
    {JSAutoRealm active(cx,target);auto callback=!std::strcmp(operation.get(),"fatalBefore")?state->environment.enhance_fatal_stack_before_inspector():state->environment.enhance_fatal_stack_after_inspector();if(!callback.IsEmpty())result.set(api::Input(callback));}
    if(!JS_WrapValue(cx,&result))return false;args.rval().set(result);return true;
  }
  if(!std::strcmp(operation.get(),"sourceSet")||!std::strcmp(operation.get(),"sourceGet")||!std::strcmp(operation.get(),"sourceCall")){
    const bool cache=args.get(1).isTrue();auto* environment=&state->environment;
    if(!std::strcmp(operation.get(),"sourceSet")){
      api::Local<api::Function> callback;
      if(!args.get(2).isUndefined()){
        if(!args.get(2).isObject()||!JS::IsCallable(&args[2].toObject())){JS_ReportErrorASCII(cx,"Source callback control requires Function or undefined");return false;}
        callback=frame.Own<api::Function>(args[2]);
      }
      if(cache)environment->set_maybe_cache_generated_source_map(callback);else environment->set_get_source_map_error_source(callback);return true;
    }
    auto callback=cache?environment->maybe_cache_generated_source_map():environment->get_source_map_error_source();
    if(!std::strcmp(operation.get(),"sourceGet")){if(!callback.IsEmpty())args.rval().set(api::Input(callback));return true;}
    if(callback.IsEmpty()){JS_ReportErrorASCII(cx,"Native source callback is not registered");return false;}
    api::Local<api::Value> input=frame.OwnValue(args.get(2)),output;
    if(!callback->Call(environment->context(),api::Undefined(&state->isolate),1,&input).ToLocal(&output))return false;
    args.rval().set(api::Input(output));return true;
  }
  if(!std::strcmp(operation.get(),"errorFlags")){
    auto* environment=&state->environment;
    if(args.get(1).isBoolean())environment->set_printed_error(args[1].toBoolean());
    if(args.get(2).isBoolean())environment->set_source_maps_enabled(args[2].toBoolean());
    JS::RootedObject output(cx,JS_NewPlainObject(cx));if(!output)return false;
    JS::RootedValue printed(cx,JS::BooleanValue(environment->printed_error())),maps(cx,JS::BooleanValue(environment->source_maps_enabled()));
    if(!JS_DefineProperty(cx,output,"printed",printed,JSPROP_ENUMERATE)||!JS_DefineProperty(cx,output,"sourceMaps",maps,JSPROP_ENUMERATE))return false;
    args.rval().setObject(*output);return true;
  }
  if(!std::strcmp(operation.get(),"message")){
    auto* isolate=&state->isolate;api::Local<api::Message> message;
    std::unique_ptr<api::TryCatch> catcher;
    if(args.get(2).isTrue()){
      if(!args.get(1).isObject()||!JS::IsCallable(&args[1].toObject())){JS_ReportErrorASCII(cx,"Native message catch control requires Function");return false;}
      catcher=std::make_unique<api::TryCatch>(isolate);
      auto callback=frame.Own<api::Function>(args[1]);
      USE(callback->Call(isolate->GetCurrentContext(),api::Undefined(isolate),0,nullptr));
      if(!catcher->HasCaught()){JS_ReportErrorASCII(cx,"Native message control did not catch an exception");return false;}
      message=catcher->Message();
    }else message=api::Exception::CreateMessage(isolate,frame.OwnValue(args.get(1)));
    if(message.IsEmpty())return false;
    CHECK(!message->IsValue()&&!message->IsPrivate());
    JS::RootedObject output(cx,JS_NewPlainObject(cx));if(!output)return false;
    auto put=[&](const char* key,api::Local<api::Value> input){JS::RootedValue value(cx,api::Input(input));return JS_DefineProperty(cx,output,key,value,JSPROP_ENUMERATE);};
    api::Local<api::String> sourceLine;
    const bool hasSource=message->GetSourceLine(isolate->GetCurrentContext()).ToLocal(&sourceLine);
    JS::RootedValue hasSourceValue(cx,JS::BooleanValue(hasSource));
    auto origin=message->GetScriptOrigin();
    if(!put("text",message->Get())||!put("resource",message->GetScriptResourceName())||
       !put("origin",origin.ResourceName())||!put("sourceMap",origin.SourceMapUrl())||
       !JS_DefineProperty(cx,output,"line",message->GetLineNumber(isolate->GetCurrentContext()).FromJust(),JSPROP_ENUMERATE)||
       !JS_DefineProperty(cx,output,"startColumn",message->GetStartColumn(),JSPROP_ENUMERATE)||
       !JS_DefineProperty(cx,output,"endColumn",message->GetEndColumn(),JSPROP_ENUMERATE)||
       !JS_DefineProperty(cx,output,"lineOffset",origin.LineOffset(),JSPROP_ENUMERATE)||
       !JS_DefineProperty(cx,output,"columnOffset",origin.ColumnOffset(),JSPROP_ENUMERATE)||
       !JS_DefineProperty(cx,output,"frames",message->GetStackTrace()->GetFrameCount(),JSPROP_ENUMERATE)||
       !JS_DefineProperty(cx,output,"hasSource",hasSourceValue,JSPROP_ENUMERATE)||
       (hasSource&&!put("source",sourceLine)))return false;
    if(catcher)catcher->Reset();args.rval().setObject(*output);return true;
  }
  if(!std::strcmp(operation.get(),"stackFrames")){
    const auto count=args.get(1);
    if(!count.isInt32()||count.toInt32()<0){JS_ReportErrorASCII(cx,"Native stack control requires nonnegative Int32 frame count");return false;}
    auto* isolate=&state->isolate;api::Local<api::StackTrace> stack;
    if(!native::GetCurrentStackTrace(isolate,count.toInt32()).ToLocal(&stack))return false;
    if(args.get(2).isTrue())native::PrintStackTrace(isolate,stack);
    JS::RootedObject output(cx,JS::NewArrayObject(cx,0));if(!output)return false;
    for(int index=0;index<stack->GetFrameCount();++index){
      auto saved=stack->GetFrame(isolate,index);JS::RootedObject item(cx,JS_NewPlainObject(cx));if(!item)return false;
      JS::RootedValue name(cx,api::Input(saved->GetFunctionName())),source(cx,api::Input(saved->GetScriptName()));
      JS::RootedValue isEval(cx,JS::BooleanValue(saved->IsEval()));
      if(!JS_DefineProperty(cx,item,"name",name,JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,item,"source",source,JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,item,"line",saved->GetLineNumber(),JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,item,"column",saved->GetColumn(),JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,item,"eval",isEval,JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,item,"scriptId",saved->GetScriptId(),JSPROP_ENUMERATE))return false;
      JS::RootedValue value(cx,JS::ObjectValue(*item));if(!JS_SetElement(cx,output,uint32_t(index),value))return false;
    }
    args.rval().setObject(*output);return true;
  }
  if(!std::strcmp(operation.get(),"templateCreate")){
    auto* isolate=&state->isolate;api::HandleScope scope(isolate);
    auto construct=[](const api::FunctionCallbackInfo<api::Value>& input){
      auto* isolate=input.GetIsolate();auto context=isolate->GetCurrentContext();
      auto name=api::String::NewFromUtf8(isolate,"payload",api::NewStringType::kNormal,-1).ToLocalChecked();
      if(!input.This()->Set(context,name,input.Data()).IsNothing())input.GetReturnValue().Set(input.This());
    };
    auto read=[](const api::FunctionCallbackInfo<api::Value>& input){
      auto* isolate=input.GetIsolate();auto name=api::String::NewFromUtf8(isolate,"payload",api::NewStringType::kNormal,-1).ToLocalChecked();
      api::Local<api::Value> value;if(input.This()->Get(isolate->GetCurrentContext(),name).ToLocal(&value))input.GetReturnValue().Set(value);
    };
    auto echo=[](const api::FunctionCallbackInfo<api::Value>& input){input.GetReturnValue().Set(input[0]);};
    auto value=api::FunctionTemplate::New(isolate,construct,frame.OwnValue(args.get(1)),{},2);
    value->SetClassName(api::String::NewFromUtf8(isolate,"NativeTemplateProbe",api::NewStringType::kNormal,-1).ToLocalChecked());
    native::SetProtoMethod(isolate,value,"read",read);native::SetMethod(isolate,value,"echo",echo);
    auto signature=api::Signature::New(isolate,value);CHECK(!value->IsValue()&&!signature->IsValue()&&!value->InstanceTemplate()->IsValue());
    const auto token=counters->next++;counters->templates.emplace(token,api::Global<api::FunctionTemplate>(isolate,value));
    args.rval().setNumber(double(token));return true;
  }
  if(!std::strncmp(operation.get(),"template",8)){
    const double token=args.get(1).isNumber()?args[1].toNumber():0;
    if(!std::isfinite(token)||token<1||token>9007199254740991.0||std::floor(token)!=token){JS_ReportErrorASCII(cx,"Invalid template control token");return false;}
    auto it=counters->templates.find(uint64_t(token));if(it==counters->templates.end()){JS_ReportErrorASCII(cx,"Unknown template control token");return false;}
    if(!std::strcmp(operation.get(),"templateDrop")){counters->templates.erase(it);return true;}
    if(std::strcmp(operation.get(),"templateGet")){JS_ReportErrorASCII(cx,"Unknown template control operation");return false;}
    auto value=native::PersistentToLocal::Strong(it->second);
    CHECK(!value->IsValue()&&!value->IsPrivate());
    auto context=state->isolate.GetCurrentContext();
    if(args.get(2).isObject()){
      JS::RootedObject global(cx,api::UnwrapObject(cx,args[2]));
      if(!global||!JS_IsGlobalObject(global)){JS_ReportErrorASCII(cx,"Template context control requires a global");return false;}
      context=frame.OwnContext(global);
    }
    api::Local<api::Function> function;if(!value->GetFunction(context).ToLocal(&function))return false;
    args.rval().set(api::Input(function));return JS_WrapValue(cx,args.rval());
  }
  if(!std::strcmp(operation.get(),"persistentCreate")) {
    const auto token=counters->next++;
    counters->persistents.emplace(token,api::Global<api::Value>(&state->isolate,frame.OwnValue(args.get(1))));
    args.rval().setNumber(double(token));return true;
  }
  if(!std::strncmp(operation.get(),"persistent",10)) {
    const double token=args.get(1).isNumber()?args[1].toNumber():0;
    if(!std::isfinite(token)||token<1||token>9007199254740991.0||std::floor(token)!=token) {
      JS_ReportErrorASCII(cx,"Invalid persistent control token");return false;
    }
    auto it=counters->persistents.find(uint64_t(token));
    if(it==counters->persistents.end()){JS_ReportErrorASCII(cx,"Unknown persistent control token");return false;}
    auto& root=it->second;
    if(!std::strcmp(operation.get(),"persistentDrop")){counters->persistents.erase(it);return true;}
    if(!std::strcmp(operation.get(),"persistentMove")) {
      api::Global<api::Value> moved(std::move(root));CHECK(root.IsEmpty());
      root=std::move(moved);CHECK(moved.IsEmpty());root=std::move(root);return true;
    }
    if(!std::strcmp(operation.get(),"persistentWeak")){root.SetWeak();return true;}
    if(!std::strcmp(operation.get(),"persistentStrong")){root.ClearWeak();return true;}
    if(!std::strcmp(operation.get(),"persistentEmpty")){args.rval().setBoolean(root.IsEmpty());return true;}
    auto value=api::Local<api::Value>::New(&state->isolate,root);
    if(!std::strcmp(operation.get(),"persistentGet")) {
      if(!value.IsEmpty())args.rval().set(api::Input(value));return true;
    }
    if(!std::strcmp(operation.get(),"persistentCall")) {
      if(value.IsEmpty()||!value->IsFunction()){JS_ReportErrorASCII(cx,"Persistent control target is not callable");return false;}
      auto result=value.As<api::Function>()->Call(state->isolate.GetCurrentContext(),api::Undefined(&state->isolate),0,nullptr);
      api::Local<api::Value> output;if(!result.ToLocal(&output))return false;
      args.rval().set(api::Input(output));return true;
    }
    JS_ReportErrorASCII(cx,"Unknown persistent control operation");return false;
  }
  if(!std::strcmp(operation.get(),"errorFactory")) {
    if(!args.get(1).isString()||!args.get(2).isString()) {
      JS_ReportErrorASCII(cx,"Native error control requires action and code");return false;
    }
    auto* isolate=&state->isolate;
    native::Utf8Value actionValue(isolate,frame.Own<api::String>(args[1])),codeValue(isolate,frame.Own<api::String>(args[2]));
    auto action=actionValue.ToString(),code=codeValue.ToString();api::Local<api::Value> result;
    if(action=="predefined") {
#define KANDELO_PREDEFINED_ERROR(name,message) if(code==#name)result=native::name(isolate);
      PREDEFINED_ERROR_MESSAGES(KANDELO_PREDEFINED_ERROR)
#undef KANDELO_PREDEFINED_ERROR
      if(code=="ERR_STRING_TOO_LONG")result=native::ERR_STRING_TOO_LONG(isolate);
      if(code=="ERR_BUFFER_TOO_LARGE")result=native::ERR_BUFFER_TOO_LARGE(isolate);
    } else {
      if(!args.get(3).isString()){JS_ReportErrorASCII(cx,"Native error control requires actual message String");return false;}
      auto message=frame.Own<api::String>(args[3]);
      if(action=="intrinsic") {
        if(code=="Error")result=api::Exception::Error(message);
        if(code=="TypeError")result=api::Exception::TypeError(message);
        if(code=="RangeError")result=api::Exception::RangeError(message);
        if(code=="SyntaxError")result=api::Exception::SyntaxError(message);
      } else {
        native::Utf8Value textValue(isolate,message);auto text=textValue.ToString();
        if(action=="create") {
#define KANDELO_CREATE_ERROR(name,type) if(code==#name)result=native::name(isolate,text);
          ERRORS_WITH_CODE(KANDELO_CREATE_ERROR)
#undef KANDELO_CREATE_ERROR
        } else if(action=="throw") {
#define KANDELO_THROW_ERROR(name,type) if(code==#name){native::THROW_##name(isolate,text);return false;}
          ERRORS_WITH_CODE(KANDELO_THROW_ERROR)
#undef KANDELO_THROW_ERROR
        } else if(action=="formatted") {
          if(!args.get(4).isString()){JS_ReportErrorASCII(cx,"Native formatting control requires String argument");return false;}
          native::Utf8Value argument(isolate,frame.Own<api::String>(args[4]));
          result=native::ERR_OUT_OF_RANGE(isolate,text,argument.ToString(),26,26,9,true);
        }
      }
    }
    if(result.IsEmpty()){if(!JS_IsExceptionPending(cx))JS_ReportErrorASCII(cx,"Unknown native error control action/code");return false;}
    args.rval().set(api::Input(result));return !JS_IsExceptionPending(cx);
  }
  if(!std::strcmp(operation.get(),"catch")) {
    if(!args.get(1).isString()||!args.get(2).isObject()||!JS::IsCallable(&args[2].toObject())) {
      JS_ReportErrorASCII(cx,"Native catch control requires mode and Function");return false;
    }
    JS::RootedString modeString(cx,args[1].toString());auto mode=JS_EncodeStringToUTF8(cx,modeString);if(!mode)return false;
    auto* isolate=&state->isolate;auto context=isolate->GetCurrentContext();
    if(!std::strcmp(mode.get(),"verbose")) { api::TryCatch caught(isolate);caught.SetVerbose(true);return false; }
    if(!std::strcmp(mode.get(),"preservePending")) {
      JS::RootedValue prior(cx,args.get(3));JS_SetPendingException(cx,prior);
      {api::TryCatch caught(isolate);USE(frame.Own<api::Function>(args[2])->Call(context,api::Undefined(isolate),0,nullptr));CHECK(caught.HasCaught());}
      return false;
    }
    if(!std::strcmp(mode.get(),"rethrow")) {
      {api::TryCatch caught(isolate);USE(frame.Own<api::Function>(args[2])->Call(context,api::Undefined(isolate),0,nullptr));
       CHECK(caught.HasCaught());CHECK(caught.ReThrow()->IsUndefined());caught.Reset();}
      return false;
    }
    JS::RootedValue result(cx),exception(cx);bool failed=false,caught=false,terminated=false,canContinue=false,innerCaught=false,sameStack=false,resetCaught=false;
    {
      api::TryCatch handler(isolate);CHECK(!handler.IsVerbose());handler.SetVerbose(false);
      if(!std::strcmp(mode.get(),"nested")) {
        JS::RootedObject throwStack(cx);
        {api::TryCatch inner(isolate);
         failed=frame.Own<api::Function>(args[2])->Call(context,api::Undefined(isolate),0,nullptr).IsEmpty();
         innerCaught=inner.HasCaught();throwStack=state->catchScope->stack;
         CHECK(inner.ReThrow()->IsUndefined());inner.Reset();}
        JS::ExceptionStack pending(cx);CHECK(JS_IsExceptionPending(cx));if(!JS::GetPendingExceptionStack(cx,&pending))return false;
        sameStack=throwStack&&throwStack==pending.stack();
      } else {
        {api::HandleScope temporary(isolate);api::Local<api::Value> value;
         failed=!frame.Own<api::Function>(args[2])->Call(context,api::Undefined(isolate),0,nullptr).ToLocal(&value);
         if(!failed) {
           result=api::Input(value);
           if(!std::strcmp(mode.get(),"get")) {
             CHECK(value->IsObject());auto key=api::String::NewFromUtf8(isolate,"owner").ToLocalChecked();
             failed=value.As<api::Object>()->Get(context,key).IsEmpty();
           } else if(!std::strcmp(mode.get(),"number")) {
             failed=value->NumberValue(context).IsNothing();
           }
         }}
        if(!std::strcmp(mode.get(),"reset")) { handler.Reset();resetCaught=handler.HasCaught(); }
        if(args.get(3).isObject()&&JS::IsCallable(&args[3].toObject())) {
          USE(frame.Own<api::Function>(args[3])->Call(context,api::Undefined(isolate),0,nullptr));
        }
      }
      caught=handler.HasCaught();terminated=handler.HasTerminated();canContinue=handler.CanContinue();
      if(terminated) {
        handler.Reset();CHECK(handler.HasTerminated());
        std::fprintf(stdout,"NATIVE_CATCH_TERMINATED:%d:%d:%d\n",caught,terminated,canContinue);return false;
      }
      auto value=handler.Exception();if(!value.IsEmpty())exception=api::Input(value);
      handler.Reset();CHECK(!handler.HasCaught());
    }
    if(JS_IsExceptionPending(cx))return false;
    JS::RootedObject output(cx,JS_NewPlainObject(cx));if(!output)return false;
    if(!JS_DefineProperty(cx,output,"exception",exception,JSPROP_ENUMERATE)||!JS_DefineProperty(cx,output,"result",result,JSPROP_ENUMERATE))return false;
    for(auto [name,value]:std::initializer_list<std::pair<const char*,bool>>{
        {"failed",failed},{"caught",caught},{"terminated",terminated},{"canContinue",canContinue},
        {"innerCaught",innerCaught},{"sameThrowStack",sameStack},{"resetCaught",resetCaught}}) {
      if(!JS_DefineProperty(cx,output,name,value,JSPROP_ENUMERATE))return false;
    }
    args.rval().setObject(*output);return true;
  }
  if(!std::strcmp(operation.get(),"number")){
    auto value=frame.OwnValue(args.get(1))->NumberValue(state->isolate.GetCurrentContext());
    if(value.IsNothing())return false;args.rval().setNumber(value.FromJust());return true;
  }
  if(!std::strcmp(operation.get(),"symbols")){
    JS::RootedObject result(cx,JS_NewPlainObject(cx));if(!result)return false;
    auto owner=state->environment.owner_symbol(),resource=state->environment.resource_symbol();
    if(owner.IsEmpty()||resource.IsEmpty())return false;
    JS::RootedValue ownerKey(cx,api::Input(owner)),resourceKey(cx,api::Input(resource));
    if(!JS_DefineProperty(cx,result,"owner",ownerKey,JSPROP_ENUMERATE)||!JS_DefineProperty(cx,result,"resource",resourceKey,JSPROP_ENUMERATE))return false;
    args.rval().setObject(*result);return true;
  }
  if(!std::strcmp(operation.get(),"inspect")){
    JS::RootedObject result(cx,JS_NewPlainObject(cx));if(!result)return false;
    for(auto [key,value]:std::initializer_list<std::pair<const char*,uint64_t>>{
      {"objects",counters->objects.size()},{"references",counters->references.size()},
      {"created",counters->created},{"destroyed",counters->destroyed},
      {"closeRequests",counters->closeRequests},{"closed",counters->closed},
      {"retiredBeforeDestructor",counters->retired},{"callbacks",counters->callbacks},
      {"weakRecords",state->weakGlobals.size()}}){
      JS::RootedValue valueRoot(cx,JS::NumberValue(double(value)));
      if(!JS_DefineProperty(cx,result,key,valueRoot,JSPROP_ENUMERATE))return false;
    }
    JS::RootedValue diagnostic(cx,JS::BooleanValue(true));
    if(!JS_DefineProperty(cx,result,"diagnosticBuild",diagnostic,JSPROP_ENUMERATE))return false;
    args.rval().setObject(*result);return true;
  }
  if(!std::strcmp(operation.get(),"create")){
    JS::RootedObject object(cx,JS_NewObject(cx,&native::nativeBindingClass));if(!object)return false;
    JS::RootedValue value(cx,JS::ObjectValue(*object));
    auto* nativeRealm=native::Realm::GetCurrent(state->isolate.GetCurrentContext());if(!nativeRealm)return false;
    auto* owner=new native::NativeOwnerProbe(nativeRealm,frame.Own<api::Object>(value),counters);
    if(args.get(1).isTrue()){
      int error=owner->Open();if(error){owner->RetireWrapper();delete owner;JS_ReportErrorASCII(cx,"Actual uv_async_init failed: %s",uv_strerror(error));return false;}
    }
    owner->MakeWeak();args.rval().set(value);return !JS_IsExceptionPending(cx);
  }
  if(!std::strcmp(operation.get(),"release")){
    if(!args.get(1).isNumber()){JS_ReportErrorASCII(cx,"Native owner reference requires numeric token");return false;}
    double token=args[1].toNumber();
    if(!std::isfinite(token)||token<1||token>9007199254740991.0||std::floor(token)!=token){JS_ReportErrorASCII(cx,"Invalid native owner reference token");return false;}
    auto it=counters->references.find(uint64_t(token));
    if(it==counters->references.end()){JS_ReportErrorASCII(cx,"Unknown native owner reference");return false;}
    // Remove membership before running a destructor which may call back into
    // this control and create/release another real reference.
    auto reference=std::move(it->second);counters->references.erase(it);reference.reset();
    return !JS_IsExceptionPending(cx);
  }
  if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"Native owner probe requires actual wrapper");return false;}
  JS::RootedValue input(cx,args[1]);auto* object=native::BaseObject::UnwrapNativeBinding(frame.Own<api::Object>(input));
  if(!std::strcmp(operation.get(),"alive")){args.rval().setBoolean(object&&counters->objects.contains(object));return true;}
  if(!object||!counters->objects.contains(object)){JS_ReportErrorASCII(cx,"Native owner wrapper is retired or foreign");return false;}
  auto* owner=static_cast<native::NativeOwnerProbe*>(object);
  if(!std::strcmp(operation.get(),"hold")){
    const auto token=counters->next++;counters->references.emplace(token,native::BaseObjectPtr<native::BaseObject>(owner));
    args.rval().setNumber(double(token));return true;
  }
  if(!std::strcmp(operation.get(),"weak")){owner->MakeWeak();return true;}
  if(!std::strcmp(operation.get(),"strong")){owner->ClearWeak();return true;}
  if(!std::strcmp(operation.get(),"detach")){owner->Detach();return true;}
  if(!std::strcmp(operation.get(),"close")){owner->Close();return true;}
  if(!std::strcmp(operation.get(),"onDestroy")){
    if(!args.get(2).isObject()||!JS::IsCallable(&args[2].toObject())){JS_ReportErrorASCII(cx,"Native destroy observer requires Function");return false;}
    owner->SetDestroyCallback(frame.Own<api::Function>(args[2]));return true;
  }
  JS_ReportErrorASCII(cx,"Unknown native owner operation");return false;
}
}
bool DefineNativeOwnerTestAPI(JSContext* cx,JS::HandleObject target){return JS_DefineFunction(cx,target,"nativeOwners",NativeOwnerControl,2,0);}
}
#else
namespace kandelo::node {
bool DefineNativeOwnerTestAPI(JSContext*,JS::HandleObject){return true;}
}
#endif
#endif
