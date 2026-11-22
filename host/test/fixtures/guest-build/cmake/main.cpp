#include <cstdlib>
#include <iostream>
#include <map>
#include <stdexcept>
#include <string>

#include "config.h"
#include "ops.h"

#ifndef GREETING
#error "GREETING comes from greeting.pc through pkg-config"
#endif
#if !defined(HAVE_UNISTD_H) || !defined(HAVE_FORK) || !defined(POINTERS_ARE_32_BITS)
#error "config.h lacks a configure check result"
#endif

int main(int argc, char **argv) {
  if (argc == 2 && std::string(argv[1]) == "--version") {
    std::cout << "calc " << KCALC_VERSION << " (" << KCALC_SYSTEM << ", "
              << plugin_name() << ")\n" << GREETING << "\n";
    return 0;
  }
  if (argc != 4) {
    std::cerr << "usage: calc OP A B\n";
    return 2;
  }
  const std::map<std::string, int (*)(int, int)> ops = {{"+", add}, {"*", multiply}};
  try {
    std::cout << ops.at(argv[1])(std::atoi(argv[2]), std::atoi(argv[3])) << "\n";
  } catch (const std::out_of_range &) {
    std::cerr << "calc: unknown operator " << argv[1] << "\n";
    return 1;
  }
  return 0;
}
