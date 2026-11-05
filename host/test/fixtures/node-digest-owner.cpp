#include "digest-operations.h"
#include <cstdio>
#include <iostream>
#include <iterator>
using namespace kandelo::crypto;
static void Text(const std::string& text) {
  putchar('"');
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') putchar('\\');
    if (c < 32) printf("\\u%04x", c); else putchar(c);
  }
  putchar('"');
}
static Bytes Unhex(const char* value) {
  Bytes bytes;
  auto digit = [](char c) { return c >= 'a' ? c - 'a' + 10 : c - '0'; };
  for (size_t i = 0; value[i] && value[i + 1]; i += 2)
    bytes.value.push_back(digit(value[i]) * 16 + digit(value[i + 1]));
  return bytes;
}
int main(int argc, char** argv) {
  try {
    if (argc > 1 && std::string(argv[1]) == "names") {
      auto names = DigestNames(); putchar('[');
      for (size_t i = 0; i < names.size(); i++) { if (i) putchar(','); Text(names[i]); }
      puts("]"); return 0;
    }
    if (argc > 1 && std::string(argv[1]) == "version") { Text(OpenSSL_version(OPENSSL_VERSION)); puts(""); return 0; }
    if (argc > 1 && std::string(argv[1]) == "equal") {
      auto a = Unhex(argv[2]), b = Unhex(argv[3]); puts(Equal(a, b) ? "true" : "false"); return 0;
    }
    Bytes input; input.value.assign(std::istreambuf_iterator<char>(std::cin), {});
    std::optional<uint32_t> length;
    if (std::string(argv[2]) != "-") length = uint32_t(std::stoull(argv[2]));
    auto bytes = Digest(argv[1], input, length, argc > 3 && std::string(argv[3]) == "1");
    printf("{\"hex\":\""); for (unsigned char c : bytes.value) printf("%02x", c); puts("\"}");
  } catch (const Error& error) {
    printf("{\"message\":"); Text(error.what());
    if (!error.code.empty()) { printf(",\"code\":"); Text(error.code); }
    if (!error.library.empty()) { printf(",\"library\":"); Text(error.library); }
    if (!error.reason.empty()) { printf(",\"reason\":"); Text(error.reason); }
    if (!error.stack.empty()) {
      printf(",\"opensslErrorStack\":[");
      for (size_t i = 0; i < error.stack.size(); i++) { if (i) putchar(','); Text(error.stack[i]); }
      putchar(']');
    }
    puts("}");
  }
}
