// Actual VM compiled-code/import owner. ScriptSource's traced private value
// retains this real Stencil/registry through nested scripts and async imports.
#include "kandelo-node-vm-module-hooks.h"
#include "kandelo-node-engine-build-id.h"
#include "builtin/ModuleObject.h"
#include "frontend/Stencil.h"
#include "frontend/CompilationStencil.h"
#include "kandelo-node-vm-script-cache.h"
#include "js/Transcoding.h"
#include "js/CallAndConstruct.h"
#include "js/Modules.h"
#include "js/Promise.h"
#include "js/ScriptPrivate.h"
#include "js/Wrapper.h"
#include "vm/JSFunction.h"
#include "jsfriendapi.h"
namespace {
enum KandeloVmCodeSlot {
  VmCodeStencil, VmCodeRegistry, VmCodeSource, VmCodeFilename,
  VmCodeLineOffset, VmCodeColumnOffset, VmCodeSlotCount
};
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
static bool KandeloVmCacheIdentity(JSContext* cx, HandleString code,
                                   const char* filename, uint32_t lineOffset,
                                   uint32_t columnOffset,
                                   std::vector<uint8_t>* identity) {
  AutoStableStringChars chars(cx);
  if (!chars.initTwoByte(cx, code)) return false;
  const auto units = chars.twoByteRange();
  const bool ok = kandelo::vm::CacheIdentity(
      std::span<const char16_t>(units.begin().get(), units.length()), filename,
      lineOffset, columnOffset, JS::BytecodeOffsetAlignment, identity);
  if (!ok) JS_ReportOutOfMemory(cx);
  return ok;
}
static bool KandeloVmReadCodeOwner(JSContext* cx, HandleValue input,
                                    MutableHandleObject owner,
                                    MutableHandleObject holder) {
  if (!KandeloVmImportChecked(cx, input, owner)) return false;
  if (!owner || JS::GetClass(owner) != &KandeloVmCodeClass) {
    JS_ReportErrorASCII(cx, "VM cache requires its actual compiled Script owner");
    return false;
  }
  RootedValue value(cx, JS::GetReservedSlot(owner, VmCodeStencil));
  if (!KandeloVmImportChecked(cx, value, holder)) return false;
  if (!holder || !holder->is<js::StencilObject>() ||
      !holder->as<js::StencilObject>().hasStencil()) {
    JS_ReportErrorASCII(cx, "VM cache requires a compiled Script stencil");
    return false;
  }
  return true;
}
static bool KandeloVmCreateCachedData(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  try {
    RootedObject owner(cx), holder(cx);
    if (!KandeloVmReadCodeOwner(cx, args.get(0), &owner, &holder)) return false;
    RootedValue result(cx);
    {
      JSAutoRealm realm(cx, owner);
      RootedString code(cx, JS::GetReservedSlot(owner, VmCodeSource).toString());
      RootedString filename(cx, JS::GetReservedSlot(owner, VmCodeFilename).toString());
      UniqueChars bytes = JS_EncodeStringToUTF8(cx, filename);
      if (!bytes) return false;
      const uint32_t line = JS::GetReservedSlot(owner, VmCodeLineOffset).toInt32();
      const uint32_t column = JS::GetReservedSlot(owner, VmCodeColumnOffset).toInt32();
      std::vector<uint8_t> identity;
      if (!KandeloVmCacheIdentity(cx, code, bytes.get(), line, column, &identity)) return false;
      // EncodeStencil merges actual collected delazifications. It neither
      // executes source nor retains any instantiated context/global.
      JS::TranscodeBuffer payload;
      const auto status = JS::EncodeStencil(cx, holder->as<js::StencilObject>().stencil(), payload);
      if (status == JS::TranscodeResult::Throw || JS_IsExceptionPending(cx)) return false;
      RootedObject data(cx);
      if (status != JS::TranscodeResult::Ok) {
        // Like native CreateCodeCache's absent result, an unencodable script
        // yields no cache bytes; do not turn OOM/Throw into ordinary rejection.
        data = KandeloNewUint8ArrayCopy(cx, nullptr, 0);
      } else {
        identity.insert(identity.end(), payload.begin(), payload.end());
        data = KandeloNewUint8ArrayCopy(cx, identity.data(), identity.size());
      }
      if (!data) return false;
      result.setObject(*data);
    }
    if (!JS_WrapValue(cx, &result)) return false;
    args.rval().set(result);return true;
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx);return false; }
}
static bool KandeloVmCacheInfo(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedObject owner(cx), holder(cx);
  if (!KandeloVmReadCodeOwner(cx, args.get(0), &owner, &holder)) return false;
  RootedValue sourceURL(cx), sourceMapURL(cx);
  auto* source = holder->as<js::StencilObject>().stencil()->getInitial()->source.get();
  if (source->hasDisplayURL()) {
    RootedString text(cx, JS_NewUCStringCopyZ(cx, source->displayURL()));
    if (!text) return false;sourceURL.setString(text);
  }
  if (source->hasSourceMapURL()) {
    RootedString text(cx, JS_NewUCStringCopyZ(cx, source->sourceMapURL()));
    if (!text) return false;sourceMapURL.setString(text);
  }
  RootedObject info(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  if (!info || !JS_DefineProperty(cx, info, "sourceURL", sourceURL, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, info, "sourceMapURL", sourceMapURL, JSPROP_ENUMERATE)) return false;
  args.rval().setObject(*info);return true;
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
