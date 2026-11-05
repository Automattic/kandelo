/* Actual SQLite database/statement bridge. Included by shell/js.cpp after its
 * JS imports. The exact backend/core own SQL, bytes and native resource state;
 * the shared JS frontend owns public argument/row/method contracts.
 * Engine compilation and guest/four-host validation remain pending.
 */
// This header exposes session constants only when the matching backend
// feature is declared. The exact Node recipe builds SQLITE_ENABLE_SESSION.
#ifndef SQLITE_ENABLE_SESSION
#define SQLITE_ENABLE_SESSION 1
#endif
#include "kandelo-node-sqlite-store.h"
#include "kandelo-node-sqlite-constants.h"
#include "js/Wrapper.h"
#include "js/Stack.h"
#include "js/Promise.h"
#include "js/SharedArrayBuffer.h"
#include "js/TracingAPI.h"
#include <algorithm>
#include <cmath>

namespace {
using SqliteConnection = kandelo::sqlite::Connection;
using SqliteStatement = kandelo::sqlite::Statement;
using SqliteSession = kandelo::sqlite::Session;
using SqliteCell = kandelo::sqlite::Cell;
using SqliteError = kandelo::sqlite::Error;
static bool KandeloSqliteRaise(JSContext* cx, const SqliteError& error) {
  if (JS_IsExceptionPending(cx)) return false;
  const JSExnType type = error.code == "ERR_INVALID_ARG_TYPE" ? JSEXN_TYPEERR
      : error.code == "ERR_OUT_OF_RANGE" ? JSEXN_RANGEERR : JSEXN_ERR;
  RootedString message(cx, JS_NewStringCopyUTF8Z(cx, JS::ConstUTF8CharsZ(error.what(), strlen(error.what()))));
  RootedString file(cx, JS_GetEmptyString(cx));
  RootedObject stack(cx);
  RootedValue value(cx);
  if (!message || !JS::CaptureCurrentStack(cx, &stack) ||
      !JS::CreateError(cx, type, stack, file, 0, JS::ColumnNumberOneOrigin(1), nullptr,
                       message, JS::NothingHandleValue, &value)) return false;
  RootedObject object(cx, &value.toObject());
  RootedString code(cx, JS_NewStringCopyZ(cx, error.code.c_str()));
  if (!code || !JS_DefineProperty(cx, object, "code", code, JSPROP_ENUMERATE)) return false;
  if (error.code == "ERR_SQLITE_ERROR") {
    RootedString description(cx, JS_NewStringCopyZ(cx, error.errstr.c_str()));
    if (!description || !JS_DefineProperty(cx, object, "errcode", error.errcode, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, object, "errstr", description, JSPROP_ENUMERATE)) return false;
  }
  JS_SetPendingException(cx, value); return false;
}
template <typename Function>
static bool KandeloSqliteTry(JSContext* cx, Function&& function) {
  try { return function(); }
  catch (const SqliteError& error) { return KandeloSqliteRaise(cx, error); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
static const JSClass KandeloSqliteLimitsClass =
    PROXY_CLASS_DEF("Object", JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE);
class KandeloSqliteLimitsHandler final : public js::ForwardingProxyHandler {
  static std::shared_ptr<SqliteConnection> Owner(HandleObject proxy) {
    auto* weak = static_cast<std::weak_ptr<SqliteConnection>*>(js::GetProxyReservedSlot(proxy, 0).toPrivate());
    auto connection = weak->lock();
    if (!connection) throw SqliteError("ERR_INVALID_STATE", "database is not open");
    connection->Require(); return connection;
  }
  static bool Index(JSContext* cx, HandleId id, int* result) {
    *result = -1;
    if (!id.isString()) return true;
    RootedString key(cx, id.toString());
    for (const auto& entry : kandelo::sqlite::kLimitMapping) {
      bool equal;
      if (!JS_StringEqualsAscii(cx, key, entry.js_name.data(), entry.js_name.size(), &equal)) return false;
      if (equal) { *result = entry.sqlite_limit_id; break; }
    }
    return true;
  }
  static bool Assign(JSContext* cx, HandleObject proxy, int index, HandleValue value) {
    auto owner = Owner(proxy); // closed state precedes value validation
    int limit;
    if (value.isNumber() && value.toNumber() == std::numeric_limits<double>::infinity()) limit = INT_MAX;
    else if (!value.isNumber() || std::trunc(value.toNumber()) != value.toNumber() ||
             value.toNumber() < INT_MIN || value.toNumber() > INT_MAX)
      throw SqliteError("ERR_INVALID_ARG_TYPE", "Limit value must be a non-negative integer or Infinity.");
    else {
      limit = int(value.toNumber());
      if (limit < 0) throw SqliteError("ERR_OUT_OF_RANGE", "Limit value must be non-negative.");
    }
    owner->SetLimit(index, limit); return true;
  }
 public:
  static const char family;
  static const KandeloSqliteLimitsHandler singleton;
  constexpr KandeloSqliteLimitsHandler() : js::ForwardingProxyHandler(&family) {}
  void finalize(JS::GCContext*, JSObject* proxy) const override {
    const auto slot = js::GetProxyReservedSlot(proxy, 0);
    if (!slot.isUndefined()) delete static_cast<std::weak_ptr<SqliteConnection>*>(slot.toPrivate());
  }
  bool getOwnPropertyDescriptor(JSContext* cx, HandleObject proxy, HandleId id,
      MutableHandle<mozilla::Maybe<JS::PropertyDescriptor>> descriptor) const override {
    return KandeloSqliteTry(cx, [&] {
      int index; if (!Index(cx, id, &index)) return false;
      if (index < 0) return ForwardingProxyHandler::getOwnPropertyDescriptor(cx, proxy, id, descriptor);
      const int value = Owner(proxy)->Limit(index);
      descriptor.set(mozilla::Some(JS::PropertyDescriptor::Data(Int32Value(value), JSPROP_ENUMERATE | JSPROP_PERMANENT)));
      return true;
    });
  }
  bool get(JSContext* cx, HandleObject proxy, HandleValue receiver, HandleId id,
           MutableHandleValue result) const override {
    return KandeloSqliteTry(cx, [&] {
      int index; if (!Index(cx, id, &index)) return false;
      if (index < 0) return ForwardingProxyHandler::get(cx, proxy, receiver, id, result);
      result.setInt32(Owner(proxy)->Limit(index)); return true;
    });
  }
  bool set(JSContext* cx, HandleObject proxy, HandleId id, HandleValue value,
           HandleValue receiver, JS::ObjectOpResult& result) const override {
    return KandeloSqliteTry(cx, [&] {
      int index; if (!Index(cx, id, &index)) return false;
      if (index < 0) return ForwardingProxyHandler::set(cx, proxy, id, value, receiver, result);
      if (!Assign(cx, proxy, index, value)) return false;
      return result.succeed();
    });
  }
  bool defineProperty(JSContext* cx, HandleObject proxy, HandleId id,
      Handle<JS::PropertyDescriptor> descriptor, JS::ObjectOpResult& result) const override {
    return KandeloSqliteTry(cx, [&] {
      int index; if (!Index(cx, id, &index)) return false;
      if (index < 0 || !descriptor.hasValue())
        return ForwardingProxyHandler::defineProperty(cx, proxy, id, descriptor, result);
      RootedValue value(cx, descriptor.value());
      if (!Assign(cx, proxy, index, value)) return false;
      return result.succeed();
    });
  }
  bool delete_(JSContext* cx, HandleObject proxy, HandleId id, JS::ObjectOpResult& result) const override {
    int index; if (!Index(cx, id, &index)) return false;
    // V8's native interceptor has no deleter. Deletion succeeds without
    // removing an actual SQLite capability, even for its virtual DontDelete
    // descriptor. A scripted Proxy cannot represent this native contract.
    return index < 0 ? ForwardingProxyHandler::delete_(cx, proxy, id, result) : result.succeed();
  }
  bool hasOwn(JSContext* cx, HandleObject proxy, HandleId id, bool* result) const override {
    int index; if (!Index(cx, id, &index)) return false;
    if (index < 0) return ForwardingProxyHandler::hasOwn(cx, proxy, id, result);
    *result = true; return true;
  }
  bool has(JSContext* cx, HandleObject proxy, HandleId id, bool* result) const override {
    int index; if (!Index(cx, id, &index)) return false;
    if (index < 0) return ForwardingProxyHandler::has(cx, proxy, id, result);
    *result = true; return true;
  }
  bool ownPropertyKeys(JSContext* cx, HandleObject proxy, MutableHandleIdVector keys) const override {
    if (!ForwardingProxyHandler::ownPropertyKeys(cx, proxy, keys)) return false;
    for (const auto& entry : kandelo::sqlite::kLimitMapping) {
      RootedString name(cx, JS_NewStringCopyZ(cx, entry.js_name.data()));
      RootedId id(cx);
      if (!name || !JS_StringToId(cx, name, &id)) return false;
      bool found = false;
      for (auto existing : keys) if (existing == id) { found = true; break; }
      if (!found && !keys.append(id)) return false;
    }
    return true;
  }
  bool getOwnEnumerablePropertyKeys(JSContext* cx, HandleObject proxy, MutableHandleIdVector keys) const override {
    return BaseProxyHandler::getOwnEnumerablePropertyKeys(cx, proxy, keys);
  }
  bool enumerate(JSContext* cx, HandleObject proxy, MutableHandleIdVector keys) const override {
    return BaseProxyHandler::enumerate(cx, proxy, keys);
  }
  bool preventExtensions(JSContext*, HandleObject, JS::ObjectOpResult& result) const override {
    return result.failCantPreventExtensions();
  }
};
const char KandeloSqliteLimitsHandler::family = 0;
const KandeloSqliteLimitsHandler KandeloSqliteLimitsHandler::singleton;
static bool KandeloSqliteString(JSContext*, HandleValue, std::string*);
static bool KandeloSqliteText(JSContext*, const std::string&, MutableHandleValue);
static bool KandeloSqliteBytes(JSContext*, const void*, size_t, MutableHandleValue);
// SQLite callback ownership/conversions follow pinned src/node_sqlite.cc.
// Node-derived algorithms are MIT licensed; see third_party/node-core/LICENSE.
// Callback/accumulator edges are traced by the real database owner below.
struct KandeloSqliteFunction;
struct KandeloSqliteAggregate;
struct KandeloSqliteCallbacks {
  JSContext* cx;
  size_t retiring = 0;
  std::vector<KandeloSqliteFunction*> functions;
  explicit KandeloSqliteCallbacks(JSContext* cx) : cx(cx) {}
  void Trace(JSTracer* tracer);
};
struct KandeloSqliteAggregate {
  JS::Heap<Value> value{UndefinedValue()};
  bool window = false;
  bool failed = false;
};
struct KandeloSqliteFunction {
  std::shared_ptr<KandeloSqliteCallbacks> registry;
  std::weak_ptr<SqliteConnection> connection;
  JS::Heap<Value> function{UndefinedValue()}, start{UndefinedValue()},
      step{UndefinedValue()}, inverse{UndefinedValue()}, result{UndefinedValue()};
  std::vector<KandeloSqliteAggregate*> aggregates;
  bool useBigInts = false;
  ~KandeloSqliteFunction() {
    auto& entries = registry->functions;
    entries.erase(std::remove(entries.begin(), entries.end(), this), entries.end());
    // SQLite retires aggregate contexts before replacing/destroying a function.
    // Release any residual failed state without invoking user JS from cleanup.
    for (auto* state : aggregates) delete state;
  }
  void Trace(JSTracer* tracer) {
    JS::TraceEdge(tracer, &function, "SQLite scalar function");
    JS::TraceEdge(tracer, &start, "SQLite aggregate start");
    JS::TraceEdge(tracer, &step, "SQLite aggregate step");
    JS::TraceEdge(tracer, &inverse, "SQLite aggregate inverse");
    JS::TraceEdge(tracer, &result, "SQLite aggregate result");
    for (auto* state : aggregates) JS::TraceEdge(tracer, &state->value, "SQLite aggregate accumulator");
  }
};
void KandeloSqliteCallbacks::Trace(JSTracer* tracer) {
  for (auto* entry : functions) entry->Trace(tracer);
}

static bool KandeloSqliteCallbackArgument(JSContext* cx, sqlite3_value* value,
                                         bool big, MutableHandleValue result) {
  switch (sqlite3_value_type(value)) {
    case SQLITE_NULL: result.setNull(); return true;
    case SQLITE_FLOAT: result.setNumber(sqlite3_value_double(value)); return true;
    case SQLITE_INTEGER: {
      const int64_t number = sqlite3_value_int64(value);
      if (!big) {
        if (number < -9007199254740991LL || number > 9007199254740991LL)
          throw SqliteError("ERR_OUT_OF_RANGE", "Value is too large to be represented as a JavaScript number: " + std::to_string(number));
        result.setNumber(double(number)); return true;
      }
      JS::BigInt* integer = JS::NumberToBigInt(cx, number);
      if (!integer) return false;
      result.setBigInt(integer); return true;
    }
    case SQLITE_TEXT: {
      const auto* text = sqlite3_value_text(value);
      if (!text) throw std::bad_alloc();
      const int length = sqlite3_value_bytes(value);
      return KandeloSqliteText(cx, std::string(reinterpret_cast<const char*>(text), length), result);
    }
    case SQLITE_BLOB: {
      const int length = sqlite3_value_bytes(value);
      const void* bytes = sqlite3_value_blob(value);
      if (length && !bytes) throw std::bad_alloc();
      return KandeloSqliteBytes(cx, bytes, length, result);
    }
  }
  MOZ_CRASH("Invalid SQLite value type");
}
static bool KandeloSqliteCallbackResult(JSContext* cx, sqlite3_context* context,
                                       HandleValue value) {
  if (value.isNullOrUndefined()) sqlite3_result_null(context);
  else if (value.isNumber()) sqlite3_result_double(context, value.toNumber());
  else if (value.isBigInt()) {
    int64_t integer;
    if (!JS::BigIntFits<int64_t>(value.toBigInt(), &integer)) {
      sqlite3_result_error(context, "BigInt value is too large for SQLite", -1);
    } else sqlite3_result_int64(context, integer);
  } else if (value.isString()) {
    std::string text;
    if (!KandeloSqliteString(cx, value, &text)) return false;
    if (text.size() > size_t(INT_MAX)) sqlite3_result_error_toobig(context);
    else sqlite3_result_text(context, text.data(), int(text.size()), SQLITE_TRANSIENT);
  } else if (value.isObject()) {
    RootedObject object(cx, js::CheckedUnwrapStatic(&value.toObject()));
    if (!object) {
      sqlite3_result_error(context, "Returned JavaScript value cannot be converted to a SQLite value", -1);
      return true;
    }
    if (JS::IsPromiseObject(object)) {
      sqlite3_result_error(context, "Asynchronous user-defined functions are not supported", -1);
    } else if (JS_IsArrayBufferViewObject(object) || JS::IsArrayBufferObject(object) || JS::IsSharedArrayBufferObject(object)) {
      SharedMem<uint8_t*> bytes;
      size_t length;
      if (!IsBufferSource(cx, object, true, true, &bytes, &length)) return false;
      // IsBufferSource may externalize inline bytes and collect. Only borrow
      // the resulting stable span after that step, while the owner stays rooted.
      JS::AutoCheckCannotGC nogc;
      if (length > size_t(INT_MAX)) sqlite3_result_error_toobig(context);
      else {
        // Node's native contents adapter preserves a null pointer for an empty
        // fixed raw ArrayBuffer, but uses non-null scratch for an empty view.
        const bool emptyRaw = length == 0 &&
            ((JS::IsArrayBufferObject(object) && !JS::UnwrapArrayBuffer(object)->as<js::ArrayBufferObject>().isResizable()) ||
             (JS::IsSharedArrayBufferObject(object) && !JS::UnwrapSharedArrayBuffer(object)->as<js::SharedArrayBufferObject>().isGrowable()));
        const void* data = emptyRaw ? nullptr : length ? bytes.unwrap() : static_cast<const void*>("");
        sqlite3_result_blob(context, data, int(length), SQLITE_TRANSIENT);
      }
    } else sqlite3_result_error(context, "Returned JavaScript value cannot be converted to a SQLite value", -1);
  } else sqlite3_result_error(context, "Returned JavaScript value cannot be converted to a SQLite value", -1);
  return true;
}
static bool KandeloSqliteCallbackCall(KandeloSqliteFunction* function, HandleValue callback,
                                      HandleValue receiver, const JS::HandleValueArray& arguments,
                                      MutableHandleValue result) {
  auto connection = function->connection.lock();
  if (!connection || function->registry->retiring || JS_IsExceptionPending(function->registry->cx)) return false;
  return JS::Call(function->registry->cx, receiver, callback, arguments, result);
}
static bool KandeloSqliteCallbackArguments(KandeloSqliteFunction* function, int argc,
                                          sqlite3_value** argv, JS::RootedValueVector& arguments) {
  JSContext* cx = function->registry->cx;
  if (!arguments.reserve(arguments.length() + argc)) return false;
  for (int i = 0; i < argc; ++i) {
    RootedValue value(cx);
    if (!KandeloSqliteCallbackArgument(cx, argv[i], function->useBigInts, &value) || !arguments.append(value)) return false;
  }
  return true;
}
// No C++ exception may unwind through SQLite's C callback frames. A pending
// JavaScript exception remains primary when the outer dispatch reports SQL.
template <typename Callback>
static bool KandeloSqliteCallbackGuard(sqlite3_context* context, KandeloSqliteFunction* function, Callback&& callback) {
  JSContext* cx = function->registry->cx;
  bool success = false;
  try {
    auto connection = function->connection.lock();
    if (connection && connection->IsOpen() && !function->registry->retiring && !JS_IsExceptionPending(cx)) {
      SqliteConnection::CallbackScope scope(*connection);
      success = callback();
    }
  } catch (const SqliteError& error) { KandeloSqliteRaise(cx, error);
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx);
  } catch (...) { JS_ReportErrorASCII(cx, "SQLite callback failed"); }
  if (!success) sqlite3_result_error(context, "", 0);
  return success;
}
static void KandeloSqliteScalar(sqlite3_context* context, int argc, sqlite3_value** argv) {
  auto* function = static_cast<KandeloSqliteFunction*>(sqlite3_user_data(context));
  KandeloSqliteCallbackGuard(context, function, [&] {
    JSContext* cx = function->registry->cx;
    JS::RootedValueVector arguments(cx);
    RootedValue callback(cx, function->function), receiver(cx, UndefinedValue()), result(cx);
    return KandeloSqliteCallbackArguments(function, argc, argv, arguments) &&
        KandeloSqliteCallbackCall(function, callback, receiver, JS::HandleValueArray(arguments), &result) &&
        KandeloSqliteCallbackResult(cx, context, result);
  });
}
static KandeloSqliteAggregate** KandeloSqliteAggregateSlot(sqlite3_context* context) {
  auto** slot = static_cast<KandeloSqliteAggregate**>(sqlite3_aggregate_context(context, sizeof(KandeloSqliteAggregate*)));
  if (!slot) throw std::bad_alloc();
  return slot;
}
static KandeloSqliteAggregate* KandeloSqliteAggregateGet(sqlite3_context* context, KandeloSqliteFunction* function) {
  auto** slot = KandeloSqliteAggregateSlot(context);
  if (*slot) return *slot;
  JSContext* cx = function->registry->cx;
  auto state = std::make_unique<KandeloSqliteAggregate>();
  RootedValue initial(cx, function->start);
  if (initial.isObject() && JS::IsCallable(&initial.toObject())) {
    RootedValue receiver(cx, NullValue()), result(cx);
    if (!KandeloSqliteCallbackCall(function, initial, receiver, JS::HandleValueArray::empty(), &result)) return nullptr;
    initial = result;
  }
  state->value = initial;
  function->aggregates.push_back(state.get());
  *slot = state.release();
  return *slot;
}
static void KandeloSqliteAggregateDelete(sqlite3_context* context, KandeloSqliteFunction* function) {
  auto** slot = static_cast<KandeloSqliteAggregate**>(sqlite3_aggregate_context(context, 0));
  if (!slot || !*slot) return;
  auto& entries = function->aggregates;
  entries.erase(std::remove(entries.begin(), entries.end(), *slot), entries.end());
  delete *slot;
  *slot = nullptr;
}
template <bool inverse>
static void KandeloSqliteAggregateStep(sqlite3_context* context, int argc, sqlite3_value** argv) {
  auto* function = static_cast<KandeloSqliteFunction*>(sqlite3_user_data(context));
  const bool success = KandeloSqliteCallbackGuard(context, function, [&] {
    auto* state = KandeloSqliteAggregateGet(context, function);
    if (!state || state->failed) return false;
    JSContext* cx = function->registry->cx;
    JS::RootedValueVector arguments(cx);
    RootedValue callback(cx, inverse ? function->inverse : function->step), receiver(cx, UndefinedValue()), result(cx);
    if (!arguments.append(state->value) || !KandeloSqliteCallbackArguments(function, argc, argv, arguments) ||
        !KandeloSqliteCallbackCall(function, callback, receiver, JS::HandleValueArray(arguments), &result)) return false;
    state->value = result;
    return true;
  });
  if (!success) {
    auto** slot = static_cast<KandeloSqliteAggregate**>(sqlite3_aggregate_context(context, 0));
    if (slot && *slot) (*slot)->failed = true;
  }
}
template <bool final>
static void KandeloSqliteAggregateValue(sqlite3_context* context) {
  auto* function = static_cast<KandeloSqliteFunction*>(sqlite3_user_data(context));
  // Finalizing an abandoned statement from GC must retire state without
  // running start/result user code or accessing callbacks being collected.
  if (function->registry->retiring || JS_IsExceptionPending(function->registry->cx)) {
    if constexpr (final) KandeloSqliteAggregateDelete(context, function);
    return;
  }
  KandeloSqliteCallbackGuard(context, function, [&] {
    auto* state = KandeloSqliteAggregateGet(context, function);
    if (!state || state->failed) return false;
    if constexpr (final) { if (state->window) return true; }
    else state->window = true;
    JSContext* cx = function->registry->cx;
    RootedValue result(cx, state->value), callback(cx, function->result), receiver(cx, NullValue());
    if (!callback.isUndefined()) {
      RootedValue argument(cx, state->value);
      if (!KandeloSqliteCallbackCall(function, callback, receiver, JS::HandleValueArray(argument), &result)) return false;
    }
    return KandeloSqliteCallbackResult(cx, context, result);
  });
  if constexpr (final) KandeloSqliteAggregateDelete(context, function);
}
static void KandeloSqliteFunctionDestroy(void* data) { delete static_cast<KandeloSqliteFunction*>(data); }

struct KandeloSqliteHandle {
  std::shared_ptr<SqliteConnection> connection;
  std::shared_ptr<SqliteStatement> statement;
  std::shared_ptr<SqliteSession> session;
  std::shared_ptr<KandeloSqliteCallbacks> callbacks;
};
static void KandeloSqliteFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (slot.isUndefined()) return;
  auto* owner = static_cast<KandeloSqliteHandle*>(slot.toPrivate());
  auto callbacks = owner->callbacks;
  if (callbacks) ++callbacks->retiring;
  delete owner;
  if (callbacks) --callbacks->retiring;
}
static void KandeloSqliteTrace(JSTracer* tracer, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (slot.isUndefined()) return;
  auto* owner = static_cast<KandeloSqliteHandle*>(slot.toPrivate());
  // Only the database owns callback edges. Child handles retain it in slot1,
  // so cycles through a user closure stay ordinary collectible JS GC graphs.
  if (owner->connection && owner->callbacks) owner->callbacks->Trace(tracer);
}
static const JSClassOps KandeloSqliteClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloSqliteFinalize,
  nullptr, nullptr, KandeloSqliteTrace};
