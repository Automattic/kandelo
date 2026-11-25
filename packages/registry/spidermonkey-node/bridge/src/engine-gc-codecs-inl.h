#ifndef KANDELO_ENGINE_GC_CODECS_INL_H
#define KANDELO_ENGINE_GC_CODECS_INL_H

namespace cppgc::internal {
enum class AllocationPhase {Constructing,Live,Retired,Destroyed};
struct NativeAllocation {
  v8::NativeCppHeap* heap=nullptr;
  void* storage=nullptr;
  size_t bytes=0,alignment=0;
  NativeTrace trace=nullptr;
  NativeDestroy destroy=nullptr;
  AllocationPhase phase=AllocationPhase::Constructing;
  JS::Heap<JSObject*> wrapper{nullptr};
  bool published=false,finalized=false;
  const std::thread::id foreground=std::this_thread::get_id();
  void AssertForeground()const{CHECK(foreground==std::this_thread::get_id());}
};
static thread_local std::shared_ptr<NativeAllocation> currentConstruction;
AllocationMember::AllocationMember():allocation_(currentConstruction){}
bool NativeAllocationIsAlive(const std::shared_ptr<NativeAllocation>& record){
  if(!record)return false;record->AssertForeground();
  return record->phase==AllocationPhase::Constructing||record->phase==AllocationPhase::Live;
}
}

