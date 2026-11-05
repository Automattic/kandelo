#include "kandelo-node-uv-error-table.h"
#include <cstdio>

int main() {
  for (const auto& entry : kandelo::errors::entries)
    std::printf("%d\t%s\t%s\n", entry.number, entry.name, entry.message);
}
