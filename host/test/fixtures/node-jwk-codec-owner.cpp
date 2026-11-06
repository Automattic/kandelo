// Exact native JWK byte helper controls. This does not execute SpiderMonkey
// JSAPI, getters, GC, OOM injection or foreign-realm key publication.
#include "kandelo-node-key-operations.h"
#include <iostream>
#include <sstream>
static std::vector<unsigned char> Unhex(const std::string& text) {
  std::vector<unsigned char> bytes;
  if (text == "-") return bytes;
  if (text.size() % 2) throw std::runtime_error("Invalid hex");
  for (size_t i = 0; i < text.size(); i += 2)
    bytes.push_back(static_cast<unsigned char>(std::stoul(text.substr(i, 2), nullptr, 16)));
  return bytes;
}
static std::string Hex(const unsigned char* bytes, size_t length) {
  constexpr char alphabet[] = "0123456789abcdef";
  std::string text;
  for (size_t i = 0; i < length; i++) { text += alphabet[bytes[i] >> 4]; text += alphabet[bytes[i] & 15]; }
  return text.empty() ? "-" : text;
}
int main() {
  try {
    std::string operation, text;
    while (std::cin >> operation >> text) {
      auto bytes = Unhex(text);
      if (operation == "encode") {
        auto output = kandelo::crypto::jwk_codec::Encode(bytes.data(), bytes.size());
        std::cout << (output.empty() ? "-" : output) << '\n';
      } else if (operation == "decode8") {
        auto output = kandelo::crypto::jwk_codec::Decode(bytes.data(), bytes.size());
        std::cout << Hex(output.value.data(), output.value.size()) << '\n';
      } else if (operation == "decode16") {
        if (bytes.size() % 2) throw std::runtime_error("Invalid UTF-16");
        std::vector<char16_t> chars;
        for (size_t i = 0; i < bytes.size(); i += 2) chars.push_back(char16_t(bytes[i] | (unsigned(bytes[i + 1]) << 8)));
        auto output = kandelo::crypto::jwk_codec::Decode(chars.data(), chars.size());
        std::cout << Hex(output.value.data(), output.value.size()) << '\n';
      } else throw std::runtime_error("Unknown operation");
    }
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
