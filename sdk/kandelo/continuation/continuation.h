#ifndef KANDELO_CONTINUATION_H
#define KANDELO_CONTINUATION_H

#include <stddef.h>

struct kandelo_continuation;

// The caller owns the stack and must keep it alive through destruction.
// The interval [bottom, top) grows downward. top must be 16-byte aligned.
struct kandelo_continuation *kandelo_continuation_create(
    void *bottom, void *top, void (*entry)(void *), void *argument);

// Return 1 after suspension, 0 after completion, or -1 with errno for
// invalid state or a resume attempted from a different pthread.
int kandelo_continuation_enter(struct kandelo_continuation *);
void kandelo_continuation_suspend(void);

// The owner can destroy an inactive continuation, including one suspended
// at a yield. An error leaves the continuation unchanged.
int kandelo_continuation_destroy(struct kandelo_continuation *);

// Visit valid conservative roots in the saved shadow stack and capture
// records. The caller must keep the owner quiescent throughout the visit.
void kandelo_continuation_visit_saved(
    const struct kandelo_continuation *,
    void (*visit)(void *address, size_t size, void *argument),
    void *argument);

#endif
