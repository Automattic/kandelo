#include "kdf-operations.h"
#include <cstdio>
#include <string>
using namespace kandelo::crypto;
static void Text(const std::string& text) {
  putchar('"');
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') putchar('\\');
    if (c < 32) printf("\\u%04x", c); else putchar(c);
  }
  putchar('"');
}
static void Unhex(const char* value, Bytes* result) {
  auto digit = [](char c) { return c >= 'a' ? c - 'a' + 10 : c - '0'; };
  for (size_t i = 0; value[i] && value[i + 1]; i += 2) result->value.push_back(digit(value[i]) * 16 + digit(value[i + 1]));
}
static void ErrorRecord(const Error& error, const char* name) {
  printf("{\"message\":"); Text(error.what()); printf(",\"name\":"); Text(name);
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
int main(int argc, char** argv) {
  try {
    if (argc < 2) return 2;
    if (std::string(argv[1]) == "version") { Text(OpenSSL_version(OPENSSL_VERSION)); puts(""); return 0; }
    const bool pbkdf2 = std::string(argv[1]) == "pbkdf2";
    if (argc != (pbkdf2 ? 7 : 9)) return 2;
    KdfConfig config(pbkdf2 ? KdfConfig::Algorithm::Pbkdf2 : KdfConfig::Algorithm::Scrypt);
    Unhex(argv[2], &config.password); Unhex(argv[3], &config.salt);
    config.length = uint32_t(std::stoul(argv[4]));
    if (pbkdf2) { config.iterations = uint32_t(std::stoul(argv[5])); config.SetDigest(argv[6]); }
    else { config.N = uint32_t(std::stoul(argv[5])); config.r = uint32_t(std::stoul(argv[6]));
      config.p = uint32_t(std::stoul(argv[7])); config.maxmem = std::stoull(argv[8]); config.CheckScrypt(); }
    const KdfOperation& work = config;
    auto output = work.Derive();
    printf("{\"hex\":\""); for (auto c : output.value) printf("%02x", c); puts("\"}");
    return 0;
  } catch (const KdfError& error) {
    ErrorRecord(error, error.type == KdfError::Type::TypeError ? "TypeError" : error.type == KdfError::Type::RangeError ? "RangeError" : "Error");
  } catch (const Error& error) { ErrorRecord(error, "Error"); }
}
