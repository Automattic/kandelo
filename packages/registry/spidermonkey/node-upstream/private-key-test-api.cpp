#include "shell/node-upstream/private-key-test-api.h"

#include "jsapi.h"

#include "builtin/ModuleObject.h"
#include "js/Array.h"
#include "js/CallAndConstruct.h"
#include "js/CallArgs.h"
#include "js/CharacterEncoding.h"
#include "js/Conversions.h"
#include "js/ErrorReport.h"
#include "js/friend/WindowProxy.h"
#include "js/GlobalObject.h"
#include "js/Modules.h"
#include "js/PropertyAndElement.h"
#include "js/Realm.h"
#include "js/RootingAPI.h"
#include "js/StableStringChars.h"
#include "js/String.h"
#include "js/Symbol.h"
#include "js/Wrapper.h"
#include "shell/jsshell.h"
#include "shell/node-upstream/async-wrap.h"
#include "shell/node-upstream/buffer-memory.h"
#include "shell/node-upstream/builtin-compiler.h"
#include "shell/node-upstream/codecs.h"
#include "shell/node-upstream/error-stack.h"
#include "shell/node-upstream/per-context.h"
#include "shell/node-upstream/trace-agent-test-api.h"
#include "shell/node-upstream/types.h"
#include "shell/ShellModuleObjectWrapper.h"

