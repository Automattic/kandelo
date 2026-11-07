#include "histogram-owner-inl.h"
#include "histogram-owner.h"
#include "histogram-window.h"
#include "histogram-work.h"
#include <atomic>
#include <chrono>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

using namespace kandelo::histogram;
namespace {
uint64_t tick = 1;
uint64_t Clock() { return tick; }
void Number(double n) {
  if (std::isnan(n)) std::cout << "\"NaN\"";
  else if (std::isinf(n)) std::cout << (n < 0 ? "\"-Infinity\"" : "\"Infinity\"");
  else std::cout << std::setprecision(17) << n;
}
void Values(const std::string& name, std::initializer_list<double> values) {
  std::cout << name << '\t' << '[';
  bool comma = false;
  for (double n : values) { if (comma) std::cout << ','; comma = true; Number(n); }
  std::cout << "]\n";
}
void Integers(const std::string& name, std::initializer_list<int64_t> values) {
  std::cout << name << '\t' << '[';
  bool comma = false;
  for (int64_t n : values) { if (comma) std::cout << ','; comma = true; std::cout << '"' << n << '"'; }
  std::cout << "]\n";
}
std::string Hex(const std::vector<uint8_t>& bytes) {
  std::ostringstream out;
  for (uint8_t n : bytes) out << std::hex << std::setfill('0') << std::setw(2) << int(n);
  return out.str();
}
void Pairs(const std::string& name, auto each) {
  std::cout << name << '\t' << '[';
  bool comma = false;
  each([&](double key, double value) {
    if (comma) std::cout << ','; comma = true;
    std::cout << '['; Number(key); std::cout << ','; Number(value); std::cout << ']';
  });
  std::cout << "]\n";
}
void Summary(const std::string& name, const std::shared_ptr<Histogram>& h) {
  Values(name + ".numberIntegers", {double(h->Count()), double(h->Min()), double(h->Max()), double(h->Exceeds()), double(h->ResetCount())});
  Integers(name + ".counts", {static_cast<int64_t>(h->Count()), h->Min(), h->Max(),
      static_cast<int64_t>(h->Exceeds()), static_cast<int64_t>(h->ResetCount())});
  Values(name + ".stats", {h->Mean(), h->Stddev(), h->Skewness(), h->Kurtosis(),
      h->EwmaMean(), h->EwmaStddev(), h->EwmaErrorRate()});
  double ps[] = {1, 25, 50, 90, 99, 100};
  int64_t vs[6]; h->PercentilesAt(ps, vs, 6);
  Integers(name + ".percentilesAt", {vs[0], vs[1], vs[2], vs[3], vs[4], vs[5]});
  Integers(name + ".percentile", {h->Percentile(1), h->Percentile(25),
      h->Percentile(50), h->Percentile(90), h->Percentile(99), h->Percentile(100)});
  Values(name + ".cdf", {h->Cdf(-1), h->Cdf(0), h->Cdf(1), h->Cdf(100),
      h->Cdf(2048), h->Cdf(1000000)});
  Integers(name + ".countAt", {h->CountAt(-1), h->CountAt(0), h->CountAt(1),
      h->CountAt(100), h->CountAt(2048), h->CountAt(1000000)});
  auto ci = h->MeanCI();
  Values(name + ".meanCI", {ci.mean, ci.lower, ci.upper});
  auto pci = h->PercentileCI(50);
  Integers(name + ".percentileCI", {pci.value, pci.lower, pci.upper});
  Pairs(name + ".percentiles", [&](auto fn) { h->Percentiles(fn); });
  Pairs(name + ".linearBuckets", [&](auto fn) { h->LinearBuckets(25000, fn); });
  Pairs(name + ".logBuckets", [&](auto fn) { h->LogBuckets(1000, 2, fn); });
  std::cout << name << ".export\t\"" << Hex(h->Export()) << "\"\n";
  for (uint32_t mode = 0; mode < 3; ++mode) {
    HistogramQrdeWork work(h, {0, .1, .25, .5, .9, 1}, QrdeDequantization(mode), true);
    work.Run();
    const auto& r = work.result();
    Pairs(name + ".qrde" + std::to_string(mode), [&](auto fn) {
      for (size_t i = 0; i < r.quantiles.size(); ++i) fn(i, r.quantiles[i]);
      for (size_t i = 0; i < r.densities.size(); ++i) fn(i + 100, r.densities[i]);
      fn(200, r.corrections); fn(201, work.snapshot().total_count);
      fn(202, work.snapshot().buckets.size());
    });
  }
}
void Pair(const std::string& name, const std::shared_ptr<Histogram>& a,
          const std::shared_ptr<Histogram>& b) {
  auto w = a->WelchTest(*b); auto m = a->MannWhitneyTest(*b);
  Values(name, {a->KsTest(*b), a->CohensD(*b), a->CliffsD(*b), w.t_statistic,
      w.degrees_of_freedom, w.p_value, w.ci_lower, w.ci_upper,
      m.u_statistic, m.z_score, m.p_value});
}
void LayoutSummary(const std::string& name, const std::shared_ptr<Histogram>& h) {
  Values(name + ".numberIntegers", {double(h->Count()), double(h->Min()), double(h->Max()), double(h->Exceeds())});
  Integers(name + ".counts", {static_cast<int64_t>(h->Count()), h->Min(), h->Max(),
      static_cast<int64_t>(h->Exceeds())});
  Integers(name + ".percentile", {h->Percentile(1), h->Percentile(50),
      h->Percentile(99), h->Percentile(100)});
  Values(name + ".stats", {h->Mean(), h->Stddev()});
  std::cout << name << ".export\t\"" << Hex(h->Export()) << "\"\n";
}
Histogram::Options Options() { return {1, 1000000, 2, 4, 2048}; }
std::shared_ptr<Histogram> Make(std::initializer_list<int64_t> values) {
  auto h = Histogram::Create(Options(), Clock);
  HistogramInvariant(bool(h));
  for (auto n : values) h->Record(n);
  return h;
}
void LocalOwnershipControls() {
  std::cerr << "local: shared and independent lifetime\n";
  auto a = Make({1, 7, 10});
  std::weak_ptr<Histogram> weak = a;
  auto alias = a;
  a.reset(); HistogramInvariant(!weak.expired());
  alias->Record(13); HistogramInvariant(alias->Count() == 4);
  auto clone = alias->Clone(); alias.reset(); HistogramInvariant(weak.expired());
  HistogramInvariant(clone->Count() == 4);
  std::cerr << "local: queued work and cache generation\n";
  HistogramQrdeWork pending(clone, {0, .5, 1}, QrdeDequantization::kHdr, true);
  clone->Record(999); pending.Run();
  HistogramInvariant(pending.snapshot().total_count == 4);
  HistogramInvariant(!clone->GetRecordedSnapshotSource(true).cache_hit);
  HistogramQrdeWork cached(clone, {0, .5, 1}, QrdeDequantization::kHdr, true);
  cached.Run(); HistogramInvariant(clone->GetRecordedSnapshotSource(true).cache_hit);
  clone->Record(10000000);
  HistogramInvariant(clone->GetRecordedSnapshotSource(true).cache_hit);
  clone->Reset(); HistogramInvariant(!clone->GetRecordedSnapshotSource(true).cache_hit);
  std::cerr << "local: delta clock\n";
  tick = 100; HistogramInvariant(clone->RecordDelta() == 0);
  tick = 150; HistogramInvariant(clone->RecordDelta() == 50 && clone->Count() == 1);
  clone->Reset(); tick = 200;
  HistogramInvariant(clone->RecordDelta() == 0 && clone->Count() == 0);
  auto actual_clock = Histogram::Create({1, INT64_MAX, 3});
  HistogramInvariant(actual_clock->RecordDelta() == 0);
  std::this_thread::sleep_for(std::chrono::milliseconds(1));
  HistogramInvariant(actual_clock->RecordDelta() > 0 && actual_clock->Count() == 1);
  std::cerr << "local: time window\n";
  auto window = SlidingWindowHistogram::Create(Options(), 2, true, 10, Clock);
  window->RecordValue(7); tick = 210; window->RecordValue(13);
  HistogramInvariant(window->CreateSnapshot()->Count() == 2);
  tick = 220; HistogramInvariant(window->CreateSnapshot()->Count() == 1);
  tick = 240; HistogramInvariant(window->CreateSnapshot()->Count() == 0);
  window->ResetWindow(); window->RecordValue(9);
  HistogramInvariant(window->CreateSnapshot()->Count() == 1);
  std::cerr << "local: concurrent records\n";
  auto threaded = Make({});
  std::vector<std::thread> threads;
  for (int i = 0; i < 4; ++i) threads.emplace_back([threaded] {
    for (int j = 0; j < 1000; ++j) { threaded->Record(j); (void)threaded->Mean(); }
  });
  for (auto& thread : threads) thread.join();
  HistogramInvariant(threaded->Count() == 4000);
  std::cerr << "local: reciprocal add lock ordering\n";
  auto other = Make({1});
  std::thread one([&] { for (int i = 0; i < 4; ++i) threaded->Add(*other); });
  std::thread two([&] { for (int i = 0; i < 4; ++i) other->Add(*threaded); });
  one.join(); two.join();
  std::cerr << "local: uncached and cache-hit parent release\n";
  auto short_lived = Make({5}); std::weak_ptr<Histogram> work_weak = short_lived;
  HistogramQrdeWork independent(short_lived, {0, .5, 1}, QrdeDequantization::kHdr, false);
  short_lived.reset(); HistogramInvariant(work_weak.expired()); independent.Run();
  HistogramInvariant(independent.snapshot().total_count == 1);
  auto cache_owner = Make({1, 3});
  HistogramQrdeWork prepare(cache_owner, {0, .5, 1}, QrdeDequantization::kHdr, true);
  prepare.Run();
  std::weak_ptr<Histogram> cache_weak = cache_owner;
  HistogramQrdeWork cache_hit(cache_owner, {0, .5, 1}, QrdeDequantization::kHdr, true);
  HistogramInvariant(cache_hit.cache_hit()); cache_owner.reset();
  HistogramInvariant(cache_weak.expired()); cache_hit.Run();
  HistogramInvariant(cache_hit.snapshot().total_count == 2);
  std::cout << "local ownership, clock, cache, time-window and thread controls passed\n";
}
}  // namespace
int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "--local") { LocalOwnershipControls(); return 0; }
  if (argc == 3 && std::string(argv[1]) == "--import") {
    std::string hex(argv[2]); std::vector<uint8_t> bytes;
    for (size_t i = 0; i < hex.size(); i += 2) bytes.push_back(std::stoul(hex.substr(i, 2), nullptr, 16));
    auto h = Histogram::Import(bytes.data(), bytes.size());
    if (h) {
      Values("import.numberIntegers", {double(h->Count()), double(h->Min()), double(h->Max())});
      Integers("import.counts", {static_cast<int64_t>(h->Count()), h->Min(), h->Max()});
      std::cout << "import.export\t\"" << Hex(h->Export()) << "\"\n";
    } else std::cout << "invalid\ttrue\n";
    return 0;
  }
  auto empty = Make({}); Summary("empty", empty);
  auto one = Make({7}); Summary("one", one);
  Summary("constant", Make({7, 7, 7, 7}));
  auto a = Make({0, 1, 1, 7, 13, 63, 512, 1023, 1024, 2047, 2048, 4095, 8191, 99999});
  a->Record(10000000); Summary("a", a);
  auto b = Make({1, 2, 2, 8, 64, 513, 1025, 4096, 9999}); Summary("b", b);
  Pair("pair.ab", a, b); Pair("pair.self", a, a); Pair("pair.empty", a, empty);
  auto snap = a->Clone(); a->Record(42); a->Record(10000000);
  Summary("snapshot", snap);
  Histogram::DiffError error;
  auto diff = a->Diff(*snap, &error); HistogramInvariant(error == Histogram::DiffError::kNone);
  Summary("diff", diff);
  HistogramInvariant(!snap->Diff(*a, &error) && error == Histogram::DiffError::kNotEarlier);
  a->Reset(); HistogramInvariant(!a->Diff(*snap, &error) && error == Histogram::DiffError::kReset);
  auto incompatible = Histogram::Create({1, 10000, 3});
  HistogramInvariant(!a->Diff(*incompatible, &error) && error == Histogram::DiffError::kIncompatible);
  std::cout << "diff.errors\t[\"not-earlier\",\"reset\",\"incompatible\"]\n";
  auto corrected = Make({}); corrected->RecordCorrected(1000, 100);
  corrected->RecordCorrected(10000000, 100); Summary("corrected", corrected);
  auto add = snap->Clone(); Values("add.dropped", {add->Add(*b)}); Summary("add", add);
  Values("add.self.dropped", {add->Add(*add)}); Summary("add.self", add);
  Values("subtract.dropped", {add->Subtract(*b)}); Summary("subtract", add);
  Values("subtract.self.dropped", {add->Subtract(*add)}); Summary("subtract.self", add);
  Values("subtract.negative.dropped", {add->Subtract(*b)}); Summary("subtract.negative", add);
  auto bytes = snap->Export(); Summary("roundtrip", Histogram::Import(bytes.data(), bytes.size()));
  auto empty_bytes = empty->Export();
  auto empty_roundtrip = Histogram::Import(empty_bytes.data(), empty_bytes.size());
  empty_roundtrip->Record(100); Summary("empty-roundtrip-first-record", empty_roundtrip);
  auto w = SlidingWindowHistogram::Create(Options(), 2, false, 3, Clock);
  w->RecordValue(1); w->RecordValue(2); w->RecordValue(10000000);
  Summary("window.first", w->CreateSnapshot());
  w->RecordValue(4); w->RecordValue(5); w->RecordValue(6);
  auto ws = w->CreateSnapshot(); Summary("window.full", ws);
  w->RecordValue(7); Summary("window.rotated", w->CreateSnapshot());
  w->ResetWindow(); Summary("window.reset", w->CreateSnapshot());
  Summary("window.independent", ws);
  auto shared = Make({3}); auto shared_clone = shared;
  shared_clone->Record(5); Summary("shared-clone", shared);
  auto high = Histogram::Create({1000, INT64_MAX, 3});
  for (int64_t v : {INT64_C(0), INT64_C(1), INT64_C(999), INT64_C(1000),
      INT64_C(1001), INT64_C(1048576), INT64_C(9007199254740991),
      INT64_C(9007199254740992), INT64_MAX}) high->Record(v);
  LayoutSummary("layout.int64", high);
  for (int figures = 1; figures <= 5; ++figures) {
    auto h = Histogram::Create({8, 10000000, figures});
    for (int64_t v : {0, 1, 1234, 65537, 9999999, 10000000}) h->Record(v);
    LayoutSummary("layout.figures" + std::to_string(figures), h);
  }
  auto narrow = Histogram::Create({1, 10000, 1});
  Values("narrow.add.dropped", {narrow->Add(*snap)}); LayoutSummary("narrow.add", narrow);
  auto upper = Histogram::Create({1, 1000000, 2});
  std::cout << "layout.upper.accepted\t[";
  bool comma = false;
  for (int64_t v : {1000000, 1000001, 1048575, 1048576}) {
    if (comma) std::cout << ','; comma = true; std::cout << int(upper->Record(v));
  }
  std::cout << "]\n"; LayoutSummary("layout.upper", upper);
  auto dense = Histogram::Create({1, 10000000, 3});
  for (int i = 1; i <= 2048; ++i)
    for (int repeat = 0; repeat < 64; ++repeat) dense->Record(i * 4093);
  Summary("dense", dense);
}
