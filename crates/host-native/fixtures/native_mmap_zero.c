/*
 * Anonymous-mmap zero-fill guest for the native Wasmtime host.
 *
 * POSIX requires a MAP_ANONYMOUS mapping to read as zero. Wasm linear memory
 * never shrinks, so a munmap only drops the kernel's record of the range: the
 * bytes stay where they were, and the next mapping placed over them sees
 * whatever the previous owner wrote unless the host clears them. Two ways to
 * land on dirtied pages, one exit code each:
 *
 *   - munmap then mmap again: the kernel's first-fit search hands back the
 *     same address (checked, so the test cannot pass by landing elsewhere);
 *   - MAP_FIXED over a live mapping, which replaces it in place.
 *
 * Prints one line on success so the test can tell "ran and checked" from
 * "exited 0 early".
 */
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define LEN (4 * 65536)

static int all_zero(const unsigned char *p) {
    for (size_t i = 0; i < LEN; i++) {
        if (p[i] != 0) return 0;
    }
    return 1;
}

int main(void) {
    unsigned char *a = mmap(NULL, LEN, PROT_READ | PROT_WRITE,
                            MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (a == MAP_FAILED) return 2;
    if (!all_zero(a)) return 3;
    memset(a, 0xA5, LEN);
    if (munmap(a, LEN) != 0) return 4;

    unsigned char *b = mmap(NULL, LEN, PROT_READ | PROT_WRITE,
                            MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (b == MAP_FAILED) return 5;
    if (b != a) return 6;
    if (!all_zero(b)) return 7;

    memset(b, 0x5A, LEN);
    unsigned char *c = mmap(b, LEN, PROT_READ | PROT_WRITE,
                            MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED, -1, 0);
    if (c != b) return 8;
    if (!all_zero(c)) return 9;

    static const char msg[] = "anonymous mappings read as zero\n";
    write(1, msg, sizeof(msg) - 1);
    return 0;
}
