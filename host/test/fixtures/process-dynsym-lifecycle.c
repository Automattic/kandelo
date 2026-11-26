#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static const char provider_path[] = "/lib/dynsym-dependency.so";
static pthread_barrier_t error_barrier;
static int callbacks[3];
int lifecycle_fork_stage;
pid_t lifecycle_fork_result;
extern char **environ;

void observe_lifecycle(int stage)
{
    __atomic_fetch_add(&callbacks[stage], 1, __ATOMIC_RELAXED);
}

static void *check_thread_error(void *argument)
{
    const char *name = argument;
    if (dlsym(RTLD_DEFAULT, name)) return argument;
    pthread_barrier_wait(&error_barrier);
    const char *error = dlerror();
    if (!error || !strstr(error, name) || dlerror()) return argument;
    return 0;
}

static void *check_loader_parallel(void *argument)
{
    for (int i = 0; i < 20; ++i) {
        void *handle = dlopen(provider_path, RTLD_LAZY | RTLD_LOCAL);
        if (!handle) return argument;
        int (*value)(void) = dlsym(handle, "dependency_value");
        if (!value || value() != 19 || dlclose(handle)) return argument;
    }
    return 0;
}

int main(int argc, char **argv)
{
    if (argc != 2) return 1;
    if (!strcmp(argv[1], "--verify-exec"))
        return dlsym(RTLD_DEFAULT, "observe_lifecycle") == (void *)&observe_lifecycle ? 0 : 17;
    pthread_t first, second;
    void *status;
    if (pthread_barrier_init(&error_barrier, 0, 2) ||
        pthread_create(&first, 0, check_thread_error, "missing_first_thread") ||
        pthread_create(&second, 0, check_thread_error, "missing_second_thread"))
        return 2;
    if (pthread_join(first, &status) || status ||
        pthread_join(second, &status) || status)
        return 3;
    pthread_barrier_destroy(&error_barrier);

    void *main = dlopen(NULL, RTLD_NOW);
    void *side = dlopen(argv[1], RTLD_LAZY);
    if (!main || !side) {
        fprintf(stderr, "%s\n", dlerror());
        return 4;
    }
    if (callbacks[0] != 1 || callbacks[1] != 0 || callbacks[2] != 1)
        return 5;
    if (dlsym(main, "lifecycle_check") || !dlerror()) return 6;
    void *again = dlopen(argv[1], RTLD_NOW | RTLD_GLOBAL);
    if (again != side || callbacks[0] != 1 ||
        !dlsym(main, "lifecycle_check") || !dlsym(main, "dependency_value"))
        return 7;
    if (dlclose(side) || !dlsym(again, "lifecycle_check") || callbacks[1])
        return 8;
    if (dlclose(again) || callbacks[1] != 1 || dlsym(side, "lifecycle_check") ||
        !dlerror() || dlsym(main, "dependency_value") || !dlerror())
        return 9;
    void *new_handle = dlopen(argv[1], RTLD_NOW);
    if (!new_handle || new_handle == side || callbacks[0] != 2 ||
        callbacks[2] != 2 || dlclose(new_handle) || callbacks[1] != 2)
        return 10;
    if (dlclose(main)) return 11;

    if (pthread_create(&first, 0, check_loader_parallel, "first open or close") ||
        pthread_create(&second, 0, check_loader_parallel, "second open or close"))
        return 12;
    pid_t child = fork();
    if (child == 0) _exit(check_loader_parallel("child open or close") ? 13 : 0);
    int child_status;
    if (child < 0 || waitpid(child, &child_status, 0) != child || child_status ||
        pthread_join(first, &status) || status ||
        pthread_join(second, &status) || status)
        return 14;

    for (int stage = 1; stage <= 2; ++stage) {
        lifecycle_fork_stage = stage;
        lifecycle_fork_result = -1;
        const int loaded = callbacks[0], closed = callbacks[1];
        void *handle = dlopen(argv[1], RTLD_NOW);
        int (*check)(void) = handle ? dlsym(handle, "lifecycle_check") : 0;
        int ok = check && check() == 19 && !dlclose(handle) &&
            callbacks[0] == loaded + 1 && callbacks[1] == closed + 1;
        child = lifecycle_fork_result;
        lifecycle_fork_stage = 0;
        if (child == 0) {
            if (ok) ok = !check_loader_parallel("child after loader continuation");
            _exit(ok ? 0 : 14 + stage);
        }
        if (!ok || child < 0 || waitpid(child, &child_status, 0) != child || child_status) {
            fprintf(stderr, "loader fork stage %d failed, child status %#x\n", stage, child_status);
            return 14 + stage;
        }
    }
    char *child_argv[] = {"/bin/dynsym-lifecycle", "--verify-exec", 0};
    int spawn_error = posix_spawn(&child, child_argv[0], 0, 0, child_argv, environ);
    if (spawn_error || waitpid(child, &child_status, 0) != child || child_status) {
        fprintf(stderr, "exec of loader-capable program failed, error %d, status %#x\n",
                spawn_error, child_status);
        return 18;
    }
    puts("guest loader lifecycle ok");
    return 0;
}
