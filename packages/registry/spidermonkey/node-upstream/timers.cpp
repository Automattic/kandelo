#include "shell/node-upstream/timers.h"

#include "mozilla/Assertions.h"
#include "mozilla/ScopeExit.h"

#include <algorithm>
#include <cerrno>
#include <cmath>
#include <cstring>
#include <limits>
#include <time.h>
#include <utility>
#include <uv.h>

#include "jsapi.h"
#include "jsfriendapi.h"
#include "js/BigInt.h"
#include "js/CallAndConstruct.h"
#include "js/CallArgs.h"
#include "js/Conversions.h"
#include "js/experimental/TypedData.h"
#include "js/GlobalObject.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/Realm.h"
#include "js/Utility.h"
#include "js/ValueArray.h"
#include "js/Wrapper.h"
#include "shell/node-upstream/per-context.h"
#include "shell/node-upstream/realm.h"

namespace kandelo::node {
namespace {
enum StateSlot { NativeLoop, Base, ImmediateInfo, TimeoutInfo,
                 ImmediateCallback, TimerCallback, CallbackProcess,
                 CallbackOwner, StateSlots };
enum BindingSlot { Loop, RealmOwner, PrincipalOwner, PrincipalProcess, BindingSlots };
struct TimerLoop {
  uv_loop_t loop{};
  uv_timer_t timer{};
  uv_check_t check{};
  uv_idle_t idle{};
  uv_prepare_t checkpointBridge{};
  uv_async_t foreground{};
  void* foregroundOwner=nullptr;
  RuntimeForegroundCallback foregroundCallback=nullptr;
  RuntimeForegroundPending foregroundPending=nullptr;
  bool initialized = false;
  bool timerInitialized = false;
  bool checkInitialized = false;
  bool idleInitialized = false;
  bool bridgeInitialized = false;
  bool foregroundInitialized = false;
  // Borrowed only during uv_run from a stack root in DispatchRuntimeTimers.
  // No untraced JS edge or persistent/finalizer root is stored in native data.
  JSContext* cx = nullptr;
  JS::RootedObject* state = nullptr;
  RuntimeTimerCheckpoint checkpoint = nullptr;
  bool running = false;
  bool okay = true;
  bool yielded = false;
  bool externalReferences = false;
  int dispatched = 0;
};
void Finalize(JS::GCContext*, JSObject* state) {
  JS::Value value = JS::GetReservedSlot(state, NativeLoop);
  if (value.isUndefined()) return;
  auto* data = static_cast<TimerLoop*>(value.toPrivate());
  MOZ_RELEASE_ASSERT(!data->running && !data->cx && !data->state);
  MOZ_RELEASE_ASSERT(!data->foregroundOwner);
  // Foreground finalization closes every initialized owned handle, suppressing
  // future JS callbacks. Closing callbacks are null and cannot enter the GC.
  for (const auto& entry : {
      std::pair{reinterpret_cast<uv_handle_t*>(&data->timer), data->timerInitialized},
      std::pair{reinterpret_cast<uv_handle_t*>(&data->check), data->checkInitialized},
      std::pair{reinterpret_cast<uv_handle_t*>(&data->idle), data->idleInitialized},
      std::pair{reinterpret_cast<uv_handle_t*>(&data->checkpointBridge), data->bridgeInitialized},
      std::pair{reinterpret_cast<uv_handle_t*>(&data->foreground), data->foregroundInitialized}}) {
    if (entry.second) uv_close(entry.first, nullptr);
  }
  if (data->initialized) {
    uv_run(&data->loop, UV_RUN_DEFAULT);
    MOZ_RELEASE_ASSERT(uv_loop_close(&data->loop) == 0, "Node libuv loop cleanup invariant");
  }
  js_delete(data);
}
const JSClassOps kStateOps = {
    nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
    Finalize, nullptr, nullptr, nullptr};
const JSClass kState = {"NodeTimerState",
    JSCLASS_HAS_RESERVED_SLOTS(StateSlots) | JSCLASS_FOREGROUND_FINALIZE, &kStateOps};
const JSClass kBinding = {"NodeTimersBinding", JSCLASS_HAS_RESERVED_SLOTS(BindingSlots)};
TimerLoop* Native(JSObject* state) {
  return static_cast<TimerLoop*>(JS::GetReservedSlot(state, NativeLoop).toPrivate());
}
void OnTimer(uv_timer_t* handle);
void OnCheck(uv_check_t* handle);
void OnCheckpointBridge(uv_prepare_t* handle);
void OnIdle(uv_idle_t*) {}  // Like Node: keep poll nonblocking for live immediates.
void OnForeground(uv_async_t*);

bool Report(JSContext* cx, const char* message) {
  if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "%s", message);
  return false;
}
JSObject* UnwrapState(JSContext* cx, JSObject* object) {
  JSObject* state = js::CheckedUnwrapDynamic(object, cx, false);
  if (!state) { Report(cx, "Native timer state access denied"); return nullptr; }
  MOZ_RELEASE_ASSERT(JS::GetClass(state) == &kState);
  return state;
}
JSObject* Binding(JSContext* cx, const JS::CallArgs& args) {
  JSObject* binding = &js::GetFunctionNativeReserved(&args.callee(), 0).toObject();
  MOZ_RELEASE_ASSERT(JS::GetClass(binding) == &kBinding);
  JS::RootedObject owner(cx, &JS::GetReservedSlot(binding, RealmOwner).toObject());
  if (!CheckRealmLibraryActive(cx, owner)) return nullptr;
  return binding;
}
bool UvResult(JSContext* cx, int status) {
  if (status == 0) return true;
  JS_ReportErrorASCII(cx, "Native libuv operation failed: %s", uv_strerror(status));
  return false;
}
bool RefreshClock(JSContext* cx, JS::HandleObject state) {
  auto* data = Native(state);
  uv_update_time(&data->loop);
  uint64_t now = uv_now(&data->loop);
  if (now > (uint64_t(1) << 53))
    return Report(cx, "Guest monotonic clock exceeds the supported exact millisecond range");
  if (now < JS::GetReservedSlot(state, Base).toNumber())
    return Report(cx, "Guest monotonic clock moved before the environment base");
  return true;
}

bool IntegerValue(JSContext* cx, JS::HandleValue value, int64_t* result) {
  // Native Value::IntegerValue is a saturating signed-64 conversion, not the
  // modulo conversion used by ECMAScript typed arrays or WebIDL long long.
  double number;
  if (!JS::ToNumber(cx, value, &number)) return false;
  if (std::isnan(number)) *result = 0;
  else if (number >= double(std::numeric_limits<int64_t>::max()))
    *result = std::numeric_limits<int64_t>::max();
  else if (number <= double(std::numeric_limits<int64_t>::min()))
    *result = std::numeric_limits<int64_t>::min();
  else *result = int64_t(number);
  return true;
}
bool Schedule(JSContext* cx, JS::HandleObject state, int64_t duration) {
  // The actual libuv timer owns the cached-clock deadline and saturation.
  return UvResult(cx, uv_timer_start(&Native(state)->timer, OnTimer,
                                   uint64_t(duration), 0));
}

bool Info(JSContext* cx, JS::HandleObject state, unsigned index, uint32_t* count,
          uint32_t* refs, uint32_t* outstanding) {
  JS::RootedObject array(cx, &JS::GetReservedSlot(state, index).toObject());
  size_t expected = index == ImmediateInfo ? 3 : 1;
  if (JS_GetTypedArrayLength(array) != expected)
    return Report(cx, "Native timer backing array was detached or has invalid length");
  uint32_t* outputs[] = {count, refs, outstanding};
  for (size_t i = 0; i < expected; i++) {
    JS::RootedValue value(cx);
    if (!JS_GetElement(cx, array, i, &value)) return false;
    MOZ_RELEASE_ASSERT(value.isNumber());
    if (outputs[i]) *outputs[i] = uint32_t(value.toNumber());
  }
  return true;
}
bool Setup(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  MOZ_RELEASE_ASSERT(args.get(0).isObject() && JS::IsCallable(&args[0].toObject()), "Node immediate callback invariant");
  MOZ_RELEASE_ASSERT(args.get(1).isObject() && JS::IsCallable(&args[1].toObject()), "Node timers callback invariant");
  JS::RootedObject state(cx, UnwrapState(cx, &JS::GetReservedSlot(binding, Loop).toObject()));
  if (!state) return false;
  JS::RootedValue immediate(cx, args[0]), timer(cx, args[1]);
  JS::RootedValue process(cx, JS::GetReservedSlot(binding, PrincipalProcess));
  JS::RootedValue owner(cx, JS::GetReservedSlot(binding, PrincipalOwner));
  {
    JSAutoRealm home(cx, state);
    if (!JS_WrapValue(cx, &immediate) || !JS_WrapValue(cx, &timer) ||
        !JS_WrapValue(cx, &process) || !JS_WrapValue(cx, &owner)) return false;
    // Publish together after all fallible wrapping: retain the actual callbacks
    // and environment receiver, never a public property or substitute closure.
    JS::SetReservedSlot(state, ImmediateCallback, immediate);
    JS::SetReservedSlot(state, TimerCallback, timer);
    JS::SetReservedSlot(state, CallbackProcess, process);
    JS::SetReservedSlot(state, CallbackOwner, owner);
  }
  args.rval().setUndefined(); return true;
}
bool Now(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  JS::RootedObject state(cx, UnwrapState(cx, &JS::GetReservedSlot(binding, Loop).toObject()));
  if (!state) return false;
  JSAutoRealm home(cx, state);
  if (!RefreshClock(cx, state)) return false;
  args.rval().setNumber(double(uv_now(&Native(state)->loop)) - JS::GetReservedSlot(state, Base).toNumber()); return true;
}
bool ScheduleTimer(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  int64_t duration;
  if (!IntegerValue(cx, args.get(0), &duration)) return false;
  JS::RootedObject state(cx, UnwrapState(cx, &JS::GetReservedSlot(binding, Loop).toObject()));
  if (!state) return false;
  JSAutoRealm home(cx, state);
  if (!Schedule(cx, state, duration)) return false;
  args.rval().setUndefined(); return true;
}
bool Toggle(JSContext* cx, unsigned argc, JS::Value* vp, bool immediate) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  JS::RootedObject state(cx, UnwrapState(cx, &JS::GetReservedSlot(binding, Loop).toObject()));
  if (!state) return false;
  auto* data = Native(state);
  bool ref = args.get(0).isTrue();
  if (immediate) {
    if (!UvResult(cx, ref ? uv_idle_start(&data->idle, OnIdle) : uv_idle_stop(&data->idle))) return false;
  } else {
    auto* handle = reinterpret_cast<uv_handle_t*>(&data->timer);
    if (ref) uv_ref(handle); else uv_unref(handle);
  }
  args.rval().setUndefined(); return true;
}
bool ToggleTimer(JSContext* cx, unsigned argc, JS::Value* vp) { return Toggle(cx, argc, vp, false); }
bool ToggleImmediate(JSContext* cx, unsigned argc, JS::Value* vp) { return Toggle(cx, argc, vp, true); }

