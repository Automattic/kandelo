#ifndef KANDELO_NATIVE_OBJECT_CODECS_INL_H
#define KANDELO_NATIVE_OBJECT_CODECS_INL_H

#include <map>
#define v8 kandelo_node_codec_api
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/node_diagnostics_channel.h"
#undef node
#undef v8

namespace kandelo_node_codec_api {
bool GlobalRootIsWeak(const std::shared_ptr<GlobalRoot>& root){return root&&root->weakMode;}
void MakeGlobalStrong(Isolate* isolate,const std::shared_ptr<GlobalRoot>& root){
  if(!root)return;auto state=root->state.lock();CHECK(state && &state->isolate==isolate);state->environment.AssertForeground();
  if(!root->weakMode)return;
  JSContext* cx=state->environment.data().cx;CHECK(cx);
  JS::RootedValue value(cx,JS::ObjectOrNullValue(root->weak));
  // Remove weak tracking before publishing a strong edge. Otherwise stale
  // tracking records can become an unintended strong owner after retirement.
  std::erase(state->weakGlobals,root);
  CHECK(root->strong&&!root->strong->cell().value.initialized());
  if(root->weak)root->strong->cell().value.init(cx,value);
  root->weak=nullptr;root->weakMode=false;
}
void MakeGlobalWeakTenured(Isolate* isolate,const std::shared_ptr<GlobalRoot>& root){
  if(!root||root->weakMode||!root->strong||!root->strong->cell().value.initialized())return;
  auto state=root->state.lock();CHECK(state && &state->isolate==isolate);state->environment.AssertForeground();
  auto value=root->strong->cell().value.get();CHECK(root->strong->IsValue()&&value.isObject());
  JSObject* object=&value.toObject();CHECK(!js::gc::IsInsideNursery(object));
  state->weakGlobals.push_back(root);root->weak=object;root->weakMode=true;root->strong->cell().value.reset();
}
struct PersistentCell {
  Isolate* isolate;
  std::shared_ptr<GlobalRoot> root;
};
PersistentCell* NewPersistentCell(Isolate* isolate,Local<Data> value){return new PersistentCell{isolate,NewGlobalRoot(isolate,value)};}
void DeletePersistentCell(PersistentCell* cell){delete cell;}
Data* BorrowPersistentLocal(const PersistentCell* cell){return PersistentCellIsEmpty(cell)?nullptr:cell->root->strong.get();}
Local<Data> ReadPersistentCell(Isolate* isolate,const PersistentCell* cell){return cell?ReadGlobalRoot(isolate,cell->root):Local<Data>();}
bool PersistentCellIsEmpty(const PersistentCell* cell){return !cell||GlobalRootIsEmpty(cell->root);}
bool PersistentCellIsWeak(const PersistentCell* cell){return cell&&GlobalRootIsWeak(cell->root);}
void WeakenPersistentCell(PersistentCell* cell,bool tenured){
  if(!cell)return;
  if(tenured)MakeGlobalWeakTenured(cell->isolate,cell->root);else MakeGlobalWeak(cell->isolate,cell->root);
}
void StrengthenPersistentCell(PersistentCell* cell){if(cell)MakeGlobalStrong(cell->isolate,cell->root);}
JSObject* BorrowPersistentObject(const PersistentCell* cell){return cell?BorrowGlobalObject(cell->root):nullptr;}

Isolate* Isolate::GetCurrent(){CHECK(Frame::current);return &Frame::current->state->isolate;}
Isolate* Isolate::TryGetCurrent(){return Frame::current?&Frame::current->state->isolate:nullptr;}
void Isolate::LowMemoryNotification(){
  auto& frame=Current(this);frame.state->environment.AssertForeground();
  // A low-memory notification requests an actual full shrinking collection.
  // Preserve both the pending thrown value and its saved throw stack.
  JS::AutoSaveExceptionState saved(frame.cx);
  JS::PrepareForFullGC(frame.cx);
  JS::NonIncrementalGC(frame.cx,JS::GCOptions::Shrink,JS::GCReason::API);
  saved.restore();
}
Local<Value> Undefined(Isolate* isolate){auto& f=Current(isolate);JS::RootedValue value(f.cx,JS::UndefinedValue());return f.OwnValue(value);}
void Function::SetName(Local<String> name){
  auto& frame=*Frame::current;JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(object&&object->is<JSFunction>());
  JSAutoRealm home(frame.cx,object);JS::RootedString string(frame.cx,name->cell().value.toString());
  JS::Rooted<JSAtom*> atom(frame.cx,js::AtomizeString(frame.cx,string));CHECK(atom);
  // Replace a previously resolved own name as well as the VM's function name.
  CHECK(JS_DefineProperty(frame.cx,object,"name",string,JSPROP_READONLY));
  object->as<JSFunction>().setAtom(atom);
}
MaybeLocal<Value> Function::Call(Local<Context> context,Local<Value> receiver,int argc,Local<Value>* argv) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f);if(nativeEntry.Terminated())return {};Context::Scope home(context);CHECK_GE(argc,0);if(JS_IsExceptionPending(f.cx))return {};
  JS::RootedValue callable(f.cx,cell().value),target(f.cx,Input(receiver)),result(f.cx);
  JS::RootedValueVector arguments(f.cx);
  if(!JS_WrapValue(f.cx,&callable)||!JS_WrapValue(f.cx,&target))return {};
  for(int i=0;i<argc;++i){JS::RootedValue value(f.cx,Input(argv[i]));if(!JS_WrapValue(f.cx,&value)||!arguments.append(value))return {};}
  if(!JS::Call(f.cx,target,callable,arguments,&result))return {};return f.OwnValue(result);
}
MaybeLocal<Object> Function::NewInstance(Local<Context> context) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f);if(nativeEntry.Terminated())return {};Context::Scope home(context);if(JS_IsExceptionPending(f.cx))return {};
  JS::RootedValue constructor(f.cx,cell().value);JS::RootedObject object(f.cx);
  if(!JS_WrapValue(f.cx,&constructor)||!JS::Construct(f.cx,constructor,JS::HandleValueArray::empty(),&object))return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));return f.Own<Object>(value);
}
Local<Uint32> Uint32::New(Isolate* isolate,uint32_t value){return Integer::NewFromUnsigned(isolate,value).As<Uint32>();}
uint32_t Uint32::Value()const{CHECK(IsUint32());return uint32_t(cell().value.toNumber());}
Local<Integer> Integer::NewFromUnsigned(Isolate* isolate,uint32_t value) {
  auto& f=Current(isolate);JS::RootedValue number(f.cx,JS::NumberValue(double(value)));return f.Own<Uint32>(number);
}
}
namespace kandelo_node_codec_impl {
const JSClass nativeBindingClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(api::NativeWrapperSlotCount)|JSCLASS_FOREGROUND_FINALIZE,&converterOps};
const JSClass nativeChannelClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(api::NativeWrapperSlotCount)|JSCLASS_FOREGROUND_FINALIZE,&converterOps};
struct NativeRealmData {
  Isolate* isolate;
  Global<Object> owner;
  std::map<size_t,BaseObject*> bindings;
  std::set<BaseObject*> objects;
  explicit NativeRealmData(Isolate* isolate,Local<Object> input):isolate(isolate),owner(isolate,input){owner.SetWeak();}
};
Realm::Realm(Isolate* isolate,Local<Object> owner):data_(std::make_unique<NativeRealmData>(isolate,owner)){}
Realm::~Realm(){CHECK(data_->objects.empty()&&data_->bindings.empty());}
Isolate* Realm::isolate(){return data_->isolate;}
Environment* Realm::env(){return &Current(isolate()).state->environment;}
Local<Object> Realm::owner(){return data_->owner.Get(isolate());}
Local<Context> Realm::context(){
  auto& f=Current(isolate());auto value=owner();if(value.IsEmpty())return {};
  JS::RootedObject object(f.cx,UnwrapObject(f.cx,Input(value)));if(!object)return {};
  JS::RootedObject global(f.cx,JS::GetNonCCWObjectGlobal(object));return f.OwnContext(global);
}
Realm* Realm::GetCurrent(const FunctionCallbackInfo<Value>& args){return GetCurrent(args.GetIsolate()->GetCurrentContext());}
Realm* Realm::GetCurrent(Local<Context> context){
  auto& f=Current(context->isolate);Context::Scope home(context);
  JS::RootedObject runtime(f.cx,kandelo::node::GetRealmRuntime(f.cx,f.realm));if(!runtime)return nullptr;
  JS::RootedObject object(f.cx,kandelo::node::GetCurrentRealmOwner(f.cx,runtime));if(!object)return nullptr;
  object=js::CheckedUnwrapDynamic(object,f.cx,false);if(!object)return nullptr;
  for(auto& realm:f.state->realms){
    auto held=realm->owner();if(held.IsEmpty())continue;
    if(UnwrapObject(f.cx,Input(held))==object)return realm.get();
  }
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));
  auto realm=std::make_unique<Realm>(context->isolate,f.Own<Object>(value));auto* result=realm.get();
  f.state->realms.push_back(std::move(realm));return result;
}
Realm* Environment::principal_realm(){auto context=this->context();return context.IsEmpty()?nullptr:Realm::GetCurrent(context);}
bool Environment::can_call_into_js()const{return !data_->stopping&&!data_->closed;}
namespace {
Local<Symbol> ReadEnvironmentSymbol(Environment* environment,const char* name){
  auto& frame=Current(environment->isolate());CHECK(&frame.state->environment==environment);
  JS::RootedObject runtime(frame.cx,kandelo::node::GetRealmRuntime(frame.cx,frame.realm));if(!runtime)return {};
  JS::RootedSymbol symbol(frame.cx,kandelo::node::GetRuntimeSymbol(frame.cx,runtime,name));if(!symbol)return {};
  JS::RootedValue value(frame.cx,JS::SymbolValue(symbol));return frame.Own<Symbol>(value);
}
}
Local<Symbol> Environment::owner_symbol(){return ReadEnvironmentSymbol(this,"owner_symbol");}
Local<Symbol> Environment::resource_symbol(){return ReadEnvironmentSymbol(this,"resource_symbol");}
Local<Symbol> Environment::handle_onclose_symbol(){return ReadEnvironmentSymbol(this,"handle_onclose_symbol");}
namespace {
Local<Private> ReadEnvironmentPrivate(Environment* environment,const char* name){
  auto& frame=Current(environment->isolate());environment->AssertForeground();
  JS::RootedObject runtime(frame.cx,kandelo::node::GetRealmRuntime(frame.cx,frame.realm));if(!runtime)return {};
  JS::RootedSymbol symbol(frame.cx,kandelo::node::GetRuntimeSymbol(frame.cx,runtime,name));if(!symbol)return {};
  CHECK(JS::GetSymbolCode(symbol)==JS::SymbolCode::EmbeddingPrivateSymbol);
  JS::RootedValue value(frame.cx,JS::SymbolValue(symbol));return frame.Own<Private>(value);
}
Local<Function> ReadEnvironmentStackCallback(Environment* environment,kandelo::node::ErrorStackCallback callback){
  auto& frame=Current(environment->isolate());environment->AssertForeground();auto context=environment->context();if(context.IsEmpty())return {};
  JS::RootedValue value(frame.cx);
  {Context::Scope home(context);JS::RootedObject runtime(frame.cx,kandelo::node::GetRealmRuntime(frame.cx,frame.realm));if(!runtime||!kandelo::node::GetCurrentErrorStackCallback(frame.cx,runtime,callback,&value))return {};}
  if(value.isUndefined())return {};
  if(!JS_WrapValue(frame.cx,&value))return {};CHECK(value.isObject()&&JS::IsCallable(&value.toObject()));return frame.Own<Function>(value);
}
void WriteRealmStackCallback(Realm* realm,kandelo::node::ErrorStackCallback callback,Local<Function> value){
  auto& frame=Current(realm->isolate());realm->env()->AssertForeground();auto context=realm->context();CHECK(!context.IsEmpty());
  Context::Scope home(context);JS::RootedObject runtime(frame.cx,kandelo::node::GetRealmRuntime(frame.cx,frame.realm));CHECK(runtime);
  JS::RootedValue input(frame.cx,value.IsEmpty()?JS::UndefinedValue():Input(value).get());
  CHECK(kandelo::node::SetCurrentErrorStackCallback(frame.cx,runtime,callback,input));
}
}
Local<Private> Environment::arrow_message_private_symbol(){return ReadEnvironmentPrivate(this,"arrow_message_private_symbol");}
Local<Private> Environment::decorated_private_symbol(){return ReadEnvironmentPrivate(this,"decorated_private_symbol");}
Local<Private> Environment::exit_info_private_symbol(){return ReadEnvironmentPrivate(this,"exit_info_private_symbol");}
Local<Private> Environment::empty_context_frame_sentinel_symbol(){return ReadEnvironmentPrivate(this,"empty_context_frame_sentinel_symbol");}
Local<Function> Environment::enhance_fatal_stack_before_inspector(){return ReadEnvironmentStackCallback(this,kandelo::node::ErrorStackCallback::BeforeFatal);}
Local<Function> Environment::enhance_fatal_stack_after_inspector(){return ReadEnvironmentStackCallback(this,kandelo::node::ErrorStackCallback::AfterFatal);}
void Realm::set_prepare_stack_trace_callback(Local<Function> callback){WriteRealmStackCallback(this,kandelo::node::ErrorStackCallback::Prepare,callback);}
void Realm::set_enhance_fatal_stack_before_inspector(Local<Function> callback){WriteRealmStackCallback(this,kandelo::node::ErrorStackCallback::BeforeFatal,callback);}
void Realm::set_enhance_fatal_stack_after_inspector(Local<Function> callback){WriteRealmStackCallback(this,kandelo::node::ErrorStackCallback::AfterFatal,callback);}
BaseObject* Realm::GetBindingRaw(size_t index){env()->AssertForeground();auto it=data_->bindings.find(index);return it==data_->bindings.end()?nullptr:it->second;}
void Realm::InstallBindingRaw(size_t index,BaseObject* object){env()->AssertForeground();CHECK(!data_->bindings.contains(index)&&data_->objects.contains(object));data_->bindings.emplace(index,object);}
void Realm::RegisterObject(BaseObject* object){env()->AssertForeground();CHECK(data_->objects.insert(object).second);}
void Realm::ForgetObject(BaseObject* object){
  CHECK(data_->objects.erase(object)==1);
  for(auto it=data_->bindings.begin();it!=data_->bindings.end();)if(it->second==object)it=data_->bindings.erase(it);else ++it;
}
void Realm::RunCleanup(){
  env()->AssertForeground();
  // Bindings release their actual detached channel references before remaining
  // weak wrappers. Destructors unregister each pointer before another visit.
  while(!data_->bindings.empty()){auto* object=data_->bindings.begin()->second;CHECK(!object->HasNativeReference());object->RetireWrapper();delete object;}
  // A detached object still present here has an outstanding native owner.
  // Never free behind that owner's shared reference during retirement.
  while(!data_->objects.empty()){auto* object=*data_->objects.begin();CHECK(!object->IsDetached()&&!object->HasNativeReference());object->RetireWrapper();delete object;}
}
BaseObject::BaseObject(Realm* realm,Local<Object> input){
  auto& f=Current(realm->isolate());JS::RootedObject object(f.cx,UnwrapObject(f.cx,Input(input)));
  CHECK(object&&JS::GetClass(object)==&nativeBindingClass&&JS::GetReservedSlot(object,0).isUndefined());
  owner_=std::make_unique<NativeObjectOwner>(f,object);owner_->realm=realm;
  JS::RootedValue actual(f.cx,JS::ObjectValue(*object));owner_->handle.Reset(realm->isolate(),f.Own<Object>(actual));owner_->root.reset();
  JS::RootedValue home(f.cx,Input(realm->owner()));
  {JSAutoRealm enter(f.cx,object);CHECK(JS_WrapValue(f.cx,&home));JS::SetReservedSlot(object,1,home);JS::SetReservedSlot(object,0,JS::PrivateValue(this));}
  realm->RegisterObject(this);
}
BaseObject::~BaseObject(){
  CHECK(!HasNativeReference());
  if(owner_->realm){
    // A weak edge is updated by the engine even during a moving collection.
    auto& handle=owner_->handle;
    // Destruction can run from a foreground GC finalizer with no native Frame.
    // The traced wrapper edge is read without allocating or invoking JS.
    auto object=handle.BorrowObject();
    if(object)JS::SetReservedSlot(object,0,JS::UndefinedValue());
    owner_->realm->ForgetObject(this);
  }else (owner_->category?owner_->state->traceReleased:owner_->state->icuReleased).fetch_add(1);
}
void BaseObject::ClearWeak(){owner_->state->environment.AssertForeground();owner_->wantsWeak=false;owner_->handle.ClearWeak();}
Global<Object>& BaseObject::persistent(){CHECK(owner_->realm);return owner_->handle;}
bool BaseObject::HasNativeReference()const{return !owner_->nativeReference.expired();}
bool BaseObject::IsWeakOrDetached()const{return owner_->wantsWeak||owner_->detached||owner_->handle.IsWeak();}
std::shared_ptr<BaseObject> BaseObject::AcquireNativeReference(){
  owner_->state->environment.AssertForeground();CHECK(owner_->realm&&!owner_->state->environment.IsClosed());
  if(Frame::current)CHECK(owner_->state==Frame::current->state);
  if(auto existing=owner_->nativeReference.lock())return existing;
  auto result=std::shared_ptr<BaseObject>(this,[](BaseObject* object){object->ReleaseNativeReference();});
  owner_->nativeReference=result;owner_->handle.ClearWeak();return result;
}
void BaseObject::ReleaseNativeReference(){
  owner_->state->environment.AssertForeground();CHECK(!HasNativeReference());
  // The resource's collection hook may defer deletion until native close has
  // completed. The default hook retires the wrapper before derived teardown.
  if(owner_->detached){OnGCCollect();return;}
  if(owner_->wantsWeak)owner_->handle.SetWeakTenured();
}
void BaseObject::RetireWrapper(){
  owner_->state->environment.AssertForeground();if(!owner_->realm)return;
  if(auto* object=owner_->handle.BorrowObject()){
    auto value=JS::GetReservedSlot(object,0);
    CHECK(value.isUndefined()||(value.isDouble()&&value.toPrivate()==this));
    JS::SetReservedSlot(object,0,JS::UndefinedValue());
  }
}
void BaseObject::OnGCCollect(){RetireWrapper();delete this;}
Local<Object> BaseObject::object()const{CHECK(owner_->realm);return owner_->handle.Get(&owner_->state->isolate);}
Realm* BaseObject::realm()const{CHECK(owner_->realm);return owner_->realm;}
void BaseObject::Detach(){CHECK(owner_->realm&&HasNativeReference());owner_->detached=true;}
bool BaseObject::IsDetached()const{return owner_->detached;}
BaseObject* BaseObject::UnwrapNativeBinding(Local<Object> input) {
  auto& f=*Frame::current;f.state->environment.AssertForeground();
  JS::RootedObject object(f.cx,UnwrapObject(f.cx,Input(input)));
  if(!object||JS::GetClass(object)!=&nativeBindingClass)return nullptr;
  auto pointer=JS::GetReservedSlot(object,0);if(pointer.isUndefined())return nullptr;
  auto* native=static_cast<BaseObject*>(pointer.toPrivate());
  if(native->owner_->state!=f.state||!native->owner_->realm)return nullptr;
  JS::RootedObject realm(f.cx,&JS::GetReservedSlot(object,1).toObject());
  if(!kandelo::node::CheckRealmLibraryActive(f.cx,realm))return nullptr;
  return native;
}
BaseObject* UnwrapSnapshotable(Local<Object> input,EmbedderObjectType type) {
  auto* object=BaseObject::UnwrapNativeBinding(input);
  if(!object||object->IsDetached()||!object->is_snapshotable())return nullptr;
  auto* snapshotable=static_cast<SnapshotableObject*>(object);
  return snapshotable->type()==type?object:nullptr;
}
SnapshotableObject::SnapshotableObject(Realm* realm,Local<Object> wrap,EmbedderObjectType type):BaseObject(realm,wrap),type_(type){}
Local<FunctionTemplate> BaseObject::MakeLazilyInitializedJSTemplate(Environment* environment,int internalFieldCount){
  return api::CreateNativeWrapperTemplate(environment->isolate(),internalFieldCount);
}
}
namespace kandelo::node {
JSObject* CreateDiagnosticsBinding(JSContext* cx,JS::HandleObject realm){
  JS::RootedObject runtime(cx,GetRealmRuntime(cx,realm));if(!runtime)return nullptr;
  auto state=api::ReadCodecState(cx,runtime);if(!state)return nullptr;api::Frame frame(cx,realm,state,nullptr,api::Domain::Diagnostics);
  JS::RootedObject object(cx,JS_NewObject(cx,&native::nativeBindingClass));if(!object)return nullptr;frame.binding=object;
  JS::RootedValue value(cx,JS::ObjectValue(*object)),unused(cx,JS::UndefinedValue());
  native::IsolateData isolateData;
  auto bindingTemplate=api::ObjectTemplate::New(&state->isolate,{});
  kandelo_diagnostics_adapter::isolate_initializer(&isolateData,bindingTemplate);
  if(!api::ApplyNativeTemplate(frame,bindingTemplate,object))return nullptr;
  if(JS_IsExceptionPending(cx))return nullptr;
  kandelo_diagnostics_adapter::initializer(frame.Own<api::Object>(value),frame.OwnValue(unused),state->isolate.GetCurrentContext(),nullptr);
  return JS_IsExceptionPending(cx)?nullptr:object.get();
}
}
namespace kandelo::node {
namespace {
bool DiagnosticsNativeControl(JSContext* cx,unsigned argc,JS::Value* vp){
  auto args=JS::CallArgsFromVp(argc,vp);
  if(!args.get(0).isString()){JS_ReportErrorASCII(cx,"Native diagnostics control requires operation String");return false;}
  JS::RootedString operationString(cx,args[0].toString());auto operation=JS_EncodeStringToUTF8(cx,operationString);if(!operation)return false;
  JS::RootedObject runtime(cx,js::shell::GetShellContext(cx)->upstreamNodeRuntime);auto state=api::ReadCodecState(cx,runtime);if(!state)return false;
  JS::RootedObject realm(cx,GetRuntimePrincipalRealm(cx,runtime));if(!realm)return false;realm=js::CheckedUnwrapDynamic(realm,cx,false);if(!realm||!CheckRealmLibraryActive(cx,realm))return false;
  JSAutoRealm home(cx,realm);api::Frame frame(cx,realm,state,&args,api::Domain::Diagnostics);
  auto* owner=native::Realm::GetCurrent(state->isolate.GetCurrentContext());if(!owner)return false;
  auto* binding=owner->GetBindingData<native::diagnostics_channel::BindingData>();
  if(!binding){JS_ReportErrorASCII(cx,"Actual diagnostics binding is not initialized");return false;}
  args.rval().setUndefined();
  if(!std::strcmp(operation.get(),"linker")){
    auto callback=binding->link_callback_.Get(&state->isolate);if(!callback.IsEmpty())args.rval().set(api::Input(callback));return !JS_IsExceptionPending(cx);
  }
  if(!std::strcmp(operation.get(),"inspect")){
    JS::RootedObject result(cx,JS_NewPlainObject(cx));if(!result)return false;
    for(auto [key,value]:std::initializer_list<std::pair<const char*,size_t>>{{"capacity",binding->subscribers_.Length()},{"indexes",binding->channel_indices_.size()},{"nextIndex",binding->next_channel_index_},{"nativeSlots",binding->channels_.size()},{"nativeRealms",state->realms.size()}}){
      JS::RootedValue number(cx,JS::NumberValue(double(value)));if(!JS_DefineProperty(cx,result,key,number,JSPROP_ENUMERATE))return false;
    }
    args.rval().setObject(*result);return true;
  }
  if(!args.get(1).isString()){JS_ReportErrorASCII(cx,"Native diagnostics channel requires name String");return false;}
  JS::RootedString name(cx,args[1].toString());auto* linear=name->ensureLinear(cx);if(!linear)return false;
  const size_t length=JS::GetDeflatedUTF8StringLength(linear);auto bytes=JS_EncodeStringToUTF8(cx,name);if(!bytes)return false;
  const std::string_view key(bytes.get(),length);
  if(!std::strcmp(operation.get(),"index")){args.rval().setNumber(binding->GetOrCreateChannelIndex(std::string(key)));return !JS_IsExceptionPending(cx);}
  if(!std::strcmp(operation.get(),"status")){
    if(!args.get(2).isObject()||!JS::IsCallable(&args[2].toObject())){JS_ReportErrorASCII(cx,"Native channel status callback requires Function");return false;}
    auto callback=std::make_shared<api::Global<api::Function>>(&state->isolate,frame.Own<api::Function>(args[2]));
    auto* isolate=&state->isolate;const auto index=binding->GetOrCreateChannelIndex(std::string(key));
    binding->SetChannelStatusCallback(index,[callback,isolate](bool active){
      auto& f=api::Current(isolate);auto function=callback->Get(isolate);if(function.IsEmpty())return;
      JS::RootedValue flag(f.cx,JS::BooleanValue(active));api::Local<api::Value> argv[]={f.OwnValue(flag)};
      USE(function->Call(isolate->GetCurrentContext(),api::Undefined(isolate),1,argv));
    });return !JS_IsExceptionPending(cx);
  }
  auto channel=native::diagnostics_channel::Channel::Get(&state->environment,key);if(JS_IsExceptionPending(cx))return false;
  if(!channel){JS_ReportErrorASCII(cx,"Native diagnostics channel could not be created");return false;}
  if(!std::strcmp(operation.get(),"get")){auto object=channel->object();if(object.IsEmpty())return false;args.rval().set(api::Input(object));return true;}
  if(!std::strcmp(operation.get(),"has")){args.rval().setBoolean(channel->HasSubscribers());return true;}
  if(!std::strcmp(operation.get(),"linked")){args.rval().setBoolean(channel->IsLinked());return true;}
  if(!std::strcmp(operation.get(),"unlink")){channel->Unlink();return true;}
  if(!std::strcmp(operation.get(),"publish")){JS::RootedValue message(cx,args.get(2));if(!JS_WrapValue(cx,&message))return false;channel->Publish(&state->environment,frame.OwnValue(message));return !JS_IsExceptionPending(cx);}
  JS_ReportErrorASCII(cx,"Unknown native diagnostics operation");return false;
}
}
bool DefineDiagnosticsTestAPI(JSContext* cx,JS::HandleObject target){return JS_DefineFunction(cx,target,"diagnosticsNative",DiagnosticsNativeControl,2,0);}
}
#endif
