#ifndef KANDELO_NATIVE_OWNER_PROBE_INL_H
#define KANDELO_NATIVE_OWNER_PROBE_INL_H
#ifdef KANDELO_NATIVE_OWNER_PROBE
namespace kandelo_node_codec_api {
struct NativeOwnerProbeState {
  std::set<native::BaseObject*> objects;
  std::map<uint64_t,native::BaseObjectPtr<native::BaseObject>> references;
  std::map<uint64_t,Global<Value>> persistents;
  std::map<uint64_t,Global<FunctionTemplate>> templates;
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
      if(!JS_DefineProperty(cx,item,"name",name,JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,item,"source",source,JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,item,"line",saved->GetLineNumber(),JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,item,"column",saved->GetColumn(),JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,item,"eval",saved->IsEval(),JSPROP_ENUMERATE)||
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
