#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>

int main(void) {
    char *heap = NULL;
    for (int i = 0; i < 1024; i++) {
        heap = malloc(8192);
        memset(heap, 3, 8192);
    }

    size_t length = 16 << 20;
    char *map = mmap(NULL, length, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    int zero = map != MAP_FAILED && map[0] == 0 && map[length - 1] == 0;
    memset(map, 5, length);

    size_t size = 200000;
    unsigned char *data = malloc(size);
    for (size_t i = 0; i < size; i++) data[i] = (unsigned char)(i * 7);
    int kept = 1;
    for (int round = 0; round < 6; round++) {
        size_t next = size * 3;
        data = realloc(data, next);
        for (size_t i = 0; i < size; i++) kept &= data[i] == (unsigned char)(i * 7);
        for (size_t i = size; i < next; i++) data[i] = (unsigned char)(i * 7);
        size = next;
    }
    printf("zero=%d kept=%d heap=%d map=%d size=%zu\n", zero, kept, heap[8191], map[length - 1], size);
    return !(zero && kept && heap[8191] == 3 && map[length - 1] == 5);
}
