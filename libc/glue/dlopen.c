/* Guest-owned named-module mapping and lifetime. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "kandelo-loader-wire.h"
#include "loader-internal.h"

__attribute__((import_module("kandelo.loader.v1"), import_name("__kandelo_map_module_v1")))
extern int __kandelo_map_module_v1(uintptr_t *, uint32_t, int);
extern void __wasm_posix_signal_checkpoint(void);
extern void __cxa_finalize(void *);

enum module_state { LOADING, ACTIVE, FINALIZING };

struct guest_module;

/* The adapter reads this prefix from guest memory, including on fork attach.
 * A zero provider identifies the executable. Side providers are already mapped. */
struct guest_binding {
    uintptr_t address;
    const char *export_name;
    struct guest_module *provider;
};

struct guest_module {
    struct guest_binding *bindings;
    struct guest_module **dependencies;
    uint32_t binding_count;
    uint32_t dependency_count;
    uint32_t generation;
    const unsigned char *index;
    size_t index_size;
    char *path;
    uintptr_t table_base;
    uintptr_t memory_base;
    dev_t device;
    ino_t inode;
    int global;
    int reachable;
    enum module_state state;
    void *handle;
    unsigned references;
    struct guest_module *next;
};
_Static_assert(sizeof(struct guest_binding) == 3 * sizeof(void *), "binding vector row size");
_Static_assert(offsetof(struct guest_module, generation) == 2 * sizeof(void *) + 8,
               "mapping descriptor generation offset");

static struct guest_module *modules;
static size_t module_count;
static uint32_t generation;
static uintptr_t table_high_water;
static uintptr_t next_handle = 2;
static pthread_mutex_t modules_mutex = PTHREAD_MUTEX_INITIALIZER;
static _Thread_local unsigned lock_depth;

static int lock_modules(void)
{
    if (lock_depth == 0) {
        if (pthread_mutex_lock(&modules_mutex)) {
            __kandelo_loader_set_error("cannot lock the dynamic loader", 0);
            return 0;
        }
    }
    ++lock_depth;
    return 1;
}

static void unlock_modules(void)
{
    if (--lock_depth == 0) pthread_mutex_unlock(&modules_mutex);
}

/* The caller may already own the registry from a side initializer.
 * Pthread waiters from the parent cannot exist in the child's copy. */
static void lock_before_fork(void)
{
    if (!lock_modules()) abort();
}

static void reset_after_fork(void)
{
    pthread_mutex_t unlocked = PTHREAD_MUTEX_INITIALIZER;
    modules_mutex = unlocked;
    if (--lock_depth && pthread_mutex_lock(&modules_mutex)) abort();
}

__attribute__((constructor(101)))
static void register_loader_atfork(void)
{
    if (pthread_atfork(lock_before_fork, unlock_modules, reset_after_fork)) abort();
}

static void unlink_module(struct guest_module *module)
{
    struct guest_module **link = &modules;
    while (*link != module) link = &(*link)->next;
    *link = module->next;
    module->next = 0;
    --module_count;
}

static void append_module(struct guest_module *module)
{
    struct guest_module **link = &modules;
    while (*link) link = &(*link)->next;
    *link = module;
    ++module_count;
}

static void destroy_module_record(struct guest_module *module)
{
    free((void *)module->index);
    free(module->bindings);
    free(module->dependencies);
    free(module->path);
    free(module);
}

static void retain_module(struct guest_module *module)
{
    if (!module || module->reachable) return;
    module->reachable = 1;
    if (module->dependencies) {
        for (uint32_t i = 0; i < module->dependency_count; ++i)
            retain_module(module->dependencies[i]);
    }
    if (module->bindings) {
        for (uint32_t i = 0; i < module->binding_count; ++i)
            retain_module(module->bindings[i].provider);
    }
}

/* The guest chooses retirement from explicit references and recorded edges.
 * Newest first keeps each consumer alive through its own finalizer. */
