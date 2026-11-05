#include "dns-lookup.h"
#include "dns-errors.h"
#include <cassert>
#include <iostream>
#include <thread>

int main() {
  sockaddr_storage address{};
  socklen_t length = 0;
  assert(kandelo::dns::NameInfoAddress("127.0.0.1", 80, &address, &length));
  const auto* v4 = reinterpret_cast<const sockaddr_in*>(&address);
  assert(v4->sin_family == AF_INET && ntohs(v4->sin_port) == 80);
  assert(length == sizeof(sockaddr_in));
  kandelo::dns::NameInfoResult reverse;
  std::thread worker([&] { reverse = kandelo::dns::NameInfo(address, length); });
  worker.join();
  assert(reverse.status == 0 && !reverse.hostname.empty() && !reverse.service.empty());

  assert(kandelo::dns::NameInfoAddress("::1", 65535, &address, &length));
  const auto* v6 = reinterpret_cast<const sockaddr_in6*>(&address);
  assert(v6->sin6_family == AF_INET6 && ntohs(v6->sin6_port) == 65535);
  assert(v6->sin6_scope_id == 0 && length == sizeof(sockaddr_in6));
  const auto numeric = kandelo::dns::NameInfo(address, length, NI_NUMERICHOST | NI_NUMERICSERV);
  assert(numeric.status == 0 && numeric.hostname == "::1" && numeric.service == "65535");

  // Unknown zone follows the pinned POSIX uv_ip6_addr behavior: scope zero.
  assert(kandelo::dns::NameInfoAddress("fe80::1%kandelo-no-such-interface", 0, &address, &length));
  assert(reinterpret_cast<const sockaddr_in6*>(&address)->sin6_scope_id == 0);
  struct if_nameindex* interfaces = if_nameindex();
  assert(interfaces);
  for (auto* item = interfaces; item->if_index != 0; ++item) {
    const std::string input = std::string("fe80::1%") + item->if_name;
    assert(kandelo::dns::NameInfoAddress(input.c_str(), 0, &address, &length));
    assert(reinterpret_cast<const sockaddr_in6*>(&address)->sin6_scope_id == item->if_index);
  }
  if_freenameindex(interfaces);
  for (const char* invalid : {"localhost", "127.0.0.999", "::not-an-ip"})
    assert(!kandelo::dns::NameInfoAddress(invalid, 0, &address, &length));

  const auto missing = kandelo::dns::Lookup("invalid.test", 4, AI_NUMERICHOST);
  assert(missing.status == EAI_NONAME && missing.addresses.empty());
  assert(kandelo::dns::ErrorStatus(missing.status, missing.system_error) == UV__EAI_NONAME);
  assert(kandelo::dns::ErrorStatus(0, EIO) == 0);
  assert(kandelo::dns::ErrorStatus(EAI_SYSTEM, EACCES) == UV__EACCES);
  assert(kandelo::dns::ErrorStatus(EAI_SYSTEM, 0) == UV__EIO);
  assert(kandelo::dns::ErrorStatus(123456, 0) == UV__UNKNOWN);
  assert(kandelo::dns::ErrorStatus(EAI_AGAIN, 0) == UV__EAI_AGAIN);
  assert(kandelo::dns::ErrorStatus(EAI_BADFLAGS, 0) == UV__EAI_BADFLAGS);
  assert(kandelo::dns::ErrorStatus(EAI_FAIL, 0) == UV__EAI_FAIL);
  assert(kandelo::dns::ErrorStatus(EAI_FAMILY, 0) == UV__EAI_FAMILY);
  assert(kandelo::dns::ErrorStatus(EAI_MEMORY, 0) == UV__EAI_MEMORY);
  assert(kandelo::dns::ErrorStatus(EAI_SERVICE, 0) == UV__EAI_SERVICE);
  assert(kandelo::dns::ErrorStatus(EAI_SOCKTYPE, 0) == UV__EAI_SOCKTYPE);
  assert(kandelo::dns::ErrorStatus(EAI_OVERFLOW, 0) == UV__EAI_OVERFLOW);
  // Output is TSV so actual libc names need no handwritten JSON escaping.
  std::cout << reverse.hostname << '\t' << reverse.service << '\n';
  std::cout << AI_ADDRCONFIG << '\t' << AI_ALL << '\t' << AI_V4MAPPED << '\n';
}
