#include "lto-fork.h"

__attribute__((noinline))
uint32_t lto_bridge(struct lto_state *state, lto_callback callback, uint32_t delta) {
    volatile uint32_t frame[8] = {17, 19, 23, 29, 31, 37, 41, 43};
    uintptr_t address = (uintptr_t)&frame[3];
    state->frame = address;
    state->callback = callback;
    uint32_t result = callback(state, delta);
    if (state->self != state || state->callback != callback ||
        state->frame != address || frame[3] != 29 || frame[7] != 43)
        return UINT32_MAX;
    return result + frame[0];
}
uint32_t lto_dispatch(struct lto_state *state, unsigned index, uint32_t delta) {
    lto_callback callback = lto_callbacks[index & 1];
    // A cross-file helper is eligible for LTO inlining without changing the
    // deliberately indirect, fork-capable call inside the retained bridge.
    uint32_t adjusted = lto_adjust(state, delta);
    return lto_bridge(state, callback, adjusted - state->value - state->salt);
}
