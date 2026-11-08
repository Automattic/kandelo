// Shared actual original-allocation/progress owner for native stream writes.
#ifndef KANDELO_NODE_STREAM_WRITE_MATERIAL_H_
#define KANDELO_NODE_STREAM_WRITE_MATERIAL_H_
#include "native-retained-memory.h"
#include <cassert>
#include <cstdint>
#include <stdexcept>
#include <utility>
#include <vector>
#include <sys/uio.h>
namespace kandelo::stream {
// Each immutable span owns the actual allocation. The syscall vectors are
// mutable progress over those original addresses, never copies of payloads.
// The portable owner accepts either real engine or retained-store capabilities.
template<class SpanRef>
struct Write {
  const std::vector<SpanRef> backing;
  std::vector<iovec> vectors;
  const uint64_t totalBytes;
  uint64_t offset = 0;
  size_t vectorIndex = 0;
  int error = 0;
  bool complete = false;
  memory::Allocation allocation{sizeof(Write)};
  static uint64_t Count(const std::vector<SpanRef>& spans) {
    uint64_t total = 0;
    for (const auto& span : spans) {
      if (!span) throw std::invalid_argument("TCP write has no original backing");
      if (span->Length() > UINT64_MAX - total) throw std::length_error("TCP write byte count overflow");
      total += span->Length();
    }
    return total;
  }
  explicit Write(SpanRef span) : Write(std::vector<SpanRef>{std::move(span)}) {}
  explicit Write(std::vector<SpanRef> spans)
      : backing(std::move(spans)), totalBytes(Count(backing)) {
    vectors.reserve(backing.size());
    for (const auto& span : backing) vectors.push_back({span->Data(), span->Length()});
    allocation.Resize(sizeof(Write) + backing.capacity() * sizeof(SpanRef) +
                      vectors.capacity() * sizeof(iovec));
  }
  Write(const Write&) = delete;
  Write& operator=(const Write&) = delete;
  uint64_t Remaining() const noexcept { return totalBytes - offset; }
  void Consume(size_t count) noexcept {
    assert(count <= Remaining()); offset += count;
    while (vectorIndex < vectors.size()) {
      auto& vector = vectors[vectorIndex];
      if (vector.iov_len > count) {
        if (count) vector.iov_base = static_cast<uint8_t*>(vector.iov_base) + count;
        vector.iov_len -= count; break;
      }
      count -= vector.iov_len; vector.iov_len = 0; ++vectorIndex;
    }
    if (!Remaining()) complete = true;
  }
};

}  // namespace kandelo::stream
#endif
