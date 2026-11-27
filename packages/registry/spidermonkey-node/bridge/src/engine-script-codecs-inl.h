#ifndef KANDELO_ENGINE_SCRIPT_CODECS_INL_H
#define KANDELO_ENGINE_SCRIPT_CODECS_INL_H

// Engine records and transport only. Resolution, format selection, module
// caches, bootstrap and public vm policy remain in their original Node owners.
namespace v8 {
namespace {
enum NativeScriptSlot {ScriptInfo,ScriptText,ScriptResource,ScriptMap,ScriptHost,
  ScriptOriginal,ScriptBound,ScriptSlots};
struct NativeScriptInfo {
  RefPtr<JS::Stencil> stencil;
  kandelo::node::cache::Description cache;
  Data::RootFactory hostFactory=nullptr;
  Module::SyntheticModuleEvaluationSteps evaluation=nullptr;
  ScriptOriginOptions options;
  int line=0,column=0,identity=0;
};
void FinalizeNativeScript(JS::GCContext*,JSObject* object){
  const auto info=JS::GetReservedSlot(object,ScriptInfo);
  if(!info.isUndefined())delete static_cast<NativeScriptInfo*>(info.toPrivate());
}
const JSClassOps nativeScriptOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeNativeScript};
const JSClass nativeScriptClass={"NodeEngineScript",
  JSCLASS_HAS_RESERVED_SLOTS(ScriptSlots)|JSCLASS_FOREGROUND_FINALIZE,&nativeScriptOps};
const JSClass nativeRequestClass={"NodeEngineModuleRequest",JSCLASS_HAS_RESERVED_SLOTS(5)};
const JSClass nativeLoadResultClass={"NodeEngineLoadResult",JSCLASS_HAS_RESERVED_SLOTS(2)};
NativeScriptInfo& ScriptInfoFor(JSObject* record){
  CHECK(JS::GetClass(record)==&nativeScriptClass);
  return *static_cast<NativeScriptInfo*>(JS::GetReservedSlot(record,ScriptInfo).toPrivate());
}
JSObject* ScriptRecord(const Data& data){
  CHECK(data.cell().context==js::TlsContext.get()&&data.cell().value.isObject());
  auto* object=js::UncheckedUnwrapWithoutExpose(&data.cell().value.toObject());
  CHECK(JS::GetClass(object)==&nativeScriptClass);return object;
}
js::ModuleObject* ModuleObjectFor(const Data& data){
  CHECK(data.cell().context==js::TlsContext.get()&&data.cell().value.isObject());
  auto* object=js::UncheckedUnwrapWithoutExpose(&data.cell().value.toObject());
  CHECK(object->is<js::ModuleObject>());return &object->as<js::ModuleObject>();
}
JSObject* ModuleOrigin(js::ModuleObject* module){
  auto value=JS::GetModulePrivate(module);
  CHECK(value.isObject()&&JS::GetClass(&value.toObject())==&nativeScriptClass);
  return &value.toObject();
}
JSObject* RequestRecord(const Data& data){
  CHECK(data.cell().context==js::TlsContext.get()&&data.cell().value.isObject());
  auto* object=js::UncheckedUnwrapWithoutExpose(&data.cell().value.toObject());
  CHECK(JS::GetClass(object)==&nativeRequestClass);return object;
}
Local<Value> NativeScriptValue(JSObject* record,NativeScriptSlot slot){
  auto& frame=*Frame::current;JS::RootedValue value(frame.cx,JS::GetReservedSlot(record,slot));
  if(!JS_WrapValue(frame.cx,&value))return {};return frame.OwnValue(value);
}
js::ScriptSource* StencilSource(JSObject* record){
  auto& info=ScriptInfoFor(record);CHECK(info.stencil);
  return info.stencil->getInitial()->source.get();
}
bool IsNativeFunctionBodyScript(JSScript* script){
  auto value=JS::GetScriptPrivate(script);
  if(!value.isObject())return false;
  auto* object=js::UncheckedUnwrapWithoutExpose(&value.toObject());
  if(JS::GetClass(object)!=&nativeScriptClass)return false;
  const auto& info=ScriptInfoFor(object);
  return info.stencil&&info.stencil->getInitial()->source.get()==script->scriptSource()&&
      info.cache.kind==kandelo::node::cache::Kind::Function;
}

JSObject* NewScriptRecord(Frame& frame,const ScriptCompiler::Source& source,
    RefPtr<JS::Stencil> stencil,ScriptCompiler::CompileOptions flags=ScriptCompiler::kNoCompileOptions){
  try {
    auto info=std::make_unique<NativeScriptInfo>();info->stencil=std::move(stencil);
    auto& origin=source.NativeOrigin();info->line=origin.LineOffset();info->column=origin.ColumnOffset();
    info->options=origin.Options();
    info->cache.kind=origin.Options().IsModule()?kandelo::node::cache::Kind::Module:kandelo::node::cache::Kind::Script;
    info->cache.flags=uint32_t(flags)&uint32_t(ScriptCompiler::kEagerCompile);
    info->cache.originFlags=origin.Options().Flags();
    do {info->identity=int(++frame.state->nextModuleIdentityHash&INT_MAX);}while(!info->identity);
    JS::RootedObject record(frame.cx,JS_NewObjectWithGivenProto(frame.cx,&nativeScriptClass,nullptr));
    if(!record)return nullptr;
    JS::RootedValue text(frame.cx,Input(source.NativeSourceString()));
    if(!JS_WrapValue(frame.cx,&text))return nullptr;
    JS::RootedString sourceText(frame.cx,text.toString());JS::AutoStableStringChars sourceChars(frame.cx);
    if(!sourceChars.initTwoByte(frame.cx,sourceText))return nullptr;
    kandelo::node::cache::Fingerprint fingerprint;
    fingerprint.Text(sourceChars.twoByteChars(),JS_GetStringLength(sourceText));info->cache.source=fingerprint.value;
    JS::SetReservedSlot(record,ScriptText,text);
    for(auto item:{std::pair{ScriptResource,origin.ResourceName()},std::pair{ScriptMap,origin.SourceMapUrl()}}){
      JS::RootedValue value(frame.cx,item.second.IsEmpty()?JS::UndefinedValue():Input(item.second));
      if(!JS_WrapValue(frame.cx,&value))return nullptr;
      JS::SetReservedSlot(record,item.first,value);
    }
    auto host=origin.GetHostDefinedOptions();
    if(!host.IsEmpty()){
      JS::RootedValue value(frame.cx,Input(host));if(!JS_WrapValue(frame.cx,&value))return nullptr;
      JS::SetReservedSlot(record,ScriptHost,value);info->hostFactory=host->RootFactoryForStorage();
    }
    JS::SetReservedSlot(record,ScriptInfo,JS::PrivateValue(info.release()));return record;
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(frame.cx);return nullptr;}
}
JSContext* NativeCompilationContext(JSContext* cx){
  JS::ContextOptionsRef(cx).compileOptions().setSourcePhaseImports(bridge::SourcePhaseImportsEnabled());
  return cx;
}
// Own all storage borrowed by CompileOptions/SourceText across compilation.
// The same origin and source conversion serves scripts, modules and functions.
struct NativeCompilationInput {
  JS::CompileOptions options;
  JS::UniqueChars filename;
  JS::UniqueTwoByteChars mapChars;
  JS::RootedString text;
  JS::AutoStableStringChars chars;
  JS::SourceText<char16_t> input;
  explicit NativeCompilationInput(JSContext* cx):options(NativeCompilationContext(cx)),text(cx),chars(cx){}
  bool init(Frame& frame,ScriptCompiler::Source& source,
      ScriptCompiler::CompileOptions flags,bool module){
  CHECK(!source.NativeSourceString().IsEmpty());
  if(uint32_t(flags)&~uint32_t(ScriptCompiler::kConsumeCodeCache|ScriptCompiler::kEagerCompile)){
    JS_ReportErrorASCII(frame.cx,"Native compiler hint consumption is not connected");return false;
  }
  const auto& origin=source.NativeOrigin();
  if(origin.LineOffset()<0||origin.ColumnOffset()<0){
    JS_ReportErrorASCII(frame.cx,"Native signed compilation-origin mapping is not connected");return false;
  }
  auto name=origin.ResourceName();
  if(!name.IsEmpty()&&!name->IsUndefined()){
    CHECK(name->IsString());JS::RootedValue nameValue(frame.cx,Input(name));
    if(!JS_WrapValue(frame.cx,&nameValue))return false;
    JS::RootedString text(frame.cx,nameValue.toString());
    JS::AutoStableStringChars nameChars(frame.cx);if(!nameChars.initTwoByte(frame.cx,text))return false;
    for(size_t i=0;i<JS_GetStringLength(text);++i)if(!nameChars.twoByteChars()[i]){
      JS_ReportErrorASCII(frame.cx,"Native embedded-NUL compilation resource mapping is not connected");return false;
    }
    filename=JS_EncodeStringToUTF8(frame.cx,text);if(!filename)return false;
  }
  options.setFileAndLine(filename?filename.get():"",uint32_t(origin.LineOffset())+1)
      .setColumn(JS::ColumnNumberOneOrigin(uint32_t(origin.ColumnOffset())+1));
  if(module)options.setModule();
  if(uint32_t(flags)&uint32_t(ScriptCompiler::kEagerCompile))options.setForceFullParse();
  auto map=origin.SourceMapUrl();
  if(!map.IsEmpty()&&map->IsString()){
    JS::RootedValue mapValue(frame.cx,Input(map));if(!JS_WrapValue(frame.cx,&mapValue))return false;
    JS::RootedString value(frame.cx,mapValue.toString());
    if(JS_GetStringLength(value)){
      JS::AutoStableStringChars characters(frame.cx);if(!characters.initTwoByte(frame.cx,value))return false;
      for(size_t index=0;index<JS_GetStringLength(value);++index)if(!characters.twoByteChars()[index]){
        JS_ReportErrorASCII(frame.cx,"Native embedded-NUL source-map mapping is not connected");return false;
      }
      mapChars=JS_CopyStringCharsZ(frame.cx,value);if(!mapChars)return false;
      options.setSourceMapURL(mapChars.get());
    }
  }
  JS::RootedValue sourceValue(frame.cx,Input(source.NativeSourceString()));
  if(!JS_WrapValue(frame.cx,&sourceValue))return false;
  text = sourceValue.toString();
  if(!chars.initTwoByte(frame.cx,text))return false;
  if(!input.init(frame.cx,chars.twoByteChars(),JS_GetStringLength(text),JS::SourceOwnership::Borrowed))return false;
  return true;
  }
};
struct NativeCachedStencil {
  RefPtr<JS::Stencil> stencil;
  bool failed=false;
};
NativeCachedStencil ReadNativeStencilCache(Frame& frame,ScriptCompiler::Source& source,
    NativeCompilationInput& compilation,ScriptCompiler::CompileOptions flags,
    kandelo::node::cache::Kind kind,uint64_t parameters=0,bool nonSyntactic=false){
  using namespace kandelo::node::cache;
  if(!(uint32_t(flags)&uint32_t(ScriptCompiler::kConsumeCodeCache)))return {};
  auto* cache=source.NativeCachedData();CHECK(cache);cache->rejected=false;
  auto reject=[&]()->NativeCachedStencil{cache->rejected=true;return {};};
  if(cache->length<0||Validate(cache->data,size_t(cache->length),kIdentity,kVersionTag)!=Check::Success)return reject();
  Fingerprint text;text.Text(compilation.chars.twoByteChars(),JS_GetStringLength(compilation.text));
  if(Read32(cache->data+80)!=uint32_t(kind)||Read64(cache->data+88)!=text.value||
      Read64(cache->data+96)!=parameters||bool(Read32(cache->data+108))!=nonSyntactic)return reject();
  // Source owns CachedData. Decode from an aligned temporary and explicitly
  // forbid borrowed/pinned output so freeing either input cannot dangle code.
  JS::TranscodeBuffer aligned;
  if(!aligned.append(cache->data+kHeaderSize,size_t(cache->length)-kHeaderSize)){
    JS_ReportOutOfMemory(frame.cx);return {{},true};
  }
  JS::DecodeOptions options(compilation.options);options.borrowBuffer=false;options.usePinnedBytecode=false;
  JS::Stencil* raw=nullptr;
  auto result=JS::DecodeStencil(frame.cx,options,JS::TranscodeRange(aligned.begin(),aligned.length()),&raw);
  RefPtr<JS::Stencil> decoded=already_AddRefed<JS::Stencil>(raw);
  if(result!=JS::TranscodeResult::Ok){
    if(result==JS::TranscodeResult::Throw||JS_IsExceptionPending(frame.cx)||frame.cx->isNativeExecutionTerminating())return {{},true};
    return reject();
  }
  CHECK(decoded&&!JS::StencilIsBorrowed(decoded));
  auto* initial=decoded->getInitial();
  if(initial->scriptData.empty()||initial->isModule()!=(kind==Kind::Module)||
      initial->scriptData[0].isFunction()!=(kind==Kind::Function))return reject();
  decoded=decoded_origin::RebaseDecodedStencilOrigin(frame.cx,decoded.forget(),compilation.options);
  if(!decoded)return {{},true};
  return {std::move(decoded),false};
}
RefPtr<JS::Stencil> CompileNativeStencil(Frame& frame,ScriptCompiler::Source& source,
    ScriptCompiler::CompileOptions flags,bool module){
  NativeCompilationInput compilation(frame.cx);
  if(!compilation.init(frame,source,flags,module))return nullptr;
  auto cache=ReadNativeStencilCache(frame,source,compilation,flags,
      module?kandelo::node::cache::Kind::Module:kandelo::node::cache::Kind::Script);
  if(cache.failed)return nullptr;
  if(cache.stencil)return std::move(cache.stencil);
  RefPtr<JS::Stencil> stencil=module?JS::CompileModuleScriptToStencil(frame.cx,compilation.options,compilation.input)
                     :JS::CompileGlobalScriptToStencil(frame.cx,compilation.options,compilation.input);
  if(!stencil)RecordNativeCompilationFailure(frame,source);
  return stencil;
}
Local<Value> SourceComment(JSObject* record,bool sourceMap){
  auto& frame=*Frame::current;auto* source=StencilSource(record);
  const char16_t* text=sourceMap?(source->hasSourceMapURL()?source->sourceMapURL():nullptr)
                              :(source->hasDisplayURL()?source->displayURL():nullptr);
  if(!text)return Undefined(&frame.state->isolate);
  JS::RootedString string(frame.cx,JS_NewUCStringCopyZ(frame.cx,text));if(!string)return {};
  JS::RootedValue value(frame.cx,JS::StringValue(string));return frame.OwnValue(value);
}
Location NativeSourceLocation(JSObject* record,int offset){
  auto& frame=*Frame::current;CHECK_GE(offset,0);JSAutoRealm home(frame.cx,record);
  JS::RootedString text(frame.cx,JS::GetReservedSlot(record,ScriptText).toString());
  CHECK_LE(size_t(offset),JS_GetStringLength(text));
  JS::AutoStableStringChars chars(frame.cx);CHECK(chars.initTwoByte(frame.cx,text));
  int line=ScriptInfoFor(record).line,column=ScriptInfoFor(record).column;
  for(int index=0;index<offset;++index){
    const char16_t unit=chars.twoByteChars()[index];
    if(unit=='\r'||unit=='\n'||unit==0x2028||unit==0x2029){
      if(unit=='\r'&&index+1<offset&&chars.twoByteChars()[index+1]=='\n')++index;
      ++line;column=0;
    }else ++column;
  }
  return {line,column};
}
bool EvaluateNativeSynthetic(JSContext* cx,JS::HandleObject module,JS::HandleValue privateValue){
  auto state=ReadNativeEngineState(cx);if(!state)return false;
  NativeCallbackEntry entry(*state);JS::RootedObject global(cx,JS::CurrentGlobalOrNull(cx));
  Frame frame(cx,global,state);CHECK(privateValue.isObject());
  auto callback=ScriptInfoFor(&privateValue.toObject()).evaluation;CHECK(callback);
  JS::RootedValue value(cx,JS::ObjectValue(*module));Local<Value> result;
  if(!callback(state->isolate.GetCurrentContext(),frame.Own<Module>(value)).ToLocal(&result))return false;
  // Node's original callback returns its settled Promise. SpiderMonkey owns
  // the genuine module evaluation promise and records callback failures itself.
  return !JS_IsExceptionPending(cx)&&!cx->isNativeExecutionTerminating();
}
struct NativeModuleLoadScope {
  JSContext* cx;Module::ResolveModuleByIndexCallback module;
  Module::ResolveSourceByIndexCallback source;
  Module::ResolveModuleCallback legacyModule=nullptr;
  Module::ResolveSourceCallback legacySource=nullptr;
  NativeModuleLoadScope* previous;
  inline static thread_local NativeModuleLoadScope* current=nullptr;
  NativeModuleLoadScope(JSContext* context,Module::ResolveModuleByIndexCallback m,Module::ResolveSourceByIndexCallback s)
      :cx(context),module(m),source(s),previous(current){current=this;}
  NativeModuleLoadScope(JSContext* context,Module::ResolveModuleCallback m,Module::ResolveSourceCallback s)
      :cx(context),module(nullptr),source(nullptr),legacyModule(m),legacySource(s),previous(current){current=this;}
  ~NativeModuleLoadScope(){CHECK(current==this);current=previous;}
};
bool NativeModuleLoad(JSContext* cx,JS::HandleScript script,JS::HandleObject request,
    JS::HandleValue hostDefined,JS::HandleValue payload,uint32_t line,JS::ColumnNumberOneOrigin column){
  auto state=ReadNativeEngineState(cx);if(!state)return false;
  JS::RootedObject referrer(cx,script&&script->isModule()?JS::GetModuleObject(script):nullptr);
  JS::RootedValue origin(cx,referrer?JS::GetModulePrivate(referrer):JS::UndefinedValue());
  if(!origin.isObject()||JS::GetClass(&origin.toObject())!=&nativeScriptClass){
    if(state->previousModuleLoad)return state->previousModuleLoad(cx,script,request,hostDefined,payload,line,column);
    JS_ReportErrorASCII(cx,"Module request has no native loader owner");return false;
  }
  auto* scope=NativeModuleLoadScope::current;
  if(!scope){JS_ReportErrorASCII(cx,"Native dynamic module loading is not connected");return false;}
  CHECK(scope->cx==cx&&(scope->module||scope->legacyModule));
  auto& requests=referrer->as<js::ModuleObject>();size_t index=0;
  for(;index<requests.requestedModules().size();++index)
    if(requests.requestedModules()[index].moduleRequest()==request)break;
  CHECK_LT(index,requests.requestedModules().size());
  NativeCallbackEntry entry(*state);JS::RootedObject global(cx,JS::CurrentGlobalOrNull(cx));Frame frame(cx,global,state);
  JS::RootedValue referrerValue(cx,JS::ObjectValue(*referrer));
  auto nativeReferrer=frame.Own<Module>(referrerValue);
  if(JS::ModuleRequestIsSourcePhase(cx,request)){
    if(scope->source){
      Local<Object> source;
      if(!scope->source(state->isolate.GetCurrentContext(),index,nativeReferrer).ToLocal(&source))return false;
    }
    JS_ReportErrorASCII(cx,"Guest module-source execution is unavailable in the initial profile");return false;
  }
  Local<Module> resolved;
  if(scope->module){
    if(!scope->module(state->isolate.GetCurrentContext(),index,nativeReferrer).ToLocal(&resolved))return false;
  }else{
    auto requestData=nativeReferrer->GetModuleRequests()->Get(int(index)).As<ModuleRequest>();
    auto attributes=requestData->GetImportAttributes();if(attributes.IsEmpty())return false;
    if(!scope->legacyModule(state->isolate.GetCurrentContext(),requestData->GetSpecifier(),attributes,nativeReferrer).ToLocal(&resolved))return false;
  }
  JS::RootedObject result(cx,ModuleObjectFor(*resolved.operator->()));
  return JS::FinishLoadingImportedModule(cx,script,request,payload,result,false);
}
bool NativeModuleLoaded(JSContext*,JS::HandleValue result){
  CHECK(result.isObject());JS::SetReservedSlot(&result.toObject(),0,JS::Int32Value(1));return true;
}
bool NativeModuleRejected(JSContext*,JS::HandleValue result,JS::HandleValue error){
  CHECK(result.isObject());JS::SetReservedSlot(&result.toObject(),0,JS::Int32Value(2));
  JS::SetReservedSlot(&result.toObject(),1,error);return true;
}
bool OwnsNativeScriptPrivate(JS::HandleValue input){
  if(input.isObject()&&JS::GetClass(js::UncheckedUnwrapWithoutExpose(&input.toObject()))==&nativeScriptClass)return true;
  auto found=nativeEngineOwners.find(js::TlsContext.get());
  return found!=nativeEngineOwners.end()&&found->second->previousDynamicOwner&&found->second->previousDynamicOwner(input);
}
bool PopulateNativeImportMeta(JSContext* cx,JS::HandleObject module,JS::HandleObject meta){
  auto state=ReadNativeEngineState(cx);if(!state)return false;
  JS::RootedValue origin(cx,JS::GetModulePrivate(module));
  if(!origin.isObject()||JS::GetClass(&origin.toObject())!=&nativeScriptClass)
    return !state->previousModuleMetadata||state->previousModuleMetadata(cx,module,meta);
  if(!state->initializeImportMeta){JS_ReportErrorASCII(cx,"Native import.meta callback is not installed");return false;}
  NativeCallbackEntry entry(*state);JS::RootedObject global(cx,JS::CurrentGlobalOrNull(cx));Frame frame(cx,global,state);
  JS::RootedValue moduleValue(cx,JS::ObjectValue(*module)),metaValue(cx,JS::ObjectValue(*meta));
  state->initializeImportMeta(state->isolate.GetCurrentContext(),frame.Own<Module>(moduleValue),frame.Own<Object>(metaValue));
  return !JS_IsExceptionPending(cx)&&!cx->isNativeExecutionTerminating();
}
Local<Data> NativeHostDefinedOptions(Frame& frame,JS::HandleObject record){
  auto& info=ScriptInfoFor(record);
  if(!info.hostFactory){
    JS::RootedObject array(frame.cx,NewNativeDataArray(frame,0));if(!array)return {};
    JSAutoRealm home(frame.cx,record);JS::RootedValue value(frame.cx,JS::ObjectValue(*array));
    if(!JS_WrapValue(frame.cx,&value))return {};
    JS::SetReservedSlot(record,ScriptHost,value);info.hostFactory=&CloneWrapper<PrimitiveArray>;
  }
  JS::RootedValue value(frame.cx,JS::GetReservedSlot(record,ScriptHost));
  if(value.isObject()){
    JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,value));if(!object)return {};value.setObject(*object);
  }
  auto root=info.hostFactory(&frame.state->isolate,std::make_unique<Cell>(frame.cx,value));auto* pointer=root.get();
  frame.roots.push_back(std::move(root));return Local<Data>(pointer);
}
Local<FixedArray> DynamicImportAttributes(Frame& frame,JS::HandleObject request){
  JSAutoRealm home(frame.cx,request);
  CHECK_LE(request->as<js::ModuleRequestObject>().attributes().length(),size_t(INT_MAX/2));
  const auto count=request->as<js::ModuleRequestObject>().attributes().length();
  JS::RootedObject array(frame.cx,NewNativeDataArray(frame,int(count*2)));if(!array)return {};
  for(size_t index=0;index<count;++index){
    // Reacquire through the rooted request after allocations; atom/string
    // pointers are rooted before value construction can trigger collection.
    const auto& attribute=request->as<js::ModuleRequestObject>().attributes()[index];
    JS::RootedValue key(frame.cx,JS::StringValue(attribute.key()));
    JS::RootedValue value(frame.cx,JS::StringValue(attribute.value()));
    if(!WriteNativeDataArray(frame,array,int(index*2),frame.Own<String>(key))||
       !WriteNativeDataArray(frame,array,int(index*2+1),frame.Own<String>(value)))return {};
  }
  JS::RootedValue value(frame.cx,JS::ObjectValue(*array));return frame.Own<FixedArray>(value);
}
bool ImportNativeModuleValue(JSContext* cx,JS::HandleValue privateValue,JS::HandleObject request,JS::HandleObject promise){
  auto state=ReadNativeEngineState(cx);if(!state)return false;
  JS::RootedObject record(cx,privateValue.isObject()?UnwrapObject(cx,privateValue):nullptr);
  if(!record||JS::GetClass(record)!=&nativeScriptClass){
    CHECK(state->previousDynamicImport);return state->previousDynamicImport(cx,privateValue,request,promise);
  }
  NativeCallbackEntry entry(*state);JS::RootedObject global(cx,JS::CurrentGlobalOrNull(cx));Frame frame(cx,global,state);
  auto options=NativeHostDefinedOptions(frame,record);if(options.IsEmpty())return false;
  auto attributes=DynamicImportAttributes(frame,request);if(attributes.IsEmpty())return false;
  JS::RootedString string(cx,JS::GetModuleRequestSpecifier(cx,request));if(!string)return false;
  JS::RootedValue specifier(cx,JS::StringValue(string));auto name=frame.Own<String>(specifier);
  auto resource=NativeScriptValue(record,ScriptResource);if(resource.IsEmpty())return false;
  const auto phase=JS::ModuleRequestIsSourcePhase(cx,request)?ModuleImportPhase::kSource:ModuleImportPhase::kEvaluation;
  MaybeLocal<Promise> result;
  if(phase==ModuleImportPhase::kSource&&state->importModuleWithPhaseDynamically)
    result=state->importModuleWithPhaseDynamically(state->isolate.GetCurrentContext(),options,resource,name,phase,attributes);
  else if(phase==ModuleImportPhase::kEvaluation&&state->importModuleDynamically)
    result=state->importModuleDynamically(state->isolate.GetCurrentContext(),options,resource,name,attributes);
  else {JS_ReportErrorASCII(cx,"Native dynamic import callback is not installed for this phase");return false;}
  Local<Promise> returned;if(!result.ToLocal(&returned))return false;
  JS::RootedValue value(cx,Input(returned));if(!JS_WrapValue(cx,&value))return false;
  return JS::FinishDynamicModuleImportWithValue(cx,value,promise);
}
void InstallNativeModuleLoad(State& state){
  if(state.moduleLoadHookInstalled)return;
  auto* runtime=JS_GetRuntime(state.cx);
  state.previousModuleLoad=JS::GetModuleLoadHook(runtime);
  state.previousModuleMetadata=JS::GetModuleMetadataHook(runtime);
  state.previousDynamicOwner=runtime->moduleDynamicImportValueOwner.ref();
  state.previousDynamicImport=runtime->moduleDynamicImportValueHook.ref();
  JS::SetModuleLoadHook(runtime,NativeModuleLoad);JS::SetModuleMetadataHook(runtime,PopulateNativeImportMeta);
  JS::SetModuleDynamicImportValueHook(runtime,OwnsNativeScriptPrivate,ImportNativeModuleValue);
  state.moduleLoadHookInstalled=true;
}
}
static void RestoreNativeModuleHooks(State& state){
  if(!state.moduleLoadHookInstalled)return;
  CHECK(!NativeModuleLoadScope::current);
  CHECK(JS::GetModuleLoadHook(JS_GetRuntime(state.cx))==NativeModuleLoad);
  auto* runtime=JS_GetRuntime(state.cx);
  CHECK(JS::GetModuleMetadataHook(runtime)==PopulateNativeImportMeta);
  CHECK(runtime->moduleDynamicImportValueOwner.ref()==OwnsNativeScriptPrivate);
  CHECK(runtime->moduleDynamicImportValueHook.ref()==ImportNativeModuleValue);
  JS::SetModuleLoadHook(runtime,state.previousModuleLoad);JS::SetModuleMetadataHook(runtime,state.previousModuleMetadata);
  JS::SetModuleDynamicImportValueHook(runtime,state.previousDynamicOwner,state.previousDynamicImport);
  state.previousModuleLoad=nullptr;state.previousModuleMetadata=nullptr;
  state.previousDynamicOwner=nullptr;state.previousDynamicImport=nullptr;
  state.initializeImportMeta=nullptr;state.importModuleDynamically=nullptr;state.importModuleWithPhaseDynamically=nullptr;
  state.moduleLoadHookInstalled=false;
}
void Isolate::SetHostInitializeImportMetaObjectCallback(HostInitializeImportMetaObjectCallback callback){
  auto state=owner.lock();CHECK(state&&state->cx==js::TlsContext.get());state->AssertForeground();
  state->initializeImportMeta=callback;InstallNativeModuleLoad(*state);
}
void Isolate::SetHostImportModuleDynamicallyCallback(HostImportModuleDynamicallyCallback callback){
  auto state=owner.lock();CHECK(state&&state->cx==js::TlsContext.get());state->AssertForeground();
  state->importModuleDynamically=callback;InstallNativeModuleLoad(*state);
}
void Isolate::SetHostImportModuleWithPhaseDynamicallyCallback(HostImportModuleWithPhaseDynamicallyCallback callback){
  auto state=owner.lock();CHECK(state&&state->cx==js::TlsContext.get());state->AssertForeground();
  state->importModuleWithPhaseDynamically=callback;InstallNativeModuleLoad(*state);
}
ScriptCompiler::CachedData::CachedData():CachedData(nullptr,0){}
ScriptCompiler::CachedData::CachedData(const uint8_t* bytes,int count,BufferPolicy policy)
  :data(bytes),length(count),rejected(false),buffer_policy(policy){CHECK_GE(length,0);CHECK(data||!length);}
