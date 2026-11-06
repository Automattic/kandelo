#ifndef KANDELO_NODE_STRING_BYTES_H
#define KANDELO_NODE_STRING_BYTES_H
// Private, allocation-free string-to-byte primitives. Node26.13.0 nbytes
// selections below remain unchanged; full references live in upstream/keys.
// The embedding/crypto owner supplies rooted characters and native storage.
#include <cstddef>
#include <cstdint>
#include <limits>
#include "kandelo-node-native-encoding.h"
namespace kandelo::encoding::bytes {
// BEGIN_PINNED_NBYTES_TABLE
const int8_t unbase64_table[256] = {
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -2, -1, -1, -2, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -2, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, 62, -1, 62, -1, 63, 52, 53, 54, 55, 56, 57, 58, 59, 60,
    61, -1, -1, -1, -1, -1, -1, -1, 0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10,
    11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, -1, -1, -1, -1,
    63, -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42,
    43, 44, 45, 46, 47, 48, 49, 50, 51, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1};
// END_PINNED_NBYTES_TABLE
// BEGIN_PINNED_NBYTES_GROUP
template <typename TypeName>
bool Base64DecodeGroupSlow(char *const dst, const size_t dstlen,
                           const TypeName *const src, const size_t srclen,
                           size_t *const i, size_t *const k) {
  uint8_t hi;
  uint8_t lo;
#define V(expr)                                                        \
  for (;;) {                                                           \
    const uint8_t c = static_cast<uint8_t>(src[*i]);                   \
    lo = unbase64_table[c];                                            \
    *i += 1;                                                           \
    if (lo < 64) break;                         /* Legal character. */ \
    if (c == '=' || *i >= srclen) return false; /* Stop decoding. */   \
  }                                                                    \
  expr;                                                                \
  if (*i >= srclen) return false;                                      \
  if (*k >= dstlen) return false;                                      \
  hi = lo;
  V(/* Nothing. */);
  V(dst[(*k)++] = ((hi & 0x3F) << 2) | ((lo & 0x30) >> 4));
  V(dst[(*k)++] = ((hi & 0x0F) << 4) | ((lo & 0x3C) >> 2));
  V(dst[(*k)++] = ((hi & 0x03) << 6) | ((lo & 0x3F) >> 0));
#undef V
  return true;  // Continue decoding.
}

// END_PINNED_NBYTES_GROUP
// BEGIN_PINNED_NBYTES_DECODER
// Doesn't check for padding at the end.  Can be 1-2 bytes over.
inline constexpr size_t Base64DecodedSizeFast(size_t size) {
  // 1-byte input cannot be decoded
  return size > 1 ? (size / 4) * 3 + (size % 4 + 1) / 2 : 0;
}

inline uint32_t ReadUint32BE(const unsigned char *p) {
  return static_cast<uint32_t>(p[0] << 24U) |
         static_cast<uint32_t>(p[1] << 16U) |
         static_cast<uint32_t>(p[2] << 8U) | static_cast<uint32_t>(p[3]);
}

template <typename TypeName>
size_t Base64DecodedSize(const TypeName *src, size_t size) {
  // 1-byte input cannot be decoded
  if (size < 2) return 0;

  if (src[size - 1] == '=') {
    size--;
    if (src[size - 1] == '=') size--;
  }
  return Base64DecodedSizeFast(size);
}

template <typename TypeName>
size_t Base64DecodeFast(char *const dst, const size_t dstlen,
                        const TypeName *const src, const size_t srclen,
                        const size_t decoded_size) {
  const size_t available = dstlen < decoded_size ? dstlen : decoded_size;
  const size_t max_k = available / 3 * 3;
  size_t max_i = srclen / 4 * 4;
  size_t i = 0;
  size_t k = 0;
  while (i < max_i && k < max_k) {
    const unsigned char txt[] = {
        static_cast<unsigned char>(
            unbase64_table[static_cast<uint8_t>(src[i + 0])]),
        static_cast<unsigned char>(
            unbase64_table[static_cast<uint8_t>(src[i + 1])]),
        static_cast<unsigned char>(
            unbase64_table[static_cast<uint8_t>(src[i + 2])]),
        static_cast<unsigned char>(
            unbase64_table[static_cast<uint8_t>(src[i + 3])]),
    };

    const uint32_t v = ReadUint32BE(txt);
    // If MSB is set, input contains whitespace or is not valid base64.
    if (v & 0x80808080) {
      if (!Base64DecodeGroupSlow(dst, dstlen, src, srclen, &i, &k)) return k;
      max_i = i + (srclen - i) / 4 * 4;  // Align max_i again.
    } else {
      dst[k + 0] = ((v >> 22) & 0xFC) | ((v >> 20) & 0x03);
      dst[k + 1] = ((v >> 12) & 0xF0) | ((v >> 10) & 0x0F);
      dst[k + 2] = ((v >> 2) & 0xC0) | ((v >> 0) & 0x3F);
      i += 4;
      k += 3;
    }
  }
  if (i < srclen && k < dstlen) {
    Base64DecodeGroupSlow(dst, dstlen, src, srclen, &i, &k);
  }
  return k;
}

template <typename TypeName>
size_t Base64Decode(char *const dst, const size_t dstlen,
                    const TypeName *const src, const size_t srclen) {
  const size_t decoded_size = Base64DecodedSize(src, srclen);
  return Base64DecodeFast(dst, dstlen, src, srclen, decoded_size);
}

// END_PINNED_NBYTES_DECODER
// BEGIN_PINNED_NBYTES_HEX_TABLE
const int8_t unhex_table[256] = {
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0,  1,  2,  3,  4,  5,  6,  7,  8,
    9,  -1, -1, -1, -1, -1, -1, -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, 10, 11, 12, 13, 14, 15, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
    -1, -1, -1, -1, -1, -1, -1, -1, -1};
// END_PINNED_NBYTES_HEX_TABLE
// BEGIN_PINNED_NBYTES_HEX_DECODER
template <typename TypeName>
static size_t HexDecode(char *buf, size_t len, const TypeName *src,
                        const size_t srcLen) {
  size_t i;
  for (i = 0; i < len && i * 2 + 1 < srcLen; ++i) {
    unsigned a = unhex_table[static_cast<uint8_t>(src[i * 2 + 0])];
    unsigned b = unhex_table[static_cast<uint8_t>(src[i * 2 + 1])];
    if (!~a || !~b) return i;
    buf[i] = (a << 4) | b;
  }

  return i;
}


// END_PINNED_NBYTES_HEX_DECODER
// UTF8/BUFFER uses the existing engine UTF8 owner. These modes write
// code units/encoded bytes without allocation, callbacks or public Buffer.
inline bool Capacity(size_t length, encoding mode, size_t* capacity) {
  switch (mode) {
    case ASCII: case BINARY: *capacity = length; return true;
    case UCS2:
      if (length > std::numeric_limits<size_t>::max() / 2) return false;
      *capacity = length * 2; return true;
    case HEX: *capacity = length / 2; return true;
    case BASE64: case BASE64URL: *capacity = Base64DecodedSizeFast(length); return true;
    default: return false;
  }
}
template <typename Char>
inline size_t Write(unsigned char* output, size_t capacity, const Char* input,
                    size_t length, encoding mode) {
  switch (mode) {
    case ASCII: case BINARY: {
      const size_t count = capacity < length ? capacity : length;
      for (size_t i = 0; i < count; i++) output[i] = static_cast<uint8_t>(input[i]);
      return count;
    }
    case UCS2: {
      const size_t count = capacity / 2 < length ? capacity / 2 : length;
      for (size_t i = 0; i < count; i++) {
        const uint16_t unit = static_cast<uint16_t>(input[i]);
        output[i * 2] = unit & 255; output[i * 2 + 1] = unit >> 8;
      }
      return count * 2;
    }
    case HEX: return HexDecode(reinterpret_cast<char*>(output), capacity, input, length);
    case BASE64: case BASE64URL:
      return Base64Decode(reinterpret_cast<char*>(output), capacity, input, length);
    default: return std::numeric_limits<size_t>::max();
  }
}
}  // namespace kandelo::encoding::bytes
#endif
