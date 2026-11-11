#include "shell/node-upstream/per-context.h"

#include "mozilla/Assertions.h"

#include <cstring>
#include <iterator>
#include <utility>

#include "jsapi.h"
#define NODE_WANT_INTERNALS 1
#include "node-env-properties.h"
#undef NODE_WANT_INTERNALS

#include "js/CallAndConstruct.h"
#include "js/Class.h"
#include "js/ErrorReport.h"
#include "js/experimental/TypedData.h"
#include "js/GlobalObject.h"
#include "js/Object.h"
#include "js/PropertyAndElement.h"
#include "js/Realm.h"
#include "js/Symbol.h"
#include "js/ValueArray.h"
#include "js/Wrapper.h"
#include "shell/node-upstream/async-wrap.h"
#include "shell/node-upstream/builtin-compiler.h"
#include "shell/node-upstream/codecs.h"
#include "shell/node-upstream/error-stack.h"
#include "shell/node-upstream/module-wrap.h"
#include "shell/node-upstream/options.h"
#include "shell/node-upstream/realm.h"
#include "shell/node-upstream/task-queue.h"
#include "shell/node-upstream/timers.h"

namespace kandelo::node {
namespace {

// Expand the original pinned Node inventory, not a separately maintained list.
struct SymbolSpec { const char* name; const char* description; bool isPrivate; };
#define PRIVATE_SYMBOL(name, description) {#name, description, true},
#define ORDINARY_SYMBOL(name, description) {#name, description, false},
static constexpr SymbolSpec kSymbols[] = {
    PER_ISOLATE_PRIVATE_SYMBOL_PROPERTIES(PRIVATE_SYMBOL)
    PER_ISOLATE_SYMBOL_PROPERTIES(ORDINARY_SYMBOL)
};
#undef PRIVATE_SYMBOL
#undef ORDINARY_SYMBOL
static_assert(std::size(kSymbols) == 49);

enum Phase { Initializing = 1, Ready = 2, Failed = 3 };
enum RuntimeSlot { RuntimePhase, ContextKey, ExitInfo, TimerBase, TimerState, TaskState, AsyncState, OptionsState, CodecState,
                   PrincipalRealm, PrincipalProcess, FirstSymbol };
static const JSClass kRuntimeClass = {
    "KandeloNodeRuntime", JSCLASS_HAS_RESERVED_SLOTS(FirstSymbol + std::size(kSymbols))};
enum ContextSlot {
  ContextPhase, OwningGlobal, RuntimeOwner, Exports, Primordials,
  PrivateSymbols, OrdinarySymbols, CompletedScripts, ModuleWrapBinding,
  ErrorStackState, RealmLibrary, ContextSlots
};
static const JSClass kContextClass = {
    "KandeloNodeContext", JSCLASS_HAS_RESERVED_SLOTS(ContextSlots)};

bool Report(JSContext* cx, const char* message) {
  if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "%s", message);
  return false;
}
void PhaseOf(JSObject* object, unsigned slot, Phase phase) {
  JS::SetReservedSlot(object, slot, JS::Int32Value(phase));
}
bool RuntimeReady(JSContext* cx, JS::HandleObject runtime) {
  if (JS::GetClass(runtime) != &kRuntimeClass ||
      JS::GetReservedSlot(runtime, RuntimePhase) != JS::Int32Value(Ready)) {
    return Report(cx, "Node runtime symbol owner is not ready");
  }
  return true;
}
JSObject* LookupContext(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject global(cx, JS::CurrentGlobalOrNull(cx));
  if (!global || !RuntimeReady(cx, runtime)) return nullptr;
  JS::RootedId key(cx, JS::PropertyKey::Symbol(
      JS::GetReservedSlot(runtime, ContextKey).toSymbol()));
  JS::RootedValue value(cx);
  if (!JS_GetPropertyById(cx, global, key, &value)) return nullptr;
  if (value.isUndefined()) return nullptr;
  if (!value.isObject()) {
    Report(cx, "Invalid canonical Node context carrier");
    return nullptr;
  }
  JS::RootedObject state(cx, &value.toObject());
  if (JS::GetClass(state) != &kContextClass ||
      JS::GetObjectRealmOrNull(state) != JS::GetCurrentRealmOrNull(cx) ||
      JS::GetReservedSlot(state, OwningGlobal) != JS::ObjectValue(*global)) {
    Report(cx, "Node context belongs to a different global");
    return nullptr;
  }
  JS::RootedObject wrappedOwner(cx, runtime);
  if (!JS_WrapObject(cx, &wrappedOwner)) return nullptr;
  if (JS::GetReservedSlot(state, RuntimeOwner) != JS::ObjectValue(*wrappedOwner)) {
    Report(cx, "Node context belongs to a different runtime owner");
    return nullptr;
  }
  return state;
}
JSObject* NullTable(JSContext* cx) {
  JS::RootedObject nullPrototype(cx);
  return JS_NewObjectWithGivenProto(cx, nullptr, nullPrototype);
}
JSObject* SymbolTable(JSContext* cx, JS::HandleObject runtime, bool privateTable) {
  JS::RootedObject table(cx, NullTable(cx));
  if (!table) return nullptr;
  for (size_t i = 0; i < std::size(kSymbols); ++i) {
    if (kSymbols[i].isPrivate != privateTable) continue;
    JS::RootedValue value(cx, JS::GetReservedSlot(runtime, FirstSymbol + i));
    if (!JS_DefineProperty(cx, table, kSymbols[i].name, value, JSPROP_ENUMERATE))
      return nullptr;
  }
  return table;
}
bool CallInitializer(JSContext* cx, JS::HandleObject state, const char* id) {
  JS::RootedFunction function(cx, CompileBuiltinFunction(cx, id));
  if (!function) return false;
  JS::RootedValue callable(cx, JS::ObjectValue(*JS_GetFunctionObject(function)));
  JS::RootedValue receiver(cx, JS::UndefinedValue());
  JS::RootedValueArray<4> args(cx);
  args[0].set(JS::GetReservedSlot(state, Exports));
  args[1].set(JS::GetReservedSlot(state, Primordials));
  args[2].set(JS::GetReservedSlot(state, PrivateSymbols));
  args[3].set(JS::GetReservedSlot(state, OrdinarySymbols));
  JS::RootedValue result(cx);
  return JS::Call(cx, receiver, callable, args, &result);
}
JSObject* ReadyContext(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject state(cx, LookupContext(cx, runtime));
  if (!state) {
    Report(cx, "Node context has not been initialized");
    return nullptr;
  }
  int phase = JS::GetReservedSlot(state, ContextPhase).toInt32();
  if (phase != Ready) {
    Report(cx, phase == Initializing ? "Reentrant Node context initialization"
                                    : "Previous Node context initialization failed");
    return nullptr;
  }
  return state;
}

}  // namespace

