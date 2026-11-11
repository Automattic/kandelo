#include "shell/node-upstream/realm.h"

#include "mozilla/Assertions.h"
#include "mozilla/Maybe.h"

#include <cerrno>
#include <cstring>
#include <string_view>
#include <sys/utsname.h>
#include <unistd.h>
#include <utility>

#include "builtin-source-registry.h"
#include "jsapi.h"
#include "jsfriendapi.h"
#include "js/Array.h"
#include "js/CallAndConstruct.h"
#include "js/CallArgs.h"
#include "js/CharacterEncoding.h"
#include "js/Exception.h"
#include "js/GlobalObject.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/Realm.h"
#include "js/Stack.h"
#include "js/String.h"
#include "js/ValueArray.h"
#include "shell/jsshell.h"
#include "shell/node-upstream/builtin-compiler.h"
#include "shell/node-upstream/error-stack.h"
#include "shell/node-upstream/per-context.h"

namespace kandelo::node {
namespace {

enum Phase { Initializing = 1, LibraryReady = 2, Failed = 3 };
enum Slot { Status, Global, Process, Primordials, Builtins, Util, InternalLoader,
            BuiltinRequire, LinkedLookup, InternalLookup, CompiledIds, Slots };
const JSClass kRealm = {"NodeRealmLibrary", JSCLASS_HAS_RESERVED_SLOTS(Slots)};
const JSClass kProcess = {"process", 0};

bool Report(JSContext* cx, const char* message) {
  if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "%s", message);
  return false;
}
bool Throw(JSContext* cx, const char* code, const char* message) {
  JS::RootedObject stack(cx);
  if (!JS::CaptureCurrentStack(cx, &stack)) return false;
  JS::RootedString filename(cx, JS_NewStringCopyZ(cx, ""));
  JS::RootedString text(cx, JS_NewStringCopyZ(cx, message));
  JS::RootedValue error(cx);
  JS::Rooted<mozilla::Maybe<JS::Value>> cause(cx, mozilla::Nothing());
  if (!filename || !text || !JS::CreateError(cx, JSEXN_ERR, stack, filename, 0,
      JS::ColumnNumberOneOrigin(1), nullptr, text, cause, &error)) return false;
  JS::RootedObject object(cx, &error.toObject());
  if (code) {
    JS::RootedString name(cx, JS_NewStringCopyZ(cx, code));
    if (!name || !JS_DefineProperty(cx, object, "code", name, JSPROP_ENUMERATE)) return false;
  }
  JS_SetPendingException(cx, error); return false;
}
bool Missing(JSContext* cx, const char* message) {
  return Throw(cx, "ERR_KANDELO_NOT_IMPLEMENTED", message);
}
bool PendingCode(JSContext* cx, const char* name) {
  JS::RootedValue error(cx);
  if (!JS_GetPendingException(cx, &error)) return false;
  JS_ClearPendingException(cx);
  JS::RootedObject object(cx, &error.toObject());
  JS::RootedString code(cx, JS_NewStringCopyZ(cx, name));
  if (!code || !JS_DefineProperty(cx, object, "code", code, JSPROP_ENUMERATE)) return false;
  JS_SetPendingException(cx, error); return false;
}
JSObject* Runtime(JSContext* cx) {
  return js::shell::GetShellContext(cx)->upstreamNodeRuntime.get();
}
JSObject* Owner(JSContext* cx, const JS::CallArgs& args) {
  JSObject* state = &js::GetFunctionNativeReserved(&args.callee(), 0).toObject();
  MOZ_RELEASE_ASSERT(JS::GetClass(state) == &kRealm);
  if (JS::GetObjectRealmOrNull(state) != JS::GetCurrentRealmOrNull(cx) ||
      JS::GetReservedSlot(state, Global) != JS::ObjectValue(*JS::CurrentGlobalOrNull(cx))) {
    Report(cx, "Native Node realm function belongs to another context"); return nullptr;
  }
  if (JS::GetReservedSlot(state, Status) == JS::Int32Value(Failed)) {
    Report(cx, "Previous Node realm initialization failed"); return nullptr;
  }
  return state;
}
JSObject* Function(JSContext* cx, JS::HandleObject state, JSNative native,
                   unsigned nargs, const char* name) {
  JS::RootedFunction function(cx, js::NewFunctionWithReserved(cx, native, nargs, 0, name));
  if (!function) return nullptr;
  JS::RootedObject object(cx, JS_GetFunctionObject(function));
  js::SetFunctionNativeReserved(object, 0, JS::ObjectValue(*state)); return object;
}
bool StringView(JSContext* cx, JS::HandleValue value, JS::UniqueChars& bytes,
                std::string_view* view) {
  MOZ_RELEASE_ASSERT(value.isString(), "Node binding name invariant");
  JS::RootedString string(cx, value.toString());
  bytes = JS_EncodeStringToUTF8(cx, string);
  if (!bytes) return false;
  JSLinearString* linear = JS_EnsureLinearString(cx, string);
  if (!linear) return false;
  *view = std::string_view(bytes.get(), JS::GetDeflatedUTF8StringLength(linear)); return true;
}
bool Compile(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject state(cx, Owner(cx, args)); if (!state) return false;
  JS::UniqueChars bytes; std::string_view id;
  if (!StringView(cx, args.get(0), bytes, &id)) return false;
  JS::RootedFunction function(cx, CompileBuiltinFunction(cx, id));
  if (!function) return false;
  JS::RootedObject records(cx, &JS::GetReservedSlot(state, CompiledIds).toObject());
  uint32_t count;
  if (!JS::GetArrayLength(cx, records, &count) || !JS_DefineElement(cx, records, count, args[0], JSPROP_ENUMERATE)) return false;
  args.rval().setObject(*JS_GetFunctionObject(function)); return true;
}
bool SetLoaders(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject state(cx, Owner(cx, args)); if (!state) return false;
  MOZ_RELEASE_ASSERT(args.get(0).isObject() && JS::IsCallable(&args[0].toObject()), "Node internal loader invariant");
  MOZ_RELEASE_ASSERT(args.get(1).isObject() && JS::IsCallable(&args[1].toObject()), "Node builtin require invariant");
  MOZ_RELEASE_ASSERT(JS::GetReservedSlot(state, InternalLoader).isUndefined() &&
                     JS::GetReservedSlot(state, BuiltinRequire).isUndefined(), "Node internal loaders registration invariant");
  JS::SetReservedSlot(state, InternalLoader, args[0]);
  JS::SetReservedSlot(state, BuiltinRequire, args[1]); args.rval().setUndefined(); return true;
}
bool Ids(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject array(cx, JS::NewArrayObject(cx, BuiltinSourceCount()));
  if (!array) return false;
  for (size_t i = 0; i < BuiltinSourceCount(); i++) {
    auto source = BuiltinSourceAt(i); MOZ_RELEASE_ASSERT(source);
    JS::RootedString id(cx, JS_NewStringCopyZ(cx, source->id));
    if (!id || !JS_DefineElement(cx, array, i, id, JSPROP_ENUMERATE)) return false;
  }
  args.rval().setObject(*array); return true;
}
bool Unimplemented(JSContext* cx, unsigned argc, JS::Value* vp) {
  return Missing(cx, "Requested native builtin metadata/cache/source-text backend is not implemented");
}
JSObject* BuiltinsBinding(JSContext* cx, JS::HandleObject state) {
  JS::Value cached = JS::GetReservedSlot(state, Builtins);
  if (cached.isObject()) return &cached.toObject();
  JS::RootedObject binding(cx, JS_NewPlainObject(cx));
  JS::RootedObject compile(cx, Function(cx, state, Compile, 1, "compileFunction"));
  JS::RootedObject loaders(cx, Function(cx, state, SetLoaders, 2, "setInternalLoaders"));
  if (!binding || !compile || !loaders ||
      !JS_DefineProperty(cx, binding, "compileFunction", compile, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, binding, "setInternalLoaders", loaders, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, binding, "builtinIds", Ids, nullptr, JSPROP_ENUMERATE)) return nullptr;
  for (const char* property : {"config", "builtinCategories", "natives"})
    if (!JS_DefineProperty(cx, binding, property, Unimplemented, nullptr, JSPROP_ENUMERATE)) return nullptr;
  static const JSFunctionSpec methods[] = {
      JS_FN("getCacheUsage", Unimplemented, 0, 0), JS_FN("hasCachedBuiltins", Unimplemented, 0, 0),
      JS_FN("importBuiltinSourceTextModule", Unimplemented, 1, 0), JS_FS_END};
  if (!JS_DefineFunctions(cx, binding, methods) || !JS_FreezeObject(cx, binding)) return nullptr;
  JS::SetReservedSlot(state, Builtins, JS::ObjectValue(*binding)); return binding;
}
bool InternalBinding(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject state(cx, Owner(cx, args)); if (!state) return false;
  JS::UniqueChars bytes; std::string_view name;
  if (!StringView(cx, args.get(0), bytes, &name)) return false;
  JS::RootedObject runtime(cx, Runtime(cx));
  JS::RootedObject binding(cx);
  if (name == "builtins") binding = BuiltinsBinding(cx, state);
  else if (name == "module_wrap") binding = GetCurrentContextModuleWrapBinding(cx, runtime);
  else if (name == "errors") binding = GetErrorStackBinding(cx);
  else if (name == "util") {
    JS::Value cached = JS::GetReservedSlot(state, Util);
    if (cached.isObject()) binding = &cached.toObject();
    else {
      binding = JS_NewPlainObject(cx);
      JS::RootedObject symbols(cx, CreateRuntimePrivateSymbolTable(cx, runtime));
      if (!binding || !symbols || !JS_DefineProperty(cx, binding, "privateSymbols", symbols, JSPROP_ENUMERATE)) return false;
      JS::SetReservedSlot(state, Util, JS::ObjectValue(*binding));
    }
  } else {
    JS_ReportErrorASCII(cx, "Native Node binding '%s' is not implemented", bytes.get());
    return PendingCode(cx, "ERR_KANDELO_NOT_IMPLEMENTED");
  }
  if (!binding) return false;
  args.rval().setObject(*binding); return true;
}
bool LinkedBinding(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject state(cx, Owner(cx, args)); if (!state) return false;
  JS::UniqueChars bytes; std::string_view name;
  if (!StringView(cx, args.get(0), bytes, &name)) return false;
  // The source admission declares no embedder-added linked external modules.
  JS_ReportErrorASCII(cx, "No such binding was linked: %s", bytes.get());
  return PendingCode(cx, "ERR_INVALID_MODULE");
}
bool ParentPid(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp); auto pid = getppid();
  if (pid < 0) return Report(cx, "Guest getppid failed");
  args.rval().setNumber(pid); return true;
}
JSObject* ProcessObject(JSContext* cx) {
  struct utsname data;
  if (uname(&data) != 0) { JS_ReportErrorASCII(cx, "Guest uname failed: %s", std::strerror(errno)); return nullptr; }
  auto pid = getpid();
  if (pid < 0) { Report(cx, "Guest getpid failed"); return nullptr; }
  JS::RootedObject process(cx, JS_NewObject(cx, &kProcess));
  JS::RootedString platform(cx, JS_NewStringCopyZ(cx, data.sysname));
  JS::RootedString machine(cx, JS_NewStringCopyZ(cx, data.machine));
  if (!process || !platform || !machine ||
      !JS_DefineProperty(cx, process, "platform", platform, JSPROP_ENUMERATE | JSPROP_READONLY) ||
      !JS_DefineProperty(cx, process, "arch", machine, JSPROP_ENUMERATE | JSPROP_READONLY) ||
      !JS_DefineProperty(cx, process, "pid", int32_t(pid), JSPROP_ENUMERATE | JSPROP_READONLY) ||
      !JS_DefineProperty(cx, process, "ppid", ParentPid, nullptr, JSPROP_ENUMERATE)) return nullptr;
  return process;
}

}  // namespace

