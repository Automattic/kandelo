/**
 * hello-lib.c — Simple shared library for dlopen example.
 *
 * Exports several functions demonstrating different capabilities:
 * - Pure computation (add, multiply)
 * - String manipulation (greet)
 * - Global state (counter)
 */

static int call_count = 0;

int add(int a, int b) {
    call_count++;
    return a + b;
}

int multiply(int a, int b) {
    call_count++;
    return a * b;
}

int get_call_count(void) {
    return call_count;
}

const char *get_greeting(void) {
    return "Hello from a dynamically loaded library!";
}
