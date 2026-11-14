#ifndef KANDELO_SURVEY_LTO_FORK_H
#define KANDELO_SURVEY_LTO_FORK_H
#include <stdint.h>
#include <sys/types.h>
struct lto_state;
typedef uint32_t (*lto_callback)(struct lto_state *, uint32_t);
struct lto_state {
    uint32_t value, salt;
    pid_t branch;
    struct lto_state *self;
    lto_callback callback;
    uintptr_t frame;
};
extern lto_callback volatile lto_callbacks[2];
uint32_t lto_adjust(struct lto_state *, uint32_t);
uint32_t lto_dispatch(struct lto_state *, unsigned, uint32_t);
#endif
