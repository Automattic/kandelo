#ifndef KANDELO_NODE_ENVIRONMENT_CODECS_INL_H
#define KANDELO_NODE_ENVIRONMENT_CODECS_INL_H

#include <deque>
#include <mutex>

#include "shell/node-upstream/timers.h"

namespace kandelo_node_codec_api {
struct GlobalRoot {
  std::weak_ptr<State> state;
  std::unique_ptr<Value> strong;
  JS::Heap<JSObject*> weak{nullptr};
  bool weakMode=false;
};
std::shared_ptr<GlobalRoot> NewGlobalRoot(Isolate* isolate,Local<Value> value) {
  auto& frame=Current(isolate);CHECK(!value.IsEmpty());
  auto root=std::make_shared<GlobalRoot>();root->state=frame.state;root->strong=RetainRoot(isolate,value);return root;
}
Local<Value> ReadGlobalRoot(Isolate* isolate,const std::shared_ptr<GlobalRoot>& root) {
  auto& frame=Current(isolate);if(!root)return {};
  CHECK(root->state.lock()==frame.state);frame.state->environment.AssertForeground();
  JS::RootedValue value(frame.cx);
  if(root->weakMode){if(!root->weak)return {};value.setObject(*root->weak);}
  else {CHECK(root->strong);value=root->strong->cell().value;}
  if(!JS_WrapValue(frame.cx,&value))return {};return frame.OwnValue(value);
}
void MakeGlobalWeak(Isolate* isolate,const std::shared_ptr<GlobalRoot>& root) {
  auto& frame=Current(isolate);CHECK(root&&root->state.lock()==frame.state&&!root->weakMode&&root->strong);
  frame.state->environment.AssertForeground();
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,root->strong->cell().value));CHECK(object);
  // The registry retains only native records. These edges are deliberately
  // weak and are updated by the engine's weak-zone callback, never traced.
  frame.state->weakGlobals.push_back(root);root->weak=object;root->weakMode=true;root->strong.reset();
}
inline thread_local std::vector<std::shared_ptr<State>> environmentOwners;
void UpdateEnvironmentWeakEdges(JSTracer* tracer,void* raw) {
  auto* state=static_cast<State*>(raw);
  for(auto it=state->weakGlobals.begin();it!=state->weakGlobals.end();){
    auto& root=*it;
    if(root.use_count()==1){root->weak=nullptr;it=state->weakGlobals.erase(it);}
    else {if(root->weak)JS_UpdateWeakPointerAfterGC(tracer,&root->weak);++it;}
  }
}
}
namespace kandelo_node_codec_impl {
class EnvironmentCleanupProbe final : public Cleanable {
  Environment* environment_;
  std::unique_ptr<char[]> allocation_;
  size_t size_;
  bool reenter_,atExit_;
  void Clean() override;
 public:
  EnvironmentCleanupProbe(Environment*,size_t,bool,bool);
};
struct EnvironmentData {
  uv_thread_t foreground=uv_thread_self();
  JSContext* cx=nullptr;
  std::unique_ptr<JS::PersistentRootedObject> runtime;
  void* wake=nullptr;
  mutable std::mutex mutex;
  std::deque<std::unique_ptr<NativeImmediate>> pending;
  bool initialized=false,closed=false,stopping=false,draining=false;
  bool weakRegistered=false;
  CleanableQueue cleanables;
  api::ExternalMemoryAccounter external{false};
  std::atomic<size_t> posted{0},executed{0},ownerChecks{0},payloadBytes{0};
  size_t probesCreated=0,probesCleaned=0,probeBytes=0,weakThreadReleases=0;
  std::vector<std::unique_ptr<EnvironmentCleanupProbe>> probes;
  std::vector<std::unique_ptr<api::Global<api::ArrayBuffer>>> weakControls;
  explicit EnvironmentData(Environment* environment):cleanables(environment) {}
};
Environment::Environment(Isolate* isolate):isolate_(isolate),data_(std::make_unique<EnvironmentData>(this)) {}
Environment::~Environment() { CHECK((!data_->initialized||data_->closed)&&data_->cleanables.IsEmpty()&&data_->pending.empty()); }
void Environment::AssertForeground() const { auto current=uv_thread_self();CHECK(uv_thread_equal(&current,&data_->foreground)); }
CleanableLink::~CleanableLink() { Remove(); }
void CleanableLink::Remove() { if(queue_)queue_->Remove(this); }
void CleanableQueue::Remove(CleanableLink* link) {
  environment_->AssertForeground();CHECK(link->queue_==this&&size_>0);
  if(link->previous_)link->previous_->next_=link->next_;else first_=link->next_;
  if(link->next_)link->next_->previous_=link->previous_;
  link->queue_=nullptr;link->previous_=nullptr;link->next_=nullptr;--size_;
}
void CleanableQueue::PushFront(Cleanable* item) {
  environment_->AssertForeground();CHECK(!environment_->IsClosed());auto* link=&item->cleanable_queue_;CHECK(!link->queue_);
  link->queue_=this;link->next_=first_;if(first_)first_->previous_=link;first_=link;++size_;
}
void CleanableQueue::CleanAll() {
  environment_->AssertForeground();
  // Retire membership before calling arbitrary native cleanup. A callback may
  // delete itself or register another object; never revisit its old address.
  while(first_){auto* item=first_->item_;Remove(first_);item->Clean();}
}
CleanableQueue* Environment::cleanable_queue() { AssertForeground();return &data_->cleanables; }
ExternalMemoryAccounter* Environment::external_memory_accounter() { AssertForeground();return &data_->external; }
JSObject* Environment::memory_owner(JSContext* cx) {
  AssertForeground();CHECK(data_->runtime&&data_->cx==cx);
  JS::RootedObject runtime(cx,*data_->runtime);
  JS::RootedObject object(cx,kandelo::node::GetRuntimeCodecState(cx,runtime,false));if(!object)return nullptr;
  return js::CheckedUnwrapDynamic(object,cx,false);
}
bool Environment::IsClosed() const { std::lock_guard lock(data_->mutex);return data_->closed; }
bool Environment::HasPending() const { std::lock_guard lock(data_->mutex);return !data_->pending.empty(); }
bool Environment::Initialize(JSContext* cx,JS::HandleObject runtime) {
  AssertForeground();
  if(data_->closed){JS_ReportErrorASCII(cx,"Native Node environment is closed");return false;}
  if(data_->initialized){CHECK(data_->cx==cx);return true;}
  data_->cx=cx;data_->runtime=std::make_unique<JS::PersistentRootedObject>(cx,runtime);
  data_->wake=kandelo::node::AttachRuntimeForeground(cx,runtime,this,
      [](JSContext* cx,void* owner){return static_cast<Environment*>(owner)->Drain(cx);},
      [](void* owner){return static_cast<Environment*>(owner)->HasPending();});
  if(!data_->wake){data_->runtime.reset();return false;}
  auto state=isolate_->owner.lock();CHECK(state);
  if(!JS_AddWeakPointerZonesCallback(cx,api::UpdateEnvironmentWeakEdges,state.get())){
    kandelo::node::DetachRuntimeForeground(cx,runtime,this);data_->wake=nullptr;data_->runtime.reset();return false;
  }
  data_->weakRegistered=true;data_->initialized=true;
  // One genuine context owner keeps Environment addresses and the canonical
  // loop alive until foreground shutdown, including background finalization.
  api::environmentOwners.push_back(state);return true;
}
void Environment::Post(std::unique_ptr<NativeImmediate> item) {
  CHECK(item);std::lock_guard lock(data_->mutex);CHECK(data_->initialized&&!data_->closed&&data_->wake);
  data_->pending.push_back(std::move(item));data_->posted.fetch_add(1);
  // Posting takes no JS roots or engine locks and is valid on a GC thread.
  CHECK_EQ(kandelo::node::SendRuntimeForeground(data_->wake),0);
}
bool Environment::Drain(JSContext* cx) {
  AssertForeground();CHECK(cx==data_->cx&&!data_->closed);
  if(data_->draining){JS_ReportErrorASCII(cx,"Reentrant native environment dispatch");return false;}
  data_->draining=true;auto leave=OnScopeLeave([&]{data_->draining=false;});
  auto state=isolate_->owner.lock();CHECK(state);
  JS::RootedObject runtime(cx,*data_->runtime);
  JS::RootedObject realm(cx,kandelo::node::GetRuntimePrincipalRealm(cx,runtime));if(!realm)return false;
  realm=js::CheckedUnwrapDynamic(realm,cx,false);if(!realm)return false;
  JSAutoRealm home(cx,realm);api::Frame frame(cx,realm,state,nullptr,api::Domain::Environment);
  for(;;){
    std::unique_ptr<NativeImmediate> item;
    {std::lock_guard lock(data_->mutex);if(data_->pending.empty())break;item=std::move(data_->pending.front());data_->pending.pop_front();}
    item->Run(this);data_->executed.fetch_add(1);item.reset();
    if(JS_IsExceptionPending(cx))return false;
  }
  return true;
}
void Environment::Shutdown(JSContext* cx) {
  AssertForeground();if(!data_->initialized||data_->closed)return;
  CHECK(cx==data_->cx&&!data_->draining);
  JS::AutoSaveExceptionState preserve(cx);
  data_->stopping=true;
  auto state=isolate_->owner.lock();CHECK(state);
  JS::RootedObject runtime(cx,*data_->runtime);
  JSAutoRealm runtimeHome(cx,runtime);
  if(!data_->cleanables.IsEmpty()||HasPending()){
    JS::RootedObject realm(cx,kandelo::node::GetRuntimePrincipalRealm(cx,runtime));CHECK(realm);
    realm=js::CheckedUnwrapDynamic(realm,cx,false);CHECK(realm);
    JSAutoRealm home(cx,realm);api::Frame frame(cx,realm,state,nullptr,api::Domain::Environment);
    do {data_->cleanables.CleanAll();CHECK(Drain(cx));}while(!data_->cleanables.IsEmpty()||HasPending());
  }
  {
    std::lock_guard lock(data_->mutex);CHECK(data_->pending.empty());data_->closed=true;
  }
  kandelo::node::DetachRuntimeForeground(cx,runtime,this);data_->wake=nullptr;
  if(data_->weakRegistered){JS_RemoveWeakPointerZonesCallback(cx,api::UpdateEnvironmentWeakEdges);data_->weakRegistered=false;}
  for(auto& root:state->weakGlobals){CHECK(!root->strong);root->weak=nullptr;}
  state->weakGlobals.clear();data_->weakControls.clear();data_->probes.clear();data_->runtime.reset();
  preserve.restore();
}
EnvironmentCleanupProbe::EnvironmentCleanupProbe(Environment* environment,size_t size,bool reenter,bool atExit)
    :environment_(environment),allocation_(std::make_unique<char[]>(size)),size_(size),reenter_(reenter),atExit_(atExit) {
  auto& data=environment_->data();std::memset(allocation_.get(),0x6d,size_);++data.probesCreated;data.probeBytes+=size_;
  environment_->external_memory_accounter()->Increase(environment_->isolate(),size_);environment_->cleanable_queue()->PushFront(this);
}
void EnvironmentCleanupProbe::Clean() {
  auto& data=environment_->data();environment_->AssertForeground();CHECK(allocation_);
  for(size_t i=0;i<size_;++i)CHECK_EQ(allocation_[i],0x6d);
  cleanable_queue_.Remove();allocation_.reset();data.probeBytes-=size_;++data.probesCleaned;
  environment_->external_memory_accounter()->Decrease(environment_->isolate(),size_);
  if(reenter_)data.probes.push_back(std::make_unique<EnvironmentCleanupProbe>(environment_,31,false,false));
  if(atExit_){
    const size_t before=data.posted.load();
    environment_->SetImmediateThreadsafe([before](Environment* environment){
      CHECK_EQ(environment->data().executed.load(),before);
      std::printf("ENVIRONMENT_CLEANUP_DONE\n");std::fflush(stdout);
    });
  }
}
}
namespace kandelo::node {
void ShutdownRuntimeCodecs(JSContext* cx) {
  // Called by every ShellContext before it unregisters its JSContext data.
  for(auto it=api::environmentOwners.begin();it!=api::environmentOwners.end();){
    auto state=*it;if(state->environment.data().cx!=cx){++it;continue;}
    state->environment.Shutdown(cx);it=api::environmentOwners.erase(it);
  }
}
namespace {
JSObject* EnvironmentSnapshot(JSContext* cx,const std::shared_ptr<api::State>& state) {
  auto& environment=state->environment;auto& data=environment.data();JS::RootedObject object(cx,JS_NewPlainObject(cx));if(!object)return nullptr;
  size_t pending;{std::lock_guard lock(data.mutex);pending=data.pending.size();}
  for(auto field:std::initializer_list<std::pair<const char*,size_t>>{
      {"posted",data.posted.load()},{"executed",data.executed.load()},{"ownerChecks",data.ownerChecks.load()},
      {"pending",pending},{"cleanables",data.cleanables.size()},{"probeBytes",data.probeBytes},
      {"probesCreated",data.probesCreated},{"probesCleaned",data.probesCleaned},{"payloadBytes",data.payloadBytes.load()},
      {"weakRecords",state->weakGlobals.size()},{"weakThreadReleases",data.weakThreadReleases}}){
    JS::RootedValue value(cx,JS::DoubleValue(double(field.second)));if(!JS_DefineProperty(cx,object,field.first,value,JSPROP_ENUMERATE))return nullptr;
  }
  return object;
}
void PostEnvironmentProbe(native::Environment* environment,size_t size) {
  auto payload=std::make_unique<char[]>(size);std::memset(payload.get(),0x4e,size);
  environment->SetImmediateThreadsafe([expected=environment,size,payload=std::move(payload)](native::Environment* actual){
    CHECK(actual==expected&&native::Environment::GetCurrent(actual->isolate())==actual);actual->AssertForeground();
    for(size_t i=0;i<size;++i)CHECK_EQ(payload[i],0x4e);
    actual->data().ownerChecks.fetch_add(1);actual->data().payloadBytes.fetch_add(size);
  });
}
bool EnvironmentControl(JSContext* cx,unsigned argc,JS::Value* vp) {
  auto args=JS::CallArgsFromVp(argc,vp);if(!args.get(0).isString()){JS_ReportErrorASCII(cx,"Native environment control requires an operation");return false;}
  JS::RootedString operationString(cx,args[0].toString());
  auto operation=JS_EncodeStringToUTF8(cx,operationString);if(!operation)return false;
  JS::RootedObject runtime(cx,js::shell::GetShellContext(cx)->upstreamNodeRuntime);auto state=api::Data(cx,runtime);if(!state)return false;
  JS::RootedObject realm(cx,GetRuntimePrincipalRealm(cx,runtime));if(!realm)return false;
  realm=js::CheckedUnwrapDynamic(realm,cx,false);if(!realm)return false;
  api::Frame frame(cx,realm,state,&args,api::Domain::Environment);auto& environment=state->environment;auto& data=environment.data();
  args.rval().setUndefined();
  if(!std::strcmp(operation.get(),"inspect")){
    JS::RootedObject snapshot(cx,EnvironmentSnapshot(cx,state));if(!snapshot)return false;args.rval().setObject(*snapshot);return true;
  }
  if(!std::strcmp(operation.get(),"weak")){
    auto value=frame.OwnValue(args.get(1));if(!value->IsArrayBuffer()){JS_ReportErrorASCII(cx,"Weak buffer control requires an ArrayBuffer");return false;}
    auto handle=std::make_unique<api::Global<api::ArrayBuffer>>();handle->Reset(&state->isolate,value.As<api::ArrayBuffer>());handle->SetWeak();
    data.weakControls.push_back(std::move(handle));args.rval().setNumber(double(data.weakControls.size()-1));return true;
  }
  if(!std::strcmp(operation.get(),"read")||!std::strcmp(operation.get(),"release")||!std::strcmp(operation.get(),"releaseFromThread")){
    if(!args.get(1).isInt32()||args[1].toInt32()<0||size_t(args[1].toInt32())>=data.weakControls.size()){JS_ReportErrorASCII(cx,"Invalid native weak buffer handle");return false;}
    auto& handle=data.weakControls[size_t(args[1].toInt32())];
    if(!std::strcmp(operation.get(),"release")){handle->Reset();return true;}
    if(!std::strcmp(operation.get(),"releaseFromThread")){
      auto retired=std::move(handle);handle=std::make_unique<api::Global<api::ArrayBuffer>>();uv_thread_t thread;
      auto drop=[](void* raw){CHECK(!api::Frame::current);static_cast<std::unique_ptr<api::Global<api::ArrayBuffer>>*>(raw)->reset();};
      CHECK_EQ(uv_thread_create(&thread,drop,&retired),0);
      JS::PrepareForFullGC(cx);JS::NonIncrementalGC(cx,JS::GCOptions::Shrink,JS::GCReason::API);
      CHECK_EQ(uv_thread_join(&thread),0);++data.weakThreadReleases;return true;
    }
    auto value=handle->Get(&state->isolate);if(!value.IsEmpty())args.rval().set(api::Input(value));return !JS_IsExceptionPending(cx);
  }
  if(!std::strcmp(operation.get(),"clean")){data.cleanables.CleanAll();return true;}
  if(!std::strcmp(operation.get(),"probe")||!std::strcmp(operation.get(),"reentrantProbe")||!std::strcmp(operation.get(),"armExit")){
    data.probes.push_back(std::make_unique<native::EnvironmentCleanupProbe>(&environment,127,!std::strcmp(operation.get(),"reentrantProbe"),!std::strcmp(operation.get(),"armExit")));return true;
  }
  if(!std::strcmp(operation.get(),"post")||!std::strcmp(operation.get(),"postThreads")){
    uint32_t count;if(!args.get(1).isNumber()||!JS::ToUint32(cx,args[1],&count)||count<1||count>1024){JS_ReportErrorASCII(cx,"Native post count must be in 1..1024");return false;}
    if(!std::strcmp(operation.get(),"post")){for(uint32_t i=0;i<count;++i)PostEnvironmentProbe(&environment,29);return true;}
    struct Thread { native::Environment* environment;uint32_t count; } input{&environment,count};uv_thread_t threads[4];
    auto run=[](void* raw){auto* input=static_cast<Thread*>(raw);for(uint32_t i=0;i<input->count;++i)PostEnvironmentProbe(input->environment,29);};
    for(auto& thread:threads)CHECK_EQ(uv_thread_create(&thread,run,&input),0);
    for(auto& thread:threads)CHECK_EQ(uv_thread_join(&thread),0);
    return true;
  }
  if(!std::strcmp(operation.get(),"postReentrant")){
    environment.SetImmediateThreadsafe([](native::Environment* environment){PostEnvironmentProbe(environment,17);});return true;
  }
  if(!std::strcmp(operation.get(),"postFailure")){
    environment.SetImmediateThreadsafe([](native::Environment* environment){
      auto error=api::Error(environment->isolate(),JSEXN_ERR,"ERR_NATIVE_ENVIRONMENT_PROBE","NATIVE_ENVIRONMENT_WORK_ERROR");
      if(!error.IsEmpty())environment->isolate()->ThrowException(error);
    });return true;
  }
  JS_ReportErrorASCII(cx,"Unknown native environment operation");return false;
}
}
bool DefineEnvironmentTestAPI(JSContext* cx,JS::HandleObject api) {
  return JS_DefineFunction(cx,api,"environment",EnvironmentControl,2,0);
}
}
#endif
