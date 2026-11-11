#include "shell/node-upstream/realm.h"

#include "mozilla/Assertions.h"
#include "mozilla/Maybe.h"

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <openssl/opensslv.h>
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
#include "js/Conversions.h"
#include "js/Exception.h"
#include "js/friend/WindowProxy.h"
#include "js/GlobalObject.h"
#include "js/LocaleSensitive.h"
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
#include "shell/node-upstream/task-queue.h"
#include "shell/node-upstream/timers.h"

namespace kandelo::node {
namespace {

enum Phase { Initializing = 1, LibraryReady = 2, Failed = 3 };
enum NodePhase { NodeNotStarted = 0, NodeRunning = 1, NodeBodyDone = 2, NodeFailed = 3 };
enum Slot { Status, Global, Process, Primordials, Builtins, Util, Config, Timers, TaskQueue, InternalLoader,
            BuiltinRequire, LinkedLookup, InternalLookup, CompiledIds, NodeStatus, Slots };
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
bool FipsConfig(JSContext* cx, unsigned argc, JS::Value* vp) {
  return Missing(cx, "Native FIPS configuration integration is not implemented");
}
bool DefaultLocale(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::UniqueChars locale = JS_GetDefaultLocale(cx);
  if (!locale) return Report(cx, "Guest engine default locale is unavailable");
  JS::RootedString result(cx, JS_NewStringCopyZ(cx, locale.get()));
  if (!result) return false;
  args.rval().setString(result); return true;
}
JSObject* ConfigBinding(JSContext* cx, JS::HandleObject state) {
  JS::Value cached = JS::GetReservedSlot(state, Config);
  if (cached.isObject()) return &cached.toObject();
  JS::RootedObject binding(cx, JS_NewPlainObject(cx));
  if (!binding) return nullptr;
  auto flag = [&](const char* name, bool enabled) {
    JS::RootedValue value(cx, JS::BooleanValue(enabled));
    return JS_DefineProperty(cx, binding, name, value, JSPROP_ENUMERATE | JSPROP_READONLY);
  };
#if defined(DEBUG) && DEBUG
  if (!flag("isDebugBuild", true)) return nullptr;
#else
  if (!flag("isDebugBuild", false)) return nullptr;
#endif
#ifdef OPENSSL_IS_BORINGSSL
  if (!flag("openSSLIsBoringSSL", true)) return nullptr;
#else
  if (!flag("openSSLIsBoringSSL", false)) return nullptr;
#endif
#ifdef OPENSSL_VERSION_NUMBER
  if (!flag("hasOpenSSL", true)) return nullptr;
#else
  if (!flag("hasOpenSSL", false)) return nullptr;
#endif
#if JS_HAS_INTL_API
  if (!flag("hasIntl", true)) return nullptr;
#endif
  // These describe this embedding's actual build/policy. No V8 tracing agent,
  // inspector or NODE_OPTIONS parser is registered; full web bootstrap is the
  // selected default, so lack of a backend must not gate those sources away.
  if (!flag("hasInspector", false) || !flag("noBrowserGlobals", false) ||
      !JS_DefineProperty(cx, binding, "bits", int32_t(8 * sizeof(intptr_t)), JSPROP_ENUMERATE | JSPROP_READONLY) ||
      !JS_DefineProperty(cx, binding, "fipsMode", FipsConfig, nullptr, JSPROP_ENUMERATE) ||
      !JS_DefineFunction(cx, binding, "getDefaultLocale", DefaultLocale, 0, 0)) return nullptr;
  JS::SetReservedSlot(state, Config, JS::ObjectValue(*binding)); return binding;
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
  else if (name == "config") binding = ConfigBinding(cx, state);
  else if (name == "timers") {
    JS::Value cached = JS::GetReservedSlot(state, Timers);
    if (cached.isObject()) binding = &cached.toObject();
    else {
      JS::RootedObject process(cx, &JS::GetReservedSlot(state, Process).toObject());
      binding = CreateTimersBinding(cx, runtime, state, process);
      if (!binding) return false;
      JS::SetReservedSlot(state, Timers, JS::ObjectValue(*binding));
    }
  }
  else if (name == "task_queue") {
    JS::Value cached = JS::GetReservedSlot(state, TaskQueue);
    if (cached.isObject()) binding = &cached.toObject();
    else {
      binding = CreateTaskQueueBinding(cx, runtime, state);
      if (!binding) return false;
      JS::SetReservedSlot(state, TaskQueue, JS::ObjectValue(*binding));
    }
  }
  else if (name == "module_wrap") binding = GetCurrentContextModuleWrapBinding(cx, runtime);
  else if (name == "errors") binding = GetErrorStackBinding(cx);
  else if (name == "util") {
    JS::Value cached = JS::GetReservedSlot(state, Util);
    if (cached.isObject()) binding = &cached.toObject();
    else {
      binding = JS_NewPlainObject(cx);
      JS::RootedObject symbols(cx, CreateRuntimePrivateSymbolTable(cx, runtime));
      JS::RootedObject constants(cx, JS_NewPlainObject(cx));
      if (!binding || !symbols || !constants ||
          !JS_DefineProperty(cx, binding, "privateSymbols", symbols, JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx, binding, "constants", constants, JSPROP_ENUMERATE)) return false;
      for (const auto& entry : {std::pair{"kExiting", kExiting}, std::pair{"kExitCode", kExitCode},
                               std::pair{"kHasExitCode", kHasExitCode}})
        if (!JS_DefineProperty(cx, constants, entry.first, int32_t(entry.second), JSPROP_ENUMERATE)) return false;
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
bool ProcessConstructor(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  if (!args.isConstructing()) {
    // An empty FunctionTemplate callback returns its effective receiver, with
    // global substitution and primitive boxing, rather than undefined.
    JS::RootedObject receiver(cx, args.thisv().isNullOrUndefined()
        ? js::ToWindowProxyIfWindow(JS::CurrentGlobalOrNull(cx))
        : JS::ToObject(cx, args.thisv()));
    if (!receiver) return false;
    args.rval().setObject(*receiver); return true;
  }
  JS::RootedObject instance(cx, JS_NewObjectForConstructor(cx, &kProcess, args));
  if (!instance) return false;
  // The original FunctionTemplate constructor creates an empty instance;
  // CreateProcessObject initializes metadata only on the actual realm process.
  args.rval().setObject(*instance); return true;
}
JSObject* ProcessObject(JSContext* cx, JS::HandleObject runtime) {
  struct utsname data;
  if (uname(&data) != 0) { JS_ReportErrorASCII(cx, "Guest uname failed: %s", std::strerror(errno)); return nullptr; }
  auto pid = getpid();
  if (pid < 0) { Report(cx, "Guest getpid failed"); return nullptr; }
  JS::RootedObject prototype(cx, JS_NewPlainObject(cx));
  JS::RootedFunction function(cx, JS_NewFunction(cx, ProcessConstructor, 0, JSFUN_CONSTRUCTOR, "process"));
  if (!prototype || !function) return nullptr;
  JS::RootedObject constructor(cx, JS_GetFunctionObject(function));
  if (!JS_DefineProperty(cx, prototype, "constructor", constructor, 0) ||
      !JS_DefineProperty(cx, constructor, "prototype", prototype, JSPROP_PERMANENT)) return nullptr;
  JS::RootedObject process(cx, JS_NewObjectWithGivenProto(cx, &kProcess, prototype));
  JS::RootedObject exitInfo(cx, GetRuntimeExitInfo(cx, runtime));
  JS::RootedSymbol exitKey(cx, GetRuntimeSymbol(cx, runtime, "exit_info_private_symbol"));
  JS::RootedString platform(cx, JS_NewStringCopyZ(cx, data.sysname));
  JS::RootedString machine(cx, JS_NewStringCopyZ(cx, data.machine));
  if (!process || !exitInfo || !exitKey || !platform || !machine) return nullptr;
  JS::RootedId key(cx, JS::PropertyKey::Symbol(exitKey));
  if (!JS_DefinePropertyById(cx, process, key, exitInfo, 0) ||
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
  JS::SetReservedSlot(state, NodeStatus, JS::Int32Value(NodeNotStarted));
  JS::SetReservedSlot(state, Global, JS::ObjectValue(*JS::CurrentGlobalOrNull(cx))); return state;
}
bool RealmLibraryIsFailed(JSObject* state) {
  MOZ_RELEASE_ASSERT(JS::GetClass(state) == &kRealm);
  return JS::GetReservedSlot(state, Status) == JS::Int32Value(Failed);
}
bool CheckRealmLibraryActive(JSContext* cx, JS::HandleObject state) {
  MOZ_RELEASE_ASSERT(JS::GetClass(state) == &kRealm);
  if (JS::GetReservedSlot(state, Status) == JS::Int32Value(Failed))
    return Report(cx, "Previous Node realm initialization failed");
  return true;
}
bool RunRealmLibrary(JSContext* cx, JS::HandleObject state,
                     JS::HandleObject primordials) {
  MOZ_RELEASE_ASSERT(JS::GetClass(state) == &kRealm);
  auto run = [&]() -> bool {
    JS::SetReservedSlot(state, Primordials, JS::ObjectValue(*primordials));
    JS::RootedObject records(cx, JS::NewArrayObject(cx, 0));
    JS::RootedObject runtime(cx, Runtime(cx));
    JS::RootedObject process(cx, ProcessObject(cx, runtime));
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
  if (ok) {
    JS::RootedObject runtime(cx, Runtime(cx));
    JS::RootedObject process(cx, &JS::GetReservedSlot(state, Process).toObject());
    ok = RegisterRuntimePrincipalRealm(cx, runtime, state, process);
  }
  JS::SetReservedSlot(state, Status, JS::Int32Value(ok ? LibraryReady : Failed)); return ok;
}
bool RejectRepeatedRealmLibraryInitialization(JSContext* cx, JS::HandleObject state) {
  int phase = JS::GetReservedSlot(state, Status).toInt32();
  return Report(cx, phase == LibraryReady ? "Node realm is already initialized"
      : phase == Failed ? "Previous Node realm initialization failed" : "Reentrant Node realm initialization");
}
bool RunNodeBootstrap(JSContext* cx, JS::HandleObject state) {
  int phase = JS::GetReservedSlot(state, NodeStatus).toInt32();
  if (phase != NodeNotStarted)
    return Report(cx, phase == NodeFailed ? "Previous Node bootstrap failed"
        : phase == NodeRunning ? "Reentrant Node bootstrap" : "Node bootstrap body already executed");
  if (JS::GetReservedSlot(state, Status) != JS::Int32Value(LibraryReady))
    return Report(cx, "Node realm library is not ready");
  JS::SetReservedSlot(state, NodeStatus, JS::Int32Value(NodeRunning));
  auto run = [&]() -> bool {
    JS::RootedFunction function(cx, CompileBuiltinFunction(cx, "internal/bootstrap/node"));
    if (!function) return false;
    JS::RootedObject records(cx, &JS::GetReservedSlot(state, CompiledIds).toObject());
    JS::RootedString id(cx, JS_NewStringCopyZ(cx, "internal/bootstrap/node"));
    uint32_t count;
    if (!id || !JS::GetArrayLength(cx, records, &count) ||
        !JS_DefineElement(cx, records, count, id, JSPROP_ENUMERATE)) return false;
    JS::RootedValue callable(cx, JS::ObjectValue(*JS_GetFunctionObject(function)));
    JS::RootedValueArray<4> args(cx);
    args[0].set(JS::GetReservedSlot(state, Process));
    args[1].set(JS::GetReservedSlot(state, BuiltinRequire));
    args[2].set(JS::GetReservedSlot(state, InternalLoader));
    args[3].set(JS::GetReservedSlot(state, Primordials));
    JS::RootedValue result(cx);
    return JS::Call(cx, JS::UndefinedHandleValue, callable, args, &result);
  };
  bool ok = run();
  JS::SetReservedSlot(state, NodeStatus, JS::Int32Value(ok ? NodeBodyDone : NodeFailed));
  // A failed native bootstrap cannot leave a reusable partial environment.
  // Success here is only node.js completion, not web/switches/Realm completion.
  if (!ok) JS::SetReservedSlot(state, Status, JS::Int32Value(Failed));
  return ok;
}
JSObject* RealmLibrarySnapshot(JSContext* cx, JS::HandleObject state, bool inspect) {
  int phase = JS::GetReservedSlot(state, Status).toInt32();
  if (!inspect && phase != LibraryReady) {
    Report(cx, phase == Failed ? "Previous Node realm initialization failed" : "Reentrant Node realm initialization"); return nullptr;
  }
  JS::RootedObject snapshot(cx, JS_NewPlainObject(cx));
  if (!snapshot || !JS_DefineProperty(cx, snapshot, "phase", phase, JSPROP_ENUMERATE)) return nullptr;
  JS::RootedValue nodeStatus(cx, JS::GetReservedSlot(state, NodeStatus));
  if (!JS_DefineProperty(cx, snapshot, "nodeBootstrapPhase", nodeStatus, JSPROP_ENUMERATE)) return nullptr;
  JS::RootedValue registered(cx, JS::BooleanValue(JS::GetReservedSlot(state, InternalLoader).isObject()));
  if (!JS_DefineProperty(cx, snapshot, "loadersRegistered", registered, JSPROP_ENUMERATE)) return nullptr;
  if (phase == LibraryReady) {
    for (const auto& field : {std::pair{"process", Process}, std::pair{"require", BuiltinRequire},
                             std::pair{"internalBinding", InternalLoader}}) {
      JS::RootedValue value(cx, JS::GetReservedSlot(state, field.second));
      if (!JS_DefineProperty(cx, snapshot, field.first, value, JSPROP_ENUMERATE)) return nullptr;
    }
  }
  if (phase == LibraryReady || inspect) {
    JS::Value recorded = JS::GetReservedSlot(state, CompiledIds);
    if (!recorded.isObject()) return snapshot;
    JS::RootedObject records(cx, &recorded.toObject());
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