JSObject* AllocateRealmLibraryState(JSContext* cx) {
  JS::RootedObject state(cx, JS_NewObject(cx, &kRealm));
  if (!state) return nullptr;
  JS::SetReservedSlot(state, Status, JS::Int32Value(Initializing));
  JS::SetReservedSlot(state, Global, JS::ObjectValue(*JS::CurrentGlobalOrNull(cx))); return state;
}
bool RunRealmLibrary(JSContext* cx, JS::HandleObject state,
                     JS::HandleObject primordials) {
  MOZ_RELEASE_ASSERT(JS::GetClass(state) == &kRealm);
  auto run = [&]() -> bool {
    JS::SetReservedSlot(state, Primordials, JS::ObjectValue(*primordials));
    JS::RootedObject records(cx, JS::NewArrayObject(cx, 0));
    JS::RootedObject process(cx, ProcessObject(cx));
    JS::RootedObject linked(cx, Function(cx, state, LinkedBinding, 1, "getLinkedBinding"));
    JS::RootedObject internal(cx, Function(cx, state, InternalBinding, 1, "getInternalBinding"));
    if (!records || !process || !linked || !internal) return false;
    JS::SetReservedSlot(state, CompiledIds, JS::ObjectValue(*records));
    JS::SetReservedSlot(state, Process, JS::ObjectValue(*process));
    JS::SetReservedSlot(state, LinkedLookup, JS::ObjectValue(*linked));
    JS::SetReservedSlot(state, InternalLookup, JS::ObjectValue(*internal));
    JS::RootedFunction function(cx, CompileBuiltinFunction(cx, "internal/bootstrap/realm"));
    if (!function) return false;
    JS::RootedString id(cx, JS_NewStringCopyZ(cx, "internal/bootstrap/realm"));
    if (!id || !JS_DefineElement(cx, records, 0, id, JSPROP_ENUMERATE)) return false;
    JS::RootedValue callable(cx, JS::ObjectValue(*JS_GetFunctionObject(function)));
    JS::RootedValueArray<4> args(cx);
    args[0].setObject(*process); args[1].setObject(*linked); args[2].setObject(*internal); args[3].setObject(*primordials);
    JS::RootedValue result(cx);
    if (!JS::Call(cx, JS::UndefinedHandleValue, callable, args, &result)) return false;
    MOZ_RELEASE_ASSERT(JS::GetReservedSlot(state, InternalLoader).isObject() &&
                       JS::GetReservedSlot(state, BuiltinRequire).isObject(), "Node realm did not register its original loaders");
    return true;
  };
  bool ok = run();
  JS::SetReservedSlot(state, Status, JS::Int32Value(ok ? LibraryReady : Failed)); return ok;
}
bool RejectRepeatedRealmLibraryInitialization(JSContext* cx, JS::HandleObject state) {
  int phase = JS::GetReservedSlot(state, Status).toInt32();
  return Report(cx, phase == LibraryReady ? "Node realm is already initialized"
      : phase == Failed ? "Previous Node realm initialization failed" : "Reentrant Node realm initialization");
}
JSObject* RealmLibrarySnapshot(JSContext* cx, JS::HandleObject state, bool inspect) {
  int phase = JS::GetReservedSlot(state, Status).toInt32();
  if (!inspect && phase != LibraryReady) {
    Report(cx, phase == Failed ? "Previous Node realm initialization failed" : "Reentrant Node realm initialization"); return nullptr;
  }
  JS::RootedObject snapshot(cx, JS_NewPlainObject(cx));
  if (!snapshot || !JS_DefineProperty(cx, snapshot, "phase", phase, JSPROP_ENUMERATE)) return nullptr;
  JS::RootedValue registered(cx, JS::BooleanValue(JS::GetReservedSlot(state, InternalLoader).isObject()));
  if (!JS_DefineProperty(cx, snapshot, "loadersRegistered", registered, JSPROP_ENUMERATE)) return nullptr;
  if (phase == LibraryReady) {
    for (const auto& field : {std::pair{"process", Process}, std::pair{"require", BuiltinRequire},
                             std::pair{"internalBinding", InternalLoader}}) {
      JS::RootedValue value(cx, JS::GetReservedSlot(state, field.second));
      if (!JS_DefineProperty(cx, snapshot, field.first, value, JSPROP_ENUMERATE)) return nullptr;
    }
    JS::RootedObject records(cx, &JS::GetReservedSlot(state, CompiledIds).toObject());
    uint32_t count;
    if (!JS::GetArrayLength(cx, records, &count)) return nullptr;
    JS::RootedObject copy(cx, JS::NewArrayObject(cx, count));
    if (!copy) return nullptr;
    for (uint32_t i = 0; i < count; i++) {
      JS::RootedValue value(cx);
      if (!JS_GetElement(cx, records, i, &value) || !JS_DefineElement(cx, copy, i, value, JSPROP_ENUMERATE)) return nullptr;
    }
    if (!JS_DefineProperty(cx, snapshot, "compiledBuiltinIds", copy, JSPROP_ENUMERATE)) return nullptr;
  }
  return snapshot;
}

}  // namespace kandelo::node
