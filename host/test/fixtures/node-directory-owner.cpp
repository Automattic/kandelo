#include "third_party/node-core/directory-operations.h"
#include <cstdio>
#include <cstdlib>
#include <stdexcept>
using namespace kandelo::nodefs;
static std::string Decode(const char* hex) {
  std::string result;
  for (size_t i = 0; hex[i] && hex[i + 1]; i += 2) {
    char digits[]{hex[i], hex[i + 1], 0}; result.push_back(char(strtoul(digits, nullptr, 16)));
  }
  return result;
}
static std::string Hex(const std::string& input) {
  std::string result; const char* table = "0123456789abcdef";
  for (unsigned char byte : input) { result += table[byte >> 4]; result += table[byte & 15]; }
  return result;
}
int main(int argc, char** argv) {
  if (argc != 6) return 2;
  const auto op = std::string(argv[1]) == "mkdir" ? PathOperation::Mkdir :
      std::string(argv[1]) == "unlink" ? PathOperation::Unlink : PathOperation::Rmdir;
  const auto result = RunPath(op, Decode(argv[2]), mode_t(strtoul(argv[3], nullptr, 10)),
      std::string(argv[4]) == "true", std::string(argv[5]) == "true");
  printf("{\"status\":%d,\"firstPathHex\":\"%s\"}\n", result.status, Hex(result.firstPath).c_str());
}