namespace kandelo::node {
namespace {

static int externalReferenceToken = 42;
bool CompileFunctionBodyForTesting(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  if (argc != 3 || !args[0].isObject() || !args[1].isString() ||
      !args[2].isString()) {
    JS_ReportErrorASCII(cx, "native function compiler control requires global, filename and body");
    return false;
  }
  JS::RootedObject global(cx, js::CheckedUnwrapDynamic(&args[0].toObject(), cx, false));
  if (!global) return false;
  global = js::ToWindowIfWindowProxy(global);
  if (!JS_IsGlobalObject(global)) {
    JS_ReportErrorASCII(cx, "native function compiler control requires a genuine global");
    return false;
  }
  JS::RootedString filename(cx, args[1].toString()), body(cx, args[2].toString());
  JS::AutoStableStringChars filenameChars(cx);
  if (!filenameChars.initTwoByte(cx, filename)) return false;
  const auto* chars = filenameChars.twoByteChars();
  const size_t length = JS_GetStringLength(filename);
  for (size_t i = 0; i < length; ++i) {
    char16_t unit = chars[i];
    if (unit == 0 || (unit & 0xfc00) == 0xdc00 ||
        ((unit & 0xfc00) == 0xd800 &&
         (++i == length || (chars[i] & 0xfc00) != 0xdc00))) {
      // The diagnostic probe supplies native UTF-8 C-string metadata, not the
      // complete V8 ScriptOrigin interface. Never silently truncate or replace.
      JS_ReportErrorASCII(cx, "native compiler probe filename must be well-formed UTF-8 metadata without NUL");
      return false;
    }
  }
  JS::UniqueChars encoded = JS_EncodeStringToUTF8(cx, filename);
  if (!encoded) return false;
  // These are native-known formal names, as used by the reviewed startup
  // consumer. This probe does not implement or register its original binding.
  const char* const parameters[] = {"require", "__filename", "__dirname"};
  JS::RootedValue result(cx);
  {
    JSAutoRealm home(cx, global);
    JS::RootedFunction function(cx, CompileNativeFunctionBody(cx, encoded.get(),
                                                            body, 3, parameters));
    if (!function) return false;
    result.setObject(*JS_GetFunctionObject(function));
  }
  if (!JS_WrapValue(cx, &result)) return false;
  args.rval().set(result);
  return true;
}
bool ConfigureNativeOptions(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  bool array = false;
  if (!args.get(0).isObject()) { JS_ReportErrorASCII(cx, "Native options control requires an argument array"); return false; }
  if (!JS::IsArrayObject(cx, args.get(0), &array)) return false;
  if (!array) { JS_ReportErrorASCII(cx, "Native options control requires an argument array"); return false; }
  JS::RootedObject arguments(cx, &args[0].toObject());
  JS::RootedString environment(cx, args.get(1).isUndefined() ? JS_NewStringCopyZ(cx, "") : JS::ToString(cx, args[1]));
  if (!environment) return false;
  JS::RootedObject runtime(cx, js::shell::GetShellContext(cx)->upstreamNodeRuntime);
  if (!ConfigureCurrentOptions(cx, runtime, arguments, environment)) return false;
  args.rval().setUndefined(); return true;
}
bool SetNativeCodecGcStress(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  if (!args.get(0).isBoolean()) { JS_ReportErrorASCII(cx, "Native codec GC control requires a boolean"); return false; }
  JS::RootedObject runtime(cx, js::shell::GetShellContext(cx)->upstreamNodeRuntime);
  if (!SetCodecGcStress(cx, runtime, args[0].toBoolean())) return false;
  args.rval().setUndefined(); return true;
}
bool InspectNativeCodecs(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject runtime(cx, js::shell::GetShellContext(cx)->upstreamNodeRuntime);
  JS::RootedObject snapshot(cx, InspectCodecState(cx, runtime)); if (!snapshot) return false;
  args.rval().setObject(*snapshot); return true;
}
bool InspectNativeOptions(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject runtime(cx, js::shell::GetShellContext(cx)->upstreamNodeRuntime);
  JS::RootedObject snapshot(cx, InspectCurrentOptions(cx, runtime)); if (!snapshot) return false;
  args.rval().setObject(*snapshot); return true;
}
bool NewExternal(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject object(cx, CreateExternalPointer(cx, &externalReferenceToken));
  if (!object) return false;
  args.rval().setObject(*object); return true;
}
bool ReadExternal(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) {
    JS_ReportErrorASCII(cx, "Expected a native External value"); return false;
  }
  JS::RootedObject object(cx, &args[0].toObject()); void* pointer;
  if (!GetExternalPointer(cx, object, &pointer)) return false;
  MOZ_RELEASE_ASSERT(pointer == &externalReferenceToken);
  args.rval().setInt32(*static_cast<int*>(pointer)); return true;
}

bool NewPrivateKey(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedString description(cx);
  if (argc && !args[0].isUndefined()) {
    description = JS::ToString(cx, args[0]);
    if (!description) {
      return false;
    }
  }
  JS::RootedSymbol key(cx, JS::NewEmbeddingPrivateSymbol(cx, description));
  if (!key) {
    return false;
  }
  args.rval().setSymbol(key);
  return true;
}

bool InitializePrivateKey(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  if (argc != 3 || !args[0].isObject() || !args[1].isSymbol()) {
    JS_ReportErrorASCII(cx, "initializePrivateKey requires object, private key, value");
    return false;
  }
  JS::RootedSymbol key(cx, args[1].toSymbol());
  if (JS::GetSymbolCode(key) != JS::SymbolCode::EmbeddingPrivateSymbol) {
    JS_ReportErrorASCII(cx, "initializePrivateKey requires an embedding-private key");
    return false;
  }
  JS::RootedObject target(cx, &args[0].toObject());
  JS::RootedId id(cx, JS::PropertyKey::Symbol(key));
  // Native DefineProperty initializes proxy-owned hidden storage. Using Set
  // here would conflate native initialization with the rejected first JS write.
  if (!JS_DefinePropertyById(cx, target, id, args[2], 0)) {
    return false;
  }
  args.rval().setUndefined();
  return true;
}

enum class ContextOperation { Initialize, GetExports, Inspect, ModuleWrapBinding,
                              ErrorBinding, InitializeRealm, GetRealm, InspectRealm, RunNode, InspectTimers, InspectAsync };

bool ContextOperationCall(JSContext* cx, unsigned argc, JS::Value* vp,
                          ContextOperation operation) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject runtime(cx, EnsureRuntimeState(
      cx, js::shell::GetShellContext(cx)->upstreamNodeRuntime));
  if (!runtime) return false;
  JS::RootedObject target(cx, JS::CurrentGlobalOrNull(cx));
  if (argc) {
    if (argc != 1 || !args[0].isObject()) {
      JS_ReportErrorASCII(cx, "context control requires a global object");
      return false;
    }
    target = js::CheckedUnwrapDynamic(&args[0].toObject(), cx, false);
    if (!target) {
      JS_ReportErrorASCII(cx, "context global access denied");
      return false;
    }
    target = js::ToWindowIfWindowProxy(target);
    if (!JS_IsGlobalObject(target)) {
      JS_ReportErrorASCII(cx, "context control requires a genuine global");
      return false;
    }
  }
  JS::RootedValue result(cx);
  bool ok;
  {
    JSAutoRealm realm(cx, target);
    ok = operation != ContextOperation::Initialize ||
         InitializeCurrentContext(cx, runtime);
    if (ok && operation == ContextOperation::InitializeRealm)
      ok = InitializeCurrentRealmLibrary(cx, runtime);
    if (ok && operation == ContextOperation::RunNode)
      ok = RunCurrentNodeBootstrap(cx, runtime);
    if (ok) {
      JS::RootedObject value(cx, operation == ContextOperation::Inspect
          ? InspectCurrentContextForTesting(cx, runtime)
          : operation == ContextOperation::ModuleWrapBinding
          ? GetCurrentContextModuleWrapBinding(cx, runtime)
          : operation == ContextOperation::ErrorBinding
          ? GetErrorStackBinding(cx)
          : operation == ContextOperation::InspectTimers
          ? InspectCurrentTimerState(cx, runtime)
          : operation == ContextOperation::InspectAsync
          ? InspectRuntimeAsyncState(cx, runtime)
          : operation == ContextOperation::InitializeRealm || operation == ContextOperation::GetRealm ||
            operation == ContextOperation::InspectRealm || operation == ContextOperation::RunNode
          ? GetCurrentRealmLibrary(cx, runtime, operation == ContextOperation::InspectRealm)
          : GetCurrentContextExports(cx, runtime));
      ok = bool(value);
      if (ok) result.setObject(*value);
    }
  }
  if (!ok) {
    // GetPendingException performs the engine's checked exception wrapping
    // into the caller realm, preserving the original exception and stack.
    if (JS_IsExceptionPending(cx)) {
      JS::RootedValue exception(cx);
      if (!JS_GetPendingException(cx, &exception)) return false;
    }
    return false;
  }
  if (!JS_WrapValue(cx, &result)) return false;
  args.rval().set(result);
  return true;
}

