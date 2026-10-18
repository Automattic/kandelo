// A thread must start on a 16-byte aligned stack pointer.
//
// Clang lays out every callee frame from an SP it assumes is 16-byte
// aligned. musl's pthread_create aligns the new thread's stack to
// sizeof(uintptr_t) — 4 here — and then subtracts `struct start_args`, so
// the value it hands to clone is routinely 4 mod 8. On such a thread the
// caller of a variadic function stores a 64-bit argument four bytes away
// from where va_arg reads it, and printf("%lld", 1000) prints garbage.
//
// Waybar exposed this: its GDBus client runs on a thread, and GIO builds
// the EXTERNAL auth identity with g_strdup_printf("%lli", (gint64) uid).
// It printed the high half of the uid, so every process claimed uid 0 to
// the session bus and dbus-daemon rejected it.
//
// Expected output on PASS:
//   MAIN: 1000
//   THREAD: 1000
//   PASS

#include <pthread.h>
#include <stdio.h>
#include <string.h>

static int mangled;

static void report(const char *where) {
    volatile long long source = 1000;
    char buf[32];
    snprintf(buf, sizeof buf, "%lld", (long long)source);
    printf("%s: %s\n", where, buf);
    if (strcmp(buf, "1000") != 0) mangled = 1;
}

static void *thread_main(void *arg) {
    (void)arg;
    report("THREAD");
    return NULL;
}

int main(void) {
    report("MAIN");

    pthread_t thread;
    if (pthread_create(&thread, NULL, thread_main, NULL) != 0) {
        printf("FAIL: pthread_create\n");
        return 1;
    }
    pthread_join(thread, NULL);

    if (mangled) {
        printf("FAIL: a 64-bit vararg was read off its own store\n");
        return 1;
    }
    printf("PASS\n");
    return 0;
}
