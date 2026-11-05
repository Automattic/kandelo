// Native dependency control for the same ncrypto material owner used by guest
// bindings. This does not exercise SpiderMonkey slots, guest syscalls or hosts.
#include "kandelo-node-key-operations.h"
#include <fstream>
#include <iostream>
#include <iterator>
using kandelo::crypto::Bytes;
using kandelo::crypto::KeyMaterial;
static Bytes Read(const char* path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) throw std::runtime_error("Cannot read fixture");
  Bytes bytes; bytes.value.assign(std::istreambuf_iterator<char>(file), {});
  return bytes;
}
static void Hex(const void* bytes, size_t size) {
  const auto* data = static_cast<const unsigned char*>(bytes);
  constexpr char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < size; ++i) std::cout << hex[data[i] >> 4] << hex[data[i] & 15];
  std::cout << '\n';
}
int main(int argc, char** argv) {
  try {
    if (argc == 3 && std::string(argv[1]) == "secret") {
      auto bytes = Read(argv[2]); auto key = KeyMaterial::Secret(bytes);
      auto copy = KeyMaterial::Secret(bytes);
      if (!key->Equals(*copy)) throw std::runtime_error("Secret equality failed");
      if (!bytes.value.empty()) bytes.value[0] ^= 1;
      Hex(key->secret.get(), key->secret.size()); return 0;
    }
    if (argc == 9 && std::string(argv[1]) == "raw") {
      // raw algorithm format curve input-file role export-format
      auto input = Read(argv[5]);
      const auto format = KeyMaterial::Format(std::stoi(argv[3]));
      std::string type;
      const std::string hex(argv[2]);
      if (hex.size() % 2) throw std::runtime_error("Expected hex algorithm name");
      for (size_t i = 0; i < hex.size(); i += 2)
        type.push_back(char(std::stoul(hex.substr(i, 2), nullptr, 16)));
      auto key = KeyMaterial::Raw(input, format, type, argv[4]);
      auto output = key->Export(KeyMaterial::Configuration(0, std::stoi(argv[6]) == 2 ? 1 : 2, nullptr),
                                std::stoi(argv[6]) == 2);
      // The role projection retains the actual private material just as the
      // guest handle does; serialize only the requested role.
      if (std::string(argv[7]) != "der" || std::string(argv[8]) != "check")
        throw std::runtime_error("Expected der check");
      Hex(output.get(), output.size()); return 0;
    }
    if (argc != 10) throw std::runtime_error("Expected role, format, encoding, key file, passphrase file or -, export format, encoding, cipher or -, export passphrase file or -");
    const bool privateKey = std::stoi(argv[1]) == 2;
    auto input = Read(argv[4]);
    const bool hasPassphrase = std::string(argv[5]) != "-";
    Bytes passphrase = hasPassphrase ? Read(argv[5]) : Bytes{};
    auto config = KeyMaterial::Configuration(std::stoi(argv[2]), std::stoi(argv[3]), hasPassphrase ? &passphrase : nullptr);
    auto key = KeyMaterial::Parse(privateKey, input, std::move(config));
    const bool encrypted = std::string(argv[8]) != "-", exportPassword = std::string(argv[9]) != "-";
    Bytes exportPassphrase = exportPassword ? Read(argv[9]) : Bytes{};
    auto output = key->Export(KeyMaterial::Configuration(std::stoi(argv[6]), std::stoi(argv[7]),
        exportPassword ? &exportPassphrase : nullptr, encrypted ? argv[8] : nullptr), privateKey);
    Hex(output.get(), output.size()); return 0;
  } catch (const kandelo::crypto::Error& error) {
    std::cerr << error.code << ':' << error.what() << '\n'; return 2;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
