#ifndef KANDELO_ENGINE_HEAP_SNAPSHOT_CAPTURE_INL_H
#define KANDELO_ENGINE_HEAP_SNAPSHOT_CAPTURE_INL_H
#include "js/UbiNode.h"
#include "gc/Marking-inl.h"
#include "gc/Tracer.h"
#include "jit/JitCode.h"
#include "vm/BigIntType.h"
#include "vm/JSScript.h"
#include "vm/RegExpShared.h"
#include "vm/Scope.h"
#include "vm/Shape.h"
#include "vm/SymbolType.h"
#include "vm/NativeObject.h"
#include "vm/StringType.h"
#include <charconv>
namespace v8 {
void UpdateNativeHeapWeakEdges(State& state,JSTracer* tracer){
  state.AssertForeground();if(!state.heapProfiler)return;
  // Do not allocate or reconstruct pointer-index maps while the GC is sweeping.
  // Dead cells disappear, and live IDs follow the collector's actual forwarding.
  for(auto& record:state.heapProfiler->identities)if(record.cell&&!js::gc::IsInsideNursery(static_cast<js::gc::Cell*>(record.cell))){
    record.cell=JS::MapGCThingTyped(record.cell,record.kind,[&](auto* pointer)->void*{
      auto result=js::TraceManuallyBarrieredWeakEdge(tracer,&pointer,"Node heap snapshot identity");
      return result.isLive()?static_cast<void*>(result.finalTarget()):nullptr;
    });
  }
  state.heapProfiler->identityIndexDirty=true;
  internal::UpdateNativeHeapAllocationWeakEdges(*state.heapProfiler,tracer);
}
namespace {
struct NativeHeapCellCensus {
  std::unordered_map<void*,JS::TraceKind> cells;
  bool failed=false;
};
void GatherNativeSnapshotCell(JSRuntime*,void* raw,JS::GCCellPtr cell,size_t,const JS::AutoRequireNoGC&){
  auto& census=*static_cast<NativeHeapCellCensus*>(raw);if(census.failed)return;
  try{census.cells.emplace(cell.asCell(),cell.kind());}
  catch(const std::bad_alloc&){census.failed=true;}
}
std::string NativeSnapshotText(const char16_t* text){
  if(!text)return {};
  auto bytes=kandelo::node::EncodeNativeTwoByteString({text,std::char_traits<char16_t>::length(text)});
  return std::string(bytes.data(),bytes.size()-1);
}
std::string NativeSnapshotString(JSContext* cx,JSString* string,const JS::AutoRequireNoGC& nogc){
  std::u16string text;text.reserve(string->length());js::StringSegmentRange<> segments(cx);
  if(!segments.init(string))bridge::FatalOutOfMemory(Isolate::GetCurrent(),"Heap snapshot string segments",false);
  while(!segments.empty()){
    auto* segment=segments.front();
    if(segment->hasLatin1Chars()){
      auto* chars=segment->latin1Chars(nogc);
      for(size_t i=0;i<segment->length();++i)text.push_back(char16_t(chars[i]));
    }else text.append(segment->twoByteChars(nogc),segment->length());
    if(!segments.popFront())bridge::FatalOutOfMemory(Isolate::GetCurrent(),"Heap snapshot string segments",false);
  }
  auto bytes=kandelo::node::EncodeNativeTwoByteString(text);
  return std::string(bytes.data(),bytes.size()-1);
}
class NativeHeapSnapshotCapture {
  using Entry=internal::HeapEntry;
  using Node=JS::ubi::Node;
  using GraphNode=EmbedderGraph::Node;
  JSContext* const cx_;
  internal::HeapProfiler& owner_;
  internal::HeapSnapshot& snapshot_;
  const HeapProfiler::HeapSnapshotOptions& options_;
  const JS::AutoRequireNoGC& nogc_;
  const NativeHeapCellCensus& census_;
  std::unordered_map<void*,SnapshotObjectId> identities_;
  std::unordered_map<Node::Id,Entry*> entries_;
  std::deque<Node> pending_;
  std::unordered_map<GraphNode*,Entry*> embedderEntries_;
  std::set<const void*> visitedNativeAddresses_;
  uint32_t completed_=0;
  bool Progress(){
    if(!options_.control)return true;
    const auto total=uint32_t(std::min(std::max(census_.cells.size(),size_t(completed_)),size_t(UINT32_MAX)));
    return options_.control->ReportProgressValue(completed_,total)==ActivityControl::kContinue;
  }
  SnapshotObjectId Identity(Node node){
    auto* pointer=reinterpret_cast<void*>(uintptr_t(node.identifier()));
    auto cell=census_.cells.find(pointer);
    if(cell==census_.cells.end())return owner_.FreshIdentity();
    if(auto found=identities_.find(pointer);found!=identities_.end())return found->second;
    CHECK(!js::gc::IsInsideNursery(static_cast<js::gc::Cell*>(pointer)));
    auto id=owner_.Identify(pointer,cell->second);identities_.emplace(pointer,id);return id;
  }
  Entry* Numeric(JS::Value value){
    CHECK(value.isNumber());char name[64];
    auto result=std::to_chars(std::begin(name),std::end(name),value.toNumber());
    CHECK(result.ec==std::errc{});
    // Inline values have no separate GC allocation; their storage is already
    // included in the owning object's measured size.
    return snapshot_.Add(HeapGraphNode::kHeapNumber,std::string(name,result.ptr),owner_.FreshIdentity(),0);
  }
  void NumericFields(JSObject* object,Entry* entry){
    if(options_.numerics_mode!=HeapProfiler::NumericsMode::kExposeNumericValues||!object->is<js::NativeObject>())return;
    auto& native=object->as<js::NativeObject>();
    for(uint32_t i=0;i<native.slotSpan();++i){
      auto value=native.getSlot(i);if(!value.isNumber())continue;
      const auto name="slot["+std::to_string(i)+"]";
      snapshot_.Edge(entry,Numeric(value),name.c_str(),HeapGraphEdge::kHidden);
    }
    for(uint32_t i=0;i<native.getDenseInitializedLength();++i){
      auto value=native.getDenseElement(i);if(!value.isNumber())continue;
      auto* target=Numeric(value);snapshot_.Edge(entry,target,nullptr,HeapGraphEdge::kElement);
      snapshot_.references.back().ordinal=int(i);
    }
  }
  Entry* EngineValue(JS::Value value){
    if(value.isGCThing())return Add(Node(JS::GCCellPtr(value)));
    if(value.isNumber()&&options_.numerics_mode==HeapProfiler::NumericsMode::kExposeNumericValues)return Numeric(value);
    return nullptr;
  }
  Entry* EmbedderEntry(GraphNode* node){
    CHECK(node);
    if(auto* wrapper=node->WrapperNode())node=wrapper;
    if(auto found=embedderEntries_.find(node);found!=embedderEntries_.end())return found->second;
    Entry* entry=nullptr;
    if(!node->IsEmbedderNode()){
      auto* engine=static_cast<internal::EmbedderGraphImpl::V8NodeImpl*>(node);
      entry=EngineValue(Input(engine->GetObject().value()));
    }else{
      const void* address=node->GetNativeObject();if(!address)address=node->GetAddress();
      auto id=owner_.FreshIdentity();
      if(address){
        visitedNativeAddresses_.insert(address);
        auto [found,inserted]=owner_.nativeIdentities.emplace(address,id);
        if(!inserted)id=found->second;
      }
      auto* name=internal::EmbedderGraphNodeName(&snapshot_,node);
      entry=snapshot_.Add(internal::EmbedderGraphNodeType(node),
          std::strcmp(name,"Window")==0?"Window (cppgc)":name,id,node->SizeInBytes());
      entry->detached=uint8_t(node->GetDetachedness());
    }
    embedderEntries_.emplace(node,entry);return entry;
  }
 public:
  NativeHeapSnapshotCapture(JSContext* cx,internal::HeapProfiler& owner,internal::HeapSnapshot& snapshot,
      const HeapProfiler::HeapSnapshotOptions& options,const JS::AutoRequireNoGC& nogc,const NativeHeapCellCensus& census)
      :cx_(cx),owner_(owner),snapshot_(snapshot),options_(options),nogc_(nogc),census_(census){
    owner.RefreshIdentityIndex();
    for(const auto& record:owner.identities)identities_.emplace(record.cell,record.id);
  }
  Entry* Add(Node node){
    if(!node)return nullptr;
    auto [found,inserted]=entries_.emplace(node.identifier(),nullptr);
    if(!inserted)return found->second;
    auto type=HeapGraphNode::kHidden;
    switch(node.coarseType()){
      case JS::ubi::CoarseType::Object:type=HeapGraphNode::kObject;break;
      case JS::ubi::CoarseType::Script:type=HeapGraphNode::kCode;break;
      case JS::ubi::CoarseType::String:type=HeapGraphNode::kString;break;
      default:break;
    }
    std::string name;
    if(node.is<JSString>())name=NativeSnapshotString(cx_,node.as<JSString>(),nogc_);
    else if(node.is<JS::Symbol>()){type=HeapGraphNode::kSymbol;name=NativeSnapshotText(node.typeName());}
    else if(node.is<JS::BigInt>()){type=HeapGraphNode::kBigInt;name=NativeSnapshotText(node.typeName());}
    else if(node.jsObjectClassName()){
      name=node.jsObjectClassName();
      if(name=="Function")type=HeapGraphNode::kClosure;
      else if(name=="Array")type=HeapGraphNode::kArray;
      else if(name=="RegExp")type=HeapGraphNode::kRegExp;
    }else name=NativeSnapshotText(node.descriptiveTypeName()?node.descriptiveTypeName():node.typeName());
    if(options_.snapshot_mode==HeapProfiler::HeapSnapshotMode::kExposeInternals&&!node.is<JSString>())
      name=NativeSnapshotText(node.typeName())+" "+name;
    if(options_.context_name_resolver&&node.is<JSObject>()&&JS_IsGlobalObject(node.as<JSObject>())){
      auto& frame=Current(owner_.isolate);HandleScope scope(owner_.isolate);
      JS::RootedObject global(cx_,node.as<JSObject>());
      if(const char* context=options_.context_name_resolver->GetName(frame.OwnContext(global)))name=context;
    }
    const auto measured=node.size(HeapMallocSizeOf);CHECK_LE(measured,uint64_t(SIZE_MAX));
    auto* entry=snapshot_.Add(type,std::move(name),Identity(node),size_t(measured));
    JSScript* script=nullptr;
    if(node.is<js::BaseScript>()){
      auto* base=node.as<js::BaseScript>();if(base->hasBytecode())script=base->asJSScript();
    }else if(node.is<JSObject>()&&node.as<JSObject>()->is<JSFunction>()){
      auto* function=&node.as<JSObject>()->as<JSFunction>();
      auto* atom=function->maybePartialDisplayAtom();
      auto name=atom?NativeSnapshotString(cx_,atom,nogc_):std::string();
      // Native accessor names may be stored without their prefix in ESR153.
      // Read the actual flags without atomizing a name during the no-GC walk.
      if(function->isAccessorWithLazyName()){
        CHECK(function->flags().isGetter()||function->flags().isSetter());
        name=(function->flags().isGetter()?"get ":"set ")+name;
      }
      entry->label=snapshot_.Store(std::move(name));
      if(function->hasBaseScript()&&function->baseScript()->hasBytecode())script=function->baseScript()->asJSScript();
    }
    if(script)snapshot_.sourceLocations.emplace_back(entry->index(),NativeStackNumber(script->scriptSource()->id()),
        NativeStackNumber(script->lineno()-1),NativeStackNumber(script->column().oneOriginValue()-1));
    auto* pointer=reinterpret_cast<void*>(uintptr_t(node.identifier()));
    if(auto identity=owner_.identityIndex.find(pointer);identity!=owner_.identityIndex.end())
      entry->traceId=owner_.identities[identity->second].traceId;
    found->second=entry;pending_.push_back(node);
    if(node.is<JSObject>())NumericFields(node.as<JSObject>(),entry);
    return entry;
  }
  bool Walk(){
    while(!pending_.empty()){
      auto node=pending_.front();pending_.pop_front();auto* from=entries_.at(node.identifier());
      auto edges=node.edges(cx_,true);
      if(!edges)bridge::FatalOutOfMemory(owner_.isolate,"Heap snapshot edges",false);
      while(!edges->empty()){
        const auto& edge=edges->front();auto* to=Add(edge.referent);
        if(to){auto name=NativeSnapshotText(edge.name.get());snapshot_.Edge(from,to,name.c_str());}
        edges->popFront();
      }
      if(completed_!=UINT32_MAX)++completed_;
      if(!Progress())return false;
    }
    return true;
  }
  bool Build(JS::ubi::RootList& roots){
    auto* root=snapshot_.Add(HeapGraphNode::kSynthetic,"",1,0);
    Node rootNode(&roots);entries_.emplace(rootNode.identifier(),root);pending_.push_back(rootNode);
    if(!Progress()||!Walk())return false;
    // The complete portable graph container and name-merging policy come from
    // the pinned V8 source. Its JS values are borrowed only within this no-GC
    // interval; its original unique_ptr nodes own every embedder allocation.
    internal::EmbedderGraphImpl graph;
    auto callbacks=owner_.build_embedder_graph_callbacks_;
    {HandleScope scope(owner_.isolate);for(auto [callback,data]:callbacks)callback(owner_.isolate,&graph,data);}
    for(const auto& node:graph.nodes())if(node->IsEmbedderNode()){
      auto* entry=EmbedderEntry(node.get());if(!entry)continue;
      if(node->IsRootNode())snapshot_.Edge(root,entry,nullptr,HeapGraphEdge::kElement);
      if(node->WrapperNode()){
        entry->detached=uint8_t(node->GetDetachedness());
        entry->label=internal::MergeNames(&snapshot_,internal::EmbedderGraphNodeName(&snapshot_,node.get()),entry->name());
        entry->kind=internal::EmbedderGraphNodeType(node.get());
        CHECK_LE(node->SizeInBytes(),SIZE_MAX-entry->bytes);entry->bytes+=node->SizeInBytes();
      }
    }
    for(const auto& edge:graph.edges()){
      auto* from=EmbedderEntry(edge.from);auto* to=EmbedderEntry(edge.to);
      if(from&&to)snapshot_.Edge(from,to,edge.name,edge.name?HeapGraphEdge::kInternal:HeapGraphEdge::kElement);
    }
    snapshot_.extraNative=graph.native_size();
    for(auto it=owner_.nativeIdentities.begin();it!=owner_.nativeIdentities.end();)
      if(!visitedNativeAddresses_.contains(it->first))it=owner_.nativeIdentities.erase(it);else ++it;
    return Walk();
  }
};
}
const HeapSnapshot* HeapProfiler::TakeHeapSnapshot(const HeapSnapshotOptions& options){
  auto& owner=*reinterpret_cast<internal::HeapProfiler*>(this);owner.AssertLive();
  auto state=owner.owner.lock();CHECK(state);auto retained=state->heapProfiler;
  auto& frame=Current(owner.isolate);NativeNoScriptEntry entry(frame);
  if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return nullptr;
  CHECK(!owner.takingSnapshot);owner.takingSnapshot=true;
  auto reset=mozilla::MakeScopeExit([&]{owner.takingSnapshot=false;});
  try{
    auto snapshot=std::make_shared<internal::HeapSnapshot>();snapshot->owner=retained;
    {
      PreserveNativeFailure preserve(frame.cx);
      Isolate::DisallowJavascriptExecutionScope noJavascript(owner.isolate,Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
      JS::PrepareForFullGC(frame.cx);JS::NonIncrementalGC(frame.cx,JS::GCOptions::Normal,JS::GCReason::API);
      if(entry.Terminated()||JS_IsExceptionPending(frame.cx))return nullptr;
      JS::ubi::RootList roots(frame.cx,true);auto [ok,nogc]=roots.init();
      if(!ok)bridge::FatalOutOfMemory(owner.isolate,"Heap snapshot roots",false);
      NativeHeapCellCensus census;
      {js::gc::AutoTraceSession tracing(frame.cx->runtime());
       js::IterateHeapUnbarriered(frame.cx,&census,NativeHeapQueryZone,NativeHeapQueryRealm,NativeHeapQueryArena,GatherNativeSnapshotCell,tracing);}
      if(census.failed)bridge::FatalOutOfMemory(owner.isolate,"Heap snapshot cell census",false);
      NativeHeapSnapshotCapture capture(frame.cx,owner,*snapshot,options,nogc,census);
      if(!capture.Build(roots))return nullptr;
      snapshot->Finish();internal::FreezeNativeHeapAllocations(owner,*snapshot);
    }
    owner.snapshots_.push_back(snapshot);return reinterpret_cast<const HeapSnapshot*>(snapshot.get());
  }catch(const std::bad_alloc&){bridge::FatalOutOfMemory(owner.isolate,"Heap snapshot graph storage",false);}
}
}
#endif
