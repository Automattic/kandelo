#include "path-metadata-operations.h"
#include <cstdio>
#include <cstdlib>
#include <string>
using namespace kandelo::nodefs;
static int Link(const std::string& source, const std::string& destination) {
  return RunMetadata(MetadataOperation::Link, source.c_str(), {}, destination.c_str());
}
static bool Write(const std::string& path, const char* text) {
  int fd = open(path.c_str(), O_CREAT | O_TRUNC | O_WRONLY, 0600);
  if (fd < 0) return false;
  return write(fd, text, 5) == 5 && close(fd) == 0;
}
int main(int argc, char** argv) {
  if (argc != 2) return 2;
  std::string base = argv[1], source = base + "/source", dest = base + "/dest";
  if (!Write(source, "owned")) return 3;
  int created = Link(source, dest);struct stat a{}, b{};
  if (stat(source.c_str(), &a) || stat(dest.c_str(), &b)) return 4;
  bool same = a.st_ino == b.st_ino;auto links = a.st_nlink;
  int duplicate = Link(source, dest), missing = Link(base + "/missing", base + "/alias");
  int parent = Link(source, base + "/missing-parent/dest"), empty = Link("", base + "/empty");
  if (unlink(source.c_str()) || stat(dest.c_str(), &b)) return 5;
  int fd = open(dest.c_str(), O_RDONLY);char bytes[6]{};
  if (fd < 0 || read(fd, bytes, 5) != 5 || close(fd)) return 6;
  std::string symlinkPath = base + "/symlink", symlinkAlias = base + "/symlink-alias";
  if (symlink("dest", symlinkPath.c_str())) return 7;
  int symlinkResult = Link(symlinkPath, symlinkAlias);
  struct stat linkState{};if (lstat(symlinkAlias.c_str(), &linkState)) return 8;
  std::string raw = base + "/raw-\xE9\x9B\xAA", rawAlias = base + "/raw-alias";
  if (!Write(raw, "bytes")) return 9;
  int rawResult = Link(raw, rawAlias);struct stat rawA{}, rawB{};
  if (stat(raw.c_str(), &rawA) || stat(rawAlias.c_str(), &rawB)) return 10;
  printf("{\"created\":%d,\"same\":%s,\"links\":%llu,\"retained\":\"%s\",\"remaining\":%llu,\"errors\":[%d,%d,%d,%d],\"symlinkResult\":%d,\"symlink\":%s,\"rawResult\":%d,\"rawSame\":%s}\n",
      created, same ? "true" : "false", static_cast<unsigned long long>(links), bytes,
      static_cast<unsigned long long>(b.st_nlink), duplicate, missing, parent, empty,
      symlinkResult, S_ISLNK(linkState.st_mode) ? "true" : "false", rawResult,
      rawA.st_ino == rawB.st_ino ? "true" : "false");
}
