#include "third_party/node-core/port-queue.h"
#include <atomic>
#include <cassert>
#include <iostream>
#include <thread>
#include <vector>

struct Packet {
  std::shared_ptr<const int> bytes;
  int sender, sequence;
};
using Registry = kandelo::ports::BroadcastRegistry<Packet>;
using Endpoint = Registry::Port;
int main() {
  Registry registry;
  auto a = registry.Join("same"), b = registry.Join("same"), c = registry.Join("same");
  auto other = registry.Join("other");
  auto storage = std::make_shared<const int>(42);
  std::weak_ptr<const int> retained = storage;
  int allocations = 0;
  auto factory = [&] { allocations++; return std::make_shared<Packet>(Packet{storage, 0, 0}); };
  assert(a->Post(factory) == Registry::Posted::Delivered && allocations == 2);
  assert(a->Receiver()->Receive(true).kind == Endpoint::Kind::Empty);
  assert(other->Receiver()->Receive(true).kind == Endpoint::Kind::Empty);
  assert(b->Receiver()->Receive().kind == Endpoint::Kind::Empty);
  auto first = b->Receiver()->Receive(true), second = c->Receiver()->Receive(true);
  assert(first.message != second.message && first.message->bytes == second.message->bytes);
  storage.reset(); assert(!retained.expired());
  first.message.reset(); assert(!retained.expired());
  second.message.reset(); assert(retained.expired());
  b->Close();
  storage = std::make_shared<const int>(43);
  assert(a->Post(factory) == Registry::Posted::Delivered);
  assert(*c->Receiver()->Receive(true).message->bytes == 43);
  assert(b->Receiver()->Receive().kind == Endpoint::Kind::Close);
  b->Receiver()->AcknowledgeClose();
  assert(c->Receiver()->Receive().kind == Endpoint::Kind::Empty);
  c->Close();
  const auto before = allocations;
  assert(a->Post(factory) == Registry::Posted::NoDestinations && allocations == before);
  a->Close(); assert(a->Post(factory) == Registry::Posted::Closed);
  // Reusing a name does not attach a previously closed owner to its new group.
  auto replacement = registry.Join("same");
  assert(replacement->Post(factory) == Registry::Posted::NoDestinations);
  replacement.reset(); other.reset(); a.reset(); b.reset(); c.reset();
  auto emptyA = registry.Join(""), emptyB = registry.Join("");
  emptyA->Close();
  assert(emptyB->Receiver()->Receive(true).kind == Endpoint::Kind::Close);
  assert(emptyB->Post(factory) == Registry::Posted::Closed);
  emptyA.reset(); emptyB.reset();

  constexpr int workers = 4, messages = 500;
  std::vector<std::shared_ptr<Registry::Member>> members;
  for (int i = 0; i < workers; i++) members.push_back(registry.Join("threaded"));
  std::vector<std::thread> senders;
  for (int i = 0; i < workers; i++) senders.emplace_back([&, i] {
    for (int n = 0; n < messages; n++) {
      assert(members[i]->Post([&] {
        return std::make_shared<Packet>(Packet{storage, i, n});
      }) == Registry::Posted::Delivered);
    }
  });
  for (auto& sender : senders) sender.join();
  for (int i = 0; i < workers; i++) {
    std::vector<int> next(workers);
    for (int n = 0; n < (workers - 1) * messages; n++) {
      auto value = members[i]->Receiver()->Receive(true);
      assert(value.kind == Endpoint::Kind::MessageValue);
      assert(value.message->sender != i);
      assert(value.message->sequence == next[value.message->sender]++);
    }
    assert(members[i]->Receiver()->Receive(true).kind == Endpoint::Kind::Empty);
  }
  members.clear();
  // Serialize concurrent close/teardown against publication; the remaining
  // owner must neither deadlock nor receive a peer-close marker from a group.
  auto sender = registry.Join("race"), receiver = registry.Join("race");
  std::thread publication([&] {
    for (int n = 0; n < 1000; n++) sender->Post([&] {
      return std::make_shared<Packet>(Packet{storage, 0, n});
    });
  });
  std::thread teardown([&] { receiver.reset(); });
  publication.join(); teardown.join();
  assert(sender->Receiver()->Receive(true).kind == Endpoint::Kind::Empty);
  assert(sender->Post(factory) == Registry::Posted::NoDestinations);
  std::cout << "{\"passed\":true,\"threadedDeliveries\":6000,\"closeRacePublications\":1000}" << std::endl;
}
