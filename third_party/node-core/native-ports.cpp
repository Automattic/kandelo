/* Native message endpoint bridge. Owned engine clone data is Send, not Copy:
 * queues retain no JS values/roots or testing-shell CloneBuffer objects.
 * SameProcess transfer sidecars own actual endpoints until receiver adoption.
 */
#include "kandelo-node-port-transit-owner.h"
#include <algorithm>
#include <atomic>
#include <map>
#include <vector>
#include "js/Wrapper.h"
namespace {
namespace PortTransit = kandelo::ports::transit;
struct KandeloPortMessageData final : PortTransit::Node {
  KandeloHistogramCloneData histogramData;
  kandelo::memory::Allocation retained{sizeof(KandeloPortMessageData)};
  JSAutoStructuredCloneBuffer data{JS::StructuredCloneScope::SameProcess,
      &KandeloHistogramCloneCallbacks, &histogramData};
  KandeloPortMessageData() { histogramData.graphOwner = this; }
  void Retire() noexcept override {
    data.clear(); histogramData.ports.clear(); histogramData.histograms.clear();
    histogramData.graphOwner = nullptr;
  }
  void AccountMemory() noexcept {
    retained.Resize(sizeof(*this) + data.sizeOfExcludingThis(moz_malloc_size_of));
  }
};
static bool KandeloReadMessage(JSContext*, KandeloPortMessageData*, MutableHandleValue, bool = false);
static const void* KandeloPortSource(JSContext*, HandleValue);
struct KandeloPortPacket final : PortTransit::Node {
  std::shared_ptr<KandeloPortMessageData> content;
  PortTransit::Edge contentEdge;
  std::atomic<bool> enqueued{false}, consumed{false};
  // Immutable after serialization. An aborted no-result packet owns no clone
  // material but still has an actual consume-once caller transaction.
  bool noResult = false;
  kandelo::memory::Allocation retained{sizeof(KandeloPortPacket)};
  kandelo::memory::Claims memoryClaims;
  std::mutex ownershipMutex;
  void AdoptMemory(const kandelo::memory::AccountHandle& account) {
    std::lock_guard lock(ownershipMutex);
    // Allocate all claim nodes before committing ownership. No JS/root belongs
    // in a cross-thread packet. Failed adoption leaves prior claims intact.
    kandelo::memory::Claims claims;
    claims.Reserve(content ? content->histogramData.histograms.size() + 3 : 1);
    auto add = [&](const kandelo::memory::RecordHandle& record) {
      claims.Add(record, account);
    };
    add(retained.Handle());
    if (content) {
      add(content->retained.Handle()); add(content->histogramData.retained.Handle());
      for (const auto& histogram : content->histogramData.histograms) add(histogram->RetainedAllocation());
    }
    memoryClaims.Commit(claims); AccountClaims();
  }
  void AccountClaims() noexcept {
    retained.Resize(sizeof(*this) + memoryClaims.MaterialBytes());
  }
  void ReleaseMemory() noexcept {
    std::lock_guard lock(ownershipMutex); memoryClaims.Clear(); AccountClaims();
  }
  void ClearContent() noexcept {
    std::lock_guard lock(ownershipMutex);
    memoryClaims.Clear(); contentEdge.Reset(); content.reset(); AccountClaims();
  }
  bool SetContent(std::shared_ptr<KandeloPortMessageData> value) {
    if (!contentEdge.Attach(Share(), value)) return false;
    content = std::move(value); return true;
  }
  void Retire() noexcept override { ClearContent(); }
};
using KandeloPortPacketHandle = PortTransit::Root<KandeloPortPacket>;
static KandeloPortPacketHandle KandeloNewPortPacket(std::shared_ptr<KandeloPortMessageData> content = {}) {
  KandeloPortPacketHandle packet(std::make_shared<KandeloPortPacket>());
  if (!packet || !packet->SetContent(content ? std::move(content) : std::make_shared<KandeloPortMessageData>())) return {};
  return packet;
}
struct KandeloPortPacketBox {
  JSContext* cx;
  KandeloPortPacketHandle packet;
  KandeloPortPacketBox(JSContext* cx, KandeloPortPacketHandle packet) : cx(cx), packet(std::move(packet)) {}
  void Release() noexcept { packet.reset(); cx = nullptr; }
};
using KandeloPortPacketBoxHandle = std::shared_ptr<KandeloPortPacketBox>;
static thread_local std::map<JSContext*, std::vector<std::weak_ptr<KandeloPortPacketBox>>> kandeloPortPacketBoxes;
static void KandeloPortPacketFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (!slot.isUndefined()) {
    JS::RemoveAssociatedMemory(object, sizeof(KandeloPortPacketBoxHandle), JS::MemoryUse::Embedding3);
    delete static_cast<KandeloPortPacketBoxHandle*>(slot.toPrivate());
  }
}
static const JSClassOps KandeloPortPacketClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloPortPacketFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloPortPacketClass = {"KandeloMessagePacket",
  JSCLASS_HAS_RESERVED_SLOTS(4) | JSCLASS_FOREGROUND_FINALIZE, &KandeloPortPacketClassOps};
