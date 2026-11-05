// Portable HKDF operation + shared operation interface, over unchanged ncrypto.
#include "hkdf-operations.h"
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
static void Failure(const Error& error, const char* name) {
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
  if (argc != 6) return 2;
  try {
    auto operation = std::make_unique<HkdfOperation>(); Bytes name;
    Unhex(argv[1], &name); name.value.push_back(0);
    operation->SetDigest(reinterpret_cast<const char*>(name.value.data()));
    Unhex(argv[2], &operation->key); Unhex(argv[3], &operation->salt); Unhex(argv[4], &operation->info);
    operation->length = uint32_t(std::stoul(argv[5])); operation->CheckLength();
    // Exercise the same polymorphic owner invoked by the queued native job.
    std::unique_ptr<KdfOperation> work = std::move(operation);
    auto output = work->Derive();
    printf("{\"hex\":\""); for (auto c : output.value) printf("%02x", c); puts("\"}");
  } catch (const KdfError& error) {
    Failure(error, error.type == KdfError::Type::TypeError ? "TypeError" : error.type == KdfError::Type::RangeError ? "RangeError" : "Error");
  } catch (const Error& error) { Failure(error, "Error"); }
}
