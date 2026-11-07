// Included after histogram-native.cpp and before histogram-clone.cpp. Actual
// native loop phases own sampling; no JS timer or callback produces samples.
#include "event-loop-delay.h"
#include <optional>
#include "histogram-owner-inl.h"
namespace {
using kandelo::histogram::EventLoopDelayLoop;
using kandelo::histogram::EventLoopDelayProducer;
enum KandeloELDSlot { KandeloELDStateSlot, KandeloELDMaterialSlot, KandeloELDFrameSlot, KandeloELDSlots };
struct KandeloELDState;
using KandeloELDCloseQueue = kandelo::histogram::ELDCloses<KandeloELDState>;
struct KandeloELDState : kandelo::histogram::ELDRetained<KandeloELDState> {
  std::shared_ptr<EventLoopDelayProducer> producer;
  kandelo::memory::Claim producerClaim, histogramClaim;
  js::shell::KandeloNativeAsyncState* lifetime = nullptr;
  double id = -1, trigger = -1;
  bool retired = false;
  std::weak_ptr<KandeloELDCloseQueue> closeQueue;
  std::shared_ptr<KandeloELDState> nextClosing;
  KandeloELDState(std::shared_ptr<EventLoopDelayProducer> sampler,
                  const kandelo::memory::AccountHandle& account)
      : ELDRetained(account), producer(std::move(sampler)),
        producerClaim(producer->RetainedAllocation(), account),
        histogramClaim(producer->histogram()->RetainedAllocation(), account) {}
  void Retire() noexcept {
    if (retired) return;
    retired = true; producer->Close();
    if (lifetime && id >= 0) lifetime->Finalized(id);
  }
  ~KandeloELDState() { Retire(); if (lifetime) lifetime->Release(); }
};
struct KandeloELDHandle : kandelo::histogram::ELDRetained<KandeloELDHandle> {
  std::shared_ptr<KandeloELDState> state;
  KandeloELDHandle(std::shared_ptr<KandeloELDState> owner,
                   const kandelo::memory::AccountHandle& account)
      : ELDRetained(account), state(std::move(owner)) {}
};
struct KandeloELDContext : kandelo::histogram::ELDRetained<KandeloELDContext> {
  std::shared_ptr<EventLoopDelayLoop> loop;
  kandelo::memory::Claim loopClaim, registryClaim;
  std::vector<std::weak_ptr<KandeloELDState>> owners;
  std::shared_ptr<KandeloELDCloseQueue> closes;
  unsigned turnDepth = 0;
  bool detached = false;
  KandeloELDContext(const kandelo::memory::AccountHandle& account,
                    const kandelo::memory::RecordHandle& registry)
      : ELDRetained(account), loop(std::make_shared<EventLoopDelayLoop>(
            kandelo::histogram::HistogramMonotonicNow() / 1000000)),
        loopClaim(loop->RetainedAllocation(), account), registryClaim(registry, account),
        closes(std::make_shared<KandeloELDCloseQueue>(account)) {}
  void Track(const std::shared_ptr<KandeloELDState>& state) {
    owners.erase(std::remove_if(owners.begin(), owners.end(),
        [](const auto& weak) { return weak.expired(); }), owners.end());
    owners.emplace_back(state);
    ResizeExtra(owners.capacity() * sizeof(owners[0]));
  }
  void Shutdown() noexcept {
    if (detached) return;
    detached = true; loop->Shutdown();
    closes->Shutdown();
    for (const auto& weak : owners) if (auto owner = weak.lock()) owner->Retire();
  }
  ~KandeloELDContext() { Shutdown(); }
};
static thread_local std::optional<kandelo::histogram::ELDRegistry<JSContext*, KandeloELDContext>> kandeloELDContexts;
static std::shared_ptr<KandeloELDContext> KandeloELDFindContext(JSContext* cx) noexcept {
  return kandeloELDContexts ? kandeloELDContexts->Find(cx) : nullptr;
}
static void KandeloELDFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, KandeloELDStateSlot);
  if (slot.isUndefined()) return;
  auto* handle = static_cast<KandeloELDHandle*>(slot.toPrivate());
  handle->state->producer->Close();
  // Exact native closing-list ownership: no vector growth/allocation in GC.
  // The state/producer/material records remain live until actual retirement.
  if (auto queue = handle->state->closeQueue.lock())
    queue->Enqueue(std::move(handle->state));
  else handle->state->Retire();
  delete handle;
}
static const JSClassOps KandeloELDClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloELDFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloELDClass = {"Histogram",
  JSCLASS_HAS_RESERVED_SLOTS(KandeloELDSlots) | JSCLASS_FOREGROUND_FINALIZE, &KandeloELDClassOps};
