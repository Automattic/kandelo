#ifndef KANDELO_ENGINE_HEAP_SNAPSHOT_DATA_H
#define KANDELO_ENGINE_HEAP_SNAPSHOT_DATA_H
#include "engine-heap-profiler-data.h"
#include "engine-cpu-profiler-data.h"
#include <deque>
#include <unordered_map>
#include <string_view>
namespace v8::internal {
struct EntrySourceLocation;
class HeapEntry;
class HeapGraphEdge {
 public:
  using Type=v8::HeapGraphEdge::Type;
  static constexpr Type kElement=Type::kElement,kHidden=Type::kHidden;
  Type kind;HeapEntry* origin;HeapEntry* target;const char* label;int ordinal;
  Type type()const{return kind;}HeapEntry* from()const{return origin;}HeapEntry* to()const{return target;}
  const char* name()const{return label;}int index()const{return ordinal;}
};
class HeapEntry {
 public:
  using Type=v8::HeapGraphNode::Type;
  static constexpr Type kSynthetic=Type::kSynthetic,kNative=Type::kNative;
  int ordinal;Type kind;const char* label;SnapshotObjectId identity;
  size_t bytes;unsigned traceId=0;uint8_t detached=0;int childCount=0;
  Type type()const{return kind;}const char* name()const{return label;}
  SnapshotObjectId id()const{return identity;}size_t self_size()const{return bytes;}
  int index()const{return ordinal;}int children_count()const{return childCount;}
  unsigned trace_node_id()const{return traceId;}uint8_t detachedness()const{return detached;}
};
// Captured allocation data is native, immutable snapshot input. Recording owns
// the live version; a snapshot freezes it so later GC cannot alter serialization.
class AllocationTraceNode {
 public:
  uint32_t identity=0,function=0,count=0;uint64_t bytes=0;
  std::vector<AllocationTraceNode*> descendants;
  unsigned id()const{return identity;}unsigned function_info_index()const{return function;}
  uint32_t allocation_count()const{return count;}uint64_t allocation_size()const{return bytes;}
  const std::vector<AllocationTraceNode*>& children()const{return descendants;}
};
class AllocationTraceTree {
 public:AllocationTraceNode* head=nullptr;AllocationTraceNode* root()const{return head;}
};
class AllocationTracker {
 public:
  struct FunctionInfo {uint32_t function_id;const char* name;const char* script_name;int script_id,line,column;int position=0;};
  std::deque<std::string> strings;
  std::vector<std::unique_ptr<FunctionInfo>> functions;
  std::vector<FunctionInfo*> functionPointers;
  std::vector<std::unique_ptr<AllocationTraceNode>> nodes;
  AllocationTraceTree tree;
  const std::vector<FunctionInfo*>& function_info_list()const{return functionPointers;}
  AllocationTraceTree* trace_tree(){return &tree;}
  std::shared_ptr<AllocationTracker> Clone()const;
};
class HeapObjectsMap {
 public:
  struct TimeInterval {
    NativeProfileTime timestamp;SnapshotObjectId last;
    SnapshotObjectId last_assigned_id()const{return last;}
  };
  std::vector<TimeInterval> intervals;
  const std::vector<TimeInterval>& samples()const{return intervals;}
};
struct NativeSnapshotProfilerData {
  std::shared_ptr<AllocationTracker> tracker;
  HeapObjectsMap map;
  AllocationTracker* allocation_tracker(){return tracker.get();}
  HeapObjectsMap* heap_object_map(){return &map;}
};
class HeapSnapshot {
 public:
  std::weak_ptr<HeapProfiler> owner;
  std::deque<std::string> strings;
  std::deque<HeapEntry> nodes;
  std::deque<HeapGraphEdge> references;
  std::vector<HeapGraphEdge*> childPointers;
  std::vector<EntrySourceLocation> sourceLocations;
  NativeSnapshotProfilerData frozen;
  size_t extraNative=0;
  HeapEntry* root(){return &nodes.front();}
  const std::deque<HeapEntry>& entries()const{return nodes;}
  const std::deque<HeapGraphEdge>& edges()const{return references;}
  const std::vector<HeapGraphEdge*>& children()const{return childPointers;}
  const std::vector<EntrySourceLocation>& locations()const{return sourceLocations;}
  NativeSnapshotProfilerData* profiler(){return &frozen;}
  size_t extra_native_bytes()const{return extraNative;}
  const char* Store(std::string value){strings.push_back(std::move(value));return strings.back().c_str();}
  const char* GetCopy(const char* value){return Store(value);}
  template<class... Args>const char* GetFormatted(const char* format,Args... args){
    int size=std::snprintf(nullptr,0,format,args...);CHECK_GE(size,0);
    std::vector<char> value(size_t(size)+1);
    CHECK_EQ(std::snprintf(value.data(),value.size(),format,args...),size);
    return Store(std::string(value.data(),size_t(size)));
  }
  HeapEntry* Add(v8::HeapGraphNode::Type type,std::string name,SnapshotObjectId id,size_t size){
    CHECK_LT(nodes.size(),size_t(INT_MAX));const auto index=int(nodes.size());
    nodes.push_back({index,type,Store(std::move(name)),id,size});return &nodes.back();
  }
  void Edge(HeapEntry* from,HeapEntry* to,const char* name=nullptr,
      v8::HeapGraphEdge::Type type=v8::HeapGraphEdge::kInternal){
    CHECK(from&&to);CHECK_LT(from->childCount,INT_MAX);
    const int index=from->childCount++;
    references.push_back({name||type!=v8::HeapGraphEdge::kInternal?type:v8::HeapGraphEdge::kHidden,from,to,name?Store(name):nullptr,index});
  }
  void Finish(){
    childPointers.reserve(references.size());for(auto& edge:references)childPointers.push_back(&edge);
    std::stable_sort(childPointers.begin(),childPointers.end(),[](auto* a,auto* b){return a->from()->index()<b->from()->index();});
  }
};
using StringsStorage=HeapSnapshot;
namespace base {
using TimeTicks=NativeProfileTime;
using TimeDelta=NativeProfileTime;
template<class T>class ScopedVector {
  std::unique_ptr<T[]> values_;size_t size_;
 public:
  explicit ScopedVector(size_t size):values_(std::make_unique<T[]>(size)),size_(size){}
  T* begin(){return values_.get();}T* end(){return begin()+size_;}
  T& operator[](size_t index){return values_[index];}size_t length()const{return size_;}
};
class HashMap {
 public:struct Entry{void* key;void* value;size_t index;};
};
class CustomMatcherHashMap {
  bool(*match_)(void*,void*);
  std::unordered_map<std::string,size_t> index_;
  std::vector<std::unique_ptr<HashMap::Entry>> entries_;
 public:
  explicit CustomMatcherHashMap(bool(*match)(void*,void*)):match_(match){}
  HashMap::Entry* LookupOrInsert(void* raw,uint32_t){
    const auto* key=static_cast<const char*>(raw);auto found=index_.find(key);
    if(found!=index_.end()){auto* entry=entries_[found->second].get();CHECK(match_(entry->key,raw));return entry;}
    const auto index=entries_.size();auto entry=std::make_unique<HashMap::Entry>(HashMap::Entry{raw,nullptr,index});
    auto* result=entry.get();entries_.push_back(std::move(entry));index_.emplace(key,index);return result;
  }
  size_t occupancy()const{return entries_.size();}
  HashMap::Entry* Start(){return entries_.empty()?nullptr:entries_.front().get();}
  HashMap::Entry* Next(HashMap::Entry* entry){const auto next=entry->index+1;return next<entries_.size()?entries_[next].get():nullptr;}
};
}
}
#endif
