/* Actual per-Worker thread/context/packet lifetime. Native shared owners contain
 * no parent JS roots. Child bootstrap and per-owner join complete before exit.
 */
#include "kandelo-node-worker-startup-owner.h"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <map>
#include <mutex>
#include <system_error>
#include <vector>
#include "vm/ArrayObject.h"

namespace {
static bool KandeloPrepareWorkerExecArgv(JSContext*,HandleValue,HandleObject,
                                        bool,HandleValue,MutableHandleValue);
struct KandeloWorkerControl {
  JSRuntime* parentRuntime;
  uint64_t id;
  uint32_t gcBudget;
  std::mutex mutex;
  kandelo::worker::StartupGate<KandeloPortPacketHandle> startup;
  JSContext* child = nullptr;
  std::atomic<bool> stopping{false}, ready{false}, finished{false};
  bool referenced = true, joined = false, abandoned = false;
  int exitCode = 1;
  const char* failure = nullptr;
  unsigned secondaryErrors = 0;
  KandeloPortPacketHandle error;
  KandeloPortEndpointOwner parentPort, childPort;
  js::UniquePtr<js::Thread> thread;
  KandeloWorkerControl(JSRuntime* runtime, uint64_t identity, uint32_t budget)
      : parentRuntime(runtime), id(identity), gcBudget(budget) {}
  void Stop() {
    stopping.store(true);
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (child) JS_RequestInterruptCallback(child);
    }
    // A real child can be alive with no LOAD_SCRIPT packet. Wake that native
    // publication gate as well as interrupting an executing JS context.
    startup.Stop();
  }
  void Join() {
    if (!joined && thread) { thread->join(); joined = true; thread.reset(); }
  }
  void RetireTransport() noexcept {
    parentPort.reset(); childPort.reset();
    startup.Clear([](auto& packet) {
      if (packet) { packet->consumed.store(true); packet->ClearContent(); }
    });
    error.reset();
  }
};
using KandeloWorkerOwner = std::shared_ptr<KandeloWorkerControl>;
static std::atomic<uint64_t> kandeloWorkerNextId{1};
static thread_local KandeloWorkerOwner kandeloCurrentWorker;
static thread_local std::map<JSContext*, std::vector<KandeloWorkerOwner>> kandeloWorkerChildren;
static void KandeloNodeWorkerMain(KandeloWorkerOwner input);
static void KandeloCaptureWorkerException(JSContext* cx) {
  if (!kandeloCurrentWorker || !JS_IsExceptionPending(cx)) return;
  auto& owner = kandeloCurrentWorker;
  if (owner->error || owner->failure) { owner->secondaryErrors++; JS_ClearPendingException(cx); return; }
  GetShellContext(cx)->exitCode = 1;
  RootedValue error(cx);
  if (!JS_GetPendingException(cx, &error)) {
    JS_ClearPendingException(cx); owner->failure = "Worker exception could not be read"; return;
  }
  JS_ClearPendingException(cx);
  try {
    auto packet = KandeloNewPortPacket();
    if (!packet) { owner->failure = "Worker error ownership was retired"; return; }
    KandeloMessageWriteOutcome outcome(cx);
    // The existing worker-error fallback owns unsuccessful serialization;
    // sender exception roots must never be retained in a cross-thread packet.
    if (KandeloWriteMessageData(cx, packet.get(), error, UndefinedHandleValue, outcome) &&
        !outcome.noResult && !outcome.hasDeferred) {
      packet->content->AccountMemory(); packet->AdoptMemory(KandeloNativeMemoryOwner(cx));
      KandeloFlushNativeMemory(cx); owner->error = std::move(packet);
    }
    else { JS_ClearPendingException(cx); owner->failure = "Worker exception could not be cloned"; }
  } catch (...) { JS_ClearPendingException(cx); owner->failure = "Worker exception allocation failed"; }
}