static KandeloELDState* KandeloELDOwner(JSContext* cx, HandleValue value, MutableHandleObject object) {
  if (!value.isObject()) { JS_ReportErrorASCII(cx, "Invalid native ELD receiver"); return nullptr; }
  object.set(js::CheckedUnwrapDynamic(&value.toObject(), cx));
  if (!object) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Invalid native ELD receiver");
    return nullptr;
  }
  if (JS::GetClass(object) != &KandeloELDClass) {
    JS_ReportErrorASCII(cx, "Invalid native ELD receiver"); return nullptr;
  }
  const auto slot = JS::GetReservedSlot(object, KandeloELDStateSlot);
  if (slot.isUndefined()) { JS_ReportErrorASCII(cx, "Uninitialized native ELD receiver"); return nullptr; }
  return static_cast<KandeloELDHandle*>(slot.toPrivate())->state.get();
}
static bool KandeloELDResourceInfo(JSContext* cx, HandleObject object, MutableHandleValue output) {
  RootedValue value(cx, ObjectValue(*object)); RootedObject unwrapped(cx);
  auto* state = KandeloELDOwner(cx, value, &unwrapped); if (!state) return false;
  JS::RootedValueArray<4> info(cx);
  info[0].setNumber(state->id); info[1].setNumber(state->trigger);
  info[2].set(JS::GetReservedSlot(unwrapped, KandeloELDFrameSlot));
  RootedString provider(cx, JS_NewStringCopyZ(cx, "ELDHISTOGRAM")); if (!provider) return false;
  info[3].setString(provider);
  for (size_t i = 0; i < 4; ++i) if (!JS_WrapValue(cx, info[i])) return false;
  RootedObject array(cx, JS::NewArrayObject(cx, info)); if (!array) return false;
  output.setObject(*array); return true;
}
static bool KandeloELDInitialize(JSContext* cx, HandleObject object, KandeloELDState* state) {
  RootedValue frame(cx); double trigger;
  if (!cx->kandeloAsyncProperty("frame", &frame) || !cx->getKandeloDefaultTriggerAsyncId(&trigger)) return false;
  auto* lifetime = js::shell::KandeloGetNativeAsyncState(cx); if (!lifetime) return false;
  lifetime->Retain(); state->lifetime = lifetime;
  state->id = cx->allocateKandeloAsyncId(); state->trigger = trigger;
  JS::SetReservedSlot(object, KandeloELDFrameSlot, frame);
  // This is the real ELD resource, at construction, not an FS request and
  // not a provider activated later by enable(). Native samples enter no JS.
  return cx->notifyKandeloAsyncLifecycle("native:init", object, frame);
}
static std::shared_ptr<KandeloELDContext> KandeloELDGetContext(JSContext* cx) {
  if (auto context = KandeloELDFindContext(cx)) return context;
  auto account = KandeloNativeMemoryOwner(cx);
  if (!account) return {};
  if (!kandeloELDContexts) kandeloELDContexts.emplace();
  auto context = std::make_shared<KandeloELDContext>(account,
      kandeloELDContexts->RetainedAllocation());
  kandeloELDContexts->Add(cx, context); return context;
}
static bool KandeloELDInitializeContext(JSContext* cx) {
  try {
    if (!KandeloELDGetContext(cx)) {
      JS_ReportErrorASCII(cx, "ELD has no registered native memory environment"); return false;
    }
    KandeloFlushNativeMemory(cx); return true;
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
static bool KandeloELDReadCachedTime(JSContext* cx, uint64_t* result) {
  auto context = KandeloELDFindContext(cx);
  if (!context) {
    JS_ReportErrorASCII(cx, "Node native loop clock is not initialized");
    return false;
  }
  *result = context->loop->time();
  return true;
}
static void KandeloELDUpdateCachedTime(JSContext* cx) {
  const uint64_t now = kandelo::histogram::HistogramMonotonicNow() / 1000000;
  if (auto context = KandeloELDFindContext(cx)) context->loop->UpdateTime(now);
  js::shell::KandeloStatWatcherUpdateCachedTime(cx, now);
}
static void KandeloELDShutdown(JSContext* cx) {
  if (auto context = KandeloELDFindContext(cx)) context->Shutdown();
  if (kandeloELDContexts) {
    kandeloELDContexts->Erase(cx);
    if (!kandeloELDContexts->StorageBytes()) kandeloELDContexts.reset();
  }
  KandeloFlushNativeMemory(cx);
}
static bool KandeloELDHasClosing(JSContext* cx) {
  auto context = KandeloELDFindContext(cx);
  return context && context->closes->Pending();
}
static void KandeloELDDrainCloses(JSContext* cx) {
  if (auto context = KandeloELDFindContext(cx)) context->closes->Drain();
  KandeloFlushNativeMemory(cx);
}
static std::shared_ptr<Histogram> KandeloELDCloneMaterial(HandleObject object) {
  if (JS::GetClass(object) != &KandeloELDClass) return {};
  const auto slot = JS::GetReservedSlot(object, KandeloELDStateSlot);
  if (slot.isUndefined()) return {};
  auto* handle = static_cast<KandeloELDHandle*>(slot.toPrivate());
  return handle->state->producer->ShareMaterialForClone();
}
static bool KandeloELDUpdateAndRunTimers(JSContext* cx) {
  auto context = KandeloELDFindContext(cx); if (!context) return true;
  try {
    KandeloELDUpdateCachedTime(cx); context->loop->RunTimers();
    KandeloFlushNativeMemory(cx); return true;
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
static int KandeloELDBackendTimeout(JSContext* cx, int requested, bool alive) {
  if (KandeloELDHasClosing(cx)) requested = 0;
  auto context = KandeloELDFindContext(cx);
  return context ? context->loop->NextTimeout(requested, alive) : requested;
}
// A real referenced dispatch phase starts nonblocking. Its one optional wait
// replaces that requested timeout immediately before the real provider wait.
// Nested drains do not overwrite the outer prepare/check baseline. This does
// not claim that Kandelo's callback topology is libuv's phase topology.
class KandeloELDTurn {
  JSContext* cx_;
  std::shared_ptr<KandeloELDContext> context_;
  bool active_ = false, finished_ = false;
  void Check() {
    if (!active_ || context_->detached || GetShellContext(cx_)->quitting ||
        GetShellContext(cx_)->exitCode) return;
    context_->loop->Check(); KandeloELDDrainCloses(cx_);
  }
 public:
  KandeloELDTurn(JSContext* cx, bool enabled) : cx_(cx) {
    if (!enabled) return;
    context_ = KandeloELDFindContext(cx); if (!context_) return;
    active_ = context_->turnDepth++ == 0;
    if (active_) context_->loop->Prepare(0);
  }
  ~KandeloELDTurn() {
    if (!context_) return;
    if (!finished_) Check();
    MOZ_ASSERT(context_->turnDepth); --context_->turnDepth;
  }
  template <typename Poll> void Wait(int actual_timeout_ms, Poll poll) {
    if (active_ && !context_->detached) context_->loop->Prepare(actual_timeout_ms);
    poll(); Check(); finished_ = true;
  }
};
static bool KandeloELDDispatch(JSContext* cx, const CallArgs& args, MutableHandleValue output) {
  using namespace kandelo::histogram;
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "ELD operation name required"); return false; }
  RootedString text(cx, args[0].toString()); JS::UniqueChars name = JS_EncodeStringToUTF8(cx, text);
  if (!name) return false;
  if (!strcmp(name.get(), "create")) {
    if (!args.get(1).isObject() || !args.get(3).isBoolean()) return false;
    int64_t resolution = KandeloHistogramInteger(args.get(2), "resolution is out of range");
    if (resolution < 1) HistogramBindingRange("resolution is out of range");
    Histogram::Options options{
      KandeloHistogramInteger(args.get(4), "options.lowest is out of range"),
      KandeloHistogramInteger(args.get(5), "options.highest is out of range"),
      int(KandeloHistogramInteger(args.get(6), "options.figures is out of range"))};
    auto context = KandeloELDGetContext(cx);
    auto account = KandeloNativeMemoryOwner(cx);
    if (!context || !account) {
      JS_ReportErrorASCII(cx, "ELD has no registered native memory environment"); return false;
    }
    auto producer = context->loop->Create(options, args[3].toBoolean() ? EventLoopDelayProducer::Mode::Iteration : EventLoopDelayProducer::Mode::Interval, uint64_t(resolution));
    if (!producer) throw HistogramBindingError("ERR_INVALID_ARG_VALUE", "TypeError", "Invalid histogram options");
    RootedValue material(cx); if (!KandeloHistogramOwnShared(cx, producer->histogram(), &material)) return false;
    RootedObject prototype(cx, &args[1].toObject());
    RootedObject object(cx, JS_NewObjectWithGivenProto(cx, &KandeloELDClass, prototype)); if (!object) return false;
    auto state = std::make_shared<KandeloELDState>(std::move(producer), account);
    state->closeQueue = context->closes;
    auto handle = std::make_unique<KandeloELDHandle>(state, account);
    context->Track(state);
    JS::SetReservedSlot(object, KandeloELDMaterialSlot, material);
    JS::SetReservedSlot(object, KandeloELDStateSlot, PrivateValue(handle.release()));
    if (!KandeloELDInitialize(cx, object, state.get())) return false;
    output.setObject(*object); KandeloFlushNativeMemory(cx); return true;
  }
  RootedObject object(cx); auto* state = KandeloELDOwner(cx, args.get(1), &object); if (!state) return false;
  if (!strcmp(name.get(), "material")) {
    output.set(JS::GetReservedSlot(object, KandeloELDMaterialSlot));
    return JS_WrapValue(cx, output);
  }
  if (!strcmp(name.get(), "start")) state->producer->Start(args.get(2).isBoolean() && args[2].toBoolean());
  else if (!strcmp(name.get(), "stop")) state->producer->Stop();
  else { JS_ReportErrorASCII(cx, "Unknown ELD operation"); return false; }
  output.setUndefined(); return true;
}
static bool KandeloNativeEventLoopDelayOperation(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); RootedValue value(cx);
  try {
    if (!KandeloELDDispatch(cx, args, &value)) return false;
    return KandeloHistogramPacket(cx, value, args.rval());
  } catch (const HistogramBindingError& error) {
    return KandeloHistogramError(cx, error.code, error.name, error.message, args.rval());
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
}  // namespace
