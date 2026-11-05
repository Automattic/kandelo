//go:build cgo

#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <unistd.h>

static volatile sig_atomic_t handler_count;
static unsigned char signal_stack[16384];
static volatile sig_atomic_t handler_valid;

static void c_signal_handler(int signal, siginfo_t *info, void *context) {
    char local;
    sigset_t mask;
    (void)context;
    handler_count++;
    if (signal == SIGUSR2 && info && info->si_signo == SIGUSR2 &&
        info->si_code == SI_USER && info->si_pid > 0 &&
        (uintptr_t)&local >= (uintptr_t)signal_stack &&
        (uintptr_t)&local < (uintptr_t)(signal_stack + sizeof(signal_stack)) &&
        sigprocmask(SIG_SETMASK, 0, &mask) == 0 &&
        sigismember(&mask, SIGUSR1) == 1 && sigismember(&mask, SIGUSR2) == 1) {
        handler_valid = 1;
    }
}

int install_c_signal_handler(void) {
    struct sigaction action = {0};
    stack_t stack = { .ss_sp = signal_stack, .ss_size = sizeof(signal_stack) };
    if (sigaltstack(&stack, 0)) return -1;
    action.sa_sigaction = c_signal_handler;
    action.sa_flags = SA_SIGINFO | SA_ONSTACK;
    sigemptyset(&action.sa_mask);
    sigaddset(&action.sa_mask, SIGUSR1);
    return sigaction(SIGUSR2, &action, 0);
}

int c_signal_handler_count(void) {
    sigset_t mask;
    stack_t stack;
    if (!handler_valid || sigprocmask(SIG_SETMASK, 0, &mask) ||
        sigismember(&mask, SIGUSR1) != 0 || sigismember(&mask, SIGUSR2) != 0 ||
        sigaltstack(0, &stack) || (stack.ss_flags & SS_ONSTACK)) return -1;
    return handler_count;
}

static int restart_write_fd;

static void restart_handler(int signal) {
    if (signal == SIGUSR2) (void)write(restart_write_fd, "r", 1);
}

int install_restart_handler(int fd) {
    struct sigaction action = {0};
    restart_write_fd = fd;
    action.sa_handler = restart_handler;
    action.sa_flags = SA_RESTART;
    sigemptyset(&action.sa_mask);
    return sigaction(SIGUSR2, &action, 0);
}

static void *raise_on_thread(void *argument) {
    int status = pthread_kill(pthread_self(), (int)(intptr_t)argument);
    return (void *)(intptr_t)status;
}

int signal_from_c_thread(int signal) {
    pthread_t thread;
    int status = pthread_create(&thread, 0, raise_on_thread, (void *)(intptr_t)signal);
    if (status) return status;
    void *result;
    status = pthread_join(thread, &result);
    return status ? status : (int)(intptr_t)result;
}
