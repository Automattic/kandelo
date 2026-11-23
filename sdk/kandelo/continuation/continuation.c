#include "continuation.h"
#include "link.h"

#include <errno.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdlib.h>

_Static_assert(sizeof(void *) == sizeof(uint32_t), "wasm32 continuation frame layout");

enum phase { FRESH, RUNNING, CAPTURING, SUSPENDED, REPLAYING, FINISHED };

// Offset zero is used for the active frame payload, offset eight for SP.
// The saved SP is restored by the generated rewind control.
struct capture_prefix {
    uintptr_t frame;
    uint32_t reserved;
    uintptr_t stack;
    uint32_t selector;
};

_Static_assert(sizeof(struct capture_prefix) == 16 &&
               offsetof(struct capture_prefix, stack) == 8,
               "continuation control prefix must match the instrumenter");

struct reference_slot {
    uint32_t kind;
    uint32_t index;
};

struct reference_vector {
    uint32_t size;
    uint32_t used;
    struct reference_slot slots[];
};

struct frame {
    struct frame *allocation_next;
    struct frame *caller;
    struct reference_vector *references;
    size_t size;
    _Alignas(16) unsigned char payload[];
};

struct kandelo_continuation {
    struct capture_prefix capture;
    struct frame *allocations;
    struct frame *pending;
    struct frame *cursor;
    struct kandelo_continuation *parent;
    enum phase phase;
    pthread_t owner;
    void *bottom;
    void *top;
    void (*entry)(void *);
    void *argument;
};

static _Thread_local struct kandelo_continuation *active;

static void require(bool condition)
{
    if (!condition)
        abort();
}

static void discard_capture(struct kandelo_continuation *ctx)
{
    struct frame *frame = ctx->allocations;
    while (frame) {
        struct frame *next = frame->allocation_next;
        struct reference_vector *vector = frame->references;
        if (vector) {
            for (uint32_t i = 0; i < vector->used; i++) {
                const struct reference_slot *slot = &vector->slots[i];
                if (slot->index)
                    __kandelo_continuation_clear_reference(slot->kind, slot->index);
            }
            free(vector);
        }
        free(frame);
        frame = next;
    }
    ctx->allocations = NULL;
    ctx->pending = NULL;
    ctx->cursor = NULL;
    ctx->capture.frame = 0;
    ctx->capture.stack = 0;
}

struct kandelo_continuation *kandelo_continuation_create(
    void *bottom, void *top, void (*entry)(void *), void *argument)
{
    if (!bottom || (uintptr_t)bottom >= (uintptr_t)top ||
        ((uintptr_t)top & 15) != 0 || !entry) {
        errno = EINVAL;
        return NULL;
    }
    struct kandelo_continuation *ctx = calloc(1, sizeof(*ctx));
    if (ctx) {
        ctx->bottom = bottom;
        ctx->top = top;
        ctx->entry = entry;
        ctx->argument = argument;
    }
    return ctx;
}

int kandelo_continuation_enter(struct kandelo_continuation *ctx)
{
    if (!ctx || (ctx->phase != FRESH && ctx->phase != SUSPENDED)) {
        errno = EINVAL;
        return -1;
    }
    const bool resume = ctx->phase == SUSPENDED;
    pthread_t thread = pthread_self();
    if (resume && !pthread_equal(ctx->owner, thread)) {
        errno = EXDEV;
        return -1;
    }
    ctx->owner = thread;
    ctx->parent = active;
    active = ctx;
    ctx->phase = resume ? REPLAYING : RUNNING;
    return __kandelo_continuation_dispatch(&ctx->capture, ctx->top, ctx->entry, ctx->argument, resume);
}

int kandelo_continuation_destroy(struct kandelo_continuation *ctx)
{
    if (!ctx)
        return 0;
    if (ctx->phase == SUSPENDED && !pthread_equal(ctx->owner, pthread_self())) {
        errno = EXDEV;
        return -1;
    }
    if (ctx->phase != FRESH && ctx->phase != SUSPENDED && ctx->phase != FINISHED) {
        errno = EBUSY;
        return -1;
    }
    discard_capture(ctx);
    free(ctx);
    return 0;
}

LINK_SYMBOL(dispatch_finish)
void __kandelo_continuation_dispatch_finish(int suspended)
{
    struct kandelo_continuation *ctx = active;
    require(ctx != NULL);
    if (suspended) {
        require(ctx->phase == CAPTURING && ctx->cursor && !ctx->pending);
        require(ctx->capture.stack >= (uintptr_t)ctx->bottom &&
                ctx->capture.stack <= (uintptr_t)ctx->top);
        ctx->phase = SUSPENDED;
    } else {
        require(ctx->phase == RUNNING);
        ctx->phase = FINISHED;
    }
    active = ctx->parent;
    ctx->parent = NULL;
}

