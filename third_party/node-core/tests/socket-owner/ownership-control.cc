#include "../../socket-owner.h"
#include "../../retained-backing-store.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <cstdlib>
#include <new>
#include <netinet/in.h>
#include <poll.h>
#include <chrono>
#include <sys/socket.h>
static bool failNextAllocation = false;
void* operator new(size_t size) {
  if (std::exchange(failNextAllocation, false)) throw std::bad_alloc();
  if (void* pointer = std::malloc(size ? size : 1)) return pointer;
  throw std::bad_alloc();
}
void operator delete(void* pointer) noexcept { std::free(pointer); }
void operator delete(void* pointer, size_t) noexcept { std::free(pointer); }
using kandelo::socket::Lease;
using kandelo::socket::Owner;
using kandelo::socket::Read;
using Write = kandelo::socket::Write<kandelo::buffer::SpanHandle>;
static auto FixtureBacking(const uint8_t* initial, size_t size) {
  auto* data = static_cast<uint8_t*>(std::malloc(size ? size : 1)); assert(data);
  if (size) std::memcpy(data, initial, size);
  auto store = kandelo::buffer::BackingStore::Prepare(data, size,
      [](void* data, size_t, void*) noexcept { std::free(data); });
  store->Commit();
  return kandelo::buffer::BackingSpan::Capture(std::move(store), 0, size);
}
static size_t checks;
#define CHECK(value) do { assert(value); ++checks; } while (false)
struct Pair {
  int peer;
  Owner owner{7};
  Pair() {
    int pair[2]; CHECK(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    peer = pair[1];
    CHECK(fcntl(pair[0], F_SETFL, fcntl(pair[0], F_GETFL) | O_NONBLOCK) == 0);
    Lease prior(pair[0]); CHECK(owner.Adopt(prior)); CHECK(prior.Fd() == -1);
  }
  ~Pair() { close(peer); }
};
int main() {
  const auto baseline = kandelo::memory::processLedger.Inspect();
  {
    Pair pair;
    CHECK(pair.owner.PendingRead() == 0);
    CHECK(pair.owner.StartRead(16));
    CHECK(!pair.owner.ProgressRead());
    CHECK(send(pair.peer, "abc", 3, 0) == 3);
    CHECK(pair.owner.ProgressRead());
    CHECK(pair.owner.PendingRead() == 1);
    auto material = pair.owner.CurrentRead();
    CHECK(material->status == 3 && memcmp(material->bytes.data(), "abc", 3) == 0);
    // Kernel buffer is empty now. The consumed completion must remain visible.
    uint8_t byte; CHECK(recv(pair.owner.Fd(), &byte, 1, MSG_PEEK | MSG_DONTWAIT) == -1 && errno == EAGAIN);
    pair.owner.StopRead();
    CHECK(pair.owner.CurrentRead() == material);
    CHECK(pair.owner.PendingRead() == 1);
    CHECK(!pair.owner.BeginDelivery());
    CHECK(pair.owner.StartRead());
    auto delivery = pair.owner.BeginDelivery();
    CHECK(delivery == material);
    // Before-hook/onread reentry cannot hide material or replace the ticket.
    CHECK(pair.owner.PendingRead() == 1);
    pair.owner.StopRead(); CHECK(pair.owner.PendingRead() == 1);
    CHECK(pair.owner.StartRead()); CHECK(!pair.owner.BeginDelivery());
    pair.owner.AbortDelivery(delivery); CHECK(pair.owner.BeginDelivery() == delivery);
    // Real callback material has its own allocation before queue admission.
    const std::vector<uint8_t> callbackArgs(delivery->bytes.data(), delivery->bytes.data() + delivery->status);
    CHECK(pair.owner.AdmitDelivery(delivery)); CHECK(!pair.owner.AdmitDelivery(delivery));
    CHECK(!pair.owner.CurrentRead()); CHECK(pair.owner.PendingRead() == 0);
    CHECK(delivery->phase == Read::Phase::Admitted);
    CHECK(memcmp(callbackArgs.data(), "abc", callbackArgs.size()) == 0);
    CHECK(memcmp(delivery->bytes.data(), "abc", 3) == 0);
    CHECK(pair.owner.StartRead(16));
    const auto next = pair.owner.CurrentRead();
    CHECK(next->sequence != delivery->sequence);
    CHECK(!pair.owner.AdmitDelivery(delivery)); CHECK(pair.owner.CurrentRead() == next);
    pair.owner.StopRead(); CHECK(!pair.owner.CurrentRead());
    CHECK(pair.owner.StartRead()); pair.owner.StopRead(); CHECK(!pair.owner.CurrentRead());
    // The owner, not a recycled numeric descriptor, controls old tickets.
    CHECK(pair.owner.StartRead());
    CHECK(shutdown(pair.peer, SHUT_WR) == 0); CHECK(pair.owner.ProgressRead());
    CHECK(pair.owner.CurrentRead()->status == 0); CHECK(pair.owner.PendingRead() == 1);
    auto eof = pair.owner.BeginDelivery(); CHECK(eof != nullptr);
    const int oldFd = pair.owner.Fd(); pair.owner.Close();
    CHECK(!pair.owner.AdmitDelivery(eof)); CHECK(pair.owner.Fd() == -1);
    CHECK(fcntl(oldFd, F_GETFD) == -1 && errno == EBADF);
    int replacement = open("/dev/null", O_RDONLY); CHECK(replacement >= 0);
    pair.owner.Close(); CHECK(fcntl(replacement, F_GETFD) >= 0); close(replacement);
    CHECK(eof->status == 0);
  }
  {
    Pair pair;
    const uint8_t bytes[] = {0, 255, 1, 7}; Write write(FixtureBacking(bytes, sizeof(bytes)));
    CHECK(pair.owner.ProgressWrite(write)); CHECK(write.error == 0 && write.offset == 4);
    uint8_t received[4]; CHECK(read(pair.peer, received, 4) == 4);
    CHECK(memcmp(bytes, received, 4) == 0);
    pair.owner.Ref(false); CHECK(!pair.owner.Referenced());
    pair.owner.Ref(true); CHECK(pair.owner.Referenced());
    // Failed double-adoption leaves the old descriptor lease intact.
    const int fd = dup(pair.peer); CHECK(fd >= 0); Lease prior(fd);
    CHECK(!pair.owner.Adopt(prior)); CHECK(prior.Fd() == fd);
    pair.owner.Close(); Write after(FixtureBacking(bytes, sizeof(bytes)));
    CHECK(pair.owner.ProgressWrite(after) && after.error == EBADF);
  }
  {
    int fd = open("/dev/null", O_RDONLY); CHECK(fd >= 0);
    Lease lease(fd);
    bool threw = false; failNextAllocation = true;
    try { Owner next(8); } catch (const std::bad_alloc&) { threw = true; }
    CHECK(threw && !failNextAllocation); CHECK(lease.Fd() == fd);
    CHECK(fcntl(fd, F_GETFD) >= 0);
  }
  {
    Pair pair;
    bool threw = false; failNextAllocation = true;
    try { pair.owner.StartRead(64); } catch (const std::bad_alloc&) { threw = true; }
    CHECK(threw && !failNextAllocation);
    CHECK(!pair.owner.Reading() && !pair.owner.CurrentRead());
    CHECK(pair.owner.StartRead(64));
    CHECK(send(pair.peer, "kept", 4, 0) == 4); CHECK(pair.owner.ProgressRead());
    auto material = pair.owner.CurrentRead(); pair.owner.StopRead();
    failNextAllocation = true;
    CHECK(pair.owner.StartRead(64));
    CHECK(failNextAllocation); failNextAllocation = false;
    CHECK(pair.owner.CurrentRead() == material && material->status == 4);
    const int fd = dup(pair.peer); CHECK(fd >= 0); Lease other(fd);
    pair.owner.Close(); CHECK(!pair.owner.Adopt(other)); CHECK(other.Fd() == fd);
  }
  {
    Pair pair;
    close(pair.peer); pair.peer = -1;
    const uint8_t byte = 1; Write failed(FixtureBacking(&byte, 1));
    CHECK(pair.owner.ProgressWrite(failed)); CHECK(failed.error == EPIPE);
  }
  {
    // Actual INET loopback transport; force a partial native write, then drain
    // its retained bytes without retrying data already accepted by the kernel.
    const int listener = socket(AF_INET, SOCK_STREAM, 0); CHECK(listener >= 0);
    sockaddr_in address = {}; address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    CHECK(bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
    CHECK(listen(listener, 1) == 0);
    socklen_t size = sizeof(address);
    CHECK(getsockname(listener, reinterpret_cast<sockaddr*>(&address), &size) == 0);
    const int client = socket(AF_INET, SOCK_STREAM, 0); CHECK(client >= 0);
    CHECK(connect(client, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
    const int peer = accept(listener, nullptr, nullptr); CHECK(peer >= 0); close(listener);
    CHECK(fcntl(client, F_SETFL, fcntl(client, F_GETFL) | O_NONBLOCK) == 0);
    CHECK(fcntl(peer, F_SETFL, fcntl(peer, F_GETFL) | O_NONBLOCK) == 0);
    const int capacity = 4096;
    CHECK(setsockopt(client, SOL_SOCKET, SO_SNDBUF, &capacity, sizeof(capacity)) == 0);
    Lease lease(client); Owner owner(99); CHECK(owner.Adopt(lease));
    std::vector<uint8_t> bytes(1024 * 1024);
    for (size_t i = 0; i < bytes.size(); ++i) bytes[i] = uint8_t(i * 7 + i / 256);
    Write write(FixtureBacking(bytes.data(), bytes.size()));
    CHECK(!owner.ProgressWrite(write)); CHECK(write.offset > 0 && write.Remaining() > 0);
    size_t received = 0; uint8_t buffer[16384];
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (received < bytes.size()) {
      CHECK(std::chrono::steady_clock::now() < deadline);
      owner.ProgressWrite(write);
      const ssize_t count = read(peer, buffer, sizeof(buffer));
      if (count > 0) {
        CHECK(size_t(count) <= bytes.size() - received);
        CHECK(memcmp(buffer, bytes.data() + received, size_t(count)) == 0);
        received += size_t(count);
      } else {
        CHECK(count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK));
        pollfd descriptors[2] = {{peer, POLLIN, 0}, {owner.Fd(), POLLOUT, 0}};
        poll(descriptors, 2, 1);
      }
    }
    CHECK(write.complete && write.error == 0 && write.offset == bytes.size());
    CHECK(owner.StartRead(64)); CHECK(shutdown(peer, SHUT_WR) == 0);
    while (!owner.ProgressRead()) CHECK(std::chrono::steady_clock::now() < deadline);
    CHECK(owner.CurrentRead()->status == 0); CHECK(owner.PendingRead() == 1);
    close(peer);
  }
  const auto after = kandelo::memory::processLedger.Inspect();
  CHECK(after.retained == baseline.retained && after.allocations == baseline.allocations);
  printf("socket owner: %zu assertions; actual socketpair bytes/EOF, completion retention, fd ownership, write, accounting\n", checks);
}