JSObject* Function(JSContext* cx, JS::HandleObject binding, JSNative native, unsigned nargs, const char* name) {
  JS::RootedFunction function(cx, js::NewFunctionWithReserved(cx, native, nargs, 0, name));
  if (!function) return nullptr;
  JS::RootedObject object(cx, JS_GetFunctionObject(function));
  js::SetFunctionNativeReserved(object, 0, JS::ObjectValue(*binding)); return object;
}
bool Call(JSContext* cx, JS::HandleObject state, bool immediate,
          JS::MutableHandleValue result) {
  MOZ_RELEASE_ASSERT(JS::GetReservedSlot(state, CallbackOwner).isObject() &&
      JS::GetReservedSlot(state, CallbackProcess).isObject(), "Node timer callbacks were not registered");
  JS::RootedObject owner(cx, js::CheckedUnwrapDynamic(
      &JS::GetReservedSlot(state, CallbackOwner).toObject(), cx, false));
  if (!owner) return Report(cx, "Native timer callback owner access denied");
  JS::RootedValue callback(cx, JS::GetReservedSlot(state, immediate ? ImmediateCallback : TimerCallback));
  MOZ_RELEASE_ASSERT(callback.isObject() && JS::IsCallable(&callback.toObject()), "Node timer callbacks were not registered");
  JS::RootedValue process(cx, JS::GetReservedSlot(state, CallbackProcess));
  JS::RootedValue now(cx, JS::DoubleValue(double(uv_now(&Native(state)->loop)) - JS::GetReservedSlot(state, Base).toNumber()));
  {
    JSAutoRealm realm(cx, owner);
    if (!CheckRealmLibraryActive(cx, owner) || !JS_WrapValue(cx, &callback) ||
        !JS_WrapValue(cx, &process)) return false;
    if (!JS::Call(cx, process, callback, immediate ? JS::HandleValueArray::empty()
        : JS::HandleValueArray(now), result)) return false;
  }
  return JS_WrapValue(cx, result);
}
void Fail(TimerLoop* data) {
  data->okay = false;
  uv_stop(&data->loop);
}
void Checkpoint(TimerLoop* data) {
  if (!data->okay) return;
  bool yield = false;
  if (!data->checkpoint(data->cx, &yield)) Fail(data);
  else if (yield) {
    data->yielded = !data->externalReferences;
    uv_stop(&data->loop);
  }
}
void OnTimer(uv_timer_t* handle) {
  auto* data = static_cast<TimerLoop*>(handle->data);
  if (!data->okay || data->yielded) return;
  MOZ_RELEASE_ASSERT(data->cx && data->state);
  JSContext* cx = data->cx;
  JS::RootedObject& state = *data->state;
  JS::RootedValue result(cx);
  ++data->dispatched;
  if (!RefreshClock(cx, state) || !Call(cx, state, false, &result)) { Fail(data); return; }
  int64_t expiry;
  if (!IntegerValue(cx, result, &expiry)) { Fail(data); return; }
  if (expiry == std::numeric_limits<int64_t>::min()) {
    Report(cx, "Native timer expiry is outside the supported signed range"); Fail(data); return;
  }
  if (expiry) {
    uint64_t magnitude = uint64_t(expiry < 0 ? -expiry : expiry);
    uint64_t elapsed = uv_now(&data->loop) - uint64_t(JS::GetReservedSlot(state, Base).toNumber());
    int64_t duration = magnitude > elapsed ? int64_t(magnitude - elapsed) : 1;
    if (!Schedule(cx, state, duration)) { Fail(data); return; }
  }
  // Preserve reentrant scheduling when expiry is zero; only unref the handle.
  auto* timer = reinterpret_cast<uv_handle_t*>(handle);
  if (expiry > 0) uv_ref(timer); else uv_unref(timer);
  Checkpoint(data);
}
void OnCheck(uv_check_t* handle) {
  auto* data = static_cast<TimerLoop*>(handle->data);
  if (!data->okay || data->yielded) return;
  MOZ_RELEASE_ASSERT(data->cx && data->state);
  JS::RootedObject& state = *data->state;
  uint32_t count, refs, outstanding;
  if (!Info(data->cx, state, ImmediateInfo, &count, &refs, &outstanding)) { Fail(data); return; }
  if (!count) return;
  do {
    JS::RootedValue result(data->cx);
    ++data->dispatched;
    if (!Call(data->cx, state, true, &result)) { Fail(data); return; }
    Checkpoint(data);
    if (!data->okay) return;
    if (!Info(data->cx, state, ImmediateInfo, &count, &refs, &outstanding)) { Fail(data); return; }
    if (data->yielded) {
      if (!refs && !UvResult(data->cx, uv_idle_stop(&data->idle))) Fail(data);
      return;
    }
  } while (outstanding);
  if (!refs && !UvResult(data->cx, uv_idle_stop(&data->idle))) Fail(data);
}
void OnCheckpointBridge(uv_prepare_t* handle) {
  // A real engine-job checkpoint services existing non-libuv native watches
  // while the shell polls them. Its reference is scoped to that actual work.
  Checkpoint(static_cast<TimerLoop*>(handle->data));
}
void OnForeground(uv_async_t* handle) {
  auto* data=static_cast<TimerLoop*>(handle->data);
  if(!data->foregroundOwner)return;
  MOZ_RELEASE_ASSERT(data->running&&data->cx&&data->state);
  if(!data->okay||data->yielded)return;
  ++data->dispatched;
  const bool okay=data->foregroundCallback(data->cx,data->foregroundOwner);
  if(!data->foregroundPending(data->foregroundOwner))uv_unref(reinterpret_cast<uv_handle_t*>(handle));
  if(!okay){Fail(data);return;}
  Checkpoint(data);
}
}  // namespace

