/*
 * __wasm_thread_init.c -- Thread worker initialization entry point.
 *
 * Called by the host when a thread worker starts. Sets the thread
 * pointer to the TLS block allocated by pthread_create, then calls
 * the thread entry function.
 *
 * Exported from the user program module so the host can call it.
 */

extern _Thread_local unsigned long __wasm_thread_pointer;

/* Exported: host calls this to set TP before invoking the thread function */
__attribute__((visibility("default")))
void __wasm_thread_init(unsigned long tp)
{
    __wasm_thread_pointer = tp;
}
