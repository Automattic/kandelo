#include "monotonic-clock.h"
#include <cassert>
#include <chrono>
#include <iostream>
#include <thread>
int main() {
  uint64_t before, after;
  assert(kandelo::clock::Nanoseconds(&before) == 0);
  std::this_thread::sleep_for(std::chrono::milliseconds(1));
  assert(kandelo::clock::Nanoseconds(&after) == 0);
  assert(after > before);
  std::cout << "{\"passed\":true,\"scope\":\"Actual shared POSIX monotonic-nanosecond owner on native host, not guest engine/kernel/four-host validation\"}\n";
}