bool ReadGuestMonotonicMillis(JSContext* cx, uint64_t* result) {
  struct timespec time;
  if (clock_gettime(CLOCK_MONOTONIC, &time) != 0) {
    JS_ReportErrorASCII(cx, "Guest CLOCK_MONOTONIC failed: %s", std::strerror(errno)); return false;
  }
  if (time.tv_sec < 0 || time.tv_nsec < 0 || time.tv_nsec >= 1000000000 ||
      uint64_t(time.tv_sec) > (std::numeric_limits<uint64_t>::max() - 999) / 1000)
    return Report(cx, "Invalid guest monotonic clock value");
  *result = uint64_t(time.tv_sec) * 1000 + uint64_t(time.tv_nsec) / 1000000;
  if (*result > (uint64_t(1) << 53))
    return Report(cx, "Guest monotonic clock exceeds the supported exact millisecond range");
  return true;
}
JSObject* CreateRuntimeTimerState(JSContext* cx, double base) {
  JS::RootedObject state(cx, JS_NewObject(cx, &kState));
  if (!state) return nullptr;
  auto* data = js_new<TimerLoop>();
  if (!data) { JS_ReportOutOfMemory(cx); return nullptr; }
  JS::SetReservedSlot(state, NativeLoop, JS::PrivateValue(data));
  // Detect a consumer header/layout mismatch before libuv can write the object.
  MOZ_RELEASE_ASSERT(sizeof(uv_loop_t) == uv_loop_size() &&
      sizeof(uv_timer_t) == uv_handle_size(UV_TIMER) &&
      sizeof(uv_check_t) == uv_handle_size(UV_CHECK) &&
      sizeof(uv_idle_t) == uv_handle_size(UV_IDLE) &&
      sizeof(uv_prepare_t) == uv_handle_size(UV_PREPARE) &&
      sizeof(uv_async_t) == uv_handle_size(UV_ASYNC), "Node libuv public layout invariant");
  if (!UvResult(cx, uv_loop_init(&data->loop))) return nullptr;
  data->initialized = true;
  if (!UvResult(cx, uv_timer_init(&data->loop, &data->timer))) return nullptr;
  data->timerInitialized = true; data->timer.data = data;
  uv_unref(reinterpret_cast<uv_handle_t*>(&data->timer));
  if (!UvResult(cx, uv_check_init(&data->loop, &data->check))) return nullptr;
  data->checkInitialized = true; data->check.data = data;
  uv_unref(reinterpret_cast<uv_handle_t*>(&data->check));
  if (!UvResult(cx, uv_check_start(&data->check, OnCheck))) return nullptr;
  if (!UvResult(cx, uv_idle_init(&data->loop, &data->idle))) return nullptr;
  data->idleInitialized = true; data->idle.data = data;
  if (!UvResult(cx, uv_prepare_init(&data->loop, &data->checkpointBridge))) return nullptr;
  data->bridgeInitialized = true; data->checkpointBridge.data = data;
  uv_unref(reinterpret_cast<uv_handle_t*>(&data->checkpointBridge));
  if(!UvResult(cx,uv_async_init(&data->loop,&data->foreground,OnForeground)))return nullptr;
  data->foregroundInitialized=true;data->foreground.data=data;
  uv_unref(reinterpret_cast<uv_handle_t*>(&data->foreground));
  JS::RootedObject immediate(cx, JS_NewUint32Array(cx, 3));
  if (!immediate) return nullptr;
  JS::RootedObject timeout(cx, JS_NewInt32Array(cx, 1));
  if (!timeout) return nullptr;
  JS::SetReservedSlot(state, Base, JS::DoubleValue(base));
  JS::SetReservedSlot(state, ImmediateInfo, JS::ObjectValue(*immediate));
  JS::SetReservedSlot(state, TimeoutInfo, JS::ObjectValue(*timeout));
  if (!RefreshClock(cx, state)) return nullptr;
  return state;
}

