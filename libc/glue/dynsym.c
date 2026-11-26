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

__attribute__((import_module("kandelo.loader.prototype.v2"), import_name("__kandelo_map_module_v2")))
extern int __kandelo_map_module_v2(uint32_t *, uint32_t, int);
extern void __wasm_posix_signal_checkpoint(void);

struct guest_module;

/* The adapter reads this prefix from guest memory, including on fork attach.
 * A zero provider identifies the executable. Side providers are already mapped. */
struct guest_binding {
    uint32_t address;
    const char *export_name;
    const struct guest_module *provider;
};

struct guest_module {
    struct guest_binding *bindings;
    uint32_t binding_count;
    struct guest_module **dependencies;
    uint32_t dependency_count;
    const unsigned char *index;
    size_t index_size;
    char *path;
    uint32_t table_base;
    uint32_t memory_base;
    unsigned references;
    int global;
    int mapped;
    struct guest_module *next;
};
_Static_assert(sizeof(struct guest_binding) == 12, "binding vector row size");
_Static_assert(offsetof(struct guest_module, index) == 16, "mapping descriptor size");

static struct guest_module *modules;
static size_t module_count;
static int side_busy;

static int lock_modules(void)
{
    if (__atomic_exchange_n(&side_busy, 1, __ATOMIC_ACQUIRE)) {
        set_error("guest module mapping is already active", 0);
        return 0;
    }
    return 1;
}

static void unlock_modules(void)
{
    __atomic_store_n(&side_busy, 0, __ATOMIC_RELEASE);
}

static int find_module_symbol(const struct guest_module *module, const char *name,
                              uintptr_t *address, uint32_t *kind,
                              const char **definition)
{
    int found = find_symbol(module->index, module->index_size, name,
                            address, kind, definition);
    if (found == 1) {
        uintptr_t base = *kind == 1 ? module->table_base : module->memory_base;
        if (*address > UINTPTR_MAX - base) return -1;
        *address += base;
    }
    return found;
}

/* POSIX handle lookup walks the named object and its dependency closure in
 * breadth-first order. Deduplicate a dependency reached by several routes. */
static int find_in_scope(struct guest_module *const *roots, size_t root_count,
                         const char *name, uintptr_t *address, uint32_t *kind,
                         const char **definition,
                         const struct guest_module **provider)
{
    if (!root_count) return 0;
    struct guest_module **queue = calloc(module_count, sizeof(*queue));
    if (!queue) return -1;
    size_t read_index = 0;
    size_t end = 0;
    int found = 0;
    for (;;) {
        for (size_t i = 0; i < root_count; ++i) {
            size_t known = 0;
            while (known < end && queue[known] != roots[i]) ++known;
            if (known == end) queue[end++] = roots[i];
        }
        if (read_index == end) break;
        struct guest_module *module = queue[read_index++];
        found = find_module_symbol(module, name, address, kind, definition);
        if (found) {
            *provider = module;
            break;
        }
        roots = module->dependencies;
        root_count = module->dependency_count;
    }
    free(queue);
    return found;
}

static int find_global_symbol(const char *name, uintptr_t *address, uint32_t *kind,
                              const char **definition,
                              const struct guest_module **provider)
{
    int found = find_executable_symbol(name, address, kind, definition);
    if (found) return found;
    for (struct guest_module *module = modules; module; module = module->next) {
        if (module->mapped && module->global) {
            found = find_module_symbol(module, name, address, kind, definition);
            if (found) {
                *provider = module;
                return found;
            }
        }
    }
    return 0;
}

static char *join_path(const char *prefix, size_t prefix_length, const char *name)
{
    size_t length = strlen(name);
    if (prefix_length > SIZE_MAX - length - 1) return 0;
    char *path = malloc(prefix_length + length + 1);
    if (!path) return 0;
    memcpy(path, prefix, prefix_length);
    memcpy(path + prefix_length, name, length + 1);
    return path;
}

static struct guest_module *load_side(const char *path);

static struct guest_module *load_needed(const char *parent, const char *name)
{
    if (name[0] == '/') return load_side(name);
    const char *slash = strrchr(parent, '/');
    const char *prefixes[] = {parent, "/lib/", "/usr/lib/"};
    size_t lengths[] = {slash ? (size_t)(slash - parent) + 1 : 0, 5, 9};
    for (size_t i = 0; i < sizeof(lengths) / sizeof(lengths[0]); ++i) {
        char *path = join_path(prefixes[i], lengths[i], name);
        if (!path) {
            set_error("cannot allocate dependency path: ", name);
            return 0;
        }
        /* Search only for a present entry. A present but invalid candidate
         * reports its actual error instead of falling through to another file. */
        if (access(path, F_OK) == 0) {
            struct guest_module *loaded = load_side(path);
            free(path);
            return loaded;
        }
        free(path);
    }
    set_error("side module dependency not found: ", name);
    return 0;
}

