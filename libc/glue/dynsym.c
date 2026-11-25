/*
 * Experimental guest-owned symbol lookup. Link explicitly for the
 * prototype. wasm-ld produces this segment when lookup survives link GC.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#ifdef KANDELO_DYNSYM_MAP
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>
#include "kandelo-loader-wire.h"
#endif

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

static _Thread_local char error_buffer[192];
static _Thread_local int error_pending;
static unsigned char main_handle;
static unsigned open_count;

static void set_error(const char *message, const char *name)
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

static int find_symbol(const unsigned char *base, size_t size, const char *name,
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

static int find_executable_symbol(const char *name, uintptr_t *address,
                                  uint32_t *kind, const char **definition)
{
    size_t size = (uintptr_t)__stop_kandelo_dynsym - (uintptr_t)__start_kandelo_dynsym;
    return find_symbol(__start_kandelo_dynsym, size, name, address, kind, definition);
}

#ifdef KANDELO_DYNSYM_MAP
_Static_assert(sizeof(void *) == 4, "the mapping prototype requires wasm32");

__attribute__((import_module("kandelo.loader.prototype.v1"), import_name("__kandelo_map_module_v1")))
extern int __kandelo_map_module_v1(uint32_t *, uint32_t, int);
extern void __wasm_posix_signal_checkpoint(void);

/* The start/attach path reads these exact bindings from the copied process. */
struct guest_binding {
    uint32_t slot;
    const char *export_name;
};
_Static_assert(sizeof(struct guest_binding) == 8, "binding vector row size");
struct guest_binding __kandelo_loader_bindings[KANDELO_LOADER_MAX_IMPORTS];

static struct {
    const unsigned char *index;
    size_t index_size;
    char *path;
    uint32_t table_base;
    uint32_t memory_base;
    unsigned references;
    int global;
} side;
static int side_busy;

static void *open_side(const char *path, int flags)
{
    if (__atomic_exchange_n(&side_busy, 1, __ATOMIC_ACQUIRE)) {
        set_error("guest module mapping is already active", 0);
        return 0;
    }
    void *result = 0;
    unsigned char *bytes = 0;
    unsigned char *metadata = 0;
    unsigned char *index = 0;
    char *path_copy = 0;
    int fd = -1;
    if (side.index) {
        unsigned references = __atomic_load_n(&side.references, __ATOMIC_RELAXED);
        if (strcmp(side.path, path) || references == UINT32_MAX) {
            set_error("prototype supports one mapped side module", 0);
            goto done;
        }
        if (flags & RTLD_GLOBAL) __atomic_store_n(&side.global, 1, __ATOMIC_RELEASE);
        __atomic_add_fetch(&side.references, 1, __ATOMIC_RELEASE);
        result = &side;
        goto done;
    }

    fd = open(path, O_RDONLY);
    struct stat file;
    if (fd < 0 || fstat(fd, &file) < 0 || file.st_size <= 0 ||
        file.st_size > 64 * 1024 * 1024) {
        set_error("cannot open side module: ", path);
        goto done;
    }
    uint32_t byte_count = file.st_size;
    uint32_t metadata_limit = 1024 * 1024;
    bytes = malloc(byte_count);
    metadata = malloc(metadata_limit);
    path_copy = strdup(path);
    if (!bytes || !metadata || !path_copy) {
        set_error("out of memory while opening side module: ", path);
        goto done;
    }
    size_t offset = 0;
    while (offset < byte_count) {
        ssize_t read_count = read(fd, bytes + offset, byte_count - offset);
        if (read_count < 0 && errno == EINTR) continue;
        if (read_count <= 0) {
            set_error("cannot read side module: ", path);
            goto done;
        }
        offset += read_count;
    }
    close(fd);
    fd = -1;

    uint32_t packet[] = {(uintptr_t)bytes, byte_count, (uintptr_t)metadata, metadata_limit};
    int inspected = __kandelo_map_module_v1(packet, sizeof(packet), KANDELO_LOADER_INSPECT);
    free(bytes);
    bytes = 0;
    if (inspected < 8 || (uint32_t)inspected > metadata_limit) {
        set_error("side module inspection failed: ", path);
        goto done;
    }

    uint32_t import_count, index_size;
    memcpy(&import_count, metadata, 4);
    memcpy(&index_size, metadata + 4, 4);
    if (import_count > KANDELO_LOADER_MAX_IMPORTS ||
        index_size < sizeof(struct dynsym_header) || index_size > (uint32_t)inspected - 8) {
        set_error("invalid side module metadata: ", path);
        goto done;
    }
    size_t index_start = inspected - index_size;
    offset = 8;
    for (uint32_t ordinal = 0; ordinal < import_count; ++ordinal) {
        uint32_t length, binding_kind;
        if (offset + 8 > index_start) {
            set_error("truncated side module imports: ", path);
            goto done;
        }
        memcpy(&length, metadata + offset, 4);
        memcpy(&binding_kind, metadata + offset + 4, 4);
        offset += 8;
        if (!length || length > index_start - offset || metadata[offset + length - 1] != 0) {
            set_error("invalid side module import: ", path);
            goto done;
        }
        const char *name = (const char *)metadata + offset;
        uint32_t kind;
        uintptr_t address;
        const char *definition;
        if (binding_kind < KANDELO_LOADER_BIND_DIRECT || binding_kind > KANDELO_LOADER_BIND_DATA ||
            find_executable_symbol(name, &address, &kind, &definition) != 1 ||
            kind != (binding_kind == KANDELO_LOADER_BIND_DATA ? 2u : 1u) ||
            (kind == 1 && !address)) {
            set_error("unresolved executable binding: ", name);
            goto done;
        }
        __kandelo_loader_bindings[ordinal] = (struct guest_binding){address, definition};
        offset += length;
    }
    if (offset != index_start) {
        set_error("invalid side module import length: ", path);
        goto done;
    }
    index = malloc(index_size);
    if (!index) {
        set_error("out of memory for side symbol index: ", path);
        goto done;
    }
    memcpy(index, metadata + index_start, index_size);
    free(metadata);
    metadata = 0;

    int transaction = __kandelo_map_module_v1(packet, sizeof(packet), KANDELO_LOADER_MAP);
    if (transaction <= 0) {
        set_error("side module mapping failed: ", path);
        goto done;
    }
    packet[0] = transaction;
    for (;;) {
        int entry = __kandelo_map_module_v1(packet, sizeof(packet), KANDELO_LOADER_ADVANCE);
        __wasm_posix_signal_checkpoint();
        if (entry < 0) {
            set_error("side module activation failed: ", path);
            goto done;
        }
        if (entry == 0) break;
        ((void (*)(void))(uintptr_t)entry)();
    }

    side.index = index;
    side.index_size = index_size;
    side.path = path_copy;
    side.table_base = packet[1];
    side.memory_base = packet[2];
    __atomic_store_n(&side.global, (flags & RTLD_GLOBAL) != 0, __ATOMIC_RELAXED);
    __atomic_store_n(&side.references, 1, __ATOMIC_RELEASE);
    index = 0;
    path_copy = 0;
    result = &side;

done:
    if (fd >= 0) close(fd);
    free(bytes);
    free(metadata);
    free(index);
    free(path_copy);
    __atomic_store_n(&side_busy, 0, __ATOMIC_RELEASE);
    return result;
}

