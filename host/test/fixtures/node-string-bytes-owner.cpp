// Allocation-free private codec controls. This does not execute JSAPI, GC,
// BufferSource pinning or guest hash/cipher dispatch.
#include "kandelo-node-string-bytes.h"
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>
static std::vector<unsigned char> Unhex(const std::string& text) {
  std::vector<unsigned char> value;
  if (text == "-") return value;
  if (text.size() % 2) throw std::runtime_error("Invalid hex");
  for (size_t i = 0; i < text.size(); i += 2)
    value.push_back(static_cast<unsigned char>(std::stoul(text.substr(i, 2), nullptr, 16)));
  return value;
}
static std::string Hex(const std::vector<unsigned char>& bytes) {
  constexpr char alphabet[] = "0123456789abcdef";
  std::string text;
  for (auto byte : bytes) { text += alphabet[byte >> 4]; text += alphabet[byte & 15]; }
  return text.empty() ? "-" : text;
}
template <typename Char>
static std::vector<unsigned char> Decode(const Char* chars, size_t length, kandelo::encoding::encoding mode) {
  size_t capacity;
  if (!kandelo::encoding::bytes::Capacity(length, mode, &capacity)) throw std::runtime_error("Mode uses existing engine UTF8 owner");
  std::vector<unsigned char> output(capacity);
  output.resize(kandelo::encoding::bytes::Write(output.data(), output.size(), chars, length, mode));
  return output;
}
int main() {
  try {
    std::string operation, label, data;
    while (std::cin >> operation >> label >> data) {
      const auto encoded = Unhex(label); const std::string name(encoded.begin(), encoded.end());
      const auto mode = kandelo::encoding::ParseEncoding(name.c_str(), kandelo::encoding::UTF8);
      if (operation == "parse") { std::cout << kandelo::encoding::EncodingName(mode) << '\n'; continue; }
      const auto input = Unhex(data);
      std::vector<unsigned char> output;
      if (operation == "decode8") output = Decode(input.data(), input.size(), mode);
      else if (operation == "decode16") {
        if (input.size() % 2) throw std::runtime_error("Invalid UTF16");
        std::vector<char16_t> chars;
        for (size_t i = 0; i < input.size(); i += 2) chars.push_back(char16_t(input[i] | (unsigned(input[i + 1]) << 8)));
        output = Decode(chars.data(), chars.size(), mode);
      } else throw std::runtime_error("Unknown operation");
      std::cout << Hex(output) << '\n';
    }
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
