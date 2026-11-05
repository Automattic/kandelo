#ifndef KANDELO_NODE_DNS_LOOKUP_H
#define KANDELO_NODE_DNS_LOOKUP_H

#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <memory>
#include <net/if.h>
#include <netdb.h>
#include <string>
#include <vector>

namespace kandelo::dns {
struct Address {
  std::string address;
  int family;
};
struct LookupResult {
  int status = 0;
  int system_error = 0;
  std::vector<Address> addresses;
};
struct NameInfoResult {
  int status = 0;
  int system_error = 0;
  std::string hostname;
  std::string service;
};

// Match the pinned POSIX uv_ip{4,6}_addr policy, including named IPv6 zones.
// Unknown interfaces have scope zero; do not invent an interface index.
inline bool NameInfoAddress(const char* ip, uint16_t port,
                            sockaddr_storage* storage, socklen_t* length) {
  *storage = {};
  auto* v4 = reinterpret_cast<sockaddr_in*>(storage);
  if (inet_pton(AF_INET, ip, &v4->sin_addr) == 1) {
    v4->sin_family = AF_INET;
    v4->sin_port = htons(port);
    *length = sizeof(*v4);
    return true;
  }
  *storage = {};
  auto* v6 = reinterpret_cast<sockaddr_in6*>(storage);
  char address[40];
  const char* zone = std::strchr(ip, '%');
  if (zone) {
    size_t count = size_t(zone - ip);
    if (count >= sizeof(address)) count = sizeof(address) - 1;
    std::memcpy(address, ip, count);
    address[count] = '\0';
    ip = address;
    v6->sin6_scope_id = if_nametoindex(zone + 1);
  }
  if (inet_pton(AF_INET6, ip, &v6->sin6_addr) != 1) return false;
  v6->sin6_family = AF_INET6;
  v6->sin6_port = htons(port);
  *length = sizeof(*v6);
  return true;
}

inline NameInfoResult NameInfo(const sockaddr_storage& address, socklen_t length,
                               int flags = NI_NAMEREQD) {
  NameInfoResult output;
  char hostname[NI_MAXHOST];
  char service[NI_MAXSERV];
  output.status = getnameinfo(reinterpret_cast<const sockaddr*>(&address), length,
                             hostname, sizeof(hostname), service, sizeof(service), flags);
  output.system_error = output.status == EAI_SYSTEM ? errno : 0;
  if (output.status == 0) {
    output.hostname = hostname;
    output.service = service;
  }
  return output;
}

// This is the OS/guest name-service path, not a DNS record query. The guest
// backend may return a private transport-routing address; do not expose it
// as a c-ares record or manufacture TTL/Resolver support from getaddrinfo.
inline LookupResult Lookup(const char* hostname, int family, int flags) {
  LookupResult output;
  addrinfo hints{};
  hints.ai_family = family == 6 ? AF_INET6 : family == 4 ? AF_INET : AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  hints.ai_flags = flags;
  addrinfo* result = nullptr;
  output.status = getaddrinfo(hostname, nullptr, &hints, &result);
  output.system_error = output.status == EAI_SYSTEM ? errno : 0;
  std::unique_ptr<addrinfo, decltype(&freeaddrinfo)> owner(result, freeaddrinfo);
  if (output.status != 0) return output;
  for (addrinfo* item = result; item; item = item->ai_next) {
    char text[INET6_ADDRSTRLEN];
    const void* address;
    int record_family;
    if (item->ai_family == AF_INET) {
      address = &reinterpret_cast<const sockaddr_in*>(item->ai_addr)->sin_addr;
      record_family = 4;
    } else if (item->ai_family == AF_INET6) {
      address = &reinterpret_cast<const sockaddr_in6*>(item->ai_addr)->sin6_addr;
      record_family = 6;
    } else {
      continue;
    }
    if (inet_ntop(item->ai_family, address, text, sizeof(text)))
      output.addresses.push_back({text, record_family});
  }
  return output;
}
}  // namespace kandelo::dns
#endif
