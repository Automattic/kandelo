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
#include "js/ValueArray.h"
#include "js/Wrapper.h"
#include "shell/node-upstream/per-context.h"
#include "shell/node-upstream/realm.h"

namespace kandelo::node {
namespace {
enum StateSlot { Base, Current, DeadlineLow, DeadlineHigh, Armed, TimerRef, ImmediateRef,
                 ImmediateInfo, TimeoutInfo, ImmediateCallback, TimerCallback,
                 CallbackProcess, CallbackOwner, Inside, PreferImmediate, StateSlots };
enum BindingSlot { Loop, RealmOwner, PrincipalOwner, PrincipalProcess, BindingSlots };
const JSClass kState = {"NodeTimerState", JSCLASS_HAS_RESERVED_SLOTS(StateSlots)};
const JSClass kBinding = {"NodeTimersBinding", JSCLASS_HAS_RESERVED_SLOTS(BindingSlots)};
uint64_t Deadline(JSObject* state) {
  return uint64_t(uint32_t(JS::GetReservedSlot(state, DeadlineLow).toInt32())) |
      (uint64_t(uint32_t(JS::GetReservedSlot(state, DeadlineHigh).toInt32())) << 32);
}
void SetDeadline(JSObject* state, uint64_t value) {
  JS::SetReservedSlot(state, DeadlineLow, JS::Int32Value(int32_t(uint32_t(value))));
  JS::SetReservedSlot(state, DeadlineHigh, JS::Int32Value(int32_t(uint32_t(value >> 32))));
}

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
bool RefreshClock(JSContext* cx, JS::HandleObject state) {
  uint64_t milliseconds;
  if (!ReadGuestMonotonicMillis(cx, &milliseconds)) return false;
  double now = double(milliseconds);
  if (now < JS::GetReservedSlot(state, Base).toNumber())
    return Report(cx, "Guest monotonic clock moved before the environment base");
  JS::SetReservedSlot(state, Current, JS::DoubleValue(now)); return true;
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
void Schedule(JS::HandleObject state, int64_t duration) {
  // uv_timer_start accepts the signed binding duration as uint64_t, and
  // saturates overflow in the absolute deadline. Preserve that native protocol.
  uint64_t timeout = uint64_t(duration);
  uint64_t now = uint64_t(JS::GetReservedSlot(state, Current).toNumber());
  uint64_t expiry = now + timeout;
  if (expiry < timeout) expiry = std::numeric_limits<uint64_t>::max();
  SetDeadline(state, expiry);
  JS::SetReservedSlot(state, Armed, JS::BooleanValue(true));
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
  args.rval().setNumber(JS::GetReservedSlot(state, Current).toNumber() - JS::GetReservedSlot(state, Base).toNumber()); return true;
}
bool ScheduleTimer(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  int64_t duration;
  if (!IntegerValue(cx, args.get(0), &duration)) return false;
  JS::RootedObject state(cx, UnwrapState(cx, &JS::GetReservedSlot(binding, Loop).toObject()));
  if (!state) return false;
  JSAutoRealm home(cx, state); Schedule(state, duration);
  args.rval().setUndefined(); return true;
}
bool Toggle(JSContext* cx, unsigned argc, JS::Value* vp, unsigned slot) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  JS::RootedObject state(cx, UnwrapState(cx, &JS::GetReservedSlot(binding, Loop).toObject()));
  if (!state) return false;
  JSAutoRealm home(cx, state);
  JS::SetReservedSlot(state, slot, JS::BooleanValue(args.get(0).isTrue()));
  args.rval().setUndefined(); return true;
}
bool ToggleTimer(JSContext* cx, unsigned argc, JS::Value* vp) { return Toggle(cx, argc, vp, TimerRef); }
bool ToggleImmediate(JSContext* cx, unsigned argc, JS::Value* vp) { return Toggle(cx, argc, vp, ImmediateRef); }
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
  JS::RootedValue now(cx, JS::DoubleValue(JS::GetReservedSlot(state, Current).toNumber() - JS::GetReservedSlot(state, Base).toNumber()));
  {
    JSAutoRealm realm(cx, owner);
    if (!CheckRealmLibraryActive(cx, owner) || !JS_WrapValue(cx, &callback) ||
        !JS_WrapValue(cx, &process)) return false;
    if (!JS::Call(cx, process, callback, immediate ? JS::HandleValueArray::empty()
        : JS::HandleValueArray(now), result)) return false;
  }
  return JS_WrapValue(cx, result);
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
  JS::RootedObject immediate(cx, JS_NewUint32Array(cx, 3));
  if (!immediate) return nullptr;
  JS::RootedObject timeout(cx, JS_NewInt32Array(cx, 1));
  if (!timeout) return nullptr;
  JS::SetReservedSlot(state, Base, JS::DoubleValue(base));
  JS::SetReservedSlot(state, ImmediateInfo, JS::ObjectValue(*immediate));
  JS::SetReservedSlot(state, TimeoutInfo, JS::ObjectValue(*timeout));
  for (unsigned slot : {Armed, TimerRef, ImmediateRef, Inside, PreferImmediate})
    JS::SetReservedSlot(state, slot, JS::BooleanValue(false));
  SetDeadline(state, 0);
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
                           bool externalReferences, int* dispatched, int64_t* nextDelay) {
  *dispatched = 0; *nextDelay = -1;
  JS::RootedObject wrapped(cx, GetRuntimeTimerState(cx, runtime, false));
  if (!wrapped) return !JS_IsExceptionPending(cx);
  JS::RootedObject state(cx, UnwrapState(cx, wrapped)); if (!state) return false;
  JSAutoRealm home(cx, state);
  if (JS::GetReservedSlot(state, Inside).isTrue()) return Report(cx, "Reentrant native timer dispatch");
  if (!RefreshClock(cx, state)) return false;
  uint32_t count, refs, outstanding;
  if (!Info(cx, state, ImmediateInfo, &count, &refs, &outstanding)) return false;
  bool timerLive = JS::GetReservedSlot(state, Armed).isTrue() && JS::GetReservedSlot(state, TimerRef).isTrue();
  bool immediateLive = JS::GetReservedSlot(state, ImmediateRef).isTrue();
  if (!timerLive && !immediateLive && !externalReferences) {
    JS::SetReservedSlot(state, PreferImmediate, JS::BooleanValue(false));
    return true;
  }
  bool due = JS::GetReservedSlot(state, Armed).isTrue() &&
             Deadline(state) <= uint64_t(JS::GetReservedSlot(state, Current).toNumber());
  bool immediate = count != 0 && (JS::GetReservedSlot(state, PreferImmediate).isTrue() || !due);
  JS::SetReservedSlot(state, PreferImmediate, JS::BooleanValue(false));
  if (due || immediate) {
    JS::SetReservedSlot(state, Inside, JS::BooleanValue(true));
    auto leave = mozilla::MakeScopeExit([&] { JS::SetReservedSlot(state, Inside, JS::BooleanValue(false)); });
    JS::RootedValue result(cx);
    if (!immediate) JS::SetReservedSlot(state, Armed, JS::BooleanValue(false));
    if (!Call(cx, state, immediate, &result)) return false;
    *dispatched = 1;
    if (immediate) {
      if (!Info(cx, state, ImmediateInfo, &count, &refs, &outstanding)) return false;
      if (!refs) JS::SetReservedSlot(state, ImmediateRef, JS::BooleanValue(false));
      JS::SetReservedSlot(state, PreferImmediate, JS::BooleanValue(outstanding == 1));
    } else {
      int64_t expiry;
      if (!IntegerValue(cx, result, &expiry)) return false;
      if (expiry == std::numeric_limits<int64_t>::min()) return Report(cx, "Native timer expiry is outside the supported signed range");
      if (expiry) {
        uint64_t magnitude = uint64_t(expiry < 0 ? -expiry : expiry);
        uint64_t elapsed = uint64_t(JS::GetReservedSlot(state, Current).toNumber()) -
                           uint64_t(JS::GetReservedSlot(state, Base).toNumber());
        int64_t duration = magnitude > elapsed ? int64_t(magnitude - elapsed) : 1;
        Schedule(state, duration);
      }
      JS::SetReservedSlot(state, TimerRef, JS::BooleanValue(expiry > 0));
      JS::SetReservedSlot(state, PreferImmediate, JS::BooleanValue(true));
    }
  }
  timerLive = JS::GetReservedSlot(state, Armed).isTrue() && JS::GetReservedSlot(state, TimerRef).isTrue();
  immediateLive = JS::GetReservedSlot(state, ImmediateRef).isTrue();
  if (!timerLive && !immediateLive && !externalReferences) {
    JS::SetReservedSlot(state, PreferImmediate, JS::BooleanValue(false));
    return true;
  }
  if (!Info(cx, state, ImmediateInfo, &count, &refs, &outstanding)) return false;
  if (count || immediateLive) *nextDelay = 0;
  else if (JS::GetReservedSlot(state, Armed).isTrue()) {
    uint64_t now = uint64_t(JS::GetReservedSlot(state, Current).toNumber());
    uint64_t expiry = Deadline(state);
    *nextDelay = int64_t(std::min(expiry > now ? expiry - now : 0, uint64_t(INT32_MAX)));
  }
  return true;
}
JSObject* InspectRuntimeTimers(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject wrapped(cx, GetRuntimeTimerState(cx, runtime, false));
  if (!wrapped) { Report(cx, "Native timers have not been initialized"); return nullptr; }
  JS::RootedObject state(cx, UnwrapState(cx, wrapped)); if (!state) return nullptr;
  JS::RootedObject snapshot(cx, JS_NewPlainObject(cx)); if (!snapshot) return nullptr;
  for (const auto& field : {std::pair{"armed", Armed}, std::pair{"timerReferenced", TimerRef},
      std::pair{"immediateReferenced", ImmediateRef}, std::pair{"base", Base},
      std::pair{"now", Current}}) {
    JS::RootedValue value(cx, JS::GetReservedSlot(state, field.second));
    if (!JS_DefineProperty(cx, snapshot, field.first, value, JSPROP_ENUMERATE)) return nullptr;
  }
  JS::Rooted<JS::BigInt*> deadline(cx, JS::NumberToBigInt(cx, Deadline(state)));
  if (!deadline) return nullptr;
  JS::RootedValue value(cx, JS::BigIntValue(deadline));
  if (!JS_DefineProperty(cx, snapshot, "deadline", value, JSPROP_ENUMERATE)) return nullptr;
  return snapshot;
}
}  // namespace kandelo::node