JSObject* CreateTimersBinding(JSContext* cx, JS::HandleObject runtime,
                             JS::HandleObject realm, JS::HandleObject process) {
  JS::RootedObject state(cx, GetRuntimeTimerState(cx, runtime, true));
  if (!state) return nullptr;
  JS::RootedObject owner(cx, GetRuntimePrincipalRealm(cx, runtime));
  if (!owner) return nullptr;
  JS::RootedObject receiver(cx, GetRuntimePrincipalProcess(cx, runtime));
  if (!receiver) return nullptr;
  JS::RootedObject binding(cx, JS_NewObject(cx, &kBinding));
  if (!binding) return nullptr;
  JS::SetReservedSlot(binding, Loop, JS::ObjectValue(*state));
  JS::SetReservedSlot(binding, RealmOwner, JS::ObjectValue(*realm));
  JS::SetReservedSlot(binding, PrincipalOwner, JS::ObjectValue(*owner));
  JS::SetReservedSlot(binding, PrincipalProcess, JS::ObjectValue(*receiver));
  JS::RootedObject raw(cx, UnwrapState(cx, state)); if (!raw) return nullptr;
  for (const auto& field : {std::pair{"immediateInfo", ImmediateInfo}, std::pair{"timeoutInfo", TimeoutInfo}}) {
    JS::RootedValue value(cx, JS::GetReservedSlot(raw, field.second));
    if (!JS_WrapValue(cx, &value) || !JS_DefineProperty(cx, binding, field.first, value, JSPROP_ENUMERATE)) return nullptr;
  }
  struct Method { const char* name; JSNative native; unsigned nargs; };
  for (const auto& method : {Method{"setupTimers", Setup, 0}, Method{"getLibuvNow", Now, 0},
      Method{"scheduleTimer", ScheduleTimer, 0}, Method{"toggleTimerRef", ToggleTimer, 0},
      Method{"toggleImmediateRef", ToggleImmediate, 0}}) {
    JS::RootedObject function(cx, Function(cx, binding, method.native, method.nargs, method.name));
    if (!function || !JS_DefineProperty(cx, binding, method.name, function, JSPROP_ENUMERATE)) return nullptr;
  }
  return binding;
}
bool DispatchRuntimeTimers(JSContext* cx, JS::HandleObject runtime,
                           bool externalReferences, RuntimeTimerCheckpoint checkpoint,
                           int* dispatched, int64_t* nextDelay) {
  *dispatched = 0; *nextDelay = -1;
  JS::RootedObject wrapped(cx, GetRuntimeTimerState(cx, runtime, false));
  if (!wrapped) return !JS_IsExceptionPending(cx);
  JS::RootedObject state(cx, UnwrapState(cx, wrapped)); if (!state) return false;
  JSAutoRealm home(cx, state);
  auto* data = Native(state);
  if (data->running) return Report(cx, "Reentrant native timer dispatch");
  uint32_t count, refs, outstanding;
  if (!Info(cx, state, ImmediateInfo, &count, &refs, &outstanding)) return false;
  MOZ_RELEASE_ASSERT(checkpoint);
  data->running = true; data->okay = true; data->dispatched = 0;
  data->yielded = false; data->externalReferences = externalReferences;
  data->cx = cx; data->state = &state; data->checkpoint = checkpoint;
  auto leave = mozilla::MakeScopeExit([&] {
    uv_prepare_stop(&data->checkpointBridge);
    uv_unref(reinterpret_cast<uv_handle_t*>(&data->checkpointBridge));
    data->cx = nullptr; data->state = nullptr; data->checkpoint = nullptr;
    data->running = false;
  });
  if(data->foregroundOwner){
    auto* handle=reinterpret_cast<uv_handle_t*>(&data->foreground);
    if(data->foregroundPending(data->foregroundOwner)){
      uv_ref(handle);
      // A caught callback error or checkpoint yield can leave queued work
      // after the original async signal was consumed. Re-arm real delivery.
      if(!UvResult(cx,uv_async_send(&data->foreground)))return false;
    }else uv_unref(handle);
  }
  if (externalReferences) {
    if (!UvResult(cx, uv_prepare_start(&data->checkpointBridge, OnCheckpointBridge))) return false;
    uv_ref(reinterpret_cast<uv_handle_t*>(&data->checkpointBridge));
  }
  // libuv owns deadlines, poll blocking, ref liveness and phase progression.
  // Existing non-libuv native watches are serviced by the shell between NOWAIT
  // steps; otherwise DEFAULT drains the real loop with callback checkpoints.
  uv_run(&data->loop, externalReferences ? UV_RUN_NOWAIT : UV_RUN_DEFAULT);
  *dispatched = data->dispatched;
  if (!data->okay) return false;
  if (!UvResult(cx, uv_prepare_stop(&data->checkpointBridge))) return false;
  uv_unref(reinterpret_cast<uv_handle_t*>(&data->checkpointBridge));
  if (uv_loop_alive(&data->loop)) *nextDelay = std::max(0, uv_backend_timeout(&data->loop));
  return true;
}

