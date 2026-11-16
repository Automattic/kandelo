"""Generate a large synthetic library (libbig) and a benchmark main."""
import sys
from pathlib import Path

out = Path(sys.argv[1])
n = int(sys.argv[2]) if len(sys.argv) > 2 else 4000
lib = ["#include <string.h>", "int big_state[64];"]
for i in range(n):
    lib.append(
        f"__attribute__((noinline)) int big_f{i}(int x) {{"
        f" int a = x * {i * 7 + 3} + big_state[{i % 64}];"
        f" for (int k = 0; k < (x & 7); k++) a = (a << 1) ^ (a >> 3) ^ {i};"
        f" big_state[{(i * 13) % 64}] += a; return a; }}"
    )
lib.append("typedef int (*big_fn)(int);")
lib.append("static big_fn const big_table[] = {" + ",".join(f"big_f{i}" for i in range(n)) + "};")
lib.append(f"int big_dispatch(int i, int x) {{ return big_table[(unsigned)i % {n}](x); }}")
lib.append("__attribute__((noinline)) int tiny(int x) { return x + 1; }")
(out / "big.c").write_text("\n".join(lib) + "\n")

main = r"""
#include <stdio.h>
#include <time.h>
extern int big_dispatch(int, int);
extern int tiny(int);
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1e9 + t.tv_nsec; }
int main(void) {
    int acc = 0;
    for (int i = 0; i < 1000; i++) acc += big_dispatch(i, i);
    const int calls = 20000000;
    double t0 = now();
    int x = 0;
    for (int i = 0; i < calls; i++) x = tiny(x);
    double t1 = now();
    printf("acc=%d x=%d tiny_ns_per_call=%.3f\n", acc, x, (t1 - t0) / calls);
    return 0;
}
"""
(out / "bigmain.c").write_text(main)
