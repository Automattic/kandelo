#include "native-retained-memory.h"
#include <cassert>
#include <thread>
#include <condition_variable>
#include <vector>
using namespace kandelo::memory;
int main() {
  assert(processLedger.Inspect().retained == 0);
  auto allocation = std::make_unique<Allocation>(100);
  auto t = processLedger.Inspect(); assert(t.retained == 100 && t.pending == 100 && t.projected == 0);
  auto source = std::make_shared<Account>();
  assert(source->Desired() == 100);
  auto sourceClaim = std::make_unique<Claim>(allocation->Handle(), source);
  auto destination = std::make_shared<Account>();
  assert(source->Desired() == 100 && destination->Desired() == 0);
  auto destinationClaim = std::make_unique<Claim>(allocation->Handle(), destination);
  // Fan-out aliases retain one physical allocation, regardless of claims.
  std::vector<std::unique_ptr<Claim>> fanout;
  for (int i=0;i<100;++i) fanout.push_back(std::make_unique<Claim>(allocation->Handle(), destination));
  assert(processLedger.Inspect().retained == 100);
  source->Detach(); assert(source->Desired() == 0 && destination->Desired() == 100);
  sourceClaim.reset(); destinationClaim.reset(); fanout.clear();
  t = processLedger.Inspect(); assert(t.pending == 100 && t.projected == 100);
  destination->Detach(); t = processLedger.Inspect();
  assert(t.retained == 100 && t.pending == 100 && t.projected == 0);
  // Queued ownership outlives every source/destination context and reattaches.
  auto later = std::make_shared<Account>(); assert(later->Desired() == 100);
  allocation->Resize(200); assert(later->Desired() == 200);
  auto metadataOnly = std::make_unique<Claim>(allocation->Handle(), source);
  allocation.reset(); assert(processLedger.Inspect().retained == 0);
  metadataOnly.reset(); later->Detach();
  // Native-thread resize/last-release races never access JS or foreign roots.
  auto account = std::make_shared<Account>();
  std::vector<std::thread> threads;
  for (int j=0;j<8;++j) threads.emplace_back([account] {
    for (int i=0;i<2000;++i) {
      Allocation data(4096); Claim claim(data.Handle(), account);
      data.Resize(8192); data.Resize(8); processLedger.Inspect();
    }
  });
  for (auto& thread:threads) thread.join();
  assert(processLedger.Inspect().retained == 0 && account->Desired() == 0);
  std::mutex gate; std::condition_variable changed;
  unsigned ready = 0; bool released = false;
  threads.clear();
  for (int j=0;j<8;++j) threads.emplace_back([&] {
    Allocation native(4096); Claim claim(native.Handle(), account);
    std::unique_lock lock(gate); ++ready; changed.notify_all();
    changed.wait(lock, [&] { return released; });
    lock.unlock(); native.Resize(8192);
  });
  { std::unique_lock lock(gate); changed.wait(lock, [&] { return ready == 8; }); }
  account->Detach();
  auto orphaned = processLedger.Inspect();
  assert(orphaned.retained == 8*4096 && orphaned.pending == orphaned.retained && orphaned.projected == 0);
  auto replacement = std::make_shared<Account>(); assert(replacement->Desired() == orphaned.retained);
  { std::lock_guard lock(gate); released = true; } changed.notify_all();
  for (auto& thread:threads) thread.join();
  assert(replacement->Desired() == 0 && processLedger.Inspect().retained == 0);
  replacement->Detach();
  CreditBalance credit; size_t actual = 0;
  auto add = [&](size_t bytes) { actual += bytes; };
  auto remove = [&](size_t bytes) { assert(actual >= bytes); actual -= bytes; };
  credit.Flush(100, add, remove); credit.Flush(100, add, remove);
  credit.Flush(120, add, remove); credit.Flush(5, add, remove);
  assert(actual == 5 && credit.Associated() == 5);
  // A host reporting failure must not commit credit that was never applied.
  try { credit.Flush(20, [](size_t) { throw 1; }, remove); assert(false); } catch (int) {}
  assert(actual == 5 && credit.Associated() == 5);
  credit.Flush(0, add, remove); assert(actual == 0);
  account->Detach(); assert(processLedger.Inspect().accounts == 0);
}
