#include "lock-manager.h"
#include <atomic>
#include <cassert>
#include <future>
#include <iostream>
#include <thread>
using namespace kandelo::locks;
using namespace std::chrono_literals;
int main() {
  Manager manager;
  const auto a = manager.Register(), b = manager.Register(), c = manager.Register();
  const auto first = manager.Request(a, u"resource", "a", Mode::Exclusive);
  assert(manager.Ready(a));
  assert(manager.Next(a).info.id == first);
  assert(!manager.Ready(a)); // Held promises are not loop keepers.
  const auto second = manager.Request(b, u"resource", "b", Mode::Exclusive);
  const auto third = manager.Request(c, u"resource", "c", Mode::Shared);
  assert(!manager.Ready(b) && !manager.Ready(c));
  assert(manager.Query(a).held.size() == 1 && manager.Query(a).pending.empty());
  assert(manager.Query(b).held.empty() && manager.Query(b).pending.size() == 1);
  assert(manager.Complete(b, first) == Completion::Absent); // Exact owner authority.
  assert(manager.Complete(a, first) == Completion::Completed);
  assert(manager.Next(c).kind == Event::Kind::Empty); // Earlier exclusive waits first.
  assert(manager.Next(b).info.id == second);
  manager.Complete(b, second);
  assert(manager.Next(c).info.id == third);
  const auto shared = manager.Request(a, u"resource", "a", Mode::Shared);
  assert(manager.Next(a).info.id == shared);
  const auto miss = manager.Request(b, u"resource", "b", Mode::Exclusive, false, true);
  assert(manager.Next(b).kind == Event::Kind::Miss);
  assert(manager.Query(b).held.empty());
  manager.Complete(b, miss);
  const auto stolen = manager.Request(b, u"resource", "b", Mode::Exclusive, true);
  assert(manager.Next(b).info.id == stolen);
  assert(manager.Ready(a) && manager.Ready(c));
  assert(manager.Next(a).kind == Event::Kind::Stolen);
  assert(manager.Next(a).kind == Event::Kind::Empty);
  assert(manager.Complete(a, shared) == Completion::Stolen);
  // A callback settling before its receiving wake still observes the steal.
  assert(manager.Complete(c, third) == Completion::Stolen);
  manager.Complete(b, stolen);

  // Own-environment steals reject the old holder before the new callback.
  const auto local = manager.Request(a, u"local-steal", "a", Mode::Exclusive);
  manager.Next(a);
  const auto replacement = manager.Request(a, u"local-steal", "a", Mode::Exclusive, true);
  const auto localGrant = manager.Next(a);
  assert(localGrant.info.id == replacement && localGrant.localStolen == std::vector<Identity>{local});
  assert(manager.Next(a).kind == Event::Kind::Empty);
  assert(manager.Complete(a, local) == Completion::Stolen);
  manager.Complete(a, replacement);

  // Simultaneous steal submissions retain the pinned front-of-queue rule.
  const auto oldSteal = manager.Request(b, u"priority-steal", "b", Mode::Exclusive, true);
  const auto newSteal = manager.Request(c, u"priority-steal", "c", Mode::Exclusive, true);
  assert(manager.Next(b).kind == Event::Kind::Empty);
  assert(manager.Next(c).info.id == newSteal);
  assert(manager.Next(b).info.id == oldSteal);
  assert(manager.Complete(c, newSteal) == Completion::Stolen);
  manager.Complete(b, oldSteal);

  // Names retain code units (including embedded NUL and lone surrogates).
  const std::u16string nul{u'x', 0, u'y'}, surrogate{char16_t(0xd800)};
  const auto n = manager.Request(a, nul, "a", Mode::Exclusive);
  const auto s = manager.Request(a, surrogate, "a", Mode::Exclusive);
  assert(manager.Next(a).info.name == nul);
  assert(manager.Next(a).info.name == surrogate);
  manager.Complete(a, n); manager.Complete(a, s);

  // A real blocked thread wakes when the holder environment is retired.
  const auto dead = manager.Register(), waiter = manager.Register();
  manager.Request(dead, u"cleanup", "dead", Mode::Exclusive);
  assert(manager.Next(dead).kind == Event::Kind::Grant);
  const auto waiting = manager.Request(waiter, u"cleanup", "waiter", Mode::Exclusive);
  std::promise<void> entered;
  auto resumed = std::async(std::launch::async, [&] {
    entered.set_value();
    assert(manager.WaitForReady(waiter, 5s));
    const auto event = manager.Next(waiter);
    assert(event.kind == Event::Kind::Grant && event.info.id == waiting);
  });
  entered.get_future().get();
  manager.Retire(dead);
  resumed.get();
  assert(manager.Query(dead).held.empty());
  assert(manager.Next(dead).kind == Event::Kind::Empty);
  manager.Retire(waiter);

  // Retiring an earlier blocked request removes its fairness obstruction.
  auto holder = manager.Register(), blocked = manager.Register(), reader = manager.Register();
  manager.Request(holder, u"queue-cleanup", "holder", Mode::Shared); manager.Next(holder);
  manager.Request(blocked, u"queue-cleanup", "blocked", Mode::Exclusive);
  const auto read = manager.Request(reader, u"queue-cleanup", "reader", Mode::Shared);
  assert(!manager.Ready(reader));
  manager.Retire(blocked);
  assert(manager.Next(reader).info.id == read);
  manager.Retire(holder); manager.Retire(reader);

  std::atomic<unsigned> critical{0};
  unsigned counter = 0;
  std::vector<std::thread> threads;
  for (unsigned t = 0; t < 4; t++) {
    threads.emplace_back([&] {
      const auto env = manager.Register();
      for (unsigned i = 0; i < 250; i++) {
        const auto id = manager.Request(env, u"threaded", "thread", Mode::Exclusive);
        assert(manager.WaitForReady(env, 5s));
        const auto event = manager.Next(env);
        assert(event.kind == Event::Kind::Grant && event.info.id == id);
        assert(critical.fetch_add(1) == 0);
        counter++;
        assert(critical.fetch_sub(1) == 1);
        assert(manager.Complete(env, id) == Completion::Completed);
      }
      manager.Retire(env);
    });
  }
  for (auto& thread : threads) thread.join();
  assert(counter == 1000);
  manager.Retire(a); manager.Retire(b); manager.Retire(c);
  std::cout << "{\"passed\":true,\"threadedExclusiveGrants\":1000,\"scope\":\"Native C++ metadata/ordering/ownership/wait/teardown controls; no guest JSAPI or four-host conformance\"}\n";
}