static int find_side_symbol(const char *name, uintptr_t *address)
{
    uint32_t kind;
    int found = find_symbol(side.index, side.index_size, name, address, &kind, 0);
    if (found == 1) {
        uintptr_t base = kind == 1 ? side.table_base : side.memory_base;
        if (*address > UINTPTR_MAX - base) return -1;
        *address += base;
    }
    return found;
}
#endif

void *dlopen(const char *path, int flags)
{
    if (flags != RTLD_NOW && flags != RTLD_LAZY &&
        flags != (RTLD_NOW | RTLD_GLOBAL) && flags != (RTLD_LAZY | RTLD_GLOBAL)) {
        set_error("invalid dlopen flags", 0);
        return 0;
    }
    if (path) {
#ifdef KANDELO_DYNSYM_MAP
        return open_side(path, flags);
#else
        set_error("side modules are unavailable in the executable lookup prototype", 0);
        return 0;
#endif
    }
    unsigned count = __atomic_load_n(&open_count, __ATOMIC_RELAXED);
    do {
        if (count == UINT32_MAX) {
            set_error("main handle reference count exhausted", 0);
            return 0;
        }
    } while (!__atomic_compare_exchange_n(&open_count, &count, count + 1, 1,
                                          __ATOMIC_RELAXED, __ATOMIC_RELAXED));
    return &main_handle;
}

void *dlsym(void *handle, const char *name)
{
    if (handle == RTLD_NEXT) {
        set_error("RTLD_NEXT is unsupported", 0);
        return 0;
    }
    int global_scope = handle == RTLD_DEFAULT ||
        (handle == &main_handle && __atomic_load_n(&open_count, __ATOMIC_RELAXED));
    uintptr_t address = 0;
    uint32_t kind;
    int found;
    if (global_scope) {
        found = find_executable_symbol(name, &address, &kind, 0);
#ifdef KANDELO_DYNSYM_MAP
        if (!found && __atomic_load_n(&side.references, __ATOMIC_ACQUIRE) &&
            __atomic_load_n(&side.global, __ATOMIC_ACQUIRE))
            found = find_side_symbol(name, &address);
#endif
#ifdef KANDELO_DYNSYM_MAP
    } else if (handle == &side && __atomic_load_n(&side.references, __ATOMIC_ACQUIRE)) {
        found = find_side_symbol(name, &address);
#endif
    } else {
        set_error("invalid dynamic loader handle", 0);
        return 0;
    }

    if (found == 1)
        return (void *)address;
    if (found < 0) {
        set_error(found == -2 ? "TLS symbol lookup is unavailable: " : "invalid executable symbol index: ", name);
        return 0;
    }
    set_error("symbol not found: ", name);
    return 0;
}

int dlclose(void *handle)
{
#ifdef KANDELO_DYNSYM_MAP
    if (handle == &side) {
        unsigned count = __atomic_load_n(&side.references, __ATOMIC_RELAXED);
        while (count) {
            if (__atomic_compare_exchange_n(&side.references, &count, count - 1, 1,
                                            __ATOMIC_RELAXED, __ATOMIC_RELAXED))
                return 0;
        }
    }
#endif
    if (handle == &main_handle) {
        unsigned count = __atomic_load_n(&open_count, __ATOMIC_RELAXED);
        while (count) {
            if (__atomic_compare_exchange_n(&open_count, &count, count - 1, 1,
                                            __ATOMIC_RELAXED, __ATOMIC_RELAXED))
                return 0;
        }
    }
    set_error("invalid dynamic loader handle", 0);
    return -1;
}

char *dlerror(void)
{
    if (!error_pending)
        return 0;
    error_pending = 0;
    return error_buffer;
}