bool InitializeContext(JSContext* cx, unsigned argc, JS::Value* vp) {
  return ContextOperationCall(cx, argc, vp, ContextOperation::Initialize);
}
bool GetContextExports(JSContext* cx, unsigned argc, JS::Value* vp) {
  return ContextOperationCall(cx, argc, vp, ContextOperation::GetExports);
}
bool InspectContext(JSContext* cx, unsigned argc, JS::Value* vp) {
  return ContextOperationCall(cx, argc, vp, ContextOperation::Inspect);
}
bool GetModuleWrapBinding(JSContext* cx, unsigned argc, JS::Value* vp) {
  return ContextOperationCall(cx, argc, vp, ContextOperation::ModuleWrapBinding);
}
bool GetErrorBinding(JSContext* cx, unsigned argc, JS::Value* vp) {
  return ContextOperationCall(cx, argc, vp, ContextOperation::ErrorBinding);
}
bool InitializeRealm(JSContext* cx, unsigned argc, JS::Value* vp) {
  return ContextOperationCall(cx, argc, vp, ContextOperation::InitializeRealm);
}
bool GetRealm(JSContext* cx, unsigned argc, JS::Value* vp) {
  return ContextOperationCall(cx, argc, vp, ContextOperation::GetRealm);
}
bool RunNode(JSContext* cx, unsigned argc, JS::Value* vp) {
  return ContextOperationCall(cx, argc, vp, ContextOperation::RunNode);
}
bool InspectTimers(JSContext* cx, unsigned argc, JS::Value* vp) {
  return ContextOperationCall(cx, argc, vp, ContextOperation::InspectTimers);
}
bool InspectAsync(JSContext* cx, unsigned argc, JS::Value* vp) {
  return ContextOperationCall(cx, argc, vp, ContextOperation::InspectAsync);
}
bool InspectRealm(JSContext* cx, unsigned argc, JS::Value* vp) {
  return ContextOperationCall(cx, argc, vp, ContextOperation::InspectRealm);
}
bool EnhanceFatalStack(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  if (argc != 2 || !args[1].isBoolean()) {
    JS_ReportErrorASCII(cx, "fatal stack control requires error and phase boolean"); return false;
  }
  return EnhanceFatalExceptionStack(cx, args[0], args[1].toBoolean(), args.rval());
}

bool EvaluateSyntheticForTesting(JSContext* cx, JS::HandleObject module,
                                 JS::HandleValue callback) {
  JS::RootedValue result(cx);
  return JS::Call(cx, JS::UndefinedHandleValue, callback,
                  JS::HandleValueArray::empty(), &result);
}

bool NewSyntheticModule(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  bool array = false;
  if (argc != 2) {
    JS_ReportErrorASCII(cx, "synthetic control requires names array and callback");
    return false;
  }
  if (!JS::IsArrayObject(cx, args[0], &array)) return false;
  if (!array || !args[1].isObject() || !JS::IsCallable(&args[1].toObject())) {
    JS_ReportErrorASCII(cx, "synthetic control requires names array and callback");
    return false;
  }
  JS::RootedObject names(cx, &args[0].toObject());
  uint32_t length;
  if (!JS::GetArrayLength(cx, names, &length)) return false;
  JS::RootedValueVector values(cx);
  if (!values.resize(length)) return false;
  for (uint32_t i = 0; i < length; i++) {
    if (!JS_GetElement(cx, names, i, values[i])) return false;
  }
  JS::RootedObject module(cx, JS::CreateSyntheticModule(
      cx, values, EvaluateSyntheticForTesting, args[1]));
  if (!module) return false;
  JS::Rooted<js::ModuleObject*> record(cx, &module->as<js::ModuleObject>());
  JS::RootedObject wrapper(cx, js::shell::ShellModuleObjectWrapper::create(cx, record));
  if (!wrapper) return false;
  args.rval().setObject(*wrapper);
  return true;
}

