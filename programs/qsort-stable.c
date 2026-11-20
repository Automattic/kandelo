#include <stdio.h>
#include <stdlib.h>

struct row {
    int key;
    int index;
};

static int compare_key(const void *left, const void *right) {
    const struct row *a = left;
    const struct row *b = right;
    return (a->key > b->key) - (a->key < b->key);
}

static int check(const char *name, struct row *rows, size_t count) {
    qsort(rows, count, sizeof(rows[0]), compare_key);
    for (size_t i = 1; i < count; i++) {
        if (rows[i - 1].key < rows[i].key)
            continue;
        if (rows[i - 1].key == rows[i].key && rows[i - 1].index < rows[i].index)
            continue;
        fprintf(stderr, "%s: row %zu (key %d, index %d) follows row %zu (key %d, index %d)\n",
                name, i, rows[i].key, rows[i].index, i - 1, rows[i - 1].key, rows[i - 1].index);
        return 1;
    }
    return 0;
}

int main(void) {
    struct row equal[5];
    struct row mixed[1000];

    for (int i = 0; i < 5; i++)
        equal[i] = (struct row){ 0, i };
    for (int i = 0; i < 1000; i++)
        mixed[i] = (struct row){ (i * 7919) % 13, i };

    if (check("equal", equal, 5) || check("mixed", mixed, 1000))
        return 1;
    puts("PASS");
    return 0;
}