namespace v8 {
using cppgc::internal::AllocationPhase;
using cppgc::internal::NativeAllocation;
struct NativeCppHeap {
  Platform* const platform;
  cppgc::AllocationHandle allocation;
  JSContext* cx=nullptr;
  Isolate* isolate=nullptr;
  std::list<std::shared_ptr<NativeAllocation>> records;
  size_t objectBytes=0;
  bool terminated=false,draining=false,retirementPending=false;
  const std::thread::id foreground=std::this_thread::get_id();
  NativeCppHeap(Platform* input,CppHeap* heap):platform(input),allocation(heap){}
  void AssertForeground()const{CHECK(foreground==std::this_thread::get_id());}
};
namespace {
void TraceNativeAllocation(JSTracer* tracer,NativeAllocation& record){
  // SpiderMonkey may trace on a parallel GC thread while the mutator is
  // stopped. These original Trace methods only enumerate barriered edges;
  // native mutation, weak death and destruction remain on the owner thread.
  if(!record.published||(record.phase!=AllocationPhase::Constructing&&record.phase!=AllocationPhase::Live))return;
  JS::TraceEdge(tracer,&record.wrapper,"Node native wrapper association");
  cppgc::Visitor visitor(tracer);record.trace(record.storage,&visitor);
}
void TraceNativeConstructionRoots(JSTracer* tracer,void* raw){
  auto& heap=*static_cast<NativeCppHeap*>(raw);
  for(auto& record:heap.records)
    if(record->phase==AllocationPhase::Constructing)TraceNativeAllocation(tracer,*record);
}
void RetireNativeAllocation(NativeAllocation& record){
  record.AssertForeground();
  record.heap->retirementPending=true;
  if(record.phase==AllocationPhase::Constructing||record.phase==AllocationPhase::Live)
    record.phase=AllocationPhase::Retired;
}
void ClearNativeGcAssociation(NativeAllocation& record){
  if(!record.wrapper)return;
  JSObject* wrapper=record.wrapper;
  auto value=JS::GetReservedSlot(wrapper,NativeCppgcAssociation);
  CHECK(!value.isUndefined()&&value.toPrivate()==&record);
  JS::SetReservedSlot(wrapper,NativeCppgcAssociation,JS::UndefinedValue());
  // Only clear opaque fields pointing inside this typed allocation. Never
  // reinterpret the separate ordinary BaseObject owner slot or its type ID.
  auto fields=JS::GetReservedSlot(wrapper,NativeInternalFields);
  if(fields.isObject()){
    auto count=fields.toObject().as<js::ArrayObject>().length();
    for(uint32_t index=0;index<count;++index){
      JSObject* field=ExistingPointerFieldRecord(record.heap->cx,wrapper,int(index));
      if(!field)continue;
      auto* info=static_cast<InternalFieldInfo*>(JS::GetReservedSlot(field,0).toPrivate());
      if(info->isValue)continue;
      uintptr_t pointer=reinterpret_cast<uintptr_t>(info->pointer);
      uintptr_t start=reinterpret_cast<uintptr_t>(record.storage);
      if(pointer>=start&&pointer-start<record.bytes)info->pointer=nullptr;
    }
  }
  record.wrapper=nullptr;record.finalized=true;
}
void FreeNativeStorage(NativeAllocation& record){
  CHECK(record.storage&&record.heap->objectBytes>=record.bytes);
  ::operator delete(record.storage,std::align_val_t(record.alignment));
  record.storage=nullptr;record.heap->objectBytes-=record.bytes;
}
}
CppHeap::CppHeap(Platform* platform):data_(std::make_unique<NativeCppHeap>(platform,this)){}
std::unique_ptr<CppHeap> CppHeap::Create(Platform* platform,const CppHeapCreateParams& params){
  CHECK(platform&&params.custom_spaces.empty());return std::unique_ptr<CppHeap>(new CppHeap(platform));
}
CppHeap::~CppHeap(){Terminate();}
cppgc::AllocationHandle& CppHeap::GetAllocationHandle(){
  data_->AssertForeground();CHECK(data_->cx&&!data_->terminated);return data_->allocation;
}
bool CppHeap::AttachToIsolate(Isolate* isolate){
  auto& heap=*data_;heap.AssertForeground();CHECK(!heap.cx&&!heap.terminated);
  auto state=isolate->owner.lock();CHECK(state&&state->cx==js::TlsContext.get()&&!state->cppHeap);
  if(!JS_AddExtraGCRootsTracer(state->cx,TraceNativeConstructionRoots,&heap)){
    JS_ReportOutOfMemory(state->cx);return false;
  }
  heap.cx=state->cx;heap.isolate=isolate;state->cppHeap=this;return true;
}
CppHeap* Isolate::GetCppHeap(){
  auto state=owner.lock();CHECK(state);state->AssertForeground();return state->cppHeap;
}
void CppHeap::UpdateWeakEdges(JSTracer* tracer){
  auto& heap=*data_;heap.AssertForeground();
  for(auto& record:heap.records){
    if(!record->published||!record->wrapper)continue;
    JS_UpdateWeakPointerAfterGC(tracer,&record->wrapper);
    // Clear weak native access in this same weak phase, before any mutator
    // yield. C++ destruction waits for a heap-idle native safe point.
    if(!record->wrapper)RetireNativeAllocation(*record);
  }
}
void CppHeap::DrainRetired(){
  auto& heap=*data_;heap.AssertForeground();
  if(!heap.cx||heap.draining||!heap.retirementPending)return;
  CHECK(heap.cx==js::TlsContext.get());js::AssertHeapIsIdle();
  heap.draining=true;auto done=mozilla::MakeScopeExit([&]{heap.draining=false;});
  PreserveNativeFailure preserve(heap.cx);
  Isolate::DisallowJavascriptExecutionScope noJavascript(heap.isolate,
      Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
  do {
    heap.retirementPending=false;
    for(auto& record:heap.records){
      if(record->phase!=AllocationPhase::Retired)continue;
      record->phase=AllocationPhase::Destroyed;
      record->destroy(record->storage);FreeNativeStorage(*record);
    }
    // Keep a native-only tombstone while the dead JS wrapper still contains its
    // association. Its later finalizer must never dereference a freed record.
    heap.records.remove_if([](const auto& record){
      return record->phase==AllocationPhase::Destroyed&&record->finalized;
    });
  }while(heap.retirementPending);
}
void CppHeap::Terminate(){
  auto& heap=*data_;heap.AssertForeground();if(heap.terminated)return;
  CHECK(!heap.draining);heap.terminated=true;
  if(!heap.cx){CHECK(heap.records.empty());return;}
  CHECK(heap.cx==js::TlsContext.get());js::AssertHeapIsIdle();
  PreserveNativeFailure preserve(heap.cx);
  Isolate::DisallowJavascriptExecutionScope noJavascript(heap.isolate,
      Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
  for(auto& record:heap.records){
    CHECK(record->phase!=AllocationPhase::Constructing);
    if(record->wrapper)ClearNativeGcAssociation(*record);
    // A null weak edge can precede the JS object's finalizer. Finish that
    // finalization with the real collector before dropping its tombstone.
    RetireNativeAllocation(*record);
  }
  DrainRetired();
  JS::PrepareForFullGC(heap.cx);
  JS::NonIncrementalGC(heap.cx,JS::GCOptions::Shrink,JS::GCReason::API);
  DrainRetired();CHECK(heap.records.empty()&&heap.objectBytes==0);
  JS_RemoveExtraGCRootsTracer(heap.cx,TraceNativeConstructionRoots,&heap);
  auto state=heap.isolate->owner.lock();CHECK(state&&state->cppHeap==this);
  state->cppHeap=nullptr;heap.cx=nullptr;heap.isolate=nullptr;
}
size_t CppHeap::NativeObjectBytes()const{data_->AssertForeground();return data_->objectBytes;}
cppgc::HeapStatistics CppHeap::CollectStatistics(cppgc::HeapStatistics::DetailLevel detail){
  auto& heap=*data_;heap.AssertForeground();
  CHECK(detail==cppgc::HeapStatistics::kBrief||detail==cppgc::HeapStatistics::kDetailed);
  cppgc::HeapStatistics result;result.detail_level=detail;
  for(const auto& record:heap.records){
    if(!record->storage)continue;
    const auto allocated=malloc_usable_size(record->storage);
    CHECK_GE(allocated,record->bytes);CHECK_LE(allocated,SIZE_MAX-result.committed_size_bytes);
    result.committed_size_bytes+=allocated;
    CHECK_LE(record->bytes,SIZE_MAX-result.used_size_bytes);result.used_size_bytes+=record->bytes;
  }
  CHECK_EQ(result.used_size_bytes,heap.objectBytes);
  // These malloc allocations occupy the guest's accessible linear memory.
  // The wrapper owner has no separate page pool or decommitted native pages.
  result.resident_size_bytes=result.committed_size_bytes;
  if(detail==cppgc::HeapStatistics::kDetailed&&result.committed_size_bytes){
    cppgc::HeapStatistics::SpaceStatistics space;
    space.name="SpiderMonkey native wrapper allocations";
    space.committed_size_bytes=result.committed_size_bytes;
    space.resident_size_bytes=result.resident_size_bytes;space.used_size_bytes=result.used_size_bytes;
    // This owner allocates individual malloc blocks, not cppgc pages or free
    // lists. Do not invent a page layout or attribute musl's shared pools here.
    try {result.space_stats.push_back(std::move(space));}
    catch(const std::bad_alloc&){bridge::FatalOutOfMemory(heap.isolate,"Native wrapper heap statistics",false);}
  }
  return result;
}

void Object::WrapNativeAllocation(Isolate* isolate,Local<Object> input,Wrappable* native,uint16_t tag){
  auto& frame=Current(isolate);frame.state->AssertForeground();
  CHECK(native&&tag==uint16_t(CppHeapPointerTag::kDefaultTag));
  auto record=native->NativeAllocationControl();CHECK(record);
  CHECK(frame.state->cppHeap&&record->heap==frame.state->cppHeap->data_.get());
  CHECK(record->phase==AllocationPhase::Constructing&&!record->published);
  JS::RootedObject wrapper(frame.cx,UnwrapObject(frame.cx,Input(input)));
  CHECK(wrapper&&JS::GetClass(wrapper)==&templateInstanceClass);
  CHECK(JS::GetReservedSlot(wrapper,NativeCppgcAssociation).isUndefined());
  record->wrapper=wrapper;record->published=true;
  JS::SetReservedSlot(wrapper,NativeCppgcAssociation,JS::PrivateValue(record.get()));
}
void TraceNativeWrapperGc(JSTracer* tracer,JSObject* wrapper){
  auto value=JS::GetReservedSlot(wrapper,NativeCppgcAssociation);
  if(value.isUndefined())return;
  auto& record=*static_cast<NativeAllocation*>(value.toPrivate());
  TraceNativeAllocation(tracer,record);
}
void FinalizeNativeWrapperGc(JSObject* wrapper){
  auto value=JS::GetReservedSlot(wrapper,NativeCppgcAssociation);
  if(value.isUndefined())return;
  auto& record=*static_cast<NativeAllocation*>(value.toPrivate());
  JS::SetReservedSlot(wrapper,NativeCppgcAssociation,JS::UndefinedValue());
  record.wrapper=nullptr;record.finalized=true;RetireNativeAllocation(record);
}

struct TracedRoot {
  std::weak_ptr<NativeAllocation> allocation;
  JS::Heap<JS::Value> value;
  Data::RootFactory factory;
  bool isValue;
  TracedRoot(std::shared_ptr<NativeAllocation> owner,JS::Value input,Data::RootFactory f,bool v)
      :allocation(owner),value(input),factory(f),isValue(v){}
};
void TracedRootDeleter::operator()(TracedRoot* root)const{delete root;}
namespace {
TracedRootOwner MakeTracedRoot(Isolate* isolate,JS::HandleValue input,
    Data::RootFactory factory,bool isValue,std::shared_ptr<NativeAllocation> record){
  auto& frame=Current(isolate);CHECK(record&&record->heap->isolate==isolate);
  CHECK(cppgc::internal::NativeAllocationIsAlive(record));
  JS::RootedValue value(frame.cx,input);
  // Use CCWs for cross-compartment edges. Raw foreign globals hidden in a
  // native record would not register incoming edges for compartment/zone GC.
  JS::RootedObject home(frame.cx,record->wrapper);
  if(!home){CHECK(value.isObject());home=UnwrapObject(frame.cx,value);CHECK(home);}
  JSAutoRealm realm(frame.cx,home);CHECK(JS_WrapValue(frame.cx,&value));
  return TracedRootOwner(new TracedRoot(record,value,factory,isValue));
}
std::shared_ptr<NativeAllocation> TracedAllocation(const TracedRoot& root){
  auto record=root.allocation.lock();CHECK(cppgc::internal::NativeAllocationIsAlive(record));return record;
}
}
TracedRootOwner NewTracedRoot(Isolate* isolate,Local<Data> value,std::shared_ptr<NativeAllocation> record){
  CHECK(!value.IsEmpty());return MakeTracedRoot(isolate,Input(value),value->RootFactoryForStorage(),value->IsValue(),record);
}
TracedRootOwner NewTracedRoot(Isolate* isolate,Local<Context> context,std::shared_ptr<NativeAllocation> record){
  CHECK(!context.IsEmpty()&&context->isolate==isolate);
  return NewTracedRoot(isolate,context.As<Data>(),std::move(record));
}
void TraceTracedRoot(JSTracer* tracer,const TracedRoot& input){
  // This hook runs without an ordinary Frame/Realm/Environment. Only barriered
  // edges are visited; no Local, getter, JS allocation or permanent root.
  JS::TraceEdge(tracer,&const_cast<TracedRoot&>(input).value,"Node native traced reference");
}
Local<Data> ReadTracedRoot(Isolate* isolate,const TracedRoot& root){
  auto record=TracedAllocation(root);CHECK(record->heap->isolate==isolate&&root.factory);
  auto& frame=Current(isolate);JS::RootedValue value(frame.cx,root.value);
  if(root.isValue){if(JS::CurrentGlobalOrNull(frame.cx)&&!JS_WrapValue(frame.cx,&value))return {};}
  else {JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,value));if(!object)return {};value.setObject(*object);}
  auto item=root.factory(&frame.state->isolate,std::make_unique<Cell>(frame.cx,value));auto* pointer=item.get();
  frame.roots.push_back(std::move(item));return Local<Data>(pointer);
}
Local<Context> ReadTracedContextRoot(Isolate* isolate,const TracedRoot& root){
  auto data=ReadTracedRoot(isolate,root);CHECK(!data.IsEmpty()&&data->IsContext());return data.As<Context>();
}
}

