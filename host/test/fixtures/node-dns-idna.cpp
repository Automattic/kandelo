#include "ada.h"
#include <iostream>
#include <string>

int main() {
  std::string input;
  while (std::getline(std::cin, input)) std::cout << ada::idna::to_ascii(input) << '\n';
  return std::cin.bad() ? 1 : 0;
}