JSObject* EnsureRuntimeState(JSContext* cx, JS::PersistentRootedObject& owner) {
  if (owner) {
    JS::RootedObject existing(cx, owner);
    return RuntimeReady(cx, existing) ? existing.get() : nullptr;
  }
  JS::RootedObject state(cx, JS_NewObject(cx, &kRuntimeClass));
  if (!state) return nullptr;  // No identity/state published: clean retry allowed.
  PhaseOf(state, RuntimePhase, Initializing);
  owner = state;  // External embedding root; no finalizer-dependent root cycle.
  uint64_t milliseconds;
  if (!ReadGuestMonotonicMillis(cx, &milliseconds)) {
    PhaseOf(state, RuntimePhase, Failed);
    return nullptr;
  }
  JS::SetReservedSlot(state, TimerBase, JS::DoubleValue(double(milliseconds)));
  JS::RootedString description(cx, JS_NewStringCopyZ(cx, "node:per-context-exports"));
  JS::RootedSymbol key(cx);
  if (description) key = JS::NewEmbeddingPrivateSymbol(cx, description);
  if (!key) {
    PhaseOf(state, RuntimePhase, Failed);
    return nullptr;
  }
  JS::SetReservedSlot(state, ContextKey, JS::SymbolValue(key));
  for (size_t i = 0; i < std::size(kSymbols); ++i) {
    description = JS_NewStringCopyZ(cx, kSymbols[i].description);
    if (description) key = kSymbols[i].isPrivate
        ? JS::NewEmbeddingPrivateSymbol(cx, description)
        : JS::NewSymbol(cx, description);
    else key = nullptr;
    if (!key) {
      PhaseOf(state, RuntimePhase, Failed);
      return nullptr;
    }
    JS::SetReservedSlot(state, FirstSymbol + i, JS::SymbolValue(key));
  }
  PhaseOf(state, RuntimePhase, Ready);
  return state;
}

