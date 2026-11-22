#ifndef KANDELO_NATIVE_OBJECT_CODECS_INL_H
#define KANDELO_NATIVE_OBJECT_CODECS_INL_H

#include <map>

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
  NativeMemoryServices::LowMemory(this);
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
#endif
