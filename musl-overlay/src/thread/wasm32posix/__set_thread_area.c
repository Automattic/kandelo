/*
 * __set_thread_area.c -- Wasm arch-specific thread area setup.
 *
 * Sets the thread pointer global variable. Returning 0 enables
 * libc.can_do_threads = 1 in __init_tp(), unblocking pthread_create.
 */
#include "pthread_impl.h"

extern unsigned long __wasm_thread_pointer;

int __set_thread_area(void *p)
{
    __wasm_thread_pointer = (unsigned long)p;
    return 0;
}
