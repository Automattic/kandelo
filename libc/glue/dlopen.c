/**
 * dlopen/dlsym/dlclose/dlerror implementation for WebAssembly dynamic linking.
 *
 * This replaces musl's ELF-based dynamic linker stubs with Wasm-native
 * implementations that use host imports for the actual Wasm module
 * compilation and instantiation.
 *
 * Flow:
 *   1. dlopen() reads the .so file via normal open/read/close syscalls
 *   2. Calls __wasm_dlopen_prepare() with the bytes in memory
 *   3. Host returns a private transaction token without entering guest code
 *   4. Each next step performs host-only compilation/instantiation as needed,
 *      then libc calls the returned initialization entry through the process
 *      table until the host atomically returns the public handle
 *   5. dlsym() calls __wasm_dlsym() host import to look up symbols
 *   6. For functions: returns the table index (== C function pointer)
 *   7. For data: returns the relocated memory address
 */

#include <stddef.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <stdlib.h>
#include <stdint.h>

/* Host imports — implemented in worker-main.ts */
extern int __wasm_dlopen_main(void);
extern int __wasm_dlopen_prepare(const void *bytes, int len,
                                 const char *name, int name_len, int flags);
extern int __wasm_dlopen_next(int transaction, int *handle);
extern int __wasm_dlsym(int handle, const char *name, int name_len);
extern int __wasm_dlclose(int handle);
extern int __wasm_dlerror(char *buf, int buf_max);
extern void __wasm_posix_signal_checkpoint(void);

/* RTLD flags (match musl dlfcn.h) */
#ifndef RTLD_LAZY
#define RTLD_LAZY   1
#define RTLD_NOW    2
#define RTLD_NOLOAD 4
#define RTLD_GLOBAL 256
#define RTLD_LOCAL  0
#endif

static char dl_error_buf[256];
static int dl_error_set = 0;

static void set_dl_error(const char *msg) {
    size_t len = strlen(msg);
    if (len >= sizeof(dl_error_buf)) len = sizeof(dl_error_buf) - 1;
    memcpy(dl_error_buf, msg, len);
    dl_error_buf[len] = '\0';
    dl_error_set = 1;
}

void *dlopen(const char *path, int flags) {
    if (!path) {
        /* An empty host request returns an opaque handle for the main
         * program's global symbol scope. */
        int handle = __wasm_dlopen_main();
        if (handle <= 0) {
            int elen = __wasm_dlerror(dl_error_buf, (int)sizeof(dl_error_buf) - 1);
            if (elen > 0) {
                dl_error_buf[elen] = '\0';
                dl_error_set = 1;
            } else {
                set_dl_error("cannot open main program");
            }
            return NULL;
        }

        dl_error_set = 0;
        return (void *)(long)handle;
    }

    /* Stat to get file size */
    struct stat st;
    if (stat(path, &st) < 0) {
        set_dl_error("cannot stat library");
        return NULL;
    }

    if (st.st_size <= 0 || st.st_size > 64 * 1024 * 1024) {
        set_dl_error("invalid library size");
        return NULL;
    }

    /* Open the .so file */
    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        set_dl_error("cannot open library");
        return NULL;
    }

    /* Allocate buffer and read file */
    void *buf = malloc((size_t)st.st_size);
    if (!buf) {
        close(fd);
        set_dl_error("out of memory");
        return NULL;
    }

    ssize_t total = 0;
    ssize_t target = (ssize_t)st.st_size;
    while (total < target) {
        ssize_t n = read(fd, (char *)buf + total, (size_t)(target - total));
        if (n <= 0) break;
        total += n;
    }
    close(fd);

    if (total != target) {
        free(buf);
        set_dl_error("read error");
        return NULL;
    }

    /*
     * The host owns module compilation and instance construction, but it must
     * not call back into Wasm while this import frame is active. Each returned
     * table entry has the canonical void(void) shape, so bootstrap,
     * relocations, constructors, and any fork continuation beneath them remain
     * an ordinary Wasm-to-Wasm call chain.
     */
    int transaction = __wasm_dlopen_prepare(
        buf, (int)st.st_size, path, (int)strlen(path), flags);
    __wasm_posix_signal_checkpoint();
    free(buf);

    if (transaction <= 0) {
        /* Get detailed error from host */
        int elen = __wasm_dlerror(dl_error_buf, (int)sizeof(dl_error_buf) - 1);
        if (elen > 0) {
            dl_error_buf[elen] = '\0';
            dl_error_set = 1;
        } else {
            set_dl_error("wasm instantiation failed");
        }
        return NULL;
    }

    int handle = 0;
    for (;;) {
        int entry = __wasm_dlopen_next(transaction, &handle);
        /*
         * WHY: the host may have used mmap or VFS channel requests while
         * advancing this transaction. Their completions are JavaScript-owned,
         * so deliver any caught signal only now, after the import returned and
         * before entering a guest initializer.
         */
        __wasm_posix_signal_checkpoint();
        if (entry < 0) {
            int elen = __wasm_dlerror(
                dl_error_buf, (int)sizeof(dl_error_buf) - 1);
            if (elen > 0) {
                dl_error_buf[elen] = '\0';
                dl_error_set = 1;
            } else {
                set_dl_error("wasm initialization failed");
            }
            return NULL;
        }
        if (entry == 0) break;
        ((void (*)(void))(uintptr_t)(unsigned int)entry)();
    }

    if (handle <= 0) {
        int elen = __wasm_dlerror(dl_error_buf, (int)sizeof(dl_error_buf) - 1);
        if (elen > 0) {
            dl_error_buf[elen] = '\0';
            dl_error_set = 1;
        } else {
            set_dl_error("wasm loader commit failed");
        }
        return NULL;
    }

    dl_error_set = 0;
    return (void *)(long)handle;
}

void *dlsym(void *handle, const char *name) {
    if (!name) {
        set_dl_error("invalid arguments to dlsym");
        return NULL;
    }

    /* A zero handle is RTLD_DEFAULT: search the main program's global scope. */
    int h = (int)(long)handle;
    int result = __wasm_dlsym(h, name, (int)strlen(name));

    if (result == 0) {
        /* 0 is "not found" — functions are at table index >= 1 */
        int elen = __wasm_dlerror(dl_error_buf, (int)sizeof(dl_error_buf) - 1);
        if (elen > 0) {
            dl_error_buf[elen] = '\0';
            dl_error_set = 1;
        } else {
            set_dl_error("symbol not found");
        }
        return NULL;
    }

    dl_error_set = 0;
    return (void *)(long)result;
}

int dlclose(void *handle) {
    if (!handle) return 0;
    int h = (int)(long)handle;
    int ret = __wasm_dlclose(h);
    __wasm_posix_signal_checkpoint();
    if (ret != 0) {
        set_dl_error("dlclose failed");
    } else {
        dl_error_set = 0;
    }
    return ret;
}

char *dlerror(void) {
    if (!dl_error_set) return NULL;
    dl_error_set = 0;
    return dl_error_buf;
}

typedef struct {
    const char *dli_fname;
    void *dli_fbase;
    const char *dli_sname;
    void *dli_saddr;
} Dl_info;

int dladdr(const void *addr, Dl_info *info) {
    if (!addr || !info) return 0;
    /* In Wasm there are no shared libraries with address ranges to look up.
     * Return success with minimal info — the address belongs to the main
     * program (the only "module"). */
    info->dli_fname = "";
    info->dli_fbase = (void *)0;
    info->dli_sname = NULL;
    info->dli_saddr = NULL;
    return 1;
}
