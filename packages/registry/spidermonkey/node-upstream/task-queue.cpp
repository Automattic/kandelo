#include "shell/node-upstream/task-queue.h"

#include "mozilla/Assertions.h"
#include "mozilla/ScopeExit.h"

#include <cstdio>
#include <utility>

#include "jsapi.h"
#include "jsfriendapi.h"
#include "js/CallAndConstruct.h"
#include "js/CallArgs.h"
#include "js/ErrorReport.h"
#include "js/Exception.h"
#include "js/experimental/TypedData.h"
#include "js/GCVector.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/Realm.h"
#include "js/Symbol.h"
#include "js/ValueArray.h"
#include "js/Wrapper.h"
#include "shell/jsshell.h"
#include "shell/node-upstream/per-context.h"
#include "shell/node-upstream/realm.h"
#include "vm/JSContext.h"

namespace kandelo::node {
namespace {
enum StateSlot { TickInfo, TickCallback, RejectCallback, TickOwner, RejectOwner,
                 MicrotaskActive, CheckpointActive, HandlingFatal, JobFailed,
                 PendingError, Interrupted, StateSlots };
enum BindingSlot { TaskState, RealmOwner, RuntimeOwner, BindingSlots };
const JSClass kState = {"NodeTaskQueueState", JSCLASS_HAS_RESERVED_SLOTS(StateSlots)};
const JSClass kBinding = {"NodeTaskQueueBinding", JSCLASS_HAS_RESERVED_SLOTS(BindingSlots)};
bool Report(JSContext* cx, const char* message) {
  if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "%s", message);
  return false;
}
bool Missing(JSContext* cx, const char* message) {
  return Report(cx, message);
}
bool Flag(JSObject* state, unsigned slot) {
  return JS::GetReservedSlot(state, slot).isTrue();
}
void Flag(JSObject* state, unsigned slot, bool value) {
  JS::SetReservedSlot(state, slot, JS::BooleanValue(value));
}
JSObject* Raw(JSContext* cx, JSObject* object) {
  JSObject* raw = js::CheckedUnwrapDynamic(object, cx, false);
  if (!raw) { Report(cx, "Native task queue state access denied"); return nullptr; }
  MOZ_RELEASE_ASSERT(JS::GetClass(raw) == &kState);
  return raw;
}
JSObject* Runtime(JSContext* cx) {
  return js::shell::GetShellContext(cx)->upstreamNodeRuntime.get();
}
JSObject* State(JSContext* cx) {
  JS::RootedObject runtime(cx, Runtime(cx));
  if (!runtime || !HasRuntimeTaskState(runtime)) return nullptr;
  JS::RootedObject state(cx, GetRuntimeTaskState(cx, runtime, false));
  return state ? Raw(cx, state) : nullptr;
}
JSObject* Binding(JSContext* cx, const JS::CallArgs& args) {
  JSObject* binding = &js::GetFunctionNativeReserved(&args.callee(), 0).toObject();
  MOZ_RELEASE_ASSERT(JS::GetClass(binding) == &kBinding);
  JS::RootedObject owner(cx, &JS::GetReservedSlot(binding, RealmOwner).toObject());
  if (!CheckRealmLibraryActive(cx, owner)) return nullptr;
  return binding;
}
JSObject* Function(JSContext* cx, JS::HandleObject binding, JSNative native, const char* name) {
  JS::RootedFunction function(cx, js::NewFunctionWithReserved(cx, native, 0, 0, name));
  if (!function) return nullptr;
  JS::RootedObject object(cx, JS_GetFunctionObject(function));
  js::SetFunctionNativeReserved(object, 0, JS::ObjectValue(*binding)); return object;
}
bool LiveFlags(JSContext* cx, JS::HandleObject state, bool* ticks, bool* rejections) {
  JS::RootedObject array(cx, &JS::GetReservedSlot(state, TickInfo).toObject());
  if (JS_GetTypedArrayLength(array) != 2)
    return Report(cx, "Native tickInfo backing array was detached or has invalid length");
  JS::RootedValue tick(cx), rejection(cx);
  if (!JS_GetElement(cx, array, 0, &tick) || !JS_GetElement(cx, array, 1, &rejection)) return false;
  *ticks = tick.toNumber() == 1; *rejections = rejection.toNumber() == 1;
  return true;
}
bool CallOwned(JSContext* cx, JS::HandleObject state, unsigned callbackSlot,
               unsigned ownerSlot, JS::HandleValue receiver,
               const JS::HandleValueArray& args, JS::MutableHandleValue result) {
  JS::RootedObject owner(cx, js::CheckedUnwrapDynamic(
      &JS::GetReservedSlot(state, ownerSlot).toObject(), cx, false));
  if (!owner) return Report(cx, "Native task queue callback owner access denied");
  JS::RootedValue callback(cx, JS::GetReservedSlot(state, callbackSlot)), self(cx, receiver);
  {
    JSAutoRealm realm(cx, owner);
    if (!CheckRealmLibraryActive(cx, owner) || !JS_WrapValue(cx, &callback) ||
        !JS_WrapValue(cx, &self)) return false;
    JS::RootedValueVector wrapped(cx);
    for (size_t i = 0; i < args.length(); ++i) {
      JS::RootedValue value(cx, args[i]);
      if (!JS_WrapValue(cx, &value) || !wrapped.append(value)) return false;
    }
    if (!JS::Call(cx, self, callback, JS::HandleValueArray(wrapped), result)) return false;
  }
  return JS_WrapValue(cx, result);
}
void PrintCallbackException(JSContext* cx) {
  // Like Node's PromiseRejectCallback: best-effort reporting does not turn
  // this diagnostic into a shell error exit or leak a pending engine exception.
  std::fputs("Exception in PromiseRejectCallback:\n", stderr);
  JS::ExceptionStack stack(cx);
  if (JS::StealPendingExceptionStack(cx, &stack)) {
    JS::ErrorReportBuilder report(cx);
    if (report.init(cx, stack, JS::ErrorReportBuilder::NoSideEffects))
      JS::PrintError(stderr, report, true);
  }
  JS_ClearPendingException(cx);
}
bool SetCallback(JSContext* cx, unsigned argc, JS::Value* vp, bool rejection) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  MOZ_RELEASE_ASSERT(args.get(0).isObject() && JS::IsCallable(&args[0].toObject()),
      "Node task queue callback function invariant");
  JS::RootedObject state(cx, Raw(cx, &JS::GetReservedSlot(binding, TaskState).toObject()));
  if (!state) return false;
  JS::RootedValue callback(cx, args[0]), owner(cx, JS::GetReservedSlot(binding, RealmOwner));
  JSAutoRealm home(cx, state);
  if (!JS_WrapValue(cx, &callback) || !JS_WrapValue(cx, &owner)) return false;
  JS::SetReservedSlot(state, rejection ? RejectCallback : TickCallback, callback);
  JS::SetReservedSlot(state, rejection ? RejectOwner : TickOwner, owner);
  args.rval().setUndefined(); return true;
}
bool SetTick(JSContext* cx, unsigned argc, JS::Value* vp) { return SetCallback(cx, argc, vp, false); }
bool SetReject(JSContext* cx, unsigned argc, JS::Value* vp) { return SetCallback(cx, argc, vp, true); }
bool RunJob(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  JS::RootedValue callback(cx, js::GetFunctionNativeReserved(&args.callee(), 1));
  return JS::Call(cx, JS::UndefinedHandleValue, callback, JS::HandleValueArray::empty(), args.rval());
}
bool Enqueue(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  MOZ_RELEASE_ASSERT(args.get(0).isObject() && JS::IsCallable(&args[0].toObject()),
      "Node microtask function invariant");
  // The internal engine queue stores JSFunctions. A native job adapter retains
  // any actual callable (including cross-realm/bound/proxy functions) in traced
  // slots, preserving its identity/receiver without a second queue or Promise.
  JS::RootedObject job(cx, Function(cx, binding, RunJob, ""));
  if (!job) return false;
  js::SetFunctionNativeReserved(job, 1, args[0]);
  if (!js::EnqueueJob(cx, job)) return false;
  args.rval().setUndefined(); return true;
}
bool RunMicrotasks(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  if (!Binding(cx, args) || !RunRuntimeMicrotasks(cx)) return false;
  args.rval().setUndefined(); return true;
}
bool AssignedAsyncIds(JSContext* cx, JS::HandleObject promise, bool* assigned) {
  JS::RootedObject runtime(cx, Runtime(cx));
  double ids[2]; size_t i = 0;
  for (const char* name : {"async_id_symbol", "trigger_async_id_symbol"}) {
    JS::RootedSymbol symbol(cx, GetRuntimeSymbol(cx, runtime, name));
    if (!symbol) return false;
    JS::RootedId key(cx, JS::PropertyKey::Symbol(symbol));
    JS::RootedValue value(cx);
    if (!JS_GetPropertyById(cx, promise, key, &value)) return false;
    ids[i++] = value.isNumber() ? value.toNumber() : -1;
  }
  *assigned = ids[0] != -1 && ids[1] != -1;
  return true;
}
}  // namespace

