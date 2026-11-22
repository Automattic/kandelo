#include <stddef.h>

_Static_assert(sizeof(size_t) == 4, "the spike expects Kandelo wasm32");

size_t spike_twice(size_t value) {
    return value * 2;
}
