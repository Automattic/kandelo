#include "shell/node-upstream/error-stack.h"

#include "mozilla/Assertions.h"
#include "mozilla/Maybe.h"
#include "mozilla/ScopeExit.h"

#include <cmath>
#include <cstdint>
#include <cstring>

#include "jsapi.h"
#include "jsfriendapi.h"
#include "jsnum.h"

#include "js/Array.h"
#include "js/CallAndConstruct.h"
#include "js/CallArgs.h"
#include "js/CharacterEncoding.h"
#include "js/ColumnNumber.h"
#include "js/Exception.h"
#include "js/friend/WindowProxy.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/PropertyDescriptor.h"
#include "js/Proxy.h"
#include "js/Realm.h"
#include "js/SavedFrameAPI.h"
#include "js/Stack.h"
#include "js/WeakMap.h"
#include "js/Wrapper.h"
#include "shell/jsshell.h"
#include "shell/node-upstream/per-context.h"
#include "util/StringBuilder.h"
#include "vm/FrameIter.h"
#include "vm/JSScript.h"
#include "vm/Realm.h"

namespace kandelo::node {
namespace {

enum StateSlot { Cache, OriginalError, OriginalToString, SitePrototype,
                 PrepareCallback, BeforeFatal, AfterFatal, Binding, StateSlots };
enum CaptureSlot { SavedStack, CaptureLimit, Cached, PreparedValue, SourceFiles, CaptureSlots };
const JSClass kState = {"NodeErrorStackState", JSCLASS_HAS_RESERVED_SLOTS(StateSlots)};
const JSClass kCapture = {"NodeErrorStackCapture", JSCLASS_HAS_RESERVED_SLOTS(CaptureSlots)};
const JSClass kSite = {"CallSite", JSCLASS_HAS_RESERVED_SLOTS(2)};
constexpr auto kVisible = JS::SavedFrameSelfHosted::Exclude;

JSObject* State(JSContext* cx) {
  auto* shell = js::shell::GetShellContext(cx);
  if (!shell->upstreamNodeRuntime) return nullptr;
  JS::RootedObject runtime(cx, shell->upstreamNodeRuntime);
  return GetCurrentContextErrorStackState(cx, runtime);
}
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
  JS_SetPendingException(cx, error); return false;
}
bool Missing(JSContext* cx, const char* message) {
  return Throw(cx, JSEXN_ERR, "ERR_KANDELO_NOT_IMPLEMENTED", message);
}
bool Limit(JSContext* cx, JS::HandleObject state, int32_t* limit) {
  JS::RootedObject current(cx, &JS::GetReservedSlot(state, OriginalError).toObject());
  JS::Rooted<mozilla::Maybe<JS::PropertyDescriptor>> descriptor(cx);
  while (current) {
    // Original V8 GetDataProperty stops at a Proxy without invoking traps.
    if (js::IsProxy(current)) { *limit = -1; return true; }
    if (!JS_GetOwnPropertyDescriptor(cx, current, "stackTraceLimit", &descriptor)) return false;
    if (descriptor.isSome()) {
      // V8 GetDataProperty does not execute accessors or coerce other values.
      *limit = -1;
      if (descriptor->isDataDescriptor() && descriptor->value().isNumber()) {
        double value = descriptor->value().toNumber();
        *limit = std::isnan(value) || value <= 0 ? 0
            : value >= INT32_MAX ? INT32_MAX : int32_t(value);
      }
      return true;
    }
    if (!JS_GetPrototype(cx, current, &current)) return false;
  }
  *limit = -1; return true;
}
bool LimitHook(JSContext* cx, uint32_t* limit, bool* handled) {
  JS::RootedObject state(cx, State(cx));
  if (!state) return !JS_IsExceptionPending(cx);
  int32_t count;
  if (!Limit(cx, state, &count)) return false;
  *handled = true; *limit = count < 0 ? 0 : uint32_t(count); return true;
}
JSObject* Frame(JSContext* cx, JS::HandleValue receiver) {
  if (!receiver.isObject() || JS::GetClass(&receiver.toObject()) != &kSite ||
      !JS::GetReservedSlot(&receiver.toObject(), 0).isObject()) {
    Throw(cx, JSEXN_TYPEERR, nullptr, "CallSite method requires a captured CallSite");
    return nullptr;
  }
  return &JS::GetReservedSlot(&receiver.toObject(), 0).toObject();
}
bool Position(JSContext* cx, JS::HandleObject frame, uint32_t* line, uint32_t* column) {
  JS::TaggedColumnNumberOneOrigin value;
  auto* principals = JS::GetRealmPrincipals(JS::GetCurrentRealmOrNull(cx));
  if (JS::GetSavedFrameLine(cx, principals, frame, line, kVisible) != JS::SavedFrameResult::Ok ||
      JS::GetSavedFrameColumn(cx, principals, frame, &value, kVisible) != JS::SavedFrameResult::Ok) {
    JS_ReportErrorASCII(cx, "Captured frame is not visible in this realm"); return false;
  }
  if (!value.isLimitedColumnNumber()) return Missing(cx, "Wasm CallSite metadata is not implemented");
  *column = value.oneOriginValue(); return true;
}
JSString* FormatSite(JSContext* cx, JS::HandleObject frame) {
  auto* principals = JS::GetRealmPrincipals(JS::GetCurrentRealmOrNull(cx));
  JS::RootedString name(cx), file(cx);
  uint32_t line, column;
  if (!Position(cx, frame, &line, &column)) return nullptr;
  if (JS::GetSavedFrameSource(cx, principals, frame, &file, kVisible) != JS::SavedFrameResult::Ok ||
      JS::GetSavedFrameFunctionDisplayName(cx, principals, frame, &name, kVisible) != JS::SavedFrameResult::Ok) {
    JS_ReportErrorASCII(cx, "Captured frame is not visible in this realm"); return nullptr;
  }
  js::JSStringBuilder text(cx);
  if ((name && (!text.append(name) || !text.append(" ("))) ||
      !text.append(file) || !text.append(':') ||
      !js::NumberValueToStringBuilder(JS::NumberValue(line), text) ||
      !text.append(':') || !js::NumberValueToStringBuilder(JS::NumberValue(column), text) ||
      (name && !text.append(')'))) return nullptr;
  return text.finishString();
}
bool SiteText(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject frame(cx, Frame(cx, args.thisv()));
  if (!frame) return false;
  JS::RootedString text(cx, FormatSite(cx, frame));
  if (!text) return false;
  args.rval().setString(text); return true;
}
enum SiteField { Filename, ScriptName, FunctionName, Line, Column };
bool SiteFieldCall(JSContext* cx, unsigned argc, JS::Value* vp, SiteField field) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject frame(cx, Frame(cx, args.thisv()));
  if (!frame) return false;
  if (field == Filename) {
    // SavedFrame.source prefers sourceURL. Keep the actual original filename
    // separately rather than silently aliasing two distinct native fields.
    JS::Value value = JS::GetReservedSlot(&args.thisv().toObject(), 1);
    if (value.isUndefined()) return Missing(cx, "Original filename of this saved frame is unavailable");
    args.rval().set(value); return true;
  }
  auto* principals = JS::GetRealmPrincipals(JS::GetCurrentRealmOrNull(cx));
  if (field == Line || field == Column) {
    uint32_t line, column;
    if (!Position(cx, frame, &line, &column)) return false;
    args.rval().setNumber(field == Line ? line : column); return true;
  }
  JS::RootedString text(cx);
  auto result = field == ScriptName
      ? JS::GetSavedFrameSource(cx, principals, frame, &text, kVisible)
      : JS::GetSavedFrameFunctionDisplayName(cx, principals, frame, &text, kVisible);
  if (result != JS::SavedFrameResult::Ok) {
    JS_ReportErrorASCII(cx, "Captured frame is not visible in this realm"); return false;
  }
  if (text) args.rval().setString(text); else args.rval().setNull();
  return true;
}
bool SiteFilename(JSContext* cx, unsigned argc, JS::Value* vp) { return SiteFieldCall(cx, argc, vp, Filename); }
bool SiteScriptName(JSContext* cx, unsigned argc, JS::Value* vp) { return SiteFieldCall(cx, argc, vp, ScriptName); }
bool SiteFunctionName(JSContext* cx, unsigned argc, JS::Value* vp) { return SiteFieldCall(cx, argc, vp, FunctionName); }
bool SiteLine(JSContext* cx, unsigned argc, JS::Value* vp) { return SiteFieldCall(cx, argc, vp, Line); }
bool SiteColumn(JSContext* cx, unsigned argc, JS::Value* vp) { return SiteFieldCall(cx, argc, vp, Column); }
bool MissingSite(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject frame(cx, Frame(cx, args.thisv()));
  return frame && Missing(cx, "Requested structured CallSite field needs additional engine capture metadata");
}
JSObject* Trace(JSContext* cx, JS::HandleObject state, JS::HandleObject capture) {
  JS::RootedObject array(cx, JS::NewArrayObject(cx, 0));
  if (!array) return nullptr;
  JS::RootedObject frame(cx, JS::GetReservedSlot(capture, SavedStack).toObjectOrNull());
  JS::RootedObject prototype(cx, &JS::GetReservedSlot(state, SitePrototype).toObject());
  JS::RootedObject files(cx, &JS::GetReservedSlot(capture, SourceFiles).toObject());
  uint32_t count = 0;
  int32_t limit = JS::GetReservedSlot(capture, CaptureLimit).toInt32();
  auto* principals = JS::GetRealmPrincipals(JS::GetCurrentRealmOrNull(cx));
  while (frame && count < uint32_t(limit)) {
    JS::RootedObject site(cx, JS_NewObjectWithGivenProto(cx, &kSite, prototype));
    if (!site) return nullptr;
    JS::SetReservedSlot(site, 0, JS::ObjectValue(*frame));
    uint32_t sourceId;
    if (JS::GetSavedFrameSourceId(cx, principals, frame, &sourceId, kVisible) != JS::SavedFrameResult::Ok) {
      JS_ReportErrorASCII(cx, "Captured frame is not visible in this realm"); return nullptr;
    }
    JS::RootedValue filename(cx);
    if (!JS_GetElement(cx, files, sourceId, &filename)) return nullptr;
    JS::SetReservedSlot(site, 1, filename);
    if (!JS_SetElement(cx, array, count++, site)) return nullptr;
    JS::RootedObject parent(cx);
    if (JS::GetSavedFrameParent(cx, principals, frame, &parent, kVisible) != JS::SavedFrameResult::Ok) {
      JS_ReportErrorASCII(cx, "Captured frame is not visible in this realm"); return nullptr;
    }
    if (parent && !JS_WrapObject(cx, &parent)) return nullptr;
    frame = parent;
  }
  return array;
}
bool DefaultPrepare(JSContext* cx, JS::HandleObject state, JS::HandleValue error,
                    JS::HandleObject trace, JS::MutableHandleValue out) {
  JS::RootedValue toString(cx, JS::GetReservedSlot(state, OriginalToString));
  JS::RootedValue header(cx);
  if (!JS::Call(cx, error, toString, JS::HandleValueArray::empty(), &header)) return false;
  js::JSStringBuilder text(cx);
  if (!text.append(header.toString())) return false;
  uint32_t count;
  if (!JS::GetArrayLength(cx, trace, &count)) return false;
  for (uint32_t i = 0; i < count; i++) {
    JS::RootedValue site(cx);
    if (!JS_GetElement(cx, trace, i, &site)) return false;
    JS::RootedObject frame(cx, Frame(cx, site));
    if (!frame) return false;
    JS::RootedString formatted(cx, FormatSite(cx, frame));
    if (!formatted || !text.append("\n    at ") || !text.append(formatted)) return false;
  }
  JS::RootedString result(cx, text.finishString());
  if (!result) return false;
  out.setString(result); return true;
}
// A borrowed accessor follows the target's actual creation realm/cache. It
// never invokes traps on an ordinary Proxy or invents a capture for a target.
JSObject* Target(JSContext* cx, JS::HandleValue value) {
  if (!value.isObject()) return nullptr;
  JSObject* object = &value.toObject();
  if (js::IsWrapper(object)) {
    object = js::CheckedUnwrapStatic(object);
    if (!object) JS_ReportErrorASCII(cx, "Error stack target access denied");
    return object;
  }
  return js::IsProxy(object) ? nullptr : object;
}
bool AccessStack(JSContext* cx, const JS::CallArgs& args, bool set) {
  JS::RootedObject target(cx, Target(cx, args.thisv()));
  args.rval().setUndefined();
  if (!target) return !JS_IsExceptionPending(cx);
  JS::RootedValue result(cx);
  {
    JSAutoRealm realm(cx, target);
    JS::RootedObject state(cx, State(cx));
    if (!state) return !JS_IsExceptionPending(cx);
    JS::RootedObject map(cx, &JS::GetReservedSlot(state, Cache).toObject());
    JS::RootedValue key(cx, JS::ObjectValue(*target)), stored(cx);
    if (!JS::GetWeakMapEntry(cx, map, key, &stored)) return false;
    if (!stored.isObject()) return true;
    JS::RootedObject capture(cx, &stored.toObject());
    if (set) {
      result = args.get(0);
      if (!JS_WrapValue(cx, &result)) return false;
      JS::SetReservedSlot(capture, PreparedValue, result);
      JS::SetReservedSlot(capture, Cached, JS::BooleanValue(true)); return true;
    }
    if (JS::GetReservedSlot(capture, Cached).toBoolean()) {
      result = JS::GetReservedSlot(capture, PreparedValue);
    } else {
      JS::RootedObject trace(cx, Trace(cx, state, capture));
      if (!trace) return false;
      auto* shell = js::shell::GetShellContext(cx);
      if (shell->upstreamErrorStackPreparing) {
        if (!DefaultPrepare(cx, state, key, trace, &result)) return false;
      } else {
        shell->upstreamErrorStackPreparing = true;
        auto clear = mozilla::MakeScopeExit([&] { shell->upstreamErrorStackPreparing = false; });
        JS::RootedValue callback(cx, JS::GetReservedSlot(state, PrepareCallback));
        if (callback.isObject()) {
          JS::RootedValueArray<3> values(cx);
          values[0].setObject(*js::ToWindowProxyIfWindow(JS::CurrentGlobalOrNull(cx)));
          values[1].set(key); values[2].setObject(*trace);
          if (!JS::Call(cx, JS::UndefinedHandleValue, callback, values, &result)) return false;
        } else {
          JS::RootedObject error(cx, &JS::GetReservedSlot(state, OriginalError).toObject());
          if (!JS_GetProperty(cx, error, "prepareStackTrace", &callback)) return false;
          if (callback.isObject() && JS::IsCallable(&callback.toObject())) {
            JS::RootedValueArray<2> values(cx); values[0].set(key); values[1].setObject(*trace);
            JS::RootedValue receiver(cx, JS::ObjectValue(*error));
            if (!JS::Call(cx, receiver, callback, values, &result)) return false;
          } else if (!DefaultPrepare(cx, state, key, trace, &result)) return false;
        }
      }
      JS::SetReservedSlot(capture, PreparedValue, result);
      JS::SetReservedSlot(capture, Cached, JS::BooleanValue(true));
    }
  }
  if (!JS_WrapValue(cx, &result)) return false;
  args.rval().set(result); return true;
}
bool GetStack(JSContext* cx, unsigned argc, JS::Value* vp) { return AccessStack(cx, JS::CallArgsFromVp(argc, vp), false); }
bool SetStack(JSContext* cx, unsigned argc, JS::Value* vp) { return AccessStack(cx, JS::CallArgsFromVp(argc, vp), true); }
JSObject* CaptureSourceFiles(JSContext* cx) {
  JS::RootedObject nullPrototype(cx);
  JS::RootedObject files(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullPrototype));
  if (!files) return nullptr;
  auto* principals = JS::GetRealmPrincipals(JS::GetCurrentRealmOrNull(cx));
  for (js::NonBuiltinFrameIter iter(cx, principals); !iter.done(); ++iter) {
    if (!iter.hasScript()) continue;
    JS::RootedScript script(cx, iter.script());
    uint32_t id = script->scriptSource()->id();
    JS::RootedValue value(cx, JS::NullValue());
    if (const char* filename = script->filename()) {
      JS::RootedString name(cx, JS_NewStringCopyUTF8Z(cx, JS::ConstUTF8CharsZ(filename, std::strlen(filename))));
      if (!name) return nullptr;
      value.setString(name);
    }
    if (!JS_DefineElement(cx, files, id, value, 0)) return nullptr;
  }
  return files;
}
bool CreatedHook(JSContext* cx, JS::HandleObject target, JS::HandleObject stack, bool* handled) {
  JS::RootedObject state(cx, State(cx));
  if (!state) return !JS_IsExceptionPending(cx);
  *handled = true;
  if (js::IsProxy(target)) {
    return Throw(cx, JSEXN_TYPEERR, nullptr, "Error stack capture does not accept Proxy targets");
  }
  int32_t limit;
  if (!Limit(cx, state, &limit)) return false;
  JS::RootedObject capture(cx, JS_NewObject(cx, &kCapture));
  if (!capture) return false;
  JS::SetReservedSlot(capture, SavedStack, JS::ObjectOrNullValue(stack));
  JS::SetReservedSlot(capture, CaptureLimit, JS::Int32Value(limit));
  JS::SetReservedSlot(capture, Cached, JS::BooleanValue(limit < 0));
  JS::RootedObject files(cx, CaptureSourceFiles(cx));
  if (!files) return false;
  JS::SetReservedSlot(capture, SourceFiles, JS::ObjectValue(*files));
  // Publish after defining the real accessors; a refused re-capture keeps its
  // original trace/cache and exception. WeakMap ephemerons own capture edges.
  if (!JS_DefineProperty(cx, target, "stack", GetStack, SetStack, 0)) return false;
  JS::RootedObject map(cx, &JS::GetReservedSlot(state, Cache).toObject());
  JS::RootedValue key(cx, JS::ObjectValue(*target)), value(cx, JS::ObjectValue(*capture));
  return JS::SetWeakMapEntry(cx, map, key, value);
}
bool SetPrepare(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  MOZ_RELEASE_ASSERT(args.get(0).isObject() && JS::IsCallable(&args[0].toObject()));
  JS::RootedObject state(cx, State(cx)); if (!state) return false;
  JS::SetReservedSlot(state, PrepareCallback, args[0]); args.rval().setUndefined(); return true;
}
bool SetEnhance(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  MOZ_RELEASE_ASSERT(args.get(0).isObject() && JS::IsCallable(&args[0].toObject()));
  MOZ_RELEASE_ASSERT(args.get(1).isObject() && JS::IsCallable(&args[1].toObject()));
  JS::RootedObject state(cx, State(cx)); if (!state) return false;
  JS::SetReservedSlot(state, BeforeFatal, args[0]); JS::SetReservedSlot(state, AfterFatal, args[1]);
  args.rval().setUndefined(); return true;
}

}  // namespace

