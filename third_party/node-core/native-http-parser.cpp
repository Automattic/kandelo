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
  bool executing = false, released = false;
  JSContext* const cx;
  js::shell::KandeloNativeAsyncState* lifetime = nullptr;
  double asyncId = -1, triggerId = -1;
  void DestroyAsync() {
    if (lifetime && asyncId >= 0) lifetime->Finalized(asyncId);
    asyncId = -1;
  }
  ~KandeloHttpOwner() {
    DestroyAsync();
    if (lifetime) lifetime->Release();
  }
  enum class Retirement { None, Free, Close };
  Retirement retirement = Retirement::None;
  const bool request;
  JS::Heap<JSObject*> identity;
  KandeloHttpOwner(JSContext* cx, std::string method, uint64_t limit, bool insecure, bool relaxed, bool request)
      : parser(std::move(method), limit, insecure, relaxed, request), cx(cx), request(request) {}
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
// Never destroy/reset the native parser from a synchronous llhttp callback.
// Its real active frame and original input allocation own that lifetime.
static void KandeloHttpRetire(JSObject* object, KandeloHttpOwner* owner) {
  MOZ_RELEASE_ASSERT(!owner->executing);
  if (owner->retirement == KandeloHttpOwner::Retirement::Close) {
    JS::SetReservedSlot(object, 0, UndefinedValue());
    JS::SetReservedSlot(object, 1, UndefinedValue());
    JS::SetReservedSlot(object, 2, UndefinedValue());
    JS::SetReservedSlot(object, 3, UndefinedValue());
    JS::RemoveAssociatedMemory(object, owner->accounted, JS::MemoryUse::Embedding3);
    delete owner;
    return;
  }
  if (owner->retirement == KandeloHttpOwner::Retirement::Free) {
    owner->parser.Release();
    owner->released = true;
    owner->retirement = KandeloHttpOwner::Retirement::None;
    JS::SetReservedSlot(object, 1, UndefinedValue());
    JS::SetReservedSlot(object, 2, UndefinedValue());
    JS::SetReservedSlot(object, 3, UndefinedValue());
  }
  KandeloHttpAccount(object, owner);
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
    JSCLASS_HAS_RESERVED_SLOTS(4) | JSCLASS_FOREGROUND_FINALIZE, &KandeloHttpOps };
