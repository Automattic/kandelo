#include "copy-file-operations.h"
#include <atomic>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>
using namespace kandelo::nodefs;
// Fault controls keep actual opens/fds/metadata/close/unlink. Only the named
// failed syscall is injected, so assertions inspect real cleanup and bytes.
struct FaultSystem : CopyFileSystem {
  static inline std::string fault;
  static inline bool zeroDirectorySize = false;
  static inline int closes = 0, writes = 0, reads = 0, clones = 0, maximumRead = 0, stats = 0;
  static inline int metadata = 0, permissions = 0;
  static inline long long sourceSize = -1;
  static inline unsigned sourceType = 0;
  static int Stat(int fd, struct stat* record) {
    ++stats;
    if ((fault == "stat-source" && stats == 1) || (fault == "stat-destination" && stats == 2)) {
      errno = EINTR; return -1;
    }
    const int result = CopyFileSystem::Stat(fd, record);
    // Preserve the real directory inode identity/type while exposing the
    // zero entry-count size of an empty Kandelo rootfs/tmpfs directory.
    if (result == 0 && zeroDirectorySize && S_ISDIR(record->st_mode)) record->st_size = 0;
    if (result == 0 && stats == 1) { sourceSize = record->st_size; sourceType = record->st_mode & S_IFMT; }
    return result;
  }
  static int Truncate(int fd) {
    if (fault == "truncate-interrupted") { errno = EINTR; return -1; }
    if (fault == "truncate-access" || fault == "truncate-empty") { errno = EACCES; return -1; }
    return CopyFileSystem::Truncate(fd);
  }
  static ssize_t Read(int fd, char* bytes, size_t size, off_t offset, bool positional) {
    ++reads; maximumRead = std::max(maximumRead, int(size));
    if (fault == "read" && reads == 2) { errno = EIO; return -1; }
    if (fault == "eof" && reads == 2) return 0;
    return CopyFileSystem::Read(fd, bytes, size, offset, positional);
  }
  static ssize_t Write(int fd, const char* bytes, size_t size) {
    ++writes;
    if (fault == "write" && writes == 2) { errno = ENOSPC; return -1; }
    if (fault == "write-zero") return 0;
    if (fault == "short-write") size = std::min(size, size_t(31));
    if (fault == "again" && writes == 1) { errno = EAGAIN; return -1; }
    return CopyFileSystem::Write(fd, bytes, size);
  }
  static int Permissions(int fd, mode_t mode) {
    ++permissions;
    if (fault == "chmod") { errno = EPERM; return -1; }
    return CopyFileSystem::Permissions(fd, mode);
  }
  static void Metadata(int fd, const struct stat& source) {
    ++metadata; CopyFileSystem::Metadata(fd, source);
  }
  static int Clone(int, int) { ++clones; return fault == "clone-unsupported" ? -ENOSYS : -ENOTSUP; }
  static int Close(int fd) {
    const int actual = CopyFileSystem::Close(fd); ++closes;
    if (fault == "close-source" && closes == 1) return -EIO;
    if (fault == "close-destination" && closes == 2) return -EBADF;
    if (fault == "write" && closes == 1) return -EBADF;
    return actual;
  }
};
int main(int argc, char** argv) {
  if (argc < 5) return 2;
  const std::string command = argv[1]; const char* source = argv[2]; const char* destination = argv[3];
  const int flags = std::atoi(argv[4]);
  if (command == "copy") {
    std::printf("{\"status\":%d}\n", CopyPathFile(source, destination, flags)); return 0;
  }
  if ((command == "fault" || command == "directory-zero") && argc == 6) {
    FaultSystem::fault = argv[5];
    FaultSystem::zeroDirectorySize = command == "directory-zero";
    const int status = CopyPathFile<FaultSystem>(source, destination, flags);
    std::printf("{\"status\":%d,\"closes\":%d,\"reads\":%d,\"writes\":%d,\"clones\":%d,\"maximumRead\":%d,\"metadata\":%d,\"permissions\":%d,\"sourceSize\":%lld,\"sourceType\":%u}\n",
        status, FaultSystem::closes, FaultSystem::reads, FaultSystem::writes, FaultSystem::clones, FaultSystem::maximumRead,
        FaultSystem::metadata, FaultSystem::permissions, FaultSystem::sourceSize, FaultSystem::sourceType); return 0;
  }
  if (command == "race") {
    constexpr int count = 24;
    std::atomic<int> arrived{0}; std::atomic<bool> go{false};
    int statuses[count]; std::vector<std::thread> threads;
    for (int i = 0; i < count; ++i) threads.emplace_back([&, i] {
      arrived.fetch_add(1); while (!go.load()) std::this_thread::yield();
      statuses[i] = CopyPathFile(source, destination, flags);
    });
    while (arrived.load() != count) std::this_thread::yield(); go.store(true);
    for (auto& thread : threads) thread.join();
    std::printf("{\"statuses\":[");
    for (int i = 0; i < count; ++i) std::printf("%s%d", i ? "," : "", statuses[i]);
    std::puts("]}"); return 0;
  }
  return 2;
}
