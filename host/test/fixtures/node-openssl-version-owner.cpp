#include "third_party/node-core/digest-operations.h"
#include <iostream>

int main() {
  std::cout << kandelo::crypto::OpenSSLVersion() << '\n';
}
