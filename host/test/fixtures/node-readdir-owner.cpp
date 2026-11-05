// Native POSIX owner control. No guest JSAPI, browser or fake filesystem.
#include "../../../third_party/node-core/readdir-operations.h"
#include <cstdio>

static void Hex(const std::string& bytes) {
  std::putchar('"');
  for (unsigned char byte : bytes) std::printf("%02x", unsigned(byte));
  std::putchar('"');
}
struct UnknownBackend : kandelo::nodefs::PosixReadDirectory {
  int Read(const std::string& path, std::vector<kandelo::nodefs::ReadEntry>* entries) {
    const int result = PosixReadDirectory::Read(path, entries);
    for (auto& entry : *entries) entry.type = kandelo::nodefs::UV_DIRENT_UNKNOWN;
    return result;
  }
};
int main(int argc, char** argv) {
  if (argc < 3) return 2;
  const bool recursive = std::strcmp(argv[2], "true") == 0;
  kandelo::nodefs::ReadDirectories result;
  if (argc > 3) {
    UnknownBackend backend;
    result = kandelo::nodefs::ReadDirectoryTree(backend, argv[1], recursive);
  } else result = kandelo::nodefs::ReadDirectoryTree(argv[1], recursive);
  std::printf("{\"status\":%d,\"errorPath\":", result.status); Hex(result.errorPath);
  std::printf(",\"directories\":[");
  // Native callers reject a failed scan rather than exposing partial results.
  if (result.status == 0) for (size_t i = 0; i < result.directories.size(); ++i) {
    if (i) std::putchar(',');
    const auto& dir = result.directories[i];
    std::printf("{\"relative\":"); Hex(dir.relative); std::printf(",\"entries\":[");
    for (size_t j = 0; j < dir.entries.size(); ++j) {
      if (j) std::putchar(',');
      std::putchar('['); Hex(dir.entries[j].name); std::printf(",%d]", int(dir.entries[j].type));
    }
    std::printf("]}");
  }
  std::printf("]}\n");
}
