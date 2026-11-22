#ifndef KANDELO_ENGINE_SCRIPT_API_H
#define KANDELO_ENGINE_SCRIPT_API_H
#include "engine-native-api.h"

// Source interfaces for real SpiderMonkey compiler/module records. Unfinished
// services remain required definitions; these declarations are not a complete
// SDK and do not substitute values for compiler or loader results.
namespace v8 {
enum class ModuleImportPhase{kSource,kDefer,kEvaluation};
class ScriptOriginOptions {
  bool shared_,opaque_,wasm_,module_;
 public:
  ScriptOriginOptions(bool shared=false,bool opaque=false,bool wasm=false,bool module=false)
      :shared_(shared),opaque_(opaque),wasm_(wasm),module_(module){}
  explicit ScriptOriginOptions(int flags):ScriptOriginOptions(flags&1,flags&2,flags&4,flags&8){}
  bool IsSharedCrossOrigin()const{return shared_;}bool IsOpaque()const{return opaque_;}
  bool IsWasm()const{return wasm_;}bool IsModule()const{return module_;}
  int Flags()const{return int(shared_)|int(opaque_)<<1|int(wasm_)<<2|int(module_)<<3;}
};
class ScriptOrigin {
  Local<Message> message_;
  Local<Value> resource_,sourceMap_;
  Local<Data> hostOptions_;
  int line_=0,column_=0,id_=-1;
  ScriptOriginOptions options_;
 public:
  ScriptOrigin(Local<Message> message,std::nullptr_t,ScriptOriginOptions options={}):message_(message),options_(options){}
  explicit ScriptOrigin(Local<Value> resource,int line=0,int column=0,bool shared=false,
      int id=-1,Local<Value> map={},bool opaque=false,bool wasm=false,bool module=false,Local<Data> host={})
      :resource_(resource),sourceMap_(map),hostOptions_(host),line_(line),column_(column),id_(id),options_(shared,opaque,wasm,module){
    if(!host.IsEmpty()&&!host->IsFixedArray())Crash("Script host options must be a PrimitiveArray");
  }
  Local<Value> ResourceName()const;Local<Value> SourceMapUrl()const;
  int LineOffset()const;int ColumnOffset()const;
  int ScriptId()const{return id_;}ScriptOriginOptions Options()const{return options_;}
  Local<Data> GetHostDefinedOptions()const{return hostOptions_;}
  const ScriptOriginOptions& NativeResourceOptions()const{return options_;}
};
class Location {
  int line_,column_;
 public:Location(int line,int column):line_(line),column_(column){}
  int GetLineNumber()const{return line_;}int GetColumnNumber()const{return column_;}
};
class ModuleRequest : public Data {
 public:using Data::Data;
  bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
  Local<String> GetSpecifier()const;ModuleImportPhase GetPhase()const;
  int GetSourceOffset()const;Local<FixedArray> GetImportAttributes()const;
};
class UnboundModuleScript : public Data {
 public:using Data::Data;
  bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
  Local<Value> GetSourceURL();Local<Value> GetSourceMappingURL();int ScriptId()const;
  static const int kNoScriptId=0;
};
class Module : public Data {
 public:using Data::Data;
  bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
  enum Status{kUninstantiated,kInstantiating,kInstantiated,kEvaluating,kEvaluated,kErrored};
  using ResolveModuleCallback=MaybeLocal<Module>(*)(Local<Context>,Local<String>,Local<FixedArray>,Local<Module>);
  using ResolveSourceCallback=MaybeLocal<Object>(*)(Local<Context>,Local<String>,Local<FixedArray>,Local<Module>);
  using ResolveModuleByIndexCallback=MaybeLocal<Module>(*)(Local<Context>,size_t,Local<Module>);
  using ResolveSourceByIndexCallback=MaybeLocal<Object>(*)(Local<Context>,size_t,Local<Module>);
  using SyntheticModuleEvaluationSteps=MaybeLocal<Value>(*)(Local<Context>,Local<Module>);
  Status GetStatus()const;Local<Value> GetException()const;Local<Value> GetResourceName()const;
  Local<FixedArray> GetModuleRequests()const;Location SourceOffsetToLocation(int)const;
  int GetIdentityHash()const;
  Maybe<bool> InstantiateModule(Local<Context>,ResolveModuleByIndexCallback,ResolveSourceByIndexCallback=nullptr);
  Maybe<bool> InstantiateModule(Local<Context>,ResolveModuleCallback,ResolveSourceCallback=nullptr);
  MaybeLocal<Value> Evaluate(Local<Context>);Local<Value> GetModuleNamespace();
  Local<UnboundModuleScript> GetUnboundModuleScript();int ScriptId()const;
  bool IsGraphAsync()const;bool HasTopLevelAwait()const;
  bool IsSourceTextModule()const;bool IsSyntheticModule()const;
  static Local<Module> CreateSyntheticModule(Isolate*,Local<String>,
      const MemorySpan<const Local<String>>&,SyntheticModuleEvaluationSteps);
  Maybe<bool> SetSyntheticModuleExport(Isolate*,Local<String>,Local<Value>);
  std::pair<LocalVector<Module>,LocalVector<Message>> GetStalledTopLevelAwaitMessages(Isolate*);
};
class UnboundScript : public Data {
 public:using Data::Data;
  bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
  Local<Script> BindToCurrentContext();int ScriptId()const;int GetId()const{return ScriptId();}
  Local<Value> GetScriptName();Local<Value> GetSourceURL();Local<Value> GetSourceMappingURL();
  int GetLineNumber(int=0);int GetColumnNumber(int=0);static const int kNoScriptId=0;
};
class Script : public Data {
 public:using Data::Data;
  bool IsValue()const override{return false;}bool IsPrivate()const override{return false;}
  static MaybeLocal<Script> Compile(Local<Context>,Local<String>,ScriptOrigin* = nullptr);
  MaybeLocal<Value> Run(Local<Context>);MaybeLocal<Value> Run(Local<Context>,Local<Data>);
  Local<UnboundScript> GetUnboundScript();int ScriptId()const;Local<Value> GetResourceName();
};
class ScriptCompiler {
 public:
  struct CachedData {
    enum BufferPolicy{BufferNotOwned,BufferOwned};
    enum CompatibilityCheckResult{kSuccess=0,kMagicNumberMismatch=1,kVersionMismatch=2,
      kSourceMismatch=3,kFlagsMismatch=5,kChecksumMismatch=6,kInvalidHeader=7,kLengthMismatch=8,
      kReadOnlySnapshotChecksumMismatch=9,kLast=kReadOnlySnapshotChecksumMismatch};
    CachedData();CachedData(const uint8_t*,int,BufferPolicy=BufferNotOwned);~CachedData();
    CompatibilityCheckResult CompatibilityCheck(Isolate*);
    const uint8_t* data;int length;bool rejected;BufferPolicy buffer_policy;
    CachedData(const CachedData&)=delete;CachedData& operator=(const CachedData&)=delete;
  };
  enum CompileOptions{kNoCompileOptions=0,kConsumeCodeCache=1,kEagerCompile=2,
    kProduceCompileHints=4,kConsumeCompileHints=8,kFollowCompileHintsMagicComment=16,
    kFollowCompileHintsPerFunctionMagicComment=32};
  enum NoCacheReason{kNoCacheNoReason=0};
  enum class InMemoryCacheResult{kNotAttempted,kHit,kMiss,kPartial};
  struct CompilationDetails {
    InMemoryCacheResult in_memory_cache_result=InMemoryCacheResult::kNotAttempted;
    static constexpr int64_t kTimeNotMeasured=-1;
    int64_t foreground_time_in_microseconds=kTimeNotMeasured,background_time_in_microseconds=kTimeNotMeasured;
  };
  class Source {
    Local<String> source_;ScriptOrigin origin_;std::unique_ptr<CachedData> cache_;
    CompilationDetails details_;
   public:
    Source(Local<String> text,const ScriptOrigin& origin,CachedData* cache=nullptr)
      :source_(text),origin_(origin),cache_(cache){}
    explicit Source(Local<String> text,CachedData* cache=nullptr)
      :Source(text,ScriptOrigin(Local<Value>()),cache){}
    const CachedData* GetCachedData()const{return cache_.get();}
    CachedData* NativeCachedData(){return cache_.get();}
    const CompilationDetails& GetCompilationDetails()const{return details_;}
    const ScriptOriginOptions& GetResourceOptions()const{return origin_.NativeResourceOptions();}
    Local<String> NativeSourceString()const{return source_;}
    const ScriptOrigin& NativeOrigin()const{return origin_;}
  };
  static MaybeLocal<Module> CompileModule(Isolate*,Source*,CompileOptions=kNoCompileOptions,NoCacheReason=kNoCacheNoReason);
  static MaybeLocal<UnboundScript> CompileUnboundScript(Isolate*,Source*,CompileOptions=kNoCompileOptions,NoCacheReason=kNoCacheNoReason);
  static MaybeLocal<Script> Compile(Local<Context>,Source*,CompileOptions=kNoCompileOptions,NoCacheReason=kNoCacheNoReason);
  static MaybeLocal<Function> CompileFunction(Local<Context>,Source*,size_t=0,Local<String>* = nullptr,
      size_t=0,Local<Object>* = nullptr,CompileOptions=kNoCompileOptions,NoCacheReason=kNoCacheNoReason);
  static uint32_t CachedDataVersionTag();
  static CachedData* CreateCodeCache(Local<UnboundScript>);
  static CachedData* CreateCodeCache(Local<UnboundModuleScript>);
  static CachedData* CreateCodeCacheForFunction(Local<Function>);
};
}
#endif
