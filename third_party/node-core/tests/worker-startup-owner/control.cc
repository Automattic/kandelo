#include "../../worker-startup-owner.h"
#include "../../port-transit-graph.h"
#include <atomic>
#include <cassert>
#include <future>
#include <memory>
#include <thread>
namespace Transit = kandelo::ports::transit;
struct Packet : Transit::Node {
  int identity;
  explicit Packet(int value) : identity(value) {}
  void Retire() noexcept override {}
};
using Root = Transit::Root<Packet>;
using Gate = kandelo::worker::StartupGate<Root>;
int main() {
  {
    Gate gate;Root bootstrap(std::make_shared<Packet>(11)),input(std::make_shared<Packet>(22));
    assert(gate.Publish(std::move(bootstrap),std::move(input)));
    assert(!gate.Publish({},{}));
    Root a,b;assert(gate.Take(true,&a,[]{return true;})==Gate::Read::Ready);
    assert(gate.Take(false,&b,[]{return true;})==Gate::Read::Ready);
    assert(a->identity==11&&b->identity==22);
    Root repeated;assert(gate.Take(true,&repeated,[]{return true;})==Gate::Read::Repeated);
    assert(gate.Take(false,&repeated,[]{return true;})==Gate::Read::Repeated);
    gate.Clear([](auto& packet){packet.reset();});
  }
  {
    Gate gate;assert(gate.Publish(Root(std::make_shared<Packet>(33)),{}));
    std::atomic<unsigned> checkpoints{0};Gate::Read result=Gate::Read::Ready;
    std::thread child([&]{Root a,b;assert(gate.Take(true,&a,[]{return true;})==Gate::Read::Ready);assert(a->identity==33);
      result=gate.Take(false,&b,[&]{++checkpoints;gate.Stop();return true;});assert(!b);});
    child.join();assert(checkpoints==1&&result==Gate::Read::Stopped);
    gate.Clear([](auto& packet){packet.reset();});
  }
  {
    Gate gate;Root absent;
    assert(gate.Take(true,&absent,[&]{gate.Stop();return false;})==Gate::Read::Interrupted);
    assert(!absent); // Real reentrant Stop proved the interrupt owns no mutex.
    assert(gate.Take(true,&absent,[]{return true;})==Gate::Read::Repeated);
  }
  {
    Gate gate;std::promise<void> checkpoint;auto observed=checkpoint.get_future();
    std::atomic<bool> announced{false};Gate::Read result=Gate::Read::Ready;
    std::thread child([&]{Root absent;result=gate.Take(true,&absent,[&]{if(!announced.exchange(true))checkpoint.set_value();return true;});assert(!absent);});
    assert(observed.wait_for(std::chrono::seconds(2))==std::future_status::ready);
    gate.Clear([](auto& packet){packet.reset();});child.join();assert(result==Gate::Read::Stopped);
  }
  {
    Gate gate;unsigned retired=0;
    assert(gate.Publish(Root(std::make_shared<Packet>(44)),Root(std::make_shared<Packet>(55))));
    gate.Clear([&](auto& packet){gate.Stop();if(packet){++retired;packet.reset();}});
    assert(retired==2);Root absent;
    assert(gate.Take(true,&absent,[]{return true;})==Gate::Read::Stopped);
    assert(gate.Take(false,&absent,[]{return true;})==Gate::Read::Stopped);
  }
  Transit::Graph::Process().Collect(true);
}
