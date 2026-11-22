#ifndef KANDELO_ENGINE_CODE_CACHE_CODECS_INL_H
#define KANDELO_ENGINE_CODE_CACHE_CODECS_INL_H

namespace v8 {
namespace {
ScriptCompiler::CachedData* EncodeNativeCodeCache(Frame& frame,JS::HandleObject record){
  JSAutoRealm home(frame.cx,record);auto& info=ScriptInfoFor(record);
  if(!info.stencil)return nullptr;
  static_assert(kandelo::node::cache::kHeaderSize%JS::BytecodeOffsetAlignment==0);
  static_assert(sizeof(kandelo::node::cache::kIdentity)==65);
  JS::TranscodeBuffer payload;
  // This is the engine's actual compiled-data serializer. Failure never
  // substitutes an empty successful cache, and pending OOM/stop stays intact.
  if(JS::EncodeStencil(frame.cx,info.stencil,payload)!=JS::TranscodeResult::Ok)return nullptr;
  constexpr size_t header=kandelo::node::cache::kHeaderSize;
  if(payload.empty()||payload.length()>size_t(INT_MAX)-header)return nullptr;
  try {
    const size_t size=header+payload.length();auto bytes=std::make_unique<uint8_t[]>(size);
    std::memcpy(bytes.get()+header,payload.begin(),payload.length());
    kandelo::node::cache::Write(bytes.get(),size,info.cache,kandelo::node::cache::kIdentity,
        kandelo::node::cache::kVersionTag);
    auto result=std::make_unique<ScriptCompiler::CachedData>(bytes.get(),int(size),
        ScriptCompiler::CachedData::BufferOwned);
    bytes.release();return result.release();
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(frame.cx);return nullptr;}
}
}
uint32_t ScriptCompiler::CachedDataVersionTag(){return kandelo::node::cache::kVersionTag;}
ScriptCompiler::CachedData::CompatibilityCheckResult ScriptCompiler::CachedData::CompatibilityCheck(Isolate* isolate){
  (void)Current(isolate);
  using Check=kandelo::node::cache::Check;
  switch(kandelo::node::cache::Validate(data,size_t(length),kandelo::node::cache::kIdentity,
      kandelo::node::cache::kVersionTag)){
    case Check::Success:return kSuccess;
    case Check::Magic:return kMagicNumberMismatch;
    case Check::Version:return kVersionMismatch;
    case Check::Flags:return kFlagsMismatch;
    case Check::Checksum:return kChecksumMismatch;
    case Check::Header:return kInvalidHeader;
    case Check::Length:return kLengthMismatch;
  }
  Crash("Invalid native code-cache check result");
}
ScriptCompiler::CachedData* ScriptCompiler::CreateCodeCache(Local<UnboundScript> script){
  auto& frame=*Frame::current;NativeNoScriptEntry entry(frame);if(entry.Terminated())return nullptr;
  JS::RootedObject record(frame.cx,ScriptRecord(*script.operator->()));
  CHECK(ScriptInfoFor(record).cache.kind==kandelo::node::cache::Kind::Script);
  return EncodeNativeCodeCache(frame,record);
}
ScriptCompiler::CachedData* ScriptCompiler::CreateCodeCache(Local<UnboundModuleScript> script){
  auto& frame=*Frame::current;NativeNoScriptEntry entry(frame);if(entry.Terminated())return nullptr;
  JS::RootedObject record(frame.cx,ScriptRecord(*script.operator->()));
  if(!ScriptInfoFor(record).stencil)return nullptr;
  CHECK(ScriptInfoFor(record).cache.kind==kandelo::node::cache::Kind::Module);
  return EncodeNativeCodeCache(frame,record);
}
ScriptCompiler::CachedData* ScriptCompiler::CreateCodeCacheForFunction(Local<Function> input){
  auto& frame=*Frame::current;NativeNoScriptEntry entry(frame);if(entry.Terminated())return nullptr;
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,Input(input)));if(!object)return nullptr;
  JSAutoRealm home(frame.cx,object);JS::RootedFunction function(frame.cx,JS_GetObjectFunction(object));
  if(!function||!function->hasBaseScript())return nullptr;
  JS::RootedScript script(frame.cx,JS_GetFunctionScript(frame.cx,function));if(!script)return nullptr;
  JS::RootedValue privateValue(frame.cx,JS::GetScriptPrivate(script));
  if(!privateValue.isObject()||JS::GetClass(&privateValue.toObject())!=&nativeScriptClass)return nullptr;
  JS::RootedObject record(frame.cx,&privateValue.toObject());auto& info=ScriptInfoFor(record);
  if(!info.stencil||info.cache.kind!=kandelo::node::cache::Kind::Function)return nullptr;
  // Nested functions share source-private metadata. Only a function whose real
  // engine extent matches the retained standalone function may use its cache.
  const auto& extent=info.stencil->getInitial()->scriptExtra[js::frontend::CompilationStencil::TopLevelIndex].extent;
  if(script->sourceStart()!=extent.sourceStart||script->sourceEnd()!=extent.sourceEnd)return nullptr;
  return EncodeNativeCodeCache(frame,record);
}
}
#endif
