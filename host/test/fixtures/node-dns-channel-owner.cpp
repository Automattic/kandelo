#include "../../../third_party/node-core/dns-resolver.h"
#include <iostream>
#include <stdexcept>
#include <thread>

struct Completion {
  std::mutex mutex;
  std::condition_variable condition;
  bool ready = false;
  kandelo::dns::QueryResult result;
  std::thread::id thread;
  static void Publish(void* data, const kandelo::dns::QueryResult& packet) {
    auto* self = static_cast<Completion*>(data);
    std::lock_guard<std::mutex> lock(self->mutex);
    self->result = packet;
    self->thread = std::this_thread::get_id();
    self->ready = true;
    self->condition.notify_all();
  }
  kandelo::dns::QueryResult Await() {
    std::unique_lock<std::mutex> lock(mutex);
    if (!condition.wait_for(lock, std::chrono::seconds(3), [&] { return ready; }))
      throw std::runtime_error("native producer deadline");
    return result;
  }
};

int main(int argc, char** argv) {
  try {
    if (argc != 2) throw std::runtime_error("controlled loopback port required");
    const int port = std::stoi(argv[1]);
    kandelo::dns::Resolver resolver(500, 1, 1000);
    if (resolver.Status() != ARES_SUCCESS) throw std::runtime_error("channel init");
    ares_addr_port_node server{};
    server.family = AF_INET; server.udp_port = server.tcp_port = port;
    if (ares_inet_pton(AF_INET, "127.0.0.1", &server.addr) != 1 ||
        resolver.SetServers(std::vector<ares_addr_port_node>{server}) != ARES_SUCCESS)
      throw std::runtime_error("typed server set");
    std::vector<std::pair<std::string, int>> servers;
    if (resolver.GetServers(&servers) != ARES_SUCCESS || servers.size() != 1 ||
        servers[0] != std::make_pair(std::string("127.0.0.1"), port))
      throw std::runtime_error("typed server read");
    if (resolver.SetLocalIP(6, "::1") != ARES_SUCCESS ||
        resolver.SetLocalIP(4, "127.0.0.1") != ARES_SUCCESS ||
        resolver.SetLocalIP(4, "invalid") != ARES_EBADSTR)
      throw std::runtime_error("local address owner");
    Completion answer;
    auto query = resolver.Submit("a.records.test", ARES_REC_TYPE_A, Completion::Publish, &answer);
    auto decoded = answer.Await().Decode(ARES_REC_TYPE_A);
    if (decoded.status != ARES_SUCCESS || decoded.value.elements.size() != 2 ||
        decoded.value.elements[0].bytes != "203.0.113.77" ||
        answer.thread == std::this_thread::get_id())
      throw std::runtime_error("independent event completion");
    Completion reverse;
    in_addr address{}; ares_inet_pton(AF_INET, "192.0.2.9", &address);
    auto reverseQuery = resolver.Reverse(&address, sizeof(address), AF_INET, Completion::Publish, &reverse);
    auto names = reverse.Await().Decode(0);
    if (names.status != ARES_SUCCESS || names.value.elements.empty() ||
        names.value.elements[0].bytes != "reverse.records.test")
      throw std::runtime_error("reverse borrowed host lifetime");
    Completion cancel;
    auto pending = resolver.Submit("silent.records.test", ARES_REC_TYPE_A, Completion::Publish, &cancel);
    resolver.Cancel();
    if (cancel.Await().status != ARES_ECANCELLED) throw std::runtime_error("cancel status");
    Completion destroy;
    auto closing = resolver.Submit("silent.records.test", ARES_REC_TYPE_A, Completion::Publish, &destroy);
    resolver.Close();
    if (destroy.Await().status != ARES_EDESTRUCTION) throw std::runtime_error("close status");
    query.reset(); reverseQuery.reset(); pending.reset(); closing.reset();
    if (decoded.value.elements[0].bytes != "203.0.113.77" || names.value.elements[0].bytes != "reverse.records.test")
      throw std::runtime_error("owned values after close");
    std::cout << "{\"typedServers\":true,\"localAddress\":true,\"eventThreadCompletion\":true,\"reverse\":true,\"cancel\":true,\"close\":true,\"ownedAfterClose\":true}\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
