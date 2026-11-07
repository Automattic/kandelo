// Generated from the pinned Node.js 26.13.0 histogram owner.
// See histogram-source-identities.json, histogram-owner.md and LICENSE.
// Regenerate with generate-histogram-owner.py; do not edit here.
#include "histogram-owner.h"
#include "histogram-work.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <numbers>
#include <vector>
#include "histogram-owner-inl.h"
namespace kandelo::histogram {
Histogram::Histogram(HistogramPointer histogram, const Options& options,
                     HistogramClock clock)
    : histogram_(std::move(histogram)), clock_(clock) {
  retained_.Resize(sizeof(*this) + hdr_get_memory_size(histogram_.get()));
  // alpha = 1 - 2^(-1/halfLife). With halfLife <= 0, EWMA is disabled.
  if (options.half_life > 0) {
    ewma_alpha_ = 1.0 - std::exp(-std::log(2.0) / options.half_life);
  }
  threshold_ = options.threshold;
}

std::shared_ptr<Histogram> Histogram::Create(const Options& options, HistogramClock clock) {
  hdr_histogram* histogram;
  if (hdr_init(options.lowest, options.highest, options.figures, &histogram) !=
      0) {
    return {};
  }
  return std::make_shared<Histogram>(HistogramPointer(histogram), options, clock);
}

namespace {
// Copies the recorded data of `source` into `target`, which must have been
// initialized with the same layout. The caller must hold a lock that prevents
// `source` from being modified during the copy.
void CopyRecordedData(hdr_histogram* target, const hdr_histogram* source) {
  HistogramInvariant((target->counts_len) == (source->counts_len));
  target->min_value = source->min_value;
  target->max_value = source->max_value;
  target->normalizing_index_offset = source->normalizing_index_offset;
  target->conversion_ratio = source->conversion_ratio;
  target->total_count = source->total_count;
  std::memcpy(target->counts,
              source->counts,
              source->counts_len * sizeof(*source->counts));
}
}  // namespace

std::shared_ptr<Histogram> Histogram::CreateWithSameLayout() const {
  // The layout is fixed when the histogram is created, so it can be read
  // without holding the lock.
  hdr_histogram* histogram;
  if (hdr_init(histogram_->lowest_discernible_value,
               histogram_->highest_trackable_value,
               histogram_->significant_figures,
               &histogram) != 0) {
    return {};
  }
  return std::make_shared<Histogram>(HistogramPointer(histogram), Options{}, clock_);
}

std::shared_ptr<Histogram> Histogram::Clone() const {
  std::shared_ptr<Histogram> clone = CreateWithSameLayout();
  if (!clone) return {};

  // Every member that holds recorded or statistical state must be copied
  // here. The recorded snapshot cache is not copied; the clone builds its own
  // on demand.
  RwLock::ScopedReadLock lock(mutex_);
  CopyRecordedData(clone->histogram_.get(), histogram_.get());
  clone->prev_ = prev_;
  clone->exceeds_ = exceeds_;
  clone->reset_count_ = reset_count_;
  clone->ewma_alpha_ = ewma_alpha_;
  clone->ewma_mean_ = ewma_mean_;
  clone->ewma_variance_ = ewma_variance_;
  clone->ewma_initialized_ = ewma_initialized_;
  clone->threshold_ = threshold_;
  clone->ewma_error_rate_ = ewma_error_rate_;
  return clone;
}

std::shared_ptr<Histogram> Histogram::Diff(const Histogram& other,
                                           DiffError* error) const {
  // Counts are subtracted index by index, so both histograms must map values
  // to the same indexes. None of these fields change after creation.
  if (!IsCompatible(other) || histogram_->normalizing_index_offset !=
                                  other.histogram_->normalizing_index_offset) {
    *error = DiffError::kIncompatible;
    return {};
  }

  std::shared_ptr<Histogram> diff = CreateWithSameLayout();
  if (!diff) {
    *error = DiffError::kOutOfMemory;
    return {};
  }

  // Only the recorded values and the exceeds count carry over. EWMA and timing
  // state cannot be subtracted.
  uint64_t reset_count;
  {
    RwLock::ScopedReadLock lock(mutex_);
    CopyRecordedData(diff->histogram_.get(), histogram_.get());
    diff->exceeds_ = exceeds_;
    reset_count = reset_count_;
  }

  // `diff` is not shared yet, so only the lock of `other` is needed from here
  // on. Never holding both locks at once avoids lock ordering issues.
  RwLock::ScopedReadLock lock(other.mutex_);
  if (reset_count != other.reset_count_) {
    *error = DiffError::kReset;
    return {};
  }
  if (diff->exceeds_ < other.exceeds_) {
    *error = DiffError::kNotEarlier;
    return {};
  }

  hdr_histogram* target = diff->histogram_.get();
  const hdr_histogram* source = other.histogram_.get();
  for (int32_t i = 0; i < target->counts_len; i++) {
    if (target->counts[i] < source->counts[i]) {
      *error = DiffError::kNotEarlier;
      return {};
    }
    target->counts[i] -= source->counts[i];
  }
  diff->exceeds_ -= other.exceeds_;
  hdr_reset_internal_counters(target);
  *error = DiffError::kNone;
  return diff;
}

bool Histogram::IsCompatible(const Histogram& other) const {
  return histogram_->counts_len == other.histogram_->counts_len &&
         histogram_->lowest_discernible_value ==
             other.histogram_->lowest_discernible_value &&
         histogram_->highest_trackable_value ==
             other.histogram_->highest_trackable_value &&
         histogram_->significant_figures ==
             other.histogram_->significant_figures;
}

Histogram::RecordedSnapshot Histogram::BuildRecordedSnapshot(
    const hdr_histogram* histogram) {
  RecordedSnapshot snapshot;
  snapshot.total_count = histogram->total_count;
  if (snapshot.total_count == 0) return snapshot;

  const size_t occupied =
      std::count_if(histogram->counts,
                    histogram->counts + histogram->counts_len,
                    [](int64_t count) { return count != 0; });
  snapshot.buckets.reserve(occupied);
  snapshot.retained.Resize(sizeof(RecordedSnapshot) + snapshot.buckets.capacity() * sizeof(RecordedBucket));
  hdr_iter iter;
  hdr_iter_recorded_init(&iter, histogram);
  while (hdr_iter_next(&iter)) {
    snapshot.buckets.push_back({
        static_cast<double>(iter.median_equivalent_value),
        static_cast<double>(
            hdr_size_of_equivalent_value_range(histogram, iter.value)),
        iter.count,
        iter.cumulative_count,
    });
  }
  snapshot.retained.Resize(sizeof(RecordedSnapshot) + snapshot.buckets.capacity() * sizeof(RecordedBucket)); return snapshot;
}

Histogram::RecordedSnapshotSource Histogram::GetRecordedSnapshotSource(
    bool use_cache) const {
  RecordedSnapshotSource source;
  int64_t lowest;
  int64_t highest;
  int figures;
  {
    RwLock::ScopedReadLock lock(mutex_);
    source.generation = mutation_generation_;
    if (use_cache && recorded_snapshot_cache_) {
      source.snapshot = recorded_snapshot_cache_;
      source.cache_hit = true;
      return source;
    }
    if (histogram_->total_count == 0) {
      source.snapshot = std::make_shared<const RecordedSnapshot>();
      return source;
    }
    lowest = histogram_->lowest_discernible_value;
    highest = histogram_->highest_trackable_value;
    figures = histogram_->significant_figures;
  }

  hdr_histogram* copy;
  if (hdr_init(lowest, highest, figures, &copy) != 0) return source;
  source.histogram.reset(copy);
  source.capturedHdrRetained.Resize(hdr_get_memory_size(copy));

  RwLock::ScopedReadLock lock(mutex_);
  source.generation = mutation_generation_;
  if (use_cache && recorded_snapshot_cache_) {
    source.histogram.reset();
    source.capturedHdrRetained.Resize(0);
    source.snapshot = recorded_snapshot_cache_;
    source.cache_hit = true;
    return source;
  }
  if (histogram_->total_count == 0) {
    source.histogram.reset();
    source.capturedHdrRetained.Resize(0);
    source.snapshot = std::make_shared<const RecordedSnapshot>();
    return source;
  }

  CopyRecordedData(source.histogram.get(), histogram_.get());
  return source;
}

void Histogram::CacheRecordedSnapshot(
    uint64_t generation, std::shared_ptr<const RecordedSnapshot> snapshot) {
  RwLock::ScopedWriteLock lock(mutex_);
  if (generation == mutation_generation_) {
    recorded_snapshot_cache_ = std::move(snapshot);
  }
}

size_t Histogram::GetCachedRecordedSnapshotMemorySize() const {
  RwLock::ScopedReadLock lock(mutex_);
  if (!recorded_snapshot_cache_) return 0;
  return recorded_snapshot_cache_->buckets.capacity() * sizeof(RecordedBucket);
}

double Histogram::Cdf(int64_t value) const {
  RwLock::ScopedReadLock lock(mutex_);
  int64_t total = histogram_->total_count;
  if (total == 0) return 0.0;

  hdr_iter iter;
  hdr_iter_init(&iter, histogram_.get());
  while (hdr_iter_next(&iter)) {
    if (iter.highest_equivalent_value >= value) {
      return static_cast<double>(iter.cumulative_count) /
             static_cast<double>(total);
    }
    // All recorded data accounted for; remaining buckets are empty.
    if (iter.cumulative_count >= total) break;
  }
  return 1.0;
}

double Histogram::Skewness() const {
  RwLock::ScopedReadLock lock(mutex_);
  int64_t total = histogram_->total_count;
  if (total < 3) return 0.0;

  // Compute mean in one pass, then variance and skewness in a second
  // pass.  This avoids calling hdr_stddev (which internally recomputes
  // hdr_mean), reducing the total from 4 iterations to 2.
  double mean = hdr_mean(histogram_.get());

  double m2 = 0.0;
  double m3 = 0.0;
  hdr_iter iter;
  hdr_iter_recorded_init(&iter, histogram_.get());
  while (hdr_iter_next(&iter)) {
    double dev = static_cast<double>(hdr_median_equivalent_value(
                     histogram_.get(), iter.value)) -
                 mean;
    double d2 = dev * dev;
    m2 += static_cast<double>(iter.count) * d2;
    m3 += static_cast<double>(iter.count) * d2 * dev;
  }

  double n = static_cast<double>(total);
  double variance = m2 / n;
  if (variance == 0.0) return 0.0;
  double s3 = variance * std::sqrt(variance);  // stddev^3
  return (m3 / n) / s3;
}

double Histogram::Kurtosis() const {
  RwLock::ScopedReadLock lock(mutex_);
  int64_t total = histogram_->total_count;
  if (total < 4) return 0.0;

  // Same single-pass approach as Skewness: compute mean first, then
  // variance and excess kurtosis together in one iteration.
  double mean = hdr_mean(histogram_.get());

  double m2 = 0.0;
  double m4 = 0.0;
  hdr_iter iter;
  hdr_iter_recorded_init(&iter, histogram_.get());
  while (hdr_iter_next(&iter)) {
    double dev = static_cast<double>(hdr_median_equivalent_value(
                     histogram_.get(), iter.value)) -
                 mean;
    double d2 = dev * dev;
    m2 += static_cast<double>(iter.count) * d2;
    m4 += static_cast<double>(iter.count) * d2 * d2;
  }

  double n = static_cast<double>(total);
  double variance = m2 / n;
  if (variance == 0.0) return 0.0;
  double s4 = variance * variance;  // stddev^4
  return (m4 / n) / s4 - 3.0;
}

double Histogram::Subtract(const Histogram& other) {
  auto do_subtract = [&]() -> double {
    int64_t dropped = 0;
    int32_t len =
        std::min(histogram_->counts_len, other.histogram_->counts_len);
    for (int32_t i = 0; i < len; i++) {
      int64_t count = histogram_->counts[i] - other.histogram_->counts[i];
      if (count < 0) {
        dropped += -count;
        count = 0;
      }
      histogram_->counts[i] = count;
    }
    hdr_reset_internal_counters(histogram_.get());
    InvalidateRecordedSnapshot();
    reset_count_++;
    exceeds_ = (exceeds_ > other.exceeds_) ? exceeds_ - other.exceeds_ : 0;
    return static_cast<double>(dropped);
  };

  if (this == &other) {
    RwLock::ScopedWriteLock lock(mutex_);
    return do_subtract();
  }

  if (std::less<const Histogram*>{}(this, &other)) {
    RwLock::ScopedWriteLock lock1(mutex_);
    RwLock::ScopedReadLock lock2(other.mutex_);
    return do_subtract();
  }

  RwLock::ScopedReadLock lock1(other.mutex_);
  RwLock::ScopedWriteLock lock2(mutex_);
  return do_subtract();
}

double Histogram::KsTest(const Histogram& other) const {
  auto do_ks = [&]() -> double {
    int64_t n1 = histogram_->total_count;
    int64_t n2 = other.histogram_->total_count;
    if (n1 == 0 || n2 == 0) return 0.0;

    double max_d = 0.0;
    int64_t cum1 = 0, cum2 = 0;
    int32_t len =
        std::max(histogram_->counts_len, other.histogram_->counts_len);

    for (int32_t i = 0; i < len; i++) {
      if (i < histogram_->counts_len) cum1 += histogram_->counts[i];
      if (i < other.histogram_->counts_len) cum2 += other.histogram_->counts[i];
      double cdf1 = static_cast<double>(cum1) / static_cast<double>(n1);
      double cdf2 = static_cast<double>(cum2) / static_cast<double>(n2);
      double d = cdf1 > cdf2 ? cdf1 - cdf2 : cdf2 - cdf1;
      if (d > max_d) max_d = d;
    }
    return max_d;
  };

  if (this == &other) return 0.0;

  if (std::less<const Histogram*>{}(this, &other)) {
    RwLock::ScopedReadLock lock1(mutex_);
    RwLock::ScopedReadLock lock2(other.mutex_);
    return do_ks();
  }

  RwLock::ScopedReadLock lock1(other.mutex_);
  RwLock::ScopedReadLock lock2(mutex_);
  return do_ks();
}

void Histogram::PercentilesAt(const double* percentiles,
                              int64_t* values,
                              size_t length) const {
  RwLock::ScopedReadLock lock(mutex_);
  hdr_value_at_percentiles(histogram_.get(), percentiles, values, length);
}

namespace {
// Continued fraction evaluation for the regularized incomplete beta
// function using Lentz's modified method. Reference: Numerical Recipes
// in C, 2nd edition, section 6.4.
static double BetaContinuedFraction(double a, double b, double x) {
  constexpr double FPMIN = 1e-30;
  constexpr int MAXIT = 200;
  constexpr double EPS = 3e-12;

  double qab = a + b;
  double qap = a + 1.0;
  double qam = a - 1.0;
  double c = 1.0;
  double d = 1.0 - qab * x / qap;
  if (std::fabs(d) < FPMIN) d = FPMIN;
  d = 1.0 / d;
  double h = d;

  for (int m = 1; m <= MAXIT; m++) {
    int m2 = 2 * m;
    // Even step.
    double aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1.0 + aa * d;
    if (std::fabs(d) < FPMIN) d = FPMIN;
    c = 1.0 + aa / c;
    if (std::fabs(c) < FPMIN) c = FPMIN;
    d = 1.0 / d;
    h *= d * c;
    // Odd step.
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1.0 + aa * d;
    if (std::fabs(d) < FPMIN) d = FPMIN;
    c = 1.0 + aa / c;
    if (std::fabs(c) < FPMIN) c = FPMIN;
    d = 1.0 / d;
    double del = d * c;
    h *= del;
    if (std::fabs(del - 1.0) <= EPS) break;
  }
  return h;
}

struct BetaParameters {
  double a;
  double b;
  double log_normalization;
  double mean;
  double standard_deviation;
  double skewness;
  double excess_kurtosis;
  double log_scale;
  double symmetry_point;
  bool use_asymptotic_front;
  bool use_asymptotic_cdf;
};

static double StirlingCorrection(double x) {
  const double inverse = 1.0 / x;
  const double inverse_squared = inverse * inverse;
  return inverse * (1.0 / 12.0 +
                    inverse_squared *
                        (-1.0 / 360.0 +
                         inverse_squared *
                             (1.0 / 1260.0 +
                              inverse_squared *
                                  (-1.0 / 1680.0 + inverse_squared / 1188.0))));
}

static BetaParameters MakeBetaParameters(double a,
                                         double b,
                                         bool approximate_large_shapes) {
  const double sum = a + b;
  const double mean = a / sum;
  const bool use_asymptotic_front =
      approximate_large_shapes && a >= 8.0 && b >= 8.0;
  // The continued fraction needs progressively more iterations as both
  // beta shapes grow. At this concentration the Edgeworth error is smaller
  // than the continued-fraction truncation error.
  const bool use_asymptotic_cdf =
      approximate_large_shapes && a * b / sum >= 25'000.0;
  const double variance = mean * (1.0 - mean) / (sum + 1.0);
  const double skewness =
      2.0 * (b - a) * std::sqrt(sum + 1.0) / ((sum + 2.0) * std::sqrt(a * b));
  const double excess_kurtosis =
      6.0 * ((a - b) * (a - b) * (sum + 1.0) - a * b * (sum + 2.0)) /
      (a * b * (sum + 2.0) * (sum + 3.0));
  return {
      a,
      b,
      use_asymptotic_front ? 0.0
                           : std::lgamma(sum) - std::lgamma(a) - std::lgamma(b),
      mean,
      std::sqrt(variance),
      skewness,
      excess_kurtosis,
      use_asymptotic_front ? 0.5 * std::log(sum * mean * (1.0 - mean) /
                                            (2.0 * std::numbers::pi)) +
                                 StirlingCorrection(sum) -
                                 StirlingCorrection(a) - StirlingCorrection(b)
                           : 0.0,
      (a + 1.0) / (sum + 2.0),
      use_asymptotic_front,
      use_asymptotic_cdf,
  };
}

static BetaParameters ReflectBetaParameters(const BetaParameters& params) {
  return {
      params.b,
      params.a,
      params.log_normalization,
      1.0 - params.mean,
      params.standard_deviation,
      -params.skewness,
      params.excess_kurtosis,
      params.log_scale,
      1.0 - params.symmetry_point,
      params.use_asymptotic_front,
      params.use_asymptotic_cdf,
  };
}

static double BetaFront(const BetaParameters& params, double x) {
  if (x <= 0.0 || x >= 1.0) return 0.0;
  double log_front;
  if (params.use_asymptotic_front) {
    log_front = params.a * std::log1p((x - params.mean) / params.mean) +
                params.b * std::log1p((params.mean - x) / (1.0 - params.mean)) +
                params.log_scale;
  } else {
    log_front = params.log_normalization + params.a * std::log(x) +
                params.b * std::log(1.0 - x);
  }
  return std::exp(log_front);
}

static double AsymptoticBetaCdf(const BetaParameters& params,
                                double x,
                                double* front_out) {
  const double z = (x - params.mean) / params.standard_deviation;
  const double normal_cdf = 0.5 * std::erfc(-z / std::numbers::sqrt2);
  if (std::fabs(z) >= 8.0) {
    if (front_out != nullptr) *front_out = 0.0;
    return normal_cdf;
  }

  const double z2 = z * z;
  const double z3 = z2 * z;
  const double normal_pdf =
      std::exp(-0.5 * z2) / std::sqrt(2.0 * std::numbers::pi);
  if (front_out != nullptr) {
    const double z4 = z2 * z2;
    const double z6 = z3 * z3;
    const double density_correction =
        1.0 + params.skewness / 6.0 * (z3 - 3.0 * z) +
        params.excess_kurtosis / 24.0 * (z4 - 6.0 * z2 + 3.0) +
        params.skewness * params.skewness / 72.0 *
            (z6 - 15.0 * z4 + 45.0 * z2 - 15.0);
    *front_out = x * (1.0 - x) * normal_pdf / params.standard_deviation *
                 std::max(0.0, density_correction);
  }
  const double correction = params.skewness / 6.0 * (1.0 - z2) -
                            params.excess_kurtosis / 24.0 * (z3 - 3.0 * z) -
                            params.skewness * params.skewness / 72.0 *
                                (z3 * z2 - 10.0 * z3 + 15.0 * z);
  return std::clamp(normal_cdf + normal_pdf * correction, 0.0, 1.0);
}

// Regularized incomplete beta function I_x(a, b).
// Returns the probability that a Beta(a,b) random variable is <= x.
static double RegularizedIncompleteBeta(const BetaParameters& params,
                                        double x,
                                        double* front_out = nullptr) {
  if (front_out != nullptr) *front_out = 0.0;
  if (x <= 0.0) return 0.0;
  if (x >= 1.0) return 1.0;
  if (params.use_asymptotic_cdf) {
    return AsymptoticBetaCdf(params, x, front_out);
  }
  const double front = BetaFront(params, x);
  if (front_out != nullptr) *front_out = front;

  // Use the symmetry relation to ensure the continued fraction
  // converges in the region where it is most accurate.
  if (x < params.symmetry_point) {
    return front * BetaContinuedFraction(params.a, params.b, x) / params.a;
  }
  return 1.0 -
         front * BetaContinuedFraction(params.b, params.a, 1.0 - x) / params.b;
}

static double RegularizedIncompleteBeta(double a, double b, double x) {
  return RegularizedIncompleteBeta(MakeBetaParameters(a, b, false), x);
}

// Standard normal CDF: Phi(x) = P(Z <= x).
static double NormalCdf(double x) {
  return 0.5 * std::erfc(-x * std::numbers::sqrt2 / 2.0);
}

// Student's t-distribution CDF: P(T <= t) for df degrees of freedom.
static double StudentTCdf(double t, double df) {
  double squared = t * t;
  double denominator = df + squared;
  if (squared < df) {
    double x = squared / denominator;
    double ibeta = RegularizedIncompleteBeta(0.5, df / 2.0, x);
    return t >= 0.0 ? 0.5 + 0.5 * ibeta : 0.5 - 0.5 * ibeta;
  }

  double x = df / denominator;
  double ibeta = RegularizedIncompleteBeta(df / 2.0, 0.5, x);
  return t >= 0.0 ? 1.0 - 0.5 * ibeta : 0.5 * ibeta;
}

// Positive Student's t-distribution quantile for an upper-tail probability.
// Using the lower tail avoids loss of precision for probabilities near 1.
static double StudentTUpperQuantile(double p, double df) {
  double lo = 0.0;
  double hi = 1.0;
  while (StudentTCdf(-hi, df) > p) hi *= 2.0;

  for (int i = 0; i < 100; i++) {
    double mid = (lo + hi) / 2.0;
    if (StudentTCdf(-mid, df) > p) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2.0;
}

// Binomial CDF: P(X <= k) for X ~ Binomial(n, p).
// Uses the identity P(X <= k) = I_{1-p}(n-k, k+1).
static double BinomialCdf(int64_t k, int64_t n, double p) {
  if (k < 0) return 0.0;
  if (k >= n) return 1.0;
  return RegularizedIncompleteBeta(
      static_cast<double>(n - k), static_cast<double>(k + 1), 1.0 - p);
}

static bool QrdeShouldDequantize(const Histogram::RecordedBucket& bucket,
                                 QrdeDequantization dequantization) {
  return bucket.count > 1 && (dequantization == QrdeDequantization::kAll ||
                              (dequantization == QrdeDequantization::kHdr &&
                               bucket.resolution > 1.0));
}

static std::pair<double, double> QrdeBucketRange(
    const Histogram::RecordedSnapshot& snapshot,
    size_t index,
    QrdeDequantization dequantization) {
  const auto& bucket = snapshot.buckets[index];
  if (!QrdeShouldDequantize(bucket, dequantization)) {
    return {bucket.value, bucket.value};
  }

  const double half_resolution = bucket.resolution / 2.0;
  if (snapshot.buckets.size() == 1) {
    return {bucket.value - half_resolution, bucket.value + half_resolution};
  }
  if (index == 0) {
    return {bucket.value, bucket.value + half_resolution};
  }
  if (index + 1 == snapshot.buckets.size()) {
    return {bucket.value - half_resolution, bucket.value};
  }
  return {bucket.value - half_resolution, bucket.value + half_resolution};
}

static bool QrdeExactSupport(const Histogram::RecordedSnapshot& snapshot,
                             const BetaParameters& params,
                             const BetaParameters& reflected,
                             double count,
                             size_t* begin_index,
                             size_t* end_index) {
  // Collapsing both tails changes a quantile by at most 2^-79 times the
  // histogram range, which is less than 2^-16 over the int64 value domain.
  constexpr double tail_mass = 0x1p-80;
  size_t lo = 0;
  size_t hi = snapshot.buckets.size();
  while (lo < hi) {
    const size_t mid = lo + (hi - lo) / 2;
    const double rank =
        static_cast<double>(snapshot.buckets[mid].cumulative_count) / count;
    const double cdf = RegularizedIncompleteBeta(params, rank);
    if (!std::isfinite(cdf)) return false;
    if (cdf < tail_mass) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo == snapshot.buckets.size()) return false;
  const size_t first = lo;

  lo = first;
  hi = snapshot.buckets.size();
  while (lo < hi) {
    const size_t mid = lo + (hi - lo) / 2;
    const double remaining_rank =
        static_cast<double>(snapshot.total_count -
                            snapshot.buckets[mid].cumulative_count) /
        count;
    const double survival =
        RegularizedIncompleteBeta(reflected, remaining_rank);
    if (!std::isfinite(survival)) return false;
    if (survival > tail_mass) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  if (lo == snapshot.buckets.size() || lo < first) return false;
  *begin_index = first;
  *end_index = lo + 1;
  return true;
}

static double QrdeQuantile(const Histogram::RecordedSnapshot& snapshot,
                           double p,
                           QrdeDequantization dequantization) {
  const double count = static_cast<double>(snapshot.total_count);
  const double a = (count + 1.0) * p;
  const double b = (count + 1.0) * (1.0 - p);
  const BetaParameters mass_params = MakeBetaParameters(a, b, true);
  const BetaParameters reflected_params = ReflectBetaParameters(mass_params);

  size_t begin_index = 0;
  size_t end_index = snapshot.buckets.size();
  if (mass_params.use_asymptotic_cdf) {
    // Outside this interval the normal-tail mass is below 2e-33.
    constexpr double support_deviations = 12.0;
    const double lower_rank = std::max(
        0.0,
        mass_params.mean - support_deviations * mass_params.standard_deviation);
    const double upper_rank = std::min(
        1.0,
        mass_params.mean + support_deviations * mass_params.standard_deviation);
    const auto first = std::lower_bound(
        snapshot.buckets.begin(),
        snapshot.buckets.end(),
        lower_rank * count,
        [](const Histogram::RecordedBucket& bucket, double cumulative) {
          return static_cast<double>(bucket.cumulative_count) < cumulative;
        });
    const auto last = std::lower_bound(
        first,
        snapshot.buckets.end(),
        upper_rank * count,
        [](const Histogram::RecordedBucket& bucket, double cumulative) {
          return static_cast<double>(bucket.cumulative_count) < cumulative;
        });
    begin_index = first - snapshot.buckets.begin();
    if (last != snapshot.buckets.end()) {
      end_index = last - snapshot.buckets.begin() + 1;
    }
  } else if (snapshot.buckets.size() >= 512) {
    QrdeExactSupport(snapshot,
                     mass_params,
                     reflected_params,
                     count,
                     &begin_index,
                     &end_index);
  }

  const bool dequantize = dequantization != QrdeDequantization::kNone;
  const auto first_range = QrdeBucketRange(snapshot, 0, dequantization);
  const auto last_range =
      QrdeBucketRange(snapshot, snapshot.buckets.size() - 1, dequantization);
  const double lower_endpoint = first_range.first;
  const double upper_endpoint = last_range.second;

  double previous_cdf = 0.0;
  double previous_survival = 0.0;
  double previous_front = 0.0;
  int64_t previous_count =
      begin_index == 0 ? 0 : snapshot.buckets[begin_index - 1].cumulative_count;
  if (previous_count != 0) {
    const double previous_rank = static_cast<double>(previous_count) / count;
    previous_cdf = RegularizedIncompleteBeta(
        mass_params, previous_rank, dequantize ? &previous_front : nullptr);
    if (!std::isfinite(previous_cdf) ||
        (dequantize && !std::isfinite(previous_front))) {
      begin_index = 0;
      end_index = snapshot.buckets.size();
      previous_count = 0;
      previous_cdf = 0.0;
      previous_front = 0.0;
    } else {
      previous_cdf = std::clamp(previous_cdf, 0.0, 1.0);
    }
  }

  double quantile = lower_endpoint * previous_cdf;
  bool using_survival = false;

  for (size_t i = begin_index; i < end_index; i++) {
    const auto& bucket = snapshot.buckets[i];
    const double u0 = static_cast<double>(previous_count) / count;
    const double u1 = static_cast<double>(bucket.cumulative_count) / count;
    double front = 0.0;
    double mass;
    // Use the reflected CDF above the symmetry point so small upper-tail
    // interval weights are not lost to subtraction from one.
    if (u1 <= mass_params.symmetry_point) {
      const double cdf =
          std::clamp(RegularizedIncompleteBeta(
                         mass_params, u1, dequantize ? &front : nullptr),
                     previous_cdf,
                     1.0);
      mass = cdf - previous_cdf;
      previous_cdf = cdf;
    } else {
      const double remaining_rank =
          static_cast<double>(snapshot.total_count - bucket.cumulative_count) /
          count;
      double survival = RegularizedIncompleteBeta(
          reflected_params, remaining_rank, dequantize ? &front : nullptr);
      if (using_survival) {
        survival = std::clamp(survival, 0.0, previous_survival);
        mass = previous_survival - survival;
      } else {
        survival = std::clamp(survival, 0.0, 1.0 - previous_cdf);
        mass = 1.0 - previous_cdf - survival;
        using_survival = true;
      }
      previous_survival = survival;
    }

    if (!QrdeShouldDequantize(bucket, dequantization)) {
      quantile += bucket.value * mass;
    } else {
      // I_x(a + 1, b) = I_x(a, b) - front / a, so the first moment
      // within this rank interval does not require a second beta CDF.
      const double sum = a + b;
      const double rank_width = static_cast<double>(bucket.count) / count;
      const double local_moment =
          std::clamp((a / sum - u0) * mass - (front - previous_front) / sum,
                     0.0,
                     rank_width * mass);
      const auto [lower, upper] = QrdeBucketRange(snapshot, i, dequantization);
      quantile += lower * mass + (upper - lower) * local_moment / rank_width;
    }

    previous_front = front;
    previous_count = bucket.cumulative_count;
  }

  const double remaining_mass =
      using_survival ? previous_survival : 1.0 - previous_cdf;
  quantile += upper_endpoint * std::clamp(remaining_mass, 0.0, 1.0);
  return quantile;
}

static QrdeResult CalculateQrde(const Histogram::RecordedSnapshot& snapshot,
                                const std::vector<double>& probabilities,
                                QrdeDequantization dequantization) {
  QrdeResult result;
  if (snapshot.buckets.empty()) return result;

  result.quantiles.resize(probabilities.size());
  result.densities.resize(probabilities.size() - 1);

  const auto first_range = QrdeBucketRange(snapshot, 0, dequantization);
  const auto last_range =
      QrdeBucketRange(snapshot, snapshot.buckets.size() - 1, dequantization);
  result.quantiles.front() = first_range.first;
  result.quantiles.back() = last_range.second;

  for (size_t i = 1; i + 1 < probabilities.size(); i++) {
    double value = QrdeQuantile(snapshot, probabilities[i], dequantization);
    value =
        std::clamp(value, result.quantiles.front(), result.quantiles.back());
    if (value < result.quantiles[i - 1]) {
      value = result.quantiles[i - 1];
      result.corrections++;
    }
    result.quantiles[i] = value;
  }

  for (size_t i = 0; i < result.densities.size(); i++) {
    const double width = result.quantiles[i + 1] - result.quantiles[i];
    const double probability_mass = probabilities[i + 1] - probabilities[i];
    result.densities[i] = width == 0.0 ? std::numeric_limits<double>::infinity()
                                       : probability_mass / width;
  }

  return result;
}

// -----------------------------------------------------------------------
// Minimal CBOR encoder/decoder (RFC 8949) -- just enough types for
// histogram export/import: unsigned int, float64, array, and map.
// -----------------------------------------------------------------------

// CBOR major types (upper 3 bits of the initial byte).
constexpr uint8_t kCborUint = 0 << 5;   // Major 0: unsigned integer
constexpr uint8_t kCborArray = 4 << 5;  // Major 4: array
constexpr uint8_t kCborMap = 5 << 5;    // Major 5: map
constexpr uint8_t kCborFloat64 = 0xfb;  // Major 7, additional 27

static void CborWriteUint(std::vector<uint8_t>& out,
                          uint8_t major,
                          uint64_t val) {
  if (val <= 23) {
    out.push_back(major | static_cast<uint8_t>(val));
  } else if (val <= 0xff) {
    out.push_back(major | 24);
    out.push_back(static_cast<uint8_t>(val));
  } else if (val <= 0xffff) {
    out.push_back(major | 25);
    out.push_back(static_cast<uint8_t>(val >> 8));
    out.push_back(static_cast<uint8_t>(val));
  } else if (val <= 0xffffffff) {
    out.push_back(major | 26);
    out.push_back(static_cast<uint8_t>(val >> 24));
    out.push_back(static_cast<uint8_t>(val >> 16));
    out.push_back(static_cast<uint8_t>(val >> 8));
    out.push_back(static_cast<uint8_t>(val));
  } else {
    out.push_back(major | 27);
    out.push_back(static_cast<uint8_t>(val >> 56));
    out.push_back(static_cast<uint8_t>(val >> 48));
    out.push_back(static_cast<uint8_t>(val >> 40));
    out.push_back(static_cast<uint8_t>(val >> 32));
    out.push_back(static_cast<uint8_t>(val >> 24));
    out.push_back(static_cast<uint8_t>(val >> 16));
    out.push_back(static_cast<uint8_t>(val >> 8));
    out.push_back(static_cast<uint8_t>(val));
  }
}

static void CborWriteFloat64(std::vector<uint8_t>& out, double val) {
  out.push_back(kCborFloat64);
  uint64_t bits;
  memcpy(&bits, &val, sizeof(bits));
  // Network byte order (big-endian).
  out.push_back(static_cast<uint8_t>(bits >> 56));
  out.push_back(static_cast<uint8_t>(bits >> 48));
  out.push_back(static_cast<uint8_t>(bits >> 40));
  out.push_back(static_cast<uint8_t>(bits >> 32));
  out.push_back(static_cast<uint8_t>(bits >> 24));
  out.push_back(static_cast<uint8_t>(bits >> 16));
  out.push_back(static_cast<uint8_t>(bits >> 8));
  out.push_back(static_cast<uint8_t>(bits));
}

static bool CborReadUint(const uint8_t*& p, const uint8_t* end, uint64_t* val) {
  if (p >= end) return false;
  uint8_t info = *p++ & 0x1f;
  if (info <= 23) {
    *val = info;
  } else if (info == 24) {
    if (p + 1 > end) return false;
    *val = p[0];
    p += 1;
  } else if (info == 25) {
    if (p + 2 > end) return false;
    *val = (static_cast<uint64_t>(p[0]) << 8) | p[1];
    p += 2;
  } else if (info == 26) {
    if (p + 4 > end) return false;
    *val = (static_cast<uint64_t>(p[0]) << 24) |
           (static_cast<uint64_t>(p[1]) << 16) |
           (static_cast<uint64_t>(p[2]) << 8) | p[3];
    p += 4;
  } else if (info == 27) {
    if (p + 8 > end) return false;
    *val = (static_cast<uint64_t>(p[0]) << 56) |
           (static_cast<uint64_t>(p[1]) << 48) |
           (static_cast<uint64_t>(p[2]) << 40) |
           (static_cast<uint64_t>(p[3]) << 32) |
           (static_cast<uint64_t>(p[4]) << 24) |
           (static_cast<uint64_t>(p[5]) << 16) |
           (static_cast<uint64_t>(p[6]) << 8) | p[7];
    p += 8;
  } else {
    return false;  // Indefinite length or reserved -- not supported.
  }
  return true;
}

static bool CborReadFloat64(const uint8_t*& p,
                            const uint8_t* end,
                            double* val) {
  if (p >= end || *p != kCborFloat64) return false;
  p++;
  if (p + 8 > end) return false;
  uint64_t bits = (static_cast<uint64_t>(p[0]) << 56) |
                  (static_cast<uint64_t>(p[1]) << 48) |
                  (static_cast<uint64_t>(p[2]) << 40) |
                  (static_cast<uint64_t>(p[3]) << 32) |
                  (static_cast<uint64_t>(p[4]) << 24) |
                  (static_cast<uint64_t>(p[5]) << 16) |
                  (static_cast<uint64_t>(p[6]) << 8) | p[7];
  p += 8;
  memcpy(val, &bits, sizeof(*val));
  return true;
}

// Read the argument of a data item that must have the given major type
// (kCborUint, kCborArray, or kCborMap). CborReadUint() alone decodes the
// argument of any major type.
static bool CborReadArgument(const uint8_t*& p,
                             const uint8_t* end,
                             uint8_t major,
                             uint64_t* val) {
  if (p >= end || (*p & 0xe0) != major) return false;
  return CborReadUint(p, end, val);
}

// Read an unsigned integer that must fit into a non-negative int64_t.
static bool CborReadInt64(const uint8_t*& p, const uint8_t* end, int64_t* val) {
  uint64_t v;
  if (!CborReadArgument(p, end, kCborUint, &v) ||
      v > static_cast<uint64_t>(std::numeric_limits<int64_t>::max())) {
    return false;
  }
  *val = static_cast<int64_t>(v);
  return true;
}

// Read an unsigned integer that must fit into a non-negative int32_t.
static bool CborReadInt32(const uint8_t*& p, const uint8_t* end, int32_t* val) {
  uint64_t v;
  if (!CborReadArgument(p, end, kCborUint, &v) ||
      v > static_cast<uint64_t>(std::numeric_limits<int32_t>::max())) {
    return false;
  }
  *val = static_cast<int32_t>(v);
  return true;
}

// Read a value that may be either a uint or float64.
static bool CborReadNumber(const uint8_t*& p, const uint8_t* end, double* val) {
  if (p >= end) return false;
  if (*p == kCborFloat64) return CborReadFloat64(p, end, val);
  uint64_t u;
  if (!CborReadArgument(p, end, kCborUint, &u)) return false;
  *val = static_cast<double>(u);
  return true;
}

// Maximum nesting depth of the values that CborSkipItem() skips over.
constexpr int kCborMaxSkipDepth = 16;

// Skip over one well-formed data item, including any items nested within it.
// Indefinite-length items are not supported.
static bool CborSkipItem(const uint8_t*& p, const uint8_t* end, int depth = 0) {
  if (p >= end || depth > kCborMaxSkipDepth) return false;
  const uint8_t major = *p >> 5;
  const uint8_t info = *p & 0x1f;

  if (major == 7) {
    // Simple values and floats. Additional information 24 to 27 is followed
    // by 1, 2, 4, or 8 bytes; 28 to 30 are reserved, and 31 is a break.
    size_t extra;
    if (info <= 23) {
      extra = 0;
    } else if (info <= 27) {
      extra = size_t{1} << (info - 24);
    } else {
      return false;
    }
    p++;
    if (static_cast<size_t>(end - p) < extra) return false;
    p += extra;
    return true;
  }

  uint64_t arg;
  if (!CborReadUint(p, end, &arg)) return false;
  switch (major) {
    case 0:  // Unsigned integer.
    case 1:  // Negative integer.
      return true;
    case 2:  // Byte string.
    case 3:  // Text string.
      if (arg > static_cast<uint64_t>(end - p)) return false;
      p += arg;
      return true;
    case 4:    // Array.
    case 5: {  // Map.
      // Each item takes at least one byte, which also bounds the loop.
      if (arg > static_cast<uint64_t>(end - p)) return false;
      const uint64_t items = major == 4 ? arg : arg * 2;
      for (uint64_t i = 0; i < items; i++) {
        if (!CborSkipItem(p, end, depth + 1)) return false;
      }
      return true;
    }
    case 6:  // Tag.
      return CborSkipItem(p, end, depth + 1);
  }
  return false;
}

// Histogram export format version. Version 2 has the same layout as
// version 1, but importers ignore unknown keys in version 2 data, so fields
// can be added without changing the version. Version 1 data is imported
// with its original semantics, which reject unknown keys.
constexpr uint64_t kExportVersion = 2;
constexpr uint64_t kStrictExportVersion = 1;

// Integer keys for the top-level CBOR map.
constexpr uint64_t kKeyVersion = 0;
constexpr uint64_t kKeyLowest = 1;
constexpr uint64_t kKeyHighest = 2;
constexpr uint64_t kKeyFigures = 3;
constexpr uint64_t kKeyTotalCount = 4;
constexpr uint64_t kKeyMin = 5;
constexpr uint64_t kKeyMax = 6;
constexpr uint64_t kKeyNormOffset = 7;
constexpr uint64_t kKeyConvRatio = 8;
constexpr uint64_t kKeyCountsLen = 9;
constexpr uint64_t kKeyCounts = 10;
constexpr uint64_t kKeyEwma = 11;

// Integer keys for the EWMA sub-map.
constexpr uint64_t kEwmaAlpha = 0;
constexpr uint64_t kEwmaMean = 1;
constexpr uint64_t kEwmaVariance = 2;
constexpr uint64_t kEwmaErrorRate = 3;
constexpr uint64_t kEwmaThreshold = 4;
}  // namespace

Histogram::MeanCIResult Histogram::MeanCI(double confidence) const {
  RwLock::ScopedReadLock lock(mutex_);
  int64_t count = histogram_->total_count;
  double mean = hdr_mean(histogram_.get());
  if (count < 2) {
    double nan = std::numeric_limits<double>::quiet_NaN();
    return {mean, nan, nan};
  }

  double stddev = hdr_stddev(histogram_.get());
  if (stddev == 0.0) return {mean, mean, mean};

  // HdrHistogram computes population stddev (divides by N). The confidence
  // interval requires sample variance (divides by N-1).
  double variance = stddev * stddev * static_cast<double>(count) /
                    static_cast<double>(count - 1);
  double standard_error = std::sqrt(variance / static_cast<double>(count));
  double alpha = 1.0 - confidence;
  double t_crit =
      StudentTUpperQuantile(alpha / 2.0, static_cast<double>(count - 1));
  double margin = t_crit * standard_error;
  return {mean, mean - margin, mean + margin};
}

Histogram::WelchTestResult Histogram::WelchTest(const Histogram& other,
                                                double confidence) const {
  auto do_welch = [&]() -> WelchTestResult {
    int64_t n1 = histogram_->total_count;
    int64_t n2 = other.histogram_->total_count;
    if (n1 < 2 || n2 < 2) return {0, 0, 1, 0, 0};

    double mean1 = hdr_mean(histogram_.get());
    double mean2 = hdr_mean(other.histogram_.get());
    double sd1 = hdr_stddev(histogram_.get());
    double sd2 = hdr_stddev(other.histogram_.get());

    // HdrHistogram computes population stddev (divides by N).
    // Welch's t-test requires sample variance (divides by N-1).
    double var1 =
        sd1 * sd1 * static_cast<double>(n1) / static_cast<double>(n1 - 1);
    double var2 =
        sd2 * sd2 * static_cast<double>(n2) / static_cast<double>(n2 - 1);

    double se1 = var1 / static_cast<double>(n1);
    double se2 = var2 / static_cast<double>(n2);
    double se_sum = se1 + se2;
    if (se_sum == 0.0) return {0, 0, 1, 0, 0};

    double t = (mean1 - mean2) / std::sqrt(se_sum);

    // Welch-Satterthwaite degrees of freedom.
    double df = (se_sum * se_sum) / (se1 * se1 / static_cast<double>(n1 - 1) +
                                     se2 * se2 / static_cast<double>(n2 - 1));

    // Two-tailed p-value.
    double p = 2.0 * StudentTCdf(-std::fabs(t), df);

    // Confidence interval on the difference of means.
    double alpha = 1.0 - confidence;
    double t_crit = StudentTUpperQuantile(alpha / 2.0, df);
    double margin = t_crit * std::sqrt(se_sum);
    double diff = mean1 - mean2;

    return {t, df, p, diff - margin, diff + margin};
  };

  if (this == &other) return {0, 0, 1, 0, 0};

  if (std::less<const Histogram*>{}(this, &other)) {
    RwLock::ScopedReadLock lock1(mutex_);
    RwLock::ScopedReadLock lock2(other.mutex_);
    return do_welch();
  }

  RwLock::ScopedReadLock lock1(other.mutex_);
  RwLock::ScopedReadLock lock2(mutex_);
  return do_welch();
}

Histogram::MannWhitneyResult Histogram::MannWhitneyTest(
    const Histogram& other) const {
  auto do_mw = [&]() -> MannWhitneyResult {
    int64_t n1 = histogram_->total_count;
    int64_t n2 = other.histogram_->total_count;
    if (n1 == 0 || n2 == 0) return {0, 0, 1};

    // Walk the counts arrays to compute the U statistic.
    // At each bucket index, values from histogram 1 at index i "beat"
    // all values from histogram 2 at indices < i (concordant pairs).
    int32_t len =
        std::max(histogram_->counts_len, other.histogram_->counts_len);

    // Forward pass: count concordant pairs (h1 values > h2 values).
    int64_t cum2 = 0;
    double concordant = 0.0;
    double tied = 0.0;
    for (int32_t i = 0; i < len; i++) {
      int64_t c1 = (i < histogram_->counts_len) ? histogram_->counts[i] : 0;
      int64_t c2 =
          (i < other.histogram_->counts_len) ? other.histogram_->counts[i] : 0;
      concordant += static_cast<double>(c1) * static_cast<double>(cum2);
      tied += static_cast<double>(c1) * static_cast<double>(c2);
      cum2 += c2;
    }

    // U statistic for sample 1: concordant + half of ties.
    double u = concordant + 0.5 * tied;
    double dn1 = static_cast<double>(n1);
    double dn2 = static_cast<double>(n2);
    double mu = dn1 * dn2 / 2.0;

    // Tie correction for the variance.
    // sigma^2 = n1*n2/12 * (N+1 - sum(t_k^3 - t_k) / (N*(N-1)))
    // where t_k is the number of observations tied at rank k.
    double n_total = dn1 + dn2;
    double tie_correction = 0.0;
    for (int32_t i = 0; i < len; i++) {
      int64_t c1 = (i < histogram_->counts_len) ? histogram_->counts[i] : 0;
      int64_t c2 =
          (i < other.histogram_->counts_len) ? other.histogram_->counts[i] : 0;
      double tk = static_cast<double>(c1 + c2);
      if (tk > 1) {
        tie_correction += tk * tk * tk - tk;
      }
    }

    double sigma_sq =
        (dn1 * dn2 / 12.0) *
        (n_total + 1.0 - tie_correction / (n_total * (n_total - 1.0)));
    if (sigma_sq <= 0.0) return {u, 0, 1};

    // Continuity-corrected z-score.
    double z = (u - mu) / std::sqrt(sigma_sq);
    // Two-tailed p-value using normal approximation.
    double p = 2.0 * NormalCdf(-std::fabs(z));

    return {u, z, p};
  };

  if (this == &other) return {0, 0, 1};

  if (std::less<const Histogram*>{}(this, &other)) {
    RwLock::ScopedReadLock lock1(mutex_);
    RwLock::ScopedReadLock lock2(other.mutex_);
    return do_mw();
  }

  RwLock::ScopedReadLock lock1(other.mutex_);
  RwLock::ScopedReadLock lock2(mutex_);
  return do_mw();
}

double Histogram::CohensD(const Histogram& other) const {
  auto do_cohens = [&]() -> double {
    int64_t n1 = histogram_->total_count;
    int64_t n2 = other.histogram_->total_count;
    if (n1 < 2 || n2 < 2) return 0.0;

    double mean1 = hdr_mean(histogram_.get());
    double mean2 = hdr_mean(other.histogram_.get());
    double sd1 = hdr_stddev(histogram_.get());
    double sd2 = hdr_stddev(other.histogram_.get());

    // Convert population variance to sample variance (Bessel's correction).
    double var1 =
        sd1 * sd1 * static_cast<double>(n1) / static_cast<double>(n1 - 1);
    double var2 =
        sd2 * sd2 * static_cast<double>(n2) / static_cast<double>(n2 - 1);

    double pooled_sd = std::sqrt((static_cast<double>(n1 - 1) * var1 +
                                  static_cast<double>(n2 - 1) * var2) /
                                 static_cast<double>(n1 + n2 - 2));
    if (pooled_sd == 0.0) return 0.0;

    return (mean1 - mean2) / pooled_sd;
  };

  if (this == &other) return 0.0;

  if (std::less<const Histogram*>{}(this, &other)) {
    RwLock::ScopedReadLock lock1(mutex_);
    RwLock::ScopedReadLock lock2(other.mutex_);
    return do_cohens();
  }

  RwLock::ScopedReadLock lock1(other.mutex_);
  RwLock::ScopedReadLock lock2(mutex_);
  return do_cohens();
}

double Histogram::CliffsD(const Histogram& other) const {
  auto do_cliffs = [&]() -> double {
    int64_t n1 = histogram_->total_count;
    int64_t n2 = other.histogram_->total_count;
    if (n1 == 0 || n2 == 0) return 0.0;

    int32_t len =
        std::max(histogram_->counts_len, other.histogram_->counts_len);

    // Forward pass: count pairs where h1 value > h2 value (concordant).
    int64_t cum2 = 0;
    double concordant = 0.0;
    double tied = 0.0;
    for (int32_t i = 0; i < len; i++) {
      int64_t c1 = (i < histogram_->counts_len) ? histogram_->counts[i] : 0;
      int64_t c2 =
          (i < other.histogram_->counts_len) ? other.histogram_->counts[i] : 0;
      concordant += static_cast<double>(c1) * static_cast<double>(cum2);
      tied += static_cast<double>(c1) * static_cast<double>(c2);
      cum2 += c2;
    }

    double discordant =
        static_cast<double>(n1) * static_cast<double>(n2) - concordant - tied;

    return (concordant - discordant) /
           (static_cast<double>(n1) * static_cast<double>(n2));
  };

  if (this == &other) return 0.0;

  if (std::less<const Histogram*>{}(this, &other)) {
    RwLock::ScopedReadLock lock1(mutex_);
    RwLock::ScopedReadLock lock2(other.mutex_);
    return do_cliffs();
  }

  RwLock::ScopedReadLock lock1(other.mutex_);
  RwLock::ScopedReadLock lock2(mutex_);
  return do_cliffs();
}

Histogram::PercentileCIResult Histogram::PercentileCI(double percentile,
                                                      double confidence) const {
  RwLock::ScopedReadLock lock(mutex_);

  int64_t value = hdr_value_at_percentile(histogram_.get(), percentile);
  int64_t n = histogram_->total_count;

  if (n < 2) {
    return {value, value, value};
  }

  double p = percentile / 100.0;
  double alpha = 1.0 - confidence;

  // Lower rank: largest j such that BinomialCdf(j-1, n, p) <= alpha/2.
  // Binary search over [0, n].
  int64_t lo = 0;
  int64_t hi = n;
  while (lo < hi) {
    int64_t mid = lo + (hi - lo + 1) / 2;
    if (BinomialCdf(mid - 1, n, p) <= alpha / 2.0) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  double lower_pct = static_cast<double>(lo) / static_cast<double>(n) * 100.0;

  // Upper rank: smallest k such that BinomialCdf(k-1, n, p) >= 1 - alpha/2.
  lo = 0;
  hi = n;
  while (lo < hi) {
    int64_t mid = lo + (hi - lo) / 2;
    if (BinomialCdf(mid - 1, n, p) >= 1.0 - alpha / 2.0) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  double upper_pct = static_cast<double>(lo) / static_cast<double>(n) * 100.0;

  int64_t lower_val = hdr_value_at_percentile(histogram_.get(), lower_pct);
  int64_t upper_val = hdr_value_at_percentile(histogram_.get(), upper_pct);

  return {value, lower_val, upper_val};
}

// Serialize the histogram to a CBOR (RFC 8949) byte sequence. There is no
// standard for serializing histograms, so this format is specific to this
// implementation. But, it has been designed to be compact, extensible, and
// portable across languages and platforms. Should be easily parseable in
// other languages with or without a CBOR library.
//
// The delta-encoded sparse counts is a space-saving optimization in the
// common case.
//
// Layout: a CBOR map with integer keys:
//   0  -> uint    format version (currently 2)
//   1  -> uint    lowest discernible value
//   2  -> uint    highest trackable value
//   3  -> uint    significant figures
//   4  -> uint    total count
//   5  -> uint    min value
//   6  -> uint    max value
//   7  -> uint    normalizing index offset
//   8  -> float64 conversion ratio
//   9  -> uint    counts array length
//   10 -> array   delta-encoded sparse counts as flat [delta, count, ...]
//                 (first delta is the absolute index)
//   11 -> map     EWMA state (omitted when alpha = 0):
//        0 -> float64 alpha
//        1 -> float64 mean
//        2 -> float64 variance
//        3 -> float64 error rate
//        4 -> uint    threshold
//
// Compatibility: Import() accepts format versions 1 and 2, whose layouts are
// identical. In version 2 data, keys that the importer does not recognize are
// skipped, so new fields can be added without changing the version. Version 1
// data keeps its original semantics, in which unknown keys are rejected. Any
// field may be absent; the total count, min, and max are then derived from
// the counts.
std::vector<uint8_t> Histogram::Export() const {
  RwLock::ScopedReadLock lock(mutex_);

  // Count non-zero buckets for the sparse encoding.
  int32_t non_zero = 0;
  for (int32_t i = 0; i < histogram_->counts_len; i++) {
    if (histogram_->counts[i] != 0) non_zero++;
  }

  bool has_ewma = ewma_alpha_ > 0;
  uint64_t map_size = has_ewma ? 12 : 11;

  std::vector<uint8_t> out;
  out.reserve(64 + non_zero * 10);

  // Top-level map.
  CborWriteUint(out, kCborMap, map_size);

  // 0: version
  CborWriteUint(out, kCborUint, kKeyVersion);
  CborWriteUint(out, kCborUint, kExportVersion);
  // 1: lowest
  CborWriteUint(out, kCborUint, kKeyLowest);
  CborWriteUint(out,
                kCborUint,
                static_cast<uint64_t>(histogram_->lowest_discernible_value));
  // 2: highest
  CborWriteUint(out, kCborUint, kKeyHighest);
  CborWriteUint(out,
                kCborUint,
                static_cast<uint64_t>(histogram_->highest_trackable_value));
  // 3: figures
  CborWriteUint(out, kCborUint, kKeyFigures);
  CborWriteUint(
      out, kCborUint, static_cast<uint64_t>(histogram_->significant_figures));
  // 4: total_count
  CborWriteUint(out, kCborUint, kKeyTotalCount);
  CborWriteUint(out, kCborUint, static_cast<uint64_t>(histogram_->total_count));
  // 5: min
  CborWriteUint(out, kCborUint, kKeyMin);
  CborWriteUint(out, kCborUint, static_cast<uint64_t>(histogram_->min_value));
  // 6: max
  CborWriteUint(out, kCborUint, kKeyMax);
  CborWriteUint(out, kCborUint, static_cast<uint64_t>(histogram_->max_value));
  // 7: normalizing_index_offset
  CborWriteUint(out, kCborUint, kKeyNormOffset);
  CborWriteUint(out,
                kCborUint,
                static_cast<uint64_t>(histogram_->normalizing_index_offset));
  // 8: conversion_ratio
  CborWriteUint(out, kCborUint, kKeyConvRatio);
  CborWriteFloat64(out, histogram_->conversion_ratio);
  // 9: counts_len
  CborWriteUint(out, kCborUint, kKeyCountsLen);
  CborWriteUint(out, kCborUint, static_cast<uint64_t>(histogram_->counts_len));
  // 10: sparse counts -- array of [delta, count, ...] pairs.
  // Indices are delta-encoded: the first value is the absolute index,
  // each subsequent value is the difference from the previous index.
  CborWriteUint(out, kCborUint, kKeyCounts);
  CborWriteUint(out, kCborArray, static_cast<uint64_t>(non_zero) * 2);
  int32_t prev_idx = 0;
  for (int32_t i = 0; i < histogram_->counts_len; i++) {
    if (histogram_->counts[i] != 0) {
      CborWriteUint(out, kCborUint, static_cast<uint64_t>(i - prev_idx));
      CborWriteUint(
          out, kCborUint, static_cast<uint64_t>(histogram_->counts[i]));
      prev_idx = i;
    }
  }

  // 11: EWMA state (optional)
  if (has_ewma) {
    CborWriteUint(out, kCborUint, kKeyEwma);
    CborWriteUint(out, kCborMap, 5);
    CborWriteUint(out, kCborUint, kEwmaAlpha);
    CborWriteFloat64(out, ewma_alpha_);
    CborWriteUint(out, kCborUint, kEwmaMean);
    CborWriteFloat64(out, ewma_mean_);
    CborWriteUint(out, kCborUint, kEwmaVariance);
    CborWriteFloat64(out, ewma_variance_);
    CborWriteUint(out, kCborUint, kEwmaErrorRate);
    CborWriteFloat64(out, ewma_error_rate_);
    CborWriteUint(out, kCborUint, kEwmaThreshold);
    CborWriteUint(out, kCborUint, static_cast<uint64_t>(threshold_));
  }

  return out;
}

std::shared_ptr<Histogram> Histogram::Import(const uint8_t* data, size_t len) {
  const uint8_t* p = data;
  const uint8_t* end = data + len;

  // Read top-level map header.
  uint64_t map_size;
  if (!CborReadArgument(p, end, kCborMap, &map_size)) return nullptr;

  int64_t lowest = 1;
  int64_t highest = std::numeric_limits<int64_t>::max();
  int32_t figures = 3;
  int64_t total_count = 0;
  int64_t min_value = std::numeric_limits<int64_t>::max();
  int64_t max_value = 0;
  int32_t norm_offset = 0;
  double conv_ratio = 1.0;
  int32_t counts_len = 0;
  // Data without a version key is imported as version 1.
  uint64_t version = kStrictExportVersion;

  // Bitsets of the keys read so far, used to reject duplicate keys and to
  // tell whether a field was present. All known keys are less than 64.
  uint64_t seen_keys = 0;
  uint64_t seen_ewma_keys = 0;
  // Unknown keys are skipped while parsing, because the version key that
  // determines whether they are allowed can appear anywhere in the map.
  bool has_unknown_keys = false;
  auto mark_seen = [](uint64_t* seen, uint64_t key) {
    const uint64_t bit = uint64_t{1} << key;
    if (*seen & bit) return false;
    *seen |= bit;
    return true;
  };
  auto has_key = [&seen_keys](uint64_t key) {
    return (seen_keys & (uint64_t{1} << key)) != 0;
  };

  // Sparse counts storage.
  std::vector<std::pair<int32_t, int64_t>> sparse_counts;

  // EWMA state.
  double ewma_alpha = 0;
  double ewma_mean = 0;
  double ewma_variance = 0;
  double ewma_error_rate = 0;
  int64_t threshold = 0;

  for (uint64_t i = 0; i < map_size; i++) {
    // Read key (unsigned int).
    uint64_t key;
    if (!CborReadArgument(p, end, kCborUint, &key)) return nullptr;
    if (key > kKeyEwma) {
      // Unknown key.
      if (!CborSkipItem(p, end)) return nullptr;
      has_unknown_keys = true;
      continue;
    }
    if (!mark_seen(&seen_keys, key)) return nullptr;  // Duplicate key.

    switch (key) {
      case kKeyVersion:
        if (!CborReadArgument(p, end, kCborUint, &version)) return nullptr;
        if (version < kStrictExportVersion || version > kExportVersion) {
          return nullptr;
        }
        break;
      case kKeyLowest:
        if (!CborReadInt64(p, end, &lowest)) return nullptr;
        break;
      case kKeyHighest:
        if (!CborReadInt64(p, end, &highest)) return nullptr;
        break;
      case kKeyFigures:
        if (!CborReadInt32(p, end, &figures)) return nullptr;
        break;
      case kKeyTotalCount:
        if (!CborReadInt64(p, end, &total_count)) return nullptr;
        break;
      case kKeyMin:
        if (!CborReadInt64(p, end, &min_value)) return nullptr;
        break;
      case kKeyMax:
        if (!CborReadInt64(p, end, &max_value)) return nullptr;
        break;
      case kKeyNormOffset:
        // Reject values that cannot be represented as int32_t; casting them
        // would wrap and produce an arbitrary offset.
        if (!CborReadInt32(p, end, &norm_offset)) return nullptr;
        break;
      case kKeyConvRatio:
        if (!CborReadNumber(p, end, &conv_ratio)) return nullptr;
        break;
      case kKeyCountsLen:
        if (!CborReadInt32(p, end, &counts_len)) return nullptr;
        break;
      case kKeyCounts: {
        // Array of flat [delta, count, ...] pairs. Indices are
        // delta-encoded: accumulate to recover absolute indices.
        uint64_t arr_len;
        if (!CborReadArgument(p, end, kCborArray, &arr_len)) return nullptr;
        if (arr_len % 2 != 0) return nullptr;
        // Each element needs at least 1 byte of CBOR encoding, so
        // arr_len can't exceed the remaining buffer. Without this
        // check, a crafted buffer claiming arr_len=2^60 would cause
        // reserve() to OOM-crash before the loop catches the error.
        if (arr_len > static_cast<uint64_t>(end - p)) return nullptr;
        sparse_counts.reserve(static_cast<size_t>(arr_len / 2));
        int64_t acc_idx = 0;
        for (uint64_t j = 0; j < arr_len; j += 2) {
          int32_t delta;
          int64_t cnt;
          if (!CborReadInt32(p, end, &delta)) return nullptr;
          if (!CborReadInt64(p, end, &cnt)) return nullptr;
          // Indices are strictly increasing, so only the first delta (the
          // absolute index of the first non-empty bucket) may be zero.
          if (j > 0 && delta == 0) return nullptr;
          acc_idx += delta;
          if (acc_idx > std::numeric_limits<int32_t>::max()) return nullptr;
          sparse_counts.emplace_back(static_cast<int32_t>(acc_idx), cnt);
        }
        break;
      }
      case kKeyEwma: {
        // Sub-map for EWMA state.
        uint64_t sub_size;
        if (!CborReadArgument(p, end, kCborMap, &sub_size)) return nullptr;
        for (uint64_t j = 0; j < sub_size; j++) {
          uint64_t sub_key;
          if (!CborReadArgument(p, end, kCborUint, &sub_key)) return nullptr;
          if (sub_key > kEwmaThreshold) {
            // Unknown EWMA key.
            if (!CborSkipItem(p, end)) return nullptr;
            has_unknown_keys = true;
            continue;
          }
          if (!mark_seen(&seen_ewma_keys, sub_key)) return nullptr;
          switch (sub_key) {
            case kEwmaAlpha:
              if (!CborReadNumber(p, end, &ewma_alpha)) return nullptr;
              break;
            case kEwmaMean:
              if (!CborReadNumber(p, end, &ewma_mean)) return nullptr;
              break;
            case kEwmaVariance:
              if (!CborReadNumber(p, end, &ewma_variance)) return nullptr;
              break;
            case kEwmaErrorRate:
              if (!CborReadNumber(p, end, &ewma_error_rate)) return nullptr;
              break;
            case kEwmaThreshold:
              if (!CborReadInt64(p, end, &threshold)) return nullptr;
              break;
          }
        }
        break;
      }
    }
  }

  // Version 1 data keeps its original semantics: unknown keys are rejected.
  if (version == kStrictExportVersion && has_unknown_keys) return nullptr;

  // Reconstruct the histogram.
  Options opts;
  opts.lowest = lowest;
  opts.highest = highest;
  opts.figures = figures;
  // Compute half_life from alpha: alpha = 1 - 2^(-1/halfLife)
  // => halfLife = -1 / log2(1 - alpha)
  if (ewma_alpha > 0 && ewma_alpha < 1) {
    opts.half_life = -1.0 / std::log2(1.0 - ewma_alpha);
  }
  opts.threshold = threshold;

  auto histogram = Histogram::Create(opts);
  if (!histogram) return nullptr;

  // Validate counts_len matches what the options produce.
  if (histogram->histogram_->counts_len != counts_len) return nullptr;

  // The normalization offset must index into the allocated counts array.
  // normalize_index() in hdr_histogram.c applies at most one wrap
  // adjustment of +/-counts_len, so any offset outside [0, counts_len)
  // can leave normalized_index out of bounds and a later record() would
  // perform an out-of-bounds write in counts_inc_normalised().
  if (norm_offset < 0 || norm_offset >= counts_len) return nullptr;

  // Restore counts directly.
  int64_t observed_total_count = 0;
  for (const auto& [idx, cnt] : sparse_counts) {
    if (idx < 0 || idx >= counts_len) return nullptr;
    // The counts must add up without overflowing int64_t.
    if (cnt > std::numeric_limits<int64_t>::max() - observed_total_count) {
      return nullptr;
    }
    observed_total_count += cnt;
    histogram->histogram_->counts[idx] = cnt;
  }
  histogram->histogram_->normalizing_index_offset = norm_offset;
  histogram->histogram_->conversion_ratio = conv_ratio;

  // Derive the total count, min, and max from the counts, as
  // Histogram::Subtract() does. This keeps the histogram consistent when
  // any of them are absent. A total count that is present must match the
  // counts. Min and max values that are present are restored as recorded.
  hdr_reset_internal_counters(histogram->histogram_.get());
  if (has_key(kKeyTotalCount) &&
      total_count != histogram->histogram_->total_count) {
    return nullptr;
  }
  if (has_key(kKeyMin)) histogram->histogram_->min_value = min_value;
  if (has_key(kKeyMax)) histogram->histogram_->max_value = max_value;

  // Restore EWMA state.
  if (ewma_alpha > 0) {
    histogram->ewma_mean_ = ewma_mean;
    histogram->ewma_variance_ = ewma_variance;
    histogram->ewma_error_rate_ = ewma_error_rate;
    histogram->ewma_initialized_ = true;
  }

  return histogram;
}

QrdeResult CalculateHistogramQrde(const Histogram::RecordedSnapshot& snapshot,
    const std::vector<double>& probabilities, QrdeDequantization mode) {
  return CalculateQrde(snapshot, probabilities, mode);
}
}  // namespace kandelo::histogram
