/* Wasm uses 64KiB pages for memory.grow, but POSIX page size is 4KiB. */
#define PAGESIZE 65536
