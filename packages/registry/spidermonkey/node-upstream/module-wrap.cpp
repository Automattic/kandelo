#include "shell/node-upstream/module-wrap.h"

#include "mozilla/Assertions.h"
#include "mozilla/Maybe.h"

#include <cstring>

#include "jsapi.h"
#include "jsfriendapi.h"

#include "builtin/ModuleObject.h"
#include "js/Array.h"
#include "js/CallAndConstruct.h"
#include "js/CallArgs.h"
#include "js/CharacterEncoding.h"
#include "js/CompilationAndEvaluation.h"
#include "js/CompileOptions.h"
#include "js/ContextOptions.h"
#include "js/ErrorReport.h"
#include "js/Exception.h"
#include "js/GCVector.h"
#include "js/GlobalObject.h"
#include "js/Modules.h"
#include "js/Object.h"
#include "js/Promise.h"
#include "js/PropertyAndElement.h"
#include "js/Realm.h"
#include "js/SourceText.h"
#include "js/StableStringChars.h"
#include "js/Stack.h"
#include "js/String.h"
#include "js/Symbol.h"
#include "js/ValueArray.h"
#include "shell/jsshell.h"
#include "shell/node-upstream/per-context.h"
#include "vm/JSAtomUtils.h"
#include "vm/JSScript.h"

