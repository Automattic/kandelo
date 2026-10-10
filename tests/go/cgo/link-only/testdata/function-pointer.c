static int add_three(int value) {
    return value + 3;
}

int (*function_pointer)(int) = add_three;

int call_function_pointer(int value) {
    return function_pointer(value);
}
