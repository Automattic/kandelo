#include "kandelo-node-dotenv-file.h"
#include <cstdio>
#include <iostream>
#include <iterator>
static void Hex(const std::string& text) {
  putchar('"');
  for (unsigned char byte : text) printf("%02x", byte);
  putchar('"');
}
int main(int argc, char** argv) {
  kandelo::dotenv::Dotenv parser;
  kandelo::dotenv::Result result;
  if (argc == 2) result = kandelo::dotenv::Load(argv[1], parser);
  else {
    const std::string input{std::istreambuf_iterator<char>(std::cin), {}};
    parser.ParseContent(input);
  }
  printf("{\"failure\":%d,\"error\":%d,\"entries\":[", int(result.failure), result.error);
  bool first = true;
  for (const auto& entry : parser.Entries()) {
    if (!first) putchar(','); first = false;
    putchar('['); Hex(entry.first); putchar(','); Hex(entry.second); putchar(']');
  }
  puts("]}");
}
