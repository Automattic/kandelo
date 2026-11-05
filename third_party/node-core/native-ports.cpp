/* Native message endpoint bridge. Owned engine clone data is Send, not Copy:
 * queues retain no JS values/roots or testing-shell CloneBuffer objects.
 * Worker bootstrap and transferable endpoints remain separate owners.
 */
#include "kandelo-node-port-queue.h"
#include <algorithm>
#include <atomic>
#include <map>
#include <vector>
namespace {
struct KandeloPortMessageData {
  JSAutoStructuredCloneBuffer data{JS::StructuredCloneScope::SameProcess, nullptr, nullptr};
};
struct KandeloPortPacket {
  std::shared_ptr<KandeloPortMessageData> content;
  std::atomic<bool> enqueued{false}, consumed{false};
  KandeloPortPacket() : content(std::make_shared<KandeloPortMessageData>()) {}
  explicit KandeloPortPacket(std::shared_ptr<KandeloPortMessageData> content)
      : content(std::move(content)) {}
};
using KandeloPortPacketHandle = std::shared_ptr<KandeloPortPacket>;
static void KandeloPortPacketFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (!slot.isUndefined()) {
    JS::RemoveAssociatedMemory(object, sizeof(KandeloPortPacketHandle), JS::MemoryUse::Embedding3);
    delete static_cast<KandeloPortPacketHandle*>(slot.toPrivate());
  }
}
static const JSClassOps KandeloPortPacketClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloPortPacketFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloPortPacketClass = {"KandeloMessagePacket",
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloPortPacketClassOps};
static bool KandeloPortPacketObject(JSContext* cx, KandeloPortPacketHandle packet,
                                    MutableHandleValue result) {
  auto handle = std::make_unique<KandeloPortPacketHandle>(std::move(packet));
  RootedObject object(cx, JS_NewObject(cx, &KandeloPortPacketClass));
  if (!object) return false;
  JS::SetReservedSlot(object, 0, PrivateValue(handle.release()));
  JS::AddAssociatedMemory(object, sizeof(KandeloPortPacketHandle), JS::MemoryUse::Embedding3);
  result.setObject(*object); return true;
}
static KandeloPortPacketHandle KandeloPortPacketOwner(JSContext* cx, HandleValue value) {
  if (!value.isObject() || JS::GetClass(&value.toObject()) != &KandeloPortPacketClass) {
    JS_ReportErrorASCII(cx, "Invalid native message packet"); return {};
  }
  const auto slot = JS::GetReservedSlot(&value.toObject(), 0);
  if (slot.isUndefined()) { JS_ReportErrorASCII(cx, "Uninitialized native message packet"); return {}; }
  return *static_cast<KandeloPortPacketHandle*>(slot.toPrivate());
}
static JS::CloneDataPolicy KandeloMessageClonePolicy() {
  JS::CloneDataPolicy policy;
  policy.allowSharedMemoryObjects();
  policy.allowIntraClusterClonableSharedObjects();
  return policy;
}
static bool KandeloNativeSerializeMessage(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  try {
    auto packet = std::make_shared<KandeloPortPacket>();
    RootedValue wrapper(cx);
    // Allocate its opaque owner before serialization can detach backing stores.
    if (!KandeloPortPacketObject(cx, packet, &wrapper)) return false;
    if (!packet->content->data.write(cx, args.get(0), args.get(1), KandeloMessageClonePolicy())) {
      packet->content.reset(); return false;
    }
    args.rval().set(wrapper); return true;
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
  auto clear = mozilla::MakeScopeExit([&] { packet->content.reset(); });
  return packet->content->data.read(cx, args.rval(), KandeloMessageClonePolicy());
}
using KandeloPortEndpoint = kandelo::ports::Endpoint<KandeloPortPacket>;
using KandeloBroadcastRegistry = kandelo::ports::BroadcastRegistry<KandeloPortPacket>;
using KandeloBroadcastMember = KandeloBroadcastRegistry::Member;
static KandeloBroadcastRegistry& KandeloBroadcastGroups() {
  // First-use construction stays inside the native operation's OOM guard.
  static KandeloBroadcastRegistry groups;
  return groups;
}
struct KandeloPortHandle {
  JSContext* cx;
  std::shared_ptr<KandeloPortEndpoint> endpoint;
  std::shared_ptr<KandeloBroadcastMember> broadcast;
};
// Shell contexts are thread-confined. Shutdown clears every queued root before
// destroying the context, even if an opaque JS handle outlives ShellContext.
static thread_local std::map<JSContext*, std::vector<std::weak_ptr<KandeloPortEndpoint>>> kandeloPortRegistries;
static thread_local std::map<JSContext*, std::vector<std::weak_ptr<KandeloBroadcastMember>>> kandeloBroadcastRegistries;
static void KandeloPortFinalize(JS::GCContext*, JSObject* object) {
  const auto slot = JS::GetReservedSlot(object, 0);
  if (!slot.isUndefined()) delete static_cast<KandeloPortHandle*>(slot.toPrivate());
}
static const JSClassOps KandeloPortClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloPortFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloPortClass = {"KandeloPortEndpoint",
  JSCLASS_HAS_RESERVED_SLOTS(1) | JSCLASS_FOREGROUND_FINALIZE, &KandeloPortClassOps};
static KandeloPortHandle* KandeloPortOwner(JSContext* cx, HandleValue value) {
  if (!value.isObject() || JS::GetClass(&value.toObject()) != &KandeloPortClass) {
    JS_ReportErrorASCII(cx, "Invalid native port endpoint"); return nullptr;
  }
  const auto slot = JS::GetReservedSlot(&value.toObject(), 0);
  auto* handle = slot.isUndefined() ? nullptr : static_cast<KandeloPortHandle*>(slot.toPrivate());
  if (!handle || handle->cx != cx) { JS_ReportErrorASCII(cx, "Port context movement is not implemented"); return nullptr; }
  return handle;
}
static bool KandeloPortNew(JSContext* cx, std::shared_ptr<KandeloPortEndpoint> endpoint, MutableHandleValue result,
                           std::shared_ptr<KandeloBroadcastMember> broadcast = {}) {
  auto handle = std::make_unique<KandeloPortHandle>(KandeloPortHandle{cx, std::move(endpoint), std::move(broadcast)});
  RootedObject object(cx, JS_NewObject(cx, &KandeloPortClass));
  if (!object) return false;
  auto& entries = kandeloPortRegistries[cx];
  entries.erase(std::remove_if(entries.begin(), entries.end(), [](const auto& p) { return p.expired(); }), entries.end());
  entries.emplace_back(handle->endpoint);
  if (handle->broadcast) {
    auto& groups = kandeloBroadcastRegistries[cx];
    groups.erase(std::remove_if(groups.begin(), groups.end(), [](const auto& p) { return p.expired(); }), groups.end());
    groups.emplace_back(handle->broadcast);
  }
  JS::SetReservedSlot(object, 0, PrivateValue(handle.release())); result.setObject(*object); return true;
}
static bool KandeloPortsHaveReferences(JSContext* cx) {
  const auto it = kandeloPortRegistries.find(cx);
  if (it == kandeloPortRegistries.end()) return false;
  for (const auto& weak : it->second) if (auto endpoint = weak.lock(); endpoint && endpoint->KeepsLoopAlive()) return true;
  return false;
}
static void KandeloShutdownPorts(JSContext* cx) {
  const auto groups = kandeloBroadcastRegistries.find(cx);
  if (groups != kandeloBroadcastRegistries.end()) {
    for (const auto& weak : groups->second) if (auto member = weak.lock()) member->Close(true);
    kandeloBroadcastRegistries.erase(groups);
  }
  const auto it = kandeloPortRegistries.find(cx);
  if (it == kandeloPortRegistries.end()) return;
  for (const auto& weak : it->second) if (auto endpoint = weak.lock()) endpoint->Abandon();
  kandeloPortRegistries.erase(it);
}
static bool KandeloPortDispatch(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isString()) { JS_ReportErrorASCII(cx, "Port operation required"); return false; }
  RootedString name(cx, args[0].toString());
  JS::UniqueChars operation(JS_EncodeStringToUTF8(cx, name));
  if (!operation) return false;
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
  auto& endpoint = owner->endpoint;
  if (!strcmp(operation.get(), "post")) {
    auto packet = KandeloPortPacketOwner(cx, args.get(2));
    if (!packet) return false;
    if (packet->enqueued.exchange(true) || packet->consumed.load())
      return cx->reportKandeloCloneError("Message packet has already been published or consumed");
    auto discard = mozilla::MakeScopeExit([&] {
      packet->consumed.store(true); packet->content.reset();
    });
    if (endpoint->IsClosed()) { args.rval().setUndefined(); return true; }
    if (owner->broadcast) {
      bool hasTransferables;
      if (!JS_StructuredCloneHasTransferables(packet->content->data.data(), &hasTransferables)) {
        JS_ReportErrorASCII(cx, "Invalid broadcast clone data"); return false;
      }
      if (hasTransferables)
        return cx->reportKandeloCloneError("Broadcast messages cannot contain transferred objects");
      // The pinned JS_ReadStructuredClone contract permits repeated reads
      // only without transferables. Retain the one immutable engine buffer;
      // never bitwise-copy SameProcess data or serialize user getters again.
      const auto posted = owner->broadcast->Post([&] {
        auto delivery = std::make_shared<KandeloPortPacket>(packet->content);
        delivery->enqueued.store(true);
        return delivery;
      });
      if (posted == KandeloBroadcastRegistry::Posted::Closed) args.rval().setUndefined();
      else args.rval().setBoolean(posted == KandeloBroadcastRegistry::Posted::Delivered);
      return true;
    }
    const bool sent = endpoint->Send(packet);
    if (sent) discard.release();
    args.rval().setBoolean(sent); return true;
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
