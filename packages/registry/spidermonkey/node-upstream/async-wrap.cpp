#include "shell/node-upstream/async-wrap.h"

#include "mozilla/Assertions.h"

#include <cstdint>
#include <iterator>
#include <openssl/opensslv.h>
#include <utility>

#include "jsapi.h"
#include "jsfriendapi.h"
#include "node-async-metadata.generated.h"
#include "js/Array.h"
#include "js/CallAndConstruct.h"
#include "js/CallArgs.h"
#include "js/Conversions.h"
#include "js/experimental/TypedData.h"
#include "js/GCVector.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/Realm.h"
#include "js/ValueArray.h"
#include "js/Wrapper.h"
#include "shell/node-upstream/per-context.h"
#include "shell/node-upstream/realm.h"

namespace kandelo::node {
namespace {
using namespace asyncmeta;
enum StateSlot { Fields, Ids, Stack, Resources, NativeResources, Hooks, HookOwner,
                 Trampoline, TrampolineOwner, PrincipalBinding, StateSlots };
enum BindingSlot { AsyncState, RealmOwner, RuntimeOwner, BindingSlots };
const JSClass kState = {"NodeAsyncState", JSCLASS_HAS_RESERVED_SLOTS(StateSlots)};
const JSClass kBinding = {"NodeAsyncWrapBinding", JSCLASS_HAS_RESERVED_SLOTS(BindingSlots)};
bool Report(JSContext* cx, const char* message) {
  if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "%s", message);
  return false;
}
JSObject* Raw(JSContext* cx, JSObject* object) {
  JSObject* state = js::CheckedUnwrapDynamic(object, cx, false);
  if (!state) { Report(cx, "Native async state access denied"); return nullptr; }
  MOZ_RELEASE_ASSERT(JS::GetClass(state) == &kState);
  return state;
}
JSObject* Binding(JSContext* cx, const JS::CallArgs& args) {
  JSObject* binding = &js::GetFunctionNativeReserved(&args.callee(), 0).toObject();
  MOZ_RELEASE_ASSERT(JS::GetClass(binding) == &kBinding);
  JS::RootedObject owner(cx, &JS::GetReservedSlot(binding, RealmOwner).toObject());
  return CheckRealmLibraryActive(cx, owner) ? binding : nullptr;
}
JSObject* State(JSContext* cx, JS::HandleObject binding) {
  return Raw(cx, &JS::GetReservedSlot(binding, AsyncState).toObject());
}
JSObject* Array(JSObject* state, unsigned slot) {
  return &JS::GetReservedSlot(state, slot).toObject();
}
bool Read(JSContext* cx, JS::HandleObject state, unsigned slot, uint32_t index, double* value) {
  JS::RootedObject array(cx, Array(state, slot));
  size_t minimum = slot == Fields ? kFieldsCount : slot == Ids ? kUidFieldsCount : size_t(index) + 1;
  if (JS_GetTypedArrayLength(array) < minimum)
    return Report(cx, "Native async backing array was detached or has invalid length");
  JS::RootedValue result(cx);
  if (!JS_GetElement(cx, array, index, &result)) return false;
  MOZ_RELEASE_ASSERT(result.isNumber());
  *value = result.toNumber(); return true;
}
bool Write(JSContext* cx, JS::HandleObject state, unsigned slot, uint32_t index, double value) {
  JS::RootedObject array(cx, Array(state, slot));
  if (JS_GetTypedArrayLength(array) <= index)
    return Report(cx, "Native async backing array was detached or has invalid length");
  return JS_SetElement(cx, array, index, value);
}
bool Length(JSContext* cx, JS::HandleObject state, unsigned slot, uint32_t length) {
  JS::RootedObject array(cx, Array(state, slot));
  return JS::SetArrayLength(cx, array, length);
}
bool Grow(JSContext* cx, JS::HandleObject state) {
  JS::RootedObject old(cx, Array(state, Stack));
  size_t size = JS_GetTypedArrayLength(old);
  if (!size || size > UINT32_MAX / 3)
    return Report(cx, "Native async stack cannot grow from its current backing length");
  JS::RootedObject grown(cx, JS_NewFloat64Array(cx, size * 3));
  if (!grown) return false;
  for (uint32_t i = 0; i < size; ++i) {
    JS::RootedValue value(cx);
    if (!JS_GetElement(cx, old, i, &value) || !JS_SetElement(cx, grown, i, value)) return false;
  }
  JS::Value bindingValue = JS::GetReservedSlot(state, PrincipalBinding);
  MOZ_RELEASE_ASSERT(bindingValue.isObject(), "Principal async binding was not initialized");
  JS::RootedObject binding(cx, js::CheckedUnwrapDynamic(&bindingValue.toObject(), cx, false));
  if (!binding) return Report(cx, "Native async binding access denied");
  JS::RootedValue value(cx, JS::ObjectValue(*grown));
  {
    JSAutoRealm realm(cx, binding);
    if (!JS_WrapValue(cx, &value)) return false;
    // This is the original principal binding's mutable publication property.
    // Publish only after allocation/copy; state never reads a public replacement.
    MOZ_RELEASE_ASSERT(JS_SetProperty(cx, binding, "async_ids_stack", value),
        "Native async stack publication invariant");
  }
  JS::SetReservedSlot(state, Stack, JS::ObjectValue(*grown));
  return true;
}
bool Push(JSContext* cx, JS::HandleObject state, double id, double trigger,
          JS::HandleObject resource) {
  double check, depthValue, priorId, priorTrigger;
  if (!Read(cx, state, Fields, kCheck, &check) || !Read(cx, state, Fields, kStackLength, &depthValue) ||
      !Read(cx, state, Ids, kExecutionAsyncId, &priorId) || !Read(cx, state, Ids, kTriggerAsyncId, &priorTrigger)) return false;
  MOZ_RELEASE_ASSERT(!check || (id >= -1 && trigger >= -1), "Node async IDs invariant");
  uint32_t depth = uint32_t(depthValue);
  if (depth > UINT32_MAX / 2) return Report(cx, "Native async stack depth overflow");
  JS::RootedObject stack(cx, Array(state, Stack));
  if (size_t(depth) * 2 >= JS_GetTypedArrayLength(stack) && !Grow(cx, state)) return false;
  if (resource) {
    JS::RootedObject array(cx, Array(state, NativeResources));
    JS::RootedValue value(cx, JS::ObjectValue(*resource));
    if (!JS_WrapValue(cx, &value) || !JS_DefineElement(cx, array, depth, value, JSPROP_ENUMERATE)) return false;
  }
  return Write(cx, state, Stack, depth * 2, priorId) &&
      Write(cx, state, Stack, depth * 2 + 1, priorTrigger) &&
      Write(cx, state, Fields, kStackLength, depth + 1) &&
      Write(cx, state, Ids, kExecutionAsyncId, id) && Write(cx, state, Ids, kTriggerAsyncId, trigger);
}
bool Pop(JSContext* cx, JS::HandleObject state, double expected, bool* more) {
  double depthValue, check, current;
  if (!Read(cx, state, Fields, kStackLength, &depthValue) || !Read(cx, state, Fields, kCheck, &check) ||
      !Read(cx, state, Ids, kExecutionAsyncId, &current)) return false;
  if (!depthValue) { *more = false; return true; }
  MOZ_RELEASE_ASSERT(!check || current == expected, "Node async stack corruption invariant");
  uint32_t offset = uint32_t(depthValue) - 1;
  if (offset > UINT32_MAX / 2) return Report(cx, "Native async stack depth overflow");
  double id, trigger;
  if (!Read(cx, state, Stack, offset * 2, &id) || !Read(cx, state, Stack, offset * 2 + 1, &trigger) ||
      !Write(cx, state, Ids, kExecutionAsyncId, id) || !Write(cx, state, Ids, kTriggerAsyncId, trigger) ||
      !Write(cx, state, Fields, kStackLength, offset) || !Length(cx, state, NativeResources, offset)) return false;
  JS::RootedObject resources(cx, Array(state, Resources)); uint32_t length;
  if (!JS::GetArrayLength(cx, resources, &length)) return false;
  if (length > offset && !Length(cx, state, Resources, offset)) return false;
  *more = offset > 0; return true;
}
bool PushMethod(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  double id, trigger;
  MOZ_RELEASE_ASSERT(JS::ToNumber(cx, args.get(0), &id) && JS::ToNumber(cx, args.get(1), &trigger),
      "Node async ID conversion invariant");
  JS::RootedObject state(cx, State(cx, binding)); if (!state) return false;
  JSAutoRealm home(cx, state); JS::RootedObject empty(cx);
  if (!Push(cx, state, id, trigger, empty)) return false;
  args.rval().setUndefined(); return true;
}
bool PopMethod(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  double id; MOZ_RELEASE_ASSERT(JS::ToNumber(cx, args.get(0), &id), "Node async ID conversion invariant");
  JS::RootedObject state(cx, State(cx, binding)); if (!state) return false;
  JSAutoRealm home(cx, state); bool more;
  if (!Pop(cx, state, id, &more)) return false;
  args.rval().setBoolean(more); return true;
}
bool Clear(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  JS::RootedObject state(cx, State(cx, binding)); if (!state) return false;
  JSAutoRealm home(cx, state);
  if (!Length(cx, state, Resources, 0) || !Length(cx, state, NativeResources, 0) ||
      !Write(cx, state, Ids, kExecutionAsyncId, 0) || !Write(cx, state, Ids, kTriggerAsyncId, 0) ||
      !Write(cx, state, Fields, kStackLength, 0)) return false;
  args.rval().setUndefined(); return true;
}
bool Resource(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  uint32_t index; if (!JS::ToUint32(cx, args.get(0), &index)) return false;
  JS::RootedObject state(cx, State(cx, binding)); if (!state) return false;
  JS::RootedValue value(cx);
  {
    JSAutoRealm home(cx, state);
    JS::RootedObject resources(cx, Array(state, NativeResources)); bool present;
    uint32_t length;
    // A native resource vector has no prototype lookups for absent entries.
    if (!JS::GetArrayLength(cx, resources, &length)) return false;
    if (index < length) {
      JS::RootedId key(cx);
      if (!JS_IndexToId(cx, index, &key) || !JS_HasOwnPropertyById(cx, resources, key, &present)) return false;
      if (present && !JS_GetElement(cx, resources, index, &value)) return false;
    }
  }
  if (!JS_WrapValue(cx, &value)) return false;
  args.rval().set(value); return true;
}
bool Setup(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  MOZ_RELEASE_ASSERT(args.get(0).isObject(), "Node async hooks object invariant");
  JS::RootedObject state(cx, State(cx, binding)); if (!state) return false;
  MOZ_RELEASE_ASSERT(JS::GetReservedSlot(state, HookOwner).isUndefined(), "Node async hooks once invariant");
  JS::RootedObject input(cx, &args[0].toObject());
  JS::RootedValueVector values(cx);
  for (const char* name : {"init", "before", "after", "destroy", "promise_resolve"}) {
    JS::RootedValue value(cx);
    MOZ_RELEASE_ASSERT(JS_GetProperty(cx, input, name, &value), "Node async hook property read invariant");
    MOZ_RELEASE_ASSERT(value.isObject() && JS::IsCallable(&value.toObject()), "Node async hook function invariant");
    if (!values.append(value)) return false;
  }
  JS::RootedValue owner(cx, JS::GetReservedSlot(binding, RealmOwner));
  JSAutoRealm home(cx, state);
  if (!JS_WrapValue(cx, &owner)) return false;
  for (size_t i = 0; i < values.length(); ++i) if (!JS_WrapValue(cx, values[i])) return false;
  JS::RootedObject hooks(cx, JS::NewArrayObject(cx, values)); if (!hooks) return false;
  JS::SetReservedSlot(state, Hooks, JS::ObjectValue(*hooks)); JS::SetReservedSlot(state, HookOwner, owner);
  args.rval().setUndefined(); return true;
}
bool SetTrampoline(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  JS::RootedObject state(cx, State(cx, binding)); if (!state) return false;
  JS::RootedValue value(cx, args.get(0)), owner(cx, JS::GetReservedSlot(binding, RealmOwner));
  if (!value.isObject() || !JS::IsCallable(&value.toObject())) { value.setUndefined(); owner.setUndefined(); }
  JSAutoRealm home(cx, state);
  if (!JS_WrapValue(cx, &value) || !JS_WrapValue(cx, &owner)) return false;
  JS::SetReservedSlot(state, Trampoline, value); JS::SetReservedSlot(state, TrampolineOwner, owner);
  args.rval().setUndefined(); return true;
}
bool PromiseHooks(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  if (!Binding(cx, args)) return false;
  for (size_t i = 0; i < 4; ++i)
    if (args.get(i).isObject() && JS::IsCallable(&args[i].toObject()))
      return Report(cx, "Native promise lifecycle hooks are not implemented");
  // No hook has been installed: clearing the real empty registration is valid.
  args.rval().setUndefined(); return true;
}
bool GetPromiseHooks(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  if (!Binding(cx, args)) return false;
  JS::RootedValueArray<4> values(cx);
  JS::RootedObject result(cx, JS::NewArrayObject(cx, values)); if (!result) return false;
  args.rval().setObject(*result); return true;
}
bool QueueDestroy(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject binding(cx, Binding(cx, args)); if (!binding) return false;
  MOZ_RELEASE_ASSERT(args.get(0).isNumber(), "Node destroy async ID invariant");
  JS::RootedObject state(cx, State(cx, binding)); if (!state) return false;
  JSAutoRealm home(cx, state); double count;
  if (!Read(cx, state, Fields, kDestroy, &count)) return false;
  if (count) return Report(cx, "Native async destroy-event delivery is not implemented");
  args.rval().setUndefined(); return true;
}
bool RegisterDestroy(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  if (!Binding(cx, args)) return false;
  MOZ_RELEASE_ASSERT(args.get(0).isObject() && args.get(1).isNumber() &&
      (args.length() == 2 || args.get(2).isObject()), "Node GC destroy registration invariant");
  return Report(cx, "Native GC destroy observers are not implemented");
}
}  // namespace