// Slots 0/1 remain native storage/list; 2/3 own the current AsyncReset
// public resource and captured frame. Constructor storage has PROVIDER_NONE.
static bool KandeloHttpResourceInfo(JSContext* cx, HandleObject object,
                                   MutableHandleValue result) {
  const Value value = JS::GetReservedSlot(object, 0);
  if (value.isUndefined()) {
    JS_ReportErrorASCII(cx, "HTTP parser resource backing is closed"); return false;
  }
  auto* owner = static_cast<KandeloHttpOwner*>(value.toPrivate());
  if (owner->cx != cx) {
    JS_ReportErrorASCII(cx, "HTTP parser belongs to another native environment"); return false;
  }
  JS::RootedValueArray<5> entries(cx);
  entries[0].setNumber(owner->asyncId); entries[1].setNumber(owner->triggerId);
  entries[2].set(JS::GetReservedSlot(object, 3));
  const char* type = owner->asyncId < 0 ? "NONE" :
      owner->request ? "HTTPINCOMINGMESSAGE" : "HTTPCLIENTREQUEST";
  RootedString provider(cx, JS_NewStringCopyZ(cx, type));
  if (!provider) return false;
  entries[3].setString(provider);
  entries[4].set(JS::GetReservedSlot(object, 2));
  for (size_t i = 0; i < 5; ++i) if (!JS_WrapValue(cx, entries[i])) return false;
  RootedObject array(cx, JS::NewArrayObject(cx, entries));
  if (!array) return false;
  result.setObject(*array); return true;
}
static bool KandeloHttpResetAsync(JSContext* cx, HandleObject object,
                                 KandeloHttpOwner* owner, HandleValue resource) {
  RootedValue frame(cx), alias(cx, resource);
  double trigger;
  if (!alias.isObject() || !cx->kandeloAsyncProperty("frame", &frame) ||
      !cx->getKandeloDefaultTriggerAsyncId(&trigger) ||
      !JS_WrapValue(cx, &frame) || !JS_WrapValue(cx, &alias)) return false;
  if (!owner->lifetime) {
    owner->lifetime = js::shell::KandeloGetNativeAsyncState(cx);
    if (!owner->lifetime) return false;
    owner->lifetime->Retain();
  }
  owner->DestroyAsync();
  owner->asyncId = cx->allocateKandeloAsyncId(); owner->triggerId = trigger;
  JS::SetReservedSlot(object, 2, alias); JS::SetReservedSlot(object, 3, frame);
  // The existing native:init consumer replaces this exact raw handle epoch;
  // execution stacks already entered with an older ID keep their authority.
  return cx->notifyKandeloAsyncLifecycle("native:init", object, frame);
}
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
    auto owner = std::make_unique<KandeloHttpOwner>(cx, text.get(), uint64_t(args[2].toNumber()), args[3].toBoolean(), args[4].toBoolean(), request);
    RootedObject object(cx, JS_NewObjectWithGivenProto(cx, &KandeloHttpClass, nullptr));
    if (!object) return false;
    owner->identity = object;
    auto* admitted = owner.release();
    JS::SetReservedSlot(object, 0, PrivateValue(admitted));
    JS::SetReservedSlot(object, 1, retainedList);
    KandeloHttpAccount(object, admitted);
    // Initialize owns AsyncReset before Init/list membership. Creation alone
    // must not expose a connection before its actual init hook executes.
    args.rval().setObject(*object); return true;
  }
  RootedObject object(cx, args.get(1).isObject() ? js::CheckedUnwrapDynamic(&args[1].toObject(), cx) : nullptr);
  if (!object || JS::GetClass(object) != &KandeloHttpClass) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "HTTP parser requires its actual native owner");
    return false;
  }
  if (JS::GetReservedSlot(object, 0).isUndefined()) {
    // Actual native close completed. Only real supported methods inherit
    // absent-backing return semantics; an unknown operation is not support.
    const char* known[] = { "remove", "free", "close", "initialize", "feed", "finish",
        "feedRequest", "finishRequest", "feedRequestHeaders", "dispatch" };
    for (const char* method : known) {
      if (strcmp(operation.get(), method) == 0) { args.rval().setUndefined();return true; }
    }
    JS_ReportErrorASCII(cx, "Unknown HTTP parser operation");return false;
  }
  auto* owner = static_cast<KandeloHttpOwner*>(JS::GetReservedSlot(object, 0).toPrivate());
  if (owner->cx != cx) {
    JS_ReportErrorASCII(cx, "HTTP parser belongs to another native environment");return false;
  }
  const bool close = strcmp(operation.get(), "close") == 0;
  const bool free = strcmp(operation.get(), "free") == 0;
  if (close || free) {
    owner->DestroyAsync();
    // Old active callback frames retain their own resource/frame/ID roots.
    JS::SetReservedSlot(object, 2, ObjectValue(*object));
    JS::SetReservedSlot(object, 3, UndefinedValue());
    const bool retired = cx->notifyKandeloAsyncLifecycle("native:retire", object, UndefinedHandleValue);
    if (close || owner->retirement == KandeloHttpOwner::Retirement::None)
      owner->retirement = close ? KandeloHttpOwner::Retirement::Close : KandeloHttpOwner::Retirement::Free;
    owner->parser.RemoveConnections();
    JS::SetReservedSlot(object, 1, UndefinedValue());
    if (!owner->executing) KandeloHttpRetire(object, owner);
    args.rval().setUndefined(); return retired;
  }
  if (strcmp(operation.get(), "initialize") == 0) {
    if (owner->executing) { JS_ReportErrorASCII(cx, "HTTP parser is already executing");return false; }
    if (!args.get(2).isString() || !args.get(3).isNumber() || !args.get(4).isBoolean() || !args.get(5).isBoolean() ||
        !std::isfinite(args[3].toNumber()) || args[3].toNumber() < 0 ||
        args[3].toNumber() > 9007199254740991.0 || std::floor(args[3].toNumber()) != args[3].toNumber()) {
      JS_ReportErrorASCII(cx, "HTTP parser requires checked method/limit/options");return false;
    }
    RootedString method(cx, args[2].toString());
    JS::UniqueChars text = JS_EncodeStringToUTF8(cx, method); if (!text) return false;
    RootedValue retainedList(cx, args.get(6));
    std::shared_ptr<kandelo::http::ConnectionsList> list;
    if (!retainedList.isUndefined()) {
      RootedObject connections(cx, retainedList.isObject() ? js::CheckedUnwrapDynamic(&retainedList.toObject(), cx) : nullptr);
      if (retainedList.isObject() && !connections) {
        if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);
        return false;
      }
      auto* target = KandeloHttpConnections(connections);
      if (!target || !owner->request) {
        if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Request parser requires its real connection list");
        return false;
      }
      list = target->list;
    }
    if (!args.get(7).isObject()) {
      JS_ReportErrorASCII(cx, "HTTP parser initialization requires its real async resource");return false;
    }
    // Initialization can run an actual init hook. Its native frame prevents
    // callback close/free from deleting/resetting the owner underneath it.
    owner->executing = true;
    auto endInitialization = mozilla::MakeScopeExit([&] {
      owner->executing = false; KandeloHttpRetire(object, owner);
    });
    JSAutoRealm realm(cx, object);
    if (!JS_WrapValue(cx, &retainedList)) return false;
    owner->released = true;
    owner->parser.RemoveConnections();
    if (!KandeloHttpResetAsync(cx, object, owner, args[7])) return false;
    if (owner->retirement != KandeloHttpOwner::Retirement::None || GetShellContext(cx)->quitting) {
      args.rval().setBoolean(false);return true;
    }
    owner->parser.Reset(text.get(), uint64_t(args[3].toNumber()), args[4].toBoolean(), args[5].toBoolean(), std::move(list), owner);
    owner->released = false;
    owner->retirement = KandeloHttpOwner::Retirement::None;
    JS::SetReservedSlot(object, 1, retainedList);
    args.rval().setBoolean(true);return true;
  }
  if (strcmp(operation.get(), "remove") == 0) {
    owner->parser.RemoveConnections();
    JS::SetReservedSlot(object, 1, UndefinedValue());
    args.rval().setUndefined(); return true;
  }
  if (strcmp(operation.get(), "dispatch") == 0) {
    if (owner->released || owner->asyncId < 0 || !args.get(2).isObject() ||
        !JS::IsCallable(&args[2].toObject()) || !args.get(3).isBoolean()) {
      JS_ReportErrorASCII(cx, "HTTP callback requires its live parser epoch and actual callback");return false;
    }
    RootedValue callback(cx, args[2]), frame(cx, JS::GetReservedSlot(object, 3));
    JSAutoRealm realm(cx, object);
    if (!JS_WrapValue(cx, &callback)) return false;
    // Actual response callbacks remain deferred packet replay; the resource
    // scope is real but does not claim synchronous llhttp callback chronology.
    KandeloNativeCallbackScope scope(cx, object, frame, args[3].toBoolean());
    if (!scope.Enter()) return scope.Stopped();
    const bool called = args[3].toBoolean()
        ? JS::Call(cx, UndefinedHandleValue, callback, JS::HandleValueArray::empty(), args.rval())
        : scope.Call(callback, JS::HandleValueArray::empty(), args.rval());
    return called ? scope.Close() : scope.Fail();
  }
  const bool fullCallbacks = strcmp(operation.get(), "feedRequest") == 0 ||
      strcmp(operation.get(), "finishRequest") == 0;
  const bool synchronous = fullCallbacks || strcmp(operation.get(), "feedRequestHeaders") == 0;
  if (owner->executing) { JS_ReportErrorASCII(cx, "HTTP parser is already executing");return false; }
  if (owner->released) { JS_ReportErrorASCII(cx, "HTTP parser is not initialized");return false; }
  owner->executing = true;
  // This one lifetime fence handles both normal/OOM accounting and actual
  // deferred retirement. No later guard can dereference a deleted owner.
  auto endExecution = mozilla::MakeScopeExit([&] {
    owner->executing = false;
    KandeloHttpRetire(object, owner);
  });
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
    if (owner->asyncId < 0) {
      JS_ReportErrorASCII(cx, "HTTP request callbacks require initialized parser resource");return false;
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
