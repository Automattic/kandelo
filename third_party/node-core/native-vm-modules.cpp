/* Node VM modules own actual SpiderMonkey ModuleObjects. Public algorithms
 * and validation remain pinned JS; record graphs/namespaces/evaluation live
 * in the engine, including embedding synthetic callbacks and live exports. */
#include "kandelo-node-vm-module-hooks.h"
#include "builtin/ModuleObject.h"
#include "js/CallAndConstruct.h"
#include "js/CharacterEncoding.h"
#include "js/ErrorReport.h"
#include "js/Exception.h"
#include "js/Modules.h"
#include "js/Promise.h"
#include "js/Realm.h"
#include "js/Stack.h"
#include "jsfriendapi.h"
#include "vm/EnvironmentObject.h"
#include <new>
#include <cstring>
#include <utility>
#include <initializer_list>

namespace {
enum KandeloVmModuleSlot { VmRecord, VmLinks, VmRegistry, VmModuleSlotCount };
static const JSClass KandeloVmModuleClass = {
  "ModuleWrap", JSCLASS_HAS_RESERVED_SLOTS(VmModuleSlotCount)};
static bool KandeloVmModuleRaiseMessage(JSContext* cx, const char* code,
                                        HandleString message, JSExnType kind) {
  if (JS_IsExceptionPending(cx)) return false;
  RootedString file(cx, JS_GetEmptyString(cx));
  RootedObject stack(cx); RootedValue exception(cx);
  if (!JS::CaptureCurrentStack(cx, &stack) ||
      !JS::CreateError(cx, kind, stack, file, 0, JS::ColumnNumberOneOrigin(1),
                       nullptr, message, JS::NothingHandleValue, &exception)) return false;
  if (code) {
    RootedObject object(cx, &exception.toObject());
    RootedString value(cx, JS_NewStringCopyZ(cx, code));
    if (!value || !JS_DefineProperty(cx, object, "code", value, JSPROP_ENUMERATE)) return false;
  }
  JS_SetPendingException(cx, exception); return false;
}
static bool KandeloVmModuleRaise(JSContext* cx, const char* code,
                                 const char* text, JSExnType kind = JSEXN_ERR) {
  if (JS_IsExceptionPending(cx)) return false;
  RootedString message(cx, JS_NewStringCopyZ(cx, text));
  return message && KandeloVmModuleRaiseMessage(cx, code, message, kind);
}
static bool KandeloVmModuleUnavailable(JSContext* cx, const char* text) {
  return KandeloVmModuleRaise(cx, "ERR_METHOD_NOT_IMPLEMENTED", text);
}
static JSObject* KandeloVmModuleOwner(JSContext* cx, HandleValue value) {
  if (!value.isObject()) return nullptr;
  JSObject* object = js::CheckedUnwrapDynamic(&value.toObject(), cx);
  return object && JS::GetClass(object) == &KandeloVmModuleClass ? object : nullptr;
}
static ModuleObject* KandeloVmModuleRecord(JSObject* owner) {
  return &JS::GetReservedSlot(owner, VmRecord).toObject().as<ModuleObject>();
}
static int KandeloVmModuleStatus(ModuleObject* module) {
  if (module->hadEvaluationError()) return 5;
  switch (module->status()) {
    case ModuleStatus::Unlinked: return 0;
    case ModuleStatus::Linking: return 1;
    case ModuleStatus::Linked: return 2;
    case ModuleStatus::Evaluating: return 3;
    // Node/V8's record reports evaluated while its evaluation Promise is
    // pending for TLA. The actual SM async state/Promise remain untouched.
    case ModuleStatus::EvaluatingAsync: case ModuleStatus::Evaluated: return 4;
    case ModuleStatus::Evaluated_Error: return 5;
  }
  MOZ_CRASH("Unexpected module status");
}
static bool KandeloVmModuleAttributes(JSContext* cx, Handle<ModuleRequestObject*> request,
                                      MutableHandleObject result) {
  // SM140 currently discards unsupported static attribute values. Never infer
  // them from source text or silently claim an empty request record.
  if (request->hasFirstUnsupportedAttributeKey() || request->moduleType() == JS::ModuleType::Unknown)
    return KandeloVmModuleUnavailable(cx, "VM module import attribute retention requires engine support");
  RootedObject attributes(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  if (!attributes) return false;
  if (request->moduleType() == JS::ModuleType::JSON) {
    RootedString type(cx, JS_NewStringCopyZ(cx, "json"));
    if (!type || !JS_DefineProperty(cx, attributes, "type", type, JSPROP_ENUMERATE)) return false;
  }
  if (!JS_FreezeObject(cx, attributes)) return false;
  result.set(attributes); return true;
}
static bool KandeloVmModuleRequests(JSContext* cx, Handle<ModuleObject*> module,
                                    MutableHandleValue output) {
  const size_t count = module->hasCyclicModuleFields() ? module->requestedModules().size() : 0;
  RootedObject requests(cx, JS::NewArrayObject(cx, count));
  if (!requests) return false;
  for (size_t i = 0; i < count; i++) {
    Rooted<ModuleRequestObject*> request(cx, module->requestedModules()[i].moduleRequest());
    RootedObject attributes(cx), item(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
    if (!item || !KandeloVmModuleAttributes(cx, request, &attributes)) return false;
    RootedString specifier(cx, request->specifier());
    // All accepted SM140 source text imports use evaluation phase. Unsupported
    // source/defer phase syntax stays a real parser gap, without rewriting it.
    if (!JS_DefineProperty(cx, item, "specifier", specifier, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, item, "attributes", attributes, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, item, "phase", 3, JSPROP_ENUMERATE) ||
        !JS_FreezeObject(cx, item)) return false;
    RootedValue value(cx, ObjectValue(*item));
    if (!JS_DefineElement(cx, requests, uint32_t(i), value, JSPROP_ENUMERATE)) return false;
  }
  output.setObject(*requests); return true;
}
static bool KandeloVmModuleAsyncGraph(JSContext* cx, HandleObject owner,
                                      MutableHandleValue output) {
  RootedObjectVector pending(cx), visited(cx);
  if (!pending.append(owner)) return false;
  while (!pending.empty()) {
    RootedObject current(cx, pending.popCopy());
    bool seen = false;
    for (auto* item : visited) if (item == current) { seen = true; break; }
    if (seen) continue;
    if (!visited.append(current)) return false;
    auto* record = KandeloVmModuleRecord(current);
    if (record->hasCyclicModuleFields() && record->hasTopLevelAwait()) {
      output.setBoolean(true); return true;
    }
    const auto linksValue = JS::GetReservedSlot(current, VmLinks);
    if (!linksValue.isObject()) continue;
    RootedObject links(cx, &linksValue.toObject()); uint32_t count;
    if (!JS::GetArrayLength(cx, links, &count)) return false;
    for (uint32_t i = 0; i < count; i++) {
      RootedValue linked(cx);
      if (!JS_GetElement(cx, links, i, &linked)) return false;
      RootedObject next(cx, KandeloVmModuleOwner(cx, linked));
      if (!next || !pending.append(next)) return false;
    }
  }
  output.setBoolean(false); return true;
}
static bool KandeloVmModuleNew(JSContext* cx, JS::HandleValueArray values,
                                MutableHandleValue output) {
  // values: prototype, identifier, actual target global, source/exportNames,
  // lineOffset/evaluationSteps, columnOffset, cachedData.
  RootedObject prototype(cx, &values[0].toObject());
  RootedObject owner(cx, JS_NewObjectWithGivenProto(cx, &KandeloVmModuleClass, prototype));
  if (!owner) return false;
  Rooted<ModuleObject*> module(cx);
  if (values[3].isString()) {
    if (!values[6].isUndefined())
      return KandeloVmModuleUnavailable(cx, "VM SourceTextModule persistent code cache");
    if (!values[4].isInt32() || !values[5].isInt32()) {
      JS_ReportErrorASCII(cx, "VM module source offsets must be int32"); return false;
    }
    const auto line = values[4].toInt32(), column = values[5].toInt32();
    if (line < 0 || column < 0)
      return KandeloVmModuleUnavailable(cx, "VM module negative source offsets");
    RootedString source(cx, values[3].toString()), filename(cx, values[1].toString());
    UniqueChars name = JS_EncodeStringToUTF8(cx, filename);
    if (!name) return false;
    AutoStableStringChars stable(cx);
    if (!stable.initTwoByte(cx, source)) return false;
    JS::SourceText<char16_t> text;
    if (!text.initMaybeBorrowed(cx, stable)) return false;
    JS::CompileOptions options(cx);
    options.setFileAndLine(name.get(), uint32_t(line) + 1)
        .setColumn(JS::ColumnNumberOneOrigin::fromZeroOrigin(uint32_t(column)));
    RootedObject compiled(cx, JS::CompileModule(cx, options, text));
    if (!compiled) return false;
    module = &compiled->as<ModuleObject>();
    JS::SetModulePrivate(module, ObjectValue(*owner));
  } else {
    if (!values[3].isObject() || !values[4].isObject() || !JS::IsCallable(&values[4].toObject())) {
      JS_ReportErrorASCII(cx, "VM synthetic module requires export names and evaluation steps"); return false;
    }
    RootedObject exports(cx, &values[3].toObject()), steps(cx, &values[4].toObject());
    uint32_t count;
    if (!JS::GetArrayLength(cx, exports, &count)) return false;
    Rooted<ExportNameVector> names(cx); RootedValueVector initial(cx);
    for (uint32_t i = 0; i < count; i++) {
      RootedValue value(cx);
      if (!JS_GetElement(cx, exports, i, &value)) return false;
      if (!value.isString()) { JS_ReportErrorASCII(cx, "Synthetic export name must be a string"); return false; }
      Rooted<JSAtom*> name(cx, AtomizeString(cx, value.toString()));
      if (!name || !names.append(name) || !initial.append(UndefinedValue())) return false;
    }
    module = ModuleObject::createEmbedderSynthetic(cx, &names, steps, owner);
    if (!module || !ModuleObject::createSyntheticEnvironment(cx, module, initial)) return false;
  }
  JS::SetReservedSlot(owner, VmRecord, ObjectValue(*module));
  if (module->isEmbedderSynthetic()) {
    RootedObject links(cx, JS::NewArrayObject(cx, 0));
    if (!links) return false;
    JS::SetReservedSlot(owner, VmLinks, ObjectValue(*links));
  }
  // Source linkRequests admission is separate from the module's unlinked
  // status; even an empty request list must be explicitly supplied by JS.
  if (!JS_DefineProperty(cx, owner, "url", values[1], JSPROP_ENUMERATE)) return false;
  output.setObject(*owner); return true;
}
static bool KandeloVmModuleDispatch(JSContext* cx, const char* operation,
                                     HandleObject owner, JS::HandleValueArray values,
                                     MutableHandleValue output) {
  Rooted<ModuleObject*> record(cx, KandeloVmModuleRecord(owner));
  if (!strcmp(operation, "register")) {
    if (!values[1].isObject()) { JS_ReportErrorASCII(cx, "Invalid VM module registry"); return false; }
    JS::SetReservedSlot(owner, VmRegistry, values[1]); return true;
  }
  if (!strcmp(operation, "status")) { output.setInt32(KandeloVmModuleStatus(record)); return true; }
  if (!strcmp(operation, "error")) {
    if (!record->hadEvaluationError())
      return KandeloVmModuleRaise(cx, "ERR_VM_MODULE_STATUS", "Module status must be errored");
    output.set(record->evaluationError()); return true;
  }
  if (!strcmp(operation, "requests")) return KandeloVmModuleRequests(cx, record, output);
  if (!strcmp(operation, "namespace")) {
    if (record->status() < ModuleStatus::Linked)
      return KandeloVmModuleRaise(cx, "ERR_VM_MODULE_STATUS", "Module status must not be unlinked or linking");
    RootedObject ns(cx, JS::GetModuleNamespace(cx, record));
    if (!ns) return false;
    output.setObject(*ns); return true;
  }
  if (!strcmp(operation, "topLevelAwait")) {
    output.setBoolean(record->hasCyclicModuleFields() && record->hasTopLevelAwait()); return true;
  }
  if (!strcmp(operation, "asyncGraph")) return KandeloVmModuleAsyncGraph(cx, owner, output);
  if (!strcmp(operation, "link")) {
    if (record->status() != ModuleStatus::Unlinked)
      return KandeloVmModuleRaise(cx, "ERR_VM_MODULE_ALREADY_LINKED", "Module has already been linked");
    if (!values[1].isObject()) { JS_ReportErrorASCII(cx, "VM module links require an array"); return false; }
    RootedObject input(cx, &values[1].toObject()); uint32_t count;
    if (!JS::GetArrayLength(cx, input, &count)) return false;
    const size_t expected = record->hasCyclicModuleFields() ? record->requestedModules().size() : 0;
    if (count != expected) return KandeloVmModuleRaise(cx, "ERR_MODULE_LINK_MISMATCH", "VM module link request count mismatch");
    RootedObject snapshot(cx, JS::NewArrayObject(cx, count));
    if (!snapshot) return false;
    for (uint32_t i = 0; i < count; i++) {
      RootedValue value(cx);
      if (!JS_GetElement(cx, input, i, &value)) return false;
      RootedObject dependency(cx, KandeloVmModuleOwner(cx, value));
      if (!dependency || JS::GetObjectRealmOrNull(dependency) != JS::GetObjectRealmOrNull(owner))
        return KandeloVmModuleRaise(cx, "ERR_VM_MODULE_DIFFERENT_CONTEXT", "Linked modules must use the same context");
      RootedValue saved(cx, ObjectValue(*dependency));
      if (!JS_DefineElement(cx, snapshot, i, saved, JSPROP_ENUMERATE)) return false;
    }
    JS::SetReservedSlot(owner, VmLinks, ObjectValue(*snapshot)); return true;
  }
  if (!strcmp(operation, "instantiate")) {
    if (!JS::GetReservedSlot(owner, VmLinks).isObject())
      return KandeloVmModuleRaise(cx, "ERR_VM_MODULE_LINK_FAILURE", "module is not linked");
    return JS::ModuleLink(cx, record);
  }
  if (!strcmp(operation, "evaluate")) {
    if (!values[1].isNumber() || values[1].toNumber() != -1 || values[2].isTrue())
      return KandeloVmModuleUnavailable(cx, "VM module owned timeout/SIGINT execution scope");
    return JS::ModuleEvaluate(cx, record, output);
  }
  if (!strcmp(operation, "setExport")) {
    if (!record->isEmbedderSynthetic() || !values[1].isString()) {
      JS_ReportErrorASCII(cx, "VM setExport requires an actual synthetic module"); return false;
    }
    Rooted<JSAtom*> name(cx, AtomizeString(cx, values[1].toString()));
    if (!name) return false;
    if (!ModuleObject::setSyntheticExport(cx, record, name, values[2])) {
      RootedString prefix(cx, JS_NewStringCopyZ(cx, "Export '"));
      RootedString suffix(cx, JS_NewStringCopyZ(cx, "' is not defined in module"));
      RootedString exportName(cx, values[1].toString()), message(cx);
      if (!prefix || !suffix) return false;
      message = JS_ConcatStrings(cx, prefix, exportName);
      if (!message) return false;
      message = JS_ConcatStrings(cx, message, suffix);
      return message && KandeloVmModuleRaiseMessage(cx, nullptr, message, JSEXN_REFERENCEERR);
    }
    return true;
  }
  if (!strcmp(operation, "cache")) return KandeloVmModuleUnavailable(cx, "VM SourceTextModule persistent code cache");
  return KandeloVmModuleUnavailable(cx, "VM source-phase module objects");
}
static bool KandeloVmModuleOperationImpl(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "VM module operation requires a name"); return false; }
  RootedString name(cx, args[0].toString()); UniqueChars operation = JS_EncodeStringToUTF8(cx, name);
  if (!operation) return false;
  if (!strcmp(operation.get(), "constants")) {
    RootedObject constants(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
    if (!constants) return false;
    const std::pair<const char*, int> fields[] = {{"kUninstantiated",0},{"kInstantiating",1},
      {"kInstantiated",2},{"kEvaluating",3},{"kEvaluated",4},{"kErrored",5},
      {"kSourcePhase",1},{"kEvaluationPhase",3}};
    for (const auto& field : fields)
      if (!JS_DefineProperty(cx, constants, field.first, field.second, JSPROP_ENUMERATE)) return false;
    args.rval().setObject(*constants); return true;
  }
  const bool constructing = !strcmp(operation.get(), "new");
  size_t expected = constructing ? 8 : 2;
  if (!strcmp(operation.get(), "register") || !strcmp(operation.get(), "link")) expected = 3;
  if (!strcmp(operation.get(), "evaluate") || !strcmp(operation.get(), "setExport")) expected = 4;
  if (args.length() != expected) { JS_ReportErrorASCII(cx, "Invalid VM module operation arguments"); return false; }
  RootedObject target(cx);
  if (constructing) {
    if (args.length() != 8 || !args[1].isObject() || !args[2].isString() || !args[3].isObject()) {
      JS_ReportErrorASCII(cx, "Invalid VM module construction arguments"); return false;
    }
    // globalThis can be the real shell WindowProxy. Keep security checks while
    // reaching its owning inner global for module compilation.
    target = js::CheckedUnwrapDynamic(&args[3].toObject(), cx, false);
    if (!target || !JS_IsGlobalObject(target)) { JS_ReportErrorASCII(cx, "VM module requires a real context global"); return false; }
  } else {
    target = KandeloVmModuleOwner(cx, args.get(1));
    if (!target) { JS_ReportErrorASCII(cx, "Invalid native VM module receiver"); return false; }
  }
  RootedValueVector values(cx);
  for (size_t i = 1; i < args.length(); i++) if (!values.append(args[i])) return false;
  RootedValue result(cx), exception(cx); bool ok = false, threw = false;
  {
    JSAutoRealm realm(cx, target);
    ok = [&]() {
      for (size_t i = 0; i < values.length(); i++) if (!JS_WrapValue(cx, values[i])) return false;
      return constructing ? KandeloVmModuleNew(cx, values, &result) :
          KandeloVmModuleDispatch(cx, operation.get(), target, values, &result);
    }();
    if (!ok && JS_IsExceptionPending(cx) && !JS_IsThrowingOutOfMemory(cx)) {
      if (!JS_GetPendingException(cx, &exception)) return false;
      JS_ClearPendingException(cx); threw = true;
    }
  }
  if (ok) {
    if (!JS_WrapValue(cx, &result)) return false;
    args.rval().set(result); return true;
  }
  if (threw) {
    if (!JS_WrapValue(cx, &exception)) return false;
    JS_SetPendingException(cx, exception);
  }
  return false;
}
static bool KandeloVmModuleOperation(JSContext* cx, unsigned argc, Value* vp) {
  try { return KandeloVmModuleOperationImpl(cx, argc, vp); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
}  // namespace

namespace {
static JSObject* KandeloVmPrivateModule(HandleValue value) {
  if (!value.isObject() || JS::GetClass(&value.toObject()) != &KandeloVmModuleClass) return nullptr;
  return &value.toObject();
}
static bool KandeloVmModuleRegistryValue(JSContext* cx, HandleObject owner,
                                         const char* name, MutableHandleValue value) {
  const auto registry = JS::GetReservedSlot(owner, VmRegistry);
  if (!registry.isObject()) { value.setUndefined(); return true; }
  RootedValue wrapped(cx, registry);
  if (!JS_WrapValue(cx, &wrapped)) return false;
  RootedObject object(cx, &wrapped.toObject());
  return JS_GetProperty(cx, object, name, value);
}
template <bool Reject>
static bool KandeloVmImportSettled(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  RootedObject promise(cx, &js::GetFunctionNativeReserved(&args.callee(), 0).toObject());
  // Slot1 retains the actual referrer record/registry/graph until the native
  // Promise reaction runs. No raw C++ or untraced realm pointer survives.
  RootedObject owner(cx, &js::GetFunctionNativeReserved(&args.callee(), 1).toObject());
  if constexpr (Reject) {
    if (!JS::RejectPromise(cx, promise, args.get(0))) return false;
  } else {
    // The pinned async callback wrapper already validates the module before
    // returning its namespace. A callable namespace export named then can
    // assimilate that return into any value; forward the settled value exactly
    // as Node ModuleWrap does, without another namespace assertion here.
    if (!JS::ResolvePromise(cx, promise, args.get(0))) return false;
  }
  args.rval().setUndefined(); return true;
}
}  // namespace

namespace js::shell {
bool KandeloVmModuleResolve(JSContext* cx, HandleValue privateValue,
                            HandleObject request, MutableHandleObject result,
                            bool* handled) {
  RootedObject owner(cx, KandeloVmPrivateModule(privateValue));
  *handled = !!owner;
  if (!owner) return true;
  if (JS::GetObjectRealmOrNull(owner) != cx->realm())
    return KandeloVmModuleRaise(cx, "ERR_VM_MODULE_DIFFERENT_CONTEXT", "Linked modules must use the same context");
  Rooted<ModuleObject*> record(cx, KandeloVmModuleRecord(owner));
  const auto linksValue = JS::GetReservedSlot(owner, VmLinks);
  if (!linksValue.isObject())
    return KandeloVmModuleRaise(cx, "ERR_VM_MODULE_LINK_FAILURE", "module is not linked");
  RootedObject links(cx, &linksValue.toObject()); uint32_t count;
  if (!JS::GetArrayLength(cx, links, &count)) return false;
  for (uint32_t i = 0; i < record->requestedModules().size(); i++) {
    if (record->requestedModules()[i].moduleRequest() != request) continue;
    if (i >= count) break;
    RootedValue linked(cx);
    if (!JS_GetElement(cx, links, i, &linked)) return false;
    RootedObject dependency(cx, KandeloVmModuleOwner(cx, linked));
    if (!dependency || JS::GetObjectRealmOrNull(dependency) != JS::GetObjectRealmOrNull(owner)) return false;
    result.set(KandeloVmModuleRecord(dependency)); return true;
  }
  return KandeloVmModuleRaise(cx, "ERR_VM_MODULE_LINK_FAILURE", "Module request is not in the linked VM graph");
}
bool KandeloVmModuleMetadata(JSContext* cx, HandleValue privateValue,
                             HandleObject meta, bool* handled) {
  RootedObject owner(cx, KandeloVmPrivateModule(privateValue));
  *handled = !!owner;
  if (!owner) return true;
  if (JS::GetObjectRealmOrNull(owner) != cx->realm())
    return KandeloVmModuleRaise(cx, "ERR_VM_MODULE_DIFFERENT_CONTEXT", "Linked modules must use the same context");
  RootedValue callback(cx), referrer(cx), ignored(cx);
  if (!KandeloVmModuleRegistryValue(cx, owner, "initializeImportMeta", &callback)) return false;
  if (callback.isUndefined()) return true;
  if (!KandeloVmModuleRegistryValue(cx, owner, "callbackReferrer", &referrer)) return false;
  JS::RootedValueArray<2> arguments(cx);
  arguments[0].setObject(*meta); arguments[1].set(referrer);
  if (!JS_WrapValue(cx, &callback)) return false;
  for (size_t i = 0; i < 2; i++) if (!JS_WrapValue(cx, arguments[i])) return false;
  return JS::Call(cx, UndefinedHandleValue, callback, arguments, &ignored);
}
bool KandeloVmModuleDynamic(JSContext* cx, HandleValue privateValue,
                            HandleObject request, HandleObject promise,
                            bool* handled) {
  RootedObject owner(cx, KandeloVmPrivateModule(privateValue));
  *handled = !!owner;
  if (!owner) return true;
  if (JS::GetObjectRealmOrNull(owner) != cx->realm())
    return KandeloVmModuleRaise(cx, "ERR_VM_MODULE_DIFFERENT_CONTEXT", "Linked modules must use the same context");
  RootedValue callback(cx), referrer(cx), returned(cx);
  if (!KandeloVmModuleRegistryValue(cx, owner, "importModuleDynamically", &callback)) return false;
  if (callback.isUndefined())
    return KandeloVmModuleRaise(cx, "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
        "A dynamic import callback was not specified.", JSEXN_TYPEERR);
  Rooted<ModuleRequestObject*> moduleRequest(cx, &request->as<ModuleRequestObject>());
  RootedObject attributes(cx);
  if (!KandeloVmModuleAttributes(cx, moduleRequest, &attributes) ||
      !KandeloVmModuleRegistryValue(cx, owner, "callbackReferrer", &referrer)) return false;
  RootedFunction fulfilled(cx, NewFunctionWithReserved(cx, KandeloVmImportSettled<false>, 1, 0, ""));
  RootedFunction rejected(cx, NewFunctionWithReserved(cx, KandeloVmImportSettled<true>, 1, 0, ""));
  if (!fulfilled || !rejected) return false;
  for (JSFunction* fn : {fulfilled.get(), rejected.get()}) {
    SetFunctionNativeReserved(fn, 0, ObjectValue(*promise));
    SetFunctionNativeReserved(fn, 1, ObjectValue(*owner));
  }
  JS::RootedValueArray<4> arguments(cx);
  arguments[0].setString(moduleRequest->specifier()); arguments[1].set(referrer);
  arguments[2].setObject(*attributes); arguments[3].setInt32(3);
  if (!JS_WrapValue(cx, &callback)) return false;
  for (size_t i = 0; i < 4; i++) if (!JS_WrapValue(cx, arguments[i])) return false;
  if (!JS::Call(cx, UndefinedHandleValue, callback, arguments, &returned)) return false;
  RootedObject completion(cx, JS::CallOriginalPromiseResolve(cx, returned));
  RootedObject onFulfilled(cx, JS_GetFunctionObject(fulfilled)), onRejected(cx, JS_GetFunctionObject(rejected));
  return completion && JS::AddPromiseReactions(cx, completion, onFulfilled, onRejected);
}
}  // namespace js::shell
