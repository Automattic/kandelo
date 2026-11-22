#ifndef KANDELO_ENGINE_CPU_PROFILER_CODECS_INL_H
#define KANDELO_ENGINE_CPU_PROFILER_CODECS_INL_H
#include "shell/node-upstream/engine-cpu-profiler-data.h"
#include "vm/FrameIter-inl.h"
#include "vm/JSFunction.h"
#include "vm/Realm.h"
#include "uv.h"
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
#undef DCHECK
#pragma push_macro("DCHECK_NULL")
#undef DCHECK_NULL
#pragma push_macro("DCHECK_NE")
#undef DCHECK_NE
#pragma push_macro("DCHECK_GE")
#undef DCHECK_GE
#pragma push_macro("DCHECK_GT")
#undef DCHECK_GT
#pragma push_macro("CHECK_WITH_MSG")
#undef CHECK_WITH_MSG
#pragma push_macro("V8_LIKELY")
#undef V8_LIKELY
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
#define DCHECK_GE(a,b) DCHECK((a)>=(b))
#define DCHECK_GT(a,b) DCHECK((a)>(b))
#define CHECK_WITH_MSG(condition,message) do{if(!(condition))kandelo_v8_graceful_fatal(message);}while(false)
#define V8_LIKELY(condition) __builtin_expect(bool(condition),true)
#pragma push_macro("V8_EXPORT_PRIVATE")
#undef V8_EXPORT_PRIVATE
#define V8_EXPORT_PRIVATE
#pragma push_macro("V8_INLINE")
#undef V8_INLINE
#define V8_INLINE inline
#include "shell/node-upstream/cpu-profiler-upstream/deps/v8/src/profiler/profile-generator.h"

