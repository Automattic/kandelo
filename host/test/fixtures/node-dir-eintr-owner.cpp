// Controlled EINTR at a real libc cursor, against pinned libuv's batch retry
// policy. Macro interception exists only in this native fault-injection fixture.
#include <dirent.h>
#include <cerrno>
#include <cstring>
#include <cstdio>
#include <set>
#include <string>
static int visible = 0;
static bool interrupted = false;
static dirent* InterruptRead(DIR* directory) {
  if (visible == 1 && !interrupted) { interrupted = true; errno = EINTR; return nullptr; }
  auto* entry = ::readdir(directory);
  if (entry && std::strcmp(entry->d_name, ".") && std::strcmp(entry->d_name, "..")) ++visible;
  return entry;
}
#define readdir InterruptRead
#include "../../../third_party/node-core/dir-cursor.h"
#undef readdir
int main(int argc, char** argv) {
  if (argc != 2) return 2;
  DIR* raw = ::opendir(argv[1]); if (!raw) return 3;
  std::set<std::string> expected; std::string first;
  while (auto* entry = ::readdir(raw)) {
    if (!std::strcmp(entry->d_name,".") || !std::strcmp(entry->d_name,"..")) continue;
    if (first.empty()) first = entry->d_name;
    expected.insert(entry->d_name);
  }
  ::closedir(raw); if (expected.size() < 3) return 4;
  expected.erase(first);
  int status; auto cursor = kandelo::nodefs::DirectoryCursor::Open(argv[1], &status);
  if (status) return 5;
  const auto batch = cursor->Read(32);
  std::set<std::string> actual;
  for (const auto& entry : batch.entries) actual.insert(entry.name);
  if (batch.status || !interrupted || actual != expected) {
    std::fprintf(stderr,"FAIL pinned libuv interrupted-batch retry: status=%d interrupted=%d names=%zu expected=%zu\n",batch.status,int(interrupted),actual.size(),expected.size());
    return 1;
  }
  if (cursor->Close() != 0) return 6;
  std::puts("PASS real cursor with injected EINTR: interrupted partial batch discarded and remaining cursor retried");
}
