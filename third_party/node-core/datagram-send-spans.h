#ifndef KANDELO_NODE_DATAGRAM_SEND_SPANS_H
#define KANDELO_NODE_DATAGRAM_SEND_SPANS_H
#include "kandelo-node-backing-capabilities.h"
#include <cstddef>
#include <cstdint>
#include <new>
#include <limits>
#include <stdexcept>
#include <sys/uio.h>
#include <utility>
#include <vector>
namespace kandelo::udp {
// Actual initial spans: storage metadata is copied, message bytes are not.
// No JS roots/context or foreign-thread JSAPI belong to this native owner.
struct SendSpans {
  JS::KandeloBacking::MetadataRef storage;
  std::vector<iovec> entries;
  std::vector<JS::KandeloBacking::SpanRef> backings;
  size_t bytes = 0;
  using Track = JS::KandeloBacking::MetadataRef (*)(size_t, const JS::KandeloBacking::AccountRef&);
  SendSpans(size_t count, const JS::KandeloBacking::AccountRef& account, Track track)
      : entries(count), backings(count) {
    if (entries.capacity() > SIZE_MAX / sizeof(iovec) ||
        backings.capacity() > (SIZE_MAX - entries.capacity() * sizeof(iovec)) / sizeof(backings[0]))
      throw std::bad_alloc();
    const size_t capacity = entries.capacity() * sizeof(iovec) + backings.capacity() * sizeof(backings[0]);
    if (capacity) {
      if (!track) throw std::runtime_error("UDP span metadata provider unavailable");
      storage = track(capacity, account);
      if (!storage) throw std::runtime_error("UDP span storage ownership unavailable");
    }
  }
  SendSpans(const SendSpans&) = delete;
  SendSpans& operator=(const SendSpans&) = delete;
  SendSpans(SendSpans&&) = default;
  SendSpans& operator=(SendSpans&&) = delete;
  void Capture(size_t index, JS::KandeloBacking::SpanRef span) {
    if (!span || index >= entries.size() || backings[index]) throw std::invalid_argument("Invalid UDP span owner");
    if (span->Length() > SIZE_MAX - bytes) throw std::length_error("UDP aggregate span length overflow");
    bytes += span->Length();
    entries[index] = {span->Data(), span->Length()};
    backings[index] = std::move(span);
  }
};
}
#endif
