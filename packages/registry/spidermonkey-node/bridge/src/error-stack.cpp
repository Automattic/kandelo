#include "kandelo-node/error-stack.h"

#include "mozilla/Assertions.h"
#include "mozilla/Maybe.h"
#include "mozilla/ScopeExit.h"

#include <cmath>
#include <cstdint>
#include <cstring>

#include "jsapi.h"
#include "jsfriendapi.h"

#include "js/Array.h"
#include "js/CallAndConstruct.h"
#include "js/CallArgs.h"
#include "js/CharacterEncoding.h"
#include "js/ColumnNumber.h"
#include "js/Conversions.h"
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
#include "util/StringBuilder.h"
#include "vm/Shape.h"
#include "vm/NativeObject.h"
#include "vm/JSFunction.h"
#include "js/GlobalObject.h"
#include "vm/FrameIter.h"
#include "vm/JSScript.h"
#include "vm/SavedFrame.h"
#include "kandelo-node/native-source-location.h"
#include "vm/Realm.h"

namespace kandelo::node {
namespace {

enum StateSlot { Cache, OriginalError, OriginalToString, SitePrototype,
                 PrepareCallback, BeforeFatal, AfterFatal, Binding, StateSlots };
enum CaptureSlot { SavedStack, CaptureLimit, Cached, PreparedValue, SourceFiles, CallRecords, CaptureSlots };
const JSClass kState = {"NodeErrorStackState", JSCLASS_HAS_RESERVED_SLOTS(StateSlots)};
const JSClass kCapture = {"NodeErrorStackCapture", JSCLASS_HAS_RESERVED_SLOTS(CaptureSlots)};
enum SiteSlot { SiteFrame, SiteOriginalFilename, SiteReceiver, SiteCallee,
                SiteConstructing, SiteSlots };
const JSClass kSite = {"CallSite", JSCLASS_HAS_RESERVED_SLOTS(SiteSlots)};
constexpr auto kVisible = JS::SavedFrameSelfHosted::Exclude;

JSObject* State(JSContext* cx) {
  auto owner=v8::ReadNativeEngineState(cx);auto* global=JS::CurrentGlobalOrNull(cx);
  if(!owner||!global)return nullptr;
  auto* fields=v8::ExistingContextEmbedderStorage(*owner,global);
  if(!fields)return nullptr;
  const auto state=JS::GetReservedSlot(fields,3);
  return state.isObject()?&state.toObject():nullptr;
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
      !JS::GetReservedSlot(&receiver.toObject(), SiteFrame).isObject()) {
    Throw(cx, JSEXN_TYPEERR, nullptr, "CallSite method requires a captured CallSite");
    return nullptr;
  }
  return &JS::GetReservedSlot(&receiver.toObject(), SiteFrame).toObject();
}
bool Position(JSContext* cx, JS::HandleObject frame, uint32_t* line, uint32_t* column) {
  JS::TaggedColumnNumberOneOrigin value;
  auto* principals = JS::GetRealmPrincipals(JS::GetCurrentRealmOrNull(cx));
  if (JS::GetSavedFrameLine(cx, principals, frame, line, kVisible) != JS::SavedFrameResult::Ok ||
      JS::GetSavedFrameColumn(cx, principals, frame, &value, kVisible) != JS::SavedFrameResult::Ok) {
    JS_ReportErrorASCII(cx, "Captured frame is not visible in this realm"); return false;
  }
  if (!value.isLimitedColumnNumber()) return Missing(cx, "Wasm CallSite metadata is not implemented");
  *column = value.oneOriginValue();
  auto* raw=js::CheckedUnwrapDynamic(frame,cx,false);
  if(raw&&raw->is<js::SavedFrame>())NativeFunctionBodyLocation(NativeFrameSourceRecord(raw->as<js::SavedFrame>()),line,column);
  return true;
}
bool IsAwaitedFrame(JSContext* cx, JS::HandleObject frame, bool* result) {
  auto* principals = JS::GetRealmPrincipals(JS::GetCurrentRealmOrNull(cx));
  JS::RootedString cause(cx);
  if (JS::GetSavedFrameAsyncCause(cx, principals, frame, &cause, kVisible) != JS::SavedFrameResult::Ok) {
    JS_ReportErrorASCII(cx, "Captured frame is not visible in this realm");
    return false;
  }
  *result = false;
  return !cause || JS_StringEqualsLiteral(cx, cause, "await", result);
}
bool SiteIsAsync(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject frame(cx, Frame(cx, args.thisv()));
  bool awaited;
  if (!frame || !IsAwaitedFrame(cx, frame, &awaited)) return false;
  args.rval().setBoolean(awaited);
  return true;
}
bool MatchesCall(js::NativeObject& object, js::PropertyInfo property,
                 JSObject* callee) {
  if (property.isDataProperty()) {
    const JS::Value value = object.getSlot(property.slot());
    return value.isObject() && &value.toObject() == callee;
  }
  return property.isAccessorProperty() &&
         (object.getGetter(property) == callee ||
          object.getSetter(property) == callee);
}

// Only inspect native slots. Looking up an alias must never invoke a getter,
// a resolve hook, a property interceptor, or a proxy trap.
bool MethodName(JSContext* cx, JS::HandleObject receiver,
                JS::HandleObject identity, JS::HandleObject callee,
                JS::MutableHandleString result) {
  result.set(nullptr);
  if (!callee || !callee->is<JSFunction>()) return true;
  JS::RootedFunction fun(cx, &callee->as<JSFunction>());
  JS::RootedString name(cx);
  {
    JSAutoRealm functionRealm(cx, fun);
    if (!JS_GetFunctionId(cx, fun, &name)) return false;
    if (name && name->length()) {
      if ((fun->isGetter() || fun->isSetter()) && name->length() >= 4) {
        JS::RootedString prefix(cx, JS_NewDependentString(cx, name, 0, 4));
        bool getter, setter;
        if (!prefix || !JS_StringEqualsLiteral(cx, prefix, "get ", &getter) ||
            !JS_StringEqualsLiteral(cx, prefix, "set ", &setter)) return false;
        if (getter || setter) {
          name = JS_NewDependentString(cx, name, 4, name->length() - 4);
          if (!name) return false;
        }
      }
    } else {
      if (!JS_GetFunctionDisplayId(cx, fun, &name)) return false;
      for (size_t end = name ? name->length() : 0; end; --end) {
        char16_t ch;
        if (!JS_GetStringCharAt(cx, name, end - 1, &ch)) return false;
        if (ch == '.') {
          name = JS_NewDependentString(cx, name, end, name->length() - end);
          if (!name) return false;
          break;
        }
      }
    }
  }
  if (name && name->length()) {
    JS::RootedValue wrapped(cx, JS::StringValue(name));
    if (!JS_WrapValue(cx, &wrapped)) return false;
    name = wrapped.toString();
    JS::RootedId key(cx);
    if (!JS_StringToId(cx, name, &key)) return false;
    for (JSObject* obj = receiver; obj && obj->is<js::NativeObject>();
         obj = obj->staticPrototype()) {
      auto& native = obj->as<js::NativeObject>();
      if (auto property = native.lookupPure(key)) {
        if (MatchesCall(native, *property, identity)) {
          result.set(name);
          return true;
        }
        break;
      }
    }
  }

  JS::PropertyKey found = JS::PropertyKey::Void();
  JS::AutoCheckCannotGC nogc;
  for (JSObject* obj = receiver; obj && obj->is<js::NativeObject>();
       obj = obj->staticPrototype()) {
    auto& native = obj->as<js::NativeObject>();
    for (js::ShapePropertyIter<js::NoGC> it(native.shape()); !it.done(); it++) {
      auto property = *it;
      auto key = property.key();
      if (!property.enumerable() || !key.isString() ||
          !MatchesCall(native, property, identity))
        continue;
      if (!found.isVoid() && found != key) return true;
      found = key;
    }
  }
  if (found.isString()) result.set(found.toString());
  return true;
}

struct CallNames {
  explicit CallNames(JSContext* cx) : type(cx), method(cx) {}
  JS::RootedString type;
  JS::RootedString method;
  bool constructing = false;
};

bool ReadCallNames(JSContext* cx, JS::HandleObject site, CallNames& names,
                   bool needType, bool needMethod) {
  JS::RootedValue receiver(cx, JS::GetReservedSlot(site, SiteReceiver));
  JS::RootedObject callee(cx, JS::GetReservedSlot(site, SiteCallee).toObjectOrNull());
  names.constructing = JS::GetReservedSlot(site, SiteConstructing).toBoolean();
  if (!callee || receiver.isNullOrUndefined()) return true;
  JS::RootedObject object(cx, JS::ToObject(cx, receiver));
  if (!object) return false;
  if (js::IsWrapper(object)) {
    object = js::CheckedUnwrapDynamic(object, cx);
    if (!object) return !JS_IsExceptionPending(cx);
  }
  if (js::IsWrapper(callee)) {
    callee = js::CheckedUnwrapDynamic(callee, cx);
    if (!callee) return !JS_IsExceptionPending(cx);
  }
  {
    JSAutoRealm realm(cx, object);
    if (needType && !names.constructing && !JS_IsGlobalObject(object) &&
        !js::IsWindowProxy(object)) {
      if (js::IsProxy(object)) {
        names.type = JS_NewStringCopyZ(cx, "Proxy");
      } else {
        if (object->is<JSFunction>()) {
          JS::RootedFunction fun(cx, &object->as<JSFunction>());
          if (!JS_GetFunctionDisplayId(cx, fun, &names.type)) return false;
        }
        if (!names.type || !names.type->length())
          names.type =
              v8::constructor_names::GetNativeConstructorName(cx, object);
      }
      if (!names.type) return false;
    }
    if (needMethod && !js::IsProxy(object)) {
      // Property slots in the receiver's realm can hold a wrapper for the
      // original function. Compare that identity when walking its properties.
      JS::RootedObject localCallee(cx, callee);
      if (!JS_WrapObject(cx, &localCallee)) return false;
      if (!MethodName(cx, object, localCallee, callee, &names.method))
        return false;
    }
  }
  for (auto* name : {&names.type, &names.method}) {
    if (name->get()) {
      JS::RootedValue wrapped(cx, JS::StringValue(name->get()));
      if (!JS_WrapValue(cx, &wrapped)) return false;
      name->set(wrapped.toString());
    }
  }
  return true;
}

bool EndsWithMethod(JSContext* cx, JS::HandleString name,
                    JS::HandleString method, bool* matches) {
  *matches = false;
  if (method->length() > name->length()) return true;
  size_t start = name->length() - method->length();
  if (start) {
    char16_t before;
    if (!JS_GetStringCharAt(cx, name, start - 1, &before)) return false;
    if (before != '.' && before != ' ') return true;
  }
  JS::RootedString suffix(
      cx, JS_NewDependentString(cx, name, start, method->length()));
  return suffix && js::EqualStrings(cx, suffix, method, matches);
}

bool AppendCallName(JSContext* cx, js::JSStringBuilder& text,
                    JS::HandleString name, CallNames& names) {
  if (names.constructing && !text.append("new ")) return false;
  if (!name || !name->length()) {
    if (names.type && (!text.append(names.type) || !text.append('.')))
      return false;
    return names.method ? text.append(names.method)
                        : text.append("<anonymous>");
  }
  if (names.type) {
    bool identifier, same;
    if (!JS_IsIdentifier(cx, name, &identifier) ||
        !js::EqualStrings(cx, name, names.type, &same))
      return false;
    if (identifier && !same && (!text.append(names.type) || !text.append('.')))
      return false;
  }
  if (!text.append(name)) return false;
  if (names.type && names.method) {
    bool matches;
    if (!EndsWithMethod(cx, name, names.method, &matches)) return false;
    if (!matches && (!text.append(" [as ") || !text.append(names.method) ||
                     !text.append(']')))
      return false;
  }
  return true;
}

bool SiteCallName(JSContext* cx, const JS::CallArgs& args, bool type) {
  JS::RootedObject frame(cx, Frame(cx, args.thisv()));
  CallNames names(cx);
  if (!frame) return false;
  JS::RootedObject site(cx, &args.thisv().toObject());
  if (!ReadCallNames(cx, site, names, type, !type)) return false;
  JSString* value = type ? names.type.get() : names.method.get();
  if (value)
    args.rval().setString(value);
  else
    args.rval().setNull();
  return true;
}
bool SiteTypeName(JSContext* cx, unsigned argc, JS::Value* vp) {
  return SiteCallName(cx, JS::CallArgsFromVp(argc, vp), true);
}
bool SiteMethodName(JSContext* cx, unsigned argc, JS::Value* vp) {
  return SiteCallName(cx, JS::CallArgsFromVp(argc, vp), false);
}

JSString* FormatSite(JSContext* cx, JS::HandleObject frame, JS::HandleObject site) {
  auto* principals = JS::GetRealmPrincipals(JS::GetCurrentRealmOrNull(cx));
  JS::RootedString name(cx), file(cx);
  uint32_t line, column;
  if (!Position(cx, frame, &line, &column)) return nullptr;
  if (JS::GetSavedFrameSource(cx, principals, frame, &file, kVisible) != JS::SavedFrameResult::Ok ||
      JS::GetSavedFrameFunctionDisplayName(cx, principals, frame, &name, kVisible) != JS::SavedFrameResult::Ok) {
    JS_ReportErrorASCII(cx, "Captured frame is not visible in this realm"); return nullptr;
  }
  js::JSStringBuilder text(cx);
  bool awaited;
  if (!IsAwaitedFrame(cx, frame, &awaited)) return nullptr;
  CallNames names(cx);
  if (!ReadCallNames(cx, site, names, true, true)) return nullptr;
  bool named = (name && name->length()) || names.type || names.constructing;
  if ((awaited && !text.append("async ")) ||
      (named && (!AppendCallName(cx, text, name, names) || !text.append(" ("))) ||
      !text.append(file) || !text.append(':') ||
      !js::NumberValueToStringBuilder(JS::NumberValue(line), text) ||
      !text.append(':') || !js::NumberValueToStringBuilder(JS::NumberValue(column), text) ||
      (named && !text.append(')'))) return nullptr;
  return text.finishString();
}
bool SiteText(JSContext* cx, unsigned argc, JS::Value* vp) {
  auto args = JS::CallArgsFromVp(argc, vp);
  JS::RootedObject frame(cx, Frame(cx, args.thisv()));
  if (!frame) return false;
  JS::RootedObject site(cx, &args.thisv().toObject());
  JS::RootedString text(cx, FormatSite(cx, frame, site));
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
    JS::Value value = JS::GetReservedSlot(&args.thisv().toObject(), SiteOriginalFilename);
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
  JS::RootedObject records(cx, JS::GetReservedSlot(capture, CallRecords).toObjectOrNull());
  uint32_t count = 0;
  int32_t limit = JS::GetReservedSlot(capture, CaptureLimit).toInt32();
  auto* principals = JS::GetRealmPrincipals(JS::GetCurrentRealmOrNull(cx));
  while (frame && count < uint32_t(limit)) {
    JS::RootedObject site(cx, JS_NewObjectWithGivenProto(cx, &kSite, prototype));
    if (!site) return nullptr;
    JS::SetReservedSlot(site, SiteFrame, JS::ObjectValue(*frame));
    JS::RootedValue receiver(cx);
    JS::RootedObject callee(cx);
    bool constructing;
    if (!JS::GetSavedFrameCall(cx, principals, frame, records, &receiver, &callee,
                               &constructing, kVisible)) return nullptr;
    JS::SetReservedSlot(site, SiteReceiver, receiver);
    JS::SetReservedSlot(site, SiteCallee, JS::ObjectOrNullValue(callee));
    JS::SetReservedSlot(site, SiteConstructing, JS::BooleanValue(constructing));
    uint32_t sourceId;
    if (JS::GetSavedFrameSourceId(cx, principals, frame, &sourceId, kVisible) != JS::SavedFrameResult::Ok) {
      JS_ReportErrorASCII(cx, "Captured frame is not visible in this realm"); return nullptr;
    }
    JS::RootedValue filename(cx);
    if (!JS_GetElement(cx, files, sourceId, &filename)) return nullptr;
    if (filename.isUndefined()) {
      // A suspended caller's script need not be on the live stack. Its
      // SavedFrame retains the source captured at the suspension point.
      auto* raw = js::CheckedUnwrapDynamic(frame, cx, false);
      auto* source = raw && raw->is<js::SavedFrame>() ? NativeFrameSource(raw->as<js::SavedFrame>()) : nullptr;
      if (source) {
        const char* original = source->filename();
        if (original) {
          JS::RootedString text(cx, JS_NewStringCopyUTF8Z(cx, JS::ConstUTF8CharsZ(original, std::strlen(original))));
          if (!text) return nullptr;
          filename.setString(text);
        } else {
          filename.setNull();
        }
      }
    }
    JS::SetReservedSlot(site, SiteOriginalFilename, filename);
    if (!JS_SetElement(cx, array, count++, site)) return nullptr;
    JS::RootedObject parent(cx);
    if (JS::GetSavedFrameParent(cx, principals, frame, &parent, kVisible) != JS::SavedFrameResult::Ok) {
      JS_ReportErrorASCII(cx, "Captured frame is not visible in this realm"); return nullptr;
    }
    if (!parent) {
      JS::RootedObject asyncParent(cx);
      if (JS::GetSavedFrameAsyncParent(cx, principals, frame, &asyncParent, kVisible) != JS::SavedFrameResult::Ok)
        return nullptr;
      if (asyncParent) {
        if (!JS_WrapObject(cx, &asyncParent)) return nullptr;
        bool awaited;
        if (!IsAwaitedFrame(cx, asyncParent, &awaited)) return nullptr;
        if (awaited) parent = asyncParent;
      }
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
    JS::RootedObject entry(cx, &site.toObject());
    JS::RootedString formatted(cx, FormatSite(cx, frame, entry));
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
      JS::SetReservedSlot(capture, CallRecords, JS::NullValue());
      JS::SetReservedSlot(capture, Cached, JS::BooleanValue(true)); return true;
    }
    if (JS::GetReservedSlot(capture, Cached).toBoolean()) {
      result = JS::GetReservedSlot(capture, PreparedValue);
    } else {
      JS::RootedObject trace(cx, Trace(cx, state, capture));
      if (!trace) return false;
      auto owner=v8::ReadNativeEngineState(cx);MOZ_RELEASE_ASSERT(owner);
      bool& preparing=owner->nativeStackPreparing;
      if (preparing) {
        if (!DefaultPrepare(cx, state, key, trace, &result)) return false;
      } else {
        preparing = true;
        auto clear = mozilla::MakeScopeExit([&] { preparing = false; });
        bool handled=false;
        if(!v8::bridge::PrepareNativeStack(cx,key,trace,&handled,&result))return false;
        if(!handled){
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
      }
      JS::SetReservedSlot(capture, PreparedValue, result);
      JS::SetReservedSlot(capture, CallRecords, JS::NullValue());
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
  JS::RootedObject records(cx, JS::TakeErrorStackCallRecords(cx, stack));
  JS::SetReservedSlot(capture, CallRecords, JS::ObjectOrNullValue(records));
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

bool ReadUnformattedErrorStack(JSContext* cx, JS::HandleValue value,
                               JS::MutableHandleObject stack) {
  stack.set(nullptr);
  JS::RootedObject target(cx, Target(cx, value));
  if (!target) return !JS_IsExceptionPending(cx);
  {
    JSAutoRealm realm(cx, target);
    JS::RootedObject state(cx, State(cx));
    if (!state) return !JS_IsExceptionPending(cx);
    JS::RootedObject map(cx, &JS::GetReservedSlot(state, Cache).toObject());
    JS::RootedValue key(cx, JS::ObjectValue(*target)), stored(cx);
    if (!JS::GetWeakMapEntry(cx, map, key, &stored)) return false;
    if (stored.isObject()) {
      JS::RootedObject capture(cx, &stored.toObject());
      if (!JS::GetReservedSlot(capture, Cached).toBoolean())
        stack.set(JS::GetReservedSlot(capture, SavedStack).toObjectOrNull());
    }
  }
  return !stack || JS_WrapObject(cx, stack);
}

JSObject* CreateErrorStackState(JSContext* cx) {
  JS::RootedObject state(cx, JS_NewObject(cx, &kState));
  JS::RootedObject map(cx, JS::NewWeakMapObject(cx)), error(cx);
  if (!state || !map || !JS_GetClassObject(cx, JSProto_Error, &error)) return nullptr;
  JS::SetReservedSlot(state, Cache, JS::ObjectValue(*map));
  JS::SetReservedSlot(state, OriginalError, JS::ObjectValue(*error));
  JS::RootedValue prototype(cx), stringify(cx);
  if (!JS_GetProperty(cx, error, "prototype", &prototype)) return nullptr;
  JS::RootedObject errorPrototype(cx, &prototype.toObject());
  // Node exposes the lazy stack on each captured error. Leaving the engine's
  // prototype accessor lets serialization retain a raw stack when formatting
  // the error's own stack throws.
  JS::ObjectOpResult removedStack;
  if (!JS_DeleteProperty(cx, errorPrototype, "stack", removedStack) ||
      !removedStack.ok()) return nullptr;
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
      JS_FN("getTypeName", SiteTypeName, 0, 0), JS_FN("getMethodName", SiteMethodName, 0, 0),
      JS_FN("getEvalOrigin", MissingSite, 0, 0), JS_FN("isToplevel", MissingSite, 0, 0),
      JS_FN("isEval", MissingSite, 0, 0), JS_FN("isNative", MissingSite, 0, 0),
      JS_FN("isConstructor", MissingSite, 0, 0), JS_FN("isAsync", SiteIsAsync, 0, 0),
      JS_FN("isPromiseAll", MissingSite, 0, 0), JS_FN("getPromiseIndex", MissingSite, 0, 0),
      JS_FS_END};
  if (!JS_DefineFunctions(cx, sitePrototype, methods)) return nullptr;
  JS::SetReservedSlot(state, SitePrototype, JS::ObjectValue(*sitePrototype));
  JS::SetEmbeddingErrorStackHooks(JS_GetRuntime(cx), LimitHook, CreatedHook);
  return state;
}

}  // namespace kandelo::node
