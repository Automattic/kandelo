#include "sqlite-store.h"
#include <cstdio>
#include <iostream>
int main(int argc, char** argv) {
  if (argc != 3) return 2;
  try {
    kandelo::sqlite::Options options; options.readOnly = true;
    auto db = std::make_shared<kandelo::sqlite::Connection>(argv[1], options); db->Open();
    auto statement = db->Prepare(argv[2]);
    std::cout << '[';
    for (int i = 1; i <= statement->ParameterCount(); ++i) {
      if (i != 1) std::cout << ',';
      std::cout << '"';
      for (unsigned char c : statement->ParameterName(i)) {
        // Parameter names may contain arbitrary quoted Unicode. ASCII JSON
        // escapes preserve every UTF-8 byte; the JS harness decodes it below.
        char escaped[7]; snprintf(escaped, sizeof(escaped), "\\u%04x", c); std::cout << escaped;
      }
      std::cout << '"';
    }
    std::cout << ']' << std::endl; db->Close();
  } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