static int collect_modules(void)
{
    for (;;) {
        for (struct guest_module *module = modules; module; module = module->next)
            module->reachable = 0;
        for (struct guest_module *module = modules; module; module = module->next)
            if (module->references || module->state != ACTIVE)
                retain_module(module);
        struct guest_module *dead = 0;
        for (struct guest_module *module = modules; module; module = module->next)
            if (!module->reachable) dead = module;
        if (!dead) return 0;

        dead->state = FINALIZING;
        if (dead->memory_base) __cxa_finalize((void *)(uintptr_t)dead->memory_base);
        uintptr_t packet[] = {(uintptr_t)dead, 0, 0, 0};
        if (__kandelo_map_module_v1(packet, sizeof(packet), KANDELO_LOADER_RETIRE) < 0) {
            __kandelo_loader_set_error("cannot retire side module: ", dead->path);
            return -1;
        }
        unlink_module(dead);
        destroy_module_record(dead);
    }
}

static int find_module_symbol(const struct guest_module *module, const char *name,
                              uintptr_t *address, uint32_t *kind,
                              const char **definition)
{
    int found = __kandelo_loader_find_symbol(module->index, module->index_size, name,
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
                         struct guest_module **provider)
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

static int find_side_global_symbol(const char *name, uintptr_t *address, uint32_t *kind,
                              const char **definition,
                              struct guest_module **provider)
{
    int found;
    for (struct guest_module *module = modules; module; module = module->next) {
        if (module->state == ACTIVE && module->global) {
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
    const char *prefixes[] = {parent, "/lib/", "/usr/lib/", "/usr/local/lib/"};
    size_t lengths[] = {slash ? (size_t)(slash - parent) + 1 : 0, 5, 9, 15};
    for (size_t i = 0; i < sizeof(lengths) / sizeof(lengths[0]); ++i) {
        char *path = join_path(prefixes[i], lengths[i], name);
        if (!path) {
            __kandelo_loader_set_error("cannot allocate dependency path: ", name);
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
    __kandelo_loader_set_error("side module dependency not found: ", name);
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
        struct guest_module *provider = 0;
        if (!read_word(metadata, end, &imports, &binding_kind)) return 0;
        int weak = binding_kind & KANDELO_LOADER_BIND_WEAK;
        binding_kind &= ~KANDELO_LOADER_BIND_WEAK;
        const char *name = read_name(metadata, end, &imports);
        if (!name || binding_kind < KANDELO_LOADER_BIND_DIRECT ||
            binding_kind > KANDELO_LOADER_BIND_DATA) return 0;
        int found = __kandelo_loader_find_executable_symbol(name, &address, &kind, &definition);
        if (found == 0)
            found = find_side_global_symbol(name, &address, &kind, &definition, &provider);
        if (found == 0 && binding_kind != KANDELO_LOADER_BIND_DIRECT) {
            found = __kandelo_loader_find_symbol(module->index, module->index_size,
                                                name, &address, &kind, &definition);
            if (found == 1) provider = module;
        }
        if (found == 0)
            found = find_in_scope(module->dependencies, module->dependency_count,
                                  name, &address, &kind, &definition, &provider);
        if (found == 0 && weak) continue;
        if (found != 1 || kind != (binding_kind == KANDELO_LOADER_BIND_DATA ? 2u : 1u) ||
            (kind == 1 && !address && provider != module)) {
            __kandelo_loader_set_error("unresolved side module binding: ", name);
            return 0;
        }
        module->bindings[i] = (struct guest_binding){address, definition, provider};
    }
    return imports == end;
}

static struct guest_module *existing_module(struct guest_module *module, const char *path)
{
    if (module->state == ACTIVE) return module;
    __kandelo_loader_set_error("cyclic or reentrant side module dependency: ", path);
    return 0;
}

static struct guest_module *load_side(const char *path)
{
    if (path[0] == '/') {
        for (struct guest_module *module = modules; module; module = module->next)
            if (!strcmp(module->path, path)) return existing_module(module, path);
    }

    struct guest_module *module = 0;
    unsigned char *bytes = 0, *metadata = 0;
    int fd = open(path, O_RDONLY);
    int linked = 0;
    struct stat file;
    if (fd < 0 || fstat(fd, &file) < 0 || file.st_size <= 0 ||
        file.st_size > 64 * 1024 * 1024) {
        __kandelo_loader_set_error("cannot open side module: ", path);
        goto fail;
    }
    for (struct guest_module *candidate = modules; candidate; candidate = candidate->next) {
        if (candidate->device == file.st_dev && candidate->inode == file.st_ino) {
            close(fd);
            return existing_module(candidate, path);
        }
    }
    module = calloc(1, sizeof(*module));
    if (!module || !(module->path = strdup(path))) {
        __kandelo_loader_set_error("cannot allocate side module: ", path);
        goto fail;
    }
    module->device = file.st_dev;
    module->inode = file.st_ino;
    append_module(module);
    linked = 1;

    uint32_t byte_count = file.st_size;
    const uint32_t metadata_limit = 1024 * 1024;
    bytes = malloc(byte_count);
    metadata = malloc(metadata_limit);
    if (!bytes || !metadata) {
        __kandelo_loader_set_error("cannot allocate side module metadata: ", path);
        goto fail;
    }

    size_t offset = 0;
    while (offset < byte_count) {
        ssize_t count = read(fd, bytes + offset, byte_count - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) {
            __kandelo_loader_set_error("cannot read side module: ", path);
            goto fail;
        }
        offset += count;
    }
    close(fd);
    fd = -1;

    uintptr_t packet[] = {(uintptr_t)bytes, byte_count, (uintptr_t)metadata, metadata_limit};
    int size = __kandelo_map_module_v1(packet, sizeof(packet), KANDELO_LOADER_INSPECT);
    if (size == -ENOEXEC) {
        __kandelo_loader_set_error(sizeof(uintptr_t) == 8
            ? "rebuild as a wasm64 Kandelo loader v1 side module: "
            : "rebuild as a wasm32 Kandelo loader v1 side module: ", path);
        goto fail;
    }
    if (size < 12 || (uint32_t)size > metadata_limit) {
        __kandelo_loader_set_error("side module inspection failed: ", path);
        goto fail;
    }

    uint32_t index_size;
    offset = 0;
    if (!read_word(metadata, size, &offset, &module->binding_count) ||
        !read_word(metadata, size, &offset, &index_size) ||
        !read_word(metadata, size, &offset, &module->dependency_count) ||
        module->binding_count > KANDELO_LOADER_MAX_IMPORTS ||
        module->dependency_count > KANDELO_LOADER_MAX_IMPORTS ||
        index_size < 16 || index_size > (uint32_t)size - offset)
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
    unsigned char *index = malloc(index_size);
    if (!index) goto allocation_failure;
    memcpy(index, metadata + end, index_size);
    module->index = index;
    module->index_size = index_size;
    if (module->binding_count) {
        module->bindings = calloc(module->binding_count, sizeof(*module->bindings));
        if (!module->bindings) goto allocation_failure;
    }
    if (!bind_imports(module, metadata, end, offset)) {
        if (!__kandelo_loader_error.pending) __kandelo_loader_set_error("invalid side module imports: ", path);
        goto fail;
    }


    if (generation == UINT32_MAX) {
        __kandelo_loader_set_error("side module generation exhausted", 0);
        goto fail;
    }
    module->generation = ++generation;
    packet[2] = (uintptr_t)module;
    packet[3] = table_high_water;
    int transaction = __kandelo_map_module_v1(packet, sizeof(packet), KANDELO_LOADER_MAP);
    if (transaction <= 0) {
        __kandelo_loader_set_error("side module mapping failed: ", path);
        goto fail;
    }
    free(bytes);
    bytes = 0;
    free(metadata);
    metadata = 0;
    packet[0] = transaction;
    for (;;) {
        int entry = __kandelo_map_module_v1(packet, sizeof(packet), KANDELO_LOADER_ADVANCE);
        if (packet[3] > table_high_water) table_high_water = packet[3];
        __wasm_posix_signal_checkpoint();
        if (entry < 0) {
            __kandelo_loader_set_error("side module activation failed: ", path);
            goto fail;
        }
        if (entry == 0) break;
        ((void (*)(void))(uintptr_t)entry)();
    }
    module->table_base = packet[1];
    module->memory_base = packet[2];
    module->state = ACTIVE;
    unlink_module(module);
    append_module(module);
    return module;

invalid:
    __kandelo_loader_set_error("invalid side module metadata: ", path);
    goto fail;
allocation_failure:
    __kandelo_loader_set_error("cannot allocate side module bindings: ", path);
fail:
    if (fd >= 0) close(fd);
    free(bytes);
    free(metadata);
    if (module) {
        if (linked) unlink_module(module);
        destroy_module_record(module);
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
    struct guest_module *module = strchr(path, '/') ?
        load_side(path) : load_needed("", path);
    void *handle = 0;
    if (module) {
        if (module->references == UINT32_MAX) {
            __kandelo_loader_set_error("side module reference count exhausted: ", path);
        } else {
            if (!module->references) {
                if (next_handle == UINTPTR_MAX) {
                    __kandelo_loader_set_error("dynamic loader handle space exhausted", 0);
                    goto finish;
                }
                module->handle = (void *)next_handle++;
            }
            if (flags & RTLD_GLOBAL) promote_global(module);
            ++module->references;
            handle = module->handle;
        }
    }
finish:
    if (!handle) {
        struct loader_error error = __kandelo_loader_error;
        collect_modules();
        __kandelo_loader_error = error;
    }
    unlock_modules();
    return handle;
}

static struct guest_module *resolve_handle(const void *handle)
{
    for (struct guest_module *module = modules; module; module = module->next)
        if (module->handle == handle && module->state == ACTIVE && module->references) return module;
    return 0;
}
static void *lookup_side(void *handle, int global_scope, const char *name)
{
    if (!lock_modules()) return 0;
    uintptr_t address = 0;
    uint32_t kind;
    struct guest_module *provider = 0;
    int found;
    if (global_scope) {
        found = find_side_global_symbol(name, &address, &kind, 0, &provider);
    } else {
        struct guest_module *module = resolve_handle(handle);
        if (!module) {
            unlock_modules();
            __kandelo_loader_set_error("invalid dynamic loader handle", 0);
            return 0;
        }
        found = find_module_symbol(module, name, &address, &kind, 0);
        if (found == 0)
            found = find_in_scope(module->dependencies, module->dependency_count,
                                  name, &address, &kind, 0, &provider);
    }
    unlock_modules();
    if (found == 1) return (void *)address;
    __kandelo_loader_set_error(found < 0 ? "invalid side symbol index: " : "symbol not found: ", name);
    return 0;
}

static int close_side(void *handle)
{
    if (!lock_modules()) return -1;
    struct guest_module *module = resolve_handle(handle);
    if (!module) {
        unlock_modules();
        __kandelo_loader_set_error("invalid dynamic loader handle", 0);
        return -1;
    }
    --module->references;
    int status = collect_modules();
    unlock_modules();
    return status;
}

LOADER_PUBLIC void *dlopen(const char *path, int flags)
{
    if (flags != RTLD_NOW && flags != RTLD_LAZY &&
        flags != (RTLD_NOW | RTLD_GLOBAL) && flags != (RTLD_LAZY | RTLD_GLOBAL)) {
        __kandelo_loader_set_error("invalid dlopen flags", 0);
        return 0;
    }
    if (!path) return __kandelo_loader_open_main();
    static const struct loader_scope scope = { lookup_side, close_side };
    __kandelo_loader_set_scope(&scope);
    return open_side(path, flags);
}
