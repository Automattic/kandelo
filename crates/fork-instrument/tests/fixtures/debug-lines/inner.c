__attribute__((import_module("env"), import_name("capture"))) extern void capture(void);
__attribute__((noinline)) void inner(int value) {
  if (value == 42)
    capture();
}
