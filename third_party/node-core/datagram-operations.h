#ifndef KANDELO_NODE_DATAGRAM_OPERATIONS_H
#define KANDELO_NODE_DATAGRAM_OPERATIONS_H

// Guest POSIX owns the endpoint and datagram boundaries. This header also runs
// in standalone native controls; it never calls the embedding host's JS APIs.
#include <arpa/inet.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <string>
#include <limits>

namespace kandelo::udp {
constexpr unsigned IPv6Only = 1, ReuseAddr = 4, ReusePort = 64;
struct Address {
  sockaddr_storage storage{};
  socklen_t length = 0;
  const sockaddr* data() const { return reinterpret_cast<const sockaddr*>(&storage); }
  sockaddr* data() { return reinterpret_cast<sockaddr*>(&storage); }
  int family() const { return storage.ss_family; }
  static int Parse(int family, const char* text, unsigned port, Address* out) {
    if (port > 65535 || (family != AF_INET && family != AF_INET6)) return EINVAL;
    Address result;
    if (family == AF_INET) {
      auto* a = reinterpret_cast<sockaddr_in*>(&result.storage);
      a->sin_family = AF_INET; a->sin_port = htons(uint16_t(port));
      if (inet_pton(AF_INET, text, &a->sin_addr) != 1) return EINVAL;
      result.length = sizeof(*a);
    } else {
      auto* a = reinterpret_cast<sockaddr_in6*>(&result.storage);
      a->sin6_family = AF_INET6; a->sin6_port = htons(uint16_t(port));
      std::string address(text);
      auto separator = address.find('%');
      if (separator != std::string::npos) {
        const auto scope = address.substr(separator + 1);
        if (scope.empty()) return EINVAL;
        bool numeric = true; uint64_t index = 0;
        for (unsigned char c : scope) {
          if (c < '0' || c > '9') { numeric = false; break; }
          index = index * 10 + c - '0'; if (index > UINT32_MAX) return EINVAL;
        }
        a->sin6_scope_id = numeric ? uint32_t(index) : if_nametoindex(scope.c_str());
        if (!numeric && !a->sin6_scope_id) return ENODEV;
        address.resize(separator);
      }
      if (inet_pton(AF_INET6, address.c_str(), &a->sin6_addr) != 1) return EINVAL;
      result.length = sizeof(*a);
    }
    *out = result; return 0;
  }
  unsigned port() const {
    return ntohs(family() == AF_INET ? reinterpret_cast<const sockaddr_in*>(&storage)->sin_port :
                  reinterpret_cast<const sockaddr_in6*>(&storage)->sin6_port);
  }
  int Text(std::string* result) const {
    char text[INET6_ADDRSTRLEN];
    const void* raw = family() == AF_INET ?
        static_cast<const void*>(&reinterpret_cast<const sockaddr_in*>(&storage)->sin_addr) :
        static_cast<const void*>(&reinterpret_cast<const sockaddr_in6*>(&storage)->sin6_addr);
    if (!inet_ntop(family(), raw, text, sizeof(text))) return errno;
    *result = text;
    if (family() == AF_INET6) {
      const auto* address = reinterpret_cast<const sockaddr_in6*>(&storage);
      if (IN6_IS_ADDR_LINKLOCAL(&address->sin6_addr) && address->sin6_scope_id) {
        char name[IF_NAMESIZE];
        if (!if_indextoname(address->sin6_scope_id, name)) return errno;
        result->append("%"); result->append(name);
      }
    }
    return 0;
  }
  std::string text() const {
    std::string result;
    if (Text(&result)) return {};
    return result;
  }
};
class Endpoint {
  int fd_ = -1, family_ = AF_UNSPEC;
  bool closed_ = false;
 public:
  Endpoint() = default;
  Endpoint(const Endpoint&) = delete;
  Endpoint& operator=(const Endpoint&) = delete;
  ~Endpoint() { Close(); }
  int fd() const { return fd_; }
  int family() const { return family_; }
  bool closed() const { return closed_; }
  void Close() { if (fd_ >= 0) { const int fd = fd_; fd_ = -1; close(fd); } closed_ = true; }
  int Ensure(int family, unsigned flags = 0) {
    if (closed_) return EBADF;
    if (fd_ >= 0) return family_ == family ? 0 : EINVAL;
    if (flags & ~(IPv6Only | ReuseAddr | ReusePort)) return EINVAL;
    int fd = ::socket(family, SOCK_DGRAM, 0);
    if (fd < 0) return errno;
    auto fail = [&](int error) { close(fd); return error; };
    int status = fcntl(fd, F_GETFL);
    if (status < 0 || fcntl(fd, F_SETFL, status | O_NONBLOCK) < 0 ||
        fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) return fail(errno);
    const int one = 1;
    if ((flags & ReuseAddr) && setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one)) < 0) return fail(errno);
    if (flags & ReusePort) {
#ifdef SO_REUSEPORT
      if (setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof(one)) < 0) return fail(errno);
#else
      return fail(ENOTSUP);
#endif
    }
    if (family == AF_INET6 && (flags & IPv6Only) &&
        setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &one, sizeof(one)) < 0) return fail(errno);
    fd_ = fd; family_ = family; return 0;
  }
  // open adopts only after complete validation; a failed handoff leaves the
  // caller's descriptor open. No duplicate numeric fd is kept after close.
  int Adopt(int fd) {
    if (closed_) return EBADF;
    if (fd_ >= 0) return EBUSY;
    int type; socklen_t length = sizeof(type);
    if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &length) < 0) return errno;
    if (type != SOCK_DGRAM) return EINVAL;
    Address address; address.length = sizeof(address.storage);
    if (getsockname(fd, address.data(), &address.length) < 0) return errno;
    if (address.family() != AF_INET && address.family() != AF_INET6) return EINVAL;
    int status = fcntl(fd, F_GETFL);
    if (status < 0 || fcntl(fd, F_SETFL, status | O_NONBLOCK) < 0 ||
        fcntl(fd, F_SETFD, FD_CLOEXEC) < 0) return errno;
    const int one = 1;
    if (setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one)) < 0) return errno;
    fd_ = fd; family_ = address.family(); return 0;
  }
  int Bind(const Address& address, unsigned flags) {
    const bool newlyCreated = fd_ < 0;
    int error = Ensure(address.family(), flags); if (error) return error;
    if (bind(fd_, address.data(), address.length) == 0) return 0;
    error = errno;
    // Failed bind must permit the public wrapper to retry on another port.
    if (newlyCreated) { close(fd_); fd_ = -1; family_ = AF_UNSPEC; }
    return error;
  }
  int Connect(const Address& address) {
    int error = Ensure(address.family()); if (error) return error;
    return connect(fd_, address.data(), address.length) < 0 ? errno : 0;
  }
  int Disconnect() {
    if (fd_ < 0 || closed_) return EBADF;
    sockaddr address{}; address.sa_family = AF_UNSPEC;
    int result;
    do { result = connect(fd_, &address, sizeof(address)); } while (result < 0 && errno == EINTR);
    if (result == 0) return 0;
    const int error = errno;
    // BSD may disconnect and still report EAFNOSUPPORT/EINVAL (libuv's
    // uv__udp_disconnect documents this). Verify the peer really retired.
    if (error == EAFNOSUPPORT || error == EINVAL) {
      Address peer;
      if (Name(&peer, true) == ENOTCONN) return 0;
    }
    return error;
  }
  int Name(Address* address, bool peer) const {
    if (fd_ < 0 || closed_) return EBADF;
    address->length = sizeof(address->storage);
    const int result = peer ? getpeername(fd_, address->data(), &address->length) :
                              getsockname(fd_, address->data(), &address->length);
    return result < 0 ? errno : 0;
  }
  int Send(const void* bytes, size_t length, const Address* destination, size_t* sent) {
    if (fd_ < 0 || closed_) return EBADF;
    ssize_t n;
    do { n = sendto(fd_, bytes, length, 0, destination ? destination->data() : nullptr,
                     destination ? destination->length : 0); } while (n < 0 && errno == EINTR);
    if (n < 0) return errno;
    // A datagram is one message. Never continue a short send as a second one.
    if (size_t(n) != length) return EIO;
    *sent = size_t(n); return 0;
  }
  int SendSpans(const iovec* buffers, size_t count, const Address* destination, size_t* sent) {
    if (fd_ < 0 || closed_) return EBADF;
    Address peer;
    const int peerError = Name(&peer, true);
    const bool connected = peerError == 0;
    if (peerError && peerError != ENOTCONN) return peerError;
    // This POSIX-allowed EISCONN choice matches libuv's explicit UDP policy.
    if (destination && connected) return EISCONN;
    if (!destination && !connected) return EDESTADDRREQ;
    // libuv's UDP vector API requires at least one entry. One zero-byte
    // entry is a real empty datagram; zero entries is EINVAL.
    if (!count || count > size_t(std::numeric_limits<decltype(msghdr{}.msg_iovlen)>::max())) return EINVAL;
    size_t length = 0;
    for (size_t i = 0; i < count; ++i) {
      if (buffers[i].iov_len > SIZE_MAX - length) return EINVAL;
      length += buffers[i].iov_len;
    }
    msghdr message{};
    message.msg_name = destination ? const_cast<sockaddr*>(destination->data()) : nullptr;
    message.msg_namelen = destination ? destination->length : 0;
    message.msg_iov = const_cast<iovec*>(buffers);
    message.msg_iovlen = static_cast<decltype(message.msg_iovlen)>(count);
    ssize_t result;
    do { result = sendmsg(fd_, &message, 0); } while (result < 0 && errno == EINTR);
    if (result < 0) return errno;
    // One vector describes one datagram. Never send a short remainder as a
    // second message; real transport/IOV/payload errors remain the syscall's.
    if (size_t(result) != length) return EIO;
    *sent = size_t(result); return 0;
  }
  int Receive(void* bytes, size_t capacity, size_t* received, Address* source) {
    if (fd_ < 0 || closed_) return EBADF;
    source->length = sizeof(source->storage); ssize_t n;
    do { n = recvfrom(fd_, bytes, capacity, 0, source->data(), &source->length); }
    while (n < 0 && errno == EINTR);
    if (n < 0) return errno;
    *received = size_t(n); return 0;
  }
  int IntegerOption(int level, int option, int value) {
    if (fd_ < 0 || closed_) return EBADF;
    return setsockopt(fd_, level, option, &value, sizeof(value)) < 0 ? errno : 0;
  }
  int BufferSize(bool receive, unsigned value, int* result) {
    if (fd_ < 0 || closed_) return EBADF;
    int option = receive ? SO_RCVBUF : SO_SNDBUF;
    if (value) {
      if (value > INT32_MAX) return EINVAL;
      const int size = int(value);
      int error = IntegerOption(SOL_SOCKET, option, size); if (error) return error;
    }
    socklen_t size = sizeof(*result);
    return getsockopt(fd_, SOL_SOCKET, option, result, &size) < 0 ? errno : 0;
  }
  int Membership(const char* group, const char* interface, const char* source, bool join) {
    Address address; int family = std::strchr(group, ':') ? AF_INET6 : AF_INET;
    int error = Address::Parse(family, group, 0, &address); if (error) return error;
    if (fd_ < 0) {
      Address wildcard;
      error = Address::Parse(family, family == AF_INET ? "0.0.0.0" : "::", 0, &wildcard);
      if (!error) error = Bind(wildcard, ReuseAddr);
    } else error = Ensure(family);
    if (error) return error;
    if (family == AF_INET) {
      ip_mreq request{};
      request.imr_multiaddr = reinterpret_cast<const sockaddr_in*>(&address.storage)->sin_addr;
      if (interface && inet_pton(AF_INET, interface, &request.imr_interface) != 1) return EINVAL;
      if (source) {
#if defined(IP_ADD_SOURCE_MEMBERSHIP) && defined(IP_DROP_SOURCE_MEMBERSHIP)
        ip_mreq_source specific{}; specific.imr_multiaddr = request.imr_multiaddr;
        specific.imr_interface = request.imr_interface;
        if (inet_pton(AF_INET, source, &specific.imr_sourceaddr) != 1) return EINVAL;
        return setsockopt(fd_, IPPROTO_IP, join ? IP_ADD_SOURCE_MEMBERSHIP : IP_DROP_SOURCE_MEMBERSHIP,
                          &specific, sizeof(specific)) < 0 ? errno : 0;
#else
        return ENOTSUP;
#endif
      }
      return setsockopt(fd_, IPPROTO_IP, join ? IP_ADD_MEMBERSHIP : IP_DROP_MEMBERSHIP,
                        &request, sizeof(request)) < 0 ? errno : 0;
    }
    // IPv6 source-specific membership needs group_source_req marshalling in
    // the libc/kernel path. Preserve that gap instead of joining every source.
    if (source) return ENOTSUP;
    ipv6_mreq request{};
    request.ipv6mr_multiaddr = reinterpret_cast<const sockaddr_in6*>(&address.storage)->sin6_addr;
    if (interface) {
      Address selected; error = Address::Parse(AF_INET6, interface, 0, &selected); if (error) return error;
      request.ipv6mr_interface = reinterpret_cast<const sockaddr_in6*>(&selected.storage)->sin6_scope_id;
    }
    return setsockopt(fd_, IPPROTO_IPV6, join ? IPV6_JOIN_GROUP : IPV6_LEAVE_GROUP,
                      &request, sizeof(request)) < 0 ? errno : 0;
  }
  int MulticastInterface(const char* text) {
    if (fd_ < 0 || closed_) return EBADF;
    if (family_ == AF_INET) {
      in_addr address{}; if (inet_pton(AF_INET, text, &address) != 1) return EINVAL;
      return setsockopt(fd_, IPPROTO_IP, IP_MULTICAST_IF, &address, sizeof(address)) < 0 ? errno : 0;
    }
    Address selected; int error = Address::Parse(AF_INET6, text, 0, &selected); if (error) return error;
    unsigned index = reinterpret_cast<const sockaddr_in6*>(&selected.storage)->sin6_scope_id;
    return setsockopt(fd_, IPPROTO_IPV6, IPV6_MULTICAST_IF, &index, sizeof(index)) < 0 ? errno : 0;
  }
};
}  // namespace kandelo::udp
#endif
