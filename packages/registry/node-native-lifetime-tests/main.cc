// Test-only native companions for the changed Node/SpiderMonkey lifetime contracts.
// The complete Node libraries and original embedding/Environment policy are used.
#include "node.h"
#include "env-inl.h"
#include "uv.h"
#include "node-native-test-engine-state.h"
#include "js/Exception.h"
#include "js/Context.h"
#include "internal/vm/JSContext.h"
#include "internal/vm/JSAtomState.h"
#include "js/SliceBudget.h"
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace {
using v8::Context;
using v8::HandleScope;
using v8::Isolate;
using v8::Local;
using v8::Value;

void Require(bool value, const char* message) {
  if (!value) {
    std::fprintf(stderr, "native-lifetime FAIL: %s\n", message);
    std::fflush(stderr);
    std::abort();
  }
}
Local<v8::String> Text(Isolate* isolate, const char* text) {
  return v8::String::NewFromUtf8(isolate, text).ToLocalChecked();
}
std::string CopyText(Isolate*, Local<v8::String>);
v8::MaybeLocal<Value> Evaluate(Local<Context> context, const char* source) {
  Local<v8::Script> script;
  if (!v8::Script::Compile(context, Text(Isolate::GetCurrent(), source)).ToLocal(&script)) return {};
  return script->Run(context);
}
Local<Value> Run(Local<Context> context, const char* source) {
  v8::TryCatch caught(Isolate::GetCurrent());
  Local<Value> result;
  if (!Evaluate(context, source).ToLocal(&result)) {
    if (caught.HasCaught() && !caught.HasTerminated()) {
      const auto text = CopyText(Isolate::GetCurrent(), caught.Message()->Get());
      std::fprintf(stderr, "native-lifetime exception: %s\n", text.c_str());
    }
    Require(false, "unexpected script failure");
  }
  return result;
}
void Truth(Local<Context> context, const char* source) {
  HandleScope scope(Isolate::GetCurrent());
  Require(Run(context, source)->IsTrue(), "JavaScript assertion returned false");
}
struct Cleanup {
  std::thread::id owner = std::this_thread::get_id();
  std::vector<int> order;
  struct Entry { Cleanup* owner; int value; } first{this, 1}, second{this, 2};
  Cleanup() { order.reserve(2); }
  static void Call(void* raw) {
    auto* entry = static_cast<Entry*>(raw);
    Require(entry->owner->owner == std::this_thread::get_id(), "cleanup changed threads");
    entry->owner->order.push_back(entry->value);
  }
  void Install(Isolate* isolate) {
    node::AddEnvironmentCleanupHook(isolate, Call, &first);
    node::AddEnvironmentCleanupHook(isolate, Call, &second);
  }
  void Check() { Require(order == std::vector<int>({2, 1}), "original cleanup hooks did not run once in reverse order"); }
};
struct WeakScript {
  v8::Global<v8::Object> handle;
  std::thread::id owner = std::this_thread::get_id();
  int collected = 0;
  static void Collected(const v8::WeakCallbackInfo<WeakScript>& info) {
    auto* record = info.GetParameter();
    Require(record->owner == std::this_thread::get_id(), "weak callback changed threads");
    record->handle.Reset();
    ++record->collected;
  }
};
void ScriptGC(Isolate* isolate, Local<Context> context) {
  Truth(context, "require('node:vm'); true");
  isolate->LowMemoryNotification();
  auto* heap = isolate->GetCppHeap();
  Require(heap != nullptr, "Node has no real native wrapper heap");
  const auto before = heap->NativeObjectBytes();
  WeakScript script;
  {
    HandleScope scope(isolate);
    auto value = Run(context, "(()=>{const s=new (require('node:vm').Script)('40+2');s.self=s;return s;})()");
    Require(value->IsObject(), "ContextifyScript did not return its real wrapper");
    script.handle.Reset(isolate, value.As<v8::Object>());
  }
  Require(heap->NativeObjectBytes() > before, "ContextifyScript native allocation was not accounted");
  for (int pass = 0; pass < 3; ++pass) isolate->LowMemoryNotification();
  {
    HandleScope scope(isolate);
    auto object = script.handle.Get(isolate);
    auto method = object->Get(context, Text(isolate, "runInThisContext")).ToLocalChecked();
    auto result = method.As<v8::Function>()->Call(context, object, 0, nullptr).ToLocalChecked();
    Require(result->Int32Value(context).FromJust() == 42, "rooted compiled script lost code during collection");
  }
  script.handle.SetWeak(&script, WeakScript::Collected, v8::WeakCallbackType::kParameter);
  for (int pass = 0; pass < 3; ++pass) isolate->LowMemoryNotification();
  Require(script.handle.IsEmpty() && script.collected == 1, "unreachable cyclic script wrapper did not die exactly once");
  Require(heap->NativeObjectBytes() <= before, "unreachable compiled-script native storage was retained");
  std::printf("observed compiled-script-root, cyclic-weak-death, native-storage-retirement\n");
}
struct Interrupts {
  Isolate* isolate;
  std::thread::id owner = std::this_thread::get_id();
  std::vector<int> order;
  std::atomic<bool> entered{false}, done{false};
  struct Entry { Interrupts* owner; int id; Entry* next; };
  Entry fourth{this, 4, nullptr}, first{this, 1, &fourth}, second{this, 2, nullptr}, third{this, 3, nullptr}, active{this, 5, nullptr};
  explicit Interrupts(Isolate* input) : isolate(input) { order.reserve(8); }
  static void Call(Isolate* isolate, void* raw) {
    auto* entry = static_cast<Entry*>(raw); auto& state = *entry->owner;
    Require(state.owner == std::this_thread::get_id() && isolate == state.isolate, "interrupt changed JS owner/thread");
    state.order.push_back(entry->id);
    if (entry->next) isolate->RequestInterrupt(Call, entry->next);
    if (entry->id == 5) state.done.store(true, std::memory_order_release);
  }
  static void NativeDone(const v8::FunctionCallbackInfo<Value>& info) {
    auto* state = static_cast<Interrupts*>(info.Data().As<v8::External>()->Value());
    state->entered.store(true, std::memory_order_release);
    info.GetReturnValue().Set(state->done.load(std::memory_order_acquire));
  }
};
void InterruptFIFO(Isolate* isolate, Local<Context> context, node::Environment* env) {
  Interrupts state(isolate);
  std::thread producer([&] {
    isolate->RequestInterrupt(Interrupts::Call, &state.first);
    isolate->RequestInterrupt(Interrupts::Call, &state.second);
    isolate->RequestInterrupt(Interrupts::Call, &state.third);
  });
  producer.join();
  isolate->DrainNativeInterruptsForCleanup();
  Require(state.order == std::vector<int>({1, 2, 3, 4}), "native drain lost FIFO or callbacks posted by callbacks");
  auto function = v8::Function::New(context, Interrupts::NativeDone, v8::External::New(isolate, &state)).ToLocalChecked();
  Require(context->Global()->Set(context, Text(isolate, "nativeDone"), function).FromJust(), "native handshake installation failed");
  std::thread active([&] {
    while (!state.entered.load(std::memory_order_acquire)) std::this_thread::yield();
    isolate->RequestInterrupt(Interrupts::Call, &state.active);
  });
  Truth(context, "while(!nativeDone()){}; true");
  active.join();
  Require(state.order == std::vector<int>({1, 2, 3, 4, 5}), "running JavaScript did not receive its real engine interrupt");
  int idle = 0;
  std::thread idle_producer([&] { node::RequestInterrupt(env, [](void* raw) { ++*static_cast<int*>(raw); }, &idle); });
  idle_producer.join();
  Require(node::SpinEventLoop(env).FromMaybe(1) == 0 && idle == 1, "idle Environment request was not delivered exactly once");
  Require(context->Global()->Delete(context, Text(isolate, "nativeDone")).FromJust(), "native handshake removal failed");
  std::printf("observed cross-thread-FIFO, recursive-post, active-JS-wakeup, idle-Environment-delivery, producer-join\n");
}
void FailureState(Isolate* isolate, Local<Context> context) {
  int calls = 0;
  auto callback = [](Isolate*, void* raw) { ++*static_cast<int*>(raw); };
  {
    v8::TryCatch caught(isolate);
    auto original = v8::Exception::Error(Text(isolate, "original-native-cleanup-error"));
    isolate->ThrowException(original);
    isolate->RequestInterrupt(callback, &calls);
    isolate->DrainNativeInterruptsForCleanup();
    Require(calls == 1 && caught.HasCaught() && caught.Exception()->StrictEquals(original), "native cleanup replaced the original exception");
    caught.Reset();
  }
  {
    v8::TryCatch denied(isolate);
    Isolate::DisallowJavascriptExecutionScope no_js(isolate, Isolate::DisallowJavascriptExecutionScope::THROW_ON_FAILURE);
    Require(Evaluate(context, "globalThis.deniedSideEffect=true").IsEmpty(), "no-JavaScript scope admitted execution");
    Require(denied.HasCaught() && !denied.HasTerminated(), "execution denial lost its catchable failure");
    denied.Reset();
  }
  Truth(context, "typeof deniedSideEffect==='undefined'");
  isolate->TerminateExecution();
  isolate->RequestInterrupt(callback, &calls);
  isolate->DrainNativeInterruptsForCleanup();
  // A published stop can be cancelled before any JavaScript executes.
  isolate->CancelTerminateExecution();
  Truth(context, "true");
  Require(calls == 2 && !isolate->IsExecutionTerminating(), "request/cancel or native stop retirement failed");
  {
    v8::TryCatch stopped(isolate);
    isolate->TerminateExecution();
    Require(Evaluate(context, "globalThis.stopSideEffect=true").IsEmpty(), "requested termination admitted JavaScript");
    Require(stopped.HasTerminated() && isolate->IsExecutionTerminating(), "termination was converted to a catchable error");
    isolate->RequestInterrupt(callback, &calls);
    isolate->DrainNativeInterruptsForCleanup();
    Require(isolate->IsExecutionTerminating() && calls == 3, "native drain cleared active termination");
    isolate->CancelTerminateExecution();
  }
  Truth(context, "typeof stopSideEffect==='undefined'");
  std::printf("observed pending-error-identity, no-JS-denial, request-cancel, active-stop-preservation\n");
}
void SiblingCleanup(Isolate* isolate, Local<Context> context, node::CommonEnvironmentSetup* setup,
                    const std::vector<std::string>& args, const std::vector<std::string>& exec_args) {
  Cleanup sibling_cleanup;
  int interrupts = 0;
  node::Environment* sibling = nullptr;
  {
    HandleScope scope(isolate);
    auto other = node::NewContext(isolate);
    Require(!other.IsEmpty(), "sibling context creation failed");
    Context::Scope entered(other);
    sibling = node::CreateEnvironment(setup->isolate_data(), other, args, exec_args, node::EnvironmentFlags::kNoFlags);
    Require(sibling != nullptr, "sibling Environment creation failed");
    Require(!node::LoadEnvironment(sibling, "globalThis.siblingLoaded=true;").IsEmpty(), "sibling bootstrap failed");
    sibling_cleanup.Install(isolate);
  }
  Truth(context, "globalThis.liveSiblingTicks=0;setTimeout(()=>{liveSiblingTicks++},0);true");
  node::RequestInterrupt(sibling, [](void* raw) { ++*static_cast<int*>(raw); }, &interrupts);
  Require(interrupts == 0, "test request was delivered before native disposal began");
  {
    Isolate::DisallowJavascriptExecutionScope outer(isolate, Isolate::DisallowJavascriptExecutionScope::THROW_ON_FAILURE);
    node::FreeEnvironment(sibling);
  }
  sibling_cleanup.Check();
  Require(interrupts == 1, "FreeEnvironment did not retire its pending native callback");
  Require(node::SpinEventLoop(setup->env()).FromMaybe(1) == 0, "live sibling did not complete its ordinary event loop");
  Truth(context, "liveSiblingTicks===1");
  std::printf("observed original-cleanup-order, pending-request-retirement, scope-after-Environment, live-sibling-progress\n");
}
struct OwnedDiagnostic {
  v8::NativeCompileDiagnosticKind kind;
  uint32_t code;
  uint16_t actual, expected;
  uint8_t origin;
  bool escaped, in_module, has_name, has_word, has_identifier;
  std::string name, word, identifier;
  bool operator==(const OwnedDiagnostic&) const = default;
};
std::string CopyText(Isolate* isolate, Local<v8::String> text) {
  if (text.IsEmpty()) return {};
  const auto length = v8::String::Utf8Length(isolate, text);
  std::vector<char> bytes(length + 1);
  Require(v8::String::WriteUtf8(isolate, text, bytes.data(), bytes.size(),
      v8::String::Utf8EncodingFlag::kNullTerminate) == bytes.size(), "diagnostic UTF8 copy failed");
  return std::string(bytes.data(), length);
}
OwnedDiagnostic CopyDiagnostic(Isolate* isolate, Local<v8::Message> message) {
  const auto value = message->GetNativeCompileDiagnostic();
  return {value.kind, value.engineCode, value.actualToken, value.expectedToken,
      value.origin, value.escaped, value.inModule, !value.engineName.IsEmpty(),
      !value.word.IsEmpty(), !value.identifier.IsEmpty(), CopyText(isolate, value.engineName),
      CopyText(isolate, value.word), CopyText(isolate, value.identifier)};
}
void DiagnosticOwnership(Isolate* isolate, Local<Context> context) {
  v8::Global<Value> retained;
  OwnedDiagnostic expected{};
  {
    HandleScope scope(isolate); v8::TryCatch caught(isolate);
    Require(Evaluate(context, "const \\u0063lass=1").IsEmpty() && caught.HasCaught(), "escaped keyword fixture did not fail");
    auto error = caught.Exception();
    expected = CopyDiagnostic(isolate, v8::Exception::CreateMessage(isolate, error));
    Require(expected.code != 0 && expected.escaped && expected.word == "class", "actual escaped-keyword diagnostic was not captured");
    retained.Reset(isolate, error); caught.Reset();
  }
  {
    HandleScope scope(isolate); v8::TryCatch caught(isolate);
    Require(Evaluate(context, "let duplicate;let duplicate").IsEmpty() && caught.HasCaught(), "nested redeclaration fixture did not fail");
    auto nested = CopyDiagnostic(isolate, caught.Message());
    Require(nested.code != expected.code, "nested diagnostic did not distinguish parser errors");
    caught.Reset();
  }
  for (int pass = 0; pass < 3; ++pass) isolate->LowMemoryNotification();
  auto actual = CopyDiagnostic(isolate, v8::Exception::CreateMessage(isolate, retained.Get(isolate)));
  Require(actual == expected, "owned parser diagnostic changed across nested error/report copies and collection");
  retained.Reset();
  std::printf("observed parser-report-copy, nested-error-isolation, diagnostic-GC-retention\n");
}

void ExecutionScopes(Isolate* isolate, Local<Context> context) {
  auto object=Run(context,"({get x(){globalThis.forbidden=(forbidden||0)+1;return 1}})").As<v8::Object>();
  auto function=Run(context,"(function(){globalThis.forbidden=(forbidden||0)+1;return 1})").As<v8::Function>();
  auto constructor=Run(context,"(function C(){globalThis.forbidden=(forbidden||0)+1})").As<v8::Function>();
  Truth(context,"globalThis.forbidden=0; true");
  auto other=node::NewContext(isolate);Require(!other.IsEmpty(),"second realm missing");
  auto deny=[&](auto attempt){v8::TryCatch caught(isolate);Require(attempt(),"forbidden entry returned success");Require(caught.HasCaught()&&!caught.HasTerminated(),"denial did not produce catchable failure");caught.Reset();};
  {
    Isolate::DisallowJavascriptExecutionScope outer(isolate,Isolate::DisallowJavascriptExecutionScope::THROW_ON_FAILURE);
    deny([&]{return object->Get(context,Text(isolate,"x")).IsEmpty();});
    deny([&]{return function->Call(context,context->Global(),0,nullptr).IsEmpty();});
    deny([&]{return constructor->NewInstance(context,0,nullptr).IsEmpty();});
    { Context::Scope entered(other); deny([&]{return Evaluate(other,"globalThis.crossRealmSideEffect=1").IsEmpty();}); }
    { Isolate::AllowJavascriptExecutionScope allowed(isolate);Truth(context,"++forbidden===1");
      { Isolate::DisallowJavascriptExecutionScope inner(isolate,Isolate::DisallowJavascriptExecutionScope::THROW_ON_FAILURE);deny([&]{return Evaluate(context,"++forbidden").IsEmpty();}); }
      Truth(context,"++forbidden===2");
    }
    deny([&]{return Evaluate(context,"++forbidden").IsEmpty();});
    { v8::TryCatch caught(isolate);auto error=v8::Exception::Error(Text(isolate,"existing-before-denial"));isolate->ThrowException(error);
      Require(function->Call(context,context->Global(),0,nullptr).IsEmpty(),"pending error admitted call");
      Require(caught.HasCaught()&&caught.Exception()->StrictEquals(error),"denial replaced pending ordinary error");caught.Reset(); }
  }
  Truth(context,"forbidden===2");
  {Context::Scope entered(other);Truth(other,"typeof crossRealmSideEffect==='undefined'");}
  std::printf("observed getter-call-construct-cross-realm-denial, nested-allow-restore, existing-error-preservation\n");
}
void GCPhases(Isolate* isolate, Local<Context> context) {
  auto state=isolate->owner.lock();Require(bool(state),"no real engine state");auto* cx=state->cx;
  Truth(context,"require('node:vm');true");isolate->LowMemoryNotification();
  auto* heap=isolate->GetCppHeap();const auto before=heap->NativeObjectBytes();
  Truth(context,"(()=>{const {Script}=require('node:vm');for(let n=0;n<12;n++){let caught=false;try{new Script('const = ;')}catch(e){if(!(e instanceof SyntaxError))throw e;caught=true}if(!caught)throw Error('invalid compiled script succeeded')}return true})()");
  isolate->LowMemoryNotification();
  Require(heap->NativeObjectBytes()<=before,"failed original ContextifyScript construction retained native storage");
  // An abandoned construction lease models failure before publication. It does
  // not execute a fake Contextify constructor or replace Node lifetime policy.
  int destroys=0;
  {
    cppgc::internal::Construction lease(heap->GetAllocationHandle(),64,alignof(std::max_align_t),
      [](void*,cppgc::Visitor*){},[](void*){Require(false,"unconstructed object destructor ran");});
    Require(heap->NativeObjectBytes()==before+64,"construction lease was not accounted");
  }
  Require(heap->NativeObjectBytes()==before&&destroys==0,"partial allocation did not roll back");
  Truth(context,"globalThis.gcRetained=new(require('node:vm').Script)('21*2');gcRetained.self=gcRetained;globalThis.gcPressure=Array.from({length:20000},(_,n)=>({n,next:{n}}));true");
  // ESR embedding defaults disable incremental GC. Enable it explicitly for
  // this stress phase and restore the original setting afterward.
  const auto incremental=JS_GetGCParameter(cx,JSGC_INCREMENTAL_GC_ENABLED);
  JS_SetGCParameter(cx,JSGC_INCREMENTAL_GC_ENABLED,1);
  Require(JS::IsIncrementalGCEnabled(cx),"incremental stress could not be enabled");
  // Prepare compilation, keys and values before the collection. Compiling a
  // fresh validation script can itself finish an incremental cycle.
  auto target=Run(context,"gcRetained.extra=null;gcRetained").As<v8::Object>();
  auto extra=Run(context,"({value:42})");auto key=Text(isolate,"extra");
  auto check=v8::Script::Compile(context,Text(isolate,
      "gcRetained.runInThisContext()===42 && gcRetained.extra.value===42")).ToLocalChecked();
  JS::PrepareForFullGC(cx);JS::StartIncrementalGC(cx,JS::GCOptions::Normal,JS::GCReason::API,JS::SliceBudget(JS::WorkBudget(1)));
  Require(JS::IsIncrementalGCInProgress(cx),"test did not enter an actual incremental collection");
  // WasIncrementalGC describes the current/most recent slice. Finish runs
  // with an unlimited budget and resets that flag; observe it while active.
  Require(JS::WasIncrementalGC(JS_GetRuntime(cx)),"collector did not report incremental work");
  Require(target->Set(context,key,extra).FromMaybe(false),"native incremental mutation failed");
  Require(JS::IsIncrementalGCInProgress(cx),"incremental mutation did not overlap the collection");
  Require(check->Run(context).ToLocalChecked()->IsTrue(),"native script did not survive incremental execution");
  // The mutator may naturally finish the cycle. The engine requires an
  // active cycle for FinishIncrementalGC; never call it on an idle collector.
  if(JS::IsIncrementalGCInProgress(cx))JS::FinishIncrementalGC(cx,JS::GCReason::API);
  Require(!JS::IsIncrementalGCInProgress(cx),"incremental collection did not finish");
  JS_SetGCParameter(cx,JSGC_INCREMENTAL_GC_ENABLED,incremental);
  Truth(context,"gcRetained.runInThisContext()===42 && gcRetained.extra.value===42");
  isolate->LowMemoryNotification();
  Truth(context,"gcRetained.runInThisContext()===42;delete globalThis.gcRetained;delete globalThis.gcPressure;true");
  isolate->LowMemoryNotification();
  // Deliberately install the engine's actual OOM state. This is a labelled
  // failure-state injection, not an allocation-failure or report-copy-OOM test.
  JS::RootedValue oom(cx,JS::StringValue(cx->names().out_of_memory_));
  cx->restorePendingExceptionState(JS::ExceptionStatus::OutOfMemory,oom,nullptr);
  Require(JS_IsThrowingOutOfMemory(cx),"engine did not install injected OOM state");
  int callbacks=0;isolate->RequestInterrupt([](Isolate*,void* raw){++*static_cast<int*>(raw);},&callbacks);
  isolate->DrainNativeInterruptsForCleanup();
  Require(callbacks==1&&JS_IsThrowingOutOfMemory(cx)&&!isolate->IsExecutionTerminating(),"native drain changed OOM into termination");
  JS_ClearPendingException(cx);Truth(context,"true");
  std::printf("observed partial-construction-rollback, real-incremental-GC, shrinking-GC, injected-OOM-preservation\n");
}
struct AsyncCleanup {
  uv_timer_t timer{};void(*done)(void*)=nullptr;void* done_arg=nullptr;int calls=0;
  static void Start(void* raw,void(*cb)(void*),void* arg) {
    auto* self=static_cast<AsyncCleanup*>(raw);++self->calls;self->done=cb;self->done_arg=arg;
    Require(uv_timer_start(&self->timer,[](uv_timer_t* timer){
      uv_close(reinterpret_cast<uv_handle_t*>(timer),[](uv_handle_t* handle){auto* state=static_cast<AsyncCleanup*>(handle->data);state->done(state->done_arg);});
    },25,0)==0,"async cleanup timer failed");
  }
};
void SharedLoopCleanup(Isolate* isolate,Local<Context> context,node::CommonEnvironmentSetup* setup,
 const std::vector<std::string>& args,const std::vector<std::string>& exec_args) {
  node::Environment* sibling;AsyncCleanup async;node::AsyncCleanupHookHandle hook;int pending=0;
  {
    HandleScope scope(isolate);auto other=node::NewContext(isolate);Context::Scope entered(other);
    sibling=node::CreateEnvironment(setup->isolate_data(),other,args,exec_args,node::EnvironmentFlags::kNoFlags);
    Require(sibling!=nullptr,"sibling construction failed");
    // Publish before LoadEnvironment initializes the original async transport.
    node::RequestInterrupt(sibling,[](void* raw){++*static_cast<int*>(raw);},&pending);
    Require(!node::LoadEnvironment(sibling,"globalThis.siblingStarted=true").IsEmpty(),"sibling load failed");
    Require(uv_timer_init(setup->event_loop(),&async.timer)==0,"cleanup handle initialization failed");async.timer.data=&async;
    hook=node::AddEnvironmentCleanupHook(isolate,AsyncCleanup::Start,&async);
  }
  Truth(context,"globalThis.duringCleanup=0;setTimeout(()=>{duringCleanup++},0);true");
  node::FreeEnvironment(sibling);
  Require(pending==1&&async.calls==1,"early native request or async cleanup was not retired exactly once");
  Truth(context,"duringCleanup===1");
  hook.reset();
  std::printf("observed pre-bootstrap-interrupt, asynchronous-handle-close, live-sibling-JS-during-cleanup\n");
}

void HandleIdentity(Isolate* isolate,Local<Context> context,node::Environment* env) {
  auto native=env->source_text_module_default_hdo();Local<Value> value=native;
  Require(value==native&&native==value&&value->StrictEquals(native),"heterogeneous Local symbol identity failed");
  auto exported=Run(context,"require('internal/test/binding').internalBinding('symbols').source_text_module_default_hdo");
  std::printf("native-symbol-identity local=%d value=%d\n",exported==native,exported->StrictEquals(native));
  Require(exported==native&&native==exported&&exported->StrictEquals(native),"original Node native/JS symbol owners disagree");
  v8::Global<v8::Symbol> retained(isolate,native);
  Require(retained==exported&&exported==retained,"persistent/Local cross-zone symbol identity failed");
  isolate->LowMemoryNotification();
  Require(retained==exported&&exported==retained,"persistent symbol identity changed across shrinking collection");
  retained.Reset();
  Run(context,"globalThis.metaDone=false;globalThis.metaError=undefined;require('internal/modules/esm/loader').getOrInitializeCascadedLoader().import('data:text/javascript,globalThis.metaUrl%3Dimport.meta.url',undefined,{}).then(()=>{metaDone=true},e=>{metaError=e;metaDone=true});");
  Require(node::SpinEventLoop(env).FromMaybe(1)==0,"module metadata loop failed");
  if(!Run(context,"metaError===undefined")->IsTrue()){
    auto text=CopyText(isolate,Run(context,"String(metaError.stack)").As<v8::String>());
    std::fprintf(stderr,"module-meta-error: %s\n",text.c_str());
  }
  Truth(context,"metaDone&&metaError===undefined&&metaUrl.startsWith('data:')");
  std::printf("observed original-Node-native-JS-symbol-identity, original-module-import-meta\n");
}


void ModuleMetadata(Isolate* isolate) {
  const std::u16string text=u"export const emoji='😺';import x from './dep.json' with {type:'json'};";
  const auto offset=text.find(u"type");Require(offset!=std::u16string::npos,"metadata fixture has no key");
  auto code=v8::String::NewFromTwoByte(isolate,reinterpret_cast<const uint16_t*>(text.data()),v8::NewStringType::kNormal,int(text.size())).ToLocalChecked();
  v8::ScriptOrigin origin(Text(isolate,"file:///tmp/native-attributes.mjs"),0,0,false,-1,{},false,false,true);
  auto check=[&](Local<v8::Module> module){
    auto requests=module->GetModuleRequests();Require(requests->Length()==1,"static module request missing");
    auto attributes=requests->Get(0).As<v8::ModuleRequest>()->GetImportAttributes();
    Require(attributes->Length()==3,"static attributes are not key/value/source triples");
    Require(CopyText(isolate,attributes->Get(0).As<v8::String>())=="type"&&CopyText(isolate,attributes->Get(1).As<v8::String>())=="json","attribute values lost");
    Require(attributes->Get(2).As<v8::Int32>()->Value()==int(offset),"source position is not actual parser UTF16 key offset");
  };
  v8::ScriptCompiler::Source source(code,origin);
  auto module=v8::ScriptCompiler::CompileModule(isolate,&source).ToLocalChecked();check(module);
  std::unique_ptr<v8::ScriptCompiler::CachedData> bytes(v8::ScriptCompiler::CreateCodeCache(module->GetUnboundModuleScript()));Require(bytes&&bytes->length>0,"module code cache missing");
  auto* borrowed=new v8::ScriptCompiler::CachedData(bytes->data,bytes->length);
  v8::ScriptCompiler::Source decoded(code,origin,borrowed);
  auto restored=v8::ScriptCompiler::CompileModule(isolate,&decoded,v8::ScriptCompiler::kConsumeCodeCache).ToLocalChecked();
  Require(!decoded.GetCachedData()->rejected,"same-build module cache was rejected");check(restored);
  std::printf("observed static-import-values, parser-UTF16-position, module-stencil-cache-roundtrip\n");
}

void UndiciLifetime(Isolate* isolate, Local<Context> context) {
  // Cached assertion-module initialization is process state, not a parser
  // allocation. Include it before measuring parser and backing-store retirement.
  Truth(context, "require('internal/test/binding').internalBinding('undici_llhttp'); require('node:assert/strict'); true");
  isolate->LowMemoryNotification();
  auto* heap = isolate->GetCppHeap();
  Require(heap != nullptr, "native parser has no real wrapper collector");
  const auto before = heap->NativeObjectBytes();
  v8::HeapStatistics initial;
  isolate->GetHeapStatistics(&initial);
  WeakScript parser;
  {
    HandleScope scope(isolate);
    auto value = Run(context, R"JS((()=>{
      const assert=require('node:assert/strict');
      const create=require('internal/test/binding').internalBinding('undici_llhttp').createInstance;
      let owner,ptr;
      const imports=Object.fromEntries(['url','status','header_field','header_value','headers_complete','message_begin','body','message_complete'].map(name=>['wasm_on_'+name,(p)=>{assert.equal(p,ptr);assert.ok(owner.exports);gc();return 0;}]));
      owner=create({env:imports});ptr=owner.exports.llhttp_alloc(2);
      const bytes=Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial');
      const at=owner.exports.malloc(512*1024);
      new Uint8Array(owner.exports.memory.buffer,at,bytes.length).set(bytes);
      assert.equal(owner.exports.llhttp_execute(ptr,at,bytes.length),0);
      owner.self=owner;return owner;
    })())JS");
    Require(value->IsObject(), "native parser factory did not return its real owner");
    parser.handle.Reset(isolate, value.As<v8::Object>());
  }
  Require(heap->NativeObjectBytes() > before, "native parser wrapper allocation was not accounted");
  for (int pass = 0; pass < 3; ++pass) isolate->LowMemoryNotification();
  Require(!parser.handle.IsEmpty(), "rooted native parser died during callback collection");
  parser.handle.SetWeak(&parser, WeakScript::Collected, v8::WeakCallbackType::kParameter);
  for (int pass = 0; pass < 3; ++pass) isolate->LowMemoryNotification();
  Require(parser.handle.IsEmpty() && parser.collected == 1, "cyclic native parser did not die exactly once");
  Require(heap->NativeObjectBytes() <= before, "native parser owner storage was retained");
  v8::HeapStatistics final;
  isolate->GetHeapStatistics(&final);
  Require(final.external_memory() <= initial.external_memory(), "native parser/buffer external allocation credit was retained");
  std::printf("observed parser-callback-GC, traced-cycle-death, native-parser-buffer-credit-retirement\n");
}

