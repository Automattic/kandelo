#include "shell/node-upstream/private-key-test-api.h"

#include "jsapi.h"

#include "js/CallArgs.h"
#include "js/Conversions.h"
#include "js/ErrorReport.h"
#include "js/friend/WindowProxy.h"
#include "js/GlobalObject.h"
#include "js/PropertyAndElement.h"
#include "js/Realm.h"
#include "js/RootingAPI.h"
#include "js/Symbol.h"
#include "js/Wrapper.h"
#include "shell/jsshell.h"
#include "shell/node-upstream/per-context.h"

namespace kandelo::node {
namespace {

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

enum class ContextOperation { Initialize, GetExports, Inspect };

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
    if (ok) {
      JS::RootedObject value(cx, operation == ContextOperation::Inspect
          ? InspectCurrentContextForTesting(cx, runtime)
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

}  // namespace

bool DefinePrivateKeyTestAPI(JSContext* cx) {
  static const JSFunctionSpec functions[] = {
      JS_FN("newPrivateKey", NewPrivateKey, 0, 0),
      JS_FN("initializePrivateKey", InitializePrivateKey, 3, 0),
      JS_FN("initializeContext", InitializeContext, 0, 0),
      JS_FN("getContextExports", GetContextExports, 0, 0),
      JS_FN("inspectContext", InspectContext, 0, 0),
      JS_FS_END,
  };
  JS::RootedObject api(cx, JS_NewPlainObject(cx));
  if (!api || !JS_DefineFunctions(cx, api, functions)) {
    return false;
  }
  JS::RootedObject global(cx, JS::CurrentGlobalOrNull(cx));
  return JS_DefineProperty(cx, global,
                           "__kandeloUpstreamTest", api, 0);
}

}  // namespace kandelo::node
