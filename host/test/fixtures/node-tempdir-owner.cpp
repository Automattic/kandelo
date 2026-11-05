// Portable actual-libc owner; not the guest JSAPI request/completion bridge.
#include "third_party/node-core/directory-operations.h"
#include <iostream>
#include <set>

int main(int argc, char** argv) {
  if (argc != 4) return 2;
  const std::string prefix = argv[1];
  const int count = std::atoi(argv[2]);
  if (count < 1 || count > 100) return 2;
  const mode_t mask = mode_t(std::strtoul(argv[3], nullptr, 8));
  const mode_t previous = ::umask(mask);
  std::set<std::string> names;
  int status = 0, created = 0;
  bool shape = true, directories = true, modes = true;
  for (int i = 0; i < count; i++) {
    const auto result = kandelo::nodefs::RunPath(kandelo::nodefs::PathOperation::Mkdtemp,
                                               prefix, 0, false, false);
    status = result.status;
    if (status < 0) break;
    created++;
    shape = shape && result.firstPath.size() == prefix.size() + 6 &&
        result.firstPath.compare(0, prefix.size(), prefix) == 0;
    names.insert(result.firstPath);
    struct stat metadata{};
    if (::stat(result.firstPath.c_str(), &metadata) < 0) return 3;
    directories = directories && S_ISDIR(metadata.st_mode);
    modes = modes && (metadata.st_mode & 0777) == (0700 & ~mask);
    // Leave the actual tree for the controller to inspect and retire. A
    // zero-mode fixture still needs deterministic host-side cleanup access.
    if (::chmod(result.firstPath.c_str(), 0700) < 0) return 4;
  }
  ::umask(previous);
  std::cout << "{\"status\":" << status << ",\"created\":" << created
            << ",\"unique\":" << (int(names.size()) == created ? "true" : "false")
            << ",\"shape\":" << (shape ? "true" : "false")
            << ",\"directories\":" << (directories ? "true" : "false")
            << ",\"modes\":" << (modes ? "true" : "false") << "}\n";
}
