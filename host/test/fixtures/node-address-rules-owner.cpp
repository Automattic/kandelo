#include "../../../third_party/node-core/address-rules.h"
#include <atomic>
#include <cassert>
#include <iomanip>
#include <iostream>
#include <thread>
using kandelo::node_address::Address;
using kandelo::node_address::BlockList;
static Address address(const char* text,int port=0) {
  Address a;assert(Address::Parse(std::strchr(text,':')?AF_INET6:AF_INET,text,uint16_t(port),&a));return a;
}
static void strings(const std::vector<std::string>& values) {
  std::cout<<'[';bool first=true;for(const auto& value:values){if(!first)std::cout<<',';first=false;std::cout<<std::quoted(value);}std::cout<<']';
}
static void checks(const BlockList& b,const std::vector<const char*>& values) {
  std::cout<<'[';bool first=true;for(const char* value:values){if(!first)std::cout<<',';first=false;std::cout<<b.Check(address(value));}std::cout<<']';
}
static void snapshot(const BlockList& b,const std::vector<const char*>& values) {
  std::cout<<"{\"size\":"<<b.Size()<<",\"rules\":";strings(b.Rules());std::cout<<",\"checks\":";checks(b,values);std::cout<<'}';
}
int main(int argc,char** argv) {
  assert(argc==2);const std::string scenario=argv[1];std::cout<<std::boolalpha;
  {auto a=address("::1");a.SetFlowLabel(0xfffff);assert(a.flow==0xfffff);}
  {auto a=address("127.0.0.1");a.SetFlowLabel(0x100000);assert(a.flow==0);}
  if(scenario=="addresses") {
    std::cout<<'[';bool first=true;
    for(const auto& input:std::vector<std::pair<int,std::string>>{
      {AF_INET,"127.0.0.1"},{AF_INET,"01.2.3.4"},{AF_INET,"1.2.3.256"},
      {AF_INET,std::string("127.0.0.1\0ignored",17)},
      {AF_INET6,"::"},{AF_INET6,"::1"},{AF_INET6,"::2"},{AF_INET6,"::ffff:192.0.2.1"},
      {AF_INET6,"2001:0DB8:0:1:0:1:0:1"},{AF_INET6,"fe80::1%lo"},{AF_INET6,"bad"}}) {
      if(!first)std::cout<<',';first=false;Address a;
      if(!Address::Parse(input.first,input.second,123,&a))std::cout<<"null";
      else std::cout<<"{\"address\":"<<std::quoted(a.text())<<",\"port\":"<<a.port<<",\"family\":"<<std::quoted(a.family==AF_INET?"ipv4":"ipv6")<<",\"flowlabel\":"<<a.flow<<'}';
    }std::cout<<']';
  } else if(scenario=="exact") {
    BlockList b;const std::vector<const char*> peers={"127.0.0.1","::ffff:127.0.0.1","::127.0.0.1","2001:db8::1","127.0.0.2"};
    std::cout<<'[';
    b.AddAddress(address("127.0.0.1",33));b.AddAddress(address("2001:db8::1"));snapshot(b,peers);std::cout<<',';
    b.AddAddress(address("::ffff:127.0.0.1",99));snapshot(b,peers);std::cout<<',';
    b.RemoveAddress(address("127.0.0.1"));snapshot(b,peers);std::cout<<',';
    b.AddAddresses({address("127.0.0.2"),address("2001:db8::2"),address("127.0.0.2")});snapshot(b,peers);std::cout<<',';
    b.Clear();snapshot(b,peers);std::cout<<']';
  } else if(scenario=="ranges") {
    BlockList b;std::cout<<"{\"added\":[";
    std::cout<<b.AddRange(address("192.0.2.2"),address("192.0.2.8"))<<',';
    std::cout<<b.AddRange(address("192.0.2.8"),address("192.0.2.2"))<<',';
    std::cout<<b.AddRange(address("2001:db8::2"),address("2001:db8::8"))<<',';
    std::cout<<b.AddRange(address("198.51.100.2"),address("::ffff:198.51.100.8"))<<',';
    std::cout<<b.AddRange(address("203.0.113.1"),address("2001:db8:1::1"))<<"],\"snapshots\":[";
    const std::vector<const char*> peers={"192.0.2.1","192.0.2.2","::ffff:192.0.2.7","192.0.2.9","2001:db8::8","198.51.100.5","::ffff:198.51.100.9","203.0.113.3"};
    snapshot(b,peers);std::cout<<',';
    b.RemoveRange(address("192.0.2.2",1),address("192.0.2.8"));snapshot(b,peers);std::cout<<',';
    b.RemoveRange(address("192.0.2.2"),address("192.0.2.8"));snapshot(b,peers);std::cout<<"]}";
  } else if(scenario=="subnets") {
    BlockList b;const std::vector<const char*> peers={"10.1.1.1","::ffff:10.1.1.1","192.0.2.5","::ffff:192.0.2.5","2001:db8::1","198.51.100.1"};
    b.AddSubnet(address("10.1.2.3"),8);b.AddSubnet(address("::ffff:192.0.2.99"),120);b.AddSubnet(address("2001:db8::5"),32);
    std::cout<<'[';snapshot(b,peers);std::cout<<',';
    b.AddSubnet(address("::"),0);snapshot(b,peers);std::cout<<',';
    b.RemoveSubnet(address("::"),0);snapshot(b,peers);std::cout<<',';
    b.AddSubnet(address("10.1.2.3"),8);b.RemoveSubnet(address("10.1.2.3",5),8);snapshot(b,peers);std::cout<<',';
    b.RemoveSubnet(address("10.1.2.3"),8);snapshot(b,peers);std::cout<<',';
    b.RemoveSubnet(address("10.1.2.3"),8);snapshot(b,peers);std::cout<<']';
  } else if(scenario=="concurrency") {
    auto owner=std::make_shared<BlockList>();auto shared=owner;std::atomic<unsigned> checked{0};std::vector<std::thread> workers;
    for(unsigned t=0;t<4;t++)workers.emplace_back([shared,t,&checked]{
      for(unsigned i=0;i<32;i++){const auto a=address(("192.0."+std::to_string(t)+"."+std::to_string(i)).c_str());shared->AddAddress(a);if(shared->Check(a))checked++;}
    });
    owner.reset();for(auto& worker:workers)worker.join();
    std::cout<<"{\"size\":"<<shared->Size()<<",\"checked\":"<<checked.load()<<",\"retainedOwnerWorks\":"<<shared->Check(address("192.0.3.31"))<<'}';
  } else return 2;
  std::cout<<'\n';return 0;
}
