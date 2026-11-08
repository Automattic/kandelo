/* Native resource finalization ownership for the SpiderMonkey Node embedding.
 * Included in shell/js.cpp before codec-handle.cpp. Numeric destroy records
 * never run JS during GC and can safely outlive ShellContext destruction.
 * Source candidate only; no runtime conformance claim.
 */
namespace {
// Native pathname diagnostics must not invoke mutable public Buffer codecs.
// Invalid UTF-8 is decoded with replacement, while native owners retain the
// exact POSIX bytes used for the syscall.
static bool KandeloFsPathString(JSContext* cx, const char* bytes, size_t length,
                                 MutableHandleValue value) {
  size_t charsLength;
  JS::UniqueTwoByteChars chars(JS::LossyUTF8CharsToNewTwoByteCharsZ(
      cx, JS::UTF8Chars(bytes, length), &charsLength, js::MallocArena).get());
  if (!chars) return false;
  RootedString path(cx, JS_NewUCString(cx, std::move(chars), charsLength));
  if (!path) return false;
  value.setString(path); return true;
}
}  // namespace

#include "kandelo-node-callback-execution-stack.h"
#include "js/experimental/TypedData.h"
#include "native-retained-memory.h"
namespace { static kandelo::memory::AccountHandle KandeloNativeMemoryOwner(JSContext* cx); }
static bool KandeloRecoverUncaughtException(JSContext* cx);
namespace js::shell {

struct KandeloExecutionPayload {
  JS::PersistentRootedValue prior;
  JS::PersistentRootedObject resource;
  kandelo::memory::Allocation retained;
  kandelo::memory::Claim claim;
  using Info = kandelo::async::ExecutionStack<KandeloExecutionPayload>::Info;
  KandeloExecutionPayload(Info info, JSContext* cx, HandleObject entering)
      : prior(cx, cx->kandeloAsyncContext()), resource(cx, entering),
        retained(info.allocationBytes),
        claim(retained.Handle(), KandeloNativeMemoryOwner(cx)) {}
};
using KandeloExecutionStack = kandelo::async::ExecutionStack<KandeloExecutionPayload>;

struct KandeloTerminalLease;
struct KandeloNativeAsyncState;
static void KandeloShutdownTerminalLeases(KandeloNativeAsyncState* state);

struct KandeloNativeDestroyRecord { double id; bool promise; };
struct KandeloFsGcCloseRecord {
  int fd, status;
  JS::UniqueChars name;
  size_t nameLength;
  bool directory;
};

struct KandeloNativeAsyncState {
  KandeloTerminalLease* terminalLeases = nullptr;
  size_t references = 1;  // Shell owner plus each actual native resource.
  bool trackingDestroy = false;
  bool detached = false;
  bool allocationFailed = false;
  unsigned callbackDepth = 0;  // Owning-context scopes, including checkpoint jobs.
  KandeloExecutionStack execution;
  JS::PersistentRootedObject process;
  JS::PersistentRootedObject domainTrampoline;
  JS::PersistentRootedObject domainTrampolineGate;
  // Environment anchor in the process realm; foreign realm globals are weak
  // keys, so TCP prototypes do not keep otherwise-dead realms alive.
  JS::PersistentRootedObject socketPrototypes;
  JS::PersistentRootedObject terminalPrototypes;
  // Per-realm filesystem BindingData storage, weakly keyed by realm globals.
  // The process environment owns the map; native cache values own their spans.
  JS::PersistentRootedObject statfsBindings;
  // Actual per-environment suppression storage, shared with the pinned JS
  // capture functions. Never retain a movable data pointer across JS or GC.
  JS::PersistentRootedObject uncaughtCaptureToggle;
  bool abortOnUncaughtException = false;
  bool handlingUncaught = false;
  Vector<KandeloNativeDestroyRecord, 0, SystemAllocPolicy> destroyIds;
  Vector<KandeloNativeDestroyRecord, 0, SystemAllocPolicy> retryIds;
  Vector<KandeloFsGcCloseRecord, 0, SystemAllocPolicy> fsGcCloses;
  size_t fsGcCursor = 0;
  mozilla::Maybe<KandeloFsGcCloseRecord> fsGcRetry;
  void FsGcClosed(int fd, int status, JS::UniqueChars name, size_t length, bool directory = false) {
    if (detached) return;
    if (!fsGcCloses.append(KandeloFsGcCloseRecord{fd, status, std::move(name), length, directory}))
      allocationFailed = true;
  }