bool InitializeCurrentContext(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject global(cx, JS::CurrentGlobalOrNull(cx));
  if (!global || !RuntimeReady(cx, runtime))
    return Report(cx, "Node initialization requires a current global and ready owner");
  JS::RootedObject existing(cx, LookupContext(cx, runtime));
  if (JS_IsExceptionPending(cx)) return false;
  if (existing) {
    int phase = JS::GetReservedSlot(existing, ContextPhase).toInt32();
    return Report(cx, phase == Ready ? "Node context is already initialized"
                      : phase == Initializing ? "Reentrant Node context initialization"
                                              : "Previous Node context initialization failed");
  }
  JS::RootedObject state(cx, JS_NewObject(cx, &kContextClass));
  if (!state) return false;
  PhaseOf(state, ContextPhase, Initializing);
  JS::SetReservedSlot(state, OwningGlobal, JS::ObjectValue(*global));
  JS::RootedObject wrappedOwner(cx, runtime);
  if (!JS_WrapObject(cx, &wrappedOwner)) return false;
  JS::SetReservedSlot(state, RuntimeOwner, JS::ObjectValue(*wrappedOwner));
  JS::SetReservedSlot(state, CompletedScripts, JS::Int32Value(0));
  JS::RootedId key(cx, JS::PropertyKey::Symbol(
      JS::GetReservedSlot(runtime, ContextKey).toSymbol()));
  JS::RootedValue carrier(cx, JS::ObjectValue(*state));
  if (!JS_DefinePropertyById(cx, global, key, carrier, 0)) return false;

  // After canonical publication every failure is terminal. Do not clear or
  // replace the pending parser/JS/OOM exception while recording Failed.
  auto initialize = [&]() -> bool {
    JS::RootedObject stackState(cx, CreateErrorStackState(cx));
    if (!stackState) return false;
    JS::SetReservedSlot(state, ErrorStackState, JS::ObjectValue(*stackState));
    JS::RootedObject exports(cx, JS_NewPlainObject(cx));
    if (!exports) return false;
    JS::SetReservedSlot(state, Exports, JS::ObjectValue(*exports));
    bool hasPrimordials;
    if (!JS_HasProperty(cx, exports, "primordials", &hasPrimordials)) return false;
    // Preserve Node's CHECK on Has, including inherited properties. Do not
    // hide a broken fresh-exports invariant by overwriting an existing field.
    MOZ_RELEASE_ASSERT(!hasPrimordials, "Node per-context exports invariant");
    JS::RootedObject primordials(cx, NullTable(cx));
    if (!primordials) return false;
    JS::SetReservedSlot(state, Primordials, JS::ObjectValue(*primordials));
    if (!JS_DefineProperty(cx, exports, "primordials", primordials, JSPROP_ENUMERATE)) return false;
    JS::RootedObject privateSymbols(cx, SymbolTable(cx, runtime, true));
    if (!privateSymbols) return false;
    JS::SetReservedSlot(state, PrivateSymbols, JS::ObjectValue(*privateSymbols));
    JS::RootedObject ordinarySymbols(cx, SymbolTable(cx, runtime, false));
    if (!ordinarySymbols) return false;
    JS::SetReservedSlot(state, OrdinarySymbols, JS::ObjectValue(*ordinarySymbols));
    static const char* const scripts[] = {
        "internal/per_context/primordials", "internal/per_context/domexception",
        "internal/per_context/messageport"};
    for (size_t i = 0; i < std::size(scripts); ++i) {
      if (!CallInitializer(cx, state, scripts[i])) return false;
      JS::SetReservedSlot(state, CompletedScripts, JS::Int32Value(i + 1));
    }
    return true;
  };
  if (!initialize()) {
    PhaseOf(state, ContextPhase, Failed);
    return false;
  }
  PhaseOf(state, ContextPhase, Ready);
  return true;
}

JSObject* GetCurrentContextExports(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject state(cx, ReadyContext(cx, runtime));
  return state ? &JS::GetReservedSlot(state, Exports).toObject() : nullptr;
}

JSObject* GetCurrentContextErrorStackState(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject state(cx, LookupContext(cx, runtime));
  if (!state) return nullptr;
  // Error allocation may happen during the original context initializers or
  // after their terminal failure. The canonical state is never re-created.
  JS::Value value = JS::GetReservedSlot(state, ErrorStackState);
  return value.isObject() ? &value.toObject() : nullptr;
}

