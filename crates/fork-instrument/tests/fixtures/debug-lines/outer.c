extern void inner(int);
__attribute__((noinline)) void outer(void) {
  inner(42);
}
