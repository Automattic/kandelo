#include "histogram-owner-inl.h"
#include "event-loop-delay.h"
#include <array>
#include <cstdlib>
#include <iostream>
#include <new>
static bool denyAllocation = false;
static int failAfter = -1;
void* operator new(std::size_t size) {
  if (denyAllocation || failAfter == 0) throw std::bad_alloc();
  if (failAfter > 0) --failAfter;
  if (void* p = std::malloc(size ? size : 1)) return p;
  throw std::bad_alloc();
}
void operator delete(void* p) noexcept { std::free(p); }
void operator delete(void* p, std::size_t) noexcept { std::free(p); }
namespace js::shell {
// Only the existing primitive async lifetime interface is a test dependency.
// No fake JSAPI/provider/GC events are emitted by this native control.
struct KandeloNativeAsyncState {
  size_t references = 1, count = 0;
  std::array<double, 4096> ids{};
  void Retain() noexcept { ++references; }
  void Release() noexcept { --references; }
  void Finalized(double id) noexcept { ids[count++] = id; }
};
}
namespace {
using kandelo::histogram::EventLoopDelayLoop;
using kandelo::histogram::EventLoopDelayProducer;
#include "eld-native-state-control.inc"
}
namespace memory = kandelo::memory;
using namespace kandelo::histogram;
static void Conserved(const memory::AccountHandle& account) {
  const auto totals = memory::processLedger.Inspect();
  assert(totals.retained == totals.projected && totals.projected == account->Desired());
}
int main() {
  assert(memory::processLedger.Inspect().retained == 0);
  auto account = std::make_shared<memory::Account>();
  ELDRegistry<int, KandeloELDContext> registry;
  auto context = std::make_shared<KandeloELDContext>(account, registry.RetainedAllocation());
  registry.Add(1, context);
  js::shell::KandeloNativeAsyncState lifetime;
  auto producer = context->loop->Create({1,1000000,2}, EventLoopDelayProducer::Mode::Interval, 1);
  auto clone = producer->ShareMaterialForClone();
  auto state = std::make_shared<KandeloELDState>(std::move(producer), account);
  state->closeQueue = context->closes; state->lifetime = &lifetime; lifetime.Retain(); state->id = 7;
  context->Track(state);
  auto handle = std::make_unique<KandeloELDHandle>(state, account);
  state.reset();
  std::weak_ptr<KandeloELDState> weak = handle->state;
  const auto before = memory::processLedger.Inspect().retained;
  Conserved(account);
  // The production GC ownership operations, under a global allocation denial.
  denyAllocation = true;
  handle->state->producer->Close();
  context->closes->Enqueue(std::move(handle->state)); handle.reset();
  denyAllocation = false;
  assert(!weak.expired() && context->closes->Pending() && lifetime.count == 0);
  assert(memory::processLedger.Inspect().retained == before-sizeof(KandeloELDHandle));
  Conserved(account);
  memory::CreditBalance credit; size_t added=0, removed=0;
  auto flush = [&] { credit.Flush(account->Desired(), [&](size_t n){added+=n;}, [&](size_t n){removed+=n;}); };
  flush();
  // Retiring the primary environment cannot erase a live native close cost.
  account->Detach(); flush(); assert(added==removed && !credit.Associated());
  auto pending=memory::processLedger.Inspect();
  assert(pending.retained==pending.pending && !pending.projected && pending.retained>0);
  auto successor=std::make_shared<memory::Account>(); Conserved(successor);
  denyAllocation=true; context->closes->Drain(); denyAllocation=false;
  assert(weak.expired() && !context->closes->Pending() && lifetime.count==1 && lifetime.ids[0]==7 && lifetime.references==1);
  Conserved(successor);
  // Native aliases own statistics only; neither sampler nor close state survives.
  registry.Erase(1); context.reset();
  const auto hdr=sizeof(Histogram)+clone->GetMemorySize();
  assert(memory::processLedger.Inspect().retained==hdr && registry.StorageBytes()==0);
  clone.reset(); assert(memory::processLedger.Inspect().retained==0);
  std::cout<<"GC-to-close retention, no-allocation enqueue/drain, context detach/adoption, matched credit and clone-only final owner passed\n";
  // Explicit enqueue order is the pinned libuv head-insertion order; this
  // does not assert equivalence of GC scheduling between engines.
  auto queue=std::make_shared<KandeloELDCloseQueue>(successor);
  auto loop=std::make_shared<EventLoopDelayLoop>(0);
  for(int i=0;i<3;i++) {
    auto p=loop->Create({1,1000,2},EventLoopDelayProducer::Mode::Iteration,1);
    auto s=std::make_shared<KandeloELDState>(std::move(p),successor);
    s->lifetime=&lifetime;lifetime.Retain();s->id=10+i;
    denyAllocation=true;queue->Enqueue(std::move(s));denyAllocation=false;
  }
  denyAllocation=true;queue->Drain();denyAllocation=false;
  assert(lifetime.count==4 && lifetime.ids[1]==12 && lifetime.ids[2]==11 && lifetime.ids[3]==10 && lifetime.references==1);
  queue->Shutdown();
  {
    auto p=loop->Create({1,1000,2},EventLoopDelayProducer::Mode::Interval,1);
    auto s=std::make_shared<KandeloELDState>(std::move(p),successor);
    s->lifetime=&lifetime;lifetime.Retain();s->id=20;
    denyAllocation=true;queue->Enqueue(std::move(s));denyAllocation=false;
  }
  assert(!queue->Pending() && lifetime.count==5 && lifetime.ids[4]==20);
  queue.reset();loop.reset();assert(memory::processLedger.Inspect().retained==0);
  std::cout<<"native LIFO close order, detached close and exactly-once provider retirement passed\n";
  // Actual registry/owner-vector growth and weak registrations retire with
  // their real contexts; no map-node size estimate or fixed budget is used.
  for(int round=0;round<8;round++) {
    for(int i=0;i<24;i++) {
      auto c=std::make_shared<KandeloELDContext>(successor,registry.RetainedAllocation());registry.Add(i,c);
      for(int n=0;n<8;n++) {
        auto p=c->loop->Create({1,1000,2},EventLoopDelayProducer::Mode::Interval,1);
        auto s=std::make_shared<KandeloELDState>(std::move(p),successor);c->Track(s);
        s->closeQueue=c->closes;c->closes->Enqueue(std::move(s));
      }
      Conserved(successor);
    }
    for(int i=0;i<24;i++) {auto c=registry.Find(i);c->Shutdown();registry.Erase(i);}
    assert(registry.StorageBytes()==0 && memory::processLedger.Inspect().retained==0);
  }
  size_t failures=0, successes=0;
  for(int failurePoint=0;failurePoint<40;failurePoint++) {
    failAfter=failurePoint;
    try {
      auto c=std::make_shared<KandeloELDContext>(successor,registry.RetainedAllocation());
      registry.Add(77,c);
      auto p=c->loop->Create({1,1000,2},EventLoopDelayProducer::Mode::Interval,1);
      auto st=std::make_shared<KandeloELDState>(std::move(p),successor);
      auto h=std::make_unique<KandeloELDHandle>(st,successor);c->Track(st);
      c->closes->Enqueue(std::move(h->state));h.reset();st.reset();
      c->Shutdown();registry.Erase(77);++successes;
    } catch(const std::bad_alloc&) { ++failures; }
    failAfter=-1;
    if(auto c=registry.Find(77)){c->Shutdown();registry.Erase(77);}
    assert(memory::processLedger.Inspect().retained==0 && registry.StorageBytes()==0);
  }
  assert(failures>0 && successes>0);
  std::cout<<"40 construction/publication OOM positions preserve actual storage/claim rollback ("<<failures<<" failures, "<<successes<<" successes)\n";
  successor->Detach();assert(memory::processLedger.Inspect().retained==0);
  std::cout<<"1536 state/producer lifetimes through real vector capacity growth/shutdown conserved\n";
}