  void Retain() { ++references; }
  void Release() {
    MOZ_RELEASE_ASSERT(references);
    if (--references == 0) js_delete(this);
  }
  bool Queue(double id, bool promise = false) {
    if (id < 0 || detached || !trackingDestroy) return true;
    return destroyIds.append(KandeloNativeDestroyRecord{id, promise});
  }
  void Finalized(double id) {
    // Foreground native class finalizers run on their owning runtime thread.
    // The shell may already be detached during JSContext/runtime destruction.
    if (!Queue(id)) allocationFailed = true;
  }
};

static KandeloNativeAsyncState* KandeloGetNativeAsyncState(JSContext* cx) {
  auto* sc = GetShellContext(cx);
  if (!sc->kandeloNativeAsync) {
    sc->kandeloNativeAsync = js_new<KandeloNativeAsyncState>();
    if (!sc->kandeloNativeAsync) JS_ReportOutOfMemory(cx);
    else {
      // Pinned Environment clears this option when it does not own process
      // state. Actual Worker shell kind is native authority, not a JS flag.
      sc->kandeloNativeAsync->abortOnUncaughtException =
          !sc->isWorker && gKandeloAbortOnUncaughtException;
    }
  }
  return sc->kandeloNativeAsync;
}

// Existing state only: engine reads never allocate a new async environment.
static bool KandeloReadExecutionIds(JSContext* cx, double* id, double* trigger) {
  auto* state = GetShellContext(cx)->kandeloNativeAsync;
  if (!state || state->detached) return false;
  *id = state->execution.Id(); *trigger = state->execution.Trigger(); return true;
}
static uint64_t KandeloReadExecutionEpoch(JSContext* cx) {
  auto* state = GetShellContext(cx)->kandeloNativeAsync;
  return state ? state->execution.Epoch() : 0;
}
static bool KandeloNativePushAsyncExecution(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isNumber() || !args.get(1).isNumber() || !args.get(2).isObject()) {
    JS_ReportErrorASCII(cx, "Async execution requires numeric IDs and an actual resource"); return false;
  }
  auto* state = KandeloGetNativeAsyncState(cx); if (!state) return false;
  RootedObject resource(cx, &args[2].toObject());
  try {
    state->execution.PushScope(args[0].toNumber(), args[1].toNumber(),
        args.get(3).isTrue() ? KandeloExecutionStack::Owner::NativeScope :
                            KandeloExecutionStack::Owner::JavaScriptScope,
        cx, resource);
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  args.rval().setUndefined(); return true;
}
static bool KandeloNativePopAsyncExecution(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = GetShellContext(cx)->kandeloNativeAsync;
  if (!state || !args.get(0).isNumber()) {
    JS_ReportErrorASCII(cx, "Async execution pop requires its actual ID"); return false;
  }
  const auto popped = state->execution.Pop(args[0].toNumber(), [&](const auto& entry) {
    args.rval().set(entry.prior);
  });
  if (popped == KandeloExecutionStack::PopResult::WrongId) {
    JS_ReportErrorASCII(cx, "Async execution stack is corrupted"); return false;
  }
  if (popped == KandeloExecutionStack::PopResult::Empty) args.rval().setUndefined();
  return JS_WrapValue(cx, args.rval());
}
static bool KandeloNativeClearAsyncExecution(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = GetShellContext(cx)->kandeloNativeAsync;
  if (state) state->execution.Clear();
  cx->kandeloAsyncContext() = UndefinedValue();
  args.rval().setUndefined(); return true;
}
static bool KandeloNativeAsyncExecutionId(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); double id = 0, trigger = 0;
  KandeloReadExecutionIds(cx, &id, &trigger); args.rval().setNumber(id); return true;
}
static bool KandeloNativeAsyncTriggerId(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); double id = 0, trigger = 0;
  KandeloReadExecutionIds(cx, &id, &trigger); args.rval().setNumber(trigger); return true;
}
static bool KandeloNativeHasAsyncExecution(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = GetShellContext(cx)->kandeloNativeAsync;
  args.rval().setBoolean(state && !state->execution.Empty()); return true;
}
static bool KandeloNativeAsyncExecutionResource(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = GetShellContext(cx)->kandeloNativeAsync;
  if (state && state->execution.Top()) args.rval().setObject(*state->execution.Top()->resource);
  else args.rval().setUndefined();
  return JS_WrapValue(cx, args.rval());
}
static bool KandeloNativeSetDomainTrampoline(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject() || !JS::IsCallable(&args[0].toObject()) ||
      !args.get(1).isObject() || !JS::IsCallable(&args[1].toObject())) {
    JS_ReportErrorASCII(cx, "Domain trampoline requires its actual callback and hook predicate");return false;
  }
  auto* state = KandeloGetNativeAsyncState(cx);if (!state) return false;
  if (!state->domainTrampoline.initialized()) state->domainTrampoline.init(cx);
  if (!state->domainTrampolineGate.initialized()) state->domainTrampolineGate.init(cx);
  state->domainTrampoline = &args[0].toObject();state->domainTrampolineGate = &args[1].toObject();
  args.rval().setUndefined();return true;
}
static bool KandeloNativeSetUncaughtProcess(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) { JS_ReportErrorASCII(cx, "Uncaught owner requires the actual process"); return false; }
  auto* state = KandeloGetNativeAsyncState(cx); if (!state) return false;
  if (!state->process.initialized()) state->process.init(cx);
  state->process = &args[0].toObject();
  args.rval().setUndefined(); return true;
}

