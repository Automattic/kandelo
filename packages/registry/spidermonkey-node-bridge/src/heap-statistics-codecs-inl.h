#ifndef KANDELO_NODE_HEAP_STATISTICS_CODECS_INL_H
#define KANDELO_NODE_HEAP_STATISTICS_CODECS_INL_H

namespace v8 {
struct HeapStatisticsData {
  size_t total=0,used=0,external=0,limit=0,executable=0,physical=0,malloc=0;
  size_t globalCapacity=0,globalUsed=0,nativeContexts=0,detachedContexts=0,zap=0;
  size_t available=0,peakMalloc=0;uint64_t allocated=0;
  std::array<HeapSpaceStatistics,4> spaces;
};
HeapStatistics::HeapStatistics():data_(std::make_unique<HeapStatisticsData>()){}
HeapStatistics::~HeapStatistics()=default;
size_t HeapStatistics::total_heap_size()const{return data_->total;}
size_t HeapStatistics::used_heap_size()const{return data_->used;}
size_t HeapStatistics::external_memory()const{return data_->external;}
size_t HeapStatistics::heap_size_limit()const{return data_->limit;}
size_t HeapStatistics::total_heap_size_executable()const{return data_->executable;}
size_t HeapStatistics::total_physical_size()const{return data_->physical;}
size_t HeapStatistics::malloced_memory()const{return data_->malloc;}
size_t HeapStatistics::total_global_handles_size()const{return data_->globalCapacity;}
size_t HeapStatistics::used_global_handles_size()const{return data_->globalUsed;}
size_t HeapStatistics::number_of_native_contexts()const{return data_->nativeContexts;}
size_t HeapStatistics::number_of_detached_contexts()const{return data_->detachedContexts;}
size_t HeapStatistics::does_zap_garbage()const{return data_->zap;}
size_t HeapStatistics::total_available_size()const{return data_->available;}
size_t HeapStatistics::peak_malloced_memory()const{return data_->peakMalloc;}
uint64_t HeapStatistics::total_allocated_bytes()const{return data_->allocated;}
uint64_t Isolate::GetHashSeed(){
  auto state=owner.lock();CHECK(state);state->AssertForeground();
  return state->cx->runtime()->nativeInitialHashSeed();
}


namespace {
size_t HeapMallocSizeOf(const void* allocation){
  // The recipe disables jemalloc; these are actual musl malloc allocations.
  return malloc_usable_size(const_cast<void*>(allocation));
}
void HeapAdd(size_t& total,size_t amount){CHECK_LE(amount,SIZE_MAX-total);total+=amount;}
void HeapSubtract(size_t& total,size_t amount){CHECK_GE(total,amount);total-=amount;}
struct HeapRuntimeMeasurement final:JS::RuntimeStats {
  HeapRuntimeMeasurement():JS::RuntimeStats(HeapMallocSizeOf){}
  void initExtraRealmStats(JS::Realm* realm,JS::RealmStats* stats,const JS::AutoRequireNoGC&)override{
    stats->extra=realm;
  }
  void initExtraZoneStats(JS::Zone* zone,JS::ZoneStats* stats,const JS::AutoRequireNoGC&)override{
    stats->extra=zone;
  }
};
struct HeapBackingCensus {
  size_t external=0,externalStringMalloc=0,zones=0,realms=0,arenas=0;
  size_t nativeContexts=0,detachedContexts=0;
  bool measureSources=false,sourceAllocationFailed=false;
  size_t sourcePayloadBytes=0;
  std::set<const void*> sourcePayloads;
  void AddSourcePayload(const void* allocation){
    if(!allocation||sourceAllocationFailed)return;
    try {
      if(sourcePayloads.insert(allocation).second)HeapAdd(sourcePayloadBytes,HeapMallocSizeOf(allocation));
    }catch(const std::bad_alloc&){sourceAllocationFailed=true;}
  }
  void AddExternal(size_t amount){
    // The native size_t API saturates if aggregate backing credits overflow.
    external=amount>SIZE_MAX-external?SIZE_MAX:external+amount;
  }
};
void HeapCensusZone(JSRuntime*,void* raw,JS::Zone*,const JS::AutoRequireNoGC&){
  ++static_cast<HeapBackingCensus*>(raw)->zones;
}
void HeapCensusRealm(JSContext*,void* raw,JS::Realm* realm,const JS::AutoRequireNoGC&){
  auto& census=*static_cast<HeapBackingCensus*>(raw);++census.realms;
  if(JS::GetRealmGlobalOrNull(realm))++census.nativeContexts;
  else ++census.detachedContexts;
}
void HeapCensusArena(JSRuntime*,void* raw,js::gc::Arena*,JS::TraceKind,size_t,const JS::AutoRequireNoGC&){
  ++static_cast<HeapBackingCensus*>(raw)->arenas;
}
void HeapCensusCell(JSRuntime*,void* raw,JS::GCCellPtr cell,size_t,const JS::AutoRequireNoGC&){
  auto& census=*static_cast<HeapBackingCensus*>(raw);
  if(cell.kind()==JS::TraceKind::Script&&census.measureSources){
    // SourceInfo.misc measures the source object, not its shared text. Read
    // the existing locked source representation without decompressing it.
    // Multiple scripts/sources may own the same immutable allocation.
    js::ScriptSource::DataReader source(cell.as<js::BaseScript>().scriptSource());
    if(!source.hasSourceText())return;
    if(source->hasCompressedSource()){
      if(source.isTwoByteString())census.AddSourcePayload(source->compressedData<char16_t>()->raw.chars());
      else census.AddSourcePayload(source->compressedData<mozilla::Utf8Unit>()->raw.chars());
    }else if(source->hasUncompressedSource()){
      if(source.isTwoByteString())census.AddSourcePayload(source->uncompressedData<char16_t>()->units());
      else census.AddSourcePayload(source->uncompressedData<mozilla::Utf8Unit>()->units());
    }
  }else if(cell.kind()==JS::TraceKind::String){
    auto& string=cell.as<JSString>();
    if(string.isExternal()){
      const size_t width=string.hasLatin1Chars()?1:sizeof(char16_t);
      CHECK_LE(string.length(),SIZE_MAX/width);census.AddExternal(string.length()*width);
      HeapAdd(census.externalStringMalloc,string.sizeOfExcludingThis(HeapMallocSizeOf));
    }
  }else if(cell.kind()==JS::TraceKind::Object){
    auto& object=cell.as<JSObject>();
    if(object.is<js::ArrayBufferObject>()){
      auto& buffer=object.as<js::ArrayBufferObject>();
      // This measures backing credits attached to real JS ArrayBuffers.
      // Views, detached storage, inline data, shared/Wasm backings and
      // user-owned/no-deleter storage do not add ordinary backing credits.
      if(!buffer.isDetached()&&!buffer.isInlineData()&&!buffer.isWasm()&&
         buffer.bufferKind()!=js::ArrayBufferObject::USER_OWNED)
        census.AddExternal(buffer.byteLength());
    }
  }
}
}

void Isolate::GetHeapStatistics(HeapStatistics* output){
  CHECK(output);auto state=owner.lock();CHECK(state);state->AssertForeground();
  JSContext* cx=state->cx;CHECK(cx&&!JS::RuntimeHeapIsBusy());
  PreserveNativeFailure pending(cx);
  Isolate::DisallowJavascriptExecutionScope noJavascript(this,Isolate::DisallowJavascriptExecutionScope::THROW_ON_FAILURE);
  // A nursery evacuation makes all occupied cells and pooled buffers visible
  // to the same actual tenured-heap traversal. No JavaScript is evaluated.
  js::gc::FinishGC(cx,JS::GCReason::API);
  cx->runtime()->gc.evictNursery();
  HeapRuntimeMeasurement measured;
  if(!JS::CollectRuntimeStats(cx,&measured,nullptr,true)){
    // This void interface cannot return partial measurements on reporter OOM.
    js::AutoEnterOOMUnsafeRegion fatal;fatal.crash("Cannot collect native heap statistics");
  }
  HeapBackingCensus census;
  {
    js::gc::AutoTraceSession tracing(cx->runtime());
    js::IterateHeapUnbarriered(cx,&census,HeapCensusZone,HeapCensusRealm,
        HeapCensusArena,HeapCensusCell,tracing);
  }
  JS::ServoSizes sizes;measured.addToServoSizes(&sizes);
  measured.zTotals.addToServoSizes(&sizes);measured.realmTotals.addToServoSizes(&sizes);
  // Fine-grained reporting moves large source entries out of the runtime
  // aggregate. Unlike zone/realm totals, that aggregate no longer includes
  // the notable entries; retain them in the actual allocated-byte total.
  for(const auto& source:measured.runtime.notableScriptSources)source.addToServoSizes(&sizes);
  size_t managedMalloc=sizes.mallocHeap;
  // GC buffer pools already account for dynamic slots/elements, including
  // their small GC-cell allocations. Remove per-object attribution of the
  // same bytes. This also removes ordinary malloc ArrayBuffer backings,
  // which belong to the separate external backing credit measurement.
  // ESR153 records slots and normal elements as NonHeap GC-buffer credits;
  // those are already absent from mallocHeap. Only the separate ordinary
  // ArrayBuffer malloc attribution must move to the external backing census.
  HeapSubtract(managedMalloc,measured.realmTotals.classInfo.objectsMallocHeapElementsArrayBuffer);
  HeapSubtract(managedMalloc,measured.realmTotals.classInfo.objectsMallocHeapElementsAsmJS);
  HeapSubtract(managedMalloc,census.externalStringMalloc);
  // The upstream runtime/zone reporter does not include these profiler-owned
  // allocations. Their source payloads are already in the source totals.
  HeapAdd(managedMalloc,cx->runtime()->geckoProfiler().sizeOfExcludingThis(HeapMallocSizeOf));
  const auto& code=measured.zTotals.code;
  size_t codeUsed=0;for(size_t amount:{code.ion,code.baseline,code.regexp,code.other})HeapAdd(codeUsed,amount);
  size_t total=0,used=0;
  for(size_t amount:{sizes.gcHeapUsed,sizes.gcHeapUnused,sizes.gcHeapAdmin,
      measured.runtime.gc.nurseryCommitted,managedMalloc,codeUsed,code.unused})HeapAdd(total,amount);
  for(size_t amount:{sizes.gcHeapUsed,sizes.gcHeapAdmin,managedMalloc,codeUsed})HeapAdd(used,amount);
  HeapSubtract(used,measured.zTotals.gcBuffers.freeBytes);
  // EVICT_NURSERY promotes every survivor even when semispace mode is on.
  // Its retained unused capacity belongs only to total after evacuation.
  CHECK(cx->runtime()->gc.nursery().isEmpty());
  CHECK_LE(used,total);
  size_t executable=codeUsed;HeapAdd(executable,code.unused);
  // The runtime reporter subtracts decommitted pages in nonempty chunks, but
  // deliberately reports the full size of cached empty chunks. Count their
  // actual page state under the GC lock for the physical-memory result.
  size_t physical=total;
  {js::AutoLockGC lock(cx->runtime());
   for(js::gc::ChunkPool::Iter chunk(cx->runtime()->gc.emptyChunks(lock));!chunk.done();chunk.next())
     HeapSubtract(physical,chunk->decommittedPages.Count()*js::gc::PageSize);}
  *output->data_=HeapStatisticsData{total,used,census.external,
      JS_GetGCParameter(cx,JSGC_MAX_BYTES),executable,physical,managedMalloc};
  const auto [capacity,occupied]=NativeGlobalHandleBytes(*state);
  output->data_->globalCapacity=capacity;output->data_->globalUsed=occupied;
  output->data_->nativeContexts=census.nativeContexts;
  output->data_->detachedContexts=census.detachedContexts;
#if defined(JS_GC_ALLOW_EXTRA_POISONING)
  output->data_->zap=JS::Prefs::extra_gc_poisoning()?1:0;
#endif
  // These counters observe the actual backend's GC-associated malloc credits
  // and mutator cell/buffer allocation events, including events between samples.
  auto& gc=cx->runtime()->gc;
  auto fitSize=[](uint64_t value){return size_t(std::min(value,uint64_t(SIZE_MAX)));};
  output->data_->malloc=fitSize(gc.nativeMallocCounters().bytes());
  output->data_->peakMalloc=fitSize(gc.nativeMallocCounters().peak());
  output->data_->allocated=gc.nativeManagedAllocatedBytes();
  // The enforced collector quota is for GC arenas, not a fabricated unified
  // native-malloc quota. Include free cells in already allocated arenas.
  const size_t quota=JS_GetGCParameter(cx,JSGC_MAX_BYTES);
  const size_t committed=gc.heapSize.bytes();
  output->data_->available=committed<quota?quota-committed:0;
  HeapAdd(output->data_->available,measured.zTotals.unusedGCThings.totalSize());
  auto& spaces=output->data_->spaces;
  size_t cells=0;for(size_t amount:{sizes.gcHeapUsed,sizes.gcHeapUnused,sizes.gcHeapAdmin})HeapAdd(cells,amount);
  const size_t decommitted=total-physical;CHECK_GE(cells,decommitted);
  auto setSpace=[&](size_t index,const char* name,size_t capacity,size_t occupied,size_t available,size_t resident){
    auto& space=spaces[index];space.name_=name;space.size_=capacity;space.used_=occupied;
    space.available_=available;space.physical_=resident;
  };
  // These are the actual backend allocation domains, not invented V8 spaces.
  // All four entries come from the same native census and reporter snapshot.
  setSpace(0,"spidermonkey_gc_cells",cells,sizes.gcHeapUsed+sizes.gcHeapAdmin,sizes.gcHeapUnused,cells-decommitted);
  setSpace(1,"spidermonkey_nursery",measured.runtime.gc.nurseryCommitted,0,
      measured.runtime.gc.nurseryCommitted,measured.runtime.gc.nurseryCommitted);
  setSpace(2,"spidermonkey_gc_owned_malloc",managedMalloc,managedMalloc,0,managedMalloc);
  setSpace(3,"spidermonkey_jit_code",executable,codeUsed,code.unused,executable);
}

size_t Isolate::NumberOfHeapSpaces(){return std::tuple_size_v<decltype(HeapStatisticsData::spaces)>;}
bool Isolate::GetHeapSpaceStatistics(HeapSpaceStatistics* output,size_t index){
  if(!output||index>=NumberOfHeapSpaces())return false;
  HeapStatistics snapshot;GetHeapStatistics(&snapshot);*output=snapshot.data_->spaces[index];return true;
}

bool Isolate::GetHeapCodeAndMetadataStatistics(HeapCodeStatistics* output){
  if(!output)return false;
  auto state=owner.lock();CHECK(state);state->AssertForeground();
  JSContext* cx=state->cx;CHECK(cx&&!JS::RuntimeHeapIsBusy());
  PreserveNativeFailure pending(cx);
  Isolate::DisallowJavascriptExecutionScope noJavascript(this,Isolate::DisallowJavascriptExecutionScope::THROW_ON_FAILURE);
  js::gc::FinishGC(cx,JS::GCReason::API);
  cx->runtime()->gc.evictNursery();
  HeapRuntimeMeasurement measured;
  if(!JS::CollectRuntimeStats(cx,&measured,nullptr,true))return false;
  HeapCodeStatistics result;
  const auto& zone=measured.zTotals;const auto& realm=measured.realmTotals;
  // Committed but unused executable capacity is not live code. Metadata is
  // attributed once, independently of bytecode and retained source storage.
  for(size_t amount:{zone.code.ion,zone.code.baseline,zone.code.regexp,zone.code.other,
      zone.jitCodesGCHeap,zone.jitZone,zone.cacheIRStubs,realm.baselineData,
      realm.ionData,realm.jitScripts,measured.runtime.jitLazyLink})HeapAdd(result.code_,amount);
  for(size_t amount:{realm.scriptsGCHeap,realm.scriptsGCBuffers,
      measured.runtime.scriptData})HeapAdd(result.bytecode_,amount);
  HeapAdd(result.bytecode_,measured.runtime.scriptSourceInfo.misc);
  for(const auto& source:measured.runtime.notableScriptSources)HeapAdd(result.bytecode_,source.misc);
  HeapBackingCensus census;census.measureSources=true;
  {js::gc::AutoTraceSession tracing(cx->runtime());
   js::IterateHeapUnbarriered(cx,&census,HeapCensusZone,HeapCensusRealm,
       HeapCensusArena,HeapCensusCell,tracing);}
  if(census.sourceAllocationFailed)return false;
  result.source_=census.sourcePayloadBytes;
  HeapAdd(result.source_,measured.runtime.uncompressedSourceCache);
  result.profiler_=cx->runtime()->geckoProfiler().sizeOfExcludingThis(HeapMallocSizeOf);
  *output=result;return true;
}
}
#endif
