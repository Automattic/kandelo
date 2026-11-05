#include "path-metadata-operations.h"
#include <cstdio>
#include <string>
static int Digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}
int main(int argc, char** argv) {
  if (argc != 3) return 2;
  const std::string input(argv[2]);std::string path;
  if (input.size() % 2) return 2;
  for (size_t i = 0; i < input.size(); i += 2) {
    const int a = Digit(input[i]), b = Digit(input[i + 1]);
    if (a < 0 || b < 0) return 2;
    path.push_back(char((a << 4) | b));
  }
  const auto operation = std::string(argv[1]) == "realpath" ?
      kandelo::nodefs::MetadataOperation::Realpath : kandelo::nodefs::MetadataOperation::Readlink;
  const auto result = kandelo::nodefs::ReadMetadataPath(operation, path.c_str());
  std::printf("{\"status\":%d,\"hex\":\"", result.status);
  for (const unsigned char byte : result.bytes) std::printf("%02x", byte);
  std::puts("\"}");
}
