// Portable clock owner only. The actual engine wait hooks and JSAPI boundary
// need separate guest-artifact verification on every host.
#include "kandelo-node-performance-clock.h"
#include <cassert>
#include <iostream>
#include <unistd.h>
using kandelo::clock::EventLoopClock;
using kandelo::clock::Nanoseconds;
static uint64_t Now() { uint64_t value; assert(Nanoseconds(&value) == 0); return value; }
static void Busy(uint64_t ns) { const auto start = Now(); while (Now() - start < ns) {} }
static void Read(const EventLoopClock& clock, uint64_t* start, uint64_t* idle) {
  assert(clock.Read(start, idle) == 0);
}
int main() {
  uint64_t start, idle;
  EventLoopClock clock;
  Read(clock, &start, &idle);
  assert(start == 0 && idle == 0);
  std::cout << "unentered state: pass\n";
  const auto before = Now(); clock.Enter(); const auto after = Now();
  Read(clock, &start, &idle); assert(start >= before && start <= after && idle == 0);
  const auto originalStart = start;
  clock.Enter(); Read(clock, &start, &idle); assert(start == originalStart);
  std::cout << "actual stable loop entry: pass\n";
  Busy(12000000); Read(clock, &start, &idle); assert(idle == 0);
  std::cout << "synchronous work stays active: pass\n";
  const auto waitBefore = Now(); clock.BeginIdle();
  usleep(12000); Read(clock, &start, &idle); const auto liveIdle = idle;
  assert(liveIdle > 0 && liveIdle <= Now() - waitBefore);
  clock.EndIdle(); const auto waitAfter = Now(); Read(clock, &start, &idle);
  assert(idle >= liveIdle && idle <= waitAfter - waitBefore);
  const auto savedIdle = idle;
  Busy(12000000); Read(clock, &start, &idle); assert(idle == savedIdle);
  std::cout << "actual live/completed wait excludes later active time: pass\n";
  EventLoopClock other; other.Enter();
  other.BeginIdle(); usleep(3000); other.EndIdle();
  uint64_t otherStart, otherIdle; Read(other, &otherStart, &otherIdle);
  Read(clock, &start, &idle); assert(otherStart > start && otherIdle > 0 && idle == savedIdle);
  std::cout << "independent context owners: pass\n";
  EventLoopClock invalid; invalid.BeginIdle(); errno = 0;
  assert(invalid.Read(&start, &idle) == -1 && errno == EINVAL);
  invalid.Enter(); errno = 0;
  assert(invalid.Read(&start, &idle) == -1 && errno == EINVAL);
  std::cout << "invalid owner state remains an error: pass\n";
}
