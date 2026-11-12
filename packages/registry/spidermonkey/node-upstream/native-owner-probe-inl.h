#ifndef KANDELO_NATIVE_OWNER_PROBE_INL_H
#define KANDELO_NATIVE_OWNER_PROBE_INL_H
#ifdef KANDELO_NATIVE_OWNER_PROBE
namespace kandelo_node_codec_api {
struct NativeOwnerProbeState {
  std::set<native::BaseObject*> objects;
  std::map<uint64_t,native::BaseObjectPtr<native::BaseObject>> references;
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
  auto state=api::Data(cx,runtime);if(!state)return false;
  JS::RootedObject realm(cx,GetRuntimePrincipalRealm(cx,runtime));if(!realm)return false;
  realm=js::CheckedUnwrapDynamic(realm,cx,false);if(!realm||!CheckRealmLibraryActive(cx,realm))return false;
  JSAutoRealm home(cx,realm);api::Frame frame(cx,realm,state,&args,api::Domain::Diagnostics);
  if(!state->ownerProbe)state->ownerProbe=std::make_shared<api::NativeOwnerProbeState>();
  auto counters=state->ownerProbe;args.rval().setUndefined();
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
