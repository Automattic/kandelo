#ifndef KANDELO_NODE_ENGINE_CODEGEN_CODECS_INL_H
#define KANDELO_NODE_ENGINE_CODEGEN_CODECS_INL_H
#ifdef KANDELO_NATIVE_NODE_ENGINE

// Engine compilation admission, not Node policy. Original Node supplies its
// ModifyCodeGenerationFromStrings/AllowWasmCodeGeneration callbacks and owns
// their Environment option checks and generated-source-map work.
namespace v8 {
namespace {
bool NativeRuntimeCodeCheck(JSContext* cx,JS::RuntimeCode kind,
    JS::HandleString codeString,JS::CompilationType compilationType,
    JS::Handle<JS::StackGCVector<JSString*>> parameterStrings,
    JS::HandleString bodyString,
    JS::Handle<JS::StackGCVector<JS::Value>> parameterArgs,
    JS::HandleValue bodyArg,bool* canCompile){
  auto state=ReadNativeEngineState(cx);CHECK(state&&state->cx==cx);
  state->AssertForeground();
  // A failed admission must leave its existing failure untouched. In
  // particular, cancellation is not an ordinary EvalError to overwrite.
  if(cx->isNativeExecutionTerminating()||JS_IsExceptionPending(cx))return false;
  const auto* previous=state->previousSecurityCallbacks;
  if(previous&&previous->contentSecurityPolicyAllows){
    bool allowed;
    if(!previous->contentSecurityPolicyAllows(cx,kind,codeString,compilationType,
        parameterStrings,bodyString,parameterArgs,bodyArg,&allowed))return false;
    if(!allowed){*canCompile=false;return true;}
  }
  try {
    JS::RootedObject global(cx,JS::CurrentGlobalOrNull(cx));CHECK(global);
    bool allowed=true;
    if(kind==JS::RuntimeCode::JS){
      JS::AutoCheckCannotGC nogc;
      if(auto* record=ExistingContextEmbedderStorage(*state,global)){
        allowed=ContextFields(record).allowCodeGenerationFromStrings;
      }
      // Pinned V8 bypasses the embedder callback for unconditionally allowed
      // string compilation. Node deliberately clears this flag during startup.
      if(allowed){*canCompile=true;return true;}
    }
    Isolate::Scope isolateScope(&state->isolate);
    // This is an engine-to-native callback while eval/Function is still being
    // evaluated. Returning must not run jobs or catch an enclosing native
    // TryCatch before JavaScript catch/finally has had a chance to execute.
    NativeCallbackEntry callbackEntry(*state);
    Frame frame(cx,global,state);
    auto context=frame.OwnContext(global);
    if(kind==JS::RuntimeCode::WASM){
      JS::RootedValue text(cx,JS::StringValue(codeString?codeString.get():JS_GetEmptyString(cx)));
      if(auto callback=state->allowWasmCodeGeneration){
        allowed=callback(context,frame.Own<String>(text));
      }
      // The engine's original Wasm caller creates its own CompileError on
      // rejection. Registering this policy does not implement guest Wasm.
    }else {
      CHECK(codeString);
      if(auto callback=state->modifyCodeGeneration){
        JS::RootedValue source(cx,JS::StringValue(codeString));
        // Ordinary strings are not V8 API-template CodeLike objects. A
        // zero-argument Function constructor has no untrusted arguments.
        const bool isCodeLike=compilationType==JS::CompilationType::Function&&
            parameterArgs.empty()&&!bodyString;
        auto result=callback(context,frame.OwnValue(source),isCodeLike);
        allowed=result.codegen_allowed;
        if(JS_IsExceptionPending(cx)||cx->isNativeExecutionTerminating())return false;
        // Node's original callback returns no replacement. The public SM CSP
        // interface cannot replace source. Keep this separate compiler gap
        // visible rather than execute the old string and report success.
        if(allowed&&!result.modified_source.IsEmpty()){
          JS_ReportErrorASCII(cx,"Native dynamic-source replacement requires compiler integration");
          return false;
        }
      }
      if(!allowed&&!JS_IsExceptionPending(cx)&&!cx->isNativeExecutionTerminating()){
        auto error=Error(&state->isolate,JSEXN_EVALERR,nullptr,
            "Code generation from strings disallowed for this context");
        if(!error.IsEmpty())state->isolate.ThrowException(error);
        return false;
      }
    }
    if(JS_IsExceptionPending(cx)||cx->isNativeExecutionTerminating())return false;
    *canCompile=allowed;return true;
  }catch(const std::bad_alloc&){
    bridge::FatalOutOfMemory(&state->isolate,"Dynamic compilation callback metadata",false);
  }
}
}
void InitializeNativeCodeGeneration(State& state){
  state.AssertForeground();CHECK(state.cx==js::TlsContext.get());
  CHECK(!state.codeGenerationSecurityInstalled);
  state.previousSecurityCallbacks=JS_GetSecurityCallbacks(state.cx);
  if(state.previousSecurityCallbacks)state.codeGenerationSecurity=*state.previousSecurityCallbacks;
  state.codeGenerationSecurity.contentSecurityPolicyAllows=NativeRuntimeCodeCheck;
  JS_SetSecurityCallbacks(state.cx,&state.codeGenerationSecurity);
  state.codeGenerationSecurityInstalled=true;
}
void RetireNativeCodeGeneration(State& state){
  state.AssertForeground();CHECK(state.cx==js::TlsContext.get());
  if(!state.codeGenerationSecurityInstalled)return;
  CHECK(JS_GetSecurityCallbacks(state.cx)==&state.codeGenerationSecurity);
  JS_SetSecurityCallbacks(state.cx,state.previousSecurityCallbacks);
  state.codeGenerationSecurityInstalled=false;state.previousSecurityCallbacks=nullptr;
  state.modifyCodeGeneration=nullptr;state.allowWasmCodeGeneration=nullptr;
}
void Context::AllowCodeGenerationFromStrings(bool allow){
  auto& frame=Current(isolate);js::AssertHeapIsIdle();
  JS::RootedObject record(frame.cx,EnsureContextEmbedderStorage(frame,*this));
  ContextFields(record).allowCodeGenerationFromStrings=allow;
}
bool Context::IsCodeGenerationFromStringsAllowed()const{
  auto& frame=Current(isolate);JS::AutoCheckCannotGC nogc;
  auto* record=ExistingContextEmbedderStorage(*frame.state,&cell().value.get().toObject());
  return !record||ContextFields(record).allowCodeGenerationFromStrings;
}
void Isolate::SetModifyCodeGenerationFromStringsCallback(ModifyCodeGenerationFromStringsCallback2 callback){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  CHECK(native_->state&&native_->state->codeGenerationSecurityInstalled);
  native_->state->modifyCodeGeneration=callback;
}
void Isolate::SetAllowWasmCodeGenerationCallback(AllowWasmCodeGenerationCallback callback){
  CHECK(native_);native_->AssertForeground();CHECK(native_->phase==NativeIsolatePhase::Live);
  CHECK(native_->state&&native_->state->codeGenerationSecurityInstalled);
  native_->state->allowWasmCodeGeneration=callback;
}
}
#endif
#endif
