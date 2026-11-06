// Native event-loop-delay producers over the pinned histogram material.
// These objects sample actual native loop phases; they do not schedule JS.
#ifndef KANDELO_NODE_EVENT_LOOP_DELAY_H_
#define KANDELO_NODE_EVENT_LOOP_DELAY_H_
#include "histogram-owner.h"
#include "event-loop-delay-lifetime.h"
#include <algorithm>
#include <climits>
#include <optional>

namespace kandelo::histogram {
class EventLoopDelayLoop;
class EventLoopDelayProducer final : public ELDRetained<EventLoopDelayProducer> {
 public:
  enum class Mode { Interval, Iteration };
  EventLoopDelayProducer(std::shared_ptr<Histogram> histogram,
      std::weak_ptr<EventLoopDelayLoop> loop, Mode mode, uint64_t resolution,
      HistogramClock clock)
      : histogram_(std::move(histogram)), loop_(std::move(loop)), mode_(mode),
        resolution_(resolution), clock_(clock) {}
  EventLoopDelayProducer(const EventLoopDelayProducer&) = delete;
  EventLoopDelayProducer& operator=(const EventLoopDelayProducer&) = delete;
  ~EventLoopDelayProducer() { Close(); }
  bool Start(bool reset = false);
  bool Stop() {
    if (!enabled_ || closed_) return false;
    enabled_ = false; return true;
  }
  void Close() { enabled_ = false; closed_ = true; }
  bool enabled() const { return enabled_; }
  bool closed() const { return closed_; }
  Mode mode() const { return mode_; }
  const std::shared_ptr<Histogram>& histogram() const { return histogram_; }

  // Actual native prepare/check hooks, using the provider's requested timeout
  // in milliseconds, including -1 for an indefinite poll. No inferred timeout
  // from elapsed time or public JS timers is an acceptable replacement.
  void Prepare(int backend_timeout_ms) {
    if (!enabled_ || closed_ || mode_ != Mode::Iteration) return;
    prepare_time_ = clock_(); timeout_ = backend_timeout_ms;
  }
  void Check() {
    if (!enabled_ || closed_ || mode_ != Mode::Iteration) return;
    const uint64_t check_time = clock_();
    HistogramInvariant(check_time >= prepare_time_ && prepare_time_ >= check_time_);
    const uint64_t poll_time = check_time - prepare_time_;
    uint64_t latency = prepare_time_ - check_time_;
    if (timeout_ >= 0) {
      const uint64_t timeout_ns = uint64_t(timeout_) * 1000 * 1000;
      if (poll_time > timeout_ns) latency += poll_time - timeout_ns;
    }
    // Exact Node26.13 IterationHistogram::CheckCB calculation and HDR owner.
    histogram_->Record(latency == 0 ? 1 : int64_t(latency));
    check_time_ = check_time;
  }
  void TimerFired() {
    if (enabled_ && !closed_ && mode_ == Mode::Interval) histogram_->RecordDelta();
  }
  // A shared message clone owns only statistical material. It has no sampler
  // controls, timer, phase registration or environment lifetime obligation.
  std::shared_ptr<Histogram> ShareMaterialForClone() const { return histogram_; }