JSObject* TestModuleArgument(JSContext* cx, JS::HandleValue value) {
  if (!value.isObject() ||
      !value.toObject().is<js::shell::ShellModuleObjectWrapper>()) {
    JS_ReportErrorASCII(cx, "synthetic control requires a genuine shell module");
    return nullptr;
  }
  JSObject* module = value.toObject().as<js::shell::ShellModuleObjectWrapper>().get();
  if (JS::GetObjectRealmOrNull(module) != JS::GetCurrentRealmOrNull(cx)) {
    JS_ReportErrorASCII(cx, "synthetic control requires a same-realm module");
    return nullptr;
  }
  return module;
}

bool SetSyntheticExport(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  if (argc != 3 || !args[1].isString()) {
    JS_ReportErrorASCII(cx, "synthetic export control requires module, name, value");
    return false;
  }
  JS::RootedObject module(cx, TestModuleArgument(cx, args[0]));
  if (!module) return false;
  JS::RootedString name(cx, args[1].toString());
  if (!JS::SetSyntheticModuleExport(cx, module, name, args[2])) return false;
  args.rval().setUndefined();
  return true;
}

bool ModuleNamespaceForTesting(JSContext* cx, unsigned argc, JS::Value* vp) {
  JS::CallArgs args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject module(cx, TestModuleArgument(cx, args.get(0)));
  if (!module) return false;
  if (module->as<js::ModuleObject>().status() == js::ModuleStatus::Unlinked) {
    JS_ReportErrorASCII(cx, "Module must be linked before namespace access");
    return false;
  }
  JS::RootedObject ns(cx, JS::GetModuleNamespace(cx, module));
  if (!ns) return false;
  args.rval().setObject(*ns);
  return true;
}

}  // namespace

bool DefinePrivateKeyTestAPI(JSContext* cx) {
  static const JSFunctionSpec functions[] = {
      JS_FN("compileFunctionBody", CompileFunctionBodyForTesting, 3, 0),
      JS_FN("newPrivateKey", NewPrivateKey, 0, 0),
      JS_FN("newExternal", NewExternal, 0, 0),
      JS_FN("configureOptions", ConfigureNativeOptions, 2, 0),
      JS_FN("inspectOptions", InspectNativeOptions, 0, 0),
      JS_FN("inspectCodecs", InspectNativeCodecs, 0, 0),
      JS_FN("stressCodecGc", SetNativeCodecGcStress, 1, 0),
      JS_FN("readExternal", ReadExternal, 1, 0),
      JS_FN("initializePrivateKey", InitializePrivateKey, 3, 0),
      JS_FN("initializeContext", InitializeContext, 0, 0),
      JS_FN("getContextExports", GetContextExports, 0, 0),
      JS_FN("inspectContext", InspectContext, 0, 0),
      JS_FN("getModuleWrapBinding", GetModuleWrapBinding, 0, 0),
      JS_FN("getErrorBinding", GetErrorBinding, 0, 0),
      JS_FN("initializeRealm", InitializeRealm, 0, 0),
      JS_FN("getRealm", GetRealm, 0, 0),
      JS_FN("inspectRealm", InspectRealm, 0, 0),
      JS_FN("runNodeBootstrap", RunNode, 0, 0),
      JS_FN("inspectTimers", InspectTimers, 0, 0),
      JS_FN("inspectAsync", InspectAsync, 0, 0),
      JS_FN("enhanceFatalStack", EnhanceFatalStack, 2, 0),
      JS_FN("newSyntheticModule", NewSyntheticModule, 2, 0),
      JS_FN("setSyntheticExport", SetSyntheticExport, 3, 0),
      JS_FN("moduleNamespace", ModuleNamespaceForTesting, 1, 0),
      JS_FS_END,
  };
  JS::RootedObject api(cx, JS_NewPlainObject(cx));
  if (!api || !JS_DefineFunctions(cx, api, functions) ||
      !DefineTraceAgentTestAPI(cx, api) || !DefineContinuationTestAPI(cx, api) ||
      !DefineBufferMemoryTestAPI(cx, api) || !DefineEnvironmentTestAPI(cx, api) || !DefineBufferNativeTestAPI(cx, api) || !DefineAliasedTestAPI(cx, api) || !DefineNativeContextTestAPI(cx, api)) {
    return false;
  }
  JS::RootedObject global(cx, JS::CurrentGlobalOrNull(cx));
  return JS_DefineProperty(cx, global,
                           "__kandeloUpstreamTest", api, 0);
}

}  // namespace kandelo::node
