#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

static int failures;
static void existing(const char *path) {
  errno = 0;
  int rc = mkdir(path, 0755);
  if (rc != -1 || errno != EEXIST) {
    fprintf(stderr, "mkdir(%s): rc=%d errno=%d, expected EEXIST\n", path, rc, errno);
    failures++;
  }
  errno = 0;
  rc = mkdirat(AT_FDCWD, path, 0755);
  if (rc != -1 || errno != EEXIST) {
    fprintf(stderr, "mkdirat(%s): rc=%d errno=%d, expected EEXIST\n", path, rc, errno);
    failures++;
  }
}
int main(void) {
  if (geteuid() == 0) return 2;
  existing("/");
  existing("/usr");
  existing("/home");
  existing("/home/maker");

  char path[128];
  snprintf(path, sizeof path, "/tmp/mkdir-existing-%ld", (long)getpid());
  if (mkdir(path, 0700) || chdir(path)) return 3;
  int file = open("file", O_CREAT | O_WRONLY, 0600);
  if (file < 0 || close(file) || mkdir("dir", 0700)
      || symlink("missing-target", "link") || chmod(".", 0555)) return 4;
  existing("file");
  existing("dir");
  existing("link");
  int fd = open(".", O_RDONLY | O_DIRECTORY);
  if (fd < 0) return 5;
  errno = 0;
  if (mkdirat(fd, "dir", 0755) != -1 || errno != EEXIST) failures++;
  errno = 0;
  if (mkdir("new", 0755) != -1 || errno != EACCES) failures++;
  errno = 0;
  if (mkdirat(fd, "new", 0755) != -1 || errno != EACCES) failures++;
  /* Lack of search permission must still hide the existing child. */
  if (chmod(".", 0000)) return 6;
  errno = 0;
  if (mkdirat(fd, "dir", 0755) != -1 || errno != EACCES) failures++;
  if (fchmod(fd, 0700) || close(fd)) return 7;
  if (failures) return 1;
  puts("mkdir-existing-directory: ok");
  return 0;
}
