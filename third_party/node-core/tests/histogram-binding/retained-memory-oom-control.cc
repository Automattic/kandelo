// Faults only native claim/record allocation. No engine/JSAPI OOM claim.
#include "native-retained-memory.h"
#include <cstdlib>
#include <new>
#include <iostream>
static int remaining = -1;
void* operator new(std::size_t size) {
  if (remaining == 0) throw std::bad_alloc();
  if (remaining > 0) --remaining;
  if (void* p = std::malloc(size ? size : 1)) return p;
  throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
int main() {
  using namespace kandelo::memory;
  auto source = std::make_shared<Account>(), destination = std::make_shared<Account>();
  Allocation a(1024), b(2048);
  Claims owner; owner.Reserve(2); owner.Add(a.Handle(), source); owner.Add(b.Handle(), source);
  int failures = 0;
  // Real shared transaction used by KandeloPortPacket::AdoptMemory. Fail its
  // vector and each individual claim allocation, including partial progress.
  for (int budget=0;budget<3;++budget) {
    remaining = budget;
    try {
      Claims replacement; replacement.Reserve(2);
      replacement.Add(a.Handle(), destination); replacement.Add(b.Handle(), destination);
      owner.Commit(replacement);
      assert(false);
    } catch (const std::bad_alloc&) { remaining = -1; ++failures; }
    const auto totals = processLedger.Inspect();
    assert(totals.retained == 3072 && totals.projected == 3072 && totals.pending == 0);
    assert(source->Desired() == 3072 && destination->Desired() == 0);
  }
  Claims replacement; replacement.Reserve(2);
  replacement.Add(a.Handle(), destination); replacement.Add(b.Handle(), destination);
  owner.Commit(replacement); replacement.Clear();
  assert(source->Desired() == 0 && destination->Desired() == 3072);
  // Accounting-record OOM cannot publish a phantom physical allocation.
  remaining = 0;
  try { Allocation unallocated(1); assert(false); }
  catch (const std::bad_alloc&) { remaining = -1; ++failures; }
  assert(processLedger.Inspect().retained == 3072);
  std::cout << failures << " native allocation/partial-claim failures conserve ownership\n";
}