JSObject* CreateErrorStackState(JSContext* cx) {
  JS::RootedObject state(cx, JS_NewObject(cx, &kState));
  JS::RootedObject map(cx, JS::NewWeakMapObject(cx)), error(cx);
  if (!state || !map || !JS_GetClassObject(cx, JSProto_Error, &error)) return nullptr;
  JS::SetReservedSlot(state, Cache, JS::ObjectValue(*map));
  JS::SetReservedSlot(state, OriginalError, JS::ObjectValue(*error));
  JS::RootedValue prototype(cx), stringify(cx);
  if (!JS_GetProperty(cx, error, "prototype", &prototype)) return nullptr;
  JS::RootedObject errorPrototype(cx, &prototype.toObject());
  if (!JS_GetProperty(cx, errorPrototype, "toString", &stringify) ||
      !JS_DefineProperty(cx, error, "stackTraceLimit", 10, JSPROP_ENUMERATE)) return nullptr;
  JS::SetReservedSlot(state, OriginalToString, stringify);
  JS::RootedObject sitePrototype(cx, JS_NewPlainObject(cx));
  if (!sitePrototype) return nullptr;
  static const JSFunctionSpec methods[] = {
      JS_FN("toString", SiteText, 0, 0), JS_FN("getFileName", SiteFilename, 0, 0),
      JS_FN("getScriptNameOrSourceURL", SiteScriptName, 0, 0),
      JS_FN("getFunctionName", SiteFunctionName, 0, 0),
      JS_FN("getLineNumber", SiteLine, 0, 0), JS_FN("getColumnNumber", SiteColumn, 0, 0),
      JS_FN("getThis", MissingSite, 0, 0), JS_FN("getFunction", MissingSite, 0, 0),
      JS_FN("getTypeName", MissingSite, 0, 0), JS_FN("getMethodName", MissingSite, 0, 0),
      JS_FN("getEvalOrigin", MissingSite, 0, 0), JS_FN("isToplevel", MissingSite, 0, 0),
      JS_FN("isEval", MissingSite, 0, 0), JS_FN("isNative", MissingSite, 0, 0),
      JS_FN("isConstructor", MissingSite, 0, 0), JS_FN("isAsync", MissingSite, 0, 0),
      JS_FN("isPromiseAll", MissingSite, 0, 0), JS_FN("getPromiseIndex", MissingSite, 0, 0),
      JS_FS_END};
  if (!JS_DefineFunctions(cx, sitePrototype, methods)) return nullptr;
  JS::SetReservedSlot(state, SitePrototype, JS::ObjectValue(*sitePrototype));
  JS::SetEmbeddingErrorStackHooks(JS_GetRuntime(cx), LimitHook, CreatedHook);
  return state;
}
JSObject* GetErrorStackBinding(JSContext* cx) {
  JS::RootedObject runtime(cx, js::shell::GetShellContext(cx)->upstreamNodeRuntime);
  if (!runtime) {
    JS_ReportErrorASCII(cx, "Node context has not been initialized"); return nullptr;
  }
  if (!GetCurrentContextExports(cx, runtime)) return nullptr;
  JS::RootedObject state(cx, State(cx)); if (!state) return nullptr;
  JS::Value cached = JS::GetReservedSlot(state, Binding);
  if (cached.isObject()) return &cached.toObject();
  JS::RootedObject binding(cx, JS_NewPlainObject(cx));
  static const JSFunctionSpec methods[] = {
      JS_FN("setPrepareStackTraceCallback", SetPrepare, 1, 0),
      JS_FN("setEnhanceStackForFatalException", SetEnhance, 2, 0), JS_FS_END};
  if (!binding || !JS_DefineFunctions(cx, binding, methods)) return nullptr;
  JS::SetReservedSlot(state, Binding, JS::ObjectValue(*binding)); return binding;
}
bool EnhanceFatalExceptionStack(JSContext* cx, JS::HandleValue error,
                               bool afterInspector, JS::MutableHandleValue out) {
  JS::RootedObject state(cx, State(cx));
  if (!state) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Node error stack state has not been initialized");
    return false;
  }
  JS::RootedValue callback(cx, JS::GetReservedSlot(state, afterInspector ? AfterFatal : BeforeFatal));
  if (!callback.isObject()) return Missing(cx, "Fatal exception stack enhancer has not been registered");
  return JS::Call(cx, JS::UndefinedHandleValue, callback, JS::HandleValueArray(error), out);
}

}  // namespace kandelo::node
