#ifndef KANDELO_ENGINE_HEAP_ALLOCATION_DATA_H
#define KANDELO_ENGINE_HEAP_ALLOCATION_DATA_H
#include "engine-heap-snapshot-data.h"
#include "mozilla/RandomNum.h"
#include <cmath>
namespace v8::internal {
inline constexpr intptr_t kTaggedSize=sizeof(void*);
namespace base::ieee754 {using std::log;}
struct NativeAllocationFrame {
  std::string name,url;
  SnapshotObjectId identity=0;
  int script=0,position=0,line=-1,column=-1;
};
struct NativeAllocationTree {
  using FunctionKey=std::tuple<int,int,std::string>;
  std::shared_ptr<AllocationTracker> data;
  std::map<FunctionKey,uint32_t> functions;
  std::map<std::pair<unsigned,unsigned>,AllocationTraceNode*> children;
  NativeAllocationTree();
  AllocationTraceNode* Stack(const std::vector<NativeAllocationFrame>&,int);
};
class NativeHeapRandom {
 public:
  double NextDouble(){
    // The process already connects Mozilla's provider to Node's original
    // entropy callback, including its fatal-failure policy.
    auto bytes=mozilla::RandomUint64();CHECK(bytes);
    return double(*bytes>>11)*0x1.0p-53;
  }
};
class SamplingHeapProfiler {
 public:
  struct Observer {
    NativeHeapRandom* random_;
    intptr_t GetNextSampleInterval(uint64_t);
  };
  struct Sample {
    void* cell;
    JS::TraceKind kind;
    size_t size;
    AllocationTraceNode* leaf;
    uint64_t ordinal;
    bool live=true,retained=false;
  };
  const uint64_t rate_;
  const int depth_;
  const v8::HeapProfiler::SamplingFlags flags_;
  NativeHeapRandom random_;
  Observer observer_{&random_};
  intptr_t remaining_;
  uint64_t nextSample_=0;
  bool samplesNeedCompaction=false;
  NativeAllocationTree tree_;
  std::vector<Sample> samples_;
  SamplingHeapProfiler(uint64_t rate,int depth,v8::HeapProfiler::SamplingFlags flags)
      :rate_(rate),depth_(depth),flags_(flags),remaining_(observer_.GetNextSampleInterval(rate)){
    CHECK_GT(rate,0u);CHECK_GE(depth,0);
  }
  v8::AllocationProfile::Allocation ScaleSample(size_t,unsigned)const;
  bool Select(size_t size){
    if(size<size_t(remaining_)){remaining_-=intptr_t(size);return false;}
    remaining_=observer_.GetNextSampleInterval(rate_);return true;
  }
  void Collected(Sample& sample,bool minor){
    sample.cell=nullptr;sample.live=false;
    sample.retained=bool(flags_&(minor?v8::HeapProfiler::kSamplingIncludeObjectsCollectedByMinorGC:
                                    v8::HeapProfiler::kSamplingIncludeObjectsCollectedByMajorGC));
    if(!sample.retained)samplesNeedCompaction=true;
  }
};
struct NativeHeapAllocations {
  HeapProfiler& owner;
  std::unique_ptr<NativeAllocationTree> tracking;
  std::unique_ptr<SamplingHeapProfiler> sampling;
  explicit NativeHeapAllocations(HeapProfiler& input):owner(input){}
  static void Observe(JSContext*,void*,JS::TraceKind,size_t,void*);
  static void NurseryWeak(JSContext*,void*);
  void Install();
  void Retire();
};
}
#endif
