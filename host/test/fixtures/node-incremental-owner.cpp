// Actual portable OpenSSL state and pinned native encoding controls.
#include "../../../third_party/node-core/incremental-hash.h"
#include "kandelo-node-native-encoding.h"
#include <cstdio>

static kandelo::crypto::Bytes InputBytes(const char* text) {
  kandelo::crypto::Bytes bytes;
  bytes.value.assign(text, text + std::strlen(text)); return bytes;
}
static std::string Hex(const kandelo::crypto::Bytes& bytes) {
  static const char digits[] = "0123456789abcdef"; std::string value;
  for (auto byte : bytes.value) { value.push_back(digits[byte >> 4]); value.push_back(digits[byte & 15]); }
  return value;
}
static std::string Unhex(const char* text) {
  std::string out;
  for (size_t i = 0; text[i] && text[i + 1]; i += 2) {
    auto digit = [](char c) { return c >= '0' && c <= '9' ? c - '0' : c - 'a' + 10; };
    out.push_back(char(digit(text[i]) * 16 + digit(text[i + 1])));
  }
  return out;
}
int main(int argc, char** argv) {
  using namespace kandelo::crypto;
  if (argc > 1 && !std::strcmp(argv[1], "encoding")) {
    if (argc != 4) return 2;
    const auto text = Unhex(argv[2]);
    const auto mode = kandelo::encoding::ParseEncoding(text.c_str(), !std::strcmp(argv[3], "buffer") ? kandelo::encoding::BUFFER : kandelo::encoding::UTF8);
    std::printf("%s\n", kandelo::encoding::EncodingName(mode)); return 0;
  }
  try {
    const char* algorithm = argc > 1 ? argv[1] : "sha256";
    IncrementalHash hash(algorithm, {}); hash.Update(InputBytes("a"));
    IncrementalHash copy(hash, {}); hash.Update(InputBytes("bc")); copy.Update(InputBytes("bd"));
    const auto first = Hex(hash.Digest()), again = Hex(hash.Digest()), branch = Hex(copy.Digest());
    hash.Update(InputBytes("later")); const auto cached = Hex(hash.Digest());
    auto key = InputBytes("key"); IncrementalHmac hmac(algorithm, key); hmac.Update(InputBytes("a")); hmac.Update(InputBytes("bc"));
    const auto mac = Hex(hmac.Digest()), empty = Hex(hmac.Digest()); const bool after = hmac.Update(InputBytes("x"));
    IncrementalHash xof("shake128", 0); xof.Update(InputBytes("abc")); const auto zero = Hex(xof.Digest());
    IncrementalHash enlarged(xof, 40); const auto longer = Hex(enlarged.Digest());
    std::printf("{\"hash\":\"%s\",\"again\":\"%s\",\"branch\":\"%s\",\"cached\":\"%s\",\"hmac\":\"%s\",\"hmacAgain\":\"%s\",\"hmacUpdateAfterFinal\":%s,\"zero\":\"%s\",\"xofCopy\":\"%s\"}\n",first.c_str(),again.c_str(),branch.c_str(),cached.c_str(),mac.c_str(),empty.c_str(),after?"true":"false",zero.c_str(),longer.c_str());
  } catch (const Error& e) { std::fprintf(stderr,"%s [%s]\n",e.what(),e.code.c_str()); return 1; }
}