namespace kandelo::node {
namespace {

enum WrapSlot { Module, EvaluationCallback, BindingOwner, Dependencies,
                Linked, HostId, SourceObject, WrapSlots };
enum BindingSlot { HostKey, SourceMapKey, ImportedCjsKey, DefaultHdo, EmbedderHdo,
                   MetaCallback, BindingSlots };
const JSClass kWrapClass = {"ModuleWrap", JSCLASS_HAS_RESERVED_SLOTS(WrapSlots)};
const JSClass kBindingClass = {"NodeModuleBinding", JSCLASS_HAS_RESERVED_SLOTS(BindingSlots)};
bool HasAsyncGraph(JSContext*, unsigned, JS::Value*);
bool SetHasAsyncGraph(JSContext*, unsigned, JS::Value*);

bool Throw(JSContext* cx, JSExnType type, const char* code, const char* message) {
  JS::RootedObject stack(cx);
  if (!JS::CaptureCurrentStack(cx, &stack)) return false;
  JS::RootedString filename(cx, JS_NewStringCopyZ(cx, ""));
  JS::RootedString text(cx, JS_NewStringCopyZ(cx, message));
  JS::RootedValue error(cx);
  JS::Rooted<mozilla::Maybe<JS::Value>> cause(cx, mozilla::Nothing());
  if (!filename || !text || !JS::CreateError(cx, type, stack, filename, 0,
      JS::ColumnNumberOneOrigin(1), nullptr, text, cause, &error)) return false;
  JS::RootedObject object(cx, &error.toObject());
  if (code) {
    JS::RootedString name(cx, JS_NewStringCopyZ(cx, code));
    if (!name || !JS_DefineProperty(cx, object, "code", name, JSPROP_ENUMERATE)) return false;
  }
  JS_SetPendingException(cx, error);
  return false;
}
bool Missing(JSContext* cx, const char* message) {
  return Throw(cx, JSEXN_ERR, "ERR_KANDELO_NOT_IMPLEMENTED", message);
}
JSObject* CheckedWrap(JSContext* cx, JS::HandleValue value) {
  if (!value.isObject() || JS::GetClass(&value.toObject()) != &kWrapClass ||
      !JS::GetReservedSlot(&value.toObject(), Module).isObject()) {
    Throw(cx, JSEXN_TYPEERR, "ERR_INVALID_THIS", "Value is not an initialized ModuleWrap");
    return nullptr;
  }
  JSObject* object = &value.toObject();
  if (JS::GetObjectRealmOrNull(object) != JS::GetCurrentRealmOrNull(cx)) {
    Throw(cx, JSEXN_ERR, "ERR_VM_MODULE_DIFFERENT_CONTEXT", "ModuleWrap belongs to another realm");
    return nullptr;
  }
  return object;
}
JSObject* Record(JS::HandleObject wrap) {
  return &JS::GetReservedSlot(wrap, Module).toObject();
}
JSObject* Owner(JS::HandleObject wrap) {
  return &JS::GetReservedSlot(wrap, BindingOwner).toObject();
}
bool ArrayValues(JSContext* cx, JS::HandleValue input, JS::RootedValueVector& values) {
  bool array;
  if (!JS::IsArrayObject(cx, input, &array)) return false;
  MOZ_RELEASE_ASSERT(array, "Node ModuleWrap requires an array");
  JS::RootedObject object(cx, &input.toObject());
  uint32_t length;
  if (!JS::GetArrayLength(cx, object, &length) || !values.resize(length)) return false;
  for (uint32_t i = 0; i < length; i++) {
    if (!JS_GetElement(cx, object, i, values[i])) return false;
  }
  return true;
}
int Status(JS::HandleObject wrap) {
  auto& module = Record(wrap)->as<js::ModuleObject>();
  if (module.hadEvaluationError()) return 5;
  switch (module.status()) {
    case js::ModuleStatus::Unlinked: return 0;
    case js::ModuleStatus::Linking: return 1;
    case js::ModuleStatus::Linked: return 2;
    case js::ModuleStatus::Evaluating: return 3;
    case js::ModuleStatus::EvaluatingAsync:
    case js::ModuleStatus::Evaluated: return 4;
    default: MOZ_CRASH("Invalid Node ModuleWrap status");
  }
}
bool EvaluateSynthetic(JSContext* cx, JS::HandleObject module, JS::HandleValue data) {
  JS::RootedObject wrap(cx, CheckedWrap(cx, data));
  if (!wrap) return false;
  MOZ_RELEASE_ASSERT(Record(wrap) == module);
  JS::RootedValue callback(cx, JS::GetReservedSlot(wrap, EvaluationCallback));
  MOZ_RELEASE_ASSERT(callback.isObject() && JS::IsCallable(&callback.toObject()));
  // Original Node consumes its callback before user code. Keep it rooted only
  // for this call; module lifetime must not retain an already-used closure.
  JS::SetReservedSlot(wrap, EvaluationCallback, JS::UndefinedValue());
  JS::RootedValue receiver(cx, JS::ObjectValue(*wrap));
  JS::RootedValue result(cx);
  return JS::Call(cx, receiver, callback, JS::HandleValueArray::empty(), &result);
}

bool RequestsMatch(JSContext* cx, JS::HandleObject a, JS::HandleObject b, bool* same) {
  auto& first = a->as<js::ModuleRequestObject>();
  auto& second = b->as<js::ModuleRequestObject>();
  if (first.specifier() != second.specifier()) { *same = false; return true; }
  JS::RootedObject x(cx, first.attributesData());
  JS::RootedObject y(cx, second.attributesData());
  uint32_t count, other;
  if (!JS::GetArrayLength(cx, x, &count) || !JS::GetArrayLength(cx, y, &other)) return false;
  if (count != other) { *same = false; return true; }
  JS::RootedValue one(cx), two(cx);
  for (uint32_t i = 0; i < count; i++) {
    if (!JS_GetElement(cx, x, i, &one) || !JS_GetElement(cx, y, i, &two)) return false;
    // Parser attributes are atomized strings, not coerced user values.
    if (one != two) { *same = false; return true; }
  }
  *same = true;
  return true;
}
JSObject* Resolve(JSContext* cx, JS::HandleValue data, JS::HandleObject request) {
  auto* shell = js::shell::GetShellContext(cx);
  if (!data.isObject() || JS::GetClass(&data.toObject()) != &kWrapClass) {
    if (shell->upstreamPreviousModuleResolve)
      return shell->upstreamPreviousModuleResolve(cx, data, request);
    Throw(cx, JSEXN_ERR, "ERR_VM_MODULE_LINK_FAILURE", "No resolver owns this module record");
    return nullptr;
  }
  JS::RootedObject wrap(cx, CheckedWrap(cx, data));
  if (!wrap) return nullptr;
  if (!JS::GetReservedSlot(wrap, Linked).toBoolean()) {
    Throw(cx, JSEXN_ERR, "ERR_VM_MODULE_LINK_FAILURE", "Module dependencies have not been linked");
    return nullptr;
  }
  JS::Rooted<js::ModuleObject*> record(cx, &Record(wrap)->as<js::ModuleObject>());
  JS::RootedObject dependencies(cx, &JS::GetReservedSlot(wrap, Dependencies).toObject());
  JS::RootedObject candidate(cx);
  JS::RootedValue value(cx);
  for (size_t i = 0; i < record->requestedModules().size(); i++) {
    candidate = record->requestedModules()[i].moduleRequest();
    bool same;
    if (!RequestsMatch(cx, candidate, request, &same)) return nullptr;
    if (!same) continue;
    if (!JS_GetElement(cx, dependencies, i, &value)) return nullptr;
    JS::RootedObject dependency(cx, CheckedWrap(cx, value));
    return dependency ? Record(dependency) : nullptr;
  }
  Throw(cx, JSEXN_ERR, "ERR_VM_MODULE_LINK_FAILURE", "Module request has no linked dependency");
  return nullptr;
}
JSObject* Attributes(JSContext* cx, JS::HandleObject request) {
  JS::RootedObject nullProto(cx);
  JS::RootedObject attributes(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullProto));
  JS::RootedObject raw(cx, request->as<js::ModuleRequestObject>().attributesData());
  if (!attributes) return nullptr;
  uint32_t count;
  if (!JS::GetArrayLength(cx, raw, &count)) return nullptr;
  JS::RootedValue key(cx), value(cx);
  JS::RootedId id(cx);
  for (uint32_t i = 0; i < count; i += 2) {
    if (!JS_GetElement(cx, raw, i, &key) || !JS_GetElement(cx, raw, i + 1, &value) ||
        !JS_ValueToId(cx, key, &id) ||
        !JS_DefinePropertyById(cx, attributes, id, value, JSPROP_ENUMERATE)) return nullptr;
  }
  return JS_FreezeObject(cx, attributes) ? attributes.get() : nullptr;
}
bool Metadata(JSContext* cx, JS::HandleValue data, JS::HandleObject meta) {
  auto* shell = js::shell::GetShellContext(cx);
  if (!data.isObject() || JS::GetClass(&data.toObject()) != &kWrapClass) {
    return !shell->upstreamPreviousModuleMetadata ||
           shell->upstreamPreviousModuleMetadata(cx, data, meta);
  }
  JS::RootedObject wrap(cx, CheckedWrap(cx, data));
  if (!wrap) return false;
  JS::RootedObject owner(cx, Owner(wrap));
  JS::RootedValue id(cx, JS::GetReservedSlot(wrap, HostId));
  if (id == JS::GetReservedSlot(owner, DefaultHdo) ||
      id == JS::GetReservedSlot(owner, EmbedderHdo))
    return Missing(cx, "Default Node import.meta URL/path/resolve backend is not implemented");
  JS::RootedValue callback(cx, JS::GetReservedSlot(owner, MetaCallback));
  if (!callback.isObject()) return Missing(cx, "Node import.meta callback has not been registered");
  JS::RootedValueArray<3> args(cx);
  args[0].set(id); args[1].setObject(*meta); args[2].setObject(*wrap);
  JS::RootedValue result(cx);
  return JS::Call(cx, JS::UndefinedHandleValue, callback, args, &result);
}
bool DynamicImport(JSContext* cx, JS::HandleValue data, JS::HandleObject request,
                   JS::HandleObject promise) {
  auto* shell = js::shell::GetShellContext(cx);
  if (!data.isObject() || JS::GetClass(&data.toObject()) != &kWrapClass) {
    if (shell->upstreamPreviousModuleDynamicImport)
      return shell->upstreamPreviousModuleDynamicImport(cx, data, request, promise);
  }
  return Missing(cx, "Node dynamic import callback/Promise ownership is not implemented");
}
void InstallHooks(JSContext* cx) {
  auto* shell = js::shell::GetShellContext(cx);
  if (shell->upstreamModuleHooksInstalled) return;
  JSRuntime* runtime = JS_GetRuntime(cx);
  shell->upstreamPreviousModuleResolve = JS::GetModuleResolveHook(runtime);
  shell->upstreamPreviousModuleMetadata = JS::GetModuleMetadataHook(runtime);
  shell->upstreamPreviousModuleDynamicImport = JS::GetModuleDynamicImportHook(runtime);
  shell->upstreamModuleHooksInstalled = true;
  JS::SetModuleResolveHook(runtime, Resolve);
  JS::SetModuleMetadataHook(runtime, Metadata);
  JS::SetModuleDynamicImportHook(runtime, DynamicImport);
}

bool New(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  MOZ_RELEASE_ASSERT(args.isConstructing() && argc >= 3, "Node ModuleWrap constructor invariant");
  MOZ_RELEASE_ASSERT(args[0].isString());
  if (!args[1].isUndefined()) return Missing(cx, "Contextified ModuleWrap realms are not implemented");
  JS::RootedObject owner(cx, &js::GetFunctionNativeReserved(&args.callee(), 0).toObject());
  JS::RootedObject self(cx, JS_NewObjectForConstructor(cx, &kWrapClass, args));
  if (!self || !JS_DefineProperty(cx, self, "hasAsyncGraph", HasAsyncGraph, SetHasAsyncGraph, 0)) return false;
  JS::SetReservedSlot(self, BindingOwner, JS::ObjectValue(*owner));
  JS::SetReservedSlot(self, Linked, JS::BooleanValue(false));
  bool synthetic;
  if (!JS::IsArrayObject(cx, args[2], &synthetic)) return false;
  JS::RootedObject module(cx);
  if (synthetic) {
    MOZ_RELEASE_ASSERT(argc >= 4 && args[3].isObject() && JS::IsCallable(&args[3].toObject()));
    JS::RootedValueVector names(cx);
    if (!ArrayValues(cx, args[2], names)) return false;
    JS::SetReservedSlot(self, EvaluationCallback, args[3]);
    JS::RootedValue data(cx, JS::ObjectValue(*self));
    module = JS::CreateSyntheticModule(cx, names, EvaluateSynthetic, data);
    JS::SetReservedSlot(self, Linked, JS::BooleanValue(true));
    JS::RootedObject empty(cx, JS::NewArrayObject(cx, 0));
    if (!empty) return false;
    JS::SetReservedSlot(self, Dependencies, JS::ObjectValue(*empty));
  } else {
    MOZ_RELEASE_ASSERT(args[2].isString() && argc >= 5 && args[3].isInt32() && args[4].isInt32());
    int32_t line = args[3].toInt32(), column = args[4].toInt32();
    if (line < 0 || column < 0) return Missing(cx, "Negative module source offsets are not implemented");
    if (argc > 5 && !args[5].isUndefined() && !args[5].isSymbol())
      return Missing(cx, "SpiderMonkey module cache data admission is not implemented");
    JS::RootedString url(cx, args[0].toString());
    JS::UniqueChars filename = JS_EncodeStringToUTF8(cx, url);
    if (!filename) return false;
    JSLinearString* linearUrl = JS_EnsureLinearString(cx, url);
    if (!linearUrl) return false;
    if (std::strlen(filename.get()) != JS::GetDeflatedUTF8StringLength(linearUrl))
      return Missing(cx, "Embedded-NUL module diagnostic URLs are not implemented");
    JS::CompileOptions options(cx);
    options.setFileAndLine(filename.get(), uint32_t(line) + 1).setModule().setForceFullParse();
    options.setColumn(JS::ColumnNumberOneOrigin(uint32_t(column) + 1));
    JS::RootedString source(cx, args[2].toString());
    JS::AutoStableStringChars chars(cx);
    if (!chars.initTwoByte(cx, source)) return false;
    JS::SourceText<char16_t> text;
    if (!text.initMaybeBorrowed(cx, chars)) return false;
    module = JS::CompileModule(cx, options, text);
    if (!module) return false;
    JS::RootedSymbol id(cx, args.get(5).isSymbol() ? args[5].toSymbol() : JS::NewSymbol(cx, url));
    if (!id) return false;
    JS::SetReservedSlot(self, HostId, JS::SymbolValue(id));
    JS::RootedId key(cx, JS::PropertyKey::Symbol(JS::GetReservedSlot(owner, HostKey).toSymbol()));
    JS::RootedValue identity(cx, JS::SymbolValue(id));
    if (!JS_DefinePropertyById(cx, self, key, identity, 0)) return false;
  }
  if (!module) return false;
  JS::SetReservedSlot(self, Module, JS::ObjectValue(*module));
  JS::SetModulePrivate(module, JS::ObjectValue(*self));
  JS::RootedId mapKey(cx, JS::PropertyKey::Symbol(JS::GetReservedSlot(owner, SourceMapKey).toSymbol()));
  JS::RootedValue isSynthetic(cx, JS::BooleanValue(synthetic));
  if (!JS_DefinePropertyById(cx, self, mapKey, JS::UndefinedHandleValue, 0) ||
      !JS_DefineProperty(cx, self, "synthetic", isSynthetic, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, self, "url", args[0], JSPROP_ENUMERATE)) return false;
  if (!synthetic) {
    auto* scriptSource = module->as<js::ModuleObject>().scriptSourceObject()->source();
    JS::RootedValue sourceURL(cx), sourceMapURL(cx);
    if (const char16_t* url = scriptSource->displayURL()) {
      JS::RootedString value(cx, JS_NewUCStringCopyZ(cx, url));
      if (!value) return false;
      sourceURL.setString(value);
    }
    if (const char16_t* url = scriptSource->sourceMapURL()) {
      JS::RootedString value(cx, JS_NewUCStringCopyZ(cx, url));
      if (!value) return false;
      sourceMapURL.setString(value);
    }
    JS::RootedValue hasAwait(cx, JS::BooleanValue(module->as<js::ModuleObject>().hasTopLevelAwait()));
    if (!JS_DefineProperty(cx, self, "hasTopLevelAwait", hasAwait, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, self, "sourceURL", sourceURL, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, self, "sourceMapURL", sourceMapURL, JSPROP_ENUMERATE)) return false;
  }
  if (synthetic && args.get(4).isObject()) {
    JS::RootedId key(cx, JS::PropertyKey::Symbol(JS::GetReservedSlot(owner, ImportedCjsKey).toSymbol()));
    if (!JS_DefinePropertyById(cx, self, key, args[4], JSPROP_ENUMERATE)) return false;
  }
  args.rval().setObject(*self);
  return true;
}

bool GetRequests(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  JS::Rooted<js::ModuleObject*> record(cx, &Record(wrap)->as<js::ModuleObject>());
  size_t count = record->hasCyclicModuleFields() ? record->requestedModules().size() : 0;
  JS::RootedObject array(cx, JS::NewArrayObject(cx, count));
  if (!array) return false;
  JS::RootedObject nullProto(cx), request(cx), attributes(cx), result(cx);
  for (size_t i = 0; i < count; i++) {
    request = record->requestedModules()[i].moduleRequest();
    attributes = Attributes(cx, request);
    result = JS_NewObjectWithGivenProto(cx, nullptr, nullProto);
    JS::RootedString specifier(cx, JS::GetModuleRequestSpecifier(cx, request));
    if (!attributes || !result || !specifier ||
        !JS_DefineProperty(cx, result, "specifier", specifier, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, result, "attributes", attributes, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, result, "phase", 3, JSPROP_ENUMERATE) ||
        !JS_FreezeObject(cx, result) || !JS_SetElement(cx, array, i, result)) return false;
  }
  args.rval().setObject(*array);
  return true;
}
bool Link(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  MOZ_RELEASE_ASSERT(argc == 1);
  JS::RootedValueVector values(cx);
  if (!ArrayValues(cx, args[0], values)) return false;
  JS::Rooted<js::ModuleObject*> record(cx, &Record(wrap)->as<js::ModuleObject>());
  size_t count = record->hasCyclicModuleFields() ? record->requestedModules().size() : 0;
  MOZ_RELEASE_ASSERT(values.length() == count, "Node ModuleWrap link request count invariant");
  for (size_t i = 0; i < count; i++) {
    JS::RootedObject dependency(cx, CheckedWrap(cx, values[i]));
    if (!dependency) return false;
    for (size_t j = 0; j < i; j++) {
      JS::RootedObject a(cx, record->requestedModules()[i].moduleRequest());
      JS::RootedObject b(cx, record->requestedModules()[j].moduleRequest());
      bool same;
      if (!RequestsMatch(cx, a, b, &same)) return false;
      if (same && values[i] != values[j])
        return Throw(cx, JSEXN_ERR, "ERR_MODULE_LINK_MISMATCH", "Identical module requests require the same dependency");
    }
  }
  JS::RootedObject dependencies(cx, JS::NewArrayObject(cx, values));
  if (!dependencies) return false;
  JS::SetReservedSlot(wrap, Dependencies, JS::ObjectValue(*dependencies));
  JS::SetReservedSlot(wrap, Linked, JS::BooleanValue(true));
  args.rval().setUndefined();
  return true;
}
bool Instantiate(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  if (!JS::GetReservedSlot(wrap, Linked).toBoolean())
    return Throw(cx, JSEXN_ERR, "ERR_VM_MODULE_LINK_FAILURE", "Module dependencies have not been linked");
  JS::RootedObject module(cx, Record(wrap));
  if (!JS::ModuleLink(cx, module)) return false;
  args.rval().setUndefined();
  return true;
}
bool AsyncGraph(JSContext* cx, JS::HandleObject root, bool* async) {
  JS::RootedObjectVector pending(cx), seen(cx);
  if (!pending.append(root)) return false;
  *async = false;
  while (!pending.empty()) {
    JS::RootedObject wrap(cx, pending.popCopy());
    bool found = false;
    for (auto* item : seen) if (item == wrap) { found = true; break; }
    if (found) continue;
    if (!seen.append(wrap)) return false;
    if (Record(wrap)->as<js::ModuleObject>().hasTopLevelAwait()) { *async = true; return true; }
    JS::Value value = JS::GetReservedSlot(wrap, Dependencies);
    if (!value.isObject()) continue;
    JS::RootedObject dependencies(cx, &value.toObject());
    uint32_t count;
    if (!JS::GetArrayLength(cx, dependencies, &count)) return false;
    JS::RootedValue child(cx);
    for (uint32_t i = 0; i < count; i++) {
      if (!JS_GetElement(cx, dependencies, i, &child)) return false;
      JS::RootedObject dependency(cx, CheckedWrap(cx, child));
      if (!dependency || !pending.append(dependency)) return false;
    }
  }
  return true;
}
bool HasAsyncGraph(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  if (Status(wrap) < 2) return Throw(cx, JSEXN_ERR, "ERR_MODULE_NOT_INSTANTIATED", "Module is not instantiated");
  bool async;
  if (!AsyncGraph(cx, wrap, &async)) return false;
  JS::RootedValue value(cx, JS::BooleanValue(async));
  if (!JS_DefineProperty(cx, wrap, "hasAsyncGraph", value, 0)) return false;
  args.rval().setBoolean(async);
  return true;
}
bool SetHasAsyncGraph(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap || !JS_DefineProperty(cx, wrap, "hasAsyncGraph", args.get(0), 0)) return false;
  args.rval().setUndefined();
  return true;
}
bool Evaluate(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  MOZ_RELEASE_ASSERT(argc == 2 && args[0].isNumber() && args[1].isBoolean());
  if (args[0].toNumber() != -1 || args[1].toBoolean())
    return Missing(cx, "Node module deadlines and signal-interruption ownership are not implemented");
  JS::RootedObject module(cx, Record(wrap));
  bool synthetic = module->as<js::ModuleObject>().hasSyntheticModuleFields();
  bool previousError = module->as<js::ModuleObject>().hadEvaluationError();
  if (!JS::ModuleEvaluate(cx, module, args.rval())) return false;
  JS::RootedObject promise(cx, &args.rval().toObject());
  if (synthetic && !previousError &&
      JS::GetPromiseState(promise) == JS::PromiseState::Rejected) {
    // V8's synthetic evaluation callback throws on its first failed call.
    // Later evaluations return a rejected promise. Preserve that native seam.
    JS::RootedValue error(cx, JS::GetPromiseResult(promise));
    if (!JS::SetSettledPromiseIsHandled(cx, promise)) return false;
    JS_SetPendingException(cx, error);
    return false;
  }
  return true;
}
bool EvaluateSync(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  bool async;
  if (!AsyncGraph(cx, wrap, &async)) return false;
  if (async) return Throw(cx, JSEXN_ERR, "ERR_REQUIRE_ASYNC_MODULE", "Synchronous evaluation requires a graph without top-level await");
  JS::RootedObject module(cx, Record(wrap));
  JS::RootedValue result(cx);
  if (!JS::ModuleEvaluate(cx, module, &result)) return false;
  JS::RootedObject promise(cx, &result.toObject());
  if (JS::GetPromiseState(promise) == JS::PromiseState::Rejected) {
    JS::RootedValue error(cx, JS::GetPromiseResult(promise));
    if (!JS::SetSettledPromiseIsHandled(cx, promise)) return false;
    JS_SetPendingException(cx, error);
    return false;
  }
  MOZ_RELEASE_ASSERT(JS::GetPromiseState(promise) == JS::PromiseState::Fulfilled,
                     "Node synchronous module evaluation invariant");
  JS::RootedObject ns(cx, JS::GetModuleNamespace(cx, module));
  if (!ns) return false;
  args.rval().setObject(*ns);
  return true;
}
bool SetExport(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  MOZ_RELEASE_ASSERT(argc == 2 && args[0].isString());
  JS::RootedObject module(cx, Record(wrap));
  MOZ_RELEASE_ASSERT(module->as<js::ModuleObject>().hasSyntheticModuleFields());
  JS::RootedString name(cx, args[0].toString());
  JS::Rooted<JSAtom*> atom(cx, js::AtomizeString(cx, name));
  if (!atom) return false;
  bool found = false;
  for (const auto& item : module->as<js::ModuleObject>().syntheticExportNames()) if (item.get() == atom) found = true;
  if (!found) return Throw(cx, JSEXN_REFERENCEERR, nullptr, "Export is not defined in module");
  if (!JS::SetSyntheticModuleExport(cx, module, name, args[1])) return false;
  args.rval().setUndefined();
  return true;
}
bool Namespace(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  if (Status(wrap) < 2) return Throw(cx, JSEXN_ERR, "ERR_MODULE_NOT_INSTANTIATED", "Module is not instantiated");
  JS::RootedObject module(cx, Record(wrap));
  JS::RootedObject ns(cx, JS::GetModuleNamespace(cx, module));
  if (!ns) return false;
  args.rval().setObject(*ns);
  return true;
}
bool GetStatus(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  args.rval().setInt32(Status(wrap)); return true;
}
bool GetError(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  MOZ_RELEASE_ASSERT(Record(wrap)->as<js::ModuleObject>().hadEvaluationError(), "Node ModuleWrap error-state invariant");
  args.rval().set(Record(wrap)->as<js::ModuleObject>().evaluationError()); return true;
}
bool SetSource(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  MOZ_RELEASE_ASSERT(argc == 1 && args[0].isObject());
  MOZ_RELEASE_ASSERT(JS::GetReservedSlot(wrap, SourceObject).isUndefined(), "Node module source object initialization invariant");
  JS::SetReservedSlot(wrap, SourceObject, args[0]); args.rval().setUndefined(); return true;
}
bool GetSource(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject wrap(cx, CheckedWrap(cx, args.thisv()));
  if (!wrap) return false;
  MOZ_RELEASE_ASSERT(argc == 0);
  if (JS::GetReservedSlot(wrap, SourceObject).isUndefined())
    return Throw(cx, JSEXN_ERR, "ERR_SOURCE_PHASE_NOT_DEFINED", "Module source phase is not defined");
  args.rval().set(JS::GetReservedSlot(wrap, SourceObject)); return true;
}
bool SetMetadataCallback(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  MOZ_RELEASE_ASSERT(argc == 1 && args[0].isObject() && JS::IsCallable(&args[0].toObject()));
  JS::RootedObject owner(cx, &js::GetFunctionNativeReserved(&args.callee(), 0).toObject());
  JS::SetReservedSlot(owner, MetaCallback, args[0]); args.rval().setUndefined(); return true;
}
bool Unimplemented(JSContext* cx, unsigned argc, JS::Value* vp) {
  return Missing(cx, "Requested Node module binding backend is not implemented");
}
bool ThrowIfRejected(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) { args.rval().setUndefined(); return true; }
  JS::RootedObject promise(cx, &args[0].toObject());
  if (!JS::IsPromiseObject(promise) || JS::GetPromiseState(promise) != JS::PromiseState::Rejected) {
    args.rval().setUndefined(); return true;
  }
  JS::RootedValue error(cx, JS::GetPromiseResult(promise));
  if (!JS::SetSettledPromiseIsHandled(cx, promise)) return false;
  JS_SetPendingException(cx, error); return false;
}

}  // namespace

