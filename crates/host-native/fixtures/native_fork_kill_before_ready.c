/*
 * The native host's copy of the fork-killed-before-replay-ready fixture.
 *
 * The behaviour under test is one POSIX case every host must agree on: a fork
 * child killed inside its launch window is still the parent's child, so the
 * parent gets its pid from fork() and reaps a SIGKILL zombie. The Node host
 * runs the same source (`host/test/fork-kernel-launch.test.ts`), so it is
 * shared by inclusion rather than copied; see `native_thread_churn.c` for why.
 */
#include "../../../programs/fork-kill-before-ready.c"