// The real private Uint32Array is rooted by the environment and consumed
// directly by native fatal admission. It is not a copied support indicator.
static bool KandeloNativeUncaughtCaptureToggle(JSContext* cx, unsigned argc,
                                               Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = KandeloGetNativeAsyncState(cx); if (!state) return false;
  if (state->detached) { JS_ReportErrorASCII(cx, "Capture environment is retired"); return false; }
  if (!state->uncaughtCaptureToggle.initialized()) {
    RootedObject toggle(cx, JS_NewUint32Array(cx, 1)); if (!toggle) return false;
    {
      JS::AutoCheckCannotGC nogc; bool shared;
      auto* data = JS_GetUint32ArrayData(toggle, &shared, nogc);
      MOZ_RELEASE_ASSERT(data && !shared);
      data[0] = 1;
    }
    state->uncaughtCaptureToggle.init(cx, toggle);
  }
  RootedObject toggle(cx, state->uncaughtCaptureToggle);
  if (!JS_WrapObject(cx, &toggle)) return false;
  args.rval().setObject(*toggle); return true;
}
static bool KandeloShouldAbortOnUncaught(JSContext* cx) {
  auto* state = GetShellContext(cx)->kandeloNativeAsync;
  if (!state || state->detached || !state->abortOnUncaughtException) return false;
  // Before capture registration, ordinary uncaught exceptions are unsuppressed.
  if (!state->uncaughtCaptureToggle.initialized()) return true;
  RootedObject toggle(cx, state->uncaughtCaptureToggle);
  JSAutoRealm realm(cx, toggle);
  JS::AutoCheckCannotGC nogc; bool shared;
  MOZ_RELEASE_ASSERT(JS_IsUint32Array(toggle) && JS_GetTypedArrayLength(toggle) == 1);
  const auto* data = JS_GetUint32ArrayData(toggle, &shared, nogc);
  MOZ_RELEASE_ASSERT(data && !shared);
  return data[0] != 0;
}

static bool KandeloFsGcErrorsPending(JSContext* cx) {
  auto* state = GetShellContext(cx)->kandeloNativeAsync;
  if (!state) return false;
  if (state->allocationFailed) return true;
  // A successful Dir GC-close warning is an unreferenced native immediate.
  // FileHandle GC closes and failed closes retain the fatal delivery owner.
  auto referenced = [](const KandeloFsGcCloseRecord& record) {
    return !record.directory || record.status < 0;
  };
  if (state->fsGcRetry && referenced(*state->fsGcRetry)) return true;
  for (size_t i = state->fsGcCursor; i < state->fsGcCloses.length(); ++i)
    if (referenced(state->fsGcCloses[i])) return true;
  return false;
}

