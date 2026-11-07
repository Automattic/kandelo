// Standalone controls for the exact POSIX endpoint owner used by native UDP.
// The guest Node/browser path still requires linked package/kernel artifacts.
#include "datagram-operations.h"
#include <cassert>
#include <poll.h>
#include <cstdio>

using kandelo::udp::Address;
using kandelo::udp::Endpoint;
static void Ready(int fd) {
  pollfd item{fd, POLLIN, 0}; assert(poll(&item, 1, 1000) == 1); assert(item.revents & POLLIN);
}
static void Family(int family, const char* loopback) {
  Endpoint receiver, sender, intruder;
  Address local; assert(Address::Parse(family, loopback, 0, &local) == 0);
  assert(receiver.Bind(local, 0) == 0);
  Address destination; assert(receiver.Name(&destination, false) == 0);
  assert(destination.family() == family && destination.port() != 0);
  assert(destination.text() == loopback);
  assert(fcntl(receiver.fd(), F_GETFL) & O_NONBLOCK);
  assert(fcntl(receiver.fd(), F_GETFD) & FD_CLOEXEC);
  Endpoint conflicting;
  assert(conflicting.Bind(destination, 0) == EADDRINUSE);
  assert(conflicting.fd() == -1);
  assert(conflicting.Bind(local, 0) == 0); // Rollback permits reuse.
  assert(sender.Bind(local, 0) == 0);
  Address source; assert(sender.Name(&source, false) == 0);
  uint8_t bytes[64]; size_t received = 0, sent = 0; Address from;
  assert(receiver.Receive(bytes, sizeof(bytes), &received, &from) == EAGAIN);
  const uint8_t payload[] = {0, 1, 2, 0xff, 0, 3};
  assert(sender.Send(payload, sizeof(payload), &destination, &sent) == 0 && sent == sizeof(payload));
  Ready(receiver.fd());
  assert(receiver.Receive(bytes, sizeof(bytes), &received, &from) == 0);
  assert(received == sizeof(payload) && memcmp(bytes, payload, received) == 0);
  assert(from.port() == source.port() && from.text() == loopback);
  // Zero-length datagrams retain their sender and are consumed separately.
  assert(sender.Send(nullptr, 0, &destination, &sent) == 0 && sent == 0);
  assert(sender.Send(payload, sizeof(payload), &destination, &sent) == 0);
  Ready(receiver.fd());
  assert(receiver.Receive(bytes, sizeof(bytes), &received, &from) == 0 && received == 0);
  assert(from.port() == source.port());
  assert(receiver.Receive(bytes, 2, &received, &from) == 0 && received == 2);
  assert(receiver.Receive(bytes, sizeof(bytes), &received, &from) == EAGAIN); // Truncated tail discarded.
  assert(receiver.Connect(source) == 0);
  Address peer; assert(receiver.Name(&peer, true) == 0 && peer.port() == source.port());
  assert(intruder.Bind(local, 0) == 0);
  assert(intruder.Send("wrong", 5, &destination, &sent) == 0);
  assert(sender.Send("right", 5, &destination, &sent) == 0);
  Ready(receiver.fd());
  assert(receiver.Receive(bytes, sizeof(bytes), &received, &from) == 0);
  assert(received == 5 && memcmp(bytes, "right", 5) == 0 && from.port() == source.port());
  assert(receiver.Receive(bytes, sizeof(bytes), &received, &from) == EAGAIN);
  assert(receiver.Send("reply", 5, nullptr, &sent) == 0);
  Ready(sender.fd());
  assert(sender.Receive(bytes, sizeof(bytes), &received, &from) == 0 && received == 5);
  assert(receiver.Disconnect() == 0);
  assert(receiver.Name(&peer, true) == ENOTCONN);
  int actual; assert(receiver.BufferSize(true, 4096, &actual) == 0 && actual >= 4096);
  assert(receiver.IntegerOption(SOL_SOCKET, SO_BROADCAST, 1) == 0);
  int old = receiver.fd(); receiver.Close(); receiver.Close();
  assert(receiver.fd() == -1 && fcntl(old, F_GETFD) == -1 && errno == EBADF);
  assert(receiver.Send("x", 1, &source, &sent) == EBADF);
  assert(receiver.Bind(local, 0) == EBADF);
}
int main() {
  Family(AF_INET, "127.0.0.1"); Family(AF_INET6, "::1");
  Address address;
  assert(Address::Parse(AF_INET, "::1", 0, &address) == EINVAL);
  assert(Address::Parse(AF_INET6, "fe80::1%4294967296", 0, &address) == EINVAL);
  assert(Address::Parse(AF_INET, "127.0.0.1", 65536, &address) == EINVAL);
  int pipeFds[2]; assert(pipe(pipeFds) == 0);
  Endpoint failed; assert(failed.Adopt(pipeFds[0]) == ENOTSOCK);
  assert(fcntl(pipeFds[0], F_GETFD) >= 0); close(pipeFds[0]); close(pipeFds[1]);
  int datagram = socket(AF_INET, SOCK_DGRAM, 0); assert(datagram >= 0);
  Endpoint adopted; assert(adopted.Adopt(datagram) == 0); assert(adopted.fd() == datagram);
  int reuse = 0; socklen_t optionLength = sizeof(reuse);
  assert(getsockopt(datagram, SOL_SOCKET, SO_REUSEADDR, &reuse, &optionLength) == 0 && reuse != 0);
  adopted.Close(); assert(fcntl(datagram, F_GETFD) == -1 && errno == EBADF);
  puts("datagram native owner: IPv4/IPv6, payload/empty/truncation, peer filtering, rollback, adoption, close PASS");
}