static bool KandeloPortPacketObject(JSContext* cx, KandeloPortPacketHandle packet,
                                    MutableHandleValue result) {
  auto account = KandeloNativeMemoryOwner(cx);
  if (!account) { JS_ReportErrorASCII(cx, "Message packet has no registered native memory environment"); return false; }
  packet->AdoptMemory(account); KandeloFlushNativeMemory(cx);
  auto box = std::make_shared<KandeloPortPacketBox>(cx, std::move(packet));
  auto handle = std::make_unique<KandeloPortPacketBoxHandle>(box);
  auto& boxes = kandeloPortPacketBoxes[cx];
  boxes.erase(std::remove_if(boxes.begin(), boxes.end(), [](const auto& weak) { return weak.expired(); }), boxes.end());
  boxes.emplace_back(box);
  RootedObject object(cx, JS_NewObject(cx, &KandeloPortPacketClass));
  if (!object) return false;
  JS::SetReservedSlot(object, 0, PrivateValue(handle.release()));
  JS::AddAssociatedMemory(object, sizeof(KandeloPortPacketBoxHandle), JS::MemoryUse::Embedding3);
  result.setObject(*object); return true;
}
static KandeloPortPacketHandle KandeloPortPacketOwner(JSContext* cx, HandleValue value) {
  if (!value.isObject() || JS::GetClass(&value.toObject()) != &KandeloPortPacketClass) {
    JS_ReportErrorASCII(cx, "Invalid native message packet"); return {};
  }
  const auto slot = JS::GetReservedSlot(&value.toObject(), 0);
  if (slot.isUndefined()) { JS_ReportErrorASCII(cx, "Uninitialized native message packet"); return {}; }
  const auto& box = *static_cast<KandeloPortPacketBoxHandle*>(slot.toPrivate());
  if (box->cx != cx || !box->packet) { JS_ReportErrorASCII(cx, "Message packet owner was retired"); return {}; }
  return box->packet;
}
static void KandeloReleasePortPacketBox(HandleValue value) noexcept {
  // Called only after native admission validated this private box and copied
  // its real owner into the publishing/reading scope. Published producer
  // tokens cannot retain transit graphs until an unrelated later JS GC.
  const auto slot = JS::GetReservedSlot(&value.toObject(), 0);
  const auto& box = *static_cast<KandeloPortPacketBoxHandle*>(slot.toPrivate());
  box->Release();
}
// These roots are sender-context state, never members of native graph/packet
// material. The opaque box holds them only until a public caller consumes it.
struct KandeloMessageWriteOutcome {
  JS::ExceptionStack deferred;
  bool hasDeferred = false, noResult = false;
  explicit KandeloMessageWriteOutcome(JSContext* cx) : deferred(cx) {}
  bool Capture(JSContext* cx) {
    if (!JS_IsExceptionPending(cx) || JS_IsThrowingOutOfMemory(cx)) return false;
    if (!JS::StealPendingExceptionStack(cx, &deferred)) return false;
    hasDeferred = true;return true;
  }
  bool Save(JSContext* cx, HandleValue wrapper) {
    if (!hasDeferred) return true;
    RootedValue exception(cx, deferred.exception());RootedObject stack(cx, deferred.stack());
    if (!JS_WrapValue(cx, &exception) || !JS_WrapObject(cx, &stack)) return false;
    JS::SetReservedSlot(&wrapper.toObject(), 1, exception);
    JS::SetReservedSlot(&wrapper.toObject(), 2, ObjectOrNullValue(stack));
    JS::SetReservedSlot(&wrapper.toObject(), 3, BooleanValue(true));return true;
  }
};
struct KandeloMessageCallerOutcome {
  JSContext* cx;
  RootedValue exception;
  RootedObject stack;
  bool deferred = false;
  explicit KandeloMessageCallerOutcome(JSContext* cx) : cx(cx), exception(cx), stack(cx) {}
  // Caller has already validated the genuine private packet box/context.
  void Take(HandleValue wrapper) {
    auto* object = &wrapper.toObject();
    const auto flag = JS::GetReservedSlot(object, 3);
    deferred = flag.isBoolean() && flag.toBoolean();
    if (deferred) {
      exception = JS::GetReservedSlot(object, 1);
      stack = JS::GetReservedSlot(object, 2).toObjectOrNull();
    }
    JS::SetReservedSlot(object, 1, UndefinedValue());
    JS::SetReservedSlot(object, 2, UndefinedValue());
    JS::SetReservedSlot(object, 3, BooleanValue(false));
  }
  bool Finish() {
    if (!deferred) return true;
    JS::ExceptionStack error(cx, exception, stack);
    JS::SetPendingExceptionStack(cx, error);return false;
  }
};
static bool KandeloPortObserveCloneOutcome(JSContext* cx,
    const JSStructuredCloneCallbacks* callbacks, void* closure, JSContext::KandeloCloneOutcome outcome) {
  if (callbacks != &KandeloHistogramCloneCallbacks || !closure)
    return cx->reportKandeloCloneError("Host clone outcome requires an owned packet");
  auto* data = static_cast<KandeloHistogramCloneData*>(closure);
  auto* transaction = static_cast<KandeloMessageWriteOutcome*>(data->writingOutcome);
  if (!data->graphOwner || !transaction) return cx->reportKandeloCloneError("Host clone outcome transaction is unavailable");
  if (outcome == JSContext::KandeloCloneOutcome::NoResult) {
    transaction->noResult = true;return true;
  }
  return transaction->Capture(cx);
}
static JS::CloneDataPolicy KandeloMessageClonePolicy() {
  JS::CloneDataPolicy policy;
  policy.allowSharedMemoryObjects();
  policy.allowIntraClusterClonableSharedObjects();
  return policy;
}
static bool KandeloWriteMessageData(JSContext* cx, KandeloPortPacket* packet,
    HandleValue value, HandleValue transfer, KandeloMessageWriteOutcome& outcome) {
  auto* data = packet->content.get();
  data->histogramData.writingOutcome = &outcome;
  auto clear = mozilla::MakeScopeExit([&] { data->histogramData.writingOutcome = nullptr; });
  return data->data.write(cx, value, transfer, KandeloMessageClonePolicy());
}
static bool KandeloNativeSerializeMessage(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  try {
    auto packet = KandeloNewPortPacket();
    if (!packet) return cx->reportKandeloCloneError("Message packet ownership was retired");
    RootedValue wrapper(cx);
    // Allocate its opaque owner before serialization can detach backing stores.
    if (!KandeloPortPacketObject(cx, packet, &wrapper)) return false;
    auto abortPacket = mozilla::MakeScopeExit([&] { packet->ClearContent(); });
    if (!args.get(2).isUndefined()) {
      packet->content->histogramData.sourcePort = KandeloPortSource(cx, args.get(2));
      if (!packet->content->histogramData.sourcePort) return false;
    }
    auto clearSource = mozilla::MakeScopeExit([&] {
      packet->content->histogramData.sourcePort = nullptr; packet->content->histogramData.validatedPorts.clear();
    });
    KandeloMessageWriteOutcome outcome(cx);
    const bool written = KandeloWriteMessageData(cx, packet.get(), args.get(0), args.get(1), outcome);
    packet->content->histogramData.sourcePort = nullptr;
    packet->content->histogramData.validatedPorts.clear(); clearSource.release();
    packet->content->AccountMemory();
    if (!written) {
      if (!outcome.noResult || JS_IsExceptionPending(cx)) {
        packet->ClearContent(); KandeloFlushNativeMemory(cx); return false;
      }
      // Release partial move/clone material now. No-result is not a valid
      // undefined message, and must never enter a receiver/broadcast queue.
      packet->noResult = true;packet->ClearContent();
    }
    if (!outcome.Save(cx, wrapper)) return false;
    packet->AdoptMemory(KandeloNativeMemoryOwner(cx)); KandeloFlushNativeMemory(cx);
    args.rval().set(wrapper); abortPacket.release(); return true;
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
static bool KandeloNativeDeserializeMessage(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  auto packet = KandeloPortPacketOwner(cx, args.get(0));
  if (!packet) return false;
  // SameProcess clone data may contain transferred pointers and is not Copy.
  // No lock is held over deserializer hooks, which may reenter JS or collect.
  if (packet->consumed.exchange(true))
    return cx->reportKandeloCloneError("Message packet has already been consumed");
  KandeloMessageCallerOutcome outcome(cx);outcome.Take(args.get(0));
  KandeloReleasePortPacketBox(args.get(0));
  auto clear = mozilla::MakeScopeExit([&] { packet->ClearContent(); KandeloFlushNativeMemory(cx); });
  try {
    if (packet->noResult) { args.rval().setUndefined();return true; }
    packet->AdoptMemory(KandeloNativeMemoryOwner(cx));
    // StructuredClone's receiver exception supersedes a deferred sender error.
    if (!KandeloReadMessage(cx, packet->content.get(), args.rval(), args.get(1).isBoolean() && args[1].toBoolean())) return false;
    return outcome.Finish();
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
using KandeloPortEndpoint = kandelo::ports::TransitEndpoint<KandeloPortPacket>;
using KandeloPortEndpointOwner = KandeloPortEndpoint::Owner;
using KandeloBroadcastRegistry = kandelo::ports::BroadcastRegistry<KandeloPortPacket, KandeloPortEndpoint>;
using KandeloBroadcastMember = KandeloBroadcastRegistry::Member;
static KandeloBroadcastRegistry& KandeloBroadcastGroups() {
  // First-use construction stays inside the native operation's OOM guard.
  static KandeloBroadcastRegistry groups;
  return groups;
}
struct KandeloPortHandle {
  JSContext* cx;
  KandeloPortEndpointOwner endpoint;
  std::shared_ptr<KandeloBroadcastMember> broadcast;
  JS::PersistentRootedObject closeRoot;
  kandelo::memory::Allocation retained{sizeof(KandeloPortHandle)};
  kandelo::memory::Claims claims;
  bool transferredClose = false, wrapped = false, prepared = false, admitting = false;
  KandeloPortHandle(JSContext* cx, KandeloPortEndpointOwner endpoint,
      std::shared_ptr<KandeloBroadcastMember> broadcast)
      : cx(cx), endpoint(std::move(endpoint)), broadcast(std::move(broadcast)), closeRoot(cx) {}
  void Abandon() noexcept {
    if (broadcast) broadcast->Close(true);
    else if (endpoint) endpoint->Abandon();
    endpoint.reset(); broadcast.reset(); closeRoot = nullptr;
    transferredClose = false;
  }
  void AbortAdmission() noexcept {
    if (endpoint) endpoint->Abandon();
    endpoint.reset();
    admitting = false;
    // A wrapper exposed during initialization/decoding still owns its local
    // asynchronous close/destroy notification, independently of the packet.
    if (prepared && closeRoot) transferredClose = true;
    else closeRoot = nullptr;
  }
};
using KandeloPortBinding = std::shared_ptr<KandeloPortHandle>;
struct KandeloPortEnvironment {
  JS::PersistentRootedObject adopt;
  explicit KandeloPortEnvironment(JSContext* cx) : adopt(cx) {}
};
// Context-local callbacks/roots never enter a packet. Only EndpointTransfer's
// native queue owner can cross threads. Source close and receiver admission
// each own their own local registry entry and pending root.
static thread_local std::map<JSContext*, std::vector<std::weak_ptr<KandeloPortHandle>>> kandeloPortRegistries;
static thread_local std::map<JSContext*, std::unique_ptr<KandeloPortEnvironment>> kandeloPortEnvironments;
static void KandeloPortFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (!slot.isUndefined()) {
    JS::RemoveAssociatedMemory(object, sizeof(KandeloPortBinding), JS::MemoryUse::Embedding3);
    delete static_cast<KandeloPortBinding*>(slot.toPrivate());
  }
}
static const JSClassOps KandeloPortClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloPortFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloPortClass = {"KandeloPortEndpoint",
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloPortClassOps};
static const JSClass KandeloPublicPortClass = {"MessagePort", JSCLASS_HAS_RESERVED_SLOTS(1)};
static JSObject* KandeloPortUnwrap(JSContext* cx, JSObject* object) {
  auto* result = js::CheckedUnwrapDynamic(object, cx);
  if (!result && !JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);
  return result;
}
static KandeloPortHandle* KandeloPortOwner(JSContext* cx, HandleValue value) {
  RootedObject object(cx, value.isObject() ? KandeloPortUnwrap(cx, &value.toObject()) : nullptr);
  if (!object && JS_IsExceptionPending(cx)) return nullptr;
  if (!object || JS::GetClass(object) != &KandeloPortClass) {
    JS_ReportErrorASCII(cx, "Invalid native port endpoint"); return nullptr;
  }
  const auto slot = JS::GetReservedSlot(object, 0);
  auto* binding = slot.isUndefined() ? nullptr : static_cast<KandeloPortBinding*>(slot.toPrivate());
  auto* handle = binding ? binding->get() : nullptr;
  if (!handle || handle->cx != cx) { JS_ReportErrorASCII(cx, "Port context movement is not implemented"); return nullptr; }
  return handle;
}
static KandeloPortHandle* KandeloPublicPortOwner(JSContext* cx, HandleObject object) {
  RootedObject unwrapped(cx, KandeloPortUnwrap(cx, object));
  if (!unwrapped || JS::GetClass(unwrapped) != &KandeloPublicPortClass) return nullptr;
  RootedValue handle(cx, JS::GetReservedSlot(unwrapped, 0));
  return KandeloPortOwner(cx, handle);
}
static const void* KandeloPortSource(JSContext* cx, HandleValue value) {
  if (!value.isObject()) { JS_ReportErrorASCII(cx, "Invalid source MessagePort"); return nullptr; }
  RootedObject object(cx, &value.toObject());
  auto* owner = KandeloPublicPortOwner(cx, object);
  if (!owner && !JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Invalid source MessagePort");
  return owner;
}
static bool KandeloPortNew(JSContext* cx, KandeloPortEndpointOwner endpoint, MutableHandleValue result,
                           std::shared_ptr<KandeloBroadcastMember> broadcast = {}) {
  auto binding = std::make_shared<KandeloPortHandle>(cx, std::move(endpoint), std::move(broadcast));
  auto account = KandeloNativeMemoryOwner(cx);
  if (!account) { JS_ReportErrorASCII(cx, "MessagePort has no native memory environment"); return false; }
  binding->claims.Add(binding->retained.Handle(), account);
  binding->retained.Resize(sizeof(KandeloPortHandle) + binding->claims.MaterialBytes());
  auto handle = std::make_unique<KandeloPortBinding>(binding);
  RootedObject object(cx, JS_NewObject(cx, &KandeloPortClass));
  if (!object) return false;
  auto& entries = kandeloPortRegistries[cx];
  entries.erase(std::remove_if(entries.begin(), entries.end(), [](const auto& p) { return p.expired(); }), entries.end());
  entries.emplace_back(binding);
  JS::SetReservedSlot(object, 0, PrivateValue(handle.release()));
  JS::AddAssociatedMemory(object, sizeof(KandeloPortBinding), JS::MemoryUse::Embedding3);
  result.setObject(*object); return true;
}
static void KandeloCollectPortTransit() noexcept { PortTransit::Graph::Process().Collect(); }
static bool KandeloPortsHaveReferences(JSContext* cx) {
  // GC/finalizers only release external slots. Native loop collection is an
  // allocation-free safe point and never calls JS on a collecting thread.
  KandeloCollectPortTransit();
  const auto it = kandeloPortRegistries.find(cx);
  if (it == kandeloPortRegistries.end()) return false;
  for (const auto& weak : it->second) if (auto owner = weak.lock(); owner &&
      (owner->transferredClose || (owner->endpoint && owner->endpoint->KeepsLoopAlive()))) return true;
  return false;
}
static void KandeloShutdownPorts(JSContext* cx) {
  const auto it = kandeloPortRegistries.find(cx);
  if (it != kandeloPortRegistries.end()) {
    for (const auto& weak : it->second) if (auto owner = weak.lock()) {
      owner->Abandon(); owner->claims.Clear(); owner->retained.Resize(sizeof(KandeloPortHandle)); owner->cx = nullptr;
    }
    kandeloPortRegistries.erase(it);
  }
  const auto boxes = kandeloPortPacketBoxes.find(cx);
  if (boxes != kandeloPortPacketBoxes.end()) {
    // Release this context's box slots, not shared packet contents that can
    // already belong to another worker's inbox or active read scope.
    for (const auto& weak : boxes->second) if (auto box = weak.lock()) box->Release();
    kandeloPortPacketBoxes.erase(boxes);
  }
  kandeloPortEnvironments.erase(cx);
  PortTransit::Graph::Process().Collect(true);
}
static constexpr uint32_t KandeloPortTransferTag = JS_SCTAG_USER_MIN + 115;
static bool KandeloPortMissingTransfer(JSContext* cx, HandleObject object, bool* isPort) {
  RootedObject unwrapped(cx, KandeloPortUnwrap(cx, object));
  if (!unwrapped) return false;
  *isPort = JS::GetClass(unwrapped) == &KandeloPublicPortClass;
  if (!*isPort) return true;
  auto* owner = KandeloPublicPortOwner(cx, object);
  if (!owner) return false;
  return cx->reportKandeloCloneError(owner->endpoint
      ? "Object that needs transfer was found in message but not listed in transferList"
      : "Cannot clone object of unsupported type.");
}
// Type identity only: nested discovery must not repeat explicit admission's
// source/detached/duplicate side effects. No JS property or public token grants
// this brand; real adoption still validates/moves its native endpoint owner.
static bool KandeloPortIsTransferHost(JSContext* cx, HandleObject object, bool* found) {
  RootedObject actual(cx, KandeloPortUnwrap(cx, object));if (!actual) return false;
  *found = JS::GetClass(actual) == &KandeloPublicPortClass;return true;
}
// Only the actual owned packet callback/closure pair can receive this scalar.
// No sender JS object or context is retained by the published sidecar.
static bool KandeloPortObserveRegisteredTransfers(JSContext* cx,
    const JSStructuredCloneCallbacks* callbacks, void* closure, uint32_t count) {
  if (callbacks != &KandeloHistogramCloneCallbacks || !closure)
    return cx->reportKandeloCloneError("Registered transfer requires an owned packet");
  auto* data = static_cast<KandeloHistogramCloneData*>(closure);
  if (!data->graphOwner)
    return cx->reportKandeloCloneError("Registered transfer packet ownership was retired");
  data->registeredTransfers = count;return true;
}
static bool KandeloPortCanTransfer(JSContext* cx, HandleObject object, bool* sameProcess, void* closure) {
  RootedObject unwrapped(cx, KandeloPortUnwrap(cx, object));
  if (!unwrapped || JS::GetClass(unwrapped) != &KandeloPublicPortClass) return false;
  auto* owner = KandeloPublicPortOwner(cx, object);
  if (!owner) return false;
  auto* data = static_cast<KandeloHistogramCloneData*>(closure);
  if (data && data->sourcePort == owner) return cx->reportKandeloCloneError("Transfer list contains source port");
  if (!owner->endpoint || owner->endpoint->IsClosed()) return cx->reportKandeloCloneError("MessagePort in transfer list is already detached");
  if (owner->broadcast) return cx->reportKandeloCloneError("Cannot transfer object of unsupported type.");
  if (!data) return cx->reportKandeloCloneError("MessagePort transfer requires an owned packet");
  if (std::find(data->validatedPorts.begin(), data->validatedPorts.end(), owner) != data->validatedPorts.end())
    return cx->reportKandeloCloneError("Transfer list contains duplicate MessagePort");
  data->validatedPorts.push_back(owner);
  *sameProcess = true; return true;
}
static bool KandeloPortWriteTransfer(JSContext* cx, HandleObject object, void* closure,
    uint32_t* tag, JS::TransferableOwnership* ownership, void** content, uint64_t* extraData) {
  auto* owner = KandeloPublicPortOwner(cx, object);
  auto* data = static_cast<KandeloHistogramCloneData*>(closure);
  if (!owner || !data) return false;
  if (!owner->endpoint) return cx->reportKandeloCloneError("MessagePort in transfer list is already detached");
  try {
    // All allocation precedes the move. A failed preparation must not abandon
    // the still-source-owned endpoint or publish an orphan raw descriptor.
    auto transfer = std::make_shared<KandeloPortTransfer>();
    const auto index = data->ports.size();
    data->ports.push_back(transfer); data->AccountMemory();
    owner->closeRoot = object;
    owner->transferredClose = true;
    owner->endpoint->Start(false); owner->endpoint->Ref(false);
    if (!data->graphOwner || !transfer->Install(data->graphOwner->Share(), owner->endpoint))
      return cx->reportKandeloCloneError("MessagePort transfer ownership was retired");
    owner->endpoint.reset();
    *tag = KandeloPortTransferTag; *ownership = JS::SCTAG_TMO_CUSTOM;
    *content = nullptr; *extraData = index;
    return true;
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
struct KandeloPortReadTransaction {
  JSContext* cx;
  JS::RootedObject ports;
  std::vector<KandeloPortBinding> adopted;
  bool committed = false;
  explicit KandeloPortReadTransaction(JSContext* cx) : cx(cx), ports(cx) {}
  ~KandeloPortReadTransaction() {
    if (!committed) for (auto& owner : adopted) owner->AbortAdmission();
  }
};
static bool KandeloPortReadTransfer(JSContext* cx, JSStructuredCloneReader*, const JS::CloneDataPolicy&,
    uint32_t tag, void* content, uint64_t index, void* closure, MutableHandleObject result) {
  auto* data = static_cast<KandeloHistogramCloneData*>(closure);
  if (tag != KandeloPortTransferTag || content || !data || index >= data->ports.size() || !data->readingPorts)
    return cx->reportKandeloCloneError("Invalid transferred MessagePort material");
  auto* transaction = static_cast<KandeloPortReadTransaction*>(data->readingPorts);
  auto found = kandeloPortEnvironments.find(cx);
  if (found == kandeloPortEnvironments.end()) return cx->reportKandeloCloneError("MessagePort receiver is not initialized");
  auto& transfer = data->ports[size_t(index)];
  auto endpoint = transfer ? transfer->BeginRead() : KandeloPortEndpointOwner{};
  if (!endpoint) return cx->reportKandeloCloneError("MessagePort transfer already consumed");
  // The in-flight record root ends on every failed/throwing admission, not
  // just eventual clone-buffer destruction (which may itself be in a cycle).
  auto abortRead = mozilla::MakeScopeExit([&] { transfer->Abort(); });
  RootedValue handle(cx), value(cx);
  // Node constructs/initializes a new unentangled port before attaching the
  // transferred data. No init getter/listener may observe the incoming queue
  // or detach an endpoint whose packet still owns it.
  if (!KandeloPortNew(cx, KandeloPortEndpoint::Unentangled(), &handle)) return false;
  auto slot = JS::GetReservedSlot(&handle.toObject(), 0);
  const auto& binding = *static_cast<KandeloPortBinding*>(slot.toPrivate());
  transaction->adopted.push_back(binding);
  binding->admitting = true;
  RootedValue factory(cx, ObjectValue(*found->second->adopt));
  if (!JS_WrapValue(cx, &factory)) return false;
  if (!JS::Call(cx, UndefinedHandleValue, factory, HandleValueArray(handle), &value) || !value.isObject()) return false;
  RootedObject object(cx, &value.toObject());
  if (KandeloPublicPortOwner(cx, object) != binding.get()) {
    if (JS_IsExceptionPending(cx)) return false;
    return cx->reportKandeloCloneError("Invalid adopted MessagePort wrapper");
  }
  if (!binding->endpoint || binding->endpoint->IsClosed())
    return cx->reportKandeloCloneError("MessagePort receiver closed during initialization");
  if (!JS_DefineElement(cx, transaction->ports, transaction->adopted.size() - 1, object, JSPROP_ENUMERATE)) return false;
  endpoint->Start(binding->endpoint->Started()); endpoint->Ref(binding->endpoint->HasRef());
  binding->endpoint->Abandon(); binding->endpoint = std::move(endpoint);
  if (!transfer->CommitRead()) return cx->reportKandeloCloneError("MessagePort transfer already consumed");
  binding->admitting = false;
  abortRead.release(); result.set(object); return true;
}
static void KandeloPortFreeTransfer(uint32_t tag, JS::TransferableOwnership,
    void* content, uint64_t index, void* closure) {
  auto* data = static_cast<KandeloHistogramCloneData*>(closure);
  if (tag == KandeloPortTransferTag && !content && data && index < data->ports.size() && data->ports[size_t(index)])
    data->ports[size_t(index)]->Abort();
}
static bool KandeloReadMessage(JSContext* cx, KandeloPortMessageData* data, MutableHandleValue result, bool includePorts) {
  // This actual native read scope retains clone data even if another owning
  // packet slot is consumed/retired during a reentrant deserializer hook.
  PortTransit::Root<KandeloPortMessageData> read(std::static_pointer_cast<KandeloPortMessageData>(data->Share()));
  if (!read) return cx->reportKandeloCloneError("Message data ownership was retired");
  KandeloPortReadTransaction transaction(cx);
  transaction.ports = JS::NewArrayObject(cx, 0);
  if (!transaction.ports) return false;
  // Transfer-free broadcast buffers are immutable and may be read on several
  // workers at once. Never install a context pointer into that shared buffer.
  const bool hasPorts = !data->histogramData.ports.empty();
  if (hasPorts) data->histogramData.readingPorts = &transaction;
  auto clear = mozilla::MakeScopeExit([&] { if (hasPorts) data->histogramData.readingPorts = nullptr; });
  RootedValue value(cx);
  if (!data->data.read(cx, &value, KandeloMessageClonePolicy())) return false;
  if (includePorts) {
    JS::RootedValueArray<2> pair(cx);
    pair[0].set(value); pair[1].setObject(*transaction.ports);
    RootedObject object(cx, JS::NewArrayObject(cx, pair));
    if (!object) return false;
    result.setObject(*object);
  } else result.set(value);
  transaction.committed = true;
  for (auto& owner : transaction.adopted) if (!owner->transferredClose) owner->closeRoot = nullptr;
  return true;
}
static bool KandeloPortDispatch(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  // Busy JS/other native providers need not reach an idle check. Port API
  // entry is another native-only collection checkpoint; actor slots and
  // explicit read scopes keep in-flight data live across reentrant calls.
  KandeloCollectPortTransit();
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "Port operation required"); return false; }
  RootedString name(cx, args[0].toString());
  JS::UniqueChars operation(JS_EncodeStringToUTF8(cx, name));
  if (!operation) return false;
  if (!strcmp(operation.get(), "configure")) {
    if (!args.get(1).isObject() || !JS::IsCallable(&args[1].toObject()) || kandeloPortEnvironments.count(cx)) {
      JS_ReportErrorASCII(cx, "MessagePort receiver requires one private factory"); return false;
    }
    auto environment = std::make_unique<KandeloPortEnvironment>(cx);
    environment->adopt = &args[1].toObject();
    kandeloPortEnvironments.emplace(cx, std::move(environment));
    args.rval().setUndefined(); return true;
  }
  if (!strcmp(operation.get(), "wrap")) {
    auto* owner = KandeloPortOwner(cx, args.get(1));
    if (!owner) return false;
    if (owner->wrapped || !args.get(2).isObject()) {
      JS_ReportErrorASCII(cx, "Invalid public MessagePort wrapper"); return false;
    }
    RootedObject prototype(cx, &args[2].toObject());
    RootedObject object(cx, JS_NewObjectWithGivenProto(cx, &KandeloPublicPortClass, prototype));
    if (!object) return false;
    JS::SetReservedSlot(object, 0, args[1]); owner->wrapped = true;
    owner->closeRoot = object;
    args.rval().setObject(*object); return true;
  }
  if (!strcmp(operation.get(), "broadcast")) {
    if (!args.get(1).isString()) { JS_ReportErrorASCII(cx, "Broadcast channel name must be a string"); return false; }
    RootedString name(cx, args[1].toString());
    JS::UniqueChars encoded(JS_EncodeStringToUTF8(cx, name));
    if (!encoded) return false;
    // Match pinned Utf8Value -> SiblingGroup::Get(*name), including its
    // C-string group-key boundary. Public .name retains the original string.
    auto member = KandeloBroadcastGroups().Join(encoded.get());
    return KandeloPortNew(cx, member->Receiver(), args.rval(), member);
  }
  if (!strcmp(operation.get(), "pair")) {
    const auto pair = KandeloPortEndpoint::Pair();
    auto cleanup = mozilla::MakeScopeExit([&] { pair.first->Abandon(); pair.second->Abandon(); });
    JS::RootedValueArray<2> handles(cx);
    if (!KandeloPortNew(cx, pair.first, handles[0]) || !KandeloPortNew(cx, pair.second, handles[1])) return false;
    RootedObject result(cx, JS::NewArrayObject(cx, handles));
    if (!result) return false;
    args.rval().setObject(*result); cleanup.release(); return true;
  }
  auto* owner = KandeloPortOwner(cx, args.get(1)); if (!owner) return false;
  if (!strcmp(operation.get(), "prepared")) {
    owner->prepared = true; args.rval().setUndefined(); return true;
  }
  if (!strcmp(operation.get(), "initialized")) {
    if (!owner->admitting && !owner->transferredClose) owner->closeRoot = nullptr;
    args.rval().setUndefined(); return true;
  }
  if (!strcmp(operation.get(), "abortWrap")) {
    owner->AbortAdmission(); args.rval().setUndefined(); return true;
  }
  auto& endpoint = owner->endpoint;
  if (!endpoint) {
    if (!strcmp(operation.get(), "receive")) {
      if (owner->transferredClose) args.rval().setNull(); else args.rval().setUndefined();
    } else if (!strcmp(operation.get(), "post")) {
      auto packet = KandeloPortPacketOwner(cx, args.get(2));
      if (!packet) return false;
      if (packet->enqueued.exchange(true) || packet->consumed.exchange(true))
        return cx->reportKandeloCloneError("Message packet has already been published or consumed");
      KandeloMessageCallerOutcome outcome(cx);outcome.Take(args.get(2));
      KandeloReleasePortPacketBox(args.get(2));
      packet->ClearContent(); KandeloFlushNativeMemory(cx); args.rval().setUndefined();
      return outcome.Finish();
    } else {
      if (!strcmp(operation.get(), "ackClose")) { owner->transferredClose = false; owner->closeRoot = nullptr; }
      args.rval().setUndefined();
    }
    return true;
  }
  if (!strcmp(operation.get(), "post")) {
    auto packet = KandeloPortPacketOwner(cx, args.get(2));
    if (!packet) return false;
    if (packet->enqueued.exchange(true) || packet->consumed.load())
      return cx->reportKandeloCloneError("Message packet has already been published or consumed");
    KandeloMessageCallerOutcome outcome(cx);outcome.Take(args.get(2));
    KandeloReleasePortPacketBox(args.get(2));
    auto discard = mozilla::MakeScopeExit([&] {
      packet->consumed.store(true); packet->ClearContent();
    });
    if (packet->noResult || endpoint->IsClosed()) { args.rval().setUndefined(); return outcome.Finish(); }
    for (const auto& transfer : packet->content->histogramData.ports) {
      if (transfer && transfer->TargetsPeerOf(*endpoint)) {
        // Pinned SiblingGroup::Dispatch discards this undeliverable packet;
        // enqueuing it would make the endpoint own its own transfer record.
        RootedString status(cx, JS_NewStringCopyZ(cx, "target-self"));
        if (!status) return false;
        args.rval().setString(status); return outcome.Finish();
      }
    }
    // Publish no source-context claim nodes to another thread. The packet's
    // native ledger records remain live/pending throughout queue ownership.
    packet->ReleaseMemory();
    if (owner->broadcast) {
      bool hasTransferables;
      if (!JS_StructuredCloneHasTransferables(packet->content->data.data(), &hasTransferables)) {
        JS_ReportErrorASCII(cx, "Invalid broadcast clone data"); return false;
      }
      if (hasTransferables || packet->content->histogramData.registeredTransfers)
        return cx->reportKandeloCloneError("Broadcast messages cannot contain transferred objects");
      // The pinned JS_ReadStructuredClone contract permits repeated reads
      // only without transferables. Retain the one immutable engine buffer;
      // never bitwise-copy SameProcess data or serialize user getters again.
      const auto posted = owner->broadcast->Post([&] {
        auto delivery = KandeloNewPortPacket(packet->content);
        if (!delivery) throw std::bad_alloc();
        delivery->enqueued.store(true);
        return delivery;
      });
      if (posted == KandeloBroadcastRegistry::Posted::Closed) args.rval().setUndefined();
      else args.rval().setBoolean(posted == KandeloBroadcastRegistry::Posted::Delivered);
      return outcome.Finish();
    }
    const bool sent = endpoint->Send(packet);
    if (sent) discard.release();
    KandeloFlushNativeMemory(cx);
    args.rval().setBoolean(sent); return outcome.Finish();
  }
  if (!strcmp(operation.get(), "receive")) {
    auto result = endpoint->Receive((args.get(2).isBoolean() && args.get(2).toBoolean()));
    if (result.kind == KandeloPortEndpoint::Kind::Empty) { args.rval().setUndefined(); return true; }
    if (result.kind == KandeloPortEndpoint::Kind::Close) { args.rval().setNull(); return true; }
    return KandeloPortPacketObject(cx, std::move(result.message), args.rval());
  }
  if (!strcmp(operation.get(), "start")) endpoint->Start((args.get(2).isBoolean() && args.get(2).toBoolean()));
  else if (!strcmp(operation.get(), "ref")) endpoint->Ref((args.get(2).isBoolean() && args.get(2).toBoolean()));
  else if (!strcmp(operation.get(), "hasRef")) {
    if (endpoint->IsClosed()) args.rval().setUndefined(); else args.rval().setBoolean(endpoint->HasRef());
    return true;
  } else if (!strcmp(operation.get(), "close")) {
    if (owner->broadcast) owner->broadcast->Close(); else endpoint->Close();
  }
  else if (!strcmp(operation.get(), "ackClose")) {
    endpoint->AcknowledgeClose();
    if (owner->broadcast) owner->broadcast->Close(true);
  }
  else { JS_ReportErrorASCII(cx, "Unknown port operation"); return false; }
  args.rval().setUndefined(); return true;
}
static bool KandeloNativePort(JSContext* cx, unsigned argc, Value* vp) {
  try { return KandeloPortDispatch(cx, argc, vp); }
  catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
}  // namespace
