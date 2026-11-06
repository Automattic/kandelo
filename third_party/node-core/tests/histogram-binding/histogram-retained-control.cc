#include "histogram-binding.h"
#include "port-queue.h"
#include <cassert>
#include <iostream>
using namespace kandelo::histogram;
namespace memory = kandelo::memory;
struct Packet {
  std::shared_ptr<Histogram> material;
  memory::Allocation retained{sizeof(Packet)};
  explicit Packet(std::shared_ptr<Histogram> h) : material(std::move(h)) {}
};
int main() {
  assert(memory::processLedger.Inspect().retained == 0);
  {
    auto account = std::make_shared<memory::Account>();
    auto h = Histogram::Create({1, 1000000, 2}); h->Record(2); h->Record(4); h->Record(6);
    const auto hdrBytes = sizeof(Histogram) + h->GetMemorySize();
    assert(memory::processLedger.Inspect().retained == hdrBytes);
    memory::Claim wrapper(h->RetainedAllocation(), account);
    size_t snapshotBytes = 0;
    {
      HistogramQrdeWork work(h, {0, .5, 1}, QrdeDequantization::kHdr, true);
      work.Run();
      snapshotBytes = sizeof(Histogram::RecordedSnapshot) + work.snapshot().buckets.capacity() * sizeof(Histogram::RecordedBucket);
      assert(h->GetRecordedSnapshotSource(true).cache_hit);
    }
    const auto cached = memory::processLedger.Inspect().retained;
    assert(cached == hdrBytes + snapshotBytes);
    // Cache hit and invalidation have independent, exact shared lifetime.
    {
      HistogramQrdeWork hit(h, {0, .5, 1}, QrdeDequantization::kHdr, true);
      assert(hit.cache_hit());
      h->Record(8); assert(!h->GetRecordedSnapshotSource(true).cache_hit);
      assert(memory::processLedger.Inspect().retained > cached);
      hit.Run(); assert(hit.snapshot().total_count == 3);
    }
    assert(memory::processLedger.Inspect().retained == hdrBytes);
    std::cout << "cache publication/hit/invalidation/work last-release conserved\n";
  }
  assert(memory::processLedger.Inspect().retained == 0);
  {
    auto source = std::make_shared<memory::Account>();
    auto h = Histogram::Create({1,1000000,2}); h->Record(7);
    const auto bytes = sizeof(Histogram) + h->GetMemorySize();
    auto sourceClaim = std::make_unique<memory::Claim>(h->RetainedAllocation(), source);
    auto endpoints = kandelo::ports::Endpoint<Packet>::Pair();
    auto packet = std::make_shared<Packet>(h);
    assert(endpoints.first->Send(packet)); h.reset(); packet.reset();
    sourceClaim.reset(); source->Detach();
    auto pending = memory::processLedger.Inspect();
    assert(pending.retained == bytes + sizeof(Packet) && pending.pending == pending.retained && pending.projected == 0);
    auto destination = std::make_shared<memory::Account>();
    auto received = endpoints.second->Receive(true);
    assert(received.message->material->Count() == 1);
    memory::Claim receiver(received.message->material->RetainedAllocation(), destination);
    assert(memory::processLedger.Inspect().retained == pending.retained);
    received.message.reset();
    assert(memory::processLedger.Inspect().retained == 0);
    destination->Detach();
    std::cout << "actual endpoint source-drop/context-retire/receive conserved\n";
  }
  {
    using Registry = kandelo::ports::BroadcastRegistry<Packet>;
    Registry registry;
    auto a = registry.Join("group"), b = registry.Join("group"), c = registry.Join("group");
    auto h = Histogram::Create({1,1000000,2});
    const auto bytes = sizeof(Histogram) + h->GetMemorySize();
    assert(a->Post([&] { return std::make_shared<Packet>(h); }) == Registry::Posted::Delivered);
    h.reset();
    assert(memory::processLedger.Inspect().retained == bytes + 2*sizeof(Packet));
    b->Close(true);
    assert(memory::processLedger.Inspect().retained == bytes + sizeof(Packet));
    c->Close(true);
    assert(memory::processLedger.Inspect().retained == 0);
    std::cout << "actual broadcast fan-out/asymmetric close/last-owner conserved\n";
  }
  assert(memory::processLedger.Inspect().retained == 0);
}
