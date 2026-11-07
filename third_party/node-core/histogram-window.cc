// Generated from the pinned Node.js 26.13.0 histogram owner.
// See histogram-source-identities.json, histogram-owner.md and LICENSE.
// Regenerate with generate-histogram-owner.py; do not edit here.
#include "histogram-window.h"
#include <algorithm>
#include "histogram-owner-inl.h"
namespace kandelo::histogram {
uint64_t SlidingWindowHistogram::CurrentTimeGeneration() const {
  const uint64_t now = clock_();
  HistogramInvariant((now) >= (origin_));
  return (now - origin_) / rotate_at_;
}

Histogram* SlidingWindowHistogram::GetChunk(uint64_t generation) {
  const size_t index = generation % chunks_.size();
  if (generations_[index] == generation) {
    HistogramInvariant(static_cast<bool>(chunks_[index]));
    return chunks_[index].get();
  }

  if (chunks_[index]) {
    chunks_[index]->Reset();
  } else if (spare_) {
    chunks_[index] = std::move(spare_);
  } else {
    chunks_[index] = Histogram::Create(options_, clock_);
    if (!chunks_[index]) return nullptr;
    const size_t size = chunks_[index]->GetMemorySize();
    external_memory_ += size;
  }

  generations_[index] = generation;
  return chunks_[index].get();
}

bool SlidingWindowHistogram::RecordValue(int64_t value) {
  uint64_t generation;
  if (time_based_) {
    generation = CurrentTimeGeneration();
  } else if (records_in_current_chunk_ == rotate_at_) {
    HistogramInvariant((current_generation_) < (kNoGeneration - 1));
    generation = current_generation_ + 1;
  } else {
    generation = current_generation_;
  }

  Histogram* chunk = GetChunk(generation);
  if (chunk == nullptr) return false;

  chunk->Record(value);
  if (!time_based_) {
    if (generation != current_generation_) {
      current_generation_ = generation;
      records_in_current_chunk_ = 0;
    }
    records_in_current_chunk_++;
    has_count_records_ = true;
  }
  return true;
}

std::shared_ptr<Histogram> SlidingWindowHistogram::CreateSnapshot() const {
  std::shared_ptr<Histogram> snapshot = Histogram::Create(options_, clock_);
  if (!snapshot) return {};

  uint64_t current_generation;
  if (time_based_) {
    current_generation = CurrentTimeGeneration();
  } else {
    if (!has_count_records_) return snapshot;
    current_generation = current_generation_;
  }

  for (size_t i = 0; i < chunks_.size(); i++) {
    const uint64_t generation = generations_[i];
    if (generation == kNoGeneration || generation > current_generation ||
        current_generation - generation >= chunks_.size()) {
      continue;
    }
    HistogramInvariant(static_cast<bool>(chunks_[i]));
    HistogramInvariant((snapshot->Add(*chunks_[i])) == (0));
  }
  return snapshot;
}

void SlidingWindowHistogram::ResetWindow() {
  std::fill(generations_.begin(), generations_.end(), kNoGeneration);
  origin_ = clock_();
  current_generation_ = 0;
  records_in_current_chunk_ = 0;
  has_count_records_ = false;
}

}  // namespace kandelo::histogram
