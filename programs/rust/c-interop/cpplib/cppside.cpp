// C++ library linked into the Rust program in rustcpp/. Its API is
// extern "C"; C++ exceptions are caught here and returned as error codes,
// because Kandelo's Rust is panic=abort and cannot unwind through Rust
// frames.
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

// A global with a constructor: it must have run before Rust's main.
struct Registry {
    std::map<std::string, int> values;
    Registry() { values["constructed"] = 42; }
};
Registry registry;

struct Shape {
    virtual ~Shape() = default;
    virtual int64_t area() const = 0;
};
struct Rect : Shape {
    int64_t w, h;
    Rect(int64_t w, int64_t h) : w(w), h(h) {}
    int64_t area() const override { return w * h; }
};
struct Square : Shape {
    int64_t s;
    explicit Square(int64_t s) : s(s) {}
    int64_t area() const override { return s * s; }
};

int parse_positive(const std::string &text) {
    std::size_t used = 0;
    int value = std::stoi(text, &used);  // throws std::invalid_argument
    if (used != text.size() || value <= 0)
        throw std::range_error("not a positive integer: " + text);
    return value;
}

}  // namespace

extern "C" {

int cpp_global_value(const char *key) {
    auto it = registry.values.find(key);
    return it == registry.values.end() ? -1 : it->second;
}

// Virtual dispatch over heap objects held in a std::vector.
int64_t cpp_total_area(void) {
    std::vector<std::unique_ptr<Shape>> shapes;
    shapes.push_back(std::make_unique<Rect>(3, 4));
    shapes.push_back(std::make_unique<Square>(5));
    int64_t total = 0;
    for (const auto &s : shapes) total += s->area();
    return total;
}

// Returns 0 and stores the value, or a negative code for the C++
// exception that was thrown and caught inside this function.
int cpp_parse_positive(const char *text, int *out) {
    try {
        *out = parse_positive(text);
        return 0;
    } catch (const std::invalid_argument &) {
        return -1;
    } catch (const std::range_error &) {
        return -2;
    }
}

// Calls a Rust callback through std::function for each element.
int64_t cpp_map_sum(const int32_t *v, std::size_t n, int32_t (*f)(int32_t)) {
    std::function<int32_t(int32_t)> fn = f;
    int64_t sum = 0;
    for (std::size_t i = 0; i < n; i++) sum += fn(v[i]);
    return sum;
}

// Writes "<a>+<b>" built with std::string into a caller buffer;
// returns the length, or -1 if it does not fit.
int cpp_concat(const char *a, const char *b, char *buf, std::size_t cap) {
    std::string s = std::string(a) + "+" + b;
    if (s.size() + 1 > cap) return -1;
    std::memcpy(buf, s.c_str(), s.size() + 1);
    return static_cast<int>(s.size());
}

}  // extern "C"
