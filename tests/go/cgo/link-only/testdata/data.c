static const int offset = 7;

int weighted(int value) {
    volatile const int *address = &offset;
    return value + *address;
}
