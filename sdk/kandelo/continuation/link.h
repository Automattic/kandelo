#ifndef KANDELO_CONTINUATION_LINK_H
#define KANDELO_CONTINUATION_LINK_H

#include <stdint.h>

// These private linker exports are consumed before process-fork analysis.
// Compile the placeholders separately from the C provider so the compiler
// cannot propagate their deliberately trapping pre-instrumentation bodies.
#define LINK_SYMBOL(name) \
    __attribute__((export_name("__kandelo_local_continuation_" #name)))

void __kandelo_continuation_unwind_begin(void *record);
void __kandelo_continuation_unwind_end(void);
void __kandelo_continuation_rewind_begin(void *record);
void __kandelo_continuation_rewind_end(void);
int __kandelo_continuation_dispatch(
    void *record, void *top, void (*entry)(void *), void *argument, int resume);
void __kandelo_continuation_clear_reference(uint32_t kind, uint32_t index);

#endif
