/* Actual per-Worker thread/context/packet lifetime. Native shared owners contain
 * no parent JS roots. Child bootstrap and per-owner join complete before exit.
 */
#include <atomic>
#include <map>
#include <mutex>
#include <vector>

namespace {
struct KandeloWorkerControl {
  JSRuntime* parentRuntime;
  uint64_t id;
  uint32_t gcBudget;
  std::mutex mutex;
  JSContext* child = nullptr;
  std::atomic<bool> stopping{false}, ready{false}, finished{false};
  bool referenced = true, joined = false, abandoned = false;
  int exitCode = 1;
  const char* failure = nullptr;
  unsigned secondaryErrors = 0;
  KandeloPortPacketHandle bootstrap, input, error;
  std::shared_ptr<KandeloPortEndpoint> parentPort, childPort;
  js::UniquePtr<js::Thread> thread;
  KandeloWorkerControl(JSRuntime* runtime, uint64_t identity, uint32_t budget)
      : parentRuntime(runtime), id(identity), gcBudget(budget) {}
  void Stop() {
    stopping.store(true);
    std::lock_guard<std::mutex> lock(mutex);
    if (child) JS_RequestInterruptCallback(child);
  }
  void Join() {
    if (!joined && thread) { thread->join(); joined = true; thread.reset(); }
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
    auto packet = std::make_shared<KandeloPortPacket>();
    if (packet->content->data.write(cx, error, UndefinedHandleValue, KandeloMessageClonePolicy())) {
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
    if ((*it)->abandoned && (*it)->finished.load()) { (*it)->Join(); it = children.erase(it); }
    else ++it;
  }
  for (const auto& child : found->second) if (child->referenced) return true;
  return false;
}
static void KandeloShutdownWorkers(JSContext* cx) {
  const auto found = kandeloWorkerChildren.find(cx);
  if (found == kandeloWorkerChildren.end()) return;
  for (const auto& child : found->second) child->Stop();
  for (const auto& child : found->second) child->Join();
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
  if (!strcmp(operation.get(), "environment") || !strcmp(operation.get(), "data")) {
    if (!kandeloCurrentWorker) { args.rval().setNull(); return true; }
    const bool bootstrap = !strcmp(operation.get(), "environment");
    auto input = bootstrap ? std::move(kandeloCurrentWorker->bootstrap) : std::move(kandeloCurrentWorker->input);
    if (!input) { JS_ReportErrorASCII(cx, "Worker environment already consumed"); return false; }
    if (input->consumed.exchange(true)) return cx->reportKandeloCloneError("Worker input already consumed");
    input->AdoptMemory(KandeloNativeMemoryOwner(cx));
    auto clear = mozilla::MakeScopeExit([&] { input->ClearContent(); KandeloFlushNativeMemory(cx); });
    RootedValue config(cx);
    if (!KandeloReadMessage(cx, input->content.get(), &config) || !config.isObject()) return false;
    if (!bootstrap) { args.rval().set(config); return true; }
    RootedObject object(cx, &config.toObject());
    RootedValue port(cx);
    if (!KandeloPortNew(cx, kandeloCurrentWorker->childPort, &port) ||
        !JS_DefineProperty(cx, object, "parentHandle", port, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, object, "threadId", double(kandeloCurrentWorker->id), JSPROP_ENUMERATE)) return false;
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
    if (packet->enqueued.exchange(true) || packet->consumed.load())
      return cx->reportKandeloCloneError("Worker input already published or consumed");
    if (bootstrap->enqueued.exchange(true) || bootstrap->consumed.load())
      return cx->reportKandeloCloneError("Worker bootstrap already published or consumed");
    auto owner = std::make_shared<KandeloWorkerControl>(JS_GetParentRuntime(cx), kandeloWorkerNextId.fetch_add(1), JS_GetGCParameter(cx, JSGC_MAX_BYTES));
    owner->input = std::move(packet);
    owner->bootstrap = std::move(bootstrap);
    owner->input->ReleaseMemory(); owner->bootstrap->ReleaseMemory();
    KandeloFlushNativeMemory(cx);
    auto pair = KandeloPortEndpoint::Pair(); owner->parentPort = pair.first; owner->childPort = pair.second;
    // Public Worker ref state owns liveness. Its private parent port never
    // independently keeps an unreferenced Worker alive in the parent loop.
    owner->parentPort->Ref(false); owner->childPort->Ref(false);
    auto handle = std::make_unique<KandeloWorkerHandle>(KandeloWorkerHandle{cx, owner});
    RootedObject wrapper(cx, JS_NewObject(cx, &KandeloWorkerClass));
    RootedObject result(cx, JS_NewPlainObject(cx)); RootedValue port(cx);
    if (!wrapper || !result || !KandeloPortNew(cx, owner->parentPort, &port)) return false;
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
    args.rval().setObject(*result); return true;
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
    owner->error.reset(); handle->owner.reset(); args.rval().setUndefined(); return true;
  }
  JS_ReportErrorASCII(cx, "Unknown Worker operation"); return false;
}
static bool KandeloNativeWorker(JSContext* cx, unsigned argc, Value* vp) {
  try { return KandeloWorkerDispatch(cx, argc, vp); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
}  // namespace
