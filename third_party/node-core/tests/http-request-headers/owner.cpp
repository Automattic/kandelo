// The actual portable llhttp owner and original native allocation are executed.
// This does not execute the production JSAPI callback or engine backing lease.
#include "http-parser.h"
#include <algorithm>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
static void Text(const std::string& text) {
  putchar('"');for (unsigned char c : text) { if (c == '"' || c == '\\') putchar('\\');if (c < 32 || c >= 127) printf("\\u%04x", c);else putchar(c); }putchar('"');
}
static void Hex(const std::vector<uint8_t>& bytes) { putchar('"');for (auto byte : bytes) printf("%02x", byte);putchar('"'); }
struct Call {
  kandelo::http::Parser* parser;
  std::vector<uint8_t>* original;
  int decision, mode;
  bool feeding = true, inFeed = false, reentryBlocked = false;
  unsigned count = 0;
  std::string url;
  static int Headers(void* data, const kandelo::http::Event& event) {
    auto& state = *static_cast<Call*>(data);state.inFeed = state.feeding;state.count++;state.url = event.url;
    assert(event.request);assert(event.type == kandelo::http::Event::Type::Headers);
    if (state.mode == 1) {
      auto& bytes = *state.original;const std::string text(bytes.begin(), bytes.end());const auto at = text.find("\r\n\r\n");assert(at != std::string::npos && at + 4 < bytes.size());bytes[at + 4] = 'Z';
    }
    if (state.mode == 2) {
      try { state.parser->Feed(nullptr, 0);assert(false); }
      catch (const std::logic_error&) { state.reentryBlocked = true; }
    }
    return state.decision;
  }
};
int main(int argc, char** argv) {
  if (argc != 4) return 2;
  std::vector<uint8_t> bytes;const std::string hex(argv[3]);
  auto digit = [](char c) { return c >= 'a' ? c - 'a' + 10 : c - '0'; };
  for (size_t i = 0; i + 1 < hex.size(); i += 2) bytes.push_back(digit(hex[i]) * 16 + digit(hex[i + 1]));
  kandelo::http::Parser parser("GET", 0, false, false, true);Call call{&parser, &bytes, kandelo::http::HeadersDecision(std::strtod(argv[1], nullptr)), std::atoi(argv[2])};
  auto step = parser.Feed(bytes.data(), bytes.size(), {&call, Call::Headers});call.feeding = false;
  std::vector<uint8_t> body;unsigned deferredHeaders = 0;
  for (const auto& event : step.events) { if (event.type == kandelo::http::Event::Type::Body) body.insert(body.end(), event.body.begin(), event.body.end());if (event.type == kandelo::http::Event::Type::Headers) deferredHeaders++; }
  printf("{\"consumed\":%zu,\"complete\":%s,\"upgrade\":%s,\"headers\":%u,\"inFeed\":%s,\"deferredHeaders\":%u,\"reentryBlocked\":%s,\"url\":", step.consumed, step.complete ? "true" : "false", step.upgrade ? "true" : "false", call.count, call.inFeed ? "true" : "false", deferredHeaders, call.reentryBlocked ? "true" : "false");Text(call.url);printf(",\"body\":");Hex(body);printf(",\"remainder\":");Hex(step.remainder);printf(",\"code\":");Text(step.code);puts("}");
}