void* AttachRuntimeForeground(JSContext* cx,JS::HandleObject runtime,void* owner,
                              RuntimeForegroundCallback callback,RuntimeForegroundPending pending) {
  JS::RootedObject wrapped(cx,GetRuntimeTimerState(cx,runtime,true));if(!wrapped)return nullptr;
  JS::RootedObject state(cx,UnwrapState(cx,wrapped));if(!state)return nullptr;
  auto* data=Native(state);MOZ_RELEASE_ASSERT(owner&&callback&&pending&&!data->foregroundOwner);
  data->foregroundOwner=owner;data->foregroundCallback=callback;data->foregroundPending=pending;
  return &data->foreground;
}
int SendRuntimeForeground(void* token) { return uv_async_send(static_cast<uv_async_t*>(token)); }
void DetachRuntimeForeground(JSContext* cx,JS::HandleObject runtime,void* owner) {
  JS::RootedObject wrapped(cx,GetRuntimeTimerState(cx,runtime,false));MOZ_RELEASE_ASSERT(wrapped);
  JS::RootedObject state(cx,UnwrapState(cx,wrapped));MOZ_RELEASE_ASSERT(state);
  auto* data=Native(state);MOZ_RELEASE_ASSERT(!data->running&&data->foregroundOwner==owner);
  data->foregroundOwner=nullptr;data->foregroundCallback=nullptr;data->foregroundPending=nullptr;
  uv_unref(reinterpret_cast<uv_handle_t*>(&data->foreground));
}

