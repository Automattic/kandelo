#include "kandelo-node/engine-process.h"

#include <atomic>
#include <charconv>
#include <cctype>
#include <cstdio>
#include <mutex>
#include <string>
#include <string_view>
#include <thread>

#include "mozilla/RandomNum.h"
#include "js/BuildId.h"
#include "js/Initialization.h"
#include "js/Context.h"
#include "jsapi.h"
#include "kandelo-node/engine-native-api.h"
#include "kandelo-node/engine-checks.h"
#include "kandelo-node/engine-build-identity.h"

namespace v8 {
namespace {
enum class ProcessPhase { Fresh, Starting, Running, Disposed };
struct EngineProcess {
  std::mutex mutex;
  ProcessPhase phase=ProcessPhase::Fresh;
  Platform* platform=nullptr;
  std::atomic<EntropySource> entropy{nullptr};
  size_t contexts=0,owners=0;
  bool firstContextCreated=false;
  bool freezeFlagsAfterInit=true,flagsFrozen=false;
  std::atomic<bool> sourcePhaseImports{false},abortOnUncaught{false},exposeGc{false};
  std::atomic<bool> immutableArrayBuffers{false};
  std::atomic<uint32_t> externalMemoryReasonableGiB{32};
  std::thread::id foreground;
};
EngineProcess& Process(){
  // Native metadata remains resident through late static destruction, like
  // registered embedder type IDs. It owns no JS roots or native resources.
  static auto* process=new EngineProcess;return *process;
}
// No realm, Environment, JS root or engine context is required. The original
// Node callback is process-resident and already owns the OS/failure policy.
bool NativeEntropy(unsigned char* bytes,size_t length){
  auto source=Process().entropy.load(std::memory_order_acquire);CHECK(source);
  CHECK(source(bytes,length));return true;
}
bool NativeBuildId(JS::BuildIdCharVector* output){
  return output->append(kandelo::node::cache::kBuildId,
      sizeof(kandelo::node::cache::kBuildId)-1);
}
bool ApplyEngineOption(std::string_view input){
  std::string normalized(input);
  const auto equals=normalized.find('=');
  for(size_t index=0;index<(equals==std::string::npos?normalized.size():equals);++index)
    if(normalized[index]=='_')normalized[index]='-';
  const std::string_view option(normalized);
  auto& process=Process();std::lock_guard lock(process.mutex);
  if(option=="--help"){
    std::printf("SpiderMonkey %s engine options:\n"
        "  --harmony-import-attributes (standard syntax, always enabled)\n"
        "  --[no-]js-source-phase-imports\n"
        "  --[no-]js-immutable-arraybuffer\n"
        "  --[no-]freeze-flags-after-init\n"
        "  --[no-]abort-on-uncaught-exception\n"
        "  --[no-]expose-gc (synchronous full gc() only)\n"
        "  --external-memory-max-reasonable-size=<GiB> (0 disables the check)\n",
        JS_GetImplementationVersion());
    return true;
  }
  const bool source=option=="--js-source-phase-imports"||option=="--no-js-source-phase-imports";
  const bool immutable = option == "--js-immutable-arraybuffer" ||
                         option == "--no-js-immutable-arraybuffer";
  const bool freeze=option=="--freeze-flags-after-init"||option=="--no-freeze-flags-after-init";
  const bool abort=option=="--abort-on-uncaught-exception"||option=="--no-abort-on-uncaught-exception";
  const bool expose=option=="--expose-gc"||option=="--no-expose-gc";
  constexpr std::string_view external="--external-memory-max-reasonable-size=";
  uint32_t limit=0;const bool memory=option.starts_with(external);
  if(memory){
    const auto value=option.substr(external.size());
    auto parsed=std::from_chars(value.data(),value.data()+value.size(),limit);
    if(parsed.ec!=std::errc()||parsed.ptr!=value.data()+value.size())return false;
  }
  // Node explicitly enables standard import attributes during ordinary startup.
  // ESR153 parses them unconditionally (Parser::importDeclaration/withClause),
  // so enabling this syntax needs no alternate parser or source rewriting.
  const bool importAttributes=option=="--harmony-import-attributes";
  // Ordinary startup still asks V8 to rehash restored snapshot hash tables.
  // This runtime constructs a fresh heap, so there are no restored tables to
  // rehash. Actual snapshot creation/restoration remains explicitly rejected.
  const bool freshHeapRehash=option=="--rehash-snapshot"||option=="--no-rehash-snapshot";
  if(!source&&!freeze&&!memory&&!abort&&!expose&&!importAttributes&&!freshHeapRehash&&!immutable)return false;
  CHECK(!process.flagsFrozen);
  if (immutable) {
    process.immutableArrayBuffers.store(option == "--js-immutable-arraybuffer", std::memory_order_release);
  }
  if(abort)process.abortOnUncaught.store(option=="--abort-on-uncaught-exception",std::memory_order_release);
  if(expose)process.exposeGc.store(option=="--expose-gc",std::memory_order_release);
  if(source)process.sourcePhaseImports.store(option=="--js-source-phase-imports",std::memory_order_release);
  if(freeze)process.freezeFlagsAfterInit=option=="--freeze-flags-after-init";
  if(memory)process.externalMemoryReasonableGiB.store(limit,std::memory_order_release);
  return true;
}
}
const char* V8::GetVersion(){return JS_GetImplementationVersion();}
void V8::SetFlagsFromCommandLine(int* argc,char** argv,bool remove){
  CHECK(argc&&*argc>=0&&(!*argc||argv));int remaining=*argc?1:0;
  for(int index=1;index<*argc;++index){
    const bool consumed=argv[index]&&ApplyEngineOption(argv[index]);
    if(!consumed||!remove)argv[remaining++]=argv[index];
  }
  if(remove){for(int index=remaining;index<*argc;++index)argv[index]=nullptr;*argc=remaining;}
}
void V8::SetFlagsFromString(const char* flags){CHECK(flags);SetFlagsFromString(flags,std::strlen(flags));}
void V8::SetFlagsFromString(const char* flags,size_t length){
  CHECK(flags||!length);const std::string_view input(flags?flags:"",length);
  size_t cursor=0;
  while(cursor<input.size()){
    while(cursor<input.size()&&std::isspace(static_cast<unsigned char>(input[cursor])))++cursor;
    const size_t start=cursor;
    while(cursor<input.size()&&!std::isspace(static_cast<unsigned char>(input[cursor])))++cursor;
    if(cursor>start&&!ApplyEngineOption(input.substr(start,cursor-start)))
      std::fprintf(stderr,"SpiderMonkey: unsupported engine option: %.*s\n",int(cursor-start),input.data()+start);
  }
}
void V8::SetEntropySource(EntropySource source){
  auto& process=Process();std::lock_guard lock(process.mutex);
  CHECK(process.phase==ProcessPhase::Fresh);CHECK(source);
  process.entropy.store(source,std::memory_order_release);
  // MFBT seed requests now enter the original native Node callback, including
  // requests made during JS_Init before a runtime/Environment exists.
  mozilla::SetRandomBytesSource(NativeEntropy);
}
void V8::InitializePlatform(Platform* platform){
  auto& process=Process();std::lock_guard lock(process.mutex);
  CHECK(process.phase==ProcessPhase::Fresh&&platform&&!process.platform);
  process.platform=platform;
}
Platform* V8::GetCurrentPlatform(){
  auto& process=Process();std::lock_guard lock(process.mutex);return process.platform;
}
bool V8::Initialize(){
  auto& process=Process();std::lock_guard lock(process.mutex);
  if(process.phase==ProcessPhase::Running)return true;
  CHECK(process.phase==ProcessPhase::Fresh&&process.platform);
  CHECK(process.entropy.load(std::memory_order_acquire));
  CHECK(!JS_IsInitialized());
  // Resident before the first runtime and valid through late destruction.
  // SpiderMonkey adds its own pointer-size/endianness/runtime-format bytes.
  // The generic engine hook owns no Node state. This existing resident native
  // logger remains valid before Environment creation and after its disposal.
  JS::SetNativeExecutionFatalHandler(kandelo_v8_graceful_fatal);
  bridge::RegisterNativeBufferOwnerFactory();
  JS::SetProcessBuildIdOp(NativeBuildId);
  process.phase=ProcessPhase::Starting;process.foreground=std::this_thread::get_id();
  if(const char* diagnostic=JS_InitWithFailureDiagnostic())
    kandelo_v8_graceful_fatal(diagnostic);
  process.flagsFrozen=process.freezeFlagsAfterInit;
  process.phase=ProcessPhase::Running;return true;
}
bool V8::Dispose(){
  auto& process=Process();std::lock_guard lock(process.mutex);
  if(process.phase==ProcessPhase::Fresh||process.phase==ProcessPhase::Disposed)return true;
  CHECK(process.phase==ProcessPhase::Running);
  CHECK(process.foreground==std::this_thread::get_id());CHECK(process.contexts==0&&process.owners==0);
  // Individual owners must already have completed their real cancellation,
  // native retirement and context destruction. JS_ShutDown joins the engine's
  // process-wide helper services; it is never a queue-empty substitute.
  JS_ShutDown();process.phase=ProcessPhase::Disposed;return true;
}
void V8::DisposePlatform(){
  auto& process=Process();std::lock_guard lock(process.mutex);
  CHECK(process.phase==ProcessPhase::Fresh||process.phase==ProcessPhase::Disposed);
  CHECK(process.contexts==0&&process.owners==0);process.platform=nullptr;
  // Keep the resident entropy callback valid for late native destruction.
}
namespace bridge {
bool SourcePhaseImportsEnabled(){return Process().sourcePhaseImports.load(std::memory_order_acquire);}
bool AbortOnUncaughtEnabled(){return Process().abortOnUncaught.load(std::memory_order_acquire);}
bool ExposedGcEnabled(){return Process().exposeGc.load(std::memory_order_acquire);}
bool ImmutableArrayBuffersEnabled() {
  return Process().immutableArrayBuffers.load(std::memory_order_acquire);
}
void CheckExternalMemoryDelta(int64_t bytes){
  const auto limit=Process().externalMemoryReasonableGiB.load(std::memory_order_acquire);
  const auto maximum=int64_t(limit)*(int64_t(1)<<30);
  CHECK(!limit||(bytes>=-maximum&&bytes<maximum));
}
void RegisterProcessContext(){
  auto& process=Process();std::lock_guard lock(process.mutex);
  CHECK(process.phase==ProcessPhase::Running);CHECK(process.owners!=SIZE_MAX);
  ++process.owners;
}
void RetireProcessContext(){
  auto& process=Process();std::lock_guard lock(process.mutex);
  CHECK(process.phase==ProcessPhase::Running&&process.owners>0);--process.owners;
}
JSContext* NewProcessContext(){
  auto& process=Process();std::lock_guard lock(process.mutex);
  CHECK(process.phase==ProcessPhase::Running);
  CHECK(process.firstContextCreated||process.foreground==std::this_thread::get_id());
  // Serialize first-runtime and self-hosted initialization. Node's worker
  // platform may already exist, but no second JS constructor may race this.
  JSContext* cx=JS_NewContext(UINT32_MAX);if(!cx)return nullptr;
  InitializeNativeContextMetadata(cx);
  if(!JS::InitSelfHostedCode(cx)){JS_DestroyContext(cx);return nullptr;}
  process.firstContextCreated=true;CHECK(process.contexts!=SIZE_MAX);++process.contexts;return cx;
}
void DestroyProcessContext(JSContext* cx){
  auto& process=Process();std::lock_guard lock(process.mutex);
  CHECK(process.phase==ProcessPhase::Running&&cx&&process.contexts>0);
  // SpiderMonkey itself checks the creating thread and outstanding rooters.
  JS_DestroyContext(cx);--process.contexts;
}
}
}
