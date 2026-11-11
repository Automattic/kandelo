#include <nbytes.h>
#include <simdutf.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace {
unsigned cases = 0, failures = 0;
void Check(const char* name, bool result) {
  ++cases;
  if (!result) ++failures;
  std::printf("{\"case\":\"%s\",\"status\":\"%s\"}\n", name,
              result ? "pass" : "fail");
}
}  // namespace

int main() {
  const char ascii[] = {0, 0x41, 0x7f};
  const char high[] = {static_cast<char>(0x80)};
  Check("ascii-validation", simdutf::validate_ascii(ascii, sizeof(ascii)) &&
                               !simdutf::validate_ascii(high, sizeof(high)));

  const char utf8[] = "A\xc3\xa9\xf0\x9f\x98\x80";
  char16_t wide[16] = {};
  const auto converted = simdutf::convert_utf8_to_utf16_with_errors(
      utf8, sizeof(utf8) - 1, wide);
  Check("utf8-to-utf16", converted.error == simdutf::error_code::SUCCESS &&
                             converted.count == 4 && wide[0] == u'A' &&
                             wide[1] == 0xe9 && wide[2] == 0xd83d &&
                             wide[3] == 0xde00);
  const char invalid[] = "\xed\xa0\x80";
  Check("invalid-utf8-rejected", !simdutf::validate_utf8(invalid, 3));

  const char16_t surrogate[] = {0xd800, u'A'};
  const char16_t pair[] = {0xd83d, 0xde00};
  Check("utf16-surrogate-validation", !simdutf::validate_utf16(surrogate, 2) &&
                                          simdutf::validate_utf16(pair, 2));
  simdutf::to_well_formed_utf16(surrogate, 2, wide);
  Check("utf16-surrogate-replacement", wide[0] == 0xfffd && wide[1] == u'A');

  const char latin1[] = {static_cast<char>(0xe9), static_cast<char>(0xff)};
  char bytes[64] = {};
  size_t length = simdutf::convert_latin1_to_utf8_safe(latin1, 2, bytes, sizeof(bytes));
  Check("latin1-to-utf8", length == 4 && std::memcmp(bytes, "\xc3\xa9\xc3\xbf", 4) == 0);
  const auto latin = simdutf::convert_utf8_to_latin1_with_errors(bytes, length, bytes + 16);
  Check("utf8-to-latin1", latin.error == simdutf::error_code::SUCCESS &&
                              latin.count == 2 && std::memcmp(bytes + 16, latin1, 2) == 0);

  const char binary[] = {1, 2, 3, 4};
  length = simdutf::binary_to_base64(binary, 4, bytes);
  Check("base64-encode", length == 8 && std::memcmp(bytes, "AQIDBA==", 8) == 0);
  const char urlBinary[] = {static_cast<char>(0xfb), static_cast<char>(0xff),
                            static_cast<char>(0xff), static_cast<char>(0xfe)};
  length = simdutf::binary_to_base64(urlBinary, 4, bytes, simdutf::base64_url);
  Check("base64url-encode", length == 6 && std::memcmp(bytes, "-____g", 6) == 0);

  length = sizeof(bytes);
  const auto decoded = simdutf::base64_to_binary_safe("AQIDBA==", 8, bytes, length);
  Check("base64-decode", decoded.error == simdutf::error_code::SUCCESS &&
                             length == 4 && std::memcmp(bytes, binary, 4) == 0);
  std::array<char, 8> guarded;
  guarded.fill(0x5a);
  length = 2;
  const auto bounded = simdutf::base64_to_binary_safe("AQIDBA==", 8, guarded.data() + 2, length);
  Check("base64-bounded-output", bounded.error == simdutf::error_code::OUTPUT_BUFFER_TOO_SMALL &&
                                    guarded[0] == 0x5a && guarded[1] == 0x5a &&
                                    std::all_of(guarded.begin() + 4, guarded.end(),
                                                [](char value) { return value == 0x5a; }));

  char swapped[] = {1, 2, 3, 4};
  const bool swappedOk = nbytes::SwapBytes16(swapped, sizeof(swapped));
  Check("byte-swap-and-odd-length", swappedOk && swapped[0] == 2 && swapped[1] == 1 &&
                                         swapped[2] == 4 && swapped[3] == 3 &&
                                         !nbytes::SwapBytes16(swapped, 3));
  length = nbytes::HexEncode(binary, 4, bytes, sizeof(bytes));
  Check("hex-encode", length == 8 && std::memcmp(bytes, "01020304", 8) == 0);
  length = nbytes::HexDecode(bytes, sizeof(bytes), "4142zz", 6);
  Check("hex-decode-stops-at-invalid", length == 2 && bytes[0] == 'A' && bytes[1] == 'B');
  length = nbytes::Base64Decode(bytes, sizeof(bytes), "AQ!IDBA==", 9);
  Check("node-base64-permissive-fallback", length == 4 && std::memcmp(bytes, binary, 4) == 0);
  char storage[32];
  char* aligned = nbytes::AlignUp(storage + 1, uintptr_t(8));
  Check("byte-alignment", reinterpret_cast<uintptr_t>(aligned) % 8 == 0 &&
                              aligned >= storage + 1 && aligned < storage + 9);
  const simdutf::implementation* implementation = simdutf::get_active_implementation();
  Check("actual-runtime-implementation", implementation != nullptr &&
                                            implementation->supported_by_runtime_system());

  std::printf("{\"kind\":\"native-codec-controls\",\"cases\":%u,\"failures\":%u}\n", cases, failures);
  return failures ? 1 : 0;
}