ScriptCompiler::CachedData::~CachedData(){if(buffer_policy==BufferOwned)delete[] data;}
bool Data::IsModule()const{
  if(!cell().value.isObject())return false;CHECK(cell().context==js::TlsContext.get());
  return js::UncheckedUnwrapWithoutExpose(&cell().value.toObject())->is<js::ModuleObject>();
}
bool Data::IsModuleRequest()const{
  if(!cell().value.isObject())return false;CHECK(cell().context==js::TlsContext.get());
  return JS::GetClass(js::UncheckedUnwrapWithoutExpose(&cell().value.toObject()))==&nativeRequestClass;
}
MaybeLocal<Module> ScriptCompiler::CompileModule(Isolate* isolate,Source* source,CompileOptions flags,NoCacheReason){
  auto& frame=Current(isolate);NativeNoScriptEntry entry(frame);if(entry.Terminated())return {};
  CHECK(source->GetResourceOptions().IsModule());
  CHECK(JS::CurrentGlobalOrNull(frame.cx));auto stencil=CompileNativeStencil(frame,*source,flags,true);if(!stencil)return {};
  JS::RootedObject record(frame.cx,NewScriptRecord(frame,*source,stencil,flags));if(!record)return {};
  JS::RootedObject module(frame.cx,JS::InstantiateModuleStencil(frame.cx,JS::InstantiateOptions(),stencil));if(!module)return {};
  JS::SetModulePrivate(module,JS::ObjectValue(*record));InstallNativeModuleLoad(*frame.state);
  JS::RootedValue value(frame.cx,JS::ObjectValue(*module));return frame.Own<Module>(value);
}
Module::Status Module::GetStatus()const{
  JS::AutoCheckCannotGC noGc;auto* module=ModuleObjectFor(*this);
  if(module->hadEvaluationError())return kErrored;
  switch(module->status()){
    case js::ModuleStatus::New:case js::ModuleStatus::Unlinked:return kUninstantiated;
    case js::ModuleStatus::Linking:return kInstantiating;
    case js::ModuleStatus::Linked:return kInstantiated;
    case js::ModuleStatus::Evaluating:return kEvaluating;
    case js::ModuleStatus::EvaluatingAsync:case js::ModuleStatus::Evaluated:return kEvaluated;
    default:Crash("Invalid engine module status");
  }
}
Local<Value> Module::GetException()const{
  auto& frame=*Frame::current;JS::Rooted<js::ModuleObject*> module(frame.cx,ModuleObjectFor(*this));CHECK(module->hadEvaluationError());
  JS::RootedValue error(frame.cx,module->evaluationError());if(!JS_WrapValue(frame.cx,&error))return {};return frame.OwnValue(error);
}
Local<Value> Module::GetResourceName()const{return NativeScriptValue(ModuleOrigin(ModuleObjectFor(*this)),ScriptResource);}
int Module::GetIdentityHash()const{JS::AutoCheckCannotGC noGc;return ScriptInfoFor(ModuleOrigin(ModuleObjectFor(*this))).identity;}
bool Module::IsSourceTextModule()const{return ModuleObjectFor(*this)->hasCyclicModuleFields();}
bool Module::IsSyntheticModule()const{return ModuleObjectFor(*this)->hasSyntheticModuleFields();}
bool Module::HasTopLevelAwait()const{auto* module=ModuleObjectFor(*this);return module->hasCyclicModuleFields()&&module->hasTopLevelAwait();}
int Module::ScriptId()const{auto* module=ModuleObjectFor(*this);CHECK(IsSourceTextModule());return int(module->scriptSourceObject()->source()->id());}
Local<UnboundModuleScript> Module::GetUnboundModuleScript(){
  CHECK(IsSourceTextModule()&&GetStatus()<kEvaluating);auto& frame=*Frame::current;
  JS::RootedValue value(frame.cx,JS::ObjectValue(*ModuleOrigin(ModuleObjectFor(*this))));return frame.Own<UnboundModuleScript>(value);
}
Local<FixedArray> Module::GetModuleRequests()const{
  auto& frame=*Frame::current;JS::Rooted<js::ModuleObject*> module(frame.cx,ModuleObjectFor(*this));
  size_t count=module->hasCyclicModuleFields()?module->requestedModules().size():0;CHECK_LE(count,size_t(INT_MAX));
  JS::RootedObject output(frame.cx,NewNativeDataArray(frame,int(count)));if(!output)return {};
  JS::RootedObject origin(frame.cx,ModuleOrigin(module));JSAutoRealm home(frame.cx,origin);
  for(size_t index=0;index<count;++index){
    JS::RootedObject request(frame.cx,module->requestedModules()[index].moduleRequest());
    const auto line=module->requestedModules()[index].lineNumber();
    const auto column=module->requestedModules()[index].columnNumber().oneOriginValue();
    JS::RootedObject record(frame.cx,JS_NewObjectWithGivenProto(frame.cx,&nativeRequestClass,nullptr));if(!record)return {};
    JS::SetReservedSlot(record,0,JS::ObjectValue(*request));JS::SetReservedSlot(record,1,JS::ObjectValue(*origin));
    JS::SetReservedSlot(record,2,JS::DoubleValue(line));JS::SetReservedSlot(record,3,JS::DoubleValue(column));
    const auto& metadata=*ScriptInfoFor(origin).stencil->getInitial()->moduleMetadata;
    CHECK_LT(index,metadata.requestedModules.length());
    JS::SetReservedSlot(record,4,JS::DoubleValue(metadata.requestedModules[index].moduleRequest.value()));
    JS::RootedValue value(frame.cx,JS::ObjectValue(*record));
    if(!WriteNativeDataArray(frame,output,int(index),frame.Own<ModuleRequest>(value)))return {};
  }
  JS::RootedValue value(frame.cx,JS::ObjectValue(*output));return frame.Own<FixedArray>(value);
}
Local<String> ModuleRequest::GetSpecifier()const{
  auto& frame=*Frame::current;JS::RootedObject record(frame.cx,RequestRecord(*this));
  JS::RootedObject request(frame.cx,&JS::GetReservedSlot(record,0).toObject());
  JSAutoRealm home(frame.cx,request);
  JS::RootedString string(frame.cx,JS::GetModuleRequestSpecifier(frame.cx,request));if(!string)return {};
  JS::RootedValue value(frame.cx,JS::StringValue(string));return frame.Own<String>(value);
}
int ModuleRequest::GetSourceOffset()const{
  auto& frame=*Frame::current;JS::RootedObject request(frame.cx,RequestRecord(*this));
  JS::RootedObject origin(frame.cx,&JS::GetReservedSlot(request,1).toObject());
  auto& info=ScriptInfoFor(origin);JSAutoRealm home(frame.cx,origin);
  int wantedLine=int(JS::GetReservedSlot(request,2).toNumber())-info.line-1;
  int wantedColumn=int(JS::GetReservedSlot(request,3).toNumber())-1;
  if(!wantedLine)wantedColumn-=info.column;
  CHECK_GE(wantedLine,0);CHECK_GE(wantedColumn,0);
  JS::RootedString text(frame.cx,JS::GetReservedSlot(origin,ScriptText).toString());
  JS::AutoStableStringChars chars(frame.cx);CHECK(chars.initTwoByte(frame.cx,text));
  size_t start=0,length=JS_GetStringLength(text);int line=0;
  for(size_t index=0;index<length&&line<wantedLine;++index){
    auto c=chars.twoByteChars()[index];
    if(c=='\r'||c=='\n'||c==0x2028||c==0x2029){
      if(c=='\r'&&index+1<length&&chars.twoByteChars()[index+1]=='\n')++index;
      ++line;start=index+1;
    }
  }
  CHECK_EQ(line,wantedLine);CHECK_LE(start+size_t(wantedColumn),length);
  CHECK_LE(start+size_t(wantedColumn),size_t(INT_MAX));return int(start+size_t(wantedColumn));
}
Local<FixedArray> ModuleRequest::GetImportAttributes()const{
  auto& frame=*Frame::current;JS::RootedObject record(frame.cx,RequestRecord(*this));
  JS::RootedObject request(frame.cx,&JS::GetReservedSlot(record,0).toObject());
  JS::RootedObject origin(frame.cx,&JS::GetReservedSlot(record,1).toObject());
  const auto& metadata=*ScriptInfoFor(origin).stencil->getInitial()->moduleMetadata;
  const size_t requestIndex=size_t(JS::GetReservedSlot(record,4).toNumber());
  CHECK_LT(requestIndex,metadata.moduleRequests.length());
  const auto& nativeAttributes=metadata.moduleRequests[requestIndex].attributes;
  JSAutoRealm home(frame.cx,request);
  CHECK_EQ(request->as<js::ModuleRequestObject>().attributes().length(),nativeAttributes.length());
  CHECK_LE(nativeAttributes.length(),size_t(INT_MAX/3));
  JS::RootedObject array(frame.cx,NewNativeDataArray(frame,int(nativeAttributes.length()*3)));if(!array)return {};
  for(size_t index=0;index<nativeAttributes.length();++index){
    const auto& attribute=request->as<js::ModuleRequestObject>().attributes()[index];
    JS::RootedValue key(frame.cx,JS::StringValue(attribute.key()));
    JS::RootedValue value(frame.cx,JS::StringValue(attribute.value()));
    if(!WriteNativeDataArray(frame,array,int(index*3),frame.Own<String>(key))||
       !WriteNativeDataArray(frame,array,int(index*3+1),frame.Own<String>(value)))return {};
    const auto offset=nativeAttributes[index].sourceOffset;CHECK_LE(offset,uint32_t(INT_MAX));
    if(!WriteNativeDataArray(frame,array,int(index*3+2),Integer::New(&frame.state->isolate,int(offset))))return {};
  }
  JS::RootedValue value(frame.cx,JS::ObjectValue(*array));return frame.Own<FixedArray>(value);
}
ModuleImportPhase ModuleRequest::GetPhase()const{
  auto& request=JS::GetReservedSlot(RequestRecord(*this),0).toObject().as<js::ModuleRequestObject>();
  return request.phase()==js::ImportPhase::Source?ModuleImportPhase::kSource:ModuleImportPhase::kEvaluation;
}
Location Module::SourceOffsetToLocation(int offset)const{return NativeSourceLocation(ModuleOrigin(ModuleObjectFor(*this)),offset);}
namespace {
Maybe<bool> InstantiateNativeModule(const Module& self,Local<Context> context,NativeModuleLoadScope& loading){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);if(entry.Terminated())return {};
  Context::Scope home(context);InstallNativeModuleLoad(*frame.state);
  JS::RootedObject module(frame.cx,ModuleObjectFor(self));
  JS::RootedObject result(frame.cx,JS_NewObjectWithGivenProto(frame.cx,&nativeLoadResultClass,nullptr));if(!result)return {};
  JS::SetReservedSlot(result,0,JS::Int32Value(0));JS::RootedValue host(frame.cx,JS::ObjectValue(*result));
  if(!JS::LoadRequestedModules(frame.cx,module,host,NativeModuleLoaded,NativeModuleRejected))return {};
  const auto status=JS::GetReservedSlot(result,0).toInt32();CHECK(status==1||status==2);
  if(status==2){JS::RootedValue error(frame.cx,JS::GetReservedSlot(result,1));JS_SetPendingException(frame.cx,error);return {};}
  if(!JS::ModuleLink(frame.cx,module))return {};return Just(true);
}
}
Maybe<bool> Module::InstantiateModule(Local<Context> context,ResolveModuleByIndexCallback callback,ResolveSourceByIndexCallback source){
  CHECK(callback);NativeModuleLoadScope loading(Current(context->isolate).cx,callback,source);
  return InstantiateNativeModule(*this,context,loading);
}
Maybe<bool> Module::InstantiateModule(Local<Context> context,ResolveModuleCallback callback,ResolveSourceCallback source){
  CHECK(callback);NativeModuleLoadScope loading(Current(context->isolate).cx,callback,source);
  return InstantiateNativeModule(*this,context,loading);
}

