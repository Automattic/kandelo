#ifndef KANDELO_NODE_HISTOGRAM_WINDOW_H_
#define KANDELO_NODE_HISTOGRAM_WINDOW_H_
#include "histogram-owner.h"
namespace kandelo::histogram {

// Ring state is confined to its owning environment thread, as in Node. Window
// owners are neither copied nor shared by structured clone. Returned snapshots
// own independent, lock-protected histograms.
class SlidingWindowHistogram final {
 public:
  static std::unique_ptr<SlidingWindowHistogram> Create(
      const Histogram::Options& options, size_t chunk_count, bool time_based,
      uint64_t rotate_at, HistogramClock clock = HistogramMonotonicNow) {
    if (chunk_count < 1 || chunk_count > 1024 || rotate_at == 0) return {};
    // The upstream sliding constructor accepts layout fields only; EWMA/SLO
    // options belong to standalone recordable histograms.
    Histogram::Options layout{options.lowest, options.highest, options.figures};
    auto spare = Histogram::Create(layout, clock);
    if (!spare) return {};
    return std::unique_ptr<SlidingWindowHistogram>(new SlidingWindowHistogram(
        layout, chunk_count, time_based, rotate_at, std::move(spare), clock));
  }
  SlidingWindowHistogram(const SlidingWindowHistogram&) = delete;
  SlidingWindowHistogram& operator=(const SlidingWindowHistogram&) = delete;

  // False denotes chunk-allocation failure. Over-high samples still consume
  // an attempt and return true, while their chunk's exceeds count increases.
  bool RecordValue(int64_t value);
  std::shared_ptr<Histogram> CreateSnapshot() const;
  void ResetWindow();
  size_t GetMemorySize() const { return external_memory_; }
  const memory::RecordHandle& RetainedAllocation() const { return retained_.Handle(); }

 private:
  SlidingWindowHistogram(const Histogram::Options& options, size_t chunk_count,
      bool time_based, uint64_t rotate_at, std::shared_ptr<Histogram> spare,
      HistogramClock clock)
      : options_(options), chunks_(chunk_count),
        generations_(chunk_count, kNoGeneration), spare_(std::move(spare)),
        time_based_(time_based), rotate_at_(rotate_at), origin_(clock()),
        external_memory_(spare_->GetMemorySize()), clock_(clock) {
    retained_.Resize(sizeof(*this) + chunks_.capacity() * sizeof(chunks_[0]) +
        generations_.capacity() * sizeof(generations_[0]));
  }
  static constexpr uint64_t kNoGeneration = std::numeric_limits<uint64_t>::max();
  Histogram* GetChunk(uint64_t generation);
  uint64_t CurrentTimeGeneration() const;
  memory::Allocation retained_;
  Histogram::Options options_;
  std::vector<std::shared_ptr<Histogram>> chunks_;
  std::vector<uint64_t> generations_;
  std::shared_ptr<Histogram> spare_;
  bool time_based_;
  uint64_t rotate_at_;
  uint64_t origin_;
  uint64_t current_generation_ = 0;
  uint64_t records_in_current_chunk_ = 0;
  size_t external_memory_ = 0;
  bool has_count_records_ = false;
  HistogramClock clock_;
};
}  // namespace kandelo::histogram
#endif
