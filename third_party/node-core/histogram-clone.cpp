// Included after histogram-native.cpp. The clone-data sidecar is owned by an
// actual SameProcess serialization packet; no JS objects or private pointers
// are encoded as script-visible metadata or copied between contexts.
#include "js/StructuredClone.h"
#include "kandelo-node-port-queue.h"
namespace {
struct KandeloPortPacket;
using KandeloPortTransfer = kandelo::ports::EndpointTransfer<KandeloPortPacket>;
struct KandeloHistogramCloneData {
  std::vector<std::shared_ptr<Histogram>> histograms;
  std::vector<std::shared_ptr<KandeloPortTransfer>> ports;
  // Borrowed only during the synchronous write/read operation. These never
  // survive publication of a packet or contain a cross-thread JS reference.
  const void* sourcePort = nullptr;
  std::vector<const void*> validatedPorts;
  void* readingPorts = nullptr;
  kandelo::memory::Allocation retained;
  void AccountMemory() noexcept {
    retained.Resize(histograms.capacity() * sizeof(histograms[0]) +
        ports.capacity() * sizeof(ports[0]) + ports.size() * sizeof(KandeloPortTransfer) +
        validatedPorts.capacity() * sizeof(validatedPorts[0]));
  }
};
static bool KandeloPortMissingTransfer(JSContext*, HandleObject, bool*);
static bool KandeloPortCanTransfer(JSContext*, HandleObject, bool*, void*);
static bool KandeloPortWriteTransfer(JSContext*, HandleObject, void*, uint32_t*,
    JS::TransferableOwnership*, void**, uint64_t*);
static bool KandeloPortReadTransfer(JSContext*, JSStructuredCloneReader*,
    const JS::CloneDataPolicy&, uint32_t, void*, uint64_t, void*, MutableHandleObject);
static void KandeloPortFreeTransfer(uint32_t, JS::TransferableOwnership, void*, uint64_t, void*);
static constexpr uint32_t KandeloHistogramCloneTag = JS_SCTAG_USER_MIN + 114;
static bool KandeloHistogramWriteClone(JSContext* cx, JSStructuredCloneWriter* writer,
    HandleObject object, bool* sameProcess, void* closure) {
  bool port;
  if (!KandeloPortMissingTransfer(cx, object, &port)) return false;
  if (port) return false;
  std::shared_ptr<Histogram> material;
  if (JS::GetClass(object) == &KandeloHistogramClass) {
    const auto slot = JS::GetReservedSlot(object, 0);
    if (!slot.isUndefined()) material = static_cast<HistogramBindingState*>(slot.toPrivate())->histogram;
  } else material = KandeloELDCloneMaterial(object);
  if (!material) return cx->reportKandeloCloneError("Object is not a cloneable native histogram");
  auto* data = static_cast<KandeloHistogramCloneData*>(closure);
  if (!data || data->histograms.size() >= UINT32_MAX)
    return cx->reportKandeloCloneError("Histogram clone ownership is unavailable");
  try {
    const uint32_t index = uint32_t(data->histograms.size());
    data->histograms.push_back(std::move(material));
    data->AccountMemory();
    // Aborted writes retain material only until their serialization packet is
    // destroyed. Neither the byte stream nor a global token registry owns it.
    *sameProcess = true;
    return JS_WriteUint32Pair(writer, KandeloHistogramCloneTag, index);
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
static JSObject* KandeloHistogramReadClone(JSContext* cx, JSStructuredCloneReader*,
    const JS::CloneDataPolicy&, uint32_t tag, uint32_t index, void* closure) {
  auto* data = static_cast<KandeloHistogramCloneData*>(closure);
  if (tag != KandeloHistogramCloneTag || !data || index >= data->histograms.size()) {
    cx->reportKandeloCloneError("Invalid native histogram clone material"); return nullptr;
  }
  try {
    RootedValue value(cx);
    if (!KandeloHistogramOwnShared(cx, data->histograms[index], &value)) return nullptr;
    return &value.toObject();
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return nullptr; }
}
static const JSStructuredCloneCallbacks KandeloHistogramCloneCallbacks = {
  KandeloHistogramReadClone, KandeloHistogramWriteClone,
  nullptr, KandeloPortReadTransfer, KandeloPortWriteTransfer,
  KandeloPortFreeTransfer, KandeloPortCanTransfer, nullptr};
}  // namespace
