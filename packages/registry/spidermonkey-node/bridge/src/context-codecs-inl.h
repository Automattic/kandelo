#ifndef KANDELO_NODE_CONTEXT_CODECS_INL_H
#define KANDELO_NODE_CONTEXT_CODECS_INL_H
#include "js/friend/MicroTask.h"

namespace v8 {
void UpdateNativePromiseHookRegistration(State&);
bool InitializeNativeExtras(Frame&,Local<Context>);
namespace {
struct ContextPointerField {
  void* pointer=nullptr;
  EmbedderDataTypeTag tag=kEmbedderDataTypeTagDefault;
  bool isPointer=false;
};
struct ContextEmbedderStorage {
  // Native pointers are opaque. Only the original owner may clear/free them;
  // a GC finalizer must never perform a second Environment shutdown.
  std::vector<ContextPointerField> fields;
  bool allowCodeGenerationFromStrings=true;
  bool securityTokenSet=false;
  bool microtaskQueueAssociated=false;
  std::weak_ptr<NativeMicrotaskData> microtaskQueue;
  bool promiseHooksEnabled=false;
  std::weak_ptr<State> promiseHooksOwner;
  ~ContextEmbedderStorage(){
    if(promiseHooksEnabled){
      if(auto state=promiseHooksOwner.lock()){
        state->AssertForeground();CHECK(state->contextPromiseHookOwners);
        --state->contextPromiseHookOwners;UpdateNativePromiseHookRegistration(*state);
      }
    }
  }
};
void FinalizeContextEmbedderStorage(JS::GCContext*,JSObject* object){
  auto value=JS::GetReservedSlot(object,0);
  if(!value.isUndefined())delete static_cast<ContextEmbedderStorage*>(value.toPrivate());
}
const JSClassOps contextEmbedderOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeContextEmbedderStorage};
const JSClass contextEmbedderClass={"NodeContextEmbedderStorage",JSCLASS_HAS_RESERVED_SLOTS(7)|JSCLASS_FOREGROUND_FINALIZE,&contextEmbedderOps};
// The first application slot belongs to this embedding, not SpiderMonkey's
// global implementation. Reads remain valid while GC forbids allocation.
constexpr uint32_t contextEmbedderSlot=0;

JSObject* ExistingContextEmbedderStorage(State&,JSObject* global){
  CHECK(global&&JS_IsGlobalObject(global));
  auto value=JS::GetReservedSlot(global,contextEmbedderSlot);
  if(value.isUndefined())return nullptr;
  CHECK(value.isObject()&&JS::GetClass(&value.toObject())==&contextEmbedderClass);
  return &value.toObject();
}
JSObject* ExistingContextEmbedderStorage(Frame& frame,Context& context){
  CHECK(context.isolate==&frame.state->isolate&&context.cell().value.get().isObject());
  return ExistingContextEmbedderStorage(*frame.state,&context.cell().value.get().toObject());
}
ContextEmbedderStorage& ContextFields(JSObject* record){
  CHECK(record&&JS::GetClass(record)==&contextEmbedderClass);
  return *static_cast<ContextEmbedderStorage*>(JS::GetReservedSlot(record,0).toPrivate());
}
JSObject* EnsureContextEmbedderStorage(Frame& frame,Context& context){
  if(auto* existing=ExistingContextEmbedderStorage(frame,context))return existing;
  js::AssertHeapIsIdle();
  JS::RootedObject global(frame.cx,&context.cell().value.get().toObject());JSAutoRealm home(frame.cx,global);
  JS::RootedObject record(frame.cx,JS_NewObjectWithGivenProto(frame.cx,&contextEmbedderClass,nullptr));CHECK(record);
  auto data=std::make_unique<ContextEmbedderStorage>();
  JS::SetReservedSlot(record,0,JS::PrivateValue(data.release()));
  JS::SetReservedSlot(global,contextEmbedderSlot,JS::ObjectValue(*record));
  return record;
}
void GrowContextFields(JSObject* record,int index){
  CHECK_GE(index,0);auto& fields=ContextFields(record).fields;
  if(size_t(index)>=fields.size())fields.resize(size_t(index)+1);
}
JS::Value ReadContextValueField(JSObject* record,int index){
  CHECK_GE(index,0);CHECK_LT(size_t(index),ContextFields(record).fields.size());
  if(JS::GetReservedSlot(record,1).isUndefined())return JS::UndefinedValue();
  auto& values=JS::GetReservedSlot(record,1).toObject().as<js::NativeObject>();
  // Array elements may be dense or sparse. The pure array getter handles
  // both without resolving names or walking a prototype (which is null).
  JS::Value value;bool found=false;auto* cx=js::TlsContext.get();CHECK(cx);
  CHECK(js::GetOwnPropertyPure(cx,&values,JS::PropertyKey::Int(index),&value,&found));
  return found?value:JS::UndefinedValue();
}
void WriteContextValueField(Frame& frame,JS::HandleObject record,int index,JS::HandleValue input){
  JSAutoRealm home(frame.cx,record);JS::RootedObject values(frame.cx);
  if(JS::GetReservedSlot(record,1).isUndefined()){
    values=JS::NewArrayObject(frame.cx,0);CHECK(values&&JS_SetPrototype(frame.cx,values,nullptr));
    JS::SetReservedSlot(record,1,JS::ObjectValue(*values));
  }else values=&JS::GetReservedSlot(record,1).toObject();
  JS::RootedValue value(frame.cx,input);CHECK(JS_WrapValue(frame.cx,&value));
  CHECK(JS_SetElement(frame.cx,values,uint32_t(index),value));
}
}
void Context::SetSecurityToken(Local<Value> token){
  auto& frame=Current(isolate);CHECK(!token.IsEmpty());
  NativeNoScriptEntry entry(frame);if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return;
  JS::RootedObject fields(frame.cx,EnsureContextEmbedderStorage(frame,*this));
  JSAutoRealm home(frame.cx,fields);JS::RootedValue value(frame.cx,Input(token));
  if(!JS_WrapValue(frame.cx,&value))return;
  // Original Node gives its VM/shadow contexts the main context's token.
  // Keep that exact shared identity in traced realm storage, without a root
  // outside the realm or a second Node permission owner.
  JS::SetReservedSlot(fields,4,value);
  ContextFields(fields).securityTokenSet=true;
}
Local<Value> Context::GetSecurityToken(){
  auto& frame=Current(isolate);JS::RootedValue value(frame.cx,cell().value);
  if(auto* fields=ExistingContextEmbedderStorage(frame,*this)){
    const auto token=JS::GetReservedSlot(fields,4);
    if(ContextFields(fields).securityTokenSet)value=token;
  }
  if(!JS_WrapValue(frame.cx,&value))return {};return frame.OwnValue(value);
}
uint32_t Context::GetNumberOfEmbedderDataFields(){
  auto& frame=Current(isolate);JS::AutoCheckCannotGC nogc;
  auto* record=ExistingContextEmbedderStorage(frame,*this);
  return record?uint32_t(ContextFields(record).fields.size()):0;
}
Local<Value> Context::GetEmbedderData(int index){
  auto& frame=Current(isolate);JS::RootedValue value(frame.cx);
  {
    JS::AutoCheckCannotGC nogc;auto* record=ExistingContextEmbedderStorage(frame,*this);CHECK(record);
    CHECK_GE(index,0);CHECK_LT(size_t(index),ContextFields(record).fields.size());
    CHECK(!ContextFields(record).fields[size_t(index)].isPointer);
    // Use the actual record compartment for the array-only pure getter.
    JSAutoRealm home(frame.cx,record);value=ReadContextValueField(record,index);
  }
  if(JS::CurrentGlobalOrNull(frame.cx))CHECK(JS_WrapValue(frame.cx,&value));
  return frame.OwnValue(value);
}
void Context::SetEmbedderData(int index,Local<Value> input){
  CHECK_GE(index,0);CHECK(!input.IsEmpty());auto& frame=Current(isolate);js::AssertHeapIsIdle();
  JS::RootedObject record(frame.cx,EnsureContextEmbedderStorage(frame,*this));GrowContextFields(record,index);
  JS::RootedValue value(frame.cx,Input(input));WriteContextValueField(frame,record,index,value);
  ContextFields(record).fields[size_t(index)]=ContextPointerField{};
}
void* Context::GetAlignedPointerFromEmbedderData(int index,EmbedderDataTypeTag tag){
  auto& frame=Current(isolate);JS::AutoCheckCannotGC nogc;
  auto* record=ExistingContextEmbedderStorage(frame,*this);CHECK(record);
  CHECK_GE(index,0);auto& fields=ContextFields(record).fields;CHECK_LT(size_t(index),fields.size());
  const auto& field=fields[size_t(index)];CHECK(field.isPointer);
  if(field.pointer)CHECK_EQ(field.tag,tag);return field.pointer;
}
void Context::SetAlignedPointerInEmbedderData(int index,void* pointer,EmbedderDataTypeTag tag){
  CHECK_GE(index,0);CHECK(!(reinterpret_cast<uintptr_t>(pointer)&1));auto& frame=Current(isolate);
  {
    JS::AutoCheckCannotGC nogc;
    if(auto* record=ExistingContextEmbedderStorage(frame,*this)){
      auto& fields=ContextFields(record).fields;
      if(size_t(index)<fields.size()&&fields[size_t(index)].isPointer){
        // Original UnassignFromContext clears these pointers during native
        // retirement, without replacing traced values or allocating in GC.
        fields[size_t(index)]={pointer,tag,true};return;
      }
    }
  }
  js::AssertHeapIsIdle();JS::RootedObject record(frame.cx,EnsureContextEmbedderStorage(frame,*this));
  GrowContextFields(record,index);JS::RootedValue value(frame.cx,JS::UndefinedValue());
  WriteContextValueField(frame,record,index,value);ContextFields(record).fields[size_t(index)]={pointer,tag,true};
}
MaybeLocal<Context> Object::GetCreationContext(Isolate* isolate){
  auto& frame=Current(isolate);frame.state->AssertForeground();
  // A Cell records its real engine owner without inspecting a JS object from
  // another thread/runtime. Public constructor/prototype fields are irrelevant.
  CHECK(cell().context==frame.cx&&frame.cx==js::TlsContext.get());
  JS::AutoCheckCannotGC nogc;CHECK(cell().value.get().isObject());
  // Strip only engine transport wrappers. A user JSProxy has its own immutable
  // creation realm, even if revoked; do not follow its target or invoke traps.
  auto* object=js::UncheckedUnwrapWithoutExpose(&cell().value.get().toObject());
  CHECK(object);if(JS_IsDeadWrapper(object))return {};
  auto* realm=JS::GetObjectRealmOrNull(object);
  CHECK(realm&&realm->runtimeFromMainThread()==frame.cx->runtime());
  JS::RootedObject global(frame.cx,JS::GetNonCCWObjectGlobal(object));CHECK(global);
  // This metadata API does not enter that realm, execute JS, drain jobs or
  // capture/replace a pending failure. The returned Context is a real root.
  return frame.OwnContext(global);
}
MaybeLocal<Context> Object::GetCreationContext(){return GetCreationContext(Isolate::GetCurrent());}
Local<Context> Object::GetCreationContextChecked(Isolate* isolate){
  Local<Context> context;
  if(!GetCreationContext(isolate).ToLocal(&context))Crash("No creation context available");
  return context;
}
Local<Context> Object::GetCreationContextChecked(){return GetCreationContextChecked(Isolate::GetCurrent());}
}
namespace v8 {
struct NativeMicrotaskData;
struct NativeMicrotaskRecord {
  NativeMicrotaskData* owner;
  JS::Heap<JSObject*> function{nullptr},global{nullptr};
  JS::Heap<JS::Value> continuation{JS::UndefinedValue()};
  MicrotaskCallback callback=nullptr;
  void* argument=nullptr;
  explicit NativeMicrotaskRecord(NativeMicrotaskData*);
  ~NativeMicrotaskRecord();
  void Trace(JSTracer* tracer){
    JS::TraceEdge(tracer,&function,"Native microtask function");
    JS::TraceEdge(tracer,&global,"Native microtask context");
    JS::TraceEdge(tracer,&continuation,"Native microtask async context");
  }
};
struct NativeJobQueue final:js::InternalJobQueue {
  NativeMicrotaskData& owner;
  NativeJobQueue(JSContext* cx,NativeMicrotaskData& input):js::InternalJobQueue(cx),owner(input){}
  bool getHostDefinedData(JSContext*,JS::MutableHandleObject,JS::MutableHandleObject)const override;
  bool getHostDefinedGlobal(JSContext*,JS::MutableHandleObject)const override;
  bool preservesHostDefinedData()const override;
  void runJobs(JSContext*)override;
  bool isDrainingStopped()const override;
  void traceNonGCThingMicroTask(JSTracer* tracer,JS::Value* value)override{
    static_cast<NativeMicrotaskRecord*>(value->toPrivate())->Trace(tracer);
  }
 protected:
  class Saved;
  js::UniquePtr<SavedJobQueue> saveJobQueue(JSContext*)override;
};
struct NativeMicrotaskData {
  Isolate* const isolate;
  JSContext* const cx;
  std::weak_ptr<State> state;
  MicrotaskQueue* queue=nullptr;
  const bool isDefault;
  std::unique_ptr<NativeJobQueue> jobs;
  std::unique_ptr<JS::PersistentRooted<js::UniquePtr<js::MicroTaskQueueSet>>> ownedQueues;
  std::weak_ptr<NativeMicrotaskData> defaultQueue;
  std::vector<std::weak_ptr<NativeMicrotaskData>> children;
  MicrotasksPolicy policy=MicrotasksPolicy::kAuto;
  int scopeDepth=0,suppressions=0;
  bool running=false,closed=false;
  size_t nativeRecords=0;
  NativeMicrotaskData(Isolate* input,bool primary)
      :isolate(input),cx(input->owner.lock()->cx),state(input->owner),isDefault(primary){
    if(isDefault)jobs=std::make_unique<NativeJobQueue>(cx,*this);
    else {
      auto queues=js::MakeUnique<js::MicroTaskQueueSet>(cx);
      if(!queues)bridge::FatalOutOfMemory(isolate,"VM microtask queue allocation",true);
      ownedQueues=std::make_unique<JS::PersistentRooted<js::UniquePtr<js::MicroTaskQueueSet>>>(cx,std::move(queues));
    }
  }
  ~NativeMicrotaskData(){CHECK(closed&&nativeRecords==0&&!ownedQueues);}
  std::shared_ptr<State> Owner(){
    auto result=state.lock();CHECK(result&&result->cx==js::TlsContext.get());
    result->AssertForeground();return result;
  }
  js::MicroTaskQueueSet* Queues(){
    CHECK(!closed);return isDefault?cx->microTaskQueues.get().get():ownedQueues->get().get();
  }
  void DropPending(){
    CHECK(cx==js::TlsContext.get());
    JS::Rooted<JS::GenericMicroTask> task(cx);
    while(!Queues()->empty()){
      task=Queues()->popFront();
      // A dead JS wrapper is still a GC object even though IsJSMicroTask
      // returns false for it. Only private non-GC entries are native records.
      if(!task.isObject())delete static_cast<NativeMicrotaskRecord*>(task.get().toPrivate());
    }
  }
  void Retire(){
    Owner();CHECK(!running&&scopeDepth==0&&suppressions==0);
    if(closed)return;
    DropPending();CHECK(nativeRecords==0);ownedQueues.reset();closed=true;
  }
};
NativeMicrotaskRecord::NativeMicrotaskRecord(NativeMicrotaskData* data):owner(data){
  CHECK(owner->nativeRecords!=SIZE_MAX);++owner->nativeRecords;
}
NativeMicrotaskRecord::~NativeMicrotaskRecord(){CHECK(owner->nativeRecords);--owner->nativeRecords;}
namespace {
const JSClass continuationSnapshotClass={"NodeContinuationSnapshot",JSCLASS_HAS_RESERVED_SLOTS(1)};
}
bool NativeJobQueue::preservesHostDefinedData()const{
  auto state=owner.state.lock();return state&&bool(state->continuationData);
}
bool NativeJobQueue::getHostDefinedGlobal(JSContext* cx,JS::MutableHandleObject global)const{
  CHECK(cx==owner.cx);
  global.set(preservesHostDefinedData()?JS::CurrentGlobalOrNull(cx):nullptr);return true;
}
bool NativeJobQueue::getHostDefinedData(JSContext* cx,JS::MutableHandleObject global,
                                       JS::MutableHandleObject hostData)const{
  global.set(nullptr);hostData.set(nullptr);CHECK(cx==owner.cx);
  auto state=owner.state.lock();CHECK(state);
  if(!state->continuationData)return true;
  JS::RootedValue snapshot(cx,state->ContinuationData());
  if(!JS_WrapValue(cx,&snapshot))return false;
  JS::RootedObject record(cx,JS_NewObjectWithGivenProto(cx,&continuationSnapshotClass,nullptr));
  if(!record)return false;
  JS::SetReservedSlot(record,0,snapshot);
  // Even undefined needs a record, or a resolver's frame would leak into a
  // reaction registered outside that scope. ESR requires an incumbent global.
  global.set(JS::CurrentGlobalOrNull(cx));hostData.set(record);return true;
}
void NativeJobQueue::runJobs(JSContext* cx){CHECK(cx==owner.cx);owner.queue->PerformCheckpoint(owner.isolate);}
bool NativeJobQueue::isDrainingStopped()const{return owner.closed||owner.cx->isNativeExecutionTerminating();}
class NativeJobQueue::Saved final:public JS::JobQueue::SavedJobQueue {
  NativeMicrotaskData& owner_;
  JS::PersistentRooted<js::MicroTaskQueueSet> saved_;
  bool running_;
 public:
  explicit Saved(NativeMicrotaskData& owner)
      :owner_(owner),saved_(owner.cx,std::move(*owner.cx->microTaskQueues)),running_(owner.running){owner_.running=false;}
  ~Saved(){
    CHECK(!JS::HasAnyMicroTasks(owner_.cx));
    *owner_.cx->microTaskQueues.get()=std::move(saved_.get());owner_.running=running_;
  }
};
js::UniquePtr<JS::JobQueue::SavedJobQueue> NativeJobQueue::saveJobQueue(JSContext* cx){
  CHECK(cx==owner.cx);
  // Allocate the save owner before moving the original engine queue set. Its
  // persistent root retains both queues; allocation failure changes neither.
  auto* result=new(std::nothrow) Saved(owner);
  if(!result){JS_ReportOutOfMemory(cx);return nullptr;}
  return js::UniquePtr<SavedJobQueue>(result);
}
namespace {
js::MicroTaskQueueSet* SelectNativeMicrotaskQueue(JSContext* cx,JSObject* global,void* raw){
  auto& primary=*static_cast<NativeMicrotaskData*>(raw);auto state=primary.Owner();CHECK(cx==primary.cx);
  JS::AutoCheckCannotGC nogc;
  auto* record=ExistingContextEmbedderStorage(*state,global);
  if(!record||!ContextFields(record).microtaskQueueAssociated)return primary.Queues();
  auto queue=ContextFields(record).microtaskQueue.lock();
  CHECK(queue&&!queue->closed&&queue->cx==cx&&queue->queue);
  return queue->Queues();
}
bool AllNativeMicrotaskQueuesEmpty(NativeMicrotaskData& data){
  auto primary=data.defaultQueue.lock();
  CHECK(data.isDefault||(primary&&!primary->closed));
  NativeMicrotaskData& root=data.isDefault?data:*primary;
  if(!root.Queues()->empty())return false;
  for(auto& weak:root.children)if(auto child=weak.lock())if(!child->closed&&!child->Queues()->empty())return false;
  return true;
}
}
MicrotaskQueue::MicrotaskQueue(Isolate* isolate,bool isDefault):data_(std::make_shared<NativeMicrotaskData>(isolate,isDefault)){
  data_->queue=this;
  if(isDefault){
    JS::SetJobQueue(data_->cx,data_->jobs.get());
    CHECK(!data_->cx->embedderMicroTaskQueueSelector);
    data_->cx->embedderMicroTaskQueueData=data_.get();
    data_->cx->embedderMicroTaskQueueSelector=SelectNativeMicrotaskQueue;
  }
}
MicrotaskQueue::~MicrotaskQueue(){if(data_&&!data_->closed)RetireNativeMicrotasks();data_->queue=nullptr;}
std::unique_ptr<MicrotaskQueue> MicrotaskQueue::New(Isolate* isolate,MicrotasksPolicy policy){
  auto state=isolate->owner.lock();CHECK(state&&state->microtasks);state->AssertForeground();
  try {
    auto result=std::unique_ptr<MicrotaskQueue>(new MicrotaskQueue(isolate,false));
    result->data_->policy=policy;result->data_->defaultQueue=state->microtasks->data_;
    auto& children=state->microtasks->data_->children;
    children.erase(std::remove_if(children.begin(),children.end(),[](const auto& item){return item.expired();}),children.end());
    children.push_back(result->data_);return result;
  }catch(const std::bad_alloc&){bridge::FatalOutOfMemory(isolate,"VM microtask queue metadata allocation",false);}
}
bool MicrotaskQueue::IsRunningMicrotasks()const{return data_->running;}
int MicrotaskQueue::GetMicrotasksScopeDepth()const{data_->Owner();return data_->scopeDepth;}
void NativeEntry::CaptureAutoQueue(Local<Context> context){
  state.AssertForeground();CHECK(cx==js::TlsContext.get());
  if(!state.microtasks){autoQueue.reset();return;}
  JS::AutoCheckCannotGC nogc;
  JSObject* global=context.IsEmpty()?JS::CurrentGlobalOrNull(cx):&context->cell().value.get().toObject();
  if(!context.IsEmpty())CHECK(context->isolate==&state.isolate);
  auto* record=global?ExistingContextEmbedderStorage(state,global):nullptr;
  if(record&&ContextFields(record).microtaskQueueAssociated){
    autoQueue=ContextFields(record).microtaskQueue.lock();
    CHECK(autoQueue&&!autoQueue->closed&&autoQueue->queue);
  }else autoQueue=state.microtasks->data_;
}
MicrotasksScope::MicrotasksScope(Local<Context> context,Type type)
    :MicrotasksScope(context->isolate,context->GetMicrotaskQueue(),type){}
MicrotasksScope::MicrotasksScope(Isolate* isolate,MicrotaskQueue* queue,Type type)
    :isolate_(isolate),run_(type==kRunMicrotasks){
  auto state=isolate->owner.lock();CHECK(state&&state->microtasks);state->AssertForeground();
  queue_=queue?queue->data_:state->microtasks->data_;
  CHECK(queue_->isolate==isolate&&!queue_->closed);queue_->Owner();
  CHECK(type==kRunMicrotasks||type==kDoNotRunMicrotasks);
  if(run_){CHECK_LT(queue_->scopeDepth,INT_MAX);++queue_->scopeDepth;}
}
MicrotasksScope::~MicrotasksScope(){
  queue_->Owner();CHECK(!queue_->closed);
  if(run_){
    CHECK(queue_->scopeDepth>0);--queue_->scopeDepth;
    if(queue_->policy==MicrotasksPolicy::kScoped&&!JS_IsExceptionPending(queue_->cx)&&
       !queue_->cx->isNativeExecutionTerminating())queue_->queue->PerformCheckpoint(isolate_);
  }
}
void MicrotasksScope::PerformCheckpoint(Isolate* isolate){isolate->PerformMicrotaskCheckpoint();}
int MicrotasksScope::GetCurrentDepth(Isolate* isolate){
  auto state=isolate->owner.lock();CHECK(state&&state->microtasks);
  return state->microtasks->GetMicrotasksScopeDepth();
}
bool MicrotasksScope::IsRunningMicrotasks(Isolate* isolate){
  auto state=isolate->owner.lock();CHECK(state&&state->microtasks);state->AssertForeground();
  return state->microtasks->IsRunningMicrotasks();
}
struct MicrotaskSuppressionData {
  std::shared_ptr<State> state;
  std::shared_ptr<NativeMicrotaskData> queue;
  MicrotaskSuppressionData(Isolate* isolate,MicrotaskQueue* input):state(isolate->owner.lock()){
    CHECK(state&&state->microtasks);state->AssertForeground();
    queue=input?input->data_:state->microtasks->data_;
    CHECK(queue->isolate==isolate&&!queue->closed);queue->Owner();
    CHECK_LT(queue->suppressions,INT_MAX);CHECK(state->microtaskCallSuppressions!=SIZE_MAX);
    ++queue->suppressions;++state->microtaskCallSuppressions;
  }
  ~MicrotaskSuppressionData(){
    state->AssertForeground();CHECK(!queue->closed&&queue->suppressions>0&&state->microtaskCallSuppressions);
    --queue->suppressions;--state->microtaskCallSuppressions;
    // Suppression exit is not an API call-completion/checkpoint event.
  }
};
Isolate::SuppressMicrotaskExecutionScope::SuppressMicrotaskExecutionScope(Isolate* isolate,MicrotaskQueue* queue)
    :data_(std::make_unique<MicrotaskSuppressionData>(isolate,queue)){}
Isolate::SuppressMicrotaskExecutionScope::~SuppressMicrotaskExecutionScope()=default;
namespace {
void EnqueueNativeMicrotask(NativeMicrotaskData& data,std::unique_ptr<NativeMicrotaskRecord> task){
  CHECK(!data.closed);auto state=data.Owner();
  task->global=JS::CurrentGlobalOrNull(data.cx);
  task->continuation=state->continuationData?state->ContinuationData():JS::UndefinedValue();
  JS::RootedValue value(data.cx,JS::PrivateValue(task.get()));
  if(!data.Queues()->enqueueRegularMicroTask(data.cx,value))bridge::FatalOutOfMemory(data.isolate,"Native microtask enqueue",true);
  task.release();
}
std::unique_ptr<NativeMicrotaskRecord> NewNativeMicrotask(NativeMicrotaskData& data){
  auto* result=new(std::nothrow) NativeMicrotaskRecord(&data);
  if(!result)bridge::FatalOutOfMemory(data.isolate,"Native microtask metadata allocation",false);
  return std::unique_ptr<NativeMicrotaskRecord>(result);
}
bool RunNativeMicrotask(NativeMicrotaskData& data,NativeMicrotaskRecord& task){
  auto* cx=data.cx;auto& frame=Current(data.isolate);
  // Once popped, the queue no longer traces this record. Root every JS edge
  // before a realm entry, allocation or callback can collect/move anything.
  JS::RootedObject functionObject(cx,task.function),global(cx,task.global);
  JS::RootedValue continuation(cx,task.continuation);
  JS::RootedValue previous(cx,frame.state->continuationData?frame.state->ContinuationData():JS::UndefinedValue());
  auto restore=mozilla::MakeScopeExit([&]{if(frame.state->continuationData)frame.state->ContinuationData()=previous;});
  frame.state->ContinuationData()=continuation;
  std::optional<Context::Scope> home;
  if(global)home.emplace(frame.OwnContext(global));
  if(functionObject){
    JS::RootedValue function(cx,JS::ObjectValue(*functionObject)),result(cx);
    if(!JS_WrapValue(cx,&function)||!JS::Call(cx,JS::UndefinedHandleValue,function,JS::HandleValueArray::empty(),&result))return false;
  }else {CHECK(task.callback);task.callback(task.argument);}
  return !JS_IsExceptionPending(cx)&&!cx->isNativeExecutionTerminating();
}
}
void MicrotaskQueue::EnqueueMicrotask(Isolate* isolate,Local<Function> function){
  auto& data=*data_;CHECK(isolate==data.isolate&&!function.IsEmpty());data.Owner();
  auto task=NewNativeMicrotask(data);
  JS::RootedObject callable(data.cx,UnwrapObject(data.cx,Input(function)));CHECK(callable&&JS::IsCallable(callable));
  task->function=callable;EnqueueNativeMicrotask(data,std::move(task));
}
void MicrotaskQueue::EnqueueMicrotask(Isolate* isolate,MicrotaskCallback callback,void* argument){
  auto& data=*data_;CHECK(isolate==data.isolate&&callback);data.Owner();
  auto task=NewNativeMicrotask(data);task->callback=callback;task->argument=argument;
  EnqueueNativeMicrotask(data,std::move(task));
}
void MicrotaskQueue::PerformCheckpoint(Isolate* isolate){
  auto& data=*data_;CHECK(isolate==data.isolate&&!data.closed);auto state=data.Owner();
  if(data.running||data.scopeDepth||data.suppressions||data.cx->isNativeExecutionTerminating()||JS_IsExceptionPending(data.cx))return;
  Isolate::Scope isolateScope(isolate);HandleScope handles(isolate);auto& frame=Current(isolate);
  data.running=true;auto leave=mozilla::MakeScopeExit([&]{data.running=false;});
  Isolate::SuppressMicrotaskExecutionScope suppress(isolate,this);
  JS::RootedValue callerContinuation(data.cx,state->continuationData?state->ContinuationData():JS::UndefinedValue());
  auto restoreContinuation=mozilla::MakeScopeExit([&]{
    if(state->continuationData)state->ContinuationData()=callerContinuation;
  });
  if(state->continuationData)state->ContinuationData()=JS::UndefinedValue();
  // Keep this API call active across job execution so an outer native catch
  // cannot steal an error before intervening JS catch/finally blocks run.
  // It retires while running is still true, suppressing recursive auto drains.
  NativeEntry entry(frame);
  JS::Rooted<JS::GenericMicroTask> task(data.cx);
  JS::Rooted<JS::JSMicroTask*> job(data.cx);
  JS::RootedObject reportingGlobal(data.cx);
  while(!data.Queues()->empty()&&!data.cx->isNativeExecutionTerminating()){
    task=data.Queues()->popFront();
    if(AllNativeMicrotaskQueuesEmpty(data))JS::JobQueueIsEmpty(data.cx);
    // A nested drain may run an unrelated native callback. Only the current
    // job contributes suspended callers to Error.captureStackTrace.
    JS::RootedObject activeJob(data.cx, task.isObject() ? JS::ToMaybeWrappedJSMicroTask(task) : nullptr);
    auto* previousJob = data.cx->activeErrorStackJob.ref();
    data.cx->activeErrorStackJob = &activeJob;
    auto restoreActiveJob = mozilla::MakeScopeExit([&]{ data.cx->activeErrorStackJob = previousJob; });
    bool success;
    if(task.isObject()){
      job=activeJob;
      JS::RootedObject global(data.cx,JS::GetExecutionGlobalFromJSMicroTask(job));
      if(!global)continue;
      reportingGlobal=global;
      Context::Scope home(frame.OwnContext(global));
      JS::RootedValue previous(data.cx,state->continuationData?state->ContinuationData():JS::UndefinedValue());
      auto restoreJobContext=mozilla::MakeScopeExit([&]{
        if(state->continuationData)state->ContinuationData()=previous;
      });
      if(state->continuationData){
        JS::RootedObject incumbent(data.cx),hostData(data.cx);
        success=JS::MaybeGetHostDefinedDataFromJSMicroTask(job,&incumbent,&hostData);
        JS::RootedValue snapshot(data.cx);
        if(success&&hostData){
          JS::RootedObject record(data.cx,js::CheckedUnwrapStatic(hostData));
          if(!record||JS::GetClass(record)!=&continuationSnapshotClass){
            JS_ReportErrorASCII(data.cx,"Invalid native job host data");success=false;
          }else {snapshot=JS::GetReservedSlot(record,0);success=JS_WrapValue(data.cx,&snapshot);}
        }
        if(success)state->ContinuationData()=snapshot;
        else if(!JS_IsExceptionPending(data.cx))JS_ReportErrorASCII(data.cx,"Unavailable native job host data");
      }else success=true;
      if(success)success=JS::RunJSMicroTask(data.cx,job);
    }else {
      std::unique_ptr<NativeMicrotaskRecord> native(static_cast<NativeMicrotaskRecord*>(task.get().toPrivate()));
      reportingGlobal=native->global;
      success=RunNativeMicrotask(data,*native);
    }
    if(!success){
      std::optional<Context::Scope> home;
      if(reportingGlobal)home.emplace(frame.OwnContext(reportingGlobal));
      if(!bridge::ReportMicrotaskException(isolate))break;
    }
  }
  // V8 drops pending jobs on termination; cancellation must not resurrect them.
  if(data.cx->isNativeExecutionTerminating())data.DropPending();
  JS::ClearKeptObjects(data.cx);
}
void MicrotaskQueue::RetireNativeMicrotasks(){
  auto& data=*data_;data.Owner();CHECK(!data.running);
  // Drop roots/metadata without invoking callbacks or dereferencing opaque
  // callback data. Original Node still owns and retires callback targets.
  if(data.isDefault&&!data.closed){
    for(auto& weak:data.children)if(auto child=weak.lock())child->Retire();
    data.children.clear();data.cx->embedderMicroTaskQueueSelector=nullptr;data.cx->embedderMicroTaskQueueData=nullptr;
  }
  data.Retire();
}
MicrotaskQueue* Context::GetMicrotaskQueue(){
  auto state=isolate->owner.lock();CHECK(state&&state->microtasks);state->AssertForeground();
  JS::AutoCheckCannotGC nogc;auto* record=ExistingContextEmbedderStorage(*state,&cell().value.get().toObject());
  if(record&&ContextFields(record).microtaskQueueAssociated){
    auto selected=ContextFields(record).microtaskQueue.lock();CHECK(selected&&!selected->closed&&selected->queue);
    return selected->queue;
  }
  return state->microtasks;
}
void Isolate::SetMicrotasksPolicy(MicrotasksPolicy policy){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  CHECK(policy==MicrotasksPolicy::kExplicit||policy==MicrotasksPolicy::kAuto||policy==MicrotasksPolicy::kScoped);
  CHECK(native_->microtasks);native_->microtasks->data_->policy=policy;
}
MicrotasksPolicy Isolate::GetMicrotasksPolicy()const{CHECK(native_&&native_->microtasks);native_->AssertForeground();return native_->microtasks->data_->policy;}
void Isolate::PerformMicrotaskCheckpoint(){CHECK(native_&&native_->microtasks);native_->microtasks->PerformCheckpoint(this);}
void Isolate::ClearKeptObjects(){auto state=owner.lock();CHECK(state);state->AssertForeground();JS::ClearKeptObjects(state->cx);}
bool Isolate::AddMessageListenerWithErrorLevel(MessageCallback callback,int levels){
  CHECK(native_&&callback);native_->AssertForeground();
  try {native_->messageListeners.emplace_back(callback,levels);return true;}
  catch(const std::bad_alloc&){return false;}
}
namespace bridge {
void OnNativeCallCompleted(Isolate* isolate,const std::shared_ptr<NativeMicrotaskData>& queue){
  if(!isolate->native_)return;auto& data=*isolate->native_;
  if(data.phase!=NativeIsolatePhase::Live||!data.state||data.state->microtaskCallSuppressions||
     data.cx->embedderExecutionRestrictions()||data.cx->activation())return;
  if(data.finalizationTasks)data.finalizationTasks->PostNext();
  if(queue){
    CHECK(!queue->closed&&queue->queue);
    if(queue->policy==MicrotasksPolicy::kAuto)queue->queue->PerformCheckpoint(isolate);
  }
}
bool ReportMicrotaskException(Isolate* isolate){
  auto state=isolate->owner.lock();CHECK(state);auto* cx=state->cx;
  if(cx->isNativeExecutionTerminating()||!JS_IsExceptionPending(cx))return false;
  if(cx->exceptionStatus()==JS::ExceptionStatus::OutOfMemory)FatalOutOfMemory(isolate,"Microtask execution",true);
  if(!JS::CurrentGlobalOrNull(cx))return false;
  JS::ExceptionStack stack(cx);if(!JS::StealPendingExceptionStack(cx,&stack))return false;
  MaybeAbortOnUncaught(isolate,stack.exception(),stack.stack());
  return ReportNativeException(isolate,stack.exception(),stack.stack());
}
void MaybeAbortOnUncaught(Isolate* isolate,JS::HandleValue error,JS::HandleObject stack){
  if(!AbortOnUncaughtEnabled())return;
  auto state=isolate->owner.lock();CHECK(state&&isolate->native_);state->AssertForeground();
  auto* cx=state->cx;if(cx->isNativeExecutionTerminating())return;
  PreserveNativeFailure pending(cx);NativeCallbackEntry entry(*state);
  if(auto callback=isolate->native_->abortOnUncaught;callback&&!callback(isolate))return;
  JS::ExceptionStack exception(cx,error,stack);JS::ErrorReportBuilder report(cx);
  if(report.init(cx,exception,JS::ErrorReportBuilder::NoSideEffects))JS::PrintError(stderr,report,false);
  JS::RootedString text(cx);
  if(stack&&JS::BuildStackString(cx,nullptr,stack,&text,0,js::StackFormat::V8)){
    auto bytes=JS_EncodeStringToUTF8(cx,text);if(bytes)std::fprintf(stderr,"%s\n",bytes.get());
  }
  kandelo_v8_graceful_fatal("Aborting on uncaught JavaScript exception");
}
bool ReportNativeException(Isolate* isolate,JS::HandleValue error,JS::HandleObject saved){
  auto state=isolate->owner.lock();CHECK(state&&isolate->native_);state->AssertForeground();
  auto* cx=state->cx;auto& listeners=isolate->native_->messageListeners;
  if(listeners.empty()||!JS::CurrentGlobalOrNull(cx))return false;
  NativeCallbackEntry entry(*state);auto& frame=Current(isolate);
  auto exception=frame.OwnValue(error);auto message=NativeMessage(isolate,exception,saved,true);
  if(message.IsEmpty())return false;
  // Registrations can change during the original Node listener's callback.
  std::vector<std::pair<MessageCallback,int>> callbacks;
  try {callbacks=listeners;}catch(const std::bad_alloc&){FatalOutOfMemory(isolate,"Native error listener dispatch",false);}
  for(const auto& [callback,levels]:callbacks){if(levels&message->ErrorLevel())callback(message,exception);}
  return !JS_IsExceptionPending(cx)&&!cx->isNativeExecutionTerminating();
}
}
namespace {
void ReportNodePrivateReadError(JSContext* cx, JS::HandleString name,
                                JS::HandleValue receiver, JS::PrivateReadKind kind) {
  auto bytes = JS_EncodeStringToUTF8(cx, name);
  if (!bytes) return;
  const char* label = JS_GetStringLength(name) == 0 ? "." : bytes.get();
  static constexpr JSErrorFormatString errors[] = {
      {"NodeCannotReadPrivateMember",
       "Cannot read private member {0} from an object whose class did not declare it",
       1, JSEXN_TYPEERR},
      {"NodeCannotReadNullishProperty", "Cannot read properties of {0} (reading '{1}')",
       2, JSEXN_TYPEERR},
      {"NodeWrongPrivateInstance", "Receiver must be an instance of class {0}",
       1, JSEXN_TYPEERR},
      {"NodeWrongPrivateClass", "Receiver must be class {0}", 1, JSEXN_TYPEERR},
  };
  auto format = [](void*, unsigned index) -> const JSErrorFormatString* {
    return &errors[index];
  };
  if (kind == JS::PrivateReadKind::StaticMember) {
    JS_ReportErrorNumberUTF8(cx, format, nullptr, 3, label);
  } else if (receiver.isNullOrUndefined()) {
    JS_ReportErrorNumberUTF8(cx, format, nullptr, 1,
                            receiver.isNull() ? "null" : "undefined", label);
  } else {
    CHECK(kind == JS::PrivateReadKind::Field ||
          kind == JS::PrivateReadKind::InstanceMember);
    JS_ReportErrorNumberUTF8(cx, format, nullptr,
                            kind == JS::PrivateReadKind::Field ? 0 : 2, label);
  }
}

void ReportNodeSymbolToStringError(JSContext* cx) {
  auto format = [](void*, unsigned) -> const JSErrorFormatString* {
    static constexpr JSErrorFormatString error = {
        "JSMSG_SYMBOL_TO_STRING",
        "Cannot convert a Symbol value to a string",
        0,
        JSEXN_TYPEERR};
    return &error;
  };
  JS_ReportErrorNumberASCII(cx, format, nullptr, JSMSG_SYMBOL_TO_STRING);
}

void ReportNodeStringRepeatError(JSContext* cx, double count) {
  if (count < 0 || !std::isfinite(count)) {
    JS::RootedValue value(cx, JS::DoubleValue(count));
    JS::RootedString string(cx, JS::ToString(cx, value));
    if (!string) return;
    auto bytes = JS_EncodeStringToUTF8(cx, string);
    if (!bytes) return;
    auto format = [](void*, unsigned) -> const JSErrorFormatString* {
      static constexpr JSErrorFormatString error = {
          "NodeInvalidRepeatCount", "Invalid count value: {0}", 1, JSEXN_RANGEERR};
      return &error;
    };
    JS_ReportErrorNumberUTF8(cx, format, nullptr, 0, bytes.get());
    return;
  }
  auto format = [](void*, unsigned) -> const JSErrorFormatString* {
    static constexpr JSErrorFormatString error = {
        "NodeInvalidStringLength", "Invalid string length", 0, JSEXN_RANGEERR};
    return &error;
  };
  JS_ReportErrorNumberUTF8(cx, format, nullptr, 0);
}

void ReportNodeTypedArrayLength(JSContext* cx, JS::HandleValue length) {
  JS::RootedString string(cx, JS::ToString(cx, length));
  if (!string) return;
  auto bytes = JS_EncodeStringToUTF8(cx, string);
  if (!bytes) return;
  auto format = [](void*, unsigned) -> const JSErrorFormatString* {
    static constexpr JSErrorFormatString error = {
        "JSMSG_BAD_ARRAY_LENGTH", "Invalid typed array length: {0}", 1, JSEXN_RANGEERR};
    return &error;
  };
  JS_ReportErrorNumberUTF8(cx, format, nullptr, JSMSG_BAD_ARRAY_LENGTH, bytes.get());
}

const JSClass nativeNodeGlobalClass={"global",JSCLASS_GLOBAL_FLAGS,&JS::DefaultGlobalClassOps};
const JSClassOps nativeInterceptedGlobalOps=[] {
  auto ops=JS::DefaultGlobalClassOps;ops.newEnumerate=EnumerateNativeTemplate;return ops;
}();
// A real engine global retains SpiderMonkey's own trace/global slots. Its
// constructor edge belongs to the existing context metadata, not wrapper slots.
const JSClass nativeInterceptedGlobalClass={"global",JSCLASS_GLOBAL_FLAGS,
  &nativeInterceptedGlobalOps,nullptr,&interceptedTemplateExtension};
bool IsNativeInterceptedGlobal(JSObject* object){
  return JS::GetClass(object)==&nativeInterceptedGlobalClass;
}
JSObject* NativeGlobalInterceptorConstructor(JSContext* cx,JS::HandleObject global){
  auto state=ReadNativeEngineState(cx);if(!state)return nullptr;
  state->AssertForeground();CHECK(state->cx==cx&&IsNativeInterceptedGlobal(global));
  JS::RootedObject storage(cx,ExistingContextEmbedderStorage(*state,global));
  if(!storage)return nullptr;
  return UnwrapTemplateObject(cx,JS::GetReservedSlot(storage,6));
}
}
Local<Context> Context::New(Isolate* isolate,ExtensionConfiguration* extensions,Local<ObjectTemplate> objectTemplate,
    Local<Value> globalObject,DeserializeInternalFieldsCallback deserialize,MicrotaskQueue* queue){
  auto& frame=Current(isolate);NativeEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return {};
  CHECK(!extensions&&globalObject.IsEmpty()&&!deserialize.callback);
  auto state=isolate->owner.lock();CHECK(state&&state->microtasks);
  if(!queue)queue=state->microtasks;
  CHECK(queue->data_->isolate==isolate&&!queue->data_->closed);
  JS::RootedObject record(frame.cx),constructor(frame.cx);
  bool intercepted=false;
  if(!objectTemplate.IsEmpty()){
    record=TemplateRecord(frame,objectTemplate);
    constructor=UnwrapTemplateObject(frame.cx,JS::GetReservedSlot(record,TemplateConstructor));
    intercepted=constructor&&NativeTemplateHasInterceptors(frame,constructor);
  }
  JS::RealmOptions options;options.creationOptions().setSharedMemoryAndAtomicsEnabled(true);
  options.creationOptions().setImmutableArrayBuffersEnabled(bridge::ImmutableArrayBuffersEnabled());
  // Node 26's V8 configuration uses JSTypedArray::kMaxSizeInHeap (64 bytes).
  options.creationOptions().setMaxLazyTypedArrayBytes(64);
  options.creationOptions().setTypedArrayLengthErrorReporter(ReportNodeTypedArrayLength);
  options.creationOptions().setStringRepeatErrorReporter(ReportNodeStringRepeatError);
  options.creationOptions().setSymbolToStringErrorReporter(ReportNodeSymbolToStringError);
  options.creationOptions().setPrivateReadErrorReporter(ReportNodePrivateReadError);
  options.creationOptions().setCaptureCallReceivers(true);
  options.creationOptions().setNodeNativeFunctionSource(true);
  JS::RootedObject global(frame.cx,JS_NewGlobalObject(frame.cx,
    intercepted?&nativeInterceptedGlobalClass:&nativeNodeGlobalClass,
    nullptr,JS::DontFireOnNewGlobalHook,options));
  if(!global)return {};
  bridge::ApplyUncaughtStackCapture(isolate,JS::GetObjectRealmOrNull(global));
  auto context=frame.OwnContext(global);Context::Scope home(context);
  JS::RootedObject storage(frame.cx,EnsureContextEmbedderStorage(frame,*context.operator->()));
  if(intercepted){
    JS::RootedValue brand(frame.cx,JS::ObjectValue(*constructor));
    if(!JS_WrapValue(frame.cx,&brand))return {};
    JS::SetReservedSlot(storage,6,brand);TemplateInfo(constructor).used=true;
  }
  ContextFields(storage).microtaskQueue=queue->data_;ContextFields(storage).microtaskQueueAssociated=true;
  entry.CaptureAutoQueue(context);
  JS_FireOnNewGlobalObject(frame.cx,global);
  if(!JS::InitRealmStandardClasses(frame.cx))return {};
  if (objectTemplate.IsEmpty()) {
    // A plain Node global has a per-realm prototype between it and
    // Object.prototype. Worker bootstrap installs its scope on that object.
    JS::RootedObject globalPrototype(frame.cx, JS_NewPlainObject(frame.cx));
    JS::RootedObject objectConstructor(frame.cx);
    if (!globalPrototype ||
        !JS_GetClassObject(frame.cx, JSProto_Object, &objectConstructor) ||
        !JS_DefineProperty(frame.cx, globalPrototype, "constructor", objectConstructor, 0) ||
        !JS_SetPrototype(frame.cx, global, globalPrototype)) {
      return {};
    }
  }
  if(!InitializeNativeExtras(frame,context))return {};
  JS::RootedObject errorStacks(frame.cx,kandelo::node::CreateErrorStackState(frame.cx));
  if(!errorStacks)return {};
  JS::SetReservedSlot(storage,3,JS::ObjectValue(*errorStacks));
  if(!objectTemplate.IsEmpty()){
    if(!AdmitNativeTemplateInstantiation(frame,record,global))return {};
    // Global interceptors/internal fields need their own global/proxy layout;
    // never write generic wrapper fields over SpiderMonkey's reserved slots.
    CHECK(TemplateInfo(record).fieldCount==0);
    if(!ApplyTemplateProperties(frame,record,global,context))return {};
    if (constructor) {
      // Like a template instance, a contextified global inherits the
      // constructor's prototype from the new realm.
      JS::RootedValue constructorRecord(frame.cx, JS::ObjectValue(*constructor));
      Local<Function> function;
      if (!frame.Own<FunctionTemplate>(constructorRecord)->GetFunction(context).ToLocal(&function)) {
        return {};
      }
      JS::RootedObject callable(frame.cx, &Input(function).toObject());
      JS::RootedValue prototype(frame.cx);
      if (!JS_GetProperty(frame.cx, callable, "prototype", &prototype)) return {};
      if (prototype.isObject()) {
        JS::RootedObject globalPrototype(frame.cx, &prototype.toObject());
        if (!JS_SetPrototype(frame.cx, global, globalPrototype)) return {};
      }
    }
  }
  return context;
}
}
#endif
