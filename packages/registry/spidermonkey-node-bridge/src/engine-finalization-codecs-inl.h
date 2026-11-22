#ifndef KANDELO_ENGINE_FINALIZATION_CODECS_INL_H
#define KANDELO_ENGINE_FINALIZATION_CODECS_INL_H
#include "builtin/FinalizationRegistryObject.h"

namespace v8 {
NativeFinalizationTasks::NativeFinalizationTasks(Isolate* input,std::shared_ptr<TaskRunner> tasks)
    :isolate(input),cx(input->owner.lock()->cx),runner(std::move(tasks)),state(input->owner){
  CHECK(runner&&runner->NonNestableTasksEnabled());
}
NativeFinalizationTasks::~NativeFinalizationTasks(){
  CHECK(!cx&&!accepting&&!running&&pending.empty()&&!runner&&postedTicket.load()==0);
}
void NativeFinalizationTasks::AssertForeground()const{
  CHECK(foreground==std::this_thread::get_id());
  CHECK(!cx||cx==js::TlsContext.get());
}
void NativeFinalizationTasks::Notify(JSFunction* cleanup,JSObject*,void* raw){
  auto& owner=*static_cast<NativeFinalizationTasks*>(raw);
  // The original SM main-thread sweep exposed this function before calling
  // us. Native allocation/root registration is allowed; no operation here can
  // allocate a JS object, collect, enter a realm or run user JavaScript.
  // Node uses the registry function's own realm, not HTML incumbent settings.
  owner.Post(cleanup);
}
void NativeFinalizationTasks::Post(JSFunction* function){
  AssertForeground();CHECK(accepting&&cx&&function);
  try {
    auto record=std::make_unique<NativeFinalizationRecord>(cx,function);
    pending.push_back(std::move(record));PostNext(true);
  }catch(const std::bad_alloc&){
    bridge::FatalOutOfMemory(isolate,"Finalization cleanup delivery metadata",false);
  }
}
void NativeFinalizationTasks::PostNext(bool allowBlocked){
  AssertForeground();
  if(!accepting||pending.empty()||postedTicket.load())return;
  if(!allowBlocked&&(cx->isExceptionPending()||cx->isNativeExecutionTerminating()||
                    cx->embedderExecutionRestrictions()))return;
  try {
    CHECK(nextTicket!=UINT64_MAX);uint64_t ticket=++nextTicket;
    auto delivery=std::make_unique<Delivery>(shared_from_this(),ticket);
    postedTicket.store(ticket);runner->PostNonNestableTask(std::move(delivery));
  }catch(const std::bad_alloc&){
    bridge::FatalOutOfMemory(isolate,"Finalization cleanup task allocation",false);
  }
}
void NativeFinalizationTasks::Run(){
  AssertForeground();if(!accepting)return;
  CHECK(cx&&!running&&!cx->activation());js::AssertHeapIsIdle();
  // Preserve an existing failure and keep the roots pending. A future normal
  // API completion can wake this ledger after recovery; never busy-repost.
  if(cx->isExceptionPending()||cx->isNativeExecutionTerminating()||
     cx->embedderExecutionRestrictions())return;
  if(pending.empty())return;
  auto record=std::move(pending.front());pending.pop_front();
  auto owner=state.lock();CHECK(owner && &owner->isolate==isolate);
  running=true;auto finish=mozilla::MakeScopeExit([&]{running=false;PostNext();});
  Isolate::Scope isolateScope(isolate);HandleScope handles(isolate);
  auto& frame=Current(isolate);
  JS::RootedObject function(cx,record->function);
  CHECK(function&&function->is<JSFunction>());
  JS::RootedObject global(cx,JS::GetNonCCWObjectGlobal(function));
  auto context=frame.OwnContext(global);Context::Scope home(context);
  MicrotasksScope annotation(context,MicrotasksScope::kDoNotRunMicrotasks);
  NativeEntry entry(frame,context);
  JS::Rooted<js::FinalizationQueueObject*> queue(cx,
      js::FinalizationQueueObject::fromCleanupFunction(&function->as<JSFunction>()));
  JS::RootedValue callable(cx,JS::ObjectValue(*function)),result(cx);
  bool success=JS::Call(cx,JS::UndefinedHandleValue,callable,JS::HandleValueArray::empty(),&result);
  // Original doCleanup clears the scheduled flag before invoking callbacks.
  // Retain Node's retry of remaining records after a throwing callback, while
  // respecting a task already queued by GC/reentry during that callback.
  if(queue->hasRegistry()&&queue->hasRecordsToCleanUp()&&!queue->isQueuedForCleanup()){
    queue->setQueuedForCleanup(true);Post(&function->as<JSFunction>());
  }
  if(!success&&!cx->isNativeExecutionTerminating())(void)bridge::ReportMicrotaskException(isolate);
}
void NativeFinalizationTasks::Shutdown(){
  AssertForeground();CHECK(cx&&accepting&&!running);
  accepting=false;postedTicket.store(0);
  // Do not run doCleanup or read user callbacks during native retirement.
  // Delivery wrappers keep only this closed native control object afterward.
  pending.clear();runner.reset();state.reset();cx=nullptr;
}
}
#endif
