extern void capture(void);
__attribute__((noinline)) void inner(int value) {
  if (value == 42)
    capture();
}
