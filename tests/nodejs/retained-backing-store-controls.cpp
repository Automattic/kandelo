#include "retained-backing-store.h"
#include <atomic>
#include <cassert>
#include <cstdlib>
#include <cstring>
#include <thread>
#include <vector>
#include <cstdio>
#include <new>
// Failure injection is confined to this standalone helper's actual C++
// allocations. It neither simulates JSAPI failures nor changes production code.
static std::atomic<int> failAllocation{-1};
void* operator new(size_t bytes) {
  int fail = failAllocation.load();
  if (fail >= 0 && failAllocation.fetch_sub(1) == 0) throw std::bad_alloc();
  if (void* data = std::malloc(bytes ? bytes : 1)) return data;
  throw std::bad_alloc();
}
void operator delete(void* data) noexcept { std::free(data); }
void operator delete(void* data, size_t) noexcept { std::free(data); }
void* operator new[](size_t bytes) { return ::operator new(bytes); }
void operator delete[](void* data) noexcept { ::operator delete(data); }
void operator delete[](void* data, size_t) noexcept { ::operator delete(data); }
using namespace kandelo::buffer;
using namespace kandelo::memory;
struct FreeState { std::atomic<unsigned> calls{0}; std::atomic<size_t> bytes{0}; };
static void Free(void* data, size_t capacity, void* state) noexcept {
  auto* result = static_cast<FreeState*>(state);
  result->bytes.fetch_add(capacity); result->calls.fetch_add(1); std::free(data);
}
static uint8_t* Allocate(size_t capacity) {
  auto* data = static_cast<uint8_t*>(std::calloc(capacity ? capacity : 1, 1)); assert(data); return data;
}
static void AssertEmpty(const Totals& before) {
  auto after = processLedger.Inspect(); assert(after.retained == before.retained);
  assert(after.allocations == before.allocations && after.pending == before.pending);
}
int main() {
  const auto empty = processLedger.Inspect();
  {
    FreeState free;
    auto* data = Allocate(12);
    { auto uncommitted = BackingStore::Prepare(data,12,Free,&free);
      auto owner = std::make_shared<JsBackingOwner>(uncommitted,AccountHandle{});
      assert(!uncommitted->Committed()); }
    assert(free.calls == 0); // metadata/registry failure leaves original ownership intact
    std::free(data);
  }
  AssertEmpty(empty);
  for (int ordinal : {0,1}) {
    FreeState free; auto* data = Allocate(12); bool failed = false;
    failAllocation.store(ordinal);
    try { (void)BackingStore::Prepare(data,12,Free,&free); }
    catch(const std::bad_alloc&) { failed = true; }
    failAllocation.store(-1); assert(failed && free.calls==0); std::free(data);
    AssertEmpty(empty);
  }
  for (int ordinal : {0,1}) {
    FreeState free; auto account = std::make_shared<Account>();
    auto store = BackingStore::Prepare(Allocate(12),12,Free,&free); store->Commit();
    const auto before = processLedger.Inspect();
    for (bool span : {false,true}) {
      bool failed = false; failAllocation.store(ordinal);
      try {
        if (span) (void)BackingSpan::Capture(store,2,3,account);
        else (void)std::make_shared<JsBackingOwner>(store,account);
      } catch(const std::bad_alloc&) { failed = true; }
      failAllocation.store(-1); assert(failed && free.calls==0);
      const auto after = processLedger.Inspect();
      assert(after.retained==before.retained && after.allocations==before.allocations);
    }
    store.reset(); assert(free.calls==1); account->Detach();
  }
  AssertEmpty(empty);
  {
    FreeState free;
    auto account = std::make_shared<Account>();
    auto store = BackingStore::Prepare(Allocate(12),12,Free,&free);
    auto owner = std::make_shared<JsBackingOwner>(store,account); store->Commit();
    auto a = BackingSpan::Capture(store,2,3,account);
    auto alias = a;
    auto b = BackingSpan::Capture(store,2,3,account);
    auto jsTracked = processLedger.Inspect().retained;
    store->Data()[2]=11;store->Data()[3]=22;store->Data()[4]=33;
    std::memset(store->Data()+3,0,3); // exact pinned RAB shrink action, visible length6->3
    store->Data()[2]=99;
    assert(a->Length()==3 && a->Offset()==2 && a->AllocationCapacity()==12);
    assert(a->Data()[0]==99 && a->Data()[1]==0 && a->Data()[2]==0);
    store->Data()[3]=66; // later prefix write after regrow to6
    assert(a->Data()[0]==99 && a->Data()[1]==66 && a->Data()[2]==0);
    try { (void)BackingSpan::Capture(store,12,1,account); assert(false); }
    catch(const std::out_of_range&) {}
    owner.reset(); // last engine JS owner retires: native payload cost remains
    auto nativeTracked = processLedger.Inspect().retained;
    assert(nativeTracked == jsTracked - sizeof(JsBackingOwner) + 12);
    assert(account->Desired()==nativeTracked);
    store.reset();a.reset();b.reset();assert(free.calls==0);
    alias.reset();assert(free.calls==1 && free.bytes==12);
    account->Detach();
  }
  AssertEmpty(empty);
  {
    FreeState free;
    auto first = std::make_shared<Account>();auto second=std::make_shared<Account>();
    auto store=BackingStore::Prepare(Allocate(64),64,Free,&free);
    auto source=std::make_shared<JsBackingOwner>(store,first);store->Commit();
    auto lease=BackingSpan::Capture(store,7,5,first);
    source.reset(); // actual contextless packet now owns the same native allocation
    auto pendingStore=store;
    auto pending=processLedger.Inspect();assert(pending.retained>=64);
    first->Detach();assert(first->Desired()==0);
    second->Detach();assert(second->Desired()==0);
    auto zeroContexts=processLedger.Inspect();assert(zeroContexts.accounts==0);
    assert(zeroContexts.pending==zeroContexts.retained);
    auto destinationAccount=std::make_shared<Account>();
    auto destination=std::make_shared<JsBackingOwner>(pendingStore,destinationAccount);
    auto afterAdopt=processLedger.Inspect();
    assert(afterAdopt.retained == zeroContexts.retained + sizeof(JsBackingOwner) - 64);
    assert(afterAdopt.projected==afterAdopt.retained);
    destination->Store()->Data()[7]=77;assert(lease->Data()[0]==77);
    destination.reset();pendingStore.reset();store.reset();assert(free.calls==0);
    lease.reset();assert(free.calls==1);destinationAccount->Detach();
  }
  AssertEmpty(empty);
  {
    FreeState free;auto account=std::make_shared<Account>();
    auto store=BackingStore::Prepare(Allocate(64),64,Free,&free);store->Commit();
    std::atomic<bool> ready{false};std::atomic<unsigned> running{0};std::vector<std::thread> workers;
    for(size_t i=0;i<8;++i){auto lease=BackingSpan::Capture(store,i,1,account);
      workers.emplace_back([lease=std::move(lease),i,&ready,&running]{
        running.fetch_add(1);while(!ready.load(std::memory_order_acquire))std::this_thread::yield();
        __atomic_store_n(lease->Data(),uint8_t(i+1),__ATOMIC_RELAXED);
        assert(__atomic_load_n(lease->Data(),__ATOMIC_RELAXED)==i+1);
      });}
    while(running.load()!=8)std::this_thread::yield();
    account->Detach();store.reset();assert(free.calls==0);
    ready.store(true,std::memory_order_release);for(auto& worker:workers)worker.join();
    assert(free.calls==1 && free.bytes==64);
  }
  AssertEmpty(empty);
  {
    FreeState free;auto store=BackingStore::Prepare(Allocate(0),0,Free,&free);store->Commit();
    auto emptySpan=BackingSpan::Capture(store,0,0);store.reset();assert(free.calls==0);
    emptySpan.reset();assert(free.calls==1 && free.bytes==0);
  }
  AssertEmpty(empty);
  std::puts("actual allocation primitive: prepare/commit, six allocation-failure rollbacks, live spans, resize zeros/prefix, alias/transfer-role, zero-account re-adoption, eight-thread final release, zero bytes PASS; engine bridge pending");
}