JSObject* InspectRuntimeTimers(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject wrapped(cx, GetRuntimeTimerState(cx, runtime, false));
  if (!wrapped) { Report(cx, "Native timers have not been initialized"); return nullptr; }
  JS::RootedObject state(cx, UnwrapState(cx, wrapped)); if (!state) return nullptr;
  JS::RootedObject snapshot(cx, JS_NewPlainObject(cx)); if (!snapshot) return nullptr;
  auto* data = Native(state);
  struct Field { const char* name; JS::Value value; };
  for (const auto& field : {
      Field{"armed", JS::BooleanValue(uv_is_active(reinterpret_cast<uv_handle_t*>(&data->timer)))},
      Field{"timerReferenced", JS::BooleanValue(uv_has_ref(reinterpret_cast<uv_handle_t*>(&data->timer)))},
      Field{"immediateReferenced", JS::BooleanValue(uv_is_active(reinterpret_cast<uv_handle_t*>(&data->idle)))},
      Field{"base", JS::GetReservedSlot(state, Base)},
      Field{"now", JS::DoubleValue(double(uv_now(&data->loop)))},
      Field{"libuvVersion", JS::Int32Value(int32_t(uv_version()))},
      Field{"loopSize", JS::Int32Value(int32_t(sizeof(uv_loop_t)))},
      Field{"nativeLoopSize", JS::Int32Value(int32_t(uv_loop_size()))}}) {
    JS::RootedValue value(cx, field.value);
    if (!JS_DefineProperty(cx, snapshot, field.name, value, JSPROP_ENUMERATE)) return nullptr;
  }

  JS::Rooted<JS::BigInt*> deadline(cx, JS::NumberToBigInt(cx, data->timer.timeout));
  if (!deadline) return nullptr;
  JS::RootedValue value(cx, JS::BigIntValue(deadline));
  if (!JS_DefineProperty(cx, snapshot, "deadline", value, JSPROP_ENUMERATE)) return nullptr;
  return snapshot;
}
}  // namespace kandelo::node
