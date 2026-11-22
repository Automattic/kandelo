#ifndef KANDELO_ENGINE_HEAP_PROFILER_DATA_H
#define KANDELO_ENGINE_HEAP_PROFILER_DATA_H
#include "engine-native-api.h"
#include "engine-state.h"
#include "vm/JSContext.h"
#include "js/TraceKind.h"
#include <unordered_map>
namespace v8::internal {
class HeapSnapshot;
class HeapProfiler;
struct NativeHeapAllocations;
void RetireNativeHeapAllocations(HeapProfiler&);
void UpdateNativeHeapAllocationWeakEdges(HeapProfiler&,JSTracer*);
void FreezeNativeHeapAllocations(HeapProfiler&,HeapSnapshot&);
struct NativeHeapCellIdentity {
  void* cell;
  JS::TraceKind kind;
  SnapshotObjectId id;
  unsigned traceId=0;
};
class HeapProfiler {
 public:
  v8::Isolate* const isolate;
  std::weak_ptr<v8::State> owner;
  std::vector<std::pair<v8::HeapProfiler::BuildEmbedderGraphCallback,void*>> build_embedder_graph_callbacks_;
  std::vector<std::shared_ptr<HeapSnapshot>> snapshots_;
  // Snapshot IDs are weak: profiling must not retain the entire guest heap.
  // Keep the kind separately; a relocated cell's old header is no longer safe
  // to inspect when SpiderMonkey reports forwarding during a moving collection.
  std::vector<NativeHeapCellIdentity> identities;
  std::map<const void*,SnapshotObjectId> nativeIdentities;
  std::unordered_map<void*,size_t> identityIndex;
  bool identityIndexDirty=false;
  bool trackingHeapObjects=false;
  std::shared_ptr<NativeHeapAllocations> allocations;
  void RefreshIdentityIndex(){
    if(!identityIndexDirty)return;
    identities.erase(std::remove_if(identities.begin(),identities.end(),
        [](const auto& record){return !record.cell;}),identities.end());
    identityIndex.clear();identityIndex.reserve(identities.size());
    for(size_t i=0;i<identities.size();++i)CHECK(identityIndex.emplace(identities[i].cell,i).second);
    identityIndexDirty=false;
  }
  SnapshotObjectId Identify(void* pointer,JS::TraceKind kind,unsigned trace=0){
    RefreshIdentityIndex();
    if(auto found=identityIndex.find(pointer);found!=identityIndex.end()){
      auto& record=identities[found->second];CHECK(record.kind==kind);
      if(trace)record.traceId=trace;return record.id;
    }
    const auto id=FreshIdentity();
    const auto index=identities.size();identities.push_back({pointer,kind,id,trace});
    CHECK(identityIndex.emplace(pointer,index).second);return id;
  }
  SnapshotObjectId nextIdentity=2;  // One belongs to the synthetic graph root.
  bool takingSnapshot=false;
  bool closed=false;
  SnapshotObjectId FreshIdentity(){CHECK_LT(nextIdentity,UINT32_MAX);return nextIdentity++;}
  explicit HeapProfiler(const std::shared_ptr<v8::State>& state):isolate(&state->isolate),owner(state){}
  ~HeapProfiler(){CHECK(closed);}
  void AssertLive()const{
    auto state=owner.lock();CHECK(state&&!closed);state->AssertForeground();CHECK(state->cx==js::TlsContext.get());
  }
  void Shutdown(){
    if(closed)return;AssertLive();RetireNativeHeapAllocations(*this);closed=true;
    build_embedder_graph_callbacks_.clear();snapshots_.clear();identities.clear();nativeIdentities.clear();identityIndex.clear();owner.reset();
  }
  void AddBuildEmbedderGraphCallback(v8::HeapProfiler::BuildEmbedderGraphCallback,void*);
  void RemoveBuildEmbedderGraphCallback(v8::HeapProfiler::BuildEmbedderGraphCallback,void*);
};
}
#endif
