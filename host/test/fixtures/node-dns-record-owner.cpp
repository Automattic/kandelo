#include "../../../third_party/node-core/dns-resolver.h"
#include <iostream>
#include <sstream>
#include <stdexcept>
using kandelo::dns::RecordValue;
static void String(const std::string& s) {
  std::cout << '"';
  const char hex[] = "0123456789abcdef";
  for (unsigned char c : s) {
    if (c >= 32 && c < 127 && c != '"' && c != '\\') std::cout << c;
    else std::cout << "\\u00" << hex[c >> 4] << hex[c & 15];
  }
  std::cout << '"';
}
static void Value(const RecordValue& v) {
  using K = RecordValue::Kind;
  if (v.kind == K::Hole) { std::cout << "{\"$hole\":true}"; return; }
  if (v.kind == K::Undefined) { std::cout << "{\"$undefined\":true}"; return; }
  if (v.kind == K::Number) { std::cout << v.number; return; }
  if (v.kind == K::String) { String(v.bytes); return; }
  if (v.kind == K::ArrayBuffer) {
    const char hex[] = "0123456789abcdef";
    std::cout << "{\"$arrayBuffer\":\"";
    for (unsigned char c : v.bytes) std::cout << hex[c >> 4] << hex[c & 15];
    std::cout << "\"}"; return;
  }
  if (v.kind == K::Array) {
    std::cout << '[';
    for (size_t i = 0; i < v.elements.size(); ++i) { if (i) std::cout << ','; Value(v.elements[i]); }
    std::cout << ']'; return;
  }
  auto fields = [](const auto& pairs) {
    std::cout << '[';
    for (size_t i = 0; i < pairs.size(); ++i) {
      if (i) std::cout << ',';
      std::cout << '['; String(pairs[i].first); std::cout << ','; Value(pairs[i].second); std::cout << ']';
    }
    std::cout << ']';
  };
  std::cout << "{\"$object\":"; fields(v.fields);
  std::cout << ",\"$assignments\":"; fields(v.assignments); std::cout << '}';
}
static const char* Status(int code) {
  switch (code) {
    case ARES_SUCCESS: return "SUCCESS";
    case ARES_ENODATA: return "ENODATA";
    case ARES_ENOTFOUND: return "ENOTFOUND";
    case ARES_EBADRESP: return "EBADRESP";
    case ARES_ESERVFAIL: return "ESERVFAIL";
    case ARES_ECANCELLED: return "ECANCELLED";
    case ARES_EDESTRUCTION: return "EDESTRUCTION";
    case ARES_ENOTIMP: return "ENOTIMP";
    default: return nullptr;
  }
}
int main(int argc, char** argv) {
  try {
    if (argc != 4) throw std::runtime_error("type name server required");
    const int type = std::stoi(argv[1]);
    kandelo::dns::Resolver resolver(500, 1, 1000);
    if (resolver.Status() != ARES_SUCCESS || resolver.SetServers(argv[3]) != ARES_SUCCESS)
      throw std::runtime_error("resolver initialization");
    auto query = resolver.Submit(argv[2], static_cast<ares_dns_rec_type_t>(type));
    kandelo::dns::QueryResult result;
    if (!query->Wait(std::chrono::seconds(3), &result)) throw std::runtime_error("query deadline");
    resolver.Close();
    // Decode after channel destruction, then retire every borrowed/native record
    // before serializing. No packet/library pointer may back the result values.
    auto decoded = result.Decode(type);
    result.record.reset(); query.reset();
    std::cout << "{\"status\":";
    if (decoded.status == ARES_SUCCESS) std::cout << '0';
    else if (auto* name = Status(decoded.status)) String(name);
    else std::cout << decoded.status;
    if (decoded.status == ARES_SUCCESS) {
      std::cout << ",\"value\":"; Value(decoded.value);
      if (decoded.has_ttls) {
        std::cout << ",\"ttls\":[";
        for (size_t i = 0; i < decoded.ttls.size(); ++i) { if (i) std::cout << ','; std::cout << decoded.ttls[i]; }
        std::cout << ']';
      }
    }
    std::cout << "}\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
