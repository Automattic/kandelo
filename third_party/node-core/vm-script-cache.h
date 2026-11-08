#ifndef KANDELO_NODE_VM_SCRIPT_CACHE_H
#define KANDELO_NODE_VM_SCRIPT_CACHE_H
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string_view>
#include <vector>

namespace kandelo::vm {
// The payload is genuine SpiderMonkey XDR, not V8 cachedData. Its own build-ID
// check includes the actual resolver recipe key and target pointer/endian state.
// Keep source and debug metadata admission exact until the engine has a real
// metadata-rebind owner. Node can admit changed filename/offsets; rejecting
// those here is an explicit implementation gap, never accepted compatibility.
inline bool CacheIdentity(std::span<const char16_t> source,
                          std::string_view filename, uint32_t lineOffset,
                          uint32_t columnOffset, size_t alignment,
                          std::vector<uint8_t>* out) {
  if (source.size() > UINT32_MAX || filename.size() > UINT32_MAX ||
      !alignment || (alignment & (alignment - 1))) return false;
  out->clear();
  const uint8_t magic[] = {'K', 'N', 'D', 'L', 'V', 'M', 1, 0};
  out->insert(out->end(), std::begin(magic), std::end(magic));
  auto word = [&](uint32_t value) {
    for (unsigned i = 0; i < 4; i++) out->push_back(uint8_t(value >> (8 * i)));
  };
  word(uint32_t(source.size()));word(uint32_t(filename.size()));
  word(lineOffset);word(columnOffset);
  for (char16_t unit : source) {
    out->push_back(uint8_t(unit));out->push_back(uint8_t(unit >> 8));
  }
  out->insert(out->end(), filename.begin(), filename.end());
  while (out->size() % alignment) out->push_back(0);
  return true;
}
inline bool CachePayload(std::span<const uint8_t> bytes,
                          std::span<const uint8_t> identity,
                          size_t* offset) {
  if (bytes.size() <= identity.size() ||
      !std::equal(identity.begin(), identity.end(), bytes.begin())) return false;
  *offset = identity.size();return true;
}
}  // namespace kandelo::vm
#endif
