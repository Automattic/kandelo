extern const int offset;

int cross_weighted(int value) {
    volatile const int *address = &offset;
    return value + *address + 1;
}
