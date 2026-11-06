#include "event-loop-delay.h"
#include <iostream>
using namespace kandelo::histogram;
static uint64_t tick = 100000000;
static uint64_t Clock() { return tick; }
static uint64_t uv_hrtime() { return Clock(); }
struct ReferenceIteration;
struct TestCheck { ReferenceIteration* owner; };
struct ReferenceIteration {
  bool enabled_ = true;
  uint64_t prepare_time_ = 0, check_time_ = 0;
  int timeout_ = 0;
  std::shared_ptr<Histogram> material;
  const std::shared_ptr<Histogram>& histogram() { return material; }
  static void CheckCB(TestCheck* handle);
};
#include "reference-check.h"

static void Formula(uint64_t before, uint64_t poll, int timeout, int64_t highest = INT64_MAX) {
  auto loop = std::make_shared<EventLoopDelayLoop>(tick / 1000000, Clock);
  Histogram::Options options{1, highest, 3};
  auto candidate = loop->Create(options, EventLoopDelayProducer::Mode::Iteration, 10);
  ReferenceIteration reference;
  reference.material = Histogram::Create(options, Clock);
  reference.check_time_ = tick;
  HistogramInvariant(candidate->Start());
  tick += before; candidate->Prepare(timeout); reference.prepare_time_ = tick; reference.timeout_ = timeout;
  tick += poll; candidate->Check(); TestCheck handle{&reference}; ReferenceIteration::CheckCB(&handle);
  HistogramInvariant(candidate->histogram()->Export() == reference.material->Export());
  HistogramInvariant(candidate->histogram()->Exceeds() == reference.material->Exceeds());
  // Reset removes measurements without moving the native check baseline.
  candidate->histogram()->Reset(); reference.material->Reset();
  tick += before; candidate->Prepare(timeout); reference.prepare_time_ = tick;
  tick += poll; candidate->Check(); ReferenceIteration::CheckCB(&handle);
  HistogramInvariant(candidate->histogram()->Export() == reference.material->Export());
}
int main() {
  Formula(0, 0, 0); Formula(1500, 500, 0); Formula(10, 10000000, 10);
  Formula(10, 9999999, 10); Formula(10, 10002000, 10);
  Formula(10000, 500000000, -1); Formula(10000, 500000000, INT_MAX);
  Formula(10000000, 50000000, 0, 1000);
  auto loop = std::make_shared<EventLoopDelayLoop>(100, Clock);
  tick = 100000000;
  auto interval = loop->Create({1, INT64_MAX, 3}, EventLoopDelayProducer::Mode::Interval, 10);
  HistogramInvariant(!loop->HasReferences() && interval->Start() && !interval->Start());
  HistogramInvariant(loop->NextTimeout(-1, false) == -1);
  HistogramInvariant(loop->NextTimeout(-1, true) == 10 && loop->NextTimeout(5, true) == 5);
  loop->UpdateTime(109); tick = 109000000; loop->RunTimers();
  HistogramInvariant(interval->histogram()->Count() == 0);
  loop->UpdateTime(110); tick = 110000000; loop->RunTimers();
  HistogramInvariant(interval->histogram()->Count() == 0);
  loop->UpdateTime(200); tick = 200000000; loop->RunTimers();
  HistogramInvariant(interval->histogram()->Count() == 1 && loop->NextTimeout(-1, true) == 10);
  loop->RunTimers(); HistogramInvariant(interval->histogram()->Count() == 1);
  HistogramInvariant(interval->Stop() && !interval->Stop());
  loop->UpdateTime(250); tick = 250000000; loop->RunTimers();
  HistogramInvariant(loop->NextTimeout(-1, true) == -1 && interval->Start());
  loop->UpdateTime(260); tick = 260000000; loop->RunTimers();
  HistogramInvariant(interval->histogram()->CountAt(60000000) == 1);
  interval->histogram()->Reset();
  loop->UpdateTime(270); tick = 270000000; loop->RunTimers();
  HistogramInvariant(interval->histogram()->Count() == 0);
  loop->UpdateTime(280); tick = 280000000; loop->RunTimers();
  HistogramInvariant(interval->histogram()->Count() == 1);
  auto shared = interval->ShareMaterialForClone();
  std::weak_ptr<EventLoopDelayProducer> weak = interval;
  interval.reset(); HistogramInvariant(weak.expired() && loop->Registrations() == 0 && shared->Count() == 1);
  auto iteration = loop->Create({1, INT64_MAX, 3}, EventLoopDelayProducer::Mode::Iteration, 10);
  HistogramInvariant(iteration->Start() && loop->NextTimeout(-1, true) == -1);
  loop->Prepare(10); tick += 10000000; loop->Check();
  HistogramInvariant(iteration->histogram()->Min() == 1);
  auto material = iteration->ShareMaterialForClone();
  loop->Shutdown(); HistogramInvariant(iteration->closed() && !iteration->Start());
  tick += 1000000; loop->Check(); loop->RunTimers();
  HistogramInvariant(material->Count() == 1);
  auto overflow = std::make_shared<EventLoopDelayLoop>(UINT64_MAX - 5, Clock);
  auto timer = overflow->Create({1, INT64_MAX, 3}, EventLoopDelayProducer::Mode::Interval, 10);
  timer->Start(); HistogramInvariant(overflow->NextTimeout(-1, true) == 5);
  overflow->UpdateTime(UINT64_MAX); overflow->RunTimers();
  HistogramInvariant(timer->histogram()->Count() == 0); // one warmup, no catchup loop
  std::cout << "8 exact pinned CheckCB comparisons plus reset, weak lifetime, unref, timer phase, restart, shutdown and overflow controls passed\n";
}
