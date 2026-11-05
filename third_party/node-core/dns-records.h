#ifndef KANDELO_NODE_DNS_RECORDS_H
#define KANDELO_NODE_DNS_RECORDS_H

#include <algorithm>
#include <ares.h>
#include <ares_dns_record.h>
#include <arpa/inet.h>
#include <climits>
#include <cstdint>
#include <memory>
#include <netdb.h>
#include <string>
#include <utility>
#include <vector>


namespace kandelo::dns {

// Owned native completion data. Strings contain Latin-1 code units, not UTF-8.
// This is not a JS object facade: the owning realm must materialize real arrays,
// holes, ordinary objects and independent ArrayBuffers. Fixed dictionary fields
// are own data properties; subsequent assignments must use ordinary [[Set]],
// including user-installed setters and their exceptions (notably CAA tags).
struct RecordValue {
  enum class Kind { Hole, Undefined, Number, String, Array, Object, ArrayBuffer };
  Kind kind = Kind::Hole;
  int64_t number = 0;
  std::string bytes;
  std::vector<RecordValue> elements;
  std::vector<std::pair<std::string, RecordValue>> fields;
  std::vector<std::pair<std::string, RecordValue>> assignments;
  static RecordValue Undefined() { RecordValue v; v.kind = Kind::Undefined; return v; }
  static RecordValue Number(int64_t n) {
    RecordValue v; v.kind = Kind::Number; v.number = n; return v;
  }
  static RecordValue String(std::string s) {
    RecordValue v; v.kind = Kind::String; v.bytes = std::move(s); return v;
  }
  static RecordValue CString(const char* s) { return String(s ? s : ""); }
  static RecordValue Array() { RecordValue v; v.kind = Kind::Array; return v; }
  static RecordValue Object() { RecordValue v; v.kind = Kind::Object; return v; }
  static RecordValue Binary(const unsigned char* p, size_t n) {
    RecordValue v; v.kind = Kind::ArrayBuffer;
    v.bytes.assign(reinterpret_cast<const char*>(p), n); return v;
  }
  RecordValue& Field(const char* name, RecordValue v) {
    fields.emplace_back(name, std::move(v)); return *this;
  }
  RecordValue& Type(const char* name) { return Field("type", CString(name)); }
  void Push(RecordValue v) { elements.push_back(std::move(v)); }
  void Set(size_t index, RecordValue v) {
    if (elements.size() <= index) elements.resize(index + 1);
    elements[index] = std::move(v);
  }
};

struct DecodedRecords {
  int status = ARES_SUCCESS;
  RecordValue value = RecordValue::Array();
  bool has_ttls = false;
  std::vector<uint32_t> ttls;
};

namespace records {
struct FreeData { void operator()(void* p) const { ares_free_data(p); } };
struct FreeHost { void operator()(hostent* p) const { ares_free_hostent(p); } };
struct FreeRecord {
  void operator()(ares_dns_record_t* p) const { ares_dns_record_destroy(p); }
};
struct FreeString { void operator()(void* p) const { ares_free_string(p); } };
using V = RecordValue;
inline int64_t Signed32(uint32_t n) {
  return n <= INT32_MAX ? static_cast<int64_t>(n) : static_cast<int64_t>(n) - 0x100000000LL;
}
inline V Soa(const char* ns, const char* host, uint32_t serial, uint32_t refresh,
             uint32_t retry, uint32_t expire, uint32_t minimum, bool any) {
  V v = V::Object();
  v.Field("nsname", V::CString(ns)).Field("hostmaster", V::CString(host))
   .Field("serial", V::Number(serial)).Field("refresh", V::Number(Signed32(refresh)))
   .Field("retry", V::Number(Signed32(retry))).Field("expire", V::Number(Signed32(expire)))
   .Field("minttl", V::Number(minimum));
  if (any) v.Type("SOA");
  else v.Field("type", V::Undefined());
  return v;
}

// Node's ANY parser tries CNAME-or-A before the other record families.
constexpr int CnameOrA = -1;
inline int General(const unsigned char* data, int length, int type, bool any,
                   V* out, std::vector<uint32_t>* ttls) {
  hostent* raw = nullptr;
  const size_t count = length > 7 ? std::max<size_t>(1, (data[6] << 8) | data[7]) : 256;
  std::vector<ares_addrttl> v4(count);
  std::vector<ares_addr6ttl> v6(count);
  int n = static_cast<int>(count), status;
  if (type == ARES_REC_TYPE_A || type == ARES_REC_TYPE_CNAME || type == CnameOrA)
    status = ares_parse_a_reply(data, length, &raw, v4.data(), &n);
  else if (type == ARES_REC_TYPE_AAAA)
    status = ares_parse_aaaa_reply(data, length, &raw, v6.data(), &n);
  else if (type == ARES_REC_TYPE_NS) status = ares_parse_ns_reply(data, length, &raw);
  else if (type == ARES_REC_TYPE_PTR)
    status = ares_parse_ptr_reply(data, length, nullptr, 0, AF_INET, &raw);
  else return ARES_ENOTIMP;
  std::unique_ptr<hostent, FreeHost> host(raw);
  if (status != ARES_SUCCESS) return status;
  if (!host) return ARES_EBADRESP;
  if (type == ARES_REC_TYPE_CNAME ||
      (type == CnameOrA && host->h_name && host->h_aliases[0])) {
    V value = V::CString(host->h_name);
    if (any) { V object = V::Object(); object.Field("value", std::move(value)).Type("CNAME"); out->Push(std::move(object)); }
    else out->Push(std::move(value));
    return ARES_SUCCESS;
  }
  if (type == CnameOrA) type = ARES_REC_TYPE_A;
  if (type == ARES_REC_TYPE_NS || type == ARES_REC_TYPE_PTR) {
    for (size_t i = 0; host->h_aliases[i]; ++i) {
      V value = V::CString(host->h_aliases[i]);
      if (any) { V object = V::Object(); object.Field("value", std::move(value)).Type(type == ARES_REC_TYPE_NS ? "NS" : "PTR"); out->Push(std::move(object)); }
      else out->Push(std::move(value));
    }
  } else {
    for (size_t i = 0; host->h_addr_list[i]; ++i) {
      char address[INET6_ADDRSTRLEN];
      if (!ares_inet_ntop(host->h_addrtype, host->h_addr_list[i], address, sizeof(address))) return ARES_EBADRESP;
      V value = V::CString(address);
      if (any) {
        if (i >= static_cast<size_t>(n)) return ARES_EBADRESP;
        V object = V::Object();
        object.Field("address", std::move(value))
          .Field("ttl", V::Number(static_cast<uint32_t>(type == ARES_REC_TYPE_A ? v4[i].ttl : v6[i].ttl)))
          .Type(type == ARES_REC_TYPE_A ? "A" : "AAAA");
        out->Push(std::move(object));
      } else out->Push(std::move(value));
    }
    for (int i = 0; i < n; ++i)
      ttls->push_back(static_cast<uint32_t>(type == ARES_REC_TYPE_A ? v4[i].ttl : v6[i].ttl));
  }
  return ARES_SUCCESS;
}

inline int Linked(const unsigned char* data, int length, int type, bool any, V* out) {
  int status;
  if (type == ARES_REC_TYPE_MX) {
    ares_mx_reply* raw = nullptr; status = ares_parse_mx_reply(data, length, &raw);
    std::unique_ptr<void, FreeData> owned(raw);
    if (status != ARES_SUCCESS) return status;
    for (auto* p = raw; p; p = p->next) {
      V v = V::Object(); v.Field("exchange", V::CString(p->host)).Field("priority", V::Number(p->priority)).Type("MX"); out->Push(std::move(v));
    }
  } else if (type == ARES_REC_TYPE_SRV) {
    ares_srv_reply* raw = nullptr; status = ares_parse_srv_reply(data, length, &raw);
    std::unique_ptr<void, FreeData> owned(raw);
    if (status != ARES_SUCCESS) return status;
    for (auto* p = raw; p; p = p->next) {
      V v = V::Object(); v.Field("name", V::CString(p->host)).Field("port", V::Number(p->port))
        .Field("priority", V::Number(p->priority)).Field("weight", V::Number(p->weight)).Type("SRV"); out->Push(std::move(v));
    }
  } else if (type == ARES_REC_TYPE_NAPTR) {
    ares_naptr_reply* raw = nullptr; status = ares_parse_naptr_reply(data, length, &raw);
    std::unique_ptr<void, FreeData> owned(raw);
    if (status != ARES_SUCCESS) return status;
    for (auto* p = raw; p; p = p->next) {
      V v = V::Object(); v.Field("flags", V::CString(reinterpret_cast<char*>(p->flags)))
        .Field("service", V::CString(reinterpret_cast<char*>(p->service)))
        .Field("regexp", V::CString(reinterpret_cast<char*>(p->regexp)))
        .Field("replacement", V::CString(p->replacement)).Field("order", V::Number(p->order))
        .Field("preference", V::Number(p->preference));
      if (any) v.Type("NAPTR");
      else v.Field("type", V::Undefined());
      out->Push(std::move(v));
    }
  } else if (type == ARES_REC_TYPE_CAA) {
    ares_caa_reply* raw = nullptr; status = ares_parse_caa_reply(data, length, &raw);
    std::unique_ptr<void, FreeData> owned(raw);
    if (status != ARES_SUCCESS) return status;
    for (auto* p = raw; p; p = p->next) {
      V v = V::Object(); v.Field("critical", V::Number(p->critical)).Type("CAA");
      v.assignments.emplace_back(reinterpret_cast<char*>(p->property), V::CString(reinterpret_cast<char*>(p->value)));
      out->Push(std::move(v));
    }
  } else if (type == ARES_REC_TYPE_TXT) {
    ares_txt_ext* raw = nullptr; status = ares_parse_txt_reply_ext(data, length, &raw);
    std::unique_ptr<void, FreeData> owned(raw);
    if (status != ARES_SUCCESS) return status;
    V chunks = V::Array();
    auto flush = [&] {
      if (chunks.elements.empty()) return;
      if (any) { V v = V::Object(); v.Field("entries", std::move(chunks)).Type("TXT"); out->Push(std::move(v)); }
      else out->Push(std::move(chunks));
      chunks = V::Array();
    };
    for (auto* p = raw; p; p = p->next) {
      if (p->record_start) flush();
      chunks.Push(V::String(std::string(reinterpret_cast<char*>(p->txt), p->length)));
    }
    flush();
  } else return ARES_ENOTIMP;
  return ARES_SUCCESS;
}

inline int Structured(const unsigned char* data, int length, int type, bool any, V* out) {
  ares_dns_record_t* raw = nullptr;
  int status = ares_dns_parse(data, static_cast<size_t>(length), 0, &raw);
  std::unique_ptr<ares_dns_record_t, FreeRecord> owned(raw);
  if (status != ARES_SUCCESS) return status;
  const size_t count = ares_dns_record_rr_cnt(raw, ARES_SECTION_ANSWER);
  const size_t offset = out->elements.size();
  for (size_t i = 0; i < count; ++i) {
    const auto* rr = ares_dns_record_rr_get(raw, ARES_SECTION_ANSWER, i);
    if (ares_dns_rr_get_type(rr) != type) continue;
    if (type == ARES_REC_TYPE_TLSA) {
      size_t n = 0; const auto* bytes = ares_dns_rr_get_bin(rr, ARES_RR_TLSA_DATA, &n);
      if (!bytes || !n) continue;
      V v = V::Object(); v.Field("certUsage", V::Number(ares_dns_rr_get_u8(rr, ARES_RR_TLSA_CERT_USAGE)))
        .Field("selector", V::Number(ares_dns_rr_get_u8(rr, ARES_RR_TLSA_SELECTOR)))
        .Field("match", V::Number(ares_dns_rr_get_u8(rr, ARES_RR_TLSA_MATCH)))
        .Field("data", V::Binary(bytes, n));
      // Preserve the target's original answer index, including sparse holes.
      out->Set(offset + i, std::move(v));
    } else {
      V v = Soa(ares_dns_rr_get_str(rr, ARES_RR_SOA_MNAME), ares_dns_rr_get_str(rr, ARES_RR_SOA_RNAME),
        ares_dns_rr_get_u32(rr, ARES_RR_SOA_SERIAL), ares_dns_rr_get_u32(rr, ARES_RR_SOA_REFRESH),
        ares_dns_rr_get_u32(rr, ARES_RR_SOA_RETRY), ares_dns_rr_get_u32(rr, ARES_RR_SOA_EXPIRE),
        ares_dns_rr_get_u32(rr, ARES_RR_SOA_MINIMUM), any);
      if (any) out->Push(std::move(v)); else *out = std::move(v);
      return ARES_SUCCESS;
    }
  }
  return type == ARES_REC_TYPE_SOA && !any ? ARES_ENODATA : ARES_SUCCESS;
}

inline int Parse(const unsigned char* data, int length, int type, bool any,
                 V* out, std::vector<uint32_t>* ttls) {
  if (type == ARES_REC_TYPE_A || type == ARES_REC_TYPE_AAAA ||
      type == ARES_REC_TYPE_CNAME || type == ARES_REC_TYPE_NS ||
      type == ARES_REC_TYPE_PTR || type == CnameOrA)
    return General(data, length, type, any, out, ttls);
  if (type == ARES_REC_TYPE_TLSA || (type == ARES_REC_TYPE_SOA && any))
    return Structured(data, length, type, any, out);
  if (type == ARES_REC_TYPE_SOA) {
    ares_soa_reply* raw = nullptr;
    int status = ares_parse_soa_reply(data, length, &raw);
    std::unique_ptr<void, FreeData> owned(raw);
    if (status != ARES_SUCCESS) return status;
    *out = Soa(raw->nsname, raw->hostmaster, raw->serial, raw->refresh,
               raw->retry, raw->expire, raw->minttl, false);
    return ARES_SUCCESS;
  }
  return Linked(data, length, type, any, out);
}
}  // namespace records

// Operates on c-ares' already validated response wire, matching the pinned
// legacy reply parsers. A future JS bridge must propagate allocation failure
// through its native completion policy; no successful empty result is invented.
inline DecodedRecords DecodeRecords(const unsigned char* data, size_t length, int type) {
  DecodedRecords result;
  if (!data || length < 12 || length > INT_MAX) { result.status = ARES_EBADRESP; return result; }
  result.has_ttls = type == ARES_REC_TYPE_A || type == ARES_REC_TYPE_AAAA;
  if (type == ARES_REC_TYPE_ANY) {
    constexpr int order[] = {records::CnameOrA, ARES_REC_TYPE_AAAA, ARES_REC_TYPE_MX,
      ARES_REC_TYPE_NS, ARES_REC_TYPE_TXT, ARES_REC_TYPE_SRV, ARES_REC_TYPE_PTR,
      ARES_REC_TYPE_NAPTR, ARES_REC_TYPE_SOA, ARES_REC_TYPE_TLSA, ARES_REC_TYPE_CAA};
    for (int part : order) {
      std::vector<uint32_t> unused;
      result.status = records::Parse(data, static_cast<int>(length), part, true, &result.value, &unused);
      if (result.status != ARES_SUCCESS && result.status != ARES_ENODATA) return result;
    }
    result.status = ARES_SUCCESS;
  } else {
    result.status = records::Parse(data, static_cast<int>(length), type, false, &result.value, &result.ttls);
  }
  return result;
}

inline DecodedRecords DecodeRecords(const ares_dns_record_t* record, int type) {
  if (!record) { DecodedRecords result; result.status = ARES_EBADRESP; return result; }
  unsigned char* wire = nullptr; size_t length = 0;
  const int status = ares_dns_write(record, &wire, &length);
  std::unique_ptr<void, records::FreeString> owned(wire);
  if (status != ARES_SUCCESS) { DecodedRecords result; result.status = status; return result; }
  return DecodeRecords(wire, length, type);
}

}  // namespace kandelo::dns
#endif
