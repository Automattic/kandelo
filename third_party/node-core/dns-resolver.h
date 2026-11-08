#ifndef KANDELO_NODE_DNS_RESOLVER_H
#define KANDELO_NODE_DNS_RESOLVER_H

#include <ares.h>
#include <ares_dns_record.h>
#include <arpa/inet.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include "dns-records.h"


namespace kandelo::dns {

// Node cares_wrap calls uv_inet_pton, whose IPv6 parser ignores a %zone.
// c-ares' parser does not. Apply that same bounded byte-address policy before
// configuring the real channel or starting reverse DNS; zones are not DNS data.
inline int ParseAddress(int family, const char* text, void* address) {
  char plain[INET6_ADDRSTRLEN];
  if (family == AF_INET6) {
    if (const char* zone = std::strchr(text, '%')) {
      const size_t length = size_t(zone - text);
      if (length >= sizeof(plain)) return 0;
      std::memcpy(plain, text, length);plain[length] = '\0';text = plain;
    }
  }
  return ares_inet_pton(family, text, address);
}

struct QueryResult {
  int status = ARES_SUCCESS;
  size_t timeouts = 0;
  std::shared_ptr<const ares_dns_record_t> record;
  std::shared_ptr<const DecodedRecords> decoded;

  DecodedRecords Decode(int type) const {
    if (status == ARES_SUCCESS) {
      if (decoded) return *decoded;
      return DecodeRecords(record.get(), type);
    }
    DecodedRecords result; result.status = status; return result;
  }
};

class Query {
  std::mutex mutex_;
  std::condition_variable condition_;
  bool complete_ = false;
  QueryResult result_;
  using Completion = void (*)(void*, const QueryResult&);
  Completion completion_ = nullptr;
  void* completionData_ = nullptr;

  void Publish(QueryResult result) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      result_ = std::move(result);
      complete_ = true;
      condition_.notify_all();
    }
    // The consumer publishes native packets only. No JS/root access belongs
    // on the c-ares event thread, including synchronous failure callbacks.
    if (completion_) completion_(completionData_, result_);
  }

 public:
  Query(Completion completion = nullptr, void* data = nullptr)
      : completion_(completion), completionData_(data) {}

  void Complete(int status, size_t timeouts, const ares_dns_record_t* record) {
    QueryResult result;
    result.status = status;
    result.timeouts = timeouts;
    if (record) {
      // c-ares' callback record is borrowed and dies on callback return.
      // Native packets own an independent copy before waking their consumer.
      auto* copy = ares_dns_record_duplicate(record);
      if (!copy) result.status = ARES_ENOMEM;
      else {
        try {
          result.record = std::shared_ptr<const ares_dns_record_t>(copy,
          [](const ares_dns_record_t* value) {
            ares_dns_record_destroy(const_cast<ares_dns_record_t*>(value));
          });
        } catch (const std::bad_alloc&) {
          // shared_ptr invokes its supplied deleter if control allocation
          // fails. Never let a C++ exception cross the c-ares C callback.
          result.status = ARES_ENOMEM;
        }
      }
    }
    Publish(std::move(result));
  }

  void CompleteReverse(int status, int timeouts, const hostent* host) {
    QueryResult result;
    result.status = status;
    result.timeouts = static_cast<size_t>(timeouts);
    if (status == ARES_SUCCESS) {
      try {
        auto decoded = std::make_shared<DecodedRecords>();
        if (!host || !host->h_aliases) result.status = ARES_EBADRESP;
        else for (size_t i = 0; host->h_aliases[i]; ++i)
          decoded->value.Push(RecordValue::CString(host->h_aliases[i]));
        result.decoded = std::move(decoded);
      } catch (const std::bad_alloc&) { result.status = ARES_ENOMEM; }
    }
    Publish(std::move(result));
  }

  bool Ready(QueryResult* output) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!complete_) return false;
    *output = result_;
    return true;
  }

  // Native controls may wait; the future JS bridge must poll completed
  // packets on its owning event loop, never block the JavaScript thread.
  bool Wait(std::chrono::milliseconds timeout, QueryResult* output) {
    std::unique_lock<std::mutex> lock(mutex_);
    if (!condition_.wait_for(lock, timeout, [&] { return complete_; })) return false;
    *output = result_;
    return true;
  }
};

