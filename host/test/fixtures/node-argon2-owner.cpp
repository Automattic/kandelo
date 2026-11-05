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
    if (argc != 11) return 2;
    KdfConfig config(KdfConfig::Algorithm::Argon2);
    config.type = uint32_t(std::stoul(argv[1]));
    Unhex(argv[2], &config.password); Unhex(argv[3], &config.salt);
    Unhex(argv[4], &config.secret); Unhex(argv[5], &config.associatedData);
    config.lanes = uint32_t(std::stoul(argv[6])); config.length = uint32_t(std::stoul(argv[7]));
    config.memory = uint32_t(std::stoul(argv[8])); config.passes = uint32_t(std::stoul(argv[9]));
    if (!Argon2Supported()) return 3;
    if (std::string(argv[10]) == "fips") EVP_default_properties_enable_fips(nullptr, 1);
    auto output = DeriveKdf(config);
    printf("{\"hex\":\""); for (auto c : output.value) printf("%02x", c); puts("\"}");
  } catch (const KdfError& error) {
    ErrorRecord(error, error.type == KdfError::Type::TypeError ? "TypeError" : error.type == KdfError::Type::RangeError ? "RangeError" : "Error");
  } catch (const Error& error) { ErrorRecord(error, "Error"); }
}
