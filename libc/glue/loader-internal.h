#ifndef KANDELO_LOADER_INTERNAL_H
#define KANDELO_LOADER_INTERNAL_H

#include <stddef.h>
#include <stdint.h>

#define LOADER_PUBLIC __attribute__((visibility("default")))
#define LOADER_INTERNAL __attribute__((visibility("hidden")))

struct loader_error {
    char text[192];
    int pending;
};

LOADER_INTERNAL extern _Thread_local struct loader_error __kandelo_loader_error;

struct loader_scope {
    void *(*lookup)(void *handle, int global_scope, const char *name);
    int (*close)(void *handle);
};

LOADER_INTERNAL void __kandelo_loader_set_error(const char *, const char *);
LOADER_INTERNAL int __kandelo_loader_find_symbol(const unsigned char *, size_t, const char *,
    uintptr_t *, uint32_t *, const char **);
LOADER_INTERNAL int __kandelo_loader_find_executable_symbol(const char *, uintptr_t *,
    uint32_t *, const char **);
LOADER_INTERNAL void *__kandelo_loader_open_main(void);
LOADER_INTERNAL void __kandelo_loader_set_scope(const struct loader_scope *);

#endif