LINK_SYMBOL(suspend)
__attribute__((noinline))
void kandelo_continuation_suspend(void)
{
    struct kandelo_continuation *ctx = active;
    require(ctx != NULL);
    if (ctx->phase == REPLAYING) {
        require(!ctx->cursor);
        __kandelo_continuation_rewind_end();
        ctx->phase = RUNNING;
        discard_capture(ctx);
        return;
    }
    require(ctx->phase == RUNNING && !ctx->allocations);
    ctx->phase = CAPTURING;
    __kandelo_continuation_unwind_begin(&ctx->capture);
}

LINK_SYMBOL(reserve)
void *__kandelo_continuation_reserve(size_t size)
{
    require(active && active->phase == CAPTURING && !active->pending);
    require(size >= sizeof(uint32_t) && size <= SIZE_MAX - sizeof(struct frame));
    // Alignment padding can be visited by a conservative language GC.
    struct frame *frame = calloc(1, sizeof(*frame) + size);
    require(frame != NULL);
    frame->allocation_next = active->allocations;
    frame->references = NULL;
    frame->size = size;
    active->allocations = frame;
    active->pending = frame;
    return frame->payload;
}

LINK_SYMBOL(commit)
void __kandelo_continuation_commit(void *payload)
{
    struct frame *frame = active->pending;
    require(frame && frame->payload == payload);
    frame->caller = active->cursor;
    active->cursor = frame;
    active->pending = NULL;
}

LINK_SYMBOL(peek)
void *__kandelo_continuation_peek(size_t size)
{
    struct frame *frame = active->cursor;
    require(frame && frame->size == size);
    return frame->payload;
}

LINK_SYMBOL(next)
void *__kandelo_continuation_next(size_t size)
{
    struct frame *frame = active->cursor;
    require(frame && frame->size == size);
    active->cursor = frame->caller;
    return frame->payload;
}

LINK_SYMBOL(resume_peek)
uint32_t __kandelo_continuation_resume_peek(uint32_t signature)
{
    (void)signature;
    if (!active->cursor)
        return 0;
    // The first word of every payload is the zero-based activation ordinal.
    uint32_t ordinal;
    __builtin_memcpy(&ordinal, active->cursor->payload, sizeof(ordinal));
    return ordinal + 1;
}

LINK_SYMBOL(vector_begin)
struct reference_vector *__kandelo_continuation_vector_begin(uint32_t size)
{
    struct frame *frame = active->pending;
    require(frame && !frame->references);
    require(size <= (SIZE_MAX - sizeof(struct reference_vector)) / sizeof(struct reference_slot));
    struct reference_vector *vector =
        calloc(1, sizeof(*vector) + size * sizeof(struct reference_slot));
    require(vector != NULL);
    vector->size = size;
    frame->references = vector;
    return vector;
}

LINK_SYMBOL(track_reference)
void __kandelo_continuation_track_reference(uint32_t kind, uint32_t index)
{
    struct reference_vector *vector = active->pending->references;
    require(vector && vector->used < vector->size && index);
    struct reference_slot *slot = &vector->slots[vector->used];
    require(!slot->index);
    slot->kind = kind;
    slot->index = index;
}

LINK_SYMBOL(vector_append)
void __kandelo_continuation_vector_append(struct reference_vector *vector, uint32_t index)
{
    require(vector == active->pending->references && vector->used < vector->size);
    require(vector->slots[vector->used].index == index);
    vector->used++;
}

LINK_SYMBOL(vector_finish)
struct reference_vector *__kandelo_continuation_vector_finish(struct reference_vector *vector)
{
    require(vector == active->pending->references && vector->used == vector->size);
    return vector;
}

LINK_SYMBOL(vector_get)
uint32_t __kandelo_continuation_vector_get(const struct reference_vector *vector, uint32_t position)
{
    require(vector && position < vector->used);
    return vector->slots[position].index;
}

void kandelo_continuation_visit_saved(
    const struct kandelo_continuation *ctx,
    void (*visit)(void *address, size_t size, void *argument),
    void *argument)
{
    if (ctx->phase != SUSPENDED)
        return;
    visit((void *)ctx->capture.stack, (uintptr_t)ctx->top - ctx->capture.stack, argument);
    for (struct frame *frame = ctx->allocations; frame; frame = frame->allocation_next)
        visit(frame->payload, frame->size, argument);
}
