// Actual VM compiled-code/import owner. ScriptSource's traced private value
// retains this real Stencil/registry through nested scripts and async imports.
#include "kandelo-node-vm-module-hooks.h"
#include "builtin/ModuleObject.h"
#include "frontend/Stencil.h"
#include "js/CallAndConstruct.h"
#include "js/Modules.h"
#include "js/Promise.h"
#include "js/ScriptPrivate.h"
#include "js/Wrapper.h"
#include "vm/JSFunction.h"
#include "jsfriendapi.h"
namespace {
enum KandeloVmCodeSlot { VmCodeStencil, VmCodeRegistry, VmCodeSlotCount };
static const JSClass KandeloVmCodeClass = {"VMCompiledCode",
  JSCLASS_HAS_RESERVED_SLOTS(VmCodeSlotCount)};
enum KandeloVmImportSlot { VmImportPromise, VmImportOwner, VmImportRequest, VmImportSlotCount };
static const JSClass KandeloVmImportClass = {"VMImport",
  JSCLASS_HAS_RESERVED_SLOTS(VmImportSlotCount)};
static bool KandeloVmImportChecked(JSContext* cx, HandleValue value,
                                    MutableHandleObject output) {
  output.set(nullptr);if (!value.isObject()) return true;
  output.set(js::CheckedUnwrapDynamic(&value.toObject(), cx));
  if (output.get()) return true;
  if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);return false;
}
static bool KandeloVmNewCodeOwner(JSContext* cx, HandleObject stencil,
                                  MutableHandleObject output) {
  RootedObject owner(cx, JS_NewObject(cx, &KandeloVmCodeClass));if (!owner) return false;
  if (stencil) JS::SetReservedSlot(owner, VmCodeStencil, ObjectValue(*stencil));
  output.set(owner);return true;
}
static bool KandeloVmFunctionImportOwner(JSContext* cx, HandleFunction function) {
  RootedScript script(cx, JS_GetFunctionScript(cx, function));
  if (!script) return false;
  RootedObject owner(cx), noStencil(cx);
  if (!KandeloVmNewCodeOwner(cx, noStencil, &owner)) return false;
  JS::SetScriptPrivate(script, ObjectValue(*owner));return true;
}
static bool KandeloVmRegisterImport(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);RootedObject input(cx), owner(cx), registry(cx);
  if (argc != 2) { JS_ReportErrorASCII(cx, "VM import registration requires two arguments");return false; }
  if (!KandeloVmImportChecked(cx, args[0], &input)) return false;
  if (!input) { JS_ReportErrorASCII(cx, "VM import registration requires actual compiled code");return false; }
  if (JS::GetClass(input) == &KandeloVmCodeClass) owner = input;
  else if (input->is<JSFunction>()) {
    JSAutoRealm realm(cx, input);RootedFunction function(cx, &input->as<JSFunction>());
    RootedScript script(cx, JS_GetFunctionScript(cx, function));
    if (!script) {
      if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "VM import registration requires an interpreted compiled function");
      return false;
    }
    RootedValue value(cx, JS::GetScriptPrivate(script));
    if (!KandeloVmImportChecked(cx, value, &owner)) return false;
  }
  if (!owner || JS::GetClass(owner) != &KandeloVmCodeClass || !args[1].isObject()) {
    JS_ReportErrorASCII(cx, "VM import registration requires its actual compiled code and registry");return false;
  }
  // Admission security and caller values stay rooted before entering the
  // actual code owner's realm. Store the real registry, never a dummy ID.
  JSAutoRealm realm(cx, owner);RootedValue value(cx, args[1]);
  if (!JS_WrapValue(cx, &value)) return false;
  JS::SetReservedSlot(owner, VmCodeRegistry, value);args.rval().setUndefined();return true;
}
template<bool Reject>
static bool KandeloVmScriptImportSettled(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedObject transaction(cx, &GetFunctionNativeReserved(&args.callee(), 0).toObject());
  RootedValue promiseValue(cx, JS::GetReservedSlot(transaction, VmImportPromise));
  if (!promiseValue.isObject()) { args.rval().setUndefined();return true; }
  RootedObject promise(cx, &promiseValue.toObject());
  RootedValue owner(cx, JS::GetReservedSlot(transaction, VmImportOwner));
  RootedValue request(cx, JS::GetReservedSlot(transaction, VmImportRequest));
  // Both reactions share this actual transaction. Clear reusable roots before
  // settlement; locals keep the original owner/request through thenable reentry.
  for (size_t i = 0; i < VmImportSlotCount; ++i) JS::SetReservedSlot(transaction, i, UndefinedValue());
  const bool ok = Reject ? JS::RejectPromise(cx, promise, args.get(0))
                         : JS::ResolvePromise(cx, promise, args.get(0));
  args.rval().setUndefined();return ok;
}
}  // namespace
namespace js::shell {
bool KandeloVmScriptDynamic(JSContext* cx, HandleValue privateValue,
                            HandleObject request, HandleObject promise, bool* handled) {
  RootedObject owner(cx);
  if (!KandeloVmImportChecked(cx, privateValue, &owner)) return false;
  *handled = owner && JS::GetClass(owner) == &KandeloVmCodeClass;
  if (!*handled) return true;
  // The import promise and native reactions belong to the actual importing
  // script realm. Only rooted CCWs cross into its callback's original realm.
  RootedValue registryValue(cx, JS::GetReservedSlot(owner, VmCodeRegistry));
  if (!JS_WrapValue(cx, &registryValue)) return false;
  if (!registryValue.isObject()) {
    JS_ReportErrorASCII(cx, "VM compiled code has no registered import owner");return false;
  }
  RootedObject registry(cx, &registryValue.toObject());
  RootedValue callback(cx), referrer(cx), returned(cx), retainedOwner(cx, ObjectValue(*owner));
  if (!JS_GetProperty(cx, registry, "importModuleDynamically", &callback) ||
      !JS_GetProperty(cx, registry, "callbackReferrer", &referrer) ||
      !JS_WrapValue(cx, &retainedOwner)) return false;
  Rooted<ModuleRequestObject*> moduleRequest(cx, &request->as<ModuleRequestObject>());
  RootedObject attributes(cx, moduleRequest->importAttributes());
  if (!attributes) attributes = JS_NewObjectWithGivenProto(cx, nullptr, nullptr);
  if (!attributes) return false;
  RootedFunction fulfilled(cx, NewFunctionWithReserved(cx, KandeloVmScriptImportSettled<false>, 1, 0, ""));
  RootedFunction rejected(cx, NewFunctionWithReserved(cx, KandeloVmScriptImportSettled<true>, 1, 0, ""));
  if (!fulfilled || !rejected) return false;
  RootedObject transaction(cx, JS_NewObject(cx, &KandeloVmImportClass));if (!transaction) return false;
  JS::SetReservedSlot(transaction, VmImportPromise, ObjectValue(*promise));
  JS::SetReservedSlot(transaction, VmImportOwner, retainedOwner);
  JS::SetReservedSlot(transaction, VmImportRequest, ObjectValue(*request));
  for (JSFunction* function : {fulfilled.get(), rejected.get()})
    SetFunctionNativeReserved(function, 0, ObjectValue(*transaction));
  JS::RootedValueArray<4> arguments(cx);
  arguments[0].setString(moduleRequest->specifier());arguments[1].set(referrer);
  arguments[2].setObject(*attributes);arguments[3].setInt32(3);
  // The complete pinned async wrapper owns namespace-or-Module validation,
  // phase names, TLA/throw/reject and namespace-then assimilation semantics.
  if (!JS::Call(cx, UndefinedHandleValue, callback, arguments, &returned)) return false;
  RootedObject completion(cx, JS::CallOriginalPromiseResolve(cx, returned));
  RootedObject onFulfilled(cx, JS_GetFunctionObject(fulfilled)), onRejected(cx, JS_GetFunctionObject(rejected));
  return completion && JS::AddPromiseReactions(cx, completion, onFulfilled, onRejected);
}
}  // namespace js::shell
