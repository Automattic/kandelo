#include "kandelo-node-cipher-operations.h"
#include <iostream>
#include <sstream>
using kandelo::crypto::CipherState;
static std::vector<unsigned char> Unhex(const std::string& text) {
  std::vector<unsigned char> output;
  for (size_t i = 0; i < text.size(); i += 2) output.push_back(std::stoul(text.substr(i, 2), nullptr, 16));
  return output;
}
static std::string Hex(const unsigned char* data, size_t length) {
  std::string output; const char* hex = "0123456789abcdef";
  for (size_t i = 0; i < length; i++) { output += hex[data[i] >> 4]; output += hex[data[i] & 15]; }
  return output;
}
static std::string Quote(const std::string& text) {
  std::string output = "\"";
  for (char c : text) { if (c == '"' || c == '\\') output += '\\'; output += c; }
  return output + '"';
}
int main(int argc, char** argv) {
  if (argc != 11) return 2;
  try {
    const bool encrypt = std::string(argv[2]) == "encrypt";
    CipherState state(encrypt);
    auto key = Unhex(argv[3]), iv = Unhex(argv[4]);
    const unsigned tagLength = unsigned(std::stoll(argv[8]));
    state.Init(argv[1], key.data(), key.size(), iv.data(), iv.size(), tagLength,
        std::string(argv[9]) == "-" ? nullptr : argv[9], std::string(argv[10]) == "-" ? nullptr : argv[10]);
    if (std::string(argv[7]) != "-") { auto tag = Unhex(argv[7]); if (!state.SetTag(tag.data(), tag.size())) throw std::runtime_error("tag state"); }
    if (std::string(argv[6]) != "-") {
      const std::string aadSpec = argv[6]; const auto split = aadSpec.find(':');
      const auto aad = Unhex(aadSpec.substr(0, split));
      const int length = split == std::string::npos ? -1 : std::stoi(aadSpec.substr(split + 1));
      if (!state.AAD(aad.data(), aad.size(), length)) throw std::runtime_error("aad state");
    }
    std::string data = argv[5]; std::vector<unsigned char> output;
    for (;;) {
      const auto split = data.find(','); auto chunk = Unhex(data.substr(0, split));
      auto result = state.Update(chunk.data(), chunk.size()); output.insert(output.end(), result.begin(), result.end());
      if (split == std::string::npos) break;
      data.erase(0, split + 1);
    }
    auto final = state.Final(); output.insert(output.end(), final.begin(), final.end());
    std::cout << "{\"output\":" << Quote(Hex(output.data(), output.size())) << ",\"tag\":";
    if (state.tagState == CipherState::TagState::Computed) std::cout << Quote(Hex(state.tag.data(), state.tagLength));
    else std::cout << "null";
    std::cout << "}" << std::endl;
  } catch (const kandelo::crypto::Error& error) {
    std::cout << "{\"error\":{\"message\":" << Quote(error.what()) << ",\"code\":"
              << (error.code.empty() ? "null" : Quote(error.code)) << "}}" << std::endl;
  }
}
