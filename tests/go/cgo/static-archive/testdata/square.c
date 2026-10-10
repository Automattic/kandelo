extern int bias(void);

int square_with_bias(int value) {
    return value * value + bias();
}
