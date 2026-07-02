/*
 * Feeds ICU its common data at intl.so load time.
 *
 * ICU ships as the standalone file icu.dat (see packages/registry/icu), but
 * ICU's automatic loader only looks for the conventional icudt<ver><endian>.dat
 * name and would never find icu.dat on its own. So instead of embedding the
 * ~30 MB blob in the .so, we hand it to ICU via udata_setCommonData() from a
 * constructor: the side-module loader runs __wasm_call_ctors before PHP calls
 * intl's MINIT, so the data is in place before any ICU service touches it.
 *
 * A missing/unreadable icu.dat is non-fatal at load (intl.so may be present
 * without any code using intl) but stays loud: we warn to stderr and let ICU
 * fail with U_MISSING_RESOURCE_ERROR when a service actually needs data, rather
 * than silently succeeding. Path defaults to /usr/lib/php/icu.dat, overridable
 * via KANDELO_ICU_DAT_PATH for VFS images that stage it elsewhere.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

#include <unicode/udata.h>
#include <unicode/uclean.h>
#include <unicode/utypes.h>

#define KANDELO_ICU_DAT_DEFAULT "/usr/lib/php/icu.dat"

static void kandelo_intl_load_icu_data(void) __attribute__((constructor));

static void kandelo_intl_load_icu_data(void) {
    const char *path = getenv("KANDELO_ICU_DAT_PATH");
    if (path == NULL || path[0] == '\0') {
        path = KANDELO_ICU_DAT_DEFAULT;
    }

    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        fprintf(stderr,
                "[intl] ICU data not loaded: cannot open %s. "
                "intl functions will fail with U_MISSING_RESOURCE_ERROR. "
                "Set KANDELO_ICU_DAT_PATH or stage icu.dat there.\n",
                path);
        return;
    }

    struct stat st;
    if (fstat(fd, &st) != 0 || st.st_size <= 0) {
        fprintf(stderr, "[intl] ICU data not loaded: cannot stat %s.\n", path);
        close(fd);
        return;
    }

    /*
     * ICU keeps this pointer for the life of the process, so the buffer must
     * outlive this function and is deliberately never freed. A plain read (not
     * mmap) sidesteps the VFS's emulated mmap and runs once per process.
     */
    size_t size = (size_t) st.st_size;
    void *buf = malloc(size);
    if (buf == NULL) {
        fprintf(stderr, "[intl] ICU data not loaded: OOM reading %s (%zu bytes).\n",
                path, size);
        close(fd);
        return;
    }

    size_t off = 0;
    while (off < size) {
        ssize_t n = read(fd, (char *) buf + off, size - off);
        if (n < 0) {
            fprintf(stderr, "[intl] ICU data not loaded: read error on %s.\n", path);
            free(buf);
            close(fd);
            return;
        }
        if (n == 0) break;
        off += (size_t) n;
    }
    close(fd);

    if (off != size) {
        fprintf(stderr, "[intl] ICU data not loaded: short read on %s (%zu/%zu).\n",
                path, off, size);
        free(buf);
        return;
    }

    UErrorCode status = U_ZERO_ERROR;
    udata_setCommonData(buf, &status);
    if (U_FAILURE(status)) {
        fprintf(stderr,
                "[intl] udata_setCommonData(%s) failed: %s. "
                "(Likely an ICU library/data version mismatch.)\n",
                path, u_errorName(status));
        free(buf);
        return;
    }

    /* Force ICU to validate/initialize now so version skew surfaces at load. */
    status = U_ZERO_ERROR;
    u_init(&status);
    if (U_FAILURE(status)) {
        fprintf(stderr, "[intl] u_init after loading %s failed: %s.\n",
                path, u_errorName(status));
    }
}
