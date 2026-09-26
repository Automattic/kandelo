/*
 * The native host's copy of the parent-returns-from-fork-first fixture.
 *
 * The child cannot exit until the parent writes after fork() returned, so a
 * host that completes the parent only at the child's exit deadlocks. The Node
 * host runs the same source (`host/test/fork-kernel-launch.test.ts`), so it
 * is shared by inclusion rather than copied; see `native_thread_churn.c`.
 */
#include "../../../programs/fork-parent-returns-first.c"
