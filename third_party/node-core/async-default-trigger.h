#ifndef KANDELO_ASYNC_DEFAULT_TRIGGER_H
#define KANDELO_ASYNC_DEFAULT_TRIGGER_H
#include <cmath>
#include <cassert>
namespace kandelo::async {
// One owning environment/context holds this value. Execution-ID push/pop,
// continuation frames and queued jobs must neither copy nor restore it.
class DefaultTrigger {
  double value_ = -1;
 public:
  static bool Valid(double value) {
    return std::isfinite(value) && value >= -1 && value <= 9007199254740991.0 &&
        std::floor(value) == value;
  }
  double Raw() const { return value_; }
  double Resolve(double execution) const { return value_ < 0 ? execution : value_; }
  bool Swap(double value, double* previous) {
    if (!Valid(value)) return false;
    *previous = value_; value_ = value; return true;
  }
};
class DefaultTriggerScope {
  DefaultTrigger& state_;
  double previous_ = -1;
  bool ready_;
 public:
  DefaultTriggerScope(DefaultTrigger& state, double value)
      : state_(state), ready_(state_.Swap(value, &previous_)) {}
  DefaultTriggerScope(const DefaultTriggerScope&) = delete;
  DefaultTriggerScope& operator=(const DefaultTriggerScope&) = delete;
  bool Ready() const { return ready_; }
  ~DefaultTriggerScope() {
    if (ready_) { double ignored; const bool ok = state_.Swap(previous_, &ignored); assert(ok); (void)ok; }
  }
};
}  // namespace kandelo::async
#endif
