// Requested storage owned outside codec-library custom allocators.
// Counts live object/container capacity, never logical payload bytes or RSS.
#ifndef KANDELO_NODE_CODEC_OWNED_CAPACITY_H
#define KANDELO_NODE_CODEC_OWNED_CAPACITY_H
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <limits>
#include <string>
#include <vector>

namespace kandelo::codecs::capacity {
inline size_t Add(size_t left, size_t right) noexcept {
  if (right > std::numeric_limits<size_t>::max() - left) std::abort();
  return left + right;
}
template <typename T, typename Allocator>
inline size_t VectorBytes(const std::vector<T, Allocator>& value) noexcept {
  if (value.capacity() > std::numeric_limits<size_t>::max() / sizeof(T)) std::abort();
  return value.capacity() * sizeof(T);
}
inline size_t StringBytes(const std::string& value) noexcept {
  // Current declared libc++ stores short-string data inside the object;
  // long-string allocation requests include its terminator. The native
  // component identifies its own standard-library artifact separately.
  const uintptr_t data = reinterpret_cast<uintptr_t>(value.data());
  const uintptr_t object = reinterpret_cast<uintptr_t>(&value);
  if (data >= object && data - object < sizeof(value)) return 0;
  return Add(value.capacity(), 1);
}
}  // namespace kandelo::codecs::capacity
#endif
