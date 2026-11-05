#include "dns-lookup.h"
#include "dns-resolver.h"
#include <cassert>
#include <iostream>
#include <thread>

int main(int argc, char** argv) {
  assert(argc == 2);
  kandelo::dns::LookupResult lookup;
  std::thread worker([&] { lookup = kandelo::dns::Lookup("127.0.0.1", 4, 0); });
  worker.join();
  assert(lookup.status == 0 && lookup.addresses.size() == 1);
  assert(lookup.addresses[0].address == "127.0.0.1");
  assert(lookup.addresses[0].family == 4);
  const auto invalid = kandelo::dns::Lookup("invalid.test", 4, AI_NUMERICHOST);
  assert(invalid.status == EAI_NONAME);

  using namespace std::chrono_literals;
  kandelo::dns::Resolver resolver(500, 1, 1000);
  assert(resolver.Status() == ARES_SUCCESS);
  assert(resolver.SetServers(argv[1]) == ARES_SUCCESS);
  assert(resolver.SetLocalAddress("127.0.0.1") == ARES_SUCCESS);
  std::string servers;
  assert(resolver.GetServers(&servers));
  assert(servers.find(argv[1]) != std::string::npos);
  const auto query = resolver.Submit("answer.test", ARES_REC_TYPE_A);
  kandelo::dns::QueryResult result;
  assert(query->Wait(2000ms, &result));
  assert(result.status == ARES_SUCCESS && result.record);
  assert(ares_dns_record_rr_cnt(result.record.get(), ARES_SECTION_ANSWER) == 1);
  resolver.Close();
  assert(resolver.Status() == ARES_ENOTINITIALIZED);
  // The record copy survives channel teardown and the borrowed callback data.
  const auto* rr = ares_dns_record_rr_get_const(result.record.get(), ARES_SECTION_ANSWER, 0);
  assert(ares_dns_rr_get_type(rr) == ARES_REC_TYPE_A);
  char address[INET_ADDRSTRLEN];
  assert(ares_inet_ntop(AF_INET, ares_dns_rr_get_addr(rr, ARES_RR_A_ADDR), address, sizeof(address)));
  assert(std::string(address) == "203.0.113.77");
  const auto ttl = ares_dns_rr_get_ttl(rr);
  assert(ttl == 47);

  kandelo::dns::Resolver cancelled(500, 1);
  assert(cancelled.Status() == ARES_SUCCESS);
  assert(cancelled.SetServers(argv[1]) == ARES_SUCCESS);
  const auto cancelled_query = cancelled.Submit("silent.test", ARES_REC_TYPE_A);
  cancelled.Cancel();
  kandelo::dns::QueryResult cancellation;
  assert(cancelled_query->Wait(1000ms, &cancellation));
  assert(cancellation.status == ARES_ECANCELLED);

  kandelo::dns::Resolver closed(500, 1);
  assert(closed.Status() == ARES_SUCCESS);
  assert(closed.SetServers(argv[1]) == ARES_SUCCESS);
  const auto closed_query = closed.Submit("silent.test", ARES_REC_TYPE_A);
  closed.Close();
  kandelo::dns::QueryResult destruction;
  assert(closed_query->Wait(1000ms, &destruction));
  assert(destruction.status == ARES_EDESTRUCTION);
  std::cout << "{\"passed\":true,\"records\":[{\"address\":\"" << address
            << "\",\"ttl\":" << ttl << "}],\"cancelledStatus\":" << cancellation.status
            << ",\"destroyedStatus\":" << destruction.status << "}\n";
}
