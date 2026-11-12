#ifndef KANDELO_NODE_SNAPSHOT_CODECS_INL_H
#define KANDELO_NODE_SNAPSHOT_CODECS_INL_H

// Kandelo's engine-specific implementation of the live Node mksnapshot
// interface. Queue policy stays in the unchanged upstream JavaScript. There is
// no V8 snapshot creator, serialization format or restored heap in this port.
namespace kandelo::node {
namespace {
bool SnapshotCallbackValue(api::Frame& frame,SnapshotCallback kind,JS::MutableHandleValue result) {
  JS::RootedObject runtime(frame.cx,GetRealmRuntime(frame.cx,frame.realm));
  return runtime&&GetSnapshotCallback(frame.cx,runtime,kind,result);
}
void RegisterSnapshotCallback(const api::FunctionCallbackInfo<api::Value>& args,SnapshotCallback kind) {
  auto& frame=api::Current(args.GetIsolate());JS::RootedValue previous(frame.cx);
  if(!SnapshotCallbackValue(frame,kind,&previous))return;
  CHECK(previous.isUndefined());auto value=args[0];CHECK(value->IsFunction());
  JS::RootedObject runtime(frame.cx,GetRealmRuntime(frame.cx,frame.realm));
  if(runtime)SetSnapshotCallback(frame.cx,runtime,kind,api::Input(value));
}
void RegisterSerialize(const api::FunctionCallbackInfo<api::Value>& args) { RegisterSnapshotCallback(args,SnapshotCallback::Serialize); }
void RegisterDeserialize(const api::FunctionCallbackInfo<api::Value>& args) { RegisterSnapshotCallback(args,SnapshotCallback::Deserialize); }
void RegisterMain(const api::FunctionCallbackInfo<api::Value>& args) { RegisterSnapshotCallback(args,SnapshotCallback::Main); }
void RunSnapshotPreload(const api::FunctionCallbackInfo<api::Value>& args) {
  auto* environment=native::Environment::GetCurrent(args);auto hook=environment->embedder_preload();
  CHECK(hook);CHECK_EQ(args.Length(),2);CHECK(args[0]->IsObject());CHECK(args[1]->IsFunction());
  hook(environment,args[0].As<api::Object>(),args[1].As<api::Function>());
}
void CompileSnapshotMain(const api::FunctionCallbackInfo<api::Value>& args) {
  CHECK(args[0]->IsString());CHECK(args[1]->IsString());auto& frame=api::Current(args.GetIsolate());
  JS::RootedString filename(frame.cx,api::Input(args[0]).toString()),body(frame.cx,api::Input(args[1]).toString());
  JS::AutoStableStringChars characters(frame.cx);if(!characters.initTwoByte(frame.cx,filename))return;
  const auto* units=characters.twoByteChars();const size_t length=JS_GetStringLength(filename);
  for(size_t i=0;i<length;++i){
    const char16_t unit=units[i];
    if(unit==0||(unit&0xfc00)==0xdc00||((unit&0xfc00)==0xd800&&(++i==length||(units[i]&0xfc00)!=0xdc00))){
      JS_ReportErrorASCII(frame.cx,"SpiderMonkey native script origins require well-formed UTF-8 without NUL");return;
    }
  }
  auto encoded=JS_EncodeStringToUTF8(frame.cx,filename);if(!encoded)return;
  const char* const names[]={"require","__filename","__dirname"};
  JS::RootedFunction function(frame.cx,CompileNativeFunctionBody(frame.cx,encoded.get(),body,3,names));
  if(!function)return;JS::RootedValue value(frame.cx,JS::ObjectValue(*JS_GetFunctionObject(function)));
  args.GetReturnValue().Set(frame.Own<api::Function>(value));
}
struct SnapshotBindingState {
  native::AliasedUint8Array mode;
  explicit SnapshotBindingState(api::Isolate* isolate):mode(isolate,1) {
    // No heap builder is attached to this engine. This is actual ordinary
    // execution state, independent of user requests for unsupported snapshots.
    mode[0]=0;
  }
};
void FinalizeSnapshotBinding(JS::GCContext*,JSObject* object) {
  auto value=JS::GetReservedSlot(object,0);
  if(value.isUndefined())return;
  JS::SetReservedSlot(object,0,JS::UndefinedValue());delete static_cast<SnapshotBindingState*>(value.toPrivate());
}
const JSClassOps snapshotOps={nullptr,nullptr,nullptr,nullptr,nullptr,nullptr,FinalizeSnapshotBinding};
const JSClass snapshotClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(1)|JSCLASS_FOREGROUND_FINALIZE,&snapshotOps};

bool NativeContextControl(JSContext* cx,unsigned argc,JS::Value* vp) {
  auto args=JS::CallArgsFromVp(argc,vp);
  if(!args.get(0).isString()||!args.get(1).isObject()){
    JS_ReportErrorASCII(cx,"Native context control requires operation and genuine global");return false;
  }
  JS::RootedString name(cx,args[0].toString());auto operation=JS_EncodeStringToUTF8(cx,name);if(!operation)return false;
  JS::RootedObject target(cx,js::CheckedUnwrapDynamic(&args[1].toObject(),cx,false));if(!target)return false;
  target=js::ToWindowIfWindowProxy(target);if(!JS_IsGlobalObject(target)){
    JS_ReportErrorASCII(cx,"Native context control requires a genuine global");return false;
  }
  JS::RootedObject runtime(cx,js::shell::GetShellContext(cx)->upstreamNodeRuntime);
  auto state=api::Data(cx,runtime);if(!state)return false;
  JS::RootedObject realm(cx,GetRuntimePrincipalRealm(cx,runtime));if(!realm)return false;
  api::Frame frame(cx,realm,state,nullptr,api::Domain::Snapshot);auto* isolate=&state->isolate;
  auto caller=isolate->GetCurrentContext();api::Local<api::Context> context;
  {api::EscapableHandleScope handles(isolate);context=handles.Escape(frame.OwnContext(target));}
  if(!std::strcmp(operation.get(),"inspect")){
    auto principal=state->environment.context();if(principal.IsEmpty())return false;
    JS::RootedObject result(cx,JS_NewPlainObject(cx));if(!result)return false;
    JS::RootedValue current(cx,api::Input(caller->Global())),owner(cx,api::Input(principal->Global())),selected(cx,api::Input(context->Global()));
    if(!JS_DefineProperty(cx,result,"current",current,JSPROP_ENUMERATE)||!JS_DefineProperty(cx,result,"principal",owner,JSPROP_ENUMERATE)||!JS_DefineProperty(cx,result,"target",selected,JSPROP_ENUMERATE))return false;
    args.rval().setObject(*result);return true;
  }
  if(!std::strcmp(operation.get(),"integer")){
    auto input=frame.OwnValue(args.get(2));int64_t value;if(!input->IntegerValue(context).To(&value))return false;
    CHECK(caller==isolate->GetCurrentContext());args.rval().setNumber(double(value));return true;
  }
  if(!std::strcmp(operation.get(),"callback")){
    JS::RootedValue callback(cx,args.get(2)),result(cx);if(!callback.isObject()||!JS::IsCallable(&callback.toObject())){
      JS_ReportErrorASCII(cx,"Native context callback must be callable");return false;
    }
    bool ok;
    {api::Context::Scope home(context);CHECK(context==isolate->GetCurrentContext());
      if(!JS_WrapValue(cx,&callback))return false;
      ok=JS::Call(cx,JS::UndefinedHandleValue,callback,JS::HandleValueArray::empty(),&result);
      CHECK(context==isolate->GetCurrentContext());}
    CHECK(caller==isolate->GetCurrentContext());if(!ok)return false;
    if(!JS_WrapValue(cx,&result))return false;args.rval().set(result);return true;
  }
  if(!std::strcmp(operation.get(),"readCallback")||!std::strcmp(operation.get(),"clearCallback")||!std::strcmp(operation.get(),"invokeCallback")){
    if(!args.get(2).isInt32()||args[2].toInt32()<0||args[2].toInt32()>2){JS_ReportErrorASCII(cx,"Snapshot callback control index");return false;}
    auto kind=static_cast<SnapshotCallback>(args[2].toInt32());JS::RootedValue value(cx);
    if(!SnapshotCallbackValue(frame,kind,&value))return false;
    if(!std::strcmp(operation.get(),"clearCallback")&&!SetSnapshotCallback(cx,runtime,kind,JS::UndefinedHandleValue))return false;
    if(!std::strcmp(operation.get(),"invokeCallback")&&!value.isUndefined()){
      auto principal=state->environment.context();if(principal.IsEmpty())return false;
      bool ok;
      {api::Context::Scope home(principal);CHECK(principal==isolate->GetCurrentContext());
        if(!JS_WrapValue(cx,&value))return false;
        JS::RootedValue result(cx);ok=JS::Call(cx,JS::UndefinedHandleValue,value,JS::HandleValueArray::empty(),&result);value=result;}
      CHECK(caller==isolate->GetCurrentContext());if(!ok||!JS_WrapValue(cx,&value))return false;
    }
    args.rval().set(value);return true;
  }
  JS_ReportErrorASCII(cx,"Unknown native context control");return false;
}
}
JSObject* CreateSnapshotBinding(JSContext* cx,JS::HandleObject realm) {
  JS::RootedObject runtime(cx,GetRealmRuntime(cx,realm));if(!runtime)return nullptr;
  auto state=api::Data(cx,runtime);if(!state)return nullptr;
  api::Frame frame(cx,realm,state,nullptr,api::Domain::Snapshot);
  JS::RootedObject binding(cx,JS_NewObject(cx,&snapshotClass));if(!binding)return nullptr;frame.binding=binding;
  auto owner=std::make_unique<SnapshotBindingState>(&state->isolate);
  auto array=owner->mode.GetJSArray();if(array.IsEmpty()||JS_IsExceptionPending(cx))return nullptr;
  JS::RootedValue mode(cx,api::Input(array));
  owner->mode.MakeWeak();JS::SetReservedSlot(binding,0,JS::PrivateValue(owner.release()));
  JS::RootedValue value(cx,JS::ObjectValue(*binding));auto target=frame.Own<api::Object>(value);auto context=state->isolate.GetCurrentContext();
  native::SetMethod(context,target,"runEmbedderPreload",RunSnapshotPreload);
  native::SetMethod(context,target,"compileSerializeMain",CompileSnapshotMain);
  native::SetMethod(context,target,"setSerializeCallback",RegisterSerialize);
  native::SetMethod(context,target,"setDeserializeCallback",RegisterDeserialize);
  native::SetMethod(context,target,"setDeserializeMainFunction",RegisterMain);
  JS::RootedString anonymous(cx,JS_NewStringCopyZ(cx,"__node_anonymous_main"));
  if(!anonymous||!JS_DefineProperty(cx,binding,"anonymousMainPath",anonymous,JSPROP_ENUMERATE))return nullptr;
  if(!JS_DefineProperty(cx,binding,"isBuildingSnapshotBuffer",mode,JSPROP_ENUMERATE))return nullptr;
  return binding;
}
bool DefineNativeContextTestAPI(JSContext* cx,JS::HandleObject api) {
  return JS_DefineFunction(cx,api,"nativeContext",NativeContextControl,3,0);
}
}
#endif