static const JSClass KandeloSqliteClass = {"KandeloSqliteOwner",
  JSCLASS_HAS_RESERVED_SLOTS(2) | JSCLASS_FOREGROUND_FINALIZE, &KandeloSqliteClassOps};
static KandeloSqliteHandle* KandeloSqliteOwner(HandleValue value, int kind) {
  if (!value.isObject() || JS::GetClass(&value.toObject()) != &KandeloSqliteClass) {
    throw SqliteError("ERR_INVALID_THIS", "Invalid SQLite owner");
  }
  const auto slot = JS::GetReservedSlot(&value.toObject(), 0);
  if (slot.isUndefined()) throw SqliteError("ERR_INVALID_STATE", "SQLite owner is not initialized");
  auto* owner = static_cast<KandeloSqliteHandle*>(slot.toPrivate());
  if (kind == 2 ? !owner->session : kind == 1 ? !owner->statement : !owner->connection) throw SqliteError("ERR_INVALID_THIS", "Wrong SQLite owner kind");
  return owner;
}
static bool KandeloSqliteNewOwner(JSContext* cx, std::unique_ptr<KandeloSqliteHandle> owner, MutableHandleValue result,
                                  JSObject* parent = nullptr) {
  RootedObject database(cx, parent);
  RootedObject object(cx, JS_NewObject(cx, &KandeloSqliteClass));
  if (!object) return false;
  JS::SetReservedSlot(object, 0, PrivateValue(owner.release()));
  JS::SetReservedSlot(object, 1, database ? ObjectValue(*database) : UndefinedValue());
  result.setObject(*object);
  return true;
}
static bool KandeloSqliteString(JSContext* cx, HandleValue value, std::string* result) {
  if (!value.isString()) throw SqliteError("ERR_INVALID_ARG_TYPE", "SQLite string argument required");
  RootedString string(cx, value.toString());
  JSLinearString* linear = JS_EnsureLinearString(cx, string);
  if (!linear) return false;
  const size_t length = JS::GetDeflatedUTF8StringLength(linear);
  result->resize(length);
  JS::AutoCheckCannotGC nogc;
  if (length) {
    const size_t written = JS::DeflateStringToUTF8Buffer(linear, mozilla::Span<char>(result->data(), length));
    MOZ_RELEASE_ASSERT(written == length);
  }
  return true;
}
static bool KandeloSqliteText(JSContext* cx, const std::string& value, MutableHandleValue result) {
  RootedString text(cx, JS_NewStringCopyUTF8N(cx, JS::UTF8Chars(value.data(), value.size())));
  if (!text) return false;
  result.setString(text); return true;
}
static bool KandeloSqliteBytes(JSContext* cx, const void* data, size_t length, MutableHandleValue result) {
  RootedObject bytes(cx, JS_NewUint8Array(cx, length));
  if (!bytes) return false;
  JS::AutoCheckCannotGC nogc;
  bool shared;
  auto* target = JS_GetUint8ArrayData(bytes, &shared, nogc);
  if (length) memcpy(target, data, length);
  result.setObject(*bytes); return true;
}
static bool KandeloSqliteValue(JSContext* cx, const SqliteCell& cell, MutableHandleValue result) {
  if (cell.type == SQLITE_NULL) { result.setNull(); return true; }
  if (cell.type == SQLITE_FLOAT) { result.setNumber(cell.number); return true; }
  if (cell.type == SQLITE_INTEGER) {
    JS::BigInt* value = JS::NumberToBigInt(cx, cell.integer);
    if (!value) return false;
    result.setBigInt(value); return true;
  }
  if (cell.type == SQLITE_TEXT) return KandeloSqliteBytes(cx, cell.text.data(), cell.text.size(), result);
  return KandeloSqliteBytes(cx, cell.bytes.data(), cell.bytes.size(), result);
}
static bool KandeloSqliteBoolean(JSContext* cx, HandleObject object, const char* name, bool* result) {
  RootedValue value(cx);
  if (!JS_GetProperty(cx, object, name, &value)) return false;
  if (!value.isBoolean()) throw SqliteError("ERR_INVALID_ARG_TYPE", "Invalid SQLite boolean option");
  *result = value.toBoolean(); return true;
}
static bool KandeloSqliteDispatch(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  std::string operation;
  if (!KandeloSqliteString(cx, args.get(0), &operation)) return false;
  if (operation == "version") return KandeloSqliteText(cx, sqlite3_libversion(), args.rval());
  if (operation == "constants") {
    RootedObject object(cx, JS_NewPlainObject(cx));
    if (!object || !KandeloSqliteConstants(cx, object)) return false;
    args.rval().setObject(*object); return true;
  }
  if (operation == "create") {
    std::string path;
    if (!KandeloSqliteString(cx, args.get(1), &path)) return false;
    if (!args.get(2).isObject()) throw SqliteError("ERR_INVALID_ARG_TYPE", "SQLite options required");
    RootedObject options(cx, &args[2].toObject());
    kandelo::sqlite::Options config;
    bool open;
    if (!KandeloSqliteBoolean(cx, options, "open", &open) ||
        !KandeloSqliteBoolean(cx, options, "readOnly", &config.readOnly) ||
        !KandeloSqliteBoolean(cx, options, "foreignKeys", &config.foreignKeys) ||
        !KandeloSqliteBoolean(cx, options, "doubleQuotedStrings", &config.doubleQuotedStrings) ||
        !KandeloSqliteBoolean(cx, options, "defensive", &config.defensive)) return false;
    RootedValue timeout(cx);
    if (!JS_GetProperty(cx, options, "timeout", &timeout)) return false;
    if (!timeout.isInt32()) throw SqliteError("ERR_OUT_OF_RANGE", "Invalid SQLite timeout");
    config.timeout = timeout.toInt32();
    RootedValue limitsValue(cx);
    if (!JS_GetProperty(cx, options, "limits", &limitsValue)) return false;
    if (!limitsValue.isObject()) throw SqliteError("ERR_INVALID_ARG_TYPE", "SQLite limits required");
    RootedObject limits(cx, &limitsValue.toObject());
    for (size_t i = 0; i < config.limits.size(); ++i) {
      RootedValue limit(cx);
      if (!JS_GetElement(cx, limits, i, &limit)) return false;
      if (limit.isUndefined()) continue;
      if (!limit.isInt32() || limit.toInt32() < 0) throw SqliteError("ERR_INVALID_ARG_TYPE", "Invalid SQLite limit");
      config.limits[i] = limit.toInt32();
    }
    auto owner = std::make_unique<KandeloSqliteHandle>();
    owner->connection = std::make_shared<SqliteConnection>(std::move(path), config);
    owner->callbacks = std::make_shared<KandeloSqliteCallbacks>(cx);
    if (open) owner->connection->Open();
    return KandeloSqliteNewOwner(cx, std::move(owner), args.rval());
  }
  const bool statementOperation = operation == "checkStatement" || operation == "columns" || operation == "finalize" || operation == "reset" || operation == "bind" || operation == "step" || operation == "stepDiscard" || operation == "names" || operation == "parameters" || operation == "sourceSQL" || operation == "expandedSQL";
  const bool sessionOperation = operation == "sessionChangeset" || operation == "closeSession";
  auto* owner = KandeloSqliteOwner(args.get(1), sessionOperation ? 2 : statementOperation ? 1 : 0);
  if (operation == "open") owner->connection->Open();
  else if (operation == "close") owner->connection->Close();
  else if (operation == "isOpen") { args.rval().setBoolean(owner->connection->IsOpen()); return true; }
  else if (operation == "isTransaction") { args.rval().setBoolean(owner->connection->IsTransaction()); return true; }
  else if (operation == "location") {
    std::string schema;
    if (!KandeloSqliteString(cx, args.get(2), &schema)) return false;
    const auto location = owner->connection->Location(schema);
    if (location.empty()) { args.rval().setNull(); return true; }
    return KandeloSqliteText(cx, location, args.rval());
  } else if (operation == "checkDatabase") { owner->connection->Require();
  } else if (operation == "registerScalar" || operation == "registerAggregate") {
    const bool scalar = operation == "registerScalar";
    auto connection = owner->connection;
    sqlite3* db = connection->Require();
    std::string name;
    if (!KandeloSqliteString(cx, args.get(2), &name)) return false;
    const unsigned arityIndex = scalar ? 4 : 7, bigIndex = scalar ? 5 : 8;
    if (!args.get(arityIndex).isNumber() || std::trunc(args[arityIndex].toNumber()) != args[arityIndex].toNumber() ||
        args[arityIndex].toNumber() < INT_MIN || args[arityIndex].toNumber() > INT_MAX || !args.get(bigIndex).isBoolean()) {
      throw SqliteError("ERR_INVALID_ARG_TYPE", "Invalid SQLite callback configuration");
    }
    auto entry = std::make_unique<KandeloSqliteFunction>();
    entry->registry = owner->callbacks;
    entry->connection = connection;
    entry->useBigInts = args[bigIndex].toBoolean();
    int flags = SQLITE_UTF8;
    if (scalar) {
      if (!args.get(3).isObject() || !JS::IsCallable(&args[3].toObject()) ||
          !args.get(6).isBoolean() || !args.get(7).isBoolean()) throw SqliteError("ERR_INVALID_ARG_TYPE", "Invalid SQLite scalar callback");
      entry->function = args[3];
      if (args[6].toBoolean()) flags |= SQLITE_DETERMINISTIC;
      if (args[7].toBoolean()) flags |= SQLITE_DIRECTONLY;
    } else {
      if (!args.get(4).isObject() || !JS::IsCallable(&args[4].toObject()) || !args.get(9).isBoolean() ||
          (!args.get(5).isUndefined() && (!args[5].isObject() || !JS::IsCallable(&args[5].toObject()))) ||
          (!args.get(6).isUndefined() && (!args[6].isObject() || !JS::IsCallable(&args[6].toObject()))))
        throw SqliteError("ERR_INVALID_ARG_TYPE", "Invalid SQLite aggregate callback");
      entry->start = args[3]; entry->step = args[4]; entry->inverse = args[5]; entry->result = args[6];
      if (args[9].toBoolean()) flags |= SQLITE_DIRECTONLY;
    }
    const bool window = !entry->inverse.get().isUndefined();
    owner->callbacks->functions.push_back(entry.get());
    auto* data = entry.release();
    // SQLite assumes ownership of user data and invokes xDestroy even when
    // registration fails. Replacements retire the old registration atomically.
    const int arity = int(args[arityIndex].toNumber());
    const int result = scalar ? sqlite3_create_function_v2(db, name.c_str(), arity, flags, data,
        KandeloSqliteScalar, nullptr, nullptr, KandeloSqliteFunctionDestroy)
        : sqlite3_create_window_function(db, name.c_str(), arity, flags, data,
            KandeloSqliteAggregateStep<false>, KandeloSqliteAggregateValue<true>,
            window ? KandeloSqliteAggregateValue<false> : nullptr,
            window ? KandeloSqliteAggregateStep<true> : nullptr, KandeloSqliteFunctionDestroy);
    if (result != SQLITE_OK) throw kandelo::sqlite::DatabaseError(db, result);
  } else if (operation == "checkStatement") { owner->statement->Require();
  } else if (operation == "limits") {
    // Hold only a weak native connection; ordinary extra properties live on
    // a traced expando target. The public database caches this single object.
    auto weak = std::make_unique<std::weak_ptr<SqliteConnection>>(owner->connection);
    RootedObject target(cx, JS_NewPlainObject(cx));
    if (!target) return false;
    RootedValue targetValue(cx, ObjectValue(*target));
    js::ProxyOptions options;
    options.setClass(&KandeloSqliteLimitsClass).setLazyProto(true);
    RootedObject limits(cx, js::NewProxyObject(cx, &KandeloSqliteLimitsHandler::singleton,
                                             targetValue, nullptr, options));
    if (!limits) return false;
    js::SetProxyReservedSlot(limits, 0, PrivateValue(weak.release()));
    args.rval().setObject(*limits); return true;
  } else if (operation == "limit" || operation == "setLimit") {
    if (!args.get(2).isInt32()) throw SqliteError("ERR_INVALID_ARG_TYPE", "SQLite limit index required");
    const int id = args[2].toInt32();
    if (operation == "limit") { args.rval().setInt32(owner->connection->Limit(id)); return true; }
    if (!args.get(3).isInt32() || args[3].toInt32() < 0) throw SqliteError("ERR_INVALID_ARG_TYPE", "SQLite nonnegative limit required");
    owner->connection->SetLimit(id, args[3].toInt32());
  } else if (operation == "defensive") {
    if (!args.get(2).isBoolean()) throw SqliteError("ERR_INVALID_ARG_TYPE", "SQLite defensive flag required");
    owner->connection->EnableDefensive(args[2].toBoolean());
  } else if (operation == "createSession") {
    std::string schema, table;
    if (!KandeloSqliteString(cx, args.get(2), &schema) || !KandeloSqliteString(cx, args.get(3), &table)) return false;
    auto result = std::make_unique<KandeloSqliteHandle>();
    result->session = owner->connection->CreateSession(schema, table);
    result->callbacks = owner->callbacks;
    return KandeloSqliteNewOwner(cx, std::move(result), args.rval(), &args[1].toObject());
  } else if (operation == "closeSession") {
    owner->session->Close(args.get(2).isTrue());
  } else if (operation == "sessionChangeset") {
    const auto bytes = owner->session->Changeset(args.get(2).isTrue());
    return KandeloSqliteBytes(cx, bytes.data(), bytes.size(), args.rval());
  } else if (operation == "applyChangeset") {
    // Callback roots live on this owning JS context's stack. Copy backing
    // bytes before entering SQLite: callbacks may detach/mutate the caller's
    // input. No borrowed engine span survives native-to-JS reentry.
    auto connection = owner->connection;
    connection->Require();
    std::vector<uint8_t> bytes;
    {
      if (!args.get(2).isObject()) throw SqliteError("ERR_INVALID_ARG_TYPE", "SQLite changeset requires a Uint8Array");
      RootedObject input(cx, &args[2].toObject());
      SharedMem<uint8_t*> data;
      size_t length;
      if (!IsBufferSource(cx, input, /*allowShared*/ true, /*allowResizable*/ true, &data, &length)) {
        if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "SQLite changeset requires real byte storage");
        return false;
      }
      JS::AutoCheckCannotGC nogc;
      if (length > size_t(INT_MAX)) throw SqliteError("ERR_OUT_OF_RANGE", "The changeset is too large.");
      bytes.resize(length);
      for (size_t i = 0; i < length; ++i) bytes[i] = __atomic_load_n(data.unwrap() + i, __ATOMIC_RELAXED);
    }
    RootedValue filter(cx, args.get(3)), conflict(cx, args.get(4));
    bool failed = false;
    std::function<bool(const char*)> select;
    std::function<int(int)> resolve;
    if (!filter.isUndefined()) select = [&](const char* table) {
      if (failed) return false;
      RootedValue argument(cx), result(cx);
      if (!KandeloSqliteText(cx, table, &argument) ||
          !JS::Call(cx, NullHandleValue, filter, JS::HandleValueArray(argument), &result)) {
        failed = true; return false;
      }
      return JS::ToBoolean(result);
    };
    if (!conflict.isUndefined()) resolve = [&](int type) {
      if (failed) return SQLITE_CHANGESET_ABORT;
      RootedValue argument(cx, Int32Value(type)), result(cx);
      if (!JS::Call(cx, NullHandleValue, conflict, JS::HandleValueArray(argument), &result)) {
        failed = true; return SQLITE_CHANGESET_ABORT;
      }
      // The target native callback accepts int32 results without coercion.
      return result.isInt32() ? result.toInt32() : -1;
    };
    const bool applied = connection->ApplyChangeset(bytes, select, resolve);
    if (failed) return false;
    args.rval().setBoolean(applied); return true;
  } else if (operation == "exec") {
    std::string sql;
    if (!KandeloSqliteString(cx, args.get(2), &sql)) return false;
    owner->connection->Exec(sql);
  } else if (operation == "prepare") {
    std::string sql;
    if (!KandeloSqliteString(cx, args.get(2), &sql)) return false;
    auto statement = owner->connection->Prepare(sql, args.get(3).isTrue());
    auto result = std::make_unique<KandeloSqliteHandle>();
    result->statement = std::move(statement);
    result->callbacks = owner->callbacks;
    return KandeloSqliteNewOwner(cx, std::move(result), args.rval(), &args[1].toObject());
  } else if (operation == "finalize") {
    owner->statement->Finalize();
  } else if (operation == "reset") {
    owner->statement->Reset(args.get(2).isTrue(), args.get(3).isTrue());
  } else if (operation == "bind") {
    if (!args.get(2).isInt32()) throw SqliteError("ERR_INVALID_ARG_TYPE", "SQLite parameter index required");
    SqliteCell cell;
    RootedValue value(cx, args.get(3));
    if (value.isNullOrUndefined()) cell.type = SQLITE_NULL;
    else if (value.isBoolean()) { cell.type = SQLITE_INTEGER; cell.integer = value.toBoolean() ? 1 : 0; }
    else if (value.isNumber()) { cell.type = SQLITE_FLOAT; cell.number = value.toNumber(); }
    else if (value.isBigInt()) {
      cell.type = SQLITE_INTEGER;
      if (!JS::BigIntFits<int64_t>(value.toBigInt(), &cell.integer)) throw SqliteError("ERR_INVALID_ARG_VALUE", "BigInt value is too large to bind.");
    } else if (value.isString()) {
      cell.type = SQLITE_TEXT;
      if (!KandeloSqliteString(cx, value, &cell.text)) return false;
    } else if (value.isObject() && JS::IsArrayBufferObject(&value.toObject())) {
      RootedObject buffer(cx, JS::UnwrapArrayBuffer(&value.toObject()));
      if (!buffer) return false;
      auto& backing = buffer->as<js::ArrayBufferObject>();
      if (backing.isResizable()) throw SqliteError("ERR_NOT_IMPLEMENTED", "Resizable raw SQLite binding storage is not implemented");
      const size_t length = JS::GetArrayBufferByteLength(buffer);
      // Node util-inl.h ArrayBufferViewContents::ReadValue keeps the null
      // pointer of fixed empty/detached raw buffers. SQLite binds it as NULL;
      // its Read(view) path instead uses non-null empty scratch storage.
      cell.type = length == 0 ? SQLITE_NULL : SQLITE_BLOB;
      if (length) {
        JS::AutoCheckCannotGC nogc;
        bool shared;
        const auto* bytes = JS::GetArrayBufferData(buffer, &shared, nogc);
        cell.bytes.assign(bytes, bytes + length);
      }
    } else if (value.isObject() && JS_IsArrayBufferViewObject(&value.toObject())) {
      RootedObject view(cx, &value.toObject());
      bool shared;
      RootedObject buffer(cx, JS_GetArrayBufferViewBuffer(cx, view, &shared));
      if (!buffer) return false;
      if (shared || JS::IsResizableArrayBufferView(view)) throw SqliteError("ERR_NOT_IMPLEMENTED", "Shared/resizable SQLite binding storage ownership is not implemented");
      const size_t length = JS_GetArrayBufferViewByteLength(view);
      JS::AutoCheckCannotGC nogc;
      const auto* bytes = static_cast<const uint8_t*>(JS_GetArrayBufferViewData(view, &shared, nogc));
      cell.type = SQLITE_BLOB;
      if (length) cell.bytes.assign(bytes, bytes + length);
    } else throw SqliteError("ERR_INVALID_ARG_TYPE", "Provided value cannot be bound to SQLite parameter " + std::to_string(args[2].toInt32()) + ".");
    owner->statement->Bind(args[2].toInt32(), cell);
  } else if (operation == "stepDiscard") {
    args.rval().setBoolean(owner->statement->Step()); return true;
  } else if (operation == "step") {
    if (!owner->statement->Step()) { args.rval().setNull(); return true; }
    const auto cells = owner->statement->Row();
    RootedObject row(cx, JS::NewArrayObject(cx, cells.size()));
    if (!row) return false;
    for (size_t i = 0; i < cells.size(); ++i) {
      RootedObject cell(cx, JS::NewArrayObject(cx, 2));
      RootedValue value(cx);
      if (!cell || !KandeloSqliteValue(cx, cells[i], &value) ||
          !JS_SetElement(cx, cell, 0, cells[i].type) || !JS_SetElement(cx, cell, 1, value)) return false;
      value.setObject(*cell);
      if (!JS_SetElement(cx, row, i, value)) return false;
    }
    args.rval().setObject(*row); return true;
  } else if (operation == "columns") {
    const int count = owner->statement->ColumnCount();
    RootedObject result(cx, JS::NewArrayObject(cx, count));
    if (!result) return false;
    for (int i = 0; i < count; ++i) {
      const auto metadata = owner->statement->ColumnMetadata(i);
      RootedObject row(cx, JS::NewArrayObject(cx, metadata.size()));
      if (!row) return false;
      for (size_t j = 0; j < metadata.size(); ++j) {
        RootedValue value(cx, NullValue());
        if (metadata[j] && !KandeloSqliteText(cx, *metadata[j], &value)) return false;
        if (!JS_SetElement(cx, row, j, value)) return false;
      }
      RootedValue value(cx, ObjectValue(*row));
      if (!JS_SetElement(cx, result, i, value)) return false;
    }
    args.rval().setObject(*result); return true;
  } else if (operation == "sourceSQL" || operation == "expandedSQL") {
    return KandeloSqliteText(cx, operation == "sourceSQL" ? owner->statement->SourceSQL() : owner->statement->ExpandedSQL(), args.rval());
  } else if (operation == "names" || operation == "parameters") {
    const bool names = operation == "names";
    const int count = names ? owner->statement->ColumnCount() : owner->statement->ParameterCount();
    RootedObject result(cx, JS::NewArrayObject(cx, count));
    RootedValue value(cx);
    if (!result) return false;
    for (int i = 0; i < count; ++i) {
      if (!KandeloSqliteText(cx, names ? owner->statement->ColumnName(i) : owner->statement->ParameterName(i + 1), &value) ||
          !JS_SetElement(cx, result, i, value)) return false;
    }
    args.rval().setObject(*result); return true;
  } else if (operation == "changes" || operation == "lastInsertRowid") {
    const int64_t integer = operation == "changes" ? owner->connection->Changes() : owner->connection->LastInsertRowid();
    JS::BigInt* value = JS::NumberToBigInt(cx, integer);
    if (!value) return false;
    args.rval().setBigInt(value); return true;
  } else throw SqliteError("ERR_NOT_IMPLEMENTED", "SQLite native operation is not implemented");
  args.rval().setUndefined(); return true;
}
static bool KandeloNativeSqlite(JSContext* cx, unsigned argc, Value* vp) {
  try { return KandeloSqliteDispatch(cx, argc, vp); }
  catch (const SqliteError& error) { return KandeloSqliteRaise(cx, error);
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  catch (...) { JS_ReportErrorASCII(cx, "SQLite native operation failed"); return false; }
}
}  // namespace
