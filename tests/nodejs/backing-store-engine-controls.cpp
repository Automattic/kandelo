// Actual portable factory/ledger control; raw VM allocation and async account
// lookup are explicit test dependencies, not engine/JSAPI/GC conformance.
#include "js/experimental/KandeloBackingCapabilities.h"
#include "js/experimental/KandeloBackingTransfers.h"
#include <atomic>
#include <cassert>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <new>
#include <thread>
#include <vector>
#include "kandelo-backing-registry-control.inc"
static JS::KandeloBacking::AccountRef currentAccount;
#include "native-backing-store.cpp"
namespace { static Backing::AccountRef KandeloNativeBackingAccount(JSContext*) noexcept { return currentAccount; } }
namespace B = JS::KandeloBacking;
struct Free { unsigned calls=0; size_t bytes=0; };
static void Release(void* data,size_t bytes,void* value) noexcept {auto* state=static_cast<Free*>(value);++state->calls;state->bytes+=bytes;std::free(data);}
static uint8_t* Data(size_t size) {auto* value=static_cast<uint8_t*>(std::calloc(size?size:1,1));assert(value);return value;}
struct AtomicRef {
 std::atomic<uint32_t> value{1};
 operator uint32_t() const { return value.load(); }
 uint32_t operator--() { return --value; }
 bool compareExchange(uint32_t expected,uint32_t desired) { return value.compare_exchange_strong(expected,desired); }
};
#define MOZ_RELEASE_ASSERT(value) assert(value)
struct SharedArrayRawBuffer {
 AtomicRef refcount_;std::mutex kandeloMutex;
 B::AllocationRef kandeloStore;std::weak_ptr<B::Allocation> kandeloWeakStore;
 uint8_t* payload=Data(24);std::atomic<unsigned>* freed;
 explicit SharedArrayRawBuffer(std::atomic<unsigned>* freed):freed(freed){}
 ~SharedArrayRawBuffer(){std::free(payload);++*freed;}
 bool addReference();bool kandeloAddReferenceLocked();void dropReference();
};
#include "kandelo-shared-owner-control.inc"
static void DropRaw(void*,size_t,void* raw) noexcept { static_cast<SharedArrayRawBuffer*>(raw)->dropReference(); }
static void SharedReferenceControls() {
 std::atomic<unsigned> freed{0};auto* raw=new SharedArrayRawBuffer(&freed);
 auto allocation=B::Prepare(raw->payload,24,DropRaw,raw,true);
 assert(raw->kandeloAddReferenceLocked());allocation->Commit();
 raw->kandeloStore=allocation;raw->kandeloWeakStore=allocation;allocation->SynchronizeJsOwners(1);
 auto queued=allocation->Capture(2,3,currentAccount);
 allocation->SynchronizeJsOwners(0);raw->dropReference();allocation.reset();
 assert(freed==0);
 std::vector<std::thread> workers;
 for(unsigned i=0;i<8;++i)workers.emplace_back([&]{for(unsigned j=0;j<1000;++j){assert(raw->addReference());raw->dropReference();}});
 for(auto& worker:workers)worker.join();assert(freed==0);
 // A new raw owner reconstructs the actual controller after native-only
 // retention. Dropping the lease cannot free the raw owner's live bytes.
 assert(raw->addReference());queued.reset();assert(freed==0);
 raw->payload[2]=88;raw->dropReference();assert(freed==1);
}
int main() {
 auto empty=kandelo::memory::processLedger.Inspect();
 assert(KandeloRegisterBackingCapabilities());assert(KandeloRegisterBackingCapabilities());
 B::Hooks foreign{nullptr,nullptr,nullptr,nullptr};assert(!B::Register(&foreign));
 assert(!B::ResolveAccount(nullptr));
 auto account=std::make_shared<kandelo::memory::Account>();currentAccount=KandeloMakeBackingAccount(account);
 assert(B::ResolveAccount(nullptr)==currentAccount);
 // Actual known owner/span claims must project controller metadata to their
 // environment, instead of leaving it in the process-wide fallback pool.
 {
  auto other=std::make_shared<kandelo::memory::Account>();
  const auto before=kandelo::memory::processLedger.Inspect();
  const size_t otherBefore=other->Desired();
  Free free;auto allocation=B::Prepare(Data(12),12,Release,&free,false);
  auto owner=allocation->MakeOwner(currentAccount,true);allocation->Commit();
  auto queued=allocation->Capture(2,3,currentAccount);
  const auto known=kandelo::memory::processLedger.Inspect();
  if(known.pending!=before.pending || other->Desired()!=otherBefore) {
   std::fprintf(stderr,"Known-owner projection mismatch: pending=%zu expected=%zu; unrelated=%zu expected=%zu\n",
       known.pending,before.pending,other->Desired(),otherBefore);return 1;
  }
  owner.reset();allocation.reset();
  assert(kandelo::memory::processLedger.Inspect().pending==before.pending);
  assert(other->Desired()==otherBefore);
  queued.reset();assert(free.calls==1);other->Detach();
 }
 {
  Free free;auto allocation=B::Prepare(Data(12),12,Release,&free,false);
  auto owner=allocation->MakeOwner(currentAccount,true);allocation->Commit();
  auto queued=allocation->Capture(2,3,currentAccount);
  allocation->Data()[2]=11;allocation->Data()[3]=22;allocation->Data()[4]=33;
  std::memset(allocation->Data()+3,0,3);allocation->Data()[2]=99;
  assert(queued->Length()==3&&queued->Offset()==2&&queued->Capacity()==12&&!queued->Shared());
  assert(queued->Data()[0]==99&&queued->Data()[1]==0&&queued->Data()[2]==0);
  auto packet=std::make_shared<B::Transfers>();
  auto entry=std::make_shared<B::TransferEntry>(allocation,1,6,12,true,nullptr,nullptr);
  size_t index=packet->Add(entry);owner.reset();allocation.reset();
  auto incoming=packet->Get(index);assert(incoming==entry);auto store=incoming->BeginRead();assert(store);
  auto destination=store->MakeOwner(currentAccount,true);
  assert(incoming->CommitRead());assert(!incoming->BeginRead());
  destination->Store()->Data()[3]=66;assert(queued->Data()[1]==66);
  store.reset();destination.reset();packet.reset();entry.reset();incoming.reset();assert(free.calls==0);
  queued.reset();assert(free.calls==1&&free.bytes==12);
 }
 {
  Free free;auto allocation=B::Prepare(Data(8),8,Release,&free,false);allocation->Commit();
  auto packet=std::make_shared<B::Transfers>();auto entry=std::make_shared<B::TransferEntry>(allocation,1,8,8,false,nullptr,nullptr);packet->Add(entry);
  allocation.reset();auto snapshot=entry->BeginRead();assert(snapshot);
  entry->CancelRead();assert(entry->BeginRead()==snapshot);
  packet->Abort();assert(!entry->CommitRead());assert(free.calls==0);
  snapshot.reset();assert(free.calls==1);assert(!packet->Get(0));
 }
 {
  Free free;auto allocation=B::Prepare(Data(32),32,Release,&free,true);allocation->Commit();
  allocation->SynchronizeJsOwners(3);auto owner=allocation->MakeOwner(currentAccount,false);
  auto queued=allocation->Capture(7,2,currentAccount);assert(queued->Shared());
  __atomic_store_n(queued->Data(),uint8_t(88),__ATOMIC_RELAXED);assert(queued->Data()[0]==88);
  allocation->SynchronizeJsOwners(0);owner.reset();allocation.reset();assert(free.calls==0);
  account->Detach();currentAccount.reset();assert(!B::ResolveAccount(nullptr));
  auto pending=kandelo::memory::processLedger.Inspect();assert(pending.accounts==0&&pending.pending==pending.retained);
  queued.reset();assert(free.calls==1&&free.bytes==32);
 }
 SharedReferenceControls();
 auto final=kandelo::memory::processLedger.Inspect();assert(final.retained==empty.retained&&final.allocations==empty.allocations);
 std::puts("actual C++17 capability/transfer machinery + C++20 native factory: prepared ownership, original spans, transfer commit/retry/abort, shared count, retired resolver, ledger retirement PASS; VM JSAPI uncompiled");
}
