#ifndef KANDELO_NATIVE_OWNER_PROBE_INL_H
#define KANDELO_NATIVE_OWNER_PROBE_INL_H
#ifdef KANDELO_NATIVE_OWNER_PROBE
namespace v8 {
struct NativeWeakCallbackProbe {
  Isolate* isolate;
  Global<Object> handle;
  std::weak_ptr<NativeWeakCallbackProbe> armOnCollect;
  size_t delivered=0;
  bool gcActive=false,frameActive=false;
  explicit NativeWeakCallbackProbe(Isolate* input):isolate(input) {}
  static void Collected(const WeakCallbackInfo<NativeWeakCallbackProbe>& info){
    auto* probe=info.GetParameter();CHECK(probe&&probe->isolate==info.GetIsolate());
    probe->gcActive=JS::RuntimeHeapIsCollecting();probe->frameActive=bool(Frame::current);
    CHECK(probe->handle.IsEmpty());probe->handle.Reset();++probe->delivered;
    if(auto next=probe->armOnCollect.lock();next&&!next->handle.IsEmpty())next->Arm();
  }
  void Arm(){handle.SetWeak(this,Collected,WeakCallbackType::kParameter);}
};
struct NativeDictionaryProbe {
  Global<DictionaryTemplate> schema;
  size_t count;
  NativeDictionaryProbe(Isolate* isolate,Local<DictionaryTemplate> value,size_t size):schema(isolate,value),count(size) {}
};
struct NativeCleanupHookProbe {
  NativeOwnerProbeState* owner;
  native::Environment* environment;
  uint64_t id;
  std::string label;
  enum Action { Record,Remove,Add } action=Record;
  NativeCleanupHookProbe* target=nullptr;
  bool armed=false,print=false;
  NativeCleanupHookProbe(NativeOwnerProbeState* input,native::Environment* env,uint64_t token,std::string name,bool output)
      :owner(input),environment(env),id(token),label(std::move(name)),print(output){}
  ~NativeCleanupHookProbe(){CHECK(!armed);}
  void Register(){CHECK(!armed);environment->AddCleanupHook(Run,this);armed=true;}
  void Unregister(){environment->RemoveCleanupHook(Run,this);armed=false;}
  static void Run(void*);
};
struct NativeOwnerProbeState {
  native::IsolateData* observedIsolateData=nullptr;
  std::shared_ptr<native::FatalIsolateOptions> retainedIsolateOptions;
  std::set<native::BaseObject*> objects;
  std::map<uint64_t,native::BaseObjectPtr<native::BaseObject>> references;
  std::map<uint64_t,native::BaseObjectWeakPtr<native::BaseObject>> weakReferences;
  std::map<uint64_t,Global<Value>> persistents;
  std::map<uint64_t,std::shared_ptr<NativeWeakCallbackProbe>> weakCallbacks;
  std::map<uint64_t,Global<FunctionTemplate>> templates;
  std::map<uint64_t,std::unique_ptr<NativeDictionaryProbe>> dictionaries;
  std::map<uint64_t,std::unique_ptr<NativeCleanupHookProbe>> cleanupHooks;
  std::vector<uint64_t> cleanupObserved;
  std::map<uint64_t,std::unique_ptr<uint64_t>> fieldPointers;
  uint64_t next=1,created=0,destroyed=0,closeRequests=0,closed=0,retired=0,callbacks=0,closedWithoutFrame=0;
};
void NativeCleanupHookProbe::Run(void* input){
  auto& hook=*static_cast<NativeCleanupHookProbe*>(input);hook.environment->AssertForeground();
  auto state=hook.environment->isolate()->owner.lock();CHECK(state&&hook.armed);
  CHECK(state->cx->embedderExecutionRestrictions()&JSContext::EmbedderThrowOnExecution);
  hook.armed=false;hook.owner->cleanupObserved.push_back(hook.id);
  if(hook.print){std::printf("CLEANUP_HOOK:%s\n",hook.label.c_str());std::fflush(stdout);}
  if(hook.action==Remove){CHECK(hook.target);hook.target->Unregister();}
  else if(hook.action==Add){CHECK(hook.target);hook.target->Register();}
}
}
namespace kandelo_node_codec_impl {
class NativeOwnerProbe final:public BaseObject {
  std::shared_ptr<api::NativeOwnerProbeState> counters_;
  uv_async_t handle_{};bool opened_=false,closing_=false;
  api::Global<api::Function> destroyCallback_;
  api::NativeCleanupHookProbe* cleanupOnDestroy_=nullptr;
  static void Closed(uv_handle_t* handle){
    auto* raw=static_cast<NativeOwnerProbe*>(handle->data);
    if(!api::Frame::current)++raw->counters_->closedWithoutFrame;
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
    if(cleanupOnDestroy_)cleanupOnDestroy_->Register();
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
  void SetCleanupOnDestroy(api::NativeCleanupHookProbe* hook){CHECK(hook&&hook->environment==env());cleanupOnDestroy_=hook;}
  void Close(){
    if(!opened_||closing_)return;closing_=true;++counters_->closeRequests;
    uv_close(reinterpret_cast<uv_handle_t*>(&handle_),Closed);
  }
  void OnGCCollect()override{if(opened_)Close();else {RetireBaseObjectWrapper(this);BaseObject::OnGCCollect();}}
  size_t SelfSize()const override{return sizeof(*this);}
  const char* MemoryInfoName()const override{return "NativeOwnerProbe";}
  void MemoryInfo(MemoryTracker*)const override{Crash("Private ownership probe heap traversal is unavailable");}
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
  if(!state->Legacy().ownerProbe)state->Legacy().ownerProbe=std::make_shared<api::NativeOwnerProbeState>();
  auto counters=state->Legacy().ownerProbe;args.rval().setUndefined();
  if(!std::strncmp(operation.get(),"cleanup",7)){
    auto& hooks=counters->cleanupHooks;auto& environment=state->Legacy().environment;
    auto lookup=[&](unsigned index)->api::NativeCleanupHookProbe*{
      const auto token=args.get(index);
      if(!token.isNumber()||!std::isfinite(token.toNumber())||token.toNumber()<1||
         token.toNumber()>9007199254740991.0||std::floor(token.toNumber())!=token.toNumber()){
        JS_ReportErrorASCII(cx,"Invalid native cleanup hook token");return nullptr;
      }
      auto found=hooks.find(uint64_t(token.toNumber()));
      if(found==hooks.end()){JS_ReportErrorASCII(cx,"Unknown native cleanup hook");return nullptr;}
      return found->second.get();
    };
    if(!std::strcmp(operation.get(),"cleanupCreate")){
      if(!args.get(1).isString()){JS_ReportErrorASCII(cx,"Native cleanup label requires a string");return false;}
      JS::RootedString label(cx,args[1].toString());auto name=JS_EncodeStringToUTF8(cx,label);if(!name)return false;
      const auto token=counters->next++;
      hooks.emplace(token,std::make_unique<api::NativeCleanupHookProbe>(counters.get(),&environment,token,name.get(),args.get(2).isTrue()));
      args.rval().setNumber(double(token));return true;
    }
    if(!std::strcmp(operation.get(),"cleanupDrain")){
      api::Isolate::DisallowJavascriptExecutionScope noJavascript(&state->isolate,api::Isolate::DisallowJavascriptExecutionScope::THROW_ON_FAILURE);
      environment.data().cleanupHooks.Drain();return true;
    }
    if(!std::strcmp(operation.get(),"cleanupInspect")){
      JS::RootedObject object(cx,JS_NewPlainObject(cx)),order(cx,JS::NewArrayObject(cx,counters->cleanupObserved.size()));if(!object||!order)return false;
      for(size_t index=0;index<counters->cleanupObserved.size();++index){
        JS::RootedValue value(cx,JS::DoubleValue(double(counters->cleanupObserved[index])));
        if(!JS_SetElement(cx,order,uint32_t(index),value))return false;
      }
      JS::RootedValue value(cx,JS::ObjectValue(*order)),empty(cx,JS::BooleanValue(environment.data().cleanupHooks.empty()));
      if(!JS_DefineProperty(cx,object,"order",value,JSPROP_ENUMERATE)||!JS_DefineProperty(cx,object,"empty",empty,JSPROP_ENUMERATE))return false;
      args.rval().setObject(*object);return true;
    }
    auto* hook=lookup(1);if(!hook)return false;
    if(!std::strcmp(operation.get(),"cleanupArm")){
      if(!args.get(2).isUndefined()){
        if(!args[2].isString()){JS_ReportErrorASCII(cx,"Native cleanup action requires a string");return false;}
        JS::RootedString actionString(cx,args[2].toString());auto action=JS_EncodeStringToUTF8(cx,actionString);if(!action)return false;
        api::NativeCleanupHookProbe::Action selected;
        if(!std::strcmp(action.get(),"add"))selected=api::NativeCleanupHookProbe::Add;
        else if(!std::strcmp(action.get(),"remove"))selected=api::NativeCleanupHookProbe::Remove;
        else {JS_ReportErrorASCII(cx,"Unknown native cleanup action");return false;}
        auto* target=lookup(3);if(!target)return false;hook->action=selected;hook->target=target;
      }
      hook->Register();return true;
    }
    if(!std::strcmp(operation.get(),"cleanupRemove")){hook->Unregister();return true;}
    if(!std::strcmp(operation.get(),"cleanupOnDestroy")){
      if(!args.get(2).isObject()){JS_ReportErrorASCII(cx,"Native cleanup retirement requires a wrapper");return false;}
      JS::RootedValue input(cx,args[2]);auto* object=native::UnwrapNativeBinding(frame.Own<api::Object>(input));
      if(!object||!counters->objects.contains(object)){JS_ReportErrorASCII(cx,"Native cleanup wrapper is retired or foreign");return false;}
      static_cast<native::NativeOwnerProbe*>(object)->SetCleanupOnDestroy(hook);return true;
    }
    if(!std::strcmp(operation.get(),"cleanupDuplicate")){
      if(!hook->armed){JS_ReportErrorASCII(cx,"Duplicate control requires an armed hook");return false;}
      environment.AddCleanupHook(api::NativeCleanupHookProbe::Run,hook);return true;
    }
    JS_ReportErrorASCII(cx,"Unknown native cleanup operation");return false;
  }
  if(!std::strcmp(operation.get(),"heapSnapshot")||!std::strcmp(operation.get(),"heapPending")){
    const bool pending=!std::strcmp(operation.get(),"heapPending");
    JS::ExceptionStack before(cx);
    if(pending){JS_SetPendingException(cx,args.get(1));if(!JS::GetPendingExceptionStack(cx,&before))return false;}
    api::HeapStatistics measured;
    {
      auto* previousFrame=api::Frame::current;
      if(args.get(pending?2:1).isTrue())api::Frame::current=nullptr;
      auto restoreFrame=mozilla::MakeScopeExit([&]{api::Frame::current=previousFrame;});
      state->isolate.GetHeapStatistics(&measured);
    }
    if(pending){
      JS::ExceptionStack after(cx);if(!JS::GetPendingExceptionStack(cx,&after))return false;
      bool same;CHECK(JS::SameValue(cx,before.exception(),after.exception(),&same)&&same&&before.stack()==after.stack());
      return false;
    }
    JS::RootedObject object(cx,JS_NewPlainObject(cx));if(!object)return false;
    for(const auto& field:std::initializer_list<std::pair<const char*,size_t>>{
        {"total",measured.total_heap_size()},{"used",measured.used_heap_size()},{"external",measured.external_memory()}}){
      JS::RootedValue value(cx,JS::DoubleValue(double(field.second)));
      if(!JS_DefineProperty(cx,object,field.first,value,JSPROP_ENUMERATE))return false;
    }
    args.rval().setObject(*object);return true;
  }
  if(!std::strcmp(operation.get(),"nativeBackingBytes")){
    args.rval().setNumber(double(state->Legacy().backingAllocations->bytes.load(std::memory_order_relaxed)));return true;
  }
  if(!std::strcmp(operation.get(),"executionPolicy")){
    if(!args.get(1).isString()){JS_ReportErrorASCII(cx,"Execution policy requires a mode");return false;}
    JS::RootedString modeString(cx,args[1].toString());auto encodedMode=JS_EncodeStringToUTF8(cx,modeString);if(!encodedMode)return false;
    const std::string_view mode(encodedMode.get());
    if(mode!="call"&&mode!="throw-call"&&mode!="throw-construct"&&mode!="throw-getter"&&mode!="throw-script"&&
       mode!="throw-no-frame"&&mode!="allow-call"&&mode!="allow-then-throw"&&mode!="nested-throw"&&mode!="allow-crash"&&mode!="crash"){
      JS_ReportErrorASCII(cx,"Unknown execution policy mode");return false;
    }
    JS::RootedValue target(cx,args.get(2));
    const auto previous=cx->embedderExecutionRestrictions();
    auto restored=mozilla::MakeScopeExit([&]{CHECK_EQ(cx->embedderExecutionRestrictions(),previous);});
    auto invoke=[&]()->bool{
      // Deliberately enter SpiderMonkey directly. A codec-only guard would
      // miss these calls, constructors, property access and script execution.
      if(mode=="throw-script"){
        static constexpr char16_t source[]=u"globalThis.__executionScopeReached = true";
        JS::SourceText<char16_t> text;if(!text.init(cx,source,std::size(source)-1,JS::SourceOwnership::Borrowed))return false;
        JS::CompileOptions options(cx);options.setFileAndLine("native-execution-scope-control.js",1);
        return JS::Evaluate(cx,options,text,args.rval());
      }
      if(mode=="throw-getter"){
        if(!target.isObject()){JS_ReportErrorASCII(cx,"Execution getter requires an object");return false;}
        JS::RootedObject object(cx,&target.toObject());return JS_GetProperty(cx,object,"value",args.rval());
      }
      if(mode=="throw-construct"){
        JS::RootedObject object(cx);if(!JS::Construct(cx,target,JS::HandleValueArray::empty(),&object))return false;
        args.rval().setObject(*object);return true;
      }
      return JS::Call(cx,JS::UndefinedHandleValue,target,JS::HandleValueArray::empty(),args.rval());
    };
    using Deny=api::Isolate::DisallowJavascriptExecutionScope;
    if(mode=="call")return invoke();
    if(mode=="crash"){Deny scope(&state->isolate,Deny::CRASH_ON_FAILURE);return invoke();}
    if(mode=="allow-crash"){
      Deny denied(&state->isolate,Deny::CRASH_ON_FAILURE);
      {api::Isolate::AllowJavascriptExecutionScope allowed(&state->isolate);if(!invoke())return false;}
      CHECK(cx->embedderExecutionRestrictions()&JSContext::EmbedderCrashOnExecution);return true;
    }
    if(mode=="throw-no-frame"){
      auto* previousFrame=api::Frame::current;api::Frame::current=nullptr;
      auto restoreFrame=mozilla::MakeScopeExit([&]{api::Frame::current=previousFrame;});
      Deny scope(&state->isolate,Deny::THROW_ON_FAILURE);return invoke();
    }
    Deny scope(&state->isolate,Deny::THROW_ON_FAILURE);
    if(mode=="allow-call"||mode=="allow-then-throw"){
      {api::Isolate::AllowJavascriptExecutionScope allowed(&state->isolate);if(!invoke())return false;}
      if(mode=="allow-call")return true;
    }
    if(mode=="nested-throw"){Deny nested(&state->isolate,Deny::THROW_ON_FAILURE);return invoke();}
    return invoke();
  }
  if(!std::strcmp(operation.get(),"dictionaryCreate")){
    bool isArray=false;
    if(!args.get(1).isObject()||!JS::IsArrayObject(cx,args[1],&isArray)||!isArray){JS_ReportErrorASCII(cx,"Dictionary names require an array");return false;}
    JS::RootedObject input(cx,&args[1].toObject());uint32_t count;if(!JS::GetArrayLength(cx,input,&count))return false;
    std::vector<std::string> names;names.reserve(count);
    for(uint32_t index=0;index<count;++index){
      JS::RootedValue key(cx);if(!JS_GetElement(cx,input,index,&key))return false;
      if(!key.isString()){JS_ReportErrorASCII(cx,"Dictionary name must be a string");return false;}
      native::Utf8Value bytes(&state->isolate,frame.OwnValue(key));if(!bytes.out())return false;
      names.emplace_back(bytes.out(),bytes.length());
    }
    std::vector<std::string_view> views;views.reserve(count);for(const auto& name:names)views.emplace_back(name);
    auto schema=api::DictionaryTemplate::New(&state->isolate,views);if(schema.IsEmpty())return false;
    CHECK(!schema->IsValue()&&!schema->IsPrivate());const auto token=counters->next++;
    counters->dictionaries.emplace(token,std::make_unique<api::NativeDictionaryProbe>(&state->isolate,schema,count));
    args.rval().setNumber(double(token));return true;
  }
  if(!std::strncmp(operation.get(),"dictionary",10)){
    const double token=args.get(1).isNumber()?args[1].toNumber():0;
    if(!std::isfinite(token)||token<1||token>9007199254740991.0||std::floor(token)!=token){JS_ReportErrorASCII(cx,"Invalid dictionary token");return false;}
    auto found=counters->dictionaries.find(uint64_t(token));if(found==counters->dictionaries.end()){JS_ReportErrorASCII(cx,"Unknown dictionary token");return false;}
    if(!std::strcmp(operation.get(),"dictionaryDrop")){counters->dictionaries.erase(found);return true;}
    if(std::strcmp(operation.get(),"dictionaryInstance")){JS_ReportErrorASCII(cx,"Unknown dictionary operation");return false;}
    bool isArray=false;
    if(!args.get(2).isObject()||!JS::IsArrayObject(cx,args[2],&isArray)||!isArray){JS_ReportErrorASCII(cx,"Dictionary values require an array");return false;}
    JS::RootedObject input(cx,&args[2].toObject());uint32_t count;if(!JS::GetArrayLength(cx,input,&count))return false;
    if(count!=found->second->count){JS_ReportErrorASCII(cx,"Dictionary value count differs from schema");return false;}
    std::vector<api::MaybeLocal<api::Value>> values(count);
    for(uint32_t index=0;index<count;++index){
      JS::RootedId id(cx);bool present;
      if(!JS_IndexToId(cx,index,&id)||!JS_HasOwnPropertyById(cx,input,id,&present))return false;
      if(present){JS::RootedValue value(cx);if(!JS_GetElement(cx,input,index,&value))return false;values[index]=frame.OwnValue(value);}
    }
    auto context=state->isolate.GetCurrentContext();
    if(!args.get(3).isUndefined()){
      if(!args[3].isObject()){JS_ReportErrorASCII(cx,"Dictionary context requires a global");return false;}
      JS::RootedObject global(cx,api::UnwrapObject(cx,args[3]));if(!global||!JS_IsGlobalObject(global)){JS_ReportErrorASCII(cx,"Dictionary context requires a global");return false;}
      context=frame.OwnContext(global);
    }
    auto value=found->second->schema.Get(&state->isolate)->NewInstance(context,values);if(value.IsEmpty())return false;
    args.rval().set(api::Input(value));return JS_WrapValue(cx,args.rval());
  }
  if(!std::strcmp(operation.get(),"allocatorConfiguration")){
    class UntrackedAllocator final:public native::ArrayBufferAllocator {
     public:
      size_t queries=0,live=0;
      void* Allocate(size_t size)override{void* result=std::calloc(std::max(size,size_t(1)),1);if(result)live+=size;return result;}
      void* AllocateUninitialized(size_t size)override{void* result=std::malloc(std::max(size,size_t(1)));if(result)live+=size;return result;}
      void Free(void* pointer,size_t size)override{CHECK_GE(live,size);live-=size;std::free(pointer);}
     private:
      native::NodeArrayBufferAllocator* GetImpl()override{++queries;return nullptr;}
    } provider;
    native::IsolateData configured(&state->isolate,&provider);
    CHECK_EQ(provider.queries,1);CHECK(configured.node_allocator()==nullptr&&state->Legacy().isolateData.node_allocator()==nullptr);
    auto* bytes=static_cast<uint8_t*>(provider.Allocate(64));CHECK(bytes);
    for(size_t index=0;index<64;++index){CHECK_EQ(bytes[index],0);bytes[index]=uint8_t(index+1);}
    for(size_t index=0;index<64;++index)CHECK_EQ(bytes[index],uint8_t(index+1));
    provider.Free(bytes,64);CHECK_EQ(provider.live,0);
    JS::RootedObject result(cx,JS_NewPlainObject(cx));if(!result)return false;
    if(!JS_DefineProperty(cx,result,"nodeAllocatorSelected",state->Legacy().isolateData.node_allocator()!=nullptr,JSPROP_ENUMERATE)||
       !JS_DefineProperty(cx,result,"providerQueries",double(provider.queries),JSPROP_ENUMERATE)||
       !JS_DefineProperty(cx,result,"providerLiveBytes",double(provider.live),JSPROP_ENUMERATE))return false;
    args.rval().setObject(*result);return true;
  }
  if(!std::strcmp(operation.get(),"constructCallFactory")){
    auto callback=[](const api::FunctionCallbackInfo<api::Value>& call){
      auto* isolate=call.GetIsolate();auto context=isolate->GetCurrentContext();auto result=api::Object::New(isolate);
      auto before=api::String::NewFromUtf8(isolate,"constructCall",api::NewStringType::kNormal,-1).ToLocalChecked();
      if(result->Set(context,before,api::Boolean::New(isolate,call.IsConstructCall())).IsNothing())return;
      if(call.Data()->IsFunction()){
        api::Local<api::Value> value=api::Boolean::New(isolate,call.IsConstructCall());
        if(call.Data().As<api::Function>()->Call(context,api::Undefined(isolate),1,&value).IsEmpty())return;
      }
      auto after=api::String::NewFromUtf8(isolate,"after",api::NewStringType::kNormal,-1).ToLocalChecked();
      if(result->Set(context,after,api::Boolean::New(isolate,call.IsConstructCall())).IsNothing())return;
      call.GetReturnValue().Set(result);
    };
    auto value=api::FunctionTemplate::New(&state->isolate,callback,frame.OwnValue(args.get(1)));api::Local<api::Function> function;
    if(!value->GetFunction(state->isolate.GetCurrentContext()).ToLocal(&function))return false;args.rval().set(api::Input(function));return true;
  }
  if(!std::strcmp(operation.get(),"signalHasHandler")){
    if(!args.get(1).isInt32()){JS_ReportErrorASCII(cx,"Signal handler query requires int32");return false;}
    args.rval().setBoolean(native::HasSignalJSHandler(args[1].toInt32()));return true;
  }
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
    if(!std::strcmp(name,"fieldSetPrivate")){object->SetInternalField(index,state->Legacy().environment.empty_context_frame_sentinel_symbol());return !JS_IsExceptionPending(cx);}
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
      auto tag=static_cast<api::EmbedderDataTypeTag>(args[4].toInt32());
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
    if(!std::strcmp(name,"fieldPrivateIdentity")){args.rval().setBoolean(data->IsPrivate()&&api::SameLocal(data.operator->(),state->Legacy().environment.empty_context_frame_sentinel_symbol().operator->()));return !JS_IsExceptionPending(cx);}
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
    auto* data=state->Legacy().environment.isolate_data();api::Local<api::FunctionTemplate> value;
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
      auto text=native::DetermineSpecificErrorType(&state->Legacy().environment,frame.OwnValue(args.get(1)));if(JS_IsExceptionPending(cx))return false;
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
    auto* data=state->Legacy().environment.isolate_data();
    if(!counters->observedIsolateData)counters->observedIsolateData=data;
    auto options=data->options();if(!options)return false;
    if(!std::strcmp(operation.get(),"isolateHoldOptions")){counters->retainedIsolateOptions=options;return true;}
    if(!std::strcmp(operation.get(),"isolateClearOptions")){counters->retainedIsolateOptions.reset();return true;}
    JS::RootedValue callbackResult(cx);bool replaced=false,beforeReport=options->report_uncaught_exception,foreignRestored=true;
    if(!std::strcmp(operation.get(),"isolateCallOptions")){
      if(!args.get(1).isObject()||!JS::IsCallable(&args[1].toObject())){JS_ReportErrorASCII(cx,"Isolate options control requires Function");return false;}
      auto callback=frame.Own<api::Function>(args[1]);api::Local<api::Value> result;
      if(!callback->Call(state->Legacy().environment.context(),api::Undefined(&state->isolate),0,nullptr).ToLocal(&result))return false;
      callbackResult.set(api::Input(result));auto next=data->options();if(!next)return false;
      replaced=next!=options;beforeReport=options->report_uncaught_exception;options=std::move(next);
    }else if(!std::strcmp(operation.get(),"isolateOptionsLocked")){
      native::Mutex::ScopedLock lock(native::per_process::cli_options_mutex);
      options=data->options();if(!options)return false;
      auto environmentOptions=state->Legacy().environment.options();if(!environmentOptions)return false;
      CHECK(environmentOptions==options->per_env);
    }else if(!std::strcmp(operation.get(),"isolateOptionsForeign")){
      JS::RootedObject target(cx,api::UnwrapObject(cx,args.get(1)));if(!target||!JS_IsGlobalObject(target)){JS_ReportErrorASCII(cx,"Isolate options context control requires global");return false;}
      {JSAutoRealm active(cx,target);options=data->options();if(!options)return false;foreignRestored=JS::CurrentGlobalOrNull(cx)==target;}
    }else if(std::strcmp(operation.get(),"isolateOptions")){JS_ReportErrorASCII(cx,"Unknown isolate options control");return false;}
    auto environmentOptions=state->Legacy().environment.options();if(!environmentOptions)return false;
    auto parsed=kandelo::node::BorrowNativeIsolateOptions(cx,realm);if(!parsed)return false;
    JS::RootedObject result(cx,JS_NewPlainObject(cx));if(!result)return false;
    auto flag=[&](const char* name,bool input){JS::RootedValue value(cx,JS::BooleanValue(input));return JS_DefineProperty(cx,result,name,value,JSPROP_ENUMERATE);};
    if(!flag("canonicalIsolateData",data==&state->Legacy().isolateData)||!flag("stableIdentity",data==counters->observedIsolateData)||
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
      bool hasBuffer=native::Buffer::New(&state->Legacy().environment,&source).ToLocal(&buffer);
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
    auto* isolate=&state->isolate;auto* environment=&state->Legacy().environment;
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
    auto* realm=state->Legacy().environment.principal_realm();CHECK(realm);
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
    {JSAutoRealm active(cx,target);auto callback=!std::strcmp(operation.get(),"fatalBefore")?state->Legacy().environment.enhance_fatal_stack_before_inspector():state->Legacy().environment.enhance_fatal_stack_after_inspector();if(!callback.IsEmpty())result.set(api::Input(callback));}
    if(!JS_WrapValue(cx,&result))return false;args.rval().set(result);return true;
  }
  if(!std::strcmp(operation.get(),"sourceSet")||!std::strcmp(operation.get(),"sourceGet")||!std::strcmp(operation.get(),"sourceCall")){
    const bool cache=args.get(1).isTrue();auto* environment=&state->Legacy().environment;
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
    auto* environment=&state->Legacy().environment;
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
  if(!std::strcmp(operation.get(),"weakCallbackCreate")){
    if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"Weak callback control requires an object");return false;}
    auto probe=std::make_shared<api::NativeWeakCallbackProbe>(&state->isolate);
    probe->handle.Reset(&state->isolate,frame.OwnValue(args[1]).As<api::Object>());probe->Arm();
    const auto token=counters->next++;counters->weakCallbacks.emplace(token,std::move(probe));
    args.rval().setNumber(double(token));return true;
  }
  if(!std::strncmp(operation.get(),"weakCallback",12)){
    const double token=args.get(1).isNumber()?args[1].toNumber():0;
    if(!std::isfinite(token)||token<1||token>9007199254740991.0||std::floor(token)!=token){JS_ReportErrorASCII(cx,"Invalid weak callback token");return false;}
    auto found=counters->weakCallbacks.find(uint64_t(token));
    if(found==counters->weakCallbacks.end()){JS_ReportErrorASCII(cx,"Unknown weak callback token");return false;}
    auto& probe=*found->second;
    if(!std::strcmp(operation.get(),"weakCallbackDrop")){counters->weakCallbacks.erase(found);return true;}
    if(!std::strcmp(operation.get(),"weakCallbackCancel")){probe.handle.Reset();return true;}
    if(!std::strcmp(operation.get(),"weakCallbackStrong")){probe.handle.ClearWeak();return true;}
    if(!std::strcmp(operation.get(),"weakCallbackArmOnCollect")){
      const double target=args.get(2).isNumber()?args[2].toNumber():0;
      if(!std::isfinite(target)||target<1||target>9007199254740991.0||std::floor(target)!=target){JS_ReportErrorASCII(cx,"Invalid dependent weak callback token");return false;}
      auto next=counters->weakCallbacks.find(uint64_t(target));
      if(next==counters->weakCallbacks.end()||next->second->handle.IsEmpty()||next->second->handle.IsWeak()){JS_ReportErrorASCII(cx,"Dependent weak callback requires a live strong handle");return false;}
      probe.armOnCollect=next->second;return true;
    }
    if(!std::strcmp(operation.get(),"weakCallbackArm")){
      if(probe.handle.IsEmpty()){JS_ReportErrorASCII(cx,"Cannot arm an empty weak persistent");return false;}
      probe.Arm();return true;
    }
    if(!std::strcmp(operation.get(),"weakCallbackGet")){
      auto value=probe.handle.Get(&state->isolate);if(!value.IsEmpty())args.rval().set(api::Input(value));return !JS_IsExceptionPending(cx);
    }
    if(!std::strcmp(operation.get(),"weakCallbackStatus")){
      JS::RootedObject result(cx,JS_NewPlainObject(cx));if(!result)return false;
      if(!JS_DefineProperty(cx,result,"delivered",double(probe.delivered),JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,result,"empty",probe.handle.IsEmpty(),JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,result,"weak",probe.handle.IsWeak(),JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,result,"gcActive",probe.gcActive,JSPROP_ENUMERATE)||
         !JS_DefineProperty(cx,result,"frameActive",probe.frameActive,JSPROP_ENUMERATE))return false;
      args.rval().setObject(*result);return true;
    }
    JS_ReportErrorASCII(cx,"Unknown weak callback operation");return false;
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
    auto owner=state->Legacy().environment.owner_symbol(),resource=state->Legacy().environment.resource_symbol();
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
      {"closedWithoutFrame",counters->closedWithoutFrame},
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
    if(!api::InitializeNativeInternalFields(frame,object,native::BaseObject::kInternalFieldCount))return false;
    JS::RootedValue value(cx,JS::ObjectValue(*object));
    auto* nativeRealm=native::Realm::GetCurrent(state->isolate.GetCurrentContext());if(!nativeRealm)return false;
    auto* owner=new native::NativeOwnerProbe(nativeRealm,frame.Own<api::Object>(value),counters);
    if(args.get(1).isTrue()){
      int error=owner->Open();if(error){native::RetireBaseObjectWrapper(owner);delete owner;JS_ReportErrorASCII(cx,"Actual uv_async_init failed: %s",uv_strerror(error));return false;}
    }
    owner->MakeWeak();args.rval().set(value);return !JS_IsExceptionPending(cx);
  }
  if(!std::strcmp(operation.get(),"weakReferenceCreate")){
    if(!args.get(1).isObject()){JS_ReportErrorASCII(cx,"Native weak reference requires a wrapper");return false;}
    auto* object=native::UnwrapNativeBinding(frame.Own<api::Object>(args[1]));
    if(!object||!counters->objects.contains(object)){JS_ReportErrorASCII(cx,"Native weak reference wrapper is retired or foreign");return false;}
    const auto token=counters->next++;counters->weakReferences.emplace(token,native::BaseObjectWeakPtr<native::BaseObject>(object));
    args.rval().setNumber(double(token));return true;
  }
  if(!std::strncmp(operation.get(),"weakReference",13)){
    const double token=args.get(1).isNumber()?args[1].toNumber():0;
    if(!std::isfinite(token)||token<1||token>9007199254740991.0||std::floor(token)!=token){JS_ReportErrorASCII(cx,"Invalid native weak reference token");return false;}
    auto found=counters->weakReferences.find(uint64_t(token));
    if(found==counters->weakReferences.end()){JS_ReportErrorASCII(cx,"Unknown native weak reference");return false;}
    auto& reference=found->second;
    if(!std::strcmp(operation.get(),"weakReferenceDrop")){counters->weakReferences.erase(found);return true;}
    if(!std::strcmp(operation.get(),"weakReferenceAlive")){args.rval().setBoolean(bool(reference));return true;}
    if(!std::strcmp(operation.get(),"weakReferenceCopy")){
      const auto next=counters->next++;counters->weakReferences.emplace(next,reference);args.rval().setNumber(double(next));return true;
    }
    if(!std::strcmp(operation.get(),"weakReferenceLock")){
      if(!reference)return true;
      const auto next=counters->next++;counters->references.emplace(next,native::BaseObjectPtr<native::BaseObject>(reference));
      args.rval().setNumber(double(next));return true;
    }
    if(!std::strcmp(operation.get(),"weakReferenceBorrow")){
      if(reference){auto object=reference->object();if(!object.IsEmpty())args.rval().set(api::Input(object));}
      return !JS_IsExceptionPending(cx);
    }
    JS_ReportErrorASCII(cx,"Unknown native weak reference operation");return false;
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
  JS::RootedValue input(cx,args[1]);auto* object=native::UnwrapNativeBinding(frame.Own<api::Object>(input));
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
