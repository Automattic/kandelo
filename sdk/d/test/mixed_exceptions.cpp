#include <stdexcept>

extern "C" int catch_cpp_exception(int value) {
  try {
    if (value == 42)
      throw std::runtime_error("C++ exception");
  } catch (const std::runtime_error &) {
    return value;
  }
  return -1;
}