inline int InitializeCares() {
  struct Library {
    int status = ares_library_init(ARES_LIB_INIT_ALL);
    ~Library() { if (status == ARES_SUCCESS) ares_library_cleanup(); }
  };
  static Library library;
  return library.status;
}

class Resolver {
  std::mutex mutex_;
  ares_channel_t* channel_ = nullptr;
  int status_ = ARES_ENOTINITIALIZED;
  const int timeout_;
  const int tries_;
  const unsigned maxTimeout_;
  bool serversDefault_ = true;
  // c-ares completes on its event thread. Only this observed native status,
  // not JS/root state, crosses into the next owning-thread query admission.
  std::atomic<bool> queryLastOk_{true};

  void SetupLocked() {
    ares_options options{};
    options.flags = ARES_FLAG_NOCHECKRESP;
    options.timeout = timeout_;
    options.tries = tries_;
    options.qcache_max_ttl = 0;
    options.maxtimeout = maxTimeout_;
    options.evsys = ARES_EVSYS_POLL;
    int mask = ARES_OPT_FLAGS | ARES_OPT_TIMEOUTMS | ARES_OPT_TRIES |
               ARES_OPT_QUERY_CACHE | ARES_OPT_EVENT_THREAD;
    if (maxTimeout_) mask |= ARES_OPT_MAXTIMEOUTMS;
    status_ = ares_init_options(&channel_, &options, mask);
  }

  // Pinned ChannelWrap::EnsureServers: only refused queries against the
  // actual sole fallback loopback resolver may reload system configuration.
  // An explicit server list is never silently replaced by system defaults.
  int EnsureServersLocked() {
    if (!channel_) return status_;
    if (queryLastOk_.load(std::memory_order_relaxed) || !serversDefault_)
      return ARES_SUCCESS;
    ares_addr_port_node* raw = nullptr;
    const int status = ares_get_servers_ports(channel_, &raw);
    std::unique_ptr<void, records::FreeData> owned(raw);
    if (status != ARES_SUCCESS) return status;
    if (!raw) return ARES_SUCCESS;
    if (raw->next) { serversDefault_ = false; return ARES_SUCCESS; }
    static const unsigned char loopback6[16] = {
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1};
    const bool loopback = raw->family == AF_INET ?
        raw->addr.addr4.s_addr == htonl(INADDR_LOOPBACK) :
        raw->family == AF_INET6 &&
            std::memcmp(&raw->addr.addr6, loopback6, sizeof(loopback6)) == 0;
    if (!loopback) { serversDefault_ = false; return ARES_SUCCESS; }
    owned.reset();
    // Real destruction joins the event producer and completes outstanding
    // packets before replacing the channel; no retained raw channel escapes.
    ares_destroy(channel_);
    channel_ = nullptr;
    SetupLocked();
    return status_;
  }

  static void Completion(void* data, ares_status_t status, size_t timeouts,
                         const ares_dns_record_t* record) {
    std::unique_ptr<std::shared_ptr<Query>> token(
        static_cast<std::shared_ptr<Query>*>(data));
    (*token)->Complete(status, timeouts, record);
  }
  static void ReverseCompletion(void* data, int status, int timeouts, hostent* host) {
    std::unique_ptr<std::shared_ptr<Query>> token(static_cast<std::shared_ptr<Query>*>(data));
    (*token)->CompleteReverse(status, timeouts, host);
  }

 public:
  Resolver(int timeout = -1, int tries = 4, unsigned max_timeout = 0)
      : timeout_(timeout), tries_(tries), maxTimeout_(max_timeout) {
    status_ = InitializeCares();
    if (status_ != ARES_SUCCESS) return;
    if (!ares_threadsafety()) { status_ = ARES_ENOTIMP; return; }
    // c-ares owns the real guest poll/thread/descriptors/timers.
    SetupLocked();
  }
  Resolver(const Resolver&) = delete;
  Resolver& operator=(const Resolver&) = delete;
  ~Resolver() { Close(); }

  int Status() {
    std::lock_guard<std::mutex> lock(mutex_);
    return status_;
  }

