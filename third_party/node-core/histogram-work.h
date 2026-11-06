#ifndef KANDELO_NODE_HISTOGRAM_WORK_H_
#define KANDELO_NODE_HISTOGRAM_WORK_H_

#include "histogram-owner.h"
#include <stdexcept>

namespace kandelo::histogram {
struct QrdeResult {
  std::vector<double> quantiles;
  std::vector<double> densities;
  size_t corrections = 0;
};
enum class QrdeDequantization : uint32_t { kNone, kHdr, kAll };

// These are native numerical capabilities, not a JS Promise or an async
// scheduler. A binding must validate options and schedule/deliver/cancel work.
// The low-level calculation requires a valid recorded snapshot and strictly
// increasing, finite probabilities with 2..1001 boundaries from 0 through 1;
// HistogramQrdeWork checks these native preconditions before dispatch.
QrdeResult CalculateHistogramQrde(const Histogram::RecordedSnapshot& snapshot,
    const std::vector<double>& probabilities, QrdeDequantization mode);

class HistogramQrdeWork {
 public:
  HistogramQrdeWork(std::shared_ptr<Histogram> histogram,
                    std::vector<double> probabilities,
                    QrdeDequantization mode,
                    bool use_cache)
      : source_(histogram->GetRecordedSnapshotSource(use_cache)),
        probabilities_(std::move(probabilities)), mode_(mode) {
    // Public JS validation also owns the exact Node error classes/messages.
    if (probabilities_.size() < 2 || probabilities_.size() > 1001 ||
        probabilities_.front() != 0 || probabilities_.back() != 1 ||
        static_cast<uint32_t>(mode_) > 2) {
      throw std::invalid_argument("Invalid QRDE options");
    }
    for (size_t i = 1; i < probabilities_.size(); ++i) {
      if (!std::isfinite(probabilities_[i]) ||
          probabilities_[i] <= probabilities_[i - 1]) {
        throw std::invalid_argument("Invalid QRDE probabilities");
      }
    }
    if (!source_.snapshot && !source_.histogram) throw std::bad_alloc();
    if (use_cache && !source_.cache_hit) histogram_ = std::move(histogram);
    AccountMemory();
  }
  HistogramQrdeWork(const HistogramQrdeWork&) = delete;
  HistogramQrdeWork& operator=(const HistogramQrdeWork&) = delete;

  void Run() {
    try {
    HistogramInvariant(state_ == State::kPrepared);
    state_ = State::kRunning;
    if (source_.snapshot) {
      snapshot_ = std::move(source_.snapshot);
    } else {
      snapshot_ = std::make_shared<const Histogram::RecordedSnapshot>(
          Histogram::BuildRecordedSnapshot(source_.histogram.get()));
      source_.histogram.reset(); source_.capturedHdrRetained.Resize(0);
    }
    if (histogram_) {
      histogram_->CacheRecordedSnapshot(source_.generation, snapshot_);
      histogram_.reset();
    }
    result_ = CalculateHistogramQrde(*snapshot_, probabilities_, mode_);
    state_ = State::kComplete;
    } catch (...) { AccountMemory(); throw; }
    AccountMemory();
  }
  const memory::RecordHandle& RetainedAllocation() const { return retained_.Handle(); }
  const QrdeResult& result() const {
    HistogramInvariant(state_ == State::kComplete); return result_;
  }
  const Histogram::RecordedSnapshot& snapshot() const {
    HistogramInvariant(state_ == State::kComplete); return *snapshot_;
  }
  bool cache_hit() const { return source_.cache_hit; }

 private:
  void AccountMemory() noexcept {
    retained_.Resize(sizeof(*this) + probabilities_.capacity() * sizeof(double) +
        result_.quantiles.capacity() * sizeof(double) + result_.densities.capacity() * sizeof(double));
  }
  memory::Allocation retained_;
  std::shared_ptr<Histogram> histogram_;
  Histogram::RecordedSnapshotSource source_;
  std::shared_ptr<const Histogram::RecordedSnapshot> snapshot_;
  const std::vector<double> probabilities_;
  const QrdeDequantization mode_;
  QrdeResult result_;
  enum class State { kPrepared, kRunning, kComplete };
  State state_ = State::kPrepared;
};
}  // namespace kandelo::histogram
#endif
