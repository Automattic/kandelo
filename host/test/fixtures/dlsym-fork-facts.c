/*
 * Fork after calls through dlsym() pointers, in a main program built with
 * the SDK so wasm-fork-instrument plans it from compiler facts.
 *
 * MODE 1: call a main-program export obtained with dlsym(RTLD_DEFAULT),
 *         then fork through a direct call.
 * MODE 2: fork through a dlsym(RTLD_DEFAULT) pointer to a main-program
 *         export.
 * MODE 3: call a side-module function obtained with dlsym(), then fork
 *         through a direct call. argv[1] names the side module.
 *
 * The exported functions are never address-taken in C, so no element
 * segment names them: only the host's dlsym installs them in the table.
 * Each mode exits 0 only if the child resumes main's frame intact.
 */
#include <dlfcn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

__attribute__((export_name("kandelo_dlsym_forker"), noinline))
int kandelo_dlsym_forker(void) {
  volatile int preserved = 23;
  int pid = fork();
  if (preserved != 23) _exit(91);
  return pid;
}

__attribute__((export_name("kandelo_dlsym_value"), noinline))
int kandelo_dlsym_value(void) { return 42; }

typedef int (*int_fn)(void);
typedef long long (*scale_fn)(int);

int main(int argc, char **argv) {
  volatile int marker = 0x5eed;
  int pid;
#if MODE == 1 || MODE == 2
  (void)argc;
  (void)argv;
  int_fn value = (int_fn)dlsym(RTLD_DEFAULT, "kandelo_dlsym_value");
  int_fn forker = (int_fn)dlsym(RTLD_DEFAULT, "kandelo_dlsym_forker");
  if (!value || !forker) { fprintf(stderr, "dlsym: %s\n", dlerror()); return 2; }
  if (value() != 42) return 3;
#if MODE == 1
  pid = kandelo_dlsym_forker();
#else
  pid = forker();
#endif
#elif MODE == 3
  if (argc < 2) return 2;
  void *side = dlopen(argv[1], RTLD_NOW);
  if (!side) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 2; }
  scale_fn scale = (scale_fn)dlsym(side, "side_scale");
  if (!scale) { fprintf(stderr, "dlsym: %s\n", dlerror()); return 2; }
  if (scale(7) != 21) return 3;
  pid = kandelo_dlsym_forker();
#else
#error "MODE must be 1, 2 or 3"
#endif
  if (pid < 0) return 4;
  if (pid == 0) _exit(marker == 0x5eed ? 0 : 9);
  int status = 0;
  if (waitpid(pid, &status, 0) != pid) return 5;
  if (!WIFEXITED(status)) return 6;
  if (WEXITSTATUS(status) != 0) {
    fprintf(stderr, "child exit %d\n", WEXITSTATUS(status));
    return 7;
  }
  puts("dlsym fork ok");
  return 0;
}
