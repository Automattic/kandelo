#include "link.h"

LINK_SYMBOL(unwind_begin)
void __kandelo_continuation_unwind_begin(void *record) { __builtin_trap(); }

LINK_SYMBOL(unwind_end)
void __kandelo_continuation_unwind_end(void) { __builtin_trap(); }

LINK_SYMBOL(rewind_begin)
void __kandelo_continuation_rewind_begin(void *record) { __builtin_trap(); }

LINK_SYMBOL(rewind_end)
void __kandelo_continuation_rewind_end(void) { __builtin_trap(); }

LINK_SYMBOL(dispatch_v1)
int __kandelo_continuation_dispatch(
    void *record, void *top, void (*entry)(void *), void *argument, int resume)
{
    __builtin_trap();
}

LINK_SYMBOL(clear_reference)
void __kandelo_continuation_clear_reference(uint32_t kind, uint32_t index)
{
    __builtin_trap();
}