 private:
  friend class EventLoopDelayLoop;
  std::shared_ptr<Histogram> histogram_;
  std::weak_ptr<EventLoopDelayLoop> loop_;
  Mode mode_;
  uint64_t resolution_;
  HistogramClock clock_;
  uint64_t due_ = 0;
  uint64_t timer_start_id_ = 0;
  uint64_t check_time_ = 0;
  uint64_t prepare_time_ = 0;
  int timeout_ = 0;
  bool enabled_ = false;
  bool closed_ = false;
};

// One registry per actual native event loop/context, confined to its loop
// thread. Weak registrations never root a JS owner and never keep the loop
// alive. Native context shutdown closes all live controls before roots retire.
class EventLoopDelayLoop final : public std::enable_shared_from_this<EventLoopDelayLoop>,
    public ELDRetained<EventLoopDelayLoop> {
 public:
  explicit EventLoopDelayLoop(uint64_t cached_loop_time_ms,
      HistogramClock clock = HistogramMonotonicNow)
      : time_(cached_loop_time_ms), clock_(clock) {}
  EventLoopDelayLoop(const EventLoopDelayLoop&) = delete;
  EventLoopDelayLoop& operator=(const EventLoopDelayLoop&) = delete;
  ~EventLoopDelayLoop() { Shutdown(); }

  std::shared_ptr<EventLoopDelayProducer> Create(const Histogram::Options& options,
      EventLoopDelayProducer::Mode mode, uint64_t resolution) {
    if (closed_ || resolution == 0) return {};
    auto histogram = Histogram::Create(options, clock_); if (!histogram) return {};
    auto owner = std::make_shared<EventLoopDelayProducer>(histogram, weak_from_this(),
        mode, resolution, clock_);
    samplers_.emplace_back(owner); AccountRegistrations(); return owner;
  }
  // The native loop updates its cached clock at its real timer update point,
  // as uv__update_time does. Start uses that cache, not a new JS/Date reading.
  void UpdateTime(uint64_t cached_loop_time_ms) {
    HistogramInvariant(cached_loop_time_ms >= time_);
    time_ = cached_loop_time_ms;
  }
  uint64_t time() const { return time_; }
  bool HasReferences() const { return false; }
  int NextTimeout(int actual_backend_timeout_ms, bool referenced_loop_alive) {
    HistogramInvariant(actual_backend_timeout_ms >= -1);
    if (closed_ || !referenced_loop_alive) return actual_backend_timeout_ms;
    int timeout = actual_backend_timeout_ms;
    Visit([&](const auto& producer) {
      if (!producer->enabled_ || producer->mode_ != EventLoopDelayProducer::Mode::Interval) return;
      uint64_t delay = producer->due_ > time_ ? producer->due_ - time_ : 0;
      int candidate = delay > INT_MAX ? INT_MAX : int(delay);
      if (timeout < 0 || candidate < timeout) timeout = candidate;
    });
    return timeout;
  }
  void RunTimers() {
    if (closed_) return;
    struct Ready { std::shared_ptr<EventLoopDelayProducer> producer; uint64_t due, id; };
    std::optional<memory::Allocation> readyRetained;
    std::vector<Ready> ready;
    // Like uv__run_timers, first collect the complete due batch, then rearm
    // each repeat before firing once. Never replay missed intervals in a loop.
    Visit([&](const auto& p) {
      if (p->enabled_ && p->mode_ == EventLoopDelayProducer::Mode::Interval && p->due_ <= time_) {
        if (!readyRetained) readyRetained.emplace();
        ready.push_back({p, p->due_, p->timer_start_id_});
        readyRetained->Resize(ready.capacity() * sizeof(Ready));
      }
    });
    std::sort(ready.begin(), ready.end(), [](const Ready& a, const Ready& b) {
      return a.due != b.due ? a.due < b.due : a.id < b.id;
    });
    for (const auto& item : ready) {
      auto& p = item.producer;
      if (!p->enabled_ || p->closed_ || p->timer_start_id_ != item.id) continue;
      Arm(*p); p->TimerFired();
    }
  }
  void Prepare(int actual_backend_timeout_ms) {
    if (!closed_) Visit([&](const auto& p) { p->Prepare(actual_backend_timeout_ms); });
  }
  void Check() { if (!closed_) Visit([&](const auto& p) { p->Check(); }); }
  void Shutdown() {
    if (closed_) return;
    closed_ = true;
    Visit([](const auto& p) { p->Close(); }); samplers_.clear();
  }
  size_t Registrations() { Prune(); return samplers_.size(); }

 private:
  friend class EventLoopDelayProducer;
  void Arm(EventLoopDelayProducer& p) {
    p.due_ = time_ + p.resolution_;
    if (p.due_ < p.resolution_) p.due_ = UINT64_MAX;
    p.timer_start_id_ = timer_counter_++;
  }
  void AccountRegistrations() noexcept {
    ResizeExtra(samplers_.capacity() * sizeof(samplers_[0]));
  }
  void Prune() {
    samplers_.erase(std::remove_if(samplers_.begin(), samplers_.end(),
        [](const auto& weak) { return weak.expired(); }), samplers_.end());
    AccountRegistrations();
  }
  template <class Function> void Visit(Function function) {
    Prune();
    for (const auto& weak : samplers_) if (auto p = weak.lock()) function(p);
  }
  std::vector<std::weak_ptr<EventLoopDelayProducer>> samplers_;
  uint64_t time_;
  HistogramClock clock_;
  uint64_t timer_counter_ = 0;
  bool closed_ = false;
};

inline bool EventLoopDelayProducer::Start(bool reset) {
  auto loop = loop_.lock();
  if (enabled_ || closed_ || !loop || loop->closed_) return false;
  enabled_ = true;
  if (reset) histogram_->Reset();
  if (mode_ == Mode::Interval) loop->Arm(*this);
  else {
    check_time_ = clock_(); prepare_time_ = check_time_; timeout_ = 0;
  }
  return true;
}
}  // namespace kandelo::histogram
#endif
