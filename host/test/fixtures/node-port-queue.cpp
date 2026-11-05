#include "port-queue.h"
#include <cassert>
#include <chrono>
#include <iostream>
#include <string>
#include <thread>
using E = kandelo::ports::Endpoint<int>;
int main() {
  using namespace std::chrono_literals;
  auto pair = E::Pair(); auto a = pair.first, b = pair.second;
  a->Ref(false); b->Ref(false);
  assert(!a->KeepsLoopAlive() && !b->KeepsLoopAlive());
  assert(a->Send(std::make_shared<int>(11)));
  assert(b->Receive().kind == E::Kind::Empty);
  auto forced = b->Receive(true); assert(forced.kind == E::Kind::MessageValue && *forced.message == 11);
  b->Ref(true); assert(b->KeepsLoopAlive()); // Ref does not require start.
  b->Start(true);
  std::thread sender([a] { for (int i = 0; i < 1000; i++) assert(a->Send(std::make_shared<int>(i))); });
  for (int i = 0; i < 1000; i++) {
    assert(b->WaitForReady(5s));
    auto value = b->Receive(); assert(value.kind == E::Kind::MessageValue && *value.message == i);
  }
  sender.join(); b->Start(false); b->Ref(false);
  assert(a->Send(std::make_shared<int>(12))); a->Close();
  assert(a->KeepsLoopAlive()); assert(a->Receive().kind == E::Kind::Close);
  assert(a->KeepsLoopAlive()); a->AcknowledgeClose();
  assert(a->Receive().kind == E::Kind::Empty); assert(!a->KeepsLoopAlive());
  assert(b->Receive().kind == E::Kind::Empty); // Peer close follows queued data.
  auto value = b->Receive(true); assert(*value.message == 12);
  assert(b->Receive().kind == E::Kind::Close); b->AcknowledgeClose(); assert(!b->KeepsLoopAlive());
  assert(!a->Send(std::make_shared<int>(13)));
  auto next = E::Pair(); next.second->Ref(false); next.first.reset();
  assert(next.second->Receive().kind == E::Kind::Close);
  auto cleanup = E::Pair(); auto data = std::make_shared<int>(42); std::weak_ptr<int> observer = data;
  cleanup.first->Send(std::move(data)); assert(!observer.expired());
  cleanup.second->Abandon(); assert(observer.expired());
  std::cout << "{\"passed\":true,\"threadedPackets\":1000,\"scope\":\"Actual C++ endpoint queue/ref/start/close/lifetime owner on native host; no JS engine/serialization/four-host conformance\"}\n";
}
