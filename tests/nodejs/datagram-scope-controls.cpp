#include "datagram-operations.h"
#include <cassert>
#include <cstdio>
using kandelo::udp::Address;
int main() {
  char name[IF_NAMESIZE];
  unsigned index = if_nametoindex("lo0");
  if (!index) index = if_nametoindex("lo");
  assert(index && if_indextoname(index, name));
  Address input; const std::string zone = std::string("fe80::1%") + std::to_string(index);
  assert(Address::Parse(AF_INET6, zone.c_str(), 123, &input) == 0);
  std::string text; assert(input.Text(&text) == 0);
  assert(text == std::string("fe80::1%") + name);
  Address roundtrip; assert(Address::Parse(AF_INET6, text.c_str(), 123, &roundtrip) == 0);
  assert(reinterpret_cast<const sockaddr_in6*>(&roundtrip.storage)->sin6_scope_id == index);
  assert(Address::Parse(AF_INET6, "::1%4294967295", 123, &input) == 0);
  assert(input.Text(&text) == 0 && text == "::1"); // Scope suffix is link-local only.
  assert(Address::Parse(AF_INET6, "fe80::1%4294967295", 123, &input) == 0);
  assert(input.Text(&text) != 0); // Unknown interface is a real error, no forged suffix.
  std::puts("scoped IPv6 text/roundtrip/link-local-only/unknown-interface PASS");
}
