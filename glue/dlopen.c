/**
 * dlopen/dlsym/dlclose/dlerror implementation for WebAssembly dynamic linking.
 *
 * This replaces musl's ELF-based dynamic linker stubs with Wasm-native
 * implementations that use host imports for the actual Wasm module
 * compilation and instantiation.
 *
 * Flow:
 *   1. dlopen() reads the .so file via normal open/read/close syscalls
 *   2. Calls __wasm_dlopen() host import with the bytes in memory
 *   3. Host compiles the Wasm side module, instantiates it into the
 *      process's memory/table space, returns a handle
 *   4. dlsym() calls __wasm_dlsym() host import to look up symbols
 *   5. For functions: returns the table index (== C function pointer)
 *   6. For data: returns the relocated memory address
 */

#include <stddef.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <stdlib.h>

/* Host imports — implemented in worker-main.ts */
extern int __wasm_dlopen(const void *bytes, int len,
                         const char *name, int name_len);
extern int __wasm_dlsym(int handle, const char *name, int name_len);
extern int __wasm_dlclose(int handle);
extern int __wasm_dlerror(char *buf, int buf_max);

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
    (void)flags;

    if (!path) {
        /* dlopen(NULL, ...) returns a handle to the main program.
         * TODO: implement RTLD_DEFAULT support. */
        set_dl_error("dlopen(NULL) not yet supported");
        return NULL;
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

    /* Call host to compile + instantiate the Wasm side module */
    int handle = __wasm_dlopen(buf, (int)st.st_size, path, (int)strlen(path));
    free(buf);

    if (handle <= 0) {
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

    dl_error_set = 0;
    return (void *)(long)handle;
}

void *dlsym(void *handle, const char *name) {
    if (!handle || !name) {
        set_dl_error("invalid arguments to dlsym");
        return NULL;
    }

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
