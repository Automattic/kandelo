#ifndef KANDELO_ENGINE_STATE_H
#define KANDELO_ENGINE_STATE_H

#include <atomic>
#include <map>
#include <thread>

#include "engine-native-api.h"
#include "js/RootingAPI.h"
#include "js/GCAPI.h"
#include "js/Principals.h"
#include "js/Modules.h"

namespace v8 {
namespace internal {class CpuProfiler;class HeapProfiler;}
void RetireNativeCpuProfilers(State&);
void RetireNativeHeapProfiler(State&);
void UpdateNativeHeapWeakEdges(State&,JSTracer*);
struct CatchScope;
struct NativeMemoryMeasurements;
// Storage for one actual SpiderMonkey context. Node policy and native resource
// ownership belong to original Node objects, never this engine record.
struct State {
  JSContext* const cx;
  std::unique_ptr<Isolate> ownedIsolate;
  Isolate& isolate;
  CatchScope* catchScope=nullptr;
  CppHeap* cppHeap=nullptr;  // Borrowed from the Isolate's actual native heap owner.
  MicrotaskQueue* microtasks=nullptr;  // Borrowed from the Isolate, not Node policy.
  PromiseRejectCallback promiseRejectCallback=nullptr;  // Supplied original Node handler.
  PromiseHook promiseHook=nullptr;
  bool nativeStackPreparing=false;
  size_t contextPromiseHookOwners=0;  // Counts live context metadata, not roots.
  size_t nativeEntryDepth=0;
  size_t microtaskCallSuppressions=0;  // Separate from native exception-catch depth.
  // SpiderMonkey contexts remain on their owning thread. These are actual
  // scoped lock/root-admission records, never a second Node scheduler/owner.
  std::recursive_mutex engineMutex;
  size_t lockerDepth=0,handleScopeLevel=0;
  HandleScope* activeHandleScope=nullptr;
  SealHandleScopeData* activeHandleSeal=nullptr;
  std::optional<size_t> sealedHandleLevel;
  // The callback table is borrowed by the actual engine runtime. Unregister
  // it before deleting State; none of these native fields own JS values.
  JSSecurityCallbacks codeGenerationSecurity{};
  const JSSecurityCallbacks* previousSecurityCallbacks=nullptr;
  bool codeGenerationSecurityInstalled=false;
  ModifyCodeGenerationFromStringsCallback2 modifyCodeGeneration=nullptr;
  AllowWasmCodeGenerationCallback allowWasmCodeGeneration=nullptr;
  // Intrusive native inventory adds no JS root or allocation. Plain weak
  // handles may retire from a producer; protect sampling/unlinking together.
  std::mutex globalRootsMutex;
  GlobalRoot* globalRootsHead=nullptr;
  std::vector<std::shared_ptr<GlobalRoot>> weakGlobals;
  std::vector<std::unique_ptr<Data>> eternalRoots;
  // V8's primitive constants use Isolate root slots, not HandleScope storage.
  // These values must survive a nested scope's return.
  std::unique_ptr<Primitive> undefinedConstant,nullConstant;
  std::unique_ptr<Boolean> trueConstant,falseConstant;
  std::unique_ptr<String> emptyStringConstant;
  // API registries are per engine owner and are invisible to Symbol.for().
  // Preserve UTF-16 code units, including lone surrogates and embedded NULs.
  std::map<std::u16string,std::unique_ptr<Data>> apiSymbols,apiPrivateNames;
  std::unique_ptr<JS::PersistentRootedObject> templateRealm;
  std::unique_ptr<JS::PersistentRootedObject> compilationOrigins;
  // Each actual global owns its fields; the engine roots only their key.
  std::unique_ptr<JS::PersistentRootedSymbol> contextEmbedderDataKey;
  struct ExternalStringResourceRecord {
    String::ExternalOneByteStringResource* one=nullptr;
    String::ExternalStringResource* two=nullptr;
  };
  // Native identities only; the actual engine string owns the callbacks and
  // resource. The registry adds no JS root or independent resource owner.
  std::mutex externalStringMutex;
  std::map<const JSExternalStringCallbacks*,ExternalStringResourceRecord> externalStringResources;
  // A private tenured GC owner carries native external-memory pressure without
  // rooting a Node realm or callback. Negative credits may arrive from sweep
  // threads; only the owning JS thread changes the collector's owner record.
  std::shared_ptr<NativeMemoryMeasurements> memoryMeasurements;
  // Borrowed profiler owners. Final engine retirement stops and joins their
  // sampling producers before the canonical native callback queue is drained.
  std::set<internal::CpuProfiler*> cpuProfilers;
  std::shared_ptr<internal::HeapProfiler> heapProfiler;
  std::unique_ptr<JS::PersistentRootedObject> externalPressureOwner;
  std::atomic<uint64_t> nativeExternalCredits{0};
  size_t externalPressureBytes=0;
  std::atomic<size_t> externalBytes{0}, created{0}, released{0}, spans{0}, collections{0};
  std::atomic<size_t> bufferCreated{0},bufferFreed{0},bufferBytes{0};
  bool stressGc=false;
  JS::ModuleLoadHook previousModuleLoad=nullptr;
  JS::ModuleMetadataHook previousModuleMetadata=nullptr;
  JS::ModuleDynamicImportValueOwner previousDynamicOwner=nullptr;
  JS::ModuleDynamicImportValueHook previousDynamicImport=nullptr;
  HostInitializeImportMetaObjectCallback initializeImportMeta=nullptr;
  HostImportModuleDynamicallyCallback importModuleDynamically=nullptr;
  HostImportModuleWithPhaseDynamicallyCallback importModuleWithPhaseDynamically=nullptr;
  bool moduleLoadHookInstalled=false;
  uint32_t nextModuleIdentityHash=0;
 private:
  const std::thread::id foreground_=std::this_thread::get_id();
 public:
  explicit State(JSContext* context,Isolate* external=nullptr)
      :cx(context),ownedIsolate(external?nullptr:std::make_unique<Isolate>()),
       isolate(external?*external:*ownedIsolate){if(!cx)Crash("Missing engine context");}
  ~State()=default;
  bool IsForeground()const{return foreground_==std::this_thread::get_id();}
  void AssertForeground()const{if(foreground_!=std::this_thread::get_id())Crash("Wrong engine thread");}
  void CheckLocalHandleAllocation(size_t level)const{
    AssertForeground();
    if(sealedHandleLevel&&level<=*sealedHandleLevel)Crash("Cannot create a local handle in a sealed handle scope");
  }
  void CheckLocalHandleAllocation()const{CheckLocalHandleAllocation(handleScopeLevel);}
};
}
#endif
