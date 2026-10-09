__attribute__((noinline)) int triple(int value) {
    return value * 3;
}

int c_target(int value) {
    return triple(value) - value;
}
