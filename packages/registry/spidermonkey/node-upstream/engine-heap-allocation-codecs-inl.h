#ifndef KANDELO_ENGINE_HEAP_ALLOCATION_CODECS_INL_H
#define KANDELO_ENGINE_HEAP_ALLOCATION_CODECS_INL_H
#include "shell/node-upstream/engine-heap-allocation-data.h"
#include "gc/Nursery-inl.h"
#include "vm/FrameIter-inl.h"
#include "shell/node-upstream/heap-sampling-upstream/deps/v8/src/profiler/sampling-heap-profiler.cc"
namespace v8::internal {
std::shared_ptr<AllocationTracker> AllocationTracker::Clone()const{
  auto result=std::make_shared<AllocationTracker>();
  for(const auto& function:functions){
    auto copy=std::make_unique<FunctionInfo>(*function);
    result->strings.emplace_back(function->name);copy->name=result->strings.back().c_str();
    result->strings.emplace_back(function->script_name);copy->script_name=result->strings.back().c_str();
    result->functionPointers.push_back(copy.get());result->functions.push_back(std::move(copy));
  }
  std::unordered_map<const AllocationTraceNode*,AllocationTraceNode*> copies;
  for(const auto& node:nodes){
    auto copy=std::make_unique<AllocationTraceNode>();
    copy->identity=node->identity;copy->function=node->function;copy->count=node->count;copy->bytes=node->bytes;
    copies.emplace(node.get(),copy.get());result->nodes.push_back(std::move(copy));
  }
  for(size_t i=0;i<nodes.size();++i)for(auto* child:nodes[i]->descendants)
    result->nodes[i]->descendants.push_back(copies.at(child));
  if(tree.head)result->tree.head=copies.at(tree.head);return result;
}
NativeAllocationTree::NativeAllocationTree():data(std::make_shared<AllocationTracker>()){
  auto root=std::make_unique<AllocationTracker::FunctionInfo>();
  *root={0,"(root)","",0,-1,-1,0};data->functionPointers.push_back(root.get());data->functions.push_back(std::move(root));
  auto head=std::make_unique<AllocationTraceNode>();head->identity=1;head->function=0;
  data->tree.head=head.get();data->nodes.push_back(std::move(head));
}
AllocationTraceNode* NativeAllocationTree::Stack(const std::vector<NativeAllocationFrame>& frames,int limit){
  auto* node=data->tree.head;
  size_t count=std::min(frames.size(),size_t(limit));
  while(count){
    const auto& frame=frames[--count];FunctionKey key{frame.script,frame.position,frame.name};
    auto found=functions.find(key);uint32_t function;
    if(found==functions.end()){
      CHECK_LT(data->functions.size(),size_t(UINT32_MAX));function=uint32_t(data->functions.size());
      auto info=std::make_unique<AllocationTracker::FunctionInfo>();
      data->strings.push_back(frame.name);const char* name=data->strings.back().c_str();
      data->strings.push_back(frame.url);const char* source=data->strings.back().c_str();
      *info={frame.identity,name,source,frame.script,frame.line,frame.column,frame.position};
      data->functionPointers.push_back(info.get());data->functions.push_back(std::move(info));
      functions.emplace(std::move(key),function);
    }else function=found->second;
    const auto childKey=std::pair(node->identity,function);auto child=children.find(childKey);
    if(child==children.end()){
      CHECK_LT(data->nodes.size(),size_t(UINT32_MAX));auto next=std::make_unique<AllocationTraceNode>();
      next->identity=uint32_t(data->nodes.size()+1);next->function=function;auto* pointer=next.get();
      data->nodes.push_back(std::move(next));node->descendants.push_back(pointer);
      children.emplace(childKey,pointer);node=pointer;
    }else node=child->second;
  }
  return node;
}
namespace {
std::vector<NativeAllocationFrame> CaptureNativeAllocationFrames(HeapProfiler& owner,JSContext* cx,int depth,
    const JS::AutoRequireNoGC& nogc){
  std::vector<NativeAllocationFrame> frames;
  for(js::NonBuiltinScriptFrameIter it(cx);!it.done()&&frames.size()<size_t(depth);++it){
    auto* script=it.script();NativeAllocationFrame frame;
    frame.identity=owner.Identify(script,JS::TraceKind::Script);
    frame.script=NativeStackNumber(script->scriptSource()->id());frame.position=NativeStackNumber(script->sourceStart());
    frame.line=NativeStackNumber(script->lineno()-1);frame.column=NativeStackNumber(script->column().oneOriginValue()-1);
    if(script->filename())frame.url=script->filename();
    if(it.isFunctionFrame())if(auto* name=it.calleeTemplate()->fullDisplayAtom())frame.name=v8::NativeSnapshotString(cx,name,nogc);
    frames.push_back(std::move(frame));
  }
  if(frames.empty()&&depth){NativeAllocationFrame frame;frame.name="(native)";frames.push_back(std::move(frame));}
  return frames;
}
class NativeAllocationProfile final:public v8::AllocationProfile {
  std::vector<std::unique_ptr<Node>> nodes_;
  std::vector<Sample> samples_;
 public:
  NativeAllocationProfile(v8::Isolate* isolate,const SamplingHeapProfiler& sampler){
    // Freeze the actual native data before creating JS strings can cause GC
    // or record additional allocations. The returned profile owns its rows.
    auto tree=sampler.tree_.data->Clone();
    struct Record{unsigned node;size_t size;unsigned count;uint64_t ordinal;bool live;};
    std::vector<Record> rows;std::set<unsigned> included;
    std::map<unsigned,std::map<size_t,unsigned>> counts;
    for(const auto& sample:sampler.samples_)if(sample.live||sample.retained){
      rows.push_back({sample.leaf->identity,sample.size,sampler.ScaleSample(sample.size,1).count,sample.ordinal,sample.live});
      auto& count=counts[sample.leaf->identity][sample.size];CHECK_LT(count,UINT_MAX);++count;
      included.insert(sample.leaf->identity);
    }
    // Keep only ancestors of samples, matching the upstream pruned call graph.
    for(auto it=tree->nodes.rbegin();it!=tree->nodes.rend();++it)
      for(auto* child:(*it)->descendants)if(included.contains(child->identity))included.insert((*it)->identity);
    included.insert(tree->tree.head->identity);
    std::unordered_map<unsigned,Node*> output;
    for(const auto& source:tree->nodes)if(included.contains(source->identity)){
      auto node=std::make_unique<Node>();const auto& info=*tree->functions.at(source->function);
      node->name=v8::String::NewFromUtf8(isolate,info.name).ToLocalChecked();
      node->script_name=v8::String::NewFromUtf8(isolate,info.script_name).ToLocalChecked();
      node->script_id=info.script_id;node->start_position=info.position;
      node->line_number=info.line<0?v8::AllocationProfile::kNoLineNumberInfo:info.line+1;
      node->column_number=info.column<0?v8::AllocationProfile::kNoColumnNumberInfo:info.column+1;
      node->node_id=source->identity;
      for(auto [size,count]:counts[source->identity])node->allocations.push_back(sampler.ScaleSample(size,count));
      output.emplace(source->identity,node.get());nodes_.push_back(std::move(node));
    }
    for(const auto& source:tree->nodes)if(included.contains(source->identity))
      for(auto* child:source->descendants)if(included.contains(child->identity))
        output.at(source->identity)->children.push_back(output.at(child->identity));
    for(const auto& row:rows)samples_.push_back({row.node,row.size,row.count,row.ordinal,row.live});
  }
  Node* GetRootNode()override{CHECK(!nodes_.empty());return nodes_.front().get();}
  const std::vector<Sample>& GetSamples()override{return samples_;}
};
}
void NativeHeapAllocations::Install(){
  auto state=owner.owner.lock();CHECK(state);auto* cx=state->cx;
  CHECK(!cx->nativeCellAllocationObserver||cx->nativeCellAllocationData==this);
  CHECK(!cx->nativeNurseryWeakObserver||cx->nativeCellAllocationData==this);
  cx->nativeCellAllocationData=this;cx->nativeCellAllocationObserver=Observe;cx->nativeNurseryWeakObserver=NurseryWeak;
}
void NativeHeapAllocations::Retire(){
  auto state=owner.owner.lock();CHECK(state);auto* cx=state->cx;CHECK(cx->nativeCellAllocationData==this);
  cx->nativeCellAllocationObserver=nullptr;cx->nativeNurseryWeakObserver=nullptr;cx->nativeCellAllocationData=nullptr;
  sampling.reset();tracking.reset();
}
void RetireNativeHeapAllocations(HeapProfiler& owner){
  if(owner.allocations){owner.allocations->Retire();owner.allocations.reset();}
  owner.trackingHeapObjects=false;
}
void NativeHeapAllocations::Observe(JSContext* cx,void* cell,JS::TraceKind kind,size_t size,void* raw){
  auto& records=*static_cast<NativeHeapAllocations*>(raw);auto& owner=records.owner;
  CHECK(!owner.closed);auto* sampler=records.sampling.get();
  if(!owner.trackingHeapObjects&&!sampler)return;
  owner.AssertLive();
  if(JS::RuntimeHeapIsBusy())return;  // Collector relocation is not a new mutator allocation.
  const bool selected=sampler&&sampler->Select(size);
  if(!owner.trackingHeapObjects&&!selected)return;
  try{
    // The new cell has not been initialized by its caller. Never dereference
    // it here; only existing interpreter frames and metadata are inspected.
    JS::AutoCheckCannotGC nogc(cx);
    v8::Isolate::DisallowJavascriptExecutionScope noJavascript(owner.isolate,v8::Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
    const int depth=std::max(records.tracking?64:0,selected?sampler->depth_:0);
    auto frames=CaptureNativeAllocationFrames(owner,cx,depth,nogc);unsigned trace=0;
    if(records.tracking){
      auto* node=records.tracking->Stack(frames,64);CHECK_LT(node->count,UINT32_MAX);
      CHECK_LE(size,UINT64_MAX-node->bytes);++node->count;node->bytes+=size;trace=node->identity;
    }
    if(owner.trackingHeapObjects)owner.Identify(cell,kind,trace);
    if(selected){
      auto* node=sampler->tree_.Stack(frames,sampler->depth_);CHECK_LT(sampler->nextSample_,UINT64_MAX);
      if(sampler->samplesNeedCompaction){
        sampler->samples_.erase(std::remove_if(sampler->samples_.begin(),sampler->samples_.end(),
            [](const auto& sample){return !sample.live&&!sample.retained;}),sampler->samples_.end());
        sampler->samplesNeedCompaction=false;
      }
      sampler->samples_.push_back({cell,kind,size,node,++sampler->nextSample_});
    }
  }catch(const std::bad_alloc&){v8::bridge::FatalOutOfMemory(owner.isolate,"Heap allocation recording",false);}
}
void NativeHeapAllocations::NurseryWeak(JSContext* cx,void* raw){
  auto& records=*static_cast<NativeHeapAllocations*>(raw);auto& owner=records.owner;owner.AssertLive();
  auto forward=[](void* cell)->void*{
    auto* pointer=static_cast<js::gc::Cell*>(cell);
    if(!js::gc::IsInsideNursery(pointer))return cell;
    return js::Nursery::getForwardedPointer(&pointer)?pointer:nullptr;
  };
  for(auto& identity:owner.identities)if(identity.cell)identity.cell=forward(identity.cell);
  owner.identityIndexDirty=true;
  if(records.sampling)for(auto& sample:records.sampling->samples_)if(sample.cell){
    sample.cell=forward(sample.cell);if(!sample.cell)records.sampling->Collected(sample,true);
  }
}
void UpdateNativeHeapAllocationWeakEdges(HeapProfiler& owner,JSTracer* tracer){
  if(!owner.allocations||!owner.allocations->sampling)return;
  auto& sampling=*owner.allocations->sampling;
  for(auto& sample:sampling.samples_)if(sample.cell&&!js::gc::IsInsideNursery(static_cast<js::gc::Cell*>(sample.cell))){
    sample.cell=JS::MapGCThingTyped(sample.cell,sample.kind,[&](auto* pointer)->void*{
      auto result=js::TraceManuallyBarrieredWeakEdge(tracer,&pointer,"Node heap allocation sample");
      return result.isLive()?static_cast<void*>(result.finalTarget()):nullptr;
    });
    if(!sample.cell)sampling.Collected(sample,false);
  }
}
void FreezeNativeHeapAllocations(HeapProfiler& owner,HeapSnapshot& snapshot){
  if(owner.allocations&&owner.allocations->tracking)snapshot.frozen.tracker=owner.allocations->tracking->data->Clone();
}
namespace {
std::shared_ptr<NativeHeapAllocations> RequireNativeHeapAllocations(HeapProfiler& owner){
  if(!owner.allocations){owner.allocations=std::make_shared<NativeHeapAllocations>(owner);owner.allocations->Install();}
  return owner.allocations;
}
}
}
namespace v8 {
void HeapProfiler::StartTrackingHeapObjects(bool trackAllocations){
  auto& owner=*reinterpret_cast<internal::HeapProfiler*>(this);owner.AssertLive();
  auto state=owner.owner.lock();CHECK(state);auto retained=state->heapProfiler;
  auto& frame=Current(owner.isolate);NativeNoScriptEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return;
  try{
    CHECK(!owner.trackingHeapObjects);auto records=internal::RequireNativeHeapAllocations(owner);
    if(trackAllocations)records->tracking=std::make_unique<internal::NativeAllocationTree>();
    {
      PreserveNativeFailure preserve(frame.cx);
      Isolate::DisallowJavascriptExecutionScope noJavascript(owner.isolate,Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
      JS::PrepareForFullGC(frame.cx);JS::NonIncrementalGC(frame.cx,JS::GCOptions::Normal,JS::GCReason::API);
      NativeHeapCellCensus census;JS::AutoCheckCannotGC nogc(frame.cx);
      {js::gc::AutoTraceSession tracing(frame.cx->runtime());
       js::IterateHeapUnbarriered(frame.cx,&census,NativeHeapQueryZone,NativeHeapQueryRealm,NativeHeapQueryArena,GatherNativeSnapshotCell,tracing);}
      if(census.failed)bridge::FatalOutOfMemory(owner.isolate,"Tracked heap inventory",false);
      for(const auto& [cell,kind]:census.cells)owner.Identify(cell,kind);
    }
    owner.trackingHeapObjects=true;
  }catch(const std::bad_alloc&){bridge::FatalOutOfMemory(owner.isolate,"Heap tracking creation",false);}
}
void HeapProfiler::StopTrackingHeapObjects(){
  auto& owner=*reinterpret_cast<internal::HeapProfiler*>(this);owner.AssertLive();owner.trackingHeapObjects=false;
  // Keep the weak nursery observer until profiler retirement: IDs recorded
  // just before stopping can still point into the nursery. Removing it here
  // would leave stale pointers when those objects move or die in a later GC.
  if(owner.allocations)owner.allocations->tracking.reset();
  for(auto& identity:owner.identities)identity.traceId=0;
}
bool HeapProfiler::StartSamplingHeapProfiler(uint64_t rate,int depth,SamplingFlags flags){
  auto& owner=*reinterpret_cast<internal::HeapProfiler*>(this);owner.AssertLive();CHECK_GT(rate,0u);CHECK_GE(depth,0);
  try{
    auto records=internal::RequireNativeHeapAllocations(owner);if(records->sampling)return false;
    records->sampling=std::make_unique<internal::SamplingHeapProfiler>(rate,depth,flags);return true;
  }catch(const std::bad_alloc&){bridge::FatalOutOfMemory(owner.isolate,"Heap sampler creation",false);}
}
void HeapProfiler::StopSamplingHeapProfiler(){
  auto& owner=*reinterpret_cast<internal::HeapProfiler*>(this);owner.AssertLive();
  if(owner.allocations)owner.allocations->sampling.reset();
}
AllocationProfile* HeapProfiler::GetAllocationProfile(){
  auto& owner=*reinterpret_cast<internal::HeapProfiler*>(this);owner.AssertLive();
  auto state=owner.owner.lock();CHECK(state);auto retained=state->heapProfiler;
  auto records=owner.allocations;if(!records||!records->sampling)return nullptr;
  auto& frame=Current(owner.isolate);NativeNoScriptEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return nullptr;
  try{
    if(records->sampling->flags_&kSamplingForceGC){
      PreserveNativeFailure preserve(frame.cx);
      Isolate::DisallowJavascriptExecutionScope noJavascript(owner.isolate,Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
      JS::PrepareForFullGC(frame.cx);JS::NonIncrementalGC(frame.cx,JS::GCOptions::Normal,JS::GCReason::API);
    }
    if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return nullptr;
    return new internal::NativeAllocationProfile(owner.isolate,*records->sampling);
  }catch(const std::bad_alloc&){bridge::FatalOutOfMemory(owner.isolate,"Heap allocation profile",false);}
}
}
#endif
