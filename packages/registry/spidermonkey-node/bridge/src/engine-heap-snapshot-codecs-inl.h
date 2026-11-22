#ifndef KANDELO_ENGINE_HEAP_SNAPSHOT_CODECS_INL_H
#define KANDELO_ENGINE_HEAP_SNAPSHOT_CODECS_INL_H
#include "kandelo-node/engine-heap-snapshot-data.h"
#include "kandelo-node/trace-utf8-native.h"
#pragma push_macro("DCHECK_EQ")
#undef DCHECK_EQ
#pragma push_macro("DCHECK_LE")
#undef DCHECK_LE
#pragma push_macro("DCHECK_LT")
#undef DCHECK_LT
#pragma push_macro("DCHECK_NOT_NULL")
#undef DCHECK_NOT_NULL
#pragma push_macro("DCHECK_IMPLIES")
#undef DCHECK_IMPLIES
#pragma push_macro("DCHECK")
#pragma push_macro("DCHECK_NULL")
#pragma push_macro("DCHECK_NE")
#pragma push_macro("V8_INLINE")
#pragma push_macro("UNREACHABLE")
#undef DCHECK
#undef DCHECK_NULL
#undef DCHECK_NE
#undef V8_INLINE
#undef UNREACHABLE
#ifdef DEBUG
#define DCHECK(condition) CHECK(condition)
#else
#define DCHECK(condition) ((void)0)
#endif
#define DCHECK_EQ(a,b) DCHECK((a)==(b))
#define DCHECK_LE(a,b) DCHECK((a)<=(b))
#define DCHECK_LT(a,b) DCHECK((a)<(b))
#define DCHECK_NOT_NULL(value) DCHECK((value)!=nullptr)
#define DCHECK_IMPLIES(a,b) DCHECK(!(a)||(b))
#define DCHECK_NULL(value) DCHECK(!(value))
#define DCHECK_NE(a,b) DCHECK((a)!=(b))
#define V8_INLINE inline
#define UNREACHABLE() kandelo_v8_graceful_fatal("Invalid native heap graph operation")
namespace v8::internal {
namespace heap_unicode {
using uchar=uint32_t;
class Utf8 {
 public:
  static constexpr uchar kBadChar=0xfffd;
  static uchar CalculateValue(const uint8_t* bytes,size_t length,size_t* cursor){
    return kandelo::node::DecodeNativeUtf8(bytes,length,cursor);
  }
};
}
namespace unibrow=heap_unicode;
}
#include "kandelo-node/heap-snapshot-upstream/deps/v8/src/profiler/heap-snapshot-generator.cc"
#pragma pop_macro("UNREACHABLE")
#pragma pop_macro("V8_INLINE")
#pragma pop_macro("DCHECK_NE")
#pragma pop_macro("DCHECK_NULL")
#pragma pop_macro("DCHECK")
#pragma pop_macro("DCHECK_IMPLIES")
#pragma pop_macro("DCHECK_NOT_NULL")
#pragma pop_macro("DCHECK_LT")
#pragma pop_macro("DCHECK_LE")
#pragma pop_macro("DCHECK_EQ")
#include "kandelo-node/engine-heap-snapshot-capture-inl.h"
#include "kandelo-node/engine-heap-allocation-codecs-inl.h"
namespace v8 {
namespace {
std::shared_ptr<internal::HeapSnapshot> RetainNativeHeapSnapshot(const HeapSnapshot* input){
  auto* snapshot=reinterpret_cast<const internal::HeapSnapshot*>(input);
  auto owner=snapshot->owner.lock();CHECK(owner);owner->AssertLive();
  auto found=std::find_if(owner->snapshots_.begin(),owner->snapshots_.end(),
      [snapshot](const auto& candidate){return candidate.get()==snapshot;});
  CHECK(found!=owner->snapshots_.end());return *found;
}
}
void HeapSnapshot::Delete(){
  auto snapshot=RetainNativeHeapSnapshot(this);auto owner=snapshot->owner.lock();CHECK(owner);
  auto& snapshots=owner->snapshots_;
  snapshots.erase(std::find(snapshots.begin(),snapshots.end(),snapshot));
  if(snapshots.empty()&&!owner->trackingHeapObjects&&!owner->takingSnapshot&&
      (!owner->allocations||!owner->allocations->sampling)){
    owner->identities.clear();owner->identityIndex.clear();owner->identityIndexDirty=false;
    owner->nativeIdentities.clear();
  }
}
void HeapSnapshot::Serialize(OutputStream* stream,SerializationFormat format)const{
  CHECK(stream&&stream->GetChunkSize()>0&&format==kJSON);
  auto snapshot=RetainNativeHeapSnapshot(this);
  try{
    internal::HeapSnapshotJSONSerializer serializer(snapshot.get());serializer.Serialize(stream);
  }catch(const std::bad_alloc&){
    auto owner=snapshot->owner.lock();CHECK(owner);
    bridge::FatalOutOfMemory(owner->isolate,"Heap snapshot serialization",false);
  }
}
}
#endif
