#ifndef KANDELO_NATIVE_OBJECT_CODECS_INL_H
#define KANDELO_NATIVE_OBJECT_CODECS_INL_H

#include <map>
#ifndef KANDELO_NATIVE_NODE_ENGINE
#define node kandelo_node_codec_impl
#include "shell/node-upstream/codecs-upstream/node_diagnostics_channel.h"
#undef node
#endif

namespace v8 {
Data* RebindIntegerHandle(Data* input,bool unsignedInteger){
  if(!input)return nullptr;
  CHECK(Frame::current&&input->IsValue());auto& frame=*Frame::current;CheckNativePrimitiveAccess(frame);
  CHECK(input->cell().context==frame.cx);auto* value=static_cast<Value*>(input);
  CHECK(unsignedInteger?value->IsUint32():value->IsInt32());
  const auto factory=unsignedInteger?&CloneWrapper<Uint32>:&CloneWrapper<Int32>;
  if(input->RootFactoryForStorage()==factory)return input;
  return unsignedInteger?static_cast<Data*>(frame.OwnTypedView<Uint32>(*input).get()):
                         static_cast<Data*>(frame.OwnTypedView<Int32>(*input).get());
}
int32_t Int32::Value()const{CHECK(IsInt32());return int32_t(cell().value.toNumber());}
bool GlobalRootIsWeak(const std::shared_ptr<GlobalRoot>& root){return root&&root->weakMode;}
void MakeGlobalStrong(Isolate* isolate,const std::shared_ptr<GlobalRoot>& root){
  if(!root)return;auto state=root->state.lock();CHECK(state && &state->isolate==isolate);state->AssertForeground();
  CancelGlobalCallback(root);
  if(!root->weakMode)return;
  JSContext* cx=state->cx;CHECK(cx);
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
  auto state=root->state.lock();CHECK(state && &state->isolate==isolate);state->AssertForeground();
  auto value=root->strong->cell().value.get();CHECK(value.isObject());
  JSObject* object=&value.toObject();CHECK(!js::gc::IsInsideNursery(object));
  state->weakGlobals.push_back(root);root->weak=object;root->weakMode=true;root->strong->cell().value.reset();
}
struct PersistentCell {
  Isolate* isolate;
  std::shared_ptr<GlobalRoot> root;
};
PersistentCell* NewPersistentCell(Isolate* isolate,Local<Data> value){return new PersistentCell{isolate,NewGlobalRoot(isolate,value)};}
void DeletePersistentCell(PersistentCell* cell){
  if(cell&&cell->root->weakCallback){
    // Parameter lifetime is managed by the native owner. Its persistent must
    // be retired on the foreground thread so a GC callback cannot
    // race destruction of that raw parameter. Plain weak edges may still be
    // released from a producer thread, as before.
    auto& callback=cell->root->weakCallback;
    auto current=uv_thread_self();CHECK(uv_thread_equal(&current,&callback->foreground));
    callback->cancelled=true;callback->registered=false;
  }
  delete cell;
}
Data* BorrowPersistentLocal(const PersistentCell* cell){return PersistentCellIsEmpty(cell)?nullptr:cell->root->strong.get();}
Local<Data> ReadPersistentCell(Isolate* isolate,const PersistentCell* cell){return cell?ReadGlobalRoot(isolate,cell->root):Local<Data>();}
bool PersistentCellIsEmpty(const PersistentCell* cell){return !cell||GlobalRootIsEmpty(cell->root);}
bool PersistentCellIsWeak(const PersistentCell* cell){return cell&&GlobalRootIsWeak(cell->root);}

namespace {
void ReadPersistentComparisonValue(const PersistentCell* cell, Frame& frame,
                                  JS::MutableHandleValue output,
                                  bool* isContext) {
  const auto& root = cell->root;
  CHECK(root && root->state.lock() == frame.state && root->strong);
  frame.state->AssertForeground();
  *isContext = root->strong->IsContext();
  // SetWeak unregisters the strong Cell's value. Its native wrapper remains
  // stable for type/layout, but equality must read the actual live weak edge.
  // Stack roots protect the comparison without changing persistent liveness.
  if (root->weakMode) {
    CHECK(root->weak);
    output.setObject(*root->weak);
  } else {
    CHECK(root->strong->cell().value.initialized());
    output.set(root->strong->cell().value);
  }
}
bool SamePersistentComparisonValues(Frame& frame, JS::HandleValue left,
                                    bool leftContext, JS::HandleValue right,
                                    bool rightContext) {
  if (leftContext || rightContext) {
    return leftContext && rightContext && left.get() == right.get();
  }
  // The persistent and Local forms share actual cross-zone value identity.
  JS::RootedValue a(frame.cx,left),b(frame.cx,right);
  JS::RootedObject global(frame.cx,NativePrimitiveRealm(frame));CHECK(global);
  JSAutoRealm home(frame.cx,global);bool same;
  CHECK(JS_WrapValue(frame.cx,&a)&&JS_WrapValue(frame.cx,&b)&&JS::SameValue(frame.cx,a,b,&same));
  return same;
}
}
bool SamePersistentCellData(const PersistentCell* left, Data* right) {
  const bool empty = PersistentCellIsEmpty(left);
  if (empty || !right) return empty && !right;
  CHECK(Frame::current);
  auto& frame = *Frame::current;
  CHECK(right->cell().context == frame.cx && right->cell().value.initialized());
  JS::RootedValue a(frame.cx), b(frame.cx, right->cell().value);
  bool leftContext;
  ReadPersistentComparisonValue(left, frame, &a, &leftContext);
  return SamePersistentComparisonValues(frame, a, leftContext, b,
                                       right->IsContext());
}
bool SamePersistentCells(const PersistentCell* left,
                         const PersistentCell* right) {
  const bool leftEmpty = PersistentCellIsEmpty(left);
  const bool rightEmpty = PersistentCellIsEmpty(right);
  if (leftEmpty || rightEmpty) return leftEmpty && rightEmpty;
  CHECK(Frame::current);
  auto& frame = *Frame::current;
  JS::RootedValue a(frame.cx), b(frame.cx);
  bool leftContext, rightContext;
  ReadPersistentComparisonValue(left, frame, &a, &leftContext);
  ReadPersistentComparisonValue(right, frame, &b, &rightContext);
  return SamePersistentComparisonValues(frame, a, leftContext, b, rightContext);
}

void WeakenPersistentCell(PersistentCell* cell,bool tenured){
  if(!cell)return;
  CancelGlobalCallback(cell->root);
  if(tenured)MakeGlobalWeakTenured(cell->isolate,cell->root);else MakeGlobalWeak(cell->isolate,cell->root);
}
void WeakenPersistentCell(PersistentCell* cell,std::function<void(Isolate*)> callback){
  CHECK(cell&&callback);auto state=cell->root->state.lock();CHECK(state);
  state->AssertForeground();
  if(Frame::current)CHECK(state==Frame::current->state);
  auto& root=cell->root;
  CHECK(!GlobalRootIsEmpty(root));
  // Promotion can itself collect. Publish the callback only after the target
  // is tenured, while its persistent still protects it throughout promotion.
  CancelGlobalCallback(root);
  if(!root->weakMode){
    // Dropping another native reference from a GC callback can restore its
    // weak persistent without a Frame. Marked roots are already tenured;
    // never request a nested collection or allocate JS metadata here.
    if(!Frame::current||JS::RuntimeHeapIsCollecting())MakeGlobalWeakTenured(cell->isolate,root);
    else MakeGlobalWeak(cell->isolate,root);
  }
  root->weakCallback=std::make_shared<WeakGlobalCallback>(std::move(callback));
}
void StrengthenPersistentCell(PersistentCell* cell){if(cell)MakeGlobalStrong(cell->isolate,cell->root);}
JSObject* BorrowPersistentObject(const PersistentCell* cell){return cell?BorrowGlobalObject(cell->root):nullptr;}

void Isolate::TerminateExecution() {
  auto state = owner.lock();CHECK(state);
  state->cx->requestNativeTermination();
}
bool Isolate::IsExecutionTerminating() {
  auto state = owner.lock();CHECK(state);
  return state->cx->isNativeExecutionTerminating();
}
void Isolate::CancelTerminateExecution() {
  auto state = owner.lock();CHECK(state);
  // No Frame/Realm/Environment access, root mutation or shell job reset here.
  state->cx->cancelNativeTermination();
}
Isolate* Isolate::GetCurrent(){auto* isolate=TryGetCurrent();CHECK(isolate);return isolate;}
Isolate* Isolate::TryGetCurrent(){
  if(IsolateScopeData::current)return &IsolateScopeData::current->owner->isolate;
  return Frame::current?&Frame::current->state->isolate:nullptr;
}
bool Isolate::InContext(){
  auto state=owner.lock();CHECK(state&&state->cx==js::TlsContext.get());
  return JS::CurrentGlobalOrNull(state->cx)!=nullptr;
}
Isolate::DisallowJavascriptExecutionScope::DisallowJavascriptExecutionScope(Isolate* isolate,OnFailure mode){
  CHECK(isolate);owner_=isolate->owner.lock();CHECK(owner_);CHECK(owner_->cx == js::TlsContext.get());
  CHECK(mode==CRASH_ON_FAILURE||mode==THROW_ON_FAILURE);
  mask_=mode==CRASH_ON_FAILURE?JSContext::EmbedderCrashOnExecution:JSContext::EmbedderThrowOnExecution;
  previous_=owner_->cx->embedderExecutionRestrictions()&mask_;
  owner_->cx->setEmbedderExecutionRestrictions(uint8_t(owner_->cx->embedderExecutionRestrictions()|mask_));
}
Isolate::DisallowJavascriptExecutionScope::~DisallowJavascriptExecutionScope(){
  CHECK(owner_->cx == js::TlsContext.get());
  owner_->cx->setEmbedderExecutionRestrictions(uint8_t((owner_->cx->embedderExecutionRestrictions()&~mask_)|previous_));
}
Isolate::AllowJavascriptExecutionScope::AllowJavascriptExecutionScope(Isolate* isolate){
  CHECK(isolate);owner_=isolate->owner.lock();CHECK(owner_);CHECK(owner_->cx == js::TlsContext.get());
  previous_=owner_->cx->embedderExecutionRestrictions();owner_->cx->setEmbedderExecutionRestrictions(0);
}
Isolate::AllowJavascriptExecutionScope::~AllowJavascriptExecutionScope(){
  CHECK(owner_->cx == js::TlsContext.get());owner_->cx->setEmbedderExecutionRestrictions(previous_);
}
uint16_t* Isolate::RegisterEmbedderDataType(const char* name,size_t nativeSize){
  auto state=owner.lock();CHECK(state);state->AssertForeground();CHECK(name&&*name&&nativeSize);
  struct Type {uint16_t id;size_t nativeSize;};
  struct Registry {std::mutex mutex;std::map<std::string,Type> types;uint32_t next=1;};
  // These tokens identify actual registered native C++ types and must remain
  // valid after any individual IsolateData is retired. They have process
  // lifetime, like the engine's native class descriptors, and no JS edges.
  static auto* registry=new Registry;
  std::lock_guard lock(registry->mutex);auto found=registry->types.find(name);
  if(found!=registry->types.end()){CHECK_EQ(found->second.nativeSize,nativeSize);return &found->second.id;}
  CHECK_LE(registry->next,uint32_t(UINT16_MAX));
  auto [entry,inserted]=registry->types.emplace(name,Type{uint16_t(registry->next++),nativeSize});CHECK(inserted);
  return &entry->second.id;
}
void Isolate::LowMemoryNotification(){
#ifdef KANDELO_NATIVE_NODE_ENGINE
  NativeMemoryServices::LowMemory(this);
#else
  auto& frame=Current(this);frame.state->AssertForeground();
  // A low-memory notification requests an actual full shrinking collection.
  // Preserve both the pending thrown value and its saved throw stack.
  JS::AutoSaveExceptionState saved(frame.cx);
  JS::PrepareForFullGC(frame.cx);
  JS::NonIncrementalGC(frame.cx,JS::GCOptions::Shrink,JS::GCReason::API);
  saved.restore();
#endif
}
Local<Primitive> Undefined(Isolate* isolate){return NativeConstant(isolate,&State::undefinedConstant,JS::UndefinedValue());}
void Function::SetName(Local<String> name){
  auto& frame=*Frame::current;JS::RootedObject object(frame.cx,UnwrapObject(frame.cx,cell().value));CHECK(object&&object->is<JSFunction>());
  JSAutoRealm home(frame.cx,object);JS::RootedString string(frame.cx,name->cell().value.toString());
  JS::Rooted<JSAtom*> atom(frame.cx,js::AtomizeString(frame.cx,string));CHECK(atom);
  // Replace a previously resolved own name as well as the VM's function name.
  CHECK(JS_DefineProperty(frame.cx,object,"name",string,JSPROP_READONLY));
  object->as<JSFunction>().setAtom(atom);
}
MaybeLocal<Value> Function::Call(Local<Context> context,Local<Value> receiver,int argc,Local<Value>* argv) {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f,context);if(nativeEntry.Terminated())return {};Context::Scope home(context);CHECK_GE(argc,0);if(JS_IsExceptionPending(f.cx))return {};
  JS::RootedValue callable(f.cx,cell().value),target(f.cx,Input(receiver)),result(f.cx);
  JS::RootedValueVector arguments(f.cx);
  if(!JS_WrapValue(f.cx,&callable)||!JS_WrapValue(f.cx,&target))return {};
  for(int i=0;i<argc;++i){JS::RootedValue value(f.cx,Input(argv[i]));if(!JS_WrapValue(f.cx,&value)||!arguments.append(value))return {};}
  if(!JS::Call(f.cx,target,callable,arguments,&result))return {};return f.OwnValue(result);
}
MaybeLocal<Object> Function::NewInstance(Local<Context> context){return NewInstance(context,0,nullptr);}
MaybeLocal<Object> Function::NewInstance(Local<Context> context,int argc,Local<Value> argv[])const {
  auto& f=Current(context->isolate);NativeEntry nativeEntry(f,context);if(nativeEntry.Terminated())return {};Context::Scope home(context);if(JS_IsExceptionPending(f.cx))return {};
  JS::RootedValue constructor(f.cx,cell().value);JS::RootedObject object(f.cx);
  CHECK(argc>=0&&(argv||!argc));JS::RootedValueVector arguments(f.cx);
  for(int index=0;index<argc;++index){JS::RootedValue value(f.cx,Input(argv[index]));if(!JS_WrapValue(f.cx,&value)||!arguments.append(value))return {};}
  if(!JS_WrapValue(f.cx,&constructor)||!JS::Construct(f.cx,constructor,arguments,&object))return {};
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));return f.Own<Object>(value);
}
bool Function::IsConstructor()const{return cell().value.isObject()&&JS::IsConstructor(&cell().value.toObject());}
Local<Value> CallbackNewTarget(Isolate* isolate){
  auto& frame=Current(isolate);CHECK(frame.arguments);
  JS::RootedValue value(frame.cx,frame.arguments->isConstructing()?frame.arguments->newTarget().get():JS::UndefinedValue());
  return frame.OwnValue(value);
}
void ReturnNull(Isolate* isolate){ReturnRaw(isolate,JS::NullValue());}
Local<Uint32> Uint32::New(Isolate* isolate,uint32_t value){return Integer::NewFromUnsigned(isolate,value).As<Uint32>();}
uint32_t Uint32::Value()const{CHECK(IsUint32());return uint32_t(cell().value.toNumber());}
Local<Integer> Integer::NewFromUnsigned(Isolate* isolate,uint32_t value) {
  auto& f=Current(isolate);JS::RootedValue number(f.cx,JS::NumberValue(double(value)));return f.Own<Uint32>(number);
}
}
#ifndef KANDELO_NATIVE_NODE_ENGINE
namespace kandelo_node_codec_impl {
const JSClass nativeBindingClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(api::NativeWrapperSlotCount)|JSCLASS_FOREGROUND_FINALIZE,&converterOps};
const JSClass nativeChannelClass={"Object",JSCLASS_HAS_RESERVED_SLOTS(api::NativeWrapperSlotCount)|JSCLASS_FOREGROUND_FINALIZE,&converterOps};
struct NativeRealmData {
  Isolate* isolate;
  Global<Object> owner;
  std::map<size_t,BaseObject*> bindings;
  struct ObjectRecord {std::shared_ptr<State> state;bool category=false,converter=false;};
  std::map<BaseObject*,ObjectRecord> objects;
  explicit NativeRealmData(Isolate* isolate,Local<Object> input):isolate(isolate),owner(isolate,input){owner.SetWeak();}
};
Realm::Realm(Isolate* isolate,Local<Object> owner):data_(std::make_unique<NativeRealmData>(isolate,owner)){}
Realm::~Realm(){CHECK(data_->objects.empty()&&data_->bindings.empty());}
Isolate* Realm::isolate(){return data_->isolate;}
IsolateData* Realm::isolate_data(){
  auto state=data_->isolate->owner.lock();CHECK(state);state->AssertForeground();return &state->Legacy().isolateData;
}
uint16_t* IsolateData::embedder_id_for_non_cppgc()const{
  return isolate_->RegisterEmbedderDataType("node.BaseObject",sizeof(BaseObject));
}
Environment* Realm::env(){
  // Original native weak callbacks can destroy an object from a foreground
  // GC with no marshalling Frame. The isolate owns the same canonical State
  // throughout callback registration and explicit environment shutdown.
  auto state=data_->isolate->owner.lock();CHECK(state);
  state->AssertForeground();return &state->Legacy().environment;
}
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
  for(auto& realm:f.state->Legacy().realms){
    auto held=realm->owner();if(held.IsEmpty())continue;
    if(UnwrapObject(f.cx,Input(held))==object)return realm.get();
  }
  JS::RootedValue value(f.cx,JS::ObjectValue(*object));
  auto realm=std::make_unique<Realm>(context->isolate,f.Own<Object>(value));auto* result=realm.get();
  f.state->Legacy().realms.push_back(std::move(realm));return result;
}
Realm* Environment::principal_realm(){auto context=this->context();return context.IsEmpty()?nullptr:Realm::GetCurrent(context);}
bool Environment::can_call_into_js()const{return !data_->stopping&&!data_->closed;}
namespace {
Local<Symbol> ReadEnvironmentSymbol(Environment* environment,const char* name){
  auto& frame=Current(environment->isolate());CHECK(&frame.state->Legacy().environment==environment);
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
struct NativeBaseObjectAccess {
  static bool HasReferences(const BaseObject* object){
    return object->pointer_data_&&object->pointer_data_->strong_ptr_count!=0;
  }
  static bool Detached(const BaseObject* object){
    return object->pointer_data_&&object->pointer_data_->is_detached;
  }
};
bool BaseObjectHasNativeReference(const BaseObject* object){return NativeBaseObjectAccess::HasReferences(object);}
bool BaseObjectIsDetached(const BaseObject* object){return NativeBaseObjectAccess::Detached(object);}
void RetireBaseObjectWrapper(BaseObject* object){
  object->env()->AssertForeground();auto* wrapper=object->persistent().BorrowObject();if(!wrapper)return;
  JS::SetReservedSlot(wrapper,api::NativeOwnerPointer,JS::UndefinedValue());
  HandleScope scope(object->env()->isolate());
  auto& frame=Current(object->env()->isolate());JS::RootedValue value(frame.cx,JS::ObjectValue(*wrapper));
  frame.Own<Object>(value)->SetAlignedPointerInInternalField(BaseObject::kSlot,nullptr,EmbedderDataTag::kDefault);
}
void Realm::TrackBaseObject(BaseObject* object){
  auto state=data_->isolate->owner.lock();CHECK(state);state->AssertForeground();
  auto& frame=Current(data_->isolate);CHECK(frame.state==state);
  JS::RootedObject wrapper(frame.cx,object->persistent().BorrowObject());CHECK(wrapper);
  CHECK(JS::GetReservedSlot(wrapper,api::NativeOwnerPointer).isUndefined());
  const JSClass* clasp=JS::GetClass(wrapper);
  NativeRealmData::ObjectRecord metadata{state,clasp==&categoryClass,clasp==&converterClass};
  CHECK(data_->objects.emplace(object,std::move(metadata)).second);
  JS::RootedValue home(frame.cx,Input(owner()));
  {JSAutoRealm enter(frame.cx,wrapper);CHECK(JS_WrapValue(frame.cx,&home));
   JS::SetReservedSlot(wrapper,api::NativeOwnerRealm,home);JS::SetReservedSlot(wrapper,api::NativeOwnerPointer,JS::PrivateValue(object));}
  if(clasp==&categoryClass)state->Legacy().traceCreated.fetch_add(1);
  if(clasp==&converterClass)state->Legacy().icuCreated.fetch_add(1);
}
void Realm::UntrackBaseObject(BaseObject* object){
  auto found=data_->objects.find(object);CHECK(found!=data_->objects.end());
  auto metadata=std::move(found->second);metadata.state->AssertForeground();
  if(auto* wrapper=object->persistent().BorrowObject())JS::SetReservedSlot(wrapper,api::NativeOwnerPointer,JS::UndefinedValue());
  data_->objects.erase(found);
  for(auto it=data_->bindings.begin();it!=data_->bindings.end();)if(it->second==object)it=data_->bindings.erase(it);else ++it;
  if(metadata.category)metadata.state->Legacy().traceReleased.fetch_add(1);
  if(metadata.converter)metadata.state->Legacy().icuReleased.fetch_add(1);
}
void Realm::RunCleanup(){
  env()->AssertForeground();
  // Binding destructors release detached channel references first. Keep the
  // existing explicit unsupported-shutdown guard for outstanding references.
  while(!data_->bindings.empty()){auto* object=data_->bindings.begin()->second;CHECK(!BaseObjectHasNativeReference(object));RetireBaseObjectWrapper(object);delete object;}
  while(!data_->objects.empty()){
    auto* object=data_->objects.begin()->first;CHECK(!BaseObjectIsDetached(object)&&!BaseObjectHasNativeReference(object));
    RetireBaseObjectWrapper(object);delete object;
  }
}
BaseObject* UnwrapCodecObject(Local<Object> input){
  auto& frame=*Frame::current;frame.state->AssertForeground();
  JS::RootedObject wrapper(frame.cx,UnwrapObject(frame.cx,Input(input)));if(!wrapper)return nullptr;
  if(!api::HasNativeFieldStorage(wrapper))return nullptr;
  auto pointer=JS::GetReservedSlot(wrapper,api::NativeOwnerPointer);if(pointer.isUndefined())return nullptr;
  JS::RootedValue value(frame.cx,JS::ObjectValue(*wrapper));auto local=frame.Own<Object>(value);
  if(!BaseObject::IsBaseObject(&frame.state->Legacy().isolateData,local))return nullptr;
  auto* object=BaseObject::FromJSObject(local);if(!object||pointer.toPrivate()!=object)return nullptr;
  if(object->env()!=&frame.state->Legacy().environment)return nullptr;
  JS::RootedObject owner(frame.cx,&JS::GetReservedSlot(wrapper,api::NativeOwnerRealm).toObject());
  if(!kandelo::node::CheckRealmLibraryActive(frame.cx,owner))return nullptr;
  return object;
}
BaseObject* UnwrapNativeBinding(Local<Object> input){
  auto& frame=*Frame::current;JS::RootedObject wrapper(frame.cx,UnwrapObject(frame.cx,Input(input)));
  if(!wrapper||JS::GetClass(wrapper)!=&nativeBindingClass)return nullptr;
  return UnwrapCodecObject(input);
}
BaseObject* UnwrapSnapshotable(Local<Object> input,EmbedderObjectType type) {
  auto* object=UnwrapNativeBinding(input);
  if(!object||BaseObjectIsDetached(object)||!object->is_snapshotable())return nullptr;
  auto* snapshotable=static_cast<SnapshotableObject*>(object);
  return snapshotable->type()==type?object:nullptr;
}
SnapshotableObject::SnapshotableObject(Realm* realm,Local<Object> wrap,EmbedderObjectType type):BaseObject(realm,wrap),type_(type){}

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
    for(auto [key,value]:std::initializer_list<std::pair<const char*,size_t>>{{"capacity",binding->subscribers_.Length()},{"indexes",binding->channel_indices_.size()},{"nextIndex",binding->next_channel_index_},{"nativeSlots",binding->channels_.size()},{"nativeRealms",state->Legacy().realms.size()}}){
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
  auto channel=native::diagnostics_channel::Channel::Get(&state->Legacy().environment,key);if(JS_IsExceptionPending(cx))return false;
  if(!channel){JS_ReportErrorASCII(cx,"Native diagnostics channel could not be created");return false;}
  if(!std::strcmp(operation.get(),"get")){auto object=channel->object();if(object.IsEmpty())return false;args.rval().set(api::Input(object));return true;}
  if(!std::strcmp(operation.get(),"has")){args.rval().setBoolean(channel->HasSubscribers());return true;}
  if(!std::strcmp(operation.get(),"linked")){args.rval().setBoolean(channel->IsLinked());return true;}
  if(!std::strcmp(operation.get(),"unlink")){channel->Unlink();return true;}
  if(!std::strcmp(operation.get(),"publish")){JS::RootedValue message(cx,args.get(2));if(!JS_WrapValue(cx,&message))return false;channel->Publish(&state->Legacy().environment,frame.OwnValue(message));return !JS_IsExceptionPending(cx);}
  JS_ReportErrorASCII(cx,"Unknown native diagnostics operation");return false;
}
}
bool DefineDiagnosticsTestAPI(JSContext* cx,JS::HandleObject target){return JS_DefineFunction(cx,target,"diagnosticsNative",DiagnosticsNativeControl,2,0);}
}
#endif  // preserved frontend
#endif