void FatalBoundary(const std::string& mode,node::MultiIsolatePlatform* platform,
                   const std::vector<std::string>& args,const std::vector<std::string>& exec_args) {
  uv_loop_t loop;Require(uv_loop_init(&loop)==0,"fatal-boundary loop creation failed");
  auto allocator=node::ArrayBufferAllocator::Create();
  auto* isolate=node::NewIsolate(allocator.get(),&loop,platform);Require(isolate!=nullptr,"fatal-boundary original isolate creation failed");
  v8::Locker locker(isolate);Isolate::Scope entered(isolate);HandleScope handles(isolate);
  auto context=node::NewContext(isolate);Require(!context.IsEmpty(),"fatal-boundary context creation failed");Context::Scope realm(context);
  if(mode=="fatal-after-env") {
    auto* data=node::CreateIsolateData(isolate,&loop,platform,allocator.get());Require(data!=nullptr,"fatal-boundary original IsolateData missing");
    auto* env=node::CreateEnvironment(data,context,args,exec_args,node::EnvironmentFlags::kNoFlags);Require(env!=nullptr,"fatal-boundary original Environment missing");
    Require(!node::LoadEnvironment(env,"globalThis.beforeFatal=true").IsEmpty(),"fatal-boundary original bootstrap failed");
    node::FreeEnvironment(env);
    std::fprintf(stderr,"native-lifetime reached after original Environment disposal\n");
  }else std::fprintf(stderr,"native-lifetime reached before Environment construction\n");
  std::fflush(stderr);
  if(mode=="fatal-oom-before-env") {JS_ReportOutOfMemory(isolate->owner.lock()->cx);Require(false,"original fatal OOM reporter returned");}
  Isolate::DisallowJavascriptExecutionScope no_js(isolate,Isolate::DisallowJavascriptExecutionScope::CRASH_ON_FAILURE);
  Evaluate(context,"globalThis.fatalSideEffect=true");Require(false,"fatal no-JavaScript gate returned");
}
}  // namespace