MaybeLocal<Value> Module::Evaluate(Local<Context> context){
  auto& frame=Current(context->isolate);NativeEntry entry(frame,context);if(entry.Terminated())return {};Context::Scope home(context);
  JS::RootedObject module(frame.cx,ModuleObjectFor(*this));JS::RootedValue result(frame.cx);
  if(!JS::ModuleEvaluate(frame.cx,module,&result))return {};return frame.OwnValue(result);
}
Local<Value> Module::GetModuleNamespace(){
  CHECK(GetStatus()>=kInstantiated);auto& frame=*Frame::current;JS::RootedObject module(frame.cx,ModuleObjectFor(*this));
  JSAutoRealm home(frame.cx,module);JS::RootedObject object(frame.cx,JS::GetModuleNamespace(frame.cx,module));if(!object)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*object));if(!JS_WrapValue(frame.cx,&value))return {};return frame.OwnValue(value);
}
Local<Module> Module::CreateSyntheticModule(Isolate* isolate,Local<String> name,
    const MemorySpan<const Local<String>>& exports,SyntheticModuleEvaluationSteps callback){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);CHECK(callback&&JS::CurrentGlobalOrNull(frame.cx));
  ScriptCompiler::Source source(String::Empty(isolate),ScriptOrigin(name));
  JS::RootedObject record(frame.cx,NewScriptRecord(frame,source,nullptr));if(!record)return {};
  ScriptInfoFor(record).evaluation=callback;JS::RootedValue privateValue(frame.cx,JS::ObjectValue(*record));
  JS::RootedValueVector names(frame.cx);if(!names.reserve(exports.size()))return {};
  for(auto name:exports){JS::RootedValue value(frame.cx,Input(name));if(!JS_WrapValue(frame.cx,&value)||!names.append(value))return {};}
  JS::RootedObject module(frame.cx,JS::CreateSyntheticModule(frame.cx,names,EvaluateNativeSynthetic,privateValue));if(!module)return {};
  InstallNativeModuleLoad(*frame.state);JS::RootedValue value(frame.cx,JS::ObjectValue(*module));return frame.Own<Module>(value);
}
Maybe<bool> Module::SetSyntheticModuleExport(Isolate* isolate,Local<String> name,Local<Value> value){
  auto& frame=Current(isolate);CheckNativePrimitiveAccess(frame);JS::RootedObject module(frame.cx,ModuleObjectFor(*this));CHECK(IsSyntheticModule());
  JSAutoRealm home(frame.cx,module);JS::RootedValue nameValue(frame.cx,Input(name)),item(frame.cx,Input(value));
  if(!JS_WrapValue(frame.cx,&nameValue)||!JS_WrapValue(frame.cx,&item))return {};
  JS::RootedString key(frame.cx,nameValue.toString());
  if(!JS::SetSyntheticModuleExport(frame.cx,module,key,item))return {};return Just(true);
}
bool Module::IsGraphAsync()const{
  CHECK(GetStatus()>=kInstantiated);auto& frame=*Frame::current;
  JS::RootedObjectVector pending(frame.cx),seen(frame.cx);CHECK(pending.append(ModuleObjectFor(*this)));
  while(!pending.empty()){
    JS::Rooted<js::ModuleObject*> module(frame.cx,&pending.back()->as<js::ModuleObject>());pending.popBack();
    bool visited=false;for(auto* previous:seen)if(previous==module){visited=true;break;}if(visited)continue;
    CHECK(seen.append(module));if(!module->hasCyclicModuleFields())continue;if(module->hasTopLevelAwait())return true;
    for(const auto& request:module->requestedModules()){
      if(request.moduleRequest()->phase()!=js::ImportPhase::Evaluation)continue;
      auto found=module->loadedModules().lookup(request.moduleRequest());CHECK(found);
      CHECK(pending.append(found->value()));
    }
  }
  return false;
}
namespace {
Local<Message> NativeStalledAwaitMessage(Frame& frame,js::ModuleObject* module){
  JSAutoRealm home(frame.cx,module);
  JS::RootedObject origin(frame.cx,ModuleOrigin(module));
  JS::Rooted<js::AbstractGeneratorObject*> generator(frame.cx,js::GetGeneratorObjectForModule(module));
  CHECK(generator&&generator->isSuspended()&&generator->isAfterAwait());
  JS::RootedScript script(frame.cx,generator->callee().nonLazyScript());
  const auto resume=script->resumeOffsets()[generator->resumeIndex()];
  CHECK_GE(resume,uint32_t(js::JSOpLength_Await));
  auto* pc=script->offsetToPC(resume-js::JSOpLength_Await);CHECK(JSOp(*pc)==JSOp::Await);
  JS::LimitedColumnNumberOneOrigin column;
  const auto line=js::PCToLineNumber(script,pc,&column);
  JS::RootedObject record(frame.cx,JS_NewObjectWithGivenProto(frame.cx,&nativeMessageClass,nullptr));
  if(!record)return {};
  JS::RootedString text(frame.cx,JS_NewStringCopyZ(frame.cx,"Top-level await promise never resolved"));
  if(!text)return {};
  JS::RootedString sourceLine(frame.cx,NativeSourceLine(frame.cx,script->scriptSource(),line));
  if(!sourceLine)return {};
  auto& info=ScriptInfoFor(origin);
  auto resource=JS::GetReservedSlot(origin,ScriptResource);
  JS::SetReservedSlot(record,MessageText,JS::StringValue(text));
  JS::SetReservedSlot(record,MessageResource,resource);
  JS::SetReservedSlot(record,MessageOriginResource,resource);
  JS::SetReservedSlot(record,MessageSourceLine,JS::StringValue(sourceLine));
  JS::SetReservedSlot(record,MessageSourceMap,JS::GetReservedSlot(origin,ScriptMap));
  JS::SetReservedSlot(record,MessageLine,JS::Int32Value(NativeStackNumber(line)));
  const auto start=NativeStackNumber(column.oneOriginValue()-1);
  JS::SetReservedSlot(record,MessageColumn,JS::Int32Value(start));
  CHECK_LT(start,INT_MAX);JS::SetReservedSlot(record,MessageEndColumn,JS::Int32Value(start+1));
  JS::SetReservedSlot(record,MessageOriginLine,JS::Int32Value(info.line));
  JS::SetReservedSlot(record,MessageOriginColumn,JS::Int32Value(info.column));
  JS::SetReservedSlot(record,MessageOriginKnown,JS::BooleanValue(true));
  JS::SetReservedSlot(record,MessageLevel,JS::Int32Value(Isolate::kMessageError));
  JS::RootedValue value(frame.cx,JS::ObjectValue(*record));return frame.Own<Message>(value);
}
}
std::pair<LocalVector<Module>,LocalVector<Message>> Module::GetStalledTopLevelAwaitMessages(Isolate* isolate){
  auto& frame=Current(isolate);frame.state->AssertForeground();CHECK(IsSourceTextModule());
  PreserveNativeFailure preserve(frame.cx);
  try {
  LocalVector<Module> modules(isolate);LocalVector<Message> messages(isolate);
  JS::RootedObjectVector pending(frame.cx),seen(frame.cx),stalled(frame.cx);
  auto require=[&](bool ok){if(!ok)bridge::FatalOutOfMemory(isolate,"Stalled top-level await diagnostics",false);};
  require(pending.append(ModuleObjectFor(*this)));
  while(!pending.empty()){
    JS::Rooted<js::ModuleObject*> module(frame.cx,&pending.back()->as<js::ModuleObject>());pending.popBack();
    bool visited=false;for(auto* previous:seen)if(previous==module){visited=true;break;}if(visited)continue;
    require(seen.append(module));if(!module->hasCyclicModuleFields())continue;
    // Keep upstream's leaf-first rule: a live async evaluation with no pending
    // module dependencies is waiting on its own await. Traverse evaluation
    // imports only, in their original order, and do not recurse into a leaf.
    if(module->asyncEvaluationOrder().isInteger()&&module->pendingAsyncDependencies()==0){
      require(stalled.append(module));continue;
    }
    auto requests=module->requestedModules();
    for(size_t i=requests.size();i>0;--i){
      auto* request=requests[i-1].moduleRequest();if(request->phase()!=js::ImportPhase::Evaluation)continue;
      auto found=module->loadedModules().lookup(request);CHECK(found);
      if(found->value()->hasCyclicModuleFields())require(pending.append(found->value()));
    }
  }
  modules.reserve(stalled.length());messages.reserve(stalled.length());
  for(size_t i=0;i<stalled.length();++i){
    JS::Rooted<js::ModuleObject*> module(frame.cx,&stalled[i]->as<js::ModuleObject>());
    JS::RootedValue value(frame.cx,JS::ObjectValue(*module));modules.push_back(frame.Own<Module>(value));
    auto message=NativeStalledAwaitMessage(frame,module);require(!message.IsEmpty());messages.push_back(message);
  }
  return {std::move(modules),std::move(messages)};
  }catch(const std::bad_alloc&){
    bridge::FatalOutOfMemory(isolate,"Stalled top-level await diagnostics",false);
  }
}
Local<Value> UnboundModuleScript::GetSourceURL(){return SourceComment(ScriptRecord(*this),false);}
Local<Value> UnboundModuleScript::GetSourceMappingURL(){return SourceComment(ScriptRecord(*this),true);}
int UnboundModuleScript::ScriptId()const{return int(StencilSource(ScriptRecord(*this))->id());}
MaybeLocal<UnboundScript> ScriptCompiler::CompileUnboundScript(Isolate* isolate,Source* source,CompileOptions flags,NoCacheReason){
  auto& frame=Current(isolate);NativeNoScriptEntry entry(frame);if(entry.Terminated())return {};
  CHECK(!source->GetResourceOptions().IsModule());
  RefPtr<JS::Stencil> stencil;
  {
    // Parser errors belong to the caller's actual realm and its Error hooks.
    JS::RootedObject realm(frame.cx,NativePrimitiveRealm(frame));if(!realm)return {};
    JSAutoRealm home(frame.cx,realm);
    stencil=CompileNativeStencil(frame,*source,flags,false);if(!stencil)return {};
  }
  // The successful unbound stencil remains realm-neutral. Its engine record
  // stays in private storage rather than keeping the compiling realm alive.
  JS::RootedObject storage(frame.cx,NativeTemplateRealm(frame));if(!storage)return {};
  JSAutoRealm home(frame.cx,storage);
  JS::RootedObject record(frame.cx,NewScriptRecord(frame,*source,stencil,flags));if(!record)return {};
  JS::RootedValue value(frame.cx,JS::ObjectValue(*record));return frame.Own<UnboundScript>(value);
}
Local<Script> UnboundScript::BindToCurrentContext(){
  auto& frame=*Frame::current;NativeNoScriptEntry entry(frame);if(entry.Terminated())return {};
  CHECK(JS::CurrentGlobalOrNull(frame.cx));JS::RootedObject original(frame.cx,ScriptRecord(*this));
  auto& info=ScriptInfoFor(original);CHECK(info.stencil);
  JS::RootedScript script(frame.cx,JS::InstantiateGlobalStencil(frame.cx,JS::InstantiateOptions(),info.stencil));if(!script)return {};
  try {
    auto copy=std::make_unique<NativeScriptInfo>(info);
    JS::RootedObject record(frame.cx,JS_NewObjectWithGivenProto(frame.cx,&nativeScriptClass,nullptr));if(!record)return {};
    for(auto slot:{ScriptText,ScriptResource,ScriptMap,ScriptHost}){
      JS::RootedValue value(frame.cx,JS::GetReservedSlot(original,slot));if(!JS_WrapValue(frame.cx,&value))return {};
      JS::SetReservedSlot(record,slot,value);
    }
    JS::RootedValue unbound(frame.cx,JS::ObjectValue(*original));if(!JS_WrapValue(frame.cx,&unbound))return {};
    JS::SetReservedSlot(record,ScriptOriginal,unbound);
    JS::SetReservedSlot(record,ScriptBound,JS::PrivateGCThingValue(script));
    JS::SetReservedSlot(record,ScriptInfo,JS::PrivateValue(copy.release()));
    JS::SetScriptPrivate(script,JS::ObjectValue(*record));
    JS::RootedValue value(frame.cx,JS::ObjectValue(*record));return frame.Own<Script>(value);
  }catch(const std::bad_alloc&){JS_ReportOutOfMemory(frame.cx);return {};}
}
int UnboundScript::ScriptId()const{return int(StencilSource(ScriptRecord(*this))->id());}
Local<Value> UnboundScript::GetScriptName(){return NativeScriptValue(ScriptRecord(*this),ScriptResource);}
Local<Value> UnboundScript::GetSourceURL(){return SourceComment(ScriptRecord(*this),false);}
Local<Value> UnboundScript::GetSourceMappingURL(){return SourceComment(ScriptRecord(*this),true);}
int UnboundScript::GetLineNumber(int offset){if(offset<0)return -1;return NativeSourceLocation(ScriptRecord(*this),offset).GetLineNumber();}
int UnboundScript::GetColumnNumber(int offset){if(offset<0)return -1;return NativeSourceLocation(ScriptRecord(*this),offset).GetColumnNumber();}
MaybeLocal<Function> ScriptCompiler::CompileFunction(Local<Context> context,Source* source,
    size_t argumentCount,Local<String>* arguments,size_t extensionCount,Local<Object>* extensions,
    CompileOptions flags,NoCacheReason){
  auto& frame=Current(context->isolate);NativeNoScriptEntry entry(frame);if(entry.Terminated())return {};
  Context::Scope home(context);CHECK(source&&!source->GetResourceOptions().IsModule());
  CHECK(arguments||!argumentCount);CHECK(extensions||!extensionCount);
  NativeCompilationInput compilation(frame.cx);
  if(!compilation.init(frame,*source,flags,false))return {};
  JS::RootedValueVector parameters(frame.cx);
  kandelo::node::cache::Fingerprint parameterFingerprint;parameterFingerprint.Word(argumentCount);
  if(!parameters.reserve(argumentCount))return {};
  for(size_t index=0;index<argumentCount;++index){
    CHECK(!arguments[index].IsEmpty());JS::RootedValue value(frame.cx,Input(arguments[index]));
    if(!JS_WrapValue(frame.cx,&value))return {};
    JS::RootedString string(frame.cx,value.toString());JS::AutoStableStringChars chars(frame.cx);
    if(!chars.initTwoByte(frame.cx,string))return {};
    const auto length=JS_GetStringLength(string);const auto* units=chars.twoByteChars();
    // Match the original API's IdentifierName check, including its per-UTF16
    // unit classification and allowance for backslashes. The actual parser
    // still validates escapes, reserved words and the complete parameter list.
    if(!length||(units[0]!='\\'&&!js::unicode::IsIdentifierStart(units[0])))return {};
    for(size_t unit=1;unit<length;++unit)
      if(units[unit]!='\\'&&!js::unicode::IsIdentifierPart(units[unit]))return {};
    parameterFingerprint.Text(units,length);
    if(!parameters.append(value))return {};
  }
  JS::EnvironmentChain environments(frame.cx,JS::SupportUnscopables::No);
  // V8 adds each extension around the preceding one (last wins). SpiderMonkey
  // treats the first vector element as innermost, so reverse the transport.
  for(size_t remaining=extensionCount;remaining>0;){
    const auto index=--remaining;
    CHECK(!extensions[index].IsEmpty());JS::RootedValue value(frame.cx,Input(extensions[index]));
    if(!JS_WrapValue(frame.cx,&value))return {};
    JS::RootedObject object(frame.cx,&value.toObject());
    if(js::IsScriptedProxy(js::UncheckedUnwrapWithoutExpose(object)))return {};
    if(!environments.append(object))return {};
  }
  // The engine creates and parses its own function signature. Parameter values
  // retain their full UTF16 length, including syntax errors and embedded NULs.
  auto cached=ReadNativeStencilCache(frame,*source,compilation,flags,
      kandelo::node::cache::Kind::Function,parameterFingerprint.value,extensionCount!=0);
  if(cached.failed)return {};
  JS::Stencil* raw=nullptr;
  JS::RootedFunction function(frame.cx,JS::CompileFunction(frame.cx,environments,
      compilation.options,nullptr,JS::HandleValueArray(parameters),compilation.input,&raw,cached.stencil));
  RefPtr<JS::Stencil> stencil=already_AddRefed<JS::Stencil>(raw);
  if(!function){RecordNativeCompilationFailure(frame,*source,true);return {};}
  // The bridge script record identifies this native body compilation. Frame
  // capture retains that identity in the shared bridge source registry; the
  // engine keeps compiler offsets but no adapter-only classification flag.
  JS::RootedScript script(frame.cx,JS_GetFunctionScript(frame.cx,function));if(!script)return {};
  JS::RootedObject record(frame.cx,NewScriptRecord(frame,*source,std::move(stencil),flags));if(!record)return {};
  auto& cache=ScriptInfoFor(record).cache;cache.kind=kandelo::node::cache::Kind::Function;
  cache.parameters=parameterFingerprint.value;cache.nonSyntactic=extensionCount!=0;
  JS::SetScriptPrivate(script,JS::ObjectValue(*record));InstallNativeModuleLoad(*frame.state);
  JS::RootedValue value(frame.cx,JS::ObjectValue(*JS_GetFunctionObject(function)));
  return frame.Own<Function>(value);
}
ScriptOrigin Function::GetScriptOrigin()const{
  auto& frame=*Frame::current;NativeNoScriptEntry entry(frame);
  ScriptOrigin empty{Local<Value>()};if(entry.Terminated())return empty;
  JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));if(!object)return empty;
  JSAutoRealm home(frame.cx,object);JS::RootedFunction function(frame.cx,JS_GetObjectFunction(object));
  if(!function||!function->hasBaseScript())return empty;
  JS::RootedScript script(frame.cx,JS_GetFunctionScript(frame.cx,function));if(!script)return empty;
  JS::RootedValue metadata(frame.cx,JS::GetScriptPrivate(script));
  if(!metadata.isObject()||JS::GetClass(&metadata.toObject())!=&nativeScriptClass)return empty;
  JS::RootedObject record(frame.cx,&metadata.toObject());auto& info=ScriptInfoFor(record);
  auto resource=SourceComment(record,false);if(resource.IsEmpty())return empty;
  if(resource->IsUndefined())resource=NativeScriptValue(record,ScriptResource);
  auto map=SourceComment(record,true);if(map.IsEmpty())return empty;
  if(map->IsUndefined())map=NativeScriptValue(record,ScriptMap);
  if(resource.IsEmpty()||map.IsEmpty())return empty;
  return ScriptOrigin(resource,info.line,info.column,info.options.IsSharedCrossOrigin(),
      int(StencilSource(record)->id()),map,info.options.IsOpaque(),info.options.IsWasm(),
      info.options.IsModule(),NativeHostDefinedOptions(frame,record));
}
MaybeLocal<Script> ScriptCompiler::Compile(Local<Context> context,Source* source,CompileOptions flags,NoCacheReason reason){
  auto& frame=Current(context->isolate);NativeNoScriptEntry entry(frame);if(entry.Terminated())return {};Context::Scope home(context);
  Local<UnboundScript> script;if(!CompileUnboundScript(context->isolate,source,flags,reason).ToLocal(&script))return {};
  return script->BindToCurrentContext();
}
MaybeLocal<Script> Script::Compile(Local<Context> context,Local<String> text,ScriptOrigin* origin){
  ScriptOrigin unnamed{Local<Value>()};ScriptCompiler::Source source(text,origin?*origin:unnamed);
  return ScriptCompiler::Compile(context,&source);
}
MaybeLocal<Value> Script::Run(Local<Context> context){return Run(context,{});}
MaybeLocal<Value> Script::Run(Local<Context> context,Local<Data> host){
  auto& frame=Current(context->isolate);JS::RootedObject record(frame.cx,ScriptRecord(*this));
  JS::RootedObject global(frame.cx,JS::GetNonCCWObjectGlobal(record));auto bound=frame.OwnContext(global);
  NativeEntry entry(frame,bound);if(entry.Terminated())return {};Context::Scope home(bound);
  if(!host.IsEmpty()){
    CHECK(host->IsFixedArray());JS::RootedValue value(frame.cx,Input(host));if(!JS_WrapValue(frame.cx,&value))return {};
    JS::SetReservedSlot(record,ScriptHost,value);ScriptInfoFor(record).hostFactory=host->RootFactoryForStorage();
  }
  auto value=JS::GetReservedSlot(record,ScriptBound);CHECK(value.isPrivateGCThing());
  JS::RootedScript script(frame.cx,static_cast<JSScript*>(value.toGCThing()));JS::RootedValue result(frame.cx);
  if(!JS_ExecuteScript(frame.cx,script,&result))return {};return frame.OwnValue(result);
}
Local<UnboundScript> Script::GetUnboundScript(){
  auto& frame=*Frame::current;JS::RootedValue value(frame.cx,JS::GetReservedSlot(ScriptRecord(*this),ScriptOriginal));
  CHECK(value.isObject());return frame.Own<UnboundScript>(value);
}
int Script::ScriptId()const{return int(StencilSource(ScriptRecord(*this))->id());}
Local<Value> Script::GetResourceName(){return NativeScriptValue(ScriptRecord(*this),ScriptResource);}

}
#include "kandelo-node/engine-code-cache-codecs-inl.h"
#endif