static bool KandeloWorkersHaveReferences(JSContext* cx) {
  const auto found = kandeloWorkerChildren.find(cx);
  if (found == kandeloWorkerChildren.end()) return false;
  auto& children = found->second;
  for (auto it = children.begin(); it != children.end();) {
    if ((*it)->abandoned && (*it)->finished.load()) { (*it)->Join(); (*it)->RetireTransport(); it = children.erase(it); }
    else ++it;
  }
  for (const auto& child : found->second) if (child->referenced) return true;
  return false;
}
static void KandeloShutdownWorkers(JSContext* cx) {
  const auto found = kandeloWorkerChildren.find(cx);
  if (found == kandeloWorkerChildren.end()) return;
  for (const auto& child : found->second) child->Stop();
  for (const auto& child : found->second) { child->Join(); child->RetireTransport(); }
  kandeloWorkerChildren.erase(found);
}
static bool KandeloWorkerInterrupt(JSContext* cx) {
  if (!kandeloCurrentWorker || !kandeloCurrentWorker->stopping.load()) return true;
  ShellContext* sc = GetShellContext(cx);
  sc->quitting = true; sc->exitCode = 1;
  JS::ReportUncatchableException(cx);
  return false;
}
struct KandeloWorkerHandle { JSContext* parent; KandeloWorkerOwner owner; };
static void KandeloWorkerFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (!slot.isUndefined()) delete static_cast<KandeloWorkerHandle*>(slot.toPrivate());
}
static const JSClassOps KandeloWorkerClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloWorkerFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloWorkerClass = {"KandeloWorkerOwner",
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloWorkerClassOps};
static KandeloWorkerHandle* KandeloWorkerGet(JSContext* cx, HandleValue value) {
  if (!value.isObject() || JS::GetClass(&value.toObject()) != &KandeloWorkerClass) {
    JS_ReportErrorASCII(cx, "Invalid native Worker owner"); return nullptr;
  }
  const auto slot = JS::GetReservedSlot(&value.toObject(), 0);
  auto* handle = slot.isUndefined() ? nullptr : static_cast<KandeloWorkerHandle*>(slot.toPrivate());
  if (!handle || !handle->owner || handle->parent != cx) {
    JS_ReportErrorASCII(cx, "Worker owner belongs to a different context"); return nullptr;
  }
  return handle;
}
static bool KandeloWorkerDispatch(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  UniqueChars operation;
  RootedValue operationValue(cx, args.get(0));
  if (!KandeloGetString(cx, operationValue, &operation)) return false;
  if (!strcmp(operation.get(), "execArgv")) {
    if (!args.get(2).isObject()) { JS_ReportErrorASCII(cx,"Worker CLI environment is unavailable");return false; }
    RootedObject environment(cx,&args[2].toObject());
    return KandeloPrepareWorkerExecArgv(cx,args.get(1),environment,args.get(3).isTrue(),args.get(4),args.rval());
  }
  if (!strcmp(operation.get(), "environment") || !strcmp(operation.get(), "data")) {
    if (!kandeloCurrentWorker) { args.rval().setNull(); return true; }
    const bool bootstrap = !strcmp(operation.get(), "environment");
    KandeloPortPacketHandle input;
    auto& owner = kandeloCurrentWorker;
    using Startup = kandelo::worker::StartupGate<KandeloPortPacketHandle>;
    const auto read = owner->startup.Take(bootstrap, &input, [&] { return js::CheckForInterrupt(cx); });
    if (read == Startup::Read::Interrupted) return false;
    if (read == Startup::Read::Stopped) {
      if (!KandeloWorkerInterrupt(cx)) return false;
      JS_ReportErrorASCII(cx, "Worker startup was retired"); return false;
    }
    if (read == Startup::Read::Repeated) {
      JS_ReportErrorASCII(cx, "Worker startup slot already consumed"); return false;
    }
    if (!input || input->noResult || !input->content) {
      JS_ReportErrorASCII(cx, "Worker startup material is unavailable"); return false;
    }
    if (input->consumed.exchange(true)) return cx->reportKandeloCloneError("Worker input already consumed");
    input->AdoptMemory(KandeloNativeMemoryOwner(cx));
    auto clear = mozilla::MakeScopeExit([&] { input->ClearContent(); KandeloFlushNativeMemory(cx); });
    RootedValue config(cx);
    if (!KandeloReadMessage(cx, input->content.get(), &config)) return false;
    if (!config.isObject()) { JS_ReportErrorASCII(cx, "Worker startup record is not an object"); return false; }
    if (!bootstrap) { args.rval().set(config); return true; }
    RootedObject object(cx, &config.toObject());
    RootedValue port(cx);
    if (!KandeloPortNew(cx, kandeloCurrentWorker->childPort, &port) ||
        !JS_DefineProperty(cx, object, "parentHandle", port, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, object, "threadId", double(kandeloCurrentWorker->id), JSPROP_ENUMERATE)) return false;
    kandeloCurrentWorker->childPort.reset();
    args.rval().setObject(*object); return true;
  }
  if (!strcmp(operation.get(), "ready")) {
    if (!kandeloCurrentWorker) { JS_ReportErrorASCII(cx, "No current Worker owner"); return false; }
    kandeloCurrentWorker->ready.store(true); args.rval().setUndefined(); return true;
  }
  if (!strcmp(operation.get(), "create")) {
    if (!CanUseExtraThreads()) { JS_ReportErrorASCII(cx, "Worker threads are disabled in this engine"); return false; }
    auto packet = KandeloPortPacketOwner(cx, args.get(1));
    auto bootstrap = KandeloPortPacketOwner(cx, args.get(2));
    if (!packet || !bootstrap) return false;
    // Admit both real source-local boxes completely before changing state or
    // consuming saved exceptions. No JS call occurs between this and retirement.
    if (packet.get() == bootstrap.get() || packet->enqueued.load() || packet->consumed.load() ||
        bootstrap->enqueued.load() || bootstrap->consumed.load())
      return cx->reportKandeloCloneError("Worker startup already published or consumed");
    if ((!packet->noResult && !packet->content) || (!bootstrap->noResult && !bootstrap->content))
      return cx->reportKandeloCloneError("Worker startup material is unavailable");
    KandeloMessageCallerOutcome outcome(cx), metadataOutcome(cx);
    outcome.Take(args.get(1)); metadataOutcome.Take(args.get(2));
    KandeloWorkerOwner owner;
    bool launched = false;
    auto releaseBoxes = mozilla::MakeScopeExit([&] {
      if (!launched && owner) owner->RetireTransport();
      if (!launched) {
        if (packet) { packet->consumed.store(true); packet->ClearContent(); }
        if (bootstrap) { bootstrap->consumed.store(true); bootstrap->ClearContent(); }
      }
      KandeloReleasePortPacketBox(args.get(1)); KandeloReleasePortPacketBox(args.get(2));
    });
    // Native env/CLI metadata contains no user host graph; reject neither a
    // missing LOAD nor its valid undefined outcome as fabricated default data.
    if (metadataOutcome.deferred) return metadataOutcome.Finish();
    if (outcome.deferred) return outcome.Finish();
    owner = std::make_shared<KandeloWorkerControl>(JS_GetParentRuntime(cx), kandeloWorkerNextId.fetch_add(1), JS_GetGCParameter(cx, JSGC_MAX_BYTES));
    const bool dropped = packet->noResult || bootstrap->noResult;
    if (packet->noResult) { packet->consumed.store(true); packet->ClearContent(); packet.reset(); }
    if (bootstrap->noResult) {
      bootstrap->consumed.store(true); bootstrap->ClearContent(); bootstrap.reset();
      // Defensive metadata admission: no null packet content enters a reader.
      // Publish neither slot when actual early metadata was not produced.
      if (packet) { packet->consumed.store(true); packet->ClearContent(); packet.reset(); }
    }
    if (packet) { packet->ReleaseMemory(); packet->enqueued.store(true); }
    if (bootstrap) { bootstrap->ReleaseMemory(); bootstrap->enqueued.store(true); }
    if (!owner->startup.Publish(std::move(bootstrap), std::move(packet))) {
      JS_ReportErrorASCII(cx, "Worker startup publication was retired"); return false;
    }
    KandeloFlushNativeMemory(cx);
    auto pair = KandeloPortEndpoint::Pair(); owner->parentPort = pair.first; owner->childPort = pair.second;
    // The startup message also owns its public child endpoint. If no load was
    // published, retire that peer while the private LOAD gate stays pending.
    if (dropped) owner->childPort->Abandon();
    // Public Worker ref state owns liveness. Its private parent port never
    // independently keeps an unreferenced Worker alive in the parent loop.
    owner->parentPort->Ref(false); owner->childPort->Ref(false);
    auto handle = std::make_unique<KandeloWorkerHandle>(KandeloWorkerHandle{cx, owner});
    RootedObject wrapper(cx, JS_NewObject(cx, &KandeloWorkerClass));
    RootedObject result(cx, JS_NewPlainObject(cx)); RootedValue port(cx);
    if (!wrapper || !result || !KandeloPortNew(cx, owner->parentPort, &port)) return false;
    owner->parentPort.reset();
    JS::SetReservedSlot(wrapper, 0, PrivateValue(handle.release()));
    if (!JS_DefineProperty(cx, result, "handle", wrapper, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, result, "port", port, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, result, "threadId", double(owner->id), JSPROP_ENUMERATE)) return false;
    owner->thread = js::MakeUnique<js::Thread>(js::Thread::Options().setStackSize(
        2 * 128 * sizeof(size_t) * 1024 + 512 * 1024));
    if (!owner->thread) { JS_ReportOutOfMemory(cx); return false; }
    auto& children = kandeloWorkerChildren[cx]; children.push_back(owner);
    if (!owner->thread->init(KandeloNodeWorkerMain, owner)) {
      children.pop_back(); owner->thread.reset();
      JS_ReportErrorASCII(cx, "Could not start guest Worker thread"); return false;
    }
    launched = true; args.rval().setObject(*result); return true;
  }
  auto* handle = KandeloWorkerGet(cx, args.get(1)); if (!handle) return false;
  auto owner = handle->owner;
  if (!strcmp(operation.get(), "abandon")) {
    owner->abandoned = true; owner->referenced = false; owner->Stop();
    args.rval().setUndefined(); return true;
  }
  if (!strcmp(operation.get(), "stop")) { owner->Stop(); args.rval().setUndefined(); return true; }
  if (!strcmp(operation.get(), "ref")) {
    owner->referenced = args.get(2).isBoolean() && args.get(2).toBoolean();
    args.rval().setUndefined(); return true;
  }
  if (!strcmp(operation.get(), "status")) {
    const bool finished = owner->finished.load();
    if (finished) owner->Join();
    RootedObject result(cx, JS_NewPlainObject(cx));
    RootedValue ready(cx, BooleanValue(owner->ready.load()));
    RootedValue done(cx, BooleanValue(finished));
    if (!result || !JS_DefineProperty(cx, result, "ready", ready, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, result, "done", done, JSPROP_ENUMERATE)) return false;
    if (finished) {
      if (!JS_DefineProperty(cx, result, "exitCode", owner->exitCode, JSPROP_ENUMERATE)) return false;
      if (owner->failure) {
        RootedString message(cx, JS_NewStringCopyZ(cx, owner->failure));
        if (!message || !JS_DefineProperty(cx, result, "failure", message, JSPROP_ENUMERATE)) return false;
      }
      if (owner->error) {
        RootedValue error(cx);
        if (!KandeloPortPacketObject(cx, owner->error, &error) ||
            !JS_DefineProperty(cx, result, "errorPacket", error, JSPROP_ENUMERATE)) return false;
      }
    }
    args.rval().setObject(*result); return true;
  }
  if (!strcmp(operation.get(), "release")) {
    if (!owner->finished.load()) { JS_ReportErrorASCII(cx, "Worker retirement still pending"); return false; }
    owner->Join();
    auto& children = kandeloWorkerChildren[cx];
    children.erase(std::remove(children.begin(), children.end(), owner), children.end());
    owner->RetireTransport(); handle->owner.reset(); args.rval().setUndefined(); return true;
  }
  JS_ReportErrorASCII(cx, "Unknown Worker operation"); return false;
}
static bool KandeloNativeWorker(JSContext* cx, unsigned argc, Value* vp) {
  try { return KandeloWorkerDispatch(cx, argc, vp); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  catch (const std::system_error& error) {
    JS_ReportErrorASCII(cx, "Worker native wait failed: %s", error.what()); return false;
  }
}
}  // namespace
