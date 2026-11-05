// Portable native address/rule owners derived from pinned node_sockaddr.cc.
// Real address bytes, shared state and locks; no network answers are invented.
// Node and libuv licenses are retained with the source references.
#ifndef KANDELO_NODE_ADDRESS_RULES_H
#define KANDELO_NODE_ADDRESS_RULES_H
#include <algorithm>
#include <arpa/inet.h>
#include <array>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <list>
#include <memory>
#include <mutex>
#include <net/if.h>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>
#include "kandelo-node-address-inet.h"
#ifndef NODE_WANT_INTERNALS
#define NODE_WANT_INTERNALS 1
#define KANDELO_ADDRESS_UNDEF_NODE_WANT_INTERNALS
#endif
#include "kandelo-node-address-hash.h"
#ifdef KANDELO_ADDRESS_UNDEF_NODE_WANT_INTERNALS
#undef NODE_WANT_INTERNALS
#undef KANDELO_ADDRESS_UNDEF_NODE_WANT_INTERNALS
#endif
namespace kandelo::node_address {
struct Address {
  int family = AF_INET;
  std::array<uint8_t, 16> bytes{};
  uint16_t port = 0;
  uint32_t scope = 0, flow = 0;
  size_t width() const { return family == AF_INET ? 4 : 16; }
  void SetFlowLabel(uint32_t label) {
    if(family!=AF_INET6)return;
    // Pinned SocketAddress::set_flow_label uses a fatal CHECK here. Keep
    // its 20-bit native contract rather than silently masking the label.
    if(label>0xfffff)std::abort();
    flow=label;
  }
  bool mapped() const {
    static constexpr uint8_t prefix[12] = {0,0,0,0,0,0,0,0,0,0,255,255};
    return family == AF_INET6 && std::memcmp(bytes.data(),prefix,12)==0;
  }
  Address counterpart() const {
    Address out; out.port = port;
    if (family == AF_INET) {
      out.family=AF_INET6;out.bytes[10]=out.bytes[11]=255;
      std::copy_n(bytes.data(),4,out.bytes.data()+12);
    } else {
      out.family=AF_INET;std::copy_n(bytes.data()+12,4,out.bytes.data());
    }
    return out;
  }
  static bool Parse(int family,const std::string& input,uint16_t port,Address* out) {
    if (family != AF_INET && family != AF_INET6) return false;
    Address value;value.family=family;value.port=port;
    // The pinned uv_ip*_addr boundary receives a UTF-8 C string. For IPv6
    // it resolves the scope through the actual interface namespace; unknown
    // interfaces have index zero rather than a manufactured interface ID.
    std::string text(input.c_str());
    if (family == AF_INET6) {
      const size_t zone=text.find('%');
      if (zone != std::string::npos) {
        value.scope=if_nametoindex(text.c_str()+zone+1);
        text=text.substr(0,std::min(zone,size_t(39)));
      }
    }
    const int result=family==AF_INET
        ? node_address_inet::inet_pton4(text.c_str(),value.bytes.data())
        : node_address_inet::inet_pton6(text.c_str(),value.bytes.data());
    if(result!=0)return false;
    *out=value;return true;
  }
  std::string text() const {
    auto dotted=[&](size_t start) {
      return std::to_string(bytes[start])+"."+std::to_string(bytes[start+1])+"."+
          std::to_string(bytes[start+2])+"."+std::to_string(bytes[start+3]);
    };
    if (family == AF_INET) return dotted(0);
    unsigned words[8];
    for (size_t i=0;i<8;i++) words[i]=unsigned(bytes[i*2])*256+bytes[i*2+1];
    int best=-1,bestLength=0,current=-1;
    for(int i=0;i<=8;i++) {
      if (i<8 && words[i]==0) {if(current<0)current=i;}
      else if(current>=0) {if(i-current>bestLength){best=current;bestLength=i-current;}current=-1;}
    }
    if(bestLength<2)best=-1;
    std::string out;
    for(int i=0;i<8;i++) {
      if(best>=0 && i>=best && i<best+bestLength){if(i==best)out+=':';continue;}
      if(i)out+=':';
      if(i==6 && best==0 && (bestLength==6 || (bestLength==7 && words[7]!=1) ||
          (bestLength==5 && words[5]==0xffff))){out+=dotted(12);break;}
      const char* hex="0123456789abcdef";char digits[4];int count=0;unsigned word=words[i];
      do {digits[count++]=hex[word&15];word>>=4;}while(word);
      while(count)out+=digits[--count];
    }
    if(best>=0 && best+bestLength==8)out+=':';
    return out;
  }
  // Two unrelated families have no ordering. IPv4-mapped IPv6 addresses
  // compare as the corresponding IPv4 bytes, independently of port/scope.
  static int Compare(const Address& a,const Address& b) {
    const auto compare=[](const uint8_t* left,const uint8_t* right,size_t length) {
      const int result=std::memcmp(left,right,length);return result<0?-1:result>0?1:0;
    };
    if(a.family==b.family)return compare(a.bytes.data(),b.bytes.data(),a.width());
    if(a.family==AF_INET && b.mapped())return compare(a.bytes.data(),b.bytes.data()+12,4);
    if(a.mapped() && b.family==AF_INET)return compare(a.bytes.data()+12,b.bytes.data(),4);
    return 256; // Unordered, outside memcmp's normalized range below.
  }
  bool sameRuleAddress(const Address& other) const {
    return family==other.family && port==other.port && scope==other.scope && flow==other.flow &&
        std::memcmp(bytes.data(),other.bytes.data(),width())==0;
  }
};
struct IpHash {
  size_t operator()(const Address& a) const {return node::HashBytes(a.bytes.data(),a.width());}
};
struct IpEqual {
  bool operator()(const Address& a,const Address& b) const {
    return a.family==b.family && std::memcmp(a.bytes.data(),b.bytes.data(),a.width())==0;
  }
};
struct FullHash {
  size_t operator()(const Address& a) const {
    uint8_t data[22]{};const uint16_t port=htons(a.port);std::memcpy(data,&port,2);
    std::memcpy(data+2,a.bytes.data(),a.width());
    if(a.family==AF_INET6)std::memcpy(data+18,&a.scope,4);
    return node::HashBytes(data,a.family==AF_INET?6:22);
  }
};
struct FullEqual {
  bool operator()(const Address& a,const Address& b) const {
    return IpEqual{}(a,b) && a.port==b.port && (a.family==AF_INET || a.scope==b.scope);
  }
};
class Trie {
  struct Node {std::unique_ptr<Node> child[2];bool terminal=false;};
  std::unique_ptr<Node> root_;
 public:
  void insert(const uint8_t* bytes,int prefix) {
    if(!root_)root_=std::make_unique<Node>();
    Node* node=root_.get();
    for(int i=0;i<prefix;i++) {
      if(node->terminal)return;
      const unsigned bit=(bytes[i/8]>>(7-i%8))&1;
      if(!node->child[bit])node->child[bit]=std::make_unique<Node>();
      node=node->child[bit].get();
    }
    node->terminal=true;node->child[0].reset();node->child[1].reset();
  }
  bool contains(const uint8_t* bytes,int bits) const {
    const Node* node=root_.get();
    for(int i=0;node && i<=bits;i++) {
      if(node->terminal)return true;
      if(i==bits)return false;
      node=node->child[(bytes[i/8]>>(7-i%8))&1].get();
    }
    return false;
  }
  void clear(){root_.reset();}
};
class BlockList {
  struct Range {Address start,end;};
  struct Subnet {Address network;int prefix;};
  std::unordered_map<Address,Address,IpHash,IpEqual> addresses_;
  size_t addressCount_=0;
  std::list<Range> ranges_;
  std::list<Subnet> subnets_;
  Trie ipv4_,ipv6_;
  mutable std::shared_mutex mutex_;
  void addAddress(const Address& a) {
    if(!addresses_.count(a))addressCount_++;
    addresses_[a]=a;
    if(a.family==AF_INET || a.mapped())addresses_[a.counterpart()]=a;
  }
  void insertSubnet(const Address& a,int prefix) {
    if(a.family==AF_INET) {
      ipv4_.insert(a.bytes.data(),prefix);
      const Address mapped=a.counterpart();ipv6_.insert(mapped.bytes.data(),prefix+96);
    } else {
      ipv6_.insert(a.bytes.data(),prefix);
      if(a.mapped() && prefix>=96)ipv4_.insert(a.bytes.data()+12,prefix-96);
    }
  }
 public:
  void AddAddress(const Address& a){std::unique_lock lock(mutex_);addAddress(a);}
  void AddAddresses(const std::vector<Address>& values){std::unique_lock lock(mutex_);for(const auto& a:values)addAddress(a);}
  void RemoveAddress(const Address& a) {
    std::unique_lock lock(mutex_);
    if(addresses_.erase(a))addressCount_--;
    if(a.family==AF_INET || a.mapped())addresses_.erase(a.counterpart());
  }
  bool AddRange(const Address& start,const Address& end) {
    const int order=Address::Compare(start,end);
    if(order!=256 && order>0)return false;
    std::unique_lock lock(mutex_);ranges_.push_front({start,end});return true;
  }
  void RemoveRange(const Address& start,const Address& end) {
    std::unique_lock lock(mutex_);
    for(auto i=ranges_.begin();i!=ranges_.end();++i)if(i->start.sameRuleAddress(start) && i->end.sameRuleAddress(end)){ranges_.erase(i);return;}
  }
  bool AddSubnet(const Address& address,int prefix) {
    if(prefix<0 || prefix>(address.family==AF_INET?32:128))return false;
    std::unique_lock lock(mutex_);insertSubnet(address,prefix);subnets_.push_front({address,prefix});return true;
  }
  void RemoveSubnet(const Address& address,int prefix) {
    std::unique_lock lock(mutex_);bool found=false;
    for(auto i=subnets_.begin();i!=subnets_.end();++i)if(i->prefix==prefix && i->network.sameRuleAddress(address)){subnets_.erase(i);found=true;break;}
    if(!found)return;
    ipv4_.clear();ipv6_.clear();
    for(const auto& subnet:subnets_)insertSubnet(subnet.network,subnet.prefix);
  }
  bool Check(const Address& a) const {
    std::shared_lock lock(mutex_);
    if(addresses_.count(a))return true;
    if(a.family==AF_INET) {
      if(ipv4_.contains(a.bytes.data(),32))return true;
      const Address mapped=a.counterpart();if(ipv6_.contains(mapped.bytes.data(),128))return true;
    } else {
      if(ipv6_.contains(a.bytes.data(),128))return true;
      if(a.mapped() && ipv4_.contains(a.bytes.data()+12,32))return true;
    }
    for(const auto& range:ranges_) {
      const int low=Address::Compare(a,range.start),high=Address::Compare(a,range.end);
      if(low!=256 && high!=256 && low>=0 && high<=0)return true;
    }
    return false;
  }
  void Clear(){std::unique_lock lock(mutex_);addresses_.clear();addressCount_=0;ranges_.clear();subnets_.clear();ipv4_.clear();ipv6_.clear();}
  size_t Size() const {std::shared_lock lock(mutex_);return addressCount_+ranges_.size()+subnets_.size();}
  std::vector<std::string> Rules() const {
    std::shared_lock lock(mutex_);std::vector<std::string> out;
    std::unordered_set<Address,FullHash,FullEqual> seen;
    for(const auto& entry:addresses_)if(seen.insert(entry.second).second) {
      const auto& a=entry.second;out.push_back(std::string("Address: ")+(a.family==AF_INET?"IPv4 ":"IPv6 ")+a.text());
    }
    for(const auto& subnet:subnets_)out.push_back(std::string("Subnet: ")+(subnet.network.family==AF_INET?"IPv4 ":"IPv6 ")+subnet.network.text()+"/"+std::to_string(subnet.prefix));
    for(const auto& range:ranges_)out.push_back(std::string("Range: ")+(range.start.family==AF_INET?"IPv4 ":"IPv6 ")+range.start.text()+"-"+range.end.text());
    return out;
  }
};
} // namespace kandelo::node_address
#endif