namespace cppgc::internal {
Construction::Construction(AllocationHandle& handle,size_t bytes,size_t alignment,NativeTrace trace,NativeDestroy destroy)
    :previous_(currentConstruction){
  auto* owner=handle.NativeHeap();CHECK(owner);auto& heap=*owner->data_;heap.AssertForeground();
  CHECK(heap.cx==js::TlsContext.get()&&!heap.terminated&&trace&&destroy);
  auto record=std::make_shared<NativeAllocation>();record->heap=&heap;
  record->bytes=bytes;record->alignment=std::max(alignment,alignof(std::max_align_t));
  record->trace=trace;record->destroy=destroy;
  record->storage=::operator new(bytes,std::align_val_t(record->alignment),std::nothrow);
  CHECK(record->storage);CHECK_LE(bytes,SIZE_MAX-heap.objectBytes);
  auto rollback=mozilla::MakeScopeExit([&]{
    ::operator delete(record->storage,std::align_val_t(record->alignment));
  });
  heap.records.push_back(record);heap.objectBytes+=bytes;
  allocation_=record;currentConstruction=record;
  rollback.release();
}
void* Construction::Storage()const{return allocation_->storage;}
void Construction::Complete(){
  CHECK(currentConstruction==allocation_&&allocation_->published&&!complete_);
  CHECK(allocation_->phase==AllocationPhase::Constructing);
  allocation_->phase=AllocationPhase::Live;complete_=true;
}
Construction::~Construction(){
  CHECK(currentConstruction==allocation_);currentConstruction=previous_;
  if(complete_)return;
  auto& record=*allocation_;record.phase=AllocationPhase::Destroyed;
  v8::ClearNativeGcAssociation(record);v8::FreeNativeStorage(record);
  record.heap->records.remove(allocation_);
}
}
#endif