JS::Symbol* GetRuntimeSymbol(JSContext* cx, JS::HandleObject runtime, const char* name) {
  if (!RuntimeReady(cx, runtime)) return nullptr;
  for (size_t i = 0; i < std::size(kSymbols); i++) {
    if (std::strcmp(name, kSymbols[i].name) == 0)
      return JS::GetReservedSlot(runtime, FirstSymbol + i).toSymbol();
  }
  Report(cx, "Unknown native runtime symbol");
  return nullptr;
}

JSObject* CreateRuntimePrivateSymbolTable(JSContext* cx, JS::HandleObject runtime) {
  if (!RuntimeReady(cx, runtime)) return nullptr;
  JS::RootedObject table(cx, JS_NewPlainObject(cx));
  if (!table) return nullptr;
  for (size_t i = 0; i < std::size(kSymbols); i++) {
    if (!kSymbols[i].isPrivate) continue;
    JS::RootedValue value(cx, JS::GetReservedSlot(runtime, FirstSymbol + i));
    if (!JS_DefineProperty(cx, table, kSymbols[i].name, value, JSPROP_ENUMERATE)) return nullptr;
  }
  return table;
}

JSObject* CreateRuntimeSymbolsBinding(JSContext* cx, JS::HandleObject runtime) {
  if (!RuntimeReady(cx, runtime)) return nullptr;
  JS::RootedObject table(cx, JS_NewPlainObject(cx));
  if (!table) return nullptr;
  for (size_t i = 0; i < std::size(kSymbols); i++) {
    if (kSymbols[i].isPrivate) continue;
    JS::RootedValue value(cx, JS::GetReservedSlot(runtime, FirstSymbol + i));
    // Native symbols.cc exports description strings, unlike the per-context
    // initializer's C++ accessor names. Both publish the same actual symbols.
    if (!JS_DefineProperty(cx, table, kSymbols[i].description, value, JSPROP_ENUMERATE)) return nullptr;
  }
  return table;
}

JSObject* GetRuntimeExitInfo(JSContext* cx, JS::HandleObject runtime) {
  if (!RuntimeReady(cx, runtime)) return nullptr;
  JS::RootedObject array(cx);
  {
    // Allocate in the owner's realm and wrap at the boundary: a raw foreign
    // object must never become a cross-compartment reserved-slot edge.
    JSAutoRealm realm(cx, runtime);
    JS::Value value = JS::GetReservedSlot(runtime, ExitInfo);
    if (value.isObject()) array = &value.toObject();
    else {
      array = JS_NewInt32Array(cx, kExitInfoFieldCount);
      if (!array) return nullptr;
      JS::SetReservedSlot(runtime, ExitInfo, JS::ObjectValue(*array));
    }
  }
  if (!JS_WrapObject(cx, &array)) return nullptr;
  return array;
}

