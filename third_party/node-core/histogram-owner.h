// Generated from the pinned Node.js 26.13.0 histogram owner.
// See histogram-source-identities.json, histogram-owner.md and LICENSE.
// Regenerate with generate-histogram-owner.py; do not edit here.
#ifndef KANDELO_NODE_HISTOGRAM_OWNER_H_
#define KANDELO_NODE_HISTOGRAM_OWNER_H_
#include "histogram-portability.h"
namespace kandelo::histogram {
constexpr int kDefaultHistogramFigures = 3;

class Histogram {
 public:
  struct Options {
    int64_t lowest = 1;
    int64_t highest = std::numeric_limits<int64_t>::max();
    int figures = kDefaultHistogramFigures;
    double half_life = 0;   // EWMA half-life in number of samples (0 = off)
    int64_t threshold = 0;  // SLO threshold (0 = off). When set with
                            // half_life, tracks EWMA error rate for values
                            // exceeding this threshold.
  };

  struct RecordedBucket {
    double value;
    double resolution;
    int64_t count;
    int64_t cumulative_count;
  };

  struct RecordedSnapshot {
    std::vector<RecordedBucket> buckets;
    int64_t total_count = 0;
    memory::Allocation retained{sizeof(RecordedSnapshot)};
  };

  using HistogramPointer = std::unique_ptr<hdr_histogram, HistogramDeleter>;

  struct RecordedSnapshotSource {
    HistogramPointer histogram;
    std::shared_ptr<const RecordedSnapshot> snapshot;
    uint64_t generation = 0;
    bool cache_hit = false;
    memory::Allocation capturedHdrRetained;
  };

  // Factory method that returns nullptr on hdr_init failure.
  static std::shared_ptr<Histogram> Create(const Options& options,
      HistogramClock clock = HistogramMonotonicNow);

  // Returns an independent copy of this histogram's current state, or nullptr
  // if the copy cannot be allocated.
  std::shared_ptr<Histogram> Clone() const;

  enum class DiffError {
    kNone,
    kOutOfMemory,
    // `other` has a different layout.
    kIncompatible,
    // Values were removed from this histogram after `other` was taken.
    kReset,
    // `other` contains values that this histogram does not.
    kNotEarlier,
  };

  // Returns a new histogram containing the values recorded in this histogram
  // after `other`, an earlier copy of it, was taken. Returns nullptr and sets
  // `error` if the difference cannot be computed.
  std::shared_ptr<Histogram> Diff(const Histogram& other,
                                  DiffError* error) const;

  Histogram(HistogramPointer histogram, const Options& options,
            HistogramClock clock = HistogramMonotonicNow);
  virtual ~Histogram() = default;
  const memory::RecordHandle& RetainedAllocation() const { return retained_.Handle(); }

  inline bool Record(int64_t value);
  inline void Reset();
  inline int64_t Min() const;
  inline int64_t Max() const;
  inline double Mean() const;
  inline double Stddev() const;
  inline double EwmaMean() const;
  inline double EwmaStddev() const;
  inline double EwmaErrorRate() const;
  inline int64_t Percentile(double percentile) const;
  inline uint64_t Exceeds() const;
  inline uint64_t Count() const;
  inline uint64_t ResetCount() const;

  inline uint64_t RecordDelta();

  inline double Add(const Histogram& other);

  // Iterator is a function type that takes two doubles as argument, one for
  // percentile and one for the value at that percentile.
  template <typename Iterator>
  inline void Percentiles(Iterator&& fn) const;

  inline size_t GetMemorySize() const;

  // Analysis methods
  inline int64_t CountAt(int64_t value) const;
  double Cdf(int64_t value) const;
  double Skewness() const;
  double Kurtosis() const;
  double KsTest(const Histogram& other) const;
  double Subtract(const Histogram& other);
  void PercentilesAt(const double* percentiles,
                     int64_t* values,
                     size_t length) const;

  // Statistical analysis
  struct MeanCIResult {
    double mean;
    double lower;
    double upper;
  };

  struct WelchTestResult {
    double t_statistic;
    double degrees_of_freedom;
    double p_value;
    double ci_lower;
    double ci_upper;
  };

  struct MannWhitneyResult {
    double u_statistic;
    double z_score;
    double p_value;
  };

  struct PercentileCIResult {
    int64_t value;
    int64_t lower;
    int64_t upper;
  };

  MeanCIResult MeanCI(double confidence = 0.95) const;
  WelchTestResult WelchTest(const Histogram& other,
                            double confidence = 0.95) const;
  MannWhitneyResult MannWhitneyTest(const Histogram& other) const;
  double CohensD(const Histogram& other) const;
  double CliffsD(const Histogram& other) const;
  PercentileCIResult PercentileCI(double percentile,
                                  double confidence = 0.95) const;

  // CBOR-encoded export/import for histogram exchange.
  std::vector<uint8_t> Export() const;
  static std::shared_ptr<Histogram> Import(const uint8_t* data, size_t len);

  inline bool RecordCorrected(int64_t value, int64_t expected_interval);

  template <typename Iterator>
  void LinearBuckets(int64_t step_size, Iterator&& fn) const;

  template <typename Iterator>
  void LogBuckets(int64_t first_bucket, double log_base, Iterator&& fn) const;

  bool IsCompatible(const Histogram& other) const;
  RecordedSnapshotSource GetRecordedSnapshotSource(bool use_cache) const;
  static RecordedSnapshot BuildRecordedSnapshot(const hdr_histogram* histogram);
  void CacheRecordedSnapshot(uint64_t generation,
                             std::shared_ptr<const RecordedSnapshot> snapshot);


 private:
  inline void UpdateEwma(double value);
  inline void InvalidateRecordedSnapshot();
  size_t GetCachedRecordedSnapshotMemorySize() const;
  std::shared_ptr<Histogram> CreateWithSameLayout() const;

  HistogramPointer histogram_;
  uint64_t prev_ = 0;
  uint64_t exceeds_ = 0;
  // Incremented whenever recorded values are removed by Reset() or Subtract().
  uint64_t reset_count_ = 0;

  // EWMA state (active when ewma_alpha_ > 0)
  double ewma_alpha_ = 0;
  double ewma_mean_ = 0;
  double ewma_variance_ = 0;
  bool ewma_initialized_ = false;

  // SLO error rate EWMA (active when threshold_ > 0 and ewma_alpha_ > 0)
  int64_t threshold_ = 0;
  double ewma_error_rate_ = 0;

  uint64_t mutation_generation_ = 0;
  std::shared_ptr<const RecordedSnapshot> recorded_snapshot_cache_;

  memory::Allocation retained_;
  HistogramClock clock_ = HistogramMonotonicNow;
  RwLock mutex_;
};
}  // namespace kandelo::histogram
#endif