namespace v8::internal {
namespace {
int64_t NativeCpuNow(){return int64_t(uv_hrtime()/1000);}
std::atomic<v8::ProfilerId> nextNativeCpuProfile{0};
const ProfileNode& NativeCpuNode(const v8::CpuProfileNode* node){return *reinterpret_cast<const ProfileNode*>(node);}
}
// The helper never reads a JS cell. Each accepted packet retains the sampler
// until delivery; stopping nulls its owner and joins before engine retirement.
struct NativeCpuSampling:std::enable_shared_from_this<NativeCpuSampling> {
  v8::Isolate* const isolate;
  CpuProfiler* owner;  // Read/written only by the owning JS thread.
  const int interval;
  std::mutex mutex;
  std::condition_variable wake;
  bool stopped=false;
  std::atomic<bool> pending{false};
  std::atomic<int64_t> completed{0};
  std::thread thread;
  NativeCpuSampling(CpuProfiler* input):isolate(input->isolate),owner(input),interval(input->interval){}
  ~NativeCpuSampling(){CHECK(!thread.joinable());}
  static void Deliver(v8::Isolate* isolate,void* raw){
    std::unique_ptr<std::shared_ptr<NativeCpuSampling>> packet(static_cast<std::shared_ptr<NativeCpuSampling>*>(raw));
    auto sampler=*packet;CHECK(sampler->isolate==isolate);
    if(sampler->owner)sampler->owner->Capture();
    sampler->completed.store(NativeCpuNow(),std::memory_order_release);
    sampler->pending.store(false,std::memory_order_release);
  }
  void Run(){
    std::unique_lock lock(mutex);
    while(!wake.wait_for(lock,std::chrono::microseconds(interval),[&]{return stopped;})){
      // Never accumulate missed ticks or sample the sampling callback itself.
      if(NativeCpuNow()-completed.load(std::memory_order_acquire)<interval||
          pending.exchange(true,std::memory_order_acq_rel))continue;
      lock.unlock();
      try {
        auto packet=std::make_unique<std::shared_ptr<NativeCpuSampling>>(shared_from_this());
        isolate->RequestInterrupt(Deliver,packet.get());packet.release();
      }catch(const std::bad_alloc&){
        kandelo_v8_graceful_fatal("CPU profiler native interrupt allocation failed");
      }
      lock.lock();
    }
  }
  void Stop(){
    owner=nullptr;
    {std::lock_guard lock(mutex);stopped=true;}
    wake.notify_one();if(thread.joinable())thread.join();
  }
};
CpuProfiler::CpuProfiler(v8::Isolate* input,v8::CpuProfilingNamingMode mode)
    :isolate(input),state(input->owner),naming(mode){
  auto live=state.lock();CHECK(live);live->AssertForeground();
  CHECK(live->cpuProfilers.insert(this).second);registered=true;
}
CpuProfiler::~CpuProfiler(){Retire();}
void CpuProfiler::StopSampler(){if(sampling_){sampling_->Stop();sampling_.reset();}}
void CpuProfiler::StartSampler(){
  if(sampling_)return;
  sampling_=std::make_shared<NativeCpuSampling>(this);
  try {sampling_->thread=std::thread([sampler=sampling_.get()]{sampler->Run();});}
  catch(const std::system_error&){kandelo_v8_graceful_fatal("CPU profiler sampling thread creation failed");}
}
void CpuProfiler::Retire(){
  if(!isolate)return;
  auto live=state.lock();CHECK(live);live->AssertForeground();
  StopSampler();
  for(auto& [id,profile]:profiles)profile->Detach();
  profiles.clear();
  if(registered){CHECK_EQ(live->cpuProfilers.erase(this),size_t(1));registered=false;}
  isolate=nullptr;state.reset();
}
CpuProfile::CpuProfile(CpuProfiler* owner,v8::ProfilerId id,v8::CpuProfilingOptions options,
    std::unique_ptr<v8::DiscardedSamplesDelegate> delegate,std::string name,bool record)
    :owner_(owner),options_(std::move(options)),delegate_(std::move(delegate)),
     filtered_(options_.has_filter_context()),identity(id),title(std::move(name)),
     tree_(std::make_unique<ProfileTree>(owner->isolate)),started{NativeCpuNow()},recordSamples(record){
  if(delegate_)delegate_->SetId(identity);
}
void CpuProfile::Detach(){
  options_.filter_context_.Reset();owner_=nullptr;active=false;
}
void CpuProfile::AddSample(const std::vector<NativeCpuFrame>& frames,
    const JS::RootedObjectVector& globals,int64_t timestamp,int sourceInterval){
  if(!active)return;
  const int requested=options_.sampling_interval_us();
  const int interval=std::max(sourceInterval,(requested/sourceInterval)*sourceInterval);
  if(lastSample&&timestamp-lastSample<interval)return;
  JSObject* filter=nullptr;
  if(filtered_){
    auto context=options_.filter_context_.Get(owner_->isolate);
    if(context.IsEmpty())return;
    filter=&context->cell().value.get().toObject();
  }
  ProfileStackTrace path;const NativeCpuFrame* leaf=nullptr;
  for(const auto& frame:frames){
    if(filtered_&&globals[frame.globalIndex]!=filter)continue;
    CodeEntry::Key key{frame.scriptId,frame.name,frame.line,frame.column};
    auto found=entries_.find(key);
    if(found==entries_.end())found=entries_.emplace(std::move(key),std::make_unique<CodeEntry>(frame)).first;
    path.push_back({found->second.get(),{frame.hitLine,frame.hitColumn}});
    if(!leaf)leaf=&frame;
  }
  if(!leaf)return;
  lastSample=timestamp;
  auto* node=tree_->AddPathFromEnd(path,{leaf->hitLine,leaf->hitColumn},true,options_.mode());
  if(recordSamples&&samples.size()<options_.max_samples()){
    CHECK_LT(samples.size(),size_t(INT_MAX));samples.push_back({node,{timestamp}});
  }else if(recordSamples&&delegate_&&!notified_){
    notified_=true;delegate_->Notify();
  }
}
v8::CpuProfilingResult CpuProfiler::Start(v8::CpuProfilingOptions options,
    std::unique_ptr<v8::DiscardedSamplesDelegate> delegate,std::string title,bool record){
  CHECK(isolate);auto live=state.lock();CHECK(live);live->AssertForeground();
  size_t active=0;
  for(auto& [id,profile]:profiles)if(profile->active){
    ++active;if(!title.empty()&&profile->title==title)return {id,v8::CpuProfilingStatus::kAlreadyStarted};
  }
  if(active>=100)return {0,v8::CpuProfilingStatus::kErrorTooManyProfilers};
  const auto id=nextNativeCpuProfile.fetch_add(1,std::memory_order_relaxed)+1;CHECK(id);
  auto profile=std::make_shared<CpuProfile>(this,id,std::move(options),std::move(delegate),std::move(title),record);
  CHECK(profiles.emplace(id,std::move(profile)).second);StartSampler();
  return {id,v8::CpuProfilingStatus::kStarted};
}
v8::CpuProfile* CpuProfiler::Stop(v8::ProfilerId id){
  CHECK(isolate);auto live=state.lock();CHECK(live);live->AssertForeground();
  auto found=profiles.find(id);if(found==profiles.end()||!found->second->active)return nullptr;
  auto& profile=*found->second;profile.active=false;profile.finished={NativeCpuNow()};
  bool active=false;for(auto& [key,value]:profiles)if(value->active){active=true;break;}
  if(!active)StopSampler();return reinterpret_cast<v8::CpuProfile*>(&profile);
}
void CpuProfiler::DeleteProfile(CpuProfile* profile){
  CHECK(isolate&&profile&&!profile->active);auto live=state.lock();CHECK(live);live->AssertForeground();
  auto found=profiles.find(profile->identity);CHECK(found!=profiles.end()&&found->second.get()==profile);
  profile->Detach();profiles.erase(found);
}
void CpuProfiler::Capture(){
  auto live=state.lock();CHECK(live);live->AssertForeground();auto* cx=live->cx;
  if(cx->isNativeExecutionTerminating()||cx->isExceptionPending()||!JS::CurrentGlobalOrNull(cx))return;
  try {
    // Freeze the owners before a native discard notification can reenter.
    // All cells are read on this JS thread, and globals/names remain rooted
    // across UTF-8 conversion, native notifications and any resulting GC.
    std::vector<std::shared_ptr<CpuProfile>> active;
    for(auto& [id,profile]:profiles)if(profile->active)active.push_back(profile);
    const auto sourceInterval=interval;
    const auto namingMode=naming;
    const auto timestamp=NativeCpuNow();
    JS::RootedObjectVector globals(cx);JS::RootedValueVector names(cx);
    std::vector<NativeCpuFrame> frames;
    {
      JS::AutoCheckCannotGC nogc;
      for(js::NonBuiltinScriptFrameIter it(cx);!it.done();++it){
        auto* script=it.script();NativeCpuFrame frame;
        frame.scriptId=NativeStackNumber(script->scriptSource()->id());
        frame.line=NativeStackNumber(script->lineno());frame.column=NativeStackNumber(script->column().oneOriginValue());
        JS::LimitedColumnNumberOneOrigin column;
        frame.hitLine=NativeStackNumber(js::PCToLineNumber(script,it.pc(),&column));
        frame.hitColumn=NativeStackNumber(column.oneOriginValue());
        if(script->filename())frame.url=script->filename();
        JSAtom* name=nullptr;
        if(it.isFunctionFrame()){
          auto* function=it.calleeTemplate();
          // NonBuiltinScriptFrameIter supplies scripted callees. ESR153's
          // full-name accessors explicitly support this no-allocation case.
          name=namingMode==v8::kDebugNaming?function->fullDisplayAtom():function->fullExplicitOrInferredName();
        }
        frame.globalIndex=globals.length();
        if(!globals.append(it.realm()->maybeGlobal())||
           !names.append(name?JS::StringValue(name):JS::UndefinedValue()))
          bridge::FatalOutOfMemory(&live->isolate,"CPU profiler frame roots",false);
        frames.push_back(std::move(frame));
      }
    }
    for(size_t i=0;i<frames.size();++i)if(names[i].isString()){
      JS::RootedString name(cx,names[i].toString());auto utf8=JS_EncodeStringToUTF8(cx,name);
      if(!utf8)bridge::FatalOutOfMemory(&live->isolate,"CPU profiler frame name",false);
      frames[i].name=utf8.get();
    }
    // Empty/native-only observations are not manufactured into JS samples.
    for(auto& profile:active)profile->AddSample(frames,globals,timestamp,sourceInterval);
  }catch(const std::bad_alloc&){bridge::FatalOutOfMemory(&live->isolate,"CPU profiler sample storage",false);}
}
}
namespace v8 {
void RetireNativeCpuProfilers(State& state){
  state.AssertForeground();while(!state.cpuProfilers.empty())(*state.cpuProfilers.begin())->Retire();
}
CpuProfilingOptions::CpuProfilingOptions(CpuProfilingMode mode,unsigned maxSamples,int interval,
    MaybeLocal<Context> filter,CpuProfileSource source)
    :mode_(mode),max_samples_(maxSamples),sampling_interval_us_(interval),profile_source_(source){
  CHECK_GE(interval,0);
  if(!filter.IsEmpty()){filter_context_.Reset(Isolate::GetCurrent(),filter.ToLocalChecked());filter_context_.SetWeak();}
}
void* CpuProfilingOptions::raw_filter_context()const{
  auto context=filter_context_.Get(Isolate::GetCurrent());
  return context.IsEmpty()?nullptr:&context->cell().value.get().toObject();
}
CpuProfiler* CpuProfiler::New(Isolate* isolate,CpuProfilingNamingMode naming,CpuProfilingLoggingMode){
  try {return reinterpret_cast<CpuProfiler*>(new internal::CpuProfiler(isolate,naming));}
  catch(const std::bad_alloc&){bridge::FatalOutOfMemory(isolate,"CPU profiler creation",false);}
}
void CpuProfiler::Dispose(){delete reinterpret_cast<internal::CpuProfiler*>(this);}
CpuProfilingResult CpuProfiler::Start(CpuProfilingOptions options,std::unique_ptr<DiscardedSamplesDelegate> delegate){
  auto* profiler=reinterpret_cast<internal::CpuProfiler*>(this);
  try{return profiler->Start(std::move(options),std::move(delegate));}
  catch(const std::bad_alloc&){bridge::FatalOutOfMemory(profiler->isolate,"CPU profile creation",false);}
}
CpuProfile* CpuProfiler::Stop(ProfilerId id){return reinterpret_cast<internal::CpuProfiler*>(this)->Stop(id);}
void CpuProfiler::UseDetailedSourcePositionsForProfiling(Isolate* isolate){
  // This interpreter retains source notes for every compiled script. Capture
  // reads the actual PC's line/column through PCToLineNumber; there is no
  // coarse JIT-code table to regenerate or speculative position to enable.
  auto live=isolate->owner.lock();CHECK(live);live->AssertForeground();
}
void CpuProfile::Delete(){
  auto* profile=reinterpret_cast<internal::CpuProfile*>(this);auto* owner=profile->cpu_profiler();CHECK(owner);owner->DeleteProfile(profile);
}
const char* CpuProfileNode::GetFunctionNameStr()const{return internal::NativeCpuNode(this).entry()->name();}
const char* CpuProfileNode::GetScriptResourceNameStr()const{return internal::NativeCpuNode(this).entry()->resource_name();}
int CpuProfileNode::GetScriptId()const{return internal::NativeCpuNode(this).entry()->script_id();}
int CpuProfileNode::GetLineNumber()const{return internal::NativeCpuNode(this).line_and_column().line;}
int CpuProfileNode::GetColumnNumber()const{return internal::NativeCpuNode(this).line_and_column().column;}
unsigned CpuProfileNode::GetHitCount()const{return internal::NativeCpuNode(this).self_ticks();}
unsigned CpuProfileNode::GetNodeId()const{return internal::NativeCpuNode(this).id();}
unsigned CpuProfileNode::GetHitLineCount()const{return internal::NativeCpuNode(this).GetHitLineCount();}
bool CpuProfileNode::GetLineTicks(LineTick* entries,unsigned length)const{return internal::NativeCpuNode(this).GetLineTicks(entries,length);}
const char* CpuProfileNode::GetBailoutReason()const{return nullptr;}  // This engine has no optimizing JIT.
int CpuProfileNode::GetChildrenCount()const{const auto* children=internal::NativeCpuNode(this).children();CHECK_LE(children->size(),size_t(INT_MAX));return int(children->size());}
const CpuProfileNode* CpuProfileNode::GetChild(int index)const{return reinterpret_cast<const CpuProfileNode*>(internal::NativeCpuNode(this).children()->at(size_t(index)));}
}
#include "shell/node-upstream/cpu-profiler-upstream/deps/v8/src/profiler/profile-generator.cc"
#pragma pop_macro("V8_INLINE")
#pragma pop_macro("V8_EXPORT_PRIVATE")
#pragma pop_macro("V8_LIKELY")
#pragma pop_macro("CHECK_WITH_MSG")
#pragma pop_macro("DCHECK_GT")
#pragma pop_macro("DCHECK_GE")
#pragma pop_macro("DCHECK_NE")
#pragma pop_macro("DCHECK_NULL")
#pragma pop_macro("DCHECK")
#pragma pop_macro("DCHECK_IMPLIES")
#pragma pop_macro("DCHECK_NOT_NULL")
#pragma pop_macro("DCHECK_LT")
#pragma pop_macro("DCHECK_LE")
#pragma pop_macro("DCHECK_EQ")
namespace v8::internal {
void CpuProfile::Serialize(v8::OutputStream* stream){
  CHECK(stream&&!active);CpuProfileJSONSerializer serializer(this);serializer.Serialize(stream);
}
}
namespace v8 {
void CpuProfile::Serialize(OutputStream* stream,SerializationFormat format)const{
  CHECK(format==kJSON);auto* profile=reinterpret_cast<internal::CpuProfile*>(const_cast<CpuProfile*>(this));
  try {profile->Serialize(stream);}
  catch(const std::bad_alloc&){
    auto* owner=profile->cpu_profiler();CHECK(owner);
    bridge::FatalOutOfMemory(owner->isolate,"CPU profile serialization",false);
  }
}
}
#endif
