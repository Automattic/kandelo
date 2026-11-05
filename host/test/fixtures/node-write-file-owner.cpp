#include "write-file-operations.h"
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
using kandelo::nodefs::WritePathFile;
static void Outcome(const char* name, const kandelo::nodefs::WriteFileResult& result) {
  printf("\"%s\":[%d,", name, result.status);
  if (result.status) printf("\"%s\"", result.syscall); else printf("null");
  printf("],");
}
static void Contents(const char* name, const std::string& path) {
  std::ifstream input(path, std::ios::binary);
  const std::string bytes{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
  printf("\"%s\":\"", name); for (unsigned char byte : bytes) printf("%02x", byte); printf("\",");
}
int main(int argc, char** argv) {
  if (argc != 2) return 2;
  const std::string root = argv[1], file = root + "/file";
  const char data[] = {'a', 0, 'b'};
  printf("{");
  Outcome("write", WritePathFile(file.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600, data, sizeof(data)));
  Contents("initial", file);
  Outcome("append", WritePathFile(file.c_str(), O_WRONLY | O_APPEND, 0600, "z", 1));
  Contents("appended", file);
  Outcome("exclusive", WritePathFile(file.c_str(), O_WRONLY | O_CREAT | O_EXCL, 0600, "x", 1));
  Outcome("readonly", WritePathFile(file.c_str(), O_RDONLY, 0600, "x", 1));
  Outcome("missing", WritePathFile((root + "/absent/file").c_str(), O_WRONLY | O_CREAT, 0600, "x", 1));
  Outcome("directory", WritePathFile(root.c_str(), O_WRONLY, 0600, "x", 1));
  Outcome("empty", WritePathFile(file.c_str(), O_WRONLY | O_TRUNC, 0600, nullptr, 0));
  std::ifstream input(file, std::ios::binary | std::ios::ate);
  printf("\"finalSize\":%lld}\n", static_cast<long long>(input.tellg()));
}