bool HasRuntimeTimerState(JSObject* runtime) {
  return runtime && JS::GetClass(runtime) == &kRuntimeClass &&
         JS::GetReservedSlot(runtime, TimerState).isObject();
}
JSObject* GetRuntimeTimerState(JSContext* cx, JS::HandleObject runtime, bool create) {
  if (!RuntimeReady(cx, runtime)) return nullptr;
  JS::RootedObject state(cx);
  {
    JSAutoRealm realm(cx, runtime);
    JS::Value value = JS::GetReservedSlot(runtime, TimerState);
    if (value.isObject()) state = &value.toObject();
    else if (create) {
      state = CreateRuntimeTimerState(cx, JS::GetReservedSlot(runtime, TimerBase).toNumber());
      if (!state) return nullptr;
      JS::SetReservedSlot(runtime, TimerState, JS::ObjectValue(*state));
    }
  }
  if (state && !JS_WrapObject(cx, &state)) return nullptr;
  return state;
}
bool HasRuntimeTaskState(JSObject* runtime) {
  return runtime && JS::GetClass(runtime) == &kRuntimeClass &&
         JS::GetReservedSlot(runtime, TaskState).isObject();
}
JSObject* GetRuntimeTaskState(JSContext* cx, JS::HandleObject runtime, bool create) {
  if (!RuntimeReady(cx, runtime)) return nullptr;
  JS::RootedObject state(cx);
  {
    JSAutoRealm home(cx, runtime);
    JS::Value value = JS::GetReservedSlot(runtime, TaskState);
    if (value.isObject()) state = &value.toObject();
    else if (create) {
      state = CreateRuntimeTaskState(cx);
      if (!state) return nullptr;
      JS::SetReservedSlot(runtime, TaskState, JS::ObjectValue(*state));
    }
  }
  if (state && !JS_WrapObject(cx, &state)) return nullptr;
  return state;
}
JSObject* GetRuntimeAsyncState(JSContext* cx, JS::HandleObject runtime, bool create) {
  if (!RuntimeReady(cx, runtime)) return nullptr;
  JS::RootedObject state(cx);
  {
    JSAutoRealm home(cx, runtime);
    JS::Value value = JS::GetReservedSlot(runtime, AsyncState);
    if (value.isObject()) state = &value.toObject();
    else if (create) {
      state = CreateRuntimeAsyncState(cx);
      if (!state) return nullptr;
      JS::SetReservedSlot(runtime, AsyncState, JS::ObjectValue(*state));
    }
  }
  if (state && !JS_WrapObject(cx, &state)) return nullptr;
  return state;
}
JSObject* GetRuntimeOptionsState(JSContext* cx, JS::HandleObject runtime, bool create) {
  if (!RuntimeReady(cx, runtime)) return nullptr;
  JS::RootedObject state(cx);
  {
    JSAutoRealm home(cx, runtime);
    JS::Value cached = JS::GetReservedSlot(runtime, OptionsState);
    if (cached.isObject()) state = &cached.toObject();
    else if (create) {
      state = CreateOptionsState(cx);
      if (!state) return nullptr;
      JS::SetReservedSlot(runtime, OptionsState, JS::ObjectValue(*state));
    }
  }
  if (state && !JS_WrapObject(cx, &state)) return nullptr;
  return state;
}
JSObject* GetRuntimeCodecState(JSContext* cx, JS::HandleObject runtime, bool create) {
  if (!RuntimeReady(cx, runtime)) return nullptr;
  JS::RootedObject state(cx);
  {
    JSAutoRealm home(cx, runtime);
    JS::Value cached = JS::GetReservedSlot(runtime, CodecState);
    if (cached.isObject()) state = &cached.toObject();
    else if (create) {
      state = CreateCodecState(cx);
      if (!state) return nullptr;
      JS::SetReservedSlot(runtime, CodecState, JS::ObjectValue(*state));
    }
  }
  if (state && !JS_WrapObject(cx, &state)) return nullptr;
  return state;
}

bool RegisterRuntimePrincipalRealm(JSContext* cx, JS::HandleObject runtime,
                                   JS::HandleObject realm, JS::HandleObject process) {
  if (!RuntimeReady(cx, runtime)) return false;
  JSAutoRealm home(cx, runtime);
  if (JS::GetReservedSlot(runtime, PrincipalRealm).isObject()) return true;
  JS::RootedObject wrappedRealm(cx, realm), wrappedProcess(cx, process);
  if (!JS_WrapObject(cx, &wrappedRealm) || !JS_WrapObject(cx, &wrappedProcess)) return false;
  // First successfully initialized realm is the environment's principal realm;
  // child realm bindings must not replace its process receiver or owner.
  JS::SetReservedSlot(runtime, PrincipalRealm, JS::ObjectValue(*wrappedRealm));
  JS::SetReservedSlot(runtime, PrincipalProcess, JS::ObjectValue(*wrappedProcess));
  return true;
}
JSObject* RuntimePrincipalObject(JSContext* cx, JS::HandleObject runtime, unsigned slot) {
  if (!RuntimeReady(cx, runtime)) return nullptr;
  JS::Value value = JS::GetReservedSlot(runtime, slot);
  if (!value.isObject()) { Report(cx, "Node environment has no principal realm"); return nullptr; }
  JS::RootedObject object(cx, &value.toObject());
  if (!JS_WrapObject(cx, &object)) return nullptr;
  return object;
}
JSObject* GetRuntimePrincipalRealm(JSContext* cx, JS::HandleObject runtime) {
  return RuntimePrincipalObject(cx, runtime, PrincipalRealm);
}
JSObject* GetRuntimePrincipalProcess(JSContext* cx, JS::HandleObject runtime) {
  return RuntimePrincipalObject(cx, runtime, PrincipalProcess);
}
bool ConfigureCurrentOptions(JSContext* cx, JS::HandleObject runtime, JS::HandleObject arguments, JS::HandleString environment) {
  JS::RootedObject context(cx, ReadyContext(cx, runtime)); if (!context) return false;
  JS::Value value = JS::GetReservedSlot(context, RealmLibrary);
  if (!value.isObject()) return Report(cx, "Node realm has not been initialized");
  JS::RootedObject realm(cx, &value.toObject());
  return ConfigureOptions(cx, realm, arguments, environment);
}
JSObject* InspectCurrentOptions(JSContext* cx, JS::HandleObject runtime) {
  if (!ReadyContext(cx, runtime)) return nullptr;
  return InspectOptionsState(cx, runtime);
}
JSObject* InspectCurrentTimerState(JSContext* cx, JS::HandleObject runtime) {
  if (!ReadyContext(cx, runtime)) return nullptr;
  return InspectRuntimeTimers(cx, runtime);
}