JSObject* CreateModuleWrapBinding(JSContext* cx, JS::HandleObject runtime) {
  JS::ContextOptionsRef(cx).setImportAttributes(true);
  JS::RootedObject owner(cx, JS_NewObject(cx, &kBindingClass));
  JS::RootedObject binding(cx, JS_NewPlainObject(cx));
  if (!owner || !binding) return nullptr;
  const char* symbols[] = {"host_defined_option_symbol", "source_map_data_private_symbol",
      "imported_cjs_symbol", "source_text_module_default_hdo", "embedder_module_hdo"};
  for (unsigned i = 0; i < 5; i++) {
    JS::RootedSymbol symbol(cx, GetRuntimeSymbol(cx, runtime, symbols[i]));
    if (!symbol) return nullptr;
    JS::SetReservedSlot(owner, i, JS::SymbolValue(symbol));
  }
  JS::RootedFunction constructor(cx, js::NewFunctionWithReserved(cx, New, 0, JSFUN_CONSTRUCTOR, "ModuleWrap"));
  JS::RootedObject prototype(cx, JS_NewObject(cx, &kWrapClass));
  if (!constructor || !prototype) return nullptr;
  JS::RootedObject function(cx, JS_GetFunctionObject(constructor));
  js::SetFunctionNativeReserved(function, 0, JS::ObjectValue(*owner));
  static const JSFunctionSpec methods[] = {
      JS_FN("getModuleRequests", GetRequests, 0, 0), JS_FN("link", Link, 1, 0),
      JS_FN("instantiate", Instantiate, 0, 0), JS_FN("evaluate", Evaluate, 2, 0),
      JS_FN("evaluateSync", EvaluateSync, 0, 0), JS_FN("setExport", SetExport, 2, 0),
      JS_FN("getNamespace", Namespace, 0, 0), JS_FN("getStatus", GetStatus, 0, 0),
      JS_FN("getError", GetError, 0, 0), JS_FN("setModuleSourceObject", SetSource, 1, 0),
      JS_FN("getModuleSourceObject", GetSource, 0, 0), JS_FN("createCachedData", Unimplemented, 0, 0),
      JS_FS_END};
  if (!JS_DefineFunctions(cx, prototype, methods) ||
      !JS_DefineProperty(cx, prototype, "constructor", function, 0) ||
      !JS_DefineProperty(cx, function, "prototype", prototype, JSPROP_PERMANENT) ||
      !JS_DefineProperty(cx, binding, "ModuleWrap", function, JSPROP_ENUMERATE)) return nullptr;
  JS::RootedFunction meta(cx, js::NewFunctionWithReserved(cx, SetMetadataCallback, 1, 0, "setInitializeImportMetaObjectCallback"));
  if (!meta) return nullptr;
  JS::RootedObject setter(cx, JS_GetFunctionObject(meta));
  js::SetFunctionNativeReserved(setter, 0, JS::ObjectValue(*owner));
  if (!JS_DefineProperty(cx, binding, "setInitializeImportMetaObjectCallback", setter, JSPROP_ENUMERATE)) return nullptr;
  static const JSFunctionSpec functions[] = {
      JS_FN("setImportModuleDynamicallyCallback", Unimplemented, 1, 0),
      JS_FN("setImportMetaResolveInitializer", Unimplemented, 1, 0),
      JS_FN("createRequiredModuleFacade", Unimplemented, 1, 0),
      JS_FN("throwIfPromiseRejected", ThrowIfRejected, 1, 0), JS_FS_END};
  if (!JS_DefineFunctions(cx, binding, functions)) return nullptr;
  const char* statuses[] = {"kUninstantiated", "kInstantiating", "kInstantiated", "kEvaluating", "kEvaluated", "kErrored"};
  for (int i = 0; i < 6; i++) if (!JS_DefineProperty(cx, binding, statuses[i], i, JSPROP_ENUMERATE)) return nullptr;
  if (!JS_DefineProperty(cx, binding, "kSourcePhase", 1, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, binding, "kDeferPhase", 2, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, binding, "kEvaluationPhase", 3, JSPROP_ENUMERATE)) return nullptr;
  InstallHooks(cx);
  return binding;
}

}  // namespace kandelo::node