  int SetServers(const char* csv) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!channel_) return ARES_ENOTINITIALIZED;
    const int status = ares_set_servers_ports_csv(channel_, csv);
    if (status == ARES_SUCCESS && csv[0] != '\0') serversDefault_ = false;
    return status;
  }

  int SetServers(const std::vector<ares_addr_port_node>& servers) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!channel_) return ARES_ENOTINITIALIZED;
    // The caller owns and links this native array for the synchronous copy.
    if (servers.empty()) return ares_set_servers(channel_, nullptr);
    const int status = ares_set_servers_ports(channel_, servers.data());
    if (status == ARES_SUCCESS) serversDefault_ = false;
    return status;
  }

  int GetServers(std::vector<std::pair<std::string, int>>* output) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!channel_) return ARES_ENOTINITIALIZED;
    ares_addr_port_node* raw = nullptr;
    int status = ares_get_servers_ports(channel_, &raw);
    std::unique_ptr<void, records::FreeData> owned(raw);
    if (status != ARES_SUCCESS) return status;
    for (auto* p = raw; p; p = p->next) {
      char address[INET6_ADDRSTRLEN];
      if (!ares_inet_ntop(p->family, &p->addr, address, sizeof(address))) return ARES_EBADRESP;
      output->emplace_back(address, p->udp_port);
    }
    return ARES_SUCCESS;
  }

  bool GetServers(std::string* output) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!channel_) return false;
    char* csv = ares_get_servers_csv(channel_);
    if (!csv) return false;
    *output = csv;
    ares_free_string(csv);
    return true;
  }

  int SetLocalAddress(const char* ipv4, const char* ipv6 = nullptr) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!channel_) return ARES_ENOTINITIALIZED;
    in_addr v4{};
    ares_in6_addr v6{};
    if (ParseAddress(AF_INET, ipv4, &v4) != 1 ||
        (ipv6 && ParseAddress(AF_INET6, ipv6, &v6) != 1)) return ARES_EBADSTR;
    ares_set_local_ip4(channel_, ntohl(v4.s_addr));
    if (ipv6) ares_set_local_ip6(channel_, reinterpret_cast<const unsigned char*>(&v6));
    return ARES_SUCCESS;
  }

  int SetLocalIP(int family, const char* text) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!channel_) return ARES_ENOTINITIALIZED;
    in_addr v4{};
    ares_in6_addr v6{};
    if (family == 4 && ParseAddress(AF_INET, text, &v4) == 1)
      ares_set_local_ip4(channel_, ntohl(v4.s_addr));
    else if (family == 6 && ParseAddress(AF_INET6, text, &v6) == 1)
      ares_set_local_ip6(channel_, reinterpret_cast<const unsigned char*>(&v6));
    else return ARES_EBADSTR;
    return ARES_SUCCESS;
  }

  std::shared_ptr<Query> Submit(const char* name, ares_dns_rec_type_t type,
                              void (*completion)(void*, const QueryResult&) = nullptr,
                              void* data = nullptr) {
    auto query = std::make_shared<Query>(completion, data);
    std::lock_guard<std::mutex> lock(mutex_);
    const int status = EnsureServersLocked();
    if (status != ARES_SUCCESS) {
      query->Complete(status, 0, nullptr);
      return query;
    }
    // The pinned ares_query_dnsrec invokes its callback on submission failure
    // too. The callback owns this token, including synchronous completion.
    auto* token = new std::shared_ptr<Query>(query);
    ares_query_dnsrec(channel_, name, ARES_CLASS_IN, type, Completion, token, nullptr);
    return query;
  }

  std::shared_ptr<Query> Reverse(const void* address, int length, int family,
                               void (*completion)(void*, const QueryResult&), void* data) {
    auto query = std::make_shared<Query>(completion, data);
    std::lock_guard<std::mutex> lock(mutex_);
    const int status = EnsureServersLocked();
    if (status != ARES_SUCCESS) { query->Complete(status, 0, nullptr); return query; }
    auto* token = new std::shared_ptr<Query>(query);
    ares_gethostbyaddr(channel_, address, length, family, ReverseCompletion, token);
    return query;
  }

  void RecordQueryStatus(int status) {
    queryLastOk_.store(status != ARES_ECONNREFUSED, std::memory_order_relaxed);
  }

  void Cancel() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (channel_) ares_cancel(channel_);
  }

  void Close() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!channel_) return;
    // Destruction completes pending callbacks with their actual terminal
    // status and joins the c-ares event owner before its channel disappears.
    ares_destroy(channel_);
    channel_ = nullptr;
    status_ = ARES_ENOTINITIALIZED;
  }
};

}  // namespace kandelo::dns
#endif
