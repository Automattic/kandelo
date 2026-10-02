/* C API of rustlib/ (the kandelo-interop crate). */
#ifndef KANDELO_INTEROP_H
#define KANDELO_INTEROP_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

uint64_t interop_u128_muldiv(uint64_t a, uint64_t b, uint64_t d);
char *interop_greeting(const char *name);
void interop_free_string(char *s);
int interop_apply(int (*f)(int), int x);
int interop_last_errno(void);
void interop_setenv(const char *key, const char *value);
int interop_write_file(const char *path, const char *text);
uint64_t interop_parallel_sum(uint32_t threads, uint32_t per_thread);

#ifdef __cplusplus
}
#endif

#endif
