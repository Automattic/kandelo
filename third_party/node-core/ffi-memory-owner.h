// Portable arithmetic/conversion and actual unaligned native-byte consumers.
// Raw pointers have caller-owned validity/lifetime; no tracked-buffer whitelist.
#ifndef KANDELO_NODE_FFI_MEMORY_OWNER_H_
#define KANDELO_NODE_FFI_MEMORY_OWNER_H_
#include "ffi-library-owner.h"
#include <cmath>
#include <cstring>
#include <limits>
#include <type_traits>
namespace kandelo::ffi {
inline constexpr double MaxSafeInteger = 9007199254740991.0;
template<class Size = size_t>
Size MemorySize(double value, const char* label) {
  if (!std::isfinite(value) || value < 0 || std::floor(value) != value)
    throw Error("ERR_INVALID_ARG_VALUE", std::string("The ") + label + " must be a non-negative integer");
  if (value > MaxSafeInteger || value > static_cast<double>(std::numeric_limits<Size>::max()))
    throw Error("ERR_OUT_OF_RANGE", std::string("The ") + label + " is too large");
  return static_cast<Size>(value);
}
template<class Address = uintptr_t>
void MemorySpan(Address pointer, size_t offset, size_t length, const char* message) {
  if (offset > std::numeric_limits<Address>::max() - pointer)
    throw Error("ERR_INVALID_ARG_VALUE", message);
  Address start = pointer + offset;
  if (length && length - 1 > std::numeric_limits<Address>::max() - start)
    throw Error("ERR_INVALID_ARG_VALUE", message);
}
inline int64_t MemorySigned(double value, int64_t minimum, int64_t maximum, const char* name) {
  if (!std::isfinite(value) || std::floor(value) != value || value < minimum || value > maximum)
    throw Error("ERR_INVALID_ARG_VALUE", std::string("Value must be an ") + name);
  return static_cast<int64_t>(value);
}
inline uint64_t MemoryUnsigned(double value, uint64_t maximum, const char* name) {
  if (!std::isfinite(value) || std::floor(value) != value || value < 0 || value > static_cast<double>(maximum))
    throw Error("ERR_INVALID_ARG_VALUE", std::string("Value must be a ") + name);
  return static_cast<uint64_t>(value);
}
template<class T>
T MemoryLoad(uintptr_t pointer, size_t offset) {
  MemorySpan(pointer, offset, sizeof(T), "The accessed range exceeds the platform address range");
  T value;
  std::memcpy(&value, reinterpret_cast<const uint8_t*>(pointer) + offset, sizeof(T));
  return value;
}
template<class T>
void MemoryStore(uintptr_t pointer, size_t offset, T value) {
  MemorySpan(pointer, offset, sizeof(T), "The accessed range exceeds the platform address range");
  std::memcpy(reinterpret_cast<uint8_t*>(pointer) + offset, &value, sizeof(T));
}
}  // namespace kandelo::ffi
#endif