JSObject* CreateRuntimeAsyncState(JSContext* cx) {
  JS::RootedObject state(cx, JS_NewObject(cx, &kState)); if (!state) return nullptr;
  struct Backing { unsigned first; size_t second; };
  for (const auto& entry : {Backing{Fields, kFieldsCount}, Backing{Ids, kUidFieldsCount}, Backing{Stack, 32}}) {
    JS::RootedObject array(cx, entry.first == Fields ? JS_NewUint32Array(cx, entry.second) : JS_NewFloat64Array(cx, entry.second));
    if (!array) return nullptr;
    JS::SetReservedSlot(state, entry.first, JS::ObjectValue(*array));
  }
  for (unsigned slot : {Resources, NativeResources, Hooks}) {
    JS::RootedObject array(cx, JS::NewArrayObject(cx, 0)); if (!array) return nullptr;
    JS::SetReservedSlot(state, slot, JS::ObjectValue(*array));
  }
  // Exact AsyncHooks constructor state, not a post-bootstrap native snapshot.
  if (!Write(cx, state, Fields, kCheck, 1) || !Write(cx, state, Ids, kDefaultTriggerAsyncId, -1) ||
      !Write(cx, state, Ids, kAsyncIdCounter, 1)) return nullptr;
  return state;
}
JSObject* CreateAsyncWrapBinding(JSContext* cx, JS::HandleObject runtime, JS::HandleObject realm) {
  JS::RootedObject state(cx, GetRuntimeAsyncState(cx, runtime, true)); if (!state) return nullptr;
  JS::RootedObject binding(cx, JS_NewObject(cx, &kBinding)); if (!binding) return nullptr;
  JS::SetReservedSlot(binding, AsyncState, JS::ObjectValue(*state));
  JS::SetReservedSlot(binding, RealmOwner, JS::ObjectValue(*realm));
  JS::SetReservedSlot(binding, RuntimeOwner, JS::ObjectValue(*runtime));
  struct Method { const char* name; JSNative native; };
  for (const auto& method : {Method{"setupHooks", Setup}, Method{"setCallbackTrampoline", SetTrampoline},
      Method{"pushAsyncContext", PushMethod}, Method{"popAsyncContext", PopMethod}, Method{"executionAsyncResource", Resource},
      Method{"clearAsyncIdStack", Clear}, Method{"queueDestroyAsyncId", QueueDestroy}, Method{"setPromiseHooks", PromiseHooks},
      Method{"getPromiseHooks", GetPromiseHooks}, Method{"registerDestroyHook", RegisterDestroy}}) {
    JS::RootedFunction function(cx, js::NewFunctionWithReserved(cx, method.native, 0, 0, method.name));
    if (!function) return nullptr;
    JS::RootedObject object(cx, JS_GetFunctionObject(function));
    js::SetFunctionNativeReserved(object, 0, JS::ObjectValue(*binding));
    if (!JS_DefineProperty(cx, binding, method.name, object, JSPROP_ENUMERATE)) return nullptr;
  }
  JS::RootedObject raw(cx, Raw(cx, state)); if (!raw) return nullptr;
  for (const auto& entry : {std::pair{"async_hook_fields", Fields}, std::pair{"async_id_fields", Ids},
      std::pair{"execution_async_resources", Resources}, std::pair{"async_ids_stack", Stack}}) {
    JS::RootedValue value(cx, JS::GetReservedSlot(raw, entry.second));
    unsigned flags = JSPROP_ENUMERATE | (entry.second == Stack ? 0 : JSPROP_READONLY | JSPROP_PERMANENT);
    if (!JS_WrapValue(cx, &value) || !JS_DefineProperty(cx, binding, entry.first, value, flags)) return nullptr;
  }
  for (bool providers : {false, true}) {
    JS::RootedObject table(cx, JS_NewPlainObject(cx)); if (!table) return nullptr;
    const auto* entries = providers ? kProviders : kConstants;
    size_t size = providers ? std::size(kProviders) : std::size(kConstants);
    for (size_t i = 0; i < size; ++i)
      if (!JS_DefineProperty(cx, table, entries[i].name, entries[i].value, JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT)) return nullptr;
    if (!JS_DefineProperty(cx, binding, providers ? "Providers" : "constants", table,
        JSPROP_ENUMERATE | JSPROP_READONLY | JSPROP_PERMANENT)) return nullptr;
  }
  JS::RootedObject principal(cx, GetRuntimePrincipalRealm(cx, runtime)); if (!principal) return nullptr;
  if (principal == realm) {
    JS::RootedObject wrapped(cx, binding);
    JSAutoRealm home(cx, raw);
    if (!JS_WrapObject(cx, &wrapped)) return nullptr;
    JS::SetReservedSlot(raw, PrincipalBinding, JS::ObjectValue(*wrapped));
  }
  return binding;
}
bool PushRuntimeAsyncContext(JSContext* cx, JS::HandleObject runtime, double id, double trigger, JS::HandleObject resource) {
  JS::RootedObject wrapped(cx, GetRuntimeAsyncState(cx, runtime, true)); if (!wrapped) return false;
  JS::RootedObject state(cx, Raw(cx, wrapped)); if (!state) return false;
  JSAutoRealm home(cx, state); return Push(cx, state, id, trigger, resource);
}
bool PopRuntimeAsyncContext(JSContext* cx, JS::HandleObject runtime, double id, bool* more) {
  JS::RootedObject wrapped(cx, GetRuntimeAsyncState(cx, runtime, false)); if (!wrapped) return false;
  JS::RootedObject state(cx, Raw(cx, wrapped)); if (!state) return false;
  JSAutoRealm home(cx, state); return Pop(cx, state, id, more);
}
bool RuntimeExecutionAsyncId(JSContext* cx, JS::HandleObject runtime, double* id) {
  JS::RootedObject wrapped(cx, GetRuntimeAsyncState(cx, runtime, false)); if (!wrapped) return false;
  JS::RootedObject state(cx, Raw(cx, wrapped)); if (!state) return false;
  JSAutoRealm home(cx, state); return Read(cx, state, Ids, kExecutionAsyncId, id);
}
JSObject* InspectRuntimeAsyncState(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject wrapped(cx, GetRuntimeAsyncState(cx, runtime, false)); if (!wrapped) return nullptr;
  JS::RootedObject state(cx, Raw(cx, wrapped)); if (!state) return nullptr;
  JS::RootedObject result(cx, JS_NewPlainObject(cx)); if (!result) return nullptr;
  JS::RootedValue hooks(cx, JS::BooleanValue(JS::GetReservedSlot(state, HookOwner).isObject()));
  JS::RootedValue trampoline(cx, JS::BooleanValue(JS::GetReservedSlot(state, Trampoline).isObject()));
  if (!JS_DefineProperty(cx, result, "hooksRegistered", hooks, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, result, "trampolineRegistered", trampoline, JSPROP_ENUMERATE)) return nullptr;
  return result;
}
}  // namespace kandelo::node