JSObject* CreateRuntimeTaskState(JSContext* cx) {
  JS::RootedObject state(cx, JS_NewObject(cx, &kState));
  JS::RootedObject ticks(cx, JS_NewUint8Array(cx, 2));
  if (!state || !ticks) return nullptr;
  JS::SetReservedSlot(state, TickInfo, JS::ObjectValue(*ticks));
  return state;
}
JSObject* CreateTaskQueueBinding(JSContext* cx, JS::HandleObject runtime,
                                JS::HandleObject realm) {
  JS::RootedObject state(cx, GetRuntimeTaskState(cx, runtime, true));
  JS::RootedObject binding(cx, JS_NewObject(cx, &kBinding));
  if (!state || !binding) return nullptr;
  JS::SetReservedSlot(binding, TaskState, JS::ObjectValue(*state));
  JS::SetReservedSlot(binding, RealmOwner, JS::ObjectValue(*realm));
  JS::SetReservedSlot(binding, RuntimeOwner, JS::ObjectValue(*runtime));
  JS::RootedObject raw(cx, Raw(cx, state)); if (!raw) return nullptr;
  JS::RootedValue info(cx, JS::GetReservedSlot(raw, TickInfo));
  JS::RootedObject events(cx, JS_NewPlainObject(cx));
  if (!events || !JS_WrapValue(cx, &info) ||
      !JS_DefineProperty(cx, binding, "tickInfo", info, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, events, "kPromiseRejectWithNoHandler", 0, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT) ||
      !JS_DefineProperty(cx, events, "kPromiseHandlerAddedAfterReject", 1, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT) ||
      !JS_DefineProperty(cx, binding, "promiseRejectEvents", events, JSPROP_ENUMERATE)) return nullptr;
  struct Method { const char* name; JSNative native; };
  for (const auto& method : {Method{"enqueueMicrotask", Enqueue}, Method{"runMicrotasks", RunMicrotasks},
      Method{"setTickCallback", SetTick}, Method{"setPromiseRejectCallback", SetReject}}) {
    JS::RootedObject function(cx, Function(cx, binding, method.native, method.name));
    if (!function || !JS_DefineProperty(cx, binding, method.name, function, JSPROP_ENUMERATE)) return nullptr;
  }
  return binding;
}
bool RunRuntimeMicrotasks(JSContext* cx) {
  JS::RootedObject state(cx, State(cx));
  if (!state) {
    if (JS_IsExceptionPending(cx)) return false;
    js::RunJobs(cx); return !JS_IsExceptionPending(cx);
  }
  // Check the actual engine drain flag before js::RunJobs can clear kept
  // objects. This protects both native method recursion and shell drain calls.
  MOZ_RELEASE_ASSERT(cx->internalJobQueue.ref());
  if (cx->internalJobQueue->isDraining()) return true;
  if (js::shell::GetShellContext(cx)->quitting) return false;
  if (cx->isEvaluatingModule != 0)
    return Report(cx, "Native microtask checkpoint during active module evaluation is not implemented");
  JSAutoRealm home(cx, state);
  Flag(state, MicrotaskActive, true);
  auto leave = mozilla::MakeScopeExit([&] { Flag(state, MicrotaskActive, false); });
  js::RunJobs(cx);
  if (Flag(state, Interrupted)) {
    Flag(state, Interrupted, false);
    if (!js::shell::GetShellContext(cx)->quitting) js::RestartDrainingJobQueue(cx);
  }
  if (Flag(state, JobFailed)) {
    JS::RootedValue error(cx, JS::GetReservedSlot(state, PendingError));
    JS::SetReservedSlot(state, PendingError, JS::UndefinedValue());
    Flag(state, JobFailed, false);
    JS_SetPendingException(cx, error);
    return false;
  }
  return !js::shell::GetShellContext(cx)->quitting && !JS_IsExceptionPending(cx);
}
bool CheckpointRuntimeTasks(JSContext* cx) {
  JS::RootedObject state(cx, State(cx));
  if (!state) return !JS_IsExceptionPending(cx) && RunRuntimeMicrotasks(cx);
  if (Flag(state, CheckpointActive) || cx->internalJobQueue->isDraining()) return true;
  JSAutoRealm home(cx, state);
  Flag(state, CheckpointActive, true);
  auto leave = mozilla::MakeScopeExit([&] { Flag(state, CheckpointActive, false); });
  bool ticks, rejections;
  if (!LiveFlags(cx, state, &ticks, &rejections)) return false;
  if (!ticks && !RunRuntimeMicrotasks(cx)) return false;
  if (!LiveFlags(cx, state, &ticks, &rejections)) return false;
  if (!ticks && !rejections) return true;
  MOZ_RELEASE_ASSERT(JS::GetReservedSlot(state, TickCallback).isObject(),
      "Node tick callback was not registered");
  JS::RootedObject runtime(cx, Runtime(cx));
  JS::RootedObject process(cx, GetRuntimePrincipalProcess(cx, runtime));
  if (!process) return false;
  JS::RootedValue result(cx), receiver(cx, JS::ObjectValue(*process));
  return CallOwned(cx, state, TickCallback, TickOwner, receiver,
      JS::HandleValueArray::empty(), &result);
}
bool HandleRuntimeJobException(JSContext* cx) {
  JS::RootedObject state(cx, State(cx));
  if (!state || !Flag(state, MicrotaskActive)) return false;
  MOZ_RELEASE_ASSERT(JS_IsExceptionPending(cx));
  auto stopOnPending = mozilla::MakeScopeExit([&] {
    if (JS_IsExceptionPending(cx)) {
      Flag(state, Interrupted, true);
      js::StopDrainingJobQueue(cx);
    }
  });
  JS::RootedValue error(cx);
  if (!JS_GetPendingException(cx, &error)) return true;
  JS_ClearPendingException(cx);
  {
    JSAutoRealm home(cx, state);
    if (!JS_WrapValue(cx, &error)) return true;
    bool handled = false;
    JS::RootedObject runtime(cx, Runtime(cx));
    JS::RootedObject wrappedOwner(cx, GetRuntimePrincipalRealm(cx, runtime));
    JS::RootedObject owner(cx, wrappedOwner ? js::CheckedUnwrapDynamic(wrappedOwner, cx, false) : nullptr);
    JS::RootedObject process(cx, GetRuntimePrincipalProcess(cx, runtime));
    if (owner && process) {
      JSAutoRealm realm(cx, owner);
      JS::RootedValue callback(cx), wrappedError(cx, error), result(cx);
      if (CheckRealmLibraryActive(cx, owner) && JS_WrapObject(cx, &process) && JS_WrapValue(cx, &wrappedError) &&
          JS_GetProperty(cx, process, "_fatalException", &callback) &&
          callback.isObject() && JS::IsCallable(&callback.toObject())) {
        MOZ_RELEASE_ASSERT(!Flag(state, HandlingFatal), "Reentrant Node fatal exception invariant");
        Flag(state, HandlingFatal, true);
        auto leave = mozilla::MakeScopeExit([&] { Flag(state, HandlingFatal, false); });
        JS::RootedValueArray<2> args(cx);
        args[0].set(wrappedError); args[1].setBoolean(false);
        JS::RootedValue receiver(cx, JS::ObjectValue(*process));
        handled = JS::Call(cx, receiver, callback, args, &result) && !result.isFalse();
      }
    }
    if (handled) return true;
    if (js::shell::GetShellContext(cx)->quitting) return true;
    // Fatal process exit/at-exit and full AsyncWrap recovery are separate
    // unfinished backends. Preserve the real failure and stop this checkpoint;
    // never claim a handled error or manufacture a successful process exit.
    if (JS_IsExceptionPending(cx)) {
      if (!JS_GetPendingException(cx, &error)) return true;
      JS_ClearPendingException(cx);
      if (!JS_WrapValue(cx, &error)) return true;
    }
    JS::SetReservedSlot(state, PendingError, error);
    Flag(state, JobFailed, true); Flag(state, Interrupted, true);
    js::StopDrainingJobQueue(cx);
  }
  return true;
}
bool ForwardRuntimePromiseRejection(JSContext* cx, JS::HandleObject promise,
                                    JS::PromiseRejectionHandlingState event) {
  JS::RootedObject state(cx, State(cx));
  if (!state) return false;
  JSAutoRealm home(cx, state);
  JS::RootedObject runtime(cx, Runtime(cx));
  JS::RootedObject wrappedOwner(cx, GetRuntimePrincipalRealm(cx, runtime));
  JS::RootedObject owner(cx, wrappedOwner ? js::CheckedUnwrapDynamic(wrappedOwner, cx, false) : nullptr);
  if (!owner) return true;
  if (RealmLibraryIsFailed(owner)) return true;
  MOZ_RELEASE_ASSERT(JS::GetReservedSlot(state, RejectCallback).isObject(),
      "Node promise rejection callback was not registered");
  JS::RootedObject wrappedPromise(cx, promise);
  JS::RootedValue result(cx);
  bool assigned = false;
  auto deliver = [&]() -> bool {
    if (!JS_WrapObject(cx, &wrappedPromise) || !AssignedAsyncIds(cx, wrappedPromise, &assigned)) return false;
    if (assigned) return Missing(cx, "Native promise async-context entry is not implemented");
    JS::RootedValueArray<3> args(cx);
    bool rejected = event == JS::PromiseRejectionHandlingState::Unhandled;
    args[0].setInt32(rejected ? 0 : 1); args[1].setObject(*wrappedPromise);
    // GetPromiseResult requires an actual Promise, not a compartment wrapper.
    JS::RootedObject rawPromise(cx, js::CheckedUnwrapDynamic(wrappedPromise, cx, false));
    if (!rawPromise) return Report(cx, "Native rejected promise access denied");
    {
      JSAutoRealm realm(cx, rawPromise);
      args[2].set(rejected ? JS::GetPromiseResult(rawPromise) : JS::UndefinedValue());
    }
    if (!JS_WrapValue(cx, args[2])) return false;
    return CallOwned(cx, state, RejectCallback, RejectOwner, JS::UndefinedHandleValue, args, &result);
  };
  if (!deliver() && JS_IsExceptionPending(cx)) PrintCallbackException(cx);
  return true;
}
}  // namespace kandelo::node
