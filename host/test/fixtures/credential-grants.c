/*
 * Guest for host/test/credential-grants.test.ts. Every image it runs prints
 * "MARKER pid=<pid>" as its first act, so the test can order the image's
 * first instruction against the host's credential prompt. Each mode then
 * blocks on one stdin line so the test can inspect grants while it runs.
 *
 *   hold          print the marker, wait for a line, exit 0
 *   fork          fork a child that prints "CHILD pid=<pid>" and waits;
 *                 after a line, release and reap it
 *   exec PATH     after a line, exec PATH (argv "credprog hold")
 *   spawn PATH    posix_spawn PATH (argv "credprog hold") and reap it,
 *                 printing "SIGNALED sig=<n>" if a signal ended it
 *   swapexec DECLARED OWN
 *                 move DECLARED aside, copy OWN to DECLARED and open it,
 *                 move that copy away and the original back, then fexecve
 *                 the open copy (argv "credprog hold"): an image of a file
 *                 that is not the one DECLARED names when the host looks
 */
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static void wait_for_line(void) {
  int c;
  while ((c = getchar()) != EOF && c != '\n') {
  }
}

int main(int argc, char **argv) {
  printf("MARKER pid=%d\n", (int)getpid());
  fflush(stdout);
  if (argc < 2) return 2;

  if (strcmp(argv[1], "hold") == 0) {
    wait_for_line();
    printf("DONE pid=%d\n", (int)getpid());
    return 0;
  }

  if (strcmp(argv[1], "fork") == 0) {
    int release[2];
    if (pipe(release) != 0) return 3;
    pid_t child = fork();
    if (child < 0) return 4;
    if (child == 0) {
      close(release[1]);
      printf("CHILD pid=%d\n", (int)getpid());
      fflush(stdout);
      char byte;
      while (read(release[0], &byte, 1) > 0) {
      }
      _exit(0);
    }
    close(release[0]);
    wait_for_line();
    close(release[1]);
    int status = 0;
    if (waitpid(child, &status, 0) != child) return 5;
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 6;
    printf("DONE pid=%d\n", (int)getpid());
    return 0;
  }

  if (strcmp(argv[1], "exec") == 0 && argc > 2) {
    wait_for_line();
    fflush(stdout);
    execl(argv[2], "credprog", "hold", (char *)0);
    return 7;
  }

  if (strcmp(argv[1], "spawn") == 0 && argc > 2) {
    char *child_argv[] = {"credprog", "hold", NULL};
    pid_t child;
    if (posix_spawn(&child, argv[2], NULL, NULL, child_argv, environ) != 0) return 8;
    int status = 0;
    if (waitpid(child, &status, 0) != child) return 9;
    if (WIFSIGNALED(status)) {
      printf("SIGNALED sig=%d\n", WTERMSIG(status));
      fflush(stdout);
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return 10;
    printf("DONE pid=%d\n", (int)getpid());
    return 0;
  }

  if (strcmp(argv[1], "swapexec") == 0 && argc > 3) {
    const char *declared = argv[2];
    char aside[256], mine[256], buf[4096];
    snprintf(aside, sizeof aside, "%s.aside", declared);
    snprintf(mine, sizeof mine, "%s.mine", declared);
    if (rename(declared, aside) != 0) return 11;
    int in = open(argv[3], O_RDONLY);
    int out = open(declared, O_WRONLY | O_CREAT | O_EXCL, 0755);
    if (in < 0 || out < 0) return 12;
    ssize_t n;
    while ((n = read(in, buf, sizeof buf)) > 0) {
      if (write(out, buf, (size_t)n) != n) return 13;
    }
    if (n < 0 || close(out) != 0 || close(in) != 0) return 14;
    int image = open(declared, O_RDONLY);
    if (image < 0) return 15;
    if (rename(declared, mine) != 0 || rename(aside, declared) != 0) return 16;
    char *child_argv[] = {"credprog", "hold", NULL};
    fflush(stdout);
    fexecve(image, child_argv, environ);
    return 17;
  }
  return 2;
}