int main(int argc, char** argv) {
  Require(argc == 2, "provide exactly one native lifetime case");
  const std::string mode = argv[1];
  Require(mode == "script-gc" || mode == "interrupts" || mode == "failure-state" || mode == "sibling-cleanup" || mode == "diagnostic-ownership" || mode == "execution-scopes" || mode == "gc-phases" || mode == "shared-loop-cleanup" || mode == "handle-identity" || mode == "fatal-before-env" || mode == "fatal-after-env" || mode == "fatal-oom-before-env" || mode == "module-metadata" || mode == "undici-lifetime", "unknown native lifetime case");
  std::vector<std::string> init_args={argv[0],"--no-node-snapshot","--no-addons"};
  if(mode=="handle-identity" || mode=="undici-lifetime")init_args.push_back("--expose-internals");
  if(mode=="undici-lifetime"){init_args.push_back("--expose-gc");init_args.push_back("--no-warnings");}
  auto initialized = node::InitializeOncePerProcess(init_args,
      {node::ProcessInitializationFlags::kNoInitializeV8,
       node::ProcessInitializationFlags::kNoInitializeNodeV8Platform,
       node::ProcessInitializationFlags::kNoInitializeCppgc});
  Require(!initialized->early_return() && initialized->errors().empty(), "original process initialization failed");
  auto platform = node::MultiIsolatePlatform::Create(4);
  v8::V8::InitializePlatform(platform.get());
  Require(v8::V8::Initialize(), "engine initialization failed");
  if(mode.starts_with("fatal-")) FatalBoundary(mode,platform.get(),initialized->args(),initialized->exec_args());
  Cleanup primary_cleanup;
  std::vector<std::string> errors;
  auto setup = node::CommonEnvironmentSetup::Create(platform.get(), &errors, initialized->args(), initialized->exec_args());
  for (const auto& error : errors) std::fprintf(stderr, "%s\n", error.c_str());
  Require(setup != nullptr && errors.empty(), "original Environment setup failed");
  {
    auto* isolate = setup->isolate();
    v8::Locker locker(isolate); Isolate::Scope isolate_scope(isolate); HandleScope handles(isolate);
    auto context = setup->context(); Context::Scope entered(context);
    Require(!node::LoadEnvironment(setup->env(), "globalThis.require=require('node:module').createRequire(process.cwd()+'/');").IsEmpty(), "original Node embedding startup failed");
    primary_cleanup.Install(isolate);
    if (mode == "script-gc") ScriptGC(isolate, context);
    else if (mode == "interrupts") InterruptFIFO(isolate, context, setup->env());
    else if (mode == "failure-state") FailureState(isolate, context);
    else if (mode == "sibling-cleanup") SiblingCleanup(isolate, context, setup.get(), initialized->args(), initialized->exec_args());
    else if (mode == "diagnostic-ownership") DiagnosticOwnership(isolate, context);
    else if (mode == "execution-scopes") ExecutionScopes(isolate,context);
    else if (mode == "gc-phases") GCPhases(isolate,context);
    else if(mode == "shared-loop-cleanup") SharedLoopCleanup(isolate,context,setup.get(),initialized->args(),initialized->exec_args());
    else if(mode == "handle-identity") HandleIdentity(isolate,context,setup->env());
    else if(mode == "undici-lifetime") UndiciLifetime(isolate,context);
    else ModuleMetadata(isolate);
  }
  // No further JS turn is supplied to make native cleanup happen.
  setup.reset();
  primary_cleanup.Check();
  Require(v8::V8::Dispose(), "engine process did not dispose");
  v8::V8::DisposePlatform();
  node::TearDownOncePerProcess();
  std::printf("native-lifetime PASS %s\n", mode.c_str());
  return 0;
}
