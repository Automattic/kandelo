extern const int offset;

int weighted(int value) {
    volatile const int *address = &offset;
    return value + *address;
}
