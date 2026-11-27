/* A C++ plugin module whose code uses vague-linkage definitions: a free
 * inline function, inline virtual members and a template's members, as
 * ScummVM's engines do through its headers. Built without optimization they
 * stay out-of-line. The module must bind them to its own copies; if wasm-ld
 * turned them into imports, the loader could not satisfy them and dlopen
 * would fail. Built with -fno-rtti so it needs no C++ runtime from a C
 * host. */
#include <stdio.h>

extern "C" int host_callback(int x);

inline int twice(int x) { return 2 * x; }

struct Shape {
    virtual int area() const { return 1; }
};

struct Square : Shape {
    int side;
    explicit Square(int s) : side(s) {}
    int area() const override { return side * side; }
};

template <typename T> struct Box {
    T value;
    T get() const { return value; }
};

static int measure(const Shape &shape) { return shape.area(); }

extern "C" int plugin_run(int x) {
    Square square(x);
    Box<int> box{host_callback(x)};
    printf("plugin-cxx: area=%d\n", measure(square));
    return twice(box.get());
}
