#ifndef KANDELO_NODE_CODEC_PLEDGE_H
#define KANDELO_NODE_CODEC_PLEDGE_H
#include <cmath>
#include <cstdint>
#include <optional>
namespace kandelo::codecs {
struct PledgedSizeError {
  enum class Kind { TypeError, RangeError };
  Kind kind;
  const char* code;
  const char* message;
};
// Pinned node_zlib.cc Zstd::Init and util-inl.h IsSafeJsInt policy.
// Absence (undefined) is handled by the owning Init caller as UNKNOWN.
// The optional here describes actual engine primitive-number admission;
// do not perform JavaScript ToNumber or truncate fractional sizes.
inline std::optional<PledgedSizeError> CheckPledgedSize(std::optional<double> input,
                                                       uint64_t* output) {
  using Kind = PledgedSizeError::Kind;
  if (!input) return PledgedSizeError{Kind::TypeError, "ERR_INVALID_ARG_TYPE", "pledgedSrcSize must be a number"};
  const double value = *input;
  if (!std::isfinite(value) || std::trunc(value) != value || std::abs(value) > 9007199254740991.0)
    return PledgedSizeError{Kind::RangeError, "ERR_OUT_OF_RANGE", "pledgedSrcSize must be a safe integer"};
  if (value < 0) return PledgedSizeError{Kind::RangeError, "ERR_OUT_OF_RANGE", "pledgedSrcSize must be non-negative"};
  *output = static_cast<uint64_t>(value);
  return std::nullopt;
}
}  // namespace kandelo::codecs
#endif
