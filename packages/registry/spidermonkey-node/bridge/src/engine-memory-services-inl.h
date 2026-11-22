#ifndef KANDELO_ENGINE_MEMORY_SERVICES_INL_H
#define KANDELO_ENGINE_MEMORY_SERVICES_INL_H

// Included inside namespace v8 after the actual NativeIsolateData definition.
// Node keeps its observers, worker termination and snapshot/profile decisions.
// This adapter owns only engine callbacks and the real existing GC-cell cap.
struct NativeMemoryServices {
  static NativeIsolateData& Data(Isolate* isolate){
    CHECK(isolate&&isolate->native_);auto& data=*isolate->native_;
    data.AssertForeground();CHECK(data.cx&&data.cx==js::TlsContext.get());return data;
  }
  struct Depth {
    unsigned& value;
    explicit Depth(unsigned& input):value(input){++value;}
    ~Depth(){CHECK(value);--value;}
  };
  static void SetCellLimit(NativeIsolateData& data,size_t bytes){
    CHECK(bytes&&bytes<=size_t(UINT32_MAX));
    CHECK(data.cx->runtime()->gc.setParameter(data.cx,JSGC_MAX_BYTES,uint32_t(bytes)));
  }
  static size_t UsedManagedBytes(Isolate* isolate){
    HeapStatistics statistics;isolate->GetHeapStatistics(&statistics);
    return statistics.used_heap_size();
  }
  static void RestoreCellLimit(Isolate* isolate,size_t requested){
    auto& data=Data(isolate);const size_t used=UsedManagedBytes(isolate);
    const size_t slack=used/4;
    const size_t minimum=slack>SIZE_MAX-used?SIZE_MAX:used+slack;
    const size_t current=JS_GetGCParameter(data.cx,JSGC_MAX_BYTES);
    SetCellLimit(data,std::min(current,std::max(requested,minimum)));
  }
  static GCCallbackFlags Flags(NativeIsolateData& data,JS::GCReason reason){
    int flags=int(data.explicitGcFlags);
    if(reason==JS::GCReason::LAST_DITCH)
      flags|=kGCCallbackFlagLastResort|kGCCallbackFlagCollectAllAvailableGarbage;
    if(reason==JS::GCReason::MEM_PRESSURE)
      flags|=kGCCallbackFlagCollectAllAvailableGarbage|kGCCallbackFlagCollectAllExternalMemory;
    return GCCallbackFlags(flags);
  }
  static void Notify(Isolate* isolate,bool begin,GCType type,GCCallbackFlags flags){
    auto& data=Data(isolate);if(data.gcCallbackDepth)return;
    CHECK(data.state&&!JS::RuntimeHeapIsBusy());Depth depth(data.gcCallbackDepth);
    PreserveNativeFailure failure(data.cx);NativeCallbackEntry callback(*data.state);
    Isolate::DisallowJavascriptExecutionScope noJavascript(isolate,Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
    try {
      // Registrations made during a callback apply to later collections.
      // Shared records let removals suppress an as-yet-uninvoked callback
      // without invalidating the current native iteration or borrowing data.
      const auto snapshot=begin?data.gcPrologues:data.gcEpilogues;
      for(const auto& record:snapshot){
        if(!record->active||!(int(record->filter)&int(type)))continue;
        if(record->callbackWithData)record->callbackWithData(isolate,type,flags,record->data);
        else record->callback(isolate,type,flags);
      }
      if(!begin&&type==kGCTypeMarkSweepCompact&&data.restoreCellHeapThreshold>0){
        const size_t used=UsedManagedBytes(isolate);
        if(double(used)<double(data.initialCellHeapLimit)*data.restoreCellHeapThreshold)
          RestoreCellLimit(isolate,data.initialCellHeapLimit);
      }
    }catch(const std::bad_alloc&){bridge::FatalOutOfMemory(isolate,"Native GC callback dispatch",false);}
  }
  static void Major(JSContext* cx,JSGCStatus status,JS::GCReason reason,void* raw){
    auto* isolate=static_cast<Isolate*>(raw);auto& data=Data(isolate);CHECK(data.cx==cx);
    Notify(isolate,status==JSGC_BEGIN,kGCTypeMarkSweepCompact,Flags(data,reason));
    if(status==JSGC_END){SyncNativeExternalPressure(*data.state);OnNativeMemoryGC(*data.state);}
  }
  static void Minor(JSContext* cx,bool begin,void* raw){
    auto* isolate=static_cast<Isolate*>(raw);auto& data=Data(isolate);CHECK(data.cx==cx);
    Notify(isolate,begin,kGCTypeScavenge,data.explicitGcFlags);
    if(!begin)SyncNativeExternalPressure(*data.state);
  }
  static bool NearLimit(JSContext* cx,void* raw){
    auto* isolate=static_cast<Isolate*>(raw);auto& data=Data(isolate);CHECK(data.cx==cx);
    if(data.nearHeapCallbacks.empty())return false;
    CHECK(data.state&&!JS::RuntimeHeapIsBusy());
    PreserveNativeFailure failure(cx);NativeCallbackEntry callback(*data.state);
    Isolate::DisallowJavascriptExecutionScope noJavascript(isolate,Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
    const auto entry=data.nearHeapCallbacks.back();
    const size_t requested=entry.first(entry.second,JS_GetGCParameter(cx,JSGC_MAX_BYTES),data.initialCellHeapLimit);
    const size_t current=JS_GetGCParameter(cx,JSGC_MAX_BYTES);
    if(requested>current){SetCellLimit(data,requested);return true;}
    // A callback may collect instead of extending the cap. Retry the actual
    // allocation if that collection brought usage below the existing cap.
    return JS_GetGCParameter(cx,JSGC_BYTES)<current;
  }
  static void Collect(Isolate* isolate,GCCallbackFlags flags,
                      JS::GCOptions options,JS::GCReason reason){
    auto& data=Data(isolate);CHECK(data.state&&!JS::RuntimeHeapIsBusy());
    PreserveNativeFailure failure(data.cx);NativeCallbackEntry callback(*data.state);
    Isolate::DisallowJavascriptExecutionScope noJavascript(isolate,Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
    const auto prior=data.explicitGcFlags;
    auto restore=mozilla::MakeScopeExit([&]{data.explicitGcFlags=prior;});
    data.explicitGcFlags=flags;
    JS::PrepareForFullGC(data.cx);JS::NonIncrementalGC(data.cx,options,reason);
    if(data.state->cppHeap)data.state->cppHeap->DrainRetired();
  }
  static void LowMemory(Isolate* isolate){
    Collect(isolate,GCCallbackFlags(kGCCallbackFlagCollectAllAvailableGarbage|kGCCallbackFlagCollectAllExternalMemory),
            JS::GCOptions::Shrink,JS::GCReason::MEM_PRESSURE);
  }
  static void CollectForTesting(Isolate* isolate){
    Collect(isolate,kGCCallbackFlagForced,JS::GCOptions::Normal,JS::GCReason::API);
  }
  static void Initialize(Isolate* isolate){
    auto& data=Data(isolate);CHECK(!data.memoryServicesInstalled);
    data.initialCellHeapLimit=JS_GetGCParameter(data.cx,JSGC_MAX_BYTES);
    // This is the canonical owner of this newly-created context's GC hooks.
    // Native clients register with these lists instead of replacing the hook.
    JS_SetGCCallback(data.cx,Major,isolate);
    JS::SetNativeMinorGCObserver(data.cx,Minor,isolate);
    JS::SetNativeCellHeapLimitCallback(data.cx,NearLimit,isolate);
    data.memoryServicesInstalled=true;
  }
  static void Retire(Isolate* isolate){
    auto& data=Data(isolate);if(!data.memoryServicesInstalled)return;
    CHECK(!data.gcCallbackDepth&&!data.cx->nativeCellHeapLimitRunning);
    JS_SetGCCallback(data.cx,nullptr,nullptr);
    JS::SetNativeMinorGCObserver(data.cx,nullptr,nullptr);
    JS::SetNativeCellHeapLimitCallback(data.cx,nullptr,nullptr);
    for(auto* list:{&data.gcPrologues,&data.gcEpilogues})
      for(const auto& record:*list)record->active=false;
    data.gcPrologues.clear();data.gcEpilogues.clear();data.nearHeapCallbacks.clear();
    data.memoryServicesInstalled=false;
  }
  static void Add(Isolate* isolate,bool begin,Isolate::GCCallback callback,
      Isolate::GCCallbackWithData withData,void* raw,GCType filter){
    auto& data=Data(isolate);CHECK(data.memoryServicesInstalled&&(callback||withData));
    CHECK(!(int(filter)&~int(kGCTypeAll)));auto& list=begin?data.gcPrologues:data.gcEpilogues;
    for(const auto& row:list)CHECK(row->callback!=callback||row->callbackWithData!=withData||row->data!=raw);
    try {
      auto row=std::make_shared<NativeGcCallbackRecord>();row->callback=callback;
      row->callbackWithData=withData;row->data=raw;row->filter=filter;list.push_back(std::move(row));
    }catch(const std::bad_alloc&){bridge::FatalOutOfMemory(isolate,"Native GC callback registration",false);}
  }
  static void Remove(Isolate* isolate,bool begin,Isolate::GCCallback callback,
      Isolate::GCCallbackWithData withData,void* raw){
    auto& data=Data(isolate);auto& list=begin?data.gcPrologues:data.gcEpilogues;
    auto row=std::find_if(list.begin(),list.end(),[&](const auto& item){return item->callback==callback&&item->callbackWithData==withData&&item->data==raw;});
    CHECK(row!=list.end());(*row)->active=false;list.erase(row);
  }
};
void Isolate::AddGCPrologueCallback(GCCallback callback,GCType filter){NativeMemoryServices::Add(this,true,callback,nullptr,nullptr,filter);}
void Isolate::AddGCPrologueCallback(GCCallbackWithData callback,void* data,GCType filter){NativeMemoryServices::Add(this,true,nullptr,callback,data,filter);}
void Isolate::AddGCEpilogueCallback(GCCallback callback,GCType filter){NativeMemoryServices::Add(this,false,callback,nullptr,nullptr,filter);}
void Isolate::AddGCEpilogueCallback(GCCallbackWithData callback,void* data,GCType filter){NativeMemoryServices::Add(this,false,nullptr,callback,data,filter);}
void Isolate::RemoveGCPrologueCallback(GCCallback callback){NativeMemoryServices::Remove(this,true,callback,nullptr,nullptr);}
void Isolate::RemoveGCPrologueCallback(GCCallbackWithData callback,void* data){NativeMemoryServices::Remove(this,true,nullptr,callback,data);}
void Isolate::RemoveGCEpilogueCallback(GCCallback callback){NativeMemoryServices::Remove(this,false,callback,nullptr,nullptr);}
void Isolate::RemoveGCEpilogueCallback(GCCallbackWithData callback,void* data){NativeMemoryServices::Remove(this,false,nullptr,callback,data);}
void Isolate::AddNearHeapLimitCallback(NearHeapLimitCallback callback,void* raw){
  auto& data=NativeMemoryServices::Data(this);CHECK(data.memoryServicesInstalled&&callback);
  CHECK_LT(data.nearHeapCallbacks.size(),size_t(100));
  for(const auto& row:data.nearHeapCallbacks)CHECK(row.first!=callback);
  try {data.nearHeapCallbacks.emplace_back(callback,raw);}
  catch(const std::bad_alloc&){bridge::FatalOutOfMemory(this,"Native heap-limit callback registration",false);}
}
void Isolate::RemoveNearHeapLimitCallback(NearHeapLimitCallback callback,size_t requested){
  auto& data=NativeMemoryServices::Data(this);
  auto row=std::find_if(data.nearHeapCallbacks.begin(),data.nearHeapCallbacks.end(),[&](const auto& item){return item.first==callback;});
  CHECK(row!=data.nearHeapCallbacks.end());data.nearHeapCallbacks.erase(row);
  if(requested)NativeMemoryServices::RestoreCellLimit(this,requested);
}
void Isolate::AutomaticallyRestoreInitialHeapLimit(double threshold){
  auto& data=NativeMemoryServices::Data(this);CHECK(std::isfinite(threshold)&&threshold>=0&&threshold<=1);
  data.restoreCellHeapThreshold=threshold;
}
#endif