static bool KandeloNativePeekFsGcClose(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = GetShellContext(cx)->kandeloNativeAsync;
  if (state && state->allocationFailed) { JS_ReportOutOfMemory(cx); return false; }
  if (!state || (!state->fsGcRetry && state->fsGcCursor == state->fsGcCloses.length())) {
    args.rval().setNull(); return true;
  }
  if (!state->fsGcRetry) {
    state->fsGcRetry.emplace(std::move(state->fsGcCloses[state->fsGcCursor++]));
    if (state->fsGcCursor == state->fsGcCloses.length()) {
      state->fsGcCloses.clear(); state->fsGcCursor = 0;
    }
  }
  // This retry slot remains owning while allocations can finalize more handles
  // and grow the pending vector. Ack only after JS has scheduled the immediate.
  auto& record = *state->fsGcRetry;
  RootedValue name(cx);
  if (!KandeloFsPathString(cx, record.name ? record.name.get() : "", record.nameLength, &name)) return false;
  JS::RootedValueArray<4> fields(cx);
  fields[0].setInt32(record.fd); fields[1].setInt32(record.status); fields[2].set(name);
  fields[3].setBoolean(record.directory);
  RootedObject array(cx, JS::NewArrayObject(cx, fields));
  if (!array) return false;
  if (state->allocationFailed) { JS_ReportOutOfMemory(cx); return false; }
  args.rval().setObject(*array); return true;
}
static bool KandeloNativeAckFsGcClose(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = GetShellContext(cx)->kandeloNativeAsync;
  if (!state || !state->fsGcRetry) {
    JS_ReportErrorASCII(cx, "No filesystem GC-close record is awaiting acknowledgement"); return false;
  }
  state->fsGcRetry.reset(); args.rval().setUndefined(); return true;
}

static bool KandeloNativeSetDestroyTracking(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isBoolean()) {
    JS_ReportErrorASCII(cx, "Native destroy tracking requires a boolean");
    return false;
  }
  auto* state = KandeloGetNativeAsyncState(cx);
  if (!state) return false;
  state->trackingDestroy = args[0].toBoolean();
  args.rval().setUndefined();
  return true;
}

static bool KandeloNativeDrainDestroyIds(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto* state = GetShellContext(cx)->kandeloNativeAsync;
  if (state && state->allocationFailed) {
    // An allocation failure is not an empty/successful destroy batch.
    JS_ReportOutOfMemory(cx);
    return false;
  }
  // Move numeric records before JS allocation can trigger more finalizers.
  // Newly finalized resources append to the next batch, not this iteration.
  Vector<KandeloNativeDestroyRecord, 0, SystemAllocPolicy> pending;
  if (state) pending = std::move(state->retryIds.empty() ? state->destroyIds : state->retryIds);
  bool delivered = false;
  auto retry = mozilla::MakeScopeExit([&] {
    if (!delivered && state) state->retryIds = std::move(pending);
  });
  RootedObject result(cx, JS::NewArrayObject(cx, pending.length()));
  if (!result) return false;
  for (size_t i = 0; i < pending.length(); ++i) {
    JS::RootedValueArray<2> fields(cx);
    fields[0].setNumber(pending[i].id);
    fields[1].setBoolean(pending[i].promise);
    RootedObject entry(cx, JS::NewArrayObject(cx, fields));
    if (!entry || !JS_DefineElement(cx, result, i, entry, JSPROP_ENUMERATE)) return false;
  }
  if (state && state->allocationFailed) { JS_ReportOutOfMemory(cx); return false; }
  args.rval().setObject(*result);
  delivered = true;
  return true;
}

static bool KandeloNativeEnqueueDestroyId(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isNumber() || !args.get(1).isBoolean()) {
    JS_ReportErrorASCII(cx, "Native destroy queue requires an ID and Promise flag");
    return false;
  }
  auto* state = KandeloGetNativeAsyncState(cx);
  if (!state) return false;
  if (!state->Queue(args[0].toNumber(), args[1].toBoolean())) {
    JS_ReportOutOfMemory(cx);
    return false;
  }
  args.rval().setUndefined();
  return true;
}

static void KandeloShutdownNativeAsync(ShellContext* sc) {
  auto* state = sc->kandeloNativeAsync;
  if (!state) return;
  MOZ_RELEASE_ASSERT(state->callbackDepth == 0);
  KandeloShutdownTerminalLeases(state);
  sc->kandeloNativeAsync = nullptr;
  state->detached = true;
  state->trackingDestroy = false;
  state->execution.Clear();
  state->socketPrototypes.reset();
  state->terminalPrototypes.reset();
  state->statfsBindings.reset();
  state->domainTrampoline.reset();
  state->domainTrampolineGate.reset();
  state->uncaughtCaptureToggle.reset();
  state->abortOnUncaughtException = false;
  state->process.reset();
  state->destroyIds.clearAndFree();
  state->retryIds.clearAndFree();
  state->fsGcRetry.reset();
  state->fsGcCloses.clearAndFree();
  state->fsGcCursor = 0;
  state->Release();  // Actual resources can finalize after the shell is gone.
}
}  // namespace js::shell
