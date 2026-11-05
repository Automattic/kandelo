#include "performance-clock.h"
#include <cassert>
#include <cmath>
#include <iostream>
#include <thread>
#include <vector>

int main() {
  kandelo::clock::PerformanceOrigin origin;
  double now;
  errno = 0;
  assert(origin.Now(&now) == -1 && errno == EINVAL);
  assert(origin.Initialize() == 0);
  const double timestamp = origin.unixMilliseconds;
  assert(timestamp > 0 && std::isfinite(timestamp));
  assert(origin.Now(&now) == 0 && now >= 0);
  const auto first = now;
  timespec delay{0, 2000000};
  while (nanosleep(&delay, &delay) != 0) assert(errno == EINTR);
  assert(origin.Now(&now) == 0 && now >= first);
  const auto later = now;
  assert(origin.Initialize() == -1 && errno == EALREADY);
  assert(origin.unixMilliseconds == timestamp);
  std::vector<std::thread> threads;
  for (int i = 0; i < 4; ++i) threads.emplace_back([&] {
    double prior = later;
    for (int n = 0; n < 100; ++n) {
      double current;
      assert(origin.Now(&current) == 0 && current >= prior);
      assert(origin.unixMilliseconds == timestamp);
      prior = current;
    }
  });
  for (auto& thread : threads) thread.join();
  timespec wall;
  assert(clock_gettime(CLOCK_REALTIME, &wall) == 0);
  assert(origin.Now(&now) == 0);
  const double expected = double(wall.tv_sec) * 1000 + double(wall.tv_nsec) / 1e6;
  assert(std::abs(timestamp + now - expected) < 100);
  std::cout << "{\"passed\":true,\"threads\":4,\"readsPerThread\":100}\n";
}
