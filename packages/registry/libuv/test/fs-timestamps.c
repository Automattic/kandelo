#define _POSIX_C_SOURCE 200809L
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <assert.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>
#include <uv.h>

static int failures;

static void check(const char *mount, const char *test, int rc, int correct) {
  printf("{\"mount\":\"%s\",\"case\":\"%s\",\"rc\":%d,\"correct\":%d}\n",
         mount, test, rc, correct);
  if (!correct) failures++;
}

static int stamp(const struct stat *st, time_t seconds) {
  return st->st_atim.tv_sec == seconds && st->st_atim.tv_nsec == 250000000 &&
         st->st_mtim.tv_sec == seconds && st->st_mtim.tv_nsec == 750000000;
}

static void exercise(const char *mount, const char *dir) {
  const time_t initial = 1600000000;
  const time_t after2038 = 2200000000LL;
  assert(mkdir(dir, 0700) == 0);
  assert(chdir(dir) == 0);
  int fd = open("file", O_RDWR | O_CREAT | O_EXCL, 0600);
  assert(fd >= 0 && symlink("file", "link") == 0);
  uv_fs_t req;
  struct stat target, link;
  int rc = uv_fs_utime(NULL, &req, "link", initial + 0.25, initial + 0.75, NULL);
  uv_fs_req_cleanup(&req);
  assert(fstat(fd, &target) == 0);
  check(mount, "follow-final-link", rc, rc == 0 && stamp(&target, initial));

  rc = uv_fs_lutime(NULL, &req, "link", after2038 + 0.25, after2038 + 0.75, NULL);
  uv_fs_req_cleanup(&req);
  assert(lstat("link", &link) == 0 && fstat(fd, &target) == 0);
  check(mount, "change-only-link", rc,
        rc == 0 && stamp(&link, after2038) && stamp(&target, initial));

  rc = uv_fs_futime(NULL, &req, fd, initial + 0.25, initial + 0.75, NULL);
  uv_fs_req_cleanup(&req);
  assert(fstat(fd, &target) == 0);
  check(mount, "open-descriptor", rc, rc == 0 && stamp(&target, initial));

  assert(rename("file", "moved") == 0);
  int replacement = open("file", O_RDWR | O_CREAT | O_EXCL, 0600);
  assert(replacement >= 0);
  rc = uv_fs_futime(NULL, &req, fd, after2038 + 0.25, after2038 + 0.75, NULL);
  uv_fs_req_cleanup(&req);
  struct stat other;
  assert(fstat(fd, &target) == 0 && fstat(replacement, &other) == 0);
  check(mount, "renamed-open-inode", rc,
        rc == 0 && stamp(&target, after2038) && !stamp(&other, after2038));

  assert(unlink("moved") == 0);
  const time_t unlinked = 1700000000;
  rc = uv_fs_futime(NULL, &req, fd, unlinked + 0.25, unlinked + 0.75, NULL);
  uv_fs_req_cleanup(&req);
  assert(fstat(fd, &target) == 0);
  check(mount, "unlinked-open-inode", rc, rc == 0 && stamp(&target, unlinked));
  assert(close(fd) == 0 && close(replacement) == 0);
  assert(unlink("file") == 0 && unlink("link") == 0 && chdir("/") == 0 && rmdir(dir) == 0);
}

int main(void) {
  exercise("tmpfs", "/tmp/uv-times");
  exercise("rootfs", "/uv-times");
  return failures != 0;
}