bool InitializeCurrentRealmLibrary(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject context(cx, ReadyContext(cx, runtime));
  if (!context) return false;
  JS::Value previous = JS::GetReservedSlot(context, RealmLibrary);
  if (previous.isObject()) {
    JS::RootedObject state(cx, &previous.toObject());
    return RejectRepeatedRealmLibraryInitialization(cx, state);
  }
  JS::RootedObject state(cx, AllocateRealmLibraryState(cx));
  if (!state) return false;
  // Canonical publication precedes upstream execution: a reentrant or failed
  // bootstrap must never install another owner or replace its loader closures.
  JS::SetReservedSlot(context, RealmLibrary, JS::ObjectValue(*state));
  JS::RootedObject primordials(cx, &JS::GetReservedSlot(context, Primordials).toObject());
  return RunRealmLibrary(cx, state, primordials);
}

JSObject* GetCurrentRealmLibrary(JSContext* cx, JS::HandleObject runtime, bool inspect) {
  JS::RootedObject context(cx, ReadyContext(cx, runtime));
  if (!context) return nullptr;
  JS::Value value = JS::GetReservedSlot(context, RealmLibrary);
  if (!value.isObject()) { Report(cx, "Node realm has not been initialized"); return nullptr; }
  JS::RootedObject state(cx, &value.toObject());
  return RealmLibrarySnapshot(cx, state, inspect);
}

bool RunCurrentNodeBootstrap(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject context(cx, ReadyContext(cx, runtime));
  if (!context) return false;
  JS::Value value = JS::GetReservedSlot(context, RealmLibrary);
  if (!value.isObject()) return Report(cx, "Node realm has not been initialized");
  JS::RootedObject state(cx, &value.toObject());
  return RunNodeBootstrap(cx, state);
}

JSObject* GetCurrentContextModuleWrapBinding(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject state(cx, ReadyContext(cx, runtime));
  if (!state) return nullptr;
  JS::Value cached = JS::GetReservedSlot(state, ModuleWrapBinding);
  if (cached.isObject()) return &cached.toObject();
  JS::RootedObject binding(cx, CreateModuleWrapBinding(cx, runtime));
  if (!binding) return nullptr;
  JS::SetReservedSlot(state, ModuleWrapBinding, JS::ObjectValue(*binding));
  return binding;
}

JSObject* InspectCurrentContextForTesting(JSContext* cx, JS::HandleObject runtime) {
  JS::RootedObject state(cx, LookupContext(cx, runtime));
  if (!state) {
    Report(cx, "Node context has not been initialized");
    return nullptr;
  }
  JS::RootedObject snapshot(cx, JS_NewPlainObject(cx));
  if (!snapshot) return nullptr;
  JS::RootedValue phase(cx, JS::GetReservedSlot(state, ContextPhase));
  JS::RootedValue completed(cx, JS::GetReservedSlot(state, CompletedScripts));
  if (!JS_DefineProperty(cx, snapshot, "phase", phase, JSPROP_ENUMERATE) ||
      !JS_DefineProperty(cx, snapshot, "completedScripts", completed, JSPROP_ENUMERATE)) return nullptr;
  if (phase == JS::Int32Value(Ready)) {
    for (const auto& field : {std::pair{"exports", Exports},
                             std::pair{"privateSymbols", PrivateSymbols},
                             std::pair{"perIsolateSymbols", OrdinarySymbols}}) {
      JS::RootedValue value(cx, JS::GetReservedSlot(state, field.second));
      if (!JS_DefineProperty(cx, snapshot, field.first, value, JSPROP_ENUMERATE)) return nullptr;
    }
  }
  return snapshot;
}

}  // namespace kandelo::node
