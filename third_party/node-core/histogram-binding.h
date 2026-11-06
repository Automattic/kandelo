// Engine-independent transport values for the real pinned histogram owner.
#ifndef KANDELO_NODE_HISTOGRAM_BINDING_H_
#define KANDELO_NODE_HISTOGRAM_BINDING_H_
#include "histogram-owner.h"
#include "histogram-window.h"
#include "histogram-work.h"
#include <string>
#include <variant>
namespace kandelo::histogram {
struct HistogramBindingError : std::exception {
  const char* code;
  const char* name;
  const char* message;
  HistogramBindingError(const char* code, const char* name, const char* message)
      : code(code), name(name), message(message) {}
  const char* what() const noexcept override { return message; }
};
[[noreturn]] inline void HistogramBindingRange(const char* message) {
  throw HistogramBindingError("ERR_OUT_OF_RANGE", "RangeError", message);
}
struct HistogramBindingState {
  std::shared_ptr<Histogram> histogram;
  std::unique_ptr<SlidingWindowHistogram> window;
  std::unique_ptr<memory::Claim> claim;
  size_t MaterialBytes() const { return sizeof(*this) + (claim ? sizeof(memory::Claim) : 0); }
  void ClaimMemory(const memory::AccountHandle& account) {
    auto next = std::make_unique<memory::Claim>(histogram ? histogram->RetainedAllocation() : window->RetainedAllocation(), account);
    claim = std::move(next);
  }
};
struct HistogramBindingInteger { int64_t value; bool big; };
struct HistogramBindingUnsigned { uint64_t value; bool big; };
struct HistogramBindingNumbers { std::vector<double> values; };
struct HistogramBindingEntries {
  std::vector<std::pair<double, int64_t>> values;
  bool big = false;
};
using HistogramBindingResult = std::variant<std::monostate, double,
    HistogramBindingInteger, HistogramBindingUnsigned, HistogramBindingNumbers,
    HistogramBindingEntries, std::vector<uint8_t>, std::shared_ptr<Histogram>>;

inline std::unique_ptr<HistogramBindingState> HistogramBindingCreate(
    const Histogram::Options& options, HistogramClock clock = HistogramMonotonicNow) {
  auto result = std::make_unique<HistogramBindingState>();
  result->histogram = Histogram::Create(options, clock);
  if (!result->histogram)
    throw HistogramBindingError("ERR_INVALID_ARG_VALUE", "TypeError", "Invalid histogram options");
  return result;
}
inline std::unique_ptr<HistogramBindingState> HistogramBindingWindow(
    const Histogram::Options& options, size_t chunks, bool time, uint64_t rotate,
    HistogramClock clock = HistogramMonotonicNow) {
  if (chunks == 0) HistogramBindingRange("options.chunks is out of range");
  if (rotate == 0) HistogramBindingRange("rotation interval is out of range");
  auto result = std::make_unique<HistogramBindingState>();
  result->window = SlidingWindowHistogram::Create(options, chunks, time, rotate, clock);
  if (!result->window)
    throw HistogramBindingError("ERR_INVALID_ARG_VALUE", "TypeError", "Invalid histogram options");
  return result;
}
inline std::shared_ptr<Histogram> HistogramBindingImport(const uint8_t* data, size_t length) {
  auto result = Histogram::Import(data, length);
  if (!result) throw HistogramBindingError("ERR_INVALID_ARG_VALUE", "TypeError", "Invalid histogram export data");
  return result;
}

// The JS wrapper validates public types/ranges before these native operations.
// Transport adapters must still reject illegal native receivers and preserve
// lossless int64 conversion before entering the owner.
inline HistogramBindingResult HistogramBindingDispatch(const std::string& name,
    HistogramBindingState& owner, double number = 0, int64_t integer = 0,
    int64_t interval = 0, const Histogram* other = nullptr,
    const std::vector<double>& percentiles = {}, double confidence = .95) {
  if (owner.window) {
    if (name == "record") {
      if (!owner.window->RecordValue(integer)) throw std::bad_alloc();
      return {};
    }
    if (name == "reset") { owner.window->ResetWindow(); return {}; }
    if (name == "snapshot") return owner.window->CreateSnapshot();
    throw HistogramBindingError("ERR_INVALID_THIS", "TypeError", "Invalid native sliding histogram receiver");
  }
  auto& h = *owner.histogram;
  if (name == "count" || name == "countBigInt") return HistogramBindingUnsigned{h.Count(), name == "countBigInt"};
  if (name == "exceeds" || name == "exceedsBigInt") return HistogramBindingUnsigned{h.Exceeds(), name == "exceedsBigInt"};
  if (name == "min" || name == "minBigInt") return HistogramBindingInteger{h.Min(), name == "minBigInt"};
  if (name == "max" || name == "maxBigInt") return HistogramBindingInteger{h.Max(), name == "maxBigInt"};
  if (name == "mean") return h.Mean();
  if (name == "stddev") return h.Stddev();
  if (name == "skewness") return h.Skewness();
  if (name == "kurtosis") return h.Kurtosis();
  if (name == "ewmaMean") return h.EwmaMean();
  if (name == "ewmaStddev") return h.EwmaStddev();
  if (name == "ewmaErrorRate") return h.EwmaErrorRate();
  if (name == "cdf") return h.Cdf(integer);
  if (name == "countAt") return double(h.CountAt(integer));
  if (name == "resetCount") return double(h.ResetCount());
  if (name == "record") { h.Record(integer); return {}; }
  if (name == "recordCorrected") { h.RecordCorrected(integer, interval); return {}; }
  if (name == "recordDelta") { h.RecordDelta(); return {}; }
  if (name == "reset") { h.Reset(); return {}; }
  if (name == "add") return h.Add(*other);
  if (name == "subtract") return h.Subtract(*other);
  if (name == "snapshot") return h.Clone();
  if (name == "share") return owner.histogram;
  if (name == "export") return h.Export();
  if (name == "percentile" || name == "percentileBigInt")
    return HistogramBindingInteger{h.Percentile(number), name == "percentileBigInt"};
  if (name == "ksTest") return h.KsTest(*other);
  if (name == "cohensD") return h.CohensD(*other);
  if (name == "cliffsD") return h.CliffsD(*other);
  if (name == "diff") {
    Histogram::DiffError error;
    auto result = h.Diff(*other, &error);
    switch (error) {
      case Histogram::DiffError::kNone: return result;
      case Histogram::DiffError::kOutOfMemory: throw std::bad_alloc();
      case Histogram::DiffError::kIncompatible:
        throw HistogramBindingError("ERR_INVALID_ARG_VALUE", "TypeError", "other must have the same configuration as the histogram");
      case Histogram::DiffError::kReset:
        throw HistogramBindingError("ERR_INVALID_STATE", "Error", "Values were removed from the histogram after other was taken");
      case Histogram::DiffError::kNotEarlier:
        throw HistogramBindingError("ERR_INVALID_ARG_VALUE", "TypeError", "other contains values that are not in the histogram");
    }
  }
  if (name == "meanCI") {
    auto ci = h.MeanCI(number); return HistogramBindingNumbers{{ci.mean, ci.lower, ci.upper}};
  }
  if (name == "percentileCI") {
    auto ci = h.PercentileCI(number, confidence);
    return HistogramBindingNumbers{{double(ci.value), double(ci.lower), double(ci.upper)}};
  }
  if (name == "welchTest") {
    auto r = h.WelchTest(*other, number);
    return HistogramBindingNumbers{{r.t_statistic, r.degrees_of_freedom, r.p_value, r.ci_lower, r.ci_upper}};
  }
  if (name == "mannWhitneyTest") {
    auto r = h.MannWhitneyTest(*other);
    return HistogramBindingNumbers{{r.u_statistic, r.z_score, r.p_value}};
  }
  HistogramBindingEntries entries;
  if (name == "percentiles" || name == "percentilesBigInt") {
    entries.big = name == "percentilesBigInt";
    h.Percentiles([&](double key, int64_t value) { entries.values.emplace_back(key, value); });
    return entries;
  }
  if (name == "percentilesAt") {
    std::vector<int64_t> values(percentiles.size());
    h.PercentilesAt(percentiles.data(), values.data(), values.size());
    for (size_t i = 0; i < values.size(); ++i) entries.values.emplace_back(percentiles[i], values[i]);
    return entries;
  }
  if (name == "linearBuckets") {
    h.LinearBuckets(integer, [&](int64_t key, int64_t count) { entries.values.emplace_back(double(key), count); });
    return entries;
  }
  if (name == "logBuckets") {
    h.LogBuckets(integer, number, [&](int64_t key, int64_t count) { entries.values.emplace_back(double(key), count); });
    return entries;
  }
  throw HistogramBindingError("ERR_INVALID_ARG_VALUE", "TypeError", "Unknown native histogram operation");
}
}  // namespace kandelo::histogram
#endif
