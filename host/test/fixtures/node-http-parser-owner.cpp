// Native differential boundary: the actual portable llhttp owner, not guest JS.
#include "http-parser.h"
#include <cstdio>
#include <iostream>
#include <string>
static void Text(const std::string& text) {
  putchar('"');
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') putchar('\\');
    if (c < 32 || c >= 127) printf("\\u%04x", c); else putchar(c);
  }
  putchar('"');
}
static void List(const std::vector<std::string>& items) {
  putchar('[');
  for (size_t i = 0; i < items.size(); ++i) { if (i) putchar(','); Text(items[i]); }
  putchar(']');
}
static void Step(const kandelo::http::Step& step) {
  printf("{\"consumed\":%zu,\"complete\":%s,\"upgrade\":%s,\"code\":", step.consumed,
      step.complete ? "true" : "false", step.upgrade ? "true" : "false");
  Text(step.code); printf(",\"reason\":"); Text(step.reason); printf(",\"remainder\":\"");
  for (auto c : step.remainder) printf("%02x", c);
  printf("\",\"events\":[");
  for (size_t i = 0; i < step.events.size(); ++i) {
    const auto& e = step.events[i]; if (i) putchar(',');
    printf("{\"type\":%d,\"headers\":", int(e.type)); List(e.headers);
    printf(",\"status\":%u,\"major\":%u,\"minor\":%u,\"keepAlive\":%s,\"upgrade\":%s,\"informational\":%s,\"statusMessage\":",
        e.status, e.major, e.minor, e.keepAlive ? "true" : "false", e.upgrade ? "true" : "false", e.informational ? "true" : "false");
    Text(e.statusMessage); printf(",\"body\":\"");
    for (auto c : e.body) printf("%02x", c); printf("\"}");
  }
  puts("]}");
}
int main(int argc, char** argv) {
  if (argc != 4) return 2;
  const int mode = std::stoi(argv[3]);
  kandelo::http::ResponseParser parser(argv[1], std::stoull(argv[2]), mode == 1, mode == 2);
  std::string line;
  while (std::getline(std::cin, line)) {
    if (line == "finish") { Step(parser.Finish()); continue; }
    std::vector<uint8_t> bytes;
    auto digit = [](char c) { return c >= 'a' ? c - 'a' + 10 : c - '0'; };
    for (size_t i = 0; i + 1 < line.size(); i += 2) bytes.push_back(digit(line[i]) * 16 + digit(line[i + 1]));
    Step(parser.Feed(bytes.data(), bytes.size()));
    // Poison and retire the input between calls: the owner must not read it
    // again for fragmented values, sticky errors, EOF or completion.
    std::fill(bytes.begin(), bytes.end(), 0xa5);
  }
}
