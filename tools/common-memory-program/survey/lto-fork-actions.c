#include "lto-fork.h"
#include <setjmp.h>
#include <unistd.h>

uint32_t lto_adjust(struct lto_state *state, uint32_t delta) {
    return state->value + state->salt + delta;
}
static uint32_t leaf(struct lto_state *state, uint32_t delta) {
    state->value += delta;
    return lto_adjust(state, 0);
}
static uint32_t fork_action(struct lto_state *state, uint32_t delta) {
    // Both the caller's C frame and this value must survive child replay.
    volatile uint32_t before = state->value + delta;
    jmp_buf continuation;
    // Keep an actual jump context active across fork, then use it in both
    // branches. LTO bitcode needs the same EH/SjLj backend configuration as
    // an ordinary SDK compile; a fork-only fixture cannot prove this path.
    switch (setjmp(continuation)) {
    case 0: {
        pid_t branch = fork();
        state->branch = branch;
        if (branch < 0) return UINT32_MAX;
        if (!branch) state->value = 99;
        longjmp(continuation, 7);
    }
    case 7:
        return lto_adjust(state, before);
    default:
        return UINT32_MAX;
    }
}
// Volatile plus the argument-selected slot retains a genuine indirect call
// under LTO. This exercises callback facts rather than constant direct calls.
lto_callback volatile lto_callbacks[2] = {leaf, fork_action};