static int read_word(const unsigned char *data, size_t end, size_t *offset,
                     uint32_t *word)
{
    if (*offset > end || end - *offset < sizeof(*word)) return 0;
    memcpy(word, data + *offset, sizeof(*word));
    *offset += sizeof(*word);
    return 1;
}

static const char *read_name(const unsigned char *data, size_t end, size_t *offset)
{
    uint32_t length;
    if (!read_word(data, end, offset, &length) || length < 2 ||
        length > end - *offset || memchr(data + *offset, 0, length) != data + *offset + length - 1)
        return 0;
    const char *name = (const char *)data + *offset;
    *offset += length;
    return name;
}

static int bind_imports(struct guest_module *module, const unsigned char *metadata,
                        size_t end, size_t imports)
{
    for (uint32_t i = 0; i < module->binding_count; ++i) {
        uint32_t binding_kind, kind;
        uintptr_t address;
        const char *definition;
        const struct guest_module *provider = 0;
        if (!read_word(metadata, end, &imports, &binding_kind)) return 0;
        const char *name = read_name(metadata, end, &imports);
        if (!name || binding_kind < KANDELO_LOADER_BIND_DIRECT ||
            binding_kind > KANDELO_LOADER_BIND_DATA) return 0;
        int found = find_global_symbol(name, &address, &kind, &definition, &provider);
        if (found == 0)
            found = find_in_scope(module->dependencies, module->dependency_count,
                                  name, &address, &kind, &definition, &provider);
        if (found != 1 || kind != (binding_kind == KANDELO_LOADER_BIND_DATA ? 2u : 1u) ||
            (kind == 1 && !address)) {
            set_error("unresolved side module binding: ", name);
            return 0;
        }
        module->bindings[i] = (struct guest_binding){address, definition, provider};
    }
    return imports == end;
}

static struct guest_module *load_side(const char *path)
{
    struct guest_module **link = &modules;
    for (; *link; link = &(*link)->next) {
        if (!strcmp((*link)->path, path)) {
            if ((*link)->mapped) return *link;
            set_error("cyclic side module dependency: ", path);
            return 0;
        }
    }

    struct guest_module *module = calloc(1, sizeof(*module));
    unsigned char *bytes = 0, *metadata = 0;
    int fd = -1;
    if (!module || !(module->path = strdup(path))) {
        set_error("cannot allocate side module: ", path);
        goto fail;
    }
    *link = module;
    ++module_count;

    fd = open(path, O_RDONLY);
    struct stat file;
    if (fd < 0 || fstat(fd, &file) < 0 || file.st_size <= 0 ||
        file.st_size > 64 * 1024 * 1024) {
        set_error("cannot open side module: ", path);
        goto fail;
    }
    uint32_t byte_count = file.st_size;
    const uint32_t metadata_limit = 1024 * 1024;
    bytes = malloc(byte_count);
    metadata = malloc(metadata_limit);
    if (!bytes || !metadata) {
        set_error("cannot allocate side module metadata: ", path);
        goto fail;
    }

    size_t offset = 0;
    while (offset < byte_count) {
        ssize_t count = read(fd, bytes + offset, byte_count - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) {
            set_error("cannot read side module: ", path);
            goto fail;
        }
        offset += count;
    }
    close(fd);
    fd = -1;

    uint32_t packet[] = {(uintptr_t)bytes, byte_count, (uintptr_t)metadata, metadata_limit};
    int size = __kandelo_map_module_v2(packet, sizeof(packet), KANDELO_LOADER_INSPECT);
    if (size < 12 || (uint32_t)size > metadata_limit) {
        set_error("side module inspection failed: ", path);
        goto fail;
    }

    uint32_t index_size;
    offset = 0;
    if (!read_word(metadata, size, &offset, &module->binding_count) ||
        !read_word(metadata, size, &offset, &index_size) ||
        !read_word(metadata, size, &offset, &module->dependency_count) ||
        module->binding_count > KANDELO_LOADER_MAX_IMPORTS ||
        module->dependency_count > KANDELO_LOADER_MAX_IMPORTS ||
        index_size < sizeof(struct dynsym_header) || index_size > (uint32_t)size - offset)
        goto invalid;

