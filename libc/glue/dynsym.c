/* Symbol lookup against the linker-emitted executable index. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>
#include "loader-internal.h"

struct dynsym_header {
    unsigned char magic[4];
    uint32_t size;
    uint32_t count;
    uint32_t reserved;
};

struct dynsym_entry {
    uint32_t name;
    uint32_t kind;
    uint64_t value;
};

_Static_assert(sizeof(struct dynsym_header) == 16, "dynsym header size");
_Static_assert(sizeof(struct dynsym_entry) == 16, "dynsym entry size");

extern const unsigned char __start_kandelo_dynsym[];
extern const unsigned char __stop_kandelo_dynsym[];

_Thread_local struct loader_error __kandelo_loader_error;
#define error_buffer __kandelo_loader_error.text
#define error_pending __kandelo_loader_error.pending

static void *const main_handle = (void *)(uintptr_t)1;
static unsigned open_count;

void __kandelo_loader_set_error(const char *message, const char *name)
{
    size_t length = strlen(message);
    memcpy(error_buffer, message, length);
    if (name) {
        size_t count = strnlen(name, sizeof(error_buffer) - 1 - length);
        memcpy(error_buffer + length, name, count);
        length += count;
    }
    error_buffer[length] = 0;
    error_pending = 1;
}

int __kandelo_loader_find_symbol(const unsigned char *base, size_t size, const char *name,
                       uintptr_t *address, uint32_t *kind, const char **definition)
{
    struct dynsym_header header;
    if (size < sizeof(header)) return -1;
    memcpy(&header, base, sizeof(header));
    if (memcmp(header.magic, "KDS1", 4) ||
        header.size != size || header.reserved != 0 ||
        header.count > (size - sizeof(header)) / sizeof(struct dynsym_entry))
        return -1;

    size_t string_start = sizeof(header) + header.count * sizeof(struct dynsym_entry);
    size_t first = 0;
    size_t end = header.count;
    while (first < end) {
        size_t middle = first + (end - first) / 2;
        struct dynsym_entry entry;
        memcpy(&entry, base + sizeof(header) + middle * sizeof(entry), sizeof(entry));
        if (entry.name < string_start || entry.name >= size)
            return -1;

        const char *candidate = (const char *)base + entry.name;
        if (!memchr(candidate, 0, size - entry.name))
            return -1;

        int order = strcmp(name, candidate);
        if (order < 0) {
            end = middle;
        } else if (order > 0) {
            first = middle + 1;
        } else {
            if (entry.kind == 3)
                return -2; /* A TLS offset needs the calling thread's base. */
            if ((entry.kind != 1 && entry.kind != 2) || entry.value > UINTPTR_MAX)
                return -1;
            *address = entry.value;
            *kind = entry.kind;
            if (definition) *definition = candidate;
            return 1;
        }
    }
    return 0;
}

int __kandelo_loader_find_executable_symbol(const char *name, uintptr_t *address,
                                  uint32_t *kind, const char **definition)
{
    size_t size = (uintptr_t)__stop_kandelo_dynsym - (uintptr_t)__start_kandelo_dynsym;
    return __kandelo_loader_find_symbol(__start_kandelo_dynsym, size, name, address, kind, definition);
}

static const struct loader_scope *side_scope;

void __kandelo_loader_set_scope(const struct loader_scope *scope)
{
    __atomic_store_n(&side_scope, scope, __ATOMIC_RELEASE);
}

void *__kandelo_loader_open_main(void)
{
    unsigned count = __atomic_load_n(&open_count, __ATOMIC_RELAXED);
    do {
        if (count == UINT32_MAX) {
            __kandelo_loader_set_error("main handle reference count exhausted", 0);
            return 0;
        }
    } while (!__atomic_compare_exchange_n(&open_count, &count, count + 1, 1,
                                          __ATOMIC_RELAXED, __ATOMIC_RELAXED));
    return main_handle;
}

LOADER_PUBLIC void *dlsym(void *handle, const char *name)
{
    if (handle == RTLD_NEXT) {
        __kandelo_loader_set_error("RTLD_NEXT is unsupported", 0);
        return 0;
    }
    if (!name) {
        __kandelo_loader_set_error("invalid dynamic symbol name", 0);
        return 0;
    }

    int global_scope = handle == RTLD_DEFAULT ||
        (handle == main_handle && __atomic_load_n(&open_count, __ATOMIC_RELAXED));
    if (global_scope) {
        uintptr_t address = 0;
        uint32_t kind;
        int found = __kandelo_loader_find_executable_symbol(name, &address, &kind, 0);
        if (found == 1) return (void *)address;
        if (found < 0) {
            __kandelo_loader_set_error(found == -2 ?
                "TLS symbol lookup is unavailable: " : "invalid executable symbol index: ", name);
            return 0;
        }
    }

    const struct loader_scope *scope = __atomic_load_n(&side_scope, __ATOMIC_ACQUIRE);
    if (scope && (handle != main_handle || global_scope))
        return scope->lookup(handle, global_scope, name);
    __kandelo_loader_set_error(global_scope ? "symbol not found: " :
        "invalid dynamic loader handle", global_scope ? name : 0);
    return 0;
}

LOADER_PUBLIC int dlclose(void *handle)
{
    if (handle == main_handle) {
        unsigned count = __atomic_load_n(&open_count, __ATOMIC_RELAXED);
        while (count) {
            if (__atomic_compare_exchange_n(&open_count, &count, count - 1, 1,
                                            __ATOMIC_RELAXED, __ATOMIC_RELAXED))
                return 0;
        }
    } else {
        const struct loader_scope *scope = __atomic_load_n(&side_scope, __ATOMIC_ACQUIRE);
        if (scope) return scope->close(handle);
    }
    __kandelo_loader_set_error("invalid dynamic loader handle", 0);
    return -1;
}

LOADER_PUBLIC char *dlerror(void)
{
    if (!error_pending)
        return 0;
    error_pending = 0;
    return error_buffer;
}
