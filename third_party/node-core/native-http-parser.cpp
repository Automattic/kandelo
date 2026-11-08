/* Opaque GC-owned HTTP framing state. Input/events never retain JS pointers. */
#include "kandelo-node-http-parser.h"
#include "mozilla/ScopeExit.h"
#include "js/Conversions.h"
#include "js/TracingAPI.h"
#include <cmath>
#include <cstring>
#include <memory>
#include <iterator>
namespace {
struct KandeloHttpOwner {
  kandelo::http::ResponseParser parser;
  size_t accounted = 0;
  bool executing = false;
  const bool request;
  JS::Heap<JSObject*> identity;
  KandeloHttpOwner(std::string method, uint64_t limit, bool insecure, bool relaxed, bool request)
      : parser(std::move(method), limit, insecure, relaxed, request), request(request) {}
  size_t Bytes() const { return sizeof(*this) - sizeof(parser) + parser.AllocationBytes(); }
};
static void KandeloHttpAccount(JSObject* object, KandeloHttpOwner* owner) {
  const size_t bytes = owner->Bytes();
  if (bytes > owner->accounted)
    JS::AddAssociatedMemory(object, bytes - owner->accounted, JS::MemoryUse::Embedding3);
  else if (bytes < owner->accounted)
    JS::RemoveAssociatedMemory(object, owner->accounted - bytes, JS::MemoryUse::Embedding3);
  owner->accounted = bytes;
}
static void KandeloHttpFinalize(JS::GCContext*, JSObject* object) {
  const auto value = JS::GetReservedSlot(object, 0);
  if (value.isUndefined()) return;
  auto* owner = static_cast<KandeloHttpOwner*>(value.toPrivate());
  JS::RemoveAssociatedMemory(object, owner->accounted, JS::MemoryUse::Embedding3);
  delete owner;
}
static void KandeloHttpTrace(JSTracer* tracer, JSObject* object) {
  const auto value = JS::GetReservedSlot(object, 0);
  if (!value.isUndefined()) {
    auto* owner = static_cast<KandeloHttpOwner*>(value.toPrivate());
    // A self-edge only updates the identity of an already traced live parser.
    // ConnectionsList never traces this edge or keeps dead parsers alive.
    JS::TraceEdge(tracer, &owner->identity, "HTTP parser identity");
  }
}
static const JSClassOps KandeloHttpOps = { nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
    KandeloHttpFinalize, nullptr, nullptr, KandeloHttpTrace };
static const JSClass KandeloHttpClass = { "KandeloHttpParser",
    JSCLASS_HAS_RESERVED_SLOTS(2) | JSCLASS_FOREGROUND_FINALIZE, &KandeloHttpOps };
struct KandeloHttpConnectionsOwner {
  std::shared_ptr<kandelo::http::ConnectionsList> list = std::make_shared<kandelo::http::ConnectionsList>();
  static constexpr size_t Accounted = sizeof(std::shared_ptr<kandelo::http::ConnectionsList>) +
      sizeof(kandelo::http::ConnectionsList);
};
static void KandeloHttpConnectionsFinalize(JS::GCContext*, JSObject* object) {
  const auto value = JS::GetReservedSlot(object, 0);
  if (value.isUndefined()) return;
  JS::RemoveAssociatedMemory(object, KandeloHttpConnectionsOwner::Accounted, JS::MemoryUse::Embedding3);
  delete static_cast<KandeloHttpConnectionsOwner*>(value.toPrivate());
}
static const JSClassOps KandeloHttpConnectionsOps = { nullptr, nullptr, nullptr, nullptr, nullptr, nullptr,
    KandeloHttpConnectionsFinalize, nullptr, nullptr, nullptr };
static const JSClass KandeloHttpConnectionsClass = { "ConnectionsList",
    JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloHttpConnectionsOps };
static KandeloHttpConnectionsOwner* KandeloHttpConnections(HandleObject object) {
  if (!object || JS::GetClass(object) != &KandeloHttpConnectionsClass) return nullptr;
  const auto value = JS::GetReservedSlot(object, 0);
  return value.isUndefined() ? nullptr : static_cast<KandeloHttpConnectionsOwner*>(value.toPrivate());
}
static bool KandeloHttpConnectionsQuery(JSContext* cx, const CallArgs& args, const char* operation) {
  RootedObject object(cx, args.get(1).isObject() ? js::CheckedUnwrapDynamic(&args[1].toObject(), cx) : nullptr);
  if (args.get(1).isObject() && !object) {
    if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);
    return false;
  }
  auto* owner = KandeloHttpConnections(object);
  if (!owner) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Connection query requires its actual native list");
    return false;
  }
  uint32_t headers = 0, request = 0;
  const bool expired = strcmp(operation, "connectionsExpired") == 0;
  if (expired && (!args.get(2).isNumber() || !args.get(3).isNumber() ||
      !JS::ToUint32(cx, args.get(2), &headers) || !JS::ToUint32(cx, args.get(3), &request))) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Connection expiry requires numeric timeouts");
    return false;
  }
  // Root actual parser identities using only native allocations before any
  // JS result allocation/wrapping can collect/finalize a list member. This is
  // a temporary query snapshot, not permanent list -> parser GC ownership.
  std::vector<std::unique_ptr<JS::PersistentRootedObject>> snapshot;
  {
    JS::AutoCheckCannotGC noGC;
    const auto records = expired ? owner->list->Expired(headers, request) :
        strcmp(operation, "connectionsIdle") == 0 ? owner->list->Idle() :
        strcmp(operation, "connectionsActive") == 0 ? owner->list->Active() : owner->list->All();
    snapshot.reserve(records.size());
    for (auto* record : records) {
      auto* parser = static_cast<KandeloHttpOwner*>(record->Owner());
      MOZ_RELEASE_ASSERT(parser && parser->identity);
      snapshot.push_back(std::make_unique<JS::PersistentRootedObject>(cx, parser->identity.get()));
    }
  }
  RootedObject result(cx, JS::NewArrayObject(cx, snapshot.size()));
  if (!result) return false;
  for (size_t i = 0; i < snapshot.size(); ++i) {
    RootedValue parser(cx, ObjectValue(*snapshot[i]->get()));
    if (!JS_WrapValue(cx, &parser) || !JS_DefineElement(cx, result, uint32_t(i), parser, JSPROP_ENUMERATE)) return false;
  }
  args.rval().setObject(*result); return true;
}
static bool KandeloHttpText(JSContext* cx, HandleObject object, const char* name, const std::string& text) {
  // HTTP field/status bytes are Latin1, not UTF8 paths.
  RootedString string(cx, JS_NewStringCopyN(cx, text.data(), text.size()));
  return string && JS_DefineProperty(cx, object, name, string, JSPROP_ENUMERATE);
}
static bool KandeloHttpHeaders(JSContext* cx, HandleObject object, const std::vector<std::string>& values) {
  RootedObject array(cx, JS::NewArrayObject(cx, 0)); if (!array) return false;
  for (size_t i = 0; i < values.size(); ++i) {
    RootedString string(cx, JS_NewStringCopyN(cx, values[i].data(), values[i].size()));
    RootedValue value(cx); if (!string) return false; value.setString(string);
    if (!JS_DefineElement(cx, array, uint32_t(i), value, JSPROP_ENUMERATE)) return false;
  }
  return JS_DefineProperty(cx, object, "headers", array, JSPROP_ENUMERATE);
}
static bool KandeloHttpEvent(JSContext* cx, const kandelo::http::Event& event, MutableHandleValue result) {
    RootedObject item(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
    if (!item || !JS_DefineProperty(cx, item, "type", int(event.type), JSPROP_ENUMERATE)) return false;
    if (event.type == kandelo::http::Event::Type::Body) {
      RootedObject bytes(cx, KandeloNewUint8ArrayCopy(cx, event.body.data(), event.body.size()));
      if (!bytes || !JS_DefineProperty(cx, item, "body", bytes, JSPROP_ENUMERATE)) return false;
    } else {
      if (!KandeloHttpHeaders(cx, item, event.headers) ||
          !JS_DefineProperty(cx, item, "informational", event.informational, JSPROP_ENUMERATE) ||
          !JS_DefineProperty(cx, item, "upgrade", event.upgrade, JSPROP_ENUMERATE)) return false;
      if (event.type == kandelo::http::Event::Type::Headers &&
          (!KandeloHttpText(cx, item, "statusMessage", event.statusMessage) ||
           !KandeloHttpText(cx, item, "url", event.url) ||
           !JS_DefineProperty(cx, item, "request", event.request, JSPROP_ENUMERATE) ||
           !JS_DefineProperty(cx, item, "method", int(event.method), JSPROP_ENUMERATE) ||
           !JS_DefineProperty(cx, item, "status", int(event.status), JSPROP_ENUMERATE) ||
           !JS_DefineProperty(cx, item, "major", int(event.major), JSPROP_ENUMERATE) ||
           !JS_DefineProperty(cx, item, "minor", int(event.minor), JSPROP_ENUMERATE) ||
           !JS_DefineProperty(cx, item, "keepAlive", event.keepAlive, JSPROP_ENUMERATE))) return false;
    }
  result.setObject(*item);return true;
}
struct KandeloHttpHeadersCall {
  JSContext* cx;
  HandleValue callback, body, complete;
  bool failed = false;
  static int Invoke(void* opaque, const kandelo::http::Event& event) {
    auto& state = *static_cast<KandeloHttpHeadersCall*>(opaque);
    RootedValue argument(state.cx), result(state.cx);
    const auto type = event.type;
    HandleValue callback = type == kandelo::http::Event::Type::Headers ? state.callback :
        type == kandelo::http::Event::Type::Body ? state.body : state.complete;
    if (!KandeloHttpEvent(state.cx, event, &argument) ||
        !JS::Call(state.cx, UndefinedHandleValue, callback,
                  JS::HandleValueArray(argument), &result)) {
      state.failed = true;
      return type == kandelo::http::Event::Type::Body ? int(HPE_USER) : -1;
    }
    if (type != kandelo::http::Event::Type::Headers) return 0;
    double number;
    if (!JS::ToNumber(state.cx, result, &number)) { state.failed = true;return -1; }
    return kandelo::http::HeadersDecision(number);
  }
};
static bool KandeloHttpPacket(JSContext* cx, const kandelo::http::Step& step, MutableHandleValue result) {
  RootedObject object(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
  RootedObject events(cx, JS::NewArrayObject(cx, 0));
  if (!object || !events ||
      !JS_DefineProperty(cx, object, "consumed", double(step.consumed), JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "complete", step.complete, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "upgrade", step.upgrade, JSPROP_ENUMERATE) ||
      !KandeloHttpText(cx, object, "code", step.code) ||
      !KandeloHttpText(cx, object, "reason", step.reason)) return false;
  for (size_t i = 0; i < step.events.size(); ++i) {
    const auto& event = step.events[i];
    RootedValue value(cx);
    if (!KandeloHttpEvent(cx, event, &value)) return false;
    if (!JS_DefineElement(cx, events, uint32_t(i), value, JSPROP_ENUMERATE)) return false;
  }
  RootedObject remainder(cx, KandeloNewUint8ArrayCopy(cx, step.remainder.data(), step.remainder.size()));
  if (!remainder || !JS_DefineProperty(cx, object, "remainder", remainder, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, object, "events", events, JSPROP_ENUMERATE)) return false;
  result.setObject(*object); return true;
}
static bool KandeloNativeHttpParserImpl(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "HTTP parser requires an operation"); return false; }
  RootedString name(cx, args[0].toString());
  JS::UniqueChars operation = JS_EncodeStringToUTF8(cx, name); if (!operation) return false;
  if (strcmp(operation.get(), "methods") == 0 || strcmp(operation.get(), "allMethods") == 0) {
    const auto methods = kandelo::http::GetMethods(strcmp(operation.get(), "allMethods") == 0);
    RootedObject array(cx, JS::NewArrayObject(cx, methods.size())); if (!array) return false;
    for (size_t i = 0; i < methods.size(); ++i) {
      RootedString method(cx, JS_NewStringCopyZ(cx, methods[i])); RootedValue value(cx);
      if (!method) return false; value.setString(method);
      if (!JS_DefineElement(cx, array, uint32_t(i), value, JSPROP_ENUMERATE)) return false;
    }
    args.rval().setObject(*array); return true;
  }
  if (strcmp(operation.get(), "createConnections") == 0) {
    if (!args.get(1).isObject()) { JS_ReportErrorASCII(cx, "ConnectionsList requires a prototype"); return false; }
    RootedObject prototype(cx, js::CheckedUnwrapDynamic(&args[1].toObject(), cx));
    if (!prototype) {
      if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);
      return false;
    }
    {
      JSAutoRealm realm(cx, prototype);
      auto owner = std::make_unique<KandeloHttpConnectionsOwner>();
      RootedObject object(cx, JS_NewObjectWithGivenProto(cx, &KandeloHttpConnectionsClass, prototype));
      if (!object) return false;
      JS::AddAssociatedMemory(object, KandeloHttpConnectionsOwner::Accounted, JS::MemoryUse::Embedding3);
      JS::SetReservedSlot(object, 0, PrivateValue(owner.release()));
      args.rval().setObject(*object);
    }
    return JS_WrapValue(cx, args.rval());
  }
  if (strcmp(operation.get(), "connectionsAll") == 0 || strcmp(operation.get(), "connectionsIdle") == 0 ||
      strcmp(operation.get(), "connectionsActive") == 0 || strcmp(operation.get(), "connectionsExpired") == 0)
    return KandeloHttpConnectionsQuery(cx, args, operation.get());
  const bool request = strcmp(operation.get(), "createRequest") == 0;
  if (request || strcmp(operation.get(), "create") == 0) {
    if (!args.get(1).isString() || !args.get(2).isNumber() || !args.get(3).isBoolean() || !args.get(4).isBoolean() ||
        !std::isfinite(args[2].toNumber()) || args[2].toNumber() < 0 ||
        args[2].toNumber() > 9007199254740991.0 || std::floor(args[2].toNumber()) != args[2].toNumber()) {
      JS_ReportErrorASCII(cx, "HTTP parser requires checked method/limit/options"); return false;
    }
    RootedString method(cx, args[1].toString());
    JS::UniqueChars text = JS_EncodeStringToUTF8(cx, method); if (!text) return false;
    RootedObject connections(cx);
    std::shared_ptr<kandelo::http::ConnectionsList> list;
    RootedValue retainedList(cx);
    if (request) retainedList.set(args.get(5));
    if (request && !retainedList.isUndefined()) {
      connections = retainedList.isObject() ? js::CheckedUnwrapDynamic(&retainedList.toObject(), cx) : nullptr;
      if (retainedList.isObject() && !connections) {
        if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);
        return false;
      }
      auto* owner = KandeloHttpConnections(connections);
      if (!owner) {
        if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Request parser requires its real connection list");
        return false;
      }
      list = owner->list;
      if (!JS_WrapValue(cx, &retainedList)) return false;
    }
    auto owner = std::make_unique<KandeloHttpOwner>(text.get(), uint64_t(args[2].toNumber()), args[3].toBoolean(), args[4].toBoolean(), request);
    RootedObject object(cx, JS_NewObjectWithGivenProto(cx, &KandeloHttpClass, nullptr));
    if (!object) return false;
    owner->identity = object;
    auto* admitted = owner.release();
    JS::SetReservedSlot(object, 0, PrivateValue(admitted));
    JS::SetReservedSlot(object, 1, retainedList);
    KandeloHttpAccount(object, admitted);
    if (list) admitted->parser.AttachConnections(std::move(list), admitted);
    args.rval().setObject(*object); return true;
  }
  RootedObject object(cx, args.get(1).isObject() ? js::CheckedUnwrapDynamic(&args[1].toObject(), cx) : nullptr);
  if (!object || JS::GetClass(object) != &KandeloHttpClass || JS::GetReservedSlot(object, 0).isUndefined()) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "HTTP parser requires its actual native owner");
    return false;
  }
  auto* owner = static_cast<KandeloHttpOwner*>(JS::GetReservedSlot(object, 0).toPrivate());
  if (strcmp(operation.get(), "remove") == 0) {
    owner->parser.RemoveConnections();
    JS::SetReservedSlot(object, 1, UndefinedValue());
    args.rval().setUndefined(); return true;
  }
  // Callback/OOM failure can leave additional native capacity allocated.
  auto account = mozilla::MakeScopeExit([&] { KandeloHttpAccount(object, owner); });
  const bool fullCallbacks = strcmp(operation.get(), "feedRequest") == 0 ||
      strcmp(operation.get(), "finishRequest") == 0;
  const bool synchronous = fullCallbacks || strcmp(operation.get(), "feedRequestHeaders") == 0;
  if (owner->executing) { JS_ReportErrorASCII(cx, "HTTP parser is already executing");return false; }
  owner->executing = true;
  auto endExecution = mozilla::MakeScopeExit([&] { owner->executing = false; });
  kandelo::http::Step step;
  if (synchronous) {
    if (!owner->request) { JS_ReportErrorASCII(cx, "Synchronous request headers require a request parser");return false; }
    RootedValue callback(cx, args.get(3)), body(cx, args.get(4)), complete(cx, args.get(5));
    if (fullCallbacks && (!body.isObject() || !JS::IsCallable(&body.toObject()) ||
        !complete.isObject() || !JS::IsCallable(&complete.toObject()))) {
      JS_ReportErrorASCII(cx, "HTTP request parsing requires actual body and completion callbacks");return false;
    }
    if (!callback.isObject() || !JS::IsCallable(&callback.toObject())) {
      JS_ReportErrorASCII(cx, "HTTP request parsing requires its actual headers callback");return false;
    }
    KandeloHttpHeadersCall call{cx, callback, body, complete};
    const kandelo::http::HeadersHandler handlers{&call, KandeloHttpHeadersCall::Invoke,
        fullCallbacks ? KandeloHttpHeadersCall::Invoke : nullptr,
        fullCallbacks ? KandeloHttpHeadersCall::Invoke : nullptr};
    if (strcmp(operation.get(), "finishRequest") == 0) {
      step = owner->parser.Finish(handlers);
    } else {
      KandeloCryptoByteSource input(cx);
      if (!input.Init(args.get(2))) {
        if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "HTTP input requires a real buffer source");
        return false;
      }
      auto original = input.Capture();if (!original) return false;
      // The original allocation remains owned through all synchronous JS
      // callbacks. Shared consumption still needs an actual atomic owner.
      if (original->Shared()) {
        JS_ReportErrorASCII(cx, "Synchronous HTTP shared input requires atomic parser consumption");return false;
      }
      step = owner->parser.Feed(original->Data(), original->Length(), handlers);
    }
    // Original JS/coercion failure wins over llhttp's unwind status. It is not
    // converted to a parser error packet that would manufacture a 400 response.
    if (call.failed || JS_IsExceptionPending(cx)) return false;
  } else if (strcmp(operation.get(), "feed") == 0) {
    kandelo::crypto::Bytes input;
    if (!args.get(2).isObject()) { JS_ReportErrorASCII(cx, "HTTP input requires buffer bytes"); return false; }
    if (!KandeloCryptoInput(cx, args.get(2), &input)) return false;
    step = owner->parser.Feed(input.value.data(), input.value.size());
  } else if (strcmp(operation.get(), "finish") == 0) step = owner->parser.Finish();
  else { JS_ReportErrorASCII(cx, "Unknown HTTP parser operation"); return false; }
  KandeloHttpAccount(object, owner);
  return KandeloHttpPacket(cx, step, args.rval());
}
static bool KandeloNativeHttpParser(JSContext* cx, unsigned argc, Value* vp) {
  try { return KandeloNativeHttpParserImpl(cx, argc, vp); }
  catch (const std::bad_alloc&) {
    // Callback unwind may allocate native parser error text. Its original JS
    // exception still owns failure even if that subsequent allocation fails.
    if (!JS_IsExceptionPending(cx)) JS_ReportOutOfMemory(cx);
    return false;
  }
  catch (const std::length_error&) {
    if (!JS_IsExceptionPending(cx)) JS_ReportOutOfMemory(cx);
    return false;
  }
  catch (...) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Unexpected native HTTP parser failure");
    return false;
  }
}
}  // namespace
