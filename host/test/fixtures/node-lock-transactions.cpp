#include "lock-manager.h"
#include "provider-rotation.h"
#include <cassert>
#include <iostream>
#include <stdexcept>
#include <vector>
using namespace kandelo::locks;
int main() {
  Manager manager;
  const auto a = manager.Register(), b = manager.Register();
  const auto held = manager.Request(a, u"transaction", "a", Mode::Exclusive);
  manager.Next(a);
  const auto steal = manager.Request(a, u"transaction", "a", Mode::Exclusive, true);
  const auto prepared = manager.Preview(a);
  assert(prepared.info.id == steal && prepared.localStolen == std::vector<Identity>{held});
  // A failed packet/receiver allocation has NO state transition to roll back.
  try { throw std::bad_alloc(); } catch (const std::bad_alloc&) {}
  assert(manager.Query(a).held.size() == 1 && manager.Query(a).held[0].id == held);
  assert(manager.Query(a).pending.size() == 1 && manager.Query(a).pending[0].id == steal);
  assert(manager.Preview(a).localStolen == prepared.localStolen);
  assert(manager.Commit(prepared));
  assert(!manager.Commit(prepared));
  assert(manager.Complete(a, held) == Completion::Stolen);
  assert(manager.Complete(a, steal) == Completion::Completed);

  // Cross-context progress invalidates a prepared miss rather than granting
  // a null result after the resource has actually become available.
  const auto holder = manager.Request(a, u"race", "a", Mode::Exclusive); manager.Next(a);
  const auto miss = manager.Request(b, u"race", "b", Mode::Exclusive, false, true);
  const auto oldMiss = manager.Preview(b); assert(oldMiss.kind == Event::Kind::Miss);
  manager.Complete(a, holder);
  assert(!manager.Commit(oldMiss));
  const auto grant = manager.Preview(b); assert(grant.kind == Event::Kind::Grant && grant.info.id == miss);
  assert(manager.Commit(grant)); manager.Complete(b, miss);

  // A new priority steal invalidates an older preview without consuming either.
  const auto ordinary = manager.Request(a, u"priority", "a", Mode::Exclusive);
  const auto preview = manager.Preview(a);
  const auto priority = manager.Request(b, u"priority", "b", Mode::Exclusive, true);
  assert(!manager.Commit(preview));
  assert(manager.Next(b).info.id == priority);
  manager.Complete(b, priority); assert(manager.Next(a).info.id == ordinary); manager.Complete(a, ordinary);

  // A foreign-steal notification remains observable if packet allocation fails.
  const auto victim = manager.Request(a, u"foreign", "a", Mode::Exclusive); manager.Next(a);
  const auto replacement = manager.Request(b, u"foreign", "b", Mode::Exclusive, true); manager.Next(b);
  const auto notification = manager.Preview(a); assert(notification.kind == Event::Kind::Stolen);
  assert(manager.Ready(a)); assert(manager.Preview(a).info.id == victim);
  assert(manager.Commit(notification)); assert(!manager.Ready(a));
  manager.Complete(a, victim); manager.Complete(b, replacement);

  // Retiring a receiver invalidates its prepared packet and releases its state.
  const auto doomed = manager.Register(); manager.Request(doomed, u"retire", "d", Mode::Exclusive);
  const auto retirement = manager.Preview(doomed); manager.Retire(doomed);
  assert(!manager.Commit(retirement));
  manager.Retire(a); manager.Retire(b);

  using kandelo::node_loop::Provider;
  kandelo::node_loop::ProviderRotation rotation;
  unsigned granted[4]{};
  for (unsigned turn = 0; turn < 400; ++turn) {
    unsigned callbacks = 0;
    assert(rotation.Dispatch([&](Provider provider) { callbacks++; granted[unsigned(provider)]++; return 1; }) == 1);
    assert(callbacks == 1);
  }
  for (unsigned count : granted) assert(count == 100);
  // Idle attempts neither manufacture progress nor references. A ready lock
  // bypasses idle providers and retains the ordinary next-turn ordering.
  assert(rotation.Dispatch([](Provider) { return 0; }) == 0);
  assert(rotation.Dispatch([](Provider provider) { return provider == Provider::Locks ? 1 : 0; }) == 1);
  unsigned attempted = 0;
  assert(rotation.Dispatch([&](Provider) { attempted++; return -1; }) == -1 && attempted == 1);
  std::cout << "{\"passed\":true,\"transactions\":6,\"mixedProviderTurns\":400,\"scope\":\"actual portable transaction/rotation owners; no guest JSAPI or provider runtime execution\"}\n";
}