    size_t end = size - index_size;
    // A valid edge list fits before the import list. Traverse it in the guest.
    if (module->dependency_count) {
        module->dependencies = calloc(module->dependency_count, sizeof(*module->dependencies));
        if (!module->dependencies) goto allocation_failure;
    }
    for (uint32_t i = 0; i < module->dependency_count; ++i) {
        const char *name = read_name(metadata, end, &offset);
        if (!name) goto invalid;
        module->dependencies[i] = load_needed(path, name);
        if (!module->dependencies[i]) goto fail;
    }
    if (module->binding_count) {
        module->bindings = calloc(module->binding_count, sizeof(*module->bindings));
        if (!module->bindings) goto allocation_failure;
    }
    if (!bind_imports(module, metadata, end, offset)) {
        if (!error_pending) set_error("invalid side module imports: ", path);
        goto fail;
    }
    unsigned char *index = malloc(index_size);
    if (!index) goto allocation_failure;
    memcpy(index, metadata + end, index_size);
    module->index = index;
    module->index_size = index_size;

    packet[2] = (uintptr_t)module;
    packet[3] = 0;
    int transaction = __kandelo_map_module_v2(packet, sizeof(packet), KANDELO_LOADER_MAP);
    if (transaction <= 0) {
        set_error("side module mapping failed: ", path);
        goto fail;
    }
    free(bytes);
    bytes = 0;
    free(metadata);
    metadata = 0;
    packet[0] = transaction;
    for (;;) {
        int entry = __kandelo_map_module_v2(packet, sizeof(packet), KANDELO_LOADER_ADVANCE);
        __wasm_posix_signal_checkpoint();
        if (entry < 0) {
            set_error("side module activation failed: ", path);
            goto fail;
        }
        if (entry == 0) break;
        ((void (*)(void))(uintptr_t)entry)();
    }
    module->table_base = packet[1];
    module->memory_base = packet[2];
    module->mapped = 1;
    return module;

invalid:
    set_error("invalid side module metadata: ", path);
    goto fail;
allocation_failure:
    set_error("cannot allocate side module bindings: ", path);
fail:
    if (fd >= 0) close(fd);
    free(bytes);
    free(metadata);
    if (module) {
        if (*link == module) {
            *link = module->next;
            --module_count;
        }
        free((void *)module->index);
        free(module->bindings);
        free(module->dependencies);
        free(module->path);
        free(module);
    }
    return 0;
}

static void promote_global(struct guest_module *module)
{
    if (module->global) return;
    module->global = 1;
    for (uint32_t i = 0; i < module->dependency_count; ++i)
        promote_global(module->dependencies[i]);
}

static void *open_side(const char *path, int flags)
{
    if (!lock_modules()) return 0;
    struct guest_module *module = load_side(path);
    if (module) {
        if (module->references == UINT32_MAX) {
            set_error("side module reference count exhausted: ", path);
            module = 0;
        } else {
            if (flags & RTLD_GLOBAL) promote_global(module);
            ++module->references;
        }
    }
    unlock_modules();
    return module;
}

static struct guest_module *resolve_handle(const void *handle)
{
    for (struct guest_module *module = modules; module; module = module->next)
        if (module == handle && module->mapped && module->references) return module;
    return 0;
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
    if (!name) {
        set_error("invalid dynamic symbol name", 0);
        return 0;
    }
#ifdef KANDELO_DYNSYM_MAP
    if (!lock_modules()) return 0;
    const struct guest_module *provider = 0;
    if (global_scope) {
        found = find_global_symbol(name, &address, &kind, 0, &provider);
    } else {
        struct guest_module *module = resolve_handle(handle);
        if (!module) {
            unlock_modules();
            set_error("invalid dynamic loader handle", 0);
            return 0;
        }
        found = find_in_scope(&module, 1, name, &address, &kind, 0, &provider);
    }
    unlock_modules();
#else
    if (!global_scope) {
        set_error("invalid dynamic loader handle", 0);
        return 0;
    }
    found = find_executable_symbol(name, &address, &kind, 0);
#endif

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
    if (handle != &main_handle) {
        if (!lock_modules()) return -1;
        struct guest_module *module = resolve_handle(handle);
        if (module) --module->references;
        unlock_modules();
        if (module) return 0;
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
